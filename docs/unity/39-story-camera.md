# Story Camera (Unity)

When a story beat's dialogue talks about something, the camera shows it. The two opening beats, Ahksun rising at the
cliff edge and the Mirandale pillar shattering, cue camera shots on their dialogue lines, switch on their visuals on
those same lines (not after the conversation), and can be skipped by holding Cancel. All of it is **presentation**:
nothing is granted, recorded or reported, and the client never reports an outcome. The conversation itself, its
quests and every intent still go through the usual path; the shot, the setting and the skip are local to the device.
Code lives in `Assets/CR/Game/Story/` (`CR.Game.Story`; pure rules in `CR.Game.Story.Logic`, tested in
`CR.Game.Story.Logic.Tests`); the editor tools are in `Assets/CR/Game/Story/Editor/`. The opening-story systems around
it are in [Opening Story](?page=unity/38-story-opening).

## The pieces

| Piece | Role |
|---|---|
| `StoryShotPlan` (+ `StoryShotEntry`, `StoryShotStep`, `StoryShotKind`, `StoryCameraMode`, `StoryCameraRelease`) in `CR.Game.Story.Logic` | Pure. Which shot a line cues under the player's mode, with every number made safe; and the blend each release uses |
| `StoryShot` | The serialized shot: node id, kind, subject, camera mark, pan start, blend, field of view, motion seconds, orbit degrees |
| `StoryShotCue` | On the story event next to `OneShotWorldEvent`. Listens to `IDialogueLineFeed.LineShown`, resolves the line through the plan and the setting, hands the director a `StoryShotRequest` |
| `IStoryCameraDirector` / `StoryCameraDirector` | One `CinemachineCamera` above the overworld rig; poses it, blends to and from it, releases it |
| `IStoryCameraSetting` / `StoryCameraSetting` | The player's "Story camera" choice over `IGameDataRepository` |
| `OneShotStage` + `OneShotStageTracker` | A per-line stage of a `OneShotWorldEvent` (visuals on the line that talks about them) |
| `IStoryBeatGate` / `StoryBeatGate` | Keeps the player menu shut while a skippable beat plays |
| `OverworldCameraGate.ReframePitch()` | Puts the overworld rig's pitch back after a release |
| `StoryCameraBindingsExtensions.BindStoryCamera()` (`Core/DI`) | The installer's bindings: setting, gate, and the NonLazy director |

## One beat

1. The dialogue service raises `LineShown(session, nodeId)` just before the view shows a line. `LineShown` fires for
   **line** nodes only, never for a choice, so a shot or stage on any other kind of node would never fire.
2. `StoryShotCue` ignores other conversations, reads the player's mode, and asks `StoryShotPlan.Resolve(nodeId, mode)`.
   No entry for the node means nothing happens: the camera stays where the last shot put it (an optional branch line
   like `r2b` keeps the crystal shot).
3. A `ReturnToPlayer` entry releases the camera with its blend. Any other entry goes to the director as a
   `StoryShotRequest` (the resolved step plus the subject, mark and pan-start transforms).
4. `OneShotWorldEvent` hears the same line and fires the stage cued by it (below).
5. The conversation's `Ended` (every outcome) releases a camera still held.

## The plan

| Kind | Default lens | Notes |
|---|---|---|
| `Wide` | 60° | the camera at its mark facing the subject |
| `Medium` | 40° | |
| `LongLens` | 20° | |
| `Pan` | 55° | stays at its mark; the aim point eases (in-out) from `panFrom` to the subject over `motionSeconds` |
| `Orbit` | 45° | the position swings round the subject by `orbitDegrees` over `motionSeconds` |
| `ReturnToPlayer` | none | hands the view back; shows nothing |

`fov` 0 means the kind's lens; authored numbers are clamped (fov 5 to 120°, blend 0 to 8 s, motion 0 to 30 s, orbit
±360°) and a NaN counts as 0. A move with no duration rests: a pan on its subject, an orbit at its mark. Two entries for
one line: the first wins.

| Mode | What the plan does |
|---|---|
| **Cinematic** (default, also what an unset or unreadable store means) | the shot as authored |
| **Gentle (cuts only)** | the same view as a cut: blend 0, no pan or orbit, and every release is a cut |
| **Off** | no entry at all: the camera never leaves the player. The stages still fire |

The mode is read at each line, so a change in the System tab applies from the next beat. A subject is required for
every shot except `ReturnToPlayer`; a camera **mark** is optional (empty: the camera stays where the view was and turns).

