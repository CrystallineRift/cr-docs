# Battle Persistence

The battle system uses fully DB-backed state. Battle session data — sessions, round keys, submitted inputs, and action logs — is stored in relational tables and survives server restarts. There is no in-memory state.

Creature **HP and status conditions are persistent across battles**: they live on the creature's own tables (`generated_creature_current_stats`, `generated_creature_status_conditions`), not per-battle. HP is written live during a battle on every resolved action, so a creature that took damage still shows that damage in the team menu after the battle ends. The active creature for each trainer is tracked on the `battle` record itself.

## Turn Model

Battles use a **sequential turn model**: exactly one trainer acts per round, resolved immediately on submit. The current round carries an `active_trainer_id` field so the client always knows whose turn it is. The faster creature (by Speed stat) goes first; ties go to the player (trainer1).

This replaced the old simultaneous-submit model where both trainers had to submit before a round could resolve.

## Why DB-Backed?

- **Crash recovery** — `GET /api/v1/battle/{id}/state` returns the correct state after a restart.
- **Horizontal scaling** — any API node can handle any request for a battle.
- **Audit trail** — `battle_action_log` preserves the resolved outcomes of every round.

## Tables

### `battle`

Tracks the overall battle session.

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID PK | Battle session identifier |
| `trainer1_id` | UUID NOT NULL | |
| `trainer2_id` | UUID NOT NULL | |
| `battle_type` | VARCHAR(50) | `"ONEvONE"`, `"Wild"`, etc. |
| `status` | VARCHAR(50) | `"Active"` or `"Ended"` |
| `winner_id` | UUID NULL | Set when status → `"Ended"` |
| `trainer1_active_creature_id` | UUID NULL | Trainer 1's creature currently on field |
| `trainer2_active_creature_id` | UUID NULL | Trainer 2's creature currently on field |
| `started_at` | DATETIME | |
| `ended_at` | DATETIME NULL | |
| `deleted` | BOOLEAN | Soft delete |

`trainer{1,2}_active_creature_id` is set at battle start (first team creature) and updated when a creature faints and is swapped. It is the source of truth for "whose creature is fighting" — there are no per-battle HP rows.

### `battle_round`

One row per round per battle. `active_trainer_id` identifies whose turn it is (added by M8006).

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID PK | |
| `battle_id` | UUID FK → `battle.id` | |
| `round_number` | INT | 1-based |
| `active_trainer_id` | UUID NULL | Whose turn this round |
| `trainer1_key` | VARCHAR(255) | Opaque submission token |
| `trainer2_key` | VARCHAR(255) | |
| `created_at` | DATETIME | |

Unique constraint: `(battle_id, round_number)`.

### `battle_round_input`

Stores each trainer's submitted moves for a round.

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID PK | |
| `battle_id` | UUID | |
| `round_number` | INT | |
| `trainer_id` | UUID | Who submitted |
| `actions_json` | TEXT | JSON-serialised `BattleAction[]` |
| `submitted_at` | DATETIME | |

Unique constraint: `(battle_id, round_number, trainer_id)` — one submission per trainer per round.

### `generated_creature_current_stats`

Persistent current HP per creature, **not** scoped to a battle. Written live during a battle and surviving after it ends. **No row means full HP** (healer pattern — clearing the row restores the creature).

| Column | Type | Notes |
|--------|------|-------|
| `generated_creature_id` | UUID PK | `generated_creature.id` |
| `current_hp` | INT | Current HP between/within battles |

`GeneratedCreature.CurrentHitPoints` (`int?`) is populated via a LEFT JOIN on this table in every `generated_creature` SELECT. `null` → use `HitPoints` (max HP).

### `generated_creature_status_conditions`

Persistent active status conditions per creature (hard-delete, composite PK). Written live during a battle.

