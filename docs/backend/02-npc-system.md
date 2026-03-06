# NPC System

## Overview

NPCs are world entities scoped to a specific trainer's world. Each NPC can hold a team of creatures and optionally give a starter creature to the player. NPCs are identified by a stable `content_id` (a GUID set in Unity's Inspector) that survives across sessions.

## Data Model

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID | Generated primary key |
| `content_id` | UUID | Stable identifier set by seed data / Unity Inspector |
| `content_key` | STRING | Human-readable key (e.g. `"cindris_starter_npc"`) |
| `trainer_id` | UUID | Owning trainer's world |
| `account_id` | UUID | Owning account |
| `npc_type` | STRING | `"starter"`, `"merchant"`, etc. |
| `name` | STRING | Display name |
| `deleted` | BOOLEAN | Soft delete |

Each NPC also has an associated **team inventory** (`npc_creature_team`) with up to 6 slots.

## Key Domain Operations

Source: `../cr-api/Npcs/CR.Npcs.Domain.Services/Interface/INpcDomainService.cs`

### `EnsureStarterNpcAsync`

Idempotent upsert — creates the NPC and loads its team with a starter creature on first call, returns the existing NPC on subsequent calls.

```csharp
Task<NpcBase> EnsureStarterNpcAsync(
    Guid accountId,
    Guid trainerId,
    Guid contentId,              // stable ID from Unity Inspector
    Guid starterCreatureBaseId,  // base creature to generate on first run
    CancellationToken ct = default);
```

### `GiveNpcCreatureToTrainerStorageAsync`

Transfers the first creature from the NPC's team into the trainer's storage inventory. Fails if the NPC has no creatures.

```csharp
Task<GeneratedCreature> GiveNpcCreatureToTrainerStorageAsync(
    Guid npcId,
    Guid accountId,
    Guid trainerId,
    CancellationToken ct = default);
```

### Other Operations

| Method | Purpose |
|--------|---------|
| `GetNpcAsync` | Fetch by UUID, scoped to account+trainer |
| `GetNpcByContentIdAsync` | Fetch by stable content_id |
| `GetNpcsByTrainerAsync` | List all NPCs in a trainer's world |
| `GetNpcsByTypeAsync` | Filter by NPC type (starter, merchant…) |
| `CreateNpcAsync` | Create NPC + team inventory |
| `UpdateNpcAsync` | Update NPC profile |
| `DeleteNpcAsync` | Soft delete |
| `AddCreatureToNpcTeamAsync` | Add creature to a team slot (1–6) |
| `RemoveCreatureFromNpcTeamAsync` | Remove creature from team |
| `SwapCreatureSlotsAsync` | Reorder team slots |

## REST Endpoints

All NPC endpoints are prefixed `/api/v1/npc`.

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/v1/npc/ensure-starter` | `EnsureStarterNpc` — idempotent upsert |
| `POST` | `/api/v1/npc/{id}/give-creature` | Give NPC's creature to trainer storage |
| `GET` | `/api/v1/npc/{id}` | Get NPC by ID |
| `GET` | `/api/v1/npc` | List NPCs for trainer |
| `POST` | `/api/v1/npc` | Create NPC |
| `PUT` | `/api/v1/npc/{id}` | Update NPC |
| `DELETE` | `/api/v1/npc/{id}` | Soft-delete NPC |

### EnsureStarterNpc request/response

```json
POST /api/v1/npc/ensure-starter
{
  "accountId":             "00000000-...",
  "trainerId":             "00000000-...",
  "contentId":             "aabb1234-...",   // from Unity Inspector
  "starterCreatureBaseId": "ccdd5678-..."    // base creature UUID
}

→ 200 OK
{
  "npcId":           "ffee9012-...",
  "hasCreatureToGive": true
}
```

## Modules & Projects

```
cr-api/Npcs/
  CR.Npcs.Data/                 ← interfaces (INpcRepository, INpcCreatureTeamRepository…)
  CR.Npcs.Data.Migration/       ← FluentMigrator migrations
  CR.Npcs.Data.Postgres/        ← PostgreSQL implementations
  CR.Npcs.Data.Sqlite/          ← SQLite implementations
  CR.Npcs.Domain.Services/      ← INpcDomainService, INpcMerchantService
  CR.Npcs.Model.REST/           ← EnsureStarterNpcRequest/Response, GiveCreatureRequest…
  CR.Npcs.Service.REST/         ← ASP.NET endpoints
```
