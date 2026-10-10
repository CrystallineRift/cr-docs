# Game Feel (More Mountains Feel)

Game feel is the layer of small, fast feedback that makes a hit land, a faint hurt and a catch feel earned: a flash
where the blow connects, a held beat at the moment of impact, a pulse in the player's hands. It uses More Mountains
**Feel 5.9.1** (`Assets/Feel`, with Nice Vibrations inside it) and plugs into the feedback bindings.

## Feedback bindings (recap)

[Event wiring](?page=unity/15-event-wiring) turns C# events into Soap event assets. `FeedbackManifest`
(`Assets/CR/Content/Defs/FeedbackManifest.asset`, edited in `CR → Feedback → Feedback Bindings`) answers those assets:
each `FeedbackBinding` names a Soap event and what to do when it is raised: an `sfxAddress`, a `vfxAddress`, an
`anchor` (where in the world), an `animatorTrigger`, and now a `feelPlayerAddress`. `FeedbackDirector` subscribes to
every enabled binding and logs every failure by the binding's note, so silence always explains itself. Anchors resolve
through `SceneFeedbackAnchors`: `Player`, `BattleTargetCreature`, `BattleActorCreature`, `BattleOpponentCreature`,
`MainCamera`.

## The rule: presentation only

Every moment is triggered by a raised event, and a raised event only reports an outcome the authority produced: the
server online, the local domain services offline. Feel never raises a game event, calls a client, writes the
preferences store or derives progress. The only thing a Feel prefab emits is a rumble request that moves a motor.
Two tests hold this: `FeelBoundaryTests` fails if the runtime half of the bridge mentions `.Raise(`, `BattleEvents`,
`IGameDataRepository` or a service, and if any assembly outside `CR.Core.Feedback` references Feel.

A raised event only counts if it reports an outcome. The player's own echo of an intent does not: `CaptureAttempted`
fires the moment they confirm a throw, before the authority has said anything, and the authority may still refuse the
throw. The capture wobble answers `CaptureResolving` instead (see the first ten moments), and `FeelBoundaryTests` fails
if any binding answers `CaptureAttempted`.

## Pieces

| Piece | Where | What it does |
|---|---|---|
| `FeedbackBinding.feelPlayerAddress`, `.intensity` | `Assets/CR/Core/Feedback/` | Which Feel prefab a binding plays, and how strongly (0 to 2, default 1) |
| `CrFeelPlayerInfo` | root of every Feel prefab | Declares the prefab's `FeelMotionClass` so the settings gate knows what to remove |
| `FeedbackDirector` + `FeelPlayerPool` | `Assets/CR/Core/Feedback/` | Preloads each player once, keeps one instance under the director, plays it at the binding's anchor. Every Feel playback goes through it (that is how the settings gate reaches it); it never touches Feel's process-wide `GlobalMMFeedbacksActive`, so disabling it cannot silence a player that was not its own |
| `IFeelMomentPlayer` | `Assets/CR/Core/Feedback/` | The director's direct-play door for a cutscene beat: `PlayAsync("feel/...", position, intensity)`, same pool and same gate, no event binding |
| `IFeedbackIntensityAdapter` | `CR.Core.Feedback.Logic` (engine-free) | Turns what an event carried into an intensity multiplier. First: `HpChangedIntensityAdapter` |
| `IFeelSettings` / `FeelSettingsStore` | `CR.Core.Feedback.Logic` | The player's Reduced Motion, Screen Shake and Rumble. Persisted by `GameDataFeelSettingsPersistence` |
| `HapticsResponder` | `Assets/CR/Game/Feedback/` | The only owner of the rumble motors (Nice Vibrations gamepad support) |
| `MMF_CrRumble` + `CrRumbleSignal` | `Assets/CR/Core/Feedback/` | The rumble feedback Feel moments use; it asks, `HapticsResponder` plays |
| `BattleCameraShakeResponder` | `Assets/CR/Game/Battle/Arena/` | Still the one owner of battle camera shake; now scaled by the Screen Shake setting |
| `CaptureThrowWatcher` + `CaptureThrowVerdict` | `Assets/CR/Game/Battle/` (the verdict is engine-free, in `Logic/`) | Follows the player's one pending crystal throw and raises `CaptureResolving` (ahead of the verdict) and `CaptureFailed` from the authority's outcome for it; a refused throw raises neither. Owned by the bag panel, the one place that knows the item was a crystal |
| `FeelMomentBuilder` + `FeelMoments` | `Assets/CR/Core/Feedback/Editor/` | Builds the moment prefabs from a table and registers their addresses |
| `FeelPlayerInspector` | `Assets/CR/Core/Feedback/Editor/` | Reads a prefab for the validator and the bindings window |

