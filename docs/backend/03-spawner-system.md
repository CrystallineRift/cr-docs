# Spawner System

The Spawner system manages generation, storage, and lifecycle of spawnable creatures. It uses a **weighted pool** model: spawners hold pools, pools hold creature templates, and templates define how a creature is generated. Understanding the spawn algorithm and the intentional simplicity of the MVP design is key to extending this system correctly.

## Why This Design?

### Why a Weighted Pool Instead of Direct Spawn Rates?

The two-level hierarchy (spawner → pools → templates) exists to support rarity tiers cleanly. Instead of assigning spawn probabilities directly to each creature template and trying to balance dozens of percentages that must sum to 100%, the design separates the question "which tier should spawn?" from the question "which creature within that tier?".

The pool selection uses `weight × rarity_multiplier` as a composite weight. This means you can define a "Legendary" pool with a low weight and boost it situationally (e.g., during an event) by temporarily raising its `rarity_multiplier` without touching the individual template probabilities inside it.

### Why Is the MVP Intentionally Simple?

The spawner was designed to ship creature encounters as quickly as possible. The current MVP has no:
- Per-trainer spawn tracking (the same spawner generates for any trainer)
- Real-time cooldown enforcement across multiple API instances
- Area-of-effect region filtering (all spawners are globally accessible by ID)

These features will be added incrementally. The `row_version` column on the `spawner` table already exists specifically to support future optimistic concurrency control when multiple server instances might simultaneously try to update the same spawner's `current_count`.

The `spawnCooldownSeconds` field exists in the schema and is checked in the validation phase, but in practice most development spawners use a cooldown of 0 to make iteration fast. Tune this in production to prevent flooding.

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
| `spawner` | Spawner config (capacity, cooldown, type, current_count, row_version) |
| `spawner_pool` | Weighted pools within a spawner |
| `creature_spawner_template` | Creature blueprints per pool |
| `ability_progression_set` | Reusable ability sets for templates |
| `ability_progression_set_entry` | Level-based entries per set |
| `spawner_spawn_history` | Full spawn event log |

Key columns on `spawner`:
- `current_count` — how many creatures have been spawned (incremented after each spawn, checked against `max_capacity`)
- `last_spawn_time` — timestamp of the most recent spawn (used for cooldown calculation)
- `row_version` — incremented on every update, reserved for future optimistic concurrency
- `is_active` — only active spawners accept spawn requests
- `deleted` — soft delete flag
- `content_key` — optional designer-facing key (e.g. `"starter-wild-zone"`); unique per trainer when set

The Unity-side `SpawnerDefinition` ScriptableObject mirrors the backend `content_key` and adds a second field used by the battle system:

| Field | Description |
|-------|-------------|
| `contentKey` | Must match `content_key` in the backend DB |
| `battleArenaKey` | Arena key used to look up the `BattleArena` MonoBehaviour in the scene. Must match `BattleArena.arenaKey` on the corresponding arena prefab. Leave empty to skip arena teleportation during wild encounters. |

Key columns on `creature_spawner_template`:
- `base_creature_id` — which creature species to generate
- `growth_profile_id` — which stat scaling curve to use
- `ability_progression_set_id` — nullable; which ability set to use (null = no abilities)
- `min_level` / `max_level` — level range for generated creatures
- `spawn_probability` — relative probability within the pool (does not need to sum to 1.0; the service normalizes)
- `variant_type` — `"normal"`, `"shiny"`, `"legendary"`

## Spawn Algorithm

The full spawn flow in `CreatureSpawnDomainService.SpawnCreaturesAsync`:

1. **Validation phase** — fetch the spawner; verify it exists, `is_active = true`, `current_count < max_capacity`, and cooldown not active (`last_spawn_time + cooldown_seconds < now`)
2. **Pool selection phase** — fetch all active pools for the spawner; compute `totalWeight = SUM(pool.spawn_weight × pool.rarity_multiplier)`; pick a uniform random value in `[0, totalWeight]`; walk the pools accumulating weight until the random value is covered; fall back to the last pool if floating-point rounding overshoots
3. **Template selection phase** — fetch all active templates for the selected pool via `GetTemplatesByProbabilityAsync`; normalize by `SUM(spawn_probability)`; same weighted random walk; fall back to last template
4. **Quantity generation** — use `request.RequestedQuantity` (future: clamp to `[min_quantity, max_quantity]` from the template)
5. **Creature generation** — call `ICreatureGenerationService.CreateFromSpawnerAsync(template.Id, trainerId, seed)` for each creature; null results (e.g., from a missing trainer ID) are silently skipped
6. **Spawn execution (transactional)** — open a connection, begin a transaction; write one `spawner_spawn_history` row per spawned creature; increment `spawner.current_count` and set `spawner.last_spawn_time`; commit; roll back if either step fails

The transaction in step 6 ensures that if history recording fails, the spawner count is not incremented and vice versa.

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

`SpawnerDomainService` exposes an idempotent upsert method used during world bootstrap:

```csharp
Task<SpawnerDomain> EnsureSpawnerForTrainerAsync(
    Guid accountId, Guid trainerId, string contentKey,
    CancellationToken ct = default);
```

This method:
1. Calls `GetSpawnerByContentKeyAsync(accountId, trainerId, contentKey)` — if found, returns the existing spawner
2. If not found, calls `GetSpawnerTemplateByContentKeyAsync(contentKey)` to load a shared template
3. Creates a new spawner row from the template (including all pools and creature templates) for this specific `(accountId, trainerId)` pair
4. Returns the new spawner

This mirrors the NPC system's `EnsureStarterNpcAsync` pattern — the same content_key on different trainers results in separate but identically configured spawner instances.

