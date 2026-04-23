# Battle System

The battle system connects scene-level events (NPC interaction, wild encounter triggers) to the server-side battle engine via a REST API. `BattleCoordinator` is the single entry point for all battle initiation in the Unity client. All battle state is DB-backed on the server — see [Battle Persistence](?page=backend/09-battle-persistence) for the backend detail.

## Battle Types

| Type | Status | Entry Point |
|------|--------|-------------|
| NPC Trainer | Implemented | `NpcInteractionBehaviour` E-press → `BattleCoordinator.StartNpcBattle` |
| Wild Creature | Implemented | `SpawnerEncounterBehaviour` trigger → `BattleCoordinator.StartWildBattle` |
| PvP | Future | Networking not yet implemented |

## `BattleCoordinator`

`BattleCoordinator` is a MonoBehaviour singleton bound as `IBattleCoordinator`. It is the only component that may call `IBattleDomainService` to start a battle or drive the turn loop. Scene components inject `IBattleCoordinator` — never the concrete class.

### Installer Binding

```csharp
// LocalDevGameInstaller.cs — battle stack
var gameDatabaseCs = connectionStringFactory.GetConnectionStringForRepository(LocalDataSources.GameOfflineRepository);
var battleRepo     = new CR.Game.Data.Sqlite.BattleRepository(logger, gameDatabaseCs);
Container.Bind<CR.Game.Data.Interface.IBattleRepository>().FromInstance(battleRepo).AsSingle();

// IBattleDomainService routes to HTTP (online) or DLL BattleDomainService (offline)
Container.Bind<IBattleDomainService>().WithId("battle_online") .To<BattleHttpDomainAdapter>().AsSingle();
Container.Bind<IBattleDomainService>().WithId("battle_offline").To<BattleDomainService>().AsSingle();
Container.Bind<IBattleDomainService>().To<OnlineOfflineBattleDomainService>().AsSingle();

Container.Bind<IWildBattleAIDomainService>().To<WildBattleAIDomainService>().AsSingle();

Container.Bind<IBattleCoordinator>()
    .To<BattleCoordinator>()
    .FromNewComponentOnNewGameObject()
    .AsSingle();

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
| `OnBattleStarted` | `BattleSession` | After `IBattleDomainService.StartBattleAsync` returns and the arena is activated |
| `OnBattleEnded` | `BattleResult` | After the turn loop ends (win/loss/draw/escape) |

### Static `BattleEvents`

`BattleEvents` is a static class in `CR.Game.Battle.Events` that fires events for animation and HUD updates during the sequential turn loop.

| Event | Signature | Description |
|-------|-----------|-------------|
| `BattleStarted` | `(string battleId, string activeTrainerId)` | Battle started, first active trainer set |
| `PlayerTurnStarted` | `(string activeCreatureId, List<WildAbilityDto> abilities)` | HUD should show action menu with ability list |
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
           IBattleDomainService.SubmitActionAsync → ActionOutcome
       else
           IWildBattleAIDomainService.DecideActionAsync → submit via IBattleDomainService
           IBattleDomainService.SubmitActionAsync → ActionOutcome
    └─ FireOutcomeEvents (HP bars, faint animations)
    └─ if outcome.BattleEnded → RaiseBattleEnded → break
       else advance activeTrainerId (Guid) + NextRoundKey
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

## `IBattleDomainService` (Unity-side)

`BattleCoordinator` injects `IBattleDomainService` — the same DLL interface the backend implements. Online calls are routed through `BattleHttpDomainAdapter` (HTTP to the REST API); offline calls go directly to the DLL's `BattleDomainService` backed by the local `game.bytes` SQLite file.

`OnlineOfflineBattleDomainService` selects the active implementation from `IGameDataRepository.IsPlayingOnline` at call time — no restart needed to switch modes.

The HTTP base URL is read from `game_config.yaml` via `GameConfigurationKeys.BattleServerHttpAddress`.

## Arena System

`BattleArena` is a MonoBehaviour placed in scenes to define a battle location.

| Inspector Field | Type | Description |
|-----------------|------|-------------|
| `arenaKey` | string | Must match `SpawnerWorldBehaviour._battleArenaKey` / `SpawnerDefinition.battleArenaKey` |
| `playerTrainerPosition` | Transform | Where the player trainer stands |
| `opponentTrainerPosition` | Transform | Where the opponent trainer stands |
| `playerCreaturePosition` | Transform | Where the player's active creature spawns |
| `opponentCreaturePosition` | Transform | Where the opponent's active creature spawns |
| `cameraLookTarget` | Transform | `BattleCameraController` lerps to look at this |
| `defaultBiome` | `BiomeType` | The biome active when the arena awakens |
| `biomes` | `BiomeEnvironment[]` | Maps each `BiomeType` to a root `GameObject` to activate/deactivate |

`BiomeType` enum values: `Grassland`, `Forest`, `Cave`, `Desert`, `Mountain`, `Beach`, `Swamp`, `Tundra`, `Volcanic`.

`BattleArena.Activate(BiomeType? biome)` activates the arena at the given (or default) biome. `SetBiome(biome)` can be called at any time to swap active environment roots. `Deactivate()` hides all environment roots.

Use **CR > Battle > Create Placeholder Arena** (editor menu) to scaffold a new arena GameObject with all child transforms pre-wired and `arenaKey` set to `"arena_placeholder"`.

`BattleArenaRegistry` implements `IWorldInitializable` and indexes all `BattleArena` components in the scene by `arenaKey` at world init. It is bound as `IBattleArenaRegistry`.

`BattleCameraController` is a MonoBehaviour that saves and restores camera position. `EnterBattle(lookTarget)` lerps the main camera toward the arena; `ExitBattle()` lerps back.

## `SpawnerEncounterBehaviour`

Adds a random 2–5 s delay before triggering a battle. If the player exits the trigger zone during the delay the encounter is cancelled.

| Inspector Field | Type | Default | Description |
|-----------------|------|---------|-------------|
| `_encounterRadius` | float | 5f | `SphereCollider` trigger radius |
| `encounterDelayMin` | float | 2f | Minimum seconds before battle starts after player enters zone |
| `encounterDelayMax` | float | 5f | Maximum seconds before battle starts after player enters zone |

On `OnTriggerEnter` (Player tag), a coroutine `EncounterDelayRoutine` is started. If the player leaves the zone (`OnTriggerExit`) before the delay expires, the coroutine is cancelled. After the delay, `BattleCoordinator.StartWildBattle` is called with the `battleArenaKey` from `SpawnerWorldBehaviour`.

`SpawnerWorldBehaviour` now has a `_battleArenaKey` field that is passed through to `SpawnerEncounterBehaviour.Activate(...)` and embedded in `WildBattleRequest.BattleArenaKey`.

## Wild Battle AI

`BattleCoordinator` injects `IWildBattleAIDomainService` (the DLL interface). The same `WildBattleAIDomainService` runs both client-side (offline) and server-side (via the `/wild-turn` endpoint in online mode).

Decision priority:
1. 20% random chance → use a Status-category ability if one exists
2. Default → use the highest-power non-Status ability

Abilities are loaded from the wild creature's progression set at its current level. Falls back to a global paginated query when no set is assigned.

## `BattleAnimationConfig`

A `ScriptableObject` created via `Assets > Create > CR > Battle > Animation Config`. Maps ability keys to clip names and VFX prefabs. `GetEntry(abilityKey)` falls back to a `"default"` entry if no exact match is found.

Each `BattleAnimationEntry` now includes `attackClipOverride` (string, default empty). When non-empty, this overrides the creature's `defaultAttackClip` from its `CreatureAnimationProfile`.

## `CreatureAnimationProfile`

A `ScriptableObject` created via `Assets > Create > CR > Battle > Creature Animation Profile`. Holds per-creature animator state names.

| Field | Default | Description |
|-------|---------|-------------|
| `defaultAttackClip` | `"Attack"` | Animator state for the default attack (used when ability has no override) |
| `hitClip` | `"Hit"` | Animator state when the creature takes damage |
| `faintClip` | `"Faint"` | Animator state when the creature faints |
| `idleClip` | `"Idle"` | Animator state during idle |

Assign a `CreatureAnimationProfile` to `BattleCoordinator._defaultAnimProfile`. `BattleCoordinator.FireOutcomeEvents` resolves clip names as: `BattleAnimationConfig.attackClipOverride` → `CreatureAnimationProfile.defaultAttackClip` → hard-coded fallback `"Attack"`.

## Offline Battle Stack

The offline battle stack uses the DLL's `BattleDomainService` (same class the backend uses) backed by a local SQLite file (`game.bytes`). Battle tables are created by `DatabaseMigrationRunner.MigrateDomain` on startup.

| Component | Role |
|-----------|------|
| `CR.Game.Data.Sqlite.BattleRepository` | DLL SQLite implementation of `IBattleRepository`; stores battles, rounds, creature states, action log in `game.bytes` |
| `CR.Game.Domain.Services.Implementation.Battle.BattleDomainService` | DLL domain service; full offline battle logic — speed-based first-mover, `BattleResolver` damage, escape RNG, wild creature soft-delete |
| `BattleHttpDomainAdapter` | Online path: implements `IBattleDomainService` against the REST API |
| `OnlineOfflineBattleDomainService` | Routes calls to `battle_online` or `battle_offline` binding based on `IsPlayingOnline` |

> **Note:** The legacy Unity-side stack (`IBattleClient` / `BattleClientUnityHttp` / `OfflineBattleClient` / `OfflineBattleService` / `IBattleRepository` under `CR.Game.Battle.Offline` / `SqliteOfflineBattleRepository`) was removed in favour of the DLL's `IBattleDomainService`. New code must not reintroduce those types.

The `game.bytes` file is keyed as `LocalDataSources.GameOfflineRepository` and resolved to `database_path_game` in `game_config.yaml` (defaults to `{persistentDataPath}/databases/gameOffline.bytes`).

## `BattleHUD`

`BattleHUD` (`Assets/CR/UI/Battle/BattleHUD.cs`) is a MonoBehaviour overlay built with **UI Toolkit** (UIDocument). It subscribes to `BattleEvents` and never calls the API directly.

**Files:**
- `BattleHUD.cs` — MonoBehaviour; queries elements and wires button callbacks
- `BattleBagPanelHandler.cs` — MonoBehaviour; manages the in-battle Items/Bag panel
- `Resources/BattleHUD.uxml` — layout: opponent panel (top-right), player panel (bottom-left), battle log, action menu (Battle / Items / Run), ability panel
- `Resources/BattleHUD.uss` — styles; root has `picking-mode="Ignore"` so clicks pass through to the 3D world
- `UI/Battle/BattleBagPanel.uxml` — bag panel layout (item list, party slots, confirm/cancel)

**Setup:**
1. Add a `UIDocument` + `BattleHUD` MonoBehaviour to a GameObject in the scene. `BattleHUD.Awake` auto-loads `Resources/BattleHUD.uxml` if none is assigned.
2. Add `BattleBagPanelHandler` as a second component on the **same GameObject** (or a sibling with its own UIDocument). Assign its `UIDocument` field.
3. On the `BattleHUD` component, assign the `BattleBagPanelHandler` component to the **Bag Panel Handler** SerializeField.

The root is hidden (`DisplayStyle.None`) on start and shown when `BattleEvents.BattleStarted` fires.

**Action menu buttons:** Battle (opens ability grid) → Items (opens bag panel via `BattleBagPanelHandler.Open`) → Run (submits `[{"type":4}]`)

**HP bars** are custom `VisualElement` fills; width is set via `style.width = Length.Percent(ratio * 100f)` with a USS `transition-duration: 0.3s` for smooth animation.

**Turn flow:**
1. `PlayerTurnStarted` fires → `ActionMenu` shown; ability list cached in `_currentAbilities`; ability buttons pre-populated
2. Player presses **Battle** → `ActionMenu` hidden, `AbilityPanel` shown (2×2 grid of up to 4 abilities)
3. Player presses an ability → `AbilityPanel` hidden; `SubmitPlayerAction` called with `[{"type":0,"abilityId":"<guid>","targetCreatureId":"<opponentId>"}]`
4. Player presses **Items** → `ActionMenu` hidden, `BattleBagPanelHandler.Open` called; on confirm `BattleCoordinator.SubmitPlayerAction` is called (or `EndBattle` on capture)
5. Player presses **Run** → submits `[{"type":4}]`

Ability button labels show `"Name (Power)"` e.g. `"Fire Bolt (50)"`. Buttons with no ability are disabled and styled with `.ability-btn--disabled`. `BattleActionType` enum: Ability=0, Item=2, Switch=3, Run=4.

`playerAbilities` is populated by `BattleCoordinator.BuildAbilityListAsync` — it queries `IAbilityRepository.GetAbilitiesForProgressionSetAtLevelAsync` for the player's active creature and maps to `WildAbilityDto` for the HUD. `BattleStateDto` (DLL type) does not include ability lists; they are assembled client-side.

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
4. `BattleCoordinator` calls `IBattleDomainService.StartBattleAsync` → `GetBattleStartResultAsync` → fires `OnBattleStarted`

## Wild Creature Battle Flow

1. `SpawnerWorldBehaviour.InitializeAsync` completes → calls `SpawnerEncounterBehaviour.Activate(context, spawnerId, wildTrainerId, battleArenaKey)`
2. Player walks into the trigger → `OnTriggerEnter` starts `EncounterDelayRoutine` (2–5s random)
3. If player stays → `StartWildBattle` fires → `StartWildBattleAsync` begins the turn loop
4. If player exits before delay → coroutine cancelled, no battle
5. Turn loop runs until `outcome.battleEnded == true`, then `BattleEvents.RaiseBattleEnded` fires

## Gotchas

**`CurrentTrainerId` null check.** `BattleCoordinator` verifies a trainer session is active before calling `IBattleDomainService`. If the session trainer ID is null, the call is dropped and an error is logged.

**Battle already in progress.** `BattleCoordinator` guards against concurrent starts with a `_battleInProgress` flag. A second `StartWildBattle` while a battle is active is ignored with a warning.

**`SubmitPlayerAction` without a pending turn.** If called when no `TaskCompletionSource` is waiting, a warning is logged and the call is a no-op.

**`EndBattle` idempotency.** `EndBattle` is guarded by a `_battleEnded` bool flag and returns immediately on repeated calls. This prevents double-invocation when `OperationCanceledException` unwinds the turn loop (e.g. player disconnect) while the `finally` block also calls `EndBattle`. The flag is reset at the start of each new battle in `StartWildBattleAsync`.

**`OperationCanceledException` in the turn loop.** When `EndBattle` cancels the `_playerActionSource` TCS during a forced exit, the awaited `_playerActionSource.Task` throws `OperationCanceledException`. A dedicated `catch (OperationCanceledException)` block before the generic `catch (Exception ex)` swallows this silently — it is not an error, and `EndBattle` in `finally` handles cleanup.

**`BattleHttpDomainAdapter` server address.** Reads `game_config.yaml` key `battle_server_http_address`. In local dev this is `http://localhost:8080`. Ensure the AIO host is running.

**`BattleArenaRegistry` requires world init.** Arenas are indexed during `IWorldInitializable.InitializeAsync`. If a battle starts before world init completes, `TryGetArena` returns false and the arena step is skipped gracefully.

## Related Pages

- [Battle Persistence](?page=backend/09-battle-persistence) — DB tables, `IBattleDomainService`, REST endpoints
- [Content Registry](?page=unity/08-content-registry) — content keys and `SpawnerDefinition`
- [World Behaviours](?page=unity/03-world-behaviours) — `SpawnerWorldBehaviour`, `IWorldInitializable`
- [NPC Interaction](?page=unity/04-npc-interaction) — `NpcInteractionBehaviour` fires `OnBattleRequested`
- [Dependency Injection](?page=unity/02-dependency-injection) — `IBattleCoordinator` and `IBattleDomainService` bindings
