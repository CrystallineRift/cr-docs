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

A downside of the static approach is testability — you cannot inject a mock registry in tests. This is an acceptable trade-off because `WorldRegistry` has no logic of its own; it is just a dictionary.

### Why `IWorldInitializable` Instead of a Base Class?

An interface allows any MonoBehaviour — regardless of its base class — to participate in world initialization. A base class would force all world behaviours to share a common inheritance chain, creating fragility when a behaviour needs a different base (e.g., a physics-aware base, or a UI panel base).

### Why Composable Sub-Behaviours for NPCs?

Earlier versions of `NpcWorldBehaviour` embedded all NPC concerns — identity resolution, creature grants, merchant state — in a single MonoBehaviour. This led to growing inspector fields and branching initialization logic: "if this NPC is a starter, do A; if it's a merchant, do B."

The composable pattern separates these concerns into independent `INpcSubInitializable` add-on components. `NpcWorldBehaviour` stays identity-only. Each sub-behaviour opts into the NPC's initialization lifecycle by implementing `INpcSubInitializable`. Designers stack only the components they need on each NPC GameObject, and there is no dead code path in any single component.

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

Source files:
- `../cr-data/…/GameInitializer.cs`
- `../cr-data/…/NpcWorldBehaviour.cs`
- `../cr-data/…/NpcCreatureGrantBehaviour.cs`
- `../cr-data/…/NpcMerchantBehaviour.cs`
- `../cr-data/…/NpcTrainerBehaviour.cs`

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
    Task OnNpcReadyAsync(Guid npcId, IWorldContext context, CancellationToken ct = default);
}
```

Components that implement `INpcSubInitializable` are discovered by `NpcWorldBehaviour` via `GetComponents<INpcSubInitializable>()` after the NPC's identity has been resolved. `NpcWorldBehaviour` calls `OnNpcReadyAsync` on each sub-behaviour in component order, passing the resolved `npcId` and the current world context.

Sub-behaviours do **not** register with `WorldRegistry` themselves — they are driven entirely by `NpcWorldBehaviour`. This means they do not need their own `Awake`/`OnDestroy` registry management.

## `WorldRegistry`

A static dictionary keyed on `IWorldInitializable` instances. Thread-safe add/remove:

```csharp
// In Awake:
WorldRegistry.Register(this);

// In OnDestroy:
WorldRegistry.Unregister(this);
```

`GameInitializer` reads `WorldRegistry.All` when it fires the init loop. The `All` property returns a snapshot of the current registrations to prevent modification-during-enumeration errors if a behaviour is destroyed while initialization is in progress.

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

`IsOnline` is read from `IGameSessionRepository` at the start of `RunAsync`. It reflects whether the session was started with network access. Individual behaviours can use this to decide whether to make HTTP calls or serve from local SQLite.

## `GameInitializer` Bootstrap Flow

```
LocalDevGameInstaller.InstallBindings
  └─ Container.Bind<GameInitializer>().FromNewComponentOnNewGameObject().AsSingle().NonLazy()

  → GameInitializer created immediately, [Inject] is called:
      _sessionManager.OnTrainerChanged += OnTrainerChanged

  → GameSessionManager.Start() runs, loads session from SQLite
  → If a trainer is active, fires OnTrainerChanged

  → GameInitializer.OnTrainerChanged fires RunAsync(accountId, trainerId, isOnline)
      └─ Creates a new CancellationTokenSource
      └─ Creates IWorldContext from current session
      └─ foreach item in WorldRegistry.All:
             await item.InitializeAsync(context, cts.Token)
