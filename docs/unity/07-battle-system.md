# Battle System

The battle system connects scene-level events (NPC interaction, wild encounter triggers) to the server-side battle engine via a REST API. `BattleCoordinator` is the single entry point for all battle initiation in the Unity client. All battle state is DB-backed on the server — see [Battle Persistence](?page=backend/09-battle-persistence) for the backend detail.

## Battle Types

| Type | Status | Entry Point |
|------|--------|-------------|
| NPC Trainer | Implemented | `NpcInteractionBehaviour` E-press → `BattleCoordinator.StartNpcBattle` |
| Wild Creature | Implemented | `SpawnerEncounterBehaviour` trigger → `BattleCoordinator.StartWildBattle` |
| PvP | Future | Networking not yet implemented |

## `BattleCoordinator`

`BattleCoordinator` is a MonoBehaviour singleton bound as `IBattleCoordinator`. It is the only component that may call `IBattleClient` to start a battle or drive the turn loop. Scene components inject `IBattleCoordinator` — never the concrete class.

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

// Phase 3 additions
Container.Bind<IWildBattleAIService>().To<LocalWildBattleAIService>().AsSingle();
Container.Bind<IBattleArenaRegistry>().To<BattleArenaRegistry>()
    .FromNewComponentOnNewGameObject().AsSingle();
Container.Bind<IBattleCameraController>().To<BattleCameraController>()
    .FromNewComponentOnNewGameObject().AsSingle();
```

### Public API

```csharp
public interface IBattleCoordinator
{
    event Action<BattleSession> OnBattleStarted;
    event Action<BattleResult>  OnBattleEnded;

    void StartNpcBattle (NpcBattleRequest  request);
    void StartWildBattle(WildBattleRequest request);

    /// Resolves the pending player turn. Call from HUD when player picks an action.
    void SubmitPlayerAction(string actionJson);
}
```

### Events

| Event | Payload | When it fires |
|-------|---------|---------------|
| `OnBattleStarted` | `BattleSession` | After `IBattleClient.StartBattleAsync` returns and the arena is activated |
| `OnBattleEnded` | `BattleResult` | After the turn loop ends (win/loss/draw/escape) |

### Static `BattleEvents`

`BattleEvents` is a static class in `CR.Game.Battle.Events` that fires events for animation and HUD updates during the sequential turn loop.

| Event | Signature | Description |
|-------|-----------|-------------|
| `BattleStarted` | `(string battleId, string activeTrainerId)` | Battle started, first active trainer set |
| `PlayerTurnStarted` | `(string activeCreatureId, string[] abilityIds)` | HUD should show action menu |
| `CreatureAttacking` | `(string creatureId, string attackClip)` | Play attack animation |
| `CreatureHit` | `(string creatureId, int damage)` | Display damage number |
| `HpChanged` | `(string creatureId, int finalHp, int maxHp)` | Update HP bar |
| `CreatureFainted` | `(string creatureId)` | Play faint animation |
| `BattleEnded` | `(bool playerWon, string outcomeLabel)` | Show result screen |
| `RunAttempted` | `(bool success)` | Show escape message |

## Wild Battle Turn Loop

Wild battles drive a sequential turn loop entirely client-side. The server resolves each half-turn via a dedicated endpoint.

```
StartBattleAsync
    └─ if activeTrainer == player
           RaisePlayerTurnStarted → await SubmitPlayerAction()
           SubmitActionAsync → ActionOutcomeResponse
       else
           SubmitWildTurnAsync → ActionOutcomeResponse
    └─ FireOutcomeEvents (HP bars, faint animations)
    └─ if outcome.battleEnded → RaiseBattleEnded → break
       else advance activeTrainerId + roundKey
