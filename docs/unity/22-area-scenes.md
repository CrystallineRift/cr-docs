# Area Scenes, Templates and Transitions

The game is split into a persistent **Core** scene and lightweight **area** scenes that load
additively. Core boots once and stays loaded; areas come and go as the player walks between them.

```
Assets/CR/Scenes/
  Core.unity                    ← always loaded, never duplicated
  Areas/_AreaTemplate.unity     ← duplicate this to make an area
  Areas/<YourArea>.unity
```

`Assets/CR/UI/Test UI.unity` remains the tech sandbox. It is untouched by this system and is not
part of the Core/area structure.

## What lives where

**Core** owns everything that must exist exactly once: the Zenject `SceneContext` and installers,
`GameInitializer` + `DatabaseMigrations`, session and data adopters, `InputManagement`, every
`UIDocument` screen, the battle camera rig, the main camera and light, and the player rig.

Some pieces you might expect in Core are **not** in the scene at all — `BattleCoordinator`,
`BattleStager`, `ScreenFader` and friends are created by `LocalDevGameInstaller` at runtime
(`BindInterfacesAndSelfTo` / `FromNewComponentOnNewGameObject`). Their absence from `Core.unity` is
correct, not a missing object.

**An area** owns only content: ground, spawn points, encounter zones, creature spawners, NPCs, a
battle arena, pickups, and doors.

### Two different "spawners"

These are easy to confuse and only one of them starts battles:

| Prefab | Components | What it does |
|---|---|---|
| `CR_EncounterZone` | `SpawnerWorldBehaviour` + `SpawnerEncounterBehaviour` | **Starts wild battles.** A trigger sphere (default radius 5); the player entering it schedules an encounter after a 2–5s delay, then calls `IBattleCoordinator.StartWildBattle`. |
| `CR_CreatureSpawner` | `CreatureSpawner` | Places a creature model in the world (`assetKey`, e.g. `creatures/cindris`). Decorative — it has no battle path at all. |

An area with only a `CR_CreatureSpawner` has creatures standing around that can never be fought.

`SpawnerWorldBehaviour._spawnerContentKey` must match a `SpawnerDefinition.contentKey` in the
content registry (the seeded one is `starter-wild-zone`), and `_battleArenaKey` must match a scene
`BattleArena.ArenaKey`.

## Making a new area

1. Duplicate `Assets/CR/Scenes/Areas/_AreaTemplate.unity`.
2. Set the `AreaDefinition`'s **areaKey to match the scene name** — the validator enforces this,
   because doors and `LoadSceneAsync` both address areas by that name.
3. Add the scene to **Build Settings**. `LoadSceneAsync` cannot find an unlisted scene, and it fails
   only at runtime.
4. Drop content prefabs from `Assets/CR/Prefabs/Areas/` into the `[Spawners]`, `[NPCs]`, `[Doors]`
   and `[Pickups]` groups.
5. Run **CR → Areas → Validate Open Area Scene**.

Rebuilding the whole structure from the sandbox is scripted, not manual:
**CR → Areas → Build Core Scene + Area Template**, or headlessly via
`unity run --command cr_build_area_template`. `cr_area_report` prints what the built scenes contain.

## Playing an area on its own

An area's `SceneContext` declares `ParentContractNames = ["CoreContext"]`, but declaring the
contract does not fill it. Zenject resolves parent contracts in `SceneParentAutomaticLoader` on
`PlayModeStateChange.ExitingEditMode` — **before any scene starts**, and therefore before any
`Awake`. Nothing placed in the area scene can supply Core in time.

What fills it is `Assets/Resources/ZenjectDefaultSceneContractConfig.asset`, mapping
`CoreContext` → `Core.unity`. Zenject opens Core additively and orders it ahead of the area itself.
Delete that asset and pressing Play on any area throws:

```
ZenjectException: Could not fill contract 'CoreContext' for scene 'Meadow'.
```

`CoreSceneAutoLoader` is a content fallback on top of that, not the mechanism — it runs in `Awake`,
far too late to satisfy a contract.

