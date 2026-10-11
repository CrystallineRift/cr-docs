# Pillar Cutscene (Unity)

The Mirandale vista beat (`arrival-pillar-shatters`): on the ramp down from the plateau the player and Ahksun watch the sky
over the city tear, the great blue crystal charge and burst, the city's lights go out and something roar from the dark.
Everything on this page is **presentation**: the beat plays once per trainer behind a local story flag, nothing is granted,
recorded or reported, and the authority never hears of it. The event that runs it is a `OneShotWorldEvent` with per-line
stages and a hold-to-skip ([Opening Story](?page=unity/38-story-opening)); the shots are the story camera's
([Story Camera](?page=unity/40-story-camera)); the burst's shake, flash and boom are Feel moments played through the game-feel
director ([Game Feel](?page=unity/41-game-feel)). Code lives in `Assets/CR/Game/Story/` (`CR.Game.Story`; pure rules in
`CR.Game.Story.Logic`, tested in `CR.Game.Story.Logic.Tests`), the builders in `Assets/CR/Game/Story/Editor/`, the shaders in
`Assets/CR/Game/Story/Shaders/`, the generated art in `Assets/CR/Game/Story/Art/Mirandale/`, and the two Feel prefabs in
`Assets/CR/Game/Story/Content/Feel/`.

Every number below (counts, colours, seconds, the seed) was chosen by AI and is listed in the
[AI content ledger](?page=content/01-ai-content-ledger) as a draft to be tuned by hand.

## The beat, line by line

The dialogue has three cued lines. `StoryShotCue` cues the camera on each; `OneShotWorldEvent` fires the stage authored for
the same line (`VistaShots.AuthorVistaShots` writes both). A line reached before the previous stage is over does not cut it
short, and a stage no line reached still runs after the dialogue.

