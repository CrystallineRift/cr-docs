# Addressables Setup

This page covers everything needed to get Unity Addressables working in Crystalline Rift — from first-time package setup through local MinIO testing to a production S3 deploy. It also documents every gotcha we hit so you don't have to rediscover them.

## How Addressables Fit Into the Pipeline

```
Source asset (prefab/sprite)          Assets/CR/Content/Creatures/Cindris.prefab
  └─ marked Addressable, address set   "creatures/cindris"
       └─ built into bundle            ServerData/StandaloneOSX/creatures_*.bundle
            └─ deployed to CDN         s3://bucket/content/StandaloneOSX/
                 └─ loaded at runtime  IGameAssetLoader.LoadAssetByKeyAsync("creatures/cindris")
                      └─ resolved via  game_assets table (SQLite offline / Postgres online)
```

The `asset_key` string (`"creatures/cindris"`) is the only identifier that crosses all three layers. It is the Addressables address, the `game_assets.key` column value, and the `assetKey` field on the `CreatureDefinition` ScriptableObject — they must all match exactly.

---

## Package Requirements

1. Install **Addressables** via Package Manager (`com.unity.addressables`).
2. Add `CR_ADDRESSABLES` to **Project Settings → Player → Scripting Define Symbols**. This enables the `#if UNITY_ADDRESSABLES` blocks in `GameAssetLoader` and `ContentDeployTool`.

Without the scripting define, `GameAssetLoader` silently falls back to `Resources.Load` and the Deploy Content tool's "Build Addressables" button is hidden.

---

## Key Windows

### Groups Window — `Window → Asset Management → Addressables → Groups`

This is the main control panel. The important settings are:

**Play Mode Script** (dropdown at the top of the window):

| Mode | When to use |
|------|-------------|
| **Use Asset Database (fastest)** | Day-to-day iteration. Loads directly from project files — no build needed. |
| **Simulate Groups (advanced)** | Tests group layout without a full build. Rarely needed. |
| **Use Existing Build** | Testing the actual deployed bundles from MinIO or S3. Requires a completed Addressables build AND a deployed CDN. |

> **Gotcha:** If you switch to "Use Existing Build" without having run a build and deployed it first, every `LoadAssetAsync` call returns `null` silently. Always switch back to "Use Asset Database" for active development.

**Build menu** (in the Groups window toolbar):

- **Build → New Build → Default Build Script** — builds all groups and writes bundles to `My project/ServerData/<BuildTarget>/`. Do this before deploying.
- **Build → Clean Build** — deletes cached build data and forces a full rebuild.
- **Build → Update a Previous Build** — incremental update using a content state file. For production update pipelines.

### Profiles Window — `Window → Asset Management → Addressables → Profiles`

Profiles store the `Remote.BuildPath` and `Remote.LoadPath` variables used when building and loading remote content.

**Required variables:**

| Variable | Example value |
|----------|---------------|
| `Remote.BuildPath` | `ServerData/[BuildTarget]` |
| `Remote.LoadPath` | `http://localhost:9000/cr-content-dev/content/[BuildTarget]` (MinIO) |
| `Remote.LoadPath` | `https://cr-content-prod.s3.us-east-1.amazonaws.com/content/[BuildTarget]` (AWS) |

`[BuildTarget]` is substituted at build time (`StandaloneOSX`, `StandaloneWindows64`, `StandaloneLinux64`).

**For each environment** (local, staging, prod), create a named profile with the appropriate `Remote.LoadPath`. Switch profiles before building to bake the correct URL into the catalog.

> **Gotcha:** If you build Addressables and then change the `Remote.LoadPath` in Profiles, the bundles are now pointing at the wrong URL. You must rebuild after any profile change.

---

## Making an Asset Addressable

1. Select the asset (prefab, sprite, etc.) in the Project window.
2. In the Inspector, check the **Addressable** checkbox.
3. Set the **Address** field to the conventional key: `creatures/cindris`, `items/potion`, etc.
4. Assign it to a **Group** (e.g. "Creatures"). Create groups per content domain to control bundle layout.

**Address naming convention:** lowercase, forward-slash namespace prefix matching the content domain:

