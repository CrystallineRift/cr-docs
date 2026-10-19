# Open World

> **Status: on cr-api-unity main** (merged in PR #65, `41b92439`), behind `world_mode`. Missing, empty or unknown values
> mean Legacy (`WorldModeSetting`). The mode comes from `GameSettings.defaultWorldMode` (shipping default Legacy), or in the
> Editor from this machine's override in Studio → Server & Keys → World mode. The default flips to `open` only after the
> Act 1 corridor is playtested. Nothing here changes cr-api, the schema or the server-authority boundary.

Seamless travel on the continent map: walk from region to region with no door, fade or loading screen. The world is a
grid of streamed cell scenes; a byte mask of the user's map says which region any world position is in.

## Architecture

| Piece | What |
|---|---|
| **Cells** | 256 m squares over a 1956 x 1476 m map (8 x 6). One scene per cell: `Assets/CR/Scenes/World/Cells/World_c{c}_r{r}.unity`, created on demand (only built cells exist). Towns/dungeons/interiors may be their own scenes, hosted by a cell in `WorldLayout`. |
| **World scene** | `Assets/CR/Scenes/World/World.unity`, always loaded in open mode beside `Core`. Owns `RenderSettings`, the backdrop (mountain ring + ocean plane), cell proxies, `RegionTracker`, `WorldStreamer`. |
| **`WorldLayout`** | SO (`Resources/OpenWorld/WorldLayout.asset`): cell size, map size, built cells, hosted scenes, start spawn (1a), ring radii, legacy-key table. |
| **`RegionMask`** | SO (`Resources/OpenWorld/RegionMask.asset`): one byte per metre = region index, plus the region table (key, display name, parent). `Sample(worldX, worldZ)`; out-of-map clamps to the nearest region. |
| **`RegionProfile` / `RegionProfileSet`** | Optional per-region banner, music, room tone, sky/fog/ambient. Lookup: region, then parent, then World defaults. |
| **Pure logic** | `CR.Game.OpenWorld.Logic` (no scene API, EditMode-tested): `WorldGrid`, `CellId`, `CellRingRule`, `CellStreamPlan`, `RegionDebounce`, `LegacyAreaKeyMap`, `WorldResumeRule`, `RegionMaskBuilder`. |

All game assets load through `IOpenWorldAssets`; the mode comes from `WorldModeSetting` (config key `world_mode`).

### Dormant / Active

`WorldStreamer` ticks about 4 Hz from the player position (decision logic in `WorldStreamerCore`, testable with a fake loader).

| Ring | Rule (defaults) | State |
|---|---|---|
| Active | player cell + cells within 40 m | loaded, logic on |
| Dormant | built cells within 256 m | loaded, rendered, logic off, **no server calls** |
| Proxy | everything else | unloaded; its proxy draws |

Hysteresis: unload only past ring radius + 32 m; Active demotes at 40 + 16 m. One load and one unload in flight at a time.
`CellActivator` (one per cell scene) promotes (runs the cell's `IWorldInitializable`s once per visit, enables activatable
behaviours and animators) and demotes (disables them, `CullCompletely`). A re-promotion re-runs world init, like today's
per-load. **World init per visit:** `IWorldInitializable`s of a cell run on each promotion (a merchant's promotion sends no stock call: the player walking up to it does, at most once a minute per merchant, and the authority re-rolls a shelf only after a trade and its restock cooldown; see [Merchant Shop → Restocking](?page=unity/18-merchant-shop#restocking)); ones on inactive objects (parked content, e.g. the demo quest-giver the corridor build parks) are skipped and logged by name, so an initializable must be active at promotion: one switched on later in the visit (a OneShotWorldEvent's `enableOnPlay`, a story beat) is not initialized until the next promotion, and nothing in the scenes does that today (`IWorldInitializable` states the contract); a trainer switch mid-promotion restarts the cell's promote with the new context. A failed load retries with backoff (1, 2, 4 s) and does not block other cells.

**Hold at edge.** If the player outruns streaming (resume, slow Deck) `WorldEdgeHold` covers the screen and gates gameplay input
(`GameplayInputHolds`, which `PlayerInputGate` honours) while a built cell within ~4 m is not yet Active, then releases. After 5 s it
toasts "still loading". Battles, cutscenes, placement, tech demo and suspend hand control to their own flow. Battles also freeze streaming for their duration.

### Region identity

`RegionTracker` samples the mask about 4 Hz; a new key must hold 0.5 s (`RegionDebounce`) before `RegionChanged(from, to)`.
On change: banner (boxes show their own name), music crossfade (`RegionAudioDirector`), sky/fog/ambient blend
(`RegionEnvironmentDirector`, 3 s), and a forced trainer-location save. Location XP is unchanged (location-enter intent).
`RegionTracker` is the `ICurrentLocationSource` in open mode (`AreaLoader` in legacy). A mask sample from a stale position
(e.g. right after a tech-demo return) is ignored until the next `SnapTo`, so a bad region is never force-saved.

**Region audio.** `RegionProfile` carries `musicKey` / `ambienceKey` played through `IGameAudio`; the AudioClip fields are secondary.
The existing playlist crossfade (`CrMusicPlaylistCommand`) is unchanged (ruling R25); `RegionSoundtrack` crossfades its own two voices and
cuts the outgoing one on a mid-fade change. A region with no profile uses its parent, then World defaults; an empty `ambienceKey` keeps the room tone.

### `world_mode`

Game config key `world_mode`: `legacy` (default; today's door/fade areas, untouched) or `open` (case-insensitive;
missing or unknown means legacy). In open mode the trainer row keeps `last_area_key` / `last_pos_xyz` / `last_yaw`, but the
key holds a **region key** and the position is **world space**. A saved key that is not a region key (old saves such as
`Meadow`) resumes at the 1a start spawn (`WorldResumeRule`).

### Server authority

Unchanged. Streaming and regions are presentation; the client still only sends intents (location enter, battle action).
Dormant cells make no calls; nothing here reports outcomes.

## Coordinates

1 map pixel = 1 m. Map top-left (0,0) is world (x=0, z=1476): `x = px`, `z = 1476 - py`; y is height. The grid never moves,
so positions are saved in world space with no conversion. Cell (c, r) covers x in [256c, 256c+256), z in [256r, 256r+256).

## Editor tools

Menu `CR/World/...`; every CLI command is `cr_world_*` and takes **one string** `args` (`--args "..."`).

| CLI command | `args` | Does |
|---|---|---|
| `cr_world_import_map` | none | Reads `world-map.png` + `regions.json`, writes `RegionMask.asset` and `region-mask-debug.png` (stays in `Data/Map`). Logs unknown colours with counts. The map PNG itself lives at `Resources/OpenWorld/world-map.png` (imported as a Sprite for the world map UI). |
| `cr_world_create_cell` | `"c,r"` | New cell scene `World_c{c}_r{r}`: root `Cell_c{c}_r{r}`, 256 m blockout ground, a `SceneContext` (parent contract `CoreContext`), `CellActivator`, `AreaWorldInitializer`; adds it to Build Settings and `WorldLayout.builtCells` (scene names). |
| `cr_world_migrate_area` | `"Key,x,z"` e.g. `Meadow,250,880` | Copies a legacy area scene's content into the right cell(s), offset so the area default spawn lands at world (x, z). Doors are dropped. The legacy scene is read, never saved. |
| `cr_world_refresh_activatables` | `"c,r"` or `""` (every built cell) | Re-collects a cell's activatables (see below) and saves the cell. |
| `cr_world_validate` | none | Objects outside their cell (+/- 2 m, looks inside migrated containers and nested gameplay placements), built cells missing from Build Settings, regions with no profile, unresolved NPC keys, ocean spawns, terrain seams > 1 mm, > 4 terrain layers (warning), corridor story objects buried > 0.5 m, corridor builder children outside their cell. Summary `E error(s), W warning(s), I info`; checks skipped for a missing provider/mask/profile set show as warnings. |
| `cr_world_bake_proxy` | `"c,r"` | Bakes the cell's far-field proxy to `Resources/OpenWorld/Proxies/Proxy_c{c}_r{r}.prefab` via `ICellProxyBaker` (built-in fallback baker: copies of enabled renderers ≥ 8 m, one LOD level per group, nothing a `BattleArena` lists as battle-only, shadows off, plus a `TerrainProxy` per terrain; Amplify baker later). |
| `cr_world_add_lods` | `"c,r"` | Adds `LODGroup`s to the cell's large renderers (grouped; small clutter gets a cull distance); vendor LODGroups (from the prefab's source chain, variants included) are kept and counted. Idempotent: rewrites a group only when it differs from the plan and saves the cell only when it wrote one. The corridor build's `lods` step runs the same pass over its owned containers. |
| `cr_world_audit_vendor_lods` | `"c,r[,fix]"` | Lists vendor LODGroups carrying instance overrides; `fix` reverts them and saves the cell. Run before `cr_world_add_lods`. |
| `cr_world_build_backdrop` | none | Builds the ocean plane + mountain ring blockout prefab (`OpenWorld/WorldBackdrop`), instanced in `World.unity`; skips ring cubes over built cells and adds the `VistaGround` (land mesh of unbuilt cells near Mirandale, `M_VistaGround.mat`). |
| `cr_world_*_corridor` | see below | Corridor builder: seed, build, check, render, revert (section "Terrain and the corridor builder" below). |
| `cr_world_seed_profiles` | none | Creates/refreshes `RegionProfiles.asset` from the legacy area scenes' audio + environment. Idempotent. |

