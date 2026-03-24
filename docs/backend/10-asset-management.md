# Asset Management

The asset management system connects binary game content (sprites, audio, prefabs) hosted on a CDN to the backend's asset manifest and to the Unity client's offline SQLite cache. The three systems are linked exclusively by a string `asset_key`, which is also the Addressables address or Resources path used at load time.

## Three-System Architecture

```
┌──────────────────────────────────────────────────────────────────────────┐
│                         Addressables CDN                                 │
│  Binary content bundles — sprites, audio, prefabs, etc.                 │
│  Addressed by asset_key string (e.g. "creatures/cindris")               │
└──────────────────────┬───────────────────────────────────────────────────┘
                       │  asset_key
┌──────────────────────▼───────────────────────────────────────────────────┐
│                    cr-api Backend                                        │
│  game_assets table — asset manifest (key → name, type, loader_source)   │
│  app_config table  — singleton row tracking content_version             │
│  Endpoints: GET /game-assets, POST /content/publish, GET /version-check │
└──────────────────────┬───────────────────────────────────────────────────┘
                       │  asset_key + sync
┌──────────────────────▼───────────────────────────────────────────────────┐
│                    Unity Client (local SQLite)                           │
│  Offline cache of game_assets rows — IGameAssetLoader resolves keys     │
│  VersionCheckClientUnityHttp — checks content_version on startup        │
└──────────────────────────────────────────────────────────────────────────┘
```

The CDN holds the actual binary content. The backend holds the manifest (what keys exist, what type they are, how to load them). The client caches the manifest locally so asset loading works offline. The `asset_key` string is the only shared identifier across all three layers — no UUIDs cross the CDN boundary.

## `game_assets` Table

Stores the asset manifest. One row per addressable asset.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | UUID | PK | Internal identifier |
| `key` | TEXT | UNIQUE NOT NULL | Addressables address / Resources path (e.g. `"creatures/cindris"`) |
| `name` | TEXT | | Human-readable label for tooling |
| `asset_type` | TEXT | | Category string (e.g. `"Creature"`, `"Item"`, `"UI"`) |
| `loader_source` | TEXT | | Load strategy hint (`"Addressables"` or `"Resources"`) |
| `deleted` | BOOLEAN | NOT NULL DEFAULT false | Soft delete flag |
| `created_at` | DATETIME | NOT NULL | Audit timestamp |
| `updated_at` | DATETIME | NOT NULL | Audit timestamp |

### `IGameAssetRepository`

```csharp
public interface IGameAssetRepository
{
    Task<GameAsset?> GetByKeyAsync(string key, CancellationToken ct = default);
    Task<IReadOnlyList<GameAsset>> GetAllAsync(CancellationToken ct = default);
    Task<GameAsset> CreateAsync(GameAsset asset, CancellationToken ct = default);
    Task<GameAsset> UpdateAsync(GameAsset asset, CancellationToken ct = default);
}
```

### `IAssetDomainService` and `GetOrCreateAsync`

`AssetDomainService` provides the `GetOrCreateAsync` pattern used by the content publish pipeline:

```csharp
public interface IAssetDomainService
{
    Task<GameAsset> GetOrCreateAsync(string key, string name, string assetType,
        string loaderSource, CancellationToken ct = default);
    Task<GameAsset?> GetByKeyAsync(string key, CancellationToken ct = default);
    Task<IReadOnlyList<GameAsset>> GetAllAsync(CancellationToken ct = default);
}
```

`GetOrCreateAsync` looks up the asset by `key`. If found, it updates the `name`, `asset_type`, and `loader_source` fields and saves. If not found, it inserts a new row. This is idempotent — calling it twice with the same key is safe and results in one row.

## `app_config` Table

