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

## Why `AsCached` for `FromInstance` Bindings?

When you create a repository via `new TrainerRepository(...)` and pass it to `FromInstance(...)`, you own the instance. Telling Zenject `AsCached()` means "reuse the instance I gave you." If you accidentally write `AsSingle()` on a `FromInstance` binding, Zenject ignores `FromInstance` and tries to create a new instance via constructor injection — which usually fails because the constructor needs parameters that Zenject cannot resolve.

Rule: **`FromInstance` always pairs with `AsCached`.** `AsSingle` is for bindings where Zenject creates the instance itself (via `To<T>()` without `FromInstance`).

## Installation Order

`InstallBindings()` runs once at scene load. The order matters because later bindings may depend on earlier ones:

1. **Anti-cheat / SQLite init** — `DeviceIdHolder.ForceLockToDeviceInit()`, `SQLiteInitializer.Initialize()` — must run before any SQLite connection is opened
2. **Core singletons** — `IUIManager`, `IGameConfiguration`, `IDatabaseConnectionStringFactory` — needed by almost everything else
3. **Resolve the connection string factory** — `Container.Resolve<IDatabaseConnectionStringFactory>()` is called once here; all subsequent `FromInstance` repository bindings use the resolved factory to build their connection strings
4. **Repositories** — online/offline pairs for each domain — registered before migrations so the connection strings are resolved
5. **Run migrations** — `RunDatabaseMigrationsSynchronously(connectionStringFactory)` — blocks the installer until all schemas exist (offline and online-cache databases)
6. **Auth** — `IAuthRepository`, `ITokenManager`, `ITokenValidator` — auth comes after repos so it can store tokens in the auth SQLite
7. **HTTP clients** — all `I*Client` bindings — come after auth so they can inject `ITokenManager`
8. **Domain services** — creature, trainer, NPC, spawner, quest, battle services — come after repos and HTTP clients
9. **Game infrastructure** — `GameSessionManager`, `GameInitializer` (NonLazy), `BattleCoordinator` — `GameInitializer` must be last so it subscribes to `GameSessionManager.OnTrainerChanged` after the manager is bound

## Online/Offline Repository Pattern

Each data domain registers three variants. From `LocalDevGameInstaller.cs`:

```csharp
// 1. Offline SQLite — device-local data
Container.Bind<ITrainerRepository>()
    .WithId(LocalDataSources.TrainerOfflineRepository)
    .To<TrainerRepository>()
    .FromInstance(new TrainerRepository(
        new CRUnityLoggerAdapter(typeof(TrainerRepository)),
        connectionStringFactory.GetConnectionStringForRepository(
            LocalDataSources.TrainerOfflineRepository)))
    .AsCached();

// 2. Online-cache SQLite — server data mirrored locally
Container.Bind<ITrainerRepository>()
    .WithId(LocalDataSources.TrainerOnlineCacheRepository)
    .To<TrainerRepository>()
    .FromInstance(new TrainerRepository(
        new CRUnityLoggerAdapter(typeof(TrainerRepository)),
        connectionStringFactory.GetConnectionString(
            LocalDataSources.TrainerOnlineCacheRepositoryDatabaseName)))
    .AsCached();

// 3. Online HTTP — live backend calls
Container.Bind<ITrainerRepository>()
    .WithId(LocalDataSources.TrainerOnlineRepository)
    .To<TrainerOnlineRepository>()
    .AsCached();

// 4. Router — picks offline or online at runtime (no Id = this is the default binding)
Container.Bind<ITrainerRepository>()
    .To<TrainerOnlineOfflineRepository>()
    .AsCached();
```

The unkeyed binding (`TrainerOnlineOfflineRepository`) is what most services receive via constructor injection. It reads the current network state and delegates to the appropriate underlying repository.

**Resolving a keyed binding manually** (inside a router):

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

## AsSingle vs AsCached Decision Guide

| Scenario | Use |
|---|---|
| Zenject creates the instance (e.g., `To<MyService>()` without `FromInstance`) | `AsSingle()` |
| You pass a pre-built instance via `FromInstance(new ...)` | `AsCached()` |
| The object holds per-consumer state (each caller needs its own copy) | `AsTransient()` |
| MonoBehaviour created by Zenject on a new GameObject | `AsSingle()` + `FromNewComponentOnNewGameObject()` |
| Service must be created at bind time (event subscriber, etc.) | `AsSingle().NonLazy()` |

In practice almost all game services use `AsSingle()`. `AsCached()` appears only with `FromInstance`. `AsTransient()` is used for `ILogger<T>` where each caller gets its own typed logger.

## Adding a New Domain — Full Checklist

