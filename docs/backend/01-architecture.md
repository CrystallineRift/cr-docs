# Backend Architecture

The backend is a collection of independently deployable domain modules unified by a single all-in-one host for local development. Understanding the layering and the dual-database strategy is essential before working in any specific domain.

## Why This Architecture?

### Why Not a Monolith or Microservices?

The chosen structure — domain modules wired by a single host — is a deliberate middle ground. Full microservices would require standing up eight separate Docker containers just to run the game locally, which is too much friction for a small team. A single-project monolith would make it impossible to run only the `Spawner` module inside Unity's offline SQLite environment without pulling in all of auth, trainers, creatures, and everything else.

The current structure lets you:
- Run all modules together in one process (`CR.REST.AIO`) for local dev
- Isolate and deploy individual domain modules independently in the future
- Compile only the SQLite implementations into the Unity client without pulling in Postgres drivers

### Why Dapper Instead of Entity Framework?

Dapper was chosen because the game's data access patterns are highly specific (paginated queries, soft-delete filters, content_id lookups) and benefit from explicit SQL that can be easily reviewed, optimized, and ported between SQLite and Postgres. EF's abstraction layer adds complexity in a dual-database scenario where subtle differences in query generation between providers can produce hard-to-debug bugs.

### Why FluentMigrator?

FluentMigrator supports multiple database target in a single migration class using its built-in database condition API. CR's schemas use only ANSI SQL types (`TEXT`, `INTEGER`, `BOOLEAN`, `REAL`) so the same migration runs identically against both PostgreSQL and SQLite without engine-specific branches. This is the foundation that makes the dual-database approach viable.

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

Each layer has a strict dependency rule:
- REST services depend on Domain services only (never on Data implementations)
- Domain services depend on Data interfaces only (never on Postgres or SQLite implementations)
- Data implementations depend on Data interfaces
- Nothing in Domain or REST layers touches raw SQL

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

Domains may call each other's domain service interfaces but never each other's repository implementations. For example, `NpcDomainService` depends on `ICreatureGenerationService` (from `Game/`) but never on `CreaturePostgresRepository` directly.

## Dependency Injection

Services are registered in `CR.REST.AIO/Program.cs` (server) and `LocalDevGameInstaller.cs` (Unity).

The pattern in `Program.cs` is always:

```csharp
// Interface → Implementation, singleton
builder.Services.AddSingleton<INpcDomainService, NpcDomainService>();
```

For `NpcDomainService` specifically, `Program.cs` uses `AddScoped` because it depends on `IDbConnectionFactory` which is scoped per request:

```csharp
builder.Services.AddScoped<INpcDomainService, NpcDomainService>();
```

For repositories the dual-DB pattern registers both a Postgres and a SQLite implementation keyed by environment:

```csharp
if (isPostgres)
    builder.Services.AddSingleton<INpcRepository, NpcPostgresRepository>();
else
    builder.Services.AddSingleton<INpcRepository, NpcSqliteRepository>();
```

In practice, `CR.REST.AIO/Program.cs` always registers Postgres implementations — local dev points that host at a local Postgres instance or a SQLite file configured via `config.yml`. The SQLite implementations are compiled into the Unity client only.

## Dual Database (PostgreSQL / SQLite)

The schema and migration files are shared. FluentMigrator generates SQL compatible with both engines because all column types and constraints use ANSI SQL with no engine-specific features:

- No `SERIAL` / `AUTOINCREMENT` (PKs are application-generated UUIDs)
- No stored procedures or triggers
- No JSON column types
- No `RETURNING` clauses (results fetched in a second query after insert)

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

### Gotcha: SQLite Boolean Columns

SQLite has no native `BOOLEAN` type. FluentMigrator maps `BOOLEAN` to `INTEGER` (0/1). The seed SQL for PostgreSQL uses `FALSE`/`TRUE`, but SQLite seed SQL must use `0`/`1`. If you write seed data by hand and mix these, Postgres will accept `0` as `FALSE` but SQLite will store `FALSE` as the text string `"FALSE"` which evaluates truthy in some drivers. Always use integer `0`/`1` in seed files that target both engines.

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

## Soft Deletes and Auditing

All tables include:
- `deleted BOOLEAN` — logical delete flag; queries always filter `WHERE deleted = 0/false`
- `created_at`, `updated_at` — full audit trail on every row
- `row_version INT` — optimistic concurrency on high-contention tables (spawner)

The `deleted` flag is the only safe way to remove data. No `DELETE FROM` statements exist in production code paths. This policy ensures:

1. Offline Unity clients can detect deletions during sync (a deleted row is a changed row, not a missing row)
2. The audit log is complete and irreversible
3. Debugging production issues is easier because historical state is always queryable

When querying data, all repository implementations add `AND deleted = false` (or `AND deleted = 0` for SQLite) to every `SELECT`. Forgetting this filter is the most common mistake in new repository implementations — always check your `WHERE` clause.

## All-In-One Host

`Convenience/CR.REST.AIO` wires every domain's REST service into a single ASP.NET host. This is the entry point for local development:

```bash
cd Convenience/CR.REST.AIO
dotnet run
```

`Program.cs` registers repositories, runs migrations inline during startup, registers domain services, and maps all endpoint groups. The startup sequence is:

1. Build configuration from `config.yml` + environment variables
2. Register repositories (Postgres implementations keyed by domain)
3. Run FluentMigrator for each domain (`AuthDatabaseMigrator`, `CreatureDatabaseMigrator`, etc.)
4. Register domain services
5. Register middleware (`PostgresGlobalErrorMiddleware`)
6. Map all endpoint groups
7. Start Kestrel

The `PostgresGlobalErrorMiddleware` catches unhandled exceptions and maps them to appropriate HTTP status codes, preventing raw exception details from leaking to clients.

In development mode, Swagger UI is served at `/swagger` for exploring all endpoints.

## Error Handling

The backend uses a small set of typed exceptions that map to HTTP status codes in middleware:

| Exception | HTTP Status |
|-----------|-------------|
| `NotFoundException` | 404 |
| `ValidationException` | 400 |
| `ConflictException` | 409 |
| Unhandled `Exception` | 500 |

Domain services throw these typed exceptions rather than returning nullable results for error cases. REST handlers do not contain try/catch blocks — they rely on the middleware.

## Common Mistakes / Tips

- **Forgetting `deleted = false` in queries.** Every hand-written query must include this filter. Add a unit test that inserts a soft-deleted row and verifies it is not returned.
- **Registering a domain service as `AddSingleton` when it depends on a scoped `IDbConnectionFactory`.** Use `AddScoped` for any service that holds or creates per-request DB connections.
- **Writing engine-specific SQL.** Run new queries against both SQLite (locally) and Postgres (CI) to catch type mismatches early.
- **Not running migrations before tests.** Integration tests must call `MigrateAll` on the test database before inserting fixtures or the schema will be missing.

## Related Pages

- [Introduction](?page=00-introduction) — project overview, repository map, key design concepts
- [NPC System](?page=backend/02-npc-system) — concrete example of the domain module pattern
- [Spawner System](?page=backend/03-spawner-system) — `row_version` usage, spawn transaction pattern
- [Auth and Accounts](?page=backend/06-auth-and-accounts) — auth middleware, token validation
- [Dependency Injection](?page=unity/02-dependency-injection) — Unity-side DI wiring mirrors the server pattern
