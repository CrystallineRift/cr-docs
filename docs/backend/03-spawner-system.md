# Spawner System

> Source: `../cr-api/Spawner/README.md`

## Overview

The Spawner system manages generation, storage, and lifecycle of spawnable creatures. It uses a **weighted pool** model: spawners hold pools, pools hold creature templates, and templates define how a creature is generated.

The system follows the **MVP pattern** for portability between the Unity client (SQLite) and the REST API (PostgreSQL).

## Architecture

```
CR.Spawner.Data            ← interfaces + base data access
CR.Spawner.Data.Migration  ← FluentMigrator migrations
CR.Spawner.Data.Postgres   ← PostgreSQL implementations
CR.Spawner.Data.Sqlite     ← SQLite implementations
CR.Spawner.Domain          ← portable domain services (ISpawnerDomainService, etc.)
CR.Spawner.Model.REST      ← DTOs
CR.Spawner.Service.REST    ← ASP.NET minimal-API endpoints
```

## Database Schema

| Table | Purpose |
|-------|---------|
| `spawner` | Spawner config (capacity, cooldown, type) |
| `spawner_pool` | Weighted pools within a spawner |
| `creature_spawner_template` | Creature blueprints per pool |
| `ability_progression_set` | Reusable ability sets for templates |
| `ability_progression_set_entry` | Level-based entries per set |
| `spawner_spawn_history` | Full spawn event log |

## Spawn Algorithm

1. **Validation** — spawner exists, is active, not at capacity, cooldown not active
2. **Pool selection** — weighted random pick from `spawner_pool` (weight × rarity_multiplier)
3. **Template selection** — probability distribution within selected pool
4. **Quantity generation** — random quantity in `[min_quantity, max_quantity]`
5. **Creature generation** — creates `GeneratedCreature` with stats, natures, abilities
6. **Spawn execution** — updates spawner counters, records history, returns result

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

### 4. Spawn

```json
POST /spawner/{spawnerId}/spawn
{ "requestedQuantity": 1 }
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
| `GET`  | `/spawner/{id}/status` | Spawner status |

## Error Codes

| Status | Meaning |
|--------|---------|
| 404 | Spawner not found / no templates available |
| 400 | Validation error |
| 409 | Spawner at capacity |
| 429 | Cooldown active |
| 500 | Internal error |

## Performance Targets

- Spawn operation: < 200 ms (p95)
- Spawner status: < 50 ms (p95)
- Max QPS: 1 000 spawns/sec per spawner
