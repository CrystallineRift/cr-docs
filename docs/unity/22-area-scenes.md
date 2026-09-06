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
**`unity run --command cr_build_area_template`**, or headlessly via
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

So the command measures rather than asks you to trust it: each run reports the footprint of the
first instance of every prefab it places, e.g. `AN_Broadleaf_3_Green 13.4x16.0x13.5m`. A number that
looks wrong is visible in the console before anyone opens the scene.

### The five areas

| Area | Kind | Ground | Light and weather | Wild pool | Levels |
|---|---|---|---|---|---|
| Meadow | `meadow` | `M_Terrain_01` | bright sky, distance haze, falling leaves | `meadow-wild-zone` | 2–6 |
| Shore | `shore` | `M_SmallRocks_Sand` | flat bright light, pale sea haze, god rays | `shore-wild-zone` | 5–10 |
| Cave | `cave` | `Ground` | no skybox, close exponential fog | `cave-wild-zone` | 9–15 |
| Crags | `crags` | `M_Terrain_02` | cold thin light, close weather, snowfall | `crags-wild-zone` | 14–21 |
| Dunes | `dunes` | `M_SmallRocks_Sand` | hard amber glare, far heat haze, god rays | `dunes-wild-zone` | 20–28 |

The level bands are a **ladder, and they overlap at every seam** so there is never a level with
nowhere to go. They used to be identical — every area spawned 2–10 — which capped battle income near
95 experience while the next level kept costing more, so a level cost 29 battles at level 20 and 65
at level 30. See cr-api M10013; the authored `SpawnerDefinition` assets must match it or online and
offline play at different difficulties.

:::caution
Meadow is the hub and doors straight into all four habitats, so nothing currently stops a level-3
player walking into the Dunes at 20–28. Gating that is an open decision.
:::

Meadow is the hub: every habitat doors back to it, so any area is two transitions from any other and
no route dead-ends.

Sun colour separates these places at a glance more than the props do — the same rocks under a white
noon sun and under a low amber one read as two different deserts. Fog distance is the cheapest way to
sell scale: the dunes push it out so the ground appears to run on, the crags pull it in so the rim
feels closed by weather.

Each area also gets one **ambient weather effect** parked above the playable space (`AN_SnowFall`,
`AN_GodRays`, `AN_LeafFall_Green`), scaled wide. Lighting and props establish where somewhere is;
moving particles are what stop it reading as a diorama. At prefab scale these cover about a metre and
look like a dropped item, hence the scale multiplier.

:::caution
`cr_build_playtest_areas` rebuilds an area from the template, **discarding whatever is in the
scene** — including a dressing pass. Always pass `--keys` to limit it. Same for `cr_dress_areas`,
which takes `--keys` to dress a subset.
:::

Gateway art follows the area, not the default: anything dressed from AZURE gets cliff pillars, and
the moss-topped `_Cov` cliff variants are used only where something would actually grow on the stone
— a meadow or a waterline, never a dune field or bare cold rock.

### Hearthmere Village, the first settlement

A sixth scene, and the only one that is not a habitat. It has **no wild pool and no encounter
zones**: a town the player cannot cross without being ambushed is not a refuge, and somewhere to
stand still is the whole point of it. It doors to and from the Meadow on the one compass bearing the
four habitat doors left free.

| Area | Kind | Ground | Light | Wild pool |
|---|---|---|---|---|
| Village | `settlement` | `M_Terrain_01` | the Meadow's `meadow` palette | *(none)* |

It shares the Meadow's ground material and lighting palette deliberately. Hearthmere is the Meadow's
town, one door apart, and a settlement standing on different earth under a different sun from the
region around it reads as a separate world — the opposite of what a hub is for.

**It is laid out, not dressed.** `CrAreaDressingCommand` scatters: seeded random inside an annulus,
which is right for a meadow and wrong for a town. People do not distribute their houses by Poisson
disc; they face them onto a square and leave a road. So the Village is absent from that command's
`Areas` table on purpose, and `cr_layout_village` authors every position instead — eight houses
turned to face a square, the well at its middle, four market stalls, and a road north to the door.

Authored in code rather than dragged in the GUI, for the same reason every other area is tool-built:
a layout that lives only in a scene file is unreviewable and unrepeatable, and the diff after
somebody nudges a house is 400 lines of YAML. Re-running rebuilds `[Village]` from scratch, so it
cannot drift from the table that claims to describe it.