```

`SubmitPlayerAction(string actionJson)` is called by the HUD (or any input handler) to unblock the `TaskCompletionSource` awaited in the loop. The action JSON matches the backend's action format, e.g. `[{"type":0,"abilityId":"...","targetCreatureId":"..."}]`.

The wild trainer GUID is `00000000-0000-0000-0000-000000000001` (defined in `WildTrainerIds.WildTrainerId`).

## `BattleSession`

`BattleSession` is the payload of `OnBattleStarted`. It is a snapshot — it does not update as the battle progresses.

| Field | Type | Notes |
|-------|------|-------|
| `BattleType` | string | `"ONEvONE"` etc. |
| `PlayerTrainerId` | Guid | The local player's trainer ID |
| `OpponentTrainerId` | Guid | The NPC or wild trainer ID |
| `PlayerTurnKey` | string | Round key for round 1 — stored on the session but superseded by `ActionOutcome.NextRoundKey` from each `SubmitActionAsync` response as the loop advances |
| `Kind` | `BattleRequestKind` | `NpcTrainer`, `Wild`, or `PvP` |

## `BattleResult`

`BattleResult` is the payload of `OnBattleEnded`.

| Field | Type | Notes |
|-------|------|-------|
| `WinnerTrainerId` | Guid? | Null on draw or forfeit |
| `Reason` | string | `"AllCreaturesFainted"`, `"Forfeit"`, `"loop_complete"`, etc. |

## `IBattleClient`

`IBattleClient` is the HTTP interface to the battle REST API. `BattleClientUnityHttp` is the concrete implementation.

```csharp
public interface IBattleClient
{
    // Active methods used by the wild-battle turn loop
    Task<StartBattleResponse>       StartBattleAsync(StartBattleRequest request, CancellationToken ct);
    Task<BattleStateResponse>       GetBattleStateAsync(Guid battleId, CancellationToken ct);
    Task<ActionOutcomeResponse>     SubmitActionAsync(Guid battleId, SubmitActionRequest request, CancellationToken ct);
    Task<ActionOutcomeResponse>     SubmitWildTurnAsync(Guid battleId, CancellationToken ct);
    Task<RunAttemptResponse>        TryRunAsync(Guid battleId, Guid trainerId, CancellationToken ct);

