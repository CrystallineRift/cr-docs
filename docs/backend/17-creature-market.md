# Creature Market

A player-to-player marketplace for trading creatures: list a creature you own for an asking
price, another trainer buys it, currency and ownership move atomically. `CR.Market.*` is a
self-contained domain — its own tables, its own migrations, its own service — that reaches
into the Trainer and Creature domains only through their repository interfaces, never their
tables directly.

## Data model

| Table | Columns of note | Notes |
|---|---|---|
| `market_listing` | `seller_account_id`, `seller_trainer_id`, `generated_creature_id`, `asking_price`, `state` (int, `ListingState`), `fee_paid`, `expires_at`, soft-delete | One row per listing, any state. `seller_trainer_id` is nullable only because it was added after `M12001`; every listing created by the current service always sets it. |
| `market_transaction` | `listing_id`, `seller_account_id`, `buyer_account_id` (null for cancellations and admin removals), `generated_creature_id`, `price`, `fee`, `kind` (`Sale` \| `Cancellation` \| `AdminRemoval`), `occurred_at` | Append-only audit log, one row per terminal event on a listing. Never updated. |

Both tables are created by `M12001CreateMarketListingTable` / `M12002CreateMarketTransactionTable`
(dual SQLite/Postgres, ANSI SQL). `M12003AddSellerTrainerIdToMarketListing` backfills the trainer
column onto the pre-existing listing table.

### The escrow trainer

`M12004SeedMarketEscrowTrainer` seeds a fixed system account/trainer pair
(`MarketConstants.MarketEscrowAccountId` / `MarketEscrowTrainerId`, both literal
`00000000-…-0000000000e1`/`…e2` GUIDs) and is guarded on `accounts`/`trainers` existing, so it's a
no-op if the Market domain is migrated standalone without those tables. While a listing is
**Active**, the creature's `generated_creature.current_trainer_id` is reassigned to this trainer —
not to a sentinel/null value. That means:

- The same `ReassignCurrentTrainerInTransactionAsync` codepath used for every other ownership move
  (buy, cancel) also covers the move *into* escrow — there is no separate "detach" operation to get
  wrong.
- A listed creature always has a real, queryable owner. `SELECT * FROM generated_creature WHERE
  current_trainer_id = <escrow trainer id>` is a legitimate way to audit everything currently
  listed, independent of `market_listing`.

The id literal is duplicated between the migration (`M12004SeedMarketEscrowTrainer`, which the
domain-services project cannot reference) and `MarketConstants` (which the migration project cannot
reference) — change one, change the other, deliberately, there's no way to share a single source
without introducing a project reference cycle.

## The market transfer core

`IMarketService` is the **sole** entry point through which creature ownership moves as part of a
trade. Every mutation for a single operation — fee debit, creature reassignment, inventory-row move,
listing/transaction writes — runs inside one database transaction opened by `IDbConnectionFactory`, so a mid-flight
failure can never leave money moved without the creature moving too (or vice versa). Business-rule
refusals are returned as a `MarketOperationResult` (`Success`, `Reason`, optional `Listing`/
`Transaction`), never thrown; `InvalidOperationException` is reserved for invariant violations that
should be impossible given valid inputs (e.g. a compare-and-swap that already checked its
precondition failing to apply).

### Listing (`ListCreatureAsync`)

Refused, in order, when: the acting trainer doesn't currently own the creature (`NotOwned`); the
acting trainer isn't found or doesn't belong to the acting account (`NotOwned`); the creature has
`is_tradable = false` (`NotTradable`); the acting *account* already holds `MarketMaxActiveListings`
`Active` listings (`ListingLimitReached`); the creature is the only member of the acting trainer's
active team (`LastTeamMember`); the trainer can't afford the fee (`InsufficientFunds`).

**`is_tradable`** (`M1032AddIsTradableToGeneratedCreature`, default `true`) exists purely to lock
story-critical creatures — starters — out of the marketplace. It's a flag on the *generated*
creature, not the species, so a player's starter is locked but every other Cindris they catch later
is tradable.

**Ownership vs. containment.** `generated_creature.current_trainer_id` says who *owns* a
creature; whether it sits on the team or in storage is a row in `trainer_creature_inventory_items`
keyed by the trainer's `creature_team_inventory_id` / `creature_storage_inventory_id`. The market
moves **both**: listing removes the creature's row from whichever container holds it
(`FindHoldingInventoryAsync`), buying adds a row to the buyer's storage, cancelling adds a row back
to the seller's storage (never the team — the old slot may be taken by now). Without the row move a
listed creature stayed a ghost in the seller's storage and a bought one never appeared for the
buyer at all.