## How to Reset Spawner Capacity

During development it is common for `current_count` to accumulate to `max_capacity` and block all spawns. There are two approaches:

**Option A: Deactivate and reactivate** — calling `/spawner/{id}/deactivate` followed by `/spawner/{id}/activate` does NOT reset `current_count`. This only toggles `is_active`.

**Option B: Direct SQL update** — the intended way to reset capacity for testing:

```sql
-- Postgres / SQLite
UPDATE spawner
SET current_count = 0, updated_at = NOW()
WHERE id = '<spawner-uuid>';
```

A future admin endpoint should wrap this as `POST /spawner/{id}/reset-capacity`. Until then, use direct SQL or create a test-only utility that calls the repository directly.

After resetting, the spawner will accept spawn requests again on the next `POST /spawner/{id}/spawn` provided `is_active = true` and the cooldown has elapsed.

**What happens after reset:** The `spawner_spawn_history` is NOT cleared — the audit log is immutable. `current_count` is the only counter that gates new spawns. History entries from before the reset remain queryable via `/spawner/{id}/history`.

## Wild Battle Proxy and Capacity Reduction

`SpawnerEncounterBehaviour` in Unity triggers a spawn before initiating the battle. The spawn call:

```json
POST /spawner/{spawnerId}/spawn
{
  "trainerId": "<trainerId>",
  "requestedQuantity": 1,
  "spawnSessionId": "<session-uuid>"
}
```

This increments `current_count` by 1 and writes a `spawner_spawn_history` row. The generated creature is stored under the Wild Trainer account (GUID `00000000-0000-0000-0000-000000000001` — see the Unity Integration section below). The battle engine loads this creature via `ICreatureInventoryService.GetTeamAsync(wildTrainerId)`.

If the player flees the battle, the capacity is NOT restored — the spawn already happened. This means spawner capacity represents "total encounters generated" not "currently active encounters". Size your `max_capacity` accordingly (e.g., set it to a very large number like 1,000,000 for perpetual wild zones, or a small number like 5 for a limited-event spawner).

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
| `GET`  | `/spawner` | List all spawners |
| `GET`  | `/spawner/{id}` | Get spawner |
| `POST` | `/spawner` | Create spawner |
| `POST` | `/spawner/{id}/activate` | Activate |
| `POST` | `/spawner/{id}/deactivate` | Deactivate |

### Spawning

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/spawner/{id}/spawn` | Spawn creatures |
| `GET`  | `/spawner/{id}/status` | Spawner status (current_count, cooldown, is_active) |
| `GET`  | `/spawner/{id}/history` | Paginated spawn history |

## `SpawnRequest` Model

```csharp
public class SpawnRequest
{
    public Guid? TrainerId { get; set; }       // required for creature generation
    public int RequestedQuantity { get; set; } = 1;
    public Guid? SpawnSessionId { get; set; }  // optional; auto-generated if null
}
```

`TrainerId` is optional at the API level but required for creature generation. If `TrainerId` is null, `GenerateCreatureAsync` returns null and the creature is skipped. A spawn request with `TrainerId = null` will return a successful result with zero spawned creatures.

## Error Codes

| Status | Meaning |
|--------|---------|
| 404 | Spawner not found / no templates available |
| 400 | Validation error (invalid request) |
| 409 | Spawner at capacity (`current_count >= max_capacity`) |
| 429 | Cooldown active |
| 500 | Internal error |

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

## Common Mistakes / Tips

- **Spawner not active.** The most common reason `SpawnCreaturesAsync` returns `ValidationError`. Always call `activate` after creating a spawner.
- **No templates in the pool.** If a pool has no active templates, `SelectTemplateAsync` returns null and the spawn returns `NoTemplatesAvailable`. Verify templates are marked `is_active = true`.
- **Spawn probabilities don't need to sum to 1.** The service normalizes by the total. However, all templates in a pool with `spawn_probability = 0` will never be selected. Use at least 0.01 for any template you want to include.
- **Missing `trainerId` in spawn request.** Spawns succeed but generate zero creatures. Add `trainerId` to the request body.
- **Capacity not reset after testing.** After testing, `current_count` accumulates. Reset it via direct SQL update (`UPDATE spawner SET current_count = 0`) or delete and recreate the spawner. A future admin endpoint should support count reset without direct DB access.
- **Using the wrong `content_key` in the world behaviour.** If `_spawnerContentKey` does not match any spawner template row, `GetSpawnerTemplateByContentKeyAsync` returns null and `EnsureSpawnerForTrainerAsync` throws `InvalidOperationException`. Verify the key matches the seed data exactly (case-sensitive).
- **Assuming `deactivate` resets capacity.** Deactivation only sets `is_active = false`. `current_count` is preserved. If you want to "reset" a spawner, reset `current_count` via SQL and re-activate separately.
- **Forgetting that capacity reduction is permanent.** Each spawn call increments `current_count` permanently (there is no decrement on battle flee). Size `max_capacity` appropriately for your use case. For indefinitely repeating wild zones, use a very large value like 999999 or periodically reset via admin tooling.

## Related Pages

- [Creature Generation](?page=backend/04-creature-generation) — how `ICreatureGenerationService.CreateFromSpawnerAsync` builds a creature from a template
- [Backend Architecture](?page=backend/01-architecture) — `row_version`, transaction patterns, soft deletes
- [Introduction](?page=00-introduction) — dual SQLite/Postgres design rationale
- [Battle System](?page=unity/07-battle-system) — `SpawnerId` as wild trainer proxy, `SpawnerEncounterBehaviour`
