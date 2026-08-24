# Runtime Content Sync

How designer-authored content reaches a running game between releases.

## The shape

The local content database, `game-data.bytes`, is a **cache of the backend**. It ships baked into
the build as an offline floor, is adopted into `persistentDataPath` at boot, and is refreshed from
the server while the game runs. Content repositories read it; nothing else.

```
Backend content tables (Postgres, source of truth)
   ▲ Editor publish (Content Studio)      ▼ bake at release · pull at boot
StreamingAssets/CR/game-data.bytes  →  persistentDataPath/game-data.bytes
                                            ▼
                          every content repository, in both play modes
```

**Content, not instances.** This cache holds definitions — abilities, base creatures, growth
profiles, progression sets. It does not hold player data. Trainers, inventories, auth and
generated creatures keep their own per-mode databases, and that separation is the boundary that
keeps offline-issued creatures out of PvP and the market. Sharing definitions is what makes that
boundary checkable: a server cannot validate a creature's stats against numbers the client does
not share.

## The pieces

| Type | Job |
|---|---|
| `ServerContentSyncService` | Fetches each domain, pages it, validates it, hands rows to the writer, returns a report. |
| `ContentSyncWriter` | All the SQL. Takes a connection string and parsed rows — no web client — so it can be tested against a real database. |
| `ContentSyncIds` | Lowercases every id written, and derives stable ids for junction rows. |
| `ContentSyncReport` / `ContentDomainResult` | Per-domain outcome. `MayRecordVersion` is true only when every domain applied. |
| `ContentSyncPaging` | Page-walk rules: full page means keep going, short page ends it, hard cap stops a runaway. |
| `ContentSyncSafety` | Guards the destructive half — deletions reconcile only against a provably complete pull *and* a plausible row count. |
| `ISpawnerSyncClient` | The spawner write path, reused by the pull. Optional on the sync service: a caller baking into a scratch file cannot supply one that writes to the right place, so it passes null and the domain is skipped rather than writing into the live database. |

`ContentRegistryInitializer` runs the sync at boot and **awaits** it, then signals
`ContentSyncReady`. It used to fire and forget, which raced world init: a spawn roll could read
rows the sync was midway through replacing, and nothing observed whether the sync ever finished.

## Rules the SQL must follow

These are not style preferences. Each one is a bug that shipped.

- **Never write an `id` on update.** The growth-profile upsert once ended
  `ON CONFLICT(name) DO UPDATE SET id = excluded.id`. `generated_creature.growth_profile_id` points
  at that key, so the first sync where the server's id differed orphaned every creature a player
  had captured. Resolve the local row by name and update its payload columns only.
- **Lowercase every id.** This service opens a plain `SqliteConnection`, so
  `GuidNormalizingSqliteConnection` is not in the path, and the progression-set join compares
  `e.ability_id = a.id` raw. One uppercase id returns zero abilities with no error.
- **No `INSERT OR REPLACE`.** It deletes the conflicting row and inserts a new one, so every
  column absent from the statement reverts to its schema default — a migration-seeded
  `stat_changes.duration` of 3 silently became 0 on every boot. Name every column in an
  `ON CONFLICT … DO UPDATE`.
- **Derive junction ids.** `ability_status_conditions` has no composite unique index, so a random
  id never replaces anything; it appends. Derive the id from what the row joins.
- **One transaction per domain.** A domain lands whole or not at all.
- **Page until a short page.** A flat `?limit=500` truncated silently and reported success.
- **Reconcile deletions only against a complete pull.** A deleted row and a truncated page look
  identical from here.
- **Clamp what the battle engine will read.** These rows arrive from an unauthenticated endpoint
  and drive damage math. Unknown element types, target types, categories, stats and calculations
  are **rejected**, never coerced — an unknown element used to silently become "Normal", which
  would have reskinned every creature using a newly added element.

## Deletion

