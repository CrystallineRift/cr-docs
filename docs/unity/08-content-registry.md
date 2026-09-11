# Content Registry

The **content registry** is the client-side catalog of every designer-authored game entity. It maps a content key (e.g. `"cindris"`, `"starter-wild-zone"`) to its human-readable metadata — display name key, element type, asset key, and so on — without requiring a database query or network call.

The registry bridges two concerns:

- The **backend** knows entities by UUID (`creature.id`) and content key (`creature.content_key`).
- **Level designers** author scene content using the content key string (Inspector fields on `NpcTrainerBehaviour`, `SpawnerWorldBehaviour`, etc.).
- **Runtime systems** (UI, battle, inventory) need typed, structured information about each entity — not just a raw key.

## Where Content Lives: the Two-Database Model

This in-memory registry is the fast lookup layer. The durable offline store underneath it is split into **two databases**:

- **game-data DB** (`game-data.bytes`) — all global authored content (base creatures, abilities, status conditions, growth profiles, items, spawner templates + pools, NPC definitions + teams + inventory, quest templates/objectives/requirements/rewards, `game_assets`, level/exp tables). Read-only at runtime, built as a versioned artifact at build time, and patched via Addressables.
- **player-data DB** (`player-data.bytes`) — per-account/per-trainer saves. Mutable; migrated in place on app update.

The registry's data ultimately originates from game-data content (offline) or the server manifest (online). A content update patches the game-data Addressable and **never touches player saves**. See the [Content Pipeline (Two-Database Model)](?page=unity/17-content-pipeline) page for the full build/ship/adopt flow and the build-time referential-integrity checks.

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
| `Assets > Create > CR > Content > Spawner Definition` | `SpawnerDefinition` | One SO per spawner zone (holds pools + templates) |
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
| `AssetKey` | `game_assets.key` value — the Addressables address or Resources path for the creature's **prefab** |
| `IconKey` | Addressables address of the creature's 2D portrait, `icons/creatures/<contentKey>` — from `creature.icon_asset_key`. Empty string when un-authored |

> **Important:** `DisplayNameKey` is a localization key, not a resolved string. Do not display it directly in UI. Always resolve it through `ILocalizationRepository` first.

> **`AssetKey` is not `IconKey`.** The first addresses a GameObject, the second a `Sprite`. Passing
> `AssetKey` to `LoadAssetByKeyAsync<Sprite>` can only ever return null — the bug that hid five broken
> icon slots. Paint icons with `UiIcon.Apply`; see [UI Icons](29-ui-icons.md).

### `ItemContentDef`

| Property | Description |
|----------|-------------|
| `DisplayName` | Display name or localization key for this item type |
| `AssetKey` | Addressables address or Resources path for the item's prefab (nullable) |
| `IconKey` | Addressables address of the item's 2D icon, `icons/items/<contentKey>` — from `item.icon_asset_key` (nullable) |

`ItemContentDef` uses constructor injection — the signature is now
`new ItemContentDef(displayName, assetKey, iconKey)`, three arguments. `AssetKey` and `IconKey` are
both nullable; items without art have null keys.

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
| `reactionProfile` | `CreatureReactionProfile` | Client-only, never synced. The creature's in-battle body reactions — see [Battle System](07-battle-system.md#creature-reaction-profiles). Picked from a dropdown of profiles in the inspector, which also reports how many of the profile's 15 beats are covered. |

> **Removed:** `abilityProgressionSetId` and `growthProfileId` used to live here. `M1023RemoveProgressionFieldsFromCreature` dropped both columns from the `creature` table — progression and growth now belong to the spawn template (`creature_spawner_template`), the trainer team slot, and the *generated* creature. The fields showed `(none)` on every creature because nothing could ever fill them.

### `SpawnerDefinition` Inspector Fields

`SpawnerDefinition` ScriptableObjects store the full zone configuration synced from the backend:

| Field | Type | Description |
|-------|------|-------------|
| `contentKey` | string | Must match `content_key` in the backend spawner table |
| `battleArenaKey` | string | Optional. Must match `BattleArena.ArenaKey` of a scene arena object. Used by `SpawnerWorldBehaviour` to tell `BattleCoordinator` which arena to activate when a wild battle starts from this zone. Leave empty to skip arena teleportation. |
| `displayName` | string | Human-readable label (synced from server) |
| `description` | string | Description text (synced from server) |
| `maxCapacity` | int | **Recorded, not enforced.** Stored and round-tripped, but `CreatureSpawnDomainService` applies no capacity limit — spawning is stateless. |
| `spawnCooldownSeconds` | int | **Recorded, not enforced.** Same: stored and synced, but no cooldown is applied at spawn time. |

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

`CreatureManifestEntry` and `ItemManifestEntry` both carry `iconAssetKey`, so an online player's
registry has icon keys without a second fetch: `IconKey = c.iconAssetKey ?? string.Empty` for
creatures, and the item entry passes `it.iconAssetKey` straight into the `ItemContentDef` constructor.
`ScriptableObjectContentRegistry` fills the same properties from `def.iconKey`, so the offline and
online registries answer the same question the same way.

### `ContentRegistryInitializer`

Implements Zenject `IInitializable`. `Initialize()` fires `FetchAndUpgradeAsync()` without awaiting — Zenject's `Initialize()` is synchronous, so the async work runs concurrently with the rest of world bootstrap. Any exception during the fetch is caught and logged; the SO registry is kept.

### `ContentManifestClientUnityHttp`

Extends `SimpleWebClient` with `IContentManifestRepository`. Calls `GET /api/v1/content/manifest` using the `game_server_http_address` config key. Deserializes via Newtonsoft (already handled by `SimpleWebClient.Get<T>`). Returns null on any exception.

### `ContentRegistryBootstrapper` (utility)

A static `async Task<IGameContentRegistry> BuildAsync(manifestClient, fallbackProvider)` helper for contexts outside the Zenject DI flow (integration tests, editor tooling). Tries to fetch the manifest; returns a `ServerContentRegistry` on success or a `ScriptableObjectContentRegistry` on failure.

### `AddressablesCatalogUpdater` (conditional)

Only compiled when the `CR_ADDRESSABLES` scripting define is active. Wraps `Addressables.CheckForCatalogUpdates` and `Addressables.UpdateCatalogs`. Call `AddressablesCatalogUpdater.UpdateAsync()` early in the startup flow — before any Addressables asset loads — to ensure remote catalog updates are applied. Add the `CR_ADDRESSABLES` define in **Project Settings → Player → Scripting Define Symbols** when `com.unity.addressables` is present in `manifest.json`.

This same catalog-update path is what delivers **game-data content patches**: the baked `game-data.bytes` artifact ships as an Addressable, so pushing a newer game-data database is just another catalog update. The cold-start adopt (atomic copy of the artifact into the working game-data path, gated by a fail-closed schema-version check) is implemented in `GameDataAdopter`. See [Content Pipeline (Two-Database Model)](?page=unity/17-content-pipeline).

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
| `ServerCreatureDto` | `id`, `contentKey`, `name`, `description`, `assetKey`, `iconAssetKey`, `elementType` (string), `updatedAt`, and all base stat ints — no `abilityProgressionSetId` / `growthProfileId`; M1023 dropped both columns from `creature` |
| `ServerNpcDto` | `contentKey`, `npcType` (string) |
| `ServerSpawnerDto` | `contentKey`, `name`, `description`, `battleArenaKey`, `maxCapacity`, `spawnCooldownSeconds`, `updatedAt` |

**Fetch methods** — called by the **⬇ Pull** action in Content Studio (tabs 0, 2, 3):

| Method | HTTP call |
|--------|-----------|
| `FetchAllCreatures()` | `GET /api/v1/creatures` |
| `FetchAllNpcs()` | `GET /api/v1/npc/content-registry` |
| `FetchAllSpawners()` | `GET /api/v1/spawners/content-registry` |

**Push methods** — called by the **⬆ Push All** action (one PUT/POST per local SO; the server upserts by `content_key`, so no fetch-compare is needed):

| Method | HTTP call | Notes |
|--------|-----------|-------|
| `SyncCreature(def)` | `PUT /api/v1/creatures/by-content-key/{contentKey}` | Pushes all base stat fields |
| `SyncSpawner(def)` | `PUT /api/v1/spawners/by-content-key/{contentKey}` | Pushes spawner metadata + `battleArenaKey` only |
| `SyncSpawnerFull(def)` | `POST /api/v1/spawners/sync-config` | Pushes metadata **and** pools + templates atomically — this is what **Push All** uses for spawners |
| `SyncNpc(def)` | `PUT /api/v1/npc/content-registry` | Upserts the NPC content-registry row (`contentKey`, `npcType`, `itemSpawnerContentKey`). It sends no `isRematchable`, and no longer needs to: the server's field is nullable, so an omitted flag is *preserved* rather than reset — an NPC-tab push can no longer switch a trainer's rematch off |
| `SyncTrainerBattle(def)` | four calls, below | Pushes a `TrainerBattleDefinition`'s team, its cached-team reset and the trainer's identity — see *A trainer battle push is four writes* |

**Delete methods** — call the soft-delete backend endpoints; return `(ok, message)` where `ok = false` means the server rejected the delete (surfaces the error text to the user):

| Method | HTTP call | Notes |
|--------|-----------|-------|
| `DeleteCreature(contentKey)` | `DELETE /api/v1/creatures/by-content-key/{contentKey}` | Returns `(false, message)` if the server returns 409 (trainer creatures exist referencing this species) |
| `DeleteSpawner(contentKey)` | `DELETE /api/v1/spawners/by-content-key/{contentKey}` | Always safe — spawner templates have no per-trainer rows |

NPC delete is not supported — NPC rows are per-trainer instances (no global template table).

**Apply methods** — called when the user accepts a sync decision:

