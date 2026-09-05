# Changelog

## 2026-09-05 — Every server error has a status, a body and player-facing text

- **One exception family for the HTTP client.** `SimpleWebClient` now classifies every non-2xx
  through `ServerResponseClassifier.ForStatus` into a `ServerRequestException` subclass
  (400/401/402/403/404/409 typed, 5xx `InternalServerErrorException`, 429 and other codes the
  base type) and wraps Best HTTP's transport failures — refused connection, DNS, TLS, timeout —
  as `ServerUnreachableException` (`StatusCode == 0`). Each carries `StatusCode`, the raw `Body`,
  `IsTransient`, and a `Message` that is always safe to show a player: the server's explanation
  when it sent one, otherwise a per-status default ("Not found.", "Sign-in required.",
  "Server error - try again.", "Can't reach the server."). Cancellation stays a plain
  `TaskCanceledException`. The types moved from `CR.Core.Data.Client.Implementation` to the
  engine-free `CR.Core.Data.Logic` assembly so the whole path is unit-tested (69 new tests).
  `Message` is chosen by `ServerErrorMessage.ForPlayer`: a 5xx body (the server's own exception
  text) is never shown, nor is the reason phrase, nor a body longer than a toast; 429 counts as
  transient. The 401 re-auth decision lives in `AuthRetryPolicy` and is pinned by tests.
- **`ServerErrorMessage` reads every body shape cr-api produces** — `message`, the market's
  `errorMessage`, `error`, ProblemDetails `detail` before `title`, or a short bare string — for
  all statuses, not only 400.
- **`PlayerErrorText.For(Exception)`** is the one rule for what a player sees when an operation
  fails: a server refusal shows its own wording, a cancel shows nothing, anything else shows
  "Something went wrong." rather than an `Object reference not set…` line. Wired into the battle
  bag (any server refusal reaches the battle log, not only a 400), giving / taking back held items
  on the team screen, merchant purchases and character creation. In battle, a request that got no
  answer is worded as "the item may still have been used" rather than as a refusal, and the bag is
  refreshed. The editor sync helpers share one `DescribeFailure` (PUT/POST and DELETE) that
  delegates to `ServerErrorMessage`, so an author sees the real reason for a 409 or 500; the
  status-condition push now branches on the status code rather than on `message.Contains("404")`,
  which the richer message would otherwise have satisfied for a 409 mentioning a 404 and rewritten
  the asset's id.
- **Version check** still degrades to offline on any server failure (the documented contract) but
  logs transient and refused cases separately. No boot-time toast: boot is mode-neutral and an
  "unreachable" line there would nag deliberately-offline players — the message surfaces at the
  first online action instead.

## 2026-09-05 — Battle follow-ups and a Review window for unpushed content

- **Battle HUD drops the species portraits.** The creature is standing right there; the two
  portrait slots, their USS and `RefreshPortraitAsync` are gone, and `BattleHUD.Init` no longer
  takes the icon-resolving services it only used for them.
- **"Beat Trainer Kael"** — the battle summary's subtitle names the trainer on a trainer win
  (`BattleOutcomeSubtitle.For`, 6 tests). `BattleResult` carries `DefeatedNpcDisplayName`; the
  coordinator stamps it from the request only when the player won.
- **Items can target a specific creature in battle.** Picking a potion, revive or cure from the
  bag now opens a target list (one row per team member, fainted ones included) instead of quietly
  aiming at the active creature. Rows the item cannot be used on stay visible but disabled, and
  pressing one says why. `TargetCandidateBuilder` is shared with the overworld bag;
  `BattleItemTargeting.NeedsChoice` decides which items ask (5 tests).
- **Real server refusals in the battle log.** A 400 now surfaces the server's `message` ("This
  item cannot be used in battle.") instead of the bare "Bad Request" — `ServerErrorMessage.From`
  (6 tests) in `SimpleWebClient`.
- **Content Studio: Review.** A **Review** button beside **Push All** opens a window listing every
  edit not yet pushed, grouped by content type, with **Diff** (field-by-field against the server's
  copy), **Push** (one asset) and **Revert** (confirm-gated, takes the server's copy). Push stamps
  are now kept per asset as well as per tab, so pushing two of five edited creatures leaves the
  pill saying three remain. Pure logic (`ContentReviewRows`, `FieldDiff`, the 3-arg
  `ContentPushStatus.Evaluate`) ships with 16 new tests.

## 2026-09-04 — Items you can actually use on a creature, and icons everywhere

- **Why:** the Bag could show items and refuse them, but there was almost nothing worth using. There
  were no potions, no revives and no cures in the catalogue; two of the status conditions cure items
  would target did not exist; the targeting UI answered "who?" *before* the player picked an item; and
  every icon slot in the game was blank because five separate screens were loading a **prefab** key as
  a `Sprite`.
- **15 new consumables (`M6020SeedCreatureConsumables`):** Super / Hyper / Max Potion, Revive, Max
  Revive, Full Heal, and nine single-condition cures (Antidote, Burn Salve, Awakening, Paralyze Heal,
  Ice Melt, Clarity Tonic, Quickstep, Skyroot, Fortify Tonic). All `item_type = 0` (`Consumable`),
  `usage_flags = 7`, `is_consumable`, ids exactly the authored `ItemDefinition` GUIDs. Enum values are
  **cast from `ItemType`/`ItemEffectType`/`ItemUsageFlags`**, not typed — the `M6019` lesson.
- **Two new statuses + the abilities that inflict them (`M12011SeedStatusHooks`):** `Asleep` (Speed −6,
  2 turns) and `Paralyzed` (Speed −4, 3 turns), plus four `ability_status_conditions` links —
  Spark and Thunder Fang → Paralyzed, Miasma and Energy Ball → Asleep. Without an inflictor the cure
  items could only ever reach `CureStatusHandler`'s refusal. `Frozen` was **not** re-authored: M10018
  already owns it as the primer half of the Shatter reaction, and a second seed would have been
  swallowed by the idempotency clause with the authored id never existing. Cure matching is by name,
  which is why Ice Melt still works.
- **`icon_asset_key` on four tables (`M6021`, `M12012`):** `item`, `creature`, `abilities`,
  `status_conditions`. Nullable, no default — a defaulted string would point every un-authored row at
  an address that does not exist, and the UI could not tell "no icon" from "icon missing". `IconAssetKey`
  on `BaseItem` / `BaseCreature` / `BaseAbility` / `BaseStatusCondition` and on both content-manifest
  entry types; copy constructors carry it, or it would be silently dropped on every re-projection.
- **Backfilled the four columns (`M6022`, `M12013`):** every seeded row landed null, because the seeds
  ran before the column existed — so the whole game rendered placeholders and nothing reported an
  error. Both migrations derive the key from what the importer already uses as the address
  (`'icons/items/' || content_key`, `'icons/creatures/' || content_key`, `'icons/abilities/' || name`,
  `'icons/status/' || name` — names verbatim, spaces and capitals included, because
  `icons/abilities/Thunder Fang` is the address the catalog will hold). `WHERE icon_asset_key IS NULL`
  only, so an authored key survives; `Down()` is a documented no-op on both. Packages rebuilt, floor
  re-baked to schema version 12013 (23 items on `icons/items/%`, zero nulls left anywhere), live
  Postgres migrated. **A seed numbered above 6022 / 12013 must set the column itself** — a backfill
  runs once per database, and nothing guards that with a test.
- **17 new content assets:** the 15 `ItemDefinition`s (`Assets/CR/Content/Defs/Items/item_*.asset`,
  ids = the M6020 GUIDs verbatim, `displayNameKey = <contentKey>_display`,
  `iconKey = icons/items/<contentKey>`) plus `Asleep.asset` and `Paralyzed.asset`
  (`StatusConditionConfig`, `iconKey = icons/status/<name>`). The fifteen items were also registered on
  `ContentDefinitionProvider.asset` — an unregistered `ItemDefinition` is an orphan the offline
  `ScriptableObjectContentRegistry` never sees, so the authored key would have reached nothing offline.
- **New endpoint:** `GET /api/v1/trainers/{trainerId}/creatures/{creatureId}/status-conditions` →
  `CreatureStatusConditionView(StatusConditionId, Name, IconAssetKey, TurnsRemaining)`. No policy of
  its own, which means `AddCrAuth`'s fallback `RequireAuthenticatedUser` applies — **401**, not
  anonymous. 404 for a missing creature *and* for one that is not this trainer's, pinned separately so
  a regression to `Ok(empty)` cannot tell the Bag a non-existent creature is healthy. A condition whose
  definition was soft-deleted comes back as `Name = "Unknown"` rather than a raw GUID.
- **Bag rework:** the six-slot party strip is gone (`CreatureSelectorStrip.cs` deleted), the item list
  is a `ScrollView`, and targeting is asked for **after** the press by a modal `CreatureTargetPicker`.
  Refused cards stay on screen, disabled, with the reason underneath — "why can't I use this here" is
  the question a hidden card cannot answer. `BagItemPolicy.Decide` lost its `hasCreatureSelected`
  parameter: `CanUse == ShowUse`, `CanEquip == ShowEquip`. New engine-free rules in `CR.UI.Logic`:
  `ItemTargetIntent`, `ItemTargetRule`, `ItemUseResultText`, `TargetCandidate`, `TargetVerdict`,
  `StatusBadge`, `SpeciesInfo` — `CR.UI.Logic.Tests` finished at 113 green, the full EditMode suite at
  1432. Every use now toasts what actually happened, from the server's own `ItemUseResult`; before, a
  refusal went to the Unity console and the player saw nothing.
- **Icons everywhere:** `IconAddress.For(type, key)` = `icons/<type>/<key>` (`items`, `creatures`,
  `abilities`, `status`), `IconGlyph.From(name)` for the two-letter placeholder, and `UiIcon.Apply` as
  the **one** caller of `LoadAssetByKeyAsync<Sprite>` in the project. `icon` + `iconKey` on
  `ItemDefinition` / `CreatureDefinition` / `AbilityConfig` / `StatusConditionConfig`, drawn by a shared
  `IconSlotField` row that derives the key from the assigned sprite. Wired into the Bag, Team, Storage,
  Journal, achievement toasts, Merchant Shop, Market, the battle bag and the battle HUD — where the
  status badge stopped being a four-letter name truncation (which made "Confused" and "Confounded" the
  same badge) and portraits appeared for the first time.
- **The target picker's portraits are real.** The bag had been resolving each species purely to read
  `.Name` and throwing the row away, so every card was built with `null` in the `IconKey` slot even
  after the column existed — the one call that had the answer had already discarded it. New engine-free
  `SpeciesInfo(Name, IconKey)` carries both off the one fetch, with `From` normalising a blank name to
  *no entry* and a blank key to `null`. Picker status chips are now two shapes: a plain text `Label`
  when the condition has no icon, a 14px sprite chip (tooltip = the name) when it does, decided by
  `StatusBadge.HasIcon`.
- **Online cache:** `ContentSyncWriter` writes `icon_asset_key` for `abilities` and `creature`
  (column list, `VALUES` and `ON CONFLICT … DO UPDATE`, bound through `NullIfBlank` so `""` stores as
  `NULL`). `item` is not synced by that class at all. `status_conditions` is **parked**: the ability
  endpoint's nested `conditions` objects carry no id and no `iconAssetKey`, so there is nothing on the
  wire to store — closing it is a cr-api change first.
- **Authoring tools:** `cr_import_icons` copies pack sprites named in
  `Assets/CR/Art/Icons/icon-map.json` into CR's own folders, imports them as 256px sprites, registers
  them addressable and writes both halves of the slot; `cr_bake_portraits` renders each species'
  addressable prefab to a 256px transparent portrait. The baker **refuses to write a blank render**
  (one flat colour) and flags an opaque background under `notes: OPAQUE` — a silently blank PNG that
  still reports "baked" is the failure worth catching. Three Asset Store packs back the map: 3000+ RPG
  Item Icons (`217341`), Fantasy Status Icons (`265728`), 500 RPG Spell Icons (`200510`).
- **Docs:** new `backend/19-item-effects.md` (item schema, the three enums, the handler roster and every
  refusal sentence, the offline mirror's four real divergences, the seeded catalogue and status tables,
  the new endpoint) and new `unity/29-ui-icons.md` (the address rule, `UiIcon`, the importer and baker,
  the map format, the pack downloads, the backfill). `unity/10-player-menu-ui.md` rewritten around the
  picker; `12-scriptable-objects`, `08-content-registry`, `07-battle-system`, `13-battle-bag-ui`
  updated.
- **The art landed:** the three packs were pulled through `cr_asset_download` / `cr_asset_import`
  (Blink under `Assets/Blink/Art/Icons/`, Hippo's single 1024×768 status sheet sliced into
  `Assets/FanyasyStatusIcons/Slices/<Name>.png`), `icon-map.json` filled for all 71 keys, and
  `cr_import_icons` reported `copied 70, skipped 1, missing 0, not found 0, failed 0` — the skip is
  `toy_bouncy_ball`, whose sprite is registered but has no `ItemDefinition` to write onto.
  `cr_bake_portraits` wrote all 15 creature portraits with `notes 0`. 85 definitions now carry an
  `iconKey` (37 abilities, 15 creatures, 22 items, 11 status) and `CRContent` holds 86 `icons/` entries.
- **Portraits are rendered twice:** the first bake of every creature came back `OPAQUE` — under URP
  `EndStaticPreview` drops the clear colour's alpha, so `Color.clear` arrived as a solid dark-grey
  square. Instead of owning a `RenderTexture`, `CreaturePortraitBaker` now snapshots the creature over
  black and over white and hands both to the new engine-free `PortraitMatte.Resolve`
  (`Assets/CR/Core/Data/Logic/PortraitMatte.cs`): `alpha = 255 − avg(white − black)`, colour =
  over-black un-premultiplied by that alpha. `PortraitMatteTests` (6) pin background → transparent,
  covered → opaque with colour kept, half-covered edge → alpha 128, and buffer validation. The
  blank/OPAQUE classification still runs on the matted output.
- **Loose fits worth a second look:** `Weakened` (Arcanist12) and `Soaked` (Enchanter16) come from the
  Blink spell set because Hippo's sheet has nothing for them, so they sit on square painted backgrounds
  unlike the other nine status chips; `Grounded` → Bleeding is a stretch; `toy_bouncy_ball` → Toy9 is a
  plush rabbit because Blink ships no ball.
- **Parked, deliberately:** the status endpoint checks that the **creature in the path belongs to the
  trainer in the path**, exactly as `ItemEndpoints`' held-item reads do — it does **not** yet check
  that the caller's account owns that trainer. Binding caller → trainer is a follow-up in the auth
  ladder and lands for this route and `POST /trainers/{id}/items/{id}/use` together. Also open:
  `status_conditions.icon_asset_key` is not carried into the online cache (the ability endpoint's
  nested `conditions` need an id and an `iconAssetKey` first); offline `BoostStatTemp` reports a boost
  it never persists; offline `TriggerEvolution` evolves a creature the online handler refuses to
  evolve; and offline item use writes neither the `items_used_*` stats nor the `UsedItem` quest event.
- **Final-review fixes:** the heal potion regression is fixed — the target picker now opens whenever
  the item's effect needs a creature (`ItemTargetIntent.NeedsCreature`: `Heal`, `Revive`, `CureStatus`,
  `CureAll`), not only when the item declares `TargetsOwnTeam`, so `item_heal_potion_30` (flags 19, no
  `TargetsOwnTeam`) no longer sends `UseItemAsync` a `Guid.Empty` target. Seven `StatusConditionConfig`
  assets (`Burn`, `Confusion`, `Grounded`, `Poisoned`, `Slow`, `Soaked`, `Weakened`) had their ids
  overwritten by a dev box's Postgres state; restored to the seeded ids, and
  `AbilityEditorSyncHelper.AdoptServerConditionId` now warns loudly (`Debug.LogWarning`, naming both
  ids) instead of logging quietly when it adopts a server id — the migrations own condition ids, not
  a server. `BattleHUD` no longer injects `IGeneratedCreatureRepository` / `ICreatureRepository`
  directly; it now resolves a creature's portrait through `IGeneratedCreatureDomainService` and
  `ICreatureDomainService`, matching the rest of the feature.

## 2026-09-04 — Bag offered Equip on consumables: seeded `item_type` was Equipment

- **Symptom:** the Bag screen showed **Equip (Slot 1 / 2)** on a Radiant Crystal (and every other
  capture crystal, the exp-share charm and the heal potion) and no **Use** on any of them.
- **Root cause (data, not UI):** `ItemType.Consumable = 0`, `Equipment = 1`. The seeds in
  `M6007SeedCaptureCrystals`, `M6009SeedExpShareItem` and `M6013SeedHealPotion` hard-coded
  `item_type = 1` while also setting `is_consumable = true`, so every seeded consumable classified
  as equipment. `BagItemPolicy` then did exactly what it was told. The authored `ItemDefinition` SO
  has no item-type field and the Studio item push preserves the server's value, so the seed was the
  only source of the wrong number. `M6017SeedBindstone` (a real held item, `1`) and
  `M6018SeedBouncyBallToy` (`2`, key item) were already right.
- **Fix:** the three seeds now write `0`; new **`M6019FixSeededConsumableItemType`** retypes those
  six `content_key`s from `1` to `0` on already-migrated databases — Postgres via the AIO startup
  migrator, and every Unity SQLite file (floor, persistent copy, item/inventory online caches) via
  the domain migrator. ANSI `UPDATE`, idempotent (`AND item_type = 1`), key-scoped `Down()`.
- **Tests:** `CR.Data.Migrations.Test/SeededItemTypeSqliteTests` (5) and
  `CR.Items.Data.Postgres.Test/SeededItemTypeTests` (3) read the six keys back through the real
  `ItemRepository` and assert the typed `ItemType`, plus a re-migrate path that flips rows to `1`,
  drops the 6019 `VersionInfo` row and re-runs. Backend suite 39/39 green.
- **Second (latent) bug in `BagItemPolicy.Decide`:** Use was suppressed by the `HeldByCreature`
  *flag*, so a dual-use item — the heal potion is a consumable that is also holdable so it
  auto-triggers in battle — would have lost its Use button the moment the data was corrected. Use
  now follows kind (`!= Equipment`) + `UsableOverworld`; Equip follows kind-or-held-flag as before.
  Three tests added to `BagItemPolicyTests` (dual-use gets both; capture crystal gets neither;
  held-flag consumable without overworld use gets Equip only).
- **Deploy notes:** `build-packages.sh` re-run (DLL verified to contain `M6019…`); AIO restarted and
  `cr_dev` rows confirmed retyped. `Assets/StreamingAssets/CR/game-data.bytes` (the offline floor)
  still carries `item_type = 1` until `cr_rebake_floor` runs — the persistent copy self-heals on
  next boot regardless, because M6019 runs there.

## 2026-09-04 — Live ops: player manager + marketplace moderation

- **Why:** there was no way to answer "what does this player actually own?" or "take this listing
  down" short of hand-written SQL against `cr_dev`. Live support needs to inspect a player and act
  on the market from the Content Studio, server-authoritatively, with every action attributable.
- **New `Moderation` domain (`cr-api/Moderation/`):** the ten-project layout mirroring `Market/`.
  `M13001CreateAccountModerationTable` (`account_moderation`: one soft-deleted row per account,
  `shadow_banned`, `shadow_ban_reason`, `shadow_ban_expires_at`, `notes`, `updated_by`) and
  `M13002CreateAdminActionTable` (`admin_action`: **append-only**, `actor`, `kind`, nullable
  account/trainer/listing targets, a `NOT NULL` `reason`, JSON `metadata`, indexed on
  `(target_account_id, occurred_at)`). Online-only — deliberately not in the baked offline floor.
  `IAccountModerationRepository` / `IAdminActionRepository` / `IPlayerSearchRepository` (Postgres +
  SQLite). `IModerationService` (`AddScoped`) composes Auth, Trainer, Creature, Item and Market:
  player search, a whole-account dossier, shadow ban / lift, currency adjust, item grant / remove,
  and listing removal. A blank reason is refused **before** anything is written, and every
  successful mutation writes exactly one `admin_action` row **in the same transaction** — an audit
  row can never describe a change that rolled back, and a refusal never leaves one behind.
- **Auth:** `POST /auth/service-token` now accepts a second pre-shared key, `AdminServiceKey`
  (dev default `local-dev-admin-service-key`), issuing the `admin` scope; `EditorServiceKey` still
  yields `content:write` only. Admin is checked first, both comparisons constant-time, and a
  missing/blank key value disables that exchange entirely. `admin` implies `content:write` and
  `player`; the reverse does not. `AdminActorName` (default `editor`) is the label stamped onto
  audit rows as `{name}:{jti[..8]}`, minted from the validated JWT and never from the request.
- **Market:** listings from an account under an *active* shadow ban are dropped from
  `BrowseListingsAsync`, answer `NotFound` from `GetListingViewAsync`/`BuyListingAsync`, and are
  untouched in `GetMyListingsAsync` — a banned seller keeps a market that looks normal to itself. A
  lapsed ban needs no sweep to stop applying. New `TransactionKind.AdminRemoval`, plus
  `AdminBrowseListingsAsync` (includes hidden rows, sets `MarketListingView.SellerShadowBanned`) and
  `AdminRemoveListingAsync` (creature back to the seller's storage, listing `Cancelled`, market
  transaction and audit row in one transaction).
- **REST:** `AdminEndpoints`, group `/api/v1/admin`, every route `RequireAdmin` —
  `GET /players?q=`, `GET /players/{accountId}`, `PUT|DELETE /players/{accountId}/shadow-ban`,
  `POST /trainers/{trainerId}/currency`, `POST|DELETE /trainers/{trainerId}/items`,
  `GET /market/listings`, `DELETE /market/listings/{id}`, `GET /actions`. Mutations answer with the
  resulting state (moderation row, refreshed `TrainerDossier`, post-removal `MarketListingView`)
  rather than an acknowledgement; refusals share one body,
  `{ error: "<sentence>", reason: "<ModerationReason>" }`, with `NotFound` → 404,
  `InvalidReason`/`InvalidQuantity` → 400 and everything else → 409.
- **Unity:** Content Studio gains a **LIVE OPS** rail group with **Players** and **Marketplace**
  tabs — search a player, inspect account, trainers, team, storage, backpack and live listings,
  shadow-ban / lift, adjust currency, grant or remove items, and pull abusive listings (the creature
  goes back to its seller). Every action opens a reason dialog and is audited; the tabs read the
  audit trail back inline. The Auth tab gains an **Admin key** row (masked field, save, reset to
  default, live Valid/Invalid/Unset chip) backed by `EditorAdminAuth`, and every failure path
  renders a sentence with a route back to the Auth tab rather than a silent no-op.
- **Docs:** new `backend/18-moderation.md`; `backend/17-creature-market.md` gains the hidden-seller
  rule and the `AdminRemoval` kind; `backend/06-auth-and-accounts.md` documents both service keys.
- **Tests:** Moderation Postgres repository + domain-service suites, Market service coverage of
  hiding/admin browse/admin removal, `AdminServiceTokenHttpTests`, and `AdminEndpointsHttpTests` —
  all ten routes table-driven for 401 (anonymous) and 403 (`content:write`), then the full operator
  flow end-to-end including a ban that genuinely hides a listing from a second player's browse while
  `/market/mine` still shows it. Unity EditMode suites for the pure live-ops logic
  (`PlayerSearchQuery`, `ModerationBadge`, the validators, `AdminAuthGate`, `AdminActionText`,
  `ListingModerationRow`, `JwtScopeReader`).
- **Review pass (same day):** backend — admin item grants now allocate **1-based** backpack slots
  like `ItemInventoryService` (the 0-based loop could exceed capacity by one), and grant/remove read
  the backpack **inside** the transaction that writes it (new `GetItemsInTransactionAsync` /
  `GetInventoriesInTransactionAsync` on the Trainer inventory repositories; the Unity
  online/online-offline repositories gained the matching pass-throughs); dossiers read active
  listings through the admin browse (the seller read clamped at 100 and truncated silently);
  `GetShadowBannedAccountIdsAsync` is bounded (1000) on the hot browse path; player search escapes
  LIKE wildcards; a shadow-ban expiry in the past → `InvalidArgument`, lifting an unknown account →
  `NotFound`; `admin_action.id` lost its Postgres-only default and the ban index became
  `(shadow_banned, account_id)`; the dev `AdminServiceKey` now lives only in the AIO
  `appsettings.Development.json` — the Auth and BFF `config.yml` carry none. Unity — every LIVE OPS
  job resolves the server address and admin key on the main thread (`AdminEndpointContext`) before
  `Task.Run` (`Resources.Load` off-thread threw on a fresh session); `/actions` sends the required
  `offset` and a failed audit read says so instead of "nothing removed"; cancelling a job from the
  job bar releases the tab (`StudioJob.Finished`); the reason dialog answers from `delayCall`, not
  inside its own layout; buttons capture the account they were pressed for; item storage rows are
  read-only (the admin item routes are backpack-only). New pure-logic `AdminQueryString` and
  `ModerationStamp` with tests.

## 2026-09-04 — Elemental reactions + damage matrix are content: backend tables, offline cache sync, Content Studio tabs

- **Why:** the three elemental reactions (Conduction, Flash Freeze, Shatter) lived in a hardcoded
  `ElementalReactionTable`, and the type-matchup matrix (`elemental_damage`) could only be edited by
  writing a migration. Designers need both in the Content Studio, pushed to the server, and pulled
  into the offline cache like every other content domain.
- **Backend (Creatures / Game):** `M12006CreateAndSeedElementalReaction` (new `elemental_reaction`
  table, seeded with the shipped rules under their authored ids), `M12007FixRadiantSelfMultiplier`
  (Radiant vs Radiant `-5.0` → `0.5`; matrix column widened to `DECIMAL(4,2)`),
  `M12008RepointActiveElementalDamageVersion` (a dangling `active_elemental_damage_version` — `v1.0`
  from M8002 vs the `v1.1` matrix from M9990 — now moves to `MAX(version)`; a pointer that names a
  seeded version is left alone). `IElementalReactionRepository` (Postgres + SQLite),
  `BattleConfigurationDomainService` grows reaction CRUD and matrix version copy / set-active /
  delete, every multiplier clamped to `[0, 10]`. `BattleDomainService` loads reactions from the
  repository **at battle start** and falls back to the static table only when the table is empty.
- **REST:** `GET|PUT|DELETE /api/v1/elemental-reactions[/all|/{id}]`;
  `GET /api/v1/elemental-damage?version=`, `GET /versions`, `PUT /versions/{version}`,
  `POST /versions/{version}/copy?from=`, `PUT /active`, `DELETE /versions/{version}`.
- **Unity runtime:** `ContentDomain.ElementalReactions` / `ElementalDamage` join
  `ServerContentSyncService` (7 domains); `ContentSyncWriter` writes both into the offline content
  database in one transaction per domain, and the active pointer only when the named version
  actually arrived with cells. `IElementalReactionRepository` and the offline
  `IBattleSystemVersionRepository` now read `game-data.bytes` (content, not player state).
  `ServerContentSyncService` takes an optional `ITokenManager` so the sync GETs carry the session
  token. The battle HUD prints the reaction's `LogLine` with a `{ReactionName}!` fallback.
- **Content Studio:** two new tabs — **Reactions** (tab 16, `ElementalReactionDefinition` assets in
  `Assets/CR/Content/Defs/Reactions/`, pull / push / delete) and **Elemental Damage** (tab 17,
  `ElementalDamageMatrixConfig` grid with a version bar: dropdown, Copy as new version, Set Active,
  Delete). Both export seed migrations (`Creatures/CR.Creatures.Data.Migration/M<next>SeedElementalReactions_<date>.cs`
  / `…SeedElementalDamage_…`) through the shared `SeedMigrationFileWriter`, which the battle-mission
  exporter now uses too. The old `BattleConfigurationListView` in the in-game data manager is gone.
- **Tests:** SQLite + Postgres repository and migration suites (M12006–M12008 seed shape, idempotency,
  Radiant fix, pointer repair and leave-alone), Unity content-sync writer + payload deserialization +
  Zenject binding tests (76 edit-mode tests in `CR.Core.Tests`), and Studio mapping / seed-generator /
  file-writer suites in `CR.Game.Battle.Logic.Tests`. Backend suite green.