```
creatures/cindris
creatures/starter-fire
items/potion
items/iron-sword
npcs/starter-merchant
spawners/starter-wild-zone
```

This address must exactly match:
- `CreatureDefinition.assetKey` (set in the ScriptableObject inspector or via Content Creator)
- `game_assets.key` in the database (written by Publish Content or Seed to Local SQLite)

---

## Content Creator Integration

When you create a definition via **Window → CR → Content Creator**, the `assetKey` field on the ScriptableObject is saved as-is. After creating the definition:

1. Create the prefab or sprite in `Assets/CR/Content/<Domain>/`.
2. Mark it Addressable and set the address to match `assetKey`.
3. Assign it to the appropriate Addressables Group.

The Content Creator does **not** automatically mark assets as Addressable — that step is manual.

---

## Publish Content Tool — `Window → CR → Publish Content`

Before the runtime `IGameAssetLoader` can resolve a key, the key must exist in `game_assets`. There are two paths depending on mode:

### Online mode (backend running)

Fill in the Server Address and Pipeline API Key, then click **Publish to Server**. This calls `POST /api/v1/content/publish` which upserts rows in the Postgres `game_assets` table.

### Offline / local SQLite

Click **Seed Assets to Local SQLite**, browse to your local `.bytes` database file (the same one the Database Manager uses), then click seed. This upserts rows directly into the SQLite `game_assets` table without needing the API server running.

The upsert logic checks for the row by `key` (ignoring the `deleted` flag) so that previously soft-deleted rows are updated and un-deleted rather than causing a unique constraint error on re-insert.

> **Gotcha:** Forgetting to seed local SQLite is the most common reason `IGameAssetLoader.LoadAssetByKeyAsync` returns `null` in Play Mode. The log will show `"Getting game asset by key"` followed immediately by `"Asset key not found in registry"` — that is a DB miss, not an Addressables miss.

After seeding, the log should show `"Getting game asset by key"` → `"Getting game asset by id"` (two DB lookups) before reaching Addressables. If you see both lookups, the DB side is working.

---

## Deploy Content Tool — `Window → CR → Deploy Content`

Wraps the deploy scripts in a GUI. All settings are saved in `EditorPrefs` (not committed to git).

### MinIO (local dev)

| Field | Value |
|-------|-------|
| Bucket Name | your bucket (e.g. `cr-content-dev`) |
| Custom Endpoint URL | `http://localhost:9000` |
| MinIO Access Key | `minioadmin` (default) |
| MinIO Secret Key | `minioadmin` (default) |

> **Gotcha:** Port `9001` is the MinIO **web console**. Port `9000` is the S3 API. Setting the endpoint to `9001` gives `"S3 API Requests must be made to API port"`. Always use `9000`.

> **Gotcha:** EditorPrefs are only flushed to disk when Unity writes them. If you change the endpoint field and Unity crashes or you forget to trigger a save, the old value is restored on next launch. If the field isn't sticking, change it while Unity is open, click elsewhere to trigger `SavePrefs()`, then close normally.

### AWS S3

Leave **Custom Endpoint URL** empty. Fill in **Bucket Name**, **Region**, and **AWS Profile**.

### Deploy workflow

1. In the Groups window: **Build → New Build → Default Build Script**
2. In Deploy Content: click **Deploy to MinIO** (or **Deploy to S3**)
3. Switch Groups window Play Mode Script to **Use Existing Build**
4. Enter Play Mode — Addressables downloads from the CDN

For rapid iteration during development, stay on **Use Asset Database** and skip steps 1–3.

---

## `CreatureSpawner` MonoBehaviour

`CR.Core.Player.CreatureSpawner` is a minimal MonoBehaviour that loads a creature prefab from Addressables and instantiates it.

**Inspector fields:**

| Field | Description |
|-------|-------------|
| Asset Key | Addressables address of the prefab (e.g. `creatures/cindris`) |
| Spawn Point | Transform to spawn at. Falls back to the spawner's own position if unset. |
| Spawn On Start | If checked, spawns automatically when the scene starts. |

