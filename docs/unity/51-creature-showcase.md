# Creature Showcase

A dev-only scene for watching creatures in Play mode: walking and the walk/idle blend, battle beats, and evolutions. It needs no server, no account, no Zenject container and no Addressables at runtime, and it is not in Build Settings, so it cannot ship.

## Opening it

- **CR > Creatures > Open Showcase Scene**, then press Play. The menu builds the scene first if the file is missing.
- **CR > Creatures > Build Showcase Scene** rebuilds `Assets/CR/Scenes/Debug/CreatureShowcase.unity` in place. Headless: `Unity -batchmode -quit -projectPath <project> -executeMethod CR.Game.Creatures.Editor.CreatureShowcaseSceneBuilder.BuildHeadless`, or the CLI command `cr_build_creature_showcase`. A rebuild rewrites the scene's internal object ids, so commit the scene only when the content changed.

## What is in the scene

A 60 m ground with a line every metre (a bolder one every 10 m, so foot sliding shows against the grid), a 1.8 m reference post, a key and a fill light, a camera, a chase marker, and one `CreatureShowcase` component. The ground, the post and the marker use materials saved under `Assets/CR/Scenes/Debug/CreatureShowcaseAssets/`.

Controls: left panel (IMGUI, mouse). Camera: right mouse button drags to orbit, the scroll wheel zooms; on a gamepad the right stick orbits and the triggers zoom. The camera follows the creature.

## The three modes

- **World** runs a real `WildCreatureBehaviour` fed the prefab by a private in-scene `IGameAssetLoader`. Buttons: Wander (1.2 m/s with pauses), Stand, Chase (a marker circles faster than the creature runs; default speed 4.5 m/s, the game's charge), Return (1.8 m/s). The controller blend (`Speed` parameter) is the game's.
- **Battle** instantiates the prefab as the battle stager does, finds its `CreatureBattlePresenter` and calls `Bind` with the reactions resolved from the definition's reaction profile (an empty set when it has none, as the stager does). One button per beat raises the matching `BattleEvents` for that creature. The line under the read-out names the event raised and the Animator state the beat should end in; the live state shows what actually played.
- **Evolution** plays the stage director's phases (`EvolutionStagePlan`) with the timings from `EvolutionPresentationConfig`, the same shrink/grow arithmetic (`EvolutionBlendScale` and `EvolutionStageScaling`, shared with `EvolutionStageDirector`; each model scales from its own root scale) and the element effect from the config. It previews the staging only; the arena, camera, fade and player teleport belong to the real stage. Pause, restart and a speed slider hold the blend.

The live read-out shows the Animator controller, the state (`A -> B` while blending), `Speed`, the clip or clips with weights and normalized time, the root scale and the measured height.

## How it is built

`CreatureShowcase` (`Assets/CR/Game/Creatures/Debug/`, namespace `CR.Game.Creatures.Debugging`) holds the behaviour in public methods so tests drive it without the GUI. Decisions that do not need Unity are in `CR.Game.Creatures.Logic` (`Assets/CR/Game/Creatures/Logic/`): the picker order (`ShowcaseCatalogue`), evolution lines and rule levels (`ShowcaseEvolution`) and the beat table with the candidate order the presenter tries (`ShowcaseBeats`). The scene builder is `Assets/CR/Game/Creatures/Editor/CreatureShowcaseSceneBuilder.cs`.

The picker lists the seven creatures with the real rigged models first (`ShowcaseCatalogue.FeaturedKeys`), then every `CreatureDefinition` alphabetically.

## Adding a creature

There is nothing to register. Author the `CreatureDefinition` (content key, `assetKey`, element, reaction profile, evolution rules) and the Addressables entry whose address equals `assetKey`, then run **Build Showcase Scene**. The builder reads the definitions and resolves each prefab through the Addressables groups at edit time, storing a direct reference. To put a new creature among the featured models at the top, add its content key to `ShowcaseCatalogue.FeaturedKeys`.

A creature whose prefab cannot be resolved is listed as "(no prefab)" and cannot be selected.

## Getting to the real evolution cutscene offline

**CR > Debug > Grant Levels To Lead Creature (offline)** (a submenu: +1 level, +3 levels, To level 8, To level 14, To level 20; and the CLI command `cr_dev_grant_levels` with an argument such as `3` or `to 14`) is an Editor-only, Play-mode-only shortcut. It asks the offline authority's `ICreatureProgressionService.ApplyExperienceAsync` — the same exact-amount experience operation the admin Grant XP route runs — for the experience of each level, then raises `EvolutionEvents.RaiseCandidates` so the real presenter runs. It refuses outside Play mode, in an online session, and when the offline trainer has no creature. Offline state is local to the device and never reaches the server.