Stores a single configuration row for the entire application. The singleton pattern is enforced by a fixed primary key value.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | TEXT | PK DEFAULT `'singleton'` | Always `'singleton'` — enforces one row |
| `content_version` | TEXT | | Current published content version string (e.g. `"2026.03.20-1"`) |
| `min_client_version` | TEXT | | Minimum client build version that can play online (e.g. `"1.2.0"`) |
| `deleted` | BOOLEAN | NOT NULL DEFAULT false | Soft delete flag (not used in practice for this table) |
| `created_at` | DATETIME | NOT NULL | Audit timestamp |
| `updated_at` | DATETIME | NOT NULL | Audit timestamp |

The row is seeded by migration `M8005CreateAppConfigTable` with empty version strings. The `content_version` field is updated each time `POST /api/v1/content/publish` runs successfully.

### `IAppConfigRepository`

```csharp
public interface IAppConfigRepository
{
    Task<AppConfig?> GetAsync(CancellationToken ct = default);
    Task<AppConfig> UpsertAsync(AppConfig config, CancellationToken ct = default);
}
```

`GetAsync` always returns the singleton row (or null if the table is empty). `UpsertAsync` writes to the fixed `'singleton'` key.

## Endpoints

### `GET /api/v1/version-check`

Unauthenticated. Called by the Unity client on startup before world bootstrap to determine whether a content sync or client update is required.

**Query parameters:**

| Parameter | Description |
|-----------|-------------|
| `v` | Client's current cached `content_version` string |
| `cv` | Client's build version string (from the installed binary) |

**Response:**

```json
{
  "content_version":        "2026.03.20-1",
  "min_client_version":     "1.2.0",
  "content_update_required": true,
  "client_update_required":  false
}
```

**Semantics:**

- `content_update_required = true` when `v` does not match `app_config.content_version`. This means the client's cached asset manifest is stale and should sync in the background. Online play can still proceed while the sync runs.
- `client_update_required = true` when `cv` is lower than `app_config.min_client_version`. This means the installed binary is too old to communicate correctly with the server. `GameSessionManager` blocks online play when this flag is set.

**Unity side:** `GameSessionManager` injects `IVersionCheckRepository` and calls version check in `Start()` before `InitializeAsync()`. It sets `ClientUpdateRequired` and `ContentUpdateRequired` properties that other systems can read.

### `GET /api/v1/game-assets`

Unauthenticated. Returns all non-deleted rows from `game_assets`. Used by the Unity client to sync its local SQLite asset manifest cache.

**Response:** array of asset objects:

```json
[
  {
    "id": "...",
    "key": "creatures/cindris",
    "name": "Cindris",
    "assetType": "Creature",
    "loaderSource": "Addressables"
  }
]
```

### `GET /api/v1/game-assets/{key}`

Unauthenticated. Returns a single asset record by its string key. Returns 404 if not found.

### `GET /api/v1/content/manifest`

Unauthenticated. Returns a single JSON object containing four lists of content definitions — creatures, items, NPCs, and spawners — keyed by their `content_key`. This is the primary endpoint Unity clients and tooling use to discover what content exists in the backend database.

**Response:**

```json
{
  "creatures": [
    { "contentKey": "cindris", "name": "Cindris", "elementType": "Fire", "assetKey": "creatures/cindris" }
  ],
  "items": [
    { "contentKey": "potion", "name": "Potion", "assetKey": null }
  ],
  "npcs": [
    { "contentKey": "npc_merchant_01", "npcType": 0, "name": "Shop Keeper" }
  ],
  "spawners": [
    { "contentKey": "forest_zone_a" }
  ]
}
```

**Filtering rules:**
- Creatures: all non-deleted rows from the `creature` table, ordered by `content_key`.
- Items: only non-deleted rows in the `item` table that have a non-null `content_key` (i.e. rows that have been through migration M6004 or were seeded with a key).
- NPCs: distinct content templates, grouped by `content_key`. When multiple NPC instance rows share the same `content_key`, the minimum `npc_type` and name are returned. Rows with a null `content_key` are excluded.
- Spawners: distinct non-deleted rows with a non-null `content_key`, ordered by `content_key`.

