# Battle Persistence

The battle system uses fully DB-backed state. All battle data — sessions, round keys, submitted inputs, creature HP, and action logs — is stored in five relational tables and survives server restarts. There is no in-memory state.

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
| `started_at` | DATETIME | |
| `ended_at` | DATETIME NULL | |
| `deleted` | BOOLEAN | Soft delete |

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

### `battle_creature_state`

Mutable per-creature state during a battle (HP, status conditions). Updated each time an action resolves.

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID PK | |
| `battle_id` | UUID | |
| `trainer_id` | UUID | Owner |
| `creature_id` | UUID | `generated_creature.id` |
| `slot_number` | INT | Team position (1-N) |
| `current_hp` | INT | |
| `is_active` | BOOLEAN | Currently on field |
| `status_conditions_json` | TEXT NULL | JSON array of `ActiveBattleCondition` |

Unique constraint: `(battle_id, creature_id)`.

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

Task CreateRoundAsync(BattleRoundRecord round);
Task<BattleRoundRecord?> GetRoundAsync(Guid battleId, int roundNumber);
Task<BattleRoundRecord?> GetCurrentRoundAsync(Guid battleId);

Task UpsertCreatureStateAsync(BattleCreatureStateRecord state);
Task<IReadOnlyList<BattleCreatureStateRecord>> GetCreatureStatesAsync(Guid battleId);

Task InsertRoundInputAsync(BattleRoundInputRecord input);
Task<IReadOnlyList<BattleRoundInputRecord>> GetRoundInputsAsync(Guid battleId, int roundNumber);

