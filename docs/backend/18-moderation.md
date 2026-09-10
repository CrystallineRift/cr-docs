# Moderation (Live Ops)

Everything an operator can look at or change about a live player, in one domain, with every
mutation audited in the same transaction that applies it. `CR.Moderation.*` owns two tables
(`account_moderation`, `admin_action`) and composes the Auth, Trainer, Creature, Item and Market
domains through their repository/service interfaces — it never touches their tables directly.

The operator UI is Content Studio's **LIVE OPS** rail group (Players and Marketplace tabs, plus the
admin-key row in the Auth tab); this page is the server contract it talks to.

## Data model

| Table | Columns of note | Notes |
|---|---|---|
| `account_moderation` | `account_id` (PK, one row per account), `shadow_banned`, `shadow_ban_reason` (≤512), `shadow_ban_expires_at` (null = permanent), `notes`, `updated_by`, `created_at`/`updated_at`, `deleted` | Soft-deleted like every other table; reads filter `deleted = false` through a `@deleted` parameter, never a literal. Indexed on `(shadow_banned, account_id)` — a bare index on a two-valued boolean is not selective enough for the planner to pick, and the trailing id makes the banned-account read covering. `notes` is written by nothing in v1 — it is the seat for the future `Note` action. |
| `admin_action` | `id`, `actor`, `kind` (int, `AdminActionKind`), `target_account_id`, `target_trainer_id`, `target_listing_id` (all nullable), `reason` (≤512, **not** nullable), `metadata` (JSON text), `occurred_at` | **Append-only**: no `deleted` column, never updated. `id` carries **no engine-side default** — `BaseAdminActionRepository` mints it before the insert, so one ANSI statement works on both engines and the caller knows the id it wrote. Indexed on `(target_account_id, occurred_at)`, `target_listing_id`, and `occurred_at`. |

Created by `M13001CreateAccountModerationTable` / `M13002CreateAdminActionTable` (dual
SQLite/Postgres, ANSI SQL). Moderation is **online-only** — like Market, it is deliberately *not*
added to `Convenience/CR.Data.Migrations` (the baked offline floor), so no `account_moderation` row
ever ships inside `game-data.bytes`.

`AdminActionKind`: `ShadowBan`, `LiftShadowBan`, `RemoveListing`, `AdjustCurrency`, `GrantItem`,
`RemoveItem`, `Note` (unused in v1), `GrantExperience`, `GrantCreature`. Members are appended, never
renumbered — the integer is persisted in `admin_action.kind`, so reordering rewrites history.

## Repositories

