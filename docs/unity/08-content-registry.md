# Content Registry

The **content registry** is the client-side catalog of every designer-authored game entity. It maps a content key (e.g. `"cindris"`, `"starter-wild-zone"`) to its human-readable metadata — display name key, element type, asset key, and so on — without requiring a database query or network call.

The registry bridges two concerns:

- The **backend** knows entities by UUID (`creature.id`) and content key (`creature.content_key`).
- **Level designers** author scene content using the content key string (Inspector fields on `NpcTrainerBehaviour`, `SpawnerWorldBehaviour`, etc.).
- **Runtime systems** (UI, battle, inventory) need typed, structured information about each entity — not just a raw key.

## System Files

| File | Location |
|------|----------|
| `IGameContentRegistry` | `CR/Core/Data/Registry/IGameContentRegistry.cs` |
| `ScriptableObjectContentRegistry` | `CR/Core/Data/Registry/ScriptableObjectContentRegistry.cs` |
| `ServerContentRegistry` | `CR/Core/Data/Registry/ServerContentRegistry.cs` |
| `MutableContentRegistry` | `CR/Core/Data/Registry/MutableContentRegistry.cs` |
| `ContentRegistryInitializer` | `CR/Core/Data/Registry/ContentRegistryInitializer.cs` |
| `OnlineOfflineContentRegistry` | `CR/Core/Data/Registry/OnlineOfflineContentRegistry.cs` |
| `ContentRegistryBootstrapper` | `CR/Core/Data/Registry/ContentRegistryBootstrapper.cs` |
| `AddressablesCatalogUpdater` | `CR/Core/Data/Registry/AddressablesCatalogUpdater.cs` |
| `ContentDefinitionProvider` | `CR/Core/Data/Registry/ContentDefinitionProvider.cs` |
| `ContentKeys` | `CR/Core/Data/Registry/ContentKeys.cs` |
| `CreatureContentDef` | `CR/Core/Data/Registry/CreatureContentDef.cs` |
| `ItemContentDef` | `CR/Core/Data/Registry/ItemContentDef.cs` |
| `NpcContentDef` | `CR/Core/Data/Registry/NpcContentDef.cs` |
| `SpawnerContentDef` | `CR/Core/Data/Registry/SpawnerContentDef.cs` |
| `CreatureDefinition` | `CR/Core/Data/Registry/Definitions/CreatureDefinition.cs` |
| `ItemDefinition` | `CR/Core/Data/Registry/Definitions/ItemDefinition.cs` |
| `NpcDefinition` | `CR/Core/Data/Registry/Definitions/NpcDefinition.cs` |
| `SpawnerDefinition` | `CR/Core/Data/Registry/Definitions/SpawnerDefinition.cs` |
| `SpawnerZoneConfig` | `CR/Core/Data/Registry/Definitions/SpawnerZoneConfig.cs` |
| `AbilityConfig` | `CR/Core/Data/Registry/Definitions/AbilityConfig.cs` |
| `AbilityProgressionSetConfig` | `CR/Core/Data/Registry/Definitions/AbilityProgressionSetConfig.cs` |
| `GrowthProfileConfig` | `CR/Core/Data/Registry/Definitions/GrowthProfileConfig.cs` |
| `IContentManifestRepository` | `CR/Core/Data/Repository/Implementation/Config/IContentManifestRepository.cs` |
| `ContentManifestClientUnityHttp` | `CR/Core/Data/Repository/Implementation/Config/ContentManifestClientUnityHttp.cs` |
| `ContentManifestResponse` | `CR/Core/Data/Repository/Implementation/Config/ContentManifestResponse.cs` |
| `ContentStudioTool` *(Editor only)* | `CR/Core/Data/Editor/ContentStudioTool.cs` |
| `DefinitionEditorExtensions` *(Editor only)* | `CR/Core/Data/Editor/DefinitionEditorExtensions.cs` |
| `CreatureDefinitionEditor` *(Editor only)* | `CR/Core/Data/Editor/CreatureDefinitionEditor.cs` |
| `ItemDefinitionEditor` *(Editor only)* | `CR/Core/Data/Editor/ItemDefinitionEditor.cs` |
| `NpcDefinitionEditor` *(Editor only)* | `CR/Core/Data/Editor/NpcDefinitionEditor.cs` |
| `SpawnerDefinitionEditor` *(Editor only)* | `CR/Core/Data/Editor/SpawnerDefinitionEditor.cs` |
| `ContentDefinitionProviderEditor` *(Editor only)* | `CR/Core/Data/Editor/ContentDefinitionProviderEditor.cs` |
| `LocalizationEditorCache` *(Editor only)* | `CR/Core/Data/Editor/LocalizationEditorCache.cs` |
| `LocalizationKeyField` *(Editor only)* | `CR/Core/Data/Editor/LocalizationKeyField.cs` |
| `LocalizationEditorWindow` *(Editor only)* | `CR/Core/Data/Editor/LocalizationEditorWindow.cs` |
| `ContentAuditTool` *(Editor only)* | `CR/Core/Data/Editor/ContentAuditTool.cs` |
| `ContentPublishTool` *(Editor only)* | `CR/Core/Data/Editor/ContentPublishTool.cs` |
| `AbilityConfigEditor` *(Editor only)* | `CR/Core/Data/Editor/AbilityConfigEditor.cs` |
| `AbilityProgressionSetConfigEditor` *(Editor only)* | `CR/Core/Data/Editor/AbilityProgressionSetConfigEditor.cs` |
| `GrowthProfileConfigEditor` *(Editor only)* | `CR/Core/Data/Editor/GrowthProfileConfigEditor.cs` |
| `AbilityEditorSyncHelper` *(Editor only)* | `CR/Game/World/Editor/AbilityEditorSyncHelper.cs` |
| `ContentCreatorSyncHelper` *(Editor only)* | `CR/Game/World/Editor/ContentCreatorSyncHelper.cs` |

## `IGameContentRegistry`

```csharp
public interface IGameContentRegistry
{
    IReadOnlyList<string> CreatureKeys { get; }
    IReadOnlyList<string> ItemKeys     { get; }
    IReadOnlyList<string> NpcKeys      { get; }
    IReadOnlyList<string> SpawnerKeys  { get; }

    bool TryGetCreature(string contentKey, out CreatureContentDef? def);
    bool TryGetItem    (string contentKey, out ItemContentDef?     def);
    bool TryGetNpc     (string contentKey, out NpcContentDef?      def);
    bool TryGetSpawner (string contentKey, out SpawnerContentDef?  def);
}
```