`CR.Core.Feedback` references `MoreMountains.Tools` and `Lofelt.NiceVibrations`; no other assembly does, and no source
outside `Assets/CR/Core/Feedback` names a Feel namespace.

## Motion classes and the settings gate

A Feel prefab declares one class. The gate is a pure function in `CR.Core.Feedback.Logic` (`FeelSettingsExtensions`),
tested without Unity.

| Class | What it is | Reduced Motion | Screen Shake | Rumble setting |
|---|---|---|---|---|
| `Cosmetic` | Lights, tints, particles, rumble pulses | plays smaller (intensity capped at 0.3) | | |
| `CameraMotion` | Impulses, shakes, zooms | removed | 100 / 50 / 0 % | |
| `ScreenFlash` | Full-screen flashes, bloom/chromatic pulses | removed | | |
| `TimeScale` | Hit stop, slow motion | removed | | |
| `Haptic` | Device rumble played by the prefab itself | | | removed |

Reduced Motion never touches sound or rumble. A moment is suppressed or played smaller; the outcome it decorates is
never hidden. The director logs why a moment was muted, at Debug.

`FeelFeedbackClassifierExtensions` sorts Feel feedback types by name into those classes. The validator uses it to hold
a prefab's declaration against its feedbacks (a freeze frame in a `Cosmetic` prefab is a problem; declaring *more* than
the prefab does is fine), and the pool falls back to it, with a warning, for a prefab that declares nothing. A prefab
that mixes device rumble with screen or time motion cannot be gated by one class and is reported.

## Intensity

```
played at = clamp( binding.intensity × payload multiplier × settings scale, 0, 2 )
```

* **Payload multiplier.** `HpChangedData` now carries `Damage`, the HP the authority reported the action took off. The
  multiplier is 0.5 for a scratch, 1.0 at 30% of max HP (the heavy-hit threshold), 2.0 from 90%, a straight line
  between (`HitMagnitude`). A payload without damage is neutral.
* **Settings scale.** From the gate above; under Reduced Motion a `Cosmetic` moment is also held to 0.3.

## Rumble