| Column | Type | Notes |
|--------|------|-------|
| `generated_creature_id` | UUID | `generated_creature.id` |
| `status_condition_id` | UUID | `status_conditions.id` |
| `turns_remaining` | INT NULL | `null` = indefinite (burn/poison) |
| `applied_in_battle_id` | UUID NULL | Battle that applied the condition |

Composite PK: `(generated_creature_id, status_condition_id)`.

> **Note:** The legacy `battle_creature_state` table has been dropped (migration M8015) and the old per-battle creature-state / condition-change repository methods removed from `IBattleRepository`. HP and status conditions now live exclusively on the persistent creature tables above. The `battle_state_stat_changes` table survives for in-battle standalone stat changes and is now keyed directly by `(battle_id, creature_id)` (migration M8014).

### `battle_action_log`

Append-only log of resolved round outcomes.

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID PK | |
| `battle_id` | UUID | |
| `round_number` | INT | |
| `actions_json` | TEXT | Resolved actions + outcomes JSON |
| `created_at` | DATETIME | |

## Repository Layer

### `IBattleRepository`

```csharp
Task<Guid>    CreateBattleAsync(BattleRecord battle);
Task<BattleRecord?> GetBattleAsync(Guid battleId);
Task UpdateBattleStatusAsync(Guid battleId, string status, Guid? winnerId, DateTime? endedAt);
Task SetActiveCreatureAsync(Guid battleId, Guid trainerId, Guid creatureId);

Task CreateRoundAsync(BattleRoundRecord round);
Task<BattleRoundRecord?> GetRoundAsync(Guid battleId, int roundNumber);
Task<BattleRoundRecord?> GetCurrentRoundAsync(Guid battleId);

Task InsertRoundInputAsync(BattleRoundInputRecord input);
Task<IReadOnlyList<BattleRoundInputRecord>> GetRoundInputsAsync(Guid battleId, int roundNumber);

Task InsertActionLogAsync(BattleActionLogRecord entry);
Task<IReadOnlyList<BattleActionLogRecord>> GetActionLogAsync(Guid battleId);

// Standalone (in-battle, not condition-linked) stat changes, keyed by (battle, creature)
Task<IReadOnlyList<BattleStateStatChange>> GetStandaloneStatChangesByBattleCreatureAsync(Guid battleId, Guid creatureId);
Task UpsertStandaloneStatChangesByBattleCreatureAsync(Guid battleId, Guid creatureId, IEnumerable<BattleStateStatChange> statChanges);
```

Persistent HP and conditions are written through `IGeneratedCreatureRepository`:

```csharp
Task UpsertCurrentHitPointsAsync(Guid creatureId, int currentHp);
Task DeleteCurrentStatsAsync(Guid creatureId);
Task ApplyStatusConditionAsync(Guid creatureId, Guid statusConditionId, int? turnsRemaining, Guid? appliedInBattleId);
Task RemoveStatusConditionAsync(Guid creatureId, Guid statusConditionId);
Task<IReadOnlyList<GeneratedCreatureStatusCondition>> GetStatusConditionsAsync(Guid creatureId);
Task RemoveAllStatusConditionsAsync(Guid creatureId);
```

### Implementation

| Class | Location |
|-------|----------|
| `BaseBattleRepository` | `Game/CR.Game.Data/Implementation/BaseBattleRepository.cs` |
| `BattleRepository` (Postgres) | `Game/CR.Game.Data.Postgres/BattleRepository.cs` |
| `BattleRepository` (SQLite) | `Game/CR.Game.Data.Sqlite/BattleRepository.cs` |

### Record Types

Plain POCOs in `Game/CR.Game.Model/Battle/` — one file per table:

- `BattleRecord` — maps to `battle` (includes `Trainer1ActiveCreatureId` / `Trainer2ActiveCreatureId`)
- `BattleRoundRecord` — maps to `battle_round` (includes `ActiveTrainerId`)
- `BattleRoundInputRecord` — maps to `battle_round_input`
- `BattleCreatureSnapshot` — in-battle view of a creature (`TrainerId`, `CreatureId`, `CurrentHp`, `IsActive`), built from persistent creature tables; replaces `BattleCreatureStateRecord` in `BattleStateDto`
- `BattleActionLogRecord` — maps to `battle_action_log`
- `BattleAction` — represents a single submitted action (type, abilityId, itemId, etc.)
- `ActionOutcome` — full resolution result returned from `SubmitActionAsync` (includes `AbilityKey`, `ConditionsApplied`, `AttackerConditionsApplied`, `NeedsSwap`)
- `ActiveBattleCondition` / `ActiveStatChange` — live conditions used by the resolver and in `ActionOutcome`
- `ResolvedConditionDefinition` — pre-loaded condition + stat changes passed into the resolver (lives in `CR.Game.Model/Battle/`)

`GeneratedCreatureStatusCondition` (in `CR.Creatures.Data`) maps to `generated_creature_status_conditions`.

## `IBattleDomainService`

```csharp
public interface IBattleDomainService
{
    Task<BattleStartResult>  StartBattleAsync(Guid trainer1Id, Guid trainer2Id, string battleType, CancellationToken ct);
    Task<BattleStateDto?>    GetBattleStateAsync(Guid battleId, CancellationToken ct);
    Task<ActionOutcome>      SubmitActionAsync(Guid battleId, Guid trainerId, string roundKey, string actionsJson, CancellationToken ct);
    Task<bool>               IsBattleCompleteAsync(Guid battleId, CancellationToken ct);
}
```

`GetBattleStateAsync` returns `null` when the battle ID is not found. `InvalidOperationException` is reserved for invariant violations (submitting to an ended battle, wrong trainer for active turn, double submission).

### `StartBattleAsync`

1. Insert `battle` row (`status = "Active"`, `battle_type`)
2. For each trainer, load their team and set the first creature as active via `SetActiveCreatureAsync` (writes `trainer{1,2}_active_creature_id`). No per-battle creature rows are written.
3. Determine first-turn trainer by comparing the two active creatures' Speed stats (ties → trainer1)
4. Generate round 1 keys, insert `battle_round` row with `active_trainer_id`
5. Return `BattleStartResult` (includes `BattleId`, `ActiveTrainerId`, round keys)

### `SubmitActionAsync`

1. Validate battle exists + is Active
2. Load current round; verify `round.ActiveTrainerId == trainerId`
3. Validate round key
4. Guard against double-submission (unique constraint on `battle_round_input`)
5. Insert `battle_round_input`
6. Read attacker/defender active creature IDs from the `battle` record; build `CreatureSnapshot`s
7. Resolve the action immediately via `BattleResolver.Resolve()` (from `CR.Game.Compat`)
8. Persist HP **live** via `IGeneratedCreatureRepository.UpsertCurrentHitPointsAsync`, and apply/remove conditions via `ApplyStatusConditionAsync` / `RemoveStatusConditionAsync`
9. Write action log entry
10. Check battle-end condition (a creature fainted — but **only end the battle if the owner has no alive backup**, see *Force-Swap on Faint* below). The true winner is threaded through to battle end rather than recording any active-creature faint as an instant Loss.
11. If a creature fainted but its owner has an alive backup: keep the battle Active and set `ActionOutcome.NeedsSwap = true` (with `NextActiveTrainerId` = the trainer who must swap)
12. If battle not over and no swap is forced: create new round with `active_trainer_id = opposingTrainerId`
13. Return `ActionOutcome` including `NextActiveTrainerId` + `NextRoundKey`

HP is written on **every resolved action**, so a creature's damage persists immediately — no end-of-battle write-back step is needed.

### Snapshot Building (`BuildSnapshotAsync`)

For a `(battleId, creatureId)` pair the service loads the `GeneratedCreature` (which already carries `CurrentHitPoints` from the LEFT JOIN), then layers active modifiers:

- Persistent conditions from `GetStatusConditionsAsync`, resolved to their stat changes via `IAbilityRepository.GetStatusConditionsWithStatChanges`.
- In-battle standalone stat changes from `GetStandaloneStatChangesByBattleCreatureAsync(battleId, creatureId)`.

The resulting stat values are floored at 1 before being handed to the resolver.

### Wild Cleanup

When the battle ends, only the Wild Trainer's active creature needs cleanup: if it still belongs to the Wild Trainer (GUID `00000000-0000-0000-0000-000000000001`) and was not captured, it is soft-deleted and its `generated_creature_current_stats` row is cleared via `DeleteCurrentStatsAsync`. Player creatures keep their persistent current HP.

## Shared Battle Engine (`CR.Game.Compat`)

The pure calculation logic lives in `Convenience/CR.Game.Compat/Battle/` (targets `netstandard2.1`, usable by both backend and Unity):

| Class | Purpose |
|-------|---------|
| `BattleResolver` | Static `Resolve(action, attacker, defender, abilityDef, resolvedConditions?, seed) → SingleActionResult` |
| `BattleActionParser` | `Parse(json) → List<BattleAction>`, `Serialise(actions) → string` |
| `CreatureSnapshot` | Input to resolver: creature stats + active conditions |
| `SingleActionResult` | Output: damage dealt, final HP, conditions applied/removed/triggered + `AttackerConditionsApplied` |
| `ResolvedConditionDefinition` | Pre-loaded condition + stat changes passed to resolver; avoids N+1 DB queries |

### Damage Formula

Physical/special damage is **data-driven** via a tunable `damage_curve` (see *Damage curves* below). `BattleResolver` applies a fixed formula *shape* whose constants come from the resolved curve:

```
levelFactor = curve.LevelCoeff × attackerLevel + curve.LevelConst
atkStat     = Physical ? Attack  : SpecialAttack
defStat     = Physical ? Defense : SpecialDefense
damage      = floor( levelFactor × Power × atkStat / max(1, defStat) / curve.Divisor + curve.FlatAdd )
              × STAB × typeMultiplier × ability.PowerMultiplier
Status:     damage = 0
```

- **STAB** (same-type attack bonus): when the attacker's element matches the ability's element (and is not `Normal`), damage is multiplied by `curve.StabMultiplier` (default 1.5). Computed in-resolver.
- **typeMultiplier**: elemental effectiveness from the `elemental_damage` table (attack element vs defender element), pre-resolved by `BattleDomainService` and passed into `Resolve` (1.0 when no mapping exists). The elemental table is loaded once per battle and cached.
- **ability.PowerMultiplier**: per-ability scalar (1.0 default; e.g. 1.5 for a rare/legendary ability).
- Minimum damage is 1 for damaging abilities. Active `StatChange` modifiers are applied to snapshot stats before calling `Resolve`.

#### Damage curves (`damage_curve` table)

Damage tuning lives in a dual-DB (SQLite + Postgres) `damage_curve` table, authored as `DamageCurveDefinition` ScriptableObjects in Unity and synced from the Content Studio **Battle Tuning** tab.

| Column | Type | Notes |
|--------|------|-------|
| `content_key` | text (UNIQUE) | designer key; `"default"` is the global curve |
| `level_coeff` | float | `levelFactor = level_coeff × Level + level_const` |
| `level_const` | float | |
| `divisor` | float | normalization divisor (higher = less damage) |
| `flat_add` | float | flat damage added after normalization |
| `stab_multiplier` | float | same-type-attack bonus (default 1.5) |
| `deleted`, `created_at`, `updated_at` | — | soft-delete + timestamps |

An ability picks a curve via `abilities.damage_curve_key` (nullable → falls back to `"default"`); `abilities.power_multiplier` (float, default 1.0) scales that ability's damage. `BattleDomainService` resolves the effective curve (`ability.DamageCurveKey ?? "default"`, cached per battle) and passes it plus the pre-resolved `typeMultiplier` into `BattleResolver.Resolve` (the resolver stays pure / DB-free).