Menu only: Import World Map, Create Cell, Validate World, Migrate Legacy Area (wizard), and the Scene-view Region overlay (borders, roads, cell lines, "you are in 2b" readout).

### Migration containers (idempotent)

Migrated content goes under `[Migrated {area}]` containers beneath each cell root. Re-running `cr_world_migrate_area` for the
same area deletes that area's containers in every built cell first, then copies again: no duplicates. Missing-scene and
missing-root checks run before anything is modified. Doors inside prefab instances are unpacked and removed.

### Activatables collector

One collector (`CellActivatableExtensions.CellActivatables` / `Scene.RefreshActivatables()`) is used by Create Cell, Migrate and
`cr_world_refresh_activatables`. It gathers spawners (`SpawnerWorldBehaviour`), NPC interaction/AI, encounter zones, pickups,
location triggers, arenas and Animators into `CellActivator.SetActivatables`. Run the refresh after hand-adding such objects to a cell.

### ArenaKeyTable

Battle arenas are looked up by the encounter's own arena content key (spawner `_battleArenaKey` / trainer battle `battleArenaKey`),
through `ArenaKeyTable`, so two areas migrated into one cell keep distinct arenas (Meadow `meadow-arena`, Village `starter-wild-zone`).
Same-key unregister no longer drops a sibling's arena.

## `regions.json`

`Assets/CR/Game/OpenWorld/Data/Map/regions.json` is the importer's input beside `world-map.png` (the user's map, the source of truth; do not change its structure).

```json
{
  "ink":     ["#212b31", "#302230"],
  "regions": [ { "key": "2b", "name": "The Meadow", "parent": "2", "color": "#015c4b", "seeds": [[237,549],[301,410]] } ],
  "boxes":   [ { "key": "2a", "x": 186, "y": 450, "w": 74, "h": 72 } ]
}
```

- **`ink`**: label/line colours. These pixels are not regions; they take the most common neighbouring region (iterated mode fill).
- **`regions`**: `key` (content key, e.g. `2b`, `mountain`, `ocean`), display `name`, `parent` (`""` for none), fill `color`, and `seeds`: map **pixel** points `[x, y]` (y down, like the image) known to lie in that region. A region may be a colour shared with siblings (e.g. 2a/2b are one green); seeds separate them.
- **`boxes`**: outlined towns/interiors that share the surrounding colour. Pixel rectangle `x, y, w, h` -> region key, applied after the colour pass.

Unknown colours are reported, never guessed silently.

### Fixing a region

1. Open `region-mask-debug.png` (beside `regions.json`; each region a distinct hue, keys drawn at seeds) and find the wrong area.
2. Edit `regions.json`: move a seed into the correct area, add a seed for a missed pocket, or adjust/add a box for a town.
3. Re-import: `cr_world_import_map` (or `CR/World/Import World Map`).
4. Re-check `region-mask-debug.png`, then `cr_world_validate`.

## Tech-demo areas

Cave, Shore, Crags and Dunes have no place on the map. They stay as their legacy scenes, reachable only from the player menu's
dev/Editor "Tech demo areas" entry (System tab). The whole round trip is `TechDemoRoundTrip` (behind `ITechDemoHost`):

- **Enter:** remembers the world pose, awaits `IWorldStreamer.SuspendAsync` (all cells unload) behind the fade, then `AreaLoader.GoToAreaAsync`. Region key `techdemo` is held on `RegionTracker`; the audio/environment directors stand down so the legacy `AreaAudio` / `AreaEnvironment` apply; proxies and backdrop hide. A suspend that exceeds 15 s aborts the entry and puts the player back (log only).
- **Return:** unloads the area, resumes streaming, restores the remembered **return pose** and releases the region (instant change back to e.g. `2b`, directors take over). If the area will not unload the player stays in the tech demo and gets a toast.
- **Trainer switch inside a tech demo:** leaves the area and resumes the world before placing the new trainer.

Legacy keys map through `WorldLayout` (`Meadow` -> `2b`, `Village` -> `2a`, the four above -> `techdemo`).

## Act 1 corridor (built)