**`npcType` values** (maps to `CR.Game.Model.Npcs.NpcType`):

| Value | Enum name |
|-------|-----------|
| 0 | Merchant |
| 1 | Trainer |
| 2 | Npc |
| 3 | QuestGiver |

**Implementation:** `IContentManifestRepository.GetManifestAsync()` runs four Dapper queries against the same connection and assembles the `ContentManifestResponse` record. The base implementation lives in `BaseContentManifestRepository`; concrete subclasses are `CR.Game.Data.Postgres.ContentManifestRepository` and `CR.Game.Data.Sqlite.ContentManifestRepository`.

### `POST /api/v1/content/publish`

Pipeline-only. Called by the CI/CD pipeline after a successful content build to register new/updated asset keys and bump the `content_version`.

**Authentication:** `X-Pipeline-Key` request header. The key is validated against a configured pipeline secret. Requests without a valid key receive 401.

**Request body:**

```json
{
  "content_version": "2026.03.20-1",
  "assets": [
    {
      "key": "creatures/cindris",
      "name": "Cindris",
      "asset_type": "Creature",
      "loader_source": "Addressables"
    },
    {
      "key": "items/potion",
      "name": "Potion",
      "asset_type": "Item",
      "loader_source": "Addressables"
    }
  ]
}
```

**Behavior:**

1. For each asset in the `assets` array, calls `IAssetDomainService.GetOrCreateAsync(key, name, assetType, loaderSource)`. This is idempotent — existing rows are updated, new rows are inserted.
2. After all assets are processed, calls `IAppConfigRepository.UpsertAsync` to set `app_config.content_version` to the provided `content_version`.

**Response:** 200 OK with a summary of how many assets were created vs updated.

**Editor tool:** The Unity Editor window at `Window > CR > Publish Content` (`ContentPublishTool.cs`) provides a GUI for triggering a content publish during development. It reads the pipeline key and server address from `game_config.yaml` and posts the current `ContentDefinitionProvider` asset list to the configured server.

## DI Wiring

```csharp
// Program.cs (CR.REST.AIO)

// Repositories — both keyed (for REST endpoints) and non-keyed (for domain services)
builder.Services.AddSingleton<IGameAssetRepository>(new GameAssetRepository(logger, configuration));
builder.Services.AddKeyedSingleton<IGameAssetRepository, GameAssetRepository>("game_assets");

builder.Services.AddSingleton<IAppConfigRepository>(new AppConfigRepository(logger, configuration));
builder.Services.AddKeyedSingleton<IAppConfigRepository, AppConfigRepository>("app_config");

// Domain service
builder.Services.AddSingleton<IAssetDomainService, AssetDomainService>();

// Endpoint mapping
app.MapGameAssetEndpoints();
app.MapVersionCheckEndpoints();
app.MapContentPublishEndpoints();
```

`ServiceCollectionExtensions.cs` exposes `AddAssetDomainServices` which registers `IAssetDomainService`. This is called from `Program.cs` alongside the other domain service registrations.

## Unity Client — Content Manifest

The Unity client fetches the content manifest on startup via `ContentManifestClientUnityHttp`, which implements `IContentManifestRepository`:

```csharp
public interface IContentManifestRepository
{
    Task<ContentManifestResponse?> FetchManifestAsync();
}
```

`ContentManifestClientUnityHttp` extends `SimpleWebClient`. It uses `GameConfigurationKeys.GameServerHttpAddress` (`"game_server_http_address"`) from `game_config.yaml` as its base URL and calls `GET /api/v1/content/manifest`. The response is deserialized by Newtonsoft into `ContentManifestResponse` (lists of `CreatureManifestEntry`, `ItemManifestEntry`, `NpcManifestEntry`, `SpawnerManifestEntry`).

The response populates a `ServerContentRegistry`, which is installed into the `MutableContentRegistry` that all game systems inject as `IGameContentRegistry`. If the fetch fails or returns null, the client keeps the local `ScriptableObjectContentRegistry` loaded from the `ContentDefinitionProvider` SO asset.

