# Battle Persistence

The battle system uses fully DB-backed state. All battle data — sessions, round keys, submitted inputs, creature HP, and action logs — is stored in five relational tables and survives server restarts. There is no in-memory state.

## Why DB-Backed?

The previous implementation (`StatefulBattleSystemV2`) stored all state in `ConcurrentDictionary` / `Dictionary` fields on a singleton. A server restart mid-battle lost everything. The DB-backed replacement gives:

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
| `battle_type` | VARCHAR(50) | `"ONEvONE"` etc. |
| `status` | VARCHAR(50) | `"Active"` or `"Ended"` |
| `winner_id` | UUID NULL | Set when status → `"Ended"` |
| `started_at` | DATETIME | |
| `ended_at` | DATETIME NULL | |
| `deleted` | BOOLEAN | Soft delete |

### `battle_round`

One row per round per battle. Stores the per-trainer round keys used to authenticate move submissions.

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID PK | |
| `battle_id` | UUID FK → `battle.id` | |
| `round_number` | INT | 1-based |
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

Mutable per-creature state during a battle (HP, status conditions). Updated each time a round resolves.

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID PK | |
| `battle_id` | UUID | |
| `trainer_id` | UUID | Owner |
| `creature_id` | UUID | `generated_creature.id` |
| `slot_number` | INT | Team position (1-N) |
| `current_hp` | INT | |
| `is_active` | BOOLEAN | Currently on field |
| `status_conditions_json` | TEXT NULL | JSON array |

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

Follows the same pattern as `BaseNpcRepository` and `BaseCreatureRepository`:

| Class | Location |
|-------|----------|
| `BaseBattleRepository` | `Game/CR.Game.Data/Implementation/BaseBattleRepository.cs` |
| `BattleRepository` (Postgres) | `Game/CR.Game.Data.Postgres/BattleRepository.cs` |
| `BattleRepository` (SQLite) | `Game/CR.Game.Data.Sqlite/BattleRepository.cs` |

`BaseBattleRepository` uses `IsSqlite` branching for boolean literals and datetime format differences. The Postgres and SQLite subclasses only provide the `IDbConnection` factory.

### Record Types

Plain POCOs in `Game/CR.Game.Model/Battle/` — one file per table:

- `BattleRecord` — maps to `battle`
- `BattleRoundRecord` — maps to `battle_round`
- `BattleRoundInputRecord` — maps to `battle_round_input`
- `BattleCreatureStateRecord` — maps to `battle_creature_state`
- `BattleActionLogRecord` — maps to `battle_action_log`

## `IBattleDomainService`

```csharp
public interface IBattleDomainService
{
    Task<Guid>            StartBattleAsync(Guid trainer1Id, Guid trainer2Id, string battleType, CancellationToken ct);
    Task<BattleStartResult> GetBattleStartResultAsync(Guid battleId, Guid trainerId, CancellationToken ct);
    Task                  SubmitInputAsync(Guid battleId, Guid trainerId, string roundKey, BattleAction[] actions, CancellationToken ct);
    Task<BattleStateDto>  GetBattleStateAsync(Guid battleId, CancellationToken ct);
    Task<bool>            IsBattleCompleteAsync(Guid battleId, CancellationToken ct);
}
```

### `StartBattleAsync`

1. Load both trainers' teams via `ICreatureInventoryService`
2. Insert `battle` row (`status = "Active"`)
3. Insert one `battle_creature_state` row per creature from both teams
4. Generate round 1 keys (one UUID per trainer), insert `battle_round` row
5. Return the new `battle.id`

### `SubmitInputAsync`

1. Load the current `battle_round` — validate that `roundKey` matches the trainer's stored key
2. Throw `ArgumentException` on key mismatch (prevents replay attacks)
3. Insert `battle_round_input` for this trainer (unique constraint prevents double-submission)
4. If both inputs are now present: resolve the round using the battle logic, update `battle_creature_state`, append `battle_action_log`, generate next round keys and insert a new `battle_round` (or mark the battle `"Ended"` if a team is fully fainted)

### `GetBattleStateAsync`

Assembles `BattleStateDto` from the DB without any in-memory state:

```csharp
public record BattleStateDto(
    Guid   BattleId,
    string Status,
    Guid?  WinnerId,
    IReadOnlyList<BattleCreatureStateRecord> CreatureStates,
    IReadOnlyList<BattleActionLogRecord>     ActionLog
);
```

## REST Endpoints

