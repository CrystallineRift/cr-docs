# Content Pipeline (Two-Database Model)

The offline SQLite store is split into **two databases** with different lifecycles, ownership, and update mechanisms. This page describes the split, how the **game-data** artifact is built and shipped, and how each database is updated over the life of an installed app.

This is the single source of truth for the two-DB model. The [Project Setup](?page=unity/01-project-setup), [Content Registry](?page=unity/08-content-registry), and [Addressables Setup](?page=unity/09-addressables-setup) pages reference back to this page.

## Why Two Databases?

The old model used a single `.bytes` file (formerly `crgame.bytes`) for everything. That conflated two fundamentally different kinds of data:

- **Authored content** — base creatures, abilities, spawner zones, NPC definitions, quest templates. This is global, identical for every player, and changes only when the design team ships new content.
- **Player saves** — trainers, generated creatures, inventories, quest progress, stats, battles. This is per-account/per-trainer, mutable, and must survive app updates.

Mixing them meant a content update risked touching player saves, and there was no clean way to ship a fresh content snapshot without a migration. Splitting them lets each side use the update mechanism that fits:

| | game-data DB | player-data DB |
|---|---|---|
| Owns | Global authored content | Per-account / per-trainer saves |
| Mutated at runtime | No (read-only) | Yes |
| Built | At build time as a versioned artifact | Created on first run from migrations |
| Updated by | **Addressables** (content patch) | **In-place migrations** on app update |
| Migration DLLs | Not needed at runtime | Shipped in the binary |

## Content vs Player Taxonomy

What lives in each database:

**game-data DB** (global, authored, read-only):
- Base creatures, abilities, status conditions, growth profiles
- Items
- Spawner templates + pools + creature spawner templates
- NPC definitions + teams + inventory (content-world rows — see below)
- Quest templates + objectives + requirements + rewards
- `game_assets` (the Addressables asset catalog)
- Level / experience tables

**player-data DB** (per-account / per-trainer, mutable):
- Trainers
- Inventories (item, creature team, storage)
- Generated creatures
- Quest instances
- Stats
- Battles
- Spawn history
- Auth / session

> **Implementation note:** The unified migrator currently creates the full schema in **each** file. Content tables in player-data and player tables in game-data simply go unused — that is acceptable. The repositories are wired (`LocalDevGameInstaller`) so each repository reads/writes the correct database via `LocalDataSources.GameData` / `LocalDataSources.PlayerData`.

## The game-data Artifact (`game-data.bytes`)

The game-data database is built at build time as a versioned artifact named `game-data.bytes` (renamed from the old, unused `crgame.bytes`).

### How it is built

`CR.Data.Migrations.Tool` (`cr-api/Convenience/CR.Data.Migrations.Tool/Program.cs`) is invoked by `build-packages.sh` (`cr-api/Convenience/CR.Game.Compat/build-packages.sh`). It:

1. Deletes any existing output, then runs **all migrations** (schema + seed content with stable GUIDs) against a fresh SQLite file.
2. Reads the highest applied migration version (`SELECT MAX(Version) FROM VersionInfo`) and writes it to a companion file `game-data_schema_version.txt`.
3. Runs **12 referential-integrity checks** against the baked database. Any dangling content reference makes the tool exit non-zero, which **fails the build**.

The 12 checks (all assert zero dangling rows among non-deleted records):

| # | Reference |
|---|-----------|
| 1 | `spawner_pool.spawner_id` → `spawner.id` |
| 2 | `creature_spawner_template.spawner_id` → `spawner.id` |
| 3 | `creature_spawner_template.pool_id` → `spawner_pool.id` (nullable) |
| 4 | `creature_spawner_template.base_creature_id` → `creature.id` |
| 5 | `creature_spawner_template.growth_profile_id` → `growth_profile.id` |
| 6 | `creature_spawner_template.ability_progression_set_id` → `ability_progression_set.id` (nullable) |
| 7 | `ability_progression_set_entry.ability_progression_set_id` → `ability_progression_set.id` |
| 8 | `ability_progression_set_entry.ability_id` → `abilities.id` |
| 9 | `status_condition_stat_changes.status_condition_id` → `status_conditions.id` |
| 10 | `quest_objective_template.quest_template_id` → `quest_template.id` |
| 11 | `quest_reward_template.quest_template_id` → `quest_template.id` |
| 12 | `quest_requirement.quest_template_id` → `quest_template.id` |

`build-packages.sh` writes the artifact to `bin/unity-package/StreamingAssets/CR/game-data.bytes` (with its `game-data_schema_version.txt` companion) and aborts the package build if generation fails.

### How it ships and is adopted

The artifact ships **two ways**:

- As an **Addressable** — so content updates can be pushed without a binary update.
- Bundled in **StreamingAssets** — as the offline first-run floor, guaranteeing a usable content DB even before any network access.

At **cold start** the client adopts the artifact: an atomic copy into the working game-data path, gated by a **schema-version check**. The gate **fails closed** — if the artifact's schema version is newer than the binary's migration set can understand, adoption is refused rather than risking a half-understood schema.

> **Status:** The two-database split and the build-time artifact + integrity checks are in place. The Unity cold-start adopt (atomic copy + schema-version gate, reusing `AddressablesCatalogUpdater`) is tracked as **Part C-2** and is marked `TODO` in `DatabaseMigration.cs` / `LocalDataSources.cs`. Until it lands, the client runs the unified migrator against both files at startup (see [Project Setup — Hit Play](?page=unity/01-project-setup)).

### How content is patched (no save loss)

Content updates are delivered by patching the game-data Addressable, reusing the existing `AddressablesCatalogUpdater` (the same path that updates the asset bundle catalog). Because content lives in its own database, **a content update never touches player saves**.

## The player-data Database

The player-data database is **migrated in place** on app update. Migrations remain part of the codebase (scoped to player-data and the online-cache databases), and the migration DLLs **ship inside the binary** — they are never delivered via Addressables.

The reason is platform constraints: IL2CPP / AOT cannot load code at runtime, and app-store policies forbid shipping executable code out-of-band. So all schema evolution for player saves rides along with the binary and runs on first launch after an update.

## Putting It Together — Update Scenarios

| Event | game-data DB | player-data DB |
|-------|--------------|----------------|
| New content (no app update) | Addressable patch adopts a newer `game-data.bytes` (subject to the schema-version gate) | Untouched |
| App update with schema changes | Newer artifact bundled + Addressable; adopted at cold start | In-place migrations run on first launch |
| Fresh install | StreamingAssets artifact is the first-run floor | Created from migrations |

## Related Pages

- [Project Setup](?page=unity/01-project-setup) — database path config keys, startup migration flow
- [Content Registry](?page=unity/08-content-registry) — the in-memory content catalog and server manifest upgrade
- [Addressables Setup](?page=unity/09-addressables-setup) — asset bundle pipeline and catalog updates
- [NPC System](?page=backend/02-npc-system) — NPC content globalization via `ContentWorldId`
- [Spawner System](?page=backend/03-spawner-system) — global read-only spawner templates