## Environment art

Areas are dressed from imported Asset Store packs by **CR → Areas → Dress Playtest Areas**
(`cr_dress_areas`). Everything it places goes under one `[Dressing]` root that is deleted and
rebuilt each run, so it never doubles up, and placement is seeded — a re-run reproduces the same
layout, so a scene diff means the plan changed, not the dice.

Dressing never touches gameplay objects. It reads them to build **keep-out circles** (spawn point,
doors, NPCs, encounter zone, pickups, arena) plus a cleared corridor from the spawn to each door, so
scatter cannot bury a spawn or wall off an exit.

Scale is set against **measured prefab bounds**, not guesses. Packs are wildly inconsistent:
`RockCave` is a 58×55×39 m cave shell, `Rokcs_01a` is a 1.6 m pebble, `Prefab_TreeLarge_01` is 22 m
tall. Treating them as interchangeable "rocks and trees" put the camera inside a rock and made the
player look ant-sized.

Supporting commands, all headless:

| Command | Purpose |
|---|---|
| `cr_asset_search` | Search the AssetInventory-indexed library; shows URP support and whether it is downloaded |
| `cr_asset_download` / `cr_asset_status` | Pull packages from the Asset Store (needs a signed-in Editor) |
| `cr_asset_import` | Import downloaded packages |
| `cr_material_survey` / `cr_material_to_urp` | Find built-in-pipeline materials and convert them to URP |

Two traps worth knowing:

- **Packs ship built-in-pipeline materials** that render magenta under URP, and nothing complains at
  import time. Some ship their own URP conversion as a *nested* `.unitypackage` (Dreamscape's
  "MeadowsURP Click me!") which must also be imported. Survey before assuming.
- **A pack's own demo scene is the reference** for how it is meant to look. Dreamscape's demo uses
  Unity's built-in Default-Skybox; the pack's `SkyboxLiteWarm_Custom` renders a hard red band here.

## Per-area lighting

Skybox, ambient and fog are per-scene, and Unity applies them from whichever scene is active — so
`AreaLoader` calling `SetActiveScene` is all they need.

Two things do **not** travel that way, and `AreaEnvironment` on the area root handles both:

- **The sun.** The directional light is a GameObject in Core, shared by every area, so a cave
  inherits the meadow's midday sun and reads as a bright field full of rocks regardless of its
  ambient settings.
- **The camera background.** With no skybox assigned, URP clears to the camera's background colour —
  also Core's — so an interior shows the overworld's blue sky beyond its walls.

`AreaEnvironment` tracks which area currently owns the override in a static field. Mid-transition
two areas are alive at once by design, and the departing area's `OnDisable` runs *after* the
arriving area's `OnEnable`; without that ownership check it would restore the meadow's sun over the
cave's override exactly as the fade lifts.

It is runtime-only, so **the Editor's edit-mode view will not show the override** — a cave looks
sunlit until you press Play. That is expected, not a broken scene.

## Connecting areas with doors

A door is a trigger volume with a target area key and a target **spawn point id**. Spawn points are
named (`AreaSpawnPoint.spawnPointId`), so a two-way connection puts the player at the correct end
rather than always at the area's entrance.

Put the meadow's `cave-door` on the boundary, targeting `cave` / `cave-mouth`; put the cave's
`meadow-door` targeting `meadow` / `meadow-gate`. Keep spawn points **outside** door volumes — the
validator flags a spawn point sitting inside a door, because the player would arrive standing in a
doorway they then cannot use without stepping away first.

## The transition

`AreaLoader.GoToAreaAsync(areaKey, spawnPointId)`:

```
guard → cover (fade) → LoadSceneAsync(Additive, allowSceneActivation = false)
      → await progress ≥ 0.9 → activate → SetActiveScene(new)
      → AreaWorldInitializer → place player → UnloadSceneAsync(old)
      → UnloadUnusedAssets → reveal (in a finally)
```