Bound as a singleton via `MutableContentRegistry`. Inject `IGameContentRegistry` — never the concrete class.

## Localization in the Editor

Localization keys on definition assets are validated live against the YAML files in `Assets/CR/Resources/configuration/localization/`. Two editor-only classes provide this:

### `LocalizationEditorCache`

Loads all `*.yaml` files from the localization directory at domain-reload time (`[InitializeOnLoad]`) and caches every `key: value` pair in memory. Public API:

| Method | Description |
|--------|-------------|
| `HasKey(key)` | True if the key exists in any loaded YAML file |
| `GetValue(key)` | Returns the English value string, or null |
| `SuggestKey(contentType, contentKey)` | Derives the conventional key: `creature_cindris_name` from `("creature", "cindris")` |
| `AddEntry(contentType, key, value)` | Appends `key: value` to `{contentType}s.yaml`; calls `AssetDatabase.Refresh()`. Returns `false` and logs an error if the file cannot be written. |
| `UpdateEntry(key, value)` | Overwrites the value for an existing key using an atomic write (write to `.tmp` then `File.Move`). If the backing YAML file has been deleted externally, calls `Reload()` and retries once; returns `false` if the file is still missing. Returns `false` and logs on any I/O error. |
| `AddOrUpdateEntry(contentType, key, value)` | Convenience method: calls `UpdateEntry` if the key already exists, otherwise calls `AddEntry`. Used by `ContentCreatorSyncHelper` when pulling creature/NPC definitions from the server, to auto-create or refresh the display-name localization entry. |
| `RemoveEntry(key)` | Removes a key from its YAML file using an atomic write. Same staleness and error handling as `UpdateEntry`. |
| `Reload()` | Re-reads all files from disk |

**Reliability guarantees:**
- All write operations (`AddEntry`, `UpdateEntry`, `RemoveEntry`) are wrapped in `try/catch`. On any I/O exception the method returns `false` and logs `Debug.LogError(...)` — the editor does not crash and the YAML file is left in its previous state.
- `UpdateEntry` and `RemoveEntry` use atomic writes: content is first written to `{filePath}.tmp`, then `File.Move` replaces the live file. A crash mid-write leaves the `.tmp` file behind but never corrupts the live YAML.
- If a YAML file is deleted externally while entries are cached, the first write attempt detects the missing file via `File.Exists`, calls `Reload()`, and retries. If still missing after reload, the method returns `false`.

Key convention matches the existing YAML files:

| Content type | YAML file | Key pattern |
|---|---|---|
| Creature | `creatures.yaml` | `creature_{content_key}_name` |
| Item | `items.yaml` | `item_{content_key}_name` |
| NPC | `npcs.yaml` | `npc_{content_key}_name` |
| Spawner | `spawners.yaml` | `spawner_{content_key}_name` |

### `LocalizationKeyField`

A static drawing utility used by all definition Inspectors and the Content Studio. Replace bare `TextField` calls for localization keys with `LocalizationKeyField.Draw(...)`.

All `GUIStyle` objects are cached as `private static` fields (badge valid/invalid, resolved value preview, missing preview) with lazy init — no style allocations occur during `Draw()` after the first call.

The internal `fieldId` key used to track per-field inline-add-panel state is `$"{contentType}_{keyPart}_{label}"` where `keyPart` is the `contentKey` when non-empty, or a unique `GUIUtility.GetControlID` value when `contentKey` is null or whitespace. This prevents two Inspectors of the same content type from sharing add-panel state, even when both assets have an empty content key field.

```csharp
_fDisplayNameKey = LocalizationKeyField.Draw(
    "Display Name Key", _fDisplayNameKey, "creature", _fContentKey);
```

Each field renders:

```
Display Name Key  [creature_cindris_name     ] ✓  [Suggest]
                  → "Cindris"                           ← resolved value preview
```

Or when the key is missing:

```
Display Name Key  [creature_emberox_name     ] ✗  [Suggest] [+YAML]
  ┌────────────────────────────────────────┐
  │ Add "creature_emberox_name" to         │
  │ creatures.yaml                         │
  │ English value: [Emberox              ] │
  │ [Add Entry]  [Cancel]                  │
  └────────────────────────────────────────┘
```

### Auto-suggest in Content Studio

When you type a content key in the `+ New` panel (tabs 0–3) and the Display Name Key field is empty, it auto-fills the suggested key. Example: typing `"cindris"` in the Creatures tab immediately fills `"creature_cindris_name"`.

If that key doesn't exist in the YAML yet, the `[+YAML]` button appears. Clicking it shows an inline panel where you type the English display value and click **Add Entry** — the key is appended to the appropriate YAML file and `AssetDatabase.Refresh()` is called automatically.

## ScriptableObject Workflow

The registry is now driven entirely by Unity ScriptableObjects instead of a YAML file. This means content is defined in the Unity Editor, benefits from asset references, type safety, and the standard `Assets > Create` menu.

### Definition ScriptableObjects

Each entity type has a dedicated ScriptableObject that designers create via the `Assets > Create > CR > Content` menu:

| Menu Item | Type | Purpose |
|-----------|------|---------|
| `Assets > Create > CR > Content > Creature Definition` | `CreatureDefinition` | One SO per creature species |
| `Assets > Create > CR > Content > Item Definition` | `ItemDefinition` | One SO per item type |
| `Assets > Create > CR > Content > NPC Definition` | `NpcDefinition` | One SO per NPC |
| `Assets > Create > CR > Content > Spawner Definition` | `SpawnerDefinition` | One SO per spawner zone |
| `Assets > Create > CR > Content > Spawner Zone Config` | `SpawnerZoneConfig` | Full zone config for spawner sync |
| `Assets > Create > CR > Content > Ability Config` | `AbilityConfig` | One SO per ability (auto-generates stable GUID) |
| `Assets > Create > CR > Content > Ability Progression Set Config` | `AbilityProgressionSetConfig` | Ordered list of (level, ability, slot) entries |
| `Assets > Create > CR > Content > Growth Profile Config` | `GrowthProfileConfig` | Stat and XP growth multipliers per creature species |

Each definition asset holds the `content_key`, `DisplayNameKey` (localization key), element type, asset key, and other metadata for that entity.

### `ContentDefinitionProvider`

`ContentDefinitionProvider` is a top-level ScriptableObject that holds arrays of every definition asset:

```
ContentDefinitionProvider SO
  ├── CreatureDefinition[]   (all creature definition assets)
  ├── ItemDefinition[]       (all item definition assets)
  ├── NpcDefinition[]        (all NPC definition assets)
  └── SpawnerDefinition[]    (all spawner definition assets)
```

