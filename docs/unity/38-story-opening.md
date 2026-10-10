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
`BarkRule.Allowed(...)` suppresses barks during dialogue, battle and the tech demo. `Say` returns `true` only when the
line was shown, so a caller that remembers "said once" never burns that memory on a suppressed line.

## NpcEscort and EscortPlan

`NpcEscort` walks an NPC along `waypoints` (0 wagon, 1 switchback, 2 lesson spot, 3 meadow edge, 4 farm gate) at `speed`,
pausing when the player is farther than `waitDistance`. `BeginFrom(i)` / `PlaceAt(i)`, event `WaypointReached`, `IsWalking`.
`EscortPlan.From(EscortQuestView)` maps quest state (welcome, first battle, first capture, runaway) to an
`EscortPhase` (`AtWagon`, `Escorting`, `AtFarm`) and a start waypoint, so a reloaded save puts the escort where the
quest state says it should be.

`EscortDirector` drives the escort from the quest authority's state and owns the bark table: lines on one waypoint
play one after another (`_barkSeconds` + `_barkGap` apart — the bubble above him holds one line), and the wait
grumble rotates through `_waitBarkKeys`. Its `Phase` also gives the open-world whiteout its safe point (below).

## OneShotWorldEvent

Plays once per trainer (`event.<eventKey>` flag): optional dialogue (awaits its end), VFX prefab at `vfxAt`, then
`enableOnPlay` / `disableOnPlay` toggles, then sets the flag. `triggerOnEnter` fires from a trigger volume.
`OneShotRule.ShouldPlay(alreadyPlayed, blocked)`. Used for the pillar shattering and Ahksun rising.

A restore (load, cell stream-in, trainer switch) shows the END state without replaying: after enabling an object it
calls every `IOneShotAftermath` under it — `CrystalRise` jumps to its final pose, `LightFlash` stays dark. A trainer
switch during the dialogue never starts the prelude; a switch during the prelude puts the new trainer's view back;
a cell unloaded mid-prelude ends the beat unplayed. `PillarCharge` drops its tint whenever it is switched off.

## PrologueController and the gate

The prologue is its own scene (`Prologue_Earth`): letter, photo, guitar, then Ahksun wakes. `PrologueController` raises
`Completed` and offers `Skip()`; the stone interaction unlocks after `readable.seen.prologue-letter`.
`PrologueGateRule.Decide(hasEverBeenPlaced, startSpawnPlan)` is true only for a never-placed trainer on the start
spawn. `OpenWorldBootstrap`, before placing the player, suspends streaming, loads the prologue additively alone,
awaits `Completed`, unloads, resumes streaming and continues placement. `world.placed` is set after the first
successful placement.

`ProloguePortal` completes the prologue only for the player's own collider (tag `Player`, then the Malbers tags):
the rig's 10/20 m child trigger spheres share its Malbers tags and overlapped the volume the moment it activated.

A run abandoned during the closing whiteout never raises `Completed`, and the bootstrap re-checks the UI context after
the saved-location read: back at the title by then, the placement is dropped (no prologue under the menus) and the
next Overworld entry gates again.

## Place flavour

`RegionProfile.flavourText` with `RegionProfileSet.FlavourFor(key, mask)` (key, then parent, then null) and
`AreaBannerEvents.RaiseArrived(banner, flavour)`. `LocationFlavourSet` (`Resources/Story/LocationFlavour.asset`)
holds `LocationFlavourEntry { locationContentKey, title, flavourText }` and `FlavourFor(locationKey)`; the journal
shows them in a Places section. Visited regions are per trainer: `RegionTracker` starts a fresh visit list (and forgets the
debounced region) when the session's trainer differs from the one who walked them, so the next trainer's Places start
empty and their first entry to a region still carries its flavour line.

## Capture-lesson hints

`BattleEvents.RaiseNotice(text)` / `Notice` feed a BattleHUD line. `CaptureLessonHints` subscribes to HP and
capture-failed events and only acts when the battle's spawner key is `story-capture-lesson`. Texts come from `StoryText`.

