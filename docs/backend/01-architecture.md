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

Dapper was chosen because the game's data access patterns are highly specific (paginated queries, soft-delete filters, content_key lookups) and benefit from explicit SQL that can be easily reviewed, optimized, and ported between SQLite and Postgres. EF's abstraction layer adds complexity in a dual-database scenario where subtle differences in query generation between providers can produce hard-to-debug bugs.

### Why FluentMigrator?

FluentMigrator supports multiple database targets in a single migration class. CR's schemas use only ANSI SQL types (`TEXT`, `INTEGER`, `BOOLEAN`, `REAL`) so the same migration runs identically against both PostgreSQL and SQLite without engine-specific branches. This is the foundation that makes the dual-database approach viable.

Note: where the migration truly diverges (e.g., Postgres `gen_random_uuid()` defaults, or Postgres partial indexes), the migration uses a `bool isSqlite = ConnectionString.ToLower().Contains("data source")` guard and calls `Execute.Sql(...)` for engine-specific DDL. This keeps the FluentMigrator fluent API for schema structure and raw SQL only for truly divergent behaviour.

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
  Quests/        ← quest templates, instances, progress tracking
  Stats/         ← string-keyed lifetime stat store + audit log
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

## How to Add a New Domain — End-to-End

This is the canonical sequence for introducing a new domain (using `Guilds` as the example):

### 1. Create the folder structure

```
cr-api/Guilds/
  CR.Guilds.Data/            ← interfaces: IGuildRepository
  CR.Guilds.Data.Postgres/   ← GuildRepository : IGuildRepository
  CR.Guilds.Data.Sqlite/     ← GuildSqliteRepository : IGuildRepository
  CR.Guilds.Data.Migration/  ← FluentMigrator migrations
  CR.Guilds.Domain.Services/ ← IGuildDomainService + GuildDomainService
  CR.Guilds.Model.REST/      ← CreateGuildRequest, GuildResponse DTOs
  CR.Guilds.Service.REST/    ← MapGuildEndpoints() extension method
```

### 2. Write the migration

```csharp
[Migration(20240315_001)]
public class M20240315_001_CreateGuildTable : FluentMigrator.Migration
{
    public override void Up()
    {
        var isSqlite = ConnectionString.ToLower().Contains("data source") ||
                       ConnectionString.ToLower().Contains("sqlite");

        Create.Table("guild")
            .WithColumn("id").AsGuid().PrimaryKey()
            .WithColumn("content_key").AsString(64).NotNullable()
            .WithColumn("name").AsString(128).NotNullable()
            .WithColumn("deleted").AsBoolean().NotNullable().WithDefaultValue(false)
            .WithColumn("created_at").AsDateTime().NotNullable().WithDefault(SystemMethods.CurrentUTCDateTime)
            .WithColumn("updated_at").AsDateTime().NotNullable().WithDefault(SystemMethods.CurrentUTCDateTime);

        if (!isSqlite)
            Execute.Sql("ALTER TABLE guild ALTER COLUMN id SET DEFAULT gen_random_uuid()");

        Create.Index("idx_guild_content_key").OnTable("guild").OnColumn("content_key").Ascending();
    }

    public override void Down() => Delete.Table("guild");
}
```

### 3. Define the repository interface

```csharp
// CR.Guilds.Data/IGuildRepository.cs
public interface IGuildRepository : IRepository<Guild>
{
    Task<Guild?> GetByContentKeyAsync(string contentKey, CancellationToken ct = default);
}
```

### 4. Implement the domain service

The domain service depends only on repository interfaces — never on concrete implementations:

```csharp
public class GuildDomainService : IGuildDomainService
{
    private readonly IGuildRepository _guildRepository;

    public GuildDomainService(IGuildRepository guildRepository)
    {
        _guildRepository = guildRepository ?? throw new ArgumentNullException(nameof(guildRepository));
    }
    // ...
}
```

### 5. Map endpoints

```csharp
public static class GuildEndpoints
{
    public static WebApplication MapGuildEndpoints(this WebApplication app)
    {
        app.MapGet("/api/v1/guilds/{id}", async (Guid id, IGuildDomainService svc, CancellationToken ct) =>
        {
            var guild = await svc.GetGuildAsync(id, ct);
            return guild is null ? Results.NotFound() : Results.Ok(guild);
        });
        return app;
    }
}
```

### 6. Wire in Program.cs

