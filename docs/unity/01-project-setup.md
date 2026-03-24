# Unity Project Setup

This page covers everything needed to go from a fresh clone to a running game session in Unity. It describes the project structure, required plugins, the configuration system, and how to start the backend that the Unity client talks to.

## Why These Choices?

### Why Unity 2022 LTS?

LTS (Long-Term Support) releases receive bug fixes and security patches for two years after release. Choosing an LTS version prevents breaking changes from mid-cycle Unity upgrades derailing active development. 2022 LTS was current at the time the project started; it will be upgraded to the next LTS when 2022 enters its maintenance phase.

### Why `My project` as the Unity project folder name?

This is Unity Hub's default project name and has not been changed. It is an intentional non-decision — renaming the folder would break any absolute paths stored in Unity's internal project settings files. The folder name does not appear in builds or affect any game functionality.

### Why `game_config.yaml` Instead of Unity's `PlayerPrefs` or `ScriptableObject`?

`game_config.yaml` is a plain text file that can be edited outside the Unity Editor (e.g., in CI pipelines or by contributors who do not have Unity installed). `PlayerPrefs` is opaque binary. A `ScriptableObject` requires the Unity Editor to modify. YAML is human-readable, version-controllable, and parseable from any language for tooling scripts.

The `IGameConfiguration` abstraction means the rest of the codebase never directly reads YAML — it calls `TryGet("key", out var value)`, making it easy to swap the backing format in the future if needed.

### Why a Single `.bytes` File for All Databases?

In production, the actual device `game_config.yaml` points all `database_path_*` keys to the same file (`crgame.bytes`). SQLite supports multiple schemas in a single file via `ATTACH DATABASE`. Using one file simplifies backup and deletion. During local development you can point each key to a separate `.db` file to inspect schemas independently — see the local dev example below.

### Why `DatabaseConnectionStringFactory` Instead of Hardcoded Paths?

`DatabaseConnectionStringFactory` implements a three-tier fallback for resolving database paths:

1. **YAML config key** — looks up `database_path_trainer` (etc.) from `game_config.yaml`. If the path is absolute it is used as-is; if relative it is resolved against `Application.persistentDataPath`.
2. **PlayerPrefs** — falls back to `DatabaseConfiguration.GetEffectiveDatabasePath()` if the YAML key is missing.
3. **Default** — `Application.persistentDataPath/{databaseName}.bytes`.

This means a new developer who does not customise `game_config.yaml` still gets a working database path automatically. The factory also creates the directory if it does not exist, so first-run setup is fully automatic.

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
          Configuration/← IGameConfiguration, DatabaseConnectionStringFactory
          Data/
            Client/     ← SimpleWebClient + all HTTP client impls
            Repository/ ← online/offline repository pairs, LocalizationRepository
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
        Npcs/           ← NPC HTTP client, NpcWorldBehaviour sub-behaviours
        Quests/         ← quest client, manager, repository
        Stats/          ← stat HTTP client
        Trainers/       ← trainer domain + HTTP clients
        UI/             ← IUIManager, UIManager
      Plugins/          ← Best HTTP, Zenject, Newtonsoft.Json
      Resources/
        configuration/
          game_config.yaml        ← loaded at runtime by ConfigurationRepository
          localization/           ← per-domain per-language YAML files
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
| Unity Addressables | 1.21.21 | UPM (`com.unity.addressables`) |

The first four are required for the game to compile. If any is missing, the build will fail with `CS0246: The type or namespace name '...' could not be found`.

**Addressables** (`com.unity.addressables` 1.21.21) is in `manifest.json` but the `AddressablesCatalogUpdater` class is compile-gated behind the `CR_ADDRESSABLES` scripting define symbol. The package is present so that Addressables asset references compile; to activate the catalog update check at startup, add `CR_ADDRESSABLES` to **Project Settings → Player → Scripting Define Symbols**.

**Zenject** (also known as Extenject for Unity) provides the `MonoInstaller` base class, `[Inject]` attribute, `Container.Bind`, and `GameContext` scene component. It is the entire foundation of the dependency injection system. See [Dependency Injection](?page=unity/02-dependency-injection) for details.