## StoryText

`[LocCatalogue] static class StoryText` (`Assets/CR/Game/Story/Text/StoryText.cs`): `LocString`s for barks
(`ui.story.bark.*`), battle hints (`ui.story.hint.*`) and UI such as Skip (`ui.story.skip`), the barn (`ui.story.barn.*`) and the morning (`ui.story.morning.*`) that are not dialogue graphs. They go
through the normal localization export. Dialogue graphs, quest text and flavour are content assets.

## Script review page

Editor CLI `cr_story_script_page` (`StoryScriptPageGenerator`) writes `CR/docs/2026-10-08-opening-script.html`
(or the path in `--args`): a single self-contained page with every dialogue's nodes in walk order (speaker, text,
choice options, node id, asset path), plus StoryText, quest, region flavour and place flavour rows, each with a
"where to edit" column. The walk/format logic is `ScriptPageBuilder` (pure, `CR.Game.Story.Logic`) over plain DTOs.
Dialogue keys are listed in `StoryScriptPageGenerator.DialogueKeys`; a missing asset is flagged NOT FOUND.
Regenerate after editing text.

## Placements: StorySceneBuilder

`Assets/CR/Game/Story/Editor/StorySceneBuilder.cs` builds every opening-story placement from code so the
blockout can be regenerated: `cr_story_build_scenes --args prologue|arrival|vista|descent|all`. Each part
replaces its own `[Story …]` root and leaves hand-placed objects alone:

- **prologue** — writes `Assets/CR/Scenes/Prologue/Prologue_Earth.unity` (room blockout, readables, the stone,
  the portal volume, `PrologueController`, a `SceneContext` parented to `CoreContext`) and adds it to Build Settings.
- **arrival** — `World_c0_r4`: the ruin inscription readable, the `arrival-ahksun-rises` event (crystal with
  `CrystalRise`) and Ahksun's first-sight bark. Triggers sit on the ramp, outside the player rig's 20 m lock-on
  sphere at the start spawn (a trigger nearer the edge fires the moment the game starts).
- **vista** — `World.unity` (always loaded, so the pillar and the trigger can reference each other): the
  Mirandale pillar + city lights at (354, 60, 758), the `arrival-pillar-shatters` event on the ramp with
  `HCFX_Explosion_02`, a `LightFlash` and the `RiftFlicker` sky quads. Adds a `SceneContext` to World.unity.
- **descent** — `World_c0_r3`: Philroe moved to the wagon, `NpcEscort` + `EscortDirector` with five waypoints
  (all in this cell — Unity cannot serialise cross-scene references), the three story encounter zones, the two
  place triggers, Ahksun's barks, the farm (gate, fence, barn, Izzandra, `BarnSleepInteraction`).

Before saving `arrival`, `vista` and `descent`, `StorySceneBuilder` calls `CorridorStoryPlacer.ApplyTo(scene, CorridorLayout.LoadDefault(), dryRun: false)`,
so a rebuild puts every story object back where the corridor layout says (the constants in `StorySceneBuilder` are the blockout
positions and are not edited). With no layout asset it is a no-op with a note.

After a rebuild run `cr_world_refresh_activatables --args c,r`, `cr_world_bake_proxy --args c,r` and `cr_world_validate`.

## Beat map on the built corridor

The corridor builder ([Open World → Terrain and the corridor builder](?page=unity/37-open-world)) moved, snapped or resized
these objects through its adjustment rows (each row carries its reason in `Act1Corridor.asset`); component fields (keys,
dialogue, quest gates, radii, escort settings) are never edited.