See [Content Registry](?page=unity/08-content-registry) for the full hot-content architecture.

## CDN Setup

Addressables bundles are hosted on an S3-compatible CDN. For local development, MinIO can stand in for AWS S3 at zero cost. The scripts and Unity tool support both.

### Local dev: MinIO

MinIO is an open-source, S3-compatible object store you can run locally in Docker.

**Start MinIO:**

```bash
docker run -p 9000:9000 -p 9001:9001 \
  -e MINIO_ROOT_USER=minioadmin \
  -e MINIO_ROOT_PASSWORD=minioadmin \
  quay.io/minio/minio server /data --console-address ":9001"
# Admin console: http://localhost:9001
```

**One-time bucket setup:**

```bash
./scripts/setup-minio-bucket.sh <bucket-name> [endpoint] [access-key] [secret-key]

# Defaults: endpoint=http://localhost:9000, access-key=minioadmin, secret-key=minioadmin
./scripts/setup-minio-bucket.sh cr-content-dev
```

The script creates the bucket and applies an anonymous read policy so Addressables can download without credentials.

**Addressables Remote Load Path (MinIO):**

```
http://localhost:9000/<bucket>/content/[BuildTarget]
```

**Deploy to MinIO:**

```bash
./scripts/deploy-content.sh cr-content-dev StandaloneOSX us-east-1 default http://localhost:9000
```

### Production: AWS S3

### One-time bucket creation

```bash
# From the cr-data repo root
./scripts/setup-s3-bucket.sh <bucket-name> [region] [aws-profile]

# Example
./scripts/setup-s3-bucket.sh cr-content-prod us-east-1 default
```

The script:
1. Creates the S3 bucket
2. Disables block-public-access
3. Applies a public-read bucket policy
4. Sets a CORS rule (required for WebGL builds)

IAM permissions required: `s3:CreateBucket`, `s3:PutBucketPolicy`, `s3:PutPublicAccessBlock`, `s3:PutBucketCors`.

**Addressables Remote Load Path (AWS S3):**

```
https://<bucket>.s3.<region>.amazonaws.com/content/[BuildTarget]
```

Set the **Remote.LoadPath** profile variable in the Addressables Groups window to the appropriate URL for your environment. The `[BuildTarget]` variable is substituted at build time (e.g. `StandaloneOSX`, `Android`). Bundles for each platform land in their own prefix so they don't collide.

### Deploying content

After running an Addressables content build (which writes to `My project/ServerData/<BuildTarget>/`):

```bash
# AWS S3
./scripts/deploy-content.sh <bucket> <build-target> [region] [profile]

# MinIO / custom endpoint (5th arg)
./scripts/deploy-content.sh <bucket> <build-target> [region] [profile] <endpoint-url>
```

The script uploads in three passes with intentional cache-control ordering:

| Pass | Files | Cache-Control |
|------|-------|---------------|
| 1 | `*.bundle` | `max-age=31536000, immutable` — bundles are content-addressed; safe to cache for a year |
| 2 | `*.hash` | `max-age=60` — clients check this to decide if the catalog changed |
| 3 | `*.json` | `max-age=60` — the catalog itself; short cache so new entries are picked up quickly |

Bundles first, hash second, catalog last ensures clients never see a new catalog pointing to bundles that haven't been uploaded yet. `--acl public-read` is only applied for real AWS; MinIO access is controlled by the bucket policy set at setup time.

### Unity Editor deploy window

`Window → CR → Deploy Content` opens `ContentDeployTool.cs`, which wraps both scripts in a GUI:

- **Bucket Name / Region / AWS Profile** — saved in `EditorPrefs` (not committed to git)
- **Custom Endpoint URL** — set to `http://localhost:9000` for MinIO; leave empty for real AWS. When set the window banner turns teal and the setup/deploy buttons switch to MinIO mode
- **Run setup-minio-bucket.sh / Run setup-s3-bucket.sh** — one-time setup button (switches based on endpoint)
- **Build Addressables** — calls `AddressableAssetSettings.BuildPlayerContent()` (requires `CR_ADDRESSABLES` define)
- **Deploy** — runs `deploy-content.sh` via `/bin/bash`, passing the endpoint URL when set
- **Build Addressables + Deploy** — runs both in sequence