**Best HTTP** provides async HTTP request handling that integrates with Unity's main thread. It is used exclusively by `SimpleWebClient`. See [HTTP Clients](?page=unity/05-http-clients).

**Newtonsoft.Json for Unity** is the standard JSON library used for serialization/deserialization of all request and response bodies. It matches the backend's serialization conventions.

**Anti-Cheat Toolkit** provides `ObscuredPrefs`, a `PlayerPrefs`-compatible API that stores values in an obfuscated format, preventing trivial cheat engine modification of session tokens and preferences. `DeviceIdHolder.ForceLockToDeviceInit()` is called at the very start of `LocalDevGameInstaller.InstallBindings()` to ensure the device lock is in place before any auth data is read.

## New Developer Setup — Step by Step

This is the complete sequence for getting from zero to a running play session.

### Step 1 — Clone the repos

```bash
git clone https://github.com/CrystallineRift/cr-data.git
git clone https://github.com/CrystallineRift/cr-api.git
```

Clone both alongside each other in the same parent directory. The docs site (`cr-docs`) is optional for gameplay but helpful for reference.

### Step 2 — Install Unity 2022 LTS

In Unity Hub: **Installs → Add → Unity 2022.x LTS**. No additional modules are required for local development on macOS or Windows. Build support modules are only needed when targeting iOS/Android.

### Step 3 — Install Asset Store plugins

Before opening the project, install these from the Unity Asset Store:
- **Zenject (Extenject)** — search Asset Store for "Extenject"
- **Best HTTP** — search Asset Store for "Best HTTP"
- **Anti-Cheat Toolkit** — search Asset Store for "Anti-Cheat Toolkit"

Newtonsoft.Json is managed via the package manifest and will be pulled automatically when Unity first opens the project. The three Asset Store plugins must be imported before opening to avoid a cascade of compile errors on first open.

### Step 4 — Open the project in Unity Hub

In Unity Hub: **Open → `cr-data/My project`**. On first open, Unity will compile scripts and import assets. This may take several minutes.

If compile errors appear about missing namespaces (`Best.HTTP`, `Zenject`, `CodeStage`), the corresponding Asset Store plugin was not imported before opening. Import it from the Package Manager window, then wait for recompilation.

### Step 5 — Configure `game_config.yaml`

Open `cr-data/My project/Assets/CR/Resources/configuration/game_config.yaml` in a text editor. For local development with `CR.REST.AIO` running on port 8080:

```yaml
# Server addresses — all point to the AIO host for local dev
auth_server_http_address: "http://localhost:8080/auth"
oauth_server_http_address: "http://localhost:8080/oauth"
account_server_http_address: "http://localhost:8080/account"
trainer_server_http_address: "http://localhost:8080/trainer"
creature_server_http_address: "http://localhost:8080/creature"
npc_server_http_address: "http://localhost:8080/npc"
quest_server_http_address: "http://localhost:8080"
stat_server_http_address: "http://localhost:8080"
trainer_inventory_server_http_address: "http://localhost:8080/trainer-inventory"
trainer_creature_inventory_server_http_address: "http://localhost:8080/trainer-creature-inventory"

# Database paths — absolute paths work best for local dev
# Leave these as-is to use Application.persistentDataPath defaults,
# or set to absolute paths to a known directory for easier inspection.
database_path_trainer: "/path/to/dev/databases/trainer.bytes"
database_path_auth: "/path/to/dev/databases/auth.bytes"
database_path_creature: "/path/to/dev/databases/creature.bytes"
database_path_spawner: "/path/to/dev/databases/spawner.bytes"
```

If you omit the `database_path_*` keys entirely, `DatabaseConnectionStringFactory` falls back to `Application.persistentDataPath`, which on macOS is `~/Library/Application Support/DefaultCompany/My project/`.

### Step 6 — Start the backend

```bash
cd cr-api/Convenience/CR.REST.AIO
dotnet run
```

Verify the server is healthy at `http://localhost:8080/swagger`. All registered endpoints should appear. The AIO server runs all domain migrations on startup — check the console for any migration errors before hitting Play in Unity.

### Step 7 — Hit Play