| # | Beat | Object | Where on the built corridor |
|---|---|---|---|
| 1 | spawn | `WorldLayout` start (208, 30.1, 1105), yaw 180 | the 1a shelf, ground 30.0; nothing solid within 1.5 m |
| 2 | Ahksun rises | `Event_arrival-ahksun-rises` | box widened to the whole glade, x 184-231, z 1091-1100 (A3); rims close every other exit |
| 3 | crystal at the cliff edge | `Ahksun Crystal (placeholder)` | moved to (205, 30, 1090), 2.2 m inside the rim, in a broken rune ring (A5) |
| 4 | inscription | `Readable_RuinInscription` (193.6, 30, 1090.6) | unchanged; a rune rock stands 1.2 m south of it |
| 5 | first sight of Mirandale | `Bark_ahksun-mirandale-first-sight` | box widened to x 206-226 on the balcony (A6); the gate posts frame the city |
| 6 | pillar shatters | World `Event_arrival-pillar-shatters` | box spans the whole shoulder, x 96-300, z 1051-1065 (W1) |
| 7 | descent, ambush seen | — | goat path legs B/C; Leg C looks down on the terrace |
| 8 | wagon: Hellcat bond, gaterbear First Battle | Philroe, WP0, `[Bond Cue]`, gaterbear zone | y-snapped onto the 4.2 m terrace; the cart is posed nose-down against a boulder (C13) and the grey rock cube parked |
| 9 | escort, descent bark, switchback | `NpcEscort`, `Bark_ahksun-descent`, `story-switchback` | ET track WP0 → WP1; waypoints, bark and trigger y-snapped |
| 10 | capture lesson | `story-capture-lesson` | WP2 in the flat lesson clearing (pad 0.0) |
| 11 | meadow edge | `Bark_ahksun-meadow` | WP2 → WP3 |
| 12 | farm gate, Runaway Cargo offer | WP4 | moved to the lane (210.5, 0, 974.5), yaw 90, facing the gate (C12); still inside `story-philroes-farm` |
| 13 | Runaway captures | `story-runaway-farm` (238, 955) r 9 | meadow south of the yard fence |
| 14 | Izzandra, barn sleep, morning | Izzandra (224, 978), Barn Sleep (231.5, 983), morning spot (215.5, 976) | through the doorless gate |

**The farm (2a).** The eight story fences are re-lined N-S as the yard's west fence around the gate frame (C27-C34); the gate's two
door children are parked so the opening is walkable (C25, C26; a broken leaf leans on the fence instead). The north and east yard
fences are closed, so a player coming down from the wagon follows the track past the lesson. The cabin (Village `house_10`) has
chimney smoke and a lantern; the barn has its own lantern over Barn Sleep. Keep-outs (legacy `entrance` 2.5 m, the barn apron,
Barn Sleep 3.2 m, Izzandra 3.5 m, morning spot 1.5 m, a 3 m corridor gate → Izzandra) are checked by `cr_world_check_corridor`.

**Village parked in open mode.** The migrated `[Village]` group and the demo quest-giver are parked in `World_c0_r3` (C4, C5); legacy
mode keeps `Areas/Village.unity`. The market broker moved to the lane's east end beside a stall at (252.5, 964.6) (C6). The `village`
visit trigger and the `entrance` spawn point are kept.

## Small story components

