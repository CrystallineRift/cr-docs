# Trainer Progression (Phase 1: Trainer Level)

The player's trainer earns XP for what they do and levels up on an admin-editable curve (cap 30). Each
level from 2 grants a talent point (spent from Phase 2). Spec: `cr-api-unity/docs/superpowers/specs/2026-09-26-trainer-progression-design.md`.

## Where things live

| Piece | Location |
|---|---|
| Contracts | `Game/CR.Game.Model/Progression/` — `ITrainerProgressionService`, `TrainerProgress`, `TrainerProgressResult`, `TrainerXpAward`, `TrainerXpSource`, `TrainerModifiers`, `ITrainerModifierProvider`, `TrainerProgressTracker`, `TalentEffectType` |
| Domain | `Talents/` — `CR.Talents.Data(.Sqlite/.Postgres/.Migration/.Migration.Postgres)`, `.Domain.Services` (`TrainerProgressionService`, `TrainerLevelCurve`, `TrainerXpRuleMath`, `TrainerProgressionContentValidation`, `NoTalentModifierProvider`), `.Model.REST`, `.Service.REST` |
| Connection string | `TalentDatabase` (**prod: `ConnectionStrings__TalentDatabase` in `/opt/cr/.env` before the first deploy**) |
| Migrations | M15001 `world_location`, M15002 `trainer_level_requirement` (+ L1–30 seed), M15003 `trainer_xp_rule` (+ 6 rules), M15004 floor seed (exported) |

## Data

- `trainer_level_requirement(level UNIQUE, required_xp)` — cumulative XP per level; seed `40·(L−1)² + 60·(L−1)` (L2 100, L5 880, L10 3,780, L20 15,580, L30 35,380). Cap = highest live level.
- `trainer_xp_rule(source_key UNIQUE, base_xp, multiplier, low_level_threshold?, low_level_factor?)` — `source_key` is a rule-driven `TrainerXpSource` name. Amount = `round(base × units × multiplier)`, × factor when `trainerLevel − opponentLevel ≥ threshold`.
- `world_location(content_key UNIQUE, name, area_key)` — only these keys earn discovery XP.
- XP lives in the `trainer_xp` stat; `trainer_level` is a monotonic high-water mark (repaired by `GetProgressAsync`). First-time checks are per-key stats: `location_discovered_{key}`, `species_captured_{baseCreatureId:N}` (`IStatService.IncrementAsync` returns the value after; 1 = first).
- Seeds are insert-if-absent: re-running never overwrites an admin edit.
- These four keys — `trainer_xp`, `trainer_level`, `location_discovered_{key}`, `species_captured_{id:N}` — are **server-owned**: the player-facing stat write routes (`POST /api/v1/stats/increment|max|set`) refuse them with `403 Forbidden` (`ServerOwnedStatKeys.Contains`, matched by exact name or prefix). Only server-side code writes them, through the progression funnel or the admin XP grant — never a client stat call. See [Stats and Lifetime Tracking](?page=backend/08-stats-system).

## Sources

| Source | Where | Units | Seed rule | Retry-safe because |
|---|---|---|---|---|
| Reward (quest, achievement, loot, pickup reward lists) | `RewardGrantService` → `GrantXpAsync(Reward)` | as authored | — | the owner's one-time transition |
| Wild / trainer win | `BattleDomainService` on the winning action | `BattleRewardScaling.ExperienceForDefeatedLevel(final KO level)` | 1 × 1.0 (1.5 trainer), guard 10 / 0.25 | battle row → Ended |
| Capture (+ first of species) | `CaptureAttemptService` after the ownership transition | creature level | 10 (+50) | the creature is no longer wild |
| Location discovered | `QuestDomainService.RecordProgressEventAsync` on `VisitLocation` | 1 | 25 | `location_discovered_{key}` must be 1; unknown keys earn 0 |
| Pickup collected | `PickupDomainService.CollectAsync` after the claim | 1 | 5 | pickup_collected claim |

XP never fails the owning operation (`SafeAwardAsync`, `TrainerProgressTracker` log and return null).
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

`M15004SeedTalentContent_<date>` is written by Crystalline Rift Studio (Trainer Progression → Export floor seed, or `cr_talent_content_export_seed`): locations from the Studio catalog (insert-if-absent, both engines, authored ids), the curve and rules copied from the configured server (SQLite only — Postgres is their source). Rebake with `build-packages.sh`; `GameDataAdopter` re-adopts by content hash.

## Effect on "locations visited" counting

Wiring Talents changes what counts toward the `locations_visited_total` lifetime stat (and so the
`explorer` achievement, see [Achievements](?page=backend/15-achievements)): `QuestDomainService` now defers that
increment to `TrainerProgressionService.AwardAsync`, which writes it **only for a genuine first-time
discovery of an authored `world_location`** — a repeat visit or an unauthored `referenceId` earns
nothing. Before this, every `VisitLocation` event counted, so a player who revisited an already-known
location or triggered an unauthored key had an inflated total. There is no backfill for the old
inflated counts; an existing player's stat re-settles to the true discovery count on their next
genuinely-new location visit (a one-time recount, not a jump). If `ITrainerProgressionService` isn't
wired at all, `QuestDomainService` falls back to the old raw per-event increment.

## Deploy prerequisites

Both of these must land **before or with** the API deploy that ships this feature, or trainer
progression stalls silently for players who reach it:

- Append `ConnectionStrings__TalentDatabase` to `/opt/cr/.env` (copy of the `StatDatabase` value) —
  `BaseRepository` throws on a missing connection-string key.
- Push the authored world locations to Production (Crystalline Rift Studio → Trainer Progression →
  Push locations) — until `world_location` is populated on Production, no discovery earns XP, the
  `explorer` achievement never unlocks, and the Journal's "locations visited" count never advances,
  with no error surfaced to the player.

## Pitfalls

- A tuning change on the server reaches offline play only after export + rebake + a client build.
- Never tune by editing M15002/M15003: their seeds are insert-if-absent and change nothing on an existing DB.
- The exporter copies the server the Studio points at — Local copies local values.
- **Never retire the `LocationDiscovered` or `CaptureFirstSpecies` rows from `trainer_xp_rule` while
  live.** The first-time marker (`location_discovered_{key}` / `species_captured_{id:N}`) is written
  by `AwardAsync` **before** the XP grant, as the gate that makes the award at-most-once. If the rule
  is missing (or removed) when a player crosses that first-time moment, the marker is still written,
  the grant silently no-ops, and that player's discovery/first-capture bonus is gone for good — there
  is no second chance, because the marker already reads as "already awarded."