**Last-team-member rule.** Team creatures may be sold directly — no "swap to storage first" step —
but a trainer can never be left with an empty team, so listing refuses `LastTeamMember` when the
creature is on the team and it's the only entry there. The service reads the team inventory via
`ITrainerCreatureInventoryRepository.GetCreatures` because that read *is* the only definition of
"on the team" the schema has.

**Storage placement.** `FindFreeStorageSlotAsync` picks the lowest free 1-based slot, mirroring
`CreatureInventoryService.FindNextAvailableSlot`, capped at the storage capacity (1000, matching
`GetMaxCapacityAsync`). No free slot → `StorageFull`, checked *before* the transaction so a full
buyer never wins the compare-and-swap. A trainer without a storage inventory is an invariant
violation (every trainer is created with one) and throws.

**Listing cap.** `MarketMaxActiveListings` (default `5`) bounds how many `Active` listings one
account may hold at once — the cap is per **account**, like the own-listing check, so a second
trainer under the same account cannot be used to get around it. The count comes from
`IMarketRepository.CountActiveListingsBySellerAsync` (only `state = Active`, `deleted = false`),
so cancelling or selling a listing frees a slot immediately. Checked before the fee, so a capped
player is told "limit reached" rather than "can't afford it".

**Fee formula:** `fee = feeBase + round(askingPrice * feePercent, AwayFromZero)`, clamped to a
minimum of 0. `feeBase` (`MarketListingFeeBase`, default `10`) and `feePercent`
(`MarketListingFeePercent`, default `0.05`) — like the cap — are read from `IConfiguration` per call — a missing or
unparseable value logs a warning and falls back to the default rather than throwing, so a
misconfigured environment degrades to the documented default instead of taking listing down
entirely. All three keys live in `CR.REST.AIO/appsettings.Development.json` and
`CR.Game.Service.BFF/config.yml`.

On success: fee is debited from the seller's trainer, the creature is reassigned to the escrow
trainer, and an `Active` listing is created — all in one transaction, in that order (debit first,
so a failed debit never leaves the creature moved).

### Buying (`BuyListingAsync`)

Refused when: the listing isn't `Active` (`AlreadySold`); the buyer is the seller's own account
(`CannotBuyOwn` — checked by account, not trainer, so a second trainer under the same account also
can't buy it); the buyer's trainer can't afford the asking price (`InsufficientFunds`).

**Compare-and-swap, not a lock.** The `Active → Sold` transition happens first, inside the
transaction, via `UpdateListingStateInTransactionAsync(id, expectedState: Active, newState: Sold)` —
an `UPDATE … WHERE state = @expectedState` that only ever affects one row across any number of
concurrent callers. Whichever caller's `UPDATE` actually changes a row is the only one that proceeds
to debit/credit currency and reassign the creature; every loser rolls back immediately (nothing else
happened yet) and reports `AlreadySold` rather than throwing or retrying. This is the same pattern
`TwoBuyersRaceForSameListing_OnlyOneUpdateWins` and the HTTP-level
`TwoBuyersRaceOneListing_ExactlyOneWinsAndCreatureHasExactlyOneOwner` pin: two real concurrent HTTP
requests against the same listing resolve to exactly one 200 and one 409, and the creature has
exactly one owner afterward — never both, never neither.

On success: buyer is debited the asking price, seller is credited the same amount, the creature
reassigns to the buyer's trainer, and a `Sale` transaction is recorded.

### Cancelling (`CancelListingAsync`)

Only the seller's own account can cancel, only while `Active` (`AlreadySold` otherwise — cancelling
a sold/expired listing is nonsensical, not a "not found"). Restores the creature to
`listing.SellerTrainerId` — never the current caller's trainer, since the seller's account could in
principle be acting through a different trainer than the one that listed it. A listing with no
`SellerTrainerId` recorded (pre-`M12003` row) throws `InvalidOperationException` rather than
guessing an owner.

**The listing fee is never refunded on cancel.** This is deliberate — a refundable fee makes
list/cancel free scanning of the market's escrow behavior, and more importantly turns "list, then
cancel" into a way to move a creature into/out of escrow for free with no cost to spamming listings.

### Admin removal (`AdminRemoveListingAsync`)

