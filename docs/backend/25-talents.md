# Talents (Phase 2)

Three talent trees (Exploration, Capture, Battle), one point per level from 2, spent live against
server rules. `CR.Talents.*` owns the content and player tables; effects reach across every domain
through `ITrainerModifierProvider`, the one seam every consumer already had from
[Trainer Progression](22-trainer-progression.md) (Phase 1). Spec:
`cr-api-unity/docs/superpowers/specs/2026-09-27-talents-phase2-design.md`.

## Where things live

| Piece | Location |
|---|---|
| Wire contracts | `Game/CR.Game.Model/Progression/` — `TalentSpendError`, `TalentAllocation`, `TalentModifierValue`, `TalentSpendResult`, `ITalentService`; `TrainerProgress.Allocations/Modifiers/QuestLockedTalentIds`; `TrainerModifiers`'s derived multipliers |
| Content model | `Talents/CR.Talents.Data.Model` — `TalentTree`, `Talent`, `TalentEffect`, `TalentTreeUpsert`, `TalentTreeBulkResult` |
| Tables + repos | `Talents/CR.Talents.Data(.Sqlite/.Postgres/.Migration)` — `ITalentTreeRepository`, `ITalentAllocationRepository` + `ITalentWriteScope` |
| Pure rules | `Talents/CR.Talents.Domain.Services` (shipped in Compat, so Unity gets the same DLL the server runs) — `TalentRules`, `TalentBuild`, `TalentTreeValidation` |
| Wiring + service | `Talents/CR.Talents.Domain.Services` — `TalentBuildReader`, `TalentModifierProvider`, `TalentService`, `TalentQuestKeys` |
| REST | `Talents/CR.Talents.Model.REST`, `Talents/CR.Talents.Service.REST/Endpoints/TalentEndpoints.cs` |
| Unity | `Assets/CR/UI/Talents/**`, `Assets/CR/Progression/*Talent*`, `Assets/CR/Core/Data/Editor/TalentTreeDefinitionEditor.cs`, `Assets/CR/Core/Data/Logic/TalentTreeSeedMigrationGenerator.cs` — see [Talents UI (Unity)](?page=unity/36-talents-ui) |

## Data model