Defined in `Game/CR.Game.Service.BFF/Endpoints/BattleEndpoints.cs`:

| Method | Route | Description |
|--------|-------|-------------|
| `POST` | `/api/v1/battle/start` | Creates a battle between two trainers; returns `BattleId` + trainer's round key |
| `GET` | `/api/v1/battle/{id}/state` | Returns full `BattleStateDto` for the given battle |
| `POST` | `/api/v1/battle/{id}/submit` | Submits a trainer's moves for the current round |
| `GET` | `/api/v1/battle/{id}/round-key` | Returns the calling trainer's current round key |

All endpoints require bearer authentication. The `trainerId` is extracted from the auth context.

## DI Wiring

```csharp
// Convenience/CR.REST.AIO/Program.cs

// Repository (singleton — connection factory only, stateless)
builder.Services.AddSingleton<IBattleRepository>(
    new BattleRepository(logger, configuration));

// Domain service (scoped — uses IDbConnectionFactory for transactions)
builder.Services.AddScoped<IBattleDomainService, BattleDomainService>();

// Migration (auto-discovers M8004 in CR.Game.Data.Migration)
new GameDatabaseMigrator().Migrate(configuration);

// Endpoints
app.MapBattleEndpoints();
```

## Migration

`M8004CreateBattleTables` in `Game/CR.Game.Data.Migration/` creates all five tables. It follows the same ANSI SQL pattern as other CR migrations — no engine-specific syntax.

```
M8001CreateBattleSystemConfigTable
M8004CreateBattleTables              ← creates the 5 battle tables
```

`GameDatabaseMigrator` auto-discovers all migrations in the assembly by scanning for `[Migration(...)]` attributes and runs them in numeric order.

## Unity Client Integration

The Unity client interacts with the battle REST API via `IBattleClient`:

```csharp
public interface IBattleClient
{
    Task<StartBattleResponse>    StartBattleAsync(StartBattleRequest request, CancellationToken ct);
    Task<BattleRoundKeyResponse> GetRoundKeyAsync(Guid battleId, Guid trainerId, CancellationToken ct);
    Task<SubmitInputResponse>    SubmitInputAsync(Guid battleId, SubmitBattleInputRequest request, CancellationToken ct);
    Task<BattleStateResponse>    GetBattleStateAsync(Guid battleId, CancellationToken ct);
}
```

`BattleClientUnityHttp` is the concrete implementation using Best HTTP (`SimpleWebClient`). It is bound as a singleton in `LocalDevGameInstaller` and injected into `BattleCoordinator`.

See [Battle System](?page=unity/07-battle-system) for the full Unity-side flow.

## Tests

`Game/CR.Game.Domain.Services.Test/BattleDomainServiceTests.cs` covers:

| Test | Verifies |
|------|---------|
| `StartBattle_CreatesSessionAndRoundKeys` | Battle row created, round 1 keys generated |
| `SubmitInput_OneTrainer_DoesNotResolveRound` | Round not resolved until both trainers submit |
| `SubmitInput_BothTrainers_ResolvesRoundAndAdvances` | Round resolves, new round row inserted |
| `SubmitInput_WrongRoundKey_Throws` | `ArgumentException` on bad key |
| `SubmitInput_AllCreaturesFainted_EndsBattle` | Battle status set to `"Ended"`, winner recorded |

`IBattleRepository` is mocked with Moq — no real DB required for the unit tests.

## Gotchas

**`BattleDomainService` must be `AddScoped`, not `AddSingleton`.** It depends on `IDbConnectionFactory` which opens scoped DB connections. Registering it as a singleton causes connection reuse across requests and will lead to threading issues under load.

**Round keys are single-use.** Each `StartBattleAsync` and each round resolution generates fresh UUIDs. Caching a round key and reusing it after the round resolves will cause `SubmitInputAsync` to throw `ArgumentException`.

**DB transaction scope.** The round resolution path (updating creature states, inserting action log, creating next round) must complete atomically. `BattleDomainService` wraps this in a transaction. If the server crashes between these writes, the round will not be resolved and both trainers can resubmit.

## Related Pages

- [Battle System](?page=unity/07-battle-system) — Unity client: `BattleCoordinator`, `IBattleClient`, session events
- [Backend Architecture](?page=backend/01-architecture) — DDD layering, repository pattern
- [NPC System](?page=backend/02-npc-system) — NPC trainer team seeding feeds creature states at battle start
- [Content Registry](?page=unity/08-content-registry) — content keys identify creature species in battle state