An operator pulling an abusive listing off the market runs the *same* body as a cancel — the
`Active → Cancelled` compare-and-swap, the creature out of escrow and back into the seller's storage,
a `market_transaction` row — and the two share a private `ReturnListingToSellerAsync(listing,
sellerTrainer, storageSlot, newState, kind, transaction, ct)` so they can never drift apart. What
differs:

- No ownership check: the actor is an operator, not the seller.
- `TransactionKind.AdminRemoval` instead of `Cancellation`, which is what tells the two apart
  afterwards — the listing itself ends in the same `Cancelled` state either way.
- One `admin_action` row (`Kind = RemoveListing`, `TargetAccountId`/`TargetTrainerId` = the seller,
  `TargetListingId`, the operator's `Reason`, and `Metadata` `{"askingPrice":250,
  "generatedCreatureId":"…"}`) written by `IAdminActionRepository.RecordInTransactionAsync` **on the
  same transaction**. An audit row that survived a rolled-back removal would accuse an operator of
  something that never happened, so it commits with the removal or not at all.

Refusals: `NotFound` (missing/deleted listing, or a seller trainer that no longer exists),
`AlreadySold` (not `Active`), `StorageFull` (the seller has no free storage slot — the creature has
to land somewhere, and silently dropping it is not an option). **None of them write an audit row.**
The listing fee is not refunded here either.

See [Moderation](18-moderation.md) for the operator-facing service and routes that call this.

## Hidden sellers (shadow bans)

An account under an active shadow ban (`account_moderation.shadow_banned`, live row, not lapsed —
see [Moderation](18-moderation.md)) keeps a market that looks completely normal *to itself* while
being invisible to everyone else. `MarketService` applies that at the service layer, on the three
paths a non-seller can reach a listing through:

| Path | Behaviour when the seller is banned |
|---|---|
| `BrowseListingsAsync(filter, offset, limit, viewerAccountId, ct)` | Rows whose `SellerAccountId` is in `IAccountModerationRepository.GetShadowBannedAccountIdsAsync(now)` are dropped, unless `viewerAccountId == SellerAccountId`. |
| `GetListingViewAsync(listingId, viewerAccountId, ct)` | `null` (→ `404`) for anyone but the seller. |
| `BuyListingAsync` | `NotFound`, checked **before** the compare-and-swap so nothing moves. Matches what browse and view already told this buyer. |
| `GetMyListingsAsync` | Unchanged. A seller always sees their own listings, banned or not — that is the point. |

`viewerAccountId` is `Guid?`: **null is anonymous, and anonymous is "somebody else"**, so hidden rows
drop. The REST layer passes `context.User?.GetAccountId()` (the nullable form — a token without a
readable account claim reads as anonymous rather than throwing mid-browse).

**Browse pages can come back short.** The repository pages first and the hidden rows are removed
after, so a `limit=50` page may return fewer than 50 rows (even zero) while later pages still hold
rows. That is the accepted trade: the ban list is small, and pushing a moderation join into the hot
player-facing browse query to keep pages exactly full is not worth it. A paging client must key off
several consecutive short pages, not one.

## Views: browsing without a round-trip per creature

`MarketListing` only carries `GeneratedCreatureId` — enough to *identify* the creature, nothing to
*render* it. A browse screen showing species, level, and seller name for each of 50 listings would
otherwise need 50 follow-up creature lookups. `MarketListingView` (`CR.Market.Model.REST`) is every
`MarketListing` field plus:

| Field | Source |
|---|---|
| `BaseCreatureId` | `generated_creature.base_creature_id` |
| `SpeciesContentKey` | `creature.content_key` |
| `SpeciesName` | `creature.name` |
| `Nickname` | `generated_creature.given_name` (nullable — there is no separate "nickname" column; `given_name` *is* the nickname) |
| `ElementType` | `creature.element_type` |
| `Level` | `generated_creature.level` |
| `SellerTrainerName` | `trainers.name`, via `LEFT JOIN` on `seller_trainer_id` (null for the rare pre-`M12003` row with no trainer recorded) |
| `GrowthProfileName` | `growth_profile.name`, via `LEFT JOIN` on `generated_creature.growth_profile_id` — display only |
| `ExperienceGrowth` (float), `HitPointsGrowth`, `AttackGrowth`, `DefenseGrowth`, `SpecialAttackGrowth`, `SpecialDefenseGrowth`, `SpeedGrowth` (int) | the matching `growth_profile` columns |
| `SellerShadowBanned` | `account_moderation`, via a `LEFT JOIN` carrying the active-ban predicate — **only populated by the admin browse below**; every player-facing path leaves it `false` because it never returns a hidden row at all |

`IMarketRepository` exposes view-returning siblings of every read method —
`GetActiveListingViewsAsync`, `GetListingViewsBySellerAsync`, `GetListingViewAsync` — built with the
same `JOIN generated_creature gc … JOIN creature c …` shape `GetActiveListingsAsync` already used
for its `baseCreatureId`/`elementType`/`level` filters, plus a `LEFT JOIN trainers`. The plain
(non-view) methods are kept — `ListCreatureAsync`/`CancelListingAsync`/`BuyListingAsync` still read
and write bare `MarketListing` rows, since the transfer core only ever needs the listing itself, not
what it displays as.

`IMarketService.BrowseListingsAsync` and `GetMyListingsAsync` return `IReadOnlyList<MarketListingView>`
(a breaking signature change from the pre-view `MarketListing` return type — there is exactly one
caller of each, the REST endpoints, updated in the same change). `GetListingViewAsync(listingId)` is
new: it backs `GET /listings/{id}` and returns a listing **in any state**, not just `Active` — a
seller needs to look up a listing they just sold, which a filtered-to-`Active` lookup would 404.

### The operator browse

`GetListingViewsAdminAsync(state, sellerAccountId, offset, limit, ct)` (behind
`IMarketService.AdminBrowseListingsAsync`) is the one read that deliberately returns hidden listings:
every non-deleted listing, newest first, in any state unless `state` narrows it, optionally for one
seller account, page size clamped to 200 rather than the usual 100. It adds

```sql
LEFT JOIN account_moderation am ON am.account_id = ml.seller_account_id
  AND am.shadow_banned = @banned AND am.deleted = @moderationDeleted
  AND (am.shadow_ban_expires_at IS NULL OR am.shadow_ban_expires_at > @now)
