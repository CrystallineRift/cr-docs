# Unity Project Setup

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

## Required Unity Packages / Plugins

| Package | Version | Source |
|---------|---------|--------|
| Zenject | 9.x | Asset Store / UPM |
| Best HTTP | 3.x | Asset Store |
| Newtonsoft.Json for Unity | 13.x | UPM (`com.unity.nuget.newtonsoft-json`) |
| Anti-Cheat Toolkit | latest | Asset Store (for `ObscuredPrefs`) |

## Opening the Project

1. Clone `cr-data` alongside `cr-api`:
   ```bash
   git clone https://github.com/CrystallineRift/cr-data.git
   ```
2. Open **Unity Hub → Add → `cr-data/My project`**
3. Wait for package import
4. Open the main scene (typically `Assets/Scenes/Game.unity`)
5. Hit **Play** — `LocalDevGameInstaller` runs migrations and boots services

## Configuration (`game_config.yaml`)

The `IGameConfiguration` reads from a YAML file at runtime. Key configuration keys:

| Key | Purpose |
|-----|---------|
| `npc_server_http_address` | Base URL for the NPC REST service |
| `auth_server_http_address` | Base URL for auth endpoints |
| `database_path_trainer` | SQLite path for trainer database |
| `database_path_spawner` | SQLite path for spawner database |
| `database_path_creature` | SQLite path for creature database |

`GameConfigurationKeys` (static class) holds all key constants to avoid magic strings.

## Running the Backend

```bash
cd cr-api/Convenience/CR.REST.AIO
dotnet run
```

Default port: `http://localhost:5000`. Set `npc_server_http_address` in `game_config.yaml` to match.