- `QuestGatedCollider` — keeps a trigger collider enabled only while `QuestGateRule` says so (required quest
  complete, blocker not complete, required dialogue heard); re-checked every frame because
  `SpawnerEncounterBehaviour.Activate` re-enables the collider at world init. The gaterbear zone has no required
  quest: it is armed from world start until First Battle completes, and waits until Philroe's opening
  (`dialogue-merchant-area-1`) has been heard. The lesson zone opens after First Battle and closes after First
  Capture. Server side, Welcome is retired by M7020 and the starter is granted at trainer creation (merged to cr-api
  `main` in PR #70; see [Quest System](?page=backend/07-quest-system)). The Unity side is in place: the gate fields
  above, and the escort waits for Philroe's post-win lines at the wagon before it walks (F7). The corridor build-out
  does not touch any of these fields (it moves transforms only).
- `ProximityBark` — one StoryText line when the player's root collider (tag `Player`) enters; once per trainer
  under `event.<key>`, written only when the line was actually shown (a line suppressed by a conversation is retried
  while the player stays inside); anchored on the player (Ahksun) or on a transform (Izzandra).
- `BarnSleepInteraction` — readable-style prompt; `BarnSleepRule` locks it until Runaway Cargo is PAID OUT (completed
  AND claimed — completed-but-unclaimed stays locked), then bark → fade → morning: Izzandra moves to the gate spot,
  `event.barn-morning` flag. The flag is read back on load and trainer switch: Izzandra at the gate, barn `Closed`,
  the night never replays.
- `DialogueLineCue` — shows a presentation-only model beside the player when a conversation reaches given line nodes
  (`IDialogueLineFeed.LineShown`, raised by `DialogueService` before each line) and hides it when the conversation
  ends. The bond-line Hellcat (T6) on `help-bond` / `help-bond-explain` uses it; the real Hellcat is the server-granted
  starter.
- `CrystalRise`, `LightFlash`, `RiftFlicker` — presentation movers driven by `PresentationMath`.

## Whiteout in the open world

`PlayerWhiteoutHandler` awaits `OpenWorldWhiteoutReturn.TryReturnPlayerAsync()` first. In open mode it moves the
player through `IOpenWorldRelocator` (impl `OpenWorldBootstrap`, Ruling S29) — the placement path: cover, warm the
destination cell until Active, `IOpenWorldPlayer.Teleport` (movement controller, never a transform write), snap the
region, reveal; the healed dialog waits for it. The target is `IWhiteoutSafePoint` — impl
`EscortWhiteoutSafePoint`: beside the farm gate when the escort phase is `AtFarm`, the lesson spot when `Escorting`
(`WhiteoutSafePointRule`), otherwise the `WorldLayout` start spawn. Legacy mode is unchanged (merchant teleport).

## Play-mode smoke

`cr_story_smoke_start --args full|skip|runaway|hold|title|switch|portal` (play mode, `world_mode` = `open` through
GameSettings or the Studio override; Editor and development builds only — `#if UNITY_EDITOR || DEVELOPMENT_BUILD`)
runs `StorySmokeRunner`. `portal` (`PortalPlacesScenario`) walks the prologue naturally into the portal, checks the
player is placed and records visited places, then switches to a second new trainer and checks its Places start empty
and its first region entry still shows flavour; it needs `IVisitedPlacesSource`, so open mode only. Every mode drives the
startup UI to a new offline trainer and walks every beat through the player's own entry points (readables,
events, NPC conversations, `SubmitPlayerAction` with `BattleActionParser.Serialise(BattleAction)`, teleports through
`IOpenWorldPlayer`). One line per step in
`Temp/i2/story_smoke.txt`; `cr_story_smoke_status` shows the phase. Its teleports still use the blockout heights, so
`Teleport` lifts each one onto the terrain + 0.2 (`GroundLiftRule`) when it would land underground. Offline, the gaterbear needs its creature
row in the local game-data (the server content sync soft-deletes creatures the server does not have); production content
with `creature_gaterbear` was pushed and the offline floor rebaked on 2026-10-09.

Capture beats are random (the capture roll is the authority's), so the runner plays them like a player would. A missed
lesson shard is retried (up to 3 times; the lesson zone stays armed until First Capture completes). Runaway Cargo gets up to
8 attempts. Between attempts the runner heals with potions through `IItemUseDomainService` (the bag screen's use-item
intent), buys potions and shards from Philroe through the merchant purchase intent when the bag is empty, and leaves the zone
as soon as each battle closes, because standing in it re-arms the next encounter. A repeat-capture battle that the zone has
already started is adopted rather than reset. Trainers are named `Smoke<MMddHHmmss>`. The runaway mode fails unless the barn
reads `Sleep` after the claim, and every mode that reaches the barn fails unless the morning fires and reads back `Closed`.