## The director

`StoryCameraDirector` is a NonLazy singleton (`BindStoryCamera()`) that creates its own `CinemachineCamera` at priority
**50**: above the overworld rig (10), below the battle role cameras (100), so a battle outranks it even if a release
were missed.

- **Take.** The first shot is placed, then the Brain's `DefaultBlend` is overridden for the transition (ease in-out over
  the shot's blend seconds, or a Cut) and the camera is enabled. The override is put back on the **next frame**: the
  Brain reads it in its own update after the camera change, and `BattleCinematicDirector` restores its blend the same
  way. A held shot never leaves the Brain overridden, so a battle starting mid-beat cannot save our blend as "the original".
- **Move.** A later shot is a pose blend of the same camera (position, rotation, lens; ease in-out) from where the
  previous shot stood. Advancing a line finishes any blend in flight first: the Brain's entry blend completes
  (`ActiveBlend = null`) and the previous shot jumps to where it was heading, so a quick reader is never held up.
- **Refusals.** A shot with no subject (an anchor the scene lost, or one a cell unload destroyed) takes nothing and warns
  with the line id; a `Pan` with no `panFrom` shows as a still shot and warns; a main camera with no
  `CinemachineBrain` warns once. A refused shot while one is held leaves the held shot alone.
- **Release.** Every path hands the view back, puts the Brain's blend back and, afterwards, the rig's pitch:

| Reason | Blend back |
|---|---|
| `ReturnToPlayer` (a line cued it) | the line's blend seconds |
| `DialogueEnded` (the conversation ended with a shot held, any outcome) | 0.8 s |
| `Skipped`, `TrainerChanged`, `AnchorLost` (a held anchor was destroyed) | cut |
| `BattleStarted` | none: the camera is disabled and the Brain's blend left to the battle director (no pitch reset: the battle's own exit re-frames) |
| `Disposed` | the Brain's blend is restored at once |

  Gentle and Off always cut.
- **Pitch.** While a camera that is not the rig's own is live, Malbers' `ThirdPersonFollowTarget` copies the Brain's yaw
  and pitch into the rig, so after a story shot the player would come back looking up at the sky. 0.1 s after a release
  `OverworldCameraGate.ReframePitch()` puts the pitch back to the initial 8°. The **yaw** is left alone on purpose: the
  player comes back facing what the last shot looked at (the city).
- `Tick(dt)` is public (Update drives it with unscaled time) so tests can step it; `OnDestroy` runs `Shutdown()`.

## Per-line stages (`OneShotWorldEvent`)

A `OneShotStage` pulls part of the beat forward to the line that talks about it: `nodeId`, `enable[]`, `disable[]`,
`runPrelude` (the event's purple-red charge runs first, for `preludeSeconds`) and `spawnVfx` (the burst).

- A stage fires on `LineShown` for its node, once per play. Stages run one after another in the order the lines come.
- A stage no line reached still runs after the dialogue, in authored order, and the end state is the event's own toggles
  plus every stage's.
- Anything a stage switched is not switched again at the end (`_handled`): a `LightFlash` that played and put itself out
  would otherwise flash a second time.
- The flag is written only after the dialogue ended, so restore, revisit and trainer-switch handling are unchanged. A
  restore still jumps every `IOneShotAftermath` to its end state.
- A trainer switch or an unloaded cell stops the stages; a new play gets a new run id, so a late stage of the old one
  does nothing.

## Skip

Holding Cancel (gamepad B, keyboard Esc) for 1 s (`skipHoldSeconds`, `HoldToSkip`) while a beat plays:

1. the camera is released at once (a cut),
2. the conversation is cancelled through the token passed to `StartAsync` (it ends Declined, no toast; nothing in these
   conversations is an intent),
3. a stage waiting on its charge is cut short and no burst plays,
4. the end state shows exactly as a revisit would (movers jump to their end pose, the flash stays dark, the pillar is
   gone), and the flag is written.

The device is read directly (as the prologue skip does), never Submit / South, which is Jump. Esc is also the player
menu's open key, so `IStoryBeatGate` keeps the menu shut from the beat's first line until it ends (`PlayerMenuWindow.MenuInputBlocked`
includes the gate, like the prologue). The first line also shows a one-time toast, "Hold Esc / B to skip"
(`StoryText.SkipBeatHint`); a beat that never ran (busy, not ready) shows nothing and locks nothing.

## The setting

System tab, Game card: **Story Camera**: Cinematic / Gentle (cuts only) / Off. Stored as text ("cinematic", "gentle",
"off") under `GameConfigurationKeys.StoryCameraMode` (`story_camera_mode`); unset means Cinematic. Local only.

## Authoring

Anchors are children of the event under `[Shots]`, so a cell unload takes them along; no corridor row names them, so a
corridor rebuild leaves them alone. The camera's aim on the crystal is a child of the crystal itself (corridor row A5
moves the crystal, and the aim rides along, rising with it).

