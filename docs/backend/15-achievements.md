# Achievements

Achievements unlock when a trainer does something — wins a battle, captures or defeats a creature, collects items, completes a quest, visits a location, talks to an NPC, or reaches a creature level. Each unlock **records a per-trainer badge** and **grants zero or more rewards** (reusing the shared reward core). Achievements are **content** — authored on the backend, baked into `game-data.bytes`, and synced like loot, pickups, items, and spawners.

## Concepts

- **Achievement definition** (`achievement_definition`) — content owned by a `content_key`: `name`, `description`, `icon_asset_key`, a `trigger_type`, an optional `trigger_reference_key`, a `threshold` (default 1), and a `hidden` flag. Lives in the **GameData** (content) database.
- **Achievement reward** (`achievement_reward`) — child rows of a definition: a `reward_type` (string: `Experience` | `Currency` | `Item` | `Creature`), an optional `reference_key` (content_key of an item/creature-spawner), and a `quantity`. A definition with zero rewards is a bragging-rights-only badge. Mirrors the `loot_entry` child-table shape.
- **Achievement unlocked** (`achievement_unlocked`) — per-trainer state in the **PlayerData** database: one append-only, idempotent row per `(account_id, trainer_id, achievement_id)`. Revive-on-write upsert (like `pickup_collected`) so a reset can re-fire, and a re-trigger never double-grants.
- **Trigger types** (`AchievementTriggerType`) map 1:1 to existing lifetime `StatKey`s and to `QuestObjectiveType` gameplay events: `BattleWon`, `CreatureCaptured`, `CreatureDefeated`, `ItemCollected`, `QuestCompleted`, `LocationVisited`, `NpcTalkedTo`, `CreatureLevelReached`. Only the "any" event of a family maps (`DefeatAnyCreature` → `CreatureDefeated`, `CaptureAnyCreature` → `CreatureCaptured`); the specific and list events (`DefeatCreature`, `DefeatCreaturesFromList`, `CaptureCreature`, and the trainer types 40–42) map to nothing, so one deed is evaluated once. There is no trainer-defeat trigger yet.

## Counting model

Achievements do **not** keep a parallel counter. Progress is read from the **Stats** system, which the quest progress funnel already increments for every gameplay event. A `threshold` of `1` is a binary "did it once" achievement; higher thresholds (e.g. "collect 10 items") are satisfied when the mapped lifetime stat aggregate reaches the threshold.

Referenced achievements (`trigger_reference_key` set, e.g. "collect item X") are restricted to `threshold == 1` in this version, because no per-reference Stat counter exists — referenced + count achievements are deferred.

### Quest categories and areas (contract from sub-project 3)