```

`[DefaultExecutionOrder(50)]` on `GameInitializer` ensures its `Start` (if any) runs after most other components, but Zenject injection via `[Inject]` is called before any `Start`, so the subscription is always in place before `GameSessionManager` can fire.

The init loop is **sequential**, not parallel. This is intentional: some behaviours may depend on the side effects of earlier behaviours (e.g., NPC initialization that creates inventory rows a later behaviour expects to find). If ordering becomes a problem, consider running behaviours in explicit priority buckets.

## `GameSessionManager`

`GameSessionManager` is the central state machine for login/trainer selection. It:
- Reads the last active session from `IGameSessionRepository` on `Start`
- Fires `OnTrainerChanged(accountId, trainerId, isOnline)` when a trainer becomes active
- Provides `GetCurrentSession()` for one-off queries of the active identity
- Fires `OnSessionCleared()` when the trainer logs out or the session is invalidated

`GameInitializer` subscribes only to `OnTrainerChanged`. When a trainer is deselected (logout), `GameInitializer` cancels the current `CancellationTokenSource` to stop any in-progress initialization loop.

## `NpcWorldBehaviour` — Identity Only

`NpcWorldBehaviour` implements `IWorldInitializable`. Its sole job is to resolve the NPC's server-side identity (`NpcId`, `AccountId`, `TrainerId`) and then hand off to sub-behaviours. It no longer embeds creature grant logic or any other NPC-type-specific behavior.

**There is no `_starterCreatureBaseId` field.** Creature team seeding is the responsibility of `NpcCreatureGrantBehaviour` (for grant NPCs) or `NpcTrainerBehaviour` (for trainer NPCs).

### Inspector Fields

| Field | Type | Description |
|-------|------|-------------|
| `_npcContentKey` | string | Stable designer-facing key — must match `content_key` in the database (e.g. `"cindris_starter_npc"`) |
| `_npcType` | NpcType | The NPC type to use when first creating this NPC. Defaults to `Npc`. Set to `Trainer` for trainer NPCs. First-write-wins: if the NPC already exists, this field is ignored. |

### Initialization Flow

```csharp
public async Task InitializeAsync(IWorldContext context, CancellationToken ct = default)
{
    // 1. Validate
    if (string.IsNullOrWhiteSpace(_npcContentKey)) { /* log warning, return */ }

    // 2. Store identity
    AccountId = context.AccountId;
    TrainerId = context.TrainerId;

    // 3. Ensure NPC exists on the backend with the configured type
    var result = await _npcWorldRepository.EnsureNpcAsync(
        context.AccountId, context.TrainerId, _npcContentKey, _npcType, ct);

    NpcId   = result.NpcId;
    NpcType = result.NpcType;

    // 4. Dispatch to sub-behaviours
    foreach (var sub in GetComponents<INpcSubInitializable>())
        await sub.InitializeAsync(NpcId, AccountId, TrainerId, ct);
}
```

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

### How It Works

```csharp
public async Task OnNpcReadyAsync(Guid npcId, IWorldContext context, CancellationToken ct)
{
    // Resolve content keys to UUIDs via game config
    var specs = _slots.Select(s => new NpcCreatureSlotSpec(
        ResolveCreatureBaseId(s.CreatureBaseContentKey),
        s.SlotNumber
    )).ToList();

    var response = await _npcClient.EnsureNpcCreatureTeamAsync(
        npcId,
        new EnsureNpcCreatureTeamRequest
        {
            AccountId = context.AccountId,
            TrainerId = context.TrainerId,
            Slots = specs,
        }, ct);

    TeamCount = response.TeamCount;
    IsReady = true;
}
```

Each slot is only seeded if currently empty (backend idempotency guarantee). Random seeds are used per creature — no two trainers will have identical NPC team variants.

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

`NpcMerchantBehaviour` implements `INpcSubInitializable`. It is currently a stub that marks the NPC as a merchant and exposes a stable `MerchantNpcId` for use by shop UI systems. Full shop catalog logic is a future concern.

### Public State

| Property | Type | Notes |
|----------|------|-------|
| `IsReady` | bool | True after `OnNpcReadyAsync` completes |
| `MerchantNpcId` | Guid | The resolved NPC ID; forwarded from `NpcWorldBehaviour` |

### Example Inspector Setup

```
GameObject: NPC_Merchant_Elara
├─ NpcWorldBehaviour
│    _npcContentKey: "elara_merchant_npc"
│    _npcType: Npc
└─ NpcMerchantBehaviour
```

No `NpcCreatureGrantBehaviour` needed for a pure merchant.

## `NpcTrainerBehaviour` — Battle-Ready NPC

`NpcTrainerBehaviour` implements `INpcSubInitializable`. It seeds the NPC's creature team and item inventory on first load, then fetches both and caches them for battle initiation.

### Inspector Fields

| Field | Type | Description |
|-------|------|-------------|
| `_allowRematch` | bool | If false, `CanBattle` stays false after the first battle. Defaults to `true`. |
| `_slots` | `List<NpcCreatureSlotDefinition>` | Ordered list of (creatureBaseContentKey, slotNumber) pairs for team seeding |
| `_items` | `List<NpcItemDefinition>` | List of (itemId string, quantity) pairs for item inventory seeding |

`NpcCreatureSlotDefinition`:
```csharp
[Serializable]
public struct NpcCreatureSlotDefinition
{
    public string creatureBaseContentKey;  // e.g. "trainer_kael_creature_1_id"
    public int slotNumber;                 // 1–6
}
```

`NpcItemDefinition`:
```csharp
[Serializable]
public struct NpcItemDefinition
{
    public string itemId;   // UUID string — TODO: replace with contentKey once items have content_key support
    public int quantity;
}
```

### Initialization Flow

1. Resolve `_slots` entries → `List<NpcCreatureSlotSpec>` via `IGameConfiguration.TryGet`; warn and skip missing config keys
2. If any specs resolved: call `EnsureNpcCreatureTeamAsync` to idempotently seed the team
3. Fetch `CreatureTeam = await GetNpcTeamAsync(...)` and cache it
4. Resolve `_items` entries → `List<NpcItemSeedSpec>` via `Guid.TryParse`; warn and skip invalid GUIDs
5. If any item specs resolved: call `EnsureNpcItemsAsync` to idempotently seed the item inventory
6. Fetch `BattleItems = await GetNpcItemsAsync(...)` and cache it

All seeding calls are idempotent — safe to call on every world load. Items already present are not re-added or modified.

### Public State

| Property | Type | Notes |
|----------|------|-------|
| `CanBattle` | bool | True when `CreatureTeam.Count > 0 && _allowRematch` |
| `CreatureTeam` | `IReadOnlyList<CreatureInventoryEntry>` | Cached team snapshot |
| `BattleItems` | `IReadOnlyList<NpcInventoryEntry>` | Cached item inventory snapshot |

### Coexistence with `NpcCreatureGrantBehaviour`

`NpcTrainerBehaviour` and `NpcCreatureGrantBehaviour` can coexist on the same GameObject. A trainer NPC that also grants a creature on first visit is a valid and common setup. The order matters:

```
Component order (top to bottom in Inspector):
1. NpcWorldBehaviour        — resolves identity
2. NpcCreatureGrantBehaviour — seeds grant team first
3. NpcTrainerBehaviour       — seeds battle team second, then reads the full team
4. NpcInteractionBehaviour   — dispatches grant-first, then battle
```

`NpcTrainerBehaviour` always re-fetches the team from the repository after seeding, so it will see any creatures added by `NpcCreatureGrantBehaviour` in the same init loop (since the loop is sequential). If `NpcTrainerBehaviour` is listed before `NpcCreatureGrantBehaviour`, it may fetch an incomplete team on first visit.

### Example Inspector Setup

A trainer NPC that can battle the player (also grants a creature on first visit):

```
GameObject: NPC_Trainer_Kael
├─ NpcWorldBehaviour
│    _npcContentKey: "kael_trainer_npc"
│    _npcType: Trainer
├─ NpcCreatureGrantBehaviour
│    _slots:
│      [0] CreatureBaseContentKey: "cindris_water_starter"
│           SlotNumber: 1
├─ NpcTrainerBehaviour
│    _allowRematch: true
│    _slots:
│      [0] creatureBaseContentKey: "kael_battle_creature_1_id"
│           slotNumber: 2
│      [1] creatureBaseContentKey: "kael_battle_creature_2_id"
│           slotNumber: 3
│    _items:
│      [0] itemId: "aaaa-bbbb-..."
│           quantity: 2
└─ NpcInteractionBehaviour
     _interactionRadius: 4