The provider asset is assigned to the `_contentDefinitions` field on `LocalDevGameInstaller` in the Inspector. `ScriptableObjectContentRegistry` reads from the provider and builds in-memory dictionaries keyed by `content_key` at startup.

### `ScriptableObjectContentRegistry`

`ScriptableObjectContentRegistry` implements `IGameContentRegistry` by reading from a `ContentDefinitionProvider`. All `TryGet*` calls are in-memory dictionary lookups after the single build pass at construction time. There is no YAML parsing, no `Resources.Load`, and no file I/O at runtime.

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

## Definition Types

### `CreatureContentDef`

| Property | Description |
|----------|-------------|
| `DisplayNameKey` | **Localization key** (not a display string) — resolve via `ILocalizationRepository.TryGetText(language, def.DisplayNameKey, out name)` |
| `Element` | Elemental type string (`"Fire"`, `"Radiant"`, `"Flora"`) |
| `AssetKey` | `game_assets.key` value — the Addressables address or Resources path for the creature's primary art asset |

> **Important:** `DisplayNameKey` is a localization key, not a resolved string. Do not display it directly in UI. Always resolve it through `ILocalizationRepository` first.

### `ItemContentDef`

| Property | Description |
|----------|-------------|
| `DisplayName` | Display name or localization key for this item type |
| `AssetKey` | Addressables address or Resources path for the item's primary asset (nullable) |

`ItemContentDef` uses constructor injection (`new ItemContentDef(displayName, assetKey)`) rather than object initializer syntax. `AssetKey` is nullable — items without art have a null key.

### `NpcContentDef`

| Property | Description |
|----------|-------------|
| `DisplayNameKey` | Localization key for the NPC's name — resolve via `ILocalizationRepository` |
| `NpcType` | `"Npc"`, `"Trainer"`, `"Merchant"`, or `"QuestGiver"` (defaults to `"Npc"`) |

### `SpawnerContentDef`

| Property | Description |
|----------|-------------|
| `DisplayNameKey` | Localization key for the zone label |

### `CreatureDefinition` Inspector Fields

`CreatureDefinition` ScriptableObjects hold the full set of species data synced from the backend:

| Field | Type | Description |
|-------|------|-------------|
| `contentKey` | string | Must match `content_key` in the backend `creature` table |
| `displayNameKey` | string | Localization key (e.g. `"creature_cindris_display"`) — resolved at runtime via `ILocalizationRepository` |
| `element` | string | Elemental type string matching the backend `ElementType` enum (e.g. `"Fire"`, `"Radiant"`) |
| `assetKey` | string | Addressables address or Resources path for the creature's primary asset |
| `name` | string | Display name string (synced from server; mirrors backend `name` column) |
| `description` | string | Lore description (synced from server) |
| `baseHitPoints` | int | Base HP stat |
| `baseAttack` | int | Base Attack stat |
| `baseSpecialAttack` | int | Base Special Attack stat |
| `baseDefense` | int | Base Defense stat |
| `baseSpecialDefense` | int | Base Special Defense stat |
| `baseSpeed` | int | Base Speed stat |
| `abilityProgressionSetId` | string | Optional GUID referencing the `AbilityProgressionSet` that drives this creature's level-up moves. Empty = none. |

### `SpawnerDefinition` Inspector Fields

`SpawnerDefinition` ScriptableObjects store the full zone configuration synced from the backend:

| Field | Type | Description |
|-------|------|-------------|
| `contentKey` | string | Must match `content_key` in the backend spawner table |
| `battleArenaKey` | string | Optional. Must match `BattleArena.ArenaKey` of a scene arena object. Used by `SpawnerWorldBehaviour` to tell `BattleCoordinator` which arena to activate when a wild battle starts from this zone. Leave empty to skip arena teleportation. |
| `displayName` | string | Human-readable label (synced from server) |
| `description` | string | Description text (synced from server) |
| `maxCapacity` | int | Max creatures alive at once (default 5; synced from server) |
| `spawnCooldownSeconds` | int | Seconds between spawn cycles (default 300; synced from server) |

## Hot-Content System

The registry now supports **hot-content** — the ability to upgrade the local ScriptableObject registry with server-fetched definitions at runtime, without blocking startup.

### Architecture

```
LocalDevGameInstaller
  creates ScriptableObjectContentRegistry (SO fallback, immediate)
  wraps in MutableContentRegistry
  binds IGameContentRegistry → MutableContentRegistry
  binds IContentManifestRepository → ContentManifestClientUnityHttp
  binds ContentRegistryInitializer as IInitializable

ContentRegistryInitializer.Initialize()
  fires FetchAndUpgradeAsync() (non-blocking)
  on success: MutableContentRegistry.SetInner(new ServerContentRegistry(manifest))
  on failure: MutableContentRegistry keeps ScriptableObject data
```

### `MutableContentRegistry`

A thread-safe `IGameContentRegistry` wrapper backed by a `volatile IGameContentRegistry _inner`. All `TryGet*` and `*Keys` calls delegate to the inner registry. `SetInner(IGameContentRegistry)` swaps the inner reference atomically (via `volatile`) without locking.

Callers that resolve a definition before the manifest loads see SO data. Callers after the swap see server data. No consumer needs to be aware of the swap — they all inject `IGameContentRegistry`.

### `ServerContentRegistry`

Populated from a `ContentManifestResponse` (the JSON payload of `GET /api/v1/content/manifest`). Builds the same four dictionaries as `ScriptableObjectContentRegistry` using `ContentManifestResponse.creatures`, `.items`, `.npcs`, and `.spawners`.

NpcType int mapping: 0 = `"Merchant"`, 1 = `"Trainer"`, 2 = `"Npc"` (default), 3 = `"QuestGiver"`.

### `ContentRegistryInitializer`

Implements Zenject `IInitializable`. `Initialize()` fires `FetchAndUpgradeAsync()` without awaiting — Zenject's `Initialize()` is synchronous, so the async work runs concurrently with the rest of world bootstrap. Any exception during the fetch is caught and logged; the SO registry is kept.

### `ContentManifestClientUnityHttp`

Extends `SimpleWebClient` with `IContentManifestRepository`. Calls `GET /api/v1/content/manifest` using the `game_server_http_address` config key. Deserializes via Newtonsoft (already handled by `SimpleWebClient.Get<T>`). Returns null on any exception.

### `ContentRegistryBootstrapper` (utility)