**REST:** `GET /api/v1/abilities/damage-curves` (list), `PUT /api/v1/abilities/damage-curves/{contentKey}` (upsert).

**Default curve:** `level_coeff = 0.4`, `level_const = 2`, `divisor = 50`, `flat_add = 2`, `stab_multiplier = 1.5` — seeded by migration `M1030`. The `abilities` columns are added by `M1031`.

### Accuracy Check

```
hits = random(0, 100) < ability.Accuracy   (seed-deterministic RNG)
```

Miss → no damage, no conditions, `ActionOutcome.Missed = true`.

### Condition Application

On an ability hit, `BattleResolver` iterates the `resolvedConditions` list passed by the caller. For each condition a probability roll is made; if it succeeds an `ActiveBattleCondition` is constructed with pre-rolled `StatChange` amounts and the condition's `DurationTurns` (or -1 for permanent). Conditions with `ApplyToUser = true` land in `SingleActionResult.AttackerConditionsApplied`; all others in `ConditionsApplied` (defender).

`BattleDomainService` bulk-fetches conditions via `IAbilityRepository.GetStatusConditionsWithStatChanges` (two queries: one for conditions, one JOIN for their stat changes) before calling the resolver. After resolution, defender conditions in `ConditionsApplied` / `ConditionsRemoved` and attacker conditions in `AttackerConditionsApplied` are persisted directly to `generated_creature_status_conditions` via `ApplyStatusConditionAsync` / `RemoveStatusConditionAsync`. Both `ConditionsApplied` and `AttackerConditionsApplied` are included in the `ActionOutcome` returned to the client.

Miss → no conditions applied regardless of probability.

### `SingleActionResult.AttackerRemainingConditions`

After resolving an action, `SingleActionResult` exposes `AttackerRemainingConditions` — the updated condition list for the attacker after start-of-turn DOT processing and turn-decrement. This list has:

- Permanent conditions (TurnsRemaining == -1) carried through unchanged.
- Conditions with TurnsRemaining > 1 decremented by 1.
- Conditions with TurnsRemaining == 1 moved to `ConditionsRemoved` and dropped from the list.

`BattleDomainService` syncs this list to `generated_creature_status_conditions` on every resolved action: conditions no longer present are removed via `RemoveStatusConditionAsync`, and remaining conditions are re-applied (updating `turns_remaining`) via `ApplyStatusConditionAsync`.

## Run / Escape Mechanics

When a trainer submits a `BattleActionType.Run` action, `BattleDomainService` resolves the attempt immediately using a deterministic escape formula rather than passing through to `BattleResolver`:

```
escapeChance = clamp(50 + (playerSpeed - wildSpeed) × 2, 10, 95)
roll = new Random(battleId.GetHashCode() ^ roundNumber).Next(0, 100)
escaped = roll < escapeChance
```

- **Escape succeeds:** battle status → `"Ended"`, `ActionOutcome.BattleOutcome = Escaped`, `ActionOutcome.BattleEnded = true`. The wild trainer's active creature is soft-deleted (player HP is already persisted).
- **Escape fails:** the opponent acts next — a new round is opened with `active_trainer_id = opponentId`, and `ActionOutcome.BattleEnded = false`. No round key is returned for the fleeing trainer.

The RNG is seeded deterministically from `battleId.GetHashCode() ^ roundNumber`, so the outcome for a given battle state is reproducible.

## Force-Swap on Faint

A battle no longer ends the instant a trainer's active creature faints. If the owner has **at least one alive backup creature** on their team, the battle stays Active and the trainer is required to swap in a replacement.

`BattleDomainService` resolves this via a private check `HasAliveBackupAsync(trainerId, activeCreatureId, ct)` — it loads the trainer's team and returns `true` if any creature other than the now-fainted active one still has HP. When the faint occurs:

- **Owner has an alive backup:** battle status stays `"Active"`, `ActionOutcome.NeedsSwap = true`, and `ActionOutcome.NextActiveTrainerId` is set to the trainer who must choose a replacement. No new round is opened until the swap is submitted.
- **Owner has no alive backup:** battle ends as before; the opponent is the winner.

The wild-trainer sentinel `00000000-0000-0000-0000-000000000001` has no team, so a fainting wild creature still ends the battle (player win) exactly as before.

> **Bug fix:** previously any active-creature faint was recorded as an instant Loss regardless of the remaining team. The backup-aware end check threads the **real** winner through to battle end.

## Switch Action

`BattleActionType.Switch` (enum value `3`) swaps the acting trainer's active creature for a backup. JSON payload shape:

```json
[{"type":3,"newCreatureId":"<guid>"}]
```

The handler validates the target creature is **owned by the acting trainer, alive, and not already active**, then sets it active via `SetActiveCreatureAsync` and passes the turn to the opponent (a new round is opened with `active_trainer_id = opponentId`). A Switch is the action a client submits in response to `ActionOutcome.NeedsSwap`.

## Battle Experience

When the player (`Trainer1`) knocks out an opponent creature (`ActionOutcome.TargetFainted`), `BattleDomainService` awards XP through the existing `ICreatureProgressionService.ApplyExperienceAsync`, which handles level-up, stat growth (`growth_profile`), and ability unlocks.

- **Amount**: `5 × defeatedLevel` (tunable `XpPerDefeatedLevel`).
- **Split**: the fighter (the active creature at the KO) takes `1 − benchShare`; the remainder is divided evenly across the **living bench**. With no living bench, the fighter takes all of it.
- **`benchShare`** = base **10%** + the trainer's `exp_share_bonus_percent` stat (read via `IStatService`), clamped to `[10%, 100%]`.

Per-creature results are returned on `ActionOutcome.ExperienceAwards` (`CreatureId`, `Amount`, `LeveledUp`, `NewLevel`) for the client to render. XP is awarded on **every** opponent knockout, independent of whether the battle ends (so multi-creature trainer battles award per KO).

### EXP-share modifiers (items / skills)

Because `benchShare` reads the `exp_share_bonus_percent` trainer stat, any writer raises the bench's cut:

- **Item** — the `IncreaseExpShare` effect (`ItemEffectType = 12`) increments the stat by its `Percent` parameter (`IncreaseExpShareHandler` on the server; `OfflineItemUseService` mirrors it offline). The sample item `exp_share_charm` ("Mentor's Charm", seeded by `M6009SeedExpShareItem`) grants +20%.
- **Skill / perk** — any future progression that records to the same stat raises it identically.

## Whiteout Team Heal

When a trainer's whole team is knocked out, the team is fully restored via `ICreatureInventoryService.HealTeamAsync(trainerId, ct)` (`Game/CR.Game.Domain.Services`). For each team creature it sets `current_hit_points` to max — reviving fainted creatures — and clears all status conditions (`UpsertCurrentHitPointsAsync` + `RemoveAllStatusConditionsAsync`), returning the number restored. Unity injects the same domain service directly, so one implementation covers the server, Unity-online, and Unity-offline paths.

A REST surface is exposed for the server path (`Game/CR.Game.Service.BFF/Endpoints/TeamEndpoints.cs`):

| Method | Route | Description |
|--------|-------|-------------|
| `POST` | `/api/v1/trainers/{trainerId}/team/heal` | Full team heal + revive + status clear; returns `{ trainerId, healed }` |

The endpoint resolves the caller's account from the request context and requires it to own `trainerId` (else `404`), preventing one account from healing another's team (IDOR). The in-process Unity caller invokes the domain service directly as the owning session.

## Wild Trainer