The road out is **enforced, not hoped for**. `BlocksTheRoad` rejects any piece that would land in the
lane between the spawn point and the Meadow door, and names it. That is the one placement mistake
here that would read as a broken area rather than as ugly dressing, and it is invisible in a table of
coordinates.

:::note
The Village is in `PolishTargets` but not in `Areas` — so `cr_polish_areas` repairs it (world bounds,
NPC keys, character models) while `cr_dress_areas` leaves it alone. `PolishTargets` is derived from
`AreaNpcRoster`, so a settlement cannot be added to the roster and forgotten here.
:::

### Encounter zones are ground cover, not spheres

A wild battle starts when the player walks into a `CR_EncounterZone` trigger. The prefab used to
draw a plain green sphere there, which told the player nothing: you either memorised where the
spheres were or you got jumped. Its `MeshRenderer` is now disabled — collider and trigger untouched
— and dressing fills the trigger with ground cover instead, so the rule is visible. Long grass is
where creatures are.

This is the one place dressing deliberately scatters **inside** a gameplay object rather than
keeping clear of it, because the trigger is the thing being illustrated. The radius comes from the
zone's own `SphereCollider`, so resizing a zone gets matching cover on the next run, and the fill is
seeded separately (`seed + 977`) so adding it does not reshuffle the trees.

Cover is per style, and the cave gets its own set — rock debris and mushrooms rather than grass,
since a lawn underground reads as a bug.

Roaming creatures are gone with it. `CR_CreatureSpawner` instantiates a creature prefab at `Start`
and leaves it standing in the world, which reads as a wild creature the player can walk up to but
never fight. It is no longer placed in the areas; the prefab stays in the project as a dev tool for
looking at a creature in a scene.

### Meadow art sets

The `style` option picks which set dresses the Meadow; the Cave set is fixed. Switching style
rebuilds the same `[Dressing]` root, so styles replace each other rather than stacking.

| `style` | Pack | Character |
|---|---|---|
| `polyart` (default) | Polyart | Stylised, low-poly |
| `fantastic` | Tidal Flask Ancient Forest | Chunkier and stylised; one art family with the Village/Seaside/City kits |
| `azure` | Raygeas AZURE Nature | Realistic, authored at real-world scale |

AZURE's scales sit near `1.0` where the stylised sets are shrunk to `0.55`–`0.8`: its prefabs are
already in metres, so a multiplier that reads as "slightly smaller" on a stylised tree turns an
AZURE broadleaf into a shrub. Its default `AN_Broadleaf_*` prefabs are autumn orange — the plan uses
the `_Green` variants, since the Meadow is a summer scene.

When the Editor has to be closed, dress in batch mode instead of through the CLI command:

```bash
"/Applications/Unity/Hub/Editor/<version>/Unity.app/Contents/MacOS/Unity" \
  -batchmode -nographics -quit -projectPath . \
  -executeMethod CR.Game.Areas.EditorTools.CrAreaDressingCommand.DressFromBatch \
  -style azure -logFile dress.log
```

`cr_dress_areas` talks to a running Editor, so it is unavailable exactly when batch work happens;
`DressFromBatch` reads the same `-style` and `-seed` options off the process command line.

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

## Footstep tracks outlive the ground they land on

`MalbersAnimations.StepsManager` lives in **Core**, which persists across transitions, but each
footprint it leaves is parented to the surface it landed on — a mesh in the **area** scene. Walking
through a door unloads the area and destroys the footprint, while the coroutine started in
`EnterStep` keeps polling `newtrack.isPlaying` on the corpse:

```
NullReferenceException
  at UnityEngine.ParticleSystem.get_isPlaying ()
  at MalbersAnimations.StepsManager+<>c__DisplayClass28_0.<EnterStep>b__0 ()
  at UnityEngine.WaitWhile.get_keepWaiting ()
```

One exception per frame, per footprint left in the area you just left. A single Steam Deck session
logged 27 of them, and it never showed up in the Editor because the Editor rarely walks door to
door for minutes at a time.