Details that are load-bearing rather than incidental:

- **Load before unload.** Unloading first leaves a frame with no ground and no lighting, and
  destroys objects the transition still reads. The fade covers the overlap.
- **`allowSceneActivation = false`** is what makes the load genuinely async. Unity clamps
  `AsyncOperation.progress` to 0.9 while activation is deferred, and activation is the part that
  hitches — so the whole load happens behind the fade.
- **`SetActiveScene`** immediately after activation, so lighting, skybox and anything instantiated
  mid-transition belong to the new area rather than the one being torn down.
- **The player is placed via `IMovementController.Teleport`**, never `transform.position`. Malbers
  derives movement from the delta against its own `LastPosition` and drags the character back within
  ~100ms otherwise.
- **The reveal runs in a `finally`**, with `ScreenFader.ClearImmediate()` as the safety valve, so a
  failed load can never strand the player behind an opaque overlay. A failed transition also unloads
  the half-loaded destination and restores the previous active scene.

## The battle camera across scenes

`BattleArena.cameraRig` is a direct object reference, and Core owns the one `BattleCameraRig`. An
arena in an area scene **cannot** hold that reference: Unity does not serialize cross-scene
references, and saving such an arena as a prefab silently nulls the field — which is exactly what
happened to `CR_BattleArena.prefab` (`cameraRig: {fileID: 0}`).

The symptom is not an error. `BattleCinematicDirector` logs
*"Arena '…' has no BattleCameraRig — camera stays on the overworld"* and the battle plays out with
the overworld camera, so battles in areas look flat while the sandbox looks correct.

`BattleCinematicDirector` therefore falls back to the single live `BattleCameraRig` when the arena
names none. An arena that *does* carry its own rig still wins, so a bespoke per-arena rig remains
possible. Area arenas sit at the same world position the sandbox arena used, so the rig's authored
placement frames them unchanged.

## Two things that would otherwise loop or break

**Doors ping-ponging.** A trigger reports an overlap every frame, and the player is placed near the
destination door on arrival. `AreaDoor` therefore starts *disarmed* and only arms once a physics
step passes with the player outside it. This deliberately lives on the door, not in the shared
guard: the guard only sees area keys, and an arrival spawn id in one area has no relationship to a
door's target spawn id in another.

**Scene-scoped world init.** `GameInitializer` runs the global `WorldRegistry` once at boot, and
clears entries on scene unload. Areas do **not** use that registry — `AreaWorldInitializer`
discovers the `IWorldInitializable` behaviours in its own scene and runs them per load. The registry
clear is scene-scoped (`WorldRegistry.UnregisterScene`) so unloading an area cannot take Core's
persistent registrants with it; a blanket clear there removed `TrainerWorldBehaviour`, which
`BattleStager` needs to place the player, and battles stopped staging after the first door.

Area behaviours still call `WorldRegistry.Register` in their own `Awake` — that is their code, not
the area system's. So `GameInitializer` skips any registrant whose scene carries an
`AreaWorldInitializer`, otherwise an area that happens to be **open at boot** is initialized twice
(once from the registry, once by its area initializer) and stacks whatever those `InitializeAsync`
calls create. Areas arriving through a door were never affected, which is what makes the duplicate
easy to miss.

## Validation

**CR → Areas → Validate Open Area Scene** checks: `AreaDefinition` present and its key matching the
scene name; spawn points present, with a resolvable default and no case-insensitive duplicates;
`AreaWorldInitializer` and `CoreSceneAutoLoader` present; the `SceneContext` parenting onto
`CoreContext`, **and `CoreContext` actually mapped in a `DefaultSceneContractConfig`**; a
`BattleArena` present; this area and Core both in Build Settings; every door's
target area listed in Build Settings with a non-empty spawn id; and no spawn point inside a door.

## Related

- [World Behaviours](03-world-behaviours.md) — `IWorldInitializable` and the boot sequence.
- [Battle System](07-battle-system.md) — the arena and `ScreenFader` the transition reuses.
