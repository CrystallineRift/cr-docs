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
profiles, progression sets, spawners, elemental reactions and the elemental damage matrix. It does
not hold player data. Trainers, inventories, auth and
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
| `BattleMissionEditorSyncHelper` | Content Studio's battle-mission transport (`GET /all`, `PUT`, `DELETE`). Editor-only, and the one content type whose offline copy comes from an exported seed migration rather than from this pull. |
| `ISpawnerSyncClient` | The spawner write path, reused by the pull. Optional on the sync service: a caller baking into a scratch file cannot supply one that writes to the right place, so it passes null and the domain is skipped rather than writing into the live database. |

### Domains, in the order they run

| Domain | Endpoint(s) | Paged | Reconciles deletions |
|---|---|---|---|
| `Abilities` | `GET /api/v1/abilities` | yes | yes (complete + plausible) |
| `GrowthProfiles` | `GET /api/v1/growth-profiles` | yes | yes (complete + plausible) |
| `ProgressionSets` | `GET /api/v1/ability-progression/sets` | yes | entries, by absence |
| `Creatures` | `GET /api/v1/creatures` | yes | yes (complete + plausible) |
| `Spawners` | `GET /api/v1/spawners/content-registry/full` | yes (envelope) | via `ISpawnerSyncClient` prune |
| `ElementalReactions` | `GET /api/v1/elemental-reactions` | no | yes, by absence |
| `ElementalDamage` | `GET /api/v1/elemental-damage/versions` then `?version=` per version | no | n/a — dense grid, overwritten |

**The sync carries the player's bearer token.** Every content route sits behind the API's fallback
authorization policy, so an unauthenticated `GET /api/v1/abilities` comes back `401` and the domain
reports Failed. `ServerContentSyncService` takes an optional `ITokenManager` and the installer
supplies the same one every other HTTP client uses; the Editor's bake-from-server tool constructs
the service without one.

`ContentRegistryInitializer` runs the sync at boot and **awaits** it, then signals
`ContentSyncReady`. It used to fire and forget, which raced world init: a spawn roll could read
rows the sync was midway through replacing, and nothing observed whether the sync ever finished.

## Rules the SQL must follow

These are not style preferences. Each one is a bug that shipped.

- **Never write an `id` on update.** The growth-profile upsert once ended
  `ON CONFLICT(name) DO UPDATE SET id = excluded.id`. `generated_creature.growth_profile_id` points
  at that key, so the first sync where the server's id differed orphaned every creature a player
  had captured. Resolve the local row by name and update its payload columns only.
- **…but say so when the ids differ.** The other side of that rule: because the creature upsert
  is keyed on `content_key` and never touches `id`, a species the server knows under a different
  id stays split forever, and every *online* capture of it names a `base_creature_id` the local
  `creature` table cannot resolve — `BattleStager` stages no model, `PlayerTeamView` draws no
  portrait. That happened to 12 of 15 species (seed migrations M9998/M10000 minted their own ids;
  the server had kept its Content-Studio ids). `WriteCreaturesAsync` now runs
  `ContentIdDivergence.Find` (`CR.Core.Sync.Logic`, tested) over the incoming payload against the
  local `(content_key, id)` rows and logs one warning naming every mismatch. The fix for the ids
  themselves is the cr-api migration `M10022AlignCreatureIdsToAuthored`, which moves every
  species onto the id on its `CreatureDefinition` asset and repoints all references — on every
  DB the unified migrator touches (floor, player save, online caches, Postgres).
- **Lowercase every id.** This service opens a plain `SqliteConnection`, so
  `GuidNormalizingSqliteConnection` is not in the path, and the progression-set join compares
  `e.ability_id = a.id` raw. One uppercase id returns zero abilities with no error.
- **No `INSERT OR REPLACE`.** It deletes the conflicting row and inserts a new one, so every
  column absent from the statement reverts to its schema default — a migration-seeded
  `stat_changes.duration` of 3 silently became 0 on every boot. Name every column in an
  `ON CONFLICT … DO UPDATE`.
- **Derive junction ids.** `ability_status_conditions` has no composite unique index, so a random
  id never replaces anything; it appends. Derive the id from what the row joins.
- **Select every column you compare on.** `WriteProgressionSetsAsync` reconciles progression
  entries by `(level, ability_slot)` and writes only what differs — but it read the row without
  `unlock_quest_content_key`, so an entry whose quest gate had changed compared equal and the write
  was skipped. A quest-gated ability then sat ungated in the local cache and unlocked offline at its
  level with no quest completed. A column that is not in the `SELECT` is a column that can never be
  seen to change. Same bug, same fix, in `LocalAbilityLibrarySyncClient.SyncProgressionSetAsync`.
