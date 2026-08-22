# Achievements

Achievements unlock when a trainer does something — wins a battle, captures or defeats a creature, collects items, completes a quest, visits a location, talks to an NPC, or reaches a creature level. Each unlock **records a per-trainer badge** and **grants zero or more rewards** (reusing the shared reward core). Achievements are **content** — authored on the backend, baked into `game-data.bytes`, and synced like loot, pickups, items, and spawners.

## Concepts

- **Achievement definition** (`achievement_definition`) — content owned by a `content_key`: `name`, `description`, `icon_asset_key`, a `trigger_type`, an optional `trigger_reference_key`, a `threshold` (default 1), and a `hidden` flag. Lives in the **GameData** (content) database.
- **Achievement reward** (`achievement_reward`) — child rows of a definition: a `reward_type` (string: `Experience` | `Currency` | `Item` | `Creature`), an optional `reference_key` (content_key of an item/creature-spawner), and a `quantity`. A definition with zero rewards is a bragging-rights-only badge. Mirrors the `loot_entry` child-table shape.
- **Achievement unlocked** (`achievement_unlocked`) — per-trainer state in the **PlayerData** database: one append-only, idempotent row per `(account_id, trainer_id, achievement_id)`. Revive-on-write upsert (like `pickup_collected`) so a reset can re-fire, and a re-trigger never double-grants.
- **Trigger types** (`AchievementTriggerType`) map 1:1 to existing lifetime `StatKey`s and to `QuestObjectiveType` gameplay events: `BattleWon`, `CreatureCaptured`, `CreatureDefeated`, `ItemCollected`, `QuestCompleted`, `LocationVisited`, `NpcTalkedTo`, `CreatureLevelReached`.

## Counting model

Achievements do **not** keep a parallel counter. Progress is read from the **Stats** system, which the quest progress funnel already increments for every gameplay event. A `threshold` of `1` is a binary "did it once" achievement; higher thresholds (e.g. "collect 10 items") are satisfied when the mapped lifetime stat aggregate reaches the threshold.

Referenced achievements (`trigger_reference_key` set, e.g. "collect item X") are restricted to `threshold == 1` in this version, because no per-reference Stat counter exists — referenced + count achievements are deferred.

## Evaluation

`IAchievementDomainService.EvaluateAsync(accountId, trainerId, triggerType, referenceKey?, ct)` (in `CR.Achievements.Domain.Services`, defined in `CR.Achievements.Data` to keep it cycle-free):

1. Load definitions matching `triggerType` (and `referenceKey` when the definition specifies one).
2. Read the current Stats aggregates **once** via `IStatService.GetAllAsync` (not one call per definition).
3. For each not-yet-unlocked definition whose mapped stat value `>= threshold`: perform the atomic unlock and, **only when this call won the insert/revive**, grant each reward via `IRewardGrantService`.
4. Return the definitions newly unlocked by this call.

The "did-I-win-the-insert" semantics (`changes()` after a guarded `INSERT OR IGNORE`/revive on SQLite; `ON CONFLICT … WHERE deleted = true RETURNING true` on Postgres) are what make re-evaluation safe — `IRewardGrantService.GrantAsync` is not itself idempotent, so rewards must be tied to the single call that actually transitioned the row.

## Quest-funnel integration

Achievement evaluation rides the quest progress funnel — the same typed round-trip the client already uses — rather than adding a parallel path:

- `QuestDomainService` takes an **optional, nullable** `IAchievementDomainService` (mirroring how it consumes `IRewardGrantService` from `CR.Game.Model`, and how `BattleDomainService` takes an optional loot service). Quests builds and runs with the dependency absent.
- After `RecordProgressEventAsync` writes the lifetime stat (`UpdateLifetimeStatsAsync`), it maps the `QuestObjectiveType` to an `AchievementTriggerType`, calls `EvaluateAsync`, and accumulates the result on `QuestProgressResult.NewlyUnlocked`. `ClaimRewardsAsync` evaluates `QuestCompleted` after writing the `QuestsCompleted` stat and surfaces unlocks on `QuestClaimResult.NewlyUnlocked`.

Because evaluation runs inside the domain service, **online and offline behave identically**: online the server evaluates and returns `NewlyUnlocked` in the `/progress` response; offline the same `QuestDomainService` runs against local SQLite and returns the same payload.

## Online / offline & content sync

Achievements follow the one content-sync standard:

- **Backend authoritative** — definitions + rewards authored on the server (`GET /api/v1/achievements` for pull; `GET /api/v1/achievements/trainer/{id}?accountId=` for a trainer's unlocked set).
- **Baked offline copy** — the definition/reward tables and seed ship inside `game-data.bytes`. Migrations `M7300`–`M7303` create the three tables and seed the starter achievements; `M9993` is a no-op content-schema bump that makes `GameDataAdopter` adopt the new content (it must be the global `MAX(Version)`).
- **PlayerData split** — `achievement_unlocked` is per-trainer writable state and lives in the player database, never the read-only baked content image. Definitions (GameData) and unlocked rows (PlayerData) are loaded by separate repositories and **joined in application code** — never across the two physical databases.

## Starter content

Seeded by `M7303SeedAchievements` (idempotent, dual-engine):

| content_key | trigger | threshold | reward |
|---|---|---|---|
| `first_victory` | BattleWon | 1 | Currency 100 |
| `first_capture` | CreatureCaptured | 1 | Item (capture crystal) |
| `scavenger` | ItemCollected | 10 | Currency 250 |
| `explorer` | LocationVisited | 3 | Experience 200 |
| `questing_begins` | QuestCompleted | 1 | Item (heal potion) |

## Unity client

- `QuestManager` re-broadcasts `OnAchievementUnlocked` from `QuestProgressResult.NewlyUnlocked` (and the claim result), so unlocks surface from the same event flow as quest completions.
- `AchievementToastPresenter` shows a transient "Achievement Unlocked" toast on that event (auto-dismiss; no input-map gating).
- `LocationTriggerBehaviour` is a scene-placed passive trigger (modeled on `PickupBehaviour`) that calls `QuestManager.OnLocationVisited(contentKey)` — the first consumer of that previously-unused helper — driving `LocationVisited` achievements.
- The player menu's **Journal** tab (`Assets/CR/UI/Journal/JournalView.cs`) is the trophy list. It reads
  `IAchievementDomainService.GetAllDefinitionsAsync` (content) plus `GetUnlockedForTrainerAsync`
  (player state) and joins them in app code — never across the two physical databases. Progress per
  row is the trainer's value of the stat the trigger maps to, resolved through the **same**
  `AchievementStatKeyMapper` the unlock check uses, so the bar cannot disagree with the evaluation.
  The unlock *record* is authoritative for the badge: lowering or raising a `threshold` by a content
  edit never re-locks an already-earned achievement. `Hidden` definitions stay off the list until
  earned. The same tab's **Records** section lists the trainer's raw lifetime `StatKey` totals.
- Content Studio authoring for achievement definitions is still deferred.

## Migration ranges

- `M7300` `achievement_definition`, `M7301` `achievement_reward`, `M7302` `achievement_unlocked`, `M7303` seed.
- `M9993` content-schema bump (no-op; global max version).
