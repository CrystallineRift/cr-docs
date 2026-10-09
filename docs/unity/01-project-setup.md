# Unity Project Setup

This page covers everything needed to go from a fresh clone to a running game session in Unity. It describes the project structure, required plugins, the configuration system, and how to start the backend that the Unity client talks to.

## Why These Choices?

### Why Unity 2022 LTS?

LTS (Long-Term Support) releases receive bug fixes and security patches for two years after release. Choosing an LTS version prevents breaking changes from mid-cycle Unity upgrades derailing active development. 2022 LTS was current at the time the project started; it will be upgraded to the next LTS when 2022 enters its maintenance phase.

### Why `My project` as the Unity project folder name?

This is Unity Hub's default project name and has not been changed. It is an intentional non-decision — renaming the folder would break any absolute paths stored in Unity's internal project settings files. The folder name does not appear in builds or affect any game functionality.

### Why `GameSettings.asset` Instead of a YAML File?

`game_config.yaml` was replaced on 2026-10-08. A ScriptableObject (`GameSettings.asset`) is typed, shows up in the Inspector and cannot hold a typo'd key; the machine-specific parts (which environment, which world mode) moved out of the committed file into per-developer Studio overrides (EditorPrefs), so switching to Local no longer dirties the repo or risks shipping `localhost`. See [Content Registry -> Game settings](?page=unity/08-content-registry).

The `IGameConfiguration` abstraction is unchanged — the rest of the codebase calls `TryGet("key", out var value)`; `SettingsGameConfiguration` now answers it from the asset.

### Why a Two-Database Split (game-data vs player-data)?

The offline SQLite store is split into **two databases** with different lifecycles:

- **game-data DB** (`game-data.bytes`) — global authored content (base creatures, abilities, status conditions, growth profiles, items, spawner templates + pools, quest templates/objectives/requirements/rewards, `game_assets`, level/exp tables). Read-only at runtime. Built at build time as a versioned artifact and patched via Addressables.
- **player-data DB** (`player-data.bytes`) — per-account/per-trainer saves (trainers, inventories, generated creatures, quest instances, stats, battles, spawn history, auth) **plus the per-trainer NPC instance tables** (`npcs`, `npc_creature_team`, `npc_inventory`). Mutable; migrated in place on app update.

> **NPC instance tables live in player-data, not game-data.** `INpcRepository` and `INpcCreatureTeamRepository` are bound to `LocalDataSources.PlayerData.OfflineSource` in `LocalDevGameInstaller`, co-located with `npc_inventory` (so merchant-purchase transactions and FK integrity stay on one physical DB). The `npcs` rows are per-`(account, trainer)` runtime save-data created by `EnsureNpcAsync` at world bootstrap — not designer content — so binding them to the adopted, read-only `game-data.bytes` was wrong: adoption could wipe runtime NPCs. NPC *definitions* (designer content) still flow through the content registry, not the offline `npcs` table.

Splitting them means a content update never touches player saves, and each side uses the update mechanism that fits (Addressables for content, in-place migrations for saves). The two offline databases are wired via `LocalDataSources.GameData.OfflineSource` (config key `database_path_game_data`) and `LocalDataSources.PlayerData.OfflineSource` (config key `database_path_player_data`). The unified migrator currently creates the full schema in each file; unused tables on each side are harmless.

See the dedicated [Content Pipeline (Two-Database Model)](?page=unity/17-content-pipeline) page for the full build/ship/adopt flow, the 12 build-time referential-integrity checks, and the content-vs-player taxonomy.

> The single-file model (formerly `crgame.bytes`, where all `database_path_*` keys pointed at one file via `ATTACH DATABASE`) has been retired. The build-time content artifact is now named `game-data.bytes`.

### Why `DatabaseConnectionStringFactory` Instead of Hardcoded Paths?

`DatabaseConnectionStringFactory` implements a three-tier fallback for resolving database paths:

1. **Configuration key** — asks `IGameConfiguration` for the data source's key. Only two are answered: `database_path_game_data` and `database_path_player_data`, which come from `GameSettings` `gameDataFileName` / `playerDataFileName` (`game-data.bytes`, `playerData.bytes`). An absolute value is used as-is; a relative one (the normal case) resolves against `Application.persistentDataPath`.
2. **PlayerPrefs** — for the base directory, `DatabaseConfiguration.GetEffectiveDatabasePath()` when it holds a path.
3. **Default** — `{base directory}/{databaseName}.bytes`, where the base directory is the PlayerPrefs path from step 2 or else `Application.persistentDataPath`. The online-cache databases always land here: `GameSettings` answers no `database_path_*_online_cache` key.

