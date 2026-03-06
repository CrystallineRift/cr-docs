# Dependency Injection

## Overview

The Unity client uses **Zenject** for dependency injection. The root installer is `LocalDevGameInstaller`, a `MonoInstaller` attached to the main scene's `GameContext` GameObject.

Source: `../cr-data/My project/Assets/CR/DI/LocalDevGameInstaller.cs`

## Installation Order

`InstallBindings()` runs once at scene load. The order matters:

1. **Anti-cheat / SQLite init** — `DeviceIdHolder.ForceLockToDeviceInit()`, `SQLiteInitializer.Initialize()`
2. **Core singletons** — `IUIManager`, `IGameConfiguration`, `IDatabaseConnectionStringFactory`
3. **Repositories** — online/offline pairs for each domain
4. **Run migrations** — `DatabaseMigrationRunner.MigrateAll(...)` for all databases synchronously
5. **Auth** — `ITokenManager`, `ITokenValidator`, auth repositories
6. **HTTP clients** — all `I*Client` bindings
7. **Domain services** — creature, trainer, NPC, spawner, battle services
8. **Game infrastructure** — `GameSessionManager`, `GameInitializer`, movement factories

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

## Database Migrations

Migrations run **synchronously** during `InstallBindings` via `RunDatabaseMigrationsSynchronously`. This ensures all tables exist before any service tries to use them.

```csharp
migrationRunner.MigrateAll(trainerOfflinePath);
migrationRunner.MigrateAll(authOfflinePath);
migrationRunner.MigrateAll(creatureOfflinePath);
migrationRunner.MigrateAll(spawnerDatabasePath);
```

`MigrateAll` loads every domain's migration assembly into a single FluentMigrator run, executing migrations in global numeric order (M0001 → M9999).

## Zenject Tips

- Use `AsSingle()` for stateful services (domain services, managers).
- Use `AsCached()` for repository instances created with `FromInstance` — Zenject won't try to re-create them.
- Use `AsTransient()` for loggers (`ILogger<T>`).
- `NonLazy()` forces instantiation at bind time — used for `GameInitializer` so it subscribes to events immediately.
