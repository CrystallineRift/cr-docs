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

## Component Overview

| Type | Role |
|------|------|
| `IWorldInitializable` | Interface that world-aware behaviours implement |
| `WorldRegistry` | Static registry of all active `IWorldInitializable` objects |
| `IWorldContext` | Snapshot of account/trainer identity passed to each initializable |
| `GameInitializer` | MonoBehaviour that drives the init loop |

Source files:
- `../cr-data/…/GameInitializer.cs`
- `../cr-data/…/NpcWorldBehaviour.cs`

## `IWorldInitializable`

```csharp
public interface IWorldInitializable
{
    Task InitializeAsync(IWorldContext context, CancellationToken ct = default);
}
```

Any `MonoBehaviour` that needs account/trainer context at scene start implements this interface and registers itself with `WorldRegistry` in `Awake`. The `CancellationToken` is provided by `GameInitializer` and is cancelled if the scene unloads or the trainer changes again before initialization completes. Always pass `ct` to any async operations inside `InitializeAsync` to support clean cancellation.

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

## Related Pages

- [Dependency Injection](?page=unity/02-dependency-injection) — `NonLazy()` binding for `GameInitializer`, installer order
- [NPC Interaction](?page=unity/04-npc-interaction) — `NpcWorldBehaviour` is the primary example of `IWorldInitializable`
- [Starter Creature Flow](?page=backend/05-starter-creature-flow) — end-to-end flow showing `WorldRegistry` → `NpcWorldBehaviour.InitializeAsync`
- [HTTP Clients](?page=unity/05-http-clients) — `IsOnline` context flag and how HTTP clients handle offline mode
