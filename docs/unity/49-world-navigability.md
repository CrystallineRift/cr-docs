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
| `cr_model_readwrite_report --args "out=<dir>"` | Read-only inventory of mesh Read/Write per model folder family (models, Read/Write on, MeshCollider / particle / skinned / scene use, what the policy would flip). Blocks the Editor for about two minutes. See [Model Read/Write policy](#model-readwrite-policy). |

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
- **Player-build caveat.** A `MeshCollider` can work in the Editor and have no collision in a Player. See [Mesh colliders in a Player build](#mesh-colliders-in-a-player-build) for the audit command and the build gate.

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

**The list and the postprocessor.** `Assets/CR/Core/Data/Editor/Build/ColliderMeshAudit/readable-collider-models.json` (`models`: sorted, unique, 22 model files at last count, the Fantastic City Pack walls, roofs and collision proxies and the Fantastic Village Pack collision beams and stairs among them). `ColliderMeshReadablePostprocessor` forces `isReadable` on those models whenever they import. The vendor pack folders are git-ignored and restored from the Asset Store, so a setting kept in their `.meta` files would vanish on a fresh clone or a CI restore; the committed list does not. The same postprocessor also applies the [Model Read/Write policy](#model-readwrite-policy), and the collider audit judges a mesh by that same decision, so `cr_collider_mesh_audit` is right even before the models have re-imported.

**Headless audit.** `-executeMethod CR.Core.Data.Editor.ColliderMeshAudit.ColliderMeshAuditRunner.AuditBatch -crOut <dir> [-crFix true]` scans every scene synchronously, writes `<dir>/collider_meshes.json` and, with `-crFix true`, adds the models of broken colliders to the list. Close the Editor on that project first.

**Tests.** `MeshColliderPlayerBuildTests` (EditMode): no mesh collider in any scene is Broken; every listed model imports readable; the list file is sorted and duplicate-free. After adding town or interior pieces run the audit with `fix=true`, commit the list, and run the tests.

**Build gate (enforced).** `ColliderMeshBuildGate` runs the collider audit (same scanner, same Read/Write decision as the importer) before every Player build (`IPreprocessBuildWithReport`, order -1800) and up front in `CiBuild` (exit code 5), so a content-only CI run is gated too. It scans the scenes in the build settings, every scene under `Assets/CR/Scenes`, and the prefabs that ship through Addressables groups (folder entries included) and `Resources` folders (prefab-own scale only; a scene that places a prefab at another scale is covered by the scene scan). A mesh collider on a mesh that is not Read/Write, with non-default cooking options or a non-uniform scale, throws `BuildFailedException` listing scene or prefab, object path, mesh, model file and reason. A scan error fails the build as well. Measured: 91 scenes, 95 prefabs and 5,939 mesh colliders in 9.5 s. The headless `AuditBatch` exits 1 while a broken collider remains (with `-crFix true` it exits 0 only if every broken model was added to the list). The pure message is `ColliderBuildGate` in `CR.Core.Data.Logic`.

**Not covered: prefabs that no scene, Addressables group or Resources folder reaches.** The audit cannot see them, so a pack prefab with colliders can enter the game later without the gate noticing until it is added to a group. Three such pack prefabs are known risks; add their models to the collider list (or run `AuditBatch -crFix true` once they are referenced) before shipping them: `NOT_Lonely/HQ_RetroFarmhouse` "Smart Module Constructor" `StairsMain.prefab` (173 mesh colliders) and `Roof.prefab` (10), and Fantastic Interior Pack `P_PROP_bowl_interior_02.prefab` (1). Do not ship them without that.

**Log rule (a cheap extra, not the gate).** `ci/build.sh` also runs `ci/check-build-log.sh` on the Unity log and fails the build when it contains `doesn't have Read/Write enabled`. The real Unity 6000.4 text is `This Mesh Collider is attached to GameObject at path '%s' with Mesh '%s' in Scene '%s' but doesn't have Read/Write enabled. Only colliders that have default cooking options, are not scaled non-uniformly, and their meshes are not marked dirty can leave this disabled.`; the string is in both the Editor binary and `UnityPlayer.dylib`. A positive control in a scratch project (macOS Mono player, non-readable meshes under non-uniform, skewed, negative-scale, convex, custom-cooking, runtime-assigned and enabled-later colliders; `bakeCollisionMeshes` on and off; the Player run with and without `-nographics`) never made Unity print the line, in the build log or the Player log, and every collider still answered a raycast. So the line has not been observed to fire at build time here, and the audit rule can flag colliders Unity would have cooked anyway (it is deliberately conservative). The check catches the line if Unity ever prints it during a build; it is tested with the real text (`ci/tests/build-log-rules-test.sh`: clean, hit, the real line, NUL bytes, empty, missing, no argument, thousands of hits, and that `ci/build.sh` calls it). The 0-hit result of the 0.0.0-rwcheck build is therefore weak evidence; the audit result is the evidence.

**`bakeCollisionMeshes` is 1** (`ProjectSettings`, "Prebake Collision Meshes"). Mesh colliders that Unity can cook while building (default cooking options, uniform scale) are cooked into the Player up front, so their meshes need not be Read/Write; that is what lets the [Model Read/Write policy](#model-readwrite-policy) turn Read/Write off. The readable list exists for the colliders that cannot be pre-baked.

**`bakeCollisionMeshes` is 1** (`ProjectSettings`, "Prebake Collision Meshes"). Mesh colliders that Unity can cook while building (default cooking options, uniform scale) are cooked into the Player up front, so their meshes need not be Read/Write; that is what lets the [Model Read/Write policy](#model-readwrite-policy) turn Read/Write off. The readable list exists for the colliders that cannot be pre-baked.

## Model Read/Write policy

A model whose mesh is Read/Write keeps a CPU copy of the mesh and cannot use the asynchronous upload path: it uploads on the main thread in the frame its cell activates, which hitches on the Steam Deck. Most of the project's models are in git-ignored Asset Store packs whose importers default to Read/Write on (5598 of 6824 at the time of writing). The policy turns it off where nothing needs it.

**Files** (all in `Assets/CR/Core/Data/Editor/Build/ColliderMeshAudit/` unless noted):

| File | Role |
|---|---|
| `model-readwrite-policy.json` | `off`: folder prefixes whose models import with Read/Write off. `keep`: folder prefixes never touched. Both sorted, unique, no trailing slash, every prefix an existing `Assets/...` folder (a test checks it). |
| `readable-collider-models.json` | Models that must stay Read/Write because a `MeshCollider` on them cannot be pre-baked. |
| `Assets/CR/Core/Data/Logic/ModelReadWritePolicy.cs` | The engine-free decision: (path, current flag, policy, collider list) gives ForceOn, ForceOff or Leave. |
| `ColliderMeshReadablePostprocessor.cs` | Applies the decision in `OnPreprocessModel`. `GetVersion()` is 2. |

**Decision rules**, in order. A model on the collider list is always Read/Write on. Otherwise the longest matching prefix decides; when the same folder is in both lists, `keep` wins. A model in neither list keeps what its `.meta` says. Paths compare case-insensitively with forward slashes, and a prefix matches whole folder names (`Assets/Pack` does not match `Assets/Pack2`). A `keep` folder inside an `off` folder protects its models; an `off` folder inside a `keep` folder applies.

**Where the flag is stored.** The postprocessor changes the importer for the import, and Unity then saves the changed flag into the model's `.meta` on that machine. The pack `.meta` files are untracked local files, so nothing tracked changes, and a fresh clone or an Asset Store restore (which brings back `isReadable: 1`) is flipped again on its first import. Never edit a pack `.meta` by hand for this.

**Current `off` prefixes:** Fantastic Ancient Forest, Fantastic City Pack, Fantastic Interior Pack, Fantastic Village Pack, LeartesStudios, Monsters Ultimate Pack 02 Cute Series (placeholder creatures), `NOT_Lonely/HQ_RetroFarmhouse`, `PurePoly/Mining_Pack`.

**Current `keep` prefixes and why.** BoZo_StylizedModularCharacters (`BoZoCharacterOptimizer` merges outfit meshes at runtime), Polyart (river, ocean, path and decal tools read and build meshes), Malbers Animations (mesh utilities), Plugins/Jungle (Grabbit reads mesh data and `isReadable`), Plugins/RootMotion, and the packs whose models are mesh-shaped particle emitters or mesh particles: Hovl Studio, Piloto Studio, VFX_Klaus, AdventureAssets. A mesh-shape particle emitter needs a readable mesh.

**Not flipped, and why.** Fantastic Lost Jungle, Remesh Games and Fantastic Seaside Town: already import with Read/Write off except the Seaside models on the collider list. Raygeas: 2 models, both on the collider list. LowlyPoly (2 readable), Feel (4), ThirdParty (1), Plugins/Jungle and RootMotion: too small to matter or not in a shipped scene. Add them when a measurement says so.

**Adding a family.** 1. Run `cr_model_readwrite_report --args "out=<dir>"` (or `-executeMethod CR.Core.Data.Editor.Build.CrModelReadWriteCommands.ReportBatch -crOut <dir>`) and read the family's row: models, Read/Write on, MeshCollider references, particle mesh, skinned, in scenes, shipped. It loads every model and takes about two minutes, and it does not write anything. 2. Search the pack's runtime scripts (not `Editor` folders) for mesh reads: `.vertices`, `.triangles`, `GetVertices`, `CombineMeshes`, `BakeMesh`, `isReadable`, `SetVertices`, `AcquireReadOnlyMeshData`, and for mesh-shaped particle systems. If any are found, add the folder to `keep` instead. 3. Add the prefix to `off`, keeping the list sorted. 4. Run `cr_collider_mesh_audit scene=all fix=true` (or the headless `AuditBatch` with `-crFix true`): models whose colliders cannot be pre-baked are added to the collider list and stay readable. 5. Commit both JSON files and run the EditMode tests (`ModelReadWriteImportTests`, `MeshColliderPlayerBuildTests`).

**Exempting a model.** Add the model file to `readable-collider-models.json` (sorted). It is then always Read/Write, whatever prefix covers it. To exempt a whole folder inside an `off` family, add it to `keep`.

**Cost: one re-import.** Changing the postprocessor version re-imports every model once on each machine that opens the project (the Editor of anyone who pulls, the build runner, a fresh clone). Measured on a warm project with the other editors idle-ish: about 6,950 model and prefab imports, 317 s in the asset pipeline refresh (329 s wall for the Unity run). Bump the version only when a rule changes in a way that must reach already-imported models; adding a prefix to a list does not re-import by itself, and the models under it keep their old flag until they re-import (touch them or bump the version).

**Editor tools are unaffected.** In the Editor, a mesh that is not Read/Write can still be read (`vertices`, `triangles`, `normals`, `GetIndices`, `CombineMeshes`, `AcquireReadOnlyMeshData`, building a `MeshCollider`); only a Player refuses it. The terrain proxy builder, corridor mesh combining, cell proxy baking, the nav probe and the portrait baker therefore work as before (`ModelReadWriteImportTests` asserts this against a non-readable mesh).

**Tests.** `ColliderMeshBuildGateTests` (a fixture collider with non-uniform scale on a non-readable mesh fails the gate; uniform passes; prefab-hierarchy scale; scan errors fail; the project passes) and `CR.Core.Data.Logic.Tests.ColliderBuildGateTests`. `ModelReadWriteImportTests` (EditMode): no `off` prefix is `Assets`, `Assets/CR` or inside it; a malformed edit of the policy file keeps throwing instead of serving the cached policy; the policy file is sorted and unique with existing prefixes and no prefix in both lists; every model under an `off` prefix imports non-readable unless it is on the collider list; every collider-list model imports readable; the project's own models (`Assets/CR`) and their meshes are non-readable; the Editor reads a non-readable mesh. The decision rules are in `CR.Core.Data.Logic.Tests` (`ModelReadWritePolicyTests`). The two importer tests take about two seconds together.

**Clean clone.** The packs are git-ignored, so on a clone without them `ModelReadWriteImportTests` that need pack folders (prefix existence, off-prefix imports, collider-list imports) are Ignored with a message naming the missing pack(s); a prefix that names no folder inside a pack that IS present is a typo and still fails, and with the packs present a wrong flag still fails.

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

**Before a Player build:** nothing to run by hand: `ColliderMeshBuildGate` fails the build (and CiBuild fails early, exit 5) when a mesh collider would have no collision. `ci/build.sh` also fails on Unity's own warning text if it ever appears in the log.

## Troubleshooting

- **Interior at 0% reach.** Open the scene's JSON: the `whatIf.ignored` list names the collider that swallows the arrival point, and `audit.oversizedBoxes` the prefab that got a whole-bounds box. Run `cr_nav_repair` on the scene.
- **Event never fires, gate never opens.** `NO_GROUND` on the event box means the old y bug: scaffold, seed the story section, rebuild the interior.
- **Camera pulls into the player's head on a street.** Look at the pinch cluster's colliders: if they are door or window frames, decoration or props, run `cr_nav_repair` on the scene (camera trim). If they are walls or stairs, they are meant to stop the camera.
- **Player falls through a piece, or cannot step on it, after the trim.** It was moved to `CameraIgnore` but the player stands on it: the Malbers ground check reads Default only. Put its name on the never-trim list in `NavCameraTrimRules` and set the object's layer back to Default.
- **Collision works in the Editor, missing in a build.** Run `cr_collider_mesh_audit scene=all fix=true` and see [Mesh colliders in a Player build](#mesh-colliders-in-a-player-build).
- **Probe says unreachable but the spot looks fine.** Check the reason: `TOO_STEEP` and `ISLAND` are about the surrounding ground, not the spot itself; the nearest reachable ground is in the JSON.
- **Snap lists a row as manual with "probe is stale".** The scene object no longer stands where the row says; re-probe.
