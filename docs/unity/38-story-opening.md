# Opening Story (Unity)

Client systems for the opening story: a one-time Earth prologue, the arrival at the cliff's edge (Find Ahksun), the walk
down to the Meadow wagon (Toward the Lights, where First Battle begins), an escorted walk to the farm, lore readables,
world barks, a scripted capture lesson and place flavour. All of it is **presentation**:
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
line was shown, so a caller that remembers "said once" never burns that memory on a suppressed line. The bubble text
goes through `LoreText.Decorate` (lore keywords coloured, never animated); the glossary that drives it,
`Content/Text/glossary.json` (next to `names.json`), is covered in [Lore text](?page=unity/39-lore-text).

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

Per-line **stages** (`OneShotStage`) pull parts of that sequence forward to the dialogue line that talks about them (the
crystal rises on `r1`; the rifts open on `s1`; the charge, burst and lights-out run on `s2`); a stage no line reached
still runs after the dialogue, and the flag is still written only at the end. Holding Cancel for 1 s **skips** the beat
(camera back at once, conversation cancelled, end state shown, flag written). The camera shots the same lines cue are
described in [Story Camera](?page=unity/39-story-camera).

A restore (load, cell stream-in, trainer switch) shows the END state without replaying: after enabling an object it
calls every `IOneShotAftermath` under it — `CrystalRise` jumps to its final pose, `LightFlash` stays dark. A trainer
switch during the dialogue never starts the prelude; a switch during the prelude puts the new trainer's view back;
a cell unloaded mid-prelude ends the beat unplayed. `PillarCharge` drops its tint whenever it is switched off.

## The opening quest chain

A new trainer is handed **Find Ahksun** at the spawn, not First Battle. First Battle used to be auto-granted there, so the
fight quest sat in the tracker a hundred metres above the gaterbear, and a playtester finished it with the first wild fight.
The chain is content only (assets under `Assets/CR/Content/Defs/Quests/`, staged in `quests.json`); the authority decides every
grant, objective and completion, and the client's only part is the location-enter intent a trigger sends.

| Quest | Key | Objective | Requirement | Granted | Done by |
|---|---|---|---|---|---|
| Find Ahksun (sort 0, Main Story) | `quest-find-ahksun` | `VisitLocation` `story-ahksun-landing` ×1 | `QuestNotStarted` `quest-first-battle` | the auto-granter, at session start | walking onto the arrival strip |
| Toward the Lights (sort 1) | `quest-the-way-down` | `VisitLocation` `story-philroes-wagon` ×1 | `QuestCompleted` `quest-find-ahksun` | the auto-granter, when Find Ahksun is claimed | the wagon's first entry |
| First Battle (sort 1) | `quest-first-battle` | `DefeatCreature` `creature_gaterbear` ×1 | `StatThreshold` `location_discovered_story-philroes-wagon` ≥ 1 | the wagon location's `discovery_quest_key` (the authority grants it on the first entry); the auto-granter is the safety net | the gaterbear's defeat |

- **Find Ahksun is closed to anyone who has started First Battle.** `QuestNotStarted` (cr-api `QuestRequirementType` 6) is met
  only while the trainer holds no instance of the named quest in any status, so a trainer who is already past the opening
  (every existing trainer holds First Battle) is never handed the first two quests. The Unity mirror: `ProgressRequirementConditionEvaluator`
  (dialogue `progress.requirement` kind `QuestNotStarted`), the `QuestDefinitionEditor` requirement drawer and the Content Audit's
  dangling-reference check.
- **The landing is the arrival strip.** Row A7 fits the `story-ahksun-landing` trigger to the same box as the `Event_arrival-ahksun-rises`
  trigger (A3: the full glade width, x 184-231, z 1091-1100), so the beat and Find Ahksun's completion are one act and no descent from
  the spawn skips the quest (the `arrival_box` navmesh check already proves the strip cannot be bypassed). The blue `Ahksun Glow`
  point light sits beside the crystal (row A8) and burns from the first frame; it used to be a child of the crystal, which stays
  inactive until the beat, so nothing was visible to walk toward.
- **The wagon trigger closes before the fight.** `story-philroes-wagon` (row C43) is 30 × 30 round the terrace, 8 m wider than the gaterbear
  zone on every side and around Philroe and the cart, because a kill counts only once First Battle is held: the grant
  must land before the player can reach the zone or Philroe. Entering it also completes Toward the Lights.
