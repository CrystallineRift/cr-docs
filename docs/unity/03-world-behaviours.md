# World Behaviours

The **World** system coordinates per-scene initialization of game objects after a trainer is selected. It solves a specific problem: multiple MonoBehaviours in the scene need to make backend calls using the current trainer's identity, but they do not know when that identity becomes available, and they must not depend on each other's initialization order.

## Why This Design?

### Why Not Use Unity's `Start` / `Awake` Ordering?

`Awake` and `Start` run at specific Unity lifecycle phases. The trainer identity comes from `GameSessionManager`, which reads from SQLite and may make async calls. There is no way to guarantee that SQLite reading completes before a scene component's `Awake` runs — and Unity's script execution order settings only control order within a single frame, not across async operations.

`IWorldInitializable` and `WorldRegistry` solve this by decoupling initialization timing from the Unity lifecycle:
1. Each MonoBehaviour registers itself with `WorldRegistry` in `Awake` (instant, synchronous)
2. `GameInitializer` waits for the trainer identity to be ready
3. Only then does it call `InitializeAsync` on all registered components

This means the components themselves have no ordering dependency on each other — they all run in the same sequential loop but their individual async operations do not need to complete in any particular relative order.

### Why a Static `WorldRegistry` Instead of Injected?

A static registry avoids the circular dependency problem: `NpcWorldBehaviour` (a MonoBehaviour) would need to inject `IWorldRegistry` to register itself, but Zenject injects MonoBehaviours in their `[Inject]` method which runs during `Awake`. By the time `[Inject]` runs, `WorldRegistry.Register` in the component's own `Awake` may have already run (execution order between Awake calls is not guaranteed). Making the registry static and globally accessible eliminates this race: `WorldRegistry.Register(this)` in `Awake` always works regardless of Zenject's injection timing.

A downside of the static approach is testability — you cannot inject a mock registry in tests. This is an acceptable trade-off because `WorldRegistry` has no logic of its own; it is just a list.

The actual `WorldRegistry` implementation is minimal:

```csharp
public static class WorldRegistry
{
    static readonly List<IWorldInitializable> _all = new();

    public static IReadOnlyList<IWorldInitializable> All => _all;

    public static void Register(IWorldInitializable obj)
    {
        if (!_all.Contains(obj))
            _all.Add(obj);
    }

    public static void Unregister(IWorldInitializable obj) => _all.Remove(obj);

    public static void Clear() => _all.Clear();
}
```

`All` returns the backing list directly (not a snapshot). `GameInitializer` calls `WorldRegistry.All.ToList()` to take a snapshot at the start of each init loop, preventing modification-during-enumeration issues.

### Why `IWorldInitializable` Instead of a Base Class?

An interface allows any MonoBehaviour — regardless of its base class — to participate in world initialization. A base class would force all world behaviours to share a common inheritance chain, creating fragility when a behaviour needs a different base (e.g., a physics-aware base, or a UI panel base).

### Why Composable Sub-Behaviours for NPCs?

Earlier versions of `NpcWorldBehaviour` embedded all NPC concerns — identity resolution, creature grants, merchant state — in a single MonoBehaviour. This led to growing inspector fields and branching initialization logic: "if this NPC is a starter, do A; if it's a merchant, do B."

The composable pattern separates these concerns into independent `INpcSubInitializable` add-on components. `NpcWorldBehaviour` stays identity-only. Each sub-behaviour opts into the NPC's initialization lifecycle by implementing `INpcSubInitializable`. Designers stack only the components they need on each NPC GameObject, and there is no dead code path in any single component.

### Why Sequential Initialization Instead of Parallel?

`GameInitializer.RunAsync` awaits each `InitializeAsync` call in a `foreach` loop. This is intentional. Some behaviours have implicit ordering dependencies: `NpcCreatureGrantBehaviour` must seed a creature team before `NpcTrainerBehaviour` fetches it. Parallel initialization would require explicit ordering annotations on every behaviour, which is more complex and error-prone.

If initialization time becomes a concern (many NPCs in a large scene), the loop can be changed to run behaviours in priority buckets — but sequential is the safe default.

## Component Overview