| Migration | Table | Columns of note |
|---|---|---|
| M15101 | `talent_tree` | `content_key` UNIQUE, `name`, `description`, `icon_address` null, `sort_order` |
| M15102 | `talent` | `content_key` UNIQUE, `talent_tree_id`, `name`, `description` (may use `{0}` for the current rank's first effect value), `icon_address` null, `tier` (1-5), `sort_order`, `max_rank` (1-5), `exclusive_group` null, `is_drawback`, `unlock_quest_key` null, `effects` (JSON text, backs `List<TalentEffect>` the same way `QuestObjectiveTemplate.TargetReferenceIds` does) |
| M15103 | `trainer_talent` | `trainer_id`, `talent_id`, `rank`; **plain `UNIQUE(trainer_id, talent_id)`, one row per pair forever** — a respec writes rank 0, never a soft delete, so there is no revive-on-write churn on this table |
| M15104 | `trainer_talent_lock` | `trainer_id` UNIQUE, `version` bigint — the per-trainer serialisation row (see [Spend, respec, admin set-rank](#spend-respec-admin-set-rank)) |

Content tables bind to the GameData connection, player tables to PlayerData — no physical foreign
keys between them. `TalentEffect { EffectType, List<double> ValuesPerRank }`:
`ValuesPerRank[r-1]` is the **total** at rank *r* (e.g. `[20, 40, 60]`), not a per-rank increment.
`TalentEffectType` (int enum): `TrainerXpPercent=1, MoveSpeedPercent=10, DropChancePercent=11,
PickupCurrencyPercent=12, ExplorationXpPercent=13, RareEncounterShift=14, CaptureChancePercent=20,
CrystalSaveChancePercent=21, CaptureXpPercent=22, CaptureMission=23 (Phase 3, refused by validation
in Phase 2), DamageDealtPercent=30, DamageTakenPercent=31, CreatureXpPercent=32, ExpSharePercent=33,
CreatureLevelUpTrainerXp=34`.

Connection string: `TalentDatabase` (same fallback-to-`StatDatabase` behaviour as the rest of
Trainer Progression — see [Trainer Progression](22-trainer-progression.md)).

### Serialising a trainer's spend

**Ruling:** `trainer_talent_lock`, not `SELECT … FOR UPDATE` on `trainers`. **Why:** `trainers` lives
behind another domain's connection key, which the Talents connection isn't guaranteed to see.
`UPDATE trainer_talent_lock SET version = version + 1 WHERE trainer_id = @t`, run as the write
transaction's first statement, takes the row lock on Postgres; SQLite transactions through
`Microsoft.Data.Sqlite` are `IMMEDIATE` by default. The result is ANSI SQL with no engine branch.
A lost race on the plain-UNIQUE upsert (Postgres `23505`) is mapped to `TalentSpendError.RankChanged`
via `DbException.Data["SqlState"]` (engine-agnostic — SQLite never raises it) rather than thrown into
the generic 409 middleware.

## The talent build (`TalentBuild`, pure)

`TalentBuild.Evaluate(trees, allocations, completedQuestKeys, level)` walks each tree tier-ascending
and returns `ValidRanks`, `SpentPoints` (sum over **every** row, including invalid ones),
`NeedsRespec`, `Modifiers` (summed and clamped) and `QuestLockedTalentIds`.

An allocation is **invalid**, and contributes nothing, when any of: its talent no longer exists, its
rank exceeds the talent's current `max_rank`, its tier gate is unmet by the *valid* points below it in
that tree, it conflicts with another ranked member of its exclusive group, or its quest gate is
closed. Every kind of invalidity is handled identically — a rank orphaned by a lowered `max_rank` is
**ignored, not clamped** — because one rule is simpler than several and the fix is always a free
respec (the "Respec required" banner). `NeedsRespec` is also set whenever `SpentPoints > level − 1`
(an admin XP take-back, or a curve edit). `AvailablePoints = max(0, (level − 1) − SpentPoints)`.
**Overspent zeros every modifier outright** (`Modifiers = TrainerModifiers.None` for the whole build,
not a per-rank clamp of just the orphaned ones) until the trainer respecs — a M2 fix pass finding: the
old per-rank-valid behavior let an overspent trainer keep every individually-still-valid rank's effect,
which was the wrong side to be generous on for something already flagged "needs respec."

`TalentRules` holds `PointsPerTier = 5`, `MaxTier = 5`, the effect caps (below), and the pure
`CanSpend(tree, talent, build, expectedRank)` (the one-point compare-and-set check) plus
`CanSetRank(tree, talent, build, rank)` (the admin path's own check — never blocked by
`NeedsRespec`, since an operator may be repairing exactly that). `TalentTreeValidation.Validate(trees)`
covers the bulk-push safety rules (unique keys, tier/`max_rank` range, effect shape, at most one
capstone, exclusive-group shape, gate feasibility ignoring quest-gated talents, `CaptureMission`
refused in Phase 2) as errors, and cap-overflow / missing-capstone as warnings; the server refuses on
errors and ignores warnings.

### Readers and wiring

`ITalentBuildReader` (internal to Talents) loads tree content once per instance (a scoped/singleton
cache, not re-queried per call), reads allocations fresh every call, and reads completed quest keys
only when some live talent carries an `unlock_quest_key` (`TalentQuestKeys`, shared with the write
path so both sides apply the exact same "read gate" rule). A read failure inside is caught and
logged, returning `TalentBuild.None` — a talent-content outage must never break an XP grant.

`TalentModifierProvider : ITrainerModifierProvider` returns `build.Modifiers`; it replaces Phase 1's
`NoTalentModifierProvider` at **every** DI site, online and offline. `TrainerProgressionService` takes
`ITalentBuildReader` in place of `ITrainerModifierProvider`: `GetProgressAsync` reads the build once at
the trainer's current level; `GrantCoreAsync` reads it once at the level the grant starts from and
re-reads it (one more cheap indexed query) only when that same grant crosses a level boundary — so an
XP grant that levels the trainer up still reports the post-level-up `AvailablePoints`, not a stale
pre-grant number.

## Spend, respec, admin set-rank

`TalentService : ITalentService` is one algorithm behind three entry points:

```
scope = allocations.BeginTrainerWriteAsync(trainerId)   // bumps trainer_talent_lock.version first
build = TalentBuild.Evaluate(trees, scope.GetAsync(), completedQuestKeys, level)

Spend(talentId, expectedRank):
  current = rows[talentId] ?? 0
  current != expectedRank        → RankChanged  (a replay lands here, never a double spend)
  TalentRules.CanSpend(...)      → NoPoints / TierLocked / MaxRank / ExclusiveTaken /
                                    TalentUnavailable / QuestLocked / NeedsRespec, or proceed
  else scope.SetRankAsync(talentId, current + 1)

Respec():
  scope.ResetAllAsync()          // always succeeds for a real trainer — free

SetRank(talentId, rank):         // admin only
  rank outside 0..max_rank       → InvalidRank
  lowering                       → re-checks every OTHER valid higher-tier allocation in the tree
                                    still meets its gate once this one's contribution drops
  raising                        → re-runs CanSpend, budgeted for the whole delta
  never blocked by NeedsRespec   // an operator may be repairing exactly that
```

A refusal rolls the scope back without committing and returns the **unchanged** current progress —
never an exception. An unknown trainer throws `InvalidOperationException`, checked *before* any scope
opens, so no `trainer_talent_lock` row is ever created for a trainer that was never real.

**Admin XP grants take the same lock as player spend.** `ITalentService.WithTrainerTalentLockAsync<T>`
exposes the same per-trainer `trainer_talent_lock` row `Spend`/`Respec`/`SetRank` already serialize on;
`GrantTrainerXpAsync`'s negative-amount (admin take-back) path runs its whole check-then-grant body
inside that lock, re-reading progress fresh instead of trusting a read taken before the lock — closing
a race where a concurrent player spend between the overspend check and the grant could let a take-back
land against a stale spent-points count. A trainer that ends up overspent anyway (a curve edit, not a
race) still just lands in `NeedsRespec`, which the build already handles.

### "Teach a talent" (quest tie-in)

`SpendAsync`, and an admin `SetRankAsync` that **raises** a rank (never a lowering correction), emit
`ProgressOutcome { Kind = TalentRankReached, SubjectKey = talent content_key, Quantity = new rank }`
to `IProgressOutcomeSink` after commit — best-effort, `CancellationToken.None`, logged on failure, same
at-most-once shape as every other outcome producer (see [Progress Dispatcher](23-progress-dispatcher.md)).
`TalentSpendResult.Report` carries the dispatcher's report from a successful spend, for the client's
toast pipeline.

`QuestObjectiveType.ReachTalentRank = 50` (see [Quest System](07-quest-system.md#questobjectivetype))
uses **MAX semantics**, not count-up-to-target: `QuestObjectiveProjector` sets `current_count` to
`max(current_count, Quantity)`, clamped to `target_count`, via the existing `RaiseObjectiveProgressAsync`
path — zero new repository code. A blank `target_reference_id` counts the highest rank reached on
**any** talent (the existing blank-matches-anything rule). A respec never lowers an objective's count
(nothing emits on the way down), and an admin *lowering* correction emits nothing either — it isn't
the player learning anything.

The gate itself is separate from the objective: a talent may name `unlock_quest_key` (a quest's
`content_key`). While the trainer has not completed that quest (`quest_instance.Status = Completed`),
the talent can't take ranks (`QuestLocked`), rides on `TrainerProgress.QuestLockedTalentIds`, and shows
sealed in the tab. The gate is read live inside `TalentBuild.Evaluate` — completing the quest needs no
event, and an allocation whose gate later closes again (a content edit) is simply invalid (§ above),
which asks for a respec rather than silently reverting. The server does not check that
`unlock_quest_key` names a real quest — trees and quests push independently, so a typo'd key just
stays locked until corrected (the Unity editor's dropdown prevents typos in practice).

`CR.Quests.Data`'s `QuestCompletionExtensions.GetCompletedQuestContentKeysAsync` (an extension on
`IQuestInstanceRepository`, fails closed to an empty set) and `QuestUnlockGate.IsUnlocked` are the
one shared rule Talents, `AbilityUnlockGate` and `CreatureProgressionService` all call — Talents
references `CR.Quests.Data` directly rather than adding a new `Game.Model` quest contract (no cycle:
Quests only reaches Talents through `Game.Model`).

## Effects — consumers

Every non-flag effect is a percent modifier, `max(0, 1 + pct/100)`, summed and clamped **after**
summing (`TalentRules.Caps`) into `TrainerModifiers`'s derived accessors:

| Effect | Range | Consumer |
|---|---|---|
| `TrainerXpPercent` | 0…+50 | `TrainerProgressionService.ApplyModifiersAsync` (Phase 1) |
| `MoveSpeedPercent` | 0…+30 | Unity `TrainerModifierApplier` → `MalbersMovementController.SetSpeed` — **client-applied, the one exception to server authority here**: the server computes the multiplier, the client only scales root motion |
| `DropChancePercent` | 0…+50 | `LootRollService.Roll` |
| `PickupCurrencyPercent` | 0…+100 | `PickupDomainService`'s collect loop |
| `ExplorationXpPercent` | 0…+100 | `ApplyModifiersAsync` (Phase 1) |
| `RareEncounterShift` | −50…+50 | `CreatureSpawnDomainService.SelectProductivePoolAsync` |
| `CaptureChancePercent` | −50…+50 | `CaptureAttemptService` (Phase 1) |
| `CrystalSaveChancePercent` | 0…+50 | `CaptureAttemptService`'s failed-roll path |
| `CaptureXpPercent` | 0…+100 | `ApplyModifiersAsync` (Phase 1) |
| `CaptureMission` | flag | Phase 3 — refused by `TalentTreeValidation` in Phase 2 |
| `DamageDealtPercent` / `DamageTakenPercent` | −50…+50 | `BattleResolver` via `CreatureSnapshot` |
| `CreatureXpPercent` | 0…+100 | `AwardBattleExperienceAsync` |
| `ExpSharePercent` | 0…+100 | `ResolveBenchShareAsync` |
| `CreatureLevelUpTrainerXp` | 0…500 | `BattleDomainService`, Mentor bonus below |

Unknown effect types in stored JSON are ignored and logged once per instance.

- **Crystal save.** On a failed capture roll, `CaptureAttemptService` rolls `CrystalSaveChance` with
  the same `ICaptureRoll`; a save sets `ItemUseResult.ItemRetained = true`. The consumption gate in
  `ItemUseDomainService` becomes `IsConsumable && !EvolutionTriggered && !ItemRetained` — a save
  refunds the item already taken under the claim-before-pay ordering, without changing that ordering.
  Offline uses the same DLL service, so there is one gate. Unity shows "Your crystal survived" —
  presentation only.
- **Loot.** `LootRollService.Roll(entries, rng, dropChanceMultiplier = 1.0)`: each entry passes when
  `rng ≤ min(1, chance × m)`. `BattleDomainService` passes the player's `DropChanceMultiplier`.
- **Pickup currency.** Each `RewardType.Currency` reward becomes `round(qty × PickupCurrencyMultiplier)`,
  minimum 1. Item/quest rewards, and currency from quests/loot/battles, are untouched.
- **Rare encounters.** `RareEncounterWeighting.Apply` (pure, `Spawner.Domain.Services`) reshapes each
  productive pool's weight `w = SpawnWeight × RarityMultiplier` to `w × (1 + s × (1 − w/maxW))` — the
  lightest pools gain the most, and a negative shift favours common pools. Only applied for a named
  trainer with 2+ productive candidates; a single candidate (e.g. a forced `poolName`) is unaffected. A
  modifier read failure logs and falls back to the authored weights.
- **Damage.** `dmg *= attacker.DamageDealtMultiplier * defender.DamageTakenMultiplier`, applied right
  after `PowerMultiplier` and before `Math.Floor` — before the reaction boost, and before DoT/recoil/
  held-item reduction, which are untouched. `BattleDomainService` reads the player's modifiers **once
  per action request** (not per AI step), keyed on `battle.Trainer1Id` — never "any creature with a
  trainer", because NPC creatures carry NPC trainer ids and a future PvP would otherwise let two
  talent sets fight silently.
- **Creature XP / exp share.** `earnedXp *= CreatureXpMultiplier` before the bench split;
  `ExpSharePercent` adds to the existing base+stat sum before the `[10%, 100%]` clamp. One modifier
  read is shared with the damage path above.
- **Mentor (creature level-up → trainer XP).** `levelsGained` sums every level crossed, across the
  fighter and every bench award, in one action. When `levelsGained > 0` and
  `CreatureLevelUpTrainerXp > 0`, the service grants `CreatureLevelUpTrainerXp × levelsGained` via
  `TrainerXpSource.CreatureLevelUp` (`TrainerXp%` still applies; other source-specific bonuses don't),
  best-effort like every other award. The `TrainerProgressTracker` bracket around an action request
  now opens for **every** action where the player scores a KO, not only the one that wins the battle —
  a mid-battle KO that levels a creature reports its `trainerProgress` in that turn's result, not just
  the final one.

## Admin (Moderation group)

`ModerationService` takes `ITalentService?`/`ITalentTreeRepository?` as optional constructor
parameters (a project reference to `Talents.Data`, acyclic — data only). Every route needs a
mandatory reason and writes an `admin_action` row after the change lands, per the existing
[Moderation](18-moderation.md) precedent.

| Route | Body | 200 | Kind | Notes |
|---|---|---|---|---|
| `PUT /api/v1/admin/trainers/{id}/talents/{talentId}` | `{ rank, reason }` | `TrainerProgress` | `SetTalentRank` (17) | Metadata `{talentId, talentKey, rankBefore, rankAfter}`. A nested `TalentSpendResult` refusal (out-of-range rank, or a lost race) is `409 { error: TalentSpendError, progress }` and writes **no** audit row — the outer `ModerationResult.Success` stays true (the moderation call itself ran); this mirrors how a 200-with-a-refusal-body already works on the player route, not a new shape. Never blocked by `NeedsRespec`. |
| `POST /api/v1/admin/trainers/{id}/talents/respec` | `{ reason }` | `TrainerProgress` | `RespecTalents` (18) | Metadata `{spentBefore}`. Always succeeds for a real trainer. |
| `POST /api/v1/admin/trainers/{id}/xp` | `{ amount, reason, respec? }` | `TrainerProgressResult` | `GrantTrainerXp` (16) | See below. |

### Negative XP and respec

`GrantTrainerXpAsync` gains `bool respec = false`. A **negative** grant that would leave
`SpentPoints > newLevel − 1` is refused `409 WouldOverspendTalents`, unless `respec = true` — in
which case the service **respecs first, then grants** (respec-then-grant, not one transaction: Stats
and Talents may sit on different connections, and respec is free, so a grant that then fails costs the
player nothing but leaves the audit row unwritten). Audit metadata gains `respecced: true`. The check
only runs for `amount < 0 && ITalentService is bound` — a positive grant can never overspend anything,
and a host with no Talents module registered has nothing to check.

See [Moderation](18-moderation.md) for the full admin route table and `ModerationReason` list, and
[cr-admin-web's Player Dossier](#cr-admin-web) below for the operator UI.

## Player REST

Ownership uses the same `.RequirePlayerTrainer("trainerId")` guard every other player route uses: 404
for a trainer that isn't the token's own **player** trainer (NPC battle identities included), 401 with
no token.

| Method | Route | Body | 200 | Errors |
|---|---|---|---|---|
| POST | `/api/v1/trainers/{trainerId}/talents/{talentId}/spend` | `{ expectedRank }` | `TrainerProgress` | 409 `{ error: TalentSpendError, progress }` |
| POST | `/api/v1/trainers/{trainerId}/talents/respec` | | `TrainerProgress` | |
| GET | `/api/v1/talents/trees` | | `TalentTree[]` (every tree, with talents) | any authenticated token |
| GET | `/api/v1/talents/trees/by-content-key/{key}` | | `TalentTree` | any authenticated token |
| PUT | `/api/v1/talents/trees/bulk` | `{ trees: TalentTreeUpsert[] }` | per-tree `{inserted, updated, retired}` | `RequireContentWrite`; 400 with every `TalentTreeValidation` problem, nothing written |

`GET /api/v1/trainers/{trainerId}/progression` (Phase 1) now also carries `SpentPoints`,
`NeedsRespec`, `Allocations`, `Modifiers` and `QuestLockedTalentIds` — see
[Trainer Progression](22-trainer-progression.md).

### DI

`AddTalentDomainServices` registers `ITalentBuildReader`, `ITrainerModifierProvider →
TalentModifierProvider`, `ITalentService` and the progression service, each **keyed and non-keyed**
(`TalentServiceKeys.Talents = "talents"`). The AIO registers `ITalentTreeRepository`/
`ITalentAllocationRepository` on `TalentDatabase`.

## Content delivery

**Studio push.** `PUT /api/v1/talents/trees/bulk` with `{ trees: [{ id, contentKey, …,
declaredTalentCount, talents: [...] }] }` — `declaredTalentCount` is the bulk-push safety rail: the
server prunes a tree's talents only when it matches how many were actually sent (the
`UpsertTreesAsync` "revive-on-write by content_key" precedent from world locations). Crystalline Rift
Studio's Trainer Progression tab has **Push talent trees** and **Export talent floor seed**;
`TrainerProgressionPipelineCommands` has `cr_talent_trees_push`/`cr_talent_trees_export_seed` for the
CLI. See [Talents UI (Unity)](?page=unity/36-talents-ui) for authoring, and [Location
Discoveries](24-location-discoveries.md#admin-authoring) for the Studio-push-replaces-admin-edits
precedent this follows.

**Offline floor.** `TalentTreeSeedMigrationGenerator` writes a `SeedTalentTrees_` migration in its own
block (15150–15199, below M15101–M15104) — insert-if-absent by `content_key` on both engines, under
the SOs' authored ids. It gets its own prefix and block rather than joining Phase 1's
`SeedTalentContent_` file, because a writer keeps an existing prefix's version forever and Phase 1's
file lives below M15101 in a block that predates these tables. A re-export regenerates the same file
in place.

## cr-admin-web

- `resources/talent-trees/` — a content descriptor over the same `GET`/bulk `PUT`. An edit sends the
  whole tree, so it prunes only within that tree. Shows a numeric enum select for the effect type,
  per-rank value arrays, and `unlockQuestKey` as a text field (server-validated for shape only). Its
  header documents that a Studio push replaces admin edits, the same precedent as World Locations.
- The **Player Dossier**'s Progression panel shows level, XP, spent/available points, a `NeedsRespec`
  badge, and — per tree — every allocated talent's rank/max with drawback/exclusive/quest-lock
  markers, joined from `TrainerProgress.Allocations` (bare `talentId`/`rank`) against
  `GET /api/v1/talents/trees`. **Set rank** and **Respec** dialogs call the two admin routes above; the
  existing **Grant XP** dialog gains a "respec if needed" checkbox that appears only once a
  `WouldOverspendTalents` refusal has actually happened, not pre-emptively.
- The quest editor's objective type list gains `ReachTalentRank` (50), with a typed talent-key field
  (no flat "talents" resource to pick from — talents nest inside a tree) and a "Rank to reach" count.

## Tests

| Project | Covers |
|---|---|
| `Talents/CR.Talents.Data.Test` | Both-engine repository round-trips, tree upsert/prune/declared-count safety, the write scope's lock bump and Postgres `23505`→`RankChanged` mapping (Testcontainers). |
| `Talents/CR.Talents.Domain.Services.Test` | `TalentBuild.Evaluate`'s every invalidity path, `TalentRules.CanSpend`/`CanSetRank`, `TalentTreeValidation`'s errors/warnings, `TalentService`'s spend/respec/set-rank algorithm (mocked write scope) including the never-blocked-by-`NeedsRespec` rule and the `TalentRankReached` emission. |
| `Game/CR.Game.Domain.Services.Test`, `Loot/CR.Loot.Domain.Services.Test`, `Pickups/CR.Pickups.Domain.Services.Test`, `Spawner/CR.Spawner.Test`, `Convenience/CR.Game.Compat.Test` | Each effect consumer (crystal save, drop-chance clamp, pickup scaling, rare-encounter weighting, damage-multiplier-before-floor, Mentor bonus on a mid-battle non-winning KO). |
| `Moderation/CR.Moderation.Domain.Services.Test` | `SetTalentRankAsync`/`RespecTalentsAsync`, the overspend refusal and respec-then-grant path, against real Postgres. |
| `Convenience/CR.Api.IntegrationTests` | `RoutePolicyCoverageTests` for every new route's policy metadata; DI-graph resolution tests over the live AIO host. |

## Related

- [Trainer Progression](22-trainer-progression.md) — the level curve, XP funnel, and `TrainerProgress`/`TrainerModifiers` this domain extends.
- [Moderation](18-moderation.md) — the admin route shapes and audit pattern `SetTalentRank`/`RespecTalents` follow.
- [Quest System](07-quest-system.md) — `ReachTalentRank` (50) and the shared quest-completion read.
- [Progress Dispatcher](23-progress-dispatcher.md) — `IProgressOutcomeSink`, `TalentRankReached`.
- [Loot System](13-loot-system.md), [Spawner System](03-spawner-system.md) — `DropChanceMultiplier`, `RareEncounterShift`.
- [Capture Mechanic (Unity)](?page=unity/14-capture-mechanic) — the crystal-save presentation.
- [Talents UI (Unity)](?page=unity/36-talents-ui) — authoring, the tab, the router, and the client-applied movement-speed effect.