A system "Wild" trainer with well-known GUID `00000000-0000-0000-0000-000000000001` is seeded by `M9990SeedGameData`. All spawned wild creatures are assigned to this trainer. When a battle ends, `WriteBackHpAsync` soft-deletes the wild trainer's active creature (if uncaptured) and clears its `generated_creature_current_stats` row.

## Wild Turn Endpoint

`POST /api/v1/battle/{battleId}/wild-turn` is called by the Unity client when `ActionOutcome.NextActiveTrainerId == WildTrainerId` in online mode. It calls `IWildBattleAIDomainService.DecideActionAsync()` and submits the result via `SubmitActionAsync`, returning the `ActionOutcome`.

`WildBattleAIDomainService` heuristics (in priority order):
1. 20% random chance → use a Status-category ability if one is available
2. Default → pick the highest-power non-Status ability

The AI loads abilities from the wild creature's own progression set when available. It looks up the `GeneratedCreature` by `CreatureId`, reads `AbilityProgressionSetId`, and calls `IAbilityRepository.GetAbilitiesForProgressionSetAtLevelAsync(setId, level)` to get only abilities the creature has actually learned at its current level. If the generated creature has no progression set, or if the progression-set lookup fails, it falls back to `GetAbilitiesPaginated(0, 50)`.

The Unity client uses the same DLL `WildBattleAIDomainService` for offline battles, bound via `IWildBattleAIDomainService`.

## REST Endpoints

Defined in `Game/CR.Game.Service.BFF/Endpoints/BattleEndpoints.cs` and `WildBattleEndpoints.cs`:

| Method | Route | Description |
|--------|-------|-------------|
| `POST` | `/api/v1/battle/start` | Creates a battle; returns `BattleId` + first `ActiveTrainerId` + round key |
| `GET` | `/api/v1/battle/{id}/state` | Returns full `BattleStateDto` |
| `GET` | `/api/v1/battle/{id}/round-key?trainerId=` | Returns current round key for a given trainer |
| `POST` | `/api/v1/battle/{id}/submit` | Submits a trainer's action for the active turn; returns `ActionOutcome` |
| `POST` | `/api/v1/battle/{id}/run` | Attempts to flee; triggers escape-chance formula |
| `GET` | `/api/v1/battle/{id}/summary` | Returns post-battle summary (outcome, creature HP grid) |
| `POST` | `/api/v1/battle/{id}/wild-turn` | Triggers Wild AI turn (online mode only); body is empty `{}` |

All endpoints require bearer authentication.

## DI Wiring

```csharp
// Convenience/CR.REST.AIO/Program.cs

builder.Services.AddSingleton<IBattleRepository>(new BattleRepository(logger, configuration));
builder.Services.AddScoped<IBattleDomainService, BattleDomainService>();
builder.Services.AddSingleton<IWildBattleAIDomainService, WildBattleAIDomainService>();

new GameDatabaseMigrator().Migrate(configuration);

app.MapBattleEndpoints();
app.MapWildBattleEndpoints();
```

## Migrations

```
M8004CreateBattleTables              ← creates the battle tables
M8006AddActiveTurnToBattleRound      ← adds active_trainer_id to battle_round
M1029CreateGeneratedCreatureStatusConditionsTable  ← persistent per-creature conditions
M1017AddAbilityProgressionSetIdToBaseCreature  ← adds ability_progression_set_id (UUID NULL) to creature table
M9003AddAnimationKeyToAbilities      ← adds animation_key (VARCHAR NULL) to abilities table
M9990SeedGameData                    ← seeds Wild Trainer (guarded: skips if account table absent)
```

Additional migrations add `trainer{1,2}_active_creature_id` to `battle` and create `generated_creature_current_stats` for persistent HP.

`ability_progression_set_id` links a `creature` row to an `AbilityProgressionSet`, enabling wild AI to restrict ability selection to the abilities the creature has actually learned at its current level. `null` means no set assigned — the AI falls back to a global ability query.