| Line | Camera | Stage | What the player sees |
|---|---|---|---|
| `s1` "the sky over the city tears" | Wide, low angle up at the rifts (fov 80, 1.2 s) from the one mark on the ramp, 1.7 m up | enable `Sky Rifts (placeholder)` (`SkyTear`) and `Sky Storm` (`SkyStorm`) | the sky turns from dusk violet to crimson over 2.2 s while the cracks glow; three lightning bolts over the city, each followed by thunder |
| `s2` "the great blue crystal… bursts" | LongLens on the pillar over the city (fov 24, 1 s): a push-in from the same mark | `runPrelude` (enable `Pillar Charge` for the event's 1.5 s `preludeSeconds`), then `spawnVfx` (`PillarBurstVfx` at `Burst Anchor`), enable `Pillar Burst`, disable the pillar | the crystal goes blue, purple, red, glowing harder and pulsing faster; the explosion, the white-violet flash, the camera kick and the low boom; the pillar is gone; a front of darkness crosses the city's windows in 0.9 s; from 1.2 s after, three roars from round the city |
| `s3` back to the player | ReturnToPlayer (1.5 s), **held until the s2 stage has ended** | none | the burst is always seen from the long lens, however fast the lines are read |

The explosion is parented to `Burst Anchor`, not to the pillar: the same stage switches the pillar off, and a VFX under it
went with it (the first build's mistake). The pillar's switch-off also clears `PillarCharge`'s tint
(`OnDisable`), so whoever sees the pillar next (a trainer who has not seen the beat) never finds it red.

### Skip

Holding Cancel (gamepad B / Esc) for 1 s skips the beat: the camera goes back at once, the conversation is cancelled, no
burst plays, and the end state shows as a restore would (below) before the flag is written. While the beat holds
`IStoryBeatGate`, the player menu stays shut (Esc is both keys) and `DialogueScreenPresenter` **ignores Cancel**: the press
that started the hold used to count as Continue on a line (and as the decline option on a choice), so the next line's stage
and shot fired for the second the skip needed to land. Continue / Submit and the option buttons work as before, and Cancel
is Continue again as soon as the beat is over. The first line shows the one-time toast "Hold Esc / B to skip"
(`StoryText.SkipBeatHint`).

### The camera waits for the stages

A reader who reaches `s3` in under the 1.5 s charge used to send the camera back before the burst and the lights-out (the
playtest complaint). `OneShotWorldEvent` now brackets every stage with `IStoryCameraDirector.BeginStage` / `EndStage` (in a
`finally`, so a skip, a trainer switch or a failed stage still ends it), and the director holds a `ReturnToPlayer` line or
the conversation's end while a stage is running, then goes back with the line's own blend when the last stage ends. The
bookkeeping is the pure `StoryReleaseDeferral`: only a release that says the beat has moved on waits; a skip, a trainer
switch, a battle start, a lost anchor or the director going away never waits; a newer shot drops the wait; and a wait that
outlasts `MaxWaitSeconds` (10 s) is let go with a warning, so a stage that never reports back cannot strand the camera on a
shot. The smoke runner waits for the hand-back before it judges the camera.

## Every piece arms, begins, settles or resets

Each thing a stage switches on is a `OneShotPresenter` (a MonoBehaviour over the engine-free `OneShotLifecycle`). The event
enables the object and, on a restore, calls `ShowAftermath` in the same call, so **nothing may start in `OnEnable`**: a piece
that began there would flash, shake or roar for a frame before it settled.

| Call | Meaning |
|---|---|
| `OnEnable` → `Arm` | enabled, nothing begins |
| first `Update` → `Begin`, then `Step(dt)` each frame until it says it is done | a live play (unscaled time, so a hit stop elsewhere cannot stretch the beat) |
| `ShowAftermath` → `Settle` | a restore (a reload, a cell streaming in, a trainer who has seen the beat): the end state, without ever having begun |
| `OnDisable` → `ResetToAuthored` | switched off (a trainer who has not seen the beat): the authored world back |

`IsArmed`, `IsRunning` and `InAftermath` are readable for tests and the smoke. The presenters:

| Presenter | On | What it does live | Settled (restore) | Reduced Motion |
|---|---|---|---|---|
| `SkyTear` | the rifts' root | turns a **runtime copy** of the current skybox from dusk violet to crimson over `seconds` (tint 1.00, 0.12, 0.16; exposure 0.5; atmosphere 0.65) and drives the rift shader's `_MirandaleRiftPulse` global so the cracks breathe at 0.35 Hz | torn sky at once | the pulse is off; the cracks burn steadily; the colour still turns |
| `SkyStorm` | `Sky Storm` | `strikes` (3) Hovl lightning bolts at the authored strike points, 40× their size, 0.5 s each, one alive at a time, on a seeded `StormPlan` (at least 0.9 s apart); one thunder `AudioSource` per clip, started after its bolt | nothing plays; any bolt is cleared and the thunder silenced | the bolts are skipped; the thunder still rolls |
| `PillarCharge` (not a presenter: enabled by the prelude, cleared by `OnDisable`) | `Pillar Charge` | tints the crystal's renderers through a `MaterialPropertyBlock` along `PillarChargePlan` (blue, purple, red; glow 0.6 to 0.9; a pulse rising from 1.2 to 2.8 Hz, never over 3), and the pillar's own light follows | n/a (never enabled by a restore) | the same colour journey without the pulse |
| `CityLightsOut` | `Pillar Burst` | writes three shader **globals** (`_MirandaleWave` origin + radius, `_MirandaleWaveSoft`, `_MirandaleFade`) so a front of darkness leaves the burst anchor and crosses the city's windows in `travelSeconds` (0.9 s, soft edge 30 m, out to 330 m); every house shares one window material, so no renderer is touched, the houses stay static-batched and no material asset is written | dark city at once (`IsDark`) | an even fade over 1.6 s instead of a front |
| `PillarBurstFeel` | `Pillar Burst` | asks `IFeelMomentPlayer.PlayAsync` for two moments at the burst anchor, at full intensity, both at once (below) | nothing plays (`Started` false) | decided by the director, not here |
| `RoarOneShots` | `Pillar Burst` | `roars` (3) from three emitters 105 m from the city centre (bearings 335, 62, 205; 3D sources with a 250 m minimum distance so a roar 300 m off is heard), from 1.2 s after the burst on a seeded `RoarPlan`, pitched 0.45 to 0.75 | nothing plays | unchanged: sound is never removed |

### The sky stays torn

The skybox has more than one writer. The open world's region environment swaps in the region's own sky halfway through
every crossing and at the first placement after a reload (all eight profiles point at the same dusk sky, and the blend
skips only a swap to the sky it already shows), so to it the torn copy was just another sky: the first crossing after the
beat and the first placement after a reload put the plain sky back for good. `SkyTear` therefore keeps the sky torn while
it is on (from its first frame, or a restore, until it is switched off, a finished live play included): in `LateUpdate`,
after the `Update` that swapped the sky, it takes whatever sky is up and tears that instead, from where the turn has got to
on the new sky's own colour, so the plain sky is never drawn. Switching it off puts back the region's sky, not the one it
first found. Only a procedural skybox (one with `_SkyTint`) is tinted; another sky is said once and left alone until the
skybox is some other material. And it does this **only while its own scene is the active one**: the skybox belongs to
the active scene's lighting settings, so a tear polling blindly would have torn the tech demo's or an interior's sky, and a
restore that runs before `World.unity` is active (`OneShotWorldEvent.Start` can come first at load) would have torn the
persistent scene's default sky and left a copy in its settings. The trade-off: the blend can no longer see through the copy,
so after the beat every crossing runs its sky swap (one `DynamicGI.UpdateEnvironment`) where crossings between regions
sharing a sky used to skip it. `OwnsSky` says whether the sky in view is the tear's copy; the smoke reads it after the beat,
after the restore and after the walk down to the wagon.

### The lightning bolt is trimmed before it wakes

A bolt is the vendor prefab (Hovl) instantiated **dormant** (`DormantInstanceExtensions`: a child of an inactive holder gets
neither `Awake` nor `OnEnable`), trimmed, then woken at its strike point. `SkyStorm.Trim` destroys the bolt's own lights (the
budget allows one real-time light, the pillar's), switches off and destroys the vendor's sound script
(`HS_EffectSound`, found by **name** so the story compiles without the pack; left behind it kept calling
`AudioSource.PlayOneShot` on the source destroyed next and threw a `MissingReferenceException` on every repeat, three per
beat in the smoke), destroys its `AudioSource`s (the thunder is this component's), switches particle lights off and
deactivates the children that belong to a strike up close (`Rays`, `Derbis`, `Crater`, `Glow`, `GroundWave`, `ShockWave`,
`WaveSmoke`, `WaveBorders`, `WaveGround`, `WaveFire`, `WaveAirSmoke`).

## The burst: two Feel moments, one gate

`PillarBurstFeel` plays `feel/pillar-shatter` and `feel/pillar-boom` through `IFeelMomentPlayer`, the game-feel director's
direct-play door, so the player's settings reach them the way they reach every other moment. **Nothing in the story reads a
setting for them**, and `StoryFeelBoundaryTests` holds the line that no source outside `Assets/CR/Core/Feedback` names a Feel
type: the story reaches the prefabs by address.

| Moment | Declared class | Feedbacks | Reduced Motion | Screen Shake |
|---|---|---|---|---|
| `feel/pillar-shatter` (`PillarShatter.prefab`) | `CameraMotion` | a uniform Cinemachine impulse (explosion shape, 1.3 s, felt from 330 m) and a white-violet flash on the child light `Flash` (0.25 s, never over 0.3; peak 16, range 450 m; the prefab's only light, off until the flash) | removed | scales the kick; **Off removes the flash with the shake**, because a moment has one class |
| `feel/pillar-boom` (`PillarBoom.prefab`) | `Cosmetic` | the low boom (Hovl `Toon ground explosion` pitched to 0.55, constant volume so nothing that scales a moment turns it down) | stays | stays |

The boom is a prefab of its own because the gate removes a **whole** moment: kept inside the shatter it would have gone
with the shake under Reduced Motion, and the settings promise that sound is never taken away. Neither prefab plays itself
(no auto-play, no script initialisation): the director's pool initialises and starts them. No particle system and no
post-processing (the Core camera renders with it off, so a bloom pulse would need the whole stack switched on for the
beat). A moment that cannot load costs the beat that part of its burst and nothing else: it is logged and the rest goes on.
`Started` is true once a moment started on the last ask (under Reduced Motion the boom alone does), for the smoke.

**Preload.** `IFeelMomentPlayer.PreloadAsync(address)` loads the prefab and builds its pooled player ahead of the first
`PlayAsync`, so the flash and the boom land on the explosion's frame instead of a few frames after it. `StoryMomentPreload`
sits on `Pillar Charge`, which the prelude enables as the 1.5 s charge begins, and asks for both moments; a restore never
enables the charge, so a trainer who has seen the beat never pays for the load. The load runs on the **director's** token,
not the caller's: a play that finds the load in flight waits on the same task, so a skipped beat walking away cannot cancel
it under that play.

**Shake.** The story camera carries a `CinemachineImpulseListener`, so the impulse reaches it while the long-lens shot is
up; its gain is 0 under Reduced Motion (`StoryCameraDirector.ShakeGain`), so the impulse fires and nothing moves. The battle
camera's shake responder is untouched.

## Reduced Motion, in one table

`StoryMotionKind` names what the beat puts on the screen and `ReducedMotionExtensions.ResponseFor` is the one table of what
the setting does to each. `IReducedMotionSetting` (`ReducedMotionSetting`) reads the same `reduced_motion` key the System
tab's toggle writes, **at every use**, so a change applies from the next beat.

| Kind | Reduced Motion |
|---|---|
| `CameraShake`, `ScreenFlash` | skipped (decided by the Feel director, which sees the same setting) |
| `LightningFlash` | skipped: the bolts do not spawn; the thunder plays |
| `Flicker` (the charge's pulse, the rifts' glow) | softened: a steady colour |
| `WaveFront` (the lights going out) | softened: an even fade |

Sound and the outcome the beat shows (the torn sky, the pillar gone, the dark city) are never in that list: Reduced Motion
changes how the beat looks, not what happened.

## Building the vista

`cr_story_build_scenes --args vista` ([Opening Story → Placements](?page=unity/38-story-opening)) replaces `[Story Vista]` in
`World.unity` (always loaded, so the pillar and the trigger can reference each other) and delegates to
`MirandaleVistaBuilder.Build`, then creates the event on the ramp (trigger box at (216, 16, 1058), 18 × 40 × 14; corridor row
W1 widens it to the whole shoulder) and authors its shots and stages. Every object a stage switches on is built **inactive**,
so a trainer who has not seen the beat sees the world as it stood before it.

| Built | What |
|---|---|
| `Mirandale Pillar (placeholder)` | PurePoly `PP_Crystal_Gradient_05` scaled to 54 m, base floating 46 m over the city centre (354, 758), every renderer on `Story_CrystalCerulean`; its colliders switched off (seen from 330 m, never touched; the mesh collider cut the corridor's sightline checks). Under it: `Pillar Light` (the vista's one real-time light, range 200, washing the city blue then following the charge) and `Pillar Charge` (`PillarCharge` + `StoryMomentPreload`) |
| `Mirandale Skyline` | `MirandaleSkylineBuilder.Apply` (below) |
| `Sky Rifts (placeholder)` | `RiftSpec` ribbons on a sphere 820 m round the ramp (one main crack from 9° to 74° elevation over the city, 5 branches, 2 loose cracks; widths 130 / 56 / 56 m tapering to 7 m), saved as `Mirandale_RiftCracks.asset` and drawn with `Mirandale_Rift.mat` (`CR/Story/Sky Rift`: a dark void, a hot pink-white rim, a magenta glow); `SkyTear` on the root |
| `Sky Storm` | `SkyStorm` with three strike points left of, beyond and right of the pillar as seen from the ramp, and one thunder source per clip (UGMC `Thunder 5`, `6`, `1`: stand-ins) |
| `Pillar Burst` | at the city centre: `CityLightsOut` (origin `Burst Anchor`, 330 m, 0.9 s, 30 m, 1.6 s), `PillarBurstFeel` (at the anchor) and `RoarOneShots` with its three `Roar_n` emitters (stand-in clips: a creature roar from the Nice Vibrations haptic samples and the Malbers wolf howl) |
| `PillarBurstVfx.prefab` | one child, an instance of `HCFX_Explosion_03` at 10× its size, spawned at `Burst Anchor` |

The assets the builder makes (the rift mesh and material, the burst prefab) are written only when they differ from what the
seed says: `EnsureBurstVfx` loads the saved prefab first and keeps it when it is what the builder would make (one child, the
explosion, at `ExplosionScale`: where it sits and anything a designer added are not compared), so a designer's tweak survives
a rebuild and the nested instance does not churn in git. Materials the builder owns are re-applied on every run.

The rifts, the storm and the roars share the skyline's seed (`Seed` = 1157). `SeededRandom` is SplitMix64, so one seed
gives the same city, cracks and schedule on every runtime and every platform.

### The skyline

`MirandaleSkylineBuilder` (`cr_story_build_skyline --args dry|build`; headless
`-executeMethod CR.Game.Story.Editor.MirandaleSkylineCommands.BuildHeadless` / `DryHeadless`) puts 34 generated low-poly
houses and 5 of the City pack's wall towers on a ring of 120 m round the pillar (houses at 90 to 130 m, towers on the rim at
134 m, a plaza left open under the crystal, nothing on water: the land test is the region mask the vista ground is cut from).
It is seeded, diff-based and idempotent: a second run reports 0 changes and writes nothing; `dry` reports what a build would
do and touches nothing; a scene open with unsaved edits is refused. Drift, strays, missing pieces, a retextured house or a
collider switched back on are each repaired and counted in the `SkylineBuildReport`.

- **Why generated houses.** The pack's complete buildings are 3,500 to 21,000 triangles and 50 to 230 objects each; 25 of
  them would be 5 to 10 times the skyline's whole 60,000-triangle budget (`TriangleBudget`, the Deck). A house here is a
  ~100-triangle silhouette (`HouseShape` / `HouseShapeExtensions.BuildMesh`: 10 variants, 8 to 15 m by 6 to 9 m, 2 to 4
  floors, gable / hip / flat roofs, chimneys) wearing the pack's own plaster, brick and roof-tile materials, saved as
  `Mirandale_House_00..09.asset`; the towers are the pack's `P_MOD_CityWall_03_tower` (500 triangles) at scale 1.35 to
  1.65. The whole skyline is about 4,400 triangles.
- **One window material.** Each house's windows are one submesh on `Mirandale_Windows.mat` (`CR/Story/City Windows`), one
  quad per window carrying its look in vertex colour (~72% lit, ~18% of those cool). The shader reads the three
  `_Mirandale*` globals, so the lights going out is one change for every window and the houses stay static-batched.
- Static-batched, no shadows, no probes; the pack colliders on the towers (and the crystal) are switched off: the vista
  is a picture, not a place.
- The centre (354, 758) is bearing 157° from the balcony at 354 m, which is where the region map puts Mirandale (6a:
  157.4°, 359.6 m). Replace the generated city with an authored one when Mirandale is dressed.

### The Feel prefabs

`PillarShatterMomentBuilder` (`Assets/CR/Core/Feedback/Story/Editor/`, its own asmdef `CR.Core.Feedback.Story.Editor`,
because only the feedback assembly family may reference Feel) builds both prefabs and registers their addresses in the
`CRContent` Addressables group. Idempotent: an existing prefab of the current shape is left alone (a designer may have tuned
it) and only its address is checked; the first version, which held all three feedbacks and played itself, is rebuilt in
place with the same guid. Menu: **CR → Story → Build Pillar Shatter Moment**. Headless:
`-executeMethod CR.Core.Feedback.Story.EditorTools.PillarShatterMomentBuilder.BuildFromCommandLine` (keeps a current prefab) or
`RebuildFromCommandLine` (remakes both from the builder's constants, discarding tuning).

### Looking at it

`cr_story_render_vista` (`MirandaleVistaPreview`; headless `CR_STORY_SHOTS_OUT=<folder> … -executeMethod
CR.Game.Story.Editor.MirandaleVistaPreview.RenderHeadless`, graphics on) renders the beat's states from the ramp to PNGs in
`Temp/MirandaleRenders`: the city lit, the crystal at the end of its charge, the front of darkness half way across, the dark
city under the torn sky, the sky looking up at the rifts, the explosion and a bolt. Each state is put in place the way the
components would settle it (the same shader values, the same sky copy), rendered through a RenderTexture (never a screen
capture), and put back; the scenes are closed unsaved. `cr_story_render_shots` renders the cued shots themselves
([Story Camera → Authoring](?page=unity/40-story-camera)).

After a rebuild: `cr_world_build_corridor --args dry` must report 0 changes, `cr_world_check_corridor` navmesh ok, and the
proxy and validation steps in [Opening Story → Placements](?page=unity/38-story-opening).

## The smoke

`cr_story_smoke_start` (`StorySmokeRunner`, [Opening Story → Play-mode smoke](?page=unity/38-story-opening)) walks onto the
ramp, waits for the conversation to end and the camera to be handed back, then checks: the pillar hidden and the rifts on;
the city dark (`CityLightsOut.IsDark`); the sky fully torn and in view (`SkyTear.Progress` 1.00, `OwnsSky`); three thunder
rolls and no bolt alive; the burst moment started once (`PillarBurstFeel.Started`); three roars; the story camera's shake
gain 1 (0 under Reduced Motion). It then restores every event (`RestorePlayedState`) and checks the dark city and the torn
sky show again with no bolt and **no second ask for the Feel moment**, and after the walk down to the wagon that the torn
sky survived the region change. Each check fails the run where it stands, and `failed` is final.

## Tests

| Where | Tests |
|---|---|
| `CR.Game.Story.Logic.Tests` (pure) | `SkylinePlanTests`, `HouseMeshTests`, `RiftMeshTests`, `PillarChargePlanTests`, `LightsOutWaveTests`, `StormAndRoarPlanTests`, `OneShotLifecycleTests`, `ReducedMotionTests`, `SeededRandomTests`, `GroundPointTests`, `StoryReleaseDeferralTests`, `HoldToSkipTests` |
| `Assets/CR/Tests/Editor` | `PillarBeatTests` (the whole beat through a real `OneShotWorldEvent`: the tear and the storm on their line, the charge and the burst on theirs, the explosion staying up when the pillar goes, a reload showing the dark city and the torn sky and playing nothing, a skip landing on the same end state, Reduced Motion leaving out the shake and the flash), `CityLightsOutTests`, `SkyTearTests` (settle, then a region profile with the original sky: still torn; a blended crossing at its midpoint; another region's sky torn and put back on switch-off; a swap mid-turn; a sky that cannot be torn warns once; another scene's settings untouched until the tear's scene is active; the whole reload then a region change), `SkyStormTests` (one bolt at a time, the trim, no bolt keeps `HS_EffectSound`), `RoarOneShotsTests`, `PillarChargeTests`, `PillarBurstFeelTests`, `StoryMomentPreloadTests`, `ReducedMotionSettingTests`, `StoryCameraShakeGateTests`, `PillarCutsceneBindingsContainerTests`, `StoryBeatCameraHoldTests` (the beat end to end with the real director, cue and event, `s3` arriving while the `s2` prelude is still waiting), `OneShotWorldEventStageTests` (stages bracketed: ran, skipped, failed, owed after the dialogue, a camera that throws), `DialogueScreenPresenterTests` (Cancel ignored while a beat holds the gate) |
| Editor, against the saved content | `MirandaleSkylineBuilderTests` (second run 0 changes; drift, stray, missing, retextured and collider repairs), `MirandaleVistaSceneTests` (stage wiring on the saved scene, the saved city equals what the builder would make, aftermath on reload, sightlines clear), `MirandaleBurstVfxTests` (the committed prefab is current and a vista build leaves it byte for byte), `MirandaleShaderTests`, `PillarShatterPrefabTests` (both prefabs: classes covered by their feedbacks, the settings decisions, flash ≤ 0.3 s on the only light, boom constant, addresses), `StoryFeelBoundaryTests` |
| PlayMode | `FeedbackDirectorPlayModeTests`: `PreloadAsync` (pooled ahead, a play finds it, a caller's cancel does not cancel the load) |

## Not yet checked in play

The beat on a Steam Deck (frame time at the burst; the 60k skyline budget is measured, the bolts' particle cost is not);
the roars' and thunder's mix against the music; the stand-in audio (a storm and monster sound pack is planned: Monster
Sounds Volume II is owned, not imported); Ahksun's Glow in `World_c0_r4` is a second always-on real-time light next to the
pillar's, against the beat's budget of one.
