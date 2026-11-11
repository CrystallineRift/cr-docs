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

The copy lands in the Unity working tree **uncommitted**, and a player build uses the committed floor, which never migrates at runtime: commit both files with the package change. `--base <floor>` makes the tool start from an existing floor instead of an empty database and run only the migrations it lacks, so rows the production overlay carries (story creatures such as the gaterbear) survive; use it to migrate the committed floor forward. `BundledFloorSchemaTests` and `ci/check-floor-schema.sh` fail when the committed floor is behind the package.

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

A creature with no model of its own can be a placeholder built from one the project already owns. `cr_build_gaterbear_placeholder`
is that for the gaterbear: a Prefab Variant of the CR `wolfpup.prefab` (a variant of a CR prefab, not of the vendor's, so
the rule above still holds) at 1.8x scale with a tinted copy of the wolf's material, made Addressable at `creatures/gaterbear`,
with its portrait baked through `cr_bake_portraits` and the definition pointed at both. It is safe to re-run after tuning the tint or
scale. Replacing it with a real model means overwriting the prefab at the same address and re-baking the portrait. Every placeholder
like this has a row in the [AI content ledger](?page=content/01-ai-content-ledger).

Push the result with `cr_sync_creatures` (the same call Crystalline Rift Studio's per-row Push makes), then
re-bake the offline floor:

```bash
unity cmd --project-path . cr_sync_creatures --keys "creature_snowbomb"
unity cmd --project-path . cr_sync_creatures            # every definition
```

:::caution
Both need cr-api reachable at the selected environment's API address (Studio → Server & Keys; Local is port 8080). If something else is already listening there the push fails with a bare `404 Not Found`,
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
| `ContentCreatorSyncHelper` | Crystalline Rift Studio push/pull |
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

## Rigged creature models: the vertex budget

Seven creatures use our own rigged models instead of the placeholder packs: Mudcalf, Gaterbear, Cindris, Cindralis, Cindrakar, Zephlet and Zephryne. Each prefab under `Assets/CR/Prefabs/Creatures` is a variant of an FBX under `Assets/CR/Prefabs`.

Three of these models first shipped straight from the mesh generator at hundreds of thousands of vertices, and two of them roam the starting meadow in numbers. They were re-exported at about 30,000 vertices each. The other four models were already between 8,000 and 13,000.

| Model | Vertices before | Vertices now (as Unity imports them) | FBX size before | FBX size now |
|---|---|---|---|---|
| `gatorbear` (Gaterbear) | 382,929 | 30,783 | 37.3 MB | 3.6 MB |
| `cindris_firecat` (Cindris) | 168,676 | 30,636 | 15.3 MB | 3.5 MB |
| `zephlet` (Zephlet) | 161,039 | 30,674 | 14.7 MB | 3.8 MB |

The counts are the vertices the engine draws, with UV seams split. The object, bone, material and clip names did not change, so the `.fbx.meta` files, prefabs and controllers needed no edits. The Gaterbear and Zephlet also needed a new texture (below); `gatorbear_albedo.png` and `zephlet_albedo.jpg` keep their names, format and size, and the Zephlet texture file shrank from 11.1 MB to 2.3 MB. Both FBX files carry all nine takes (the seven original clips plus Hit and Faint), so the same file serves the Hit and Faint branch.

**The budget is 40,000 vertices per creature**, summed over every `SkinnedMeshRenderer` and every plain `MeshFilter` mesh on the prefab (an extra unskinned mesh does not escape the count). It is enforced by `RiggedCreatureModelTests` (EditMode, `Assets/CR/Tests/Editor/`), which runs over every prefab in `Assets/CR/Prefabs/Creatures` that is a variant of an `.fbx` in `Assets/CR/Prefabs`:

| Test | Checks |
|---|---|
| `The_seven_rigged_creatures_are_found` | The seven prefabs above are all picked up, so a renamed or moved prefab cannot silently drop out of the other checks. |
| `Every_rigged_creature_mesh_is_within_the_vertex_budget` | Vertices summed over every `SkinnedMeshRenderer` and every plain `MeshFilter` mesh on the prefab are at most 40,000, so an extra unskinned mesh cannot dodge the budget. The failure message lists the offending model and its count. |
| `Every_rigged_creature_still_binds_to_its_model` | Each skinned mesh has a mesh, bones that are all bound, as many bones as bind poses, and no missing material; the mesh is not Read/Write; the root has an Animator with a valid avatar and a battle controller, a `CreatureBattlePresenter`, and a `CreatureWorldAnimation` with a world controller. |
| `Every_rigged_creature_deforms_when_animated` | The Idle pose and a mid-Attack pose differ by at least 5 % of the creature's height. A prefab whose bones no longer match a re-exported FBX bakes the same bind pose for both and fails. |

The budget sits above the lightened exports and the models that arrived light, and below a raw generator mesh. Do not raise it to make a heavy model pass; lighten the model.

**Lightening on export.** The rigging skill (`animating-quadrupeds`) can write a lighter mesh while exporting, without touching the rigged `.blend`. It has two modes, set with environment variables when running `q_export_fbx.py` or with keys under `"export"` in the model's `<file>.quadruped.json` config (the environment variable wins; nothing set means the export is unchanged):

- **Keep the UVs:** `DECIMATE=30000` (config `"decimate_verts": 30000`). The mesh is cut open along the UV island borders, decimated, and the cracks that opens are snapped shut. This is only good when the texture atlas is tidy.
- **Re-bake:** `REBAKE=1 DECIMATE=31000` (config `"rebake": true`). The mesh is simplified as one welded surface, given a new UV layout, and the original colours are painted into a new texture. Use this when the atlas is fragmented.

`DECIMATE` counts the vertices the engine draws (after UV-seam splits), not Blender's count; aim for 28,000 to 33,000.

**Why the Gaterbear and Zephlet were re-baked.** The first lightened versions (keep-the-UVs mode) showed hairline cracks and dark specks in Unity: on the Gaterbear's head, brow, snout, neck and around the spikes, and on the Zephlet's beak and plume. The source atlas is cut into so many islands that 16,246 of the Gaterbear's 29,936 vertices were seam copies. Each island was simplified on its own, so the seams opened, and island edges sampled the atlas background (black on the Gaterbear). The re-bake does this instead:

1. Simplify the welded surface (no seam splitting).
2. Lay out new UVs with wide gutters between islands (17 px at 2048, 34 px at 4096, because each mip level halves them), with the head islands enlarged.
3. Transfer the original colours into a new texture with the same name, format and size, never re-lit, and fill the whole background so no mip level can sample a background colour.
4. Take skin weights from the original surface, keep the skull and ground-contact vertices, and fit the weights to the four bones Unity keeps (see the next section).

The texture keeps its name, format and size, so the existing `.fbx.meta` and material wiring keep working when the files are dropped over the old ones. Cindris was not re-baked and is unchanged.

**How to judge a lightened model.** When the atlas is fragmented, re-bake. Whole-model renders are not acceptance evidence, because cracks and specks are only a few pixels wide: judge zoomed captures of the head, mouth, spikes and beak taken in Unity (the original, the previous version and the new one side by side, textured and plain grey), at mip levels 1 to 3 as well as full size. The export also writes `<name>.export.json` with a `lighten.health` block: open and non-manifold edges must equal the original's and zero-area triangles must be 0.

## Pushing Studio content from the CLI

Studio's **Push All Content** button has a headless twin for the open Editor, so a push no longer needs the window or a modal. Both call the same method (`ContentStudioTool.QueueAllContentPush`), so the order (creatures first, trainer battles last, then the achievements catalog), the per-asset saves and the `ContentPushLog` stamps are identical. The stamps are what clear the **Push N Edits** pill.

```
unity cmd --project-path <cr-api-unity> cr_studio_push_all --args dry   # pending edits per tab + destructive-push warning
unity cmd --project-path <cr-api-unity> cr_studio_push_all --args go    # queue the push; returns at once
unity cmd --project-path <cr-api-unity> cr_studio_push_status           # progress, then one line per type
unity cmd --project-path <cr-api-unity> cr_studio_push_status --args cancel
```

- **`dry`** prints the server the Studio points at (the Local/Production switch), then `N of M edited since last push` for every tab, the total, and the same "these types remove server rows the assets do not list" text the dialog shows. It reloads the asset lists first, so a long-open window's stale lists cannot hide edits. A bare call does the same as `dry`; only `go` pushes, standing in for the dialog's confirm.
- **`go`** queues one `StudioJob` per type plus one for achievements. `StudioJobRunner` steps them on `EditorApplication.update`, one request per tick, so the command returns before anything is sent. It refuses while the runner is already busy.
- **`cr_studio_push_status`** reads `PushRunLedger` (shared with the window's own Push All): `RUNNING`, `DONE`, `DONE WITH FAILURES` or `STOPPED`, the job in progress, and `OK` / `FAILED` per type. A type stopped part-way is listed as never answered and is not stamped.

A push writes live content to that server, so the user runs `go`. The ledger and the queue are lost on a domain reload (a script compile); a push interrupted that way shows as `STOPPED`, and the unstamped types stay pending.

## Related Pages

- [Project Setup](?page=unity/01-project-setup) — database path config keys, startup migration flow
- [Content Registry](?page=unity/08-content-registry) — the in-memory content catalog and server manifest upgrade
- [Addressables Setup](?page=unity/09-addressables-setup) — asset bundle pipeline and catalog updates
- [NPC System](?page=backend/02-npc-system) — NPC content globalization via `ContentWorldId`
- [Spawner System](?page=backend/03-spawner-system) — global read-only spawner templates