**Usage:** Add `CreatureSpawner` to a GameObject, set Asset Key, hit Play. Call `SpawnAsync()` or `DespawnCurrent()` from other scripts at runtime.

**Assembly note:** `CreatureSpawner` lives in `CR.Core.Player.asmdef` which does not reference Assembly-CSharp. It therefore cannot take a `CreatureDefinition` reference directly — it uses a plain `string assetKey` field instead. Copy the value from the `assetKey` field on the definition.

**Asset release:** `OnDestroy` cancels any in-flight load and destroys the spawned creature, but does **not** call `IGameAssetLoader.ReleaseAllAssets()`. Because `IGameAssetLoader` is a shared singleton, releasing all assets from one `CreatureSpawner` would unload assets still in use by other systems. If you need to release the specific handle, track the loaded asset reference manually and call `ReleaseAsset(Guid)` with the corresponding asset UUID.

---

## Gotchas Reference

| Symptom | Root cause | Fix |
|---------|------------|-----|
| `LoadAssetAsync` returns `null`, log shows "Asset key not found in registry" | `game_assets` row doesn't exist in local SQLite | Run **Seed Assets to Local SQLite** in Publish Content tool |
| `LoadAssetAsync` returns `null`, log shows two DB lookups then silence | Addressables can't find the bundle | Either: address mismatch, no build run, or Play Mode Script set to "Use Existing Build" without a deploy |
| "S3 API Requests must be made to API port" | Endpoint set to port `9001` (console) | Change to `http://localhost:9000` |
| `aws: command not found` in Unity deploy | Unity launches bash with a stripped PATH — Homebrew not included | Fixed in `deploy-content.sh`: `export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"` at top of script |
| "The config profile (default) could not be found" when deploying to MinIO | MinIO doesn't use AWS profiles | Fixed: deploy script uses `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` env vars instead of `--profile` when an endpoint is set |
| Endpoint field reverts after editor restart | EditorPrefs only persist if Unity exits cleanly after the pref is saved | Change the field, click elsewhere (triggers `SavePrefs()`), then close Unity normally |
| Display Name Key shows `creature_c_display` during typing | `def.contentKey` in the inspector is stale (updated after `ApplyModifiedProperties()`) | Fixed: inspectors now pass `propKey.stringValue` (live value) instead of `def.contentKey` |
| `CS0234: namespace 'Data' does not exist in CR.Core` from `CreatureSpawner` | `CreatureDefinition` is in Assembly-CSharp; `CR.Core.Player.asmdef` can't reference it | Use `string assetKey` field directly instead of a `CreatureDefinition` reference |

---

## Full Workflow Summary

### Fast iteration (daily dev)

```
1. Create/edit prefab in Assets/CR/Content/<Domain>/
2. Mark Addressable, set address (e.g. creatures/cindris)
3. Window → CR → Publish Content → Seed Assets to Local SQLite
4. Groups window: Play Mode Script = "Use Asset Database (fastest)"
5. Hit Play — loads directly from project files, no build needed
```

### End-to-end CDN test

```
1. Groups window: select correct Profile (MinIO or AWS)
2. Groups window: Build → New Build → Default Build Script
3. Window → CR → Deploy Content → Deploy to MinIO (or S3)
4. Groups window: Play Mode Script = "Use Existing Build"
5. Hit Play — downloads bundles from CDN
```

### Production content release

```
1. Designer creates definitions via Window → CR → Content Creator
2. Artist creates prefabs, marks Addressable, sets address
3. Window → CR → Publish Content → Publish to Server (bumps content_version in DB)
4. Window → CR → Deploy Content → Build Addressables + Deploy (per platform)
5. Clients call /api/v1/version-check on startup → content_update_required = true
6. Background sync fetches new catalog → new bundles downloaded on demand
```

---

## Related Pages

- [Asset Management](?page=backend/10-asset-management) — `game_assets` table, publish endpoint, three-system architecture, S3/MinIO CDN scripts
- [Content Registry](?page=unity/08-content-registry) — `CreatureDefinition` ScriptableObjects, `IGameContentRegistry`, `IGameAssetLoader`, editor tooling