```

`NpcInteractionBehaviour` inspects both `NpcCreatureGrantBehaviour` (grant pending?) and `NpcTrainerBehaviour` (can battle?) to decide what interaction to offer.

## `SpawnerEncounterBehaviour` — Wild Encounter Trigger

`SpawnerEncounterBehaviour` is **not** an `IWorldInitializable`. It is activated by `SpawnerWorldBehaviour` after that behaviour's `InitializeAsync` completes. This separation keeps `SpawnerWorldBehaviour` focused on ensuring the spawner zone exists, and `SpawnerEncounterBehaviour` focused on detecting when the player enters it.

```
SpawnerWorldBehaviour.InitializeAsync
  └─ GetComponent<SpawnerEncounterBehaviour>()?.Activate(context, SpawnerId, WildTrainerId)
```

Once activated, `SpawnerEncounterBehaviour`:
1. Enables a `SphereCollider` trigger (radius = `_encounterRadius`)
2. On `OnTriggerEnter` with tag `"Player"`: builds a `WildBattleRequest` and calls `IBattleCoordinator.StartWildBattle`
3. Subscribes to `IBattleCoordinator.OnBattleEnded` to reset the encounter lock when the battle ends

`[RequireComponent(typeof(SpawnerWorldBehaviour))]` enforces co-presence at the Unity component level. However, `SpawnerEncounterBehaviour` won't activate unless `SpawnerWorldBehaviour` is also present and its `InitializeAsync` completes successfully.

Do not add or configure a `SphereCollider` manually — `Activate()` creates and configures it at runtime.

See [Battle System](?page=unity/07-battle-system) for the full wild encounter flow.

## Implementing a New World Behaviour

```csharp
public class MyWorldBehaviour : MonoBehaviour, IWorldInitializable
{
    private IMyService _myService;
    private ICRLogger _logger;