| Method | Side effects |
|--------|-------------|
| `ApplyToCreature(def, dto)` | Sets all stat/name fields on the SO. Auto-generates `displayNameKey` (`creature_{contentKey}_display`) and calls `LocalizationEditorCache.AddOrUpdateEntry` to create or update the YAML entry. |

#### Icon keys travel with the content

`iconAssetKey` rides these same paths for creatures, items, abilities and status conditions
(`ContentCreatorSyncHelper`, `AbilityEditorSyncHelper`), with the two directions deliberately
disagreeing:

| Direction | Rule | Meaning |
|---|---|---|
| Push | `SyncFieldMerge.PreferLocalUnlessBlank(local, server)` | An authored key wins; a blank local field leaves the server's value alone; both blank push `null`, not `""` |
| Pull | `SyncFieldMerge.PreferServerUnlessBlank(server, local)` | The server wins unless it has nothing to say |

The item push runs the local value through `AbilityEditorSyncHelper.KeyOrDerived(def.iconKey,
def.icon)` first, so a designer who assigned the sprite but never derived the string still gets the
icon to the server.

`FetchAllCreatures` builds its DTO field-by-field from a `JObject` rather than deserializing, which is
why `iconAssetKey` had to be added there by hand — the sibling fetches for abilities and status
conditions go through `JsonConvert` and picked the new field up for free. A DTO field that is never
populated makes the merge a permanent no-op that looks like "the server had nothing".

See [UI Icons](29-ui-icons.md).
| `ApplyToNpc(def, dto)` | Sets `npcType`. Auto-generates `displayNameKey` (`npc_{contentKey}_display`) with the `contentKey` as a placeholder value. |
| `ApplyToSpawner(def, dto)` | Sets `displayName`, `description`, `maxCapacity`, `spawnCooldownSeconds`, `battleArenaKey`. |

#### Content Studio Sync UI (tabs 0, 2, 3)

Sync is **drift-free**: SOs are the source of truth and pushes are idempotent upserts keyed by `content_key`, so there is no fetch-compare-resolve step. Each synced tab shows two buttons (hidden on Items):

- **⬆ Push All** — loops every local definition on the tab and upserts it (`SyncCreature` / `SyncNpc` / `SyncSpawnerFull`). No server fetch; the server overwrites by `content_key`. A status line reports `N pushed, M failed`, and per-row badges show each result.
- **⬇ Pull** — the rare reverse-bootstrap. After a confirm dialog, calls `FetchAll*()`, then for each server entry overwrites the matching local SO (`ApplyTo*`) or creates one (`CreateAssetSilent` + register into `ContentDefinitionProvider`) for server-only keys. Spawners additionally fetch `/by-content-key/{key}/config` so pools + templates come down too. Reports `N updated, M created`.

There is no diff preview, conflict resolution, or in-review delete step — push always wins, and removing a backend record is done explicitly via **Unregister** (below).

`CreateAssetSilent<T>()` is an internal helper that creates a definition SO asset at a default path without opening a save dialog, handling name collisions by appending `_1`, `_2`, etc.

### Content Studio Tool — `Window → CR → Content Studio`

The **Content Studio** is a unified EditorWindow (`CR/Core/Data/Editor/ContentStudioTool.cs`) that replaces the former Content Creator and Ability Library windows. It handles all 7 content domains in a single window with a consistent dual-panel UX: clicking a row in the list opens its full custom inspector inline below.

```
Window → CR → Content Studio
```

**Tab layout (20 tabs, grouped in the nav rail):**

| Index | Group | Tab | Data Source | Push helper |
|-------|-------|-----|-------------|-------------|
| 0 | CONTENT | Creatures | `ContentDefinitionProvider.creatures` + orphan scan | `ContentCreatorSyncHelper.SyncCreature` |
| 1 | CONTENT | Items | `ContentDefinitionProvider.items` + orphan scan | `ContentCreatorSyncHelper.PushItems` (bulk merge) |
| 2 | CONTENT | NPCs | `ContentDefinitionProvider.npcs` + orphan scan | `ContentCreatorSyncHelper.SyncNpc` |
| 7 | CONTENT | Quests | `AssetDatabase.FindAssets("t:QuestDefinition")` | `QuestEditorSyncHelper.SyncQuest` |
| 13 | CONTENT | Trainer Battles | `AssetDatabase.FindAssets("t:TrainerBattleDefinition")` | `ContentCreatorSyncHelper.SyncTrainerBattle` |
| 3 | WORLD | Spawners | `ContentDefinitionProvider.spawners` + orphan scan | `ContentCreatorSyncHelper.SyncSpawnerFull` |
| 10 | WORLD | Spawn Pools | pools of the registry spawners | via the owning spawner |
| 12 | WORLD | Item Spawners | `AssetDatabase.FindAssets("t:ItemSpawnerDefinition")` | `ContentCreatorSyncHelper.SyncItemSpawnerFull` |
| 4 | COMBAT | Abilities | `AssetDatabase.FindAssets("t:AbilityConfig")` | `AbilityEditorSyncHelper.SyncAbility` (+ conditions) |
| 5 | COMBAT | Progression | `AssetDatabase.FindAssets("t:AbilityProgressionSetConfig")` | `AbilityEditorSyncHelper.SyncProgressionSet` |
| 6 | COMBAT | Growth | `AssetDatabase.FindAssets("t:GrowthProfileConfig")` | `AbilityEditorSyncHelper.SyncGrowthProfile` |
| 8 | COMBAT | Conditions | `AssetDatabase.FindAssets("t:StatusConditionConfig")` | `AbilityEditorSyncHelper.SyncStatusCondition` |
| 15 | COMBAT | Battle Missions | `AssetDatabase.FindAssets("t:BattleMissionDefinition")` | `BattleMissionEditorSyncHelper.Sync` |
| 16 | COMBAT | Reactions | `AssetDatabase.FindAssets("t:ElementalReactionDefinition")` | `ElementalReactionEditorSyncHelper.Sync` |
| 17 | COMBAT | Elemental Damage | `AssetDatabase.FindAssets("t:ElementalDamageMatrixConfig")` | `ElementalDamageEditorSyncHelper.PushMatrix` |
| 11 | COMBAT | Battle Tuning | `AssetDatabase.FindAssets("t:DamageCurveDefinition")` | `AbilityEditorSyncHelper.SyncDamageCurve` |
| 9 | SYSTEM | Registry | the `ContentDefinitionProvider` asset | status overview — see below; pushes everything |
| 14 | SYSTEM | Auth | `EditorServiceAuth` / `EditorAdminAuth` key boxes | mints service tokens; no content |
| 18 | LIVE OPS | Players | `GET /api/v1/admin/players?q=` + `/players/{accountId}` | `AdminPlayerEditorSyncHelper` (writes, not pushes) |
| 19 | LIVE OPS | Marketplace | `GET /api/v1/admin/market/listings` | `AdminMarketEditorSyncHelper.RemoveListing` |

LIVE OPS is the last group on purpose: every tab above it edits *content* that is pushed to the
server; the two tabs below it read and change *live player state* on whichever server the header
points at. See *Live ops tabs* below.

**Features:**
- **Header** — one sentence saying what, if anything, needs doing, with the button that resolves it; the connection pill; and the two detail switches. See *Reading the window* below.
- **Dual-panel layout** — list area (45% height) + inline detail inspector (55%); clicking any row embeds the full custom editor below the list via `Editor.CreateEditor(asset).OnInspectorGUI()`
- **Orphan strip** (tabs 0–3) — detects unregistered definition assets on disk; `[Register All]` appends them to the provider; orphan rows are selectable so you can inspect before registering
- **`+ New` button** (tabs 0–3) — toggles an inline create panel with content-key field and type-specific extras (element for Creatures, npcType for NPCs); `Create & Register` creates the SO and selects it in the detail panel
- **`Unregister` button** — shown in the detail panel toolbar for tabs 0–3; removes from the provider array while keeping the `.asset` file. For Creatures and Spawners, a dialog appears after unregistering asking "Also delete from server?" — choosing **Delete from server** calls `ContentCreatorSyncHelper.DeleteCreature/DeleteSpawner`; any server-side block (e.g. 409 creature guard) is surfaced in a follow-up dialog.
- **`⬆ Push All` / `⬇ Pull` buttons** — **Push All** upserts every local SO on the tab; **Pull** (confirm-gated) overwrites local from server and creates SOs for server-only keys. No diff/review step. See *One way to reach the server*.
- **File-dialog `New` button** (tabs 4–6) — opens a save dialog to create a new `AbilityConfig`, `AbilityProgressionSetConfig`, or `GrowthProfileConfig` SO
- **Battle Missions tab (15)** — loose `BattleMissionDefinition` SOs in `Assets/CR/Content/Defs/BattleMissions/`. Push is `PUT /api/v1/battle-missions/{id}`, Pull is `GET /api/v1/battle-missions/all?includeInactive=true` applied by id (this is how the ten seeded missions become editable assets — the project ships with none). Per-row **Delete** removes the asset and soft-deletes on the server. The extra **⬇ Export Seed Migration** button writes the authored set into cr-api as a seed migration, because the offline floor is baked from migration seeds only and a push alone never reaches it. Type, reward type and condition dropdowns are built from `CR.Game.Data.Constants.*` and project content, and the row/inspector validation runs the server's own `BattleMissionTemplateValidation`. See [Battle Extensions → Authoring missions in Content Studio](?page=unity/24-battle-extensions).
- **Reactions tab (16)** — loose `ElementalReactionDefinition` SOs in `Assets/CR/Content/Defs/Reactions/`. Push is `PUT /api/v1/elemental-reactions/{id}`, Pull is `GET /api/v1/elemental-reactions/all?includeInactive=true` applied by id (this is how the three seeded reactions — Conduction, Flash Freeze, Shatter — become editable assets; the project ships with none). Push All refuses duplicate content keys before building the plan, because the key is identity on the server and two assets sharing one would 409 against each other. Per-row **Delete** removes the asset and soft-deletes on the server (`DeleteReactionConfirmed` is the seam without the dialog). The extra **⬇ Export Seed Migration** button writes the authored set into `Creatures/CR.Creatures.Data.Migration` as `M<n>SeedElementalReactions_<date>.cs` — each row an upsert, because M12006 already seeds those content keys and an insert-only seed would leave a retuned reaction at its shipped numbers offline. Primer/payload dropdowns are built from the project's `StatusConditionConfig` assets and the detonator dropdown from `ElementType`; the row and inspector validation run the server's own `ElementalReactionValidation`.
- **Elemental Damage tab (17)** — one `ElementalDamageMatrixConfig` asset per matrix version in `Assets/CR/Content/Defs/ElementalDamage/`, and one 10×10 grid at a time. The version dropdown picks which asset is shown; **+ New Version** prompts via `StudioTextPrompt.Ask` (suggesting the next version via `ElementalDamageMatrixMapping.SuggestNextVersion`), validates the name against `ElementalDamageMatrixValidation.IsValidVersion`, and refuses a name any existing asset already carries — it used to create the asset at its field default with no prompt, which was born a duplicate of the seeded v1.1 (the tab kept showing the old grid while the new asset sat un-editable, and neither could be pushed). **Copy as new version…** calls `POST /api/v1/elemental-damage/versions/{version}/copy?from=` and pulls the result back, **Set Active** calls `PUT /api/v1/elemental-damage/active` and re-pulls (the pointer moves for every version at once), and **Delete version…** (Advanced only) calls `DELETE /api/v1/elemental-damage/versions/{version}`, which the server refuses while that version is active. Push sends the whole 100-cell matrix per version — cr-api rejects a partial write, because a matchup with no row resolves at 1.0 with nothing in the logs to say so, so `ElementalDamageMatrixMapping.Complete` fills any gap with the neutral 1.0 before sending. Pull reads `GET …/versions` then `GET …?version=` per version. **⬇ Export Seed Migration** writes the selected version into `Creatures/CR.Creatures.Data.Migration` as `M<n>SeedElementalDamage_<date>.cs`, upserting on `(offense_element, defending_element, version)` and — only when that version is active, and only guarded on the table existing, because it belongs to the Game domain — pointing `battle_system_version` at it.
- **Status Conditions tab (8)** — server-browser with no local SO; `↻ Fetch from Server` loads all conditions; `+ New Condition` / `✎ Edit` open an inline form with name, applyToUser, probability, duration, and a per-condition stat changes sub-list; `Delete` soft-deletes on server. Backed by `AbilityEditorSyncHelper.FetchAllStatusConditions/CreateStatusCondition/UpdateStatusCondition/DeleteStatusCondition` and new `POST /PUT /DELETE /api/v1/status-conditions` endpoints.