Four cells: `World_c0_r4` (1a summit ruins; start spawn **(208, 30.1, 1105)**, ground 30.0), `World_c0_r3` (descent, wagon terrace,
escort track, Philroe and Izzandra's farm in 2a, the migrated Meadow in 2b), `World_c1_r4` and `World_c1_r3` (fjord bank, Hound Tor, road).
Each cell has one Unity Terrain generated by the corridor builder (next section); the old blockout ground, the 1a plateau/ramp and the
Village group are parked (`SetActive(false)`), never deleted. The shipped assets are `WorldLayout`, `RegionMask`, `RegionProfiles`,
`WorldBackdrop`, `World.unity` and the corridor layout `Assets/CR/Game/OpenWorld/Data/Corridor/Act1Corridor.asset`.

## Terrain and the corridor builder

Everything between the summit and the farm is generated by one idempotent Editor builder from one ScriptableObject,
`Act1Corridor.asset` (`CorridorLayout`, menu **CR/World/Corridor**). The asset is the source of truth: hand edits to builder
objects are lost on the next build unless recorded as overrides. Code: `Assets/CR/Game/OpenWorld/Editor/Corridor/` (Editor) and
`Assets/CR/Game/OpenWorld/Logic/Terrain/` (pure, engine-free, EditMode-tested in `CR.Game.OpenWorld.Logic.Tests`).
It is presentation and staging only: no client→server call, nothing reports an outcome.

### Layout sections

| Section | Holds | Seed class (reset) |
|---|---|---|
| terrain | cells, terrain settings, solver, region height rules, polygons (shelf, balcony, wagon terrace, farm pad), contours, pads, noise, paths (GP goat path, ET escort track, conform paths), layers, splat, edge guards | `Act1TerrainSeed` |
| adjustments | every touched story/gameplay object (rows A1-A6, W1, C1-C42, D1-D2): scene, path, from/to, treatment, **zone** and **reason** | `Act1AdjustmentsSeed` |
| summit / descent / wagon / farm | landmarks, polylines (rims, fences), rows (cabbages), composites (scarecrow, clothesline), scatter rules, detail rules, paint areas | `Act1SummitSeed`, `Act1DescentSeed`, `Act1WagonSeed`, `Act1FarmSeed` |
| mood | World light + fog, the eight region rows (one dusk) | `Act1MoodSeed` |
| checks | sightlines, walk beats, beat-skip boxes, keep-outs, camera bookmarks | `Act1ChecksSeed` |

`cr_world_seed_corridor --args section=<name>|all` rewrites one section from its seed class (other sections untouched). After the
build-out the asset is authoritative, so seeding is a **reset**, not a step of the normal loop.

### Steps and commands

| CLI | Menu (`CR/World/Corridor/…`) | Does |
|---|---|---|
| `cr_world_build_corridor --args steps=height+paint+trees+details+dressing+guards+adjust+environment,cells=c0_r4+c0_r3+c1_r4+c1_r3,zones=terrain+summit+wagon+farm+mood,dry` | Build Act 1 Corridor / (Dry Run) | Opens missing cells additively, runs the steps, saves changed scenes/assets, closes what it opened. Defaults: all steps, all cells, all zones, not dry. `zones` filters only adjust + environment. The height solve always covers all four cells. Report `Temp/CorridorBuild/last-report.txt` (counts per container, every adjustment old → new + reason, rejected placements + why, solver residual, timings). Refuses in play mode. |
| `cr_world_check_corridor --args navmesh[,bare][,only=…]` | Check / Check with NavMesh | Read-only checks below; returns `ok` or `FAIL n`; `Temp/CorridorBuild/check.txt`. |
| `cr_world_render_corridor --args views=02_spawn_south+06_balcony_vista` | Render Views | Camera bookmarks → RenderTexture → PNG in `Temp/CorridorRenders/` (never a screen read). Warms the builder's particle systems first. |
| `cr_world_revert_corridor --args confirm` | Revert… | Restores every manifest entry (active flags, transforms, box sizes, gate doors, World light, region profiles), empties the owned containers, parks the terrains (TerrainData kept). |
| `cr_world_seed_corridor --args section=…` | Seed Layout Section/… | See above. |
| — | Record Selection As Override / As Removed | Stores the selected builder children's position/rotation/scale delta (or `removed`) in `layout.overrides` by stable id; applied last on every build. |

Steps: **height** (constraints → harmonic SOR solve 4/2/1 m → bicubic 0.5 m → noise → path benches → pads; one world grid feeds all
four terrains, so shared edges are bit-identical), **paint** (grass/path/rock/snow-or-farmfield per 0.5 m texel), **trees** (terrain
tree instances, vendor LODGroups kept), **details** (grass/flowers, zero under every placed footprint + 0.3 m), **dressing**
(landmarks, polylines, rows, composites, scatter, combined crop meshes), **guards** (edge guards), **adjust** (the §3 rows through
`CorridorStoryPlacer`), **environment** (World light, fog, sky, region profiles), **lods** (last: the `cr_world_add_lods` grouping and
vendor guard over the renderers in the owned containers only, so a child an earlier step created or recreated gets its LODGroup before the
hashes are recorded; idempotent, an unchanged container gets no write).

### Containers and idempotency

The builder owns only `[Corridor Terrain]`, `[Corridor Landmarks]`, `[Corridor Dressing]` (one sub-container per rule),
`[Corridor Farm]` and `[Corridor Guards]` under each `Cell_c{c}_r{r}` at local (0, 0, 0). Outside them it touches only the adjustment rows
and the World/RegionProfile mood values, and every first touch stores the original in `Act1Corridor.manifest.asset`.

- Children are synced by **stable id** (scatter: `<rule>_c<col>r<row>_<gx>_<gz>_<pick>_<member>`): same id + prefab → transform updated only
  when it differs by more than 1e-4; otherwise recreated; orphans destroyed. Randomness only comes from `StableRandom`/`HashNoise` (seed 20261008).
- Adjustments are absolute and matched by xz (`AdjustmentMatch`): at `from` or `to` → applied; anywhere else → skipped and reported
  "moved by hand" (adopt it with an override).
- A content hash per owned container and per TerrainData (component types, transforms, colliders, materials, lights, terrain settings)
  is stored in the manifest by every saved build; the check's `hashes` group fails on drift. A second identical build reports
  **0 changes** and saves no scene.
- LODGroups on builder children come from the build's own **lods** step, so a recreated child gets its group back in the same build.
  `cr_world_add_lods` groups the rest of the cell (renderers outside the owned containers, e.g. the migrated Meadow); it rewrites a group
  only when its levels, members or bounds differ from the plan, saves the cell only then, and reports `n written`.

### Checks (`cr_world_check_corridor`)

| Group | Proves |
|---|---|
| adjust | every adjustment row matches exactly one object and is at target |
| grades | GP ≤ 22° (stair 20.4° ± 0.5, ≤ 26°), ET ≤ 12°, cross-slope ≤ 14°, step ≤ 0.30 m (0.40 stair) |
| escort | waypoints on the ground (\|Δy\| ≤ 0.05), 3.2 m headroom, capsule clear, 2.5 m clearance to every solid |
| triggers / grounding | every story box/sphere contains its ground point; story objects and landmarks seated; spawn ground 30.0; the cart's crash pose |
| sightlines | spawn/balcony → city and pillar, farm gate → R7, Leg C → wagon, stair top → chimney smoke, den, wagon → R7 |
| rims | summit rims and farm fences: largest hole ≤ 0.6 m at blocking height |
| seams / bounds / materials | edge seams ≤ 1 mm, builder children inside their cell ± 2 m, no pink/null materials |
| trees | instance count within 600 ± 15 % |
| sun | the glade is lit by every region sun (terrain-only occlusion) |
| keepouts | spawn safety/flatness, legacy `entrance`, barn apron, Barn Sleep, Izzandra, morning spot, gate → Izzandra corridor, arena tube, arches |
| hashes | containers and TerrainData match the last saved build |
| navmesh (opt-in) | a temporary in-memory NavMesh: the beat chain spawn → … → farm → spawn completes within 1.6× authored length; beat-skip boxes (arrival, first sight, pillar) and borders (mountain, fjord, south edge) are **not** reachable, each with a positive control |

### Edge guards

Invisible 3 m × 0.6 m BoxColliders (no renderer) on layer `Ignore Raycast`, planned by `EdgeGuardPlanner` along fjord rims and
built-cell borders that face unbuilt cells (584 today); none within 20 m of the escort.

### Sun override, resume lift, smoke lift

- `RegionProfile.overridesSun` + `sunEuler/sunColor/sunIntensity`: `RegionEnvironmentBlend` slerps the sun with the fog/sky blend
  and skips the skybox swap when the target material is already current. All eight profiles share `Sky_TahrokDusk` and sun
  Euler (22, 60, 0) (the planned 16° left the glade's west end in the ridge's shadow).
- `OpenWorldBootstrap.MovePlayerAsync` lifts a buried saved position onto the terrain (`GroundLiftRule`, tolerance 0.25, clearance 0.1) after
  warming the cell and before `IOpenWorldPlayer.Teleport`; positions above the ground (bridges, roofs) are untouched.
- `StorySmokeRunner.Teleport` lifts to terrain + 0.2 the same way, so smoke teleports written for the blockout stay valid.

### LODs and proxies

- `cr_world_audit_vendor_lods --args c,r[,fix]` lists (and with `fix` reverts) LODGroup overrides on vendor prefab instances. Run it before
  `cr_world_add_lods`. A vendor group is any LODGroup that comes from the prefab's **source chain**, so prefab variants (Remesh `BigGate`,
  whose model root has no LODGroup) are recognised; `cr_world_add_lods` skips and counts them.
- `cr_world_bake_proxy` copies only the last LOD level of a group, skips disabled renderers (vendor collider hulls) and everything a
  `BattleArena` lists as battle-only (the arena's `[Arena Backdrop]` tube is saved active and hidden only at runtime, so the bake has to leave it
  out itself: `BattleOnlyProxyExtensions.BattleOnlyRenderers`; see [Area Scenes](?page=unity/22-area-scenes)), and adds a
  `TerrainProxy` child per terrain: 65 × 65 mesh, skirts to y −10 on edges facing unbuilt cells, 256² colour map from the layers
  (`Resources/OpenWorld/Proxies/Terrain/ProxyTerrain_c{c}_r{r}.asset/.png/.mat`). The material is saved with URP's opaque setup already
  applied (RenderType tag, MotionVectors pass off, `_MainTex` = `_BaseMap`), so URP does not rewrite it on first play. A rebake does
  renumber the proxy prefab's local fileIDs (same content); revert that churn if nothing else changed.

### Performance budget (Steam Deck 1280 × 800)