```

and derives `SellerShadowBanned` from `(am.account_id IS NOT NULL)`. The join carries the *active*-ban
predicate rather than just the flag, so a lapsed ban reports the seller as clear here exactly as it
does everywhere else; it is a `LEFT` join so an unmoderated seller (no row at all) reads as `false`
instead of dropping their listings. Booleans go through parameters, never literals, because the same
SQL has to be right on SQLite and Postgres.

**Element-type filtering tolerates both stored spellings.** `creature.element_type` is a varchar
holding the `ElementType` enum in two forms: the enum *name* on hand-written seeds (Cindris:
`'Fire'`) and the enum *ordinal* on everything written through `BaseCreatureRepository` or a Studio
push (Dapper binds the enum as an int, so the roster reads `'8'` for Poison). Creature reads survive
because `Enum.Parse` accepts both; a raw SQL compare did not — a client sending `?element=Poison`
matched nothing in a real database, and browse rows displayed `8 • Lv 5`. `CreatureElementText`
(Market.Data) resolves the incoming filter to both forms and both filter queries emit
`(UPPER(c.element_type) = UPPER(@elementName) OR c.element_type = @elementOrdinal)` — ANSI, so the
same on SQLite — while every view read maps `ElementType` back to the display name (`"Poison"`).
The market normalises on read rather than rewriting the column because the ordinal writers live in
the Creatures domain and would reintroduce it. Unknown element text simply matches nothing.

## Advanced search — growth values

Two Cindris at the same level are not the same creature: what separates them is the growth profile
they level with. Advanced search filters on **the numbers in that profile, not on which profile it
is**. A buyer wants "attack growth ≥ 150", and every profile clearing that bar is an equally good
match, whatever it's called — so there is deliberately no filter on `growth_profile_id` or
`growth_profile.name`. `GrowthProfileName` rides along on the view purely so a row can label what
the buyer is looking at.

Seven values, each with an independent, inclusive min/max:

| Query param | Type | `growth_profile` column | Semantics |
|---|---|---|---|
| `minExpGrowth` / `maxExpGrowth` | float | `experience_growth` | Percent of the base experience curve. **Lower is faster**: 50 fast, 100 normal, 200 slow — so "levels quickly" is a *max* bound, not a min. |
| `minHpGrowth` / `maxHpGrowth` | int | `hit_points_growth` | Percent of base; 100 is unmodified. |
| `minAtkGrowth` / `maxAtkGrowth` | int | `attack_growth` | " |
| `minDefGrowth` / `maxDefGrowth` | int | `defense_growth` | " |
| `minSpAtkGrowth` / `maxSpAtkGrowth` | int | `special_attack_growth` | " |
| `minSpDefGrowth` / `maxSpDefGrowth` | int | `special_defense_growth` | " |
| `minSpdGrowth` / `maxSpdGrowth` | int | `speed_growth` | " |

Bounds are ANDed with each other and with the existing `species`/`element`/level/price filters.
An inverted range (min above max) can only ever match nothing, so it is treated as a client bug:
`400 { "message": "minAtkGrowth must be less than or equal to maxAtkGrowth." }`. Equal bounds are a
legal single-value search. The same rule now also covers `minLevel`/`maxLevel` and
`minPrice`/`maxPrice`, which previously returned an empty list when inverted.

**The join.** `LEFT JOIN growth_profile gp ON gp.id = gc.growth_profile_id` (`LOWER()` on both sides
in the SQLite branch, matching the existing joins). It is a LEFT join because a creature whose
`growth_profile_id` resolves to no row must still be browsable rather than silently vanishing from
the marketplace; each value is `COALESCE`d to `0` and the name left null. The flip side is that such
a creature drops out of *any* bounded search — `NULL >= 150` is not true — which is correct: its
growth is unknown, not zero.

**`experience_growth` is `CAST(… AS REAL)` in the SELECT.** Dapper builds one deserializer from the
first row of a result set; on SQLite a NUMERIC column whose first row happens to hold a whole number
comes back as `long` and every later row fails to map. The cast is ANSI and valid on Postgres
(`real`) too, so both engines share one column list.

Wire-up: `MarketGrowthFilter` (`CR.Market.Model.REST`, so the data layer can see it) holds the
fourteen nullable bounds; `MarketListingFilter` (Domain.Services) *inherits* it, which is why
`MarketService.BrowseListingsAsync` can hand the filter straight to
`IMarketRepository.GetActiveListingViewsAsync(…, growth: filter, ct)` with no mapping step.
`BaseMarketRepository.AppendGrowthRangeFilters` emits one `AND gp.<col> >= @min…` / `<= @max…` per
set bound, in the style of the existing `AppendElementFilter`.

## REST

| Method | Route | Auth | Notes |
|---|---|---|---|
| GET | `/api/v1/market/listings` | Player | Browse `Active` listings, filterable by `species` (base creature id), `element`, `minLevel`/`maxLevel`, `minPrice`/`maxPrice`, and the fourteen growth bounds above; `offset`/`limit` are required. Returns `MarketListingView[]`, or `400 { message }` on an inverted range. Listings from shadow-banned sellers are omitted for every caller but the seller (so a page can be short — see above). |
| GET | `/api/v1/market/listings/{id}` | Player | Single listing, any state, as `MarketListingView`. `404` if absent/deleted **or hidden from this caller by the seller's shadow ban** — **not** gated on `Active`, so a seller can look up a listing that already sold. |
| POST | `/api/v1/market/listings` | Player | List a creature. Body: `{ generatedCreatureId, askingPrice }`. Acting trainer via `X-Trainer-Id` header (never the body — mirrors the buy endpoint). |
| DELETE | `/api/v1/market/listings/{id}` | Player | Cancel the caller's own `Active` listing. |
| POST | `/api/v1/market/listings/{id}/buy` | Player | Buy an `Active` listing on behalf of the acting trainer (`X-Trainer-Id` header). |
| GET | `/api/v1/market/mine` | Player | Caller's own listings, any state, as `MarketListingView[]`. |
| GET | `/api/v1/market/rules` | Player | `MarketRules { maxActiveListings, listingFeeBase, listingFeePercent }` — the configured values `ListCreatureAsync` enforces, so the client can show "Listings 2/5" and compute the fee without hard-coding what the server owns. |

The operator-facing market routes (`GET /api/v1/admin/market/listings`,
`DELETE /api/v1/admin/market/listings/{id}`) live in the Moderation domain and are documented in
[Moderation](18-moderation.md); they call `AdminBrowseListingsAsync` / `AdminRemoveListingAsync` here.

### Status mapping

`MarketEndpoints.MapResult` translates `MarketOperationResult.Reason` to an HTTP status once, shared
by list/cancel/buy:

| Reason | Status |
|---|---|
| `NotOwned`, `CannotBuyOwn` | 403 Forbidden |
| `NotTradable`, `LastTeamMember`, `AlreadySold`, `StorageFull`, `ListingLimitReached` | 409 Conflict |
| `InsufficientFunds` | 402 Payment Required |
| `NotFound` | 404 Not Found |
| anything else (validation failures) | 400 Bad Request |

The account id is always read from the authenticated `HttpContext` (`context.GetAccountId()`),
never trusted from a request body — the same rule every other domain follows for "who is acting".

## Test coverage

- **`CR.Market.Data.Postgres.Test`** (Testcontainers Postgres) — CRUD and paging on
  `market_listing`/`market_transaction`, the CAS state transition, and the view queries: joined
  species/level/seller-name fields, that the element-type filter matches regardless of case and
  finds ordinal-stored elements by name or ordinal (and displays the name on every view read), and
  that the per-seller active count ignores other sellers and non-`Active` states. Advanced search
  gets two dedicated tests against real `growth_profile` rows (prefix `market_test_gp_`, cleaned up
  per test): that every growth value and the profile name reach the view (including the float
  `experience_growth`, pinning the `CAST … AS REAL`), and that min/max bounds select on values —
  a band bracketing two different profiles returns both (18 tests).
- **`CR.Market.Domain.Services.Test`** (Testcontainers Postgres, real repositories, no mocks) — the
  security-critical properties of the transfer core: ownership only ever moves paired with the
  matching currency change, non-tradable creatures and a trainer's last team member can never be
  listed, the inventory row follows the creature (team/storage → escrow on list, buyer's storage on
  buy, seller's storage on cancel, lowest free slot, `StorageFull` at 1000, untouched on a refused
  fee), the listing cap is enforced per account (a second trainer on the account is refused too)
  and a cancel frees a slot, `GetRules` reflects configuration, and two concurrent buyers resolve
  to exactly one winner. Plus three browse tests proving the growth bounds survive the service→
  repository hop, that the view carries the growth values, and that a creature with an unresolvable
  growth profile stays browsable (zeroed values, null name) while dropping out of any bounded search.
  Moderation adds twelve more against real `PostgresAccountModerationRepository` /
  `PostgresAdminActionRepository` (the Moderation migrations are applied by
  `MarketDomainServicesTestMigrator` alongside Market's): a banned seller's listing is absent for
  another viewer and for an anonymous viewer but present for the seller, an unrelated seller is
  unaffected, a lapsed ban is visible again, `GetListingViewAsync` is null to others and a view to
  the seller, `BuyListingAsync` refuses `NotFound` with the listing still `Active` and nothing debited,
  `/mine` still lists it; admin browse includes the hidden row with `SellerShadowBanned == true` and
  filters by state and seller (and reports a lapsed ban as clear); `AdminRemoveListingAsync` returns
  the creature to the seller's storage with `current_trainer_id` = seller, records an `AdminRemoval`
  transaction and **exactly one** `admin_action` row with the right actor/reason/targets/metadata,
  while missing → `NotFound`, non-`Active` → `AlreadySold` and a full seller storage → `StorageFull`
  each leave **no** audit row; and a plain `CancelListingAsync` still records a `Cancellation` and no
  audit row at all, pinning the shared-body refactor (32 tests).
- **`CR.Api.IntegrationTests`** (`MarketHttpTests`, real AIO host + Postgres) — the whole stack
  (routing, `[Authorize]`, header parsing, service, repository) end to end: list → appears in browse
  (with the joined view fields) → buy → appears sold in `/mine` and via the single-listing endpoint
  → currency, ownership and the buyer's storage row actually moved in the database. Plus the
  two-buyer HTTP race, `/rules` (401 anonymous, configured values when authenticated) and listing
  past the cap → `409` with `reason = ListingLimitReached` and the creature still with the seller.
  Advanced search adds two: the growth query params actually narrow the browse feed over the wire
  (and the JSON rows carry `attackGrowth`/`experienceGrowth`/`growthProfileName`), and an inverted
  range returns `400` naming both offending params while equal bounds return `200` (6 tests).

## Related

- [Moderation](18-moderation.md) — `account_moderation`/`admin_action`, shadow bans, and the operator routes that drive admin browse/removal.
- [Trainer Currency](12-trainer-currency.md) — the balance the listing fee and sale price debit/credit.
- [Creature Generation](04-creature-generation.md) — `generated_creature`, `is_tradable`, ownership (`current_trainer_id`).