### Live ops tabs — Players (18) and Marketplace (19)

Both tabs live in `Assets/CR/Core/Data/Editor/LiveOps/` and talk to the backend's admin surface
(`/api/v1/admin/*`, documented in [Backend → Moderation](?page=backend/18-moderation)). They need an
**admin** token, not the editor's `content:write` token: `EditorAdminAuth` (mirror of
`EditorServiceAuth`, pref `CR_EditorAdminKey`, default `local-dev-admin-service-key` matching the
AIO dev `AdminServiceKey`) exchanges the key at `POST /auth/service-token`, caches the JWT per server,
and retries once on 401. The Auth tab (14) has a second key box for it. A 401/403 on either tab
renders `AdminAuthGate.Explain(status)` and an **Open Auth tab** button instead of a stack trace.

Every server round trip is a `StudioJob` (`PlayerSearchJob`, `PlayerDossierJob`, `ListingsJob`,
`AdminMutationJob`). Each job's `Steps()` first calls `AdminEndpointContext.Resolve()` on the main
thread — that is the one place the server address (`Resources.Load` of `game_config`) and the admin
key (`EditorPrefs`) are read — and hands the resulting `(BaseUrl, AdminKey)` struct into `Task.Run`, so
the worker body is plain HTTP + `JsonConvert`. Results land on the main thread through the job runner,
and the tab never patches its own copy after a write — it re-reads the dossier or page from the server.
Both tabs subscribe to `StudioJob.Finished` when they enqueue, so a cancel from the job bar (or a
faulted job) releases the tab's busy state instead of leaving every button disabled.

