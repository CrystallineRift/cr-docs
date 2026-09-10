# Spawner System

The Spawner system manages generation of spawnable creatures from a **weighted pool** model: spawners hold pools, pools hold creature templates, and templates define how a creature is generated. A spawner is now a **global, read-only content template** — there are no per-trainer copies, and spawning is stateless.

## Spawners Are Global, Read-Only Content

The spawner is global, authored content shared by all trainers — it is **not** per-trainer state.

- **Per-trainer spawner clones are retired.** Earlier, `EnsureSpawnerForTrainerAsync` created a copy of the global template for each `(account_id, trainer_id)`. **Migration `M5016RetirePerTrainerSpawner`** soft-deletes every per-trainer clone (rows where `account_id IS NOT NULL OR trainer_id IS NOT NULL`); the template rows are the sole source of truth. **Migration `M5017DropVestigialOwnerColumns`** then drops the now-dead `account_id`, `trainer_id`, `current_count`, and `last_spawn_time` columns entirely (Postgres `DROP COLUMN`; SQLite table-rebuild) and replaces the `(account_id, trainer_id, content_key)` unique index with one on `content_key` alone.
- **Spawning is stateless.** The service enforces **no capacity and no cooldown**. A spawner only needs to be active and have at least one active pool/template; wild creatures are generated fresh on demand. There are no per-player runtime counters to track or reset.
- In the offline two-database split, spawner templates and pools live in the read-only **game-data DB**; the resulting wild creatures and spawn-history rows are player state in **player-data**. See [Content Pipeline (Two-Database Model)](?page=unity/17-content-pipeline).

> The `EnsureSpawnerForTrainerAsync` / `EnsureSpawnerForTrainerByKeyAsync` methods still exist on `ISpawnerDomainService`, but with clones retired the spawn path resolves pools directly from the global template by `content_key` (`CreatureSpawnDomainService` falls back to `GetSpawnerTemplateByContentKeyAsync` when a spawner has no pools of its own).

## Why This Design?

### Why a Weighted Pool Instead of Direct Spawn Rates?

The two-level hierarchy (spawner → pools → templates) exists to support rarity tiers cleanly. Instead of assigning spawn probabilities directly to each creature template and trying to balance dozens of percentages that must sum to 100%, the design separates the question "which tier should spawn?" from the question "which creature within that tier?".

The pool selection uses `weight × rarity_multiplier` as a composite weight. This means you can define a "Legendary" pool with a low weight and boost it situationally (e.g., during an event) by temporarily raising its `rarity_multiplier` without touching the individual template probabilities inside it.

### Why Is Spawning Stateless?

The spawner is global, read-only content and holds no per-player runtime counters. The service deliberately enforces **no capacity and no cooldown** — wild creatures are generated fresh on demand. This keeps the same template usable by every trainer simultaneously with no contention and nothing to "reset."

- `current_count`, `last_spawn_time`, `account_id`, and `trainer_id` were **dropped** by `M5017` (they were never read/written by stateless spawning). `row_version` remains.
- `max_capacity` and `spawnCooldownSeconds` persist in the schema and the `SpawnerDefinition` SO for descriptive/admin purposes, but are not enforced during a spawn.
- Validation now checks only that the spawner exists and is active (`is_active`). A `BypassValidation` flag on the request skips even the active check (used by quest rewards and other deterministic spawns).

### Why Does `CreateFromSpawnerAsync` Accept an Optional `seed`?

Deterministic generation is useful for testing and for scenarios where two clients need to agree on the same creature without a round-trip (e.g., peer-to-peer encounter previews). When `seed` is `null`, `new Random()` is used and the creature is random. When `seed` is provided, `new Random(seed.Value)` is used for level selection, making the output reproducible for a given template + seed pair.

## Architecture

```
CR.Spawner.Data            ← interfaces + base data access
CR.Spawner.Data.Migration  ← FluentMigrator migrations
CR.Spawner.Data.Postgres   ← PostgreSQL implementations
CR.Spawner.Data.Sqlite     ← SQLite implementations
CR.Spawner.Domain          ← portable domain services (ICreatureSpawnDomainService, etc.)
CR.Spawner.Model.REST      ← DTOs
CR.Spawner.Service.REST    ← ASP.NET minimal-API endpoints
```

`CR.Spawner.Domain` contains no HTTP or database dependencies. It depends only on interfaces from `CR.Spawner.Data` and `CR.Creatures.Data`. This makes it portable to the Unity client — the SQLite implementations satisfy the same interfaces, so the domain service runs identically offline.