Task InsertActionLogAsync(BattleActionLogRecord entry);
Task<IReadOnlyList<BattleActionLogRecord>> GetActionLogAsync(Guid battleId);
```

### Implementation

| Class | Location |
|-------|----------|
| `BaseBattleRepository` | `Game/CR.Game.Data/Implementation/BaseBattleRepository.cs` |
| `BattleRepository` (Postgres) | `Game/CR.Game.Data.Postgres/BattleRepository.cs` |
| `BattleRepository` (SQLite) | `Game/CR.Game.Data.Sqlite/BattleRepository.cs` |

### Record Types

Plain POCOs in `Game/CR.Game.Model/Battle/` — one file per table:

- `BattleRecord` — maps to `battle`
- `BattleRoundRecord` — maps to `battle_round` (includes `ActiveTrainerId`)
- `BattleRoundInputRecord` — maps to `battle_round_input`
- `BattleCreatureStateRecord` — maps to `battle_creature_state`
- `BattleActionLogRecord` — maps to `battle_action_log`
- `BattleAction` — represents a single submitted action (type, abilityId, itemId, etc.)
- `ActionOutcome` — full resolution result returned from `SubmitActionAsync` (includes `AbilityKey`, `ConditionsApplied`, `AttackerConditionsApplied`)
- `ActiveBattleCondition` / `ActiveStatChange` — live conditions stored as JSON in creature state
- `ResolvedConditionDefinition` — pre-loaded condition + stat changes passed into the resolver (lives in `CR.Game.Model/Battle/`)

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

1. Load both trainers' teams via `ICreatureInventoryService`
2. Insert `battle` row (`status = "Active"`, `battle_type`)
3. Insert one `battle_creature_state` row per creature from both teams
4. Determine first-turn trainer by comparing active creature Speed stats (ties → trainer1)
5. Generate round 1 keys, insert `battle_round` row with `active_trainer_id`
6. Return `BattleStartResult` (includes `BattleId`, `ActiveTrainerId`, round keys)

### `SubmitActionAsync`

1. Validate battle exists + is Active
2. Load current round; verify `round.ActiveTrainerId == trainerId`
3. Validate round key
4. Guard against double-submission (unique constraint on `battle_round_input`)
5. Insert `battle_round_input`
6. Resolve the action immediately via `BattleResolver.Resolve()` (from `CR.Game.Compat`)
7. Persist updated HP and conditions for both creatures
8. Write action log entry
9. Check battle-end condition (all of one trainer's creatures at HP ≤ 0)
10. If battle not over: create new round with `active_trainer_id = opposingTrainerId`
11. Return `ActionOutcome` including `NextActiveTrainerId` + `NextRoundKey`

### HP Write-Back and Wild Cleanup

When the battle ends:
- Each creature's final `battle_creature_state.current_hp` is written back to `generated_creature.hit_points`
- All creatures belonging to the Wild Trainer (GUID `00000000-0000-0000-0000-000000000001`) are soft-deleted

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

```
Physical:  damage = floor(Power × Attack / Defense)
Special:   damage = floor(Power × SpecialAttack / SpecialDefense)
Status:    damage = 0
```

Minimum damage is 1 for damaging abilities. Active `StatChange` modifiers are applied to snapshot stats before calling `Resolve`.

### Accuracy Check

```
hits = random(0, 100) < ability.Accuracy   (seed-deterministic RNG)
```

Miss → no damage, no conditions, `ActionOutcome.Missed = true`.

### Condition Application

On an ability hit, `BattleResolver` iterates the `resolvedConditions` list passed by the caller. For each condition a probability roll is made; if it succeeds an `ActiveBattleCondition` is constructed with pre-rolled `StatChange` amounts and the condition's `DurationTurns` (or -1 for permanent). Conditions with `ApplyToUser = true` land in `SingleActionResult.AttackerConditionsApplied`; all others in `ConditionsApplied` (defender).

`BattleDomainService` bulk-fetches conditions via `IAbilityRepository.GetStatusConditionsWithStatChanges` (two queries: one for conditions, one JOIN for their stat changes) before calling the resolver. Self-applied (attacker) conditions are merged into `AttackerRemainingConditions` before writing back to `battle_creature_state.status_conditions_json`. Both `ConditionsApplied` and `AttackerConditionsApplied` are included in the `ActionOutcome` returned to the client.

Miss → no conditions applied regardless of probability.

### `SingleActionResult.AttackerRemainingConditions`

After resolving an action, `SingleActionResult` exposes `AttackerRemainingConditions` — the updated condition list for the attacker after start-of-turn DOT processing and turn-decrement. This list has:

- Permanent conditions (TurnsRemaining == -1) carried through unchanged.
- Conditions with TurnsRemaining > 1 decremented by 1.
- Conditions with TurnsRemaining == 1 moved to `ConditionsRemoved` and dropped from the list.

`BattleDomainService` writes this list back to `battle_creature_state.status_conditions_json` on every resolved action, replacing the original (unmodified) condition snapshot.

## Run / Escape Mechanics

When a trainer submits a `BattleActionType.Run` action, `BattleDomainService` resolves the attempt immediately using a deterministic escape formula rather than passing through to `BattleResolver`:

```
escapeChance = clamp(50 + (playerSpeed - wildSpeed) × 2, 10, 95)
roll = new Random(battleId.GetHashCode() ^ roundNumber).Next(0, 100)
escaped = roll < escapeChance
```

- **Escape succeeds:** battle status → `"Ended"`, `ActionOutcome.BattleOutcome = Escaped`, `ActionOutcome.BattleEnded = true`. HP is written back and wild creatures are soft-deleted.
- **Escape fails:** the opponent acts next — a new round is opened with `active_trainer_id = opponentId`, and `ActionOutcome.BattleEnded = false`. No round key is returned for the fleeing trainer.

The RNG is seeded deterministically from `battleId.GetHashCode() ^ roundNumber`, so the outcome for a given battle state is reproducible.

## Wild Trainer

A system "Wild" trainer with well-known GUID `00000000-0000-0000-0000-000000000001` is seeded by `M9990SeedGameData`. All spawned wild creatures are assigned to this trainer. After battle they are soft-deleted via `WriteBackHpAsync`.

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
M8004CreateBattleTables              ← creates the 5 battle tables
M8006AddActiveTurnToBattleRound      ← adds active_trainer_id to battle_round
M1017AddAbilityProgressionSetIdToBaseCreature  ← adds ability_progression_set_id (UUID NULL) to creature table
M9003AddAnimationKeyToAbilities      ← adds animation_key (VARCHAR NULL) to abilities table
M9990SeedGameData                    ← seeds Wild Trainer (guarded: skips if account table absent)
```

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

## Related Pages

- [Battle System](?page=unity/07-battle-system) — Unity client: `BattleCoordinator`, `IBattleClient`, session events
- [Backend Architecture](?page=backend/01-architecture) — DDD layering, repository pattern
- [NPC System](?page=backend/02-npc-system) — NPC trainer team seeding feeds creature states at battle start
- [Content Registry](?page=unity/08-content-registry) — content keys identify creature species in battle state
