# Achievements

Achievements unlock when a trainer's lifetime stats cross authored thresholds — battles won, creatures
captured, locations discovered, quests completed, trainer level, or another achievement already earned
(a meta chain). Each unlock **records a per-trainer badge**, **grants zero or more rewards** (the shared
reward core), and **pays authored points as trainer XP**. Achievements are **content** — authored on the
backend (or via cr-admin-web), baked into `game-data.bytes`, and synced like loot, pickups, items, and
spawners. This page describes the **v2 model** (categories, multi-criterion achievements, points, the
authority-computed board); see [Migration ranges](#migration-ranges) for how v1 content became v2.

## Concepts

- **Achievement category** (`achievement_category`) — a content row on the achievement rail: `content_key`,
  `name`, an optional `parent_category_id` (**one level of nesting only** — a grandchild is a validation
  error), `sort_order`, `icon_asset_key`. Seeded categories (`M18005`): `trainer`, `quests`, `exploration`,
  `battle`, `collections`, `feats_of_strength`.
- **Achievement definition** (`achievement_definition`) — content owned by a `content_key`: `name`,
  `description`, `icon_asset_key`, an optional `category_id`, `points`, `sort_order`, an optional
  `required_criteria_count` (null = every criterion required, otherwise an N-of-M count), and `hidden`.
  The legacy `trigger_type`/`trigger_reference_key`/`threshold` columns remain in the schema (SQLite
  cannot drop them cleanly) but are inert — nothing reads them after `M18004`.
- **Achievement criterion** (`achievement_criterion`) — one checklist line, child of a definition:
  `criterion_type` (`AchievementCriterionType`, below), an optional `reference_key`, `required_amount`
  (default 1), an optional display `label`, `sort_order`. Replaced whole on upsert, the same
  revive-by-content-key contract `achievement_reward` already used.
- **Achievement reward** (`achievement_reward`) — unchanged: a `reward_type` (`Experience` | `Currency` |
  `Item` | `Creature`), an optional `reference_key`, a `quantity`. A definition needs zero rewards to be a
  points-only badge.
- **Achievement unlocked** (`achievement_unlocked`) — per-trainer state in the **PlayerData** database: one
  append-only, idempotent row per `(account_id, trainer_id, achievement_id)`. Revive-on-write upsert (like
  `pickup_collected`) so a reset can re-fire, and a re-trigger never double-grants.

### `AchievementCriterionType` (append-only; serialised as its integer)

| Value | Type | Reference | Current value |
|---|---|---|---|
| 0 | `BattlesWon` | none | `StatKey.BattlesWon` |
| 1 | `TrainersDefeated` | none | `StatKey.TrainersDefeatedTotal` |
| 2 | `CreaturesDefeated` | none | `StatKey.CreaturesDefeatedTotal` |
| 3 | `BattleMissionsCompleted` | none | `StatKey.BattleMissionsCompleted` |
| 4 | `CreaturesCaptured` | none | `StatKey.CreaturesCapturedTotal` |
| 5 | `DistinctSpeciesCaptured` | none | count of `species_captured_*` keys with a value ≥ 1 |
| 6 | `SpeciesCaptured` | base creature id | `StatKey.SpeciesCapturedKey(id)` |
| 7 | `HighestCreatureLevel` | none | `StatKey.HighestCreatureLevel` |
| 8 | `ItemsCollected` | none | `StatKey.ItemsCollectedTotal` |
| 9 | `LocationsDiscovered` | none | `StatKey.LocationsVisitedTotal` |
| 10 | `LocationDiscovered` | world_location content_key | `StatKey.LocationDiscoveredKey(key)` |
| 11 | `QuestsCompleted` | none | `StatKey.QuestsCompleted` |
| 12 | `QuestCompleted` | quest content_key | `StatKey.QuestCompletedKey(key)` |
| 13 | `TrainerLevelReached` | none | `StatKey.TrainerLevel` |
| 14 | `AchievementEarned` (meta) | achievement content_key | 1 if an active unlock row exists for it, else 0 |
| 15 | `NpcsTalkedTo` | none | `StatKey.NpcsTalkedToTotal` |
| 16 | `DistinctTrainersDefeated` | none | the literal stat key `"trainers_defeated_distinct"` — **no `StatKey` constant or writer exists yet** (`AchievementCriterionResolver` has a `TODO`; nothing currently satisfies this criterion) |

Every "current value" read is a stat **only the authority ever writes** — a criterion can never be
satisfied by anything the client reports. `AchievementCriterionResolver` (pure, no I/O) is the single
place a criterion's current value is computed; both the evaluator's unlock check and the read-only board
call it against the same `AchievementFacts` snapshot, so a progress bar can never disagree with an unlock.

## Counting model

Achievements still do **not** keep a parallel counter — every criterion reads the **Stats** system, which
the progress dispatcher already writes for every gameplay event (see [Progress
Dispatcher](23-progress-dispatcher.md)). A definition unlocks when enough of its criteria are satisfied:
every criterion by default, or an N-of-M count via `required_criteria_count`. A **meta** criterion
(`AchievementEarned`) lets one achievement require another already being earned, so chains up to several
levels deep resolve within a single evaluation call (see [Evaluation](#evaluation)).

## Evaluation

`IAchievementEvaluator.EvaluateAsync(accountId, trainerId, ct)` — defined in `CR.Game.Model.Achievements`
(not `CR.Achievements.Data`) so any producer can take it as an **optional** constructor dependency without
a project cycle, the same precedent as `IRewardGrantService`/`ITrainerProgressionService`.
`IAchievementDomainService` (in `CR.Achievements.Data`) extends `IAchievementEvaluator` and adds the read
paths (`GetAllDefinitionsAsync`, `GetBoardAsync`, `GrantAsync`, `RevokeAsync`); registering the one
implementation, keyed and non-keyed, satisfies both contracts.

`AchievementDomainService.EvaluateAsync`:

1. Reads the trainer's current facts **once** — every `trainer_stat` value (`IStatService.GetAllAsync`,
   the full set, not a curated subset) plus the trainer's already-earned content keys — into an
   `AchievementFacts` snapshot.
2. Evaluates every **live, unearned** definition against that snapshot via `AchievementCriterionResolver`.
3. For each definition whose criteria pass (all, or the N-of-M count): performs the atomic unlock and,
   **only when this call won the insert/revive**, grants each reward via `IRewardGrantService` and pays
   `Points` as trainer XP via `ITrainerProgressionService.AwardAsync(TrainerXpAward.AchievementEarned(points))`
   (`TrainerXpSource.AchievementEarned = 9`, a normal `trainer_xp_rule` row from `M18006` — no talent
   modifiers bypass it).
4. **Repeats** against a refreshed snapshot until nothing new unlocks, so a meta achievement satisfied by
   *this same call's* unlocks (including one unlocked via `TrainerLevelReached`, since the XP just paid can
   cross a level) still unlocks before the call returns.
5. Returns every definition newly unlocked, in unlock order, as `AchievementUnlockNotice`s.

The "did-I-win-the-insert" semantics (`changes()` after a guarded `INSERT OR IGNORE`/revive on SQLite;
`ON CONFLICT … WHERE deleted = true RETURNING true` on Postgres) are what make re-evaluation safe —
`IRewardGrantService.GrantAsync` is not itself idempotent, so rewards and points are tied to the single
call that actually transitioned the row.

## Where evaluation runs

Achievements are evaluated **once per root call of the progress dispatcher**, after its outcome queue
drains (see [Progress Dispatcher](23-progress-dispatcher.md)). `ProgressDispatcher`'s constructor takes
`IAchievementEvaluator?` directly and calls `SafeEvaluateAsync` (a failure is logged and never fails the
producer) — there is no longer an intermediate step type. The two admin mutations (grant/revoke, below)
are the only other callers; `ModerationService.GrantTrainerXpAsync` also calls `SafeEvaluateAsync` after
paying admin XP, so an admin XP grant that crosses a `TrainerLevelReached` threshold can unlock in the same
call. Unlocks travel as `AchievementUnlockNotice`s in `ProgressReport.NewlyUnlocked` (and in the compat
route's `QuestProgressResult.NewlyUnlocked`). **A quest claim carries them too**: `QuestDomainService` takes
an optional `IAchievementEvaluator` and `ClaimRewardsAsync` runs one `SafeEvaluateAsync` pass after its
reward grants — before closing the XP tracker bracket, so an unlocked achievement's own points XP lands in
the same `TrainerProgress` — returning unlocks on `QuestClaimResult.Progress.NewlyUnlocked` (so a
`TrainerLevelReached` achievement can now unlock from the XP a claim's own rewards just paid, not only from
an earlier incidental evaluation). The client never posts an unlock — the route is retired and the Unity
router refuses an online client-evaluated unlock.

## REST (spec §6)

| Method | Route | Auth | Notes |
|---|---|---|---|
| GET | `/api/v1/achievements` | any token | All definitions with criteria + rewards (Content Studio pull, and Unity's catalog read) |
| GET | `/api/v1/achievements/categories` | any token | All categories |
| PUT | `/api/v1/achievements/bulk` | `content:write` | `AchievementBulkPushRequest { Replace, Categories[], Achievements[] }` — see [Content push](#content-push-and-validation) |
| GET | `/api/v1/trainers/{trainerId}/achievements/board` | `RequirePlayer` + `RequirePlayerTrainer` | The authority-computed board for the caller's own trainer |
| POST | `/api/v1/admin/trainers/{trainerId}/achievements/{contentKey}` | `RequireAdmin` | Operator grant, body `ReasonRequest { Reason }` |
| DELETE | `/api/v1/admin/trainers/{trainerId}/achievements/{contentKey}` | `RequireAdmin` | Operator revoke, body `ReasonRequest { Reason }` |

Removed in v2: the client-reported `POST .../unlock/{achievementId}` and the query-param
`GET /achievements/trainer/{id}?accountId=` (both server-authoritative-unlock violations — the board route
replaces the read, and nothing accepts a client-posted unlock any more).

### Content push and validation

`PUT /api/v1/achievements/bulk` upserts categories first (achievements reference them by id), then
achievements, inside one call — `AchievementContentValidation.Validate` runs first and **nothing is
written** if it fails (400, `AchievementContentValidationErrorResponse { Message, Problems }`). Errors
(non-exhaustive): a missing or duplicate content key, an achievement naming an unknown category (checked
against **this push's** categories *and* the server's already-stored non-deleted categories, so a
partial push — achievements only, referencing an already-live category — doesn't 400), zero criteria on a
non-hidden achievement, `required_criteria_count` out of `1..criteria.Count`, `points` outside
`[MinPoints, MaxPoints]`, a criterion's `required_amount < 1`, a criterion referencing an unknown creature
id / world-location key / quest key, an `AchievementEarned` criterion with no reference or referencing an
unknown achievement, a criterion type that doesn't take a reference but has one, and a meta-achievement
cycle (2-node or deeper). Warnings (still writes): points not a multiple of 5, a hidden achievement with
points outside `feats_of_strength`, an `Experience` reward on an achievement that already pays points as XP.

`Replace: true` prunes (soft-deletes) live categories/achievements the payload doesn't name — but **only
from a non-empty, just-written list**, never from an unread or empty config
(`feedback_never_prune_from_an_unread_config`): a categories-only push with `achievements: []` never
prunes achievements, and vice versa.

## Online / offline & content sync

Achievements follow the one content-sync standard:

- **Backend authoritative** — categories + definitions + criteria + rewards authored on the server.
- **Baked offline copy** — the category/definition/criterion/reward tables and seeds ship inside
  `game-data.bytes`.
- **PlayerData split** — `achievement_unlocked` is per-trainer writable state and lives in the player
  database, never the read-only baked content image. Content (GameData) and unlocked rows (PlayerData) are
  loaded by separate repositories and joined in application code — never across the two physical databases.
  The **board** (below) is computed from both, server-side (online) or by the same DLL against local SQLite
  (offline) — never assembled by the client from separate reads.

### The board (`GetBoardAsync`)

`AchievementBoard { TrainerId, TotalPoints, List<AchievementBoardEntry> }` — one `AchievementBoardEntry
{ AchievementId, UnlockedAt?, List<AchievementCriterionProgress> }` per **live** definition, and one
`AchievementCriterionProgress { CriterionId, Current, Required }` per criterion, computed by the same
`AchievementCriterionResolver` the evaluator uses. An earned achievement's criteria are **clamped complete**
(`Current = Required`), so a later criteria edit never shows an earned achievement as unfinished.
`TotalPoints` sums `Points` over the trainer's earned, live achievements only. The client joins this to
content (categories/definitions/criteria, read local-first) by id — the board never repeats content.

## Starter content

Seeded by `M7303SeedAchievements` (unchanged since v1) and assigned a category + points by `M18005`
(never overwrites a hand-authored category/points):

| content_key | category | points | criterion (from the legacy trigger) | reward |
|---|---|---|---|---|
| `first_victory` | Battle | 10 | BattlesWon ≥ 1 | Currency 100 |
| `first_capture` | Collections | 10 | CreaturesCaptured ≥ 1 | Item (Summoning Shard) |
| `scavenger` | Exploration | 10 | ItemsCollected ≥ 10 | Currency 250 |
| `explorer` | Exploration | 10 | LocationsDiscovered ≥ 3 | Experience 200 |
| `questing_begins` | Quests | 10 | QuestsCompleted ≥ 1 | Item (heal potion) |

Since trainer progression (2026-09-26) wired the Talents domain, `explorer`'s mapped stat
(`locations_visited_total`) is no longer written by `QuestDomainService` directly. It is now (Location
Discoveries v2) a pure `LifetimeStatProjector` projection of the `LocationEntered` outcome's
`Facts[FirstTime]`, gated by the `trainer_location_discovery` ledger — one increment per authored
`world_location`, ever, per trainer. See [Location Discoveries](24-location-discoveries.md) and
[Trainer Progression — Effect on "locations visited"
counting](22-trainer-progression.md#effect-on-locations-visited-counting-superseded-see-location-discoveries-v2)
for the detail.

## Admin grant / revoke and the dossier (spec §8.4)

`IModerationService.GrantAchievementAsync`/`RevokeAchievementAsync` (`AdminActionKind.GrantAchievement =
19` / `RevokeAchievement = 20`) are the only way an operator changes a trainer's achievements, and both go
through the same audited-transaction shape every other admin mutation does — see
[Moderation](18-moderation.md). A grant unlocks the achievement (paying rewards + points XP exactly like a
normal unlock) if not already earned, then calls `SafeEvaluateAsync` so a meta achievement this grant now
satisfies unlocks in the same admin call; an **already-unlocked retry still writes one audit row**
(`alreadyUnlocked`/`pointsAwarded` in its metadata) rather than silently no-op'ing, so an operator retry
leaves a trail. A revoke soft-deletes the trainer's unlock row — **no reward or points clawback**. Both
refuse an unknown content key or trainer, and a blank reason, writing nothing.

The admin dossier (`GET /api/v1/admin/trainers/{trainerId}` → `TrainerDossier`) carries a nullable
`Achievements { TotalPoints, List<EarnedAchievementSummary { ContentKey, DisplayName, Points, UnlockedAt }> }`
— earned-only, joined to definitions by id, null when achievements isn't registered in the host (the same
fallback `Progress` uses).

## Admin web (Achievements / Achievement Categories)

cr-admin-web has two Content Studio resources: **Achievement Categories** and **Achievements** (Content
nav), both sync-all against `PUT /api/v1/achievements/bulk` — the categories resource pushes with
`achievements: []` and vice versa, so one resource's save never prunes the other. The achievement editor's
criterion reference picker follows the resolver's exact mapping (creature picker for `SpeciesCaptured`,
world-location picker for `LocationDiscovered`, quest picker for `QuestCompleted`, achievement picker for
`AchievementEarned`, no reference field for every other type); its reward reference picker mirrors
`RewardGrantService` and is restricted to the four reward types an achievement can actually pay
(`Experience`/`Currency`/`Item`/`Creature`). The **Player Dossier** page shows a trainer's total points and
earned list, and has "Grant achievement" / "Revoke" buttons (`ReasonDialog`, both idempotent-safe — a
repeat grant still succeeds, a revoke never claws back rewards) against the admin grant/revoke routes above.

## Unity client

- `IAchievementService` (`Assets/CR/Achievements/`) is the online/offline **router**, not a thin pass-through:
  it owns definitions, categories, and the board's own online (HTTP, memoised in `IPlayerStateCache` under
  `CacheScope.AchievementBoard`, no fallback on a fresh-cache failure) vs. offline
  (`IAchievementDomainService.GetBoardAsync` against local SQLite) branch, and `ReportUnlocks`/`Unlocked`
  carry `AchievementUnlockNotice` (the DLL wire type), not the legacy `AchievementDefinition`. Unlocks still
  ARRIVE on quest/talk/item/pickup results (`ProgressReport.NewlyUnlocked`), so `QuestManager` is the
  reporter: it calls `ReportUnlocks` on every applied server-progress response. `CacheScope.AchievementBoard`
  invalidates on exactly the same 7 `InvalidationScopes` rows `TrainerProgress` does (`BattleClosed`,
  `PickupCollected`, `QuestProgressRecorded`, `QuestClaimed`, `ItemUsed`, `CreatureCaptured`, `NpcTalked`).
- Definitions and categories route through their own online/offline repositories:
  `AchievementDefinitionOnlineOfflineRepository` (gained `PruneNotInAsync`) and the new
  `AchievementCategoryOnlineOfflineRepository` (categories needed their own class rather than extending the
  definitions repository — the two interfaces share method names, and a one-type-per-file split was simpler
  and safer than explicit interface implementation for every member).
- Toasts go through `INotificationService` (`Assets/CR/Core/Notifications/`). `AchievementToastPresenter` is
  only the renderer: one queue (capped at 8 pending, oldest dropped), one UIDocument, one dismiss timer,
  passive (`PickingMode.Ignore`, no input gating). `AchievementUnlockToastAdapter` reads
  `IAchievementService.Unlocked`'s `AchievementUnlockNotice` and passes `notice.Points` through
  `ToastRequest.Points`; the toast shows a small points shield (`--cr-achievement-shield-*` tokens) only when
  `Points > 0`. **The kind decides the chrome** (`ToastChrome.For(ToastKind)`) — only `Achievement` carries
  the "Achievement Unlocked" heading. See `docs/backend/07-quest-system.md#new-quest-toast-and-dedup` and
  `docs/unity/26-creature-storage.md` for the sibling adapters.
- `LocationTriggerBehaviour` is a scene-placed passive trigger (modeled on `PickupBehaviour`) that calls
  `QuestManager.OnLocationVisited(contentKey)`, driving `LocationDiscovered` criteria.
- The player menu's **Achievements** tab (`Assets/CR/UI/Achievements/AchievementsView.cs`) is a WoW-style
  rail (Summary, categories, Statistics) over `AchievementBoardProjection`, reading real categories,
  multi-criterion definitions and points end-to-end through `IAchievementService` — see [Player Menu UI →
  Achievements tab](?page=unity/10-player-menu-ui#achievements-tab-achievementsview) for the full breakdown.
- On an online board-load failure the tab shows a **Retry** button next to the existing `PlayerErrorText`
  message (no stale/fallback board is ever shown — R12, the same fresh-failure-throws contract the router
  itself has).
- A board-load failure or a Retry re-runs `RenderAsync` for the same trainer/account; nothing is cached
  client-side beyond the router's own `IPlayerStateCache` memo.
- Crystalline Rift Studio authoring for achievement definitions moved to cr-admin-web (above) — Unity-side
  authoring is still deferred.

## Migration ranges

- `M7300` `achievement_definition`, `M7301` `achievement_reward`, `M7302` `achievement_unlocked`, `M7303`
  seed (v1).
- `M9993` content-schema bump (no-op; global max version, v1).
- `M18001` `achievement_category`. `M18002` v2 columns on `achievement_definition`
  (`category_id`, `points`, `sort_order`, `required_criteria_count`; the legacy trigger columns stay,
  inert). `M18003` `achievement_criterion`. `M18004` copies each definition's legacy trigger into one
  criterion row (`LegacyCriterionBackfill`; a referenced trigger maps to v2 only when v2 has a referenced
  variant of that type — today, only `LocationVisited` → `LocationDiscovered`; every other referenced
  trigger, e.g. `ItemCollected` + a key, has no v2 target and is skipped, insert-if-absent per achievement).
  `M18005` seeds the six base categories and assigns the five starter achievements a category + 10 points,
  never overwriting a hand-authored value. `M18006` (in `Talents.Data.Migration`, alongside the other
  `trainer_xp_rule` seeds) adds the `AchievementEarned` XP rule row. `M18007` (Postgres-only, no-op on
  SQLite — offline PlayerData/GameData live in two files a migration can't join) back-fills
  `quest_completed_{key}` stat rows from `quest_instance`/`quest_template` for trainers who completed quests
  before the per-quest stat existed. `M18008` (`M18008BackfillQuestsCompletedForUnclaimed`, both engines,
  guarded like `M18007` by the table existing) **adds to** (never overwrites) each trainer's
  `quests_completed` the count of their `Completed`-but-unclaimed `quest_instance` rows — instances the old
  at-claim counting scheme never counted and the new at-completion scheme can't retroactively see, since it
  only fires on the completion compare-and-set going forward. See [Quest System — completion
  outcome](07-quest-system.md#quest-categories-and-area-key) for the at-completion counting rule this closes
  the gap for.
- `M18010SeekerVocabularyAchievementText` (both engines, live 2026-10-08 via cr-api PR #68): the opening-story
  vocabulary pass. `first_capture`'s description becomes "Summon your first krytorus." and the `trainer`
  category's name becomes "Seeker". Content keys and ids are unchanged, and each UPDATE fires only while the
  row still holds the seeded text, so an authored value is never overwritten. Both texts are AI drafts in the
  [AI content ledger](?page=content/01-ai-content-ledger).
