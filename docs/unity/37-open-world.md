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
per-load. **World init per visit:** `IWorldInitializable`s of a cell run on each promotion (merchant stock re-rolls per visit); ones on inactive objects (parked content, e.g. the demo quest-giver the corridor build parks) are skipped and logged by name, so an initializable must be active at promotion: one switched on later in the visit (a OneShotWorldEvent's `enableOnPlay`, a story beat) is not initialized until the next promotion, and nothing in the scenes does that today (`IWorldInitializable` states the contract); a trainer switch mid-promotion restarts the cell's promote with the new context. A failed load retries with backoff (1, 2, 4 s) and does not block other cells.

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
| `cr_world_bake_proxy` | `"c,r"` | Bakes the cell's far-field proxy to `Resources/OpenWorld/Proxies/Proxy_c{c}_r{r}.prefab` via `ICellProxyBaker` (built-in fallback baker: copies of enabled renderers ≥ 8 m, one LOD level per group, shadows off, plus a `TerrainProxy` per terrain; Amplify baker later). |
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
- `cr_world_bake_proxy` copies only the last LOD level of a group, skips disabled renderers (vendor collider hulls), and adds a
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

## World map tab

In open mode `OpenWorldMapLayoutSource` replaces the legacy node layout: every region (sub-regions included; not mountain, ocean or unassigned) is shown
with `WorldMapUnknownAreaDisplay.AllVisible` (no fog; discovery of regions deferred). `WorldMapDefinition.backgroundSprite` draws `world-map.png` in a
child element sized to the same canvas rect as the nodes (`WorldMapLayout.BackgroundRect`), and `IWorldMapMarkerSource` places an exact player marker from
`IOpenWorldPlayer` (refreshed on tab open, not live). See [World Map](?page=unity/35-world-map).

## Story start and migration

New trainer in open mode wakes in **1a Cliff Ruins**, descends past the merchant, sees the Meadow (2b) and Village (2a); Act 1 must still play end to end, online and offline. Steps (playable after each): World scene + streamer + tracker behind `world_mode`; Act 1 corridor cells; tech-demo entry; flip default to `open`; delete the legacy door path.

## Far field (summary)

Per-object LODs and per-cell proxies (fade 0.5 s on load/unload, terrain proxies included), plus the backdrop and vista ground. GPU occlusion culling and GPU Resident Drawer are off today and trialled on the Deck behind an A/B. The Act 1 corridor's terrain and dressing come from the corridor builder; the art in it is an AI draft (see the [AI content ledger](?page=content/01-ai-content-ledger)).

## See also

[World Map](?page=unity/35-world-map) (the player menu Map tab), [World Behaviours](?page=unity/03-world-behaviours).