When adding an entirely new domain (e.g., `Guilds`), touch all of these in `LocalDevGameInstaller.cs`:

```csharp
// ── 1. Resolve connection strings (already done once at the top) ──────────────
// (nothing new needed here — factory already bound)

// ── 2. Repository bindings ────────────────────────────────────────────────────
Container.Bind<IGuildRepository>()
    .WithId(LocalDataSources.GuildOfflineRepository)
    .To<GuildRepository>()
    .FromInstance(new GuildRepository(
        new CRUnityLoggerAdapter(typeof(GuildRepository)),
        connectionStringFactory.GetConnectionStringForRepository(
            LocalDataSources.GuildOfflineRepository)))
    .AsCached();

// (add online-cache and online variants if offline support is needed)

Container.Bind<IGuildRepository>()
    .To<GuildOnlineOfflineRepository>()
    .AsCached();

// ── 3. Migrations (inside RunDatabaseMigrationsSynchronously) ─────────────────
// migrationRunner.MigrateAll(guildDatabasePath); // if separate DB file

// ── 4. HTTP client ────────────────────────────────────────────────────────────
Container.Bind<IGuildClient>().To<GuildClientUnityHttp>().AsSingle();

// ── 5. Domain service ─────────────────────────────────────────────────────────
Container.Bind<IGuildDomainService>().To<GuildDomainService>().AsSingle();
```

Also add to `LocalDataSources`:
```csharp
public const string GuildOfflineRepository = "guild_offline";
public const string GuildOnlineCacheRepositoryDatabaseName = "guildOnlineCache";
public const string GuildOnlineRepository = "guild_online";
```

And to `GameConfigurationKeys`:
```csharp
public const string GuildServerHttpAddress = "guild_server_http_address";
```

## Database Migrations

Migrations run **synchronously** during `InstallBindings` via `RunDatabaseMigrationsSynchronously`. This ensures all tables exist before any service tries to use them.

```csharp
// From RunDatabaseMigrationsSynchronously in LocalDevGameInstaller.cs
migrationRunner.MigrateAll(trainerOfflinePath);
migrationRunner.MigrateAll(authOfflinePath);
migrationRunner.MigrateAll(creatureOfflinePath);
migrationRunner.MigrateAll(spawnerDatabasePath);

migrationRunner.MigrateAll(trainerOnlinePath);
migrationRunner.MigrateAll(authOnlinePath);
migrationRunner.MigrateAll(creatureOnlinePath);
```

`MigrateAll` loads every domain's migration assembly into a single FluentMigrator run, executing migrations in global numeric order (M0001 → M9999). All domain migrations share a global number space — reserve ranges per domain (e.g., Auth: M0001–M0099, Creatures: M0100–M0199).

**Why synchronous?** Async initialization in `InstallBindings` is not supported by Zenject's binding lifecycle. The installer must complete before the scene starts. Migrations are fast (< 100 ms for a typical SQLite schema on device) and only create tables that do not already exist, so they are idempotent and safe to run on every startup.

If migrations fail during startup, `RunDatabaseMigrationsSynchronously` logs the error and re-throws. Zenject will abort `InstallBindings` and log the exception. Check the Unity Console for `Failed to run database migrations during installation` and the underlying exception message.

## Debugging Zenject Binding Errors

**Error: `ZenjectException: Unable to resolve type X`**

Zenject could not find any binding for type `X`. Common causes:
- You added a dependency to a service constructor but forgot to add the binding in `LocalDevGameInstaller.cs`
- You used the wrong interface type (e.g., `ITrainerRepository` vs `CR.Trainers.Data.Interface.ITrainerRepository` — check the namespace)
- The binding was added to the wrong container (e.g., a sub-container instead of the main scene container)

Fix: search `LocalDevGameInstaller.cs` for `Container.Bind<X>`. If not found, add it in the correct section.

**Error: `ZenjectException: Found multiple bindings for type X without an Id`**

You have two unkeyed bindings for the same interface. This happens if you accidentally add a second unkeyed binding when you intended to add a keyed one. Fix: add `.WithId(...)` to one of them.

**Error: `ZenjectException: Circular dependency detected`**

Service A depends on service B, which depends on service A. Fix: introduce a lazy reference (`Lazy<T>`) or refactor to break the cycle by extracting a shared sub-dependency.

**Symptom: Injection worked but service never activates**

You added a `NonLazy()` binding for a service that subscribes to events, but the event never fires. Check that the service you are subscribing to is also bound and initialized before the subscriber.

## Verifying Bindings at Runtime