| Item | Value |
|---|---|
| Counter keys | `quests_completed_cat_{bonus\|main_story\|exploration\|battle\|talent}` in `trainer_stat` |
| Written by | The authority only: `LifetimeStatProjector` on `QuestCompleted`, once per won completion CAS, next to `quests_completed` (server online, the same DLL offline) |
| Semantics | Completions, not claims. A ReturnToGiver quest counts when its objectives complete, and a repeatable quest counts once per completion |
| Outcome facts | `Facts[Category]` (slug), `Facts[AreaKey]` (the quest's `area_key`, when set), from the server's template row |
| Evaluation | No per-service call: the dispatcher evaluates achievements once per drained call |

See [Quest System → Quest categories and area key](07-quest-system.md#quest-categories-and-area-key) for the
column, write and backfill contract.

## Evaluation

`IAchievementDomainService.EvaluateAsync(accountId, trainerId, triggerType, referenceKey?, ct)` (in `CR.Achievements.Domain.Services`, defined in `CR.Achievements.Data` to keep it cycle-free):

1. Load definitions matching `triggerType` (and `referenceKey` when the definition specifies one).
2. Read the current Stats aggregates **once** via `IStatService.GetAllAsync` (not one call per definition).
3. For each not-yet-unlocked definition whose mapped stat value `>= threshold`: perform the atomic unlock and, **only when this call won the insert/revive**, grant each reward via `IRewardGrantService`.
4. Return the definitions newly unlocked by this call.

The "did-I-win-the-insert" semantics (`changes()` after a guarded `INSERT OR IGNORE`/revive on SQLite; `ON CONFLICT … WHERE deleted = true RETURNING true` on Postgres) are what make re-evaluation safe — `IRewardGrantService.GrantAsync` is not itself idempotent, so rewards must be tied to the single call that actually transitioned the row.

## Where evaluation runs

Achievements are evaluated **once per root call of the progress dispatcher**, after its outcome queue drains
(see [Progress Dispatcher](?page=backend/23-progress-dispatcher)). Phase B's `TriggerAchievementStep` calls
`EvaluateAsync` once per distinct (trigger, subject) in the drained batch — `BattleWon`, `CreatureCaptured`,
`CreatureDefeated`, `ItemCollected`, `QuestCompleted` (at completion, not claim), `LocationEntered` →
`LocationVisited`, a **first** talk → `NpcTalkedTo`. Unlocks travel as `AchievementUnlockNotice`s in
`ProgressReport.NewlyUnlocked` (and in the compat route's `QuestProgressResult.NewlyUnlocked`); a claim carries
none. Domain services never call the evaluator themselves; sub-project #4 replaces the step with its
evaluate-all-unearned evaluator. The client never posts an unlock (the route is retired; the Unity router
refuses an online client-evaluated unlock).

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

Since trainer progression (2026-09-26) wired the Talents domain, `explorer`'s mapped stat
(`locations_visited_total`) is written by `TrainerProgressionService.AwardAsync`, not by
`QuestDomainService` directly — only for a genuine, first-time discovery of an *authored*
`world_location`. A repeat visit or an unauthored reference key no longer moves it, whereas every
`VisitLocation` event used to count. See [Trainer Progression — Effect on "locations visited"
counting](?page=backend/22-trainer-progression#effect-on-locations-visited-counting) for the detail,
including why there is no recount for existing players.

## Unity client

- `IAchievementService` (`Assets/CR/Achievements/`) owns achievements on the client: `Unlocked`, the definition and unlock reads, and `ReportUnlocks`. Unlocks still ARRIVE on quest results (`QuestProgressResult.NewlyUnlocked` and the claim result), so `QuestManager` is the reporter: it calls `ReportUnlocks` where it used to raise its own `OnAchievementUnlocked` event (removed). Anything interested in achievements depends on `IAchievementService`, not on the quest service. A subscriber that throws is logged and does not stop the other subscribers or the claim.
- Toasts go through `INotificationService` (`Assets/CR/Core/Notifications/`). `AchievementToastPresenter` is only the renderer: one queue (capped at 8 pending, oldest dropped), one UIDocument, one dismiss timer, passive (`PickingMode.Ignore`, no input gating). It is **code-created** by a non-lazy binding in `LocalDevGameInstaller` (it prefers a scene-placed instance if one exists); until 2026-09-20 it was attached to no scene at all, so no toast ever rendered. Three small adapters translate domain events into toasts: `AchievementUnlockToastAdapter` (`IAchievementService.Unlocked`), `QuestGrantToastAdapter` (`IQuestService.OnQuestGranted`, the "New quest" toast — see `docs/backend/07-quest-system.md#new-quest-toast-and-dedup`) and `AbilityUnlockToastAdapter` (`IProgressionNotifier.AbilitiesUnlocked`, the "New ability learned!" toast — one per claim, not per creature; see `docs/unity/26-creature-storage.md`). The static `WorldToast.Show` (pickups, shop, market, evolution) forwards into the same service.
- **The kind decides the chrome** (`ToastChrome.For(ToastKind)`, pure, `Assets/CR/Core/Notifications/ToastChrome.cs`, since 2026-09-23). Only `Achievement` carries the "Achievement Unlocked" heading; every other kind shows its message alone, so a pickup no longer reads as an achievement. `Info` (what `WorldToast` raises: "Picked up 3 x Heal Potion") flashes bottom-left for 2.2 s; everything else sits **centred on the top edge** for 3.5 s (top-right until 2026-09-26; the card is also ~25% smaller since then, `left: 50%` + `translate: -50% 0` keeps it centred whatever the message measures). A request may carry its own heading (`ToastRequest.Title`, since 2026-09-26): the quest adapters send "New Quest" / "Quest Complete" over the quest name so a quest toast is the same two-line card as an achievement, and the card has a `min-height` so a one-line pickup matches too. One template (`AchievementToast.uxml`): the presenter fills or hides the `title` label, toggles `achievement-toast--bottom-left`, and adds `achievement-toast--shown` a frame after insertion so the 0.15 s opacity transition plays both ways.
- `LocationTriggerBehaviour` is a scene-placed passive trigger (modeled on `PickupBehaviour`) that calls `QuestManager.OnLocationVisited(contentKey)` — the first consumer of that previously-unused helper — driving `LocationVisited` achievements.
- The player menu's **Achievements** tab (`Assets/CR/UI/Achievements/AchievementsView.cs`, replaces the
  old Journal tab) is a WoW-style rail (Summary, categories, Statistics) over
  `AchievementBoardProjection`. It reads two Unity-only seam interfaces — `IAchievementCatalogReader`
  and `IAchievementBoardReader` — which are **real adapters over the services above**, not fakes:
  `AchievementCatalogReader` wraps `IAchievementService.GetAllDefinitionsAsync` (the same read the old
  Journal tab made), and `AchievementBoardReader` wraps `IAchievementService.GetUnlockedAsync` plus
  `IStatService.GetAllAsync`. Since `achievement_category`/`achievement_criterion`/`points` don't exist
  yet (see Counting model v1/v2 below — this is the Unity-only lane, ahead of the server phase), every
  achievement is filed under one shared "General" category, given 0 points, and given exactly one
  criterion built from its legacy `threshold`/`TriggerType` (`AchievementStatKeyMapper` for the stat,
  `StatKeyFormatter` for the label). The board's per-criterion progress and `UnlockedAt` are real,
  read the same way the evaluation check reads them, so the bar cannot disagree with an unlock; the
  unlock *record* is authoritative, not the stat, and `Hidden` definitions stay off every list and bar
  until earned. Once the server phase (categories, criteria, points, the board route) ships, both
  interfaces rebind to a GameData-backed catalog reader and the real online/offline board router with
  no tab code change. The rail's **Statistics** entry (folds in the old Journal Records section) reads
  `IStatService.GetAllAsync` directly for the trainer's raw lifetime `StatKey` totals.
- Crystalline Rift Studio authoring for achievement definitions is still deferred.

## Migration ranges

- `M7300` `achievement_definition`, `M7301` `achievement_reward`, `M7302` `achievement_unlocked`, `M7303` seed.
- `M9993` content-schema bump (no-op; global max version).