Nothing needs configuring on a fresh clone. The factory also creates the directory if it does not exist, so first-run setup is fully automatic.

## Repository Structure

```
cr-data/
  My project/
    Assets/
      CR/
        Auth/           ← auth data, HTTP clients
        Common/         ← shared utilities, base types
        Core/
          Assets/       ← IGameAssetLoader
          Auth/         ← ITokenManager, ITokenValidator
          Configuration/← GameSettings, SettingsGameConfiguration, IGameConfiguration, DatabaseConnectionStringFactory
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
          GameSettings.asset      ← read by SettingsGameConfiguration
          BackendEnvironments.asset ← the Local / Production environments
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

### Step 5 — Point the Editor at your local server

Nothing in the repo changes for this. The committed `GameSettings.asset` holds the shipping defaults (environment `production`, world mode Legacy); your machine's choices are Editor-only overrides stored in EditorPrefs.

1. Open **Crystalline Rift Studio → Server & Keys**.
2. On the **Local** card (`http://localhost:8080`), press **Use for game** so Play mode talks to your local `CR.REST.AIO` (EditorPrefs `CR_Studio_EnvironmentId`), and **Use for editor** so Studio pushes go there too.
3. Optional: set the **World mode** override to `Open` to play the open world. The shipping default is Legacy.

The cards, the key fields and **Reset to shipping defaults** are described in [Content Registry](?page=unity/08-content-registry) under *Server & Keys section* and *Game settings*. Database files need no setup: they go under `Application.persistentDataPath` (on macOS `~/Library/Application Support/DefaultCompany/My project/`).

### Step 6 — Start the backend

```bash
cd cr-api/Convenience/CR.REST.AIO
dotnet run
```

Verify the server is healthy at `http://localhost:8080/swagger`. All registered endpoints should appear. The AIO server runs all domain migrations on startup — check the console for any migration errors before hitting Play in Unity.

### Step 7 — Hit Play

Open the main scene (typically `Assets/Scenes/Game.unity`) and press **Play**. On first play:
1. `LocalDevGameInstaller.InstallBindings()` runs synchronously. `GameDataAdopter` adopts the baked `game-data.bytes` content artifact into `persistentDataPath`, and `DatabaseMigrations.RunMigrations()` runs the unified migrator against `player-data` plus the online-cache databases (see [Content Pipeline](?page=unity/17-content-pipeline)). `GameDataAdopter` re-adopts when **either** the bundled schema version (`game-data_schema_version.txt`, = `MAX(VersionInfo)`) exceeds the adopted copy's, **or** a SHA-256 of the bundled `game-data.bytes` differs from a `.srchash` marker written next to the adopted copy. The content-hash gate fixes the "offline content keeps vanishing" bug: a content-only re-bake at the same migration head used to leave the version unchanged and silently never re-adopt; now any byte difference triggers re-adoption.
2. `GameSessionManager` reads any cached session from SQLite.
3. If no session exists, the login/auth flow starts.
4. Once a trainer is selected, `GameInitializer` fires `RunAsync` and all `IWorldInitializable` behaviours in the scene initialize.

Watch the Unity Console for `[GameInitializer] === World init complete ===` to confirm the bootstrap succeeded.

## Configuration (`GameSettings.asset`)

`IGameConfiguration` is implemented by `SettingsGameConfiguration`, built in `LocalDevGameInstaller` from `GameSettingsResolver.Resolve(shipping defaults, overrides, isPlayerBuild)`. Player builds ignore overrides. The keys it answers:

| Key | Answer |
|-----|--------|
| every `*_server_http_address` (`npc_`, `auth_`, `trainer_`, `creature_`, `quest_`, `stat_`, `game_`, ...) | The selected environment's API base URL (your override, else `defaultEnvironmentId`) |
| `discord_server_http_address` | `discordApiBaseUrl` (Discord's API; never follows the environment) |
| `database_path_game_data` | `gameDataFileName` — the **game-data** offline SQLite file (authored content; read-only) |
| `database_path_player_data` | `playerDataFileName` — the **player-data** offline SQLite file (per-trainer saves; mutable) |
| `starter_creature_level` | `offlineStarterCreatureLevel` |
| `world_mode` | `legacy` / `open` (your override, else `defaultWorldMode`) |

Any other key is not found (`TryGet` returns false), and the reader's own fallback applies.

`GameConfigurationKeys` (static class in `CR.Core.Data.Repository`) holds string constants for all keys. Always use these constants instead of string literals:

```csharp
// Correct — compile-time safe
configuration.TryGet(GameConfigurationKeys.NpcServerHttpAddress, out var url);

// Wrong — silently fails on a typo
configuration.TryGet("npc_server_http_adress", out var url);
```

## Adding a Creature or an NPC

Neither touches configuration. A creature is a `CreatureDefinition` and an NPC an `NpcDefinition` under `Assets/CR/Content/Defs/`, pushed to the server from Crystalline Rift Studio (see [Content Registry](?page=unity/08-content-registry)); the backend migrations seed the floor. An NPC placed in a scene names its `content_key` in `NpcWorldBehaviour._npcContentKey`, and the server creates the per-trainer row through the NPC ensure call on first play. What an NPC gives or fields in battle is authored on the server (gift template, `{key}-team` spawner templates, battle-item loadout), not in the scene. Localization strings follow [Localization](?page=unity/06-localization).

## Running the Backend

```bash
cd cr-api/Convenience/CR.REST.AIO
dotnet run
```

Default port: `http://localhost:8080` (check `launchSettings.json` if it differs on your machine). The **Local** environment in `BackendEnvironments.asset` points at that address; if your server runs elsewhere, edit the environment (Server & Keys → Advanced → *Edit environments…*) and press **Use for game** on it.

Check Swagger UI at `http://localhost:8080/swagger` to verify all endpoints are registered and the server is healthy before hitting Play in Unity.

## SQLite Database Files

Unity creates the SQLite files under `Application.persistentDataPath`. `DatabaseConnectionStringFactory` creates the directory if it does not exist, so no manual setup is required.

Database files use the `.bytes` extension (not `.db`) so Unity's asset pipeline does not try to import them as binary assets. SQLite itself does not care about the extension.

The offline store is two databases: `game-data.bytes` (global authored content, read-only) and `player-data.bytes` (per-trainer saves, mutable). See [Content Pipeline](?page=unity/17-content-pipeline) for how each is built and updated.

If you need to reset all local state (e.g., after a breaking schema migration):
1. Stop the Unity Player.
2. Delete the `.bytes` files from `Application.persistentDataPath`. To reset only saves while keeping content, delete `player-data.bytes` and leave `game-data.bytes`.
3. Hit Play — migrations recreate them fresh.

The database files should be listed in `.gitignore` and never committed. They are local developer state.

## content_key

Every piece of content — creatures, NPCs, quest templates, items — has a `content_key` string, set on its definition ScriptableObject and stored in the backend's `content_key` column. When a level designer places an NPC and sets `_npcContentKey` in the Inspector, they use that key.

This separation means:
- Designers work in definition assets, Crystalline Rift Studio and the Unity Inspector
- Backend engineers manage the database seed data
- The `content_key` string is the contract between the two worlds — readable, version-controllable, and human-friendly

See [Introduction](?page=00-introduction) for more on the `content_key` vs UUID design philosophy.

## Common Mistakes / Tips

- **All four plugins must be present before opening the project.** Missing a plugin causes a cascade of compile errors that can be misleading. Import Zenject and Best HTTP from the Asset Store before opening the project for the first time.
- **Play mode talks to production when you expected Local.** The shipping default is `production`; Play mode uses Local only after **Use for game** on the Local card. The first line of Server & Keys says where Editor, Game and Content point.
- **Stale SQLite files after schema migration.** If a migration adds a non-nullable column with no default, and the old `.bytes` file has rows missing that column, queries will fail at runtime. Delete and recreate the database files after breaking schema changes.
- **Editor vs Build database paths.** `Application.persistentDataPath` differs between Editor and standalone builds, so the Editor and a build on the same machine never share a database.
- **Multiple Unity instances with the same database file.** Two Unity instances sharing the same `.bytes` file will cause SQLite lock contention. There is no per-instance configuration override any more; run the second instance from a separate project clone (a different `persistentDataPath`).
- **Wrong port.** The AIO server uses port 8080 by default (check `launchSettings.json`). If requests time out immediately, check the Local environment's API URL in Server & Keys.
- **`GameConfigurationKeys` key not found logs no error at startup.** `TryGet` returns false silently. If an HTTP client's base URL resolves to null, you will see `Invalid HttpClient configuration` in the log at startup — search for this string to identify the misconfigured key.
- **The file names resolve against `Application.persistentDataPath`.** `gameDataFileName` / `playerDataFileName` are relative, so `playerData.bytes` becomes `{persistentDataPath}/playerData.bytes`. In the Editor `persistentDataPath` includes Unity's company and project name.
- **`.bytes` extension required.** SQLite files must use `.bytes` to avoid Unity's asset importer attempting to process them. The `DatabaseConnectionStringFactory.GetConnectionString` method appends `.bytes` automatically when using the database name overload, but `GetConnectionString(DataSource)` uses the configured file name as-is.

## The CR menu

The menu holds what you reach for while working. Five entries sit at the top:
**Crystalline Rift Studio**, **Trainer Battle Author**, **Localization Editor**, **Database Manager**,
**Content Audit**. Everything else is grouped by subject:

- **Build/** — Build Players…, Deploy to Steam Deck…, Bake Floor From Server, Create Standalone Build Profiles
- **Content/** — Rebake Offline Floor, Full Package Rebuild, Bake Game-Data DB, Export Ability FX Seed Migration
- **Areas/** — Validate Open Area Scene, Link Areas (doors), Dress Playtest Areas, Dress Battle Arenas, Polish Areas, Split Encounter Zones, Fix Walk-Through Props
- **Battle/** — Create Battle Arena, Camera Director Simulator, Build Camera Rig Prefab, battle controllers, Map Reaction Profiles (dry run / apply), Audit Creature Reaction Coverage
- **Wiring/**, **Components/**, **Ability Workbench/** — unchanged

### What was removed, and where it went

Three entries were duplicates. The windows are unchanged and open from
**Crystalline Rift Studio → Pipeline ▾**: *Publish to Server* (was `CR/Publish Content`), *Build & Deploy
(S3/MinIO)* (was `CR/Deploy Content`), and *Pipeline Status* (was `CR/CR Studio`) — the drift
dashboard, which reports on exactly the content Crystalline Rift Studio edits.

Fourteen more were one-shot scaffolding or repairs — things run once when a system is first set
up, or after a specific breakage. **The code is untouched; only the menu entry is gone**, and
each still runs headlessly, which is how they are usually driven anyway:

| Command | Run it with |
|---|---|
| Build Core Scene + Area Template | `unity run --command cr_build_area_template` |
| Build Playtest Areas | `unity run --command cr_build_playtest_areas` |
| Lay Out Village | `unity run --command cr_layout_village` |
| Swap Player Model In Core Scene | `unity run --command cr_swap_player_in_scene` |
| Build BoZo Player Prefab | `unity run --command cr_build_player_model` |
| Set Up Master Audio | `unity run --command cr_setup_audio` |
| Create Music Playlists | `unity run --command cr_create_music_playlists` |
| Wire Area Audio | `unity run --command cr_wire_area_audio` |
| Restore Asset Store Packages | `unity run --command cr_assets_restore` |
| Author Demo Trainer (Meadow Scout) | `unity run --command cr_author_demo_trainer` |
| Fix LOD / Prop / Trunk Colliders | `cr_fix_lod_colliders`, `cr_fix_prop_colliders`, `cr_fix_trunk_colliders` |
| Wire Pickup Visual | `unity run --command cr_wire_pickup_visual` |

The first four **replace a scene from a template and discard what is in it**. They used to sit in
`CR/Areas/`, one slot away from the validators used daily; a headless command you have to type is
a far better fit for something that destructive.

## Related Pages

- [Content Pipeline (Two-Database Model)](?page=unity/17-content-pipeline) — game-data vs player-data, baked `game-data.bytes` artifact, cold-start adopt
- [Dependency Injection](?page=unity/02-dependency-injection) — `LocalDevGameInstaller`, migration runner, binding order
- [Content Registry](?page=unity/08-content-registry) — Game settings, Server & Keys, environment and world-mode overrides
- [HTTP Clients](?page=unity/05-http-clients) — how the `*_server_http_address` keys configure HTTP clients
- [Localization](?page=unity/06-localization) — localization files and the Language setting
- [Auth and Accounts](?page=backend/06-auth-and-accounts) — auth clients and token management
- [Backend Architecture](?page=backend/01-architecture) — how the server-side mirrors this structure
