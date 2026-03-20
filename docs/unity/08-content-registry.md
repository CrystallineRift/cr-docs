# Content Registry

The **content registry** is the client-side catalog of every designer-authored game entity. It maps a content key (e.g. `"cindris"`, `"starter-wild-zone"`) to its human-readable metadata — display name, element type, sprite key, and so on — without requiring a database query or network call.

The registry bridges two concerns:

- The **backend** knows entities by UUID (`creature.id`) and content key (`creature.content_key`).
- **Level designers** author scene content using the content key string (Inspector fields on `NpcTrainerBehaviour`, `SpawnerWorldBehaviour`, etc.).
- **Runtime systems** (UI, battle, inventory) need typed, structured information about each entity — not just a raw key.

## System Files

| File | Location |
|------|----------|
| `IGameContentRegistry` | `CR/Core/Data/Registry/IGameContentRegistry.cs` |
| `GameContentRegistry` | `CR/Core/Data/Registry/GameContentRegistry.cs` |
| `ContentKeys` | `CR/Core/Data/Registry/ContentKeys.cs` |
| `CreatureContentDef` | `CR/Core/Data/Registry/CreatureContentDef.cs` |
| `NpcContentDef` | `CR/Core/Data/Registry/NpcContentDef.cs` |
| `SpawnerContentDef` | `CR/Core/Data/Registry/SpawnerContentDef.cs` |
| `content_registry.yaml` | `CR/Resources/configuration/content_registry.yaml` |

## `IGameContentRegistry`

```csharp
public interface IGameContentRegistry
{
    IReadOnlyList<string> CreatureKeys { get; }
    IReadOnlyList<string> NpcKeys      { get; }
    IReadOnlyList<string> SpawnerKeys  { get; }

    bool TryGetCreature(string contentKey, out CreatureContentDef? def);
    bool TryGetNpc     (string contentKey, out NpcContentDef?      def);
    bool TryGetSpawner (string contentKey, out SpawnerContentDef?  def);
}
```

Bound as a singleton. Inject `IGameContentRegistry` — never the concrete `GameContentRegistry` class.

## `ContentKeys` — Compile-Time Constants

Use the constants in `ContentKeys` rather than bare string literals everywhere:

```csharp
// Instead of:
registry.TryGetCreature("cindris", out var def);

// Write:
registry.TryGetCreature(ContentKeys.Creatures.Cindris, out var def);
```

| Constant | Value | Description |
|----------|-------|-------------|
| `ContentKeys.Creatures.Cindris` | `"cindris"` | Fire-type playable creature |
| `ContentKeys.Creatures.Starter1` | `"starter_1"` | Radiant starter option |
| `ContentKeys.Creatures.Starter2` | `"starter_2"` | Fire starter option |
| `ContentKeys.Creatures.Starter3` | `"starter_3"` | Flora starter option |
| `ContentKeys.Spawners.StarterWildZone` | `"starter-wild-zone"` | Default wild encounter zone |

Add entries to `ContentKeys` whenever a new creature, NPC, or spawner is created.

## `content_registry.yaml`

The YAML file lives in `Resources/configuration/content_registry.yaml` and is loaded at startup by `GameContentRegistry` using YamlDotNet. Keys use `underscore_case` which YamlDotNet maps to PascalCase properties automatically.

```yaml
creatures:
  cindris:
    display_name: Cindris
    element: Fire
    asset_key: creatures/cindris      # matches game_assets.key in the DB

  starter_1:
    display_name: Starter 1
    element: Radiant
    asset_key: creatures/starter_1

spawners:
  starter-wild-zone:
    display_name: Starter Wild Zone

npcs:
  # starter-npc:
  #   display_name: Professor Oak
  #   npc_type: Npc
```

## Definition Types

### `CreatureContentDef`

| Property | YAML Key | Description |
|----------|----------|-------------|
| `DisplayName` | `display_name` | Human-readable name for UI |
| `Element` | `element` | Elemental type string (`"Fire"`, `"Radiant"`, `"Flora"`) |
| `AssetKey` | `asset_key` | `game_assets.key` value — the Addressables address or Resources path for the creature's primary art asset |

### `NpcContentDef`

| Property | YAML Key | Description |
|----------|----------|-------------|
| `DisplayName` | `display_name` | Name shown in dialog |
| `NpcType` | `npc_type` | `"Npc"` or `"Trainer"` (defaults to `"Npc"`) |

### `SpawnerContentDef`

| Property | YAML Key | Description |
|----------|----------|-------------|
| `DisplayName` | `display_name` | Zone label |

## DI Wiring

```csharp
// LocalDevGameInstaller.cs
Container.Bind<IGameContentRegistry>().To<GameContentRegistry>().AsSingle();
```

`GameContentRegistry` injects `ICRLogger` and loads the YAML file in its constructor. Because it is bound `AsSingle`, the file is parsed once at startup and all lookups are in-memory dictionary reads.

## Usage Examples