`animation_key` on the `abilities` table drives client-side animation clip selection. `null` means the creature's `defaultAttackClip` (from `CreatureAnimationProfile`) is used instead.

## Tests

### Domain Service Tests (`Game/CR.Game.Domain.Services.Test/`)

| Test | Verifies |
|------|---------|
| `StartBattle_FasterWildCreature_WildGoesFirst` | Speed-based first turn |
| `StartBattle_SpeedTie_PlayerGoesFirst` | Tie-breaking rule |
| `SubmitAction_PlayerTurn_ResolvesImmediatelyAndCreatesNextRound` | Sequential flow |
| `SubmitAction_WrongTrainerForActiveTurn_ThrowsInvalidOperation` | Turn order enforcement |
| `SubmitAction_PhysicalAbility_UsesAttackOverDefense` | Physical damage formula |
| `SubmitAction_SpecialAbility_UsesSpecialAttackOverSpecialDefense` | Special damage formula |
| `SubmitAction_StatusAbility_NoDamage` | Status ability handling |
| `SubmitAction_MissedAccuracy_NoDamageNoConditions` | Miss handling |
| `SubmitAction_TargetFaints_BattleEndsWithCorrectWinner` | Battle-end detection |
| `SubmitAction_BothCreaturesFaint_SameTurn_EndsInDraw` | Draw condition |
| `SubmitAction_AfterBattleEnded_ThrowsInvalidOperation` | Post-battle guard |
| `SubmitAction_RunAction_Escapes_WhenSpeedAdvantage` | Escape formula: 95% chance → succeeds |
| `SubmitAction_RunAction_Fails_WhenSlowerThanWild` | Escape formula: 10% chance → fails |
| `SubmitAction_ConditionDot_DamagesAttackerAtStartOfTurn` | DOT fires at start of turn |
| `SubmitAction_ConditionExpires_RemovedAfterTurnsElapse` | Expired conditions are removed |

### Resolver Condition Tests (`Game/CR.Game.Domain.Services.Test/Battle/BattleResolverConditionTests.cs`)

Pure logic tests — `BattleResolver.Resolve()` called directly with `ResolvedConditionDefinition` lists. Covers probability proc/miss, `applyToUser` routing to `AttackerConditionsApplied`, zero/null probability, amount range rolling, miss suppression, `DurationTurns` mapping to `TurnsRemaining`, and `null` resolved-conditions guard.

## Gotchas

**`BattleDomainService` must be `AddScoped`, not `AddSingleton`.** It depends on `IDbConnectionFactory` which opens scoped DB connections.

**`active_trainer_id` determines whose turn it is.** Do not compare round keys to decide who can submit — always check `round.ActiveTrainerId == trainerId`.

**`ActionOutcome.NextRoundKey` is single-use.** Returned from `SubmitActionAsync` for the next round; valid only until that round resolves.

**`ActiveBattleCondition` / `ActiveStatChange` are plain classes (not records) in `CR.Game.Model`.** Using `record` + `init` in a multi-TFM assembly causes `MissingMethodException` at runtime when the net8.0 build is loaded by a netstandard2.1 consumer. Condition objects are constructed with object-initializer syntax.

**HP and conditions are persistent, not per-battle.** A creature with `current_hp` damage carries it into the next battle and shows it in the team menu. To "heal" a creature, delete its `generated_creature_current_stats` row (`DeleteCurrentStatsAsync`) and its conditions (`RemoveAllStatusConditionsAsync`) — no row means full HP.

## Related Pages

- [Battle System](?page=unity/07-battle-system) — Unity client: `BattleCoordinator`, `IBattleClient`, session events
- [Backend Architecture](?page=backend/01-architecture) — DDD layering, repository pattern
- [NPC System](?page=backend/02-npc-system) — NPC trainer team seeding feeds creature states at battle start
- [Content Registry](?page=unity/08-content-registry) — content keys identify creature species in battle state