Open the main scene (typically `Assets/Scenes/Game.unity`) and press **Play**. On first play:
1. `LocalDevGameInstaller.InstallBindings()` runs synchronously, executing all FluentMigrator migrations against each SQLite file.
2. `GameSessionManager` reads any cached session from SQLite.
3. If no session exists, the login/auth flow starts.
4. Once a trainer is selected, `GameInitializer` fires `RunAsync` and all `IWorldInitializable` behaviours in the scene initialize.

Watch the Unity Console for `[GameInitializer] === World init complete ===` to confirm the bootstrap succeeded.

## Configuration (`game_config.yaml`)

The `IGameConfiguration` reads from a YAML file at runtime via `ConfigurationRepository`. Key configuration keys:

| Key | Purpose |
|-----|---------|
| `npc_server_http_address` | Base URL for NPC REST endpoints |
| `auth_server_http_address` | Base URL for auth endpoints |
| `trainer_server_http_address` | Base URL for trainer endpoints |
| `creature_server_http_address` | Base URL for creature and growth-profile endpoints |
| `quest_server_http_address` | Base URL for quest endpoints |
| `stat_server_http_address` | Base URL for stats debug endpoints |
| `database_path_trainer` | Absolute or relative path for the trainer SQLite file |
| `database_path_auth` | Absolute or relative path for the auth SQLite file |
| `database_path_creature` | Absolute or relative path for the creature SQLite file |
| `database_path_spawner` | Absolute or relative path for the spawner SQLite file |

`GameConfigurationKeys` (static class in `CR.Core.Data.Repository`) holds string constants for all keys. Always use these constants instead of string literals:

```csharp
// Correct — compile-time safe
configuration.TryGet(GameConfigurationKeys.NpcServerHttpAddress, out var url);

// Wrong — silently fails on a typo
configuration.TryGet("npc_server_http_adress", out var url);
```

## How to Add a New Creature to `game_config.yaml`

New creatures are defined in the backend seed data (database migration), not in `game_config.yaml` directly. However, the Unity Inspector and any code that looks up a creature by `content_key` from config does need YAML entries for any creature whose UUID you need to reference from configuration.

The pattern is:

```yaml
# Wild encounter base creature IDs (referenced by content_key in spawner config)
wild_encounter_cindris_creature_id: a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d
```

When a new creature is added:
1. Add a migration in `CR.Creatures.Data.Migration` to seed the `creature_base` row with the correct `content_key`.
2. After running the migration, retrieve the UUID from the database.
3. If any game configuration lookup references this creature (e.g., a wild encounter spawner pool, or a starter creature slot), add the UUID to `game_config.yaml` under a descriptive key.
4. Add the key constant to `GameConfigurationKeys` if it will be used in code.

Localization strings for the creature go in `Resources/configuration/localization/creatures.yaml`:

```yaml
creature_cindris_fire_name: Cindris Fire
creature_cindris_fire_description: A flame-type starter creature native to the Cindris region.
```

The key pattern is `creature_{content_key}_{field}`. See [Localization](?page=unity/06-localization) for full key conventions.

## How to Add a New NPC to `game_config.yaml`

NPCs are not configured in `game_config.yaml` directly. The NPC's `content_key` is set in the Unity Inspector on `NpcWorldBehaviour._npcContentKey`. The NPC row is created on the backend via `EnsureNpcAsync` on first play.

However, if an NPC's creature team slots reference creature base UUIDs by config key (as is the pattern in `NpcTrainerBehaviour`), those UUIDs need to be in `game_config.yaml`:

```yaml
# NPC trainer creature slot config keys (resolved by NpcTrainerBehaviour)
kael_battle_creature_1_id: bbbb2222-...
kael_battle_creature_2_id: cccc3333-...
```

`NpcTrainerBehaviour` looks these up via `IGameConfiguration.TryGet(creatureBaseContentKey)`. If the key is missing, the behaviour logs a warning and skips that slot.

Localization strings for NPC dialogue go in a dedicated YAML file or in an existing domain file under `Resources/configuration/localization/`:

```yaml
# In a new npcs.yaml file (create it — Unity picks it up automatically)
npc_kael_trainer_name: Trainer Kael
npc_kael_trainer_greeting: Ready to see what your creatures are made of?
```

## Running the Backend