- `cr_story_author_shots --args arrival|vista|all` puts the shots and stages into the existing scenes (idempotent:
  replaces the event's `[Shots]`, cue and stages, saves the scene). `StorySceneBuilder` calls the same authoring after
  creating each event, so a rebuilt root gets its shots back. Headless:
  `Unity -batchmode -quit -projectPath … -executeMethod CR.Game.Story.Editor.StoryShotCommands.AuthorAllHeadless`.
- `cr_story_render_shots --args out=<folder>` renders every authored shot to PNG from the scene data, with the scene as it
  stands when that line appears (earlier stages done, the line's own stage switched on but not yet its disables, so the
  pillar still stands in s2). A pan renders at its start and its end. Headless:
  `CR_STORY_SHOTS_OUT=<folder> Unity -batchmode … -executeMethod CR.Game.Story.Editor.StoryShotPreview.RenderAllHeadless`
  (graphics on, so no `-nographics`).
- The shots live in `ArrivalShots` and `VistaShots` (world positions as constants). After changing them run the author
  command, then the render command and look at the PNGs.
- `cr_world_build_corridor --args dry` reports the same 0 changes before and after: the corridor rows are untouched.

### The two beats

| Beat | Line | Shot |
|---|---|---|
| Arrival (`World_c0_r4`) | r0 | Pan, 4 s, from the glade (bearing 182°) to Mirandale, from the overlook (208, 33.3, 1107.8: corridor bookmark 02), fov 58, blend in 1.5 s |
| | r1 | Medium on the rising crystal from the ring of rune stones (205.2, 31.7, 1095.2), fov 30, 1.2 s. **Stage:** the crystal is enabled on this line and rises while Ahksun speaks |
| | r2 | Wide on the city between the gate posts (211, 32.2, 1092), fov 62, 1.0 s |
| | r3 | ReturnToPlayer, 1.2 s. r4, r5, r5b and the optional r2b have no shot |
| Vista (`World.unity`) | s1 | Wide, low angle up at the rifts from the ramp (216, 21.2, 1060), fov 80, 1.2 s. **Stage:** the rifts open |
| | s2 | LongLens on the pillar over the city, same mark, fov 24, 1.0 s (a push-in). **Stage:** 1.5 s charge, burst, flash, pillar gone, city lights out |
| | s3 | ReturnToPlayer, 1.5 s |

The placeholder crystal is a 15 cm shard, so the r1 shot is close. The rift strips were single-sided and lie flat facing
up, so they were invisible from the ground; `Story_SkyRift.mat` is now double-sided (`_Cull` 0), and `StorySceneBuilder`
keeps it that way.

## Tests

`StoryShotPlanTests`, `StoryCameraModeTests`, `StoryCameraReleaseTests`, `OneShotStageTrackerTests` (pure, in
`CR.Game.Story.Logic.Tests`); `StoryCameraDirectorTests` (every release path restores the blend, missing anchors, pose
blends, pitch reset), `StoryShotCueTests`, `StoryShotPoseTests`, `StoryCameraSettingTests`,
`StoryCameraBindingsContainerTests`, `StoryBeatGateTests`, `OneShotWorldEventStageTests` (stage ordering, unfired stages
after the end, flag only at the end, restore to the aftermath, skip, gate, hint), `StoryShotAuthoringTests`, and
`StoryShotScenesTests`, which audits the real scenes (every cued node is a line of the real dialogue, anchors in the
event's own scene, marks above the corridor ground, the corridor placer's dry run aborts nothing and changes nothing).
`StorySmokeRunner` checks that the story camera is the Brain's live camera during each beat and released after it
(skipped when the setting is Off).

## Not yet checked in play

Both beats on a new trainer; the skip (B and Esc: no menu opens, hint toast shows); the Off and Gentle settings; the
return-to-player yaw and pitch; a battle or trainer switch mid-beat; Deck frame time at the beats.
