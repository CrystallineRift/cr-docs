# Crystalline Rift — Overview

Crystalline Rift is a creature-collection RPG built across two primary repositories and a shared documentation site.

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
- **.NET 8** minimal-API REST services
- **Dapper** for SQL data access (no ORM)
- **FluentMigrator** for schema migrations
- **PostgreSQL** in production, **SQLite** for local/Unity offline use
- Domain-Driven Design: each feature lives in its own module (`Npcs/`, `Spawner/`, `Auth/`, `Creatures/`, `Trainers/`, `Game/`)

### Unity Client (`cr-data`)
- **Unity 2022 LTS** 3D project
- **Zenject** for dependency injection
- **Best HTTP** for HTTP requests
- **Newtonsoft.Json** for serialization
- Dual online/offline data layer (SQLite for offline cache, HTTP for online)

## Core Systems

| System | Backend Module | Unity Namespace |
|--------|---------------|-----------------|
| NPC Management | `Npcs/` | `CR.Game.World` |
| Spawner | `Spawner/` | `CR.Spawner.*` |
| Creatures | `Creatures/`, `Game/` | `CR.Creatures.*` |
| Trainers | `Trainers/` | `CR.Trainers.*` |
| Auth | `Auth/` | `CR.Auth.*` |
| Battle | `Game/CR.Game.BattleSystem` | `CR.Game.BattleSystem` |

## Serving the Docs

```bash
cd cr-docs
node generate-nav.js       # rebuild nav.json after adding pages
npx serve .                # open http://localhost:3000
```

Or open `index.html` directly with VS Code Live Server.
