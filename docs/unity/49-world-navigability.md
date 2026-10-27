# World Navigability

Can the player walk to everything the world asks of them, and does the third-person camera stay usable while they do? This page covers the **nav probe** that measures it, the **collider rule** that keeps generated pieces from walling rooms in, the **camera trim** that lets the camera look through minor town trim, the **Player-build safety check** for mesh colliders, the **dungeon clearance rules**, and how **overworld rows** are kept on reachable ground (rows by snapping, terrain by repair pads).

Related: [Dungeon Scaffold](?page=unity/47-dungeon-scaffold), [Open World](?page=unity/37-open-world) (towns, interiors, story rows), [Side Content Packets](?page=unity/46-side-content-packets), [World Fill Content](?page=content/02-world-fill).

**Server authority is untouched.** Everything here is Editor tooling and content placement. Nothing reports an outcome; the probe only reads scenes, and the row tools only move positions of content rows.

## Why this exists

A probe of the shipped scenes found three families of defect:

| Defect | Cause | Size |
|---|---|---|
| Interiors you could not walk in (10 of 35 at 0% reach, the mine beside the meadow among them) | `EnsureCollider` put **one box over the whole renderer bounds** of every prefab that had no collider. For `RockCave` that is a 57 x 55 x 39 m solid block; stairs, arches, bridges and gates became solid blocks too. | 10 interiors, many props |
| Dungeon gates that never opened, quest pickups sealed in | The scaffold wrote event rows at `y = height / 2` and the interior build lifted them again, so the event box floated half a room height above the floor and the player never entered it. | every dungeon with events |
| Overworld pickups, zones, NPCs and readables on slopes steeper than the player can climb or on islands | Rows are authored at hand-picked x/z; only y is snapped to the terrain. | about 82 targets in the cells |

## The player and camera model

The probe measures what the real rig can do (taken from the player object in `Core.unity`):