| Type | Role |
|------|------|
| `IWorldInitializable` | Interface that world-aware behaviours implement |
| `WorldRegistry` | Static registry of all active `IWorldInitializable` objects |
| `IWorldContext` | Snapshot of account/trainer identity passed to each initializable |
| `GameInitializer` | MonoBehaviour that drives the init loop |
| `INpcSubInitializable` | Interface for NPC add-on components run after identity resolves |
| `NpcWorldBehaviour` | Identity-only NPC world behaviour; dispatches to sub-behaviours |
| `NpcCreatureGrantBehaviour` | Sub-behaviour: seeds a configured creature team onto the NPC |
| `NpcMerchantBehaviour` | Sub-behaviour: stub for merchant NPC state |
| `NpcTrainerBehaviour` | Sub-behaviour: seeds creature team + items, caches both for battle |
| `SpawnerWorldBehaviour` | World behaviour: ensures spawner zone exists; exposes `SpawnerId` |
| `SpawnerEncounterBehaviour` | Activated by `SpawnerWorldBehaviour`; trigger-based wild encounter entry point |

Source files live in `cr-data/My project/Assets/CR/Game/World/` and its `Behaviours/` subfolder.

## `IWorldInitializable`

```csharp
public interface IWorldInitializable
{
    Task InitializeAsync(IWorldContext context, CancellationToken ct = default);
}
```

Any `MonoBehaviour` that needs account/trainer context at scene start implements this interface and registers itself with `WorldRegistry` in `Awake`. The `CancellationToken` is provided by `GameInitializer` and is cancelled if the scene unloads or the trainer changes again before initialization completes. Always pass `ct` to any async operations inside `InitializeAsync` to support clean cancellation.

## `INpcSubInitializable`

```csharp
public interface INpcSubInitializable
{
    Task InitializeAsync(Guid npcId, Guid accountId, Guid trainerId, CancellationToken ct = default);
}
```

Components that implement `INpcSubInitializable` are discovered by `NpcWorldBehaviour` via `GetComponents<INpcSubInitializable>()` after the NPC's identity has been resolved. `NpcWorldBehaviour` calls `InitializeAsync` on each sub-behaviour in component order, passing the resolved `npcId` and identity GUIDs.

Sub-behaviours do **not** register with `WorldRegistry` themselves — they are driven entirely by `NpcWorldBehaviour`. This means they do not need their own `Awake`/`OnDestroy` registry management.

## `WorldRegistry`

A static list of `IWorldInitializable` instances. The `Register` method checks for duplicates (a behaviour added to the scene while already registered will not be double-registered). `GameInitializer` calls `WorldRegistry.All.ToList()` at the start of each `RunAsync` to get a snapshot before awaiting anything.

```csharp
// In Awake:
WorldRegistry.Register(this);

// In OnDestroy:
WorldRegistry.Unregister(this);
```

**How `WorldRegistry` discovers implementations.** It does not discover anything automatically. Each component that implements `IWorldInitializable` is responsible for calling `WorldRegistry.Register(this)` in its own `Awake`. There is no reflection scan or Zenject collection binding — registration is explicit. This means if you forget to call `Register`, the behaviour will not be initialized and no error will occur (it is simply not in the list).

**Scene unload.** When a scene unloads, `GameInitializer` listens to `SceneManager.sceneUnloaded` and calls `WorldRegistry.Clear()`. The registry is then empty until the next scene's components each call `WorldRegistry.Register(this)` in their `Awake`.

**Edge case: Behaviour added after init.** If a MonoBehaviour is instantiated after `GameInitializer` has already completed the init loop (e.g., spawned at runtime), it will register with `WorldRegistry` but `InitializeAsync` will not be called on it automatically. Handle this by checking for a cached `IWorldContext` in `Awake` or by exposing a separate initialization trigger from the spawning code.

## `IWorldContext`

```csharp
public interface IWorldContext
{
    Guid AccountId { get; }
    Guid TrainerId { get; }
    bool IsOnline { get; }
}
```

`WorldContext` is the concrete implementation, created by `GameInitializer.RunAsync` with the current session's IDs. It is immutable — the same context object is passed to all `InitializeAsync` calls within a single init loop. If the trainer changes during initialization (e.g., the user switches trainers on a slow connection), a new init loop with a new context starts. The `CancellationToken` from the previous loop is cancelled first.

`IsOnline` is read from the `TrainerChangedEventArgs.IsOnlineTrainer` flag set by `GameSessionManager`. Individual behaviours can use this to decide whether to make HTTP calls or serve from local SQLite.

