# Dependency Injection

The Unity client uses **Zenject** for dependency injection. The root installer is `LocalDevGameInstaller`, a `MonoInstaller` attached to the main scene's `GameContext` GameObject. Understanding the installation order, the online/offline repository pattern, and Zenject's lifecycle guarantees is essential for adding new systems without introducing subtle ordering bugs.

## Why Zenject?

Unity's built-in component model relies on `GetComponent<T>()` calls and manually managed references, which makes testing difficult and creates implicit ordering dependencies. Zenject provides:

- **Constructor injection** for non-MonoBehaviour services (domain services, repositories, HTTP clients)
- **Method injection** (`[Inject]` on a void method) for MonoBehaviours where constructors are not available
- **Scene context** that scopes the container to the active scene
- **`NonLazy()` binding** that forces instantiation at bind time, enabling subscriptions to events before any `Start` runs

The alternative (direct singleton instances or `FindObjectOfType<T>()`) was rejected because it makes the dependency graph implicit and testing impossible without running a Unity scene.

## Why the Online/Offline Triple-Binding?

The game must function both online (HTTP to backend) and offline (local SQLite). The triple-binding pattern registers three implementations of the same interface:

1. **Offline SQLite** — keyed with `LocalDataSources.TrainerOfflineRepository` — a repository backed by the device's local SQLite file for data the trainer owns
2. **Online cache SQLite** — keyed with `LocalDataSources.TrainerOnlineCacheRepository` — a separate SQLite file used as a local mirror of server data fetched while online
3. **Online HTTP** — keyed with `LocalDataSources.TrainerOnlineRepository` — a repository backed by HTTP calls to the backend

The fourth (unkeyed) binding is `TrainerOnlineOfflineRepository` — a router that checks `IGameSessionRepository.IsOnline` and delegates to the appropriate keyed binding at runtime. Services that need trainer data inject `ITrainerRepository` and get this router without knowing which backend is active.

This means:
- Adding offline support for a new domain requires only adding a new keyed SQLite binding + a router implementation
- The router can be swapped for a more sophisticated sync engine later without touching any consumer code
- Tests can inject a mock implementation directly (unkeyed binding) without touching the router

## Installation Order

`InstallBindings()` runs once at scene load. The order matters because later bindings may depend on earlier ones:

1. **Anti-cheat / SQLite init** — `DeviceIdHolder.ForceLockToDeviceInit()`, `SQLiteInitializer.Initialize()` — must run before any SQLite connection is opened
2. **Core singletons** — `IUIManager`, `IGameConfiguration`, `IDatabaseConnectionStringFactory` — needed by almost everything else
3. **Repositories** — online/offline pairs for each domain — registered before migrations so the connection strings are resolved
4. **Run migrations** — `DatabaseMigrationRunner.MigrateAll(...)` for all databases synchronously — blocks the installer until all schemas exist
5. **Auth** — `ITokenManager`, `ITokenValidator`, auth repositories — auth comes after repos so it can store tokens in the auth SQLite
6. **HTTP clients** — all `I*Client` bindings — come after auth so they can inject `ITokenManager`
7. **Domain services** — creature, trainer, NPC, spawner, battle services — come after repos and HTTP clients
8. **Game infrastructure** — `GameSessionManager`, `GameInitializer`, movement factories — `GameInitializer` must be last so it subscribes to `GameSessionManager.OnTrainerChanged` after the manager is bound

## Online/Offline Repository Pattern

Each data domain registers three variants:

```csharp
// Offline SQLite (local device)
Container.Bind<ITrainerRepository>()
    .WithId(LocalDataSources.TrainerOfflineRepository)
    .To<TrainerRepository>()
    .FromInstance(new TrainerRepository(logger, offlineConnectionString))
    .AsCached();

// Online cache SQLite (synced from server)
Container.Bind<ITrainerRepository>()
    .WithId(LocalDataSources.TrainerOnlineCacheRepository)
    .To<TrainerRepository>()
    .FromInstance(new TrainerRepository(logger, onlineCacheConnectionString))
    .AsCached();

// Online HTTP (live server)
Container.Bind<ITrainerRepository>()
    .WithId(LocalDataSources.TrainerOnlineRepository)
    .To<TrainerOnlineRepository>()
    .AsCached();

// Router — picks offline or online at runtime
Container.Bind<ITrainerRepository>()
    .To<TrainerOnlineOfflineRepository>()
    .AsCached();
```

The unkeyed binding (`TrainerOnlineOfflineRepository`) is what most services receive via constructor injection. It reads the current network state and delegates to the appropriate underlying repository.

The `WithId` / `AsCached` combination is important: `AsCached` tells Zenject not to create a new instance each time the keyed binding is resolved — it reuses the same instance, which is what you want for SQLite connections that maintain a connection pool.

**Resolving a keyed binding manually** (rare but valid in the router implementation):

```csharp
[Inject]
public void Init(
    [Inject(Id = LocalDataSources.TrainerOfflineRepository)] ITrainerRepository offline,
    [Inject(Id = LocalDataSources.TrainerOnlineRepository)]  ITrainerRepository online)
{
    _offline = offline;
    _online  = online;
}
```

## Adding a New Binding

### 1. Add domain services

```csharp
Container.Bind<IMyDomainService>().To<MyDomainService>().AsSingle();
```

### 2. Add an HTTP client (if needed)

```csharp
Container.Bind<IMyClient>().To<MyClientUnityHttp>().AsSingle();
```