- **Players** — search by trainer name or account email prefix (2+ characters; `PlayerSearchQuery`
  normalises the term), pick a hit, and the dossier shows the account (shadow-ban badge with reason
  and expiry) and every trainer: currency, team, creature storage, backpack, item storage (read-only —
  the admin item routes are backpack-only), active listings. Actions, each through
  `ModerationReasonDialog` (reason required; the dialog closes before it answers, and the answer runs
  from `EditorApplication.delayCall`, never inside the dialog's own layout): **Adjust…** currency
  (`CurrencyAdjustValidator` — non-zero, result never below zero), **Grant item… (backpack)** /
  **Remove…** on backpack rows (`ItemChangeValidator`; the item picker is the project's
  `ItemDefinition` assets, sending the asset's server id), **Shadow-ban…** with optional expiry,
  **Lift ban…**. Each button captures the account it was pressed for, so opening another dossier while
  a dialog is up cannot redirect the write. The audit trail below the dossier comes back with the
  dossier itself, rendered by `AdminActionText.Describe`; timestamps go through `ModerationStamp`.
- **Marketplace** — pages the admin listing view (`offset`/`limit` always sent, page size 50,
  filter by state or seller), which includes hidden listings and flags `SellerShadowBanned` on each
  row (`ListingModerationRow`, `ListingRowProjection`). **Remove…** calls
  `DELETE /api/v1/admin/market/listings/{id}` — the creature goes back to the seller's storage, the
  listing ends as `AdminRemoval`, and the reason lands in `admin_action`. The seller filter takes
  an account id (copy one from a dossier with the Players tab's **Copy** button); **Clear** drops it.
  The "Recent listing removals" footer rides along with each page load — an unfiltered
  `GET /api/v1/admin/actions?offset=0&limit=…` narrowed to listing removals on the client; when that
  read fails the footer says so rather than claiming nothing was removed.

Pure logic (`ModerationTone`, `ModerationBadge`, `AdminAuthGate`, `JwtScopeReader`,
`EditorAdminAuthStatus`, `AdminQueryString`, `ModerationStamp`) lives in `CR.Core.Data.Logic` and is
covered by EditMode tests.

`ContentStudioTool.AddConstantToContentKeys(contentKey, contentType)` is a `public static` method so tooling such as `ContentAuditTool` can trigger ContentKeys.cs updates without opening the window.

### Reading the window

The window is built so that somebody opening it for the first time can act without being told
which parts to ignore, and somebody who knows it can still reach everything. Three things do that
work.

**The header answers one question.** Instead of a row of count chips, the header carries a single
pill: the ranked answer to *"is there anything for me to do?"*, with the button that resolves it.
The ranking is `StudioWorkSummary` (pure, 11 tests):

| Order | Condition | Pill says | Button |
|-------|-----------|-----------|--------|
| 1 | no `ContentDefinitionProvider` in the project | "No content registry in this project" | **Fix** → Registry |
| 2 | definitions on disk are not registered | "*n* items are not in the registry — the game cannot see them" | **Review** → Registry |
| 3 | edits since the last recorded push | "*n* edits not yet pushed" | **Push All** |
| 4 | a connection check has failed | "Server unreachable" | — |
| — | none of the above | "Everything registered and pushed" | — |

Registration outranks pushing because pushing first would send an incomplete set. Offline still
*states* the outstanding work — a disconnected editor that looked finished would be the worse lie —
but withholds the button that cannot succeed. State is never colour alone: a glyph (`✓ ! ✕`) and
the sentence carry it.

**Review shows the edits before you push them.** Beside the pill, a **Review** button appears
whenever the pill is offering **Push All**. It opens `ContentReviewWindow` ("Review edits"): every
content asset whose file is newer than its last push, grouped by content type in the rail's order,
newest edit first. Each row carries the asset name and its content key, "edited *n* ago" and three
buttons:

| Button | What it does |
|--------|--------------|
| **Diff** | Fetches the server's copy, applies it to a throwaway clone of the asset with the same routine Pull All uses, serialises both with `EditorJsonUtility` and lists the fields that differ (`FieldDiff.Compare`, engine-free, Newtonsoft-flattened `a.b[2].c` paths; `m_*` Unity bookkeeping skipped). "Not on server" and fetch failures are shown in place of the list. For a Progression Set (tab 5) the server fetch is only top-level fields (`name`/`description`/`isActive`) — entries are not fetched — so the comparison is marked **partial**: "no differences" reads as "no differences among the fields that can be compared", not "matches the server", and the footer says entries were not diffed. |
| **Push** | Sends just that asset through the same `StudioIteratorJob` path as Push All (`ContentStudioTool.PushOne`). Items, which normally go up in one bulk call, are sent one at a time here. The tab is *not* stamped — one asset says nothing about the rest. If the asset cannot be pushed (no plan step for it, or the same push already queued), a "Could not push" dialog appears pointing at the Studio's status line. |
| **Revert** | Confirm-gated. Overwrites the asset with the server's copy (`RevertOne` → the same per-type apply as Pull All), saves it and stamps it pushed. Unavailable for Trainer Battles, which have no pull. |

(Rows on tabs whose content type has no content key show the asset name alone, with no key column text.)

Group headers carry **Push group** (the tab's Push All) and the header carries **Push All** for
everything. Offline, the **Diff**, **Push** and **Revert** buttons are all disabled and a banner says why; the list itself still shows, because knowing what is outstanding does not need a server.

What makes per-row pushing honest is that the push log now stamps **per asset** as well as per tab.
`ContentPushLog` keeps `CR_ContentStudio_LastPushUtcTicks_<tab>` for the tab and
`CR_ContentStudio_LastPushUtcTicks_asset_<guid>` for each asset a step covered; an asset counts as
unpushed when its file write time is newer than the *later* of the two (`ContentPushStatus.Evaluate`
3-arg overload, `IsUnpushed`). A tab-wide Push All stamps both; a single push or revert stamps only
the asset — so after pushing two of five edited creatures, the pill correctly says three remain.
The window rebuilds its rows on open, on **Refresh**, and whenever the job runner goes busy→idle,
since that is when the stamps move. The pure pieces — `ReviewRow`, `ReviewGroup`,
`ContentReviewRows.Build/Headline`, `FieldChange`, `FieldDiff` — live in `CR.Core.Data.Logic`
with their tests.

**Guide and Advanced decide how much is said.** Both are header buttons, both remembered per
machine:

| Switch | Default | What it changes |
|--------|---------|-----------------|
| **Guide** | on | The sentence under each section heading: what this content *is*, and what you would normally do here. Wording comes from `ContentSectionCatalog`, which is also where the rail's labels, groups and order come from — so the tool and these docs cannot describe a section two different ways. |
| **Advanced** | off | Reveals the plumbing: raw content keys and ids on every row and in every inspector, the server address field, the all-content Push/Pull bar, `⟲ Restore…`, and `✦ Fix All Addressables`. |

`Advanced` is the old **Debug** button under a name that says what it is for, and it keeps the same
`EditorPrefs` key, so nobody's setting reset. `ContentStudioTool.ShowDebugFields` still exists as a
read-only alias — every inspector that gates a raw id on it is unchanged.

Nothing is *removed* by leaving Advanced off. With it off a list row leads with the human name
(`ContentDisplayName`) and the content key moves to the second line; with it on both are shown.

**Scans are cached, not repeated per repaint.** Answering "what is unregistered", "what is missing
an Addressables entry" and "what has been edited since the last push" costs, on a project this
size, about **100 ms for the registry sweep and another 100 ms for the push-state file stats** —
and all of it used to run on *every repaint*, which capped the window near ten frames a second and
was the reason the Registry tab in particular felt heavy. Each answer now goes through `EditorMemo`,
whose refresh timing is `EditorMemoPolicy` (pure, 7 tests):

- recomputation happens **only on the IMGUI Layout pass**, never between Layout and Repaint — a
  cache expiring mid-frame would change the control count and produce a `Mismatched LayoutGroup`
  error;
- windows are sized to what each answer costs and how fast it can change on its own (registry sweep
  10 s, push state and Addressables 5 s);
- anything the author does that changes an answer — creating, deleting, registering, pushing, fixing
  Addressables — calls `InvalidateScans()`, so the UI updates at once rather than waiting the window
  out.

The header's answer is recomputed from the IMGUI body rather than the editor tick, so an idle
window in the background costs nothing.

### Background jobs and progress

Caching stopped the window re-scanning the project on every repaint, but two problems remained.
The cheap-to-cache answers still had to be *computed* somewhere, and whichever draw paid for a
refresh froze for as long as it took — around 200 ms every few seconds for the registry sweep and
the push comparison. And the genuinely long operations were never cached at all: a **Push All**
made one blocking HTTP request per definition inside the button click, so a few hundred
definitions meant the better part of a minute with a frozen window, no indication of progress, and
no way to stop.

Slow work now runs as a **job**.

| Type | Where | What it is |
|------|-------|------------|
| `StudioJobTracker` | `Core/Data/Logic/` | Progress, status text, cancellation, state machine, queued console lines. Engine-free; 14 tests. |
| `StudioJobQueue` | `Core/Data/Logic/` | Which job is next, and de-duplication by key. Engine-free; 8 tests. |
| `StudioJob` | `Core/Data/Editor/Studio/Jobs/` | Base class: the work, written as an iterator of slices. |
| `StudioIteratorJob` | `Core/Data/Editor/Studio/Jobs/` | A job whose slices come from a lambda, for work that lives inside a window. |
| `StudioJobRunner` | `Core/Data/Editor/Studio/Jobs/` | `[InitializeOnLoad]`; pumps the current job on `EditorApplication.update` within an 8 ms budget. |
| `StudioProgressBar` | `Core/Data/Editor/Studio/Jobs/` | The UI Toolkit strip above the status bar (`cr-jobbar*` in `CRStudio.uss`). |
| `StudioLog` | `Core/Data/Editor/Studio/Jobs/` | Console output under a `[Studio]` prefix. |

**Two yield conventions, and one rule.** A job's iterator always resumes on the **main thread**, so
a slice may freely use the AssetDatabase. `yield return null` ends the slice; the runner keeps
pumping until its 8 ms budget runs out, so short slices batch and a slow one (a blocking HTTP
request) simply takes the whole tick by itself. `yield return someTask` parks the job until that
`Task` completes and then resumes it back on the main thread — which is how work that needs **no**
Unity API (file reading, YAML parsing) gets off the main thread entirely. The one rule a job author
keeps is that the task body touches no Unity API; the tracker is built to be written from either
side.

**One at a time, FIFO.** This is deliberate, not incidental: `_allContentTabs` is a dependency
order (creatures before the spawners that reference them by key), so overlapping pushes would
corrupt content rather than merely confuse the reader. "Push All Content" now queues eleven jobs in
that order instead of running eleven loops.

**Every status transition is also a console line.** The bar is only true while somebody is looking
at it, so phases, summaries and failures are written to the console under `[Studio]`. Per-item
status ("Pushing 12/57: kael") is *not* logged — it changes hundreds of times and would bury
everything else.

**A domain reload cancels a running job.** Jobs therefore write results as they go rather than only
at the end, and the NPC scan caches per file: a script compile costs the current file, not the scan.

What runs as a job today:

- **Push a content type** — the plan (which definitions, which call sends each) is built with no
  network at all, so the bar's total is known before the first request; then one definition per
  tick. Stopping is a real outcome: the tab is deliberately **not** stamped as pushed, and the
  summary says how far it got. The requests themselves are still blocking and still one at a time.
- **Pull a content type** — a single step (a pull is one round-trip plus a burst of asset writes,
  neither half safely divisible), but the bar names the type before the wait starts.
- **The registry sweep and push comparison** — one content type per slice. Because a job can finish
  at any moment, results are published into a pending slot and adopted by the draw code **only on a
  Layout pass** — the same discipline as `EditorMemoPolicy`, for the same reason. The first ask is
  still answered synchronously: an empty cache has nothing to draw, and "nothing is missing" would
  be a wrong answer rather than a slow one.
- **The all-scenes NPC scan** — below.

### NPCs: which scenes is this one actually in?

The NPCs section answers placement for the **whole project**, not for whichever scenes happen to be
open.

It used to use `FindObjectsByType<NpcWorldBehaviour>`, which sees only loaded scenes. An NPC placed
in `Village` therefore read as *unplaced* while the author had `Meadow` open, and the readiness
checklist on `NpcDefinitionEditor` said so — a wrong answer, delivered confidently. Opening every
scene to fix that is worse than the bug: slow, dirtying, and impossible without interrupting
whoever is working.

**So the scan reads the files.** `NpcSceneScanJob` walks every `.unity` under `Assets/`
(build-settings scenes first, so shipping scenes report before vendor demo scenes) plus every
`.prefab`, on a worker thread. No scene is opened and nothing is dirtied.

Prefabs come first because the area scenes place NPCs as prefab **instances** — the scene alone does
not identify them. `NpcPrefabClosure` runs to a fixed point over `m_SourcePrefab` references, so a
*variant* of an NPC prefab, or a set-dressing prefab with an NPC child, counts too and inherits the
base's key unless it names its own.

`NpcScenePlacementParser` (pure, 12 tests pinned to real text from `Village.unity` and
`Test UI.unity`) recognises three shapes, and the UI says which, because they are worth different
amounts of trust:

| `NpcPlacementSource` | Shape |
|----------------------|-------|
| `Component` | An `NpcWorldBehaviour` serialized straight into the scene (`_npcContentKey`, `_npcType`, `m_GameObject` → the GameObject's `m_Name`). |
| `PrefabInstance` | An instance of an NPC prefab; the key is the scene's `_npcContentKey` override, or the prefab's own. |
| `PrefabReference` | The scene references an NPC prefab but overrides nothing on it — inferred from the reference, so the prefab's key applies. |

**Speed comes from not reading what cannot matter.** `NpcScanFileReader.Scan` makes one pass
through a reused character buffer, never materialising a line — the 91 MB scene in this project
would otherwise cost a million short-lived strings to answer a question that is almost always "no".
It looks for `guid:` references and checks whether `m_SourcePrefab` preceded each one, which is how
a prefab instantiation is told from a reference to a mesh. Only files that say "yes" are then read
line by line.

**And from remembering.** Results are cached per file in `Library/CRStudioNpcScenes.json` (never
committed — it describes a working copy, not the project), reused while a file's timestamp *and*
length are unchanged (`NpcScanCachePolicy`). Two fingerprints guard it: one over every prefab
file's state, which skips the whole prefab pass while nothing changed; and one over the *resolved*
prefab answer, because an NPC prefab whose key was edited changes what every unmodified instance of
it means without any scene file being touched.

Measured on this project (207 scenes, 6164 prefabs, ~575 MB of YAML): a cold forced scan finishes
in roughly 15 s in the background while the editor stays responsive; an incremental re-scan with
nothing changed finishes in under 3 s and logs `2 NPC prefab(s) unchanged — skipping the prefab
pass` / `207 scanned, 207 unchanged`.

**In the UI:**

- A strip at the top of the NPCs section reports `Scene placements: 16 across 10 scene(s)`, how
  fresh that is, and a **Scan all scenes** / **Rescan** button (**Full rescan**, which ignores the
  cache, is Advanced-only). Before the first scan it says so and offers one — never a dead end.
- Each NPC row carries `in Village (2), Meadow` as a second line. That is a dictionary lookup into
  `NpcPlacementIndex`, so a row costs nothing; the scan itself is the background job.
- An expanded NPC lists its placements **grouped by scene**, each with **Open scene** (Unity's own
  save prompt, then select and frame the object) or **Select** when that scene is already open.
  `NpcPlacementNavigator` owns both.
- `NpcDefinitionEditor`'s readiness checklist now takes "placed in a scene" from the scan **or**
  from the open scene — the open scene still counts because an NPC dragged in a moment ago exists
  only in memory. Its facts are also memoised now (`EditorMemo`, 3 s): `BuildSnapshot` is four
  project-wide asset sweeps plus a scene search, and this inspector is drawn *inline* inside
  Content Studio's list, so it was re-scanning the project several times a second.

### One way to reach the server

There is **one vocabulary — Push and Pull — at two scopes, and it lives in Content Studio.**

| Scope | Where | What it does |
|-------|-------|--------------|
| One content type | the tab's `⬆ Push All` / `⬇ Pull` | upserts (or reverse-bootstraps) every asset on that tab |
| Everything | the header pill's **Push All** when it reports unsent edits, or the all-content bar's `⬆ Push All Content` / `⬇ Pull All Content` under **Advanced** | runs the above for every content tab; Pull offers a backup first |

Push is an **idempotent upsert keyed by content key**, so pushing a tab is a safe superset of pushing one asset.

**Per-asset sync buttons no longer exist.** Definition inspectors used to carry their own, and they had drifted into eight different spellings of one operation — "Sync to Server", "Sync to Backend", "Sync All Items", "Sync Metadata Only", "Sync Full Config (Pools + Templates)", "Sync Conditions", "Pull Full Config from Server", plus a per-row `Sync` on six tabs — roughly twenty controls in total. Several were *partial* in ways only the label hinted at, so getting content to the server correctly meant knowing which button did the whole job:

- **Ability conditions** went through a second endpoint reached only by "Sync Conditions", so pressing "Sync to Server" alone reported success while the server kept stale conditions. Folding that call into `SyncAbility` looked like the fix and was **reverted the same day**: the endpoint was delete-and-recreate over *shared* rows, so running it once per ability during a bulk push destroyed them (see *Ability Library Authoring*). The endpoint has since been rewritten to upsert; the split is kept anyway, because conditions are shared content edited on their own tab.
- **"Sync Metadata Only"** on a spawner skipped its pools and templates; the tab's Push All has always used `SyncSpawnerFull`.
- **The item inspector's** payload was a different shape from Content Studio's (`effectParametersJson` vs `effectParameters`, no `captureModifier`, and no fetch-merge of server-owned fields like name and base value). The merge-aware bulk path is the one that survived.

#### A push that cannot be completed is refused, not half-applied

Three of these syncs *reconcile*: the payload is treated as the whole truth, and the server retires
whatever is not in it. That is right when the payload really is complete, and destructive when
something was quietly dropped on the way — which is exactly what used to happen.

| Sync | What it used to do | What it does now |
|------|--------------------|------------------|
| Spawner `sync-config` | deleted every pool, then **skipped** templates whose creature key or growth-profile *name* the server did not have, and answered `200 success` — a spawner pushed before its dependencies came out empty and looked fine | resolves the whole payload **before touching the database**; anything missing → `409` naming it, and not so much as a spawner row is created |
| Item spawner `sync-config` | same shape: unresolved item keys skipped, pools replaced with the remainder | same guard, same `409` |
| Progression `sets/sync` | the editor dropped entries whose ability reference was missing, and the server dutifully retired those `(level, slot)` rows | the editor refuses the push and names the levels (`ContentSyncGuard`, pure + 6 tests) |

The refusal text is written to be acted on — *"'meadow-wild-zone' refers to content this server does
not have: creature 'creature_x', growth profile 'Balanced Growth'. Nothing was changed — push that
content first, then retry."* — and both sync helpers now surface the server's `message` instead of
`"Server returned 409: Conflict"`.

An **empty** payload is still honoured: clearing a spawner's pools is a real edit, and it is
distinguishable from a payload the server could not read.

**Push order is dependency order** for the same reason (`_allContentTabs`): creatures, items,
abilities, conditions, growth, progression, curves, then spawners and item spawners, then NPCs and
quests, and **trainer battles last** — a trainer's team names creatures, growth profiles and
progression sets, so all of them have to be on the server before it is pushed. Spawners used to be pushed *before* growth profiles, which is how a first Push All against
an empty server produced spawners with nothing in them.

**Two assets may not share a name** where the server matches by name — progression sets, and growth
profiles (which spawner templates resolve by name). Both would claim one server row, and the second
push would retire the first's entries. `DuplicateNameRule` (pure, 7 tests) refuses the colliding
assets at push time and lets the rest through.

#### A trainer battle push is four writes

**Trainer Battles** (tab 13) syncs like every other tab — a `⬆ Push` on each row, a `⬆ Push` in the
top bar, counted by the header's pending-edits pill, and included in **Push All Content** (ordered
last, above). `ContentCreatorSyncHelper.SyncTrainerBattle(def)` then makes four calls and stops at
the first that fails, reporting which leg it was:

| # | Call | What it writes |
|---|------|----------------|
| A | `PUT /api/v1/spawners/by-content-key/{contentKey}-team` | metadata for the hidden team spawner, including the battle arena key |
| B | `POST /api/v1/spawners/sync-config` | the team itself — one template per slot, `minLevel = maxLevel = level`, growth profile and progression set sent **by name** and resolved server-side |
| C | `POST /api/v1/npc/reset-teams` | discards every account's cached copy of that trainer's team so the new one takes effect |
| D | `PUT /api/v1/npc/content-registry` | the trainer's identity: `npcType: Trainer`, and `isRematchable` from `allowRematch` |

**Leg B's template ids are deterministic, and that is the whole point.** A battle resolves its
opponent by `creature_spawner_template.id`, so slot *n* is written under
`md5("cr-trainer:<contentKey>:slot<n>")` — the digest rendered as raw lowercase hex sliced
8-4-4-4-12, never through `new Guid(bytes)`, whose endianness would render the same digest as a
different string. `CR.Core.Sync.Logic.TrainerContentIds` owns that recipe and the Trainer Battle
Author shares it. `TrainerPushPlan` (pure, pinned against M10020's constants) **recomputes** the ids
from the content key at push time instead of trusting the stored ones, refuses the push when a
stored id disagrees — the content key was renamed, and pushing anyway would orphan the rows the
definition still points at — and the ids that were pushed are restamped into the asset on success.

**Leg C sweeps a cache, not authored content.** NPC teams are regenerated from the templates at the
next encounter, so nothing is lost; without the sweep a re-push is invisible to every account that
has already fought the trainer, including the designer's own test save — which is the iteration loop
this exists to close.

**The push writes the local databases too**, last and non-fatally, after the server has already
accepted it. `TrainerBattleOfflineWriter` builds the SQLite repositories from the `game_config`
connection strings and calls the **real** `SpawnerConfigSyncService` for the templates in game-data
(a hand-written editor mirror would be a second set of matching rules, and they drift), plus a
repo-level replica of the team sweep against player-data — the two live in different files, because
templates are content and cached teams are player state. Designers playtest offline, so this closes
their loop without a floor re-bake; a missing `database_path_*` is reported in the push message
rather than turned into a failed push.

**A trainer's team spawner is never listed on the Spawners tab.** Any `SpawnerDefinition` whose
content key is a `TrainerBattleDefinition`'s content key + `-team` is excluded from that tab's
listing, its Addressables scan and its push loop, and the duplicate
`npc-trainer-meadow-scout-team.asset` has been deleted. Both halves were load-bearing: the Spawners
push goes through `sync-config` **without** ids, so a single **Push All** soft-deleted the
deterministic templates and re-minted random ones — after which every battle against that trainer
500s on a lookup that no longer resolves — and while the asset existed,
`SpawnerDefinitionSyncBehaviour` re-synced it into the local database on every world load, quietly
reverting whatever had just been pushed. The trainer is pushed from its own tab, which sends the ids.

Hand-written migrations are no longer how an existing trainer's team is changed; M10020 remains the
fresh-database seed. Server side, `id` and `progressionSetName` on `sync-config` are documented in
[Backend — Spawner System](?page=backend/03-spawner-system) and `reset-teams` in
[Backend — NPC System](?page=backend/02-npc-system).

#### A blank server value never clears an authored one

Pull overwrites local content — that is its job, and the dialog says so. One case is not that,
though: a server row that has **nothing** in a field. Copying that blank over an authored value
teaches you nothing and destroys something, so `SyncFieldMerge.PreferServerUnlessBlank` (pure, 5
tests) keeps the local value when the server's is empty.

It applies to the fields the server does not always carry: a creature's and an item's `assetKey`,
and a spawner's `battleArenaKey` — every live item row currently has a blank asset key, and 12 of 14
spawners a blank arena key, so the first authored art key or arena would have been erased by the
next Pull All. The NPC `itemSpawnerContentKey` already worked this way after the same bug unlinked
every merchant's stock; the rule is now shared rather than repeated.

Clearing a field is still possible — you do it in the editor, where it is visible, and push it.

#### Conditions repair their own ids

`PUT /status-conditions/{id}` 404s when that id is not a live row, and pushing conditions used to
fail there permanently: a clean server could not be seeded, and an id orphaned by an earlier
delete-and-recreate could never be reconnected. The push now recovers on a 404 — it looks the
condition up **by name** (what actually identifies a shared condition), adopts the server's id into
the asset, or creates the row when the server has none, then pushes again. The asset is saved with
the id it adopted, so the repair is permanent.

**Ability→condition links are pushed with the ability.** They used to be reachable only through the
Ability Workbench's publish, so a Push All produced abilities on the server with none of their
effects attached. Safe now that `sync-conditions` upserts shared conditions by name and only unlinks
what the payload omits — a blank condition name is refused rather than sent.

#### The Registry tab answers "is anything out of step?"

Registry is the whole-project view, so it carries a **STATUS** block: each row states a condition plainly and puts the button that resolves it on the same line, or shows a ✓ and no button when there is nothing to do. Two rows today:

| Row | Condition | Fix |
|-----|-----------|-----|
| Registration | definitions exist on disk but are not in the provider — the game will not see them | **Register All (n)** |
| Push | assets have been edited since the last recorded push | **⬆ Push All Content** (disabled while the server is unreachable) |

The push row is answered by `ContentPushLog` (editor) over `ContentPushStatus` (pure, 13 tests). `ContentPushLog.Stamp(tab)` records the time in `EditorPrefs` when — and only when — a tab's push completes with **zero failures**; a partial push leaves the badge lit rather than reporting content as sent that is not. The state is then each asset's last write time compared against that stamp.

**What this readout does and does not know**, because the wording depends on it:

- It answers *"do I have unsent edits?"*, not *"does the server match?"* — hence "3 of 87 edited since the last push", never "the server is out of date". Answering the second question honestly would mean fetching every content type on every repaint.
- A **teammate's** push is invisible to it (the stamp is per-machine, in `EditorPrefs`, deliberately not committed — a shared file would just make every author's push time collide in version control).
- An asset with **unsaved** edits counts as changed. Its file on disk is still the old one, so a pure file-time check would report in-progress work as already pushed — the one wrong answer this row must never give.
- The existing content signature in the pipeline dashboard (`CRStudioWindow`) is **not** reused here: it hashes only content keys and ids, so it cannot see an edit that changes a creature's stats without renaming it — which is most edits.

Each inspector now ends with a single footer (`ContentStudioLink.DrawFooter`) naming the tab that owns the asset, plus **Open in Content Studio** — which navigates to that tab and selects the asset (`ContentStudioTool.NavigateTo`), and is replaced by a plain note when the inspector is already being drawn inline inside Content Studio.

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

### Content Publish Tool — `Window → Content Studio → Pipeline ▾ → Publish to Server`

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
| `ItemDefinitionEditor` | `ItemDefinition` | Steel blue banner; structured effect/trigger param fields (typed dropdowns — no raw JSON TextArea); condition picker via `GET /ability/status_conditions` |
| `NpcDefinitionEditor` | `NpcDefinition` | Teal banner |
| `SpawnerDefinitionEditor` | `SpawnerDefinition` | Dark green banner; pool/template editing |
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
- `[Add to ContentKeys.Creatures]` button — appears inline below the HelpBox when the content key is missing from `ContentKeys.Creatures`; calls `ContentStudioTool.AddConstantToContentKeys` directly without opening any window

## Removing Content from the Backend

All deletes are **soft-deletes** (`deleted = true`). The row is never physically removed; it disappears from all read queries and sync fetch calls.

### Via Unregister (removing a specific definition)

1. Open the definition in Content Studio (click its row to open the detail panel).
2. Click **Unregister** in the detail panel toolbar — this removes the SO from the `ContentDefinitionProvider` array and clears the selection. The `.asset` file is kept on disk.
3. A dialog appears: **"Also delete from server?"**
   - **Delete from server** → calls `ContentCreatorSyncHelper.DeleteCreature/DeleteSpawner`, which sends `DELETE /api/v1/creatures/by-content-key/{contentKey}` or `DELETE /api/v1/spawners/by-content-key/{contentKey}`. If the server rejects the delete (e.g. 409 for a creature that trainers own), an error dialog shows the server's message and the record is left intact.
   - **Keep on server** → record stays in the backend. It will no longer have a local SO; **⬇ Pull** would recreate one.

> NPC definitions cannot be deleted from the backend this way — NPC rows are per-trainer instances (no global template table to delete from). Delete individual NPC instances via admin tooling or direct SQL.

### Server-only records (no local SO)

When a content key exists on the server but has no local SO (e.g. the `.asset` file was deleted), **⬇ Pull** recreates the local SO and registers it. There is no in-sync "delete server-only record" affordance — to remove a backend record, recreate or select its SO and use **Unregister → Delete from server** (above), or delete it via admin tooling. Creature deletes are still guarded server-side (see below).

### Player-data guard for Creatures

`DELETE /api/v1/creatures/by-content-key/{contentKey}` checks `SELECT COUNT(*) FROM generated_creature WHERE NOT deleted AND base_creature_id = @id`. If any trainer-owned creatures reference the species:

- Backend returns **409 Conflict** with body `{ "message": "X trainer creature(s) are based on this species. Remove them before deleting the template." }`
- The editor surfaces this message in a dialog.
- The `creature` row is **not** deleted.

To delete a creature species that trainers own, first release or delete all their `generated_creature` instances, then retry the delete.

---

## Adding a New Entity

### Adding a new Creature (full pipeline)

This is the most common case and involves the most moving parts. Work through the checklist in order.

#### Step 1 — Create the prefab and mark it Addressable

1. Build or import your creature prefab.
2. In the **Inspector**, tick **Addressable** (this creates an entry in the Addressables Groups window).
3. Set the Addressable **address** to a stable key like `creatures/crabby`. This exact string is what you'll set as `assetKey` on the definition SO in the next step.

> The address is the runtime lookup key — it must exactly match `assetKey` on the `CreatureDefinition`.

#### Step 2 — Create the definition SO and fill it in

Open `Window → CR → Content Studio` → **Creatures** tab → `[+ New]`.

Fill in:

| Field | Example | Notes |
|-------|---------|-------|
| `contentKey` | `creature_crabby` | Snake-case, unique. Must match `content_key` in the backend DB. |
| `assetKey` | `creatures/crabby` | Must exactly match the Addressable address from Step 1. |
| `displayNameKey` | `creature_crabby_name` | Localization key (auto-suggested). |
| `element` | `Water` | Dropdown in the Inspector. |

Click `Create & Register` — the SO is created, added to `ContentDefinitionProvider`, and the `ContentKeys.Creatures` constant is added automatically.

If you created the SO manually (e.g. via right-click → `Create > CR > Content > Creature Definition`), open it in the Inspector: a yellow HelpBox will appear if the constant is missing. Click **`[Add to ContentKeys.Creatures]`** to add it in one click.

#### Step 3 — Add the localization entry

Open `Window → CR → Localization Editor` → **Creatures** tab → **Missing** section. The new creature will appear there. Fill in the English display name and click `[+YAML]`. See [Localization](?page=unity/06-localization).

#### Step 4 — Seed the backend `creatures` row

The backend must have a row in the `creatures` table with a matching `content_key`. Options:

- **Sync from Unity** — use the `[⬆ Push All]` button in the Creatures tab of Content Studio. This calls `PUT /api/v1/creatures/by-content-key/{contentKey}` for each local SO to push its values to the server (creates the row if missing).
- **Manual migration seed** — add the key to the creature seed migration and re-run migrations.

#### Step 5 — Testing in-editor / local dev (no publish required)

`GameAssetLoader.LoadAssetByKeyAsync` first checks the `game_assets` registry (populated by ContentPublishTool). If the asset isn't there yet, **it falls back to loading directly from Addressables by key**. This means:

- As long as the prefab is marked Addressable with the correct address, `CreatureSpawner` and other systems will find it immediately in editor play mode — no ContentPublishTool run required.
- The fallback only triggers on a registry miss, so published production builds are unaffected.

**How the fallback reports itself.** A project that has never published has an *empty* `game_assets`
table, so every single load takes this path — and the loader used to log a **warning** on arrival,
before knowing whether the fallback worked. Icons are re-applied on every panel rebuild, so one
session produced hundreds of warnings, all of them announcing a path that then succeeded, and it
read as "the Addressables build is broken" when nothing was wrong. It now reports by **outcome**:
a key that resolves through Addressables is a `LogDebug`, said **once per key**; only a key that is
in neither the registry *nor* Addressables is a warning, because that one is a genuinely missing
asset. A warning that fires on success is how a console becomes something nobody reads.

#### Step 6 — Publish before shipping (production only)

When you're ready to ship or test against a real server, run `Window → Content Studio → Pipeline ▾ → Publish to Server`. This calls `POST /api/v1/content/publish`, which seeds the `game_assets` table row for the creature's `assetKey`. After that, `LoadAssetByKeyAsync` resolves via the registry (the normal path) rather than the fallback.

---

### Adding a new Item / NPC / Spawner

The flow is the same as creatures with these differences:

| Type | No assetKey needed? | Backend sync | Localization tab |
|------|---------------------|--------------|-----------------|
| Item | No — set `assetKey` to the Addressable address | No direct sync (no backend service) | Items |
| NPC | Not typically | Pull-only (server is authoritative for `npcType`) | NPCs |
| Spawner | No — see backend spawner system | Push via `[⬆ Push All]` → `POST /api/v1/spawners/sync-config` (metadata + pools + templates) | Spawners |

For all types: `[+ New]` in Content Studio creates, registers, and adds the `ContentKeys` constant in one step.

---

## `IGameAssetLoader.LoadAssetByKeyAsync<T>`

`LoadAssetByKeyAsync<T>(assetKey)` takes an Addressables address string (the `assetKey` from a `CreatureDefinition` or equivalent) and returns the loaded Unity asset.

```csharp
var prefab = await _assetLoader.LoadAssetByKeyAsync<GameObject>(def.assetKey);
```

**Resolution order:**

1. **Registry lookup** — queries `game_assets` (via `IAssetDomainService.GetByKeyAsync`) for a row matching `assetKey`. If found, uses the stored `loader_source` (Addressable or Resource) to load.
2. **Direct Addressables fallback** — if the registry returns null (asset not yet published), attempts `Addressables.LoadAssetAsync<T>(assetKey)` directly. This lets unpublished local assets load during development without requiring a ContentPublish run.
3. **Null** — if both fail, returns null and logs a warning.

> Assets loaded via the fallback path are not tracked in `_loadedHandles` so `ReleaseAsset` will not release them. This is intentional for dev builds — the fallback path disappears once the asset is published and the registry path takes over.

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

Three ScriptableObjects form the ability authoring pipeline. None of them has its own sync button — every content type reaches the server the same way, through Content Studio's **⬆ Push All** / **⬇ Pull** (see *One way to reach the server* below). The endpoints each type pushes to are listed here because they are still what runs; `AbilityEditorSyncHelper` (editor-only, blocking HTTP) makes the calls.

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

Pushed by Content Studio → Abilities → ⬆ Push All → `PUT {game_server_http_address}/api/v1/abilities/{id}`, immediately followed by `POST /api/v1/abilities/{id}/sync-conditions` for the ability's status conditions (see *One way to reach the server*).

### `AbilityProgressionSetConfig`

Created via `Assets > Create > CR > Content > Ability Progression Set Config`. Fields:

| Field | Description |
|-------|-------------|
| `id` | Auto-generated stable GUID |
| `setName` | Human-readable label |
| `description` | Optional notes |
| `isActive` | Whether this set is active in the backend |
| `entries[]` | Array of `AbilityProgressionEntry`: `(level, AbilityConfig, abilitySlot 1–4, unlockQuestContentKey)` |

The Inspector shows a per-entry foldout sorted by level and warns on duplicate `(level, slot)` pairs. Entries with a null or ID-less `AbilityConfig` are skipped on sync.

`unlockQuestContentKey` is the entry's **quest gate** (`ability_progression_set_entry.unlock_quest_content_key`, M5019): empty means the ordinary "learn it at `level`" entry, a value means the owning trainer must also have completed that quest. It is drawn as a `ContentPicker.Quests()` dropdown of authored `QuestDefinition` content keys rather than a text box, and it rides the push payload — `/sets/sync` reconciles by `(level, slot)` and rewrites the row from the payload, so an *omitted* gate is an *erased* gate. See [Creature Storage → Authoring a gate](26-creature-storage.md#authoring-a-gate-and-keeping-it-through-sync).

Pushed by Content Studio → Progression → ⬆ Push All → `POST {game_server_http_address}/api/v1/ability-progression/sets/sync`

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

Pushed by Content Studio → Growth → ⬆ Push All → `PUT {creature_server_http_address}/api/v1/growth-profiles/{id}`

### `AbilityEditorSyncHelper`

`CR/Game/World/Editor/AbilityEditorSyncHelper.cs` — Editor-only static helper. Reads `game_server_http_address` from `game_config.yaml` via `Resources.Load<TextAsset>("configuration/game_config")` and uses blocking `System.Net.Http.HttpClient` calls (acceptable in editor context). Returns `(bool ok, string message)` tuples that Content Studio records per asset and shows in the row.

`SyncAbility` pushes **the ability row only**; conditions are pushed from the Conditions tab. Folding the conditions call into it was tried and reverted on 2026-08-30 — at the time `sync-conditions` was destructive (see below). The endpoint is safe now, but the split is kept deliberately: a shared condition is content in its own right, and the tab that lists it is where it should be edited and pushed.

`POST /api/v1/abilities/{id}/sync-conditions` **reconciles this ability's links to shared conditions, and never deletes a condition** (rewritten 2026-08-30). Name is the natural key, matching the unique index:

- a name that does not exist yet is **created**, with the stat changes the ability supplied;
- a name that already exists is **reused as-is** — a shared definition is owned by the Conditions tab, and an ability push has no business rewriting a duration or stat change that other abilities depend on;
- what is genuinely per-ability — `probability` and `applyToUser` — is written to the `ability_status_conditions` **link** row;
- a condition dropped from the payload is **unlinked, not deleted**.

The response reports `conditionsCreated` / `conditionsReused` so a push says which happened.

> **What it used to do, and why the Push All on 2026-08-30 hurt.** It soft-deleted every condition linked to the ability — renaming each to `<name>_<id>` to get around `IX_status_conditions_name`, then UNIQUE across the whole table including deleted rows — and re-inserted fresh rows with **new GUIDs**. Because those conditions are shared, running it once per ability across a bulk push soft-deleted 7 of 9 of them, dropped every `ability_status_conditions` link, orphaned the authored ids (their own `PUT /status-conditions/{id}` then 404s, since it requires `deleted = false`), and returned 409 whenever a re-insert hit a name still live. Some rows were renamed twice — `Grounded_<id>_<id>` — and the concatenation eventually overflowed `varchar(100)`. Migration **M10021** replaces that index with a partial unique index on `(name) WHERE deleted = false`, so retired rows keep their names and nothing has to mangle data to make room. The relaxation lands on Postgres only — on SQLite the uniqueness was never a droppable index in the first place: `M1021` rebuilt the table with an inline `name TEXT NOT NULL UNIQUE` constraint, which SQLite backs with an internal `sqlite_autoindex_…` no `DROP INDEX` can reach. Every SQLite database (the baked floor, player saves, online caches) therefore keeps table-wide uniqueness on `name` regardless; only Postgres — the engine `POST /abilities/{id}/sync-conditions` actually runs against — gets the fix.

#### Bidirectional sync support

`AbilityEditorSyncHelper` also provides fetch and apply methods used by the Content Studio **⬆ Push All** / **⬇ Pull** actions (tabs 4–6):

**Server response DTOs** (defined in the same file, `namespace CR.Game.World.Editor`):

| Type | Fields |
|------|--------|
| `ServerAbilityDto` | `id`, `name`, `description`, `elementType` (int), `power`, `accuracy`, `cost`, `priority`, `targetType`, `category`, `animationKey`, `updatedAt` |
| `ServerGrowthProfileDto` | `id`, `name`, `description`, `experienceGrowth` (float), `hitPointsGrowth`, `attackGrowth`, `defenseGrowth`, `specialAttackGrowth`, `specialDefenseGrowth`, `speedGrowth`, `updatedAt` |
| `ServerProgressionSetDto` | `id`, `name`, `description`, `isActive`, `updatedAt`, `entries` (list of `ServerProgressionEntryDto`) |
| `ServerProgressionEntryDto` | `level`, `abilityId`, `abilitySlot`, `unlockQuestContentKey` (null = ungated) |
| `ServerStatusConditionDto` | `id`, `name`, `applyToUser`, `probability`, `durationTurns` (nullable int), `statChanges` (list of `ServerStatChangeDto`) |

**Fetch methods** — blocking GET calls using `System.Text.Json.JsonDocument` (not `JsonUtility`; required for top-level JSON arrays):

| Method | Endpoint |
|--------|----------|
| `FetchAllAbilities()` | `GET /api/v1/abilities` |
| `FetchAllGrowthProfiles()` | `GET /api/v1/growth-profiles` |
| `FetchAllProgressionSets()` | `GET /api/v1/ability-progression/sets` |
| `FetchAllStatusConditions()` | `GET /api/v1/status-conditions?limit=500` |

**Status condition CRUD** — used by the Content Studio Conditions tab (tab 8):

| Method | HTTP call | Returns |
|--------|-----------|---------|
| `CreateStatusCondition(dto)` | `POST /api/v1/status-conditions` | `(bool ok, string message, string id)` |
| `UpdateStatusCondition(id, dto)` | `PUT /api/v1/status-conditions/{id}` | `(bool ok, string message)` |
| `DeleteStatusCondition(id)` | `DELETE /api/v1/status-conditions/{id}` | `(bool ok, string message)` |

Each returns `(bool ok, string error, List<T> data)`.

**Apply-from-server methods** — update a local SO in-place from a server DTO:

| Method | Notes |
|--------|-------|
| `ApplyToAbility(config, dto)` | Copies all fields; converts `elementType` int back to string via reverse lookup |
| `ApplyToGrowthProfile(config, dto)` | Copies all growth fields |

**Element type reverse lookup** — `IntToElementType` dictionary maps server int values (0–11) back to the `elementType` string used by `AbilityConfig`.

### Spawner Template `abilityProgressionSet` Field

`SpawnerTemplateConfig.abilityProgressionSet` is now a `AbilityProgressionSetConfig?` SO reference (previously a raw UUID string). The `SpawnerDefinitionEditor` renders it as an object drag field with a warning if empty. Both `SpawnerSyncHttpClient` and `LocalSpawnerSyncClient` read `t.abilityProgressionSet?.id` to extract the UUID.

### Ability Sync Workflow (Tabs 4–6 in Content Studio)

The Abilities, Progression Sets, and Growth Profiles tabs in **Content Studio** each have **"⬆ Push All"** and **"⬇ Pull"** buttons (plus a per-row **Sync** button). (These tabs formerly lived in the standalone `AbilityLibraryTool` window.) Sync is drift-free — no fetch-compare or conflict resolution.

#### Push All / Pull workflow

- **⬆ Push All** — upserts every local SO on the tab via `SyncAbility` / `SyncProgressionSet` / `SyncGrowthProfile` (matched on server `id`). Reports `N pushed, M failed`.
- **Per-row Sync** — pushes a single SO and shows the `(ok, message)` result inline.
- **⬇ Pull** (confirm-gated) — fetches all server records, then `ApplyTo*` overwrites each matching local SO (by `id`), or `CreateAssetSilent` creates one for server-only records. Reports `N updated, M created`.

#### Progression Set pull note

On **Pull**, only the top-level fields (`name`, `description`, `isActive`) of a Progression Set are updated. Entries are **not** overwritten — they reference `AbilityConfig` SOs by object reference and cannot be reconstructed from server UUIDs without a full lookup pass. Update entries manually.

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

## Content Studio's shell is UI Toolkit

Content Studio's chrome was rebuilt on the same design system as the Trainer Battle Author
(`Core/Data/Editor/UI/ContentStudio.uxml` + the shared `CRStudio.uss`):

- **Header** — the CONTENT STUDIO wordmark, live count chips (creatures / items / NPCs /
  spawners / quests), the server-address field with its apply button, a **connection pill**
  (coloured dot *and* the word CONNECTED / DISCONNECTED / CHECKING — never colour alone;
  click it to re-ping), plus Pipeline ▾ and Refresh.
- **Navigation rail** — the sixteen tabs, grouped CONTENT / WORLD / COMBAT / SYSTEM, each row
  carrying a live count badge. It replaces a single cramped row of toolbar toggles.
- **Status bar** — the tab's own summary ("Creatures — 15 item(s).") until something has
  something to say, then the message, tinted by severity.

`CRStudio.uss` is the shared editor design system (`cr-` classes): cool near-black ground,
layered surfaces, 1px borders, the house accent `#4b9cd3` for selection, and no USS property
Unity does not actually support (no box-shadow, no gradients). New CR editor windows should
add this sheet rather than inventing a palette.

**The tab bodies are deliberately still IMGUI**, hosted in an `IMGUIContainer` that draws the
section heading, the all-content bar when Advanced is on, and the unchanged `DrawActiveTab()`. The facelift replaces the chrome around
roughly two thousand lines of working field logic instead of putting it at risk; tabs can be
migrated to UI Toolkit one at a time behind the same shell.

## The Auth section (SYSTEM › Auth)

The one place the editor's server credentials are managed (`Core/Data/Editor/StudioAuthPanel.cs`,
wording and verdicts from the tested pure-logic `Core/Data/Logic/EditorAuthStatus.cs`). Two
halves, matching the two auth flows that exist:

- **Editor → Server (content pushes).** Every push authenticates with a short-lived
  `ContentWrite` JWT minted by exchanging the **service key** at `POST /auth/service-token`
  (`Game/World/Editor/EditorServiceAuth.cs`; the server side reads `EditorServiceKey` from its
  config). The panel shows the key **masked** (tail-4 only, revealable on click), says whether
  the built-in local-dev key or a custom one is in use, and edits go through a draft
  `PasswordField` so a half-typed key is never live. The key is stored in **EditorPrefs
  (`CR_EditorServiceKey`) on this machine only** — never in the repo, never in a build.
  **Test authentication** runs the two-step probe — key exchange, then an authorized GET
  against a content endpoint — because "wrong key" (401 on the exchange) and "wrong
  scope/policy" (403 on the probe) are different repairs. **Forget cached tokens** clears the
  per-server token cache; saving or resetting the key does that automatically.
- **Player Login (game clients).** Probes the anonymous device flow by POSTing a made-up
  device id at `/auth/game`. A **healthy server refuses it (401)** — a token for a device it
  has never seen is the failure. 400 and 404 each get their own message naming the stale
  server build that produces them.

Advanced adds the plumbing: the resolved server address, the raw token-expiry epoch, and where
the key is stored. Nothing in the panel ever logs or renders the raw key except an explicit
Reveal click.

## Names people can read, ids behind Advanced

Content keys are internally consistent but were written by different hands —
`creature_wolfpup`, `npc-trainer-meadow-scout`, `item_heal_potion_30`, `meadow-wild-zone`. Read
raw in a list they are noise, and each tool humanised them slightly differently, which is what
made the editors feel inconsistent.

**`ContentDisplayName`** (`Core/Data/Logic`, pure + 15 EditMode tests) is now the single rule:
strip the leading type prefix, split on `_`/`-`, title-case the words, and leave casing inside a
word alone so `item_restore_HP` stays "Restore HP". `Prefer(authoredName, key)` lets an authored
name win — a designer who typed "Scout Maren" meant it. The key itself is never rewritten; this
is presentation only.

**`ContentPicker`** (`Core/Data/Editor`) replaces the free-text fields that point at other
content. Typing `StormTide` or `meadow-arena` by hand is how you get content that looks authored
and silently does nothing, because nothing validates a misspelt key until the battle starts. The
picker draws a dropdown of readable names, stores the key, and sources options from the project:
progression sets, growth profiles, damage curves, items, and battle arenas (unioned from
spawners, trainers, **and** the `BattleArena` components in open scenes — no single source knows
them all).

A value that is not in the list is never silently replaced. It stays selected and raises a
warning naming the offending text, because a dangling reference is exactly what you want to see.

`TrainerBattleDefinition` gets a custom inspector on this: the arena and each slot's move list
are dropdowns, and the derived spawner-template id is read-only (the Author window's "Wire team"
step owns it).

### Advanced detail (formerly "Debug mode")

Unity's own Debug inspector mode is per-Inspector and cannot reach a custom `EditorWindow`, so
Content Studio has its own: the **Advanced** toggle in the header (lit while on). With it off you
see names; with it on every raw key and id appears dimmed beneath its field, along with the rest of
the plumbing listed under *Reading the window*.

It was called **Debug** when it only revealed ids. The name changed once it also decided whether the
server field, the all-content sync bar and the recovery actions were on screen — "debug" implied
something diagnostic and optional, when what it really controls is how much of the machinery an
author wants in front of them. The `EditorPrefs` key is unchanged, so an existing setting carries
over, and `ContentStudioTool.ShowDebugFields` remains as a read-only alias of `ShowAdvanced` for the
inspectors that gate raw ids on it.

### What the sweep fixed

The picker/debug rules were then applied everywhere they were missing (one agent per area,
compiled together):

- **Spawn pools and spawners** — creature content key, growth profile, variant type, the
  `abilityProgressionSetId` GUID and the spawner's own arena key are dropdowns. ~215 lines of
  live-server **Fetch** machinery (UnityWebRequest calls, hand-rolled response parsing,
  GenericMenu pickers) were deleted: options come from project assets and are simply *there*.
  The old hardcoded variant list was also **wrong** — it offered `shadow`, which nothing
  consumes at runtime, and omitted `rare`. The dropdown is now derived from the
  `CR.Game.Model.Spawner.VariantType` enum, which is the only truth (the server stores the
  lowercase name), including in `SpawnerTemplatesListView`.
- **Definition inspectors** — the Ability Progression Set, Growth Profile and Ability editors
  each rendered a raw `ID …` row unconditionally; all are gated behind Debug now. The creature
  editor's progression-set/growth-profile fields and the item editor's evolution-target creature
  id became immediate dropdowns (server pull demoted to an optional extra).
  VFX/SFX key fields were deliberately left as text: they are the asset's *own* identity keys
  derived from its AssetReference address, not references into another content list.
- **Trainer battles** now have a Content Studio tab of their own, under CONTENT.
- **The Registry tab could not be scrolled.** `DrawContentProviderTab` still opened its own
  `BeginScrollView` from before the chrome rebuild — nested inside the shared one *and reusing
  the same `_listScroll` field*, so the inner call clobbered the field mid-layout, and with no
  bounded height it grew to full content height instead of clipping. Removing the leftover pair
  fixed it.
- **NPCs** got the Trainer-Author treatment: readable name first, a readiness checklist
  (`NpcAuthorChecklist`, pure + 38 tests) covering identity, type, merchant stock, trainer team,
  a quest that names it, registry membership and scene placement, with one-click fixes. Its
  "Open in Content Studio" button was dead for two reasons — it called `ShowWindow()`, which
  never selects anything, *and* it was drawn inside Content Studio's own inline inspector, where
  there is nowhere to go. It now calls `NavigateToNpc` and says "Already open in Content Studio"
  in that context instead of offering a no-op.

## When the editor falls behind the data model

Two fields on `CreatureDefinition` — `abilityProgressionSetId` and `growthProfileId` — showed
`(none)` on **every** creature, with a "Pull from server" button that could never succeed. They
were not missing content. cr-api's **`M1023RemoveProgressionFieldsFromCreature`** dropped both
columns from the `creature` table; the baked `game-data.bytes` confirms they are gone.

A species no longer decides how its instances level. Each *generated* creature takes a
progression set and growth profile from whatever produced it — the spawn template
(`creature_spawner_template`, which is why those DO carry values), a trainer's team slot, or
`StarterCreatureService` — and they are stored on the generated creature, which is what
`CreatureProgressionService` reads.

The fields were removed, along with the inspector rows, the two `ContentAuditTool` checks that
could never fire, and the push/pull mappings in `ContentCreatorSyncHelper` (which were sending
and parsing fields the server does not have). `ServerCreatureDto` now mirrors the real wire
shape. The 15 creature assets were re-saved through Unity's serializer to drop the dead YAML.

### The same drift, treated differently: spawner capacity and cooldown

`SpawnerDefinition.maxCapacity` and `spawnCooldownSeconds` are a *different* case with the same
symptom. The columns still exist and still round-trip, but **the spawn service enforces neither** —
spawning is stateless, and a wild creature is generated fresh on demand. One editor even marked
Max Capacity as required (`*`).

Deleting these would fight a schema that still has them, so they are kept and **labelled
honestly** instead: the inspector section reads "Capacity & Timing (recorded, not enforced)" with
a note, the tooltips say the same, and the required markers are gone. An author tuning those
numbers now knows nothing will change.

**The check that finds this class of bug:** compare a definition's fields against three things —
the columns in `game-data.bytes`, the sync DTO, and whether any *runtime* (non-editor) code reads
the field. A field that fails all three is dead; one that survives only in the schema is inert and
should say so.

## Related Pages

- [Content Pipeline (Two-Database Model)](?page=unity/17-content-pipeline) — game-data vs player-data, baked artifact, Addressables content patching
- [Dependency Injection](?page=unity/02-dependency-injection) — how singletons like `IGameContentRegistry` are registered
- [Localization](?page=unity/06-localization) — resolving `DisplayNameKey` strings via `ILocalizationRepository`
- [World Behaviours](?page=unity/03-world-behaviours) — `NpcWorldBehaviour` and `SpawnerWorldBehaviour` use content keys at bootstrap
- [NPC Interaction](?page=unity/04-npc-interaction) — content keys appear in `NpcTrainerBehaviour` Inspector fields
- [Battle System](?page=unity/07-battle-system) — content keys identify creatures involved in a battle
- [Asset Management](?page=backend/10-asset-management) — `game_assets` table, version check, content publish pipeline
- [Battle Persistence](?page=backend/09-battle-persistence) — backend battle tables reference creatures by content key
