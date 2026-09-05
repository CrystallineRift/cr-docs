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
- Quest templates + objectives + requirements + rewards
- `game_assets` (the Addressables asset catalog)
- Level / experience tables

NPC *definitions* are authored content too, but they reach the offline client through the **content registry** (ScriptableObjects / server manifest), not the offline `npcs` table — so the physical `npcs` / `npc_creature_team` / `npc_inventory` tables live in **player-data** (see below).

**player-data DB** (per-account / per-trainer, mutable):
- Trainers
- Inventories (item, creature team, storage)
- Generated creatures
- **Per-trainer NPC instances** — `npcs`, `npc_creature_team`, `npc_inventory`
- Quest instances
- Stats
- Battles
- Spawn history
- Auth / session

> **NPC instance tables are player-data, not game-data.** `EnsureNpcAsync` creates `npcs` rows per `(account, trainer)` at world bootstrap — runtime save-data, not designer content. They were originally (and incorrectly) bound to `LocalDataSources.GameData.OfflineSource`; because game-data is read-only and re-adopted from the baked artifact, an adoption could **wipe runtime NPCs**. `INpcRepository` and `INpcCreatureTeamRepository` are now bound to `PlayerData.OfflineSource` in `LocalDevGameInstaller`, co-located with `npc_inventory` so FK integrity and the merchant purchase transaction stay on a single physical DB.

> **Implementation note:** The unified migrator currently creates the full schema in **each** file. Content tables in player-data and player tables in game-data simply go unused — that is acceptable. The repositories are wired (`LocalDevGameInstaller`) so each repository reads/writes the correct database via `LocalDataSources.GameData` / `LocalDataSources.PlayerData`.