`VibrationLight / Medium / Strong` have been raised by the battle for a long time (impacts, faints, captures, a
creature's own reaction tier) with nothing listening. `HapticsResponder` now drives Nice Vibrations' light, medium and
heavy impact presets on the current gamepad, and also answers `MMF_CrRumble` pulses from Feel moments.

* **Gated** by the Rumble setting, at request time and again at play time.
* **Merged.** One hit raises several signals in a frame; they collapse to the strongest, and a pulse inside 80 ms of the
  last is dropped unless it is stronger (`RumbleCoalescer`, on unscaled time so a hit stop does not stall it).
* **Reset.** The motors stop on application pause, on focus loss, when a battle closes, when Rumble is switched off and
  when the responder is destroyed.

Do not put Feel's own haptics feedbacks (`MMF_NV*`) in a moment: they talk to the device directly, bypassing all of the
above, and compile only when a build-profile define is present.

## Settings

System, Game: **Reduced Motion** (off), **Screen Shake** (100 / 50 / 0 %), **Rumble** (on). They are stored with Combat
Speed in the local preferences store under `reduced_motion`, `screen_shake_level` and `rumble_disabled`, each shaped so
that an unset key reads as its default. They are presentation preferences: nothing about them is sent anywhere. A change
applies to the very next hit.

The Reduced Motion hint reads "Removes screen shake and hit stop, and softens light flashes. Sound and rumble stay." on
purpose: the moments' lights are `Cosmetic`, so under Reduced Motion they play at no more than 0.3 intensity rather than
off; only camera motion, screen flashes and hit stop are removed.

## Anchors for battle moments

`BattleTargetCreature` is whoever was last cast at, which after the opponent's turn is the Seeker's own creature, so a
capture anchored on it lit the wrong creature. `BattleOpponentCreature` is the creature being fought or caught, whoever
acted last; the capture moments and the capture celebration binding use it. `SceneFeedbackAnchors` also learns the
actor, target and opponent when a battle opens and on a switch-in, so a first action that is not an ability (a thrown
shard) has somewhere to play and one battle's ids never reach the next.

## The first ten moments

Prefabs live in `Assets/CR/Content/Feel` and are Addressable under `feel/`.

| Address | Answers | Class | Made of |
|---|---|---|---|
| `feel/hit-normal` | `CreatureHit` | Cosmetic | warm flash, 0.12 s |
| `feel/hit-heavy` | `HeavyHit` | TimeScale | 50 ms hit stop, hot flash |
| `feel/faint` | `CreatureFainted` | TimeScale | 60 ms hit stop, cold light draining |
| `feel/capture-wobble` | `CaptureResolving` | Cosmetic | three ticks of light and light rumble |
| `feel/capture-fail` | `CaptureFailed` | Cosmetic | red-orange puff, medium rumble |
| `feel/capture-success` | `CreatureCaptured` | TimeScale | 60 ms hit stop, golden flash |
| `feel/level-up` | `LevelUp` | Cosmetic | rising golden glow around the Seeker, light rumble |
| `feel/quest-turn-in` | `QuestRewardsDispatched` | Cosmetic | warm glow, medium rumble |
| `feel/item-use` | `ItemHpRestored`, `ItemStatusCured`, `ItemCreatureRevived`, `ItemStatBoosted` | Cosmetic | soft green glow, light rumble |
| `feel/status-applied` | `StatusApplied` | Cosmetic | violet tint pulse |

`HeavyHit` is raised by the battle bus but had no Soap event asset, so nothing could answer it. It now has
`Events/HeavyHit.asset`, an `EventWiringManifest` entry and a regenerated `GeneratedEventWiringBridge`;
`FeelWiringTests` fails if any of the three is missing.

`CaptureResolving` is new as well. `BattleCoordinator.PlayStepsAsync` raises `BattleEvents.ActionResolving` for each
resolved step before it is presented (the lead-in to `ActionResolved`), and `CaptureThrowWatcher` watches for the
player's own Item step at the creature they threw at: if the authority took the throw it raises `CaptureResolving`
ahead of the verdict, and if the creature then got away it raises `CaptureFailed`. It has `Events/CaptureResolving.asset`,
an `EventWiringManifest` entry and a regenerated bridge (`FeelWiringTests` covers all three). The player's outcome
carries no item id, so the match is the player's Item step at that creature (`CaptureThrowVerdict`).

Sound and the existing effects stay on the bindings (`sfxAddress`, `vfxAddress`). A creature's body language (scale
punch, flash, animation) stays on `CreatureBattlePresenter`, and a moment never writes a creature's transform. The
capture wobble plays once the authority has taken the throw, just ahead of its verdict, and asserts nothing about it;
a throw the authority refuses wobbles nothing.

### Authoring

* `CR → Feedback → Build Feel Moments` makes the prefabs from the table in `FeelMoments.cs`, skipping any that exist, and
  registers each address in the `CRContent` group. `Rebuild Feel Moments (overwrite)` remakes them. Headless:
  `-executeMethod CR.Core.Feedback.EditorTools.FeelMomentBuilder.BuildFromCommandLine`.
* `CR → Feedback → Feedback Bindings` has a **Feel player** picker and a **Feel intensity** slider on every binding, and a
  line under the picker saying what the prefab declares and whether that covers its feedbacks. **Validate** also checks
  every Feel prefab and every intensity.