A static `async Task<IGameContentRegistry> BuildAsync(manifestClient, fallbackProvider)` helper for contexts outside the Zenject DI flow (integration tests, editor tooling). Tries to fetch the manifest; returns a `ServerContentRegistry` on success or a `ScriptableObjectContentRegistry` on failure.

### `AddressablesCatalogUpdater` (conditional)

Only compiled when the `CR_ADDRESSABLES` scripting define is active. Wraps `Addressables.CheckForCatalogUpdates` and `Addressables.UpdateCatalogs`. Call `AddressablesCatalogUpdater.UpdateAsync()` early in the startup flow — before any Addressables asset loads — to ensure remote catalog updates are applied. Add the `CR_ADDRESSABLES` define in **Project Settings → Player → Scripting Define Symbols** when `com.unity.addressables` is present in `manifest.json`.

## DI Wiring

```csharp
// LocalDevGameInstaller.cs

// Manifest HTTP client
Container.Bind<IContentManifestRepository>()
    .To<ContentManifestClientUnityHttp>()
    .AsSingle();

// MutableContentRegistry starts with SO data; upgraded async by ContentRegistryInitializer
var soRegistry      = new ScriptableObjectContentRegistry(_contentDefinitions, logger);
var mutableRegistry = new MutableContentRegistry(soRegistry);
Container.Bind<MutableContentRegistry>().FromInstance(mutableRegistry).AsSingle();
Container.Bind<IGameContentRegistry>().FromInstance(mutableRegistry).AsSingle();

// Registers as IInitializable so Zenject calls Initialize() during startup
Container.BindInterfacesTo<ContentRegistryInitializer>().AsSingle();
```

The `ContentDefinitionProvider` asset reference is set in the `LocalDevGameInstaller` Inspector field before entering Play Mode. All lookups are in-memory; the async manifest fetch upgrades the inner registry without interrupting any ongoing lookups.

## Usage Examples

### Look up a creature, resolve its name, and load its art

`DisplayNameKey` on `CreatureContentDef` is a localization key — it must be resolved through `ILocalizationRepository` before being shown in UI. `AssetKey` is the `game_assets.key` value used by `IGameAssetLoader`:

```csharp
[Inject] private IGameContentRegistry   _registry;
[Inject] private ILocalizationRepository _localization;
[Inject] private IGameAssetLoader        _assetLoader;

async void ShowOpponentCreature(string contentKey, string language)
{
    if (!_registry.TryGetCreature(contentKey, out var def)) return;

    // DisplayNameKey is a localization key, NOT a display string
    string displayName = def.DisplayNameKey; // e.g. "creature.cindris.name"
    if (_localization.TryGetText(language, def.DisplayNameKey, out var resolved))
        displayName = resolved;              // e.g. "Cindris"

    nameLabel.text    = displayName;
    elementLabel.text = def.Element;        // "Fire"

    // AssetKey = game_assets.key (e.g. "creatures/cindris")
    // Loader resolves it via the backend asset manifest and loads via Addressables or Resources.
    var sprite = await _assetLoader.LoadAssetByKeyAsync<Sprite>(def.AssetKey);
    if (sprite != null) spriteRenderer.sprite = sprite;
}
```

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
    {
        string displayName = def.DisplayNameKey;
        if (_localization.TryGetText(_language, def.DisplayNameKey, out var resolved))
            displayName = resolved;

        AddCreatureCard(key, displayName, def.Element);
    }
}
```

## Editor Tools

### Content Creator Bidirectional Sync — `ContentCreatorSyncHelper`

`CR/Game/World/Editor/ContentCreatorSyncHelper.cs` — Editor-only static helper that mirrors `AbilityEditorSyncHelper` for Creature, NPC, and Spawner content. Uses blocking `System.Net.Http.HttpClient` calls (acceptable in editor context). Item sync is not supported (no backend REST service).

**Server response DTOs** (same file, `namespace CR.Game.World.Editor`):

| Type | Fields |
|------|--------|
| `ServerCreatureDto` | `contentKey`, `name`, `description`, `assetKey`, `elementType` (string), `abilityProgressionSetId`, `updatedAt`, and all base stat ints |
| `ServerNpcDto` | `contentKey`, `npcType` (string) |
| `ServerSpawnerDto` | `contentKey`, `name`, `description`, `battleArenaKey`, `maxCapacity`, `spawnCooldownSeconds`, `updatedAt` |

**Fetch methods** — called by the sync review panel in Content Studio (tabs 0, 2, 3):

| Method | HTTP call |
|--------|-----------|
| `FetchAllCreatures()` | `GET /api/v1/creatures` |
| `FetchAllNpcs()` | `GET /api/v1/npc/content-registry` |
| `FetchAllSpawners()` | `GET /api/v1/spawners/templates` |

**Push methods:**

| Method | HTTP call | Notes |
|--------|-----------|-------|
| `SyncCreature(def)` | `PUT /api/v1/creatures/by-content-key/{contentKey}` | Pushes all base stat fields |
| `SyncSpawner(def)` | `PUT /api/v1/spawners/by-content-key/{contentKey}` | Pushes display fields + `battleArenaKey` |
| `SyncNpc(def)` | — | Returns `(false, "NPC content keys are world-specific; only pull is available.")` — NPC push is not supported |

**Apply methods** — called when the user accepts a sync decision:

| Method | Side effects |
|--------|-------------|
| `ApplyToCreature(def, dto)` | Sets all stat/name fields on the SO. Auto-generates `displayNameKey` (`creature_{contentKey}_display`) and calls `LocalizationEditorCache.AddOrUpdateEntry` to create or update the YAML entry. |
| `ApplyToNpc(def, dto)` | Sets `npcType`. Auto-generates `displayNameKey` (`npc_{contentKey}_display`) with the `contentKey` as a placeholder value. |
| `ApplyToSpawner(def, dto)` | Sets `displayName`, `description`, `maxCapacity`, `spawnCooldownSeconds`, `battleArenaKey`. |

**Diff methods** — return `string[]` of changed field names:

- `CreatureDiffersFromServer(local, server, out differentFields)`
- `NpcDiffersFromServer(local, server, out differentFields)`
- `SpawnerDiffersFromServer(local, server, out differentFields)`

#### Content Studio Sync UI (tabs 0, 2, 3)

Content Studio exposes a **↕ Sync** button on the Creatures, NPCs, and Spawners tabs (hidden on Items) that triggers the sync review workflow:

1. **Fetching phase** — calls `FetchAll*()` for the active tab, shows a status label
2. **Reviewing phase** — draws a sync review panel grouping definitions into four categories:
   - **Only Local** — SO exists locally but not on server. For Creatures/Spawners: auto-queued for push. For NPCs: info badge (push not supported).
   - **Only Server** — server has a record but no local SO. Auto-queued for pull (creates a new SO via `CreateAssetSilent<T>()`).
   - **In Sync** — local and server match; shown collapsed.
   - **Conflict** — both exist but differ. Shows a diff table of changed field names with per-field values. User must choose **Use Local** or **Use Server** per conflict before Apply is enabled.
3. **Apply** — disabled until all conflicts are resolved. Calls `ApplyContentSyncDecisions()` which iterates each category and applies the appropriate `Apply*` or `Sync*` call. New SOs created on pull are registered into `ContentDefinitionProvider`.

`CreateAssetSilent<T>()` is an internal helper that creates a definition SO asset at a default path without opening a save dialog, handling name collisions by appending `_1`, `_2`, etc.

### Content Studio Tool — `Window → CR → Content Studio`

The **Content Studio** is a unified EditorWindow (`CR/Core/Data/Editor/ContentStudioTool.cs`) that replaces the former Content Creator and Ability Library windows. It handles all 7 content domains in a single window with a consistent dual-panel UX: clicking a row in the list opens its full custom inspector inline below.

```
Window → CR → Content Studio
```

**Tab layout (7 tabs):**

| Index | Tab | Data Source | Sync |
|-------|-----|-------------|------|
| 0 | Creatures | `ContentDefinitionProvider.creatures` + orphan scan | `ContentCreatorSyncHelper` |
| 1 | Items | `ContentDefinitionProvider.items` + orphan scan | — |
| 2 | NPCs | `ContentDefinitionProvider.npcs` + orphan scan | `ContentCreatorSyncHelper` |
| 3 | Spawners | `ContentDefinitionProvider.spawners` + orphan scan | `ContentCreatorSyncHelper` |
| 4 | Abilities | `AssetDatabase.FindAssets("t:AbilityConfig")` | `AbilityEditorSyncHelper` |
| 5 | Progression Sets | `AssetDatabase.FindAssets("t:AbilityProgressionSetConfig")` | `AbilityEditorSyncHelper` |
| 6 | Growth Profiles | `AssetDatabase.FindAssets("t:GrowthProfileConfig")` | `AbilityEditorSyncHelper` |

**Features:**
- **Provider header** — auto-finds the `ContentDefinitionProvider` asset on open; `[Find]` re-runs the search; count badge shows all 4 registry totals (e.g. `5C · 3I · 2N · 1S`)
- **Dual-panel layout** — list area (45% height) + inline detail inspector (55%); clicking any row embeds the full custom editor below the list via `Editor.CreateEditor(asset).OnInspectorGUI()`
- **Orphan strip** (tabs 0–3) — detects unregistered definition assets on disk; `[Register All]` appends them to the provider; orphan rows are selectable so you can inspect before registering
- **`+ New` button** (tabs 0–3) — toggles an inline create panel with content-key field and type-specific extras (element for Creatures, npcType for NPCs); `Create & Register` creates the SO and selects it in the detail panel
- **`Unregister` button** — shown in the detail panel toolbar for tabs 0–3; removes from the provider array while keeping the `.asset` file
- **`↕ Sync` button** — available on all tabs except Items; triggers the bidirectional sync review workflow
- **File-dialog `New` button** (tabs 4–6) — opens a save dialog to create a new `AbilityConfig`, `AbilityProgressionSetConfig`, or `GrowthProfileConfig` SO

`ContentStudioTool.AddConstantToContentKeys(contentKey, contentType)` is a `public static` method so tooling such as `ContentAuditTool` can trigger ContentKeys.cs updates without opening the window.

### Localization Editor Window — `Window → CR → Localization Editor`

`LocalizationEditorWindow` (`CR/Core/Data/Editor/LocalizationEditorWindow.cs`) provides a dedicated view for auditing and editing YAML localization keys across all content types.

**Layout (per-tab: Creatures / Items / NPCs / Spawners):**

| Section | Contents |
|---------|----------|
| **Present** | Definitions that have a YAML entry — values editable inline; dirty keys tracked and saved in bulk via `Save N change(s)` |
| **Missing** | Definitions whose `displayNameKey` is absent from the YAML files — shows suggested key, English value field, and `[+YAML]` per row; `[Generate All Missing Entries]` batch-adds all rows that have a value filled in |
| **Orphaned YAML Keys** | YAML keys for this content type that no definition references — `[✕]` removes the line from the YAML file after confirmation |

A **Filter** text field narrows all sections by content key or localization key.

When switching tabs with unsaved changes, a dialog ("Unsaved Changes — Switch tab and discard? / Switch / Stay") appears. If the user clicks Stay, the switch is cancelled with an early `return` so the toolbar selection reverts cleanly without a redundant assignment.

### Content Audit Tool — `Window → CR → Content Audit`

`ContentAuditTool` (`CR/Core/Data/Editor/ContentAuditTool.cs`) runs a full health-check over every registered definition and localization file and surfaces actionable issues ranked by severity.

**Issue categories and severities:**

| Severity | Category | Description | Fix action |
|----------|----------|-------------|------------|
| Error | Missing Asset Key | Creature or item has no `assetKey` — cannot load art | `[Fix]` → opens asset in Inspector |
| Warning | Localization | `displayNameKey` is not in any YAML file | `[Fix]` → opens Localization Editor |
| Warning | ContentKeys | No matching constant in `ContentKeys.cs` | `[Fix]` → calls `ContentStudioTool.AddConstantToContentKeys` |
| Info | Orphaned Asset | Definition asset is not registered in the provider | `[Fix]` → registers it |
| Info | Orphaned YAML | YAML key has no matching definition | `[Fix]` → removes the key from YAML |

A **summary bar** counts errors/warnings/info at the top. Each row has a `[↑]` ping button to locate the asset in the Project window.

### Content Publish Tool — `Window → CR → Publish Content`

`ContentPublishTool` (`CR/Core/Data/Editor/ContentPublishTool.cs`) sends a `POST /api/v1/content/publish` request to the backend with the full asset manifest and a content version hash.

**Pre-publish validation:** Before sending, the tool scans all `CreatureDefinition` and `ItemDefinition` assets for empty `assetKey`. If any are found, a dialog reports the count ("X definitions have no assetKey and will be skipped") and gives the option to **Publish Anyway** or **Cancel**.

**Seed to Local SQLite upsert behaviour:** The existence check queries `game_assets` by `key` without filtering on `deleted`, so rows that were previously soft-deleted are found and updated (with `deleted` reset to `0`) rather than triggering a unique constraint error on re-insert.

Fields:
- **Server Address** — e.g. `http://localhost:8080`
- **Pipeline API Key** — sent as `X-Pipeline-Key` header
- **Content Catalog Hash** — the Addressables catalog hash string; becomes `content_version` in the backend `app_config` row

