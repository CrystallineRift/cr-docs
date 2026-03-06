# Unity Project Setup

This page covers everything needed to go from a fresh clone to a running game session in Unity. It describes the project structure, required plugins, the configuration system, and how to start the backend that the Unity client talks to.

## Why These Choices?

### Why Unity 2022 LTS?

LTS (Long-Term Support) releases receive bug fixes and security patches for two years after release. Choosing an LTS version prevents breaking changes from mid-cycle Unity upgrades derailing active development. 2022 LTS was current at the time the project started; it will be upgraded to the next LTS when 2022 enters its maintenance phase.

### Why `My project` as the Unity project folder name?

This is Unity Hub's default project name and has not been changed. It is an intentional non-decision — renaming the folder would break any absolute paths stored in Unity's internal project settings files. The folder name does not appear in builds or affect any game functionality.

### Why `game_config.yaml` Instead of Unity's `PlayerPrefs` or `ScriptableObject`?

`game_config.yaml` is a plain text file that can be edited outside the Unity Editor (e.g., in CI pipelines or by contributors who do not have Unity installed). `PlayerPrefs` is opaque binary. A `ScriptableObject` requires the Unity Editor to modify. YAML is human-readable, version-controllable, and parseable from any language for tooling scripts.

The `IGameConfiguration` abstraction means the rest of the codebase never directly reads YAML — it calls `GetString("key")` or similar, making it easy to swap the backing format in the future if needed.

## Repository Structure

```
cr-data/
  My project/
    Assets/
      CR/
        Auth/           ← auth data, HTTP clients
        Common/         ← shared utilities, base types
        Core/
          Assets/       ← IGameAssetLoader (loads game_config.yaml assets)
          Auth/         ← ITokenManager, ITokenValidator
          Configuration/← IGameConfiguration, UnityConfigurationAdapter
          Data/
            Client/     ← SimpleWebClient + all HTTP client impls
            Repository/ ← online/offline repository pairs
          Logging/      ← ICRLogger, CRUnityLoggerAdapter
          Movement/     ← IMovementController, ICreatureAI
          Session/      ← GameSessionManager
        Creatures/      ← creature domain services + HTTP clients
        DI/             ← LocalDevGameInstaller
        Game/
          BattleSystem/ ← IBattleSystem, StatefulBattleSystemV2
          Common/       ← ICRLogger, IWorldContext, WorldRegistry
          Data/         ← IGameSessionRepository, IGameAssetRepository
          Domain/       ← high-level game services
          World/        ← GameInitializer, NpcWorldBehaviour…
        Items/          ← item domain + HTTP clients
        Npcs/           ← NPC HTTP client
        Trainers/       ← trainer domain + HTTP clients
        UI/             ← IUIManager, UIManager
      Plugins/          ← Best HTTP, Zenject, Newtonsoft.Json
    ProjectSettings/
```

The `CR/` folder is the game's source root. Every domain has its own subfolder following the same sub-structure as the backend: data interfaces, HTTP client implementations, and domain services. The `Core/` folder holds cross-cutting infrastructure (logging, configuration, session management) that every other domain depends on.

## Required Unity Packages / Plugins

| Package | Version | Source |
|---------|---------|--------|
| Zenject | 9.x | Asset Store / UPM |
| Best HTTP | 3.x | Asset Store |
| Newtonsoft.Json for Unity | 13.x | UPM (`com.unity.nuget.newtonsoft-json`) |
| Anti-Cheat Toolkit | latest | Asset Store (for `ObscuredPrefs`) |

All four are required for the game to compile. If any is missing, the build will fail with `CS0246: The type or namespace name '...' could not be found`.

**Zenject** (also known as Extenject for Unity) provides the `MonoInstaller` base class, `[Inject]` attribute, `Container.Bind`, and `GameContext` scene component. It is the entire foundation of the dependency injection system. See [Dependency Injection](?page=unity/02-dependency-injection) for details.

**Best HTTP** provides async HTTP request handling that integrates with Unity's main thread via coroutines and `UniTask`-style continuations. It is used exclusively by `SimpleWebClient`. See [HTTP Clients](?page=unity/05-http-clients).

**Newtonsoft.Json for Unity** is the standard JSON library used for serialization/deserialization of all request and response bodies. It matches the backend's serialization conventions.

**Anti-Cheat Toolkit** provides `ObscuredPrefs`, a `PlayerPrefs`-compatible API that stores values in an obfuscated format, preventing trivial cheat engine modification of session tokens and preferences.

## Opening the Project

1. Clone `cr-data` alongside `cr-api`:
   ```bash
   git clone https://github.com/CrystallineRift/cr-data.git
   ```
