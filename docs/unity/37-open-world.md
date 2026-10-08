# Open World

> **Status: in development** (branch `feature/open-world`, cr-api-unity). Not on main. `world_mode` defaults to `legacy`;
> the default flips to `open` only after the Act 1 corridor is playtested. Nothing here changes cr-api, the schema or
> the server-authority boundary.

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
per-load. **World init per visit:** `IWorldInitializable`s of a cell run on each promotion (merchant stock re-rolls per visit); a trainer switch mid-promotion restarts the cell's promote with the new context. A failed load retries with backoff (1, 2, 4 s) and does not block other cells.

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
| `cr_world_validate` | none | Objects outside their cell (+/- 2 m, looks inside migrated containers), built cells missing from Build Settings, regions with no profile, unresolved NPC keys, ocean spawns. Summary `E error(s), W warning(s), I info`; checks skipped for a missing provider/mask/profile set show as warnings. |
| `cr_world_bake_proxy` | `"c,r"` | Bakes the cell's far-field proxy to `Resources/OpenWorld/Proxies/Proxy_c{c}_r{r}.prefab` via `ICellProxyBaker` (built-in fallback baker: merged low-detail copies, shadows off; Amplify baker later). |
| `cr_world_add_lods` | `"c,r"` | Adds `LODGroup`s to the cell's large renderers (grouped; small clutter gets a cull distance). Cell scene must exist; saves it. |
| `cr_world_build_backdrop` | none | Builds the ocean plane + mountain ring blockout prefab (`OpenWorld/WorldBackdrop`), instanced in `World.unity`. |
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

Four cells, blockout at real scale (user dresses): `World_c0_r4` (1a ruins plateau; start spawn **(208, 30.1, 1105)**), `World_c0_r3`
(Meadow 2b + Village 2a content, migrated), `World_c1_r3`, `World_c1_r4` (blockout ground only). Meadow and Village spawns are ~63 m apart and
their content overlaps in c0_r3 until re-dressed. The shipped assets are `WorldLayout`, `RegionMask`, `RegionProfiles`, `WorldBackdrop` and `World.unity`.

## World map tab

In open mode `OpenWorldMapLayoutSource` replaces the legacy node layout: every region (sub-regions included; not mountain, ocean or unassigned) is shown
with `WorldMapUnknownAreaDisplay.AllVisible` (no fog; discovery of regions deferred). `WorldMapDefinition.backgroundSprite` draws `world-map.png` in a
child element sized to the same canvas rect as the nodes (`WorldMapLayout.BackgroundRect`), and `IWorldMapMarkerSource` places an exact player marker from
`IOpenWorldPlayer` (refreshed on tab open, not live). See [World Map](?page=unity/35-world-map).

## Story start and migration

New trainer in open mode wakes in **1a Cliff Ruins**, descends past the merchant, sees the Meadow (2b) and Village (2a); Act 1 must still play end to end, online and offline. Steps (playable after each): World scene + streamer + tracker behind `world_mode`; Act 1 corridor cells; tech-demo entry; flip default to `open`; delete the legacy door path.

## Far field (summary)

Per-object LODs and per-cell proxies (fade 0.5 s on load/unload), plus the backdrop. GPU occlusion culling and GPU Resident Drawer are off today and trialled on the Deck behind an A/B. Terrain and art dressing are the user's.

## See also

[World Map](?page=unity/35-world-map) (the player menu Map tab), [World Behaviours](?page=unity/03-world-behaviours).