### `DefinitionEditorExtensions` — Shared drawing helpers

`DefinitionEditorExtensions` (`CR/Core/Data/Editor/DefinitionEditorExtensions.cs`) is an `internal static` class that provides the drawing primitives shared by all four definition Inspectors. This eliminates four identical copies of each helper method.

All GUI styles are cached as `private static` fields with lazy init (null-coalescing) so they are created at most once per editor session and never allocated during `OnInspectorGUI`:

| Helper | Signature | Description |
|--------|-----------|-------------|
| `DrawBanner` | `static void DrawBanner(string label, Color color)` | Renders a tinted `GUILayout.Box` banner with bold 14pt white text |
| `DrawValidated` | `this SerializedProperty prop, string label, bool valid` | Property field with a green `✓` or red `✗` badge |
| `ExistsInContentKeys` | `this string key, string className` | Searches `AssetDatabase` for a `ContentKeys` MonoScript containing `class {className}` and `"{key}"`. Null/empty asset paths are skipped silently; file read errors return `false` without crashing the inspector. |
| `DrawContentKeyInfo` | `this string key, string className` | Renders a `HelpBox` (Info or Warning) showing whether the key appears in `ContentKeys.cs` |

Call sites in each definition editor use the extension form where a natural receiver exists:

```csharp
// Banner (no receiver — static call)
DefinitionEditorExtensions.DrawBanner("Creature Definition", _bannerColor);

// Validated field (receiver = SerializedProperty)
propKey.DrawValidated("Content Key", !string.IsNullOrWhiteSpace(def.contentKey));

// Content key info (receiver = string)
def.contentKey.DrawContentKeyInfo("Creatures");
```

### Custom Inspectors

Each definition type has a `[CustomEditor]` that replaces the default Inspector:

| Editor class | Target type | Color |
|---|---|---|
| `CreatureDefinitionEditor` | `CreatureDefinition` | Deep red banner + element color pill |
| `ItemDefinitionEditor` | `ItemDefinition` | Steel blue banner |
| `NpcDefinitionEditor` | `NpcDefinition` | Teal banner |
| `SpawnerDefinitionEditor` | `SpawnerDefinition` | Dark green banner |
| `SpawnerZoneConfigEditor` | `SpawnerZoneConfig` | Blue banner, pool/template foldouts, SO reference for `abilityProgressionSet` |
| `AbilityConfigEditor` | `AbilityConfig` | Purple banner, element/category popups, status-move power warning |
| `AbilityProgressionSetConfigEditor` | `AbilityProgressionSetConfig` | Brown banner, entry list with duplicate (level, slot) detection |
| `GrowthProfileConfigEditor` | `GrowthProfileConfig` | Green banner, two-column stat grid, live base-50 stat preview |
| `ContentDefinitionProviderEditor` | `ContentDefinitionProvider` | Navy banner |

Every definition Inspector shows:
- Colored type banner (via `DefinitionEditorExtensions.DrawBanner`)
- Validated field rows (green `✓` / red `✗` badge, via `prop.DrawValidated`)
- HelpBox indicating whether the content key is present in `ContentKeys.cs` (via `key.DrawContentKeyInfo`)
- `[Open in Content Studio]` button

`ContentDefinitionProviderEditor` additionally shows:
- Count summary (`4 Creatures · 0 Items · 0 NPCs · 1 Spawner`)
- Per-type foldout with content key list (read-only)
- Orphan warning with `[Register All Orphans]` if any unregistered definition assets are found

`CreatureDefinitionEditor` additionally shows:
- Colored element pill next to the element dropdown
- Preview row: `content key → display name key → asset key` (rendered in a cached monospace `GUIStyle` using `Font.CreateDynamicFontFromOSFont("Courier New", 11)`; the font and style are created once and stored in a `private static` field)

## Adding a New Entity

### Using the Content Studio (recommended)

1. Open `Window → CR → Content Studio`
2. Select the appropriate tab (Creatures / Items / NPCs / Spawners)
3. Click `+ New` to expand the create panel; fill in content key and type-specific fields
4. Click `Create & Register` — the tool creates the `.asset` file, registers it in the provider, selects it in the detail panel, and updates `ContentKeys.cs`
5. Add the localization entry for `DisplayNameKey` (see [Localization](?page=unity/06-localization))

### Manual workflow

1. **Create the definition ScriptableObject:**
   - Right-click in the Project window → `Create > CR > Content > Creature Definition`
   - Set `content_key` to the designer key (e.g. `"emberox"`)
   - Set `DisplayNameKey` to a localization key (e.g. `"creature.emberox.name"`)
   - Set `Element`, `AssetKey`, and other fields as needed

2. **Add the asset to `ContentDefinitionProvider`:**
   - Open the `ContentDefinitionProvider` asset
   - Add the new definition to the appropriate array (e.g. `Creature Definitions`)

3. **Add the constant to `ContentKeys`:**

   ```csharp
   public static class Creatures
   {
       public const string Emberox = "emberox";
       // ...
   }
   ```

4. **Add the localization entry** for `DisplayNameKey` in the relevant localization YAML file (see [Localization](?page=unity/06-localization)).

5. **Seed the backend** — add the `content_key` value to the creature migration seed data and ensure `M1015EnforceContentKeyNotNullAndUnique` has run.

6. **Publish the asset manifest** — run `Window > CR > Publish Content` to push the `asset_key` to the backend `game_assets` table so `IGameAssetLoader.LoadAssetByKeyAsync` can resolve it.

## `IGameAssetLoader.LoadAssetByKeyAsync<T>`

`IGameAssetLoader.LoadAssetByKeyAsync<T>(assetKey)` is unchanged. It takes the `AssetKey` from a content def (which matches `game_assets.key` in the backend database) and returns the loaded Unity asset via Addressables or Resources, depending on `game_assets.loader_source`.

```csharp
var sprite = await _assetLoader.LoadAssetByKeyAsync<Sprite>(def.AssetKey);
```

## Relationship to `game_config.yaml` and `GameConfigurationKeys`

`game_config.yaml` is a flat `string → string` map for runtime configuration (server addresses, database paths, content version, etc.). It is **not** the place for structured content definitions.