## Database Schema

| Table | Purpose |
|-------|---------|
| `spawner` | Global, read-only spawner template config. Owner/runtime columns (`account_id`, `trainer_id`, `current_count`, `last_spawn_time`) were dropped by `M5017`; `capacity`/`cooldown` persist but are not enforced |
| `spawner_pool` | Weighted pools within a spawner |
| `creature_spawner_template` | Creature blueprints per pool |
| `ability_progression_set` | Reusable ability sets for templates |
| `ability_progression_set_entry` | Level-based entries per set |
| `spawner_spawn_history` | Full spawn event log |

Key columns on `spawner`:
- `row_version` — incremented on update; reserved for optimistic concurrency
- `is_active` — only active spawners accept spawn requests (the one runtime check)
- `current_count`, `last_spawn_time`, `account_id`, `trainer_id` — **dropped** by `M5017` (per-trainer scoping + stateful spawning are gone)
- `deleted` — soft delete flag
- `content_key` — designer-facing key (e.g. `"starter-wild-zone"`); the lookup key for the global template
- `battle_arena_key` — optional string matching `BattleArena.ArenaKey` in the Unity scene; added by migration M5013. Stored server-side so the Content Creator sync tool can read/write it bidirectionally.

The Unity-side `SpawnerDefinition` ScriptableObject mirrors the backend `content_key` and stores additional fields synced from the server:

| Field | Description |
|-------|-------------|
| `contentKey` | Must match `content_key` in the backend DB |
| `battleArenaKey` | Arena key used to look up the `BattleArena` MonoBehaviour in the scene. Must match `BattleArena.arenaKey` on the corresponding arena prefab. Leave empty to skip arena teleportation during wild encounters. Also stored in `spawner.battle_arena_key` on the backend (M5013). |
| `displayName` | Human-readable label for the zone (synced from server). |
| `description` | Description text (synced from server). |
| `maxCapacity` | Max creatures alive at once (default 5). Synced from server. |
| `spawnCooldownSeconds` | Seconds between spawn cycles (default 300). Synced from server. |
| `pools[]` | One or more weighted pools, each containing creature templates (see below). |

`SpawnerDefinition` is the **single** source of truth for spawner content — it holds the zone's pools and templates directly. (The older scene-attached `SpawnerZoneConfig` SO has been removed; everything is authored as a `SpawnerDefinition` in the content registry, via the Spawners / Spawn Pools tabs of Content Studio or `Assets → Create → CR → Content → Spawner Definition`.)

Each `SpawnerPoolConfig`:
| Field | Description |
|-------|-------------|
| `poolName` | Internal name used in logs. |
| `spawnWeight` | Relative weight (higher = more common). |
| `rarityMultiplier` | Scales effective weight (< 1 = rarer). |
| `templates[]` | Creature blueprints in this pool. |

Each `SpawnerTemplateConfig`:
| Field | Description |
|-------|-------------|
| `creatureContentKey` | `content_key` of the `BaseCreature` species. |
| `growthProfileName` | Name of the `GrowthProfile` row (e.g. `"Fast Experience"`). |
| `variantType` | `"normal"`, `"shiny"`, or `"shadow"`. |
| `minLevel` / `maxLevel` | Level range for spawned creatures. |
| `spawnProbability` | Probability 1–100 within the pool. |
| `abilityProgressionSet` | Optional `AbilityProgressionSetConfig` SO reference. Leave empty for default abilities. |

Two further **optional** fields exist on the sync payload (`SpawnerTemplateSyncDto` / `SpawnerTemplateSyncData`) rather than on the SO, because only the trainer-battle push sends them:

| Field | Description |
|-------|-------------|
| `id` | Caller-chosen template UUID. Trainer teams push a **deterministic** id per slot because the battle handshake resolves an opponent by `creature_spawner_template.id`; wild spawners omit it and keep getting a fresh random id. A value that is not a valid non-empty UUID is refused with the same `409` as an unresolvable content key — falling back to a random id would answer `200` and still break the lookup. |
| `progressionSetName` | Name of the `AbilityProgressionSet` row, resolved server-side via `IAbilityProgressionSetRepository.GetByNameAsync`. Wins over `abilityProgressionSetId` when both are sent. An unresolvable name refuses the whole sync. |