- **First Battle counts the gaterbear only**, by species content key (the battle emits the defeated species' key). Any other creature, or a
  kill made before the quest is held, advances nothing.
- **Registry order is part of the content.** The offline sync writes `ContentDefinitionProvider.quests` in list order, in one pass, and
  resolves a requirement's quest key against what is already written; a quest named too early stores a null reference that is never met.
  The list is First Battle, Find Ahksun, Toward the Lights, First Capture, Runaway Cargo. `QuestRegistryOrder` (pure, `CR.Core.Data.Logic`)
  states the rule; the Content Audit reports a violation as `quest-registered-before-its-reference` and `OpeningChainContentTests`
  syncs the shipped quests into an in-memory store to prove every reference resolves on the first pass. (Runaway Cargo used to be listed
  before First Capture, so on a fresh offline install the farm gate did not offer it until the second launch.)
- **Offline needs the locations on the floor.** The offline authority answers an unknown location with nothing, so `story-ahksun-landing`
  and `story-philroes-wagon` must be in the baked floor's `world_location` (cr-api M15014, ids from `WorldLocations.asset`); nothing at
  runtime writes them there. `OpeningLocationFloorTests` checks the package's floor against the catalog and **fails** the run when the
  committed floor lacks rows the installed package seeds (it skips only when the package does not seed them either), so a stale floor
  cannot ship quietly.
- **Philroe's hub** is unchanged for a new trainer from the wagon on (`help` while First Battle is active, `walk`, `caught`, the Runaway
  cases). Before the wagon trigger fires, and for a trainer whose First Battle was abandoned (the authority restarts it in place on the next
  sweep, so it reads as on offer, never Active), he is still pinned behind the gaterbear (`trapped`); his `breath` fallback names no place.
  `DialoguePhilroeHubResolutionTests` walks every state of the chain, a legacy trainer who was never offered the first two, and the
  abandoned case.

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
Dialogue keys are listed in `StoryScriptPageGenerator.DialogueKeys` and the quests in `StoryQuestKeys` (the five opening quests,
Find Ahksun first); a missing asset is flagged NOT FOUND.
Regenerate after editing text.

## Placements: StorySceneBuilder

`Assets/CR/Game/Story/Editor/StorySceneBuilder.cs` builds every opening-story placement from code so the
blockout can be regenerated: `cr_story_build_scenes --args prologue|arrival|vista|descent|all`. Each part
replaces its own `[Story …]` root and leaves hand-placed objects alone:

- **prologue** — writes `Assets/CR/Scenes/Prologue/Prologue_Earth.unity` (room blockout, readables, the stone,
  the portal volume, `PrologueController`, a `SceneContext` parented to `CoreContext`) and adds it to Build Settings.
- **arrival** — `World_c0_r4`: the ruin inscription readable, the `arrival-ahksun-rises` event (crystal with
  `CrystalRise`, its camera shots and the r1 stage: see [Story Camera](?page=unity/39-story-camera)), the `story-ahksun-landing` trigger and `Ahksun Glow`, and Ahksun's first-sight bark. Triggers sit on the ramp, outside the player rig's 20 m lock-on
  sphere at the start spawn (a trigger nearer the edge fires the moment the game starts).
- **vista** — `World.unity` (always loaded, so the pillar and the trigger can reference each other): the
  Mirandale pillar + city lights at (354, 60, 758), the `arrival-pillar-shatters` event on the ramp with
  `HCFX_Explosion_02`, a `LightFlash` and the `RiftFlicker` sky quads (double-sided, so they show from the ground), with the
  event's camera shots and the s1 / s2 stages. Adds a `SceneContext` to World.unity.
- **descent** — `World_c0_r3`: Philroe moved to the wagon, `NpcEscort` + `EscortDirector` with five waypoints
  (all in this cell — Unity cannot serialise cross-scene references), the three story encounter zones, the three
  place triggers (switchback, farm, and `story-philroes-wagon`), Ahksun's barks, the farm (gate, fence, barn, Izzandra,
  `BarnSleepInteraction`).