## `GameInitializer` Bootstrap Flow

```
LocalDevGameInstaller.InstallBindings
  └─ Container.Bind<GameInitializer>().FromNewComponentOnNewGameObject().AsSingle().NonLazy()

  → GameInitializer created immediately, [Inject] is called:
      _sessionManager.OnTrainerChanged += OnTrainerChanged
      SceneManager.sceneUnloaded += OnSceneUnloaded

  → GameSessionManager.Start() runs, loads session from SQLite
  → If a trainer is active, fires OnTrainerChanged(e.TrainerId, e.IsOnlineTrainer)

  → GameInitializer.OnTrainerChanged fires RunAsync(accountId, trainerId, isOnline)
      └─ Cancels previous CancellationTokenSource (if any)
      └─ Creates new CancellationTokenSource
      └─ Creates IWorldContext(accountId, trainerId, isOnline)
      └─ initializables = WorldRegistry.All.ToList()
      └─ Logs "[GameInitializer] === World init start ==="
      └─ foreach item in initializables:
             await item.InitializeAsync(context, ct)
             (OperationCanceledException → break; Exception → log, failed++, continue)
      └─ Logs "[GameInitializer] === World init complete === N ok / M failed / Xms"
```

`[DefaultExecutionOrder(50)]` on `GameInitializer` ensures its Unity lifecycle methods run after most other components, but Zenject injection via `[Inject]` is called before any `Start`, so the subscription is always in place before `GameSessionManager` can fire.

Errors thrown by individual `InitializeAsync` calls are caught and logged with the component name and elapsed time. The loop continues to the next component — a single NPC failing to initialize does not block other NPCs. The final log line includes the count of successes and failures.

## Failure Mode Handling

When `InitializeAsync` throws:

- **`OperationCanceledException`** — caught by `GameInitializer`, interpreted as clean cancellation (scene unload or trainer change mid-init). The loop stops and no further behaviours initialize for this run.
- **Any other exception** — caught by `GameInitializer`, logged as an error with the component name and elapsed time, then the loop continues. The failed component is left in whatever partial state it was in when the exception was thrown. Downstream components that read the failed component's public state (e.g., `NpcInteractionBehaviour` checking `NpcWorldBehaviour.NpcId`) will see `Guid.Empty` and should handle it gracefully.

If `GameInitializer` itself fails (e.g., `GameSessionManager` fires an event before `GameInitializer` is created — which cannot happen with `NonLazy()`), the `OnTrainerChanged` handler wraps `RunAsync` in a `ContinueWith(OnlyOnFaulted)` continuation that logs unhandled errors:

```csharp
RunAsync(...)
    .ContinueWith(t =>
        _logger.Error($"[GameInitializer] Unhandled error in RunAsync: {t.Exception?.GetBaseException().Message}"),
        TaskContinuationOptions.OnlyOnFaulted);
```

If the WorldRegistry is empty when `RunAsync` fires, `GameInitializer` logs a warning: `WorldRegistry is empty — no IWorldInitializable objects registered`. This is a common symptom of forgetting `WorldRegistry.Register(this)` in `Awake`.

## Adding a New IWorldInitializable System — Full Walkthrough

This is the complete sequence for adding a new system that participates in world bootstrap.

### Step 1 — Create the MonoBehaviour

```csharp
using System.Threading;
using System.Threading.Tasks;
using CR.Game.Common;
using CR.Game.World;
using UnityEngine;
using Zenject;

public class QuestBoardBehaviour : MonoBehaviour, IWorldInitializable
{
    private IQuestClient _questClient;
    private ICRLogger _logger;

    [Inject]
    public void Init(IQuestClient questClient, ICRLogger logger)
    {
        _questClient = questClient;
        _logger = logger;
    }

    private void Awake() => WorldRegistry.Register(this);
    private void OnDestroy() => WorldRegistry.Unregister(this);

    public async Task InitializeAsync(IWorldContext context, CancellationToken ct = default)
    {
        _logger.Debug($"[QuestBoardBehaviour] init. trainerId={context.TrainerId}");

        // Store identity values you need — do NOT store the context object itself
        _trainerId = context.TrainerId;

        if (!context.IsOnline)
        {
            _logger.Info("[QuestBoardBehaviour] offline — skipping quest fetch.");
            return;
        }

        var quests = await _questClient.GetActiveQuestsAsync(context.TrainerId, ct);
        RenderQuestBoard(quests);
    }

    private Guid _trainerId;
    private void RenderQuestBoard(/* ... */) { /* ... */ }
}
```