Use Zenject's **Container Validation** in Unity Editor:
- **Tools → Zenject → Validate Installer** — validates all bindings in the active scene without entering Play mode. This catches resolution errors early.
- In the Console, look for `[GameInitializer] Injected and subscribed to OnTrainerChanged` — this confirms `GameInitializer` was created and injected successfully.
- Add a debug `[Inject]` log to any service constructor you want to verify: `logger.Debug($"[MyService] constructed")`. It will appear in the Console during `InstallBindings`.

## `GameInitializer` — NonLazy Explained

```csharp
// In LocalDevGameInstaller:
Container.Bind<CR.Game.World.GameInitializer>()
    .FromNewComponentOnNewGameObject()
    .AsSingle()
    .NonLazy();
```

`FromNewComponentOnNewGameObject()` creates a new GameObject with `GameInitializer` attached. `.NonLazy()` tells Zenject to do this at bind time, not when something first resolves `GameInitializer`. The result:

1. Zenject creates the `GameInitializer` GameObject during `InstallBindings`
2. Zenject calls the `[Inject]` method on `GameInitializer`, wiring `_sessionManager.OnTrainerChanged += OnTrainerChanged`
3. When `GameSessionManager.Start()` runs and fires `OnTrainerChanged`, `GameInitializer` is already subscribed and drives world initialization

Without `NonLazy()`, `GameInitializer` would only be created when something resolves it — but nothing resolves it except itself. The subscription would never happen. This is the most common Zenject "silent failure" pattern.

Note: `GameInitializer`'s `[Inject]` method subscribes in the injection call, not in `OnEnable`. This is intentional — `OnEnable` runs before `[Inject]` on a `FromNewComponentOnNewGameObject` object, so subscribing in `OnEnable` would crash with `NullReferenceException` because the injected `_sessionManager` would not be set yet.

## Zenject Tips

- Use `AsSingle()` for stateful services (domain services, managers) — one instance shared by all consumers
- Use `AsCached()` for repository instances created with `FromInstance` — Zenject will not try to re-create them
- Use `AsTransient()` for stateless helpers where each consumer should get its own instance (e.g., `ILogger<T>`)
- `NonLazy()` forces instantiation at bind time — used for `GameInitializer` and `BattleCoordinator` so they subscribe to events immediately
- **Never use `FindObjectOfType<T>()` inside an `[Inject]` method.** Zenject resolves injections during `Awake` before the scene is fully initialized. `FindObjectOfType` may return null for objects not yet awake.
- **Circular dependencies.** Zenject detects circular constructor injection at startup and throws. If you need a circular relationship (rare), use lazy injection with `Lazy<IService>`.

## Common Mistakes / Tips

- **Binding after migrations.** If a service binding comes before `RunDatabaseMigrationsSynchronously` and the service's constructor tries to open a SQLite connection, the database may not have the required tables yet. Always run migrations before any service binding that performs DB operations at construction time.
- **Forgetting `NonLazy()` for event subscribers.** Any service that subscribes to events in its `[Inject]` method needs `NonLazy()` or it will never be created. Check for `AsSingle()` bindings where the consumer expects event-driven activation.
- **`WithId` binding resolved without the Id.** If a service injects `ITrainerRepository` without an `Id`, it gets the unkeyed router binding. This is usually correct. But if you accidentally bind the router twice (e.g., both with and without `.WithId`), Zenject will throw an ambiguity error at resolve time.
- **`AsSingle` vs `AsCached` for `FromInstance`.** Use `AsCached` when you pass a pre-created instance via `FromInstance`. `AsSingle` causes Zenject to attempt to create a new instance via constructor injection, ignoring the `FromInstance` call.
- **Missing `using` statement for the interface namespace.** Zenject binds by exact type. If two assemblies both define `ITrainerRepository` in different namespaces, you must use the fully qualified name in the `Bind<>` call or Zenject will silently bind the wrong one.
- **Zenject validate passes but Play fails.** Container validation does not execute `FromInstance` factories, so runtime errors (e.g., `DatabaseConnectionStringFactory` throwing because `game_config.yaml` is missing a key) only appear on Play. Always check the Console on first Play after changing bindings.
- **`ILogger<T>` binding uses `AsTransient`.** This is intentional — each service gets its own typed logger. Do not change it to `AsSingle()`.

## Related Pages

- [Unity Project Setup](?page=unity/01-project-setup) — `game_config.yaml`, database paths, plugin requirements
- [World Behaviours](?page=unity/03-world-behaviours) — `GameInitializer` and `NonLazy` in detail
- [HTTP Clients](?page=unity/05-http-clients) — HTTP client bindings and `ITokenManager` dependency
- [Backend Architecture](?page=backend/01-architecture) — server-side DI mirrors this pattern