| Quantity | Value |
|---|---|
| Capsule | radius 0.35 m, height 1.7 m |
| Slope limit | 50 degrees (terrain 45 degrees) |
| Step height | 0.4 m |
| Camera | Cinemachine third-person follow, arm 6 m overworld, **3.2 m** with the interior profile, obstacle radius 0.35 m, shoulder offset (1, 2, -2); obstacle avoidance ignores triggers and sees the **Default layer only** (`CollisionFilter` = 1 on the Malbers rig; `NavProbeSettings.CameraMask`), see [Camera trim](#camera-trim-the-cameraignore-layer) |

Only non-trigger colliders count as solid. Tunables are in `NavProbeSettings`.

## The nav probe

Code: `Assets/CR/Core/Data/Editor/Build/CrNavProbeCommands.cs`, `NavProbe/` (Unity side, one type per file), `NavProbe/Logic/` (engine-free rules, asmdef `CR.Core.NavProbe.Logic`, with tests). Read-only: scenes are opened additively and closed **unsaved**, and `Core.unity` is never opened for saving.

### Commands

`unity cmd --project-path <repo> <command> --args "<args>"`. Probe and repair return at once and step across editor ticks (about 25 s of work per tick), so poll the status command.

| Command | Does |
|---|---|
| `cr_nav_probe --args "scene=<path\|SceneName\|all\|cells\|interiors\|areas\|prologue> out=<dir> [radius=40\|full] [cell=0.5] [ignore=A\|B]"` | Starts a run. `all` = cells + interiors + prologue; `areas` (legacy scenes) is opt-in. `radius` = metres sampled around each seed and target in a cell (`full` = whole cell); `cell` = grid spacing (default 0.25 m in a small interior, 0.5 m in a cell); `ignore` = what-if pass, see below. |
| `cr_nav_probe_status` | Progress, or the outcome of the last run with its worst scenes. |
| `cr_nav_probe_cancel` | Stops the run, closes its scene, keeps partial results. |
| `cr_nav_repair --args "scene=<path\|SceneName\|interiors\|cells\|areas\|all> [out=<dir>] [dry=true]"` | Swaps whole-bounds boxes in saved scenes for the colliders the rule below picks, **and moves minor town trim to the `CameraIgnore` layer** (the `[Town ...]` containers and the `[Continent Landmarks]` / `[Corridor Landmarks]` containers; the log line shows `camera-trim N`). Saves each changed scene (never Core). `dry=true` only counts. Idempotent. One line per scene goes to `<out>/repair.log`. Also covers the town containers inside cells and the dungeon gatehouse towns. |
| `cr_collider_mesh_audit --args "scene=<all\|path\|name\|cells\|interiors\|areas> [out=<dir>] [fix=true] [dry=true]"`, `cr_collider_mesh_audit_status`, `cr_collider_mesh_audit_cancel` | Player-build safety check for `MeshCollider`s, see [Mesh colliders in a Player build](#mesh-colliders-in-a-player-build). |
| `cr_nav_repair_status`, `cr_nav_repair_cancel` | As above. |
| `cr_nav_snap_rows`, `cr_dress_cells` | Overworld row placement and NPC dressing, see [Overworld rows](#overworld-rows-on-reachable-ground). |

### What it measures, per scene

1. **Seeds.** Interiors: the point just inside `Door_exit`, facing inward. Cells: portals, `WorldDoor`s, town gates, player starts; terrain centre as the fallback.
2. **Walk graph.** A grid over the room (cells: only near seeds and targets), ground by downward raycast, slope at most 50 degrees. A node is free when the capsule fits there; an edge exists when a capsule sweep passes allowing a 0.4 m step. Flood fill from the seeds gives `reachablePct` of the walkable floor or terrain band. In cells, large open ground that no seed reaches counts as reachable with the note `OPEN_GROUND_NOT_SEEDED`.
3. **Target reachability.** Every `WorldDoor`, NPC, pickup, readable, event box, location trigger, wagon stop and spawner zone (gauntlet stations are skipped: they are a bare object at the container origin). A target is reachable when a reached node is within 1.5 m (a wagon stop, a cart or boat hull, within the 2.5 m interaction radius). Each unreachable target reports its name, hierarchy path, position, the colliders within 2 m (with their prefab asset), a **reason code**, and the **nearest reachable ground** at least 2 m inside the reachable area (never on its rim, never seabed below y -0.5), plus spare spots at least 2.5 m apart.
4. **Doors.** The capsule must pass through every `WorldDoor` frame (swept 1.5 m along its forward). Teleport doors that are solid by design are counted apart.
5. **Camera pinch.** On reachable nodes about every 2 m, for 8 yaws and pitches -10, 15 and 35 degrees: sphere-cast (radius 0.35) from the head back along the arm, **against the layers the camera sees** (`CameraMask`, Default only, so `CameraIgnore` trim never clamps it), and record the clamped length. A node is **pinched** when the arm is under 1.5 m for at least 6 of 8 yaws at 15 degrees. Pinched nodes within 3 m form a **cluster** that names the colliders clamping it. A camera end point inside a collider is flagged too.
6. **Geometry audit.** `walkThrough` (wide renderer, no collider anywhere on it), `oversizedBoxes` (a generated box filling 3 or more times the volume of its meshes, or covering a door, arch, stair, bridge, tunnel or cave by name), `triggerOnly` (every collider is a trigger), `tinyColliders` (solid colliders cover a small part of what the piece shows). Lists are capped; the `...Total` fields are not.

### Reason codes

| Code | Meaning |
|---|---|
| `BLOCKED_BY_COLLIDER` | Ground exists but a solid collider fills the capsule space. The blockers are listed. |
| `NO_GROUND` | No surface within reach (a trigger volume hanging above the room is this). |
| `TOO_STEEP` | Ground exists but only above the slope limit. |
| `STEP_TOO_HIGH` | A ledge higher than 0.4 m separates it from reachable ground. |
| `ISLAND` | Standable ground that no seed connects to. |

### What-if pass

`ignore=Name1|Name2` re-takes the measures with colliders whose **object or prefab name contains** one of the names treated as absent (it matches collider object or prefab names, not dungeon prop ids). The report's `whatIf` block holds the second set of numbers. It answers two questions: "what is still wrong once this barrier opens", for gates that events remove, and, automatically when the real run cannot start because something swallows the arrival point, "what is still wrong once that is fixed".

### Output

`<out>/<SceneName>.json` per scene, `<out>/summary.json` and `<out>/summary.md`. The JSON is `NavSceneReport`: `scene`, `kind` (`interior`, `cell`, `area`, `prologue`), `gridCount`, `reachableCount`, `reachablePct`, `seeds[]`, `targets[]` (`name`, `path`, `kind`, `pos`, `reachable`, `reason`, `blockers[]`, `nearestReachable`), `doors[]`, `pinchClusters[]`, `audit`, `whatIf`, `notes[]`, `error`. `summary.md` is one table, worst scene first: scene, kind, reach % (with the what-if value in brackets), unreachable targets, impassable doors, pinch clusters, audit counts.

### Running it as a release gate

Run it against the Editor that has the project open (one Editor per project; several agents must serialise their Editor cycles).

```
unity cmd --project-path <repo> cr_nav_probe --args "scene=all out=/tmp/nav-gate"
unity cmd --project-path <repo> cr_nav_probe_status        # repeat until it reports the outcome
```

Then read `/tmp/nav-gate/summary.md`. A release is clean when:

| Scene kind | Gate |
|---|---|
| Interior (hosted dungeon or town interior) | reach >= 65% of the floor (a closed shell with a deliberate void prop is the only exception, written down), **0 unreachable targets** (after the event-removed barriers, via `ignore=`), **0 impassable required doors**, no pinch clusters (at most one unavoidable, with a reason). |
| Cell | 0 unreachable targets other than the ones listed as `manual` in the snap ledger (each with a reason), no new pinch clusters. |

The whole world takes a while, so run `scene=interiors` after a dungeon change and `scene=cells` after a placement change, and `all` before a build. Unit tests for the pure rules run with `cr_edit_tests_start` (fixtures under `CR.Core.NavProbe.Logic.Tests`).

## Generated colliders: the EnsureCollider rule

`EnsureCollider` (`Assets/CR/Game/OpenWorld/Editor/Towns/TownColliderExtensions.cs`) runs on every placed town piece, interior shell piece and dungeon prop. A piece that **already has a collider keeps it**. A piece with none gets one of:

| Piece | Collider |
|---|---|
| Has a pack collision mesh: a child named `*_Collider` (case-insensitive) whose renderer is off | A **non-convex `MeshCollider` on that mesh** (the pack's own answer to what is solid; `RockCave_Collider` is a 96-vertex shell). |
| Static meshes | A **non-convex `MeshCollider` per mesh filter** (LOD 0 only, so a mesh is not doubled; particles, trails, billboards, disabled renderers, foliage and switched-off children skipped). |
| **Thin flat piece**: shortest bounds axis under 0.6 m and the box is not oversized against the meshes (floor tile, wall panel) | **One `BoxCollider`**. |
| Skinned renderer, or no mesh filter | One `BoxCollider` over the renderer bounds. |
| A mesh over 65,535 vertices | Box kept, reported in the repair log as too dense. |

The decision is pure logic in `NavColliderRules.Choose` (`NavProbe/Logic`), the Unity side is `TownColliderPlan` and `TownColliderPlanExtensions.PlanCollider` / `AddColliders`. Notes that matter:

- **Why not a box everywhere.** The old rule was fast and wrong: the box covered the whole bounds, so a cave, a stair, a bridge or an arch became a solid block that swallowed the doorway and the arrival point. `RockCave` (57 x 55 x 39 m) in a 30 to 48 m room cut the room in two; the mine beside the meadow (`tahrok-mine-gate`, `Interior_tahrok-crown-mine`) reached 0%.
- **Why still a box for thin pieces.** A box on a floor tile or wall panel is exact and cheap, and a mesh collider on a flat plane is worse for stepping.
- **Existing scenes.** The old boxes live in saved scenes. `cr_nav_repair` finds the boxes `EnsureCollider` added (a `BoxCollider` on a prefab instance whose prefab has no collider) and swaps them by the same rule. A rebuild of a town or interior regenerates with the new rule, so both routes end up equal.
- **Steps.** Mesh colliders follow the stair geometry; risers around 0.38 m fit the 0.4 m step limit, taller ones are `STEP_TOO_HIGH`.
- **Player-build caveat.** A `MeshCollider` can work in the Editor and have no collision in a Player. See [Mesh colliders in a Player build](#mesh-colliders-in-a-player-build) for the audit command and the CI rule.

## Camera trim: the CameraIgnore layer

With solid mesh colliders on every town piece, the camera arm was clamped by door and window frames, wall decoration, gutters, chimneys and small props, so it pulled into the player's head on a street (the probe's pinch clusters). The fix is a layer, not a collider change:

- **Layer `CameraIgnore`** is user layer 8 (`ProjectSettings/TagManager.asset`). `TownCameraTrimExtensions.EnsureCameraIgnoreLayer` adds it to the first free user slot if a project lacks it.
- **Why a layer.** The overworld rig's `AvoidObstacles.CollisionFilter` is **Default only**, so a collider on `CameraIgnore` no longer clamps the arm. The layer collision matrix is all on, so the **player capsule still collides** with it: the trim is still solid to walk into.
- **Why only trim.** The Malbers animal controller's **ground check also reads Default only**. Anything the player can stand on or climb must stay on Default or the character falls through or cannot step. So shell pieces (walls, bases, towers, gates, roofs, whole buildings) and walkable pieces (stairs, steps, floors, balconies, bridges, ramps, piers, docks, platforms, decks) are never moved.
- **The rule** is `NavCameraTrimRules.IsCameraTrim(name, sizeX, sizeY, sizeZ)` (`NavProbe/Logic`, engine-free, tested in `NavCameraTrimRulesTests`). The name is stripped of the pack prefixes (`ucx_`, `sm_`, `p_`, `mod_`). A name containing a **never-trim** word (`stair`, `step`, `floor`, `balcony`, `bridge`, `ramp`, `pier`, `dock`, `platform`, `deck`, `ground`, `terrain`, `tower`, `gate`, `base`, `body`, `arena`, `cliff`, `rock`) or starting with `wall` (except `walldeco` / `walltrim`) is never trim. Otherwise it is trim when it starts with `walldeco`, `walltrim`, `window`, `door`, `gutter`, `chimney`, `lantern`, `sign`, `awning`, `banner`, `flag`, `candle`, `cloth`, `rope`, `net_`, `shutter`, `beam_`, `roof_ridge` and a few more, or is a `prop_` at most 3.5 m, or is compact whatever it is called (at most 1.6 m wide and 2.2 m tall).
- **Applied by** `TownCameraTrimExtensions.ApplyCameraTrim(root)`, called from the town build (`TownBuildTool`, after `EnsureCollider`) and the corridor dressing step (landmarks). It touches only plain geometry: tag `Untagged`, no behaviours, rigidbody or character controller, no trigger. Its size comes from the collider's own shape and the transform scale (`DesignSize`), so a swapped-out (inactive) plot measures the same as an active one. `CountCameraTrim` is the dry count.
- **Existing scenes.** `cr_nav_repair` applies it to the saved town and landmark containers (see the command table), so a repair pass and a rebuild end up equal.
- **The probe models it.** `NavProbeSettings.CameraMask` (1 = Default) restricts the pinch sphere-casts to the layers the rig sees, so a trimmed scene reports fewer pinch clusters. If the rig's `CollisionFilter` ever changes, change `CameraMask` with it.

## Mesh colliders in a Player build

Unity 6000.4 logs, when it builds a scene: `This Mesh Collider is attached to GameObject ... but doesn't have Read/Write enabled. Only colliders that have default cooking options, are not scaled non-uniformly, and their meshes are not marked dirty can leave this disabled.` A mesh collider whose mesh is not Read/Write is **cooked while building** only when its cooking options are the default and its scale is uniform. Every other one has **nothing to cook from at runtime: no collision in the Player**, although it works in the Editor. The mesh-accurate colliders from `EnsureCollider` made this a real risk (town walls are stretched along one axis, so their scale is non-uniform).

`cr_collider_mesh_audit --args "scene=all [out=<dir>] [fix=true] [dry=true]"` (code: `Assets/CR/Core/Data/Editor/Build/ColliderMeshAudit/`, rule in `NavMeshColliderRules`). It scans every `MeshCollider` in the chosen scenes (additively, closed unsaved), judges each as:

| Verdict | Meaning |
|---|---|
| Readable | The mesh is Read/Write in the Player (its model importer, or the list below, says so). |
| PreBaked | Not readable, but default cooking options and a uniform scale: Unity cooks it while building. |
| Broken | Not readable and non-default cooking or non-uniform scale: no collision in a Player. |

It writes `<out>/collider_meshes.json` (default `Temp/cr_collider_mesh_audit`): totals, one entry per distinct mesh (`readable`, `colliders`, `brokenColliders`, `scenes`) and the broken colliders by scene and path with the reason. Poll `cr_collider_mesh_audit_status`. `fix=true` adds the model file of every mesh with a broken collider to the committed list and re-imports it (`dry=true` only reports what it would add). A mesh embedded in a scene, or one that is not from a model file, is listed for hand work.

**The list and the postprocessor.** `Assets/CR/Core/Data/Editor/Build/ColliderMeshAudit/readable-collider-models.json` (`models`: sorted, unique, 16 model files at last count, the Fantastic City Pack walls, roofs and collision proxies among them). `ColliderMeshReadablePostprocessor` forces `isReadable` on those models whenever they import. The vendor pack folders are git-ignored and restored from the Asset Store, so a setting kept in their `.meta` files would vanish on a fresh clone or a CI restore; the committed list does not.

**Tests.** `MeshColliderPlayerBuildTests` (EditMode): no mesh collider in any scene is Broken; every listed model imports readable; the list file is sorted and duplicate-free. After adding town or interior pieces run the audit with `fix=true`, commit the list, and run the tests.

**CI rule.** A Player build log must **not contain** `doesn't have Read/Write enabled`. The Unity log is `Logs/ci-unity-*.log` from `ci/build.sh`; grep it after the build and fail on a hit. At the time of writing `ci/build.sh` only greps a summary out of the log and does not fail on this text yet, so check the log by hand on a release build until the step exists.

**`bakeCollisionMeshes` stays 0** (`ProjectSettings`, "Prebake Collision Meshes"). Turning it on would cook every mesh collider into the Player up front, which would make the readable list unnecessary, but it costs build time and size, and it is the lever to try if collider cooking hitches while streaming cells on the Steam Deck. It is a perf option, not part of the safety rule.

## Town walls on slopes (TownWallGround)

A wall piece used to be seated on the terrain height at its pivot, so on a slope the low end hovered and the player (and the nav probe) found a gap under Mirandale's west wall. `TownWallGround.SamplePoints` (`Game/OpenWorld/Logic/Towns`, engine-free, `TownWallGroundTests`) takes **5 evenly spaced points along the piece, end to end, centred on the pivot** (along the prefab's Z or X axis, after the row's yaw), and `TownBuildTool` seats the wall on the **lowest** ground of the five (`WallGroundY`): the high end is buried, the low end never hovers. Plots, gates and other pieces are unchanged (one sample at their footprint).

**Status: pending.** The rule is in the code, but no town has been rebuilt with it yet; the Mirandale rebuild (`cr_town_build mirandale`, host cells `World_c1_r2` and `World_c1_r3`) is the step that applies it. Until then the saved Mirandale walls still stand at the old heights. After the rebuild, re-probe `scene=cells` and check the west wall.

## Dungeon rules

Dungeons are specs, see [Dungeon Scaffold](?page=unity/47-dungeon-scaffold). The navigability rules added to that flow:

### Clearance rule (`cr_dungeon_check`)

`DungeonClearanceChecks` (`Game/OpenWorld/Logic/Dungeons`, engine-free) with `DungeonPrefabFootprints` (Editor, measures prefabs) reports an **error** when a prop's footprint comes within **2.5 m** of the arrival point, the exit door (south wall) or any pickup, npc or readable.

- The footprint is the prefab's renderer bounds (so an off-centre pivot counts) with root position, rotation and scale replaced by the spec's x/z/yaw/scale, exactly as the interior build places it.
- Exceptions: dressing no bigger than **1.5 m** in both horizontal axes (crates, barrels, torches) may stand beside a pickup, npc or readable but not within **0.6 m**, and never near the arrival point or the door. A prop whose underside hangs **2 m or more** above the floor (a lintel, a banner) walls nothing in.
- Typical offenders: `Column`, `Piller`, `Statue` (18 m tall, 4 to 10 m footprints: use `scale` 0.4 to 0.5), `RockCave` (57 x 39 m: do not use it as a room prop), `Bridge`, `Chain_*` (23 m long), `Steps` at the arrival point, tents (use scale 0.7).
- The rule is geometry only: it does not prove the room is connected. That is the probe's job.

### Reach rule (nav probe, after every build)

After `cr_dungeon_build` (or the manual chain) run `cr_nav_probe --args "scene=Interior_<key> out=<dir> ignore=<collider names of the props the events disable>"`. Required: **reach >= 65%**, **0 unreachable targets** (judged in the `whatIf` pass when barriers are event-controlled), **no pinch clusters**. The gate quest's own giver must be in the region the player arrives in.

### Seed before interior build

The scaffold writes story rows to `Data/Corridor/Continent/regions/<n>.json`, but `cr_interior_build` reads them from the **compiled** `Continent.asset`. So the order is:

```
cr_dungeon_scaffold --args <key>
cr_world_seed_corridor --args "layout=Continent,section=story"
cr_interior_build --args <key>
```

`cr_dungeon_build` now does the seed step itself (scaffold, seed story, town build, interior build, interior check, world validate, dungeon check). Run the seed by hand whenever you run the steps one at a time, or the scene is built from the previous rows. Seeding compiles every region file (about 984 overlay rows), so it is not instant.

### Event rows stay at y = 0 (PivotLift)

An event row's `localPosition.y` must be **0**. `InteriorBuildTool.BuildStory` places each row at `local.y + yOffset + StoryRowPlacer.PivotLift(row)`, and `PivotLift` is half the box height for a volume row (`size.y / 2`), so the box already sits on the floor. The scaffold used to write `y = room.height / 2` as well: the lift was applied twice, the box floated half a room height up, the player on the floor never entered it, and the probe reported the event as `NO_GROUND`. Gates never opened and quest pickups behind them stayed sealed. `DungeonStoryRows` now writes `Vector3.zero`; existing dungeons are fixed by a scaffold, a story seed and an interior **rebuild** (the saved scenes still carry the old boxes until rebuilt). A test (`DungeonStoryRowsEventPlacementTests`) pins it.

## Overworld rows on reachable ground

Overworld content rows (pickups, zones, readables, NPCs, locations, barks in `regions/<n>.json` `story`, and generated `WildZone_*` rows in `wildZones.json`) are authored at x/z with y derived from the terrain by the builder. Nothing used to check that the spot is reachable, so rows landed on cliffs and on islands.

**The rule: a row's x/z must be on ground the probe reaches, on dry land (ground below y -0.5 is never offered: the ocean plane at y -1 has no collider, so seabed is "reachable" but under water; hand-placed rows aim for y 0.5 or more), at least 2.5 m from the next row of its group.** Town-plot rows belong to the town layout and are never moved automatically.

### `cr_nav_snap_rows`

`cr_nav_snap_rows --args "probe=<cr_nav_probe out dir> [cells=c1_r1+c0_r1|all] [maxMove=20] [towns=<m>] [dry=true|false]"` (code: `Assets/CR/Game/OpenWorld/Editor/NavSnap/`).

- Reads the unreachable cell targets from a probe run (so run `cr_nav_probe scene=cells out=<dir>` first), finds the overlay row each one belongs to, and rewrites **x and z only** to the probe's nearest reachable spot (or an alternate that keeps the row in its region and group). A wild zone must stay in its own region; a pinned wild zone is left alone by a reseed.
- Never moves a row more than `maxMove` metres (default 20); those, rows in a town pad, rows whose scene object no longer matches the row (stale probe) and files that do not round-trip through the JSON writer go to the `manual` list. `towns=<m>` lets plot rows move that far.
- **Dry by default.** `dry=false` writes. Idempotent.
- Writes the ledger `Assets/CR/Game/OpenWorld/Data/Corridor/Continent/nav-snap-ledger.json`: `moved[]` (`id`, `file`, `kind`, `scene`, `oldX`, `oldZ`, `newX`, `newZ`, `reason`; `oldX/oldZ` stay the first position across runs) and `manual[]` (replaced each run). First pass: 65 rows moved, 17 manual.

### After a snap

1. `cr_world_seed_corridor --args "layout=Continent,section=story"` and `section=wildZones`.
2. Rebuild only the affected cells' story content.
3. `cr_dress_cells --args "c1_r1+c0_r2"` (the NPC dressing pass for just those cells; a story rebuild strips the NPC bodies, see [Open World](?page=unity/37-open-world)). The full `cr_dress_cell_npcs` opens every scene that names an NPC and outruns the CLI. Check per-scene NPC body counts against the base.
4. `cr_world_validate` with 0 errors, the world content lint, then re-probe `scene=cells` and confirm the unreachable list is down to the ledger's `manual` entries.
5. Moved pickups and zones are content: push with Studio (Push All) as usual. Nothing is pushed by the tools.

Hand fixes for the `manual` list are small and specific (plot rows 2 to 4 m to the street side, a door against a cliff landmark, a buried gate pad, terrain pads under a row instead of moving it 30 m). Prefer a small terrain pad (12 m radius or less, smooth blend, `afterSolve`, see [Terrain repair pads](#terrain-repair-pads-aftersolve)) on a row's spot over a long move when the row belongs to a quest area, and record every move and pad in the ledger.

### Terrain repair pads (`afterSolve`)

Sometimes the row is right and the ground is wrong: a quest area on a 380 m2 plateau walled in by 50 degree slopes, a zone on a ridge pocket. A small terrain **pad** (`pads` in a region overlay, `HeightPad`) flattens a clearing and blends it into the slope. A normal pad is a **fixed node of the harmonic solve**, so adding one nudges the solve everywhere and every cell rewrites itself. For a world that is already built, mark the pad `"afterSolve": true`:

- `HeightPad.afterSolve` (Editor data) maps to `HeightPatch.ConstrainsSolve = false` (`ToLogic` passes `!afterSolve`).
- `CorridorHeightComposer` then **does not rasterise the pad as a constraint** (its report line reads `pad <id>: after the solve (not a fixed node)`), and lays it over the solved surface in the pad passes only (the same steps as any pad: before the path benches when `underPaths`, otherwise after them). Nothing outside the pad's shape + blend (+ the noise mask) changes, so only the cells the pad touches rewrite.
- Use it for **repair pads on a built world**; leave it off for pads that are part of the original terrain design.

Six pads are laid this way, recorded in the `pads` array of `nav-snap-ledger.json` (`id`, `file`, `centerX`, `centerZ`, `radius`, `y`, `blend`, `cells`, `serves` = the rows it serves, `reason` = the probe code):

| Pad | File | Centre (x, z) | r | y | Blend | Fixes |
|---|---|---|---|---|---|---|
| `gate_plaza_pad` | `regions/12.json` | 272, 488 | 8 | 21.8 | 20 | plateau under the stone head: joins it to the Drowned Gate pocket (TOO_STEEP / ISLAND) |
| `boulder_ring_pad` | `regions/12.json` | 498, 494 | 8 | 17.5 | 25 | boulder ring on a shore slope: ties it to the 12c plateau |
| `northwest_clearing_pad` | `regions/12.json` | 18, 470 | 8 | 21.0 | 20 | zone in a 28 m2 jungle-ridge pocket |
| `tonic_clearing_pad` | `regions/12.json` | 68, 520 | 8 | 18.9 | 20 | pickup 3 m inside the cell edge on a slope |
| `ranger_camp_pad` | `regions/12.json` | 386, 516 | 10 | 14.0 | 25 | creek-floor pocket widened to a camp clearing |
| `roam_high_ledge_pad` | `regions/13.json` | 284, 266 | 10 | 20.5 | 20 | zone hung on the mountain wall: a ledge at the Marshal camp height |

To add one: append the pad to the region's `pads` with `afterSolve: true`, add a ledger entry (with the rows it `serves`), rebuild the terrain **height** step for the affected cells (the `cells` field lists them, rim cells included), then `cr_world_validate` and re-probe `scene=cells`. Keep it small (12 m radius or less, smooth blend) and give it a y that matches the ground it joins.

## Checklists

**After changing a dungeon spec:** `cr_dungeon_check <key>`, `cr_dungeon_build <key>`, then the probe with `ignore=` for the barriers, then read reach, unreachable, pinch.

**After adding overworld rows:** seed, rebuild the cell, `cr_dress_cells`, probe the cell, `cr_nav_snap_rows dry=true` to see what it would move.

**After changing `EnsureCollider`, the camera trim rule or a kit:** `cr_nav_repair scene=all dry=true`, then apply, then `cr_nav_probe scene=all` and compare `summary.md` with the previous run. Then `cr_collider_mesh_audit scene=all fix=true`, commit `readable-collider-models.json` if it changed, and run `MeshColliderPlayerBuildTests`.

**Before a Player build:** the mesh collider audit is clean, and the build log has no `doesn't have Read/Write enabled`.

## Troubleshooting

- **Interior at 0% reach.** Open the scene's JSON: the `whatIf.ignored` list names the collider that swallows the arrival point, and `audit.oversizedBoxes` the prefab that got a whole-bounds box. Run `cr_nav_repair` on the scene.
- **Event never fires, gate never opens.** `NO_GROUND` on the event box means the old y bug: scaffold, seed the story section, rebuild the interior.
- **Camera pulls into the player's head on a street.** Look at the pinch cluster's colliders: if they are door or window frames, decoration or props, run `cr_nav_repair` on the scene (camera trim). If they are walls or stairs, they are meant to stop the camera.
- **Player falls through a piece, or cannot step on it, after the trim.** It was moved to `CameraIgnore` but the player stands on it: the Malbers ground check reads Default only. Put its name on the never-trim list in `NavCameraTrimRules` and set the object's layer back to Default.
- **Collision works in the Editor, missing in a build.** Run `cr_collider_mesh_audit scene=all fix=true` and see [Mesh colliders in a Player build](#mesh-colliders-in-a-player-build).
- **Probe says unreachable but the spot looks fine.** Check the reason: `TOO_STEEP` and `ISLAND` are about the surrounding ground, not the spot itself; the nearest reachable ground is in the JSON.
- **Snap lists a row as manual with "probe is stale".** The scene object no longer stands where the row says; re-probe.