### Look up a creature and load its art via the asset system

`AssetKey` on `CreatureContentDef` is the `game_assets.key` value — the same string stored in the `game_assets` database table and used by `IGameAssetLoader`. Use `LoadAssetByKeyAsync<T>` to go from content registry → loaded Unity asset in one step, without managing UUIDs:

```csharp
[Inject] private IGameContentRegistry _registry;
[Inject] private IGameAssetLoader      _assetLoader;

async void ShowOpponentCreature(string contentKey)
{
    if (!_registry.TryGetCreature(contentKey, out var def)) return;

    nameLabel.text    = def.DisplayName;    // "Cindris"
    elementLabel.text = def.Element;        // "Fire"

    // AssetKey = game_assets.key (e.g. "creatures/cindris")
    // Loader resolves it to a UUID, then loads via Addressables or Resources.
    var sprite = await _assetLoader.LoadAssetByKeyAsync<Sprite>(def.AssetKey);
    if (sprite != null) spriteRenderer.sprite = sprite;
}
```

`IGameAssetLoader.LoadAssetByKeyAsync<T>` calls `IAssetDomainService.GetByKeyAsync` internally to resolve the key to a `GameAsset` UUID, then delegates to the normal `LoadAssetAsync<T>(Guid)` path (Addressables or Resources depending on `game_assets.loader_source`).

### Validate a content key at startup

```csharp
private void Start()
{
    if (!_registry.TryGetCreature(_contentKey, out _))
        Debug.LogWarning($"[{name}] Content key '{_contentKey}' not found in registry.");
}
```

### Enumerate all creatures for a selection screen

```csharp
foreach (var key in _registry.CreatureKeys)
{
    if (_registry.TryGetCreature(key, out var def))
        AddCreatureCard(key, def.DisplayName, def.Element);
}
```

## Adding a New Entity

1. **Add the entry to `content_registry.yaml`:**

   ```yaml
   creatures:
     emberox:
       display_name: Emberox
       element: Fire
       asset_key: creatures/emberox   # must match game_assets.key in the DB
   ```

2. **Add the constant to `ContentKeys`:**

   ```csharp
   public static class Creatures
   {
       public const string Emberox = "emberox";
       // ...
   }
   ```

3. **Seed the backend** — add the `content_key` value to the creature migration seed data and ensure `M1015EnforceContentKeyNotNullAndUnique` has run.

4. **Use the constant** wherever you reference the key in code.

## Relationship to `game_config.yaml` and `GameConfigurationKeys`

`game_config.yaml` is a flat `string → string` map for configuration values (server addresses, database paths, etc.). It is **not** the place for structured content definitions.

The wild encounter creature is now referenced by content key instead of UUID:

```yaml
# game_config.yaml
wild_encounter_creature_content_key: cindris
```

```csharp
// Read via:
_gameConfig.TryGet(GameConfigurationKeys.WildEncounterCreatureContentKey, out var key);
// Then look up:
_registry.TryGetCreature(key, out var def);
```

## Relationship to the Backend `content_key` Column

Every entity that appears in the registry must have a matching `content_key` value in the backend database. The constraint is enforced by migrations:

- `M1015EnforceContentKeyNotNullAndUnique` — creature table
- `M2006EnforceContentKeyNotNullOnNpcs` — npcs table
- `M5012EnforceContentKeyNotNullOnSpawner` — spawner table

If a content key in the registry has no matching row in the DB, `EnsureNpcAsync` / `EnsureSpawnerForTrainerByKeyAsync` will fail at world bootstrap. If a DB row exists with no matching registry entry, runtime systems will fall back gracefully (empty `TryGet`) but will not crash.

## Gotchas

**Registry is empty at startup.** If `content_registry.yaml` is missing or the `Resources/` path is wrong, `GameContentRegistry` logs a warning and all `TryGet*` calls return false. Check `Assets/CR/Resources/configuration/content_registry.yaml` exists and the asset is in a `Resources` folder.

**YAML parsing is case-sensitive for keys.** `"Cindris"` and `"cindris"` are different keys. Always use lowercase with underscores for creature keys and lowercase with hyphens for spawners — matching the backend convention.

**Adding a field to a def POCO.** YamlDotNet ignores unknown keys, so new fields are backward compatible. But adding a required field without updating the YAML will leave it as the default empty string — validate in `Start()` if the field is load-bearing.

## Related Pages

- [Dependency Injection](?page=unity/02-dependency-injection) — how singletons like `IGameContentRegistry` are registered
- [World Behaviours](?page=unity/03-world-behaviours) — `NpcWorldBehaviour` and `SpawnerWorldBehaviour` use content keys at bootstrap
- [NPC Interaction](?page=unity/04-npc-interaction) — content keys appear in `NpcTrainerBehaviour` Inspector fields
- [Battle System](?page=unity/07-battle-system) — content keys identify creatures involved in a battle
- [Battle Persistence](?page=backend/09-battle-persistence) — backend battle tables reference creatures by content key