* The numbers in `FeelMoments.cs` are AI-drafted tuning, listed in the [AI content ledger](?page=content/01-ai-content-ledger).

## Steam Deck budget

| Limit | Value | Enforced by |
|---|---|---|
| Post-processing shakers across all moments | 2, bloom and chromatic aberration only (the first set uses none) | `FeelMomentContentTests` |
| Hit stop | 60 ms each, 120 ms per resolved action (an impact plus the faint it causes, 50 + 60 ms; a catch stands alone), none under Reduced Motion | content tests; the `TimeScale` class |
| Per moment | one light, no particle system, at most 8 feedbacks | content tests |
| Start cost of a moment | 0.25 ms | the director times each `PlayFeedbacks` call: Profiler marker `CR.Feel.PlayFeedbacks`, a once-per-address warning in a player build |

The hit-stop total is a per-action cap, not a per-round one, and it holds by construction: only the heavy-hit, faint and
capture-success moments freeze time, each answers an event the battle raises at most once per action (`HeavyHit`,
`CreatureFainted`, `CreatureCaptured`), and the content tests fail if another moment freezes time or a stop is bound
to any other event. A round is two actions, so it can hold more (a heavy hit, then the opponent's heavy hit that
faints your creature, is 160 ms); the director does not total a round at runtime, and the beats between the actions
keep those stops apart.

## Not done yet

* **Critical hit and super-effective.** No battle event carries either and the server does not report them: `ActionOutcome`
  has no crit flag (the resolver has no crit mechanic) and no type effectiveness, only `ReactionName` and
  `ReactionBonusDamage`. cr-api work: `BattleResolver` reports the `typeMultiplier` it applied, `BattleDomainService` copies
  it onto `ActionOutcome` (as `TypeEffectiveness`, and `IsCritical` once a crit mechanic exists), the REST DTO passes both
  through; then the client raises `SuperEffectiveHit` / `CriticalHit` from the outcome. The client must not derive either
  from HP numbers.
* **The pillar burst** is authored by the pillar cutscene lane and played from the cutscene's second stage. Give its root
  a `CrFeelPlayerInfo` (`CameraMotion`) and play it through `IFeelMomentPlayer.PlayAsync`, so it shares the pool and the
  Reduced Motion / Screen Shake gate.
* **Feel's demo folders** (about 340 MB, compiled into the runtime assembly through asmrefs) are still in `Assets/Feel`.

## Tests

| Test | Covers |
|---|---|
| `FeelSettingsGateTests`, `FeedbackIntensityTests`, `FeelFeedbackClassifierTests`, `RumbleCoalescerTests`, `FeelSettingsStoreTests`, `FeedbackBindingValidatorTests` | The engine-free rules (Logic) |
| `GameDataFeelSettingsPersistenceTests`, `HpChangedIntensityAdapterTests`, `HapticsResponderTests`, `SceneFeedbackAnchorsTests`, `FeelWiringTests` | The game layer |
| `FeelMomentContentTests`, `FeelBoundaryTests`, `FeedbackBindingsWindowTests` | The saved prefabs, the boundaries, the authoring window |
| `GameFeelBindingsContainerTests` | Zenject resolves the Feel bindings exactly as the installer binds them |
| `CaptureThrowVerdictTests`, `CaptureThrowWatcherTests` | Which outcome is the player's own throw, and that only the outcome cues the wobble and the broke-free cue (a refused throw cues neither; the throw itself cues nothing) |
| `BattleCoordinatorActionSeamTests` | `PlayStepsAsync` announces each step before presenting it and resolves it after, so the wobble leads the catch and the miss |
| `FeedbackDirectorPlayModeTests` | A raised event plays its Feel player exactly once; Reduced Motion and Screen Shake gates; payload scaling; a disabled director plays nothing but leaves Feel's global switch and other players alone; direct plays; and the real authored prefabs through the real director (hit stop holds time and lets go, the flash lights and goes dark, the wobble asks for three light rumble pulses) |
