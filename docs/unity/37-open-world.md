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
per-load. If the player outruns streaming (resume, slow Deck) they are held at the cell edge behind a short fade until the
destination is Active; the only fade left. Battles suspend streaming for their duration.

### Region identity

`RegionTracker` samples the mask about 4 Hz; a new key must hold 0.5 s (`RegionDebounce`) before `RegionChanged(from, to)`.
On change: banner (boxes show their own name), music crossfade (`RegionAudioDirector`), sky/fog/ambient blend
(`RegionEnvironmentDirector`, 3 s), and a forced trainer-location save. Location XP is unchanged (location-enter intent).
`RegionTracker` is the `ICurrentLocationSource` in open mode (`AreaLoader` in legacy).

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

Menu `CR/World/...`; each has a CLI command (`unity cmd <name> --args ...`, see the Unity CLI reference).

| CLI command | Does |
|---|---|
| `cr_world_import_map` | Reads `world-map.png` + `regions.json`, writes `RegionMask.asset` and `region-mask-debug.png`. Logs unknown colours with counts. |
| `cr_world_create_cell --args c,r` | New cell scene with root `Cell_c{c}_r{r}`, blockout ground, `CellActivator`, `AreaWorldInitializer`; adds it to Build Settings and `WorldLayout.builtCells`. |
| `cr_world_migrate_area --args Meadow,237,927` | Copies a legacy area scene's root objects (prefab links kept) into the right cell roots, offset so the area spawn lands at the given world x,z. The legacy scene is read, not saved. |
| `cr_world_validate` | Objects outside their cell (+/- 2 m), built cells missing from Build Settings, regions with no profile (info), unresolved NPC keys, spawn points in the ocean. |
| `cr_world_bake_proxy --args c,r` | Bakes `Proxy_c{c}_r{r}.prefab` from the cell's large renderers via `ICellProxyBaker` (built-in fallback: merged low-detail copies, shadows off; Amplify Impostors baker once the package is imported). |
| `cr_world_add_lods` | Adds `LODGroup` to large props (mesh, then impostor when available, then culled); small clutter gets a cull distance. |
| `cr_world_build_backdrop` | Builds the mountain ring + ocean plane in the World scene (never streamed). |
| `cr_world_seed_profiles` | Seeds `RegionProfiles.asset` with a profile entry per region in the mask for the user to dress. |

Also in the menu: Region overlay (Scene-view borders, roads, cell lines, "you are in 2b" readout).

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

Cave, Shore, Crags and Dunes have no place on the map. They stay as their legacy scenes, reachable only from a dev/Editor
"Tech demo areas" entry (region key `techdemo`). `OpenWorldBootstrap.EnterTechDemoAsync` suspends the streamer and calls
`AreaLoader.GoToAreaAsync`; `ReturnToWorldAsync` unloads the area, resumes streaming and returns to the remembered world pose.
Legacy keys map through `WorldLayout` (`Meadow` -> `2b`, `Village` -> `2a`, the four above -> `techdemo`).

## Story start and migration

New trainer in open mode wakes in **1a Cliff Ruins**, descends past the merchant, sees the Meadow (2b) and Village (2a); Act 1 must still play end to end, online and offline. Steps (playable after each): World scene + streamer + tracker behind `world_mode`; Act 1 corridor cells; tech-demo entry; flip default to `open`; delete the legacy door path.

## Far field (summary)

Per-object LODs and per-cell proxies (fade 0.5 s on load/unload), plus the backdrop. GPU occlusion culling and GPU Resident Drawer are off today and trialled on the Deck behind an A/B. Terrain and art dressing are the user's.

## See also

[World Map](?page=unity/35-world-map) (the player menu Map tab), [World Behaviours](?page=unity/03-world-behaviours).
