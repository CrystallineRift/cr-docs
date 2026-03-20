# Battle System

The battle system connects scene-level events (NPC interaction, wild encounter triggers) to the server-side battle engine via a REST API. `BattleCoordinator` is the single entry point for all battle initiation in the Unity client. All battle state is DB-backed on the server — see [Battle Persistence](?page=backend/09-battle-persistence) for the backend detail.

## Battle Types

| Type | Status | Entry Point |
|------|--------|-------------|
| NPC Trainer | Implemented | `NpcInteractionBehaviour` E-press → `BattleCoordinator.StartNpcBattle` |
| Wild Creature | Implemented | `SpawnerEncounterBehaviour` trigger → `BattleCoordinator.StartWildBattle` |
| PvP | Phase 2 | Networking not yet implemented |

## `BattleCoordinator`

`BattleCoordinator` is a MonoBehaviour singleton bound as `IBattleCoordinator`. It is the only component that may call `IBattleClient` to start a battle or retrieve a round key. Scene components inject `IBattleCoordinator` — never the concrete class.

### Installer Binding

```csharp
// LocalDevGameInstaller.cs
Container.Bind<IBattleClient>()
    .To<BattleClientUnityHttp>()
    .AsSingle();

Container.Bind<IBattleCoordinator>()
    .To<BattleCoordinator>()
    .FromNewComponentOnNewGameObject()
    .AsSingle();
```

### Public API

```csharp
public interface IBattleCoordinator
{
    event Action<BattleSession> OnBattleStarted;
    event Action<BattleResult>  OnBattleEnded;

    void StartNpcBattle (NpcBattleRequest  request);
    void StartWildBattle(WildBattleRequest request);
    void EndBattle(Guid? winnerTrainerId, string reason);
}
```

### Events

| Event | Payload | When it fires |
|-------|---------|---------------|
| `OnBattleStarted` | `BattleSession` | After `IBattleClient.GetRoundKeyAsync` returns — the player's round key is stamped on the session before this event |
| `OnBattleEnded` | `BattleResult` | After `EndBattle` is called by the battle UI or external resolver |

Subscribe to `OnBattleStarted` to trigger battle UI or scene transitions. Subscribe to `OnBattleEnded` to return to the world, award experience, etc.

```csharp
public class BattleUIController : MonoBehaviour
{
    [Inject] private IBattleCoordinator _battleCoordinator;

    private void OnEnable()
    {
        _battleCoordinator.OnBattleStarted += HandleBattleStarted;
        _battleCoordinator.OnBattleEnded   += HandleBattleEnded;
    }

    private void OnDisable()
    {
        _battleCoordinator.OnBattleStarted -= HandleBattleStarted;
        _battleCoordinator.OnBattleEnded   -= HandleBattleEnded;
    }

    private void HandleBattleStarted(BattleSession session) { /* open battle UI */ }
    private void HandleBattleEnded(BattleResult result)     { /* close battle UI, show result */ }
}
```

Always unsubscribe in `OnDisable`/`OnDestroy`.

## `BattleSession`

`BattleSession` is the payload of `OnBattleStarted`. It is a snapshot — it does not update as the battle progresses.

| Field | Type | Notes |
|-------|------|-------|
| `BattleType` | string | `"ONEvONE"` etc. |
| `PlayerTrainerId` | Guid | The local player's trainer ID |
| `OpponentTrainerId` | Guid | The NPC or wild trainer ID |
| `PlayerTurnKey` | string | Round key returned by `IBattleClient.GetRoundKeyAsync`; pass this to the server when submitting a move |
| `Kind` | `BattleRequestKind` | `NpcTrainer`, `Wild`, or `PvP` |

`PlayerTurnKey` is always non-null when `OnBattleStarted` fires — `BattleCoordinator` awaits `GetRoundKeyAsync` before raising the event.

## `BattleResult`

`BattleResult` is the payload of `OnBattleEnded`.

| Field | Type | Notes |
|-------|------|-------|
| `WinnerTrainerId` | Guid? | Null on draw or forfeit |
| `Reason` | string | `"AllCreaturesFainted"`, `"Forfeit"`, etc. |

## `IBattleClient`

`IBattleClient` is the HTTP interface to the battle REST API. `BattleClientUnityHttp` is the concrete implementation using Best HTTP (`SimpleWebClient`).

```csharp
public interface IBattleClient
{
    Task<StartBattleResponse>    StartBattleAsync(StartBattleRequest request, CancellationToken ct);
    Task<BattleRoundKeyResponse> GetRoundKeyAsync(Guid battleId, Guid trainerId, CancellationToken ct);
    Task<SubmitInputResponse>    SubmitInputAsync(Guid battleId, SubmitBattleInputRequest request, CancellationToken ct);
    Task<BattleStateResponse>    GetBattleStateAsync(Guid battleId, CancellationToken ct);
}
```

The base URL is read from `game_config.yaml` via `GameConfigurationKeys.BattleServerHttpAddress`.

## NPC Trainer Battle Flow

