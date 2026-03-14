# Battle System

The battle system connects scene-level events (NPC interaction, wild encounter triggers) to the core `IBattleSystem` engine. `BattleCoordinator` is the single entry point for all battle initiation in the Unity client.

## Battle Types

| Type | Status | Entry Point |
|------|--------|-------------|
| NPC Trainer | Implemented | `NpcInteractionBehaviour` E-press → `BattleCoordinator.StartNpcBattle` |
| Wild Creature | Implemented | `SpawnerEncounterBehaviour` trigger → `BattleCoordinator.StartWildBattle` |
| PvP | Phase 2 | Networking not yet implemented |

## `BattleCoordinator`

`BattleCoordinator` is a MonoBehaviour singleton bound as `IBattleCoordinator` in the Zenject installer. It is the only component that may call `IBattleSystem.InitializeBattle` or `ICombatAI.InitializeAsync`. Scene components that need to start or react to battles inject `IBattleCoordinator` — never the concrete class.

### Installer Binding

```csharp
// LocalDevGameInstaller.cs
Container.Bind<IBattleCoordinator>().FromComponentInHierarchy().AsSingle();
Container.Bind<ICombatAI>().To<BasicCombatAI>().AsSingle();
```

### Public API

```csharp
public interface IBattleCoordinator
{
    event Action<BattleSession> OnBattleStarted;
    event Action<BattleResult> OnBattleEnded;

    void StartNpcBattle(NpcBattleRequest request);
    void StartWildBattle(WildBattleRequest request);
    void EndBattle(Guid? winnerTrainerId, string reason);
}
```

### Events

| Event | Payload | When it fires |
|-------|---------|---------------|
| `OnBattleStarted` | `BattleSession` | After `IBattleSystem.OnPlayerTurn` fires — the player turn key is stamped on the session before this event |
| `OnBattleEnded` | `BattleResult` | After `EndBattle` is called by the battle engine or external resolver |

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
| `BattleId` | Guid | Unique ID for this battle instance |
| `BattleType` | string | Matches `IBattleSystem` battle type constant (e.g. `"ONEvONE"`) |
| `PlayerTrainerId` | Guid | The local player's trainer ID |
| `OpponentTrainerId` | Guid | The NPC trainer ID or wild spawner proxy ID |
| `PlayerTurnKey` | string | Opaque key set by `IBattleSystem.OnPlayerTurn`; pass to battle engine when submitting a player move |
| `Kind` | `BattleRequestKind` | `NpcTrainer`, `Wild`, or `PvP` |

`PlayerTurnKey` is only populated after `IBattleSystem.OnPlayerTurn` fires. `BattleCoordinator` waits for this event before firing `OnBattleStarted`, so `PlayerTurnKey` is always non-null when `OnBattleStarted` is received.

## `BattleResult`

`BattleResult` is the payload of `OnBattleEnded`.

| Field | Type | Notes |
|-------|------|-------|
| `WinnerTrainerId` | Guid? | Null on draw or forfeit |
| `Reason` | string | Human-readable reason (e.g. `"AllCreaturesFainted"`, `"Forfeit"`) |

## NPC Trainer Battle Flow

1. Player enters `NpcInteractionBehaviour` trigger radius and presses **E**
2. `NpcInteractionBehaviour` checks `NpcTrainerBehaviour.CanBattle` and that no grant is pending
3. `NpcInteractionBehaviour` builds an `NpcBattleRequest` and fires `OnBattleRequested`, then calls `BattleCoordinator.StartNpcBattle(request)`
4. `BattleCoordinator` creates `TrainerShim(request.TrainerId)` for the player and `TrainerShim(request.NpcId)` for the opponent
5. `IBattleSystem.InitializeBattle("ONEvONE", playerShim, npcShim)` is called
6. `ICombatAI.InitializeAsync(npcTrainerId, ...)` is called for the NPC opponent
7. `IBattleSystem.OnPlayerTurn` fires → `BattleCoordinator` stamps `PlayerTurnKey` on the `BattleSession`
8. `BattleCoordinator` fires `OnBattleStarted(session)` — subscribers open battle UI

## Wild Creature Battle Flow

1. `SpawnerWorldBehaviour.InitializeAsync` completes → calls `SpawnerEncounterBehaviour.Activate(spawnerId, wildTrainerId)`
2. `SpawnerEncounterBehaviour` enables its `SphereCollider` trigger
3. Player walks into the trigger → `OnTriggerEnter` checks `other.tag == "Player"`
4. `SpawnerEncounterBehaviour` builds a `WildBattleRequest` and calls `BattleCoordinator.StartWildBattle(request)`
5. `BattleCoordinator` creates `TrainerShim(request.PlayerTrainerId)` and `TrainerShim(request.WildTrainerId)`
6. `IBattleSystem.InitializeBattle("ONEvONE", playerShim, wildShim)` is called
7. `ICombatAI.InitializeAsync(wildTrainerId, ...)` is called for the wild side
8. `IBattleSystem.OnPlayerTurn` fires → session stamped → `OnBattleStarted` fires
9. On `OnBattleEnded`, `SpawnerEncounterBehaviour` re-enables its trigger (reset for next encounter)

## PvP — Phase 2

