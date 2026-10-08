# Trainer Progression (Phase 1: Trainer Level)

The player's trainer earns XP for what they do and levels up on an admin-editable curve (cap 30). Each
level from 2 grants a talent point, spent through the real [Talents](25-talents.md) domain (Phase 2,
landed) — `AvailablePoints`/`SpentPoints`/`NeedsRespec` below are no longer placeholders; they are read
from `TalentBuild.Evaluate` every call. Spec: `cr-api-unity/docs/superpowers/specs/2026-09-26-trainer-progression-design.md`.

## Where things live

| Piece | Location |
|---|---|
| Contracts | `Game/CR.Game.Model/Progression/` — `ITrainerProgressionService`, `TrainerProgress` (now also `AvailablePoints`/`SpentPoints`/`NeedsRespec`/`Allocations`/`Modifiers`/`QuestLockedTalentIds` — see [Talents](25-talents.md)), `TrainerProgressResult`, `TrainerXpAward`, `TrainerXpSource`, `TrainerModifiers`, `ITrainerModifierProvider`, `TrainerProgressTracker`, `TalentEffectType` |
| Domain | `Talents/` — `CR.Talents.Data(.Sqlite/.Postgres/.Migration/.Migration.Postgres)`, `.Domain.Services` (`TrainerProgressionService`, `TrainerLevelCurve`, `TrainerXpRuleMath`, `TrainerProgressionContentValidation`, `TalentBuildReader`, `TalentModifierProvider`, `TalentService`), `.Model.REST`, `.Service.REST`. `NoTalentModifierProvider` is deleted — `ITrainerModifierProvider` now always resolves to the real `TalentModifierProvider`, both online and offline. |
| Connection string | `TalentDatabase`; when the key is absent the API uses the `StatDatabase` connection string and logs `[startup] ConnectionStrings:TalentDatabase is not set; …` once (`TalentDatabaseFallbackExtensions`, `CR.REST.AIO`) |
| Migrations | M15001 `world_location`, M15002 `trainer_level_requirement` (+ L1–30 seed), M15003 `trainer_xp_rule` (+ 6 rules), M15010 `world_location.discovery_xp`/`discovery_quest_key`, M15011 `trainer_location_discovery` (the discovery ledger), M15012 `world_region` (+ 77 open-world region keys). The floor seed (M15004 at first export) is **not shipped yet** — see [Offline floor](#offline-floor) |
- **M15013** seeds the six legacy area keys (Meadow, Village, Cave, Shore, Crags, Dunes) into `world_region` (parent `legacy`), so legacy-mode location saves validate offline too, where `world_location` has no rows.

## Data

- `trainer_level_requirement(level UNIQUE, required_xp)` — cumulative XP per level; seed `40·(L−1)² + 60·(L−1)` (L2 100, L5 880, L10 3,780, L20 15,580, L30 35,380). Cap = highest live level.
- `trainer_xp_rule(source_key UNIQUE, base_xp, multiplier, low_level_threshold?, low_level_factor?)` — `source_key` is a rule-driven `TrainerXpSource` name. Amount = `round(base × units × multiplier)`, × factor when `trainerLevel − opponentLevel ≥ threshold`.
- `world_location(content_key UNIQUE, name, area_key, discovery_xp?, discovery_quest_key?)` — only these
  keys earn discovery XP; the last two columns (M15010) override the flat rule amount and grant a one-time
  quest — see [Location Discoveries](?page=backend/24-location-discoveries).
- `world_region(key UNIQUE, name, parent?)` — the server-owned open-world region keys (`regions.json`
  `regions[].key` + `techdemo`), seeded insert-if-absent by M15012. Earns nothing; it only widens the
  trainer location-save check: `IWorldLocationRepository.AreaKeyExistsAsync` is true for a live
  `world_location.area_key` **or** a live `world_region.key` (case-insensitive), enforced in
  `TrainerDomainService.UpdateLastLocationAsync` — see [Area Scenes](?page=unity/22-area-scenes#resuming-where-you-stood).
  New regions need a new seed migration.
- XP lives in the `trainer_xp` stat; `trainer_level` is a display/achievement high-water mark: grants raise it with `MaxAsync` and `GetProgressAsync` repairs it **up** only — a read never lowers it (its XP and level reads are not synchronised, so a down-repair could undo a concurrent level-up). The one write that lowers it is an admin take-back, which `SetAsync`s the level derived from its own post-increment total. First-time capture checks read the per-key stat `species_captured_{baseCreatureId:N}` (`IStatService.GetAsync`, 0 = first) — **read-only** since [Progress Dispatcher](?page=backend/23-progress-dispatcher): `TrainerProgressionService.AwardAsync` no longer increments this key itself; `LifetimeStatProjector` does, from the `CreatureCaptured` outcome's `ProgressFacts.BaseCreatureId` fact, after the award has already read and used the pre-capture count. The location-discovery equivalent moved off a stat flag onto the `trainer_location_discovery` ledger (M15011) — `location_discovered_{key}` is now a projection, not a gate.
- Seeds are insert-if-absent: re-running never overwrites an admin edit.
- These four keys — `trainer_xp`, `trainer_level`, `location_discovered_{key}`, `species_captured_{id:N}` — are **server-owned**: the player-facing stat write routes (`POST /api/v1/stats/increment|max|set`) refuse them with `403 Forbidden` (`ServerOwnedStatKeys.Contains`, matched trimmed and case-insensitively by exact name or prefix). The write routes also refuse any key with leading or trailing whitespace (`400`), since a padded key would be stored as its own row nobody reads. Only server-side code writes them, through the progression funnel or the admin XP grant — never a client stat call. See [Stats and Lifetime Tracking](?page=backend/08-stats-system).

## Sources

| Source | Where | Units | Seed rule | Retry-safe because |
|---|---|---|---|---|
| Reward (quest, achievement, loot, pickup reward lists) | `RewardGrantService` → `GrantXpAsync(Reward)` | as authored | — | the owner's one-time transition |
| Wild / trainer win | `BattleDomainService` on the winning action | `BattleRewardScaling.ExperienceForDefeatedLevel(final KO level)` | 1 × 1.0 (1.5 trainer), guard 10 / 0.25 | battle row → Ended |
| Capture (+ first of species) | `CaptureAttemptService` after the ownership transition | creature level | 10 (+50) | the creature is no longer wild |
| Location discovered | `LocationEntryService.EnterAsync` (via the BFF `.../world-locations/enter` route — the only caller since Phase E retired the `/quests/progress` compat forward) | 1 | 25, or the location's own `discovery_xp` override | the discovery ledger's per-trainer, per-location `xp_awarded` claim; unknown keys earn 0 — see [Location Discoveries](?page=backend/24-location-discoveries) |
| Pickup collected | `PickupDomainService.CollectAsync` after the claim | 1 | 5 | pickup_collected claim |
| Creature level-up (Mentor talent) | `BattleDomainService.ResolveSingleActionAsync`, via `SafeGrantXpAsync` | levels the KO crossed × `CreatureLevelUpTrainerXp` | `TrainerXpSource.CreatureLevelUp`, no seed row (a raw grant, not a rule) | paid inside the same widened `TrainerProgressTracker` bracket as the KO's other awards — see [Talents §6.8](25-talents.md#effects) |

XP never fails the owning operation:

- Source awards go through `SafeAwardAsync` and the `TrainerProgressTracker` bracket, which log and return null on failure. After the owning operation has committed (capture ownership, battle → Ended, pickup claim) they run with `CancellationToken.None`, so a client disconnect can neither lose the award nor turn a committed operation into an error. Cancellation *before* the commit still propagates.
- Reward XP: `RewardGrantService` catches a non-cancellation failure from `GrantXpAsync`, logs it and pays the amount as a raw `trainer_xp` increment instead, so a quest claim, pickup reward list or achievement reward is never aborted half-paid (a retried claim would re-pay its items). This pays the XP exactly once because `GrantXpAsync` does everything that can throw *before* its `trainer_xp` increment.
- The `trainer_level` write after the increment is best-effort and uncancellable: if it fails the grant still returns (logged as an error) and `GetProgressAsync` repairs the high-water mark on the next read. An admin grant that lowers the level and whose `trainer_level` write fails (or is overtaken by a racing level-up) leaves the stored stat high until the next admin take-back; a positive admin grant raises it with `MaxAsync` like any other grant. The derived level readers use is right throughout.
- On the rule path (`AwardAsync`), "nothing granted" is always `null` — whether the rule, the low-level guard or the trainer's modifiers brought the amount to 0. `GrantXpAsync` (the raw funnel) always returns a snapshot.
- A capture whose trainer-modifier read fails (not a cancellation) logs a warning and rolls with no modifiers; the throw is never failed by a modifier outage. The capture log line carries the battle id.
Level readers derive: `ConditionEvaluator` evaluates `TrainerLevel` from `trainer_xp` via `LevelForXpAsync`.

## Results on the wire

`trainerProgress` (`TrainerProgressResult?`: `xpGained, totalXp, oldLevel, newLevel, xpIntoLevel, xpForNextLevel (null at cap), availablePoints, needsRespec, trainerId`) is on `QuestClaimResult`, `QuestProgressResult`, `ActionOutcome` (winning action), `ItemUseResult` (capture) and `PickupCollectResult`. It is the before/after of one `TrainerProgressTracker` bracket around the operation's grants. `TrainerProgressionService.GrantCoreAsync` reads the talent build once at the level the grant starts from, and re-reads it (one more cheap indexed query) only when the grant itself crosses a level boundary — otherwise a same-call level-up would report the pre-grant `AvailablePoints`.

`GET .../progression`'s full `TrainerProgress` additionally carries `SpentPoints`, `NeedsRespec`, `Allocations` (`{talentId, rank}[]`, every row with `rank > 0` including ones current content no longer supports), `Modifiers` (`{effectType, value}[]`, summed and clamped, non-zero only) and `QuestLockedTalentIds` — see [Talents](25-talents.md).

## Routes

| Route | Auth | Notes |
|---|---|---|
| `GET /api/v1/trainers/{trainerId}/progression` | RequirePlayer (admin bypasses ownership) | 404 for another account's trainer |
| `GET /api/v1/world-locations` · `PUT …/world-locations/bulk` | any token · RequireContentWrite | bulk `{ locations[], replace }`; replace retires unnamed rows; empty replace refused |
| `GET/PUT /api/v1/trainer-progression/level-curve` | any token · RequireContentWrite | whole curve; levels 1..N, strictly increasing, L1 = 0 |
| `GET/PUT /api/v1/trainer-progression/xp-rules` | any token · RequireContentWrite | upsert by source key |
| `POST /api/v1/admin/trainers/{trainerId}/xp` | RequireAdmin | `{ amount, reason, respec? }`; negative allowed, never below 0, refused `409 WouldOverspendTalents` unless `respec`; audit `GrantTrainerXp` (16) |
| `POST /api/v1/quests/progress` | anonymous | **retired (410)** as of Phase E — no ownership check runs, every caller gets the same `route_retired` shape |

Talent spend/respec/admin set-rank routes, the talent tree content routes, and the Moderation
`SetTalentRank`/`RespecTalents` admin routes are documented on [Talents](25-talents.md), not here.

A refused content write answers 400 `{ message, problems[] }` and writes nothing.

## Offline floor

**Not shipped yet — no floor-seed migration exists in cr-api today.** Offline play runs on the M15002/M15003 defaults and has no world locations until one is exported. The migration (`M<version>SeedTalentContent_<date>`, version = repository max + 1, so `M15004SeedTalentContent_<date>` at the first export) is written by Crystalline Rift Studio (Trainer Progression → Export floor seed, or `cr_talent_content_export_seed`): locations from the Studio catalog (insert-if-absent, both engines, authored ids), the curve and rules copied from the configured server (SQLite only — Postgres is their source). The export needs a Studio content key for the server it reads (Local or Production). Rebake with `build-packages.sh`; `GameDataAdopter` re-adopts by content hash. The generator's exact output is executed on SQLite and Postgres by `CR.Data.Migrations.Test/TalentContentSeedGeneratedSql*Tests` (sample in `TalentSeedSample/`, regenerate it when the template changes).

## Effect on "locations visited" counting (superseded — see Location Discoveries v2)

**Current behavior:** the discovery gate is the `trainer_location_discovery` ledger, not a stat flag.
`locations_visited_total` and `location_discovered_{key}` are pure projections of the `LocationEntered`
outcome (`LifetimeStatProjector`), written **only for a genuine first-time discovery of an authored
`world_location`** — a repeat visit or an unauthored key earns nothing and writes nothing. See
[Location Discoveries](?page=backend/24-location-discoveries) for the ledger, the XP/quest claims and the
idempotency rules; `TrainerProgressionService.AwardAsync` no longer holds a location gate or a stat write
at all — both were deleted in that change, along with the flag-rollback logic this section used to describe.

There was never a recount or backfill across that change: the game is not live, so there are no legacy
raw-counted players to repair.

## Deploy prerequisites

- **Required, before or with the API deploy that ships this feature** (or location progression
  stalls silently): push the authored world locations to Production (Crystalline Rift Studio → Trainer Progression →
  Push locations) — until `world_location` is populated on Production, no discovery earns XP, the
  `explorer` achievement never unlocks, and the Journal's "locations visited" count never advances,
  with no error surfaced to the player.
- Optional: `ConnectionStrings__TalentDatabase` in `/opt/cr/.env`. Without it the API falls back to
  the `StatDatabase` connection string (one `[startup]` log line says so); set it only to point the
  Talents tables somewhere else.

## Admin web (World Locations)

The cr-admin-web **World Locations** editor reads the server's locations and can tweak names,
`discoveryXp` (number, blank/NaN → "use rule default") and `discoveryQuestKey` (a quest picker, by
content key) — never `area_key`, which is authored only. The Studio's **Push locations** writes the
whole catalog with `replace: true`: it retires every row the catalog doesn't name — a location created
in the admin editor is gone on the next Studio push — and writes the catalog's values (name, XP, quest
key) over any admin edit. Add, rename or retire locations in the Studio catalog; an admin tweak is a
stopgap until the next push, or until it is pulled back into the catalog (Studio "Pull tuning from
server" — see [Location Discoveries — Admin / authoring](?page=backend/24-location-discoveries#admin-authoring)).

## Pitfalls

- A tuning change on the server reaches offline play only after export + rebake + a client build.
- Never tune by editing M15002/M15003: their seeds are insert-if-absent and change nothing on an existing DB.
- The exporter copies the server the Studio points at — Local copies local values.
- **Never retire the `CaptureFirstSpecies` row from `trainer_xp_rule` while live.** `AwardAsync` reads the
  first-time marker (`species_captured_{id:N}`) **before** deciding the bonus, but the marker's own
  increment is now a separate write — `LifetimeStatProjector`, from the `CreatureCaptured` outcome the
  capture call records right after the award — that lands later in the same call, after the award has
  already read and used the pre-capture count. If the `CaptureFirstSpecies` rule is missing (or removed)
  when a player crosses that first-time moment, the read still comes back 0, the grant still silently
  no-ops (no rule to pay), and the marker still gets incremented moments later regardless — that player's
  first-capture bonus is gone for good, because the marker now reads "already awarded" on every future
  capture of that species. The location
  equivalent has the same shape but a different gate: the `trainer_location_discovery.xp_awarded` claim
  (not `location_discovered_{key}`) is what flips at-most-once — see
  [Location Discoveries — Idempotency](?page=backend/24-location-discoveries#idempotency). Retiring the
  `LocationDiscovered` rule (or leaving a location's `discovery_xp` unset with no rule) loses that
  discovery's XP the same way, permanently, once the claim wins.