`game_config.yaml` now includes:

```yaml
game_server_http_address: http://localhost:8080
content_version_key: ""     # populated after a content publish
```

Read via:

```csharp
_gameConfig.TryGet(GameConfigurationKeys.GameServerHttpAddress, out var address);
_gameConfig.TryGet(GameConfigurationKeys.ContentVersionKey, out var version);
```

## Relationship to the Backend `content_key` Column

Every entity that appears in the registry must have a matching `content_key` value in the backend database. The constraint is enforced by migrations:

- `M1015EnforceContentKeyNotNullAndUnique` — creature table
- `M2006EnforceContentKeyNotNullOnNpcs` — npcs table
- `M5012EnforceContentKeyNotNullOnSpawner` — spawner table

If a content key in the registry has no matching row in the DB, `EnsureNpcAsync` / `EnsureSpawnerForTrainerByKeyAsync` will fail at world bootstrap. If a DB row exists with no matching registry entry, runtime systems will fall back gracefully (empty `TryGet`) but will not crash.


## Ability Library Authoring

Three ScriptableObjects form the ability authoring pipeline. Each has a "Sync to Server" button in its custom Inspector that calls `AbilityEditorSyncHelper` (editor-only, blocking HTTP).

### `AbilityConfig`

Created via `Assets > Create > CR > Content > Ability Config`. Fields:

| Field | Default | Description |
|-------|---------|-------------|
| `id` | auto-generated GUID | Stable UUID — set once by `OnValidate`, never change after first sync |
| `abilityName` | — | Display name of the ability |
| `description` | — | Tooltip / battle-log description |
| `elementType` | `"Normal"` | One of: Normal, Fire, Water, Flora, Ice, Ground, Wind, Lightning, Poison, Radiant |
| `power` | 0 | Base damage value |
| `accuracy` | 100 | Hit chance (0–100) |
| `cost` | 20 | PP cost per use |
| `priority` | 0 | Turn order modifier |
| `targetType` | `"Single"` | Target selection type |
| `category` | `"Physical"` | Physical, Special, or Status |
| `animationKey` | — | Links to a battle animation asset |

The Inspector warns if `power > 0` and `category == "Status"`.

"Sync to Server" → `PUT {game_server_http_address}/api/v1/abilities/{id}`

### `AbilityProgressionSetConfig`

Created via `Assets > Create > CR > Content > Ability Progression Set Config`. Fields:

| Field | Description |
|-------|-------------|
| `id` | Auto-generated stable GUID |
| `setName` | Human-readable label |
| `description` | Optional notes |
| `isActive` | Whether this set is active in the backend |
| `entries[]` | Array of `AbilityProgressionEntry`: `(level, AbilityConfig, abilitySlot 1–4)` |

The Inspector shows a per-entry foldout sorted by level and warns on duplicate `(level, slot)` pairs. Entries with a null or ID-less `AbilityConfig` are skipped on sync.

"Sync to Server" → `POST {game_server_http_address}/api/v1/ability-progression/sets/sync`

### `GrowthProfileConfig`

Created via `Assets > Create > CR > Content > Growth Profile Config`. Fields:

| Field | Default | Description |
|-------|---------|-------------|
| `id` | auto-generated GUID | Stable UUID |
| `profileName` | — | Name matching the backend `growth_profile.name` |
| `description` | — | Optional notes |
| `experienceGrowth` | 100 | XP gain multiplier (100 = normal) |
| `hitPointsGrowth` | 100 | HP stat scale at level 1 (100 = base × 1.0) |
| `attackGrowth` | 100 | Attack scale |
| `defenseGrowth` | 100 | Defense scale |
| `specialAttackGrowth` | 100 | Sp. Atk scale |
| `specialDefenseGrowth` | 100 | Sp. Def scale |
| `speedGrowth` | 100 | Speed scale |

The Inspector renders a two-column grid for the six stat fields and shows a live preview: `Base 50 @ Lv1 → HP:{50*hp/100} ATK:{50*atk/100} ...`. A warning appears if any value is below 10.

"Sync to Server" → `PUT {creature_server_http_address}/api/v1/growth-profiles/{id}`

### `AbilityEditorSyncHelper`

`CR/Game/World/Editor/AbilityEditorSyncHelper.cs` — Editor-only static helper. Reads `game_server_http_address` from `game_config.yaml` via `Resources.Load<TextAsset>("configuration/game_config")` and uses blocking `System.Net.Http.HttpClient` calls (acceptable in editor context). Returns `(bool ok, string message)` tuples that the custom Inspectors display in a `HelpBox`.

#### Bidirectional sync support

`AbilityEditorSyncHelper` also provides fetch and conflict-detection methods used by the Content Studio sync review workflow (tabs 4–6):

**Server response DTOs** (defined in the same file, `namespace CR.Game.World.Editor`):

| Type | Fields |
|------|--------|
| `ServerAbilityDto` | `id`, `name`, `description`, `elementType` (int), `power`, `accuracy`, `cost`, `priority`, `targetType`, `category`, `animationKey`, `updatedAt` |
| `ServerGrowthProfileDto` | `id`, `name`, `description`, `experienceGrowth` (float), `hitPointsGrowth`, `attackGrowth`, `defenseGrowth`, `specialAttackGrowth`, `specialDefenseGrowth`, `speedGrowth`, `updatedAt` |
| `ServerProgressionSetDto` | `id`, `name`, `description`, `isActive`, `updatedAt`, `entries` (list of `ServerProgressionEntryDto`) |
| `ServerProgressionEntryDto` | `level`, `abilityId`, `abilitySlot` |

**Fetch methods** — blocking GET calls using `System.Text.Json.JsonDocument` (not `JsonUtility`; required for top-level JSON arrays):

| Method | Endpoint |
|--------|----------|
| `FetchAllAbilities()` | `GET /api/v1/abilities` |
| `FetchAllGrowthProfiles()` | `GET /api/v1/growth-profiles` |
| `FetchAllProgressionSets()` | `GET /api/v1/ability-progression/sets` |

Each returns `(bool ok, string error, List<T> data)`.

**Apply-from-server methods** — update a local SO in-place from a server DTO:

| Method | Notes |
|--------|-------|
| `ApplyToAbility(config, dto)` | Copies all fields; converts `elementType` int back to string via reverse lookup |
| `ApplyToGrowthProfile(config, dto)` | Copies all growth fields |

**Conflict detection** — pure functions, no side effects:

| Method | Returns |
|--------|---------|
| `AbilityDiffersFromServer(local, server, out string[] differentFields)` | `true` if any field differs; populates `differentFields` |
| `GrowthProfileDiffersFromServer(local, server, out string[] differentFields)` | same |
| `ProgressionSetDiffersFromServer(local, server, out string[] differentFields)` | compares name, description, isActive, entry count |

**Element type reverse lookup** — `IntToElementType` dictionary maps server int values (0–11) back to the `elementType` string used by `AbilityConfig`.

### Spawner Template `abilityProgressionSet` Field

`SpawnerTemplateConfig.abilityProgressionSet` is now a `AbilityProgressionSetConfig?` SO reference (previously a raw UUID string). The `SpawnerZoneConfigEditor` renders it as an object drag field with a warning if empty. Both `SpawnerSyncHttpClient` and `LocalSpawnerSyncClient` read `t.abilityProgressionSet?.id` to extract the UUID.

### Ability Sync Workflow (Tabs 4–6 in Content Studio)

The Abilities, Progression Sets, and Growth Profiles tabs in **Content Studio** each have a **"↕ Sync with Server"** button that triggers a full bidirectional sync review. (These tabs formerly lived in the standalone `AbilityLibraryTool` window.)

#### Bidirectional sync workflow

1. Click **"↕ Sync with Server"** on any tab (Abilities, Growth Profiles, or Progression Sets).
2. The tool fetches all records from the server for that type.
3. A **Sync Review** panel replaces the normal list, grouped by status:

| Status | Color badge | Description |
|--------|------------|-------------|
| **Only Local** | Green | Asset exists locally but not on the server — will push on Apply |
| **Only Server** | Blue | Record on server but no matching local SO — will create local SO on Apply |
| **In Sync** | Gray | ID matches, all fields equal — no action |
| **Conflict** | Orange | ID matches but one or more fields differ — requires manual resolution |

4. For each **Conflict**, a diff table shows the differing field names with Local and Server values side by side.
5. Resolution buttons per conflict: **Use Local** (push local to server), **Use Server** (pull server data into local SO), **Skip** (take no action).
6. The **Apply** button is disabled until all conflicts have a resolution chosen. Its label shows the pending action count: `Apply (N push, M pull, K resolved)`.
7. On Apply, all decisions are executed in order, `AssetDatabase.SaveAssets()` is called, and the panel closes.

#### Progression Set conflict notes

For Progression Set conflicts resolved as **Use Server**, only the top-level fields (`name`, `description`, `isActive`) are updated. Entries are not overwritten — they reference `AbilityConfig` SOs by object reference and cannot be reconstructed from server UUIDs without a full lookup pass. A HelpBox warning `"Entries require manual update"` appears in the conflict row when UseServer is selected.

#### Silent asset creation

When pulling a server-only record (creating a new local SO), `CreateAssetSilent<T>` is used instead of the file-dialog `CreateAsset<T>`. It writes directly to the target folder (`Assets/CR/Content/Abilities`, `GrowthProfiles`, or `ProgressionSets`) with the server name as the filename, appending a short UUID suffix if a file with that name already exists.

### Ability Sync DI Wiring

```csharp
// LocalDevGameInstaller.cs
Container.Bind<IAbilityLibrarySyncClient>()
    .WithId("online").To<AbilityLibrarySyncHttpClient>().AsSingle();
Container.Bind<IAbilityLibrarySyncClient>()
    .WithId("offline").To<LocalAbilityLibrarySyncClient>()
    .FromMethod(ctx => new LocalAbilityLibrarySyncClient(
        connectionStringFactory.GetConnectionStringForRepository(LocalDataSources.BaseCreatureOfflineRepository),
        new CRUnityLoggerAdapter(typeof(LocalAbilityLibrarySyncClient))))
    .AsSingle();
Container.Bind<IAbilityLibrarySyncClient>()
    .To<OnlineOfflineAbilityLibrarySyncClient>().AsSingle();
```

## Gotchas

**Registry is empty at startup.** If `_contentDefinitions` is not assigned in the `LocalDevGameInstaller` Inspector, `ScriptableObjectContentRegistry` will have empty arrays and all `TryGet*` calls return false. Check that the `ContentDefinitionProvider` asset is assigned.

**`DisplayNameKey` is not a display string.** If you render `def.DisplayNameKey` directly in the UI, players will see raw localization keys like `"creature.cindris.name"` instead of `"Cindris"`. Always resolve through `ILocalizationRepository.TryGetText` first.

**Definition asset not added to the provider.** Creating a `CreatureDefinition` asset is not enough — it must also be added to the `ContentDefinitionProvider`'s array, or it will not appear in the registry.

**Manifest fetch happens after Zenject Initialize.** `ContentRegistryInitializer.Initialize()` fires the async fetch but does not block. Code that reads the registry in `Awake()` or `Start()` may still see SO data — this is expected. Only code that runs well after the first-frame Initialize cycle (e.g., world bootstrap triggered by a trainer selection) is guaranteed to see server data.

**`game_server_http_address` must be set.** `ContentManifestClientUnityHttp` uses `GameConfigurationKeys.GameServerHttpAddress` to resolve the base URL. If that key is missing from `game_config.yaml`, the client logs `Invalid HttpClient configuration` at startup and all manifest fetches return null (SO fallback applies).

**`AddressablesCatalogUpdater` is compile-gated.** The `CR_ADDRESSABLES` scripting define must be added in Player Settings for `AddressablesCatalogUpdater` to compile. If `com.unity.addressables` is in `manifest.json` but the define is absent, the updater file compiles to nothing and no catalog update check runs.

**Content key case and separator conventions.** Use lowercase with underscores for creature keys and lowercase with hyphens for spawners — matching the backend convention.

## Related Pages

- [Dependency Injection](?page=unity/02-dependency-injection) — how singletons like `IGameContentRegistry` are registered
- [Localization](?page=unity/06-localization) — resolving `DisplayNameKey` strings via `ILocalizationRepository`
- [World Behaviours](?page=unity/03-world-behaviours) — `NpcWorldBehaviour` and `SpawnerWorldBehaviour` use content keys at bootstrap
- [NPC Interaction](?page=unity/04-npc-interaction) — content keys appear in `NpcTrainerBehaviour` Inspector fields
- [Battle System](?page=unity/07-battle-system) — content keys identify creatures involved in a battle
- [Asset Management](?page=backend/10-asset-management) — `game_assets` table, version check, content publish pipeline
- [Battle Persistence](?page=backend/09-battle-persistence) — backend battle tables reference creatures by content key