- **locations** — adds or refreshes only the landing trigger, the wagon trigger and `Ahksun Glow` in a cell whose story
  roots were built before they existed (the glow's old copy under the crystal is removed), leaves every other story object
  as it is, then re-applies the corridor rows. Headless: `-executeMethod CR.Game.Story.Editor.StorySceneBuilder.BuildOpeningLocations`.

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
| 2 | Ahksun rises; Find Ahksun completes | `Event_arrival-ahksun-rises`, `[VisitTrigger] story-ahksun-landing` | both boxes widened to the whole glade, x 184-231, z 1091-1100 (A3, A7); rims close every other exit |
| 3 | crystal and glow at the cliff edge | `Ahksun Crystal (placeholder)`, `Ahksun Glow` | crystal moved to (205, 30, 1090), 2.2 m inside the rim, in a broken rune ring (A5); the glow burns 0.8 m over it (A8) |
| 4 | inscription | `Readable_RuinInscription` (193.6, 30, 1090.6) | unchanged; a rune rock stands 1.2 m south of it |
| 5 | first sight of Mirandale | `Bark_ahksun-mirandale-first-sight` | box widened to x 206-226 on the balcony (A6); the gate posts frame the city |
| 6 | pillar shatters | World `Event_arrival-pillar-shatters` | box spans the whole shoulder, x 96-300, z 1051-1065 (W1) |
| 7 | descent, ambush seen | — | goat path legs B/C; Leg C looks down on the terrace |
| 8 | wagon: First Battle is granted, then the Hellcat bond and the gaterbear | `[VisitTrigger] story-philroes-wagon`, Philroe, WP0, `[Bond Cue]`, gaterbear zone | trigger box x 198-228, z 994-1024 (C43); the rest y-snapped onto the 4.2 m terrace; the cart is posed nose-down against a boulder (C13) and the grey rock cube parked |
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
  `SpawnerEncounterBehaviour.Activate` re-enables the collider at world init. The gaterbear zone
  (`Story_EncounterZone_story-gaterbear-wagon` in `World_c0_r3`) no longer gates on Welcome and has no required quest
  (First Battle is granted by the wagon location's trigger, which closes before the zone). It arms only once Philroe's opening (`dialogue-merchant-area-1`) has been
  heard: the conversation ends after showing `help-catch` or `trapped`. It stays shut mid-talk, on the last line and
  after a walk-off. The "heard" marker is a local presentation story flag per trainer
  (`IStoryFlags`), so it is never reported to the authority. The zone closes for good when First Battle completes
  (`blockedByCompletedQuestKey: quest-first-battle`). The lesson zone opens after First Battle and closes after First
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
`Temp/i2/story_smoke.txt`; `cr_story_smoke_status` shows the phase. The arrival and vista beats also check that the story
camera was the Brain's live camera during the beat and is released after it (skipped when the Story camera setting is Off). Its teleports still use the blockout heights, so
`Teleport` lifts each one onto the terrain + 0.2 (`GroundLiftRule`) when it would land underground. Offline, the gaterbear needs its creature
row in the local game-data (the server content sync soft-deletes creatures the server does not have); production content
with `creature_gaterbear` was pushed and the offline floor rebaked on 2026-10-09.

Its model is a placeholder: `creatures/gaterbear` is a scaled (1.8x), olive-tinted Prefab Variant of the Wolf Pup,
built by `cr_build_gaterbear_placeholder`, with a portrait baked from it at `icons/creatures/creature_gaterbear`. Before
that the definition pointed at Dragon Fire's prefab and icon, so the wagon fight showed a dragon. Changing a
creature's `assetKey` or icon key reaches players only through the same two steps as its row: push `creature_gaterbear`
(online reads the key from the server) and rebake the offline floor (offline reads it from `game-data.bytes`).

The runner follows the chain: at the spawn Find Ahksun is active and First Battle is not; teleporting onto the arrival strip plays
Ahksun rises and must complete Find Ahksun and hand out Toward the Lights; teleporting to the wagon box's northern edge (inside
the box, outside the gaterbear zone and 16 m from Philroe) must grant First Battle and complete Toward the Lights before anything
else; only then does it walk up to Philroe. First Capture must reach ReadyToTurnIn (completed, unclaimed) and be claimed through
Philroe's `pass` option. Each of these fails the run with a message naming the trigger that did not reach the authority.

Capture beats are random (the capture roll is the authority's), so the runner plays them like a player would. A missed
lesson shard is retried (up to 3 times; the lesson zone stays armed until First Capture completes). Runaway Cargo gets up to
8 attempts. Between attempts the runner heals with potions through `IItemUseDomainService` (the bag screen's use-item
intent), buys potions and shards from Philroe through the merchant purchase intent when the bag is empty (it reads his shelf the
way the shop does, the stock ask first and then the read, because nothing stocks a merchant at world load), and leaves the zone
as soon as each battle closes, because standing in it re-arms the next encounter. A repeat-capture battle that the zone has
already started is adopted rather than reset. Trainers are named `Smoke<MMddHHmmss>`. The runaway mode fails unless the barn
reads `Sleep` after the claim, and every mode that reaches the barn fails unless the morning fires and reads back `Closed`.