A designer's delete propagates as **soft-delete-by-absence**: rows the server no longer lists are
marked `deleted = 1`. Because a deleted row and a truncated response look identical from the
client, that only runs when **both** guards pass — the domain's full page set arrived
(`MayReconcileDeletions`) and the payload is not implausibly smaller than what is already held
(`IsPlausibleRowCount`, currently half). A partial pull leaves local content untouched.

## Spawn pools

Spawn pools **pull**. Until 2026-08-24 the client did the opposite: `SpawnerDefinitionSyncBehaviour`
pushed every baked ScriptableObject to `POST /api/v1/spawners/sync-config` at world init, so a
server-side pool edit was not merely ignored, it was overwritten by the build's copy.

`ISpawnerSyncClient` now has exactly one runtime binding — `LocalSpawnerSyncClient` — so no runtime
path can POST; a regression test fails if anyone re-adds an online binding. The sync pulls
`GET /api/v1/spawners/content-registry/full` (header, pools and creature templates together, so it
is one request rather than one per spawner) and writes through that same local client, reusing its
existing upsert and prune logic. Content Studio's editor push is unaffected — it builds its own
`HttpClient` and never went through DI.

`SpawnerRecoveryService` used to sync-then-count-local, which online could never satisfy. It now
re-pulls the single spawner from the server when reachable, and falls back to the authored floor
otherwise.

## Baking a floor from the server

`CR/Build/Bake Floor From Server` (menu, plus the `cr_bake_floor_from_server` CLI command) rebakes
the floor into a scratch directory, runs the content sync against it, and publishes to
`StreamingAssets/CR/game-data.bytes` **only** if no domain failed. An unreachable server leaves the
shipped floor untouched. The Build Players window can run it as a pre-build step (off by default).

Before this, the shipped floor was built purely from migration seed data and had never seen the
live server.

## WAL

The local databases run in WAL journal mode so a writer no longer blocks every reader — the content
sync writes several domains in transactions while gameplay reads the same file. Two notes specific
to this driver: `journal_mode` is **not** a connection-string keyword in Microsoft.Data.Sqlite
3.1.32 (the version the compat package ships), so it is issued as a PRAGMA once per path and
persists in the database header; and `DefaultTimeout`/`Pooling` do not exist on that version's
connection-string builder at all, so a busy timeout cannot be set this way — it is per-connection
and would need a connection-opening helper every call site routed through.

Because WAL parks committed pages in `-wal`/`-shm` sidecars, `GameDataAdopter` now deletes them
alongside the database when it adopts a new floor. A fresh database must never inherit the previous
one's write-ahead log.

## What a base creature does *not* carry

`creature` has no `growth_profile_id` and no `ability_progression_set_id` — M1023 removed both
deliberately. The **spawner template** decides which growth profile and move set a spawn receives
(`creature_spawner_template`), and the **generated creature** records what it got. A review asked
for these to be synced onto the base creature; a schema test now pins the fact that they do not
belong there.

## Tests

`cr-api-unity/Tests/ContentSync` — `dotnet test`, not the Unity test runner: the code under test
lives in Assembly-CSharp, which a Unity asmdef cannot reference. The tests build a temp database
from the **shipped floor's own schema**, read at run time, so they cannot drift from what ships.

Decision rules (`ContentSyncReport`, `ContentSyncPaging`, `ContentSyncSafety`) are unit-tested in
`CR.Core.Sync.Logic`, which is engine-free.

## Still to do

- Items, loot tables, pickups, achievements and battle missions read a correct-but-stale floor.
  Their bulk endpoints now exist (`/api/v1/loot-tables`, `/api/v1/pickups`); the client pull does not.
- Quest templates still overwrite from ScriptableObjects at world init.
- The version gate is not wired. Before it can be, the recorded version must move *into*
  `game-data.bytes` — `GameDataAdopter` replaces that file wholesale while the version sits in
  player prefs, which would pin a client to floor content while it believed itself current.
- `TargetType` has no real enum in cr-api; it is a bare string whose only spec is an XML comment.
  The client whitelists against that comment.
- A first-run bulk pull has no progress indication.