    [Inject]
    public void Init(IMyService myService, ICRLogger logger)
    {
        _myService = myService;
        _logger = logger;
    }

    private void Awake() => WorldRegistry.Register(this);
    private void OnDestroy() => WorldRegistry.Unregister(this);

    public async Task InitializeAsync(IWorldContext context, CancellationToken ct = default)
    {
        _logger.Debug($"[MyWorldBehaviour] init. trainer={context.TrainerId}");
        await _myService.DoSomethingAsync(context.AccountId, context.TrainerId, ct);
    }
}
```

Always pass `ct` to all async calls inside `InitializeAsync`. If the scene is unloaded or the trainer changes mid-initialization, the token is cancelled and your async operations should terminate gracefully (they will throw `OperationCanceledException` which is caught by `GameInitializer`'s loop).

Do not store the `IWorldContext` reference beyond the scope of `InitializeAsync` — it may become stale if the trainer changes. Store only the values you need (e.g., `_accountId = context.AccountId`).

## Scene Unload and Re-initialization

When a scene unloads:
1. `GameInitializer` receives `SceneManager.sceneUnloaded` event
2. Cancels the active `CancellationTokenSource`
3. Calls `WorldRegistry.Clear()`

When the new scene loads:
1. Each new `IWorldInitializable` in the scene calls `WorldRegistry.Register(this)` in its `Awake`
2. If a trainer is already active, `GameSessionManager` fires `OnTrainerChanged` again (or `GameInitializer` manually re-fires on scene load with the cached session)
3. `InitializeAsync` runs for all newly registered behaviours

This means behaviours in a new scene are always initialized fresh with the current session — there is no stale state from the previous scene.

## Common Mistakes / Tips

- **Forgetting `WorldRegistry.Unregister(this)` in `OnDestroy`.** If a behaviour is destroyed but stays registered, `InitializeAsync` will be called on a destroyed object, throwing `MissingReferenceException`. Always pair `Register` in `Awake` with `Unregister` in `OnDestroy`.
- **Not passing `ct` to inner async calls.** If your `InitializeAsync` does not pass the cancellation token, scene unloads will not cleanly cancel in-progress HTTP requests. The request will complete after the scene is gone, potentially writing to destroyed objects.
- **Using `context.AccountId` after `InitializeAsync` returns.** Store the ID values you need as fields. The context object is not guaranteed to remain valid beyond the method.
- **Dynamically instantiated behaviours not getting initialized.** Use a separate post-initialization hook or check `GameSessionManager.GetCurrentSession()` in the behaviour's `Awake` to self-initialize if a session is already active.
- **Not using `NonLazy()` for `GameInitializer`.** Without `NonLazy()`, `GameInitializer` is never created unless something resolves it, meaning `OnTrainerChanged` is never subscribed and world initialization never happens. See [Dependency Injection](?page=unity/02-dependency-injection).
- **`SpawnerEncounterBehaviour` zone never triggers.** If `SpawnerWorldBehaviour.InitializeAsync` did not complete (init error, missing `_spawnerContentKey`, or world bootstrap not running), `Activate` is never called and the `SphereCollider` stays disabled. Check the `GameInitializer` log for errors during spawner init.
- **Adding `INpcSubInitializable` components without `NpcWorldBehaviour`.** Sub-behaviours are driven by `NpcWorldBehaviour.InitializeAsync`. If `NpcWorldBehaviour` is missing from the GameObject, sub-behaviours' `OnNpcReadyAsync` is never called — they will silently remain uninitialized.
- **Placing creature slot config on `NpcWorldBehaviour` instead of `NpcCreatureGrantBehaviour` or `NpcTrainerBehaviour`.** `NpcWorldBehaviour` is identity-only. There is no `_starterCreatureBaseId` or similar field on it. All creature team configuration belongs on the relevant sub-behaviour.
- **Wrong `_npcType` on `NpcWorldBehaviour`.** If a trainer NPC has `_npcType = Npc`, it is created as a generic NPC in the database. This is a first-write-wins setting — to fix an already-created NPC, update the `npc_type` column directly in the database.
- **`NpcTrainerBehaviour` listed before `NpcCreatureGrantBehaviour`.** If a trainer NPC also has a grant behaviour, place `NpcCreatureGrantBehaviour` above `NpcTrainerBehaviour` in the component list. The init loop is sequential, so grant seeding must complete before the trainer behaviour fetches the team.

## Related Pages

- [Dependency Injection](?page=unity/02-dependency-injection) — `NonLazy()` binding for `GameInitializer`, installer order
- [NPC Interaction](?page=unity/04-npc-interaction) — `NpcInteractionBehaviour` dispatches grant vs battle using sub-behaviour state
- [Battle System](?page=unity/07-battle-system) — `BattleCoordinator`, `SpawnerEncounterBehaviour`, all three battle types
- [Starter Creature Flow](?page=backend/05-starter-creature-flow) — end-to-end flow showing `WorldRegistry` → `NpcWorldBehaviour.InitializeAsync`
- [NPC System](?page=backend/02-npc-system) — `EnsureNpcAsync`, `EnsureNpcCreatureTeamAsync`, `EnsureNpcItemsAsync`, `NpcCreatureSlotSpec`, `NpcItemSeedSpec`
- [HTTP Clients](?page=unity/05-http-clients) — `IsOnline` context flag and how HTTP clients handle offline mode
