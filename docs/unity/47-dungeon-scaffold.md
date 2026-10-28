# Dungeon Scaffold

One spec file produces one **hosted room behind a 1-plot gatehouse**: the gate town, the interior, the story rows and the registry keys. The scaffold
allocates registry **keys**, not definitions; NPC, trainer, arena and quest definitions come from [Side Content Packets](?page=unity/46-side-content-packets).

Related: [Open World](?page=unity/37-open-world) (towns, interiors, story rows), [Content Pipeline](?page=unity/17-content-pipeline), [World Navigability](?page=unity/49-world-navigability) (clearance rule, nav probe, collider rule).

## Where things live

| Path (under `Assets/CR/`) | What |
|---|---|
| `Game/OpenWorld/Data/Dungeons/<key>.json` | Specs. `_<key>.json` is an example: addressable by key, never part of `all`. Worked example `_example-crypt.json`. The real `arena-crypt` files are hand-authored and not replaced. |
| `Game/OpenWorld/Logic/Dungeons/` | Engine-free: `DungeonSpec` (+ `DungeonGate`, `DungeonInterior`, `DungeonProp`, `DungeonNpc`, `DungeonReadable`, `DungeonPickup`, `DungeonGauntlet`, `DungeonEvent`), `DungeonSpecParser`, `DungeonSpecChecks`, `DungeonScaffoldPlanner`. |
| `Game/OpenWorld/Editor/Dungeons/` | `DungeonScaffold`, `DungeonRegionMerge`, `DungeonRegistryMerge`, `DungeonStoryRows`, `DungeonVerify`, `DungeonCommands`. |

## Spec

```
{ key, name, region (leaf, e.g. "20a"), townKey,
  gate:     { landmark | x,z, yaw, kit "city", role "gatehouse", pad 20 },
  interior: { width, depth, height, arenaKey, lighting{r,g,b,lightIntensity,lightRange,lightR,lightG,lightB},
              floorPrefab/wallPrefab/doorPrefab (optional),
              props:     [{ id, prefab, x, z, y, yaw, scale, startDisabled }],
              npcs:      [{ key, x, z, yaw, role host|healer|stage|boss|flavour, trainer, startDisabled }],
              readables: [{ key (dialogue), x, z, displayName }],
              pickups:   [{ id, itemKey, x, z }] },
  gauntlet: { host, stages [npc keys, fight order], healer, healBetween, arenaKey },
  events:   [{ id, kind "propSwap", when{quest, objectiveSortOrder, minCount}, enable[], disable[], bark, dialogue }],
  gimmick:  "one line (design note)" }
```

- `interior` x/z are room-local metres from the room centre; floor y = 0.
- `gate.landmark` is a landmark id in the region file (its x/z wins); otherwise `gate.x/z` are world metres. `gate.yaw` = the way the entrance faces.
- Roles: `host` = QuestGiver that runs the gauntlet; `healer` = Healer; `stage` / `boss` = Trainer (definition `trainer-<name>` unless `trainer` is set); `flavour` = plain Npc.
- Event toggles name prop ids, or `npc:<key>` for an NPC that starts disabled.

## Derived files

Never hand-edit afterwards; a hand edit shows as stale in `cr_dungeon_check`.

| Derived | Where | Owned by the spec how |
|---|---|---|
| Gatehouse town (1 plot, role from the kit, door to interior, location trigger `story-<key>`) | `Data/Towns/<townKey>.json` | Whole file. Refused if the file has other plots. |
| Interior (room, props, npcs, arenaKey, lighting, spawn + exit door on the south wall) | `Data/Interiors/<key>.json` | Whole file; the compiled slot (`volume`, `slotRow`) is kept. |
| Story rows: readables, pickups, events, gauntlet | `Data/Corridor/Continent/regions/<n>.json` `story` | Rows with id `<key>-...` and `interiorKey: <key>`, gauntlet `gauntlet-<key>`; replaced in place, others untouched. |
| Registry keys (npcs, healers, trainers, dialogues, events, arenas, gauntlets, locations, interiors, towns, items) | `Game/Story/Content/story-registry.json` | Appended to region `<n>` and the top-level lists; never removed. |

**Keys vs definitions.** The registry lists *keys* so other tools can resolve them. A key in the registry is not an NPC, trainer, arena or quest
*definition*: those are server content, authored (side packets) and pushed separately. The new location `story-<key>` earns discovery XP only once it
is an authored world location (`cr-world-locations` skill, `cr_world_locations_push`).

## Checks

`DungeonSpecChecks` (mirrors `InteriorFileChecks`):