PvP is architecture-only in the current build. `BattleRequestKind.PvP` exists as an enum value, and `BattleCoordinator` has no `StartPvpBattle` method yet. PvP requires a networking layer (lobby, matchmaking, or direct peer connection) to coordinate `TrainerShim` construction on both clients simultaneously. This is planned for Phase 2.

## `SpawnerEncounterBehaviour`

`SpawnerEncounterBehaviour` is a `[RequireComponent(typeof(SpawnerWorldBehaviour))]` component that turns a spawner zone GameObject into a physical encounter trigger.

### How It Works

`SpawnerEncounterBehaviour` does **not** implement `IWorldInitializable`. It is activated explicitly by `SpawnerWorldBehaviour` after that behaviour's `InitializeAsync` completes:

```csharp
// Inside SpawnerWorldBehaviour.InitializeAsync (simplified):
_encounterBehaviour.Activate(spawnerId, wildTrainerId);
```

Once activated:
- The `SphereCollider` on the GameObject is enabled as a trigger
- Any `OnTriggerEnter` with tag `"Player"` calls `BattleCoordinator.StartWildBattle`
- The trigger is disabled for the duration of the battle
- `SpawnerEncounterBehaviour` subscribes to `IBattleCoordinator.OnBattleEnded` and re-enables the trigger when the battle concludes

### Inspector Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `_encounterRadius` | float | 5f | `SphereCollider` trigger radius |

### Adding to a Spawner Zone GameObject

1. Select the spawner zone GameObject — it must already have `SpawnerWorldBehaviour`
2. Add `SpawnerEncounterBehaviour` (Unity will enforce `SpawnerWorldBehaviour` via `RequireComponent`)
3. Set `_encounterRadius` to match the intended zone size
4. Ensure the player root has tag `"Player"`
5. The `SphereCollider` is configured at runtime — do not set it manually in the Inspector

### Example Inspector Setup

```
GameObject: SpawnerZone_MysticForest
├─ SpawnerWorldBehaviour
│    _spawnerContentKey: "mystic-wild-zone"
└─ SpawnerEncounterBehaviour
     _encounterRadius: 8
```

No additional coordinator script is needed — `SpawnerEncounterBehaviour` calls `IBattleCoordinator` directly.

## `TrainerShim`

`IBattleSystem.InitializeBattle` takes `ITrainer` instances for both sides of a battle. In most cases the full trainer object is not needed — only the trainer's ID matters for the battle engine to look up teams and resolve moves.

`TrainerShim` is a minimal `ITrainer` implementation that wraps a single `Guid`:

```csharp
public class TrainerShim : ITrainer
{
    public Guid TrainerId { get; }
    public TrainerShim(Guid trainerId) => TrainerId = trainerId;
}
```

`BattleCoordinator` constructs a `TrainerShim` for each side of every battle. Full trainer data (team, items) has already been seeded to the backend by the time the battle starts, so the battle engine fetches it server-side by `TrainerId`. The shim is never persisted.

`TrainerShim` lives in `CR.Game.Model/Trainers/TrainerShim.cs` on the backend and is mirrored client-side where needed.

## `WildBattleRequest`

```csharp
public record WildBattleRequest(
    Guid AccountId,
    Guid PlayerTrainerId,
    Guid SpawnerId,
    Guid WildTrainerId
);
```

`WildTrainerId` in Phase 1 is the spawner's own ID used as a proxy for the wild side. This is intentional — there is no dedicated wild trainer entity yet. A future phase will introduce proper wild trainer rows.

## Gotchas

**`CurrentTrainerId` null check.** Before calling `StartNpcBattle` or `StartWildBattle`, `BattleCoordinator` verifies that a trainer session is active. If `GameSessionManager.GetCurrentSession()` returns null (no trainer selected), the call is logged and dropped silently. Symptoms: E press or zone entry does nothing. Fix: ensure world bootstrap has completed and a trainer is selected.

**Battle already in progress.** `BattleCoordinator` guards against concurrent battle starts with an `_isBattleActive` flag. If `StartNpcBattle` or `StartWildBattle` is called while a battle is active, the call is ignored and a warning is logged. This prevents double-triggering if a player enters two encounter zones simultaneously or presses E rapidly.

**`SpawnerEncounterBehaviour` requires `SpawnerWorldBehaviour`.** `[RequireComponent]` prevents adding `SpawnerEncounterBehaviour` to a GameObject without `SpawnerWorldBehaviour`, but it does not prevent `SpawnerWorldBehaviour` from being removed after the fact. If `SpawnerWorldBehaviour` is missing at runtime, `Activate` is never called and the trigger never enables — the zone is silently inert.

**`OnBattleEnded` not firing.** If the battle engine resolves without calling `EndBattle`, `SpawnerEncounterBehaviour` never resets its trigger and the zone stays locked. Ensure all battle resolution paths (win, loss, forfeit, disconnect) call `IBattleCoordinator.EndBattle`.

## Related Pages

- [World Behaviours](?page=unity/03-world-behaviours) — `SpawnerWorldBehaviour`, `SpawnerEncounterBehaviour`, `IWorldInitializable`
- [NPC Interaction](?page=unity/04-npc-interaction) — `NpcInteractionBehaviour` fires `OnBattleRequested` and calls `StartNpcBattle`
- [Dependency Injection](?page=unity/02-dependency-injection) — `IBattleCoordinator` binding in installer
- [Spawner System](?page=backend/03-spawner-system) — backend spawner config, `SpawnerId` as wild trainer proxy