```csharp
// Non-keyed registration — used by domain service via constructor injection
builder.Services.AddSingleton<IGuildRepository>(new GuildRepository(logger, configuration));

// Keyed registration — used by REST endpoints via [FromKeyedServices]
builder.Services.AddKeyedSingleton<IGuildRepository, GuildRepository>("guilds");

builder.Services.AddScoped<IGuildDomainService, GuildDomainService>();

if (!isSwaggerGen) new GuildDatabaseMigrator().Migrate(configuration);

// In endpoint mapping section:
app.MapGuildEndpoints();
```

Both keyed and non-keyed registrations are required. The domain service resolves `IGuildRepository` from the non-keyed registration. REST endpoints that need `[FromKeyedServices("guilds")]` use the keyed registration. Forgetting one causes a runtime DI failure.

## Real Migration Example

From `CR.Auth.Data.Migration/M0001CreateAccountTable.cs` — the actual `accounts` table migration:

```csharp
[Migration(0001)]
public class M0001CreateAccountTable : FluentMigrator.Migration
{
    public override void Up()
    {
        bool isSqlite = ConnectionString.ToLower().Contains("data source") ||
                       ConnectionString.ToLower().Contains("sqlite");

        if (isSqlite)
        {
            Create.Table("accounts")
                .WithColumn("id").AsGuid().PrimaryKey()
                .WithColumn("email").AsString(255).Nullable()
                .WithColumn("password_hash").AsString(255).Nullable()
                .WithColumn("salt").AsString(255).Nullable()
                .WithColumn("created_at").AsDateTime().NotNullable()
                    .WithDefault(SystemMethods.CurrentUTCDateTime)
                .WithColumn("updated_at").AsDateTime().NotNullable()
                    .WithDefault(SystemMethods.CurrentUTCDateTime)
                .WithColumn("deleted").AsBoolean().NotNullable().WithDefaultValue(false);
        }
        else
        {
            Create.Table("accounts")
                .WithColumn("id").AsGuid().WithDefaultValue(SystemMethods.NewGuid).PrimaryKey()
                // same columns…
                .WithColumn("deleted").AsBoolean().NotNullable().WithDefaultValue(false);

            // Postgres-only partial index — cannot express this in FluentMigrator fluent API
            Execute.Sql("CREATE INDEX idx_accounts_email_not_deleted ON accounts (email) WHERE NOT deleted");
        }

        Create.Index("idx_accounts_email").OnTable("accounts").OnColumn("email").Ascending();
        Create.Index("idx_accounts_deleted").OnTable("accounts").OnColumn("deleted").Ascending();
    }

    public override void Down() => Delete.Table("accounts");
}
```

Key patterns to copy:
- `isSqlite` guard for engine-specific DDL
- `SystemMethods.CurrentUTCDateTime` for timestamp defaults (FluentMigrator maps this to `NOW()` on Postgres and `CURRENT_TIMESTAMP` on SQLite)
- `deleted BOOLEAN NOT NULL DEFAULT false` on every table
- Partial indexes via `Execute.Sql` only on the Postgres branch

## Dependency Injection

Services are registered in `CR.REST.AIO/Program.cs` (server) and `LocalDevGameInstaller.cs` (Unity).

### Keyed vs Non-Keyed — Why Both Are Needed

Every repository in `Program.cs` gets two registrations: a non-keyed one for domain services and a keyed one for REST endpoint injection. From the actual `Program.cs`:

```csharp
// Keyed — used by REST endpoints via [FromKeyedServices("creature_db")]
builder.Services.AddKeyedSingleton<ICreatureRepository, CreatureRepository>(
    CreatureConstants.CREATURE_DB);

// Non-keyed — used by NpcDomainService and CreatureGenerationService
// which resolve ICreatureRepository from the DI container by type only
builder.Services.AddSingleton<ICreatureRepository>(
    new CreatureRepository(npcLogger, configuration));
```

The domain service constructor takes `ICreatureRepository` without any key — the DI container resolves the non-keyed registration. If only the keyed registration exists, the domain service constructor injection fails at runtime with a `InvalidOperationException: No service for type 'ICreatureRepository'`.

### Scoped vs Singleton

Most repositories are `AddSingleton` — they hold no per-request state. Domain services that depend on `IDbConnectionFactory` (which is `AddScoped`) must themselves be `AddScoped`:

```csharp
// IDbConnectionFactory is scoped — creates one connection per HTTP request
builder.Services.AddScoped<IDbConnectionFactory>(sp =>
    new PostgresConnectionFactory(sp.GetRequiredService<IConfiguration>(), "TrainerDatabase"));

// NpcDomainService injects IDbConnectionFactory → must be Scoped
builder.Services.AddScoped<INpcDomainService, NpcDomainService>();

// QuestDomainService injects IStatService (Scoped) → must be Scoped
builder.Services.AddScoped<IStatService, StatService>();
builder.Services.AddScoped<IQuestDomainService, QuestDomainService>();
```

