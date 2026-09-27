# Trainer Progression (Phase 1: Trainer Level)

The player's trainer earns XP for what they do and levels up on an admin-editable curve (cap 30). Each
level from 2 grants a talent point (spent from Phase 2). Spec: `cr-api-unity/docs/superpowers/specs/2026-09-26-trainer-progression-design.md`.

## Where things live

| Piece | Location |
|---|---|
| Contracts | `Game/CR.Game.Model/Progression/` — `ITrainerProgressionService`, `TrainerProgress`, `TrainerProgressResult`, `TrainerXpAward`, `TrainerXpSource`, `TrainerModifiers`, `ITrainerModifierProvider`, `TrainerProgressTracker`, `TalentEffectType` |
| Domain | `Talents/` — `CR.Talents.Data(.Sqlite/.Postgres/.Migration/.Migration.Postgres)`, `.Domain.Services` (`TrainerProgressionService`, `TrainerLevelCurve`, `TrainerXpRuleMath`, `TrainerProgressionContentValidation`, `NoTalentModifierProvider`), `.Model.REST`, `.Service.REST` |
| Connection string | `TalentDatabase`; when the key is absent the API uses the `StatDatabase` connection string and logs `[startup] ConnectionStrings:TalentDatabase is not set; …` once (`TalentDatabaseFallbackExtensions`, `CR.REST.AIO`) |
| Migrations | M15001 `world_location`, M15002 `trainer_level_requirement` (+ L1–30 seed), M15003 `trainer_xp_rule` (+ 6 rules). The floor seed (M15004 at first export) is **not shipped yet** — see [Offline floor](#offline-floor) |

## Data

- `trainer_level_requirement(level UNIQUE, required_xp)` — cumulative XP per level; seed `40·(L−1)² + 60·(L−1)` (L2 100, L5 880, L10 3,780, L20 15,580, L30 35,380). Cap = highest live level.
- `trainer_xp_rule(source_key UNIQUE, base_xp, multiplier, low_level_threshold?, low_level_factor?)` — `source_key` is a rule-driven `TrainerXpSource` name. Amount = `round(base × units × multiplier)`, × factor when `trainerLevel − opponentLevel ≥ threshold`.
- `world_location(content_key UNIQUE, name, area_key)` — only these keys earn discovery XP.
- XP lives in the `trainer_xp` stat; `trainer_level` is a display/achievement high-water mark that `GetProgressAsync` converges to the derived level on every read — up with `MaxAsync`, and down with `SetAsync` when it reads above what the XP supports (an admin take-back raced by a play grant's late level-up `MaxAsync`, or a curve edit). First-time checks are per-key stats: `location_discovered_{key}`, `species_captured_{baseCreatureId:N}` (`IStatService.IncrementAsync` returns the value after; 1 = first).
- Seeds are insert-if-absent: re-running never overwrites an admin edit.
- These four keys — `trainer_xp`, `trainer_level`, `location_discovered_{key}`, `species_captured_{id:N}` — are **server-owned**: the player-facing stat write routes (`POST /api/v1/stats/increment|max|set`) refuse them with `403 Forbidden` (`ServerOwnedStatKeys.Contains`, matched trimmed and case-insensitively by exact name or prefix). The write routes also refuse any key with leading or trailing whitespace (`400`), since a padded key would be stored as its own row nobody reads. Only server-side code writes them, through the progression funnel or the admin XP grant — never a client stat call. See [Stats and Lifetime Tracking](?page=backend/08-stats-system).

## Sources

| Source | Where | Units | Seed rule | Retry-safe because |
|---|---|---|---|---|
| Reward (quest, achievement, loot, pickup reward lists) | `RewardGrantService` → `GrantXpAsync(Reward)` | as authored | — | the owner's one-time transition |
| Wild / trainer win | `BattleDomainService` on the winning action | `BattleRewardScaling.ExperienceForDefeatedLevel(final KO level)` | 1 × 1.0 (1.5 trainer), guard 10 / 0.25 | battle row → Ended |
| Capture (+ first of species) | `CaptureAttemptService` after the ownership transition | creature level | 10 (+50) | the creature is no longer wild |
| Location discovered | `QuestDomainService.RecordProgressEventAsync` on `VisitLocation` | 1 | 25 | `location_discovered_{key}` must be 1; unknown keys earn 0 |
| Pickup collected | `PickupDomainService.CollectAsync` after the claim | 1 | 5 | pickup_collected claim |

XP never fails the owning operation:

- Source awards go through `SafeAwardAsync` and the `TrainerProgressTracker` bracket, which log and return null on failure. After the owning operation has committed (capture ownership, battle → Ended, pickup claim) they run with `CancellationToken.None`, so a client disconnect can neither lose the award nor turn a committed operation into an error. Cancellation *before* the commit still propagates.
- Reward XP: `RewardGrantService` catches a non-cancellation failure from `GrantXpAsync`, logs it and pays the amount as a raw `trainer_xp` increment instead, so a quest claim, pickup reward list or achievement reward is never aborted half-paid (a retried claim would re-pay its items). This pays the XP exactly once because `GrantXpAsync` does everything that can throw *before* its `trainer_xp` increment.
- The `trainer_level` write after the increment is best-effort and uncancellable: if it fails the grant still returns (logged as an error) and `GetProgressAsync` repairs the high-water mark on the next read. An admin grant that lowers the level and whose `trainer_level` write fails (or is overtaken by a racing level-up) leaves the stored stat high only until the next progress read, which sets it back down — the derived level readers use is right throughout.
- On the rule path (`AwardAsync`), "nothing granted" is always `null` — whether the rule, the low-level guard or the trainer's modifiers brought the amount to 0. `GrantXpAsync` (the raw funnel) always returns a snapshot.
- A capture whose trainer-modifier read fails (not a cancellation) logs a warning and rolls with no modifiers; the throw is never failed by a modifier outage. The capture log line carries the battle id.
Level readers derive: `ConditionEvaluator` evaluates `TrainerLevel` from `trainer_xp` via `LevelForXpAsync`.

## Results on the wire

`trainerProgress` (`TrainerProgressResult?`: `xpGained, totalXp, oldLevel, newLevel, xpIntoLevel, xpForNextLevel (null at cap), availablePoints, needsRespec, trainerId`) is on `QuestClaimResult`, `QuestProgressResult`, `ActionOutcome` (winning action), `ItemUseResult` (capture) and `PickupCollectResult`. It is the before/after of one `TrainerProgressTracker` bracket around the operation's grants.

## Routes

| Route | Auth | Notes |
|---|---|---|
| `GET /api/v1/trainers/{trainerId}/progression` | RequirePlayer (admin bypasses ownership) | 404 for another account's trainer |
| `GET /api/v1/world-locations` · `PUT …/world-locations/bulk` | any token · RequireContentWrite | bulk `{ locations[], replace }`; replace retires unnamed rows; empty replace refused |
| `GET/PUT /api/v1/trainer-progression/level-curve` | any token · RequireContentWrite | whole curve; levels 1..N, strictly increasing, L1 = 0 |
| `GET/PUT /api/v1/trainer-progression/xp-rules` | any token · RequireContentWrite | upsert by source key |
| `POST /api/v1/admin/trainers/{trainerId}/xp` | RequireAdmin | `{ amount, reason }`; negative allowed, never below 0; audit `GrantTrainerXp` (16) |
| `POST /api/v1/quests/progress` | player | now 404 for another account's trainer |

A refused content write answers 400 `{ message, problems[] }` and writes nothing.

## Offline floor

**Not shipped yet — no floor-seed migration exists in cr-api today.** Offline play runs on the M15002/M15003 defaults and has no world locations until one is exported. The migration (`M<version>SeedTalentContent_<date>`, version = repository max + 1, so `M15004SeedTalentContent_<date>` at the first export) is written by Crystalline Rift Studio (Trainer Progression → Export floor seed, or `cr_talent_content_export_seed`): locations from the Studio catalog (insert-if-absent, both engines, authored ids), the curve and rules copied from the configured server (SQLite only — Postgres is their source). The export needs a Studio content key for the server it reads (Local or Production). Rebake with `build-packages.sh`; `GameDataAdopter` re-adopts by content hash. The generator's exact output is executed on SQLite and Postgres by `CR.Data.Migrations.Test/TalentContentSeedGeneratedSql*Tests` (sample in `TalentSeedSample/`, regenerate it when the template changes).

## Effect on "locations visited" counting

Wiring Talents changes what counts toward the `locations_visited_total` lifetime stat (and so the
`explorer` achievement, see [Achievements](?page=backend/15-achievements)): `QuestDomainService` now defers that
increment to `TrainerProgressionService.AwardAsync`, which writes it **only for a genuine first-time
discovery of an authored `world_location`** — a repeat visit or an unauthored `referenceId` earns
nothing. Before this, every `VisitLocation` event counted, so a player who revisited an already-known
location or triggered an unauthored key had an inflated total. **There is no recount and no backfill:**

- An existing player's old, inflated `locations_visited_total` stays as it is; it only grows from there.
- `location_discovered_{key}` has no backfill either, so every authored place a player visited *before*
  this release counts as a first discovery on their first revisit: +25 XP (the `LocationDiscovered`
  rule) and +1 to `locations_visited_total`, once per place.

The count is written right after the discovery flag, **before and independent of** the XP grant, and
everything after the flag commits ignores request cancellation: a failed or missing `LocationDiscovered`
rule never drops a genuine discovery's count (the award returns null). If the count write itself fails, the
flag is rolled back (`-1`, logged) so the next visit is still a first visit and counts it — exactly once per
authored key.

If `ITrainerProgressionService` isn't
wired at all, `QuestDomainService` falls back to the old raw per-event increment.

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

The cr-admin-web **World Locations** editor is for reading the server's locations and tweaking names
only. The Studio's **Push locations** writes the whole catalog with `replace: true`: it retires every
row the catalog doesn't name — a location created in the admin editor is gone on the next Studio
push — and writes the catalog's names over any admin rename. Add, rename or retire locations in the
Studio catalog; an admin tweak is a stopgap until the next push.

## Pitfalls

- A tuning change on the server reaches offline play only after export + rebake + a client build.
- Never tune by editing M15002/M15003: their seeds are insert-if-absent and change nothing on an existing DB.
- The exporter copies the server the Studio points at — Local copies local values.
- **Never retire the `LocationDiscovered` or `CaptureFirstSpecies` rows from `trainer_xp_rule` while
  live.** The first-time marker (`location_discovered_{key}` / `species_captured_{id:N}`) is written
  by `AwardAsync` **before** the XP grant, as the gate that makes the award at-most-once. If the rule
  is missing (or removed) when a player crosses that first-time moment, the marker is still written,
  the grant silently no-ops (a location discovery still counts toward `locations_visited_total`), and that player's discovery/first-capture bonus is gone for good — there
  is no second chance, because the marker already reads as "already awarded."