```bash
cd cr-api/Convenience/CR.REST.AIO
dotnet run
```

Default port: `http://localhost:8080` (check `launchSettings.json` if it differs on your machine). Set all `*_server_http_address` keys in `game_config.yaml` to match.

Check Swagger UI at `http://localhost:8080/swagger` to verify all endpoints are registered and the server is healthy before hitting Play in Unity.

## SQLite Database Files

Unity creates SQLite files at the configured `database_path_*` locations. `DatabaseConnectionStringFactory` creates the directory if it does not exist, so no manual setup is required.

Database files use the `.bytes` extension (not `.db`) so Unity's asset pipeline does not try to import them as binary assets. SQLite itself does not care about the extension.

If you need to reset all local state (e.g., after a breaking schema migration):
1. Stop the Unity Player.
2. Delete the `.bytes` files from the configured paths.
3. Hit Play — migrations recreate them fresh.

The database files should be listed in `.gitignore` and never committed. They are local developer state.

## content_key and game_config.yaml

The `game_config.yaml` and localization YAML files define `content_key` values for game content — creatures, NPCs, quest templates, items, etc. When a level designer places an NPC in the Unity scene and sets `_npcContentKey` in the Inspector, they use the `content_key` from the YAML and database seed data.

This separation means:
- Designers work in YAML and Unity Inspector only
- Backend engineers manage the database seed data
- The `content_key` string is the contract between the two worlds — readable, version-controllable, and human-friendly

See [Introduction](?page=00-introduction) for more on the `content_key` vs UUID design philosophy.

## Common Mistakes / Tips

- **All four plugins must be present before opening the project.** Missing a plugin causes a cascade of compile errors that can be misleading. Import Zenject and Best HTTP from the Asset Store before opening the project for the first time.
- **`game_config.yaml` not found at startup.** If the config file is missing, all `IGameConfiguration.TryGet` calls return false and null. HTTP client base URLs will be null, and every request will throw immediately. The file must be at `Assets/CR/Resources/configuration/game_config.yaml`.
- **Stale SQLite files after schema migration.** If a migration adds a non-nullable column with no default, and the old `.bytes` file has rows missing that column, queries will fail at runtime. Delete and recreate the database files after breaking schema changes.
- **Editor vs Build database paths.** `Application.persistentDataPath` differs between Editor and standalone builds. Use absolute paths in `game_config.yaml` only during local development — use relative paths or omit the keys for device builds to use the default path.
- **Multiple Unity instances with the same database file.** Two Unity instances sharing the same `.bytes` file will cause SQLite lock contention. Use separate `game_config.yaml` overrides for each instance.
- **Wrong port in `game_config.yaml`.** The AIO server uses port 8080 by default (check `launchSettings.json`). The example in this doc previously showed 5000 — if requests are timing out immediately, verify the port.
- **`GameConfigurationKeys` key not found logs no error at startup.** `TryGet` returns false silently. If an HTTP client's base URL resolves to null, you will see `Invalid HttpClient configuration` in the log at startup — search for this string to identify the misconfigured key.
- **Relative `database_path_*` values resolve against `Application.persistentDataPath`.** A value like `databases/trainer.bytes` becomes `{persistentDataPath}/databases/trainer.bytes`. This is fine for device builds but may be surprising in the Editor where `persistentDataPath` includes Unity's company and project name in the path.
- **`.bytes` extension required.** SQLite files must use `.bytes` to avoid Unity's asset importer attempting to process them. The `DatabaseConnectionStringFactory.GetConnectionString` method appends `.bytes` automatically when using the database name overload, but `GetConnectionStringForRepository` uses the path from YAML as-is.

## Related Pages

- [Dependency Injection](?page=unity/02-dependency-injection) — `LocalDevGameInstaller`, migration runner, binding order
- [HTTP Clients](?page=unity/05-http-clients) — how `game_config.yaml` keys are used to configure HTTP clients
- [Localization](?page=unity/06-localization) — YAML localization files alongside `game_config.yaml`
- [Auth and Accounts](?page=backend/06-auth-and-accounts) — `auth_server_http_address` and token management
- [Backend Architecture](?page=backend/01-architecture) — how the server-side mirrors this structure