1. Player enters `NpcInteractionBehaviour` trigger radius and presses **E**
2. `NpcInteractionBehaviour` checks `NpcTrainerBehaviour.CanBattle` and that no creature grant is pending
3. Builds an `NpcBattleRequest` (NPC ID, NPC trainer ID, creature team, battle items) and fires `OnBattleRequested`, then calls `BattleCoordinator.StartNpcBattle(request)`
4. `BattleCoordinator` calls `IBattleClient.StartBattleAsync` → server creates battle row, returns `BattleId` and assigns round keys
5. `BattleCoordinator` calls `IBattleClient.GetRoundKeyAsync(battleId, playerTrainerId)` → receives the player's round key
6. `BattleCoordinator` populates `BattleSession` and fires `OnBattleStarted`

## Wild Creature Battle Flow

1. `SpawnerWorldBehaviour.InitializeAsync` completes → calls `SpawnerEncounterBehaviour.Activate(spawnerId, wildTrainerId)`
2. `SpawnerEncounterBehaviour` enables its `SphereCollider` trigger
3. Player walks into the trigger → `OnTriggerEnter` checks `other.tag == "Player"`
4. Builds a `WildBattleRequest` and calls `BattleCoordinator.StartWildBattle(request)`
5. Same `IBattleClient.StartBattleAsync` + `GetRoundKeyAsync` flow as NPC battles
6. On `OnBattleEnded`, `SpawnerEncounterBehaviour` re-enables its trigger (reset for next encounter)

## PvP — Phase 2

`BattleRequestKind.PvP` exists as an enum value. `BattleCoordinator` has no `StartPvpBattle` method yet. PvP requires a lobby / matchmaking layer to coordinate both clients and calls `StartBattleAsync` with two real trainer IDs. Planned for Phase 2.

## `SpawnerEncounterBehaviour`

`SpawnerEncounterBehaviour` is a `[RequireComponent(typeof(SpawnerWorldBehaviour))]` component that turns a spawner zone into a physical encounter trigger.

`SpawnerEncounterBehaviour` does **not** implement `IWorldInitializable`. It is activated explicitly by `SpawnerWorldBehaviour` after `InitializeAsync` completes:

```csharp
// Inside SpawnerWorldBehaviour.InitializeAsync (simplified):
_encounterBehaviour.Activate(spawnerId, wildTrainerId);
```

Once activated, the `SphereCollider` is enabled. Any `OnTriggerEnter` with tag `"Player"` calls `BattleCoordinator.StartWildBattle`. The trigger is disabled for the battle duration and re-enabled when `IBattleCoordinator.OnBattleEnded` fires.

### Inspector Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `_encounterRadius` | float | 5f | `SphereCollider` trigger radius (synced via `OnValidate`) |

### Adding to a Spawner Zone

1. Select the spawner zone — it must have `SpawnerWorldBehaviour`
2. Add `SpawnerEncounterBehaviour` (Unity enforces `RequireComponent`)
3. Set `_encounterRadius`
4. Ensure the player root has tag `"Player"`

```
GameObject: SpawnerZone_GroveZone
├─ SpawnerWorldBehaviour
│    _spawnerContentKey: "starter-wild-zone"
└─ SpawnerEncounterBehaviour
     _encounterRadius: 8
```

## `WildBattleRequest`

```csharp
public record WildBattleRequest(
    Guid AccountId,
    Guid PlayerTrainerId,
    Guid SpawnerId,
    Guid WildTrainerId
);
```

`WildTrainerId` in Phase 1 is the spawner's own ID used as a proxy for the wild side. A future phase will introduce proper wild trainer rows.

## Gotchas

**`CurrentTrainerId` null check.** `BattleCoordinator` verifies a trainer session is active before calling `IBattleClient`. If `GameSessionManager.CurrentTrainerId` is null, the call is dropped and an error is logged. Symptom: E-press or zone entry does nothing. Fix: ensure world bootstrap completed and a trainer session is active.

**Battle already in progress.** `BattleCoordinator` guards against concurrent starts with a `_battleInProgress` flag. A second `StartNpcBattle` or `StartWildBattle` while a battle is active is ignored with a warning log.

**`OnBattleEnded` not firing.** If the battle resolves without `EndBattle` being called, `SpawnerEncounterBehaviour` never resets and the zone stays locked. Ensure all resolution paths (win, loss, forfeit) call `IBattleCoordinator.EndBattle`.

**`IBattleClient` server address.** `BattleClientUnityHttp` reads `game_config.yaml` key `battle_server_http_address`. In local dev this is `http://localhost:8080`. Ensure the AIO host is running before testing battles in play mode.

## Related Pages

- [Battle Persistence](?page=backend/09-battle-persistence) — DB tables, `IBattleDomainService`, REST endpoints
- [Content Registry](?page=unity/08-content-registry) — content keys for creature species in battle
- [World Behaviours](?page=unity/03-world-behaviours) — `SpawnerWorldBehaviour`, `IWorldInitializable`
- [NPC Interaction](?page=unity/04-npc-interaction) — `NpcInteractionBehaviour` fires `OnBattleRequested`
- [Dependency Injection](?page=unity/02-dependency-injection) — `IBattleCoordinator` and `IBattleClient` bindings