Key points:
- `Awake` registers, `OnDestroy` unregisters — always both
- `[Inject]` wires dependencies — never use `GetComponent` or `FindObjectOfType` inside `[Inject]`
- Always pass `ct` to inner async calls
- Do not store the `context` reference — extract and store the values you need

### Step 2 — Add the MonoBehaviour to the scene

Add `QuestBoardBehaviour` to a GameObject in the scene. The component will automatically register itself with `WorldRegistry` when the scene loads.

### Step 3 — Verify Zenject has the required bindings

`IQuestClient` and `ICRLogger` must be bound in `LocalDevGameInstaller`. `ICRLogger` is already bound with a per-consumer factory. If `IQuestClient` is not yet bound, add it (see [Dependency Injection](?page=unity/02-dependency-injection) for the full checklist).

### Step 4 — Play and check the log

Look for:
```
[GameInitializer] Initializing 'QuestBoardBehaviour (QuestBoardBehaviour)'...
[GameInitializer] 'QuestBoardBehaviour (QuestBoardBehaviour)' done in 43ms.
```

If the component name appears in the failure count (`M failed`), the exception message is logged directly above it.

## Controlling Initialization Order

The order in which `InitializeAsync` is called on registered behaviours depends on the order they were registered with `WorldRegistry` — which is the order their `Awake` methods ran. Unity does not guarantee `Awake` order across different GameObjects unless you set **Script Execution Order** in Project Settings.

For the NPC sub-behaviour case, ordering within a single NPC's components is controlled by the component order in the Unity Inspector (top to bottom = first to last in `GetComponents`).

If two world behaviours have a dependency (e.g., behaviour B needs data produced by behaviour A), there are two options:
1. Set script execution order so A's `Awake` runs first (ensuring A is earlier in the `WorldRegistry.All` list)
2. Have B read a cached value from A's public property in its `InitializeAsync` and retry if it is `Guid.Empty` (polling until A's data is ready)

Option 1 is simpler and preferred for stable dependencies. Option 2 is fragile and should be avoided.

## `NpcWorldBehaviour` — Identity Only

`NpcWorldBehaviour` implements `IWorldInitializable`. Its sole job is to resolve the NPC's server-side identity (`NpcId`, `AccountId`, `TrainerId`) and then hand off to sub-behaviours.

From the actual source:

```csharp
public async Task InitializeAsync(IWorldContext context, CancellationToken ct = default)
{
    if (string.IsNullOrWhiteSpace(_npcContentKey))
    {
        _logger.Warn($"[NpcWorldBehaviour] '{name}' — _npcContentKey is empty. Skipping.");
        return;
    }

    AccountId = context.AccountId;
    TrainerId = context.TrainerId;

    var result = await _npcWorldRepository.EnsureNpcAsync(
        context.AccountId, context.TrainerId, _npcContentKey, _npcType, ct);

    NpcId   = result.NpcId;
    NpcType = result.NpcType;

    // Dispatch to all sub-behaviours in component order
    var subBehaviours = GetComponents<INpcSubInitializable>();
    foreach (var sub in subBehaviours)
        await sub.InitializeAsync(NpcId, AccountId, TrainerId, ct);
}
```

### Inspector Fields

| Field | Type | Description |
|-------|------|-------------|
| `_npcContentKey` | string | Stable designer-facing key — must match `content_key` in the database (e.g. `"cindris_starter_npc"`) |
| `_npcType` | NpcType | The NPC type to use when first creating this NPC. Defaults to `Npc`. Set to `Trainer` for trainer NPCs. First-write-wins: if the NPC already exists, this field is ignored. |

### Public State

| Property | Type | Notes |
|----------|------|-------|
| `NpcId` | Guid | Set after `EnsureNpcAsync`; `Guid.Empty` until initialized |
| `AccountId` | Guid | From world context |
| `TrainerId` | Guid | From world context |
| `NpcType` | NpcType | The resolved NPC type from the backend |

Sub-behaviours and interaction components read these properties directly.

## `NpcCreatureGrantBehaviour` — Inspector-Configured Team

`NpcCreatureGrantBehaviour` implements `INpcSubInitializable`. It reads a designer-configured list of creature slots from the Inspector and calls `EnsureNpcCreatureTeamAsync` to idempotently seed the NPC's team.