| Item | Budget | Measured (Editor, 2026-10-10) |
|---|---|---|
| Frame | ≥ 40 fps summit, ≥ 50 fps farm | pending Deck run |
| SRP batches (opaque) | ≤ 500 summit, ≤ 350 farm | pending Deck run |
| Visible triangles incl. shadows | ≤ 1.2 M | pending Deck run |
| Terrain trees | ≈ 600, treeDistance 200 | 605 (279 / 73 / 179 / 74 in c0_r4 / c0_r3 / c1_r4 / c1_r3) |
| Builder GameObjects (excluding guards) | ≤ 700 | 437 (c0_r4 248, c0_r3 169, c1_r4 4, c1_r3 16); crops combined (125 + 5 heads → 2 meshes) |
| Lights / particles | 2 unshadowed points / 1 system | 2 lanterns, 1 chimney smoke |
| LODGroups added by `cr_world_add_lods` | — | c0_r4 3 large + 38 small, c0_r3 38 + 386, c1_r4 1 + 0, c1_r3 1 + 1; 687 vendor groups kept |
| Proxies | one LOD level per group | renderers 65 / 158 / 3 / 0 + one TerrainProxy each; ≈ 23.4 k / 111.6 k / 8.8 k / 8.4 k triangles |

Levers if the Deck misses: treeDistance 150 → detail density 0.5 → `fir_slopes` × 0.75 → pixel error 8 → a Deck quality level with
2 shadow cascades at 40 m. Record the Deck numbers at bookmarks 02, 06 and 09 here.

### Change the corridor

See [Setting Up the World System → Tweak and rebuild the corridor](?page=guides/04-setup-world-system) and the single-page guide
`CR/docs/2026-10-09-corridor-builder-guide.html`.

## Towns (P1a, 2026-10-18)

(Unity: lands with the `feature/world-p1a` client PR.) A town is data plus a builder, like the corridor.

- **`TownLayout`** (`Assets/CR/Data/Towns/<key>.json`): points, walls, gates, plots, square, spawns, locations and NPCs on a pad. Pure logic and checks live in `Game/OpenWorld/Logic/Towns` (`TownChecks`, `TownWallPlanner`, `TownBuildPlanner`, `TownFoliageRule`, `TownOrientedRect`).
- **Kits** (`Data/Towns/kits.json`): 49 roles in three kits (city 29, village 12, seaside 8), sizes measured from the prefabs by `cr_town_kits_measure`. City buildings are big (house 9.6 x 11.6 m); the door side of every City building is its +X.
- **Commands.** `cr_town_check <key>` validates the layout; `cr_town_build <key>` builds the `[Town <key>]` container in the host cells (idempotent: owned container plus manifest, a repeat build reports `0 changes`; renaming an NPC key gives `created 1, removed 1`); `cr_town_render` writes review renders. Pad flattening and scatter exclusion come from the region overlay `pads` / `scatterExclusionRects`. Order: terrain, paint, scatter and trees, town build, story step, validate.
- **NPCs.** Placed by registry key (`TownNpcPlacer`). A town NPC must be named `CR_NPC_*` for `cr_dress_cell_npcs` to dress it.
- **Sandbox.** `town-test` on the Bridgeford pad (cell World_c3_r3) with `interior-test-house`. P1b removed it (see below).

## Interiors (P1a)

An interior is a hosted scene far below its host cell, entered through a door.

- **Slot.** x/z = the door's x/z snapped to a 64 m grid, y = -200 - 40 x slotRow (first free row per town). Volume = 64 x 30 x 64 m AABB, recorded in `Data/Interiors/<key>.json` and compiled by `cr_interior_build` into `Resources/OpenWorld/InteriorVolumes.asset`. `InteriorVolumeChecks` rejects overlap. The room stands under the door (clamped 4 m inside the slot) and the region check samples the room, not the whole slot, against the region at the door. No `RegionHold`: same x/z is the same region.
- **Hosted scenes.** `HostedScene {sceneName, col, row, interiorKey}`; scene `Interior_<key>.unity` with its own `HostedSceneActivator` and `AreaWorldInitializer`. `HostedSceneGroup` is reconciled every streamer step from what is true (host ring, loaded, active): host and hosted scene load at Dormant, promote together and unload together. A load that fails 3 times faults the door's waiter and the bootstrap puts the player at the start spawn. `cr_interior_build` adds the scene to Build Settings and `hostedScenes`; `cr_interior_check` validates both.
- **Doors.** `WorldDoor` (Interact) calls `IOpenWorldRelocator.RelocateToInteriorAsync(interiorKey, spawnId)`, which warms the host cell (`IWorldStreamer.WarmHostedAsync`) and ensures the scene is loaded before the teleport; the exit door reverses. Both are default interface methods so other packages' doubles still compile.
- **Ground lift.** Every lift user (`LiftOntoTerrain`, `TrySampleTerrainHeight`, the smoke runner) is honoured centrally: inside a volume, `TrySampleTerrainHeight` returns null and `LiftOntoTerrain` returns the position unchanged (`InteriorVolumeRegistry.Current`).
- **Resume inside an interior.** `WorldResumeSteps`: resolve the volume, warm the host cell, load the hosted scene, place the player.
- `InteriorLighting` sets the interior's ambient; `cr_interior_render` writes renders.

## Wagon travel (P1a)

`WagonStop` (Interact) opens a UI Toolkit list (`UI/Travel`: `TravelListView`, `TravelCoverCard`, `TravelUiPanel`, `TravelList.uss`) over `IWagonTravel`/`WagonTravelService`. Stops come from `Resources/OpenWorld/WagonStops.json` (built from `Data/Towns/wagon-stops.json` by `cr_wagon_build`; three stops: farm, Mirandale south gate, Bridgeford inn). A stop is listed once its region is discovered (`DiscoveredRegions`, read only); the ride is a cover card plus the normal location save. No beat is set by a ride. `rides[]` plus `StartRideAsync(rideKey)` run a scripted ride: the barn-sleep morning waits 4 s, then rides `act1-to-mirandale`, only for the trainer who slept. Strings are in `WorldText` (see the [ledger](?page=content/01-ai-content-ledger)).

## Story rows (P1a)

`CorridorLayout.story` is a `StoryRows` object with a list per row kind (12 kinds, `GauntletRow` among them). `ContinentSeedLoader` has a `story` section; the overlay merge prefixes **row ids only**, registry keys (event, dialogue, npc, quest, beat, location, arena, trainer) stay raw. `CorridorStoryStep` (`cr_world_build_corridor ... steps=story`) owns `[Continent Story]` / `[Corridor Story]`, stamps each row (`StoryRowStamp` hash) and is idempotent (a rebuilt toggle target rebuilds its event). Act 1 cells belong to `Act1Corridor`, so their rows are in `Data/Corridor/Act1/story.json` (`cr_world_seed_corridor --args section=story`); the continent `story.json` is empty. A layout builds only its own cells, so an overlay story row in an Act 1 cell errors.

**Registry validation.** `StoryRegistry` reads `Game/Story/Content/story-registry.json`; `StoryRowChecks` runs inside `cr_world_validate` and reports `story:<row>: unknown npc/dialogue/quest/beat/location/trainer key`. A zone's `arenaKey` is required. Registry NPCs placed by story rows need an `NpcDefinition`, or the existing unresolved-NPC rule errors.

## NPC looks and content commands (P1a)

- **Looks.** `npc-looks.json` (presets, defaults, per-key looks, tint materials) read by `NpcLookTable`; `RoleFor(name, npcType)` picks the role from the name segment, else the authored `_npcType`, else the legacy substring. `cr_dress_cell_npcs` dresses with BSMC 2.0 paths (`Prefabs/Catalog`, `Prefabs/Fantasy/Catalog/<Slot>`) and skips scenes without NPCs. Run it with `-executeMethod`; the pipeline CLI drops the long sweep.
- **`cr_quests_import_staging`**: imports staged story quests into the quest assets (dry run reports `0 changes`).
- **`cr_content_push`**: pushes quests, dialogue and NPC/trainer rows to the Studio server. The default server is production, so the user runs it. `ContentPushFilter` skips parked paths and any key with a `test` segment (for example `trainer-bridgeford-test`).
- **`cr_author_trainer`**: creates a trainer definition plus its NPC row in one command.
- `NpcDefinition.regionKey` round-trips through push, pull and the inspector.