### Bucket layout

Supported platforms and their Unity build target folder names:

| Platform | Build target folder |
|---|---|
| macOS | `StandaloneOSX` |
| Windows | `StandaloneWindows64` |
| Steam Deck / Linux | `StandaloneLinux64` |

```
cr-content-prod/
  content/
    StandaloneOSX/
      catalog_2026.03.20.json
      catalog_2026.03.20.hash
      creatures_assets_all_<hash>.bundle
      items_assets_all_<hash>.bundle
    StandaloneWindows64/
      ...
    StandaloneLinux64/
      ...
```

For Steam Deck, use `StandaloneLinux64` — SteamOS is Arch-based Linux; there is no Steam Deck-specific Unity build target. Use IL2CPP scripting backend and Vulkan graphics API in Player Settings for best compatibility.

## Source Asset Folder Convention

Source prefabs, sprites, audio, and other content assets live under `Assets/CR/Content/` organised by domain:

```
Assets/CR/Content/
  Creatures/     ← creature prefabs and sprites (e.g. Cindris.prefab)
  Items/         ← item icons and prefabs
  NPCs/          ← NPC prefabs
  Spawners/      ← spawner zone prefabs
  UI/            ← UI art not covered by other domains
```

**The folder location has no effect on deployment.** Addressables are identified by their *address string*, not their file path. Unity compiles source assets into content-addressed `.bundle` files during a build — the deploy script only ever touches `ServerData/[BuildTarget]/`, never `Assets/`.

The only string that must match across all layers is the **address / asset_key**:

```
Assets/CR/Content/Creatures/Cindris.prefab   ← source, location is arbitrary
  └─ Addressable address: "creatures/cindris" ← set in Addressables inspector
       └─ stored in: creature.asset_key = "creatures/cindris"
            └─ loaded by: IGameAssetLoader.LoadAssetByKeyAsync("creatures/cindris")
```

**Address naming convention:** lowercase with forward-slash namespace prefix matching the domain folder — `creatures/cindris`, `items/potion`, `npcs/cindris_starter_npc`, `spawners/starter-wild-zone`.

**To make a source asset addressable:**
1. Select the asset in the Project window
2. Check the **Addressable** checkbox in the Inspector
3. Set the address to match the `asset_key` registered in cr-api (e.g. `creatures/cindris`)
4. Assign it to the appropriate Addressables Group (e.g. "Creatures")

The `asset_key` on a definition is intentionally separate from `content_key`. Two variants of a creature can share the same `asset_key` (same art) while having different `content_key` values (different game identities). An entity with no art yet simply has a null `asset_key`.

### Full content release workflow

```
1. Designer edits/creates definition SOs in Unity
2. Window → CR → Content Creator  (create & register definitions)
3. Window → CR → Publish Content  (push asset keys to cr-api backend)
4. Window → CR → Deploy Content   (build Addressables + sync to S3)
5. Clients fetch /api/v1/content/manifest on next startup → ServerContentRegistry upgraded
   Addressables.CheckForCatalogUpdates() picks up new catalog → bundles downloaded on demand
```

## Related Pages

- [Backend Architecture](?page=backend/01-architecture) — DI wiring, module structure, full endpoint table
- [Content Registry](?page=unity/08-content-registry) — ScriptableObject definitions on the Unity side; `DisplayNameKey`; `IGameAssetLoader.LoadAssetByKeyAsync`
- [Localization](?page=unity/06-localization) — resolving `DisplayNameKey` strings from content defs
- [Creature Generation](?page=backend/04-creature-generation) — `BaseCreature.AssetKey` replaces the old `AssetId` UUID field
