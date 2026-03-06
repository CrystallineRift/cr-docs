# Crystalline Rift — Overview

Crystalline Rift is a creature-collection RPG built across two primary repositories and a shared documentation site. This page describes the high-level structure, the tech stack, and how the pieces fit together. If you are new to the project, read this page first before diving into any backend or Unity-specific docs.

## Why This Architecture?

Crystalline Rift was designed with two hard constraints from day one:

1. **The game must be playable offline.** A player on an airplane or with no internet should still be able to battle, catch creatures, and manage their team. This ruled out a purely server-authoritative architecture and required a local data store in the Unity client.

2. **Local development must not require a running Postgres server.** New contributors should be able to clone the repo, hit Play in Unity, and have a working game without setting up database servers. This ruled out embedding Postgres-only schemas everywhere.

Both constraints are solved by the same mechanism: every schema and repository is written twice — once for PostgreSQL (production) and once for SQLite (local/offline). FluentMigrator runs the same migration files against both engines because all SQL uses ANSI-compatible syntax with no engine-specific extensions.

The result is a system where:
- The backend in production uses PostgreSQL for durability and concurrent multi-user access
- The backend in local dev uses SQLite for zero-setup iteration
- The Unity client carries its own SQLite databases for full offline play
- When online, Unity switches to HTTP clients that call the same REST endpoints the server exposes

## Repository Map

| Repo | Purpose | Stack |
|------|---------|-------|
| `cr-api` | Backend REST API | .NET 8, C#, Dapper, FluentMigrator |
| `cr-data` | Unity client | Unity 2022 LTS, C#, Zenject, Best HTTP |
| `cr-docs` | This documentation site | Vanilla HTML/JS, marked.js, highlight.js |

Clone all three side-by-side for cross-repo navigation:

```bash
cd ~/Documents/GitHub
git clone https://github.com/CrystallineRift/cr-api.git
git clone https://github.com/CrystallineRift/cr-data.git
git clone https://github.com/CrystallineRift/cr-docs.git
```

## Tech Stack

### Backend (`cr-api`)

- **.NET 8** minimal-API REST services — chosen for low-ceremony endpoint registration, excellent async/await support, and straightforward DI integration
- **Dapper** for SQL data access — no ORM magic, queries are explicit SQL, easy to audit and optimize
- **FluentMigrator** for schema migrations — supports multiple database targets (Postgres, SQLite) from the same migration classes
- **PostgreSQL** in production — reliable, battle-tested, handles concurrent writes gracefully
- **SQLite** for local/Unity offline use — embedded, zero-setup, full SQL support
- Domain-Driven Design: each feature lives in its own module (`Npcs/`, `Spawner/`, `Auth/`, `Creatures/`, `Trainers/`, `Game/`). No module imports another's data layer directly; cross-domain calls go through domain service interfaces.

### Unity Client (`cr-data`)

- **Unity 2022 LTS** 3D project — LTS release chosen for stability over long development cycles
- **Zenject** for dependency injection — constructor injection across MonoBehaviours, supports scene contexts and installer chaining
- **Best HTTP** for HTTP requests — async-native HTTP library designed for Unity's threading model
- **Newtonsoft.Json** for serialization — consistent JSON handling matching the backend's serialization
- Dual online/offline data layer — the same repository interface is implemented by both a SQLite class (offline) and an HTTP client class (online). A router implementation picks between them based on network state at runtime.

## Core Systems

| System | Backend Module | Unity Namespace |
|--------|---------------|-----------------|
| NPC Management | `Npcs/` | `CR.Game.World` |
| Spawner | `Spawner/` | `CR.Spawner.*` |
| Creatures | `Creatures/`, `Game/` | `CR.Creatures.*` |
| Trainers | `Trainers/` | `CR.Trainers.*` |
| Auth | `Auth/` | `CR.Auth.*` |
| Battle | `Game/CR.Game.BattleSystem` | `CR.Game.BattleSystem` |

Each system follows the same layering pattern: interfaces in a shared `*.Data` project, Postgres implementation in `*.Data.Postgres`, SQLite implementation in `*.Data.Sqlite`, business logic in `*.Domain.Services`, and REST endpoints in `*.Service.REST`. See [Backend Architecture](?page=backend/01-architecture) for details.

## Key Design Concepts

### content_id vs UUID

Every game entity that has a counterpart in Unity's `game_config.yaml` asset system carries two identifiers:

- `id` (UUID) — the internal database primary key, generated at row creation, never exposed to designers
- `content_id` (UUID) / `content_key` (string) — a stable identifier that Unity's Inspector fields reference, matching keys in `game_config.yaml`

This separation means a game designer can rename a creature, move it to a different YAML section, or change its display properties without touching the database schema or invalidating existing rows. The backend looks up entities by `content_id` when bridging from Unity's world to the database, and uses `id` for all internal foreign key relationships.

### Soft Deletes

No table in Crystalline Rift ever has rows physically removed. Every `DELETE` operation sets `deleted = true` on the row and updates `updated_at`. This design choice serves two purposes:

1. **Audit trail** — you can always see what existed, when it was removed, and reconstruct historical state
2. **Offline sync consistency** — when a Unity client syncs its offline SQLite cache with the server, it receives delete events as updates to the `deleted` flag rather than missing rows. This avoids ambiguity between "not synced yet" and "actually deleted".

### row_version for Concurrency

High-contention tables (notably `spawner`) carry a `row_version INT` column. This prepares the schema for optimistic concurrency patterns where two processes might attempt to update the same spawner simultaneously. Currently `row_version` is incremented on update but not yet used to reject stale writes — that enforcement is planned once multiplayer spawner contention becomes a real concern.

## Serving the Docs

```bash
cd cr-docs
node generate-nav.js       # rebuild nav.json after adding pages
npx serve .                # open http://localhost:3000
```

Or open `index.html` directly with VS Code Live Server.

## Related Pages

- [Backend Architecture](?page=backend/01-architecture) — layer diagram, module structure, DI wiring
- [NPC System](?page=backend/02-npc-system) — NPC data model, domain operations, REST endpoints
- [Spawner System](?page=backend/03-spawner-system) — weighted pool spawning, schema, spawn algorithm
- [Creature Generation](?page=backend/04-creature-generation) — stat calculation, growth profiles, natures
- [Starter Creature Flow](?page=backend/05-starter-creature-flow) — end-to-end walkthrough from world boot to creature transfer
- [Auth and Accounts](?page=backend/06-auth-and-accounts) — bearer tokens, Discord OAuth, token management
- [Unity Project Setup](?page=unity/01-project-setup) — repo structure, plugins, game_config.yaml
- [Dependency Injection](?page=unity/02-dependency-injection) — Zenject installer, online/offline pattern
- [World Behaviours](?page=unity/03-world-behaviours) — IWorldInitializable, WorldRegistry, GameInitializer
- [NPC Interaction](?page=unity/04-npc-interaction) — NpcWorldBehaviour, NpcInteractionBehaviour
- [HTTP Clients](?page=unity/05-http-clients) — SimpleWebClient, typed client pattern, error handling