**How the sync works:** `SpawnerDefinitionSyncBehaviour` writes every `SpawnerDefinition` in the content registry to the **local SQLite** spawner tables at world init, through `ISpawnerSyncClient` — which the runtime container binds to `LocalSpawnerSyncClient`, and only that. The game cannot push spawner content to the server: `SpawnerSyncHttpClient` (`POST /api/v1/spawners/sync-config`) exists for editor tooling and is not resolved through the Zenject graph at all, so a play session can never overwrite a server edit. The server-side push is Content Studio's, via `ContentCreatorSyncHelper.SyncSpawnerFull`, which makes its own direct HTTP call. That endpoint **resolves every creature content key, growth-profile name, progression-set name and explicit template id in the request first**, then upserts the global template spawner by `contentKey`, soft-deletes existing pools/templates, and recreates them from the request.

> **Templates carrying an explicit `id` are written with an upsert-revive** (`INSERT … ON CONFLICT (id) DO UPDATE …, deleted = false`) rather than a plain insert. They have to be: the recreate step runs *after* every existing template for the spawner was soft-deleted, so re-pushing the same deterministic id lands on the row the sync itself just deleted and a plain insert collides on the primary key. Templates with no `id` keep the plain-insert path unchanged. Every recreated template — both paths — is written with `is_active = true` and populates `creature_content_key` / `growth_profile_name` so the stale-UUID repair path has something to repair from.

> **Postgres used to discard pushed ids.** `BaseCreatureSpawnerTemplateRepository`'s Postgres INSERT omitted the `id` column and let the server default mint one, and the SQLite branch overwrote `template.Id` with `Guid.NewGuid()` unconditionally. Both now honour a caller-supplied id and mint only when it is `Guid.Empty`. Without that, a trainer's team could never be looked up at the id the client asked for.

> **Resolution happens before anything is deleted, and a payload the server cannot fully resolve is refused with `409`** — the response names each missing creature or growth profile, and the database is untouched (not even a spawner row is created for a new content key). This was previously the other way round: unresolved templates were skipped mid-rebuild with a log warning while the call answered `200 success`, so a spawner pushed before its creatures or growth profiles existed came out the far side with empty pools and no error anywhere. Content Studio's push order was also part of that — it sent spawners before growth profiles — and now runs in dependency order. Covered by `SpawnerConfigSyncServiceTests` (8 tests), which assert that a refused sync deletes nothing and creates nothing. `SpawnerWorldBehaviour` no longer syncs anything — it just resolves the spawner by its `_spawnerContentKey` and activates the encounter. The global template is the sole source of truth; the spawn path reads pools directly by `contentKey`.

Key columns on `creature_spawner_template`:
- `base_creature_id` — which creature species to generate
- `creature_content_key` — the designer-facing `content_key` of the base creature (added M5014); used as a fallback when `base_creature_id` is stale after a server rebuild
- `growth_profile_id` — which stat scaling curve to use
- `growth_profile_name` — the human-readable name of the growth profile (added M5014); fallback lookup if `growth_profile_id` is stale
- `ability_progression_set_id` — nullable; which ability set to use (null = no abilities)
- `min_level` / `max_level` — level range for generated creatures
- `spawn_probability` — relative probability within the pool (does not need to sum to 1.0; the service normalizes)
- `variant_type` — `"normal"`, `"shiny"`, `"legendary"`