### Inspector Fields

| Field | Type | Description |
|-------|------|-------------|
| `_slots` | `List<NpcCreatureSlotEntry>` | Ordered list of (creatureBaseContentKey, slotNumber) pairs |

`NpcCreatureSlotEntry` is a serializable struct with two fields:

```csharp
[Serializable]
public struct NpcCreatureSlotEntry
{
    public string CreatureBaseContentKey;  // e.g. "cindris_grass_starter"
    public int SlotNumber;                 // 1–6
}
```

### Example Inspector Setup

An NPC that offers two creatures in a grant flow:

```
GameObject: NPC_Cindris
├─ NpcWorldBehaviour
│    _npcContentKey: "cindris_grant_npc"
│    _npcType: Npc
├─ NpcCreatureGrantBehaviour
│    _slots:
│      [0] CreatureBaseContentKey: "cindris_grass_starter"
│           SlotNumber: 1
│      [1] CreatureBaseContentKey: "cindris_fire_starter"
│           SlotNumber: 2
└─ NpcInteractionBehaviour
     _interactionRadius: 3
```

## `NpcMerchantBehaviour` — Merchant Stub

`NpcMerchantBehaviour` implements `INpcSubInitializable`. It is currently a stub that marks the NPC as a merchant and exposes a stable `MerchantNpcId` for use by shop UI systems.

### Example Inspector Setup

```
GameObject: NPC_Merchant_Elara
├─ NpcWorldBehaviour
│    _npcContentKey: "elara_merchant_npc"
│    _npcType: Npc
└─ NpcMerchantBehaviour
```

## `NpcTrainerBehaviour` — Battle-Ready NPC

`NpcTrainerBehaviour` implements `INpcSubInitializable`. It seeds the NPC's creature team and item inventory on first load, then fetches both and caches them for battle initiation.

### Inspector Fields

| Field | Type | Description |
|-------|------|-------------|
| `_allowRematch` | bool | If false, `CanBattle` stays false after the first battle. Defaults to `true`. |
| `_slots` | `List<NpcCreatureSlotDefinition>` | Ordered list of (creatureBaseContentKey, slotNumber) pairs for team seeding |
| `_items` | `List<NpcItemDefinition>` | List of (itemId string, quantity) pairs for item inventory seeding |

### Coexistence with `NpcCreatureGrantBehaviour`

`NpcTrainerBehaviour` and `NpcCreatureGrantBehaviour` can coexist on the same GameObject. The order matters:

```
Component order (top to bottom in Inspector):
1. NpcWorldBehaviour        — resolves identity
2. NpcCreatureGrantBehaviour — seeds grant team first
3. NpcTrainerBehaviour       — seeds battle team second, then reads the full team
4. NpcInteractionBehaviour   — dispatches grant-first, then battle
```

`NpcTrainerBehaviour` always re-fetches the team from the repository after seeding, so it will see any creatures added by `NpcCreatureGrantBehaviour` in the same init loop (since the loop is sequential). If `NpcTrainerBehaviour` is listed before `NpcCreatureGrantBehaviour`, it may fetch an incomplete team on first visit.

### Public State

| Property | Type | Notes |
|----------|------|-------|
| `CanBattle` | bool | True when `CreatureTeam.Count > 0 && _allowRematch` |
| `CreatureTeam` | `IReadOnlyList<CreatureInventoryEntry>` | Cached team snapshot |
| `BattleItems` | `IReadOnlyList<NpcInventoryEntry>` | Cached item inventory snapshot |

## `SpawnerEncounterBehaviour` — Wild Encounter Trigger

`SpawnerEncounterBehaviour` is **not** an `IWorldInitializable`. It is activated by `SpawnerWorldBehaviour` after that behaviour's `InitializeAsync` completes.

```
SpawnerWorldBehaviour.InitializeAsync
  └─ GetComponent<SpawnerEncounterBehaviour>()?.Activate(context, SpawnerId, WildTrainerId)
```

Once activated, `SpawnerEncounterBehaviour`:
1. Enables a `SphereCollider` trigger (radius = `_encounterRadius`)
2. On `OnTriggerEnter` with tag `"Player"`: builds a `WildBattleRequest` and calls `IBattleCoordinator.StartWildBattle`
3. Subscribes to `IBattleCoordinator.OnBattleEnded` to reset the encounter lock when the battle ends

