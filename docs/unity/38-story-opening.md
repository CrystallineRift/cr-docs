# Opening Story (Unity)

Client systems for the opening story: a one-time Earth prologue, the arrival at the Meadow wagon, an escorted walk to
the farm, lore readables, world barks, a scripted capture lesson and place flavour. All of it is **presentation**:
the client sends only existing intents (start dialogue, accept quest, enter trigger, battle actions); quest progress,
rewards and captures are decided by the server (online) or the local domain services (offline). Presentation flags
are never sent to the server. Code lives under `Assets/CR/Game/Story/` (`CR.Game.Story`; pure rules in
`CR.Game.Story.Logic`, tested in `CR.Game.Story.Logic.Tests`).

## IStoryFlags

`IStoryFlags { Has(key); Set(key) }`, impl `GameDataStoryFlags`. Flags are per current trainer
(`IGameSessionService.CurrentTrainerId`), stored in `IGameDataRepository` under `story_flags_<trainerId>` as a JSON
list. Keys: `readable.seen.<dialogueKey>`, `world.placed`, `prologue.done`, `event.<eventKey>`. They only gate
presentation (show once, skip intro); they grant nothing.

## LoreReadable

`MonoBehaviour` with `dialogueContentKey` and `displayName`. Shows the usual interaction indicator; on Interact it calls
`IDialogueService.StartAsync(key, new DialogueNpcContext(key, displayName))` and sets `readable.seen.<key>`.
Raises `Read` (and static `AnyRead`). `ReadablePromptRule.Decide(hasDialogue, dialogueActive, inBattle, inTechDemo)`
decides whether the prompt shows.

## WorldBark

`IBarkService.Say(anchor, text, seconds)`, impl `WorldBarkService`: a world-space bubble (USS class `world-bark`).
`BarkRule.Allowed(...)` suppresses barks during dialogue, battle and the tech demo.

## NpcEscort and EscortPlan

`NpcEscort` walks an NPC along `waypoints` (0 wagon, 1 switchback, 2 lesson spot, 3 meadow edge, 4 farm gate) at `speed`,
pausing when the player is farther than `waitDistance`. `BeginFrom(i)` / `PlaceAt(i)`, event `WaypointReached`, `IsWalking`.
`EscortPlan.From(EscortQuestView)` maps quest state (welcome, first battle, first capture, runaway) to an
`EscortPhase` (`AtWagon`, `Escorting`, `AtFarm`) and a start waypoint, so a reloaded save puts the escort where the
quest state says it should be.

## OneShotWorldEvent

Plays once per trainer (`event.<eventKey>` flag): optional dialogue (awaits its end), VFX prefab at `vfxAt`, then
`enableOnPlay` / `disableOnPlay` toggles, then sets the flag. `triggerOnEnter` fires from a trigger volume.
`OneShotRule.ShouldPlay(alreadyPlayed, blocked)`. Used for the pillar shattering and Ahksun rising.

## PrologueController and the gate

The prologue is its own scene (`Prologue_Earth`): letter, photo, guitar, then Ahksun wakes. `PrologueController` raises
`Completed` and offers `Skip()`; the stone interaction unlocks after `readable.seen.prologue-letter`.
`PrologueGateRule.Decide(hasEverBeenPlaced, startSpawnPlan)` is true only for a never-placed trainer on the start
spawn. `OpenWorldBootstrap`, before placing the player, suspends streaming, loads the prologue additively alone,
awaits `Completed`, unloads, resumes streaming and continues placement. `world.placed` is set after the first
successful placement.

## Place flavour

`RegionProfile.flavourText` with `RegionProfileSet.FlavourFor(key, mask)` (key, then parent, then null) and
`AreaBannerEvents.RaiseArrived(banner, flavour)`. `LocationFlavourSet` (`Resources/Story/LocationFlavour.asset`)
holds `LocationFlavourEntry { locationContentKey, title, flavourText }` and `FlavourFor(locationKey)`; the journal
shows them in a Places section.

## Capture-lesson hints

`BattleEvents.RaiseNotice(text)` / `Notice` feed a BattleHUD line. `CaptureLessonHints` subscribes to HP and
capture-failed events and only acts when the battle's spawner key is `story-capture-lesson`. Texts come from `StoryText`.

## StoryText

`[LocCatalogue] static class StoryText` (`Assets/CR/Game/Story/Text/StoryText.cs`): `LocString`s for barks
(`ui.story.bark.*`), battle hints (`ui.story.hint.*`) and UI such as Skip (`ui.story.ui.*`) that are not dialogue graphs. They go
through the normal localization export. Dialogue graphs, quest text and flavour are content assets.

## Script review page

Editor CLI `cr_story_script_page` (`StoryScriptPageGenerator`) writes `CR/docs/2026-10-08-opening-script.html`
(or the path in `--args`): a single self-contained page with every dialogue's nodes in walk order (speaker, text,
choice options, node id, asset path), plus StoryText, quest, region flavour and place flavour rows, each with a
"where to edit" column. The walk/format logic is `ScriptPageBuilder` (pure, `CR.Game.Story.Logic`) over plain DTOs.
Dialogue keys are listed in `StoryScriptPageGenerator.DialogueKeys`; a missing asset is flagged NOT FOUND.
Regenerate after editing text.