    // Legacy methods — kept for NPC battle compatibility; not used in wild-battle flow
    Task<BattleRoundKeyResponse>    GetRoundKeyAsync(Guid battleId, Guid trainerId, CancellationToken ct);
    Task<SubmitBattleInputResponse> SubmitInputAsync(Guid battleId, SubmitBattleInputRequest request, CancellationToken ct);
}
```

`StartBattleResponse` includes `ActiveTrainerId` and `RoundKey` fields so the turn loop can begin immediately without a separate `GetRoundKeyAsync` call.

The base URL is read from `game_config.yaml` via `GameConfigurationKeys.BattleServerHttpAddress`.

## Arena System

`BattleArena` is a MonoBehaviour placed in scenes to define a battle location.

| Inspector Field | Type | Description |
|-----------------|------|-------------|
| `arenaKey` | string | Must match `SpawnerWorldBehaviour._battleArenaKey` / `SpawnerDefinition.battleArenaKey` |
| `playerSpawnPoint` | Transform | Where the player's creature spawns |
| `opponentSpawnPoint` | Transform | Where the wild creature spawns |
| `cameraLookTarget` | Transform | `BattleCameraController` lerps to look at this |
| `environmentRoot` | GameObject | Activated/deactivated by `Activate()`/`Deactivate()` |

`BattleArenaRegistry` implements `IWorldInitializable` and indexes all `BattleArena` components in the scene by `arenaKey` at world init. It is bound as `IBattleArenaRegistry`.

`BattleCameraController` is a MonoBehaviour that saves and restores camera position. `EnterBattle(lookTarget)` lerps the main camera toward the arena; `ExitBattle()` lerps back.

## `SpawnerEncounterBehaviour`

Enhanced in Phase 3 to include an encounter delay and zone-exit cancellation.

| Inspector Field | Type | Default | Description |
|-----------------|------|---------|-------------|
| `_encounterRadius` | float | 5f | `SphereCollider` trigger radius |
| `encounterDelayMin` | float | 2f | Minimum seconds before battle starts after player enters zone |
| `encounterDelayMax` | float | 5f | Maximum seconds before battle starts after player enters zone |

On `OnTriggerEnter` (Player tag), a coroutine `EncounterDelayRoutine` is started. If the player leaves the zone (`OnTriggerExit`) before the delay expires, the coroutine is cancelled. After the delay, `BattleCoordinator.StartWildBattle` is called with the `battleArenaKey` from `SpawnerWorldBehaviour`.

`SpawnerWorldBehaviour` now has a `_battleArenaKey` field that is passed through to `SpawnerEncounterBehaviour.Activate(...)` and embedded in `WildBattleRequest.BattleArenaKey`.

## Wild Battle AI

`LocalWildBattleAIService` (`IWildBattleAIService`) provides client-side wild battle AI decisions. The server's `SubmitWildTurnAsync` endpoint uses `WildBattleAIDomainService` in online mode; this service runs locally for offline scenarios.

Decision priority:
1. If `currentHp / maxHp < 30%` AND a healing item is available in `wildTrainerItems` → use item (type 2)
2. 20% random chance → use a Status-category ability if one exists in `wildAbilities`
3. Default → use the highest-power non-Status ability from `wildAbilities`

The backend `WildBattleAIDomainService` omits the HP/healing check (it queries abilities globally, not per-creature). The two AIs produce equivalent behaviour when no healing items are available.

## `BattleAnimationConfig`

A `ScriptableObject` created via `Assets > Create > CR > Battle > Animation Config`. Maps ability keys to clip names and VFX prefabs. `GetEntry(abilityKey)` falls back to a `"default"` entry if no exact match is found.

## `BattleHUD`

`BattleHUD` (`Assets/CR/UI/Battle/BattleHUD.cs`) is a MonoBehaviour that subscribes to `BattleEvents` and updates uGUI elements. Requires a Canvas with:
- `PlayerPanel/CreatureName` (Text) and `PlayerPanel/HpBar` (Slider)
- `OpponentPanel/CreatureName` (Text) and `OpponentPanel/HpBar` (Slider)
- `ActionMenu/` with `BattleButton` and `RunButton` (Buttons; hidden on non-player turns)
- `BattleLog/LogText` (Text; shows last 4 battle events)

`BattleButton` calls `IBattleCoordinator.SubmitPlayerAction("[{\"type\":0}]")` (default attack). `RunButton` submits type 4 (Run). The `BattleActionType` enum values are: Ability=0, Item=2, Switch=3, Run=4. A full implementation should open an ability picker sub-menu.

## `WildBattleRequest`

```csharp
public record WildBattleRequest(
    Guid AccountId,
    Guid PlayerTrainerId,
    Guid SpawnerId,
    Guid WildTrainerId,
    string BattleArenaKey = ""
);
```

`BattleArenaKey` is optional. When empty, `BattleCoordinator` skips arena teleportation and camera transition.

## NPC Trainer Battle Flow

1. Player enters `NpcInteractionBehaviour` trigger radius and presses **E**
2. `NpcInteractionBehaviour` checks `NpcTrainerBehaviour.CanBattle` and that no creature grant is pending
3. Builds an `NpcBattleRequest` and calls `BattleCoordinator.StartNpcBattle(request)`
4. `BattleCoordinator` calls `IBattleClient.StartBattleAsync` → `GetRoundKeyAsync` → fires `OnBattleStarted`

## Wild Creature Battle Flow

1. `SpawnerWorldBehaviour.InitializeAsync` completes → calls `SpawnerEncounterBehaviour.Activate(context, spawnerId, wildTrainerId, battleArenaKey)`
2. Player walks into the trigger → `OnTriggerEnter` starts `EncounterDelayRoutine` (2–5s random)
3. If player stays → `StartWildBattle` fires → `StartWildBattleAsync` begins the turn loop
4. If player exits before delay → coroutine cancelled, no battle
5. Turn loop runs until `outcome.battleEnded == true`, then `BattleEvents.RaiseBattleEnded` fires

## Gotchas

**`CurrentTrainerId` null check.** `BattleCoordinator` verifies a trainer session is active before calling `IBattleClient`. If `GameSessionManager.CurrentTrainerId` is null, the call is dropped and an error is logged.

**Battle already in progress.** `BattleCoordinator` guards against concurrent starts with a `_battleInProgress` flag. A second `StartWildBattle` while a battle is active is ignored with a warning.

**`SubmitPlayerAction` without a pending turn.** If called when no `TaskCompletionSource` is waiting, a warning is logged and the call is a no-op.

**`EndBattle` idempotency.** `EndBattle` is guarded by a `_battleEnded` bool flag and returns immediately on repeated calls. This prevents double-invocation when `OperationCanceledException` unwinds the turn loop (e.g. player disconnect) while the `finally` block also calls `EndBattle`. The flag is reset at the start of each new battle in `StartWildBattleAsync`.

**`OperationCanceledException` in the turn loop.** When `EndBattle` cancels the `_playerActionSource` TCS during a forced exit, the awaited `_playerActionSource.Task` throws `OperationCanceledException`. A dedicated `catch (OperationCanceledException)` block before the generic `catch (Exception ex)` swallows this silently — it is not an error, and `EndBattle` in `finally` handles cleanup.

**`IBattleClient` server address.** `BattleClientUnityHttp` reads `game_config.yaml` key `battle_server_http_address`. In local dev this is `http://localhost:8080`. Ensure the AIO host is running.

**`BattleArenaRegistry` requires world init.** Arenas are indexed during `IWorldInitializable.InitializeAsync`. If a battle starts before world init completes, `TryGetArena` returns false and the arena step is skipped gracefully.

## Related Pages

- [Battle Persistence](?page=backend/09-battle-persistence) — DB tables, `IBattleDomainService`, REST endpoints
- [Content Registry](?page=unity/08-content-registry) — content keys and `SpawnerDefinition`
- [World Behaviours](?page=unity/03-world-behaviours) — `SpawnerWorldBehaviour`, `IWorldInitializable`
- [NPC Interaction](?page=unity/04-npc-interaction) — `NpcInteractionBehaviour` fires `OnBattleRequested`
- [Dependency Injection](?page=unity/02-dependency-injection) — `IBattleCoordinator` and `IBattleClient` bindings