Patched in the vendor file with a `//CustomPatch:` marker, guarded as
`() => newtrack != null && newtrack.isPlaying`. `!= null` is the only form that works: Unity's
overloaded operator is what sees a destroyed object, and `?.` / `??` bypass it entirely — see
[the fake-null note](#). **Reimporting Malbers wipes this patch**, alongside the `Fall.cs` one.

## The arrival banner

On arrival `AreaLoader` raises `AreaBannerEvents.Arrived` with a line like
`Sunlit Meadow  (Lv. 2-6)`, built by `AreaBannerText` from the area's display name and the level
range read off the authored `SpawnerDefinition` in the scene. A settlement, which has no spawner,
gets its name alone. It never throws — a caption failing to draw must not fail a transition the
player has already walked through.

### It must not fire at boot

`AreaLoader` receives the `PreGame` context at boot and loads the starting area immediately, as a
**backdrop** behind the main menu. That load is not an arrival: no trainer has been chosen, and
announcing it greeted the player with the name of a place they had not been to yet, over the menu,
before they picked a character.

`AreaArrivalRule.ShouldAnnounce` gates it on a trainer session existing — the thing that becomes
true exactly when the player enters the world. The backdrop area is announced later, by the
deferred initialization path, when they actually walk into it.

### Sizing is computed, not authored

The banner sits in a band **20% down the screen**, **15% of screen height** tall, and every
measurement inside it — font size, padding, the rule's width and thickness — is derived from that
band by `AreaBannerLayout`. Both fractions live there and are applied from the presenter, so the
stylesheet carries no numbers to drift out of step.

This is not stylistic. The USS is scaled by the panel, which is configured to match screen **width**
against a 1200px reference, so px authored in the stylesheet get multiplied by 2× or more on a wide
monitor and stop bearing any relation to the screen they sit on — the banner grew into a slab across
the top. Driving it from height gives the same slice of the view on every display.

`VisualTreeAsset.Instantiate()` returns a **TemplateContainer wrapping** the UXML's root element,
so the element carrying `.area-banner-root` is a child of what `Instantiate()` hands back. Styling
and measuring the wrapper instead is what cut the banner in half against the top of the screen: the
wrapper's height is `auto`, effectively zero, so the band's percentage height resolved to nothing
and the card centred on y=0 with half of it above the frame. The presenter now stretches the
wrapper to the panel and queries `banner-root` for everything else.

Two more traps the tests pin down:

- The card must **fit inside its band** at every screen height, so the ratios are asserted rather
  than eyeballed.
- `GeometryChangedEvent` **bubbles**, so the card resizing lands in the band's own handler. Sizing
  from `evt.newRect` there measures the card and feeds its padding back into itself — a layout
  loop. The handler ignores any event whose target is not the band.

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

## Polish pass: bounds, zone fog, visit trigger, NPC models

`cr_polish_areas` handles three things the scatter pass does not, because they are repair of
gameplay-facing objects rather than decoration — re-scattering the trees to fix a wall would be a bad
trade. It is idempotent; running it twice leaves the same scene.

### The area reports that you have been here

Each area carries a `[VisitTrigger]` — a box trigger spanning the whole playable space, sitting on
the spawn point, keyed to the area key lowercased. Walking in reports a location visit, which
advances `VisitLocation` quest objectives and drives location achievements.

`LocationTriggerBehaviour` had existed for some time, complete and injected, and was placed in
**zero** scenes. Written and never wired reads identically to working, right up until content
depends on it — which the shipped quest chain now does.

Sized to the area rather than to a landmark on purpose: the objective is "reached this place", not
"found this spot", so *go to the Shore* should complete on arriving at the Shore.

### You cannot walk off the edge

Four invisible `BoxCollider` slabs at the ground's edge, sized from the ground renderer's own bounds
so a resized area is still enclosed. 20 m tall and sunk 2 m: short walls get vaulted, and flush ones
let a character clip under on a slope. Rebuilt from scratch each run rather than adjusted in place,
which is how four colliders across five scenes drift out of step with a resized ground.

Verified by raycast at ankle, hip, head and above-head height at every area's edge — 4/4 in all five.

### The encounter zone has the biome's colour in it

A low, wide, faint disc of the area's `Signature` colour inside the trigger. The bush gives the zone
a silhouette; this gives it a colour matching the element the area is lit in, so "fights happen here"
and "this place is Fire" become the same visual idea. Kept faint and flat deliberately — it marks
ground, and a player should never lose the bush inside its own marker.

### The NPCs are people

The quest giver and merchant were primitive cylinders. Replacing them needed a character, and the
project did not have one: the Malbers Steve rig's only body texture is named `SteveNaked`, and its
five material variants are skin tones in underwear.

So the character is **assembled** from the BoZo modular pack — a base body plus `Top`, `Bottom`,
`Feet` and hair pieces. The rebinding is the part that matters: a modular outfit prefab carries its
own copy of the skeleton, so parenting it is not enough. Each piece's `bones` array is remapped by
name onto the base's bones and its `rootBone` repointed, which is what makes the parts move as one
character instead of standing rigid while the body walks away.

Two rules the swap follows:

- **The NPC GameObject is never replaced.** It carries the interaction trigger and the CR behaviours
  that make it a quest giver rather than a shape. Only the visual child changes.
- **The old visual is matched by what it is, not what it is called.** `InstantiatePrefab` keeps the
  prefab's name, so a name-based check finds nothing on the next run and quietly stacks a second
  character inside the first.

### Every area has both

The quest giver used to live only in Meadow and the merchant only in Cave. That split was
deliberate once: Meadow is open at boot and Cave only ever arrives through a transition, so having
content in each proved `AreaWorldInitializer` initializes a scene loaded after `GameInitializer`
has already run. That case is still covered by Cave. What the split also produced was three areas
with nobody in them and no way to shop without walking back.

Every area has a merchant and a quest giver, placed from two directions:

- `CrPlaytestAreasBuilder.Plans` carries both in every area plan, so a rebuilt area has them.
- `EnsureAreaNpcs`, part of `cr_polish_areas`, adds whichever is missing to an area that already
  exists. Rebuilding an area re-creates it from the template and **discards its dressing**, so the
  repair path is the only way to give a finished area an NPC without throwing the art away.

Since Hearthmere exists, "every area has both" is about the **pair**, not the scene. Area 1's
merchant and quest giver stand in the Village, not out in the Meadow — see
[Where a pair actually stands](#where-a-pair-actually-stands) below.

Two details the repair pass depends on:

- **Position comes from the ground's own bounds**, not from the world origin. Areas are laid out
  around wherever the player was standing when they were built, so a fixed coordinate would drop an
  NPC into the void in four areas out of five.
- **Presence is matched by name**, which is what the model swap above also keys off. An NPC placed
  under any other name would never be given a character and would stand there as a cylinder.
  `InstantiatePrefab` keeping the prefab's name is what makes the check work across runs.

### Each area's NPCs are their own

The prefabs ship with **empty** content keys. `cr_polish_areas` stamps them per area
(`StampAreaNpcKeys`, re-run every time so an area built before this still gets fixed):

| Area | Merchant | Quest giver | Merchant stock | Standing in |
|---|---|---|---|---|
| Meadow (1) | `demo-merchant-area-1` | `demo-questgiver-area-1` | `demo-merchant-area-1-items` | **Village** |
| … | … | … | … | its own area |
| Dunes (5) | `demo-merchant-area-5` | `demo-questgiver-area-5` | `demo-merchant-area-5-items` | its own area |

The mapping lives in one place, `AreaNpcKeys` (`Assets/CR/Game/Areas/Logic/`), used by the
builder, the content audit and — by convention — the seed migrations. It used to be the other way
round: the prefab carried `demo-merchant`, so all five areas resolved to **one** NPC row and one
inventory. The keys are numbered rather than biome-named because this database is carried into
the real game; `demo-` marks the playtest set.

Each NPC has a matching `NpcDefinition` SO (registered on the `ContentDefinitionProvider`, with a
display key in `localization/npcs.yaml`) so Content Studio syncs it to the server like any other
content. Quest accepts are idempotent, so five quest givers still grant a quest once.

### Where a pair actually stands

A town makes two facts come apart that used to be the same one: *the Meadow has a merchant* (it does
— area 1's) and *the merchant stands in `Meadow.unity`* (it no longer does). `AreaNpcRoster`
(`Assets/CR/Game/Areas/Logic/`) owns the difference.

`HostedAreaNumber(sceneKey)` answers "whose NPCs stand in this scene":

| Scene | Hosts | Why |
|---|---|---|
| `Village` | area 1 | the settlement claims the Meadow's pair |
| `Meadow` | *nobody* | **because** the Village claims area 1 |
| `Cave` … `Dunes` | their own number | no settlement serves them yet |

It is stated as a delegation rather than left as an absence on purpose. An empty roster for the
Meadow reads identically whether the pair moved to the Village or somebody deleted them by accident;
this way the Meadow answers 0 *because* the Village claims 1.

A settlement **hosts an existing area's NPCs rather than minting its own**. Area numbers are seeded
server-side by migration, so a Village with its own key would be a merchant the world knows about
and the database does not — which is why standing up a town needed no backend change at all.

Two repairs follow from this, and the pass runs both directions:

- `EnsureAreaNpcs` stops regrowing a pair the roster says belongs elsewhere. Without it the next
  polish run would put a second merchant back in the Meadow, carrying the same content key as the
  town merchant — two bodies, one inventory, which is exactly the bug numbered keys were introduced
  to kill, arriving from the other side.
- `RemoveDelegatedNpcs` clears out the originals still standing in a field from before the town
  existed. Deliberately narrow: only the two prefabs the command itself places, only from an area the
  roster says hosts nobody, and every removal logged. An editor tool that silently deletes authored
  work is worse than the drift it repairs.

`StampAreaNpcKeys` reads the roster too, not the area key — a settlement is not itself a numbered
area, but the pair standing in it must carry the area's keys.

## Each biome is lit as an element

Every area now reads as one element at a glance, before any creature appears. The mapping is
terrain-intuitive rather than derived from the spawn pools — the pools are deliberately mixed (the
Cave rolls six elements, one creature each), so there is no dominant element to read off them:

| Area | Element | Reads as |
|---|---|---|
| Meadow | Flora | Sap-green light and haze, pollen drifting up |
| Cave | Ground | Ochre and umber, no sky, dust falling |
| Shore | Water | Cyan-teal haze, cool sun, sea spray |
| Crags | Ice | Blue-white, fog pulled in close, snowfall |
| Dunes | Fire | Amber glare, fog run far out, embers rising |

### One palette, not three switch blocks

`ElementalPalette` holds each biome's sun, ambient, fog, motes and signature colour in a single row.
These values used to live in three separate `switch` blocks — ground material in one, fog and ambient
in another, sun in a third — so "what does the Cave look like?" could not be answered without reading
all three, and changing a biome meant editing it in three places and hoping they still agreed.

That drift was real, not hypothetical: portal colours lived in a *fourth* table, and the Cave portal
was still purple after the Cave itself became Ground ochre — the doorway taught one element and the
place behind it another. `PortalColour` now reads the destination's `Signature` from the same table.

**A door is coloured by where it leads, not where it stands.** The glow is a label for the
destination, readable from across the area — which is why the Cave's exit is Flora-green.

### The motes are authored, not sourced

AZURE ships three ambient prefabs — god rays, leaf fall, snow — and everything else on disk is a
combat impact effect. Pollen, cave dust, sea spray and embers do not exist in any imported pack, so
`BuildElementalMotes` builds them: a `ParticleSystem` per element, with drift direction carrying the
meaning (pollen and embers rise, cave dust falls from the ceiling).

Two details that would otherwise go wrong:

- **Particle modules are structs returned by value.** Editing a local copy silently does nothing; the
  assignment back through the property is what applies it.
- **The Cave has no weather prefab** — there is no sky to have weather in — so the mote build must not
  sit behind the weather early-return, or the biome that most needs its element in the air is exactly
  the one that skips it.

Crags gets no motes: it is Ice and already snowing, and a second particle system there would be
noise rather than identity.

## The bush is where the battle is

Wild encounters fire from one place and one place only: the `SphereCollider` trigger on
`CR_EncounterZone` (radius 5 m). Nothing else in the world starts a battle, so the whole design
problem is making that invisible circle legible — the zone's own `MeshRenderer` is disabled, and a
trigger you cannot see is a trigger you get ambushed by.

Ground cover alone did not solve it. Grass reads as scenery in a meadow because grass is everywhere,
and in the cave and the dunes there is no grass to read at all. So `cr_dress_areas` now builds each
zone in two layers:

1. **Ground cover** across the full trigger disc — dense, biome-appropriate, the existing behaviour.
2. **A bush core**: one raised clump inside 55% of the radius, with a silhouette you can see from
   across the area and aim at.

The 55% matters. Placed wider, the player could brush the leaves without crossing into the trigger,
which teaches the opposite of the rule the clump exists to state.

| Area | Core |
|---|---|
| Meadow | `AN_Bush_1/2/3` — flowering shrubs |
| Cave | `AN_Mushrooms` over `Rokcs_Group01` — a thicket that isn't a lawn indoors |
| Shore | `AN_Reedmace` + `AN_Reeds` — the one thing on an open beach tall enough to hide in |
| Crags | `AN_Dead_Bush` over `AN_Stones_1` — cold stone grows scrub |
| Dunes | `AN_Dead_Bush` + `AN_Branch_2` — drier, sparser scrub |

### Only LOD0 collides

`cr_fix_lod_colliders` (**CR > Areas > Fix LOD Colliders**) removes collision from every LOD level
except the nearest, in all six area scenes.

LOD1 and beyond are *render* stand-ins — cheaper meshes that stop being drawn as the camera pulls
back — and they are routinely a crude envelope of the silhouette rather than the shape itself.
Collision is never swapped by distance, so a collider on one is live at all times regardless of
which level is on screen.

That is how the Meadow became unwalkable in patches. Its birches carry a **0.79m capsule on LOD0**
(the trunk, correct) and a **mesh collider on each of LOD1/2/3 built from the canopy — 8.4m to
10.1m across, reaching the ground**. The player was stopped nine metres from a tree by nothing they
could see. The command removed 21 such colliders, **all of them in the Meadow**; the other five
areas returned zero, which is why only the Meadow was ever reported.

The rule keys off the object's role in its `LODGroup`, not its name — see `LodColliderPolicy`.
Names only happen to encode the level in this one art pack, and the next pack will disagree.

Re-running reports zero. It is worth re-running after re-dressing an area or updating an art pack,
because the colliders come from the packs' own prefabs and come back with them.

### Props, not terrain, are what you snag on

"The character controller gets stuck in the Meadow" reads as a terrain problem. It is not: every
area's ground is a single flat `MeshCollider`, 100m x 100m, with a height of **exactly zero**.
There is no terrain to rebuild. The snags are the props standing on it, and there are two kinds —
see `PropColliderPolicy`, applied by `cr_fix_prop_colliders` (**CR > Areas > Fix Prop Colliders**).

**Concave mesh colliders.** A `MeshCollider` that is not convex is raw triangle soup, and a capsule
slid along one catches on the seams between triangles. A convex hull of the same rock has no
interior seams. Only applied to props under 3.5m: hulling a cliff seals whatever gap runs through
it, which turns a snag into a wall.

**Shin-height obstacles.** The Meadow's fallen logs top out at 0.50m — too tall to walk over, too
short to read as something to walk around, so the player slides along one never seeing what stopped
them. Those lose their collider; stepping over a fallen log is what a player expects.

:::danger Two ways this command destroyed floors before the tests existed
Both are worth knowing because both look like sound logic:

- **A floor is flat, so a height-only rule calls it shin-height.** The first run deleted the battle
  arena's own 70x70 `Ground` plane out of all six areas. Height cannot separate a thing you step
  OVER from a thing you stand ON — footprint can, so anything wider than 6m is never removed.
- **`bounds` on an INACTIVE collider is a zero-size box at the origin**, not its real extents. The
  arenas sit inactive until a battle starts, so their floors measured as zero-width, zero-height
  obstacles — which is why only some areas lost theirs and the bug looked random. Inactive and
  disabled colliders are now skipped outright; they cannot snag anyone anyway.

A third trap sits next to them: a repair that reverted every removed-collider override put back the
LOD canopy blobs and made all the foliage solid again. **A scene's collider state is the
intersection of four policies** — this one, `LodColliderPolicy`, `TrunkColliderPolicy` and
`WalkThroughProps` — so a repair that knows about only one of them is a regression in the others.
Re-run all of them after re-dressing an area.
:::

### A trunk capsule that stops too high shoves you into the floor

The third Meadow snag is not a collider that should not be there — it is one shaped wrong at the
one height the player can reach. See `TrunkColliderPolicy`, applied by `cr_fix_trunk_colliders`
(**CR > Areas > Fix Trunk Colliders**).

A capsule's end cap is only a vertical wall down to its **equator** — the widest ring of the
hemisphere. Below that the surface curves in toward the pole and its normal tilts to point partly
*downward*. The Meadow's `Tree_Large_01..04` (~26 instances, and they appear in no other area)
carry a 2.0m-radius, 7.6m-tall capsule whose bottom equator sat **0.56m above the ground**. The
player's own capsule bottoms out at 0.495m above their feet — inside that tilted sliver. Running
into it produced a contact normal with a downward component while the player was already resting on
the floor, so forward speed turned into a shove into the ground. Measured directly with a raycast
into the live scene: `normal.y = -0.18` at ankle height, `0.00` from about 0.3m up.

This is why it read as a **Steam Deck** problem and felt fine on a Mac. A bigger per-step
displacement drives the contact deeper before the solver corrects it, so the same geometry that is
invisible at a high framerate is unplayable at a low, variable one.

The fix extends the capsule **downward only** — the top and the radius end up exactly where they
started, so nothing about how wide or tall the trunk reads to the player changes; the curved part
just ends up buried. Nothing keys off a prefab name: the same geometric check runs over every trunk
capsule in every area and is a no-op wherever the equator is already deep enough. The Meadow's
birches prove that discrimination works — their equator measures ~0.18m, they read a flat normal at
ankle height already, and the command left all of them alone. 26 fixed in the Meadow, **zero in the
other five areas**. Re-running reports zero.

:::note "Rebuild the terrain" is never the fix here
Every area's ground is the same stock 100x100 plane, unmodified. Three separate Meadow bugs have now
presented as "the character controller gets stuck in the terrain" and all three were props: LOD
canopy colliders, shin-height logs, and now trunk capsules. Measure the colliders before touching
the ground.
:::

### Colliders are stripped, deliberately

`MakeWalkThrough` destroys every `Collider` on encounter-zone dressing. This is the difference
between a bush you run into and a bush you bounce off: several of these prefabs ship with capsule or
mesh colliders because they are authored as scenery to walk *around*, and leaving them on would
build a wall standing exactly where the trigger is — the encounter could never fire. Destroyed
rather than disabled, so a later prefab-override sweep cannot switch them back on.

The dressing group is named `Encounter_<zone>` rather than `Grass_<zone>`; it is a lawn in one of
the five biomes.

## Per-area battle arenas

Every area instances `CR_BattleArena`, and for a long time every one of them kept the prefab's
default `arenaKey` of `starter-wild-zone`. That is harmless while one area is loaded and ambiguous
during a transition, when two scenes are briefly loaded together and `BattleArenaRegistry` has to
pick between two arenas claiming the same key. Each area now owns its key and its biome:

| Area | `arenaKey` | `BiomeType` | Ground |
|---|---|---|---|
| Meadow | `meadow-arena` | Grassland | 70 m, `M_Terrain_01` |
| Cave | `cave-arena` | Cave | 70 m, dungeon `Ground` |
| Shore | `shore-arena` | Beach | 70 m, `M_SmallRocks_Sand` |
| Crags | `crags-arena` | Mountain | 70 m, `M_Terrain_02` |
| Dunes | `dunes-arena` | Desert | 70 m, `M_SmallRocks_Sand` |

`cr_dress_arenas` (**CR → Areas → Dress Battle Arenas**) sets all of that, dresses the arena to its
biome, and repoints every battle-starter in the scene — `SpawnerEncounterBehaviour`,
`SpawnerWorldBehaviour`, `NpcInteractionBehaviour` — at the new key. It is idempotent: the dressing
is rebuilt from scratch each run, so re-running never stacks a second forest on the first.

### The camera owns the middle

The arena is laid out along X: trainers at ±9, creatures at ±4.5, and the authored establishing vCam
orbits the centre at **radius 9** with ring heights 0.1–5; the close shots sit about 3 m off a
creature. Dressing therefore has a no-build zone:

```
radius < 14      nothing at all — camera orbit, trainers, creatures, and margin
radius 15–21     low dressing: grass, stones, bushes, reeds
radius 21–28     occluders: trees, cliffs, cave walls
radius 31        the backdrop
```

**Clearance is measured from geometry, not from pivots.** That distinction is the whole game: a
dungeon boulder whose mesh is fifteen metres across, placed with its pivot at twenty-one, reaches to
six — and the first cave render was taken from *inside* one while the tool cheerfully reported a
"closest prop" of 15.0 m. `TryClearFootprint` measures each instance's world bounds, pushes it
outward until its geometry clears, and drops it entirely if it cannot fit before `MaxPropRadius`.
The report says `nearest geometry`, and that number is the honest one.

### Ending the view takes two things

Occluders are placed on **staggered rings** rather than scattered: evenly spaced by angle, each ring
phase-offset so one ring's props sit over the next ring's gaps, jittered a third of a step so the
result still reads as terrain. Uniform random placement leaves gaps — that is what a uniform
distribution *does* — and every early render showed daylight between the cliffs.

Rings alone still could not be trusted, so a **backdrop** stands behind them at radius 31: a tube of
inward-facing quads, 16 m tall, unlit and tinted to that biome's distance. The props supply the
silhouette; the backdrop supplies the certainty. It sits far outside the camera orbit, so it can
never come between the camera and the fight.

Two traps if you edit it. The tube is viewed from inside, and back-face culling keys off **triangle
winding**, not the normals — an inward-facing surface can be authored correctly and still render as
nothing, which is what happened first. The material sets `_Cull Off` so winding cannot matter. And
material settings are re-applied on every run rather than only at creation, or an asset from an
earlier run keeps whatever it was first given and later tweaks silently do nothing.

### Checking it

`cr_render_arenas` renders each arena from the camera's own orbit — radius 9, height 3, three
bearings, framed on `OrbitCenter` — and writes PNGs. Numbers cannot answer either question that
matters here (does the dressing end the view, can the camera still see the fight), and every real
defect in this feature was found in an image rather than in a log. Particle systems do not render in
edit mode, so ambient FX are absent from the shots, and the AZURE foliage shader renders its leaves
red in batch mode — neither reflects how the scene looks in the Editor.

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

## Resuming where you stood

An area transition used to be the only thing that decided where the player stands; a fresh
session always began at the current area's default spawn point. Trainers now carry a **last
saved location** — `trainers.last_area_key` / `last_pos_x/y/z` / `last_yaw` (cr-api
`M4013AddLastLocationToTrainer`) — and the world resumes there.

### Saving

Two writers, one repository method (`ITrainerRepository.UpdateLastLocationAsync`, routed
online/offline like every other trainer call — the online path also mirrors into the cache DB):

- **`TrainerLocationTracker`** (bound `FromNewComponentOnNewGameObject` + `NonLazy`, never
  scene-placed) watches the player transform and saves on the `TrainerLocationSaveRule`
  throttle: at most once per 10 s, and only after ≥ 0.5 m of movement — standing still never
  writes. Forced saves ignore the throttle: the moment a trainer is switched *away from*
  (the tracker caches the outgoing identity, because by the time `OnTrainerChanged` fires the
  session already answers with the new trainer), and `OnApplicationPause`/`Quit`.
- **`AreaLoader`** saves immediately after a successful transition, so a crash right after
  walking through a door still resumes on the correct side of it.

The write deliberately lives outside the profile-update SQL — a movement-cadence save and an
appearance edit can never clobber each other.

### Resuming

`TrainerResumeRule.Decide(savedAreaKey, hasSavedPosition, currentAreaKey)` (pure, EditMode-tested
in `TrainerResumeTests`) picks one of three plans when the overworld initializes:

| Plan | When | What happens |
|------|------|--------------|
| `DefaultSpawn` | nothing usable saved | default spawn point, exactly as before |
| `TeleportInPlace` | saved spot is in the loaded area | `IMovementController.Teleport` to the spot |
| `TransitionToSavedArea` | saved spot is elsewhere | `GoToAreaAsync` there; a `_pendingArrival` override makes `PlacePlayer` land on the exact saved spot instead of the area's spawn point. If that transition fails, `_pendingArrival` is cleared rather than left armed, so the player falls through to the area's default spawn point instead of a stale arrival override surfacing on some later, unrelated transition |

All placement goes through the movement controller — writing the transform directly makes
Malbers drag the player back within ~100 ms.

### Trainer switches re-initialize the world

Switching trainers mid-session fires `IGameSessionService.OnTrainerChanged`. `GameInitializer`
already re-runs the persistent scene's `IWorldInitializable`s, but area scenes initialize
through their own `AreaWorldInitializer`, whose `HasInitialized` latch survived the switch —
every NPC and spawner in the loaded area kept the *previous* trainer's identity (stale quest
givers, wrong team ensures, merchants that would not load). `AreaLoader` now subscribes to the
same event and, when a new trainer arrives, clears its own `_worldInitialized` flag and calls
`AreaWorldInitializer.ResetForNewSession()` on the loaded area, so entering the overworld
re-initializes everything for the new session — and then resumes at *that* trainer's saved
location via the rules above.

## Related

- [World Behaviours](03-world-behaviours.md) — `IWorldInitializable` and the boot sequence.
- [Battle System](07-battle-system.md) — the arena and `ScreenFader` the transition reuses.

## First area in a player build

The Editor almost always has an area scene open in the hierarchy, and `AreaLoader.Awake()` adopts
it as `CurrentAreaKey`. A player build has no such luxury: only Core (scene 0) loads, and until
2026-08-23 nothing loaded an area until the player walked through a door they could not reach —
the trainer spawned into an empty skybox.

`AreaLoader` now registers with `IUICoordinator` and, on the first `Overworld` context, asks
`InitialAreaRule.Decide(currentAreaKey, isTransitioning, initialAreaKey)` whether to load the
configured starting area (default `Meadow`, serialized on the component). The rule is engine-free
and tested: an adopted Editor area or an in-flight transition means "do nothing", so Editor
behaviour is unchanged. Registration happens in `Start()`, not `OnEnable()` — the component is
created by `FromNewComponentOnNewGameObject`, and `OnEnable` fires before Zenject injects.