### 3. Add repositories (full pattern)

```csharp
var connStr = connectionStringFactory.GetConnectionStringForRepository(LocalDataSources.MyOfflineRepository);

Container.Bind<IMyRepository>()
    .WithId(LocalDataSources.MyOfflineRepository)
    .To<MyRepository>()
    .FromInstance(new MyRepository(logger, connStr))
    .AsCached();

Container.Bind<IMyRepository>()
    .WithId(LocalDataSources.MyOnlineRepository)
    .To<MyOnlineRepository>()
    .AsCached();

Container.Bind<IMyRepository>()
    .To<MyOnlineOfflineRepository>()
    .AsCached();
```

Also add `LocalDataSources.MyOfflineRepository` and `LocalDataSources.MyOnlineRepository` constants to the `LocalDataSources` static class, and call `DatabaseMigrationRunner.MigrateAll(myDatabasePath)` in the migrations step.

## Database Migrations

Migrations run **synchronously** during `InstallBindings` via `RunDatabaseMigrationsSynchronously`. This ensures all tables exist before any service tries to use them.

```csharp
migrationRunner.MigrateAll(trainerOfflinePath);
migrationRunner.MigrateAll(authOfflinePath);
migrationRunner.MigrateAll(creatureOfflinePath);
migrationRunner.MigrateAll(spawnerDatabasePath);
```

`MigrateAll` loads every domain's migration assembly into a single FluentMigrator run, executing migrations in global numeric order (M0001 → M9999). All domain migrations share a global number space — if two domains both define a migration numbered M0005, FluentMigrator will run them both but the order between same-numbered migrations is undefined. Reserve migration number ranges per domain to avoid conflicts (e.g., Auth: M0001–M0099, Creatures: M0100–M0199).

**Why synchronous?** Async initialization in `InstallBindings` is not supported by Zenject's binding lifecycle. The installer must complete before the scene starts. Migrations are fast (< 100 ms for a typical SQLite schema on device) and only create tables that do not already exist, so they are idempotent and safe to run on every startup.

## Zenject Tips

- Use `AsSingle()` for stateful services (domain services, managers) — one instance shared by all consumers
- Use `AsCached()` for repository instances created with `FromInstance` — Zenject will not try to re-create them
- Use `AsTransient()` for stateless helpers where each consumer should get its own instance
- `NonLazy()` forces instantiation at bind time — used for `GameInitializer` so it subscribes to events immediately without waiting for a consumer to resolve it. Without `NonLazy()`, `GameInitializer` would never be created if nothing explicitly injects it.
- **Never use `FindObjectOfType<T>()` inside an `[Inject]` method.** Zenject resolves injections during `Awake` before the scene is fully initialized. `FindObjectOfType` may return null for objects not yet awake.
- **Circular dependencies.** Zenject detects circular constructor injection at startup and throws. If you need a circular relationship (rare), use lazy injection with `[Inject] private Lazy<IService> _service;`.

## `GameInitializer` — NonLazy Explained

```csharp
// In LocalDevGameInstaller:
Container.Bind<GameInitializer>()
    .FromNewComponentOnNewGameObject()
    .AsSingle()
    .NonLazy();
```

`FromNewComponentOnNewGameObject()` creates a new GameObject with `GameInitializer` attached. `.NonLazy()` tells Zenject to do this at bind time, not when someone first resolves `GameInitializer`. The result:

1. Zenject creates the `GameInitializer` GameObject during `InstallBindings`
2. Zenject calls the `[Inject]` method on `GameInitializer`, wiring `_sessionManager.OnTrainerChanged += OnTrainerChanged`
3. When `GameSessionManager.Start()` runs and fires `OnTrainerChanged`, `GameInitializer` is already subscribed and drives world initialization

Without `NonLazy()`, `GameInitializer` would only be created when something resolves it — but nothing resolves it except itself. The subscription would never happen. This is the most common Zenject "silent failure" pattern.

## Common Mistakes / Tips

- **Binding after migrations.** If a service binding comes before `MigrateAll` in the installer and the service's constructor tries to open a SQLite connection, the database may not have the required tables yet. Always run migrations in step 4 before any service binding that performs DB operations at construction time.
- **Forgetting `NonLazy()` for event subscribers.** Any service that subscribes to events in its `[Inject]` method needs `NonLazy()` or it will never be created. Check for `AsSingle()` bindings where the consumer expects event-driven activation.
- **`WithId` binding resolved without the Id.** If a service injects `ITrainerRepository` without an `Id`, it gets the unkeyed router binding. This is usually correct. But if you accidentally bind the router twice (e.g., both with and without `.WithId`), Zenject will throw an ambiguity error at resolve time.
- **`AsSingle` vs `AsCached` for `FromInstance`.** Use `AsCached` when you pass a pre-created instance via `FromInstance`. `AsSingle` causes Zenject to attempt to create a new instance via constructor injection, ignoring the `FromInstance` call.

## Related Pages

- [Unity Project Setup](?page=unity/01-project-setup) — `game_config.yaml`, database paths, plugin requirements
- [World Behaviours](?page=unity/03-world-behaviours) — `GameInitializer` and `NonLazy` in detail
- [HTTP Clients](?page=unity/05-http-clients) — HTTP client bindings and `ITokenManager` dependency
- [Backend Architecture](?page=backend/01-architecture) — server-side DI mirrors this pattern