| Interface | Responsibility |
|---|---|
| `IAccountModerationRepository` | `GetAsync` / `GetManyAsync` / `UpsertInTransactionAsync`, plus the two questions the market asks: `IsShadowBannedAsync(accountId, nowUtc)` and `GetShadowBannedAccountIdsAsync(nowUtc)`. Both answer **false/absent** for a missing row, a soft-deleted row, an unflagged row, *and* a ban whose `shadow_ban_expires_at` has passed — a lapsed ban is not a ban, and nothing has to sweep the table to make that true. `GetShadowBannedAccountIdsAsync` is bounded at `MaxShadowBannedIds` (1000, most recently updated first): the market browse subtracts that list from every page it serves, so it must not grow with the ban table. |
| `IAdminActionRepository` | `RecordInTransactionAsync` (takes the caller's `IDbTransaction`, so the audit row commits with the change it describes) and `ListAsync(AdminActionFilter)` — newest first, `limit` clamped to 1..200. |
| `IPlayerSearchRepository` | `SearchAsync(term, limit)`. A term that parses as a GUID matches `accounts.id` **or** `trainers.id`; otherwise it is a case-insensitive **prefix** match on `trainers.name` or `accounts.email`, with `%` and `_` escaped (`ESCAPE '\'`, ANSI, both engines) so a wildcard in the term cannot turn a prefix search into a full scan. Accounts with no trainer still come back (`TrainerId` null). `limit` clamped 1..100. |

`AdminActionFilter { AccountId, TrainerId, ListingId, Offset, Limit }` — every id optional, combined
with AND.

## `IModerationService`

Refusals travel back as `ModerationResult { Success, Reason, CurrencyAfter, ExperienceGrant,
SpawnGrant }` rather than as exceptions, so the caller always learns *which rule* stopped it.

| `ModerationReason` | Meaning |
|---|---|
| `NotFound` | The account, trainer, listing or inventory entry does not exist (or is deleted). |
| `NotBanned` | A lift was asked for on an account with no *active* ban. |
| `InsufficientFunds` | The adjustment would drive the balance below zero. |
| `StorageFull` | No free slot for the item (or the returned creature). |
| `InsufficientQuantity` | More was asked to be removed than the trainer holds. |
| `AlreadySold` | The listing is no longer `Active`. |
| `InvalidReason` | Blank reason, or longer than `ModerationReasonRules.MaxLength` (512). |
| `InvalidQuantity` | A zero delta, a non-positive item quantity or experience amount, or a forced spawn level outside 1..100. |
| `InvalidSearchTerm` | A search term too short to be worth running against the player table (REST-side; <2 characters). |
| `InvalidArgument` | A well-formed request carrying a value the operation cannot act on — most visibly a shadow-ban expiry already in the past. |
| `NoSpawnCandidate` | The spawner exists but has no pool holding an active template — either it is empty, or the pool the operator named is. |

### The reason rule

`ModerationReasonRules.IsValid(reason)` gates **every** mutation, and is checked *before* anything is
written — a refused operation leaves no row at all, not even in the audit log. The REST layer checks
it too, so the 400 is identical no matter which route was called. An audit row that says nothing is
worse than no action at all, which is why `admin_action.reason` is `NOT NULL`.

### Operations

| Method | Rules |
|---|---|
| `SearchPlayersAsync(term, limit)` | Straight delegation to `IPlayerSearchRepository`, limit clamped. |
| `GetPlayerDossierAsync(accountId)` | One read for the whole picture: account + provider links, moderation state (a *clear default* when the account has never been moderated — the absence of a row is not an error), every trainer with team / creature storage / backpack / item storage / active listings, and the last 20 `admin_action` rows. Listings come from the **operator** browse (`IMarketService.AdminBrowseListingsAsync(Active, accountId, …)`), which filters to `Active` in SQL and includes the listings a shadow ban hides from players — the seller-facing read clamps at 100 rows and would have silently truncated a busy account. `null` when the account does not exist. |
| `SetShadowBanAsync(accountId, reason, expiresAtUtc, actor)` | An `expiresAtUtc` already in the past → `InvalidArgument`, because a ban nothing would ever enforce must not be recorded as one the operator will believe is in force. Unknown account → `NotFound`. Idempotent: re-banning updates reason/expiry on the same row rather than creating a second one, and records a second audit entry. Metadata `{"expiresAt":…}`. |
| `LiftShadowBanAsync(accountId, reason, actor)` | `NotFound` when the account does not exist — saying `NotBanned` would read as confirmation that the operator looked at the right player. Otherwise `NotBanned` for an account with no row, an unflagged row, **or a ban that already lapsed** — an expired ban needs no lifting. |
| `RemoveListingAsync(listingId, reason, actor)` | Delegates to `IMarketService.AdminRemoveListingAsync`, which owns both the creature transfer and its audit row, and maps `MarketOperationReason` → `ModerationReason`. Exactly **one** `admin_action` row is written, by Market, not two. |
| `AdjustCurrencyAsync(trainerId, delta, reason, actor)` | Delta 0 → `InvalidQuantity`. Uses `ITrainerRepository.TryAdjustCurrencyInTransactionAsync`, which refuses to go negative → `InsufficientFunds` with nothing written. `CurrencyAfter` is **read back inside the same transaction**, so the number returned is the one that committed, not `before + delta`. Metadata `{"delta":D,"after":A}`. |
| `GrantItemAsync(trainerId, itemId, quantity, reason, actor)` | Quantity ≤ 0 → `InvalidQuantity`. Target is the trainer's backpack (`Trainer.ItemBackpackInventoryId`); an existing stack is topped up, otherwise the lowest free slot is used, or `StorageFull`. Item slots are **1-based** (`1..max_slots`), the same numbering `ItemInventoryService.FindNextAvailableSlot` and the market's storage placement use. The current quantity and the free-slot lookup are read **inside the transaction that writes**, via `GetItemsInTransactionAsync` / `GetInventoriesInTransactionAsync`, so a concurrent write cannot land between the decision and the insert. Metadata `{"itemId":"…","quantity":Q,"after":A}`. |
| `RemoveItemAsync(trainerId, itemId, quantity, reason, actor)` | Entry missing → `NotFound`; more than held → `InsufficientQuantity`; the whole stack clears the slot, less reduces it. Reads in-transaction like the grant, so the audited `after` is the committed one. Same metadata shape. |
| `GrantExperienceAsync(generatedCreatureId, amount, reason, actor)` | Amount ≤ 0 → `InvalidQuantity`; unknown creature → `NotFound`. Applies the **exact** amount through `ICreatureProgressionService.ApplyExperienceAsync`, not the growth-profile-scaled `ApplyEarnedExperienceAsync` — an operator typed the number and should get the number. Real progression, so level-ups, ability unlocks and the evolution check all happen exactly as they do in play. |
| `GrantCreatureFromSpawnerAsync(trainerId, spawnerContentKey, poolName?, level?, reason, actor)` | Rolls a spawn pool and hands the trainer what came out. A level outside 1..100 → `InvalidQuantity`; unknown trainer **or** unknown `spawnerContentKey` → `NotFound`; a spawner (or named pool) with no active template → `NoSpawnCandidate`. All three are refused *before* anything is generated. The roll goes through `ICreatureSpawnDomainService.SpawnCreaturesAsync` — the same weighted pool draw, template draw and `CreateFromSpawnerAtLevelAsync` generation a wild encounter and a trainer team go through — then places the creature with `ICreatureInventoryService.AddToTeamOrStorageAsync`. Metadata `{"spawnerContentKey":…,"poolName":…,"generatedCreatureId":"…","speciesContentKey":…,"speciesName":…,"level":L,"placedIn":"Team"|"Storage","slotNumber":S}`. |
| `ListActionsAsync(filter)` | The audit log, newest first. |

:::note Why the creature grant reuses the spawn path instead of building a creature
The whole point of the route is that a developer testing the game is handed *the creature the world
would have produced* — same species odds, same growth profile, same ability progression set. A
creature assembled here would be a second, quietly diverging generator. So the grant calls the spawn
domain service, which also records the spawn in `spawner_spawn_history` exactly as a wild encounter
does. `BypassValidation` is set: an operator naming a spawner has already decided to roll it, and
whether that zone is currently active says nothing about the creature it makes.

`poolName` narrows the draw to one pool and, when it matches nothing productive, refuses rather than
falling back — a grant from a pool the operator did not ask for is worse than no grant. `level`
overrides only the level; species, growth and abilities still come from the template.
:::

:::note Why the experience and creature grants audit outside the mutating transaction
Every other write here audits inside the transaction that mutates. Progression, and likewise the
spawn and placement path, own their own connections and writes, so there is no transaction to join —
the audit row goes in its own, immediately after a grant that succeeded. The property that matters
still holds and is tested: a row is only ever written for a grant that landed. `RemoveListingAsync`
already works this way for the same reason.

A grant that reports failure *after* the creature was confirmed to exist is an invariant violation,
not a bad id, so it throws rather than answering `NotFound` — calling it not-found would send an
operator hunting for a creature sitting right in front of them.
:::

Registered by `AddModerationDomainServices()` (`AddScoped`). It requires the caller to have already
registered the three Moderation repositories, `IMarketService`, the Trainer/Creature/Item
repositories, `ICreatureProgressionService`, `ICreatureSpawnDomainService`, `ISpawnerRepository`,
`ICreatureInventoryService`, **and the same `IDbConnectionFactory` those domains use** — a mutation
and its audit row commit together, which only works if they share one connection.

## Shadow bans and the market

A shadow-banned account keeps a market that looks completely normal *to itself* while being
invisible to everyone else. The rule is applied by `MarketService`, not here; see
[Creature Market → Hidden sellers](17-creature-market.md#hidden-sellers-shadow-bans). In short:
browse drops the banned seller's rows, single-listing view and buy answer `NotFound`, and
`GET /api/v1/market/mine` is untouched — a seller always sees their own listings.

Two consequences worth knowing:

- **Operator reads must not use the player paths.** `GET /api/v1/admin/market/listings` calls
  `AdminBrowseListingsAsync`, which includes hidden rows and sets `MarketListingView.SellerShadowBanned`
  so the UI can badge them. The player browse would hide exactly the listings an operator most wants
  to see.
- **The post-removal view is read back *as the seller*.** `DELETE /api/v1/admin/market/listings/{id}`
  answers with the updated `MarketListingView`; it fetches that view using the seller's account id
  (taken from the audit row the removal just wrote), because an anonymous read would 404 on a banned
  seller's listing.

## The actor label

Admin tokens are issued against a shared pre-shared key, not against a person, so the only thing
distinguishing two operators is which token they hold. `AdminActor.From(HttpContext, IConfiguration)`
mints the label stored on every audit row:

```
{AdminActorName}:{first 8 chars of the JWT's jti}      e.g.  editor:3f9a1c7d
```

`AdminActorName` defaults to `editor`. The `jti` is read from the **validated** principal
(`JwtRegisteredClaimNames.Jti`, claim type `jti`) — never from the request body — and is unique per
token exchange, so it traces back to a row in `auth_session`.

## Getting an admin token

The admin scope comes from the second pre-shared key on `POST /auth/service-token` (see
[Auth and Accounts](06-auth-and-accounts.md#service-tokens-content-studio-and-live-ops)):

```bash
TOKEN=$(curl -s -X POST http://localhost:8080/auth/service-token \
  -H 'Content-Type: application/json' \
  -d '{"serviceKey":"local-dev-admin-service-key"}' | jq -r .accessToken)

curl -s "http://localhost:8080/api/v1/admin/players?q=al" -H "Authorization: Bearer $TOKEN"
```

`admin` implies `content:write` and `player`; the reverse is not true, so a Content Studio
(`content:write`) token gets **403** from every route below. `AdminServiceKey` left blank or unset
disables the admin exchange entirely — the safe default for a production host.

The only checked-in admin key is the local-dev one in `Convenience/CR.REST.AIO/appsettings.Development.json`.
The standalone Auth and BFF `config.yml` files deliberately carry no `AdminServiceKey`; a deployed host
sets it (and `AdminActorName`) through its environment or secret store, never in a committed config.

## REST routes

`AdminEndpoints.MapAdminEndpoints()`, group `/api/v1/admin`, **every** route
`.RequireAuthorization(AuthorizationPolicies.RequireAdmin)`.

| Method | Route | Body | 200 | Errors |
|---|---|---|---|---|
| GET | `/players?q=&limit=` | | `PlayerSearchHit[]` | 400 `InvalidSearchTerm` when `q` trims to fewer than 2 characters |
| GET | `/players/{accountId}` | | `PlayerDossier` | 404 |
| PUT | `/players/{accountId}/shadow-ban` | `ShadowBanRequest { reason, expiresAt? }` | `AccountModeration` | 400 `InvalidReason`, 404 |
| DELETE | `/players/{accountId}/shadow-ban` | `ReasonRequest { reason }` | `AccountModeration` | 400 `InvalidReason`, 404, 409 `NotBanned` |
| POST | `/trainers/{trainerId}/currency` | `AdjustCurrencyRequest { delta, reason }` | `AdjustCurrencyResponse { currencyAfter }` | 400 `InvalidReason`/`InvalidQuantity`, 404, 409 `InsufficientFunds` |
| POST | `/trainers/{trainerId}/items` | `ItemChangeRequest { itemId, quantity, reason }` | `TrainerDossier` (refreshed) | 400, 404, 409 `StorageFull` |
| DELETE | `/trainers/{trainerId}/items` | `ItemChangeRequest` | `TrainerDossier` (refreshed) | 400, 404, 409 `InsufficientQuantity` |
| POST | `/creatures/{generatedCreatureId}/experience` | `GrantExperienceRequest { amount, reason }` | `GrantExperienceResponse` (below) | 400 `InvalidReason`/`InvalidQuantity`, 404 |
| POST | `/trainers/{trainerId}/creatures/from-spawner` | `GrantCreatureFromSpawnerRequest { spawnerContentKey, poolName?, level?, reason }` | `GrantCreatureFromSpawnerResponse` (below) | 400 `InvalidReason`/`InvalidQuantity`, 404, 409 `NoSpawnCandidate`/`StorageFull` |
| GET | `/market/listings?state=&sellerAccountId=&offset=&limit=` | | `MarketListingView[]` — hidden rows **included**, `sellerShadowBanned` set | |
| DELETE | `/market/listings/{id}` | `ReasonRequest` | `MarketListingView` (post-removal, `state = Cancelled`) | 400, 404, 409 `AlreadySold`/`StorageFull` |
| GET | `/actions?accountId=&trainerId=&listingId=&offset=&limit=` | | `AdminAction[]`, newest first | |

Both item routes and both shadow-ban routes are method pairs on the same path; the two `DELETE`s
that carry a body (`/shadow-ban`, `/trainers/{id}/items`, `/market/listings/{id}`) read it via
`[FromBody]` — minimal APIs accept a request body on `DELETE`, and the reason is not optional, so it
cannot move to the query string.

### Granting experience

The response says what the grant did, so an operator testing an evolution can see it worked without
opening the game:

```json
{ "generatedCreatureId": "6f1c…", "amountApplied": 370,
  "levelBefore": 11, "levelAfter": 12,
  "experienceBefore": 1300, "experienceAfter": 1670,
  "leveledUp": true, "readyToEvolve": true,
  "evolvesIntoCreatureId": "9ab2…", "evolutionBlockedBecause": 0 }
```

`evolvesIntoCreatureId` is null unless `readyToEvolve`. `evolutionBlockedBecause` is the **integer**
of `EvolutionBlockReason` (see [Evolution](16-evolution.md) — note the gap where `LevelTooLow = 2`
used to be), so a Unity client must read it as an int and map it, not as a string.

This is the intended way to test an evolution chain: grant enough experience to cross a rule's
`MinLevel` and the offer is raised server-side, reaching the player as a cutscene next time they
play.

### Granting a creature from a spawn pool

`POST /api/v1/admin/trainers/{trainerId}/creatures/from-spawner` is how a developer gets the
encounter without hunting for it:

```json
{ "spawnerContentKey": "starter-wild-zone", "poolName": null, "level": null,
  "reason": "testing the cindris line" }
```

```json
{ "generatedCreatureId": "6f1c…", "speciesContentKey": "creature_cindris", "speciesName": "Cindris",
  "level": 6, "placedIn": "Team", "slotNumber": 3 }
```

The response is the **roll's** outcome, not an echo of the request: the operator named a zone, the
pool chose the species, and a full team quietly pushes the creature to storage — so `placedIn` is the
string `"Team"` or `"Storage"` and `slotNumber` is the slot in whichever container took it.

`poolName` null rolls the spawner over every pool it can reach, as the world does; naming a pool
restricts the draw to it (case-insensitive) and refuses with 409 `NoSpawnCandidate` if that pool
holds no active template. `level` null uses the selected template's band.

:::tip A rolled creature with no abilities is not a generation bug
A generated creature learns from its template's ability progression set. If the grant comes back with
four empty slots, check whether that set has entries (see
[Creature Generation](04-creature-generation.md)) before suspecting the generator — that is the
failure `M13007RestoreProgressionSetEntries` was written to repair.
:::

### Error shape

Every refusal is the same object, so a client can branch on `reason` without parsing prose:

```json
{ "error": "That account is not currently under an active shadow ban.", "reason": "NotBanned" }
```

`ModerationErrorMapper` maps status once, shared by all routes:

| Reason | Status |
|---|---|
| `NotFound` | 404 Not Found |
| `InvalidReason`, `InvalidQuantity`, `InvalidSearchTerm`, `InvalidArgument` | 400 Bad Request |
| everything else | 409 Conflict |

`InvalidSearchTerm` and `InvalidArgument` are also produced directly by the REST layer — a search
term under two characters, and an `ArgumentException` escaping a service call — using the same
`ModerationReason` names, so a client sees one vocabulary regardless of which layer refused.

### Reading a mutation back

Three routes answer with state rather than an acknowledgement, so the operator's screen never has to
guess what happened:

- the shadow-ban pair returns the `account_moderation` row as it now stands;
- the item pair returns the trainer's slice of the refreshed dossier (looked up via
  `ITrainerRepository.GetTrainerById(trainerId).AccountId` → `GetPlayerDossierAsync`);
- the listing removal returns the post-removal `MarketListingView`.

## Program.cs wiring

```csharp
// Before AddMarketDomainServices(): MarketService resolves the moderation repositories at construction.
builder.Services.AddSingleton<IAccountModerationRepository>(new PostgresAccountModerationRepository(logger, configuration));
builder.Services.AddKeyedSingleton<IAccountModerationRepository>("account_moderation", …);
builder.Services.AddSingleton<IAdminActionRepository>(new PostgresAdminActionRepository(logger, configuration));
builder.Services.AddKeyedSingleton<IAdminActionRepository>("admin_action", …);
builder.Services.AddSingleton<IPlayerSearchRepository>(new PostgresPlayerSearchRepository(logger, configuration));
builder.Services.AddKeyedSingleton<IPlayerSearchRepository>("player_search", …);

builder.Services.AddMarketDomainServices();
builder.Services.AddModerationDomainServices();

if (!isSwaggerGen) new ModerationDatabaseMigratorPostgres().Migrate(configuration);
…
app.MapAdminEndpoints();   // after app.MapMarketEndpoints()
```

Connection string key: `ModerationDatabase` (in local dev, like every other key, the same `cr_dev`
database).

## Tests

| Project | Covers |
|---|---|
| `Moderation/CR.Moderation.Data.Postgres.Test` | Repository round-trips, the four ways a ban fails to be active (missing / deleted / unflagged / lapsed), audit filtering + limit clamp + ordering, the `MaxShadowBannedIds` bound on the banned-id read, and every search branch (prefix, email, account GUID, trainer GUID, no match, deleted trainer excluded, and a `%`/`_` in the term matched literally). |
| `Moderation/CR.Moderation.Domain.Services.Test` | The service against real Postgres: dossier contents, ban idempotency, refusals writing nothing, currency metadata, 1-based backpack slot allocation and `StorageFull`, that a grant reads the backpack through the in-transaction path (proved with a recording repository decorator), a past shadow-ban expiry → `InvalidArgument`, a lift on an unknown account → `NotFound`, that a dossier carries active listings only including ones a shadow ban hides, item removal arithmetic, and that a listing removal produces exactly one audit row. The spawn-pool grant is wired to the **real** spawn, generation and inventory services against the floor-seeded `starter-wild-zone`: the roll's species and level, the creature really existing and owned by that trainer, a forced level the template's band could not have produced, a full team falling back to storage, unknown trainer/spawner, a named pool that holds nothing → `NoSpawnCandidate` with nothing rolled, and exactly one audit row carrying the spawner, species and level. |
| `Convenience/CR.Api.IntegrationTests/AdminEndpointsHttpTests` | The routes end-to-end through the real AIO host: all eleven refuse an anonymous caller (401), a `content:write` token (403) **and an ordinary player's session token (403)**, then — with an admin token — search, dossier, a shadow ban that genuinely hides a listing from another *player's* `GET /api/v1/market/listings` while `/api/v1/market/mine` still shows it, double-lift → 409 `NotBanned`, currency credit and overdraw, item grant/remove and over-removal, the admin feed carrying `sellerShadowBanned`, a removal that puts the creature back in the seller's storage, a second removal → 409 `AlreadySold`, a blank reason → 400 with no row written, `/actions` newest-first, and a spawn-pool grant that rolls `starter-wild-zone`, lands a real Cindris on the trainer's team at the forced level and audits once (plus its 404/400/409 refusals, each leaving no creature behind). |

## Related

- [Creature Market](17-creature-market.md) — the hidden-seller rule, `AdminRemoval` transactions, and the transfer core the removal route reuses.
- [Auth and Accounts](06-auth-and-accounts.md) — service tokens, `AdminServiceKey`, the scope ladder.
- [Trainer Currency](12-trainer-currency.md) — the balance `AdjustCurrencyAsync` moves.
- [Item Spawner & Merchant Stock](11-item-spawner.md) — the `items` catalogue `GrantItemAsync` grants from.
- [Spawner System](03-spawner-system.md) — the pools, templates and weighted draw `GrantCreatureFromSpawnerAsync` rolls.
- [Creature Generation](04-creature-generation.md) — `CreateFromSpawnerAtLevelAsync` and what a template decides.