- **Tooling:** `unity cmd cr_edit_tests_start <assemblies>` / `cr_edit_tests_status` — an async
  EditMode test runner for the Pipeline CLI; the stock `run_tests` wedges the Editor. Documented on
  the ability-workbench page.
- **Applied:** M12006–M12010 on dev Postgres (pointer `v1.1`); compat package rebuilt; floor
  `game-data.bytes` at schema 12010 with the reactions seeded and the pointer at `v1.1`. M12009 /
  M12010 are the first Studio-exported snapshots of both tables, so the Publish drift check now has
  something to compare against.
- **Verified live in the Editor:** Pull on both tabs (3 reaction assets created with their primer
  SOs re-attached; matrix v1.1 updated, 100 cells, Radiant→Radiant 0.5), cell + reaction edits pushed
  and read back from Postgres, Copy as new version (`v9.9`, 201) → Set Active → Pull created the
  second asset flagged active, Delete of the active version refused with a clear message, Delete of
  the inactive copy 204, version-format validation refused `v9.9-verify`, both seed exporters ran and
  the exports compile and pass the migration suites. Unity EditMode: 1253/1253; backend: 1895/1895
  before the exports, 157 migration + 34 Postgres + 659 Game-service tests re-run after.

## 2026-09-03 — M12005 battle mission seed applied; build-packages now rebuilds Game.Data.Migration

- **Why:** a fresh database seeded seven of the ten battle missions (`M10018` in Creatures ran before
  the Game table existed). The Studio-exported `M12005SeedBattleMissions_20260903` cures that, but
  shipping it to the client exposed a second bug: the compat package *copied* `CR.Game.Data.Migration.dll`
  without ever *building* it, so the Unity-side migration DLL had a fresh mtime and Aug-31 contents.
- **Applied:** `M12005` on dev Postgres (`VersionInfo` 12005, still ten rows — idempotent by authored id)
  and in the baked floor (`game-data.bytes` schema 12005, ten missions). Fresh-database count is now
  ten on both engines; the 7/10 caution is retired from the battle-persistence and battle-extensions
  pages.
- **Fixed:** `build-packages.sh` gains a `build_if_needed` entry for `Game/CR.Game.Data.Migration`
  (it was the only `*.Data.Migration` project without one — nothing in the compat csproj graph pulls
  it in). Verified by `strings` on the Release and package DLLs and by reflection inside the open
  Editor (`CR.Game.Data.Migration.M12005SeedBattleMissions_20260903` loads from the package path);
  compile gate clean. Verification rule recorded in the content-pipeline page: check migration DLLs
  with `strings … | grep M<number>`, not mtimes.
- **Not done:** Steam Deck / player builds under `cr-api-unity/Builds/` still carry the stale DLL
  until rebuilt.

## 2026-09-03 — Content Studio: battle mission editor tab (push/pull/delete + seed export)

- **Why:** the ten battle missions were authorable only by writing a FluentMigrator class in cr-api,
  rebuilding the compat packages and restarting the API. Backend CRUD landed the same day; this is
  the half a designer touches. Without it the new `PUT` / `DELETE` routes had no caller.
- **Content Studio → Battle Missions** (COMBAT group, tab 15): list rows with type · condition ·
  ×threshold · same-target / Active / Invalid chips · reward ability, **+ New**, per-row **Delete**
  (asset + `DELETE /api/v1/battle-missions/{id}`; the post-confirm half is its own
  `DeleteBattleMissionConfirmed` so the destructive sequence can be exercised without the modal),
  **⬆ Push All** (`PUT` per mission, duplicate content keys refused before sending, server 400/409
  `message` shown on the offending row) and
  **⬇ Pull** (`GET /all?includeInactive=true`, applied by id — which is how the seeded missions
  become editable assets, since the project shipped with none).
- **`BattleMissionDefinition`** SO (`Assets/CR/Content/Defs/BattleMissions/`) with the stable-id
  `OnValidate` pattern, plus a custom inspector ordered Basics → Objective → Reward → Advanced. The
  reward is an `AbilityConfig` reference; the raw id survives beside it so pulling from a server
  whose reward ability has no local asset cannot blank the reward on the next push.
- **One validation rule, not two.** `BattleMissionTemplateUpsertRequest` and
  `BattleMissionTemplateValidation` ship to Unity in `CR.Game.Data.dll`, so the inspector strip, the
  **Invalid** chip and the push pre-check all run *the server's own validator*. Mission-type and
  reward-type dropdowns render from `BattleMissionTypes.All` / `BattleMissionRewardTypes.All`; the
  condition dropdown switches between the project's `StatusConditionConfig` names and
  `ElementalReactionTable.All`, and disappears for `KnockOut`, which ignores `condition_key`.
- **The offline step, made explicit.** The baked floor comes from migration seeds only and Studio
  does not write local SQLite, so a pushed mission does not exist for a disconnected player.
  **⬇ Export Seed Migration** writes the authored set into
  `cr-api/Game/CR.Game.Data.Migration/M<version>SeedBattleMissions_<yyyyMMdd>.cs` — authored ids,
  dual-engine (`INSERT OR IGNORE` + `1`/`0` vs `ON CONFLICT DO NOTHING` + `true`/`false`), every
  insert guarded on `WHERE NOT EXISTS (… content_key)`, and `Down()` matching **both** key and id so
  a rollback cannot take rows an earlier migration seeded under the same key. The version is the
  repo-wide maximum plus one, which also serves as the content-schema bump `GameDataAdopter` needs.
- **Runtime untouched.** `GET /api/v1/battle-missions` (active only) still backs
  `BattleMissionTemplateHttpSource` → `BattleMissionTemplateRoutedSource`, and neither source nor
  `PlayerTeamView` caches, so an edited mission appears the next time the team screen is opened — no
  restart, no `MissionsChanged` event needed. No hardcoded mission names exist anywhere: the tracker
  matches on `MissionType` / `ConditionKey` from the row.
- **Verified live in the Editor** against the AIO on `localhost:8080`: Pull created all ten SOs
  under their seeded `b1550000-…` ids with every reward ability resolved to a local `AbilityConfig`;
  a threshold edit round-tripped to Postgres and back; a blank name was refused with the server's
  own `name is required.` (`curl` confirms the endpoint answers 400 with the same string); a second
  asset claiming `mission_pyromaniac` drew `409: content_key 'mission_pyromaniac' is already used by
  battle mission 'b1550000-…-0001'` from the server and was refused locally by Push All before any
  request; delete removed the asset and soft-deleted the row, and reported the 404 rather than
  claiming success when the row was never on the server; Export regenerated the seed migration
  byte-identically (`IsSeedStale=false`). The ten seeded rows were left exactly as found.
- **Tests:** `CR.Game.Battle.Logic` 126 → 164 (+38) — `BattleMissionSeedMigrationGeneratorTests`
  (17: both engine branches, idempotency guard, id preserved and lowercased, quote/backslash
  escaping, tightened `Down()`, stable ordering, blank optionals as `null`) and
  `BattleMissionContentKeyTests` (21: the snake_case rule, and that a derived key always passes it).

## 2026-09-03 — market window: advanced search on growth values

- **Why:** the backend learned to filter listings on the seven growth-profile values the same day
  (see the entry below); this is the player-facing half — without it the fourteen new query
  parameters had no caller, and a buyer still could not tell a 150-attack-growth creature from a
  70-attack-growth one before buying it.
- **The panel:** a `▸ Advanced` / `▾ Advanced` toggle under the Browse filter bar opens
  `market-advanced-panel` with seven min/max pairs — Exp growth (`FloatField`), then HP, Attack,
  Defense, Sp. Atk, Sp. Def, Speed (`IntegerField`, 100 = baseline). `0` means "no bound", matching
  the existing level/price fields. Bounds are applied by the same **Search** button, not per
  keystroke, and go to the server (`minExpGrowth`, `minHpGrowth`, `minAtkGrowth`, `minDefGrowth`,
  `minSpAtkGrowth`, `minSpDefGrowth`, `minSpdGrowth` and their `max` twins) — never as a post-filter
  over the fetched page, which would silently hide matches on later pages.
- **A Button, not a Foldout:** a focusable container swallows d-pad navigation, and
  `Button.clicked` is the only click path a gamepad submit reaches. The panel's initial
  `style="display: none;"` is the one deliberate inline style in the screen — the collapsed state
  has to hold before any code runs.
- **Two small honesty fixes:** `MarketBrowseFilter.Validate()` mirrors the server's `400` on
  `min > max` and shows e.g. `Sp. Def growth min can't be higher than max.` in the status label
  **without sending a request**; and a *collapsed* Advanced panel that is still filtering marks its
  toggle (`market-advanced-toggle--active`), so nobody hunts for listings a bound they cannot see is
  hiding. Panel open/closed state and typed bounds both survive a Search.
- **Per-row growth line:** every Browse and My Listings row now carries
  `Growth (Swift): HP 120 · Atk 150 · Def 80 · SpA 100 · SpD 100 · Spd 110 · Exp 100`
  (`market-row-growth`, formatted by the pure `MarketGrowthSummary`). A listing that carries no
  growth data at all formats to an empty string and the label is hidden, rather than drawing a
  real-looking all-zero creature.
- **Plumbing:** the fourteen bounds live once, in `MarketGrowthRanges` (engine-free
  `CR.UI.Market.Logic`), shared by `MarketBrowseFilter` and `MarketBrowseQuery` — `ToQuery()` hands
  out a snapshot, so editing the panel afterwards cannot mutate a query already in flight.
  `MarketManager.BrowseAsync` gained a `MarketBrowseQuery` overload; the screen now passes the
  filter whole instead of eight positional arguments.
- **Tests:** `Assets/CR/UI/Market/Logic/Tests/` 47 → 71 NUnit cases (bound mapping, `HasAdvanced`,
  `Validate`, the exact server parameter names, invariant float formatting under a `de-DE` culture,
  and the summary formatter). All green; Unity compile gate clean.
- **Docs:** `unity/28-creature-market.md` — new "Advanced search (growth values)" section;
  `doc-sources.json` now also watches `Assets/CR/UI/Resources/Market*` (the UXML/USS the screen
  actually loads were outside every glob).

## 2026-09-03 — battle mission templates: CRUD endpoints for the Studio editor

- **Why:** `battle_mission_template` had exactly one route — the game's active-only feed — so the
  ten seeded missions could only be changed by writing a migration. Missions are content, and
  content is authored in the Content Studio.
- **cr-api:** `IBattleMissionTemplateRepository` gains `GetAllAsync(includeInactive)`,
  `GetByIdAsync`, `GetByContentKeyAsync(contentKey, includeDeleted)`, `UpsertAsync` and
  `SoftDeleteAsync`. Four new routes sit beside the existing feed, all behind
  `AuthorizationPolicies.RequireContentWrite` — the same policy the ability, spawner and
  ability-progression authoring routes use, satisfied by the token the Studio already gets from
  `POST /auth/service-token`: `GET /api/v1/battle-missions/all?includeInactive=`,
  `GET|PUT|DELETE /api/v1/battle-missions/{id:guid}`. `GET /api/v1/battle-missions` is untouched,
  response shape included — Unity's `MissionDefinition` still deserializes it byte for byte.
- **Shipped to Unity:** `BattleMissionTemplateUpsertRequest`, `BattleMissionTypes`,
  `BattleMissionRewardTypes` and `BattleMissionTemplateValidation` all live in `CR.Game.Data`, which
  build-packages.sh copies to Unity as `CR.Game.Data.dll` — so the editor's dropdowns and inline
  validation are the server's own types, not a hand-rolled mirror that can drift.
- **Semantics worth knowing:** the route id is authoritative and a body `id` is ignored. The
  content-key uniqueness check runs *ignoring* `deleted`, so a key belongs to one id permanently:
  re-creating a deleted mission means `PUT`ting its original id, which revives the row in place
  rather than forking a second row under the same key. A different id holding the key is `409`.
- **Documented but not fixed:** `M10018`'s three `ElementalReaction` missions are seeded from the
  Creatures domain and guarded on `battle_mission_template` existing, but `Program.cs` migrates
  Creatures before Game — so a genuinely fresh database gets seven missions, not ten. `cr_dev` has
  all ten only because the table already existed when that migration first ran. Called out in both
  affected doc pages; nothing counts on ten any more.
- **Tests:** 12 SQLite repository + 27 validation (`CR.Game.Data.Test`), 7 Postgres repository
  (`CR.Game.Data.Postgres.Test`), 26 endpoint handler (`CR.Game.Domain.Services.Test`), 10 HTTP
  round-trip through the real AIO host and a Postgres testcontainer
  (`CR.Api.IntegrationTests/BattleMissionTemplateHttpTests.cs`, covering anonymous `401`,
  player-token `403`, and editor-token `PUT → GET /all → DELETE`). All four suites green in full,
  no filter: 63 / 24 / 553 / 49.

## 2026-09-03 — market advanced search on growth-profile values

- **Why:** two creatures of the same species and level differ only in the growth profile they level
  with, and the marketplace gave a buyer no way to search on it. Filtering on the *profile* would
  have been the wrong shape — a buyer wants "attack growth ≥ 150", and every profile clearing that
  bar is an equally good match — so the search is on the seven **values**, never on profile identity
  or name.
- **cr-api:** `MarketListingView` gains `GrowthProfileName` (display only) plus `ExperienceGrowth`
  (float) and `HitPointsGrowth`/`AttackGrowth`/`DefenseGrowth`/`SpecialAttackGrowth`/
  `SpecialDefenseGrowth`/`SpeedGrowth` (int). New `MarketGrowthFilter` (`CR.Market.Model.REST`)
  holds fourteen nullable min/max bounds; `MarketListingFilter` inherits it, so the service hands
  the filter straight to the repository with no mapping step.
  `GET /api/v1/market/listings` takes `minExpGrowth`/`maxExpGrowth` (float) and
  `min|max` × `HpGrowth`, `AtkGrowth`, `DefGrowth`, `SpAtkGrowth`, `SpDefGrowth`, `SpdGrowth` (int).
  An inverted range now returns `400 { message }` naming both params — that rule also retro-fits
  `minLevel`/`maxLevel` and `minPrice`/`maxPrice`, which previously just returned an empty list.
- **Two traps closed:** the growth join is a `LEFT JOIN` so a creature whose `growth_profile_id`
  resolves to nothing stays browsable (values `COALESCE`d to 0, name null) instead of vanishing from
  the marketplace — though it correctly drops out of any bounded search, since its growth is unknown
  rather than zero. And `experience_growth` is `CAST(… AS REAL)` in the SELECT: Dapper plans a whole
  result set from its first row, so a SQLite NUMERIC column whose first row holds a whole number
  comes back `long` and breaks every later row.
- **Tests:** `CR.Market.Data.Postgres.Test` 16 → 18, `CR.Market.Domain.Services.Test` 16 → 19,
  `MarketHttpTests` 4 → 6. All green.
- **Docs:** `backend/17-creature-market.md` — new "Advanced search — growth values" section.

## 2026-09-03 — market element search matches ordinal-stored elements

- **Bug:** browsing the market by element returned nothing for real data, and rows showed the
  element as a number (`8 • Lv 5`). `creature.element_type` is a varchar that stores the enum
  *name* on hand-written seeds (`'Fire'`) but the enum *ordinal* (`'8'`) on everything saved through
  the Creatures repository or a Studio push; the market's SQL compared the client's `Poison` against
  `'8'`.
- **Fix (cr-api, `CR.Market.Data`):** new `CreatureElementText` resolves a filter to both forms;
  `GetActiveListingsAsync`/`GetActiveListingViewsAsync` match
  `UPPER(element_type) = UPPER(@name) OR element_type = @ordinal`; every view read
  (`GetActiveListingViewsAsync`, `GetListingViewsBySellerAsync`, `GetListingViewAsync`) maps
  `ElementType` to the display name. `CR.Market.Data` now references `CR.Game.Model` for the enum.
- **Tests:** `MarketRepositoryTests` +1 (ordinal-stored species found by `poison` and `8`, not by
  `Fire`; `Plasma` matches nothing; all three view reads return `"Poison"`) — 16/16.
- No client change; the Unity dropdown already sends the enum name.

## 2026-09-03 — listing cap, market rules endpoint and filter labels

**A trainer could pile up an unbounded number of active listings** — nothing capped how many
creatures one account could have on the market at once. `MarketService.ListCreatureAsync` now
counts the acting account's Active listings before allowing a new one and refuses with a new
`ListingLimitReached` reason (409) when the count is already at the configured limit. The limit is
config-driven (`MarketMaxActiveListings`, default 5) rather than hard-coded, and the "is this
already my listing" ownership check that guards List/Cancel is account-level (an account's *any*
trainer counts against the same cap and can cancel any of the account's own listings), matching how
the rest of the market already scopes ownership.

A new `GET /api/v1/market/rules` endpoint (`RequirePlayer` auth) returns
`CR.Market.Model.REST.MarketRules { MaxActiveListings, ListingFeeBase, ListingFeePercent }` so the
client can read the cap and fee formula instead of hard-coding them — it ships in the
`CR.Market.Model.REST` compat DLL alongside the other market DTOs.

Client side:

- **Filter bar labels**: `MarketScreen.uxml`'s Browse filters (species/element/min-max
  level/max price/sort) had no labels — a new player had no way to tell what an empty text field or
  a `0` searched on. Each control is now wrapped in a `market-filter-group` with a
  `market-filter-label` above it; control names are unchanged so `MarketScreenHandler`'s lookups
  still resolve.
- **Rules fetch**: `IMarketClient.GetRulesAsync` / `MarketClientUnityHttp.GetRulesAsync` (GET
  `/api/v1/market/rules`) and a `MarketManager.GetRulesAsync` wrapper (same `IsAvailable`-gate,
  exception-to-`MarketResult` pattern as every other market call). `MarketScreenHandler.Open` fetches
  it once per open, holds it in `_marketRules`, and falls back to defaults (max 5, fee 10 + 5%) with
  a logged warning if the fetch fails — the market still opens.
- **Listings N/M**: the Sell tab now shows a `market-sell-listing-count` label next to "Your
  Creatures" — the account's current Active-listing count over the cap, reusing the same `/mine`
  load the My Listings tab already does. `SellEligibility.Evaluate` gained `activeListings` and
  `maxListings` parameters and refuses with "You've reached your listing limit ({maxListings})."
  right after the last-team-member check and before the price/afford checks, disabling the List
  button the same way an untradable or last-team candidate already does.
- **`MarketFee.Compute`** now takes `feeBase`/`feePercent` explicitly (sourced from the fetched
  `MarketRules`, `MarketFee.DefaultFeeBase`/`DefaultFeePercent` as the fallback) instead of hard-coded
  constants, so the fee preview matches the server even if an environment overrides the config.
- **`MarketErrorText`**'s List/409 copy now mentions the cap: "...it may be untradable, already
  listed, your last team creature, or you've hit your listing limit."
- 8 new/changed NUnit cases (listing-cap allowed/refused/ordering-vs-gold for `SellEligibility`,
  a non-default-rules case for `MarketFee`, the updated 409 copy for `MarketErrorText`) — 47 total
  in `Assets/CR/UI/Market/Logic/Tests/`, all passing via both the throwaway `dotnet test` project and
  Unity EditMode.

## 2026-09-03 — sell team creatures on the market

**The Sell tab said "Nothing in storage to sell." even with a full roster.** Every one of the
player's creatures was on the active team, and the Market window only ever sourced Sell candidates
from `ICreatureInventoryService.GetStorageAsync` — `SellEligibility` also hard-refused anything
`isInParty`. A player whose whole roster is on the team had nothing to sell.

Both repos changed together:

- **cr-api**: `MarketService` now moves the inventory row itself on list/buy/cancel, so a team
  creature can be listed directly (no "swap to storage first" step). Listing 409s when it would
  leave the trainer with zero team creatures (last-team-member rule); buying 409s when the buyer's
  storage is full instead of silently dropping the creature.
- **cr-api-unity**: `MarketScreenHandler.LoadSellCandidatesAsync` now reads `GetTeamAsync` first,
  then `GetStorageAsync`, into one candidate list — team creatures show a "Team" badge.
  `SellEligibility.Evaluate` takes `(isOnTeam, teamCount)` instead of `isInParty` and refuses only
  the trainer's last team member. `MarketErrorText`'s List/Buy 409 copy and the Sell tab's empty
  state/header text ("Your Creatures" / "No creatures to sell.") were updated to match.

## 2026-09-03 — quest-gated abilities in the storage data file

**A creature's Data File now lists its whole progression roster, not just its four current moves.**
`AbilityRosterBuilder` (`Assets/CR/UI/Storage/Logic/`, engine-free, 19 new tests) sorts every entry
of the creature's `ability_progression_set` into learned (`name` + the level it came from),
level-locked (`name` + `Lv N`) and quest-locked (`???` + `Complete: <quest name>`). The masking is
the builder's call, not the view's — `PlayerStorageView` picks a USS class and prints two strings.

The rules follow the backend's `AbilityUnlockGate` exactly, because a roster that disagreed with the
server would either promise a move the player cannot reach or hide one they have already earned: a
blank gate is not a gate, an unreadable completion set fails closed, keys compare trimmed and
case-insensitively, an already-known ability beats its own gate, and an ungated route to an ability
defeats its gated duplicate. Rows are cached per creature and computed once per open — `Redraw()`
runs on every chip and page change, so a repository call reached from the layout path would be a
query per repaint. A roster that *throws* is cached too, so a failure shows an empty block once
rather than retrying forever.

**Two local SQLite writers were silently dropping the gate.**
`LocalAbilityLibrarySyncClient.SyncProgressionSetAsync` (offline push) and
`ContentSyncWriter.WriteProgressionSetsAsync` (online content sync) both reconcile progression
entries by `(level, ability_slot)` and write only what they can see differs — and neither selected
`unlock_quest_content_key`. A changed gate therefore compared equal, the writer reported "same
ability at same slot/level — no-op", and the ability unlocked offline at its level with no quest
completed. Both now SELECT/INSERT/UPDATE the column and treat a changed gate as a change. An unset
gate is written as `NULL`, never `""`: readers test for null to mean "not gated", and an empty
string is a gate naming a quest that cannot exist.

Authoring: `AbilityProgressionSetConfig` entries gained `unlockQuestContentKey`, drawn as a
**dropdown of authored `QuestDefinition` content keys** (`ContentPicker.Quests()`) rather than a text
box — the server matches the key exactly, and a typo produces an entry that reads as authored and
can never unlock. The key rides both push payloads (`AbilityEditorSyncHelper.SyncProgressionSet`,
`AbilityLibrarySyncHttpClient`), because `/ability-progression/sets/sync` rewrites the row from the
payload: an omitted gate is an *erased* gate, not an unchanged one.

Finally, `QuestManager.ClaimRewardsAsync` re-broadcasts
`QuestClaimResult.AbilityUnlockedCreatureIds` as `OnAbilitiesUnlocked`, and
`AchievementToastPresenter` shows **"New ability learned!"** — one toast per claim, not per creature.
Without it a retroactive unlock is completely silent: the move just appears in a menu the player may
not open for an hour.