2. Open **Unity Hub → Add → `cr-data/My project`**
3. Wait for package import (first open may take several minutes as plugins compile)
4. Open the main scene (typically `Assets/Scenes/Game.unity`)
5. Hit **Play** — `LocalDevGameInstaller` runs migrations and boots services

On first Play, FluentMigrator creates all SQLite database files in the paths specified by `game_config.yaml`. If the paths do not exist, it creates the directories. If migrations fail (e.g., conflicting schema from a previous version), Unity will log an error during `InstallBindings`.

## Configuration (`game_config.yaml`)

The `IGameConfiguration` reads from a YAML file at runtime. The file lives at a path relative to `Application.dataPath` or a configured root. Key configuration keys:

| Key | Purpose |
|-----|---------|
| `npc_server_http_address` | Base URL for the NPC REST service (e.g., `http://localhost:5000`) |
| `auth_server_http_address` | Base URL for auth endpoints |
| `trainer_server_http_address` | Base URL for trainer endpoints |
| `creature_server_http_address` | Base URL for creature endpoints |
| `database_path_trainer` | SQLite path for trainer database |
| `database_path_spawner` | SQLite path for spawner database |
| `database_path_creature` | SQLite path for creature database |

`GameConfigurationKeys` (static class) holds all key constants to avoid magic strings throughout the codebase. If you add a new server endpoint, add the key constant there before using it in any `SimpleWebClient` subclass.

### Example `game_config.yaml`

```yaml
npc_server_http_address: "http://localhost:5000"
auth_server_http_address: "http://localhost:5000"
trainer_server_http_address: "http://localhost:5000"
creature_server_http_address: "http://localhost:5000"

database_path_trainer: "Databases/trainer.db"
database_path_spawner: "Databases/spawner.db"
database_path_creature: "Databases/creature.db"
```

When running `CR.REST.AIO` locally, all four server addresses point to the same host (the AIO server). In a deployed environment with separate microservices, each address would point to its own host.

## Running the Backend

```bash
cd cr-api/Convenience/CR.REST.AIO
dotnet run
```

Default port: `http://localhost:5000`. Set all `*_server_http_address` keys in `game_config.yaml` to this address.

Check Swagger UI at `http://localhost:5000/swagger` to verify all endpoints are registered and the server is healthy before hitting Play in Unity.

## SQLite Database Files

Unity creates SQLite files at the configured `database_path_*` locations relative to `Application.persistentDataPath` (or the path root in your configuration adapter). These files are created on first run and persist between Play sessions in the Editor.

If you need to reset all local state (e.g., after a breaking schema migration):
1. Stop the Unity Player
2. Delete the `.db` files from the configured paths
3. Hit Play — migrations recreate them fresh

The database files should be listed in `.gitignore` and never committed. They are local developer state.

## content_id and game_config.yaml

The `game_config.yaml` and related YAML asset files define `content_id` values for all game content — creatures, NPCs, items, etc. When a level designer places an NPC in the Unity scene and sets `_npcContentId` in the Inspector, they look up the `content_id` from the YAML, not the database UUID.

This separation means:
- Designers work in YAML and Unity Inspector only
- Backend engineers manage the database seed data
- The `content_id` is the contract between the two worlds

See [Introduction](?page=00-introduction) for more on the `content_id` vs UUID design philosophy.

## Common Mistakes / Tips

- **All four plugins must be present before opening the project.** Missing a plugin causes a cascade of compile errors that can be misleading. Import Zenject and Best HTTP from the Asset Store before opening the project for the first time.
- **`game_config.yaml` not found at startup.** If the config file is missing, all `IGameConfiguration.GetString` calls return null. HTTP client base URLs will be null, and every request will throw immediately. Check the path your `UnityConfigurationAdapter` is reading from.
- **Stale SQLite files after schema migration.** If a migration adds a non-nullable column with no default, and the old `.db` file has rows missing that column, queries will fail at runtime. Delete and recreate the database files after breaking schema changes.
- **Editor vs Build database paths.** `Application.persistentDataPath` differs between Editor and standalone builds. Test on device/build early to verify your path configuration works outside the Editor.
- **Multiple Unity instances with the same config.** Two Unity instances sharing the same SQLite file will cause lock contention. Use separate `game_config.yaml` overrides for each instance.

## Related Pages

- [Dependency Injection](?page=unity/02-dependency-injection) — `LocalDevGameInstaller`, migration runner, binding order
- [HTTP Clients](?page=unity/05-http-clients) — how `game_config.yaml` keys are used to configure HTTP clients
- [Auth and Accounts](?page=backend/06-auth-and-accounts) — `auth_server_http_address` and token management
- [Backend Architecture](?page=backend/01-architecture) — how the server-side mirrors this structure