> **Online-cache DBs must be migrated too.** In **online** mode, content/player repos route through cache-then-server-fill online repos (e.g. `CreatureOnlineRepository`): a cache miss fetches from the server and writes the row back into a **per-domain online-cache SQLite** (`baseCreatureOnlineCache.bytes`, `trainerItemInventoryOnline.bytes`, …). Those DBs are neither adopted (that's game-data only) nor backed by the populated game-data/player-data — so they must be **migrated for schema**, or the fill INSERT throws `no such table` (an online-mode boot crash, surfaced as `no such table: creature`). The complete set of writable DBs to migrate is enumerated in **`LocalDataSources.MigratableSources`** (player-data + every `OnlineCacheSource`; game-data excluded). `LocalDevGameInstaller.KickOffMigrations` resolves and dedupes those connection strings on the main thread, then migrates each off-thread behind `DbReadyGate`. When you add a cached domain, add its `OnlineCacheSource` to `MigratableSources`.

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

`build-packages.sh` writes the artifact to `bin/unity-package/StreamingAssets/CR/game-data.bytes` (with its `game-data_schema_version.txt` companion) and aborts the package build if generation fails. It then **auto-copies** the freshly baked `game-data.bytes` + version file into `cr-api-unity/Assets/StreamingAssets/CR/`, so the live Unity project always picks up the latest bake. (The manual **`CR → Content → Bake Game-Data DB`** editor menu still exists but is now optional — only needed for ad-hoc rebakes from inside the Editor.)

:::caution
**Two migration paths, two build graphs.** The bake tool runs the migrations from a `dotnet run` (Debug) build of its own project graph, so the floor always carries the newest migration classes. The `*.Data.Migration.dll`s that ship inside the Unity package (used by the client to migrate its **online-cache** DBs) come from each project's **Release** output, built by the script's per-project `build_if_needed` list. A migration project missing from that list is *copied* but never *rebuilt* — its DLL gets a fresh mtime and stale contents, and the floor and the client disagree about the schema. `Game/CR.Game.Data.Migration` was exactly that case until 2026-09-03 (nothing in the compat csproj graph references it). Verify a shipped migration with `strings bin/unity-package/Runtime/CR.<Domain>.Data.Migration.dll | grep M<number>`, never with `ls -l`.
:::

### How it ships and is adopted

The artifact ships **two ways**:

- As an **Addressable** — so content updates can be pushed without a binary update.
- Bundled in **StreamingAssets** — as the offline first-run floor, guaranteeing a usable content DB even before any network access.

At **cold start** the client adopts the artifact: an atomic copy into the working game-data path, gated on **two** triggers. `GameDataAdopter` re-adopts when **either**:

- the bundled schema version (`game-data_schema_version.txt`, = `MAX(VersionInfo)`) exceeds the adopted copy's, **or**
- a **SHA-256 of the bundled `game-data.bytes`** differs from a `.srchash` marker written next to the adopted copy.

The content-hash trigger fixes the long-standing "offline content keeps vanishing" bug: previously adoption was gated **only** on schema version, so a content-only re-bake at the same migration head (same `MAX(VersionInfo)`) silently never re-adopted, and authored content edits never reached the client. Hashing the bundled bytes means **any byte difference** re-adopts, no version bump required.

The schema-version comparison still **fails closed** — if the artifact's schema version is newer than the binary's migration set can understand, adoption is refused rather than risking a half-understood schema.

> **Status:** Implemented. The two-database split, the build-time artifact + integrity checks, and the cold-start adopt are all in place. `GameDataAdopter` (execution order -200) copies the bundled `game-data.bytes` from StreamingAssets into the working path via an atomic temp-and-rename, gated by a fail-closed schema-version check **plus a SHA-256 content-hash check (`.srchash` marker)** so content-only re-bakes at the same schema version still re-adopt. Player-data + **all** online-cache DBs (`LocalDataSources.MigratableSources`) are then migrated **off the main thread** by `LocalDevGameInstaller.KickOffMigrations`, which signals `DbReadyGate` when done; startup consumers await the gate before their first query. (`DatabaseMigrations`, order -100, now only covers the game-data **dev fallback** — migrating game-data at startup when no baked artifact is bundled; see [Project Setup — Hit Play](?page=unity/01-project-setup).) Remote artifact delivery via `AddressablesCatalogUpdater` is the next layer.

### How content is patched (no save loss)

Content updates are delivered by patching the game-data Addressable, reusing the existing `AddressablesCatalogUpdater` (the same path that updates the asset bundle catalog). Because content lives in its own database, **a content update never touches player saves**.

## The player-data Database

The player-data database is **migrated in place** on app update. Migrations remain part of the codebase (scoped to player-data and the online-cache databases), and the migration DLLs **ship inside the binary** — they are never delivered via Addressables.

The reason is platform constraints: IL2CPP / AOT cannot load code at runtime, and app-store policies forbid shipping executable code out-of-band. So all schema evolution for player saves rides along with the binary and runs on first launch after an update.

## Putting It Together — Update Scenarios

| Event | game-data DB | player-data DB |
|-------|--------------|----------------|
| New content (no app update) | A re-baked `game-data.bytes` is re-adopted on any content-hash difference, even at the same schema version (subject to the fail-closed schema-version gate) | Untouched |
| App update with schema changes | Newer artifact bundled + Addressable; adopted at cold start | In-place migrations run on first launch |
| Fresh install | StreamingAssets artifact is the first-run floor | Created from migrations |

## Authoring a creature headlessly

`cr_create_creature` does the whole species in one call — the six steps that otherwise live in four
different windows:

```bash
unity cmd --project-path . cr_create_creature \
  --name "Snow Bomb" --element Ice \
  --source "Assets/Monsters Ultimate Pack 02 Cute Series/Snow Bomb Cute Series/Prefabs/Snow Bomb.prefab" \
  --description "A packed snowball with a short temper and a shorter fuse." \
  --hp 52 --attack 13 --sp_attack 12 --defense 13 --sp_defense 10 --speed 9
```

It builds the art prefab from a source model, adds `AudioSource` and `CreatureBattlePresenter` and
wires both private fields, marks the prefab Addressable as `creatures/<key>`, writes the
`CreatureDefinition`, and adds it to the `ContentDefinitionProvider`.

That last step matters most. A definition that exists as an asset but is missing from the provider
is **invisible to the game** — the provider is the only thing that resolves content by key at
runtime, and nothing errors when it is absent. The other quiet failure is a prefab that was never
made Addressable: it resolves to null at battle time, and you find out when the creature is sent
out.

The source prefab is unpacked completely rather than kept as a variant, so a CR creature never
inherits from a vendor prefab that a pack reimport can change or delete.

Push the result with `cr_sync_creatures` (the same call Content Studio's per-row Push makes), then
re-bake the offline floor:

```bash
unity cmd --project-path . cr_sync_creatures --keys "creature_snowbomb"
unity cmd --project-path . cr_sync_creatures            # every definition
```

:::caution
Both need cr-api reachable at the `*_server_http_address` in `game_config.yaml` — port 8080 by
default. If something else is already listening there the push fails with a bare `404 Not Found`,
because a different server answered rather than nothing answering at all.
:::

## Element ids are duplicated in three places

`CR.Game.Model.Elemental.ElementType` in cr-api is authoritative: `Wind` is 6, `Lightning` is 7,
`Poison` 8, `Radiant` 9. Unity keeps its own copies of that mapping, and two of them were wrong —
Wind and Lightning transposed, with four invented types (Psychic, Shadow, Dragon, Fairy) sitting
where Poison and Radiant belong.

The failure is silent in both directions. A creature pushed as Lightning stored as Wind behind a
`200`, and the runtime content sync then read it back into the client's SQLite as Wind too, so the
database and the game agreed on the wrong answer.

| Copy | Used by |
|---|---|
| `ContentCreatorSyncHelper` | Content Studio push/pull |
| `AbilityEditorSyncHelper` | Ability authoring |
| `ServerContentSyncService` | Runtime content sync into SQLite |

All three now match the enum. Anything added to `ElementType` has to be added to all three, and
after changing one, check the element that actually lands rather than trusting the response code.

## A creature needs more than a definition

Authoring the species is the first of four things. Miss any of the rest and it exists without
appearing or acting:

| Piece | Where it lives | Symptom when missing |
|---|---|---|
| Definition + prefab + Addressable | Unity, via `cr_create_creature` | Never resolves; null at battle time |
| Abilities of its element | `abilities` | Nothing to attack with |
| Ability progression set | `ability_progression_set` (+ `_entry`) | Spawns with empty move slots |
| Spawner template | `creature_spawner_template` | Exists but never appears in the wild |

The link from a creature to its moves is **not on the creature**. `creature` has no
`ability_progression_set_id` column — the pairing lives on `creature_spawner_template`, alongside
`growth_profile_id`. A species learns what the template that spawned it says it learns, so adding a
creature to a pool and giving it moves are the same act.

:::caution
`variant_type` on `creature_spawner_template` is `NOT NULL DEFAULT 'normal'`. Pass a value, never an
explicit `NULL` — `INSERT OR IGNORE` swallows the constraint violation, so the migration reports
success, writes nothing, and the pool silently stays as it was. Always read the affected rows back
after a seed migration rather than trusting that it ran.
:::

## Related Pages

- [Project Setup](?page=unity/01-project-setup) — database path config keys, startup migration flow
- [Content Registry](?page=unity/08-content-registry) — the in-memory content catalog and server manifest upgrade
- [Addressables Setup](?page=unity/09-addressables-setup) — asset bundle pipeline and catalog updates
- [NPC System](?page=backend/02-npc-system) — NPC content globalization via `ContentWorldId`
- [Spawner System](?page=backend/03-spawner-system) — global read-only spawner templates