See [Creature Storage & Team Exchange](unity/26-creature-storage.md) and
[Creature Generation → Quest-gated abilities](backend/04-creature-generation.md#quest-gated-abilities).

## 2026-09-03 — creature market window

**The marketplace is now a screen, not just an API.** `MarketScreenHandler`
(`Assets/CR/UI/Market/`) opens on interacting with a market broker NPC (`NpcMarketBehaviour`,
checked before the merchant branch in `NpcInteractionBehaviour`) and gives Browse/Sell/My Listings
over `MarketListingView` — Browse and My Listings need no per-row creature lookup, since the view
already joins species/level/seller.

Two client-side gaps this closed, both invisible until buying/listing was actually wired up:

- `MarketClientUnityHttp` used to deserialize the List/Buy response body straight into
  `MarketListing`. The server actually answers those with `MarketOperationResult`
  (`{ success, reason, listing, transaction }`) — a domain-services-internal type deliberately not
  shipped to Unity — so every field silently came back empty. A new internal wire DTO,
  `MarketOperationResponse`, unwraps `Listing` without recreating the domain result type.
- `SimpleWebClient.CheckForResponseForErrors` had no `case 402`, so the market's
  `InsufficientFunds` refusal (the only 402 anywhere in the client) fell into `default` and came
  back as an indistinguishable `InternalServerErrorException`. It now throws a new
  `PaymentRequiredException`, alongside 409's `ConflictException`.

Business-rule refusals are read from the HTTP status code (402/403/409/404), not a re-parsed
reason enum — `CR.UI.Market.Logic.MarketErrorText` maps `(operation, statusCode)` to player text,
since the same status means a different thing depending which call produced it (a 403 on Buy is
"that's your own listing"; a 403 on List is "you don't own that creature").

A new engine-free asmdef, `CR.UI.Market.Logic`, holds the testable rules: `MarketFee` (mirrors the
server's `feeBase + round(price * feePercent, AwayFromZero)` fee formula exactly, including the
rounding mode), `MarketBrowseFilter` (server-side element/level/price via `ToQuery()`, client-side
species-text `Matches()` — the server's `species` filter is an exact base-creature-id match, not a
name search), `MarketListingSorter`, and `SellEligibility` (tradable → in-party → afford, the same
order the server checks). 36 NUnit tests cover fee rounding at exact `.5` boundaries, filtering,
sorting, eligibility, and the error-text matrix.

The market has no offline counterpart anywhere in the stack (a cached listing is one that could be
sold twice): `NpcInteractionBehaviour`'s market branch checks `MarketManager.IsAvailable` first and
shows a `WorldToast` ("The market is closed while offline.") instead of opening the screen at all.

A market broker NPC (`npc_market_broker`, `CR_NPC_Merchant` prefab with `NpcMerchantBehaviour`
swapped for `NpcMarketBehaviour`) is placed in `Village.unity`, 4m from the area's existing
merchant. No backend seed migration was needed — `NpcWorldBehaviour.InitializeAsync` upserts the
`npcs` row by content key the first time it's seen, the same mechanism every scene-placed NPC uses.

See [Creature Market Window](unity/28-creature-market.md).

## 2026-09-03 — Content Studio background jobs, and NPC placements across every scene

**"Where is this NPC placed?" is now a question about the project, not about what happens to be
open.** Content Studio and `NpcDefinitionEditor` answered it with `FindObjectsByType`, which sees
only loaded scenes — so an NPC placed in `Village` read as *unplaced* while the author had `Meadow`
open, and the readiness checklist said so. `NpcSceneScanJob` now reads every `.unity` under
`Assets/` (build-settings scenes first) plus every `.prefab` on a worker thread. No scene is opened
and nothing is dirtied: scene files are text, and the placement, its key and its object name are all
in there.

Prefabs are scanned first, because the area scenes place NPCs as prefab *instances* and the scene
alone does not identify them. `NpcPrefabClosure` runs to a fixed point over `m_SourcePrefab`, so a
variant of an NPC prefab — or a set-dressing prefab with an NPC child — counts too and inherits the
base's key unless it names its own. `NpcScenePlacementParser` recognises three shapes and the UI says
which, because they are worth different amounts of trust: a component written straight into the
scene, a prefab instance (key from the scene's override or the prefab's), and a referenced prefab
with no overrides at all, which is inferred.

Speed comes from not reading what cannot matter. `NpcScanFileReader` makes one pass through a reused
character buffer and never materialises a line — the 91 MB scene in this project would otherwise
cost a million short-lived strings to answer a question that is almost always "no" — and only files
that mention an NPC are then parsed. Results are cached per file in `Library/CRStudioNpcScenes.json`
and reused while a file's timestamp *and* length are unchanged. Two fingerprints guard the cache: one
over every prefab file's state, which skips the whole prefab pass while nothing changed; one over the
*resolved* prefab answer, because an NPC prefab whose key was edited changes what every unmodified
instance of it means without any scene file being touched. Measured here (207 scenes, 6164 prefabs,
~575 MB of YAML): ~15 s cold in the background, under 3 s incremental.

**Underneath it is a job system, and the rest of the window now uses it too.** `StudioJobRunner`
(`[InitializeOnLoad]`) pumps one job at a time on `EditorApplication.update` within an 8 ms budget.
A job is an iterator whose slices always resume on the main thread, so a slice may use the
AssetDatabase freely; `yield return someTask` parks it until that `Task` completes, which is how work
needing no Unity API leaves the main thread entirely. One at a time and FIFO is deliberate:
`_allContentTabs` is a dependency order, so overlapping pushes would corrupt content rather than
merely confuse. Progress, status and cancellation live in the engine-free `StudioJobTracker` and
`StudioJobQueue` (22 tests); a `cr-jobbar` strip above the status bar shows the bar, the status line,
the queue depth and **Stop**; every status transition is also a `[Studio]` console line, because the
bar is only true while somebody is watching it.

Three things moved onto it. **Push** built its plan with no network at all — so the total is known
before the first request — then sends one definition per tick; stopping is a real outcome, and the
tab is deliberately *not* stamped as pushed. It used to be one blocking HTTP request per definition
inside the button click: a few hundred definitions meant the better part of a minute frozen, silent
and unstoppable. **Pull** stays a single step but names the type before the wait. And the **registry
sweep + push comparison** — around 200 ms, previously paid inside whichever draw found the cache
expired — is now stepped one content type per slice, publishing into a pending slot that the draw
code adopts *only on a Layout pass*, the same discipline (and for the same reason) as
`EditorMemoPolicy`. `NpcDefinitionEditor` also memoises its checklist facts: `BuildSnapshot` is four
project-wide asset sweeps plus a scene search, and that inspector is drawn *inline* inside Content
Studio's list, so it was re-scanning the project several times a second.

In the NPCs section: a scan strip with freshness and **Scan all scenes** / **Rescan**, `in Village
(2), Meadow` on each row (a dictionary lookup, not a search), and an expanded NPC listing its
placements grouped by scene with **Open scene** — Unity's own save prompt, then select and frame —
or **Select** when that scene is already open.

## 2026-09-03 — quest-gated ability unlocks

**A quest can now teach a move.** `QuestRewardType.Ability` had been logging "not yet implemented"
since the reward table was written; it is now the fifth working reward type. The gate lives on the
progression entry rather than on the reward: `M5019` adds
`ability_progression_set_entry.unlock_quest_content_key` (nullable, Spawner domain), and a non-null
value means reaching the entry's level is necessary but not sufficient — the owning trainer must also
have completed that quest. Every existing row is `NULL`, so nothing already seeded changes how it is
learned.

One rule decides it everywhere: `AbilityUnlockGate.IsUnlocked(gate, completedQuestKeys)`, pure and
static, used by level-up (`ApplyAbilityChangesForLevelAsync`), by the manual slot editor
(`CanLearnAbilityAsync`), and by the retroactive pass. It **fails closed** — an unreadable trainer or
a throwing quest lookup leaves the ability locked, because a lookup that could not be performed must
never be mistaken for a quest that was finished. Completed keys are read from the quest
*repositories*, not `IQuestDomainService`: the quest service depends on `IRewardGrantService`, which
now depends on `ICreatureProgressionService`, so injecting the service would have closed a DI cycle.

The retroactive pass is the part that makes it feel like a reward rather than an IOU. A creature that
passed the entry's level long before finishing the quest would otherwise wait for its next level-up —
or never, at level 100. `ICreatureProgressionService.ApplyQuestUnlocksAsync(accountId, trainerId,
questContentKey, onlyAbilityContentKey, ct)` walks the trainer's team and storage, teaches every
newly-eligible gated entry using the same slot/replacement path as level-up, writes each creature
once, and returns the ids that changed. Those surface on
`QuestClaimResult.AbilityUnlockedCreatureIds`, kept separate from `SpawnedCreatureIds` so the client
knows to re-read move sets rather than to add party members. `RewardGrant` gained a `SourceKey` to
carry the unlocking quest's content key — it is a property of the source, not of the reward, and
folding it into `ReferenceKey` would have cost the per-ability filter.

The field round-trips through Content Studio push/pull (`/sets/sync`, `GET /sets`, the entry
create endpoint and both REST DTOs). 42 new tests: `AbilityUnlockGate` (10),
`CreatureProgressionService` gate + retroactive pass (18), `RewardGrantService` ability dispatch (3),
`QuestDomainService` claim routing (2), SQLite + Postgres column round-trip (8), and a migration-chain
test pinning the column and that no seeded entry is gated (3, one shared with the round-trips).

No demo seed: quest templates are seeded Postgres-only by design (M7012/M7015 — SQLite gets them from
ScriptableObjects), and Unity's `LocalAbilityLibrarySyncClient` soft-deletes progression entries the
SO does not declare, so a migration-authored gate would not survive offline. The first gated ability
should be authored in Content Studio and pushed. See [Creature Generation — Quest-gated
abilities](?page=backend/04-creature-generation#quest-gated-abilities) and [Quest System — Ability
rewards](?page=backend/07-quest-system#ability-rewards-quest-gated-ability-unlocks).

## 2026-09-03 — second-trainer quest auto-grant race, "New quest" toast, live seed for the welcome quest

**Switching from offline play to a second/subsequent online trainer in the same session silently
dropped the auto-granted "Welcome To CR" quest** (and its starter-creature reward) — no error, no
server request. Root cause: `QuestManager.WhenReady` was a one-shot `TaskCompletionSource` that
stayed completed forever after the *first* trainer's world init — every later trainer selection saw
a stale "ready" signal and skipped waiting for its own session's template sync, so
`QuestGranterBehaviour` looked up the quest template before it existed locally and gave up. Fixed by
extracting the gate into `QuestSessionReadyGate` (engine-free, 9 NUnit tests) and adding
`QuestManager.BeginSession()`, called as the first statement of
`CharacterSelectController.SelectAsync` — before the `OnTrainerSelected` event any granter reacts to.
Also found and fixed: the live onboarding quest (`content_key = "quest-welcome-to-cr"`) had no
migration seed at all — it only existed in Postgres because someone had pushed it once via Content
Studio — so a fresh deployment's online accept would have failed on the missing FK. Added
`M7015_SeedLiveWelcomeToCRQuest` (Postgres only, guarded against an existing Studio-authored row; 5
NUnit tests). See [Quest System — WhenReady is per-session, not a one-shot
flag](?page=backend/07-quest-system#reading-quests-from-unity-the-quest-journal).

**Feature:** any quest grant — auto-grant, dialogue accept, or a quest discovered purely server-side
on a later sync — now shows a `"New quest: <name>"` toast exactly once per instance, via a new
`QuestManager.OnQuestGranted` event and `QuestToastPolicy` (engine-free, 6 NUnit tests) for dedup.
`AchievementToastPresenter` (already hosting achievement + `WorldToast` toasts) subscribes to the new
event. The quest journal (`QuestJournalView`) needed no additional wiring — `PlayerMenuWindow`
already reloads every tab's data on every open/switch. See [Achievements — Unity
client](?page=backend/15-achievements#unity-client).

## 2026-09-03 — dev-only battle debug stats overlay (F3)

**No way to see a creature's raw stats mid-battle without a debugger attached.** Added
`BattleDebugStatsOverlay` (Editor / `DEVELOPMENT_BUILD` only): pressing **F3** during a battle
toggles two panels, beside the opponent/player combat cards, showing level, current/max HP, the
raw stat block, status conditions, held item, ability list (name/category/power), and a raw
stat-modifier log — sourced from the same `BattleEvents` bus and `TeamSync` data `BattleHUD`
already reads, rendered into the same `UIDocument`. The opponent's raw stats are honestly shown as
unavailable rather than fabricated — the server never sends them to the client. Formatting lives
in a pure, engine-free `CR.UI.Battle.DebugOverlay.Logic` asmdef pinned by 18 NUnit tests. A new
`Debug/ToggleBattleStats` (F3, keyboard) action was added to `CR_GameInput.inputactions` — no
prior debug action map existed to reuse. See [Battle System — Debug stats
overlay](?page=unity/07-battle-system#debug-stats-overlay).

## 2026-09-03 — market listings carry the creature

**Browsing the marketplace meant one follow-up creature lookup per listing** — `GET
/api/v1/market/listings` and `/mine` returned bare `MarketListing` rows carrying only a
`generatedCreatureId`, so rendering a browse row (species, level, seller name) required a
round-trip per row. Both endpoints, plus a new `GET /api/v1/market/listings/{id}`, now return
`MarketListingView`: every `MarketListing` field plus `speciesContentKey`/`speciesName`/
`elementType`/`level` (joined from `creature` via `generated_creature`), `nickname`
(`generated_creature.given_name`), and `sellerTrainerName` (joined from `trainers`). The
single-listing endpoint deliberately isn't gated to `Active` listings — a seller can look up one
that already sold. Element-type filtering on the browse feed is now case-insensitive
(`UPPER()` both sides).

`IMarketRepository` gained view-returning siblings of its existing read methods
(`GetActiveListingViewsAsync`, `GetListingViewsBySellerAsync`, `GetListingViewAsync`); the plain
`MarketListing`-returning methods are unchanged and still back the list/buy/cancel transfer core,
which only ever needs the listing itself.

Pages: *Backend → Creature Market* (new).

## 2026-09-03 — capture crystals refused in trainer battles

**A crystal thrown at a trainer's creature was silently swallowed: the bag closed, the crystal and
the turn were gone, and the log said nothing.** `ItemUseDomainService.UseItemAsync` now detects a
capture crystal by effect type *or* flag (seeded crystals have no `CaptureCrystal` flag) and refuses
it in any non-wild battle before the handler runs — `400 "Capture Crystals cannot be used in a
trainer battle."`, nothing consumed. On the client the engine-free `CaptureCrystalRule` makes the
same call from the coordinator's `BattleSession`; `BattleBagPanelHandler` greys the row
(`BlockedReason`) and refuses in `ExecuteUseAsync` before the VFX or the server call, and the new
`BattleEvents.ItemUseRefused` event puts the reason — or any server 400 / failed `ItemUseResult` —
into the battle log. Wild battles unchanged.

Pages: *Unity → Capture Mechanic* (Refused in trainer battles), *Backend → Battle Persistence*
(Trainer Battles → No capture crystals).

## 2026-09-02 — storage box is six wide and fits on screen

**The Storage tab showed three columns of creatures with the right half of the panel empty, and
the bottom rows ran off the screen.** `.storage-grid` was pinned to exactly four slots wide
(`464px`); under a fractional UI scale the rounded slot widths overran that by a pixel, so the
fourth column wrapped and a 4 x 6 box rendered as 3 x 8. A box is now `6 x 4` (still 24 slots, so
box count and paging are unchanged) and the grid is pinned to `704px` — six slots plus 8px of
slack that absorbs the rounding but cannot fit a seventh.

Pages: *Unity → Creature Storage* (Grid shape).

## 2026-09-02 — online team swap no longer answers 409 Conflict

**Reordering two occupied team slots while online failed with `Failed to swap creature slots:
Conflict`; moving into an empty slot worked.** The server swapped with one `UPDATE … CASE` that
exchanged the two `slot_number`s. PostgreSQL checks the partial `UNIQUE INDEX
(inventory_id, slot_number)` per row as the statement runs, so the first row to take the other's
slot raised `23505` — mapped to 409 — even though the finished state would have been unique. An
empty target touches one row, hence the intermittency. SQLite (offline) already went through a
temporary slot, which is why the bug only showed online.

`BaseTrainerCreatureInventoryRepository` and `BaseNpcCreatureTeamRepository` now run the same
three-step script (A → `-1`, B → A, `-1` → B) inside a transaction on both engines; the
non-transactional overloads delegate to the transactional one so a failure between steps can never
leave a creature parked in slot `-1`. Postgres-container tests pin the occupied-slot swap for both
repositories. The AIO server must be restarted to pick up the fix.

Pages: *Unity → Player Menu UI* (Reordering the team → Why the server swaps through a temporary
slot), *Backend → NPC System* (Other Operations).

## 2026-09-02 — reorder your team from the Team tab

**Team order was fixed at capture order, and there was no way to change it.** The Team tab now has
two controls: **Move** on every squad card (press once to arm, then press the card, *Swap here*
button, or empty-slot *Move here* target you want it in; press the armed card again to cancel) and
**Make lead** on the featured card. Both call `ICreatureInventoryService.SwapTeamSlotsAsync`, which
is transactional and fires `OnSlotsSwapped`; `TeamSync` now listens to that event so the battle
swap list shows the new order at once.

Slots are 1–6 with gaps (storage leaves a hole), so a new `GetTeamSlotsAsync` on the service returns
the real slot number per creature — the view never assumes `index + 1`. The gesture is an
engine-free state machine (`TeamMoveMode`) plus slot arithmetic (`TeamSlotLayout`) in
`CR.UI.Logic`, both tested.

Pages: *Unity → Player Menu UI* (Team tab → Reordering the team), *Unity → Domain Sync Pattern*
(TeamSync events).

## 2026-09-02 — a wild battle that ended before it began

**Visit the Bag tab once, and the next wild encounter ended on the spot.** It looked like a
creature fainting without the forced swap firing. It was nothing of the kind: the battle aborted
before turn 1. `UICoordinator.SetContext(Battle)` walked its screen list with a plain `foreach`;
the bag screen — still an active GameObject behind the closed menu — reacted by deactivating
itself, `OnDisable` unregistered it mid-loop, and `Collection was modified` escaped
`BattleEvents.RaiseBattleStarted` into the coordinator's catch, which logged only the message and
ended the battle `loop_complete`.

Three fixes, each closing the hole from a different side:

- **`ContextScreenRegistry`** (`CR.UI.Logic`, engine-free, tested) now owns screen registration
  and dispatches over a snapshot, skipping screens that left before their turn. Pinned by a test
  that reproduces the exact re-entrancy.
- **`IsolatedDispatch`** (`CR.Game.Battle.Logic`, tested): every `BattleEvents.Raise*` invokes
  subscribers one at a time. A throwing subscriber is logged by name and skipped; the rest still
  run; the raiser never sees the exception.
- **`BagScreenHandler.Dismiss()`**: the menu puts the bag away when it hides, so no orphaned
  context listener survives a closed menu.

Pages: *Unity → Player Menu UI* (registry, dismiss), *Unity → Battle System* (dispatch).

## 2026-08-25 — held items stop duplicating, and the pad works

**Equipping a held item offline duplicated it.** The offline path wrote the creature's slot and
nothing else — the item was never taken out of the bag — so afterwards there was a copy in the bag
and a copy on the creature. Do it again and the same item was on two creatures and still in the bag.
Live in shipped code, reachable from the Bag screen.

The online path was not duplicating, but got there by two unguarded writes, so a failure between
them landed in the same place and two simultaneous equips could overwrite each other's slot.

Both now run through one `HeldItemService`: one transaction, one guarded slot write that only
succeeds if the slot still holds what the caller last read. Room is checked before anything leaves
the bag, returning an item stacks onto an existing entry, and a swap returns the occupant inside the
same transaction *after* the slot write is won. 16 tests, over a real connection rather than a
mocked transaction — a mocked rollback succeeds without proving anything.

**Held items can now be managed from the Team tab**, not just the Bag: two slot buttons per
creature, with a picker filtered to what a creature can actually hold.

**The merchant screen was barely navigable on a pad.** It had one `:focus` rule in the entire screen
while five buttons had only `:hover`, so focus moved and nothing changed. The row was also focusable
while containing three focusable buttons — a container in the ring that does nothing on Submit. The
row now follows its children instead of competing with them.

**The bumpers cycle menu tabs.** Those actions existed and were subscribed to by nothing — and were
bound to keyboard only, so wiring the handler alone would have changed nothing. They were also on
the arrow keys, which `Navigate` already uses; the moment a handler existed one press would have
both moved focus and changed tab.

30/30 backend projects, 490/490 Unity EditMode.

## 2026-08-25 — evolution

A creature that reaches its species' evolution level can become something else — unless the player
holds a button to stop it, or it is holding a Bindstone.

**Three phases, because the cutscene is seven seconds long.** Across those seconds the client can
crash, drop its connection or be force-quit, so the species change is not applied when the evolution
starts. Begin records an offer and touches nothing; commit applies it; cancel records the refusal. A
run that never comes back leaves a pending row and a creature nobody modified — nothing happened, and
it is offered again next level-up.

**Commit re-validates from scratch** rather than trusting the offer it was handed. That is the
difference between server-authoritative and server-observed: between begin and commit the creature
may have been given a blocking held item or traded away, and an old id must not be replayable into an
evolution that is no longer legal. The pending row is claimed *before* the creature is touched,
because the two writes cannot share a transaction and the other order risks evolving a creature whose
cancel won the race.

**One rule, shared.** `EvolutionEligibility` is pure, because it runs in two places that cannot share
a database — online the server decides, offline the client resolves the same rule against its baked
floor. It reports *why* it refused, not just no: a creature that silently declines to evolve reads as
a broken feature, most of all when the cause is a stone the player put there themselves.

**The Bindstone** is a column on `item`, not a new held-item trigger — every value that enum has names
an in-battle event, and evolution is not one. It works by being held, so it offers no Use option: a
stone with one is a stone players try to use, to no effect.

**The cutscene's timing is pure logic**, so every boundary about when a cancel still counts is
testable without playing seven real seconds. Releasing resets the hold rather than banking it; a hold
completing on the final frame still cancels; holding after completion does nothing.

**And five species that can actually evolve.** Until now `evolution_level` was null on all 19 — the
mechanic was fully built and could never fire once. Bud, Sunflower Fairy, Crabby, Snakelet and Dragon
Spark, at levels chosen against the habitat ladder.

Two things found on the way, both the same shape as the mechanic itself: `LocationTriggerBehaviour`
was complete, injected and placed in zero scenes, and the achievement toast presenter sits in no
tracked scene either — so the evolution presenter is created by the installer rather than waiting to
be dragged into a scene that is not in the repository.

30/30 backend projects, 469/469 Unity EditMode, floor rebaked at schema 10015.

## 2026-08-25 — the experience curve, and somewhere to spend it

"The exp curve feels off" turned out to be three faults, only one of which was the curve.

**The curve opened at nothing.** The requirement was a bare cubic, `0.8 × (level−1)³`. Cubic is the
right shape, but a bare cubic starts at almost zero — level 2 cost 1 experience and a first win pays
5. A level cost 0.25 battles at level 1 and 4.84 at level 100: the opening levels were handed over,
then the pace decelerated for the rest of the game. A quadratic term lifts the early levels and
leaves the late shape alone; it is now 1.50 → 5.05.

**The world ran out at level 10.** Every area spawned levels 2–10, and a battle pays out on the
defeated creature's level, so income capped near 95 experience while the next level kept costing
`2.4 × level²`. Fighting the average level-5 wild, a level cost 29 battles at level 20 and 65 at
level 30. No re-curving could have fixed that: the curve was fine, there was nothing left worth
fighting. The habitats are now a ladder — Meadow 2–6, Shore 5–10, Cave 9–15, Crags 14–21,
Dunes 20–28 — overlapping at every seam.

**The experience trait was inverted.** `experience_growth` scaled the level *requirement*, so the
profile named "Fast Experience" (150) needed half again as much per level and was the slowest in the
game. It now scales what a creature *gains*, and the curve is identical for everybody. Earned and
exact experience are separate named methods rather than a flag, because a level-up item computes
precisely what the next level costs and must not be scaled.

**A fourth, found on the way:** creature generation stamped a new creature's starting experience
from its own private formula — `0.8 × level³`, cubing the level rather than `level−1`. A freshly
generated level-25 spawn began 1,439 experience short of what level 25 costs. Generation now reads
the same table as everything else.

**Eight new quests** follow the ladder, so where to go next is answered by a quest rather than by
walking into a habitat twenty levels above you. Each gates on the one before; the middle rungs also
gate on creature level. Making them work also revived `LocationTriggerBehaviour`, which had been
written, injected and placed in zero scenes — every `VisitLocation` objective was unreachable and
every location achievement unwinnable. Every area now carries a visit trigger.

30/30 backend projects, 458/458 Unity EditMode.

## 2026-08-25 — Hearthmere Village, the first settlement

A sixth area scene, and the first that is not a habitat. Eight houses turned to face a square, the
well at its middle, four market stalls, and a road north to the Meadow door — 44 pieces, every
position authored. It is the first use of the FANTASTIC Village Pack, which had sat imported and
entirely unreferenced.

**The town needed no backend change at all.** A settlement hosts an existing area's NPCs rather than
minting its own: the Meadow's merchant and quest giver now work out of Hearthmere, carrying area 1's
content keys and its seeded stock. A sixth area key would have been a merchant the world knows about
and the database does not.

**Where a pair stands became a fact worth stating.** `AreaNpcRoster` separates *the Meadow has a
merchant* (it does — area 1's) from *the merchant stands in `Meadow.unity`* (it no longer does), and
states it as a delegation rather than an absence: the Meadow hosts nobody **because** the Village
claims area 1. Without that, `cr_polish_areas` would have regrown the pair it just lost, giving the
town merchant a twin in a field sharing one inventory — the bug numbered keys were introduced to
kill, arriving from the other side. The repair now runs both directions, and the removal half is
deliberately narrow: only the two prefabs the command places, only from an area the roster says hosts
nobody, every removal logged.

**Laid out, not dressed.** `CrAreaDressingCommand` scatters — seeded random inside an annulus, right
for a meadow and wrong for a town. `cr_layout_village` authors every position instead, in code rather
than in the GUI, so re-running rebuilds the same village exactly and the layout cannot drift from the
table describing it. The road out is enforced rather than hoped for: any piece landing in the lane
between the spawn point and the door is rejected and named.

**One gap the audio wiring found.** `cr_wire_area_audio` skipped the Village with "no AreaEnvironment
to attach to", which turned out to mean everything the dressing pass does *besides* scattering was
being missed by the one area that is never dressed — ground material, fog, ambient, sun. That pass is
now callable on its own, and the village takes the Meadow's palette, because a town lit by a
different sun than its own region reads as a separate world.

`music_area_village` is Medieval Market LOOP, the only bed here that is not a landscape.

458/458 EditMode tests, content audit clean across ten scene NPCs.

## 2026-08-24 — the client becomes a cache

Server content now reaches a running game, and the client no longer overwrites the server on its
way in. Five parallel workstreams, one compile gate.

**Content reads hit one database.** Four bindings — abilities, base creatures, growth profiles,
items — resolved a per-mode router that sent online reads to a stale cache the boot sync never
wrote. They now resolve the one game-data-backed instance in both modes, which deleted 1,218 lines
of routing repositories and two live `NotImplementedException` paths with them. `LocalDataSources.Creature`
turned out to be entirely dead — migrated on every boot, referenced by nothing — and four retired
content caches left the migration pass with it. Player data keeps its per-mode split untouched;
that separation is what keeps offline-issued creatures out of PvP and the market.

**Spawn pools pull instead of push.** World init used to upload every baked ScriptableObject to the
server, so a designer's pool edit was overwritten rather than merely ignored. `ISpawnerSyncClient`
now has one runtime binding and no path can POST — with a regression test that fails if anyone
re-adds one. The sync pulls header, pools and templates in a single request through a new bulk
endpoint, and `SpawnerRecoveryService` re-pulls from the server instead of syncing upward and
counting local rows, which online could never satisfy.

**Deletion propagates.** Rows the server no longer lists are soft-deleted — but only against a
complete page set and a plausible row count, because a deleted row and a truncated response look
identical from the client. Unknown elements, target types, categories, stats and calculations are
now rejected rather than coerced; an unknown element used to become "Normal" silently.

**Abilities got a `content_key`** (M10011, deterministic kebab backfill, partial unique index), so
every content domain finally has a stable identifier across the client/server boundary.

**The floor can be baked from the server.** `CR/Build/Bake Floor From Server` rebakes into scratch,
syncs live content into it, and publishes only if no domain failed. Previously the shipped floor
was built purely from migration seeds and had never seen the backend.

**WAL** is on, so a writer no longer blocks every reader — and `GameDataAdopter` now deletes the
`-wal`/`-shm` sidecars when it swaps a floor, so a fresh database can never inherit the previous
one's write-ahead log.

Two things the compile gate caught that no agent could have: a hardening change written against a
modern Microsoft.Data.Sqlite when Unity compiles against 3.1.32, where `DefaultTimeout` and
`Pooling` do not exist on the connection-string builder; and a constructor collision where one
workstream added a required dependency another was already constructing without. The spawner client
is now optional precisely because a caller baking into a scratch file cannot supply one that writes
to the right place.


## 2026-08-24 — repairing the sync before trusting it

The plan was to point every content repository at the database the server sync writes. Review
stopped that: the sync itself was not safe to make authoritative, and flipping the reads first
would have made six latent defects newly visible to the whole game.

The worst of them destroyed player data. The growth-profile upsert ended
`ON CONFLICT(name) DO UPDATE SET id = excluded.id` — and `generated_creature.growth_profile_id`
points at that key. The first sync where the server's id differed from the baked one would orphan
every creature a player had captured, from a *content* sync. Alongside it: half the GUID writes
skipped normalisation against a case-sensitive join, so one uppercase id meant a creature that
learned nothing; `INSERT OR REPLACE` quietly reset a seeded `stat_changes.duration` of 3 to 0 on
every boot; junction rows minted a fresh id each run against a table with no composite unique
index, so they appended rather than replaced; there were no transactions, no paging past 500 rows,
and no way for `SyncAllAsync` — which caught everything and returned void — to report a failure.

All fixed, and the SQL moved into `ContentSyncWriter` so it could be tested against a real SQLite
database built from the shipped floor's own schema. Eleven round-trip tests, each sabotage-checked:
restoring the original growth-profile statement fails the test that describes it, by name.

That test suite also caught a review finding that was itself wrong. A pass had asked for
`growth_profile_id` and `ability_progression_set_id` to sync onto `creature`; the columns do not
exist there, because M1023 deleted them on purpose — the spawner template makes that assignment
and the generated creature records it. Implementing the suggestion failed against the real schema
in seconds. A schema test now pins it.

`ContentRegistryInitializer` also stopped firing the sync and forgetting it: world init writes and
reads the same database, so an unawaited sync raced it.

## 2026-08-23 — the camera kept looking around behind the menu

Opening the player menu left the camera and the trainer live underneath it: the stick rotated the
world while you were trying to navigate tabs. `PlayerInputGate` was built for exactly this and was
doing nothing, because the `BoolVariable` asset carrying the "menu is open" signal no longer
existed. The scenes still held its GUID, so nothing looked broken in the YAML — the fields simply
resolved to null, the menu set a flag on nobody, and the gate never fired.

Recreated as `Assets/CR/Content/Defs/Variables/IsMenuOpen.asset` and pointed the gate, the player
menu and the merchant shop at that one instance. Disabling the Player map stops the camera too:
the rig's `MInputLinkLook` reads `Player/Look` and `Player/Zoom`, and it handles `canceled`, so a
held stick zeroes out rather than leaving the camera drifting.

The rule moved out of the MonoBehaviour into engine-free `GameplayInputRule` (6 tests): gameplay
input is live only in the overworld, with no menu and no battle open.

## 2026-08-23 — the quest that lived in the wrong scene

Talking to a quest giver granted nothing — no quest logged, no starter creature. The Quest
Granter (grants `quest-welcome-to-cr` on the `OnTrainerSelected` event; its reward chain is the
player's first creature) existed only in legacy `Test UI.unity`. Every Editor session had that
scene co-loaded, so the flow worked by accident; Core-only builds — every player build — had no
granter at all. The granter now lives in `Core.unity` with the identical entry, next to the rest
of the system-level wiring (`QuestWorldBehaviour` sync and the DI-bound `QuestDialogueBridge`
were already there). The quest-accept idempotency guard means players who already selected a
trainer just get the quest on their next launch, once.

## 2026-08-23 — a name the Deck can actually type

Name entry now works without a physical keyboard. Gamepad A on the Create Character name field
asks Steam for its keyboard first (`SteamTextEntry`, Steamworks.NET behind `#if STEAMWORKS_NET`
— it lights up only when the game runs under Steam), and falls back to a built-in on-screen
keyboard (`VirtualKeyboardOverlay`): a code-built UI Toolkit modal, every key a focusable button
so the d-pad walks it, B cancels, Done commits. The editing rules — leading capital, shift
consumed by one press, capital after a space, no double spaces, length cap —
live in engine-free `VirtualKeyboardModel` with 9 tests. Desktop typing is unchanged.

## 2026-08-23 — the Deck reaches the meadow

Two more Steam Deck findings once the build booted. The world behind the startup screens was an
empty skybox: only the Editor ever had an area scene open, and nothing in a player build loads
one until a door is used. `AreaLoader` now loads its configured starting area (Meadow) on first
overworld entry when no area is present — `InitialAreaRule`, engine-free, 5 tests.

And the Create Character name field never took input: nothing focuses it, a gamepad-only device
has no pointer to click it with, and an unfocused UI Toolkit field shows no caret and receives no
keys — the Steam keyboard was typing into the void. The field now takes focus a frame after the
screen shows (a frame, because Focus() on an element the panel has not laid out yet is a no-op).

Follow-ups from the second Deck run: the baked catalog still carried a **remote catalog** pointed
at the dev MinIO on localhost, so startup flooded the console with connection errors on any
machine that is not the dev Mac — remote catalog build is off until a real CDN exists. And the
starting area now loads at boot (PreGame) rather than on overworld entry, so the main menu sits
over the world as it does in the Editor; the NPC/spawner init that needs a trainer runs deferred
when the overworld is actually entered.


## 2026-08-23 — the build that opened the wrong door

The first Linux player booted into two grey cylinders. Nothing platform-specific: the global
scene list still had `Test UI.unity` — the pre-Core scene — at slot 0, and a player always
starts at slot 0. The Editor never showed it because you press Play on Core. Test UI and the
`_AreaTemplate` are out of the list; Core is scene 0, the five areas follow.

Same scene had been sitting open beside Core in the hierarchy, which is why the menu stopped
taking input earlier in the day: two full UI stacks, two EventSystems, one of them winning.

While checking the build inputs, the `CRContent` Addressables group had lost 21 entries on disk
(14 of them for assets still present). Rebuilt from the abilities themselves through the
workbench's publish step — 102 entries, zero dangling references — then an Addressables build
and a floor rebake so the next player build ships current content.

Then the Steam Deck booted into Meadow with "Scene 'Core' couldn't be loaded": the active Linux
build profile had grown its own scene-list override (areas only). Cleared on all three game
profiles so they inherit the global list. Underneath that, the Linux player had **no SQLite
native** — `libe_sqlite3.so` shipped with a stub `.meta` assigned to no platform — so the
initial migration could never open a database. `build-packages.sh` now writes the per-platform
PluginImporter `.meta` for all three natives, and `link.xml` covers the five newer migration
assemblies (Achievements, Loot, Pickups, Quests, Stats).

## 2026-08-23 — one click, three players

Shipping a round of builds meant opening Build Profiles three times and babysitting each one.
**CR > Build > Build Players…** now takes the three checkboxes — Windows, macOS, Linux — and runs
them as a queue in the open Editor, one row per target, with size and time on success and an
error count pointing at the Console on failure. A failed target does not stop the others.

The builds are sequential on purpose. Unity cannot build two players inside one Editor process,
and the alternative — a mirrored project copy and a headless Unity per target — costs ~20 GB of
disk per platform for a machine that would be pegged anyway. Sequential was the call; the window
says so in its help box rather than pretending otherwise.

Target → profile, target → output path, queue order and the summary line are engine-free
(`PlayerBuildPlan`, 10 NUnit tests). `Builds/` is now git-ignored so an `.exe` or `_Data/` folder
can never be staged by accident.

## 2026-08-23 — a correct swap that looked like a loss

Storage swaps were writing the right rows and still reading as a bug: swap out a level 7, and it is
gone from the team, not in the Data File, and somewhere in a box of near-identical cards. The
database was right the whole time. The screen simply never said where the creature went.

The view now follows the outgoing creature — selects it, pages to its box, and says so in words. New
`StorageBrowser.BoxIndexOf` answers "which box is this on" under the *current* filter and sort, and
returns `-1` when the active element chip would hide the creature; the view clears the chip rather
than paging to a box the creature is not on. That filter case is the one path that can make a stored
creature genuinely invisible.

Five tests, sabotage-verified.

The box also went from 5 columns to **4** (`BoxColumns` x `BoxRows` = 4 x 6 = 24 slots). The grid had
been wrapping on available width, which fitted a fifth column only partly; it is now pinned to
exactly four slots wide.

## 2026-08-23 — creature storage, and a swap that cannot half-happen

The Storage tab: a paged box grid with element chips and a capacity readout, a Data File panel for
the selected creature, and a modal for exchanging it with a team member. Built from the Stitch
designs.

The interesting part is the exchange. Expressed the obvious way — move one out, move the other in —
it is two transactions, so a failure between them leaves the team a creature short with no way to
tell which half landed. It also cannot express the common case at all: on a full team the incoming
creature has nowhere to go until the outgoing one has left. `SwapTeamAndStorageAsync` does both
removals and both adds inside one transaction, reusing the exact slot the outgoing creature vacated
so the player's battle order survives.

The screen's rules live in an engine-free asmdef and are tested outside the Editor — 31 cases
covering box paging, clamping, filters, sorting and swap eligibility, plus 10 on the transaction.

One rule worth stating: **the last creature able to battle cannot be sent to storage.** Allowing it
strands the player, and the failure surfaces much later as "nothing happens when I walk into grass"
rather than at the moment of the mistake. A fainted member can always be swapped out, including when
the whole team has fainted — otherwise a wipe would be unrecoverable.

## 2026-08-22 — a merchant per area, stocked from the server when online

Every area instantiated the same merchant prefab with `demo-merchant` baked in, so five bodies
were one NPC row and one inventory — and that inventory was the first roll from 19 days ago,
draining as the player bought, because a restock cooldown of 0 meant "never". Online mode never
talked to the server for merchants at all: `INpcMerchantService` was bound straight to the local
implementation.

Now:

- **One merchant and one quest giver per area** — `demo-merchant-area-{n}` /
  `demo-questgiver-area-{n}`, stamped onto the prefab instances by `cr_polish_areas` from
  `AreaNpcKeys`. Ten new `NpcDefinition` SOs, registered and localised.
- **Five stock spawners**, `demo-merchant-area-{n}-items`, seeded by `M6015` and authored as SOs;
  cheap crystals in area 1, radiant and the charm weighted toward area 5.
- **Stock refreshes on every world load** (`NpcMerchantBehaviour` forces the re-roll).
- **Online is server-authoritative**: `NpcMerchantOnlineOfflineService` routes every merchant call
  to `/api/v1/merchants/*` when online, local SQLite when offline, sampled per call. No fallback.
  New `GET /merchants/{id}/multipliers`; 409 bodies now survive as `ConflictException` so a refused
  purchase shows its reason.
- **Audit**: `AuditAreaNpcs` scrapes the area scenes and reports shared, empty, undefined and
  wrongly-typed NPC keys — every one of which had shipped silently. `demo-merchant.asset` said
  `QuestGiver`; fixed.
- **Bug found by the new read-back test**: `spawn_probability` is NUMERIC-affinity in SQLite, so a
  pool mixing `1.0` (stored INTEGER) and `0.5` (REAL) threw for the whole query. `CAST AS REAL` on
  the SQLite read path.

Then a gap audit went looking for what the first pass missed, and found plenty:

- **The authored spawner key was inert.** `NpcDefinition.itemSpawnerContentKey` synced to the server
  and passed the audit, but the game read the *scene* field, which `cr_polish_areas` overwrote with
  the numbered convention — so editing the SO changed nothing. The stamper now reads the SO and only
  falls back to the convention when it is unset, and a new `npc_stock_key_drift` warning fires when
  the scene and the SO disagree.
- **Merchant identity came from the GameObject name.** Duplicating a merchant (`CR_NPC_Merchant (1)`)
  or renaming it silently switched off key stamping *and* every merchant audit check. Identity now
  comes from the source prefab.
- **Two merchants in one area sharing a key went unreported** — the audit grouped by distinct area,
  so the Ctrl-D case, which is the same one-row-two-bodies bug, slipped through.
- **A pull could wipe an authored link.** The server upsert coalesces so a runtime re-ensure cannot
  null the key; the pull direction had no such guard, so Pull All on a never-pushed project unlinked
  every merchant from its stock.
- **`isActive` was a decoy in item-spawner sync** — a designer could disable a pool or template, push
  it live anyway, then pull and have it silently re-enabled. The hardcode was in
  `ItemSpawnerDomainService`, one layer above the endpoint, so it round-trips properly now.
- **236 dead doc-source globs.** Every `cr-data` pattern carried a `cr-api-unity/` prefix, but the
  watcher runs `git log` with that repo as its working directory — so the prefixed form matched
  nothing and 27 doc pages could never be marked stale.

Two weak tests were replaced rather than trusted. `SeedIsIdempotentOnRerun` could not fail:
FluentMigrator skips an applied migration, so the seed SQL never ran twice and every guard in it
could have been deleted with the test still green. The replacement deletes the `VersionInfo` row and
re-runs, and was sabotage-checked by stripping a guard.

Verified: cr-api full suite green; Unity area-logic and merchant-router logic green standalone; the
Editor compile gate confirmed with a positive control per assembly, because Unity aborts the
remaining assemblies on the first failure and one injected error only proves one of them is live.

## 2026-08-22 — six missions, and the player picks one

Battle missions were one hard-coded objective that was always on. There are now **six**, and the
player chooses which to carry into the next fight from the team view's sidebar, beside the run
summary.

New content: Deep Freeze (Slow), Mind Games (Confusion), Earthbound (Grounded), Venomancer
(Poisoned), Wildfire (burn four *different* creatures) and Clean Sweep — the first mission that is
not about status at all, counting the player's own knockouts. Each unlocks an existing high-power
ability, so every reward is a move the battle system already knows how to resolve and animate.

**No mission uses `Weakened`**, because exactly one ability applies it and a mission nobody can
finish reads as a bug rather than a challenge. A migration test now enforces that generally: every
status mission must name a condition some ability can actually inflict, every reward ability must
exist, and every mission type must be one the tracker implements.

`KnockOut` is a new mission type in the tracker, and an unknown type now scores zero instead of
being skipped by a type check — content naming a type this build has not implemented should be
inert, never fatal to a turn.

The selection is **client state by design**: the conductor is a Unity sidecar that evaluates
missions from the outcome stream both online and offline, so nothing on the server needs the
choice. It is kept per trainer, so two characters on one device do not share a loadout.


## 2026-08-21 (evening) — a player who is wearing clothes

**The player was the Malbers demo rig, in underwear.** Its only body texture is named `SteveNaked`
and all five material variants are skin tones. The BoZo pack has clothed characters but no
controller, and the two skeletons share not one bone name — `R_Spine2` versus `spine_04` — so the
mesh-rebinding trick used for the area NPCs could not work.

Both avatars are Humanoid, though, so Mecanim retargets `AC Human v5` onto BoZo's skeleton. The root
GameObject is never replaced: `MAnimal`, `Aim`, `IKManager`, the Rigidbody, the movement capsule and
the `Tags` component all stay put, and only the skeleton and meshes beneath change.

The part that would otherwise have cost an evening: deleting a skeleton nulls every Malbers
reference into it, including `MAnimal.RootBone` — which gives a character that loads without a
single error and then does not move. Rather than warn, the command records what each reference
*meant* as a `HumanBodyBones` value before the delete and re-points it afterwards: 8 of 11
re-pointed automatically, along with the three bone-mounted hit capsules.

Two more it caught by itself: the hair carried 7 simulation bones with no body equivalent (null bone
entries smear a mesh to the origin — now anchored to the head), and the new body is 35% taller, so
the movement capsule was scaled to match or the character walks shin-deep in the floor.

**Follow-up 3 — a NullReferenceException flood from the character pack.** Every BoZo component
looks for an `OutfitSystem` in its parents, and that object was the prefab root the graft discards.
`BodyShapeModifier` calls `system.GetBones()` from `LateUpdate`, so eleven orphaned copies threw
every frame — about 660 exceptions a second. The swap now strips the entire `Bozo.*` namespace from
the grafted rig (36 components here: `BodyShapeModifier` x11, `BoZo_MagicaClothCollider` x13,
`Outfit` x8, plus `ApplyTags`, `OutfitHideByTag`, `OutfitHeightChange`), because the pack is used as
static art — bound once at build time, with nothing to re-fit at play time.

**Follow-up 2 — the clothes went through the body.** `ProxyMesh`, the base rig's one visible mesh,
is a low-poly *fitting proxy*, not the body. The real body is `Body_BasicBody`, split into fourteen
region renderers, and that split is the pack's hiding mechanism: a garment's `CoverChest` /
`CoverUpperArms` tag names a region directly, and you switch it off. Rendering the proxy meant a
whole naked body sat inside the clothes. Now 14 regions bind and 7 are hidden under the outfit,
read from each garment's own `ApplyTags` data rather than from its name.

Two follow-ons from that: the head is a separate piece (the proxy had been supplying the face, so
hiding it produced a headless character), and eyes anchored to the rig root — which sits on the
floor — stretched from the face to the feet as a thin spike. Head, hair, face and makeup slots now
anchor to the head bone.

**Follow-up — the camera flew up on start.** Self-inflicted: the re-homed chest and head capsules
were created on new GameObjects, which are born on layer `Default`. The third-person camera's
obstacle avoidance filters on exactly `Default` and deliberately excludes the character's own
`Animal` layer, so the camera began treating the player's own torso as world geometry and shoved
itself out of it — upward, every spawn, with nothing in the console. Carriers now inherit the bone's
layer. Fixed alongside it: `MAnimal.RootBone` was set to the topmost bone (`armature`) where Malbers'
own rule is `Hips.parent` (`root`).

`cr_swap_player_in_scene` does it in place on `Core.unity`, because the scene player carries a dozen
CR and Dialogue components the Malbers prefab has never seen; **26 components preserved**, camera
tracking intact, 0 null bones. `cr_build_player_model` produces a standalone prefab — and sets its
tag to `Player`, since the Malbers prefab ships tagged `Animal` and every door, pickup and NPC
trigger tests for `Player` by name.


## 2026-08-21 (later again) — rewards that scale, and somebody in every area

**Gold did not scale with level because there was no gold.** Loot tables existed for exactly two
owners — the creature `cindris` and the spawner `starter-wild-zone` — and no playable area uses
either. Every wild battle in Meadow, Cave, Shore, Crags and Dunes rolled against an empty entry set
and dropped nothing at all. The loot system was working perfectly on content nobody had authored.

Two fixes, because one alone would leave the other half broken:

- **`BattleRewardScaling`** grants victory currency from the defeated creature's level, before and
  independently of the loot roll. It needs only the level, not a resolved `content_key` and not an
  authored table — both of which had been missing in practice. A win that pays nothing reads as a
  broken battle, not as a gap in the data.
- **`M7103`** seeds a loot table for each of the five area spawners, so items drop too. The five are
  identical on purpose: all five areas draw from the same level band (2–10), so tiering the drops
  would encode a difficulty difference the spawner data does not have.

**Experience is quadratic now, not linear.** Levelling costs `0.8 x (level - 1)^3`, so the price of
the next level grows like `level^2` while the old `5 x level` award grew like `level`. The gap
compounded: roughly 3 wins per level at 10, 10 at 20, and **48 at the level cap** — the game got
slower the longer it was played, which is what a grind is. Matching the curve's shape holds it near
2.5–4.5 wins per level from start to cap. Currency loot and experience loot rolled from tables are
scaled by the same growth factor; item and creature quantities are **not**, because those are counts
rather than amounts and multiplying them hands out inventories. Levels are clamped to `[1, 100]` for
scaling so a corrupt level field cannot mint an unbounded amount into the economy.

**Every area has a quest giver and a merchant.** They were split one per area — quest giver in
Meadow, merchant in Cave — to prove content initializes in a scene loaded after the game has booted.
Cave still covers that. What the split also produced was three areas with nobody in them. Both are
now in all five, added by `cr_polish_areas` so a finished area gains them without a rebuild that
would discard its dressing.


## 2026-08-21 (later still) — pickups, edges, zone colour and people

**Pickups were dead three ways over.** Every placed pickup asked for `item_heal_potion_30`, which is
not a `pickup_definition` — the seeded ones are `pickup_small_currency` and `pickup_lost_toy`
(`pickup_coin_pile` and `pickup_bouncy_ball` are model asset keys on those rows, not definitions).
The lookup returned null, and because `_collecting` was set on entry and cleared only in the `catch`,
that early return left the pickup **visible and permanently inert** — which is exactly what "they
stay on the scene" looked like. And the player could not have triggered it anyway: the Malbers rig
tags only its root `Player`, so `CompareTag` on the entering collider failed for every child while
the ones that did fire were 5 m AI detection spheres.

All three are fixed: real content keys with a unique instance id per placement (they had shipped
sharing one, so collecting any single pickup would have despawned the other four), a `finally` that
releases the flag on every non-despawn path, and reach decided by distance from the collector's root
rather than by which collider happened to hit. `OnTriggerStay`, because on Enter a rejected detection
sphere means the pickup is never reconsidered while the player stands on top of it.

Collection now raises a **`WorldToast`** — "You picked up 50 Coins" — named from the granted reward
rather than the content key. The bus lives in `CR.Core.Notifications`: gameplay raises, UI listens.

**You can no longer walk off the world.** Four invisible slabs at each ground's edge, sized from the
ground renderer's own bounds, 20 m tall and sunk 2 m so they cannot be vaulted or clipped under.
Verified by raycast at four heights in all five areas.

**The encounter zones carry their biome's colour** — a low, faint disc of the area's signature hue
inside the trigger, so "fights happen here" and "this place is Ice" are one idea.

**The quest giver and merchant are people.** They were primitive cylinders, and nothing in the
project had a dressed humanoid to replace them with — the Malbers body texture is literally named
`SteveNaked` and its five variants are skin tones in underwear. So the character is assembled from
the BoZo modular pack: base body plus tunic, trousers, boots, each piece's bone array remapped by
name onto the base skeleton. Parenting alone would have left the clothes standing still while the
body walked off.

Known gaps: the hair piece did not bind and the NPCs are bald, and the outfit materials read muddier
than the pack's own demo. Both are cosmetic and want an Editor session.


## 2026-08-21 (later) — each biome lit as its element

Every area now names an element before a single creature appears: Meadow Flora, Cave Ground, Shore
Water, Crags Ice, Dunes Fire. The mapping is terrain-intuitive rather than read from the spawn pools,
because the pools are deliberately mixed — the Cave rolls six elements at one creature each, so there
is no dominant element in the data to derive from.

**The values live in one table now.** Sun, ambient, fog, ground, motes and signature colour used to
be spread across three `switch` blocks, so a biome could not be described without reading all three
and could not be changed without editing all three. `ElementalPalette` collects them into a row per
place.

That split had already caused drift. Portal colours sat in a *fourth* table, and the Cave portal was
still purple after the Cave became Ground ochre — the doorway taught one element and the room behind
it another. `PortalColour` now reads the destination's signature from the same table, so a door is
coloured by where it leads.

**The motes are authored.** AZURE ships god rays, leaf fall and snow; everything else on disk is a
combat impact effect. Pollen, cave dust, sea spray and embers do not exist in any imported pack, so
they are built as particle systems with drift carrying the meaning — pollen and embers rise, cave
dust falls from a ceiling. Crags gets none: it is Ice and already snowing.

Two traps on the way. Particle modules are structs returned by value, so editing a local copy does
nothing until it is assigned back. And the Cave has no weather prefab — no sky to have weather in —
so an early return on "no weather" skipped the mote build for the one biome that most needed its
element in the air.

**Known, not fixed:** the battle arena sits 99 m from each play area and its 31 m backdrop is always
active, so it reads as a pale wall on the horizon wherever the fog runs far enough to show it — most
visibly in the Dunes, whose fog deliberately reaches 220 m. That predates this change and needs a
decision about hiding the arena until a battle starts.


## 2026-08-21 — something to fight, and somewhere to find it

**Walking into a zone sometimes produced nothing, and it was not the content bug.**
`CreatureSpawnDomainService` chose a spawn pool with a weighted draw and only then asked whether that
pool held any templates. An active-but-empty pool could win the draw, and the spawn returned
`NoTemplatesAvailable` while a sibling pool sat full of creatures — a coin flip weighted by the
pools' own `spawn_weight`. The global-template fallback had the same shape, firing only when the
spawner had *no* pools at all, so one emptied pool skipped it and starved.

`SelectProductivePoolAsync` collects every reachable pool (the spawner's own and the global
template's, every time), drops the ones holding no templates, and draws over what is left. If
anything under a spawner can produce a creature, it now does. All-zero weights and all-zero
probabilities are handled explicitly rather than falling through: both are states a designer can
author, and neither should cost an encounter already committed to.

The regression test repeats 25 times with the empty pool carrying 1000× the weight of the full one.
The bug was probabilistic; one green pass would have proved nothing. Reverting the service makes
exactly those two tests fail.

**The bushes are the encounter now.** Wild battles only ever fire from the `CR_EncounterZone`
trigger, whose own renderer is disabled — so the design problem was making an invisible 5 m circle
legible. Ground cover alone did not do it: grass reads as scenery in a meadow because grass is
everywhere, and the cave and the dunes have none to read. Each zone now also gets a raised clump
inside 55% of the trigger radius — near enough that reaching the bush and entering the trigger are
the same act. Flowering shrubs in the Meadow, a mushroom thicket over slate in the Cave, cattails on
the Shore, dead scrub over stones in the Crags and Dunes.

`MakeWalkThrough` strips the colliders off every piece of that dressing. It is the difference
between a bush you run into and a bush you bounce off: these prefabs are authored as scenery to walk
*around*, and leaving their colliders on would build a wall exactly where the trigger is. Verified by
rendering all five zones and by a `Physics.OverlapSphere` at each trigger — zero solid colliders
inside any of them.


## 2026-08-20 — the DEFEAT screen for a battle that never happened

Walking into the grass produced a **DEFEAT** summary reading `loop_complete`: no experience, no
items, no events. Nothing about the battle system was broken. The meadow had no creatures to spawn,
and every layer between that fact and the player converted it into something less true than the
layer before.

The chain, cause first:

1. The eight newest species were authored through the Content Studio, so Postgres assigned their ids.
   `M10000SeedRosterCreatures` seeded the same content keys with different hard-coded ids, lost to
   the UNIQUE index on `creature.content_key`, and `ON CONFLICT DO NOTHING` dropped the rows in
   silence.
2. `M10001`/`M10002` pointed the area templates at the discarded ids. No foreign key exists from
   `creature_spawner_template.base_creature_id` to `creature.id`, so every insert succeeded.
3. The spawner config endpoint resolves the creature by id to fill `creatureContentKey`, and
   returned `""` for each affected template.
4. A Content Studio pull wrote those blanks into the `SpawnerDefinition` assets.
5. The offline spawner sync read the assets, resolved no creature for a single template, and applied
   its normal rule for templates missing from a config: it soft-deleted all 23 of them. Meadow, Cave
   and Crags lost their entire spawn list.
6. `BattleCoordinator` found no opponent and returned early — into a `finally` that called
   `EndBattle(null, "loop_complete")` regardless, which derives `playerWon` from a null winner.

Each step was individually defensible. Together they turned one mismatched GUID into a lost battle
the player never fought.

**Four fixes, one per layer that could have stopped it.**

`M10006RepairTemplateCreatureIds` repoints dangling templates using the denormalized
`creature_content_key` on the template row — the one link between the two id sets that stayed
correct. It touches only rows whose id resolves to nothing, so a healthy database is untouched and
re-running is a no-op.

The config endpoint falls back to that same column and logs a warning instead of emitting an empty
key as though it were data.

`SpawnerPrunePolicy` stops the sync deleting from a config it did not read cleanly: templates are
pruned only when every one the pool declared resolved, and a definition declaring no pools at all is
treated as a failed read rather than an emptied spawner. Stale rows surviving one sync is
recoverable; the deletion was not.

`BattleCoordinator` tracks `_encounterStaged` and, when an encounter dies before the arena is staged,
unwinds quietly instead of inventing a result. The player never left the overworld, so that is where
they stay.

**The zone now recovers on its own.** Fixing the DEFEAT screen exposed the other half of the
problem: `SpawnerEncounterBehaviour` clears its `_encounterInProgress` gate in `OnBattleEnded`, and
an aborted encounter deliberately never raises it — so a quiet abort would have left the zone dead
for the rest of the session, with the player standing inside a trigger that cannot fire again.

`OnEncounterAborted` closes the loop. The zone clears its gate, and on the first
`NoCreatureAvailable` failure asks `ISpawnerRecoveryService` to rebuild the spawner from its
`SpawnerDefinition` — which works because the database pool is derived data and the asset is the
source. Then it re-arms on a capped exponential backoff, and after three failures stops with an error
naming the spawner, because a zone whose pool is genuinely empty fails every time and a retry loop
would only bury that. `EnsureReadyAsync` runs the same check at activation, so the usual case is
repaired before the player reaches the grass.

**The test that was missing.** `EveryTemplatePointsAtACreatureThatExists` asserts the invariant
against a full migration run. It is the check nobody wrote, and its absence is why a schema-level
inconsistency surfaced as a gameplay bug in a playtest rather than as a red build.


## 2026-08-19 — a battle arena per area, and the clearance check that was lying

Every area instanced `CR_BattleArena` with the prefab's default `arenaKey` of `starter-wild-zone`, so
all five arenas claimed the same key — harmless with one area loaded, ambiguous during a portal
transition when two scenes are briefly loaded together. And the arena itself was a bare 20 m plane,
so a battle showed the world beyond rather than a place. Each area now owns its key
(`meadow-arena`, `cave-arena`, `shore-arena`, `crags-arena`, `dunes-arena`), its `BiomeType`, a 70 m
ground in its own material, and dressing built from its own biome's props.

`cr_dress_arenas` does the work and repoints every battle-starter in the scene at the new key. The
constraint that shaped it: the authored establishing vCam orbits the arena centre at **radius 9**
(ring heights 0.1–5), close shots sit ~3 m off a creature, trainers stand at x ±9 and creatures at
±4.5. So radius < 14 is a no-build zone, dressing lives at 15–28, and the backdrop at 31.

**The check that lied.** The first version measured each prop's distance from the arena centre by its
**pivot** and reported a reassuring "closest prop 15.0 m". The cave render was taken from *inside* a
boulder: `RockCave`'s mesh is wide enough that a pivot at 21 m reaches to 6 m. `TryClearFootprint`
now measures world bounds, pushes each instance out until its geometry clears, and drops it if it
cannot fit at all — which retired every `RockCave` in the cave plan, so the chamber is built from
rocks that fit. The report says `nearest geometry`, and that number is honest.

**Ending the view took two mechanisms, not one.** Occluders are placed on staggered rings — evenly
spaced by angle, each ring phase-offset so one ring's props cover the next ring's gaps — because
uniform random placement leaves holes, and every early render showed daylight between the cliffs.
Rings still could not be *guaranteed*, so a backdrop tube stands behind them at radius 31: 16 m tall,
unlit, tinted to each biome's distance. Props give the silhouette; the backdrop gives the certainty.

Two traps met on the way. The backdrop is viewed from inside and back-face culling keys off triangle
**winding**, not normals — so a correctly authored inward surface rendered as nothing until the
material set `_Cull Off`. And the material was only configured at creation, so an asset from an
earlier run kept its first settings and later tweaks silently did nothing; settings are now
re-applied every run.

**`cr_render_arenas`** renders each arena from the camera's own orbit, three bearings, and writes
PNGs. Every real defect in this feature — the wrong prefab packs, the ring gaps, the boulder around
the camera — was found in an image, never in a log.

→ [Area Scenes — per-area battle arenas](?page=unity/22-area-scenes)

## 2026-08-19 — the opponent could not attack: status conditions were never wired up

A playtest report — *"the opponent looked unable to attack and kept passing the turn to me"* — turned
out not to be a battle-loop bug at all. The opponent was taking its turn; the turn just did nothing,
and nothing on screen said so.

Three faults stacked. The wild AI rolls a **20 % chance to use a Status-category ability**. Growl is
the only Status ability in the game, deals no damage by design, and its entire contribution is the
condition it applies. And **no ability in any database inflicted any condition**: `M9990SeedGameData`
seeded four status conditions but nothing ever populated `ability_status_conditions` or
`status_condition_stat_changes`, so both tables were empty in Postgres and in the baked SQLite floor
alike. Growl was a guaranteed no-op. Add a 15 % miss rate on the alternative and **≈32 % of wild
turns produced no visible effect** — a third of them, with no message to explain it.

The same empty table also made `mission_pyromaniac` ("apply Burn three times") permanently
unreachable. The tracker and conductor were both correct; the content could not produce the event
they counted.

**Content** — `M10005SeedAbilityStatusConditions` seeds 22 ability→condition links (Fire→Burn,
Ice/Lightning→Slow, Poison→Poisoned, Ground→Grounded, Radiant→Confusion, Growl→Weakened), a stat
change per condition, and a duration on every condition — a NULL duration read as "lasts the whole
battle". Two traps found on the way: `damage_per_turn` / `healing_per_turn` on `status_conditions`
are **inert** (the resolver reads damage over time from a `HealthPoints` stat change), and
`BuildSnapshotAsync` honours only `Add` and `Subtract`, so a `Multiply` amount silently does nothing.
Verified by querying the migrated database rather than trusting the migration to report success —
the same class of bug bit an earlier seed that "succeeded" while writing zero rows.

**The fix the content needed** — seeding the links would still have changed nothing.
`BaseAbility.ConditionsInflictedIds` is not a column: it has to be joined in from
`ability_status_conditions`, and **no ability read path did that join**. `GetAbility`,
`GetAbilitiesPaginated` and `GetAbilitiesForProgressionSetAtLevelAsync` all returned abilities
claiming they inflicted nothing, so `BattleDomainService` skipped condition resolution entirely —
status effects had been dead project-wide with no failing test to show it. `HydrateConditionsInflictedAsync`
now fills the property on all three paths in one batched query, and `AbilityConditionHydrationSqliteTests`
reads it back through the real repository against a migrated database.

**Migration domains** — running the Docker suite surfaced 13 failures in
`CR.Creatures.Data.Postgres.Test` that `--skip-docker` had been hiding. Three Creatures-domain
migrations seed the world into Spawner-domain tables, which do not exist in a domain-scoped run;
they now guard on `Schema.Table(...).Exists()`. That skip is silent, and a silent skip in the full
pipeline would empty the game world without failing anything, so `WorldContentSeedSqliteTests`
asserts all five area spawners exist, no spawner has an empty pool, and no progression set is
without entries.

**Wild AI** — a status ability is now only chosen if it actually inflicts something, and the 20 % roll
is only made when such an ability exists. Separately, `LoadAbilitiesAsync` was passing a hardcoded
level `1` to `GetAbilitiesForProgressionSetAtLevelAsync`, pinning every wild creature to its starting
moves forever; it now uses the creature's real level.

**HUD** — every resolved turn now says something: *"The opponent used Cyclone!"* before the animation,
*"But it missed!"* on a miss, and *"But nothing happened!"* as a trailing remark when an ability
connected and still changed nothing. The last rule lives in `BattleTurnNarration.IsSilentTurn` in the
pure `CR.Game.Battle.Logic` asmdef (10 EditMode tests). The log shows `ActionOutcome.AbilityName`,
a new field: `AbilityKey` is an animation key and twelve abilities share `fire_ember`, so it would
name the wrong move for eleven of them.

Also fixed while in there: `BattlePresentationSequencer` reported `ConditionsTriggered` and
`ConditionsRemoved` against the **target**, but `BattleResolver` collects both from the **attacker's**
condition list — so a burn ticking on your own creature was announced as the opponent's.

**Spawners** — `CR.REST.AIO/Program.cs` declares spawner routes inline instead of calling
`MapSpawnerEndpoints`, and `GET /api/v1/spawners/content-registry` was missing. Content Studio's
Spawners **Pull** therefore 404'd against the dev host no matter what the database held, which is why
the five area spawners seeded by `M10001`/`M10002` (meadow, cave, shore, crags, dunes) existed as
rows but never as `SpawnerDefinition` assets. Route added; Pull now creates the missing assets.

→ [Battle Persistence](?page=backend/09-battle-persistence#condition-application) ·
[Battle System — turn narration](?page=unity/07-battle-system) ·
[Spawner System](?page=backend/03-spawner-system) ·
[Backend Architecture — migration domains](?page=backend/01-architecture)

## 2026-08-19 — battle extensions: in-battle missions without touching the battle system

In-battle missions shipped — *"set the same target burning three times → unlock Mega Burn for the
rest of this battle"* — and the battle system was not modified to support them. The interesting part
is the shape, not the feature.

An extension gets **two seams and nothing else**: `BattleEvents.ActionResolved` coming out (raised
after `PlayAndReconcileAsync`, so a reaction lands after the hit it reacts to) and
`IPlayerAbilityAugmenter.Augment` going back in (between `BuildAbilityListAsync` and
`RaisePlayerTurnStarted`, player turns only, injected `[InjectOptional]` so battles run with nothing
bound). Neither seam can change how an action resolves.

An unlocked move needs no special handling downstream because `BattleDomainService` looks abilities
up by id with **no ownership check** — so an injected entry flows through the ordinary pipeline:
same damage math, same FX keys, same presentation beats. The honest caveat is that online play
therefore trusts the client about unlocks; acceptable for now, recorded as a follow-up.

`BattleMissionTracker` is pure and per-battle (`CR.Game.Battle.Logic`, 11 EditMode tests), so mission
progress has no persistence, no migrations and no online/offline routing — it dies with the fight.
Only the templates are content: `battle_mission_template` (M10004, seeding `mission_pyromaniac`) plus
the Mega Burn ability (M10003), served by `GET /api/v1/battle-missions` and read through the shared
`SyncRouter`, exactly like every other domain.

New page: [Battle Extensions](?page=unity/24-battle-extensions), written as the pattern for the next
combo meter or style scorer rather than as a mission feature tour.

## 2026-08-05 — fixed: main menu ignored the gamepad; interact moved to X

**The main menu.** Not an input-wiring fault, despite appearances. Measured live: `bindingMask=null`,
`UI/Submit` resolving to `[/Keyboard/enter, /XboxGamepadMacOSWireless/buttonSouth]`, `UI/Navigate`
carrying both sticks and the d-pad, the input module enabled, and focus correctly set on `continue`
at boot. Everything the input layer owns was already right.

**The actual cause was one attribute in `MainMenu.uxml`:** the layout container carried
`focusable="true"`, which put a plain `VisualElement` in the navigation ring alongside the five
buttons:

```
VisualElement:"VisualElement" tabIdx=0   ← focusable, but not a control
Button:"btnQuit" | Button:"btnOptions" | Button:"play-offline" | Button:"play-online" | Button:"continue"
```

Pressing down moved focus onto that wrapper. It has no `:focus` style, no visible content, and
Submit does nothing on it — so the menu highlighted correctly on open, went blank on the first
d-pad press, and worked fine if you pressed A *before* moving. That matches the reported behaviour
exactly.

Fixed to `focusable="false"`, plus a guard in `MainMenuController` that clears `focusable` from any
non-`Button` in the tree, so re-adding it in the UI Builder cannot break controller navigation
again. Verified: `continue → play-online → play-offline`, and the focusable set is now only the five
buttons.

The rest of this entry describes two real but *separate* defects found while chasing the above.
Neither was the reported symptom — recorded because both were reproduced and fixed.

**A hidden screen could hold focus.** Every CR `UIDocument` shares one
`PanelSettings` and therefore one focus controller, and hiding a screen (`display: none`) does not
release the focus it holds. Traced live from the focused element up:

```
Button("") ← VisualElement ← ScrollView("character-select-list")
   ← VisualElement("character-select-root")
   ← UIDocumentRootElement("Character Select-container") ← PanelRootElement("Panel Settings")
```

Focus was inside **Character Select** while the **Main Menu** was the visible screen. The stick
dutifully navigated buttons nobody could see, and Submit fired a hidden screen's handler. Focus was
never null, so a null-check would have called this healthy.

Focus is also set only once, in `Show()`, and UI Toolkit never restores it — proven separately:
blurring gave `before=continue afterBlur=NULL` with nothing putting it back, so a click on the menu
background strands it too.

The obvious fix does not work, and this is worth recording. Catching `NavigationMoveEvent` to
re-anchor fails because the focus controller handles navigation internally, below the event
callbacks, and reclaims focus regardless of `StopPropagation` — measured as focus landing on the
panel's own root element instead of the button. It is the same shape as `Button`'s default action,
which `StopPropagation` also cannot suppress (see the entry below).

So `UiFocusRecovery` reacts to focus *changes* instead, and asks the right question: not "is anything
focused" but "is the focused thing something the player can actually see". It walks the focused
element's ancestors for `display: none`, and re-focuses the visible screen's first button a frame
later. Verified end-to-end: focus stolen by hidden Character Select → next frame →
`RECOVERED -> MainMenu:continue (Button)`.

The policy is pure and tested (`FocusRecoveryPolicy`): never steal focus from a *visible* element,
and never restore from a hidden screen.

**The menu also had no `:focus` style at all** — only `:hover` and `:active` — so even correct focus
was invisible, which reads as a dead menu on a controller. `BattleHUD.uss` has had `:focus` styling
throughout, which is why the battle menu always felt navigable by comparison. Added to
`main-menu.uss`.

**Interact moved to X.** `Player/Interact` was on `<Gamepad>/buttonNorth` (Y on an Xbox pad); it is
now `<Gamepad>/buttonWest` (X). Keyboard stays `E`. Verified live:
`Interact controls=[/Keyboard/e /XboxGamepadMacOSWireless/buttonWest]`.

The NPC badge hardcoded `"E"`, which is wrong the moment a controller is in hand, so it now follows
whichever device the player last touched — `X` on a gamepad, `E` on the keyboard — via the tested
`InteractionGlyphPolicy`.

Note: `buttonWest` is also bound to `Player/Attack`. Nothing in CR reads that action (the `Attack`
hits in the codebase are `BattleHUD.Mode.Attack` and creature stat labels), so it is left alone — but
if Malbers ever consumes it, the two will collide on the same button.

## 2026-08-05 — added: game audio layer over Master Audio

CR had no audio system at all — no music, no ambience, no menu sound, and no mixer. The battle FX
slots (`AbilityConfig.useSfx`/`hitSfx`/`missSfx`, `StatusConditionConfig`, `CreatureReaction.sounds`)
existed but had nothing behind them.

Added `IGameAudio` as the single audio surface, with **Master Audio** (Dark Tonic) behind it. The
vendor's API is entirely static, so calling it directly from the battle presenters would have welded
a third-party package into code that needs to stay constructible in headless tests. `NullGameAudio`
takes over when the package is absent and warns once — a silently-swallowing audio service is
indistinguishable from working audio playing nothing.

Wired two things end-to-end:

- **Per-area music and ambience** via `AreaAudio`, the audio counterpart to `AreaEnvironment`.
  `MusicTransitionResolver` decides keep / change / stop. The rule that matters is *same track keeps
  playing* — two areas are alive at once during a door transition, so without it, crossing between
  two areas that share a theme restarts the track every time.
- **Battle menu sound**, through a new `BattleHUD.OnPressed(button, sound, action)` helper that wires
  the action and its sound together, still using `clicked` for the reason below.

Pure logic lives in `CR.Core.Audio.Logic` (no engine references) and is covered by 16 unit tests.

Imported Master Audio 2022, Endless Cave Ambience and Fantasy Interface Sounds. Master Audio needed
one patch to compile under Unity 6: `PlaySoundResult.cs` shipped `[SerializeField]` on a class
declaration, which is now `error CS0592`. **Re-apply after any reimport.**

Content authoring is now scripted too, via `cr_setup_audio` and `cr_wire_area_audio` (both also on
the **CR → Audio** menu, both idempotent). They create the MasterAudio prefab, the four buses, and
starter Sound Groups — `ui_confirm`, `ui_back`, `amb_cave`, `amb_meadow` — then attach `AreaAudio` to
Meadow and Cave. Scripted rather than clicked because this configuration lives in scenes, and scenes
get regenerated.

`musicKey` is empty on both areas, which means *inherit*: the imported packs are ambience and
interface sound, so there is no music to point at yet.

A second vendor package needed the same Unity 6 patch as Master Audio — Dynamic Village Ambience's
`AmbienceMixer.cs` had `[SerializeField]` on an abstract property. Both patches are listed in
[Game Audio](unity/23-game-audio.md) and must be re-applied after a reimport.

## 2026-08-05 — fixed: gamepad A did not activate the battle menu

The binding was never at fault. `UI/Submit` is bound to `*/{Submit}` in every control-scheme group,
and a gamepad's south button carries the Submit usage — so an earlier fix that blamed the
InputSystem binding mask was treating the wrong layer.

The battle menu's buttons were wired like this:

```csharp
_attackBtn?.RegisterCallback<ClickEvent>(_ => EnterAttack());
```

A UI Toolkit `Button` handles `NavigationSubmitEvent` by invoking **`clicked`**. It never
synthesises a `ClickEvent`. So a `ClickEvent` handler fires for the mouse and is silently skipped
for gamepad A and keyboard Submit — no error, no warning. That is exactly the reported symptom: the
stick moved focus around the menu, and nothing ever activated.

The tell was already in the same codebase. The bag rows and party slots register **both**
`ClickEvent` and `NavigationSubmitEvent`, and `BattleSummaryScreen`'s OK button uses `clicked +=` —
those always worked. Only `BattleHUD`'s attack / bag / swap / run and back buttons had the gap.

Attack / bag / swap / run and the three back buttons now use `clicked`, which covers mouse,
keyboard and gamepad in one path.

The audit turned up the inverse bug next door. `BattleHUD.Activate(Button, Action)` registered
`clicked` **and** an explicit `NavigationSubmitEvent` handler, so gamepad A on an ability row ran
the action **twice** — `StopPropagation` halts propagation but does not suppress a Button's default
action, which had already invoked `clicked`. The explicit handler is gone.

Rule of thumb: on a `Button`, use `clicked` alone. On a plain `VisualElement` used as a button, set
`focusable = true` and register both events (see `PlayerTeamView.MakeActivatable`).

## 2026-08-04 — fixed: the trainer was not staged behind its creature in battle

The arena wiring was never at fault. The anchors are all assigned and laid out along one axis —
opponent trainer −9, opponent creature −4.5, camera 0, player creature +4.5, player trainer +9 — so
the trainer's mark is correctly behind its creature.

`BattleStager` moved the trainer there by writing the transform directly:

```csharp
_playerTrainerTransform.SetPositionAndRotation(arena.PlayerTrainerPosition.position, ...);
```

Malbers derives movement each frame from the delta between the current position and its own
`LastPosition`. An unannounced jump reads as one enormous frame of travel, and its grounding and
platform correction immediately undoes it. Measured live, sampling the trainer's position every
100ms through a battle:

```
06:31:23.198  trainer=(9.00, 0.00, -100.00)   ← teleport applied
06:31:23.299  trainer=(1.33, 0.00,   -1.27)   ← dragged back ~100ms later
```

Malbers ships `Teleport`/`TeleportRot` for exactly this: they re-seat `LastPosition`, reset any
platform the animal was standing on, and raise a `JustTeleported` flag that suppresses the
corrections for a moment.

The fix routes staging through the movement abstraction rather than poking the transform:

- **`IMovementController.Teleport(position, rotation)`** — new, and documented as the required path
  for any repositioning (battle staging, spawn placement, fast travel).
- **`MalbersMovementController`** implements it via `animal.Rotation` + `animal.Teleport`, then
  syncs the Rigidbody pose and zeroes velocity. That last part matters because the trainer's body is
  interpolated (from the head-jitter fix), and an interpolated body renders from its *previous*
  pose — so without the sync a teleport visibly slides in from the old location.
- **`BattleStager`** uses it for both the teleport and the restore-after-battle, keeping a plain
  transform write as fallback when no controller exists yet, and now **warns** if the trainer does
  not land within 0.5m of the anchor. This failed silently before.

Verified by A/B on the same battle: with the legacy path the trainer snaps back within ~100ms; with
the fix it holds at (9, ~0, −100) for the battle and restores to the overworld on exit.

**Rule worth keeping:** never reposition a character driven by a movement system by writing its
transform. The system tracks the previous pose to derive velocity and ground state, and will
correct against the jump.

## 2026-08-03 — fixed: gamepad A did nothing in battle, and the battle team showed only one creature

Two separate reports from the same battle, with two unrelated causes.

### The team went missing because one item row would not deserialize

The swap list and party slots read `BattleBagPanelHandler.Party`. Measured live mid-battle:
`TeamSync` held all 6 creatures while the bag handler's party held 0 — and its item list was
empty too, which is the signature of its `try` block failing.

The failure came from the item catalog read:

```
InvalidCastException → DataException: Error parsing column 16 (CaptureModifier=1 - Int64)
ItemDomainService: Error retrieving base items with offset: 0, limit: 500
```

SQLite assigns a storage class **per value**, not per column, and `capture_modifier` is declared
`NUMERIC` (what FluentMigrator's `AsFloat()` emits). So a modifier authored as `1` is stored as
INTEGER while `1.5` is stored as REAL. Dapper's deserializer for the C# `float` property cannot
unbox an `Int64`, and the whole read throws. Reading the catalog now casts:
`CAST(capture_modifier AS REAL) as CaptureModifier`, which is valid on SQLite and Postgres alike
and fixes every item read path at once.

This surfaced only recently because the bag previously looked up **just the items in the player's
backpack**; switching to a single catalog fetch (a performance fix) meant it now read *every* item,
including the integer-stored ones.

Second, independent defect: the party assignment sat as the **last line of the item try block**, so
an item failure silently emptied the team as collateral damage. The party is now loaded before that
block — it comes from `TeamSync` and needs no I/O — and the catch handles items only.

### Gamepad A selected nothing because the gamepad was masked out of the UI

`Submit` is bound to the `*/{Submit}` usage, and the controller does carry it
(`buttonSouth: PrimaryAction, Submit`). But at runtime the action resolved to exactly one control:

```
assetBindingMask=[Keyboard&Mouse]   assetDevices=Keyboard/Mouse
SUBMIT controls: count=1 -> /Keyboard/enter
```

A `PlayerInput` component inherited from the Malbers demo player prefab activates a single control
scheme, which sets `bindingMask`/`devices` on the **whole shared asset** — every map, including UI.
The gamepad was filtered out of `Submit` everywhere. It looked half-broken rather than fully broken
because `Navigate` also has keyboard bindings, so the menus still appeared to respond.

CR never reads `PlayerInput` — movement goes through `TrainerMovementController` →
`MalbersMovementController` and the UI through `InputSystemUIInputModule`, both reading the actions
directly. `PlayerInputGate` now disables any `PlayerInput` bound to the CR asset and clears the
mask, so keyboard and gamepad drive the game simultaneously. Verified live: `Submit` then resolves
both `/Keyboard/enter` and `/…/buttonSouth`.

**Rule worth keeping:** a `PlayerInput` control scheme masks the entire `InputActionAsset`, not just
the map it cares about. In a single-player game whose UI must accept every device at once, don't let
one ride along on the shared asset.

## 2026-08-03 — fixed: loading into combat could leave the screen white

Reported symptom: entering a battle showed a white screen that faded in and never cleared.

The battle paths were not missing the fade-out — both wild and NPC start already do
`cover → stage → reveal`. The bug was in `ScreenFader` itself:

```csharp
if (_run != null) StopCoroutine(_run);   // old fade's TaskCompletionSource never completes
```

`StopCoroutine` does not run the remainder of a coroutine, so a superseded fade's
`TaskCompletionSource` was **never completed and its awaiter hung forever**. Callers sequence
`await cover; …stage…; await reveal;` — so once a cover fade was superseded, the awaiting battle
setup never resumed and the reveal line was never reached. The overlay stayed opaque white.

Three fixes:

1. **A superseded fade now completes its TCS** (`TrySetResult(false)` = "did not finish") instead
   of stranding the awaiter. This is the actual cause.
2. **The fade advances on `Time.unscaledDeltaTime`.** On scaled time a paused game (`timeScale 0`)
   would leave `deltaTime` at 0, so the loop could never advance and the cover would never lift.
3. **The reveal moved into a `finally`** on both the wild and NPC start paths, so a staging failure
   between cover and reveal can no longer strand the player behind an opaque overlay. Added
   `ScreenFader.ClearImmediate()` as a hard safety valve.

Contributing factor worth knowing: `CloseBattle` fires `CloseWithFadeAsync()` **un-awaited**, so a
new battle starting while the previous close-fade is mid-flight supersedes it — which is precisely
how a fade got superseded in normal play. That is now harmless rather than fatal.

Verified live by exercising the defect directly: starting a 3s cover and immediately superseding it
now completes the first task (previously it would never complete), and the overlay settles to
`alpha=0`. Fader alpha measured at 0 both mid-battle and back in the overworld.

**Test gap, stated plainly:** this is coroutine/`TaskCompletionSource` lifecycle, which EditMode
cannot exercise — the project has no PlayMode test assembly (both existing test asmdefs are
pure-logic EditMode). Standing one up is a larger change than the fix; this is currently covered by
live verification only, and a PlayMode regression test is the right follow-up.

## 2026-08-03 (later) — acting on the measurements

Follow-ups driven by the world-init numbers rather than by guesswork.

### Merchants no longer re-roll their entire stock on every world load

`NpcMerchantBehaviour` calls `StockFromSpawnerAsync` on every world load, and the restock guard
only applied when the spawner defined a cooldown. The seeded `starting-merchant-items` spawner has
`restock_cooldown_seconds = 0`, so the guard never fired and every merchant **cleared and re-rolled
its whole inventory on every load** — a serial write loop per merchant, linear in merchant count.
It was also a gameplay exploit: reloading rerolled the shop's contents.

A cooldown of 0 now means *"do not auto-restock"*, not *"restock every time"*. First-time stocking
still happens (empty merchant), an elapsed cooldown still restocks, and `force: true` still
restocks unconditionally. 5 new tests cover each branch.

Measured on the live save: merchant world-init **~40ms → ~19ms**, world init total **~290ms →
~275ms**, and the merchant's stock is now byte-identical across loads (previously re-rolled).

### Bag panel no longer does a query per item mid-battle

`BattleBagPanelHandler` fetched an item definition per distinct backpack item every time the bag
opened — during a battle turn, in front of the player. It now reads the item catalog once and
indexes it (item definitions are bounded content data). The fetch is capped at 500 rows and
**logs a warning if the cap is hit** rather than silently rendering items without definitions.

### Item ownership check de-duplicated

`ItemUseDomainService` had the same inventory-walk copy-pasted for item use and held-item equip.
Both now call one `FindOwnedEntryAsync`. This is a clarity fix, not a speed one — the walk already
stopped at the first match, so its cost is bounded by inventory count.

### Not changed: `TrainerWorldBehaviour` (~40% of world init)

Investigated because the measurement singled it out. Its cost is `LoadVisualAssetsAsync` — the
Addressables load of the rigged character model. That is legitimately expensive I/O, not a code
defect, and it must finish before the player can be shown. Left alone.

Backend 29/29 projects, Unity EditMode 103/103.

## 2026-08-03 — world-init measured: don't parallelize it

The serial `GameInitializer` loop was the last open item from the performance sweep. It is now
**measured rather than assumed**, and the answer is to leave the loop alone.

`GameInitializer` retains per-initializable timings from the last world load
(`LastRunTimings` / `LastRunTotalMs`), read back by the new `cr_worldinit_report` pipeline command.
The instrumentation exists because the loop's own Debug lines scroll out of the 100-line console
buffer long before a load finishes — which is exactly why this question went unanswered for so long.

Three runs, 8 initializables, steady state ≈ **290ms** total (first run 336ms, cold):

| ms | share | initializable |
|----|-------|---------------|
| 106–140 | ~40% | `TrainerWorldBehaviour` |
| 48–59 | ~17% | `QuestWorldBehaviour` |
| 39–43 | ~15% | `NpcWorldBehaviour` (Merchant) |
| 38–48 | ~14% | `SpawnerDefinitionSyncBehaviour` |
| 19–20 | ~7% | `TeamSync` |
| 13 | ~5% | `InventorySync` |
| 4–6 | ~1% | `NpcWorldBehaviour` (Quest Giver) |
| 3–4 | ~1% | `SpawnerWorldBehaviour` |

**Verdict: not worth the redesign.** Perfect parallelism caps out at ~170ms saved, and respecting
the real dependencies (trainer before team/inventory sync, spawner definitions before spawner
state) the realistic floor is ~165ms — about **125ms saved on a one-time load that already sits
behind a fade**. That does not justify adding a dependency-declaration contract to every
initializable plus the race risk that comes with it.

Two findings worth more than the parallelism would have been:

- **`TrainerWorldBehaviour` alone is ~40% of world init.** If load time ever needs to come down,
  optimizing or deferring that single item beats parallelizing all eight.
- **Per-NPC cost scales with content, and that is the real risk.** The merchant NPC costs ~40ms
  against the quest giver's ~4ms; the difference is `StockFromSpawnerAsync` restocking on every
  world load. With two NPCs that is invisible, but it is linear — twenty merchants would add
  roughly 800ms to every load. This is the same "grows with content" shape as the bugs already
  fixed this week, and is the thing to watch as the world fills out.

## 2026-08-02 (round 2 — larger blast radius)

Second pass over the performance backlog, taking the items that needed interface changes or
touched shared code rather than a single call site.

- **Sync-over-async removed from the startup path.** `GameAccountRepository.TryGet(identifier, out
  Account)` blocked on `GetAsync(...).Result` — an HTTP round-trip resolved by blocking Unity's
  main thread, which both stalls the frame and risks deadlocking (the awaited continuation wants
  the thread the caller is holding). It implemented no interface (`IGameRepository` declares the
  async `TryGetAsync`) and had **zero callers**, so it's deleted rather than rewritten. A comment
  marks the spot so a blocking wrapper doesn't come back. The other `.Result` hits in the client
  were checked and are safe — they read handles already known to be complete.
- **Creature batch fetch replaces an N+1 on the party/box path.** `CreatureInventoryService`
  looped `GetCreature` once per slot; this backs team and storage rendering *and* runs twice per
  battle round via `GetTeamAsync`. New `IGeneratedCreatureRepository.GetCreaturesByIdsAsync`
  resolves the whole page in one query (Dapper `IN`, lowercased ids on SQLite to match the stored
  GUID casing), and the service re-orders results to slot order since a batch query guarantees
  none. 6 new SQLite data tests cover soft-deleted exclusion, the current-HP join, mixed-case
  GUID matching, unknown ids and empty/null input.
- **Quest requirement evaluation reads each fact once.** `ConditionEvaluator` re-read the same
  data per requirement — every `HasItem` walked every inventory again, every `QuestCompleted`
  re-read the whole completed list, and stats were re-fetched per requirement. It now uses a
  per-pass read-through memo (item totals summed across inventories once, completed list once,
  each stat key once). Caching is scoped to a single evaluation — requirements are checked against
  a snapshot with no interleaved writes, so this is behaviour-preserving, and a test asserts the
  cache does **not** leak between evaluations. 6 new tests.

Backend 29/29 projects green throughout.

**Deliberately not changed: `GameInitializer` serial world-init.** Every `IWorldInitializable` is
awaited in sequence on world load, and `NpcWorldBehaviour` nests a serial sub-behaviour loop
inside it. Parallelizing looks tempting but is unsafe as written: `IWorldInitializable` declares
no ordering, registration order is just `Awake` order, and there are real implicit dependencies
(trainer load before team/inventory sync, spawner definitions before spawner world state).
Doing this properly needs an explicit phase/priority contract so each initializable declares what
it depends on, and then parallelism *within* a phase — a design change, not a tuning change. It
should also be measured first: the loop already stopwatch-logs each item, so a single instrumented
world load will show whether this is worth the redesign.

## 2026-08-02 (later)

### Performance sweep: unbounded tables and repeated work on hot paths

Follow-up to the merchant freeze — an audit of what actually accumulates in a save, plus a
codebase sweep for serial-await/N+1/per-frame offenders. Fixed:

- **Battle action log was read in full, twice per round.** `GetBattleStateAsync` eagerly loaded
  the entire `battle_action_log` on every call (once before the player's turn, once before the
  AI's) — and **no caller anywhere read the field**. Turn latency grew with battle length for a
  payload nobody consumed. The eager load is gone, and `GetActionLogAsync` is now bounded
  (`maxEntries`, default 200, newest-first then re-ordered chronologically) so it can't become
  unbounded again.
- **Stale battles / leaked wild creatures.** Force-quitting mid-battle left the row `Active`
  forever and stranded its uncaptured wild creature as a live DB row (12 stale battles / 10
  leaked wilds in the dev save). `StartBattleAsync` now sweeps the trainer's stale Active
  battles, marking them `Abandoned` and releasing their wilds. Verified live: an injected stale
  battle came back `Abandoned` with its wild soft-deleted.
- **`spawner_spawn_history` grew forever** — one row per wild encounter since the save was
  created, never pruned. Writes now prune past a 30-day retention window, **throttled** to at
  most one sweep per 10 minutes (the delete is a table scan, so it must not run per spawn).
- **Merchant shop N+1.** Opening the shop cost 3 serial round-trips per stock row, two of them
  redundant: `CalculateBuyPriceAsync` re-reads the NPC *and* re-reads the same item the UI had
  just fetched. The screen now reads the buy multiplier once and does the arithmetic locally
  (3N → N+1).
- **Per-frame `GetComponent` in the battle camera.** `BattleCinematicDirector.Update` resolved
  the establishing camera and its `CinemachineOrbitalFollow` every frame, for the whole duration
  of every battle, for a reference that never changes mid-battle. Now cached, invalidated on
  EnterBattle/ExitBattle.

Save-data cleanup applied to the dev save (backed up first): 12 stale battles closed, 67 wild
creatures released, 52 orphaned `generated_creature_current_stats` rows deleted, spawn history
older than 30 days pruned, action logs for finished battles dropped, `VACUUM`.

New tests: stale-battle sweep (Game.Domain.Services) and three spawn-history pruning tests
(Spawner.Data.Sqlite, including one asserting the throttle so the prune can't regress into a
per-spawn scan). Backend 29/29 projects green.

**Known remaining (documented, not yet fixed)** — ranked, from the same sweep:
`GameInitializer` initializes every `IWorldInitializable` strictly serially on world load (and
`NpcWorldBehaviour` nests a serial sub-behaviour loop inside it); quest-requirement evaluation on
NPC interact is a three-deep serial nest (`QuestDomainService` → `ConditionEvaluator` →
per-inventory item reads); `CreatureInventoryService.GetCreaturesAsync` is an N+1 per creature on
every party/box display; `GameAccountRepository:71` blocks on `.Result` over an HTTP call on the
startup path. These are ordering-sensitive or wider-blast-radius changes and want their own pass.

## 2026-08-02

### Fixed: 10-second freeze when talking to the merchant (quest instance stacking)

The freeze wasn't the shop at all. The stat-event log showed `quest_claim` firing **38 times over
~9 seconds** the moment the merchant NPC was talked to: the non-repeatable "Welcome To CR" quest
had **38 stacked instances** — auto-granted once per boot, because `QuestGranterBehaviour`'s
`grantOnce` only dedupes per session (in-memory) and the backend `AcceptQuestAsync` never checked
for an existing instance. One NPC talk satisfied all 38 at once and the serial claim pipeline
(rewards + stats + achievement eval per claim) stalled the main thread for ~10s.

Fixes:
- `QuestDomainService.AcceptQuestAsync` is now idempotent: a **non-repeatable** template with any
  existing instance (any status) returns that instance instead of creating another; a
  **repeatable** template only re-accepts when no instance is currently in progress. 3 new unit
  tests; Quests 19/19 + Game 386/386 green.
- Player save dedupe: 57 duplicate/orphaned quest instances soft-deleted (kept the oldest per
  template — including 13 orphans of a template that no longer exists in the content DB).
  Verified across three live boots: instance count stable, new templates still accept.
- Known cosmetic residue: the `quests_completed` lifetime stat was inflated to ~45 by the
  duplicate claims.

### Over-the-shoulder camera framing + character micro-stutter fix

- **Character micro-stutter (the "head vibration")** — root-caused by measurement, not guesswork:
  a probe sampling the head bone's per-frame angular delta showed stepped bursts (max 8× the
  mean). `MAnimal.Awake` force-sets the Animator to **Fixed** update (50Hz physics ticks) with
  `Rigidbody.interpolation = None`, so at 60+ fps the pose freezes then double-steps every few
  frames — a ~10Hz aliasing shimmer, most visible on the head. `MalbersMovementController` now
  sets `Animator.updateMode = Normal` + `Rigidbody.interpolation = Interpolate` after MAnimal's
  Awake (Malbers fully supports Normal mode). Measured: maxDelta 1.10° → 0.40° at identical mean
  — stepping eliminated. (The Malbers demo `Aim` component stays disabled too — head IK from a
  FixedUpdate camera raycast, no CR gameplay uses it. Disabling it alone did NOT fix the
  stutter; the update-mode aliasing was the cause.)
- **Framing**: shoulder offset (0.6, 0.5, 0), camera distance 3.8 (tunable via
  `cr_setup_overworld_camera --distance/--shoulderX/--shoulderY`), and the camera now starts
  each overworld entry at a level ~8° pitch. Previously it inherited whatever pitch the boot or
  battle flow left behind — battle exit re-syncs the rig's pitch from the battle camera (which
  was staring down at the arena), so `OverworldCameraGate` re-frames on `BattleClosed`, one beat
  after the camera cut, still under the reveal fade.
- New probes: `cr_jitter_measure`/`cr_jitter_report` (head-bone angular-delta sampler),
  `cr_toggle_component` (runtime A/B), `cr_trainer_components` (component tree dump), and the
  pipeline `eval` command turned out to be the fastest way to inspect/mutate live state.
  Discovered during testing: walking off the world edge puts the trainer in free-fall (a
  respawn eventually catches it) — invalidated one whole measurement round.

### Look settings, spawn-in gating, and controller support on the startup menu

Batch of overworld input/camera polish:
- **System ▸ Controls settings**: Look Sensitivity slider (0.1–2.0×, persisted as
  `look_sensitivity`) plus Invert Look Y / Invert Look X toggles. `CameraLookSettings` on the
  camera rig applies stored values at startup and live on change; the default is now **0.5×**
  (the Malbers authored 1.0 was too twitchy).
- **Nothing moves until you spawn in**: `PlayerInputGate` is now UIContext-aware — the Player
  action map only enables in the Overworld (was: enabled from scene load, so WASD moved the
  character behind the main menu). `TrainerMovementController` no longer force-enables the map.
  New `OverworldCameraGate` (replaces the orphaned `CameraInputGate`, deleted) allows camera
  rotation only when movement is ready AND context is Overworld.
- **Player hidden on the menu**: new `TrainerVisibilityGate` disables the trainer's renderers
  outside the overworld/battle so the character no longer stands in the world behind the main
  menu. Known cosmetic nit: a Malbers "Dust Track" ground decal can still appear at the feet
  position pre-spawn.
- **Controller works on the startup menus**: MainMenu and CharacterSelect now set an initial
  focused button when shown — gamepad/keyboard navigation needs a focus root to start from,
  and without one the controller did nothing.
- `cr_setup_overworld_camera` now also installs the gate + settings components and clears
  missing-script remnants. Verified headlessly: menu = frozen camera + immobile hidden trainer;
  overworld = visible trainer, live camera (yaw 90→290 on look), movement follows camera;
  sensitivity 0.5 applied on the rig. Note: `NavigateTabsLeft/Right` actions exist in
  `CR_GameInput` but are not yet wired to the player menu's TabView (pre-existing gap).

### Fixed: overworld movement directions + added a real third-person camera

Two long-standing issues in the Malbers movement shim:
1. **Directions were world-space, not camera-relative.** `MalbersMovementController` called
   `MAnimal.Move()` — Malbers' AI/direction entry point, which treats the stick vector as a
   world-space direction ("up" always walked toward world +Z). Player input now goes through
   `SetInputAxis()` with `UseCameraInput = true`, Malbers' camera-relative path.
2. **There was no overworld camera controller at all.** The scene had a `CinemachineBrain` and a
   `CameraInputGate`, but the `ThirdPersonFollowTarget` rig the gate requires was never added, and
   nothing fed look input. New editor command `cr_setup_overworld_camera` instantiates the Malbers
   "CM Third Person Main (New Input)" prefab, targets the scene trainer, retargets Look/Zoom to
   `CR_GameInput` (`Player/Look`, `Player/Zoom`), and sweeps duplicate rigs (idempotent).

Also: `SetSpeed` no longer maps to `MAnimal.TimeMultiplier` (that's a global time scale — it made
everything slow-motion, not faster movement). Verified headlessly with new probes
(`cr_move_probe`, `cr_cam_look_direct`, `cr_ui_gamepad_stick`, key hold/release phases on
`cr_ui_press_key`): camera yaw rotates via the look path, and walking forward with the camera
rotated 112° moves the trainer exactly along the new camera heading. Physical mouse feel check
remains the human gate (synthetic mouse deltas can't cross the editor/play input buffer split).

### Battle log moved to the upper-left

The in-battle notification panel (`.battle-log` in BattleHUD) no longer floats front-and-center
over the action: `.hud-middle` now aligns flex-start with left padding, the log caps at 40%
width, and its text is left-aligned. New probe: `cr_ui_screenshot` captures the real backbuffer
(UI Toolkit overlays included) to `Temp/ui_shot.png` — pipeline `screenshot`/`capture_game_view`
render cameras only and miss UITK.

### Fixed: overworld menu hotkeys were completely dead (I / Escape / Start did nothing)

Three stacked causes, found by probing the live input chain headlessly:
1. The scene's `PlayerMenuWindow.inputActionsAsset` pointed at **Malbers Inputs** — an asset that
   has a `UI` action map (so init "succeeded") but no `ToggleMenu` action, leaving the handler
   silently unsubscribed.
2. The code fallback loaded `InputSystem_Actions` — a **legacy near-duplicate** of the live
   `CR_GameInput` asset that the input gate, movement, and NPC interaction actually use.
3. The earlier "Escape toggles the menu" rebind had been authored into that stale duplicate, so
   the live asset still carried the old `CloseMenu ← Escape` binding.

Fixes: the scene reference now points at `CR_GameInput` (saved via the editor pipeline);
`PlayerMenuWindow.ResolveInputActions()` binds from the first asset that actually contains
`UI/ToggleMenu` (serialized → CR_GameInput → InputSystem_Actions) and logs an error on a bad scene
reference instead of failing silently; Escape moved to `ToggleMenu` in `CR_GameInput` (`CloseMenu`
now unbound); freshly bound actions are disabled outside `UIContext.Overworld` so the hotkey is not
live on the main menu. New headless probes: `cr_ui_input_dump` (context/asset/action/map/device
state) and `cr_ui_press_key` (synthesizes real keyboard input). Verified live: I opens, Escape
closes in the overworld; nothing fires on the main menu. EditMode 103/103 green.

## 2026-07-31

### Fixed: wild-battle loot never actually dropped (and combat XP under-counted)

Live verification of the loot display exposed a backend ordering bug: on a wild win,
battle-end cleanup soft-deletes the uncaptured wild creature **before** the loot roll, and the
roll's `GetCreature` (filtered `deleted = false`) came back null — loot silently skipped on every
real wild victory (`[Battle] Skipping loot roll — could not resolve creature content_key`). The
combat-XP path had the same latent read: `defeated?.Level ?? 1` degraded every battle-ending KO
to level 1. `BattleDomainService` now loads the defeated creature once before the battle-end
branches and passes it to both `AwardBattleExperienceAsync` and `RollAndGrantBattleLootAsync`.
Unit tests missed this because mocks returned the creature regardless of deletion; a new
regression test uses a stateful mock (GetCreature → null after DeleteCreature). Verified live
headlessly: `LOOT [Currency] qty=11` and the VICTORY screen's **ITEMS RECEIVED — Currency +11**.
The smoke harness also gained a 4s summary hold + `ScreenCapture` backbuffer screenshot
(`Temp/smoke_summary.png`) because pipeline screenshot commands render cameras only and miss
UI Toolkit overlays, and its turn budget rose to 15 so wins are reachable.

### Battle loot is now visible: ITEMS RECEIVED shows currency + item drops

The backend already rolled and granted loot on wild-battle wins (currency and items — cindris
drops 10–30 currency, the starter zone adds a 40% heal-potion / 70% currency roll); the summary
screen just never showed it. Now the sequencer raises a new `BattleEvents.LootAwarded` per grant
from the battle-ending outcome's `LootAwards` (aftermath beat), and `BattleSummaryScreen` renders
them: a summed **Currency +N** row first, then items alphabetically with ×quantity, content keys
humanized ("item_heal_potion_30" → "Heal Potion 30"). Aggregation/formatting is pure
`LootSummaryFormat` (`CR.Game.Battle.Logic`) with 13 new test cases. The smoke harness now logs
`LOOT [...]` lines and fights to a win (15-turn budget) so drops are verifiable headlessly.
Note: loot events ride `BattleEvents` directly (like the creature presenters) rather than a new
SO event channel — the channel manifest/codegen step is Editor-authored and can be added later.

## 2026-07-30 (later still)

### Player-configurable Combat Speed + wider battle framing

Combat pacing is now a player setting: pause menu **System ▸ Combat Speed** (Fast 0.75× /
Normal 1× / Relaxed 1.4×) persists `battle_pacing_scale`, which `BattlePresentationSequencer`
applies to every beat duration at battle start (clamped 0.5–2.5; the System card's first
functional setting). Verified live via the smoke harness: turn-to-turn gap stretched 2.3s → 3.1s
at Relaxed. Automation hook: `cr_set_combat_speed --scale <x>`. The battle camera also pulls
back: `BattleCameraProfile.fovWidenMultiplier` (default 1.15) widens all rig vcams on battle
enter and restores the authored lenses on exit.

## 2026-07-30 (later)

### Battle FX verified end-to-end for both sides — by a self-driving smoke test

New pipeline-CLI harness (`cr_battle_fx_smoke_start`/`_status` + `cr_world_dump`,
`BattleFxSmokeRunner`) plays the game like a human: clicks through the startup menu (Continue →
character select), starts a real wild encounter through the spawner's own path, auto-plays two
ability turns, flees/acknowledges the summary, and reports per-side FX verdicts. Final run:
**player Scratch impact spawns at the opponent; wild Fire Blast plays the full staged chain**
(cast SFX+VFX at caster → travel VFX across the arena → impact SFX+VFX at the target on arrival),
zero load warnings. En route it exposed and fixed three real bugs: `BattleCoordinator` raised
`PlayerTurnStarted` before creating the action-wait source (programmatic submits hung the turn);
battle-path `TaskCompletionSource`s lacked `RunContinuationsAsynchronously` (coroutine completions
resumed the round loop inline); and **persistent HP had the whole roster at 0** from prior
playtests, making every battle an instant Loss (save healed; keep a heal flow in mind for real
players). Also surfaced: in online mode content sync mirrors the server, so ability FX must be
**published** to appear online — offline seeds alone aren't enough (Fire Blast got placeholder
fire FX published + seeded). Follow-up to investigate: the player creature dropped out of the
visual registry on turn 2 (`caster=NOT IN REGISTRY`) — FX fell back to captured position, worth a
look alongside faint/recall handling.

## 2026-07-30

### Content loop is now fully headless (Unity Pipeline CLI)

`com.unity.pipeline` (0.4.0-exp.1) + Unity CLI beta.3 drive the open Editor from the shell:
compile (`recompile`), tests (`run_tests` — 91/91 EditMode green headlessly), console reads, and
now CR's own tooling via `[CliCommand]`s in `CrPipelineCommands`: `cr_fx_seed_status`,
`cr_export_fx_seeds`, `cr_rebake_floor`. The rebake exposed two real bugs, both fixed: the temp
output directory was never created (SQLite "unable to open database file" — also latent in the
menu variant), and spawning `dotnet` from the Editor inherits Unity's `DYLD_*`/`DOTNET_*`/
`MSBuild*` environment, which must be stripped. Verified end-to-end: status → export → rebake →
floor at schema 9997 with authored FX intact.

## 2026-07-21

### Enemy FX weren't playing: stale floor seed (+ Publish now warns about it)

Authored Scratch FX (`fx/clawslash-circus`) existed on the AbilityConfig but never reached the
offline floor — the seed migration hadn't been re-exported after the authoring session, so enemy
Scratch raised cues with empty keys. Regenerated `M9997SyncAuthoredAbilityFx` from the current
assets (Ember, Hydro Pump, **Scratch** now carry FX) and rebaked the floor. To stop this drift
from recurring silently, **Publish now includes an "Offline floor seed" step**: it compares the
generator's output against the exported migration and warns (non-blocking) when an export +
rebake is needed.

### FX picker: Piloto Studio pack + adopt-on-use into the content folder

The Piloto Studio pack (19 prefabs incl. the Claw Slashes set) was invisible to the Workbench FX
picker — scan roots are a hardcoded list and didn't include `Assets/Piloto Studio`. Added. Beyond
that, effects are now **adopted on use**: picking (or drag-and-dropping — Publish catches those)
an asset from any pack copies it into `Assets/CR/Content/Effects` (audio under `Effects/Audio`),
stamps the copy with its source GUID for idempotent reuse, claims byte-identical pre-existing
hand-copies instead of duplicating, and assigns + registers the addressable against the CR-owned
copy. Content no longer references third-party folders directly. Rules live in pure
`FxAdoptionRule` with 10 new EditMode tests.

## 2026-07-19

### In-Editor floor rebake + FX seed migration export

Two new menu items close the content-authoring loop without a terminal.
**CR → Content → Export Ability FX Seed Migration** snapshots every AbilityConfig's presentation
values (animation/camera/FX keys — auto-derived from AssetReferences when blank — plus FX
lifecycle) into cr-api's `M9997SyncAuthoredAbilityFx`, regenerated in place with stable ordering
by the pure, unit-tested `AbilityFxSeedMigrationGenerator` (7 new tests). The export is
authoritative and the dialog offers a chained floor rebake.
**CR → Content → Rebake Offline Floor** runs the cr-api Migrations.Tool in the background
(cancelable progress bar, no main-thread stalls), copies the fresh `game-data.bytes` into
StreamingAssets, and reports the schema version; **Full Package Rebuild** shells the whole
`build-packages.sh` for when cr-api C# changed. The initial `M9997` (all 16 abilities) ships with
this change — floor is at schema **9997** — and it compiles warning-free and passes the full
migration test suite on both engines.

### Ability FX stages now sequence and auto-stop

Previously all three ability effects (cast, projectile, impact) spawned **simultaneously** and were
hard-destroyed after a flat 4 seconds — impact appeared while the projectile was still flying, and
looping effects lingered. The responder now plays stages in order (impact waits for projectile
arrival, impact SFX at the moment of arrival) and, per new ability-level config, **stops each stage
shortly after the next one starts**: `fx_auto_stop` + `fx_stop_delay_ms` columns (M9996, defaults
on/50ms) flow ability → battle outcome → `AbilityFxCue`; stopping cuts particle emission so live
particles fade instead of popping, with the 4s lifetime kept as a safety net. Authored in the
AbilityConfig **Advanced ▸ FX lifecycle** section and carried through publish (workbench + runtime
sync clients) and the offline cache sync. Stage sequencing rules extracted into pure
`AbilityFxStagePlan` (`CR.Game.Battle.Logic`) with 6 new EditMode tests. Along the way the runtime
ability sync DTO was found to be dropping **all** FX keys on publish (would have nulled server FX
columns) — fixed.

### Pre-existing Postgres test breakage fixed (suite fully green)

Four Postgres test projects had been failing for unrelated, pre-existing reasons; all fixed and
`run-all-tests.sh` is green across all 29 projects. Root causes: test SQL still inserting the
`asset_id` column dropped by M1021 (2 Spawner projects); a real product bug — unguarded
`LOWER(id)` in `BaseGrowthProfileRepository.Get` crashing on Postgres `uuid` (engine-branched like
its siblings); `GeneratedCreatureRepositoryTests` inserting `Guid.Empty` progression-set FKs
(SQLite doesn't enforce FKs, Postgres does); and `BaseItemRepository.BuildParams` missing
`captureModifier` — Postgres parsed the unbound `@captureModifier` as an operator + bogus column
(the item upsert was also missing the value entirely, which would have crashed item content sync).
Also fixed a ~5%-flaky capture test (`Times.Never` verify was counting invocations from earlier
roll attempts).

## 2026-07-18

### Battle FX now reach the database (dedup + seeded FX keys)

Ability sounds/visuals never played because the FX-key columns on `abilities` were `NULL`
everywhere the battle actually reads: the `M9994` demo seed wrote explicit `NULL`s, the `M9990`
authored seed carried no FX columns at all, and creatures' progression entries pointed at
duplicate demo rows (a second Ember/Scratch under different ids). New migration
`M9995DedupAbilitiesAndSeedAbilityFx`: canonical ability id = the Unity `AbilityConfig` asset id;
all references (`ability_progression_set_entry`, `ability_status_conditions`,
`generated_creature` slots) remapped onto canonical rows; duplicates soft-deleted; Ember's
`fire_ember` animation key carried over; the bogus `creatures/crabby` hit-VFX on Scratch cleared;
and the authored FX keys (Ember + Hydro Pump, the Ability Workbench starter set) seeded so the
baked floor carries them. Floor rebaked to schema **9995** (clients re-adopt automatically).
Covered by a new `AbilityDedupAndFxSeedTests` fixture running the full migration chain
(`CR.Data.Migrations.Test`, SQLite + Postgres, 33 green). Docs: canonical-id section on
[Battle Persistence](?page=backend/09-battle-persistence); the Ability Workbench
"Remember the floor" section now states the real rule — published FX keys must be copied into a
seed migration to survive a rebake. Remaining 14 abilities still need FX authored in the
Workbench.

## 2026-07-08

### Standalone build readiness (macOS + Windows)

Desktop builds unblocked. `build-packages.sh` now always bundles **both** SQLite natives
(`libe_sqlite3.dylib` osx-arm64 + `e_sqlite3.dll` win-x64) into the Unity package — previously it
shipped only the primary architecture, which would have crashed a Windows build on first DB open.
New **CR → Build → Create Standalone Build Profiles** menu (`BuildProfileSetupTool.cs`) creates
`CR_Game_macOS` / `CR_Game_Windows` profiles via the internal Unity 6 factory (reflection);
Addressables switched to build content with the player. New [Standalone Builds](?page=unity/21-standalone-builds)
page covers profiles, natives, the offline data floor, and known limits (Mono-only Windows
cross-build, arm64-only mac native). Follow-up: the package no longer ships `Newtonsoft.Json.dll` —
the vanilla copy shadowed Unity's AOT-patched `com.unity.nuget.newtonsoft-json` on build-target
switch, breaking `com.unity.services.core` editor compilation (`AotHelper` CS0103); CR DLLs bind
to Unity's copy. Also added a Linux x64 profile (`CR_Game_Linux_SteamDeck`) and `libe_sqlite3.so`
to the bundled natives for Steam Deck.

### Addressables now bake into builds (shipped builds had none)

The profile's `Local.BuildPath`/`Local.LoadPath` had been repurposed for the MinIO dev workflow
(build to `ServerData/`, load from `http://localhost:9000/…StandaloneOSX`), so distributed builds
contained zero addressable content and streamed everything from the tester's own localhost.
Restored true local paths (all groups bake into the player), pointed `Default Local Group` at
them too, and fixed `Remote.LoadPath` to use `[BuildTarget]`. Live-update path (baked floor +
streamed deltas via remote catalog + content-update builds) documented on the
[Standalone Builds](?page=unity/21-standalone-builds) page.

### Captured creatures join the team when there's room

Capture placement was hard-wired to storage — a comment claimed `AddToStorageAsync` handled
team-if-space internally, but it never touched the team. New
`ICreatureInventoryService.AddToTeamOrStorageAsync` places the catch on the team when a slot is
free (next free slot, capacity 6) and falls back to storage; `InventoryAddResult.AddedToTeam`
reports the destination. Both capture paths (online `CaptureCreatureHandler`, offline
`OfflineItemUseService`) now use it, so behavior is identical either way. Covered by 3 new
placement tests + updated handler tests (385 green in `CR.Game.Domain.Services.Test`).

### Battle FX pipeline debug logging

`BattleAbilityFxResponder` logs the resolved cue (keys + registry hits) and every spawn/load
result; `BattleEventDebugLogger` subscribes to `AbilityFx`; `BattleStager` logs the registry id
each visual registers under. One battle run in the console now pinpoints which link of the
ability-FX chain (cue → keys → registry → Addressables load) is broken.

## 2026-07-07

### Test infrastructure repaired + suite fully green (979 tests, 29.2% line coverage)

Round 2 added 206 tests — a new Auth test suite (61 tests, 3 projects: SQLite repo, JWT/model, password/claims security) and +145 Game.Domain.Services tests (wild AI, item-use service + 5 untested handlers, creature inspection/progression, battle FX-key propagation, read paths). **Testing exposed 7 production bugs**: 4 in Auth (OAuth SQL vs missing columns, `PasswordHashed` never mapped on read, `GetAccountId()` claim-type mismatch, unenforced email uniqueness — dormant while the game is device-bound, must be repaired before online-account work) and 3 in Game (creature summary computes level from XP instead of stored `Level`; dead replace-ability branch means full-roster creatures learn nothing on level-up; wild-AI heal heuristic documented but absent). All pinned as regression tests.

`run-all-tests.sh` had been running a hardcoded 6 of 25 test projects (one nonexistent) and its `--coverage` flag produced broken MSBuild switches — "all tests green" covered a quarter of the suite. Fixed: auto-discovery of every `*Test*.csproj`, working coverage collection (bash-array quoting), `coverlet.collector` added to the 5 projects that silently emitted no data. Six broken projects repaired (stale damage-formula expectations, missing `SKIP_DOCKER_TESTS` guards, an NUnit setup-ordering NRE, test DDL missing evolution columns, a `CS0104` build ambiguity, xUnit throw-instead-of-skip fixtures, a quest-objective upsert test-data bug). Currency test gaps closed with a new `CR.Trainers.Data.Sqlite.Test` project. Unity: Ability Workbench decision logic extracted into `CR.AbilityWorkbench.Logic` with ~47 tests across 6 fixtures. Full report: `CR/guides/cr-coverage-report.html`.

### Ability Workbench — guided FX authoring for abilities

New editor tooling so a designer ships a fully-effected ability without touching GUIDs, key strings, or the Addressables window (branch `feature/ability-workbench`). Built after research confirmed the battle FX pipeline itself was intact and effects weren't playing purely because ability FX/SFX keys were never authored (17 of 18 abilities had no VFX keys, none had SFX).

- **Reworked `AbilityConfig` inspector**: readiness strip (`Basics ✓ · Effects 2/3 · Sound 0/3 · Not published`), visual Cast/Travel/Impact effect slot cards, auditionable sound rows, status-effect summary rows, and a single **Publish** button; every technical field (keys, raw AssetReferences, individual sync buttons) moved under an **Advanced** foldout. ([Ability Workbench](?page=unity/20-ability-workbench))
- **FX Library picker**: virtualized thumbnail grid over the project's ~400 FX prefabs (ParticleSystem + VFX Graph detection) with element filter chips and heavy-asset warnings; one pick assigns the slot, registers the asset addressable (`fx/<name>` / `sfx/<name>` in `CRContent`, collision-uniquified), and derives the key.
- **Publish pipeline**: validate → register addressables → derive keys → sync ability → sync status effects, reported as a plain-language checklist; Content Studio **Publish All** adds a reachability probe and cancelable progress bar. Readiness logic lives in a pure, unit-tested asmdef (`CR.AbilityWorkbench.Logic`).
- **Edit-mode FX preview**: ▶ Preview plays cast → travel → impact between marker capsules using explicit `ParticleSystem.Simulate`/`VisualEffect.Simulate` ticking, reading the scene sequencer's timing values when present; leak-proof cleanup incl. domain-reload sweep and a **CR → Ability Workbench → Clear FX Preview** safety.
- **FX templates**: `AbilityFxTemplate` SO + "Start from template…" fills all six slots in one click (starter set hand-authored under `Assets/CR/Content/Editor/FxTemplates/`).
- **Visibility**: Content Studio ability rows show readiness chips (`FX 2/3 · SFX 0/3 · Published`); Content Audit gained an **Ability FX** category — assigned-but-not-addressable (with Fix), keys addressing nothing, and keys resolving to non-FX assets (catches the mis-authored `Scratch → creatures/crabby`).

## 2026-06-26

### NPC ensure crash + offline content adoption — durable fix

A fresh offline character could crash at world bootstrap with an NPC `UNIQUE` violation, and re-baked offline content kept vanishing. Four root causes, all fixed durably (branch `feature/account-mode-startup`).

- **NPC ensure is now an atomic, revive-aware upsert (cr-api).** `NpcDomainService.EnsureNpcAsync` no longer does check-then-insert; `BaseNpcRepository.EnsureNpcAsync` runs one dual-engine `INSERT … ON CONFLICT(account_id, trainer_id, content_key) DO UPDATE SET deleted = 0/false, npc_type = <no-downgrade: keep existing when the incoming type is the default Npc> RETURNING id`. Because the `npcs` UNIQUE index `uix_npc_account_trainer_content_key` is **non-partial**, soft-deleted rows still occupy the slot — so a plain insert collided; the upsert revives them in place and is race-safe against concurrent ensures. Team inventory is created only when the returned row is genuinely new (`CreatureTeamInventoryId == null`). New `CR.Npcs.Data.Sqlite.Test` covers idempotency, soft-delete revive, and no-downgrade. ([NPC System](?page=backend/02-npc-system))
- **Per-trainer NPC tables → player-data (Unity).** `INpcRepository` / `INpcCreatureTeamRepository` were wrongly bound to `LocalDataSources.GameData.OfflineSource` (read-only, adoption-overwritten content DB); now bound to `PlayerData.OfflineSource` in `LocalDevGameInstaller`, co-located with `npc_inventory` (FK integrity + merchant purchase on one physical DB). `npcs` rows are per-`(account, trainer)` runtime save-data created by `EnsureNpcAsync`, not designer content — binding them to the adopted `game-data.bytes` let adoption wipe runtime NPCs. ([Project Setup](?page=unity/01-project-setup) · [Content Pipeline](?page=unity/17-content-pipeline))
- **Single `GameInitializer` (Unity).** It is placed in the boot scene **and** was bound `FromNewComponentOnNewGameObject().NonLazy()`, creating a second instance → `OnTrainerChanged` subscribed twice → two concurrent `RunAsync` passes (double world bootstrap, which surfaced the NPC `UNIQUE` crash). Binding changed to `FromComponentInHierarchy().AsSingle().NonLazy()` so exactly one (scene) instance runs. ([World Behaviours](?page=unity/03-world-behaviours))
- **Content-hash adoption gate + auto-bake (Unity).** `GameDataAdopter` previously re-adopted only when the bundled schema version (`game-data_schema_version.txt` = `MAX(VersionInfo)`) exceeded the adopted copy — so content-only re-bakes at the same migration head silently never re-adopted (the "offline content keeps vanishing" bug). It now also compares a SHA-256 of the bundled `game-data.bytes` against a `.srchash` marker next to the adopted copy and re-adopts on any byte difference. `build-packages.sh` now auto-copies the freshly baked `game-data.bytes` + version file into `cr-api-unity/Assets/StreamingAssets/CR` (the manual `CR → Bake Game-Data DB` editor menu is now optional). ([Project Setup](?page=unity/01-project-setup) · [Content Pipeline](?page=unity/17-content-pipeline))

### Offline content floor — authored demo content seeded into migrations

Fixes the recurring "no creatures / no wild encounters / no merchant" on a fresh offline character. Root cause: the baked GameData floor (`StreamingAssets/CR/game-data.bytes`, adopted into `persistentDataPath` by `GameDataAdopter`) is produced by `build-packages.sh` from **migration seeds only** — but the demo spawner chain and its creatures had only ever been authored at runtime (they lived in the old shared `crgame.bytes`), so they were absent from every bake and vanished on each adopt/re-bake. The persistentDataPath copy is a disposable cache regenerated from the floor, so it could not be hand-edited "forward" either.

Fix: the authored content is now seeded as migrations, so `build-packages.sh` bakes it every time.
- `Creatures/CR.Creatures.Data.Migration/M9994SeedDemoCreatures.cs` — 3 creatures (Cindris/Crabby/Mudcalf), 1 growth profile, 4 abilities.
- `Spawner/CR.Spawner.Data.Migration/M5018SeedDemoSpawnerContent.cs` — `welcome-npc-reward-spawner`, 2 spawner pools, 2 creature-spawner templates, 2 ability-progression sets + 5 entries.

Both dual-engine (Postgres + SQLite, `isSqlite`-guarded) and idempotent (`INSERT OR IGNORE` / `ON CONFLICT DO NOTHING`). The bumped schema version (9994) makes `GameDataAdopter` re-adopt automatically. (At the time of this entry, content-only floor changes at the same version did **not** auto-readopt and needed a version bump or deleting the adopted copy — **superseded later the same day** by the SHA-256 content-hash adoption gate; see "NPC ensure crash + offline content adoption — durable fix" above.) Verified: a clean `build-packages.sh --clean` bake now yields creature=7, spawner_pool=2, creature_spawner_template=2, ability_progression_set_entry=5, FK-clean, with the `starter-wild-zone → pool → template → Cindris` chain intact.

## 2026-06-25

### Content Studio — editable server address

The target server is no longer buried in `game_config.yaml`. The Content Studio banner has a **Server** field (with a ⟳ apply-&-test button) that overrides `game_server_http_address` per-machine via EditorPrefs (`ContentCreatorSyncHelper.ServerAddressPrefKey`) — no yaml edit or Unity restart, and it shows exactly what every sync/ping targets. Both `ContentCreatorSyncHelper.GetBaseUrl` and `AbilityEditorSyncHelper.GetBaseUrl` honor the override (empty = fall back to the config value, exposed as `ConfigBaseUrl`). Note the AIO's default `dotnet run` binds **http://localhost:5124** (its launch profile), not `:8080` — so either run it with `--urls http://localhost:8080` or point this field at `:5124`.

### Content Studio — connection-poll fixes (lag + stuck "Checking…")

Follow-up to the live-status/server-field work:
- **Lag:** removed `EditorGUIUtility.AddCursorRect` on the status dot — it forced the window to repaint every frame while hovered, and Content Studio's heavy OnGUI made that lag the editor.
- **Stuck on "Checking…":** the background ping task touched Unity APIs off the main thread — first resolving the URL (`EditorPrefs`/`Resources`), then updating the UI from the `ContinueWith` (`Repaint`/`EditorApplication.delayCall`). Off-thread Unity calls fail silently, so the dot never repainted out of "Checking…" and `_pingInFlight` looked wedged. Rewritten so the URL resolves on the main thread, the `Task.Run` body touches **no** Unity APIs (it only writes plain result fields), and the main-thread `OnEditorTick` drains the result to log + repaint. Added an 8s watchdog and made the dot click / ⟳ always re-check (abandon any in-flight ping) so it can never get wedged.

### Content Studio — live connection status

The banner connection dot now polls on a timer instead of only when the window repaints (so it no longer reads stale "Disconnected" while the server is up). `ContentStudioTool` drives `SchedulePingIfNeeded` from `EditorApplication.update` (subscribed in `OnEnable`, removed in `OnDisable`), the poll interval is 30s, and the dot is now a click-to-recheck button (`ForcePing` backdates the last-ping time and re-pings immediately, showing a transient "● Checking…").

## 2026-06-24

### Online mode — inventory sync, config paths, dead menu object

Three follow-on fixes from the online-mode build log:

- **Item-inventory client was a stub.** `InventorySync.RefreshAsync` (online) threw `NotImplementedException` because `TrainerItemInventoryClientUnityHttp.GetItems/GetItemInventories/AddItemToInventory` were unimplemented. Implemented all three against the existing server routes (`GET/POST /trainer/{trainerId}/inventory/item[/{inventoryId}]`), modeled on the working creature client.
- **Inventory base-address 404s.** `trainer_inventory_server_http_address` / `trainer_creature_inventory_server_http_address` carried bogus `/trainer-inventory` / `/trainer-creature-inventory` prefixes, but the server mounts inventory routes at **root** (`/trainer/...`) — so every call 404'd (`ITrainerCreatureInventoryClient … Not Found`). Dropped both to `http://localhost:8080`. (Same class as the `game_server_http_address` vs service-prefixed-address gotcha.) Also fixed `TrainerCreatureInventoryClientUnityHttp.AddCreatureToInventory` to `POST` (server's verb) instead of `PUT`.
- **Config DB paths were machine-specific absolutes.** `game_config.yaml` hardcoded every `database_path_*` to `/Users/efranford/Library/Application Support/DefaultCompany/My project/crgame.bytes` — wrong (default) product dir, single-file (defeating the two-DB split), and unportable. Replaced with relative `database_path_game_data: game-data.bytes` + `database_path_player_data: playerData.bytes` (resolve under the real `persistentDataPath`); dropped the stale per-domain `*_offline`/`*_online_cache` overrides so online-cache DBs fall back to their own per-domain files (now migrated via `MigratableSources`). Removed a dead `StartMenuController` GameObject (deleted-script reference) from the boot scene.

### Online mode boot crash — unmigrated online-cache databases

A standalone build in **online** mode crashed with `no such table: creature` / `no such table: trainer_item_inventory_items`, spamming thousands of `SqliteException`s. Root cause: the online repos are **cache-then-server-fill** (e.g. `CreatureOnlineRepository.GetCreature` reads the local cache; on a miss it fetches from the server and writes the row back into a per-domain **online-cache SQLite**). Those cache DBs (`baseCreatureOnlineCache.bytes`, `trainerItemInventoryOnline.bytes`, …) are neither adopted (game-data only) nor populated from game-data/player-data — and startup migrated **only 4** of them (player-data + trainer/auth/creature caches). The other caches had no schema, so the server-fill `INSERT` threw `no such table`. (Offline mode was unaffected — its content repos read the adopted, populated game-data DB.)

- New `LocalDataSources.MigratableSources` enumerates **every** writable local DB to migrate (player-data + all `OnlineCacheSource`; game-data excluded — it's adopted).
- `LocalDevGameInstaller.KickOffMigrations` now resolves + dedupes that whole set on the main thread and migrates each off-thread behind `DbReadyGate`, instead of a hand-picked four. Add new cached domains' `OnlineCacheSource` to the list.

### Ability VFX-on-hit — auto-derive the synced content key

Move VFX wasn't playing on hit. The runtime chain (`BattleDomainService` → `outcome` → `BattlePresentationSequencer` `Strike` beat → `AbilityFxCue` → `BattleAbilityFxResponder` → `BattleVisualRegistry`) was wired correctly and the responder is bound `NonLazy`; the break was in authoring. `AbilityConfig` carries each effect as a pair — the `AssetReference` a designer assigns, and the **string key** that actually syncs and drives the runtime — and the key was only populated when the designer manually clicked "← from asset". Assign-but-don't-click left the key blank → backend stored `null` → the cue carried `""` → the responder skipped the spawn, silently.

- **`AbilityConfigEditor.DrawAssetWithKeyRow`** now auto-fills a blank key from the asset's Addressables address whenever the asset is set (the inspector comment finally matches the code). Designers can still override.
- **`AbilityEditorSyncHelper.SyncAbility`** self-heals at push time via a new `KeyOrDerived(storedKey, assetRef)` helper (and an `AssetReference` overload of `TryDeriveAddressableKey`), so a bulk/Content-Studio push can't ship a null VFX/SFX key.
- **Prerequisite:** the VFX/SFX prefab must be **Addressable** — derivation reads `FindAssetEntry`. Recovery for existing abilities: ensure the prefab is addressable (Content Studio "Fix All Addressables"), then re-open or re-sync the ability. Disambiguator in the log — `[BattleAbilityFx] load '<key>' failed` means key present but address unbuilt; silence means the key is still empty.

### Migration seed idempotency — content_key collisions

The AIO Postgres migration crashed with `23505 duplicate key … idx_item_spawner_content_key_unique`: content seeds used `ON CONFLICT (id) DO NOTHING`, which only guards the primary key, but content tables have a UNIQUE on `content_key` — and Content Studio pushes content with fresh UUIDs, so the same `content_key` can already exist under a different id.

- **Single-table seeds:** `ON CONFLICT (id) DO NOTHING` → `ON CONFLICT DO NOTHING` (no target) across all cr-api migrations — ignores a conflict on *any* unique constraint, the true equivalent of SQLite `INSERT OR IGNORE`.
- **FK-chain seeds (parent + child rows under hardcoded ids):** `ON CONFLICT` alone isn't enough — skipping just the parent orphans the child FKs. These now gate the whole seed on the parent's `content_key` being absent (`INSERT … SELECT … WHERE NOT EXISTS`), so it's all-or-nothing per parent and a clean no-op once the content exists. Fixed: item-spawner (`M6014`), creature spawner (`M5009`), quests (`M7006`/`M7008`), loot (`M7102`), achievements (`M7303`).
- Runtime `ON CONFLICT … DO UPDATE` upserts (achievement-unlocked did-I-win, pickup-collected, etc.) are a different, correct pattern and were left untouched.

## 2026-06-23

### Startup — database migration moved off the main thread

Boot no longer freezes on the database. SQLite is synchronous under Dapper (`await` doesn't yield), so the every-boot, reflection-heavy FluentMigrator pass was blocking the Unity main thread.

- **Removed a duplicate migration pass.** The `DatabaseMigrations` (-100) component re-ran the same player-data + online-cache migrations the installer already ran — roughly half the boot migration cost, deleted.
- **Migration runs off the main thread behind `DbReadyGate`.** `LocalDevGameInstaller.KickOffMigrations` captures connection strings + does the working-dir repoint on the main thread, then runs the writable-DB migrations in a `Task.Run` and signals `DbReadyGate`. Startup DB consumers — `GameSessionManager.Start` (after the version check, which is network and overlaps migration) and `MainMenuController` (in the play action) — `await DbReadyGate.Ready` before their first query, which is what guarantees the schema exists (replacing the old synchronous install-time block). A migration failure faults the gate and is logged, instead of hard-aborting the Zenject container.
- **Menu shows instantly.** `MainMenuController.Start` no longer does a redundant session init on the menu's critical path (Continue visibility reads only the `LastPlayMode` pref); the play action awaits the gate (brief "Preparing…" only if migration is somehow still running).
- **Scope:** game-data.bytes adoption stays synchronous on purpose — it's cheap on normal boots (a version check; the heavy file copy only happens on first install / content upgrade) and keeping it synchronous avoids racing the content-registry read of game-data.
- A dead `.Result` sync-over-async in `GameAccountRepository.TryGet` was left as-is — it's unused legacy (the Discord `GameAccountManager` path), to be deleted with that subsystem rather than patched.

## 2026-06-21

### Offline gameplay audit — fixes

A multi-system audit of the recently-built features surfaced several offline correctness bugs, now fixed.

- **Quest & achievement funnel wired into the core loop.** `QuestManager.OnBattleWon` / `OnCreatureDefeated` / `OnCreatureCaptured` / `OnItemCollected` previously had no callers, so most quests and achievements could not progress. Now: `BattleCoordinator.EndBattle` fires `OnBattleWon` on victory; the opponent-faint branch fires `OnCreatureDefeated(baseContentKey)`; `BattleBagPanelHandler` fires `OnCreatureCaptured(baseContentKey)` on capture success; `PickupBehaviour` fires `OnItemCollected` for item rewards. (Damage/heal/level-up hooks, battle-loot item-collected, and merchant-purchase-as-collected are deferred — the first two need new client consumption of `ActionOutcome.LootAwards`.)
- **Item rewards land in the backpack.** `RewardGrantService` granted items via `TrainerInventoryDomainService.AddItemAsync`, which selected `FirstOrDefault()` of the trainer's two `Item` inventories (no `ORDER BY`) — items could land in **Storage** and never show in the bag. Now uses `IItemInventoryService.AddToBackpackAsync` (targets `ItemBackpackInventoryId` and raises the change event). Fixes loot, quest, and achievement item rewards.
- **Creature rewards are placed.** `RewardGrantService` creature rewards spawned an owned creature but never added it to team/storage (pickups/loot left it unlisted). Now placed into the first open team slot, falling back to storage.
- **Offline consumables decrement.** `OfflineItemUseService` never removed consumed items (capture crystals/potions were infinite). Successful consumable use now calls `RemoveFromBackpackAsync` (raises the change event so the count updates live).
- **Capture can't orphan a creature.** Capture now adds to storage **before** claiming ownership; a full storage fails the capture cleanly (and the crystal isn't consumed) instead of reporting success with a lost creature.
- **Merchant sell raises the backpack event** (symmetry with purchase) so the bag isn't stale after selling.
- **Legacy `TrainerInventoryDomainService` correctness.** `GetInventoryItemAsync`/`GetItemQuantityAsync` compared an inventory-container id to an item id (always missed) — fixed to sum entries by `ItemId`; `UpdateItemQuantity` no longer deletes legitimate multi-slot stacks (data loss).

### Account mode & startup — menu consolidation

- **Reused the live `MainMenuController`** (`IUIScreen` "MainMenu") for the mode-first menu instead of a separate prototype — fixes dead Play Online/Offline buttons (the menu UXML's `btnStart` had been replaced) and the menu overlaying character select (a registered screen is hidden by `NavigateToScreen`). The `StartMenuController` prototype was removed.

## 2026-06-20

### Battle bag — stale inventory fix

- **Purchased items now appear in the battle bag.** A merchant purchase wrote the item straight through the repository without raising the inventory-changed events `InventorySync` listens for, so cached views (the battle bag) omitted just-bought capture crystals. Root fix: `NpcMerchantService.PurchaseItemFromMerchantAsync` now calls `IItemInventoryService.NotifyBackpackChanged(...)` **after commit** (best-effort, preserves purchase atomicity), which raises `OnBackpackUpdated`; `InventorySync` already subscribes and refreshes, so **every** consumer updates. `BattleBagPanelHandler` also refreshes on open as belt-and-suspenders for any other direct-repo writer.

### Account mode &amp; startup

- **An account always exists at boot.** `GameSessionManager` now calls `AccountBootstrapper.EnsureLocalAccountAsync()` after session init when no account is loaded — a mode-neutral resolve of the device-bound local account (it does not set the online/offline flag). Fixes the long-standing "no account at startup" failure. ([Account Mode &amp; Startup](unity/19-account-mode-startup.md))
- **Mode-first menu.** The existing live `MainMenuController` (`IUIScreen` "MainMenu") presents Continue · Play Online · Play Offline (its single "Start" button replaced). Continue remembers the last *mode* only and routes to that mode's character selection. Because it's a registered screen, `NavigateToScreen("CharacterSelect")` hides it automatically — no manual hide. Buttons are queried/wired in `Start()` (not the race-prone `OnEnable`). The separate `StartMenuController` prototype was removed in favor of reusing `MainMenuController`.
- **Connectivity-gated online entry.** New `IConnectivityProbe` / `ConnectivityProbe` (reuses the version-check endpoint for reachability) gates Play Online and Continue-into-online; unreachable → block + explain, never enters online.
- **No reconciliation.** Offline and online are two non-crossing worlds; characters are mode-locked via `IsOnlineTrainer`. Online keeps its OnlineCache DBs. Login/email-link remains an optional later upgrade. Boot-entry-point consolidation and EditMode tests are follow-ups.
- **Auth `salt` read fix.** Boot account resolution surfaced a latent mismatch — the auth `salt` column is TEXT but `Account.Salt` is `byte[]`, so a legacy string-valued salt (`''`, from before the column was made nullable) threw `InvalidCastException` during Dapper deserialization. Two-part fix: `ByteArrayTypeHandler` (registered in `DapperBootstrap`) tolerates it as defense, and migration `M0008NormalizeEmptySalt` sets `salt = NULL WHERE salt = ''` so stored data is corrected. No live code writes empty-string salt (anonymous creation passes `null`).

### Achievements

- **New `CR.Achievements` domain.** Achievements unlock on gameplay triggers (battle won, creature captured/defeated, item collected, quest completed, location visited, NPC talked to, creature level reached), record a per-trainer badge, and grant zero or more rewards. `achievement_definition` + child `achievement_reward` are baked content (GameData); `achievement_unlocked` is per-trainer state (PlayerData) with a did-I-win-the-insert upsert so re-triggers never double-grant. ([Achievements](backend/15-achievements.md))
- **Stats-driven, no parallel counter.** `threshold` (default 1 = binary) is checked against existing lifetime `StatKey` aggregates via one batched read. Referenced achievements are `threshold == 1` in this version.
- **Rides the quest funnel.** `QuestDomainService` takes an optional `IAchievementDomainService`; after the lifetime-stat write it evaluates and returns unlocks on `QuestProgressResult.NewlyUnlocked` / `QuestClaimResult.NewlyUnlocked`. Online and offline behave identically. `M7300`–`M7303` + `M9993` content bump.
- **Unity.** `QuestManager` re-broadcasts `OnAchievementUnlocked`; `AchievementToastPresenter` shows the unlock toast; new `LocationTriggerBehaviour` (the first caller of `QuestManager.OnLocationVisited`) drives location achievements. Trophy screen + Content Studio authoring deferred.

## 2026-06-17

### Loot tables + world pickups (backend)

- **Battle-victory loot.** New `CR.Loot` domain: loot tables layered by spawner (zone) and creature (species), independent per-entry drop chance, pure `LootRollService`. `BattleDomainService` rolls + grants on victory and returns `LootAward[]` on the outcome. `M8016` adds `spawner_content_key` to `battle` so the spawner table can roll. Loot `Experience` grants trainer XP, separate from per-creature combat XP. ([Loot System](backend/13-loot-system.md))
- **World pickups.** New `CR.Pickups` domain: reusable `pickup_definition` (rewards JSON) + per-trainer `pickup_collected` (one-time persistent, revive-on-write upsert). Rewards grant a creature/item/currency/XP/quest set; `Quest` is consumer-routed. ([World Pickups](backend/14-world-pickups.md))
- **Shared reward core.** `RewardType` + `RewardGrant` + `IRewardGrantService` extracted from `QuestDomainService.GrantRewardAsync`; quests now delegate. No new dependency cycles.
- Unity client (offline repos/routers, `PickupBehaviour`, DI, migrators, Content Studio authoring) is a follow-on phase.

## 2026-06-12

### Unity — warning cleanup + ability sync repair

- **Ability content sync fixed.** `ServerContentSyncService.SyncAbilitiesAsync` still inserted the `asset_id` column dropped by `M1021` — every boot logged `table abilities has no column named asset_id` and abilities never synced. The INSERT now matches the current schema and carries the full fx-key set (`use/hit/miss_sfx_key`, `use/travel/hit_vfx_key`, `camera_cue_key`), `damage_curve_key`, and `power_multiplier` from the server instead of nulling them.
- **Zenject install-time resolve removed.** `LocalDevGameInstaller` constructs `ConfigurationRepository` + `DatabaseConnectionStringFactory` directly and binds `FromInstance` — no more "resolving during install" warning. ([Dependency Injection](unity/02-dependency-injection.md))
- **USS pseudo-classes.** UI Toolkit doesn't support `:first-child`/`:last-child`; replaced with explicit `--first`/`--last` classes (BagScreen tabs, BattleSummary xp rows) and removed the cosmetic rule from the content-editor sheets.
- **Malbers** `IKProcessorOnAnimIK` gets `[Serializable]` (SerializeReference warning).

## 2026-06-09

### Capture offline + trainer currency + merchant shop

- **Offline capture works.** `OfflineItemUseService` now handles `CaptureCreature`, sharing the exact server formula via the new `CaptureChanceCalculator` (clamp 5–95%). Ownership reassignment + storage add mirror the server handler. ([Capture Mechanic](unity/14-capture-mechanic.md))
- **Opponent-target fix (online too).** Capture against `Guid.Empty` now resolves the wild side's active creature from the battle record; `BattleHUD` also passes its real opponent id into the bag panel.
- **Trainer currency.** `trainers.currency` (M4012, default 500), race-safe conditional-UPDATE adjust methods, merchant purchase debit / sell credit inside the purchase transaction, `QuestRewardType.Currency` payouts, `NewBalance` on purchase/sell results. No client adjust endpoint by design. ([Trainer Currency](backend/12-trainer-currency.md))
- **Merchant shop UI.** E on a merchant opens `MerchantShopScreenHandler`: stock from the item spawner, live prices (BaseValue × BuyMultiplier), wallet, qty stepper, Buy disabled when unaffordable. Sell tab stubbed. ([Merchant Shop](unity/18-merchant-shop.md))
- **Content:** `StartingMerchantItems` spawner authored (crystals + heal potion), `demo-merchant` wired as Merchant, `M6013` seeds Heal Potion (base_value 50), legacy `item_capture_crystal` orphan deleted.
- `run-all-tests.sh` fixed (cd leak + unsupported `--parallel` switch) — Docker repo suites run again.

## 2026-05-28

### Unity — battle wiring consolidated

- **BattleStateBridge + BattleSync deleted.** All event→SO and event→Variable routing now flows through `EventWiringManifest` (codegen) and `VariableWiringManifest` (reflection). Single source of truth, no duplicate raises.
- **`EventChannelInstaller`** + `EventChannelIds` constants — consumers use `[Inject(Id = EventChannelIds.X)]` instead of `[SerializeField]` SO drags. Adding a new event = one manifest row, zero per-consumer Inspector work.
- **`BattleCoordinator.EndBattle` split into `EndBattle` + `CloseBattle`.** EndBattle raises resolution; CloseBattle exits the arena. New `BattleEvents.BattleClosed` + `ScriptableEventBattleClosed` SO. `_battleInProgress` stays true across the summary so input gates suppress the full lifecycle.
- **`BattleSummaryScreen`** — new post-battle modal (UI Toolkit). Outcome banner + Experience Gained list + Items Received + scrollable Synopsis of every notable battle event. OK calls `CloseBattle`. Run-away auto-dismisses after 1.2s.
- **`PlayerInputGate`** also gates on battle (Player map disabled from `BattleStarted` until `BattleClosed`). Trainer movement runs through `TrainerMovementController` → `IMovementController` → `MalbersMovementController`; gating the Player map naturally stops the shim.
- **Starter selection (cr-api):** `BattleDomainService.SeedForTrainerAsync` now picks the first non-fainted creature by slot order (fallback to slot 0 if all fainted). Locked with a new test.
- **Combat HUD redesign** — Figma "Monster Curator" light theme. Command card swaps modes (Attack / Bag / Swap / Run). Focus = navy fill + scale lift (USS has no box-shadow).
- **Bag** — real `BaseItem.Name` / `Description` in both dashboard and combat bags (no more GUID prefixes).
- **Team-availability dots** on the player card: full fill = fightable, ~15% = fainted, empty = no slot.


Reverse-chronological log of significant additions to the codebase. Each entry links to the relevant documentation section.

---

## 2026-05-24

### Two-database content pipeline — game-data artifact, spawner/NPC globalization

The offline SQLite store is split into two databases with separate lifecycles: a read-only **game-data DB** (global authored content) and a mutable **player-data DB** (per-trainer saves). Content ships as a versioned `game-data.bytes` artifact and is patched via Addressables; player saves are migrated in place. Spawner and NPC content are globalized.

**Backend (cr-api)**
- `CR.Data.Migrations.Tool` (`Program.cs`) — default output renamed `crgame.bytes` → `game-data.bytes`; after running all migrations it runs **12 referential-integrity checks** (spawner/template/pool, ability progression, status-condition stat changes, quest template→objective/reward/requirement) and exits non-zero on any dangling content reference, failing the build.
- `build-packages.sh` — generates the pre-built `game-data.bytes` (+ `game-data_schema_version.txt`) into `bin/unity-package/StreamingAssets/CR/`; aborts the package build if generation or the integrity checks fail.
- `M5016RetirePerTrainerSpawner` — soft-deletes per-trainer spawner clones (`account_id`/`trainer_id` non-null); global template rows are the sole source of truth. `account_id`/`trainer_id`/`current_count` columns kept dormant.
- `CreatureSpawnDomainService` — spawning is stateless: no capacity/cooldown enforcement; validation checks only `is_active` (with a `BypassValidation` flag); spawning never mutates the template. Falls back to the global template's pools by `content_key`.
- `M2010GlobalizeNpcContent` — NPC content globalized via the `ContentWorldId` sentinel (`00000000-0000-0000-0000-000000000001` as both account/trainer); dedups stray content-world rows, re-points child rows, adds a partial content-key index. Genuine player NPC instances untouched.
- → [Spawner System](?page=backend/03-spawner-system) · [NPC System](?page=backend/02-npc-system)

**Unity (cr-api-unity)**
- `LocalDataSources` — adds `GameData` (`database_path_game_data`) and `PlayerData` (`database_path_player_data`) offline sources; content repos route to game-data, player-state repos to player-data (Part C-1).
- `DatabaseMigrations.RunMigrations()` — migrates both offline databases plus online-cache DBs. Cold-start adopt of the baked artifact (atomic copy + fail-closed schema-version gate, reusing `AddressablesCatalogUpdater`) tracked as Part C-2 (TODO).
- → [Content Pipeline (Two-Database Model)](?page=unity/17-content-pipeline) · [Project Setup](?page=unity/01-project-setup) · [Content Registry](?page=unity/08-content-registry) · [Addressables Setup](?page=unity/09-addressables-setup)

---

## 2026-04-19

### Ability + condition asset content keys

Replaces the unused UUID `asset_id` foreign-key columns on abilities and status_conditions with a flat content-key model that mirrors the `creature.asset_key` pattern (M1016). Designers populate Addressables `AssetReference` slots in Unity SOs; the matching string keys are synced to the backend and round-trip through the battle outcome so the client can play the right sound/VFX without coupling the resolver to assets.

**Backend (cr-api)**
- `M1021ReplaceAssetIdsWithKeys` — drops `abilities.asset_id` and `status_conditions.{on_hit,on_trigger,on_removed}_effect_asset_id`. Adds `abilities.{use,hit,miss}_sfx_key`, `abilities.{use,travel,hit}_vfx_key`, `abilities.camera_cue_key`, `status_conditions.{on_hit,on_trigger,on_removed}_vfx_key`, `status_conditions.{on_apply,on_tick,on_remove}_sfx_key`.
- `BaseAbility`, `Ability`, `BaseStatusCondition`, `StatusCondition`, `ActiveBattleCondition` — model fields updated. `AssetId` and `OnHit/Trigger/RemovedEffectAssetId` properties removed.
- `ActionOutcome` — surfaces seven ability key fields directly (UseSfxKey, HitSfxKey, MissSfxKey, UseVfxKey, TravelVfxKey, HitVfxKey, CameraCueKey).
- `BattleResolver` + `BattleDomainService` — pass keys into `ActiveBattleCondition` and outcome payloads.
- `BaseAbilityRepository`, `AbilityEndpoints`, `Program.cs` status-condition endpoints, `M9990SeedGameData`, `CreaturesSchemaExtensions` — SQL + DTOs updated to round-trip new columns.

**Unity (cr-api-unity)**
- `AbilityConfig`, `StatusConditionConfig` — paired `AssetReferenceT<AudioClip>`/`AssetReferenceGameObject` + `string ___Key` fields. Editors render an "Audio / VFX" section with an `← from asset` button that auto-derives the Addressables address into the key field.
- `AbilityEditorSyncHelper` — `TryDeriveAddressableKey` helper, sync DTOs and PUT payloads include the new keys.
- `BattleEvents` — `SfxRequested(string)` and `VfxRequested(string)` events. Wired into `BattleEventsAdapter`.
- `BattleCoordinator` — fires `SfxRequested`/`VfxRequested` from outcome keys at cast-time and impact-time, and from `ActiveBattleCondition` keys on apply / trigger / removed.
- `StatusConditionListView` — UI search and editor form switched to the new key fields.
- → [Event Wiring](?page=unity/15-event-wiring) (audio/VFX request events added)

### Wiring system — editor, codegen, and juice events

Followups to the variable wiring system + a batch of cinematic / haptic events for battle UX.

**Unity (cr-api-unity)**
- `VariableWiringEditorWindow` — designer-facing editor at `CR → Wiring → Variable Wiring Editor` (mirrors event wiring editor shape).
- `VariableWiringDiscovery` — shared helper for value-type resolution + variable asset enumeration.
- `VariableWiringCodegen` — IL2CPP-safe bridge generator at `CR → Wiring → Generate Variable Bridge From Selected Manifest`. Output: `Assets/CR/Core/Wiring/Generated/GeneratedVariableWiringBridge.cs`.
- `BattleEvents` — added camera cues (`CameraCueIntro`, `CameraCueAttacker`, `CameraCueDefender`, `CameraCueFaint`, `CameraCueCapture`, `CameraCueVictory`), derived game-feel events (`HeavyHit`, `LowHpEntered`, `CriticalHpEntered`), and 0-arg vibration tiers (`VibrationLight/Medium/Strong`).
- `BattleCoordinator` — fires camera cues at lifecycle points + derives `HeavyHit` (>30% maxHp damage), `LowHpEntered`/`CriticalHpEntered` (downward 30%/10% threshold crossings, once per descent), and tier-appropriate vibration cues.
- `BattleEventsAdapter` — wires all juice events for SOAP routing.
- `BattleBagPanelHandler` — fires `CameraCueCapture` + strong vibration on capture success.
- → [Event Wiring](?page=unity/15-event-wiring) (camera cues / game-feel / vibration tables added)

### Wiring system — deferred items shipped

Followups to the Event Wiring system covering quest rewards, capture/exp/level events, and SOAP variable assignments.

**Unity (cr-api-unity)**
- `QuestRewardAdapter` — wraps `QuestRewardDispatcher.OnRewardsDispatched` (`Action<QuestInstance, IReadOnlyList<QuestRewardTemplate>>`) as a single-arg `Action<QuestRewardsDispatchedData>` for SOAP wiring.
- `QuestRewardsDispatchedData`, `ScriptableEventQuestRewardsDispatched` — payload + SO event type.
- `BattleEvents` — added `CaptureAttempted`, `CaptureFailed`, `ExpGained`, `LevelUp`. Wired into `BattleEventsAdapter`.
- `ExpGainedData`, `ScriptableEventExpGained` — payload + SO event type for exp gain (capture/levelup use existing `ScriptableEventString`).
- `BattleBagPanelHandler` — fires `CaptureAttempted` pre-roll, `CaptureFailed` on failed capture, `ExpGained`/`LevelUp` from item-use results.
- `VariableWiringEntry`, `VariableWiringManifest`, `VariableWiringExecutor`, `VariableWiringRunner`, `VariableWriteMode` — designer-driven mapping of C# events to SOAP `Bool`/`Int`/`Float`/`StringVariable` assignments. Replaces job #2 of legacy state bridges.
- `LocalDevGameInstaller` — binds `QuestRewardAdapter`, `VariableWiringRunner`, optional `VariableWiringManifest`.
- → [Event Wiring](?page=unity/15-event-wiring) (now also covers Variable Wiring + new event tables)

---

## 2026-04-15

### Items — domain service replaces Unity-local repository

Item use is now routed through the DLL `IItemUseDomainService` contract instead of the Unity-local `IItemUseRepository`. This aligns the Unity client with the backend contract and removes duplicated model types.

**Unity (cr-api-unity)**
- `IItemUseRepository`, `ItemUseModels`, `ItemUseOnlineRepository`, `ItemUseOnlineOfflineRepository` — **deleted**.
- `ItemHttpDomainAdapter` — new HTTP adapter implementing `IItemUseDomainService`. Posts to `POST /api/v1/trainers/{trainerId}/items/{itemId}/use`.
- `OnlineOfflineItemDomainService` — new router; delegates to the HTTP adapter (online) or `OfflineItemUseService` (offline) based on `IsPlayingOnline`.
- `OfflineItemUseService` — refactored to implement `IItemUseDomainService` directly (was `IItemUseRepository`).
- `BattleBagPanelHandler`, `BagScreenHandler` — inject `IItemUseDomainService` instead of `IItemUseRepository`.
- `LocalDevGameInstaller` — keyed bindings `"item_online"` / `"item_offline"` + unkeyed default router.
- → [Battle Bag UI](?page=unity/13-battle-bag-ui) · [Item System](?page=unity/10-item-system)

### Quest acceptance from dialogue

Dialogue scripts can now trigger quest acceptance by calling `AcceptQuest("template-uuid")` in a Pixel Crushers Dialogue System Script field. No code changes needed per quest.

**Unity (cr-api-unity)**
- `PixelCrushersDialogueHandler` — registers the `AcceptQuest` Lua function in `Start()` and unregisters in `OnDestroy()`. Raises `IDialogueHandler.OnQuestAcceptedFromDialogue`.
- `IDialogueHandler` — `event Action<string> OnQuestAcceptedFromDialogue` added.
- `QuestDialogueBridge` — subscribes to `OnQuestAcceptedFromDialogue` and calls `QuestManager.AcceptQuestAsync(guid)`.
- → [Dialogue Integration — Quest Acceptance](?page=unity/11-dialogue-integration#quest-acceptance-from-dialogue)

### Quest reward dispatcher

Quest rewards are now claimed and surfaced to the HUD automatically on quest completion.

**Unity (cr-api-unity)**
- `QuestRewardDispatcher` — bound `NonLazy`; subscribes to `QuestManager.OnQuestCompleted`, calls `ClaimRewardsAsync`, increments `StatKey.QuestsCompleted`, and fires `OnRewardsDispatched` for the HUD.
- → [Quest System](?page=unity/quest-system)

---

## 2026-04-17

### Quest creature reward — stale UUID bug fix

Fixes crash chain when claiming quest rewards that spawn creatures. Root causes: `INSERT OR REPLACE` caused UUID churn on content re-sync; seed UUIDs were uppercase, causing SQLite TEXT mismatch; fresh-DB race between `SyncCreaturesAsync` and `SpawnerDefinitionSyncBehaviour`; `QuerySingleAsync` threw instead of returning null.

**Backend (cr-api)**
- `BaseCreatureRepository.GetCreature` — `QuerySingleAsync` → `QuerySingleOrDefaultAsync`; return type `Task<BaseCreature?>`.
- `ICreatureRepository.GetCreature` — signature updated to `Task<BaseCreature?>`.
- `CreatureGenerationService.CreateFromSpawnerAsync` — added `ResolveBaseCreatureIdAsync` / `ResolveGrowthProfileIdAsync` with content-key/name fallback and self-heal (updates stale UUID on template for next call).
- `CreatureSpawnerTemplate` model — added `CreatureContentKey: string?` and `GrowthProfileName: string?`.
- Migration M1019 — normalises `creature.id` to lowercase in SQLite.
- Migration M1020 — normalises `growth_profile.id` to lowercase in SQLite.
- Migration M5014 — adds `creature_content_key` and `growth_profile_name` columns to `creature_spawner_template`.
- `BaseCreatureSpawnerTemplateRepository` — INSERT/UPDATE SQL includes new columns.
- → [Spawner System](?page=backend/03-spawner-system) · [Creature Generation — Stale-UUID Fallback](?page=backend/04-creature-generation#staleuuid-fallback)

**Unity (cr-api-unity)**
- `ServerContentSyncService.SyncCreaturesAsync` — `INSERT OR REPLACE` → `ON CONFLICT(content_key) DO UPDATE SET` (preserves `id`); `c.Id.ToLowerInvariant()`.
- `ServerContentSyncService.SyncGrowthProfilesAsync` — `ON CONFLICT(name) DO UPDATE SET`; `p.Id.ToLowerInvariant()`.
- `LocalSpawnerSyncClient` — stores `CreatureContentKey` and `GrowthProfileName` in spawner templates.
- `CreatureOnlineOfflineRepository` / `CreatureOnlineRepository` — `GetCreature` returns `Task<BaseCreature?>`.

---

## 2026-04-08

### Typed item effect parameters

Item effect parameters are now strongly-typed structs instead of raw JSON blobs, giving both the backend and Unity a clean, validated contract for every effect type.

**Backend (cr-api)**
- 14 typed param classes added under `CR.Game.Model.Items.EffectParameters` (e.g. `HealFlatParams`, `BoostStatPermParams`, `CureStatusParams`, `CaptureParams`, …).
- `EffectParameterSerializer` (Newtonsoft.Json, camelCase, null-safe) handles serialization for all handlers.
- `StatEnumConverter` maps legacy string aliases (`"HP"`, `"spa"`, `"spd"`) to the `Stat` enum for backwards compatibility with existing item data.
- 6 item-effect handlers and 2 evaluators refactored to use typed deserialization.
- `BattleResolver` held-item methods refactored; `ApplyHeldTypeBoost` now takes `ElementType?`.
- `GET /api/v1/ability/status_conditions` list endpoint added.
- 75 unit tests added covering the serializer, all 6 handlers, and both evaluators.
- → [Item System](?page=backend/06-item-system)

**Unity editor (cr-api-unity)**
- `ItemDefinitionEditor`: structured inspector fields per `EffectType` (enum dropdowns, sliders, condition picker) — replaces raw JSON `TextArea`. Existing SO assets auto-migrate on open.
- `OfflineItemUseService`: removes `TryResolveEffectType` hack; uses `item.EffectType` / `EffectParameters` from SQLite; fixes `CureStatus` singular/plural bug; switches to `EffectParameterSerializer` + `Stat` enum for `BoostStatPerm`.
- → [Item System](?page=unity/10-item-system)

---

## 2026-04-07

### Capture crystal — bag UI and item flag

`CaptureCrystal` (value `64`) added to the `ItemUsageFlags` enum in both backend and Unity, enabling the battle bag UI to identify and present capture items distinctly from consumables.

**Backend (cr-api)**
- `ItemUsageFlags.CaptureCrystal = 64` added.

**Unity editor (cr-api-unity)**
- `ItemUsageFlags.CaptureCrystal = 64` mirrored.
- `BattleBagPanel`: `IsCaptureCrystal()` and `GetCaptureLevelText()` helpers added.
- `PopulateItemList()` shows capture crystal tier info inline; `OnItemRowClicked()` displays tier and auto-selects the opponent as the target.
- USS styles added for capture crystal indicator rows.
- → [Capture Mechanic](?page=unity/14-capture-mechanic)

---

## 2026-04-01

### Data-driven content keys — ContentKeys.cs removed, Addressables catalog wired

The `ContentKeys.cs` constants file has been deleted. It was editor-only scaffolding that created the false impression that adding new content requires a code change and rebuild. The runtime has always been fully data-driven (server manifest → `ServerContentRegistry` → `GameAssetLoader`); the file was never consulted at runtime.

`AddressablesCatalogUpdater.UpdateAsync()` is now called at startup inside `ContentRegistryInitializer.FetchAndUpgradeAsync()` (behind the `CR_ADDRESSABLES` define). This means running game clients will download updated Addressables catalogs from the CDN before loading any assets — new content shipped to the CDN will land without a rebuild.

**cr-api-unity changes:**
- `Assets/CR/Core/Data/Registry/ContentKeys.cs` — **deleted**
- `ContentRegistryInitializer` — calls `AddressablesCatalogUpdater.UpdateAsync()` before fetching the server manifest
- `ContentStudioTool` — "Add to ContentKeys.cs" checkbox and `AddConstantToContentKeys()` method removed
- `ContentAuditTool` — "missing ContentKeys constant" warning category removed
- `CreatureDefinitionEditor`, `NpcDefinitionEditor`, `SpawnerDefinitionEditor`, `ItemDefinitionEditor` — ContentKeys help text and "Add to ContentKeys" button removed
- `DefinitionEditorExtensions` — `ExistsInContentKeys()` and `DrawContentKeyInfo()` helpers removed
- → [Content Registry](?page=unity/08-content-registry)
- → [Addressables Setup](?page=unity/09-addressables-setup)

---

### Growth profile assignment on creature species templates

`BaseCreature` (and `CreatureDefinition` in Unity) can now reference a `GrowthProfile` directly, so a species template carries its default stat-scaling curve rather than relying solely on spawner templates or manual generation calls.

**Backend (cr-api)**
- `BaseCreature` gains `GrowthProfileId Guid?` — FK to the `growth_profile` table.
- `M1018AddGrowthProfileIdToBaseCreature` — adds `growth_profile_id UUID NULL` to the `creature` table.
- `BaseCreatureRepository` — `growth_profile_id` included in all SELECT, INSERT, UPDATE, and upsert (ON CONFLICT) queries.
- → [Creature Generation — BaseCreature Model](?page=backend/04-creature-generation#basecreature-model)

**Unity editor (cr-api-unity)**
- `CreatureDefinition` SO gains a `growthProfileId` string field (same pattern as `abilityProgressionSetId` — paste the GUID from a `GrowthProfileConfig` SO).
- `ContentCreatorSyncHelper` — `ServerCreatureDto` carries `growthProfileId`; `FetchAllCreatures`, `ApplyToCreature`, `CreatureDiffersFromServer`, and `BuildCreatureJson` all handle the new field bidirectionally.
- `ContentStudioTool` diff view shows `growthProfileId` conflicts in the Creatures sync panel.
- → [Content Registry — CreatureDefinition Inspector Fields](?page=unity/08-content-registry#creaturedefinition-inspector-fields)

### UICoordinator — battle bag panel and overworld bag screen

- `BagScreenHandler` and `BattleBagPanelHandler` migrated to the `IContextAwareScreen` pattern; both hide on coordinator registration (no more Awake hacks).
- `BattleBagPanel.uxml` gets a **← Back** button that restores the battle action menu without closing the battle.
- `PlayerMenuWindow.EnableInput` / `DisableInput` narrowed to game-specific actions only — no longer disables Unity's shared UI action map, which was blocking all UIToolkit click events during battle.

### Battle fixes

- Wild team capped at 1 creature per encounter (was accumulating across encounters).
- `OfflineBattleService` now looks up `BaseCreature.BaseHitPoints` for max HP and `GivenName` for display name.
- Wild AI falls back to `GetAbilitiesPaginated(0,4)` when a creature has no progression set — AI now always takes a turn.
- Battle ends and logs when the player's creature faints.

---

## 2026-03-28

### Content deletion — server soft-delete from Content Studio

Unregistering a definition or resolving an "Only Server" sync row can now remove the backend record rather than always pulling it back.

**Backend (cr-api `feature/content-delete-endpoints`)**
- `DELETE /api/v1/creatures/by-content-key/{contentKey}` — soft-deletes the `BaseCreature` template. Guarded by `IGeneratedCreatureRepository.CountByBaseCreatureIdAsync`: if any trainer-owned `generated_creature` rows reference the species, returns 409 Conflict instead of deleting.
- `DELETE /api/v1/spawners/by-content-key/{contentKey}` — soft-deletes the global spawner template (no guard — spawner templates have no per-trainer rows).
- → [Creature Generation — API Endpoints](?page=backend/04-creature-generation#creature-list-and-upsert-endpoints)
- → [Spawner System — API Endpoints](?page=backend/03-spawner-system#content-creator-sync-bidirectional)

**Unity editor (cr-data `feature/content-delete-sync`)**
- `ContentCreatorSyncHelper` gains `DeleteCreature(contentKey)` and `DeleteSpawner(contentKey)` methods (blocking HTTP DELETE); `SendDelete` extracts JSON error bodies so server messages (e.g. the 409 creature guard) surface to the user.
- **Unregister flow** — after removing a Creature or Spawner definition from the provider, a dialog asks "Also delete from server?" with **Delete from server** / **Keep on server** options.
- **Sync "Only Server" rows** — Creature and Spawner rows now require explicit resolution. Each row shows **[Pull]** and **[Delete]** toggle buttons. Apply is blocked until every row has a choice. (NPCs, Abilities, Progression Sets, and Growth Profiles still auto-pull.)
- → [Content Registry — Removing Content from the Backend](?page=unity/08-content-registry#removing-content-from-the-backend)

---

## 2026-03-25

### BattleHUD ability selection menu
- **`BattleHUD`** gains a real ability sub-panel (up to 4 buttons). Pressing **Battle** now opens the ability picker rather than auto-submitting a default attack.
- `BattleEvents.PlayerTurnStarted` signature updated: carries `List<WildAbilityDto>` (name + power + id) instead of a bare `string[]`.
- `BattleStateResponse` gains a `playerAbilities` field populated by `OfflineBattleService` from the creature's progression set.
- `WildAbilityDto` gains a `name` field (shared by player and wild ability lists).
- → [Battle System — BattleHUD](?page=unity/07-battle-system#battlehud)

---

## 2026-03-24

### Wild Battle System — Phases 2–5 (Unity client)

**Arena system** (`CR.Game.Battle.Arena`)
- `BattleArena` MonoBehaviour: biome-specific environment GameObjects, trainer/creature spawn points, camera look target, `SetBiome()` / `Activate()` / `Deactivate()`.
- `BattleArenaRegistry` (`IWorldInitializable`): discovers all `BattleArena` in scene at init, keyed by `arenaKey`.
- `BattleCameraController`: lerps main camera to `cameraLookTarget` on `EnterBattle`, restores on `ExitBattle`.
- Editor tool: **CR > Battle > Create Placeholder Arena** scaffolds an arena GameObject with default biome structure.
- → [Battle System — Arena](?page=unity/07-battle-system#battle-arena)

**Offline battle stack** (`CR.Game.Battle.Offline`)
- `IBattleRepository` + `SqliteOfflineBattleRepository`: persists battle state to a local SQLite DB (crash-recovery; 4 tables: `battle`, `battle_round`, `battle_creature_state`, `battle_action_log`).
- `OfflineBattleService`: uses `BattleResolver` from `CR.Game.Compat` for in-memory resolution; calls `IGeneratedCreatureRepository` for HP write-back on battle end.
- `OfflineBattleClient`: implements `IBattleClient` for fully offline play.
- `OnlineOfflineBattleClient`: routes `IBattleClient` calls to HTTP or offline based on `IsPlayingOnline`.
- → [Battle System — Offline Stack](?page=unity/07-battle-system#offline-battle-stack)

**Turn loop and coordinator** (`CR.Game.Battle.BattleCoordinator`)
- Sequential turn loop driven by `TaskCompletionSource<string>`; player action awaited until `SubmitPlayerAction()` resolves it.
- `StartBattleAsync` response carries `activeTrainerId` + `roundKey`; avoids an extra `GetRoundKey` round-trip.
- Arena activation and camera transition wired into the wild battle start flow.
- `BattleEvents` static class: 8 events (`BattleStarted`, `PlayerTurnStarted`, `CreatureAttacking`, `CreatureHit`, `HpChanged`, `CreatureFainted`, `BattleEnded`, `RunAttempted`).
- → [Battle System — Turn Loop](?page=unity/07-battle-system#wild-battle-turn-loop)

**Wild AI client** (`CR.Game.Battle.AI`)
- `LocalWildBattleAIService`: offline heuristics — heal at <30% HP if item available, 20% chance for a status ability, else highest-power ability.
- → [Battle System — Wild AI](?page=unity/07-battle-system#local-wild-battle-ai)

**UI** (`CR.UI.Battle.BattleHUD`)
- HP bars, creature names, 4-line scrolling battle log.
- → [Battle System — BattleHUD](?page=unity/07-battle-system#battlehud)

**DI wiring** (`LocalDevGameInstaller`)
- Full offline battle stack bound: `SqliteOfflineBattleRepository`, `OfflineBattleService`, `OfflineBattleClient`, `BattleClientUnityHttp`, `OnlineOfflineBattleClient` as `IBattleClient`.
- `LocalWildBattleAIService`, `BattleArenaRegistry`, `BattleCameraController` bound.
- → [Battle System — DI](?page=unity/07-battle-system#installer-binding)

**SpawnerEncounterBehaviour**
- Random 2–5 s encounter delay with trigger-exit cancel.
- → [Battle System — Wild Creature Battle Flow](?page=unity/07-battle-system#wild-creature-battle-flow)

---

### Wild Battle System — ability animations and progression set (cr-api)

- `M9003`: `animation_key` (VARCHAR NULL) on `abilities` table — drives `BattleCoordinator.FireOutcomeEvents` clip selection.
- `M1017`: `ability_progression_set_id` (UUID NULL FK) on `creature` table — wild AI and offline `GetBattleStateAsync` use it to fetch the creature's learned abilities.
- `GetAbilitiesForProgressionSetAtLevelAsync` added to `IAbilityRepository`.
- `WildBattleAIDomainService` updated to use the creature's own progression set instead of a global ability query.
- `ActionOutcome.AbilityKey` now populated from `BaseAbility.AnimationKey`.
- → [Battle Persistence — Wild AI](?page=backend/09-battle-persistence#wild-trainer-ai)

---

## 2026-03-23

### Wild Battle System — core backend (cr-api)

**Shared engine (`CR.Game.Compat.Battle`)**
- `BattleResolver`: pure-static damage resolver (physical/special/status formula, accuracy roll, DOT conditions).
- `BattleActionParser`: JSON serialiser/deserialiser for `BattleAction[]`.
- `CreatureSnapshot` + `SingleActionResult` records.
- → [Battle Persistence — BattleResolver](?page=backend/09-battle-persistence#battleresolver)

**Sequential turn model**
- `M8006`: `active_trainer_id` on `battle_round` — replaces simultaneous-submit with single-actor-per-round.
- `IBattleDomainService.SubmitActionAsync` replaces `SubmitInputAsync`; resolves immediately and returns `ActionOutcome` with `NextActiveTrainerId` + `NextRoundKey`.
- Speed-based first-mover; ties go to trainer1 (player).
- → [Battle Persistence — Turn Model](?page=backend/09-battle-persistence#turn-model)

**Wild trainer + AI**
- Wild Trainer seeded with GUID `00000000-0000-0000-0000-000000000001`.
- `WildBattleAIDomainService` + `POST /api/v1/battle/{id}/wild-turn` endpoint.
- → [Battle Persistence — Wild AI](?page=backend/09-battle-persistence#wild-trainer-ai)

**Endpoints added**
- `POST /api/v1/battle/start` — returns `activeTrainerId` + `roundKey` in one call.
- `POST /api/v1/battle/{id}/submit` — resolves immediately, returns `ActionOutcome`.
- `POST /api/v1/battle/{id}/wild-turn` — AI picks + submits wild action server-side.
- `POST /api/v1/battle/{id}/run` — escape with speed-based formula.
- `GET /api/v1/battle/{id}/summary` — post-battle creature state summary.
- → [Battle Persistence — REST Endpoints](?page=backend/09-battle-persistence#rest-endpoints)

---

## 2026-03-17

### Content and asset refactor (cr-api)

- `asset_key` replaces `asset_id` on `creature` and `item` tables (M1016, M6003).
- `game_assets` table and `GET /api/v1/assets/manifest` endpoint.
- Merchant REST endpoints added.
- → [Asset Management](?page=backend/10-asset-management)

---

## 2026-03-10

### Battle persistence foundation (cr-api)

- `M8004`: 5 battle tables (`battle`, `battle_round`, `battle_round_input`, `battle_creature_state`, `battle_action_log`).
- `IBattleRepository`, `BattleDomainService`, initial REST endpoints.
- → [Battle Persistence](?page=backend/09-battle-persistence)

---

## Earlier

For history prior to 2026-03-10 see the [git log](https://github.com/CrystallineRift/cr-api/commits/main) and [cr-data commits](https://github.com/CrystallineRift/cr-data/commits/main).