- **An unset optional string is `NULL`, not `""`.** Readers test these columns for null to mean
  "not set". An empty `unlock_quest_content_key` is a gate naming a quest that cannot exist, and the
  entry would never unlock at all.
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

## Elemental reactions and the damage matrix

Both are authored content as of 2026-09-03, and both are read by the **offline**
`BattleDomainService` — which is the only reason they are in this pull at all. Online, the server
reads its own tables; offline, whatever these two domains wrote is the fight.

**Reactions** (`elemental_reaction`) come from the player-facing
`GET /api/v1/elemental-reactions` — active rows in evaluation order — not the content-write
`/all` route. An inactive reaction is one a designer switched off; caching it would only give the
client a rule it must then remember not to apply.

`WriteElementalReactionsAsync` upserts by id, adopts the local row that already holds the
`content_key` when the server's id has drifted (so a re-id is an update, not a duplicate under a
UNIQUE key), and soft-deletes rows absent from the payload. Three details worth keeping:

- **No plausibility floor.** The other domains skip reconciliation when a pull is far smaller than
  what is held locally. This table holds a handful of rows, where deleting one of three is ordinary
  authoring. The safety comes from the caller instead: an empty or failed pull is reported as
  Empty/Failed and never reaches the writer, which throws if handed an empty list.
- **A row this client refuses to write is still a row the server lists.** Rejected rows (unknown
  detonator, blank primer or log line) still count as present, so a client-side disagreement never
  deletes content.
- **A `content_key` held by a third row skips that one reaction, with a warning.** Writing it would
  violate `UNIQUE(content_key)` and abort the transaction, taking the whole pull with it.

**The matrix** (`elemental_damage`) is pulled in two hops: `/versions` says what exists and which is
active, then one read per version. A version whose read fails fails the whole domain — a half-written
grid resolves its missing matchups at 1.0, which is a silently wrong fight rather than a visible
error. Cells upsert on `UNIQUE(offense_element, defending_element, version)` with ids derived from
that same triple, so a re-sync updates in place. There is no `deleted` column and nothing to retire.

The active pointer is written into `battle_system_version.active_elemental_damage_version`, and
**only when the named version actually arrived with cells** — pointing at a version this database
holds no rows for is how every matchup silently becomes 1.0. That row lives in `game-data.bytes`
with the matrix it names: the offline `IBattleSystemVersionRepository` binding reads the content
database, not `player-data.bytes`, because a single column naming an authored matrix version is
content, not player state.

Multipliers on both tables are clamped to `[0, 10]` on write, mirroring the server-side validation.
A negative multiplier heals the target it was meant to hurt — which is what the Radiant→Radiant
`-5.0` typo did until `M12007`.

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

Three files in that project are worth knowing by name:

- `ElementalContentSyncWriterTests` — the reaction and matrix SQL against the shipped floor's own
  `elemental_reaction` / `elemental_damage` / `battle_system_version` definitions.
- `ElementalPayloadDeserializationTests` — the wire contract, pinned against payloads captured
  verbatim from a running AIO. The API serializes with System.Text.Json defaults, so `detonator`
  arrives as an **integer** (`7` = Lightning); Newtonsoft handles that, and this is the tripwire for
  the day someone adds a converter on one side only.
- `BattleDomainServiceBindingTests` — every required constructor parameter of `BattleDomainService`
  has a `Container.Bind<…>` in `LocalDevGameInstaller`. Adding a dependency in cr-api without
  binding it in Unity makes `battle_offline` throw at install time and the world never bootstraps.
  Both sides are read as source text: the installer is in Assembly-CSharp, which no asmdef may
  reference, so no EditMode test can build the container.

## Still to do

- Items, loot tables, pickups and achievements read a correct-but-stale floor.
  Their bulk endpoints now exist (`/api/v1/loot-tables`, `/api/v1/pickups`); the client pull does not.
- Battle missions are a partial exception, and worth knowing about because it is the shape the
  others will take. The *runtime* read is already routed (`BattleMissionTemplateRoutedSource` —
  server when online, floor when offline), so an edited mission takes effect online without a bake.
  What the runtime pull does **not** do is write the floor. Authored missions reach offline play by
  being exported from Content Studio as a seed migration and rebaked — see
  [Battle Extensions → Authoring missions in Content Studio](?page=unity/24-battle-extensions).
  That is the standard, not a gap: the offline floor is reviewable content in the repository, never
  whatever happened to be in one machine's local database.
- Quest templates still overwrite from ScriptableObjects at world init.
- The version gate is not wired. Before it can be, the recorded version must move *into*
  `game-data.bytes` — `GameDataAdopter` replaces that file wholesale while the version sits in
  player prefs, which would pin a client to floor content while it believed itself current.
- `TargetType` has no real enum in cr-api; it is a bare string whose only spec is an XML comment.
  The client whitelists against that comment.
- A first-run bulk pull has no progress indication.