- Room <= 56 x 56 m, height 2 to 26 m, arena room >= 8 x 8 m. One door (the scaffold places exactly one). Everything inside the room.
- Keys are slugs; prop ids unique; every prefab path exists on disk; an item lies once (quantity 1).
- Trainers need `interior.arenaKey`.
- Gauntlet host / stages / healer exist with the right roles.
- Events toggle known props / npcs; enable targets start disabled; disable targets start enabled; a disabled prop/npc is enabled by some event.
- **Clearance (`DungeonClearanceChecks`).** No prop footprint within 2.5 m of the arrival point, the exit door or any pickup, npc or readable (dressing <= 1.5 m may stand beside a target but not within 0.6 m of it; a prop hanging >= 2 m above the floor is exempt). Footprints are measured from the prefab renderer bounds by `DungeonPrefabFootprints` with the spec's x/z/yaw/scale. Details and typical offenders (`Column`, `Piller`, `Statue`, `RockCave`, `Bridge`, `Chain_*`, `Steps`, tents) in [World Navigability](?page=unity/49-world-navigability#dungeon-rules).

## Commands

`unity cmd` or `unity run --command`; each has a headless form.

| Command | Does |
|---|---|
| `cr_dungeon_check --args <key>\|all` | Checks the spec, that derived files are current, then the town, interior and story-row checks. Prints `ok` or `FAIL n`. |
| `cr_dungeon_scaffold --args <key>\|all[,dry]` | Writes the derived files. Idempotent (second run = `0 changes`). Refuses, writing nothing, on a failing spec, a missing region/landmark/registry region, or a town/interior that is somebody else's. |
| `cr_dungeon_build --args <key>` | Scaffold, then `cr_town_build`, `cr_interior_build`, `cr_interior_check`, `cr_world_validate`, then the dungeon check. Slow (validates the world). |

Headless: `-executeMethod CR.Game.OpenWorld.Editor.DungeonCommands.ScaffoldBatch|CheckBatch|BuildBatch -dungeonArgs "<key>"` (exit 1 on failure).

**Build chain.** scaffold (files + keys), **compile the story rows** (`cr_world_seed_corridor --args "layout=Continent,section=story"`), then town build, interior build, interior check, world validate, dungeon check. The interior build reads story rows from the compiled `Continent.asset`, not from `regions/<n>.json`, so `cr_dungeon_build` runs the seed itself; when you run the steps by hand, seed after the scaffold and before `cr_interior_build` or the room is built from the previous rows. Afterwards push content with Studio as usual and run the rebuild hygiene from [Open World](?page=unity/37-open-world) (`cr_dress_cell_npcs`, body-count check).

**Keep the room walkable.** After every build run `cr_nav_probe --args "scene=Interior_<key> out=<dir> ignore=<names of the props the events disable>"` and `cr_nav_probe_status`. It must report reach >= 65% of the floor, 0 unreachable targets (judged in the `whatIf` pass, which removes the event-controlled barriers) and no pinch clusters. See [World Navigability](?page=unity/49-world-navigability).

## Prop-swap convention (`kind: "propSwap"`)

A swap is a `OneShotWorldEvent` in the room (a story event row) with `requiredQuestObjective` and enable/disable toggles (`Game/Story/OneShotWorldEvent.cs`, `ObjectiveGateRule`, `OneShotRecheckRule`). **Presentation only; it never grants or reports progress.**

| Topic | Rule |
|---|---|
| Which objective | `when.objectiveSortOrder` is the **0-based position** of the objective in the quest's objectives ordered by `SortOrder` (ties keep listed order), not the SortOrder value. It becomes `requiredQuestObjective.objectiveIndex`. An index outside the quest's objectives is never pending (gate stays shut). |
| `minCount` | Does not exist at the gate (it means "objective pending"); the field accepts `0` or `1` only. |
| When it plays | Only while the quest is in progress and that objective is not completed. The scaffold also sets `playIfQuestCompleted: true` (and `waitForQuestActive`), so a player who finished the objective before entering still sees the swap once. |
| Re-evaluation | Asked when the player enters the event box, and again on every quest objective / quest-completed signal while inside (a busy dialogue/battle is waited out, up to 2 minutes). The box covers the whole room. Not evaluated on a quest change while outside; it plays on the next entry. |
| Persistence | On play the toggles run and the local story flag `event.<dungeon>-<id>` is set (per trainer). Every scene load (`Start`) and trainer switch re-applies the toggles' end state without replaying, so it stays done after the quest completes. A trainer who has not seen it gets the authored state back. |
| Event row height | An event row's `localPosition.y` is **0**. The interior build adds `StoryRowPlacer.PivotLift` (half the box height) itself; the scaffold once wrote `height / 2` as well, so the box floated half a room above the floor and the player never entered it (gates stayed shut, pickups stayed sealed). Dungeons built before the fix need a scaffold, the story seed and an interior rebuild. |
| Authoring rule | The prop that appears starts `startDisabled: true` and is in `enable`; the prop that goes away starts enabled and is in `disable`. Same x/z for a swap pair. The checks enforce both. |