## Mirandale and Bridgeford (P1b, 2026-10-19)

(Unity: cr-api-unity PR #108.) Two real towns replace the `town-test` sandbox, which `cr_town_remove` deleted (data, interior, scene, volume, trainer asset).

- **Mirandale** (`Data/Towns/mirandale.json`, region 6a, `city` kit, pad 310-400 x 705-795). Walled, four gates; 29 plots; square r 11.5 m with the Governor's stage, bell and `mirandale-arena`; Merchant Row, the Lower End with the open pit yard (`serpent-pit-arena`), Watchtower, Helena's school, the Damisel manor and the healer's house. 7 registry NPCs (Philroe, Mackio, Helena, Damisel, Roric, Mauricio, Merchant Row merchant), 9 locations. Interiors (`Data/Interiors/`): `serpent-tavern`, `helena-school`, `damisel-manor`, `watchtower`, `mirandale-healer`.
- **Bridgeford** (`Data/Towns/bridgeford.json`, region 18a, pad 925-1005 x 826-906). No wall; three bridges, crossroads square (r 11 m, `bridgeford-arena`), signpost, merchant stall, 11 plots, 2 NPCs, 3 locations. One interior: `bridgeford-inn` (Healer innkeeper). Its four `BeatGatedPass` rows live in `regions/18.json` `story`.
- **Wagon.** `Data/Towns/wagon-stops.json` keeps three stops (farm, Mirandale south gate, Bridgeford inn, moved beside the inn). The ride `act1-to-mirandale` (barn-sleep morning) ends at the Mirandale south gate; no beat is set by a ride.

### Engine additions

- **`TownPlot.startDisabled`.** The plot and its door build inactive (`TownPlanRow.StartDisabled`, `TownDesiredChild.Active`); a rebuild restores the start state and the hash covers it. Swap partners share one footprint: `School_intact` / `School_burnt` sit at the same local spot, and `TownChecks` skips the plot-overlap test when either plot is `startDisabled`. A story event toggles the pair (`school-burns`).
- **Cross-cell rule.** Town plots must stay inside the town's cell. The Mirandale pad crosses the c1_r2 / c1_r3 line at z 768, and c1_r3 is an Act 1 cell the Continent layout does not build, so the school pair lives at local (-14, 7). A row in the wrong cell is not built and its toggle is not found (`cr_world_build_corridor` warns).
- **`StoryRows.pickups`.** `StoryPickupRow {id, itemKey, quantity 1, oncePerTrainer true, position | interiorKey + localPosition {x,y,z}}`. World rows are placed by the story step (`StorySceneBuilder.Pickup`, `CR_Pickup` prefab, instance id `story-pickup-<id>`); interior rows are placed by `cr_interior_build` in `[Interior Story Pickups]` inside the hosted scene. Checks: item in registry `items`, quantity 1, `oncePerTrainer` true, interior file exists. The one P1b pickup is `key_music_player` in the Damisel manor.
- **Pickup scan.** `cr_pickup_placements_scan` / `_push` read `Scenes/Areas`, `Scenes/World/Cells` and `Scenes/World/Interiors` (`PickupSceneFiles`). A legacy area scene that holds a migrated copy of the same instance is skipped (`FirstPerInstance`), the repeat is reported.
- **`InteriorFile.arenaKey`.** Puts a `BattleArena` at the room centre and gives interior NPC slots that arena. The check needs a registry arena and a room of at least 8 x 8 m. `serpent-tavern` should carry `serpent-pit-arena`.
- **`cr_town_remove <key>[,dry]`.** Removes the town containers and manifest, each interior (scene, `hostedScenes` row, volume, Build Settings, manifest), the town's own wagon stops and rides, and its `-test` NPC/trainer definitions (compacting null provider slots). Town and interior data files stay.
- **NPC dressing.** `cr_dress_cell_npcs` also dresses `npc_<key>` / `NpcWorldBehaviour` objects and scans `Interiors` scenes.

### Act 2 story flow

`Game/Story/Content/story-registry.json` (rev 3) lists regions 6 and 18 as built. Quests run in order (line-act-2, then line-act-3 step 1); each grants beats on completion:

| # | Quest | Beat granted |
|---|---|---|
| 1 | The Lockdown | (none) |
| 2 | The First Duel (`shard-for-hellcat`) | (none) |
| 3 | The Crowned Serpent (gauntlet `gauntlet-serpent-pit`) | `serpent-pit-won` |
| 4 | Festival of Souls | `festival-done` |
| 5 | The Night the School Burned | `school-burned`, `mirandale-open` |
| 6 | The Trail Splits | `road-open` |

**Gates** (`BeatGatedPass`): `pass-6a-south-gate` needs `act1-done`; `pass-6b-bridgeford-road` needs `mirandale-open`; `pass-18-north`, `-south`, `-southwest` need `road-open`; `pass-18-east` needs `road-done` (Act 3 end). Turn-back barks are `ui.story.bark.pass.*`. Dialogues use `story.beat`, `npc.trainerLost` and `battle.start`, so the server dialogue vocabulary must be live before Studio pushes them.

**Owner steps after merge:** `cr_content_push --args all`, `cr_world_locations_push`, `cr_spawners_push`, NPC rows with `regionKey` / `lossAllowed`, then `cr_pickup_placements_scan` / `_push`. The server still needs a `key_music_player` item and pickup definition.

## The Road: Act 3 (P2, 2026-10-19)

(Unity: cr-api-unity "World P2: The Road — Act 3"; spec `CR/docs/specs/2026-10-19-world-p2-the-road-act3-design.md`, §2 as amended by §6 B1-B9.) After `road-open` the player leaves Bridgeford by any of three roads and frees three corrupted crystals from three generals, in any order. Anton's closing quest then grants `road-done`, which opens `pass-18-east` (Act 4). The story registry is rev 4 (regions 7, 10, 11, 12, 13, 14, 19 are `built`).

### The three spokes

| Spoke | Regions | Towns and camps | General (band) | Wagon ride from Bridgeford |
|---|---|---|---|---|
| North, the Warden of the Mines | 19 Ravine (19b hold, 19c Cellblock 83), 7 North Mesa | `ravine-hold` (19b, inn `ravine-inn`, healer `npc-ravine-innkeeper`, merchant `shop-ravine-hold`); Covenant mesa camp (7, not a town: tents, fire, `npc-covenant-medic` Healer) | Warden L18 (spoke band L13-16) | `bridgeford-to-ravine-hold` |
| South, the Marshal of the Sands | 11 Redwood, 10a Erranume camp, 13 Desert, 14 Coastal Scrubland | `redwood-village` (11a, inn `redwood-inn`, healer `npc-redwood-innkeeper`, merchant `shop-redwood-village`); `erranume-camp` (10a, healer `npc-erranume-elder`, no merchant); `sedran-hamlet` (13c, healer `npc-sedran-elder`, no merchant) | Marshal L20 (L15-18) | `bridgeford-to-redwood-village`, `bridgeford-to-sedran-hamlet` |
| South-west, the Veiled General | 12 Jungle, 10b Inselberg | none; the Drowned Gate (12) and the grown crystal (10b); the captive `npc-erranume-sister` | Veiled General L22 (L17-20) | none |

Bands are fixed per spoke (no scaling with generals freed). `Data/Towns/wagon-stops.json` now has six stops (farm, Mirandale south gate, Bridgeford inn, `ravine-hold`, `redwood-village`, `sedran-hamlet`); the new rides are `allowUndiscovered false`, so a town must be visited once first. The camp at 10a is reached on foot. Wild zones use the seven `*-wild-act3` spawners, retuned to the spoke bands (ravine/mesa L13-16, forest/desert/scrub L15-18, jungle/karst L17-20); the zones that sat on set pieces were moved and pinned (19a, 13c, 12g, and 13a at (456,200)).

**Healers.** `npc-ravine-innkeeper`, `npc-redwood-innkeeper`, `npc-erranume-elder` and `npc-sedran-elder` are Healer NPCs; `npc-covenant-medic` heals at the mesa camp. Their dialogues offer `team.heal`; shops are `npc.openShop` options.

### Quest lines (four steps per spoke)

Each spoke is a `questLine line-act-3-<spoke>` (`questLine`/`lineStep` are Studio metadata only). Ordering is explicit: type 7 (`road-open`) on step 1 and a type 0 (QuestCompleted) row on the previous step for steps 2-4. A VisitLocation fires once per session and the server has no objective order, so the fight and the attune are separate quests.

| Step | North | South | South-west |
|---|---|---|---|
| 1 | `quest-the-mines` (Cellblock 83: visit, read the ledger, beat the two guards) | `quest-sedran-hamlet` (Erranume camp, read the camp pillar, Sedran oasis, read the paint, Sedran elder) | `quest-jungle-passage` (Drowned Gate, beat the two poachers) |
| 2 | `quest-the-covenant-camp` (Henrik, Nicolai; the Henrik choice is flavour, both options `quest.recordTalk`) | `quest-the-great-dune` (beat the two sand riders, visit the dune) | `quest-the-inselberg` (visit the crystal, talk to the sister) |
| 3 | `quest-the-warden`: beat `npc-warden` (fight only, no beat) | `quest-the-marshal`: beat `npc-marshal` | `quest-the-veiled-general`: beat `npc-veiled-general` |
| 4 | `quest-attune-cellblock-83` "The Red Pillar" | `quest-attune-great-dune` "The Dune Pillar" | `quest-attune-inselberg` "The Grown Crystal" |

Step 3 is the general's fight (objectives are NPC keys, never trainer keys; a general beaten before step 3 is active does not count, `allowRematch true` covers it). Step 4 has one objective, ReadReadable `readable-<r>-pillar`, and carries `grantsBeats` for the general beat (`general-warden`, `general-marshal`, `general-veiled`); steps 1-3 grant none. Rewards are 400/600/900 XP plus 300 XP on step 4, gold 80/120/200/100, times 1.0 / 1.2 / 1.4 per spoke; step 4 also gives 3 `capture_crystal_standard`.

**Closing quest.** `quest-izzys-trail-east` (`line-act-3`, region 18) requires all three general beats (three type-7 rows), auto-grants, completes on TalkToNpc `npc-anton-bridgeford`, and grants `road-done`. After any two beats Anton (`dialogue-anton-bridgeford`: `two`, `closing`, `c2`, `done`) and the signpost (`readable-18-signpost`: `s-two`, `s-done`) change their text via `story.beat`; no mechanics.

### The reusable crystal set piece

One shape, three sites (`crystal-cellblock-83` in 19c, `crystal-great-dune` in 13c, `crystal-inselberg` at `10:crystal` in 10b). Per site, in the region overlay `story` block:

1. **Location** `story-<site>` (size 12) at the pillar (`story-red-pillar`, `story-great-dune`, `story-inselberg-crystal`).
2. **Arena** `<site>-arena` about 10 m from the pillar (`cellblock-83-arena`, `great-dune-arena`, `inselberg-arena`). Guards, riders and poachers use an arena within about 150 m of where they stand: `jungle-gate-arena` (12), `sedran-arena` (13c), `waystop-arena` (14).
3. **General NPC row**: NpcType Trainer, trainer key, arena key, with a `Data/Trainers/<trainer>.json` and a definition from `cr_author_trainer`. Teams: Warden ground/poison (gaterbear L18, poisonbomb L17, spike L18, snakelet L16); Marshal fire/ground (cindralis L20, cindrakar L19, spike L20, dragonfire L18); Veiled General wind/radiant/ice stand-ins for psychic (sunflowerfairy L22, sunflorapixie L21, snowbomb L21, dragonspark L20). All `lossAllowed false`, `allowRematch true`.
4. **Attune event** `attune-<site>`: `waitForQuestActive` the step-4 quest, `requiredQuestObjective` 0 (the pillar readable). The pillar swap is in `stages[]` on node `attune` of `dialogue-attune-<site>` (nodes `a1, a2, attune, a4, a5, end`; Ahksun and Tobias), so the colours change mid-line; event-level `enableOnPlay`/`disableOnPlay` are not used. Shots: a Wide on the pillar (a1, 1.6 s, 15 m south, fov 60) and ReturnToPlayer (a5); a 2 s prelude on 19 and 13.
5. **Blue cluster landmarks** `<r>:pillar_blue_a/_b` with `startDisabled`, placed beside the red or purple cluster that the stage disables. In 10b the stage also swaps the cage for `cage_open`. The beat comes from the step-4 quest (server); nothing client-side decides anything.

Region 7's duplicate `red_pillar`, `cellblock_gate`, `cellblock_cage` and `mine_head` were removed; 19c owns Cellblock 83.

### Roads

`Data/Map/roads.json` (now 37 roads) gained `road-act3-north`, `road-act3-south` and `road-act3-southwest`. Rivers are not edited: `ContinentPathsSeeder` plus `RoadCrossingPlanner` derive bridges from road x river intersections at `section=paths`.

| Road | From to | Length |
|---|---|---|
| `road-act3-north` | `pass-18-north` past the Covenant camp pass-by and the Cellblock yard to the hold pad (ends 570,1200) | 547 m |
| `road-act3-south` | `pass-18-south` through 11a and 10a, joins `road-10` at (520,215.5), ends 280,182 | 1331 m |
| `road-act3-southwest` | `pass-18-southwest` to the jungle edge, the 10b crystal spur, then west to the Drowned Gate pass-by | 984 m |

Cell row is `floor(z/256)`, column `floor(x/256)`. Act 1 pinned cells are `x < 512` and `768 <= z < 1280`; no sampled point of the new roads falls there. The south road crosses the mountain for about 52 m between 11a and 10a (the only way into the 10a enclave); vet it in the height build. After a road change the controller rebuilds `steps=height+paint+trees+dressing+details+guards` for the touched cells.

### Engine additions

- **`LandmarkPlacement.startDisabled`.** A landmark builds inactive; `GameObject.ApplyStartDisabled` (`CorridorPlacementExtensions`, called from `CorridorDressingStep`) re-disables it on each rebuild, which counts as Updated only if someone switched it on. It never re-activates: turning the flag off needs a `SetActive` or a recreate.
- **Kit roles `tent` and `awning`** (`Data/Towns/kits.json`, village kit, sizes from `cr_town_kits_measure`): `tent` 12.0 x 11.7 m (max over 5 prefabs, so camp plots should set `w`/`d` tighter), `awning` 4.5 x 4.6 m (4 Seaside cloth-frame prefabs). `awning` is a free role in `TownChecks`, so it may stand on the square.
- **`TownPlot.tint`** (`"#RRGGBB[AA]"`): `TownTint.TryParse`, `TownPlanRow.Tint` (in the signature hash), `TownChecks` rejects bad hex, and `PlotTint` multiplies each material's `_BaseColor`/`_Color` through a `MaterialPropertyBlock` (no material writes; re-applied at `OnEnable`). Used for the red Covenant paint on `house_b` in `sedran-hamlet` (`#8E3B2F`). Not yet checked visually.
- **Act 3 smoke plan.** `Game/Story/Smoke/Act3Smoke{Names,StepKind,Step,Plan}.cs`: 25 steps (Bridgeford, north spoke, back, south, back, south-west, back, Anton, `road-done`, `pass-18-east` opens). Plan only, like Act 2; the runner sections (`act2|act3|act4`) arrived in P3, see [The Court](?page=unity/37-open-world#the-court-act-4-p3-2026-10-19).
- **New data files.** Towns `ravine-hold`, `redwood-village`, `sedran-hamlet`, `erranume-camp` (each 40-70 m pad; `square.arena false`, so the registry arena is a story arena row); interiors `ravine-inn` and `redwood-inn` (copies of `bridgeford-inn`, slotRow 0); run `cr_interior_build ravine-inn` and `redwood-inn` before the volume tests pass.

### Healer region key

The server (`TeamHealService.HealAtNpcAsync`) refuses a heal unless `trainer.LastAreaKey` equals `npc.RegionKey` (OrdinalIgnoreCase; empty refuses). `LastAreaKey` comes from `TrainerLocationTracker` via `RegionTracker.CurrentRegion` = `RegionMask.Sample(x,z)`, which is the **leaf** mask key (`6a`, `19b`), not the top-level parent. Interiors are not held, so inside an inn the region is the door's leaf. So an NPC's `regionKey` must be the leaf area key:

| Healer | regionKey |
|---|---|
| `npc-mirandale-healer`, `npc-serpent-barkeep` | `6a` (Act 2, corrected) |
| `npc-bridgeford-innkeeper` | `18a` (Act 2, was `18`) |
| `npc-ravine-innkeeper` | `19b` |
| `npc-redwood-innkeeper` | `11a` |
| `npc-erranume-elder` | `10a` |
| `npc-sedran-elder` | `13c` (the elder stands at x 381; the hamlet straddles 13c/13a near x 391) |
| `npc-covenant-medic` | `7` (no sub-areas at the camp) |

Probe a spot with `cr_world_probe_ground`. `lossAllowed` is not gated on region (`IsLossAllowedAsync` reads `npc.LossAllowed` only). The Act 2 healer dialogues `dialogue-mirandale-healer`, `dialogue-bridgeford-inn` and `dialogue-serpent-barkeep` now offer "Can you see to my team?" with `team.heal`; before, a Healer with a conversation could heal only through its document and had no such option.

**Owner steps after merge:** `cr_content_push --args all`, `cr_world_locations_push` (seven new `story-*` VisitLocation targets), `cr_spawners_push` (seven retuned `*-wild-act3`, two new `shop-*`), NPC rows with `regionKey` = leaf area key and `lossAllowed`. The server dialogue vocabulary (`story.beat`, `npc.trainerLost`, `battle.start`) must be live first.

## The Court: Act 4 (P3, 2026-10-19)

(Unity: cr-api-unity "World P3: The Court — Act 4"; spec `CR/docs/specs/2026-10-19-world-p3-the-court-act4-design.md`, §2 as amended by §6 B1-B10.) After `road-done` (`pass-18-east` open) the player enters the Pilgrimage Season bracket at the Coliseum, beats the Champion in the crypt and frees the fourth crystal (`coliseum-won`), then crosses `pass-20-east` to the Capital, where the Actuators' Court rules against them and Gaweyn loses the case in the Marble Tower (`court-done`). The story registry is rev 5 (regions 20 and 21 are `built`). Band L24-30.

### Places

| Place | Where | What |
|---|---|---|
| `coliseum-town` | 20b pad (only its SE quadrant, x 1380-1420, z 955-1000, is leaf `20b`) | City kit: inn (interior `coliseum-inn`, healer `npc-coliseum-innkeeper`, regionKey `20b`), merchant `npc-coliseum-merchant` (`shop-coliseum`), Pilgrimage stalls with awnings, the Champion banner (`champion_flag` landmark kept), wagon stop `coliseum-town`. `square.arena false`. |
| `arena-ring` | 20a, ring rect 1240-1320 x 960-1040 | Tiny single-plot town file: one `gatehouse` plot, `crypt_door`, whose door is interior `arena-crypt` (stand point at the ring's south gate). The four towers stay landmarks; the arena row `coliseum-arena` is a story row at the ring centre (1280,1000). |
| `arena-crypt` | interior, `arenaKey crypt-arena` | The Champion `npc-champion` (Trainer, `lossAllowed false`, `allowRematch true`) beside the fourth crystal, which is interior props, not the old `20:arena_crystal` landmark (deleted; `20_vista` passWhen rewritten). |
| `capital` | 21a pad, 100 percent 21a | Walls own the ring (the P0 west/south gate and tower landmarks and the `court_hall` / `marble_tower` masses were removed), inn (`capital-inn`, healer `npc-capital-innkeeper`), merchant `npc-capital-merchant` (`shop-capital`), a `court_hall` plot whose door is `court-hall`, four houses, plinth, benches, wagon stop `capital`. Roland `npc-roland` (QuestGiver) stands inside the south gate. The Lower End (21b) is outside the pad and stays untinted landmarks. |
| `marble-tower` | 21c pad 1705-1752 x 1235-1266 | Tiny single-plot town file: one scaled (2.4) `tower` plot, door `marble-tower`. |
| `court-hall` | interior | Benches, dais stand-in, judge's table; `npc-court-clerk`, `npc-regent` (talk only). |
| `marble-tower` | interior, one flat hall, `arenaKey tower-arena` | Guards `npc-court-guard-1/2` near the door, `npc-gaweyn` at the far end beside the dais. |

Rides `bridgeford-to-coliseum` and `bridgeford-to-capital` (`allowUndiscovered false`). Interior doors come only from town plots inside a pad, which is why the ring and the tower get their own one-plot files. Integration fixes: the `coliseum-inn` plot moved and the `marble-tower` room shrank to a 12 x 12 hall (tower plot scale 2.0) so each door and its room sit in one region (the first builds were refused: the room reached 20c water / 21a and mountain). The dais in `court-hall` and `marble-tower` is a sunk `statue_base` plinth (id `dais`, top at floor level, so NPCs standing on the floor are not buried). The first `cr_interior_build` of `arena-crypt` and `court-hall` shows the `[Interior Story]` container; the second build reports 0 changes. Interior volumes are written by `cr_interior_build`; run it for `coliseum-inn`, `arena-crypt`, `capital-inn`, `court-hall`, `marble-tower` before the volume tests pass.

### Quest line (`line-act-4`, five steps)

Step 1 needs `road-done` (type 7); steps 2-5 need the previous step (type 0). A scripted loss cannot sit in a gauntlet (it would reopen the stage forever), so Izzy's final is not a gauntlet stage.

| Step | Quest | Objectives |
|---|---|---|
| 1 | `quest-the-tournament` | VisitLocation `story-coliseum-gate`; TalkToNpc `npc-coliseum-master`; the bracket (DefeatTrainersFromList `npc-bracket-1/2/3`, run as `gauntlet-coliseum-bracket`); FightTrainer 43 `npc-izzandra-final` (win or lose) |
| 2 | `quest-under-the-arena` | DefeatTrainer `npc-champion` only (the crypt door is open all along) |
| 3 | `quest-attune-arena` | ReadReadable `readable-20-arena-pillar`; grants beat `coliseum-won` |
| 4 | `quest-the-marble-tower` | Visit `story-capital-gate`; Talk `npc-roland`; Visit `story-marble-tower`; Talk `npc-court-clerk`, `npc-regent`, `npc-gaweyn` (the server has no order on the talks; each dialogue stands alone) |
| 5 | `quest-the-verdict` | ReadReadable `readable-21-edict-of-daemamion`; DefeatTrainersFromList `npc-court-guard-1/2`; DefeatTrainer `npc-gaweyn`; grants beat `court-done` |

- **Bracket then Izzy.** The gauntlet is host `npc-coliseum-master` (a story `npcs` row at the ring gate), healer `npc-coliseum-medic`, trainers bracket 1-3 (L24-26, two creatures each). After stage 3 the master says Izzy waits. `npc-izzandra-final` is a separate Trainer row (`trainer-izzandra-final`, L27 sunflowerfairy, wolfpup, crabby; `lossAllowed true`, `allowRematch true`, arena `coliseum-arena`); her dialogue has win, lose and challenge branches, and the story continues either way. The Edict's rule against a Hellcat touching a human is flavour text in the master's dialogue.
- **Attune by reading.** As in P2: the step-3 pillar readable carries the beat. The pillar swap (red cluster off, blue cluster on) is a stage on node `attune` of `dialogue-attune-arena`; the event `attune-arena` lives in the crypt.
- **Regent.** No event row (an event dialogue alone fails the content audit and would race the NPC's own `recordTalk`). `dialogue-regent-audience` is `npc-regent`'s dialogue: the pending-talk case is the audience, otherwise a one-line dismissal. `the-verdict` is an event row inside `court-hall` (`waitForQuestActive quest-the-verdict`) and has its own dialogue, `dialogue-the-verdict` (clerk, Regent, Gaweyn's aside); the clerk's `dialogue-court` is talk only.
- **Fights.** Champion L29 (dragonfire, gaterbear, cindrakar, shell; challenge only while step 2 is Active); court guards L27; Gaweyn L30 (snowbomb, poisonbomb, dragonspark, cindralis; challenge only when step 5 is Active and both guards are beaten, via `quest.objectiveCount`). Champion and Gaweyn use objective type 43 (NPC key).
- **Gates.** `pass-20-east` (BeatGatedPass, requires `coliseum-won`, bark `ui.story.bark.pass.coliseum-east`) sits on the last 20a point of road-25 at (1422,1057), yaw 90, so the Capital is unreachable until step 3 completes. `pass-21-east` (requires `court-done`, bark `ui.story.bark.pass.capital-east`) sits on road-32 at (1676,1030). The `flight-east` lineCue (Roland's `flight` node) fires at the Capital's south gate after `court-done`.
- **Rewards (mine, spec silent).** XP 1500 / 1800 / 600 / 1600 / 2200, gold 300 / 350 / 200 / 320 / 400; 3 `capture_crystal_standard` on steps 3 and 5; 3 super potions on step 5.

### Story rows inside interiors (engine E1)

`StoryEventRow`, `StoryReadableRow` and `StoryLocationRow` gained `interiorKey` and `localPosition` (the pickups pattern, shared interface `IInteriorHosted`). `localPosition` is room-local: x,z from the room centre, y above the floor (events also lift by half their size, so the box sits on the floor); `yaw` applies. Rules:

- `InteriorBuildTool.BuildStory` places them in a container `[Interior Story]` under the interior root (via `StoryRowPlacer.Build` with an `anchorOrigin`; shot points are room-local, y = floor + up) and hashes them (`InteriorBuildTool.Hash(file, pickups, gauntlets, story)`; an empty story hashes as before). Entry point is unchanged: `cr_interior_build --args <key>[,dry]`.
- `StoryRows.InWorld()` drops every interior-hosted row, so `CorridorStoryStep` skips it and reports `hosted by interior <key> (the interior build places it)`. `StoryRowChecks` errors if the interior has no file and warns when `localPosition` is zero.
- Toggle names in an event resolve inside the interior root (`InteriorToggleResolver.Find`: any descendant including inactive ones, `[Gauntlets]`, arena children), as written or as `Prop_<name>`.
- `InteriorProp` gained `id` (object `Prop_<id>`, else the old `Prop_<index>_<prefab>`) and `startDisabled` (built inactive). The crypt uses `crystal_red` and `crystal_blue` with the blue one disabled; the attune stage swaps them. Checks reject duplicate ids and whitespace.
- Used by: `readable-20-arena-pillar` and `attune-arena` (crypt), `readable-21-edict-of-daemamion`, `readable-21-court-notice` and `the-verdict` (court hall). The outdoor locations `story-arena-crypt` and `story-capital-court` stay as discovery text only.

### Roads

`roads.json` is now 39 roads. Existing roads already reach the 20b pad from `pass-18-east`; the two new pieces only fill gaps, and are separate ids because they are disjoint:

| Road | From to | Length |
|---|---|---|
| `road-act4-east-spur` | pad west edge (1352,972) to the ring's east side (1322,966), 2 m outside the ring rect (the south-edge point is within 10 m of `arena_gate_s`) | 30.6 m |
| `road-act4-east` | (1519.5,1128.5) to the Capital pad west edge (1640,1128), north of the Lower End | 133.5 m |

No bridges (no river crossings) and no point in the pinned Act 1 cells. Rebuild `height+paint+trees+dressing+details+guards` for the touched cells.

### Kit and smoke

- **`gatehouse` kit role** (`kits.json`, city kit, `BLD_03_4x4_Ext_01`, frontYaw 90, 7.19 x 5.75 x 18.1 m): the 4x4 shell, smaller than `house`. A plot's `door` works on any role (the planner puts the door out along the role's frontYaw past the footprint); `KitRolesP3Tests` confirms it for `tower` and `gatehouse`. Verify the door side with a render (frontYaw assumed).
- **Dais props.** No dais exists in the packs; use `P_PROP_statue_base_city_01` (a 4.2 m plinth) or the half stair run `P_MOD_Stairs_02_E_straight_01_half` (low step, under 2.6 m). The `P_MOD_Base_02_straight_large` is 6 m high.
- **Act 4 smoke plan.** `Game/Story/Smoke/Act4Smoke{Names,StepKind,Step,Plan}.cs`: 31 steps in gate order (`pass-18-east`, tournament, crypt, attune, `coliseum-won`, `pass-20-east`, tower, verdict, `court-done`, `pass-21-east`). Kinds are Act 3's plus TalkToNpc, RunGauntlet, FightTrainer.
- **Runner sections (engine E2).** `cr_story_smoke_start --args act2|act3|act4` (Play) lists the plan, then reads state back without driving the player: quests through the quest service, beats through `IStoryBeatReader`; walks, fights and reads print as `drive` lines. It fails only if state is not a clean prefix of the plan, and ends with `probed steps reached from the start: N of M`. `--args plan:act4` (or `cr_story_smoke_plan --args act4`) prints the listing without Play. Code: `ActSmokeSections`, `ActSmokeLine`, `ActSmokeProbe`, `ActSmokeProgress`, `StorySmokeRunner.Acts.cs`.

### Healer keys and owner steps

Healers use leaf keys again: `npc-coliseum-innkeeper` `20b`, `npc-coliseum-medic` `20a`, `npc-capital-innkeeper` `21a` (see [Healer region key](?page=unity/37-open-world#healer-region-key)). Other NPC keys: master, bracket 1-3, Izzy final, Champion `20a`; Roland, clerk, Regent, merchant `21a`; Gaweyn and the guards `21c`.

**Owner steps after merge:** `cr_content_push --args all`, `cr_world_locations_push` (new `story-*` VisitLocation targets), `cr_spawners_push` (`shop-coliseum`, `shop-capital`), NPC rows with `regionKey` = leaf area key and `lossAllowed`. The server dialogue vocabulary (`story.beat`, `npc.trainerLost`, `battle.start`) must be live first.

## World map tab

In open mode `OpenWorldMapLayoutSource` replaces the legacy node layout: every region (sub-regions included; not mountain, ocean or unassigned) is shown
with `WorldMapUnknownAreaDisplay.AllVisible` (no fog; discovery of regions deferred). `WorldMapDefinition.backgroundSprite` draws `world-map.png` in a
child element sized to the same canvas rect as the nodes (`WorldMapLayout.BackgroundRect`), and `IWorldMapMarkerSource` places an exact player marker from
`IOpenWorldPlayer` (refreshed on tab open, not live). Since v0.1.8 the definition is built with `nodeDisplay = Markers` (a 16 px marker per
region with a decluttered name beside it), the tab fills its page and the map zooms (1 to 8, opening at 2.5× on the player) and pans;
the pin is the region tracker's key only, never the legacy area loader's. See [World Map → The open-world map](?page=unity/35-world-map).

## Story start and migration

New trainer in open mode wakes in **1a Cliff Ruins**, descends past the merchant, sees the Meadow (2b) and Village (2a); Act 1 must still play end to end, online and offline. Steps (playable after each): World scene + streamer + tracker behind `world_mode`; Act 1 corridor cells; tech-demo entry; flip default to `open`; delete the legacy door path.

## Far field (summary)

Per-object LODs and per-cell proxies (fade 0.5 s on load/unload, terrain proxies included), plus the backdrop and vista ground. GPU occlusion culling and GPU Resident Drawer are off today and trialled on the Deck behind an A/B. The Act 1 corridor's terrain and dressing come from the corridor builder; the art in it is an AI draft (see the [AI content ledger](?page=content/01-ai-content-ledger)).

## See also

[World Map](?page=unity/35-world-map) (the player menu Map tab), [World Behaviours](?page=unity/03-world-behaviours). Story beats, the gauntlet and the Healer: [Opening Story](?page=unity/38-story-opening#healer-battlestart-and-the-scripted-loss-p1a).
