# World Behaviours

## Overview

The **World** system coordinates per-scene initialization of game objects after a trainer is selected. It consists of three components:

| Type | Role |
|------|------|
| `IWorldInitializable` | Interface that world-aware behaviours implement |
| `WorldRegistry` | Static registry of all active `IWorldInitializable` objects |
| `IWorldContext` | Snapshot of account/trainer identity passed to each initializable |
| `GameInitializer` | MonoBehaviour that drives the init loop |

Source files:
- `../cr-data/…/GameInitializer.cs`
- `../cr-data/…/NpcWorldBehaviour.cs`

## IWorldInitializable

```csharp
public interface IWorldInitializable
{
    Task InitializeAsync(IWorldContext context, CancellationToken ct = default);
}
```

Any `MonoBehaviour` that needs account/trainer context at scene start implements this interface and registers itself with `WorldRegistry` in `Awake`.

## WorldRegistry

A static dictionary keyed on `IWorldInitializable` instances. Thread-safe add/remove:

```csharp
// In Awake:
WorldRegistry.Register(this);

// In OnDestroy:
WorldRegistry.Unregister(this);
```

`GameInitializer` reads `WorldRegistry.All` when it fires the init loop.

## IWorldContext

```csharp
public interface IWorldContext
{
    Guid AccountId { get; }
    Guid TrainerId { get; }
    bool IsOnline { get; }
}
```

`WorldContext` is the concrete implementation, created by `GameInitializer.RunAsync` with the current session's IDs.

## GameInitializer Bootstrap Flow

```
LocalDevGameInstaller.InstallBindings
  └─ Container.Bind<GameInitializer>().FromNewComponentOnNewGameObject().NonLazy()

  → GameInitializer created immediately, [Inject] is called:
      _sessionManager.OnTrainerChanged += OnTrainerChanged

  → GameSessionManager.Start() runs, loads session from SQLite
  → If a trainer is active, fires OnTrainerChanged

  → GameInitializer.OnTrainerChanged fires RunAsync(accountId, trainerId, isOnline)
      └─ foreach item in WorldRegistry.All:
             await item.InitializeAsync(context, ct)
```

Source: `../cr-data/…/GameInitializer.cs`

The `[DefaultExecutionOrder(50)]` attribute ensures `GameInitializer` runs its `Start` (if any) after most other components, but Zenject injection via `[Inject]` is called before any `Start`, so the subscription is always in place before `GameSessionManager` can fire.

## Implementing a New World Behaviour

```csharp
public class MyWorldBehaviour : MonoBehaviour, IWorldInitializable
{
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

## Scene Unload

When a scene unloads, `GameInitializer` listens to `SceneManager.sceneUnloaded` and calls `WorldRegistry.Clear()`. The next time a trainer is selected in the new scene, the registry is populated fresh by each behaviour's `Awake`.