`[RequireComponent(typeof(SpawnerWorldBehaviour))]` enforces co-presence at the Unity component level. Do not add or configure a `SphereCollider` manually — `Activate()` creates and configures it at runtime.

See [Battle System](?page=unity/07-battle-system) for the full wild encounter flow.

## Scene Unload and Re-initialization

When a scene unloads:
1. `GameInitializer` receives `SceneManager.sceneUnloaded` event
2. Calls `WorldRegistry.Clear()`

When the new scene loads:
1. Each new `IWorldInitializable` in the scene calls `WorldRegistry.Register(this)` in its `Awake`
2. When a trainer is already active, `GameSessionManager` fires `OnTrainerChanged` again (or `GameInitializer` re-fires on scene load via the cached session)
3. `InitializeAsync` runs for all newly registered behaviours

This means behaviours in a new scene are always initialized fresh with the current session — there is no stale state from the previous scene.

## Common Mistakes / Tips

- **Forgetting `WorldRegistry.Unregister(this)` in `OnDestroy`.** If a behaviour is destroyed but stays registered, `InitializeAsync` will be called on a destroyed object, throwing `MissingReferenceException`. Always pair `Register` in `Awake` with `Unregister` in `OnDestroy`.
- **Not passing `ct` to inner async calls.** If your `InitializeAsync` does not pass the cancellation token, scene unloads will not cleanly cancel in-progress HTTP requests. The request will complete after the scene is gone, potentially writing to destroyed objects.
- **Using `context.AccountId` after `InitializeAsync` returns.** Store the ID values you need as fields. The context object is not guaranteed to remain valid beyond the method.
- **Dynamically instantiated behaviours not getting initialized.** Use a separate post-initialization hook or check `GameSessionManager.GetCurrentSession()` in the behaviour's `Awake` to self-initialize if a session is already active.
- **Not using `NonLazy()` for `GameInitializer`.** Without `NonLazy()`, `GameInitializer` is never created unless something resolves it, meaning `OnTrainerChanged` is never subscribed and world initialization never happens. See [Dependency Injection](?page=unity/02-dependency-injection).
- **`WorldRegistry is empty` warning on Play.** Every `IWorldInitializable` component in the scene must call `WorldRegistry.Register(this)` in its `Awake`. If you see this warning, at least one component is missing the call.
- **`SpawnerEncounterBehaviour` zone never triggers.** If `SpawnerWorldBehaviour.InitializeAsync` did not complete (init error, missing `_spawnerContentKey`, or world bootstrap not running), `Activate` is never called and the `SphereCollider` stays disabled. Check the GameInitializer log for errors during spawner init.
- **Adding `INpcSubInitializable` components without `NpcWorldBehaviour`.** Sub-behaviours are driven by `NpcWorldBehaviour.InitializeAsync`. If `NpcWorldBehaviour` is missing from the GameObject, sub-behaviours' `InitializeAsync` is never called — they will silently remain uninitialized.
- **`NpcTrainerBehaviour` listed before `NpcCreatureGrantBehaviour`.** The init loop is sequential and follows component order. If the trainer behaviour runs before the grant behaviour, it may cache an empty team on first visit.
- **Wrong `_npcType` on `NpcWorldBehaviour`.** If a trainer NPC has `_npcType = Npc`, it is created as a generic NPC in the database. This is first-write-wins — fix requires a direct database update.

## Related Pages

- [Dependency Injection](?page=unity/02-dependency-injection) — `NonLazy()` binding for `GameInitializer`, installer order
- [NPC Interaction](?page=unity/04-npc-interaction) — `NpcInteractionBehaviour` dispatches grant vs battle using sub-behaviour state
- [Battle System](?page=unity/07-battle-system) — `BattleCoordinator`, `SpawnerEncounterBehaviour`, all three battle types
- [Starter Creature Flow](?page=backend/05-starter-creature-flow) — end-to-end flow showing `WorldRegistry` → `NpcWorldBehaviour.InitializeAsync`
- [NPC System](?page=backend/02-npc-system) — `EnsureNpcAsync`, `EnsureNpcCreatureTeamAsync`, `EnsureNpcItemsAsync`
- [HTTP Clients](?page=unity/05-http-clients) — `IsOnline` context flag and how HTTP clients handle offline mode