> **UUID stability:** `creature_content_key` and `growth_profile_name` are stored alongside the UUID foreign keys so the generation service can self-heal stale references without user intervention. See [Creature Generation — stale UUID fallback](?page=backend/04-creature-generation#staleuuid-fallback).

## Spawn Algorithm

The full spawn flow in `CreatureSpawnDomainService.SpawnCreaturesAsync`:

1. **Validation phase** — fetch the spawner; verify it exists and `is_active = true`. **No capacity or cooldown check** — the spawner is global, read-only content with no per-player counters. (A `BypassValidation` request flag skips even the active check.)
2. **Pool selection phase** — fetch all active pools for the spawner; if `request.PoolName` is set, keep only the pool with that name (case-insensitive); compute `totalWeight = SUM(pool.spawn_weight × pool.rarity_multiplier)`; pick a uniform random value in `[0, totalWeight]`; walk the pools accumulating weight until the random value is covered; fall back to the last pool if floating-point rounding overshoots. With per-trainer clones retired, a spawner with no pools of its own falls back to the global template's pools (resolved by `content_key`).
3. **Template selection phase** — fetch all active templates for the selected pool via `GetTemplatesByProbabilityAsync`; normalize by `SUM(spawn_probability)`; same weighted random walk; fall back to last template
4. **Quantity generation** — use `request.RequestedQuantity` (future: clamp to `[min_quantity, max_quantity]` from the template)
5. **Creature generation** — call `ICreatureGenerationService.CreateFromSpawnerAtLevelAsync(template.Id, trainerId, request.LevelOverride, seed)` for each creature; null results (e.g., from a missing trainer ID) are silently skipped
6. **Spawn execution (transactional)** — open a connection, begin a transaction; write one `spawner_spawn_history` row per spawned creature; commit; roll back on failure. The template is global, read-only content, so spawning **never mutates the spawner** (`current_count` / `last_spawn_time` are not touched).

The transaction in step 6 ensures spawn-history rows are written atomically.

## Configuration Example

```
Spawner: "Mystic Forest Spawner"
├── Pool: "Common Forest Creatures"  (weight: 70, levels 1-10, rarity: 1.0×)
│   ├── Sparklefox   normal  40%  levels 1-5
│   ├── Leafwhisker  normal  35%  levels 2-6
│   └── Mossclaw     normal  25%  levels 3-7
├── Pool: "Rare Forest Creatures"    (weight: 25, levels 5-15, rarity: 1.5×)
│   ├── Sparklefox   shiny   50%  levels 5-10
│   ├── Thornbeast   normal  30%  levels 6-12
│   └── Moonwhisper  normal  20%  levels 8-15
└── Pool: "Legendary Forest"         (weight: 5,  levels 10-20, rarity: 3.0×)
    └── Forest Guardian  legendary  100%  levels 10-20
```

Effective pool weights: Common = 70×1.0 = 70, Rare = 25×1.5 = 37.5, Legendary = 5×3.0 = 15. Total = 122.5. So Common spawns ~57% of the time, Rare ~31%, Legendary ~12%.

## `EnsureSpawnerForTrainerAsync`

`SpawnerDomainService` still exposes these idempotent resolution methods:

```csharp
Task<SpawnerDomain?> EnsureSpawnerForTrainerAsync(
    Guid accountId, Guid trainerId, string contentKey,
    CancellationToken ct = default);

Task<SpawnerDomain> EnsureSpawnerForTrainerByKeyAsync(
    Guid accountId, Guid trainerId, string contentKey,
    CancellationToken ct = default);
```

With per-trainer clones **retired** (`M5016`), the global template by `content_key` is the source of truth. The spawn path resolves pools directly from the template — `CreatureSpawnDomainService` falls back to `GetSpawnerTemplateByContentKeyAsync(contentKey)` when a spawner record has no pools of its own. There is no longer a separate, mutable per-trainer spawner row to maintain.

## No Capacity to Reset

Spawning is stateless: there is no `current_count` gate and no cooldown. Wild creatures are generated fresh on every spawn, so there is nothing to reset. `current_count` / `last_spawn_time` columns remain on the table but are not used by the spawn path.

If you need to stop a spawner, deactivate it (`POST /spawner/{id}/deactivate` sets `is_active = false`). Reactivate with `/spawner/{id}/activate`. The `spawner_spawn_history` audit log is immutable and is never cleared by activation changes.

## Wild Battle Proxy

`SpawnerEncounterBehaviour` in Unity triggers a spawn before initiating the battle. The spawn call:

```json
POST /spawner/{spawnerId}/spawn
{
  "trainerId": "<trainerId>",
  "requestedQuantity": 1,
  "spawnSessionId": "<session-uuid>"
}
```

This writes a `spawner_spawn_history` row and generates the creature — it does **not** mutate the spawner template. The generated creature is stored under the Wild Trainer account (GUID `00000000-0000-0000-0000-000000000001` — see the Unity Integration section below). The battle engine loads this creature via `ICreatureInventoryService.GetTeamAsync(wildTrainerId)`.

If the player flees the battle, nothing about the spawner changes — spawning never consumed any capacity to begin with. Wild zones are perpetual by default.

## Admin/Debug Patterns for Spawner State

**Check current spawner state:**

```
GET /spawner/{id}/status
→ 200 OK
{
  "spawnerId": "...",
  "isActive": true,
  "currentCount": 47,
  "maxCapacity": 100,
  "lastSpawnTime": "2026-03-13T10:00:00Z",
  "cooldownSeconds": 0
}
```

> `currentCount`, `maxCapacity`, `lastSpawnTime`, and `cooldownSeconds` are reported for descriptive/admin purposes only — they are **not** enforced. `isActive` is the only field that affects whether a spawn is accepted.

**View spawn history (who spawned what):**

```
GET /spawner/{id}/history?limit=20&offset=0
→ 200 OK
{
  "history": [
    {
      "spawnedAt":          "2026-03-13T10:05:00Z",
      "spawnedByTrainerId": "...",
      "generatedCreatureId": "...",
      "variantType":        "normal",
      "levelGenerated":     7,
      "spawnDurationMs":    142
    }
  ]
}
```

**Temporarily disable a spawner without deleting it:**

```
POST /spawner/{id}/deactivate
→ 204 No Content
```

The spawner retains all its pools, templates, and history. Reactivate with `POST /spawner/{id}/activate`.

## Quick Start

### Option A: SpawnerDefinition ScriptableObject (recommended for designers)

1. In Unity: `Assets → Create → CR → Content → Spawner Definition` (or create one from the Spawners tab in Content Studio)
2. Set `contentKey` to a unique string (e.g. `"forest-wild-zone"`), fill in pools and templates (the Spawn Pools tab gives a pool/template-focused editor)
3. Place a `SpawnerWorldBehaviour` in the scene and set its `_spawnerContentKey` to the same key
4. On next play, `SpawnerDefinitionSyncBehaviour` syncs the definition (`POST /api/v1/spawners/sync-config`) — the backend creates the global template and all pools; `SpawnerWorldBehaviour` resolves it by key and runs encounters

### Option B: Manual REST (admin / tooling)

### 1. Create a spawner

```json
POST /spawner
{
  "name": "Mystic Forest Spawner",
  "spawnerType": "creature",
  "maxCapacity": 100,
  "spawnCooldownSeconds": 300
}
```

### 2. Add a pool

```json
POST /spawner/{spawnerId}/pools
{
  "name": "Common Forest Creatures",
  "spawnWeight": 70,
  "minLevel": 1,
  "maxLevel": 10,
  "rarityMultiplier": 1.0
}
```

### 3. Add creature templates

```json
POST /spawner/{spawnerId}/templates
{
  "poolId": "<pool-uuid>",
  "baseCreatureId": "<creature-uuid>",
  "growthProfileId": "<growth-uuid>",
  "variantType": "normal",
  "minLevel": 1,
  "maxLevel": 5,
  "spawnProbability": 0.40,
  "minQuantity": 1,
  "maxQuantity": 1
}
```

### 4. Activate the spawner

Spawners start inactive. Call `/spawner/{id}/activate` before any spawn attempt or you will receive a `ValidationError` response.

### 5. Spawn

```json
POST /spawner/{spawnerId}/spawn
{ "trainerId": "<trainer-uuid>", "requestedQuantity": 1 }
```

## API Endpoints

### Spawner management

| Method | Path | Description |
|--------|------|-------------|
| `GET`  | `/api/v1/spawners` | List all spawners |
| `GET`  | `/api/v1/spawners/{id}` | Get spawner |
| `POST` | `/api/v1/spawners` | Create spawner |
| `POST` | `/api/v1/spawners/{id}/activate` | Activate |
| `POST` | `/api/v1/spawners/{id}/deactivate` | Deactivate |

### Config sync (Unity → backend)

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/v1/spawners/sync-config` | Upsert a full spawner (pools + templates) from a `SpawnerDefinition` SO, or a trainer's team from a `TrainerBattleDefinition`. Templates may carry an optional `id` (deterministic, preserved verbatim) and `progressionSetName`. |
| `GET` | `/api/v1/spawners/by-content-key/{contentKey}/config` | Full config (header + pools + creature templates) for one spawner, by `content_key`. Used by Content Studio pull. |

Request body mirrors `SpawnerConfigSyncRequest` (contentKey, displayName, maxCapacity, spawnCooldownSeconds, pools[]).

### Content Studio sync (push / pull)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/v1/spawners/content-registry` | Returns all global spawner **headers only** (no pools/templates) as a bare JSON array for the editor **Pull** action. Each item: `id`, `contentKey`, `name`, `description`, `battleArenaKey`, `maxCapacity`, `spawnCooldownSeconds`, `updatedAt`. |
| `GET` | `/api/v1/spawners/content-registry/full` | Bulk variant: every non-deleted spawner with its pools and creature templates nested inline, so a client does not need one `by-content-key/{contentKey}/config` request per spawner. Paginated — `offset`/`limit` query params, default and max `limit` 500. Response envelope: `{ data: [...], offset, limit, total }`, where `total` is the full matching row count (not just the page size), so a client can detect truncation. |
| `PUT` | `/api/v1/spawners/by-content-key/{contentKey}` | Upserts a spawner definition by `content_key`. Creates the global template row if it doesn't exist; updates display fields if it does. Body: `SpawnerDefinitionSyncRequest` (`DisplayName`, `Description`, `MaxCapacity`, `SpawnCooldownSeconds`, `BattleArenaKey`). Returns `{ contentKey }` on success. |
| `DELETE` | `/api/v1/spawners/by-content-key/{contentKey}` | Soft-deletes the global spawner template row with the given `content_key`. Per-trainer spawner rows are unaffected. Returns 204 on success, 404 if not found. Spawner templates have no per-trainer player-data guard — the delete is always safe. |

:::caution AIO maps these routes by hand
`CR.REST.AIO/Program.cs` does not call `MapSpawnerEndpoints` — it declares spawner routes inline, so a
route can exist in `SpawnerEndpoints.cs` and still 404 against the local dev host. `content-registry`
was missing there, which meant Content Studio's **Spawners → Pull** always failed against AIO
regardless of what the database held: a spawner seeded by a migration could never become a
`SpawnerDefinition` asset in Unity. When adding a spawner route, add it in both places, and verify
against a running AIO (`curl localhost:8080/swagger/v1/swagger.json`), not just against the source.

`sync-config` and `by-content-key/{contentKey}/config` used to exist **only** in AIO's inline routes,
not in `SpawnerEndpoints.cs` — a host that switched from AIO to the modular `CR.Spawner.Service.REST`
project would silently lose spawner config sync. Both are now mirrored into `SpawnerEndpoints.cs` (and
`ISpawnerConfigSyncService` is registered in `CR.Spawner.Service.REST/Program.cs`) so the modular host
carries the same spawner sync surface as AIO.
:::

### Spawning

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/v1/spawners/{id}/spawn` | Spawn creatures |
| `GET`  | `/api/v1/spawners/{id}/status` | Spawner status (`is_active` / `canSpawn`; stateless — no count or cooldown) |
| `GET`  | `/api/v1/spawners/{id}/history` | Paginated spawn history |

## `SpawnRequest` Model

```csharp
public class SpawnRequest
{
    public Guid? TrainerId { get; set; }       // required for creature generation
    public int RequestedQuantity { get; set; } = 1;
    public Guid? SpawnSessionId { get; set; }  // optional; auto-generated if null
    public bool BypassValidation { get; set; } // skip the active check (quest rewards, admin grants)
    public string? PoolName { get; set; }      // null = roll every reachable pool, as the world does
    public int? LevelOverride { get; set; }    // null = draw from the selected template's band
}
```

`TrainerId` is optional at the API level but required for creature generation. If `TrainerId` is null, `GenerateCreatureAsync` returns null and the creature is skipped. A spawn request with `TrainerId = null` will return a successful result with zero spawned creatures.

`PoolName` and `LevelOverride` exist for tooling that has to aim a roll rather than take what the
world gives — today, the admin "grant a creature from a spawn pool" action (see
[Moderation](?page=backend/18-moderation)). `PoolName` is matched case-insensitively against
`spawner_pool.name` and narrows the candidates **before** the weighted draw, so a caller who named a
pool either gets that pool or gets `NoTemplatesAvailable`; it never falls back to a pool nobody asked
for. `LevelOverride` replaces only the level — species, growth profile and ability progression set
still come from the drawn template, so an overridden creature is the same creature, only older or
younger.

## Error Codes

| Status | Meaning |
|--------|---------|
| 404 | Spawner not found / no templates available |
| 400 | Validation error (e.g. spawner inactive, invalid request) |
| 500 | Internal error |

> Capacity (409) and cooldown (429) responses are gone — spawning is stateless, so neither is enforced.

## `spawner_spawn_history` Schema

Every successful spawn writes a row to `spawner_spawn_history`:

| Column | Notes |
|--------|-------|
| `id` | UUID primary key |
| `spawner_id` | FK → spawner |
| `template_id` | Which template was used |
| `pool_id` | Which pool was selected |
| `generated_creature_id` | FK → generated_creature |
| `variant_type` | normal / shiny / legendary |
| `level_generated` | The level the creature was generated at |
| `quantity` | Always 1 per history row |
| `spawned_at` | UTC timestamp |
| `spawned_by_trainer_id` | The trainer who triggered the spawn |
| `spawn_session_id` | Groups all creatures from one spawn call |
| `spawn_duration_ms` | How long generation took |

## Unity Integration — Wild Trainer GUID

`SpawnerWorldBehaviour` in the Unity client exposes two properties after `InitializeAsync` completes:

```csharp
public Guid SpawnerId     { get; private set; }  // the resolved spawner row ID
public Guid WildTrainerId { get; private set; }  // always 00000000-0000-0000-0000-000000000001
```

`WildTrainerId` is hardcoded to the well-known Wild Trainer GUID (`00000000-0000-0000-0000-000000000001`), seeded by `M9990SeedGameData` on the backend. Spawned wild creatures are stored under this trainer's account, and `BattleDomainService` looks them up via `ICreatureInventoryService.GetTeamAsync(wildTrainerId)`.

`SpawnerEncounterBehaviour` reads these values and passes `WildTrainerId` as the opponent ID in `WildBattleRequest`. After the battle ends, the backend soft-deletes all creatures owned by the Wild Trainer — ensuring wild creature rows do not accumulate indefinitely.

See [Battle System](?page=unity/07-battle-system) for the complete wild encounter flow.

## A Spawner That Can Produce a Creature Always Does

Pool selection used to choose first and check second: `SelectPoolAsync` ran a weighted draw over the
active pools, then `SelectTemplateAsync` asked the winner for a template. A pool that was active but
empty could win that draw, and the spawn returned `NoTemplatesAvailable` while a sibling pool sat
full of creatures. The failure was a coin flip weighted by the pools' own `spawn_weight`, which is
why it read as "sometimes there is nothing to fight".

The global-template fallback had the same shape. It only fired when the trainer-scoped spawner had
**no pools at all**, so a spawner holding one emptied pool skipped it and starved.

`SelectProductivePoolAsync` fuses the two steps:

1. Collect every reachable pool — the spawner's own **and** the global content template's, every
   time, not only as a fallback.
2. Drop the pools that hold no templates, logging each one.
3. Weighted draw over what remains.

`NoTemplatesAvailable` now means what it says: nothing anywhere under this spawner can spawn. That
honest failure still matters — it is what the Unity encounter zone reads to decide whether to repair
itself or give up.

Two degenerate cases are handled rather than left to chance, because both are states a designer can
author and neither should cost the player an encounter that has already been committed to:

| State | Behaviour |
|---|---|
| All pool weights total zero | First productive pool, with a warning — the weights are doing nothing |
| All template probabilities total zero | First template |

`SpawnPoolSelectionTests` covers these. The empty-pool test repeats 25 times with the empty pool
carrying 1000× the weight of the full one: the bug it guards was probabilistic, so a single green
pass would prove nothing.

## A Template Must Point at a Creature That Exists

Nothing enforces this. There is no foreign key from `creature_spawner_template.base_creature_id` to
`creature.id`, so a template can name an id no row has ever carried and every insert still succeeds.
In August 2026 that gap emptied three spawn zones, and the failure travelled a long way from its
cause before anyone saw it:

1. The eight newest species were authored through the Content Studio, so Postgres generated their
   ids. `M10000SeedRosterCreatures` then seeded the same content keys with its own hard-coded ids,
   lost to the UNIQUE index on `creature.content_key`, and `ON CONFLICT DO NOTHING` discarded the
   rows without a word.
2. `M10001`/`M10002` wrote area templates pointing at those discarded ids.
3. `GET /api/v1/spawners/by-content-key/{key}/config` resolves the creature by id to fill
   `creatureContentKey`, so it returned `""` for every affected template.
4. A Content Studio pull wrote those blanks into the `SpawnerDefinition` assets.
5. The offline spawner sync read the assets, resolved no creature for any template, and soft-deleted
   all 23 it could not match — its normal "this template was removed from the config" behaviour.
6. Meadow, Cave and Crags ended up with empty pools, so walking into the grass started a battle with
   no opponent.

Three defences now sit along that path:

| Where | What it does |
|---|---|
| `M10006RepairTemplateCreatureIds` | Repoints a dangling `base_creature_id` using the template's own denormalized `creature_content_key`, which stayed correct throughout. Only touches rows whose id resolves to nothing. |
| The config endpoint | Falls back to `creature_content_key` when the creature join misses, and logs a warning. An empty key is never emitted as if it were fine. |
| `SpawnerPrunePolicy` (Unity) | The sync refuses to delete templates from a pool it did not read cleanly. See [Unity — Battle System](../unity/07-battle-system.md). |

`TemplateCreatureIdRepairSqliteTests.EveryTemplatePointsAtACreatureThatExists` asserts the invariant
against a full migration run, so a new seed that reintroduces a dangling reference fails the build
rather than emptying a zone in a playtest.

**When you seed a creature with a hard-coded id, check the id is the one the Content Studio assets
use.** A seed that loses to the UNIQUE index is silent, and everything downstream of it inherits the
mismatch.

## Several zones per habitat, narrow at the start

Each habitat used to be one encounter zone rolling its whole band at once. At the bottom of the
game that is not a difficulty setting, it is a coin flip: a trainer opens with a single level-1
creature, and a zone spanning levels 1-4 decides the first fight of the game before the player
does anything.

`M10016SubdivideAreaLevelBands` splits every habitat into several zones and narrows the band where
the player is weakest:

| Habitat | Zones | Spans |
|---|---|---|
| Meadow | 1-2, 3-4, 5-6 | 2 |
| Shore | 5-7, 8-10 | 3 |
| Cave | 9-12, 13-16 | 4 |
| Crags | 15-19, 20-24 | 5 |
| Dunes | 22-27, 28-34 | 6, 7 |

A habitat's band is now the **union of its zones**, so anything reasoning about area difficulty has
to group by area rather than by spawner content key — `meadow-wild-zone` alone stops at 2 and
`meadow-wild-zone-3` carries the top of the meadow.

The new spawners are built with `INSERT..SELECT` from the existing rows rather than from hardcoded
ids, so every creature, growth-profile and ability-progression id is copied from a row that already
works. Hand-writing those ids is how a seed ends up pointing at nothing — see
[Seed ids lose to authored ids](#) in the migration notes.

In the world, the harder zone of a pair is placed **further from the door the player arrives
through**, so the level you meet depends on how far you have walked rather than on a roll you
cannot influence. The client half — the `SpawnerDefinition` assets, their registration with the
`ContentDefinitionProvider`, and the scene placement — is applied by `cr_split_encounter_zones`
(**CR > Areas > Split Encounter Zones**) in the Unity project, and its band table must stay
identical to the migration's or online and offline play at different difficulties.

## Common Mistakes / Tips

- **Spawner not active.** The most common reason `SpawnCreaturesAsync` returns `ValidationError`. Always call `activate` after creating a spawner.
- **No templates in the pool.** If a pool has no active templates, `SelectTemplateAsync` returns null and the spawn returns `NoTemplatesAvailable`. Verify templates are marked `is_active = true`.
- **Spawn probabilities don't need to sum to 1.** The service normalizes by the total. However, all templates in a pool with `spawn_probability = 0` will never be selected. Use at least 0.01 for any template you want to include.
- **Missing `trainerId` in spawn request.** Spawns succeed but generate zero creatures. Add `trainerId` to the request body.
- **Expecting capacity to gate spawns.** Spawning is stateless — there is no `current_count`/`max_capacity` gate and no cooldown (`M5016` retired per-trainer clones and stateful spawning). A spawner only needs to exist and be active. Nothing to reset after testing.
- **Using the wrong `content_key` in the world behaviour.** If a `SpawnerWorldBehaviour`'s `_spawnerContentKey` does not match any `SpawnerDefinition` (and thus any global spawner template row), `GetSpawnerTemplateByContentKeyAsync` returns null and no pools resolve, so no creature spawns. Make sure a `SpawnerDefinition` with that exact `contentKey` exists in the content registry so `SpawnerDefinitionSyncBehaviour` creates the global template.
- **`growthProfileName` typo in a SpawnerDefinition template.** If the name doesn't match an existing `GrowthProfile` row, the template is skipped with a warning and no creature will spawn. Check server logs for `GrowthProfile named '...' not found`. Seeded growth profiles are `"Gains more strength"` and `"Fast Experience"`.
- **`creatureContentKey` mismatch.** If the creature content key doesn't match a `BaseCreature` row, the template is skipped silently. Verify via `GET /api/v1/creatures?contentKey=...`.
- **Sync overwrites pools on every startup.** The sync-config endpoint soft-deletes all existing pools and recreates them. If you have manually added pools via REST and then the SO syncs, the manual pools will be replaced. Use the SO as the single source of truth.
- **`deactivate` only toggles `is_active`.** It does not affect spawn state — there is none. Deactivation makes the validation phase reject spawns until you reactivate.

## Related Pages

- [Content Pipeline (Two-Database Model)](?page=unity/17-content-pipeline) — spawner templates/pools live in the read-only game-data DB; spawn history is player state
- [Creature Generation](?page=backend/04-creature-generation) — how `ICreatureGenerationService.CreateFromSpawnerAsync` builds a creature from a template
- [Backend Architecture](?page=backend/01-architecture) — `row_version`, transaction patterns, soft deletes
- [Introduction](?page=00-introduction) — dual SQLite/Postgres design rationale
- [Battle System](?page=unity/07-battle-system) — `SpawnerId` as wild trainer proxy, `SpawnerEncounterBehaviour`