### Soft-Delete Guard in Queries

Every hand-written SQL query in repository implementations must include `AND deleted = false` (Postgres) or `AND deleted = 0` (SQLite). A representative Postgres query from the NPC repository:

```sql
SELECT * FROM npcs
WHERE account_id = @AccountId
  AND trainer_id = @TrainerId
  AND id = @NpcId
  AND deleted = false
```

The SQLite equivalent uses `0` instead of `false`. Since parameterized queries via Dapper handle type mapping, you can pass C# `false` and Dapper will convert it correctly for both engines when using the `AsBoolean()` FluentMigrator column type. The most reliable approach is to use `@Deleted` parameters typed as `bool` and let Dapper handle the mapping rather than hardcoding `0` or `false` in the query string.

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

Run migrations standalone:

```bash
cd CR.<Domain>.Data.Migration
dotnet run -- --connectionString "<cs>" --database "Postgres"
```

Or use the unified runner in Unity (`DatabaseMigrationRunner.MigrateAll`). In `CR.REST.AIO`, migrations run inline at startup before the app starts serving requests:

```csharp
if (!isSwaggerGen) new AuthDatabaseMigrator().Migrate(configuration);
if (!isSwaggerGen) new CreatureDatabaseMigrator().Migrate(configuration);
if (!isSwaggerGen) new NpcDatabaseMigratorPostgres().Migrate(configuration);
// ... one per domain
```

### Gotcha: SQLite Boolean Columns

SQLite has no native `BOOLEAN` type. FluentMigrator maps `BOOLEAN` to `INTEGER` (0/1). The seed SQL for PostgreSQL uses `FALSE`/`TRUE`, but SQLite seed SQL must use `0`/`1`. Looking at the real seed migration `M7006_SeedStarterQuestData.cs`:

```csharp
if (isSqlite)
{
    Execute.Sql($@"INSERT OR IGNORE INTO quest_template (..., is_repeatable, ..., deleted, ...)
        VALUES ('{id}', ..., 0, ..., 0, ...)");   // ← integer 0, not false
}
else
{
    Execute.Sql($@"INSERT INTO quest_template (..., is_repeatable, ..., deleted, ...)
        VALUES ('{id}', ..., false, ..., false, ...)  -- ← boolean false
        ON CONFLICT (id) DO NOTHING");
}
```

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
2. Register repositories (keyed and non-keyed for each domain)
3. Run FluentMigrator for each domain (`AuthDatabaseMigrator`, `CreatureDatabaseMigrator`, etc.)
4. Register domain services (`AddScoped` for services that depend on `IDbConnectionFactory` or other Scoped services)
5. Register middleware (`PostgresGlobalErrorMiddleware`)
6. Map all endpoint groups (`app.MapNpcEndpoints()`, `app.MapQuestEndpoints()`, etc.)
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
- **Only registering the keyed repository and forgetting the non-keyed registration.** Domain services resolve the non-keyed binding. REST endpoints that use `[FromKeyedServices]` resolve the keyed binding. Both must exist or you get a runtime DI failure.
- **Writing engine-specific SQL.** Run new queries against both SQLite (locally) and Postgres (CI) to catch type mismatches early.
- **Not running migrations before tests.** Integration tests must call `MigrateAll` on the test database before inserting fixtures or the schema will be missing.
- **Using `SystemMethods.NewGuid` for the SQLite branch.** SQLite does not support `gen_random_uuid()` or equivalent as a column default. Generate the UUID in application code (e.g., `Guid.NewGuid()`) and pass it explicitly on insert. Only use `SystemMethods.NewGuid` in the Postgres branch.
- **Forgetting `isSwaggerGen` guards around migration calls.** The `SWAGGER_GEN=1` environment variable is set by the OpenAPI spec generator. If migrations run during spec generation, they may fail because no real database is configured. Always guard: `if (!isSwaggerGen) new MyMigrator().Migrate(configuration)`.

## Related Pages

- [Introduction](?page=00-introduction) — project overview, repository map, key design concepts
- [NPC System](?page=backend/02-npc-system) — concrete example of the domain module pattern
- [Spawner System](?page=backend/03-spawner-system) — `row_version` usage, spawn transaction pattern
- [Auth and Accounts](?page=backend/06-auth-and-accounts) — auth middleware, token validation
- [Dependency Injection](?page=unity/02-dependency-injection) — Unity-side DI wiring mirrors the server pattern
- [Quest System](?page=backend/07-quest-system) — concrete example of the scoped service pattern; stats side-effects
- [Stats and Lifetime Tracking](?page=backend/08-stats-system) — append-only audit log, Increment/Max/Set operators
