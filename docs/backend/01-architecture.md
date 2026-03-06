# Backend Architecture

## Layer Diagram

```
┌─────────────────────────────────────────────────────────┐
│                   REST Services                         │
│  CR.Npcs.Service.REST  │  CR.Spawner.Service.REST  │…   │
├─────────────────────────────────────────────────────────┤
│                  Domain Services                        │
│  CR.Npcs.Domain.Services  │  CR.Game.Domain.Services   │
├─────────────────────────────────────────────────────────┤
│                   Data Layer                            │
│  CR.Npcs.Data.{Postgres,Sqlite}  │  CR.Spawner.Data.*  │
├──────────────────────┬──────────────────────────────────┤
│     PostgreSQL       │          SQLite                  │
│  (production/server) │  (Unity offline / local dev)    │
└──────────────────────┴──────────────────────────────────┘
```

## Domain Module Boundaries

Each feature domain is a self-contained folder at the repo root:

```
cr-api/
  Auth/          ← accounts, tokens, OAuth
  Creatures/     ← base creatures, abilities, growth profiles
  Npcs/          ← NPC CRUD, team management, starter flow
  Spawner/       ← weighted spawn pools, creature generation
  Trainers/      ← trainer profiles, inventory
  Game/          ← high-level orchestration (sessions, battles, items)
  Common/        ← shared data contracts, base repositories
  Convenience/   ← CR.REST.AIO: single host wiring all modules
```

Every domain follows the same project structure:

| Project suffix | Responsibility |
|---------------|----------------|
| `*.Data` | Interfaces for repositories |
| `*.Data.Migration` | FluentMigrator migrations |
| `*.Data.Postgres` | PostgreSQL implementations |
| `*.Data.Sqlite` | SQLite implementations |
| `*.Domain.Services` | Business logic, portable (no HTTP) |
| `*.Model.REST` | Request/response DTOs |
| `*.Service.REST` | ASP.NET minimal-API endpoints |

## Dependency Injection

Services are registered in `CR.REST.AIO/Program.cs` (server) and `LocalDevGameInstaller.cs` (Unity).

The pattern is always:

```csharp
// Interface → Implementation, singleton
builder.Services.AddSingleton<INpcDomainService, NpcDomainService>();
```

For repositories the dual-DB pattern registers both a Postgres and a SQLite implementation keyed by environment:

```csharp
if (isPostgres)
    builder.Services.AddSingleton<INpcRepository, NpcPostgresRepository>();
else
    builder.Services.AddSingleton<INpcRepository, NpcSqliteRepository>();
```

## Dual Database (PostgreSQL / SQLite)

The schema and migration files are shared. FluentMigrator generates SQL compatible with both engines.

| Context | Database | Connection key |
|---------|----------|---------------|
| Production server | PostgreSQL | `--database Postgres` |
| Local dev (server) | SQLite | `--database SQLite` |
| Unity offline | SQLite | `TrainerDatabase` / `SpawnerDatabase` |
| Unity online cache | SQLite | `*OnlineCache` databases |

Run migrations:

```bash
cd CR.<Domain>.Data.Migration
dotnet run -- --connectionString "<cs>" --database "Postgres"
```

Or use the unified runner in Unity (`DatabaseMigrationRunner.MigrateAll`).

## Database ERD (summary)

Key tables and relationships — see `../cr-api/Docs/database_diagram_erd.md` for the full Mermaid diagram.

**Creature system**
- `creature` → `generated_creature` (base → instances)
- `generated_creature` → `growth_profile` (stat scaling)
- `generated_creature` → `abilities` ×4 (active moves)

**Spawner system**
- `spawner` → `spawner_pool` → `creature_spawner_template`
- `spawner_spawn_history` records every spawn event

**Trainer system**
- `accounts` → `trainers` (one account, multiple trainers)
- `trainers` → `trainer_inventory` (creature, item storage)

**Auth**
- `accounts` stores hashed credentials + salt

## Soft Deletes & Auditing

All tables include:
- `deleted BOOLEAN` — logical delete, never physically removed
- `created_at`, `updated_at` — full audit trail
- `row_version INT` — optimistic concurrency on high-contention tables (spawner)

## All-In-One Host

`Convenience/CR.REST.AIO` wires every domain's REST service into a single ASP.NET host. This is the entry point for local development:

```bash
cd Convenience/CR.REST.AIO
dotnet run
```
