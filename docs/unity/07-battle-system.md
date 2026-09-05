# Battle System

The battle system connects scene-level events (NPC interaction, wild encounter triggers) to the server-side battle engine via a REST API. `BattleCoordinator` is the single entry point for all battle initiation in the Unity client. All battle state is DB-backed on the server — see [Battle Persistence](?page=backend/09-battle-persistence) for the backend detail.

## Battle Types

| Type | Status | Entry Point |
|------|--------|-------------|
| NPC Trainer | Implemented | `NpcInteractionBehaviour` E-press → `BattleCoordinator.StartNpcBattle` |
| Wild Creature | Implemented | `SpawnerEncounterBehaviour` trigger → `BattleCoordinator.StartWildBattle` |
| PvP | Future | Networking not yet implemented |

## `BattleCoordinator`

`BattleCoordinator` is a MonoBehaviour singleton bound via `BindInterfacesAndSelfTo<BattleCoordinator>()` (the concrete type is required by the event wiring manifest to subscribe to its `OnBattleStarted`/`OnBattleEnded`/`OnBattleClosed` events). It is the only component that may call `IBattleDomainService` to start a battle or drive the turn loop. Scene components inject `IBattleCoordinator` — never the concrete class.

### Resolution vs Close — two lifecycle moments

- `EndBattle(winner, reason)` marks the battle resolved and raises `OnBattleEnded` / `BattleEvents.BattleEnded`. The arena is **not** exited; the post-battle summary screen shows.
- `CloseBattle()` is called by `BattleSummaryScreen` on OK (or auto-dismiss for `ran_away`). Restores camera + trainer position via `BattleStager.ExitArenaAsync` and raises `OnBattleClosed` / `BattleEvents.BattleClosed`.

Gameplay systems (input gates, ambient audio) release on `BattleClosed`, not `BattleEnded`, so the world doesn't unlock behind the summary modal.

### Installer Binding

```csharp
// LocalDevGameInstaller.cs — battle stack
var gameDatabaseCs = connectionStringFactory.GetConnectionStringForRepository(LocalDataSources.GameOfflineRepository);
var battleRepo     = new CR.Game.Data.Sqlite.BattleRepository(logger, gameDatabaseCs);
Container.Bind<CR.Game.Data.Interface.IBattleRepository>().FromInstance(battleRepo).AsSingle();

// IBattleDomainService routes to HTTP (online) or DLL BattleDomainService (offline)
Container.Bind<IBattleDomainService>().WithId("battle_online") .To<BattleHttpDomainAdapter>().AsSingle();
Container.Bind<IBattleDomainService>().WithId("battle_offline").To<BattleDomainService>().AsSingle();
Container.Bind<IBattleDomainService>().To<OnlineOfflineBattleDomainService>().AsSingle();

Container.Bind<IWildBattleAIDomainService>().To<WildBattleAIDomainService>().AsSingle();

Container.Bind<IBattleCoordinator>()
    .To<BattleCoordinator>()
    .FromNewComponentOnNewGameObject()
    .AsSingle();

Container.Bind<IBattleArenaRegistry>().To<BattleArenaRegistry>()
    .FromNewComponentOnNewGameObject().AsSingle();
Container.Bind<IBattleCameraController>().To<BattleCameraController>()
    .FromNewComponentOnNewGameObject().AsSingle();
```

### Public API

```csharp
public interface IBattleCoordinator
{
    event Action<BattleSession> OnBattleStarted;
    event Action<BattleResult>  OnBattleEnded;

    void StartNpcBattle (NpcBattleRequest  request);
    void StartWildBattle(WildBattleRequest request);

    /// Resolves the pending player turn. Call from HUD when player picks an action.
    void SubmitPlayerAction(string actionJson);
}
```

### Events

| Event | Payload | When it fires |
|-------|---------|---------------|
| `OnBattleStarted` | `BattleSession` | After `IBattleDomainService.StartBattleAsync` returns and the arena is activated |
| `OnBattleEnded` | `BattleResult` | After the turn loop ends (win/loss/draw/escape) |

### Static `BattleEvents`

`BattleEvents` is a static class in `CR.Game.Battle.Events` that fires events for animation and HUD updates during the sequential turn loop.

| Event | Signature | Description |
|-------|-----------|-------------|
| `BattleStarted` | `(string battleId, string activeTrainerId)` | Battle started, first active trainer set |
| `PlayerTurnStarted` | `(string activeCreatureId, List<WildAbilityDto> abilities)` | HUD should show action menu with ability list |
| `CreatureAttacking` | `(string creatureId, string attackClip)` | Play attack animation |
| `CreatureHit` | `(string creatureId, int damage)` | Display damage number |
| `HpChanged` | `(string creatureId, int finalHp, int maxHp)` | Update HP bar |
| `CreatureFainted` | `(string creatureId)` | Play faint animation |
| `CreatureRecalled` | `(string creatureId)` | The outgoing creature is being recalled ("collected back") — play its recall beat |
| `CreatureWithdrawn` | `(string creatureId)` | The recall effect finished — despawn the body (consumed by `BattleStager`) |
| `CreatureSwitchedIn` | `(bool isPlayer, string newCreatureId)` | Send out the incoming creature (stager spawns it at the side anchor with a pop) |
| `PlayerMustSwap` | `(string trainerId)` | Player's active creature fainted but has a backup; HUD must force a swap |
| `BattleEnded` | `(bool playerWon, string outcomeLabel)` | Show result screen |
| `RunAttempted` | `(bool success)` | Show escape message |
| `ActionResolved` | `(ActionOutcome outcome)` | Every resolved action, raised once per turn **after** its presentation has played. The outbound seam for battle extensions — see [Battle Extensions](?page=unity/24-battle-extensions) |
| `MissionProgressed` | `(string missionName, int current, int threshold)` | An in-battle mission ticked forward (e.g. applying Burn); HUD shows a fading progress toast |
| `MissionCompleted` | `(string missionName, string unlockedAbilityName)` | An in-battle mission finished and unlocked a move for the rest of the battle; HUD shows a completion banner |

#### A subscriber that throws is not the battle's problem (`IsolatedDispatch`)

Every `Raise*` helper goes through `IsolatedDispatch.Invoke` (`CR.Game.Battle.Logic`, engine-free,
pinned by `IsolatedDispatchTests`) instead of `X?.Invoke(...)`. It walks the event's invocation
list one handler at a time: a handler that throws is reported to a fault sink — `BattleEvents`
logs `[BattleEvents] {event} handler {Type}.{Method} threw: …` via `Debug.LogError` — and the
handlers after it still run. The raiser (usually the `BattleCoordinator` turn loop) never sees the
exception.

The reason it exists: a plain multicast invoke stops at the first throw and hands the exception
to whoever raised it. A UI listener once threw out of `RaiseBattleStarted`, the coordinator's
catch logged only `ex.Message`, and the wild battle ended `loop_complete` before turn 1. The
log line now names the offending subscriber, and a broken listener costs only its own
notification.

## Wild Battle Turn Loop

Wild battles drive a sequential turn loop entirely client-side. The server resolves each half-turn via a dedicated endpoint.

```
StartBattleAsync
    └─ if activeTrainer == player
           RaisePlayerTurnStarted → await SubmitPlayerAction()
           IBattleDomainService.SubmitActionAsync → ActionOutcome
       else
           IWildBattleAIDomainService.DecideActionAsync → submit via IBattleDomainService
           IBattleDomainService.SubmitActionAsync → ActionOutcome
    └─ await IBattlePresentationSequencer.PlayOutcomeAsync(outcome, action, ctx)   ← paced beats
    └─ RaiseActionResolved(outcome)                                               ← extension seam
    └─ if outcome.BattleEnded → RaiseBattleEnded → break
       else advance activeTrainerId (Guid) + NextRoundKey
```

The loop **awaits** the sequencer, so an outcome's beats finish playing before the next turn resolves (see [Presentation Orchestrator](#presentation-orchestrator)).

### Extension seams

The loop exposes exactly two hooks for systems that react to combat without being combat (missions, combo meters, style scoring):

- **Outbound** — `BattleEvents.ActionResolved` is raised right after `PlayAndReconcileAsync`, so a reaction lands after the hit it reacts to.
- **Inbound** — `_abilityAugmenter?.Augment(activeCreatureId, abilities)` runs between `BuildAbilityListAsync` and `RaisePlayerTurnStarted`, on player turns only. It is injected `[InjectOptional]`, so battles run unchanged when nothing is bound.

Neither seam can alter how an action resolves. See [Battle Extensions](?page=unity/24-battle-extensions) for the pattern and the battle-missions worked example.

`SubmitPlayerAction(string actionJson)` is called by the HUD (or any input handler) to unblock the `TaskCompletionSource` awaited in the loop. The action JSON matches the backend's action format, e.g. `[{"type":0,"abilityId":"...","targetCreatureId":"..."}]`.

The wild trainer GUID is `00000000-0000-0000-0000-000000000001` (defined in `WildTrainerIds.WildTrainerId`).

## Presentation Orchestrator

The backend `ActionOutcome` is authoritative for *what happened*; `BattlePresentationSequencer` (in `CR.Game.Battle.Presentation`, bound `IBattlePresentationSequencer`) decides *how it is played*. It converts one outcome into an ordered, timed **beat sequence** and raises the existing `BattleEvents` one phase at a time, so combat flows instead of firing every signal on one frame.

`BattleBeatPlan.Build(BeatInput)` (pure, in `CR.Game.Battle.Logic`, unit-tested) yields the phase order:

```
Resolve → Strike → Impact/Miss → Faint → Recall → SendOut → Aftermath → TurnEnd
```

- **Ability** outcomes plan `Resolve, Strike` then `Impact` (hit) or `Miss`.
- A **faint** appends `Faint` then `Recall` (the fainted creature) — unless the battle ended.
- A **Switch** plans `Recall` (outgoing) then `SendOut` (incoming).
- Status/XP/level-up are grouped into `Aftermath`.

**Send-out without a server round-trip.** `ActionOutcome` does not carry the incoming creature id; the submitted **action** does (`BattleAction.NewCreatureId`). The coordinator parses it from the action JSON and passes it via `SideContext`, so the swap plays immediately. The old state-diff `ReconcileActiveVisuals` is retired.

**Recall is an injected effect with a completion event.** `RecallEffect` (default `ScaleDissolveRecallEffect`, bound via DI, single reused instance) plays the creature's exit and raises `Completed`; the sequencer waits on that event — with a hard **timeout** so a misconfigured effect can never freeze the turn loop — then raises `CreatureWithdrawn` (stager despawns) and, for a switch, `CreatureSwitchedIn` (stager spawns the incoming creature with a scale-up pop). The default needs no art or prefab; swap the bound `RecallEffect` to upgrade the visual.

**Threading.** The sequencer runs the beats as a coroutine (all `WaitForSeconds`/effect-waits on the Unity main thread, matching `BattleCinematicDirector`); the async loop awaits a `Task` the coroutine completes via `TaskCompletionSource` (created with `RunContinuationsAsynchronously` — the battle loop must never resume inline inside a coroutine frame or a UI click's callstack). No `Task.Delay`, no background threads — non-blocking, no stutter.

**Loot display.** The battle-ending outcome's `LootAwards` (rolled + granted server-side on a
wild win — currency and items) are raised one-per-grant as `BattleEvents.LootAwarded` during the
aftermath beat. `BattleSummaryScreen` accumulates them and renders the ITEMS RECEIVED section via
pure `LootSummaryFormat`: one summed Currency row, then items alphabetically with ×quantity and
humanized content keys. No drops → "No items found." stays.

**Player-configurable pacing (Combat Speed).** The authored beat durations are scaled by the
persisted `battle_pacing_scale` multiplier (`GameConfigurationKeys.BattlePacingScale`, clamped
0.5–2.5; 1 = authored, higher = slower). The sequencer re-reads it at every `ResetForNewBattle`,
so changing it applies from the next battle. Players set it via the pause menu **System ▸ Combat
Speed** dropdown (Fast 0.75× / Normal 1× / Relaxed 1.4× — the System card's first functional
setting, `PlayerMenuWindow.WireCombatSpeedSetting`). Automation can set it with the
`cr_set_combat_speed --scale <x>` pipeline command.

**Battle framing (zoom).** `BattleCameraProfile.fovWidenMultiplier` (default **1.15**) widens
every rig vcam's FOV while in battle — applied by the director on `EnterBattle`, authored lens
restored on `ExitBattle` — so the whole exchange reads without re-authoring per-shot framing.
Set it to 1 for the rig's exact authored lenses.

## Force-Swap on Faint

When the player's active creature faints but the team still has an alive backup, the server keeps the battle Active and returns `ActionOutcome.NeedsSwap = true` (see [Battle Persistence — Force-Swap on Faint](?page=backend/09-battle-persistence)). The client turns this into a forced swap rather than ending the battle.

**Event flow:**

```
BattleCoordinator (outcome.NeedsSwap && outcome.NextActiveTrainerId == playerTrainerId)
    └─ BattleEvents.PlayerMustSwap(trainerId)
       └─ BattleEventsAdapter re-emits
          └─ EventWiringManifest routes to Soap SO PlayerMustSwap.asset (ScriptableEventString)
             └─ BattleHUD consumes via [Inject(Optional = true, Id = EventChannelIds.PlayerMustSwap)]
```

`BattleCoordinator` only raises `PlayerMustSwap` when `outcome.NeedsSwap` is set **and** `outcome.NextActiveTrainerId` is the local player's trainer ID (a wild/NPC opponent swaps server-side).

On the event, `BattleHUD` **force-enters Swap mode**:

- The player must pick a backup creature or Run — the swap panel cannot be dismissed (no back-out).
- While the swap is forced, the panel's back button becomes a **Run** button.
- Selecting a creature submits a Switch action: `[{"type":3,"newCreatureId":"<guid>"}]`.

## Whiteout on Team KO

When the player's **whole team** is knocked out the battle resolves as a loss (after force-swap-on-faint, a loss only happens once every team creature is down). `PlayerWhiteoutHandler` — a pure-DI listener on `IBattleCoordinator` end/close events (no scene object, bound `NonLazy` in `LocalDevGameInstaller`) — owns this path. `BattleSummaryScreen` skips the defeat recap when `BattleOutcome.IsPlayerLoss(result, playerTrainerId)` is true, so the whiteout drives the moment instead.

Sequence:

1. **`OnBattleEnded`** → `"{name} passed out!"` (trainer name via `ITrainerDomainService`), then `CloseBattle()`.
2. **`OnBattleClosed`** (arena already restored) → heal the team → teleport the player to the merchant → `"Your team was healed."`

The heal is **routed by connectivity**: online it POSTs the BFF's
`POST /api/v1/trainers/{trainerId}/team/heal` via `ITeamClient`/`TeamClientUnityHttp`
(current HP is server-authoritative in `generated_creature_current_stats` — the earlier in-process
`ICreatureInventoryService.HealTeamAsync` call only wrote the client's local cache online, so the
next server read reset the team straight back to 0 HP); offline it still calls the in-process
domain service, which owns the local store. The endpoint enforces token-account ownership of the
trainer.

The heal + teleport run on `OnBattleClosed` (not `OnBattleEnded`) because the arena stager restores the player to the pre-battle position synchronously inside `CloseBattle`; running after that restore means the merchant teleport lands last and sticks. Teleport moves `TrainerWorldBehaviour` → `NpcMerchantBehaviour` (both resolved via `WorldRegistry`) — the same transform the stager moves.

`MessageDialog` (`Assets/CR/UI/Common/MessageDialog.cs`, USS in `Resources/MessageDialog.uss`) is a self-spawning awaitable UI Toolkit modal that reuses a scene `PanelSettings`, so the whiteout needs **no new scene wiring**.

## Experience

XP is awarded **server-side** on a knockout (see *Battle Experience* on the backend battle-persistence page for the 90/10 fighter/bench split and EXP-share). `BattleCoordinator.FireOutcomeEvents` reads `ActionOutcome.ExperienceAwards` and raises `BattleEvents.ExpGained(creatureId, amount, leveledUp)` (plus `LevelUp` when a creature levels). The **battle summary** collects these into its XP section and "LEVEL UP" chip — the client does no XP math, it only renders what the outcome reports.

## `BattleSession`

`BattleSession` is the payload of `OnBattleStarted`. It is a snapshot — it does not update as the battle progresses.

| Field | Type | Notes |
|-------|------|-------|
| `BattleType` | string | `"ONEvONE"` etc. |
| `PlayerTrainerId` | Guid | The local player's trainer ID |
| `OpponentTrainerId` | Guid | The NPC or wild trainer ID |
| `PlayerTurnKey` | string | Round key for round 1 — stored on the session but superseded by `ActionOutcome.NextRoundKey` from each `SubmitActionAsync` response as the loop advances |
| `Kind` | `BattleRequestKind` | `NpcTrainer`, `Wild`, or `PvP` |

## `BattleResult`

`BattleResult` is the payload of `OnBattleEnded`.

| Field | Type | Notes |
|-------|------|-------|
| `WinnerTrainerId` | Guid? | Null on draw or forfeit |
| `Reason` | string | `"AllCreaturesFainted"`, `"Forfeit"`, `"loop_complete"`, etc. |

On a trainer win the banner subtitle reads `Beat Trainer {DisplayName}` (`BattleOutcomeSubtitle.For`, fed by `BattleResult.DefeatedNpcDisplayName`); otherwise it echoes the reason in caps.

## `IBattleDomainService` (Unity-side)

`BattleCoordinator` injects `IBattleDomainService` — the same DLL interface the backend implements. Online calls are routed through `BattleHttpDomainAdapter` (HTTP to the REST API); offline calls go directly to the DLL's `BattleDomainService` backed by the local `game.bytes` SQLite file.

`OnlineOfflineBattleDomainService` selects the active implementation from `IGameDataRepository.IsPlayingOnline` at call time — no restart needed to switch modes.

The HTTP base URL is read from `game_config.yaml` via `GameConfigurationKeys.BattleServerHttpAddress`.

## Arena System

`BattleArena` is a MonoBehaviour placed in scenes to define a battle location.

| Inspector Field | Type | Description |
|-----------------|------|-------------|
| `arenaKey` | string | Must match `SpawnerWorldBehaviour._battleArenaKey` / `SpawnerDefinition.battleArenaKey` |
| `playerTrainerPosition` | Transform | Where the player trainer stands |
| `opponentTrainerPosition` | Transform | Where the opponent trainer stands |
| `playerCreaturePosition` | Transform | Where the player's active creature spawns |
| `opponentCreaturePosition` | Transform | Where the opponent's active creature spawns |
| `cameraLookTarget` | Transform | Center the cinematic camera orbits/frames (falls back to the midpoint of the lead slots) |
| `cameraRig` | `BattleCameraRig` | The authored cinematic rig for this arena (role vCams + target group + impulse). Empty → camera stays on the overworld |
| `playerCreatureSlots` / `opponentCreatureSlots` | `List<Transform>` | Optional per-side stand points for 2v2/NvN/boss; empty → the single creature position above is slot 0 |
| `defaultBiome` | `BiomeType` | The biome active when the arena awakens |
| `biomes` | `BiomeEnvironment[]` | Maps each `BiomeType` to a root `GameObject` to activate/deactivate |

`BiomeType` enum values: `Grassland`, `Forest`, `Cave`, `Desert`, `Mountain`, `Beach`, `Swamp`, `Tundra`, `Volcanic`.

`BattleArena.Activate(BiomeType? biome)` activates the arena at the given (or default) biome. `SetBiome(biome)` can be called at any time to swap active environment roots. `Deactivate()` hides all environment roots.

Use **CR > Battle > Create Placeholder Arena** (editor menu) to scaffold a new arena GameObject with all child transforms pre-wired and `arenaKey` set to `"arena_placeholder"`.

### `BattleArenaRegistry`

`BattleArenaRegistry` exposes `IBattleArenaRegistry.TryGetArena(key, out arena)`. Arenas **self-register** via a static dictionary — `BattleArena.OnEnable` calls `BattleArenaRegistry.RegisterArena(this)` and `OnDisable` removes it. No `FindObjectsOfType` scan, no `IWorldInitializable` dependency, no timing coupling to `GameInitializer.RunAsync`. Arenas loaded into additive scenes after world init are picked up automatically.

### Cinematic Camera (`BattleCinematicDirector`)

The battle camera is a **reactive, editor-authored Cinemachine 3 system**. `BattleCinematicDirector` (the conductor, bound as `IBattleCameraController`) listens to the `BattleEvents` cues the coordinator already raises and, per beat, picks a **shot role** and aims the matching authored virtual camera at the right anchors. It owns no framing and no shake — those live in the editor-authored rig and a decoupled responder.

| Type | Role |
|------|------|
| `BattleCinematicDirector` | Conductor. Subscribes to `BattleEvents` in `OnEnable`/`OnDisable`, gated on `_inBattle`. Resolves the attacker side from `TurnStarted.isPlayer` (swap-safe), enables exactly one role vCam at a time and sets its `Follow`/`LookAt`, runs the idle orbit + intro radius ease, and overrides the Brain's blend. `EnterBattle(BattleArena)` / `ExitBattle()`. |
| `BattleCameraRig` | Editor-authored prefab: one `CinemachineCamera` per `BattleCameraRole` (`Establishing`, `Action`, `Reaction`, `LowAngle`, `Hero`), a `CinemachineTargetGroup`, a `CinemachineImpulseSource`, and a `BattleCameraProfile`. Assigned to `BattleArena.cameraRig`. |
| `BattleCameraProfile` | ScriptableObject of feel values (blend seconds, action/faint holds, orbit °/s, intro radius multiplier, shake force). Persists across Play-mode tuning; framing lives on the vCams. |
| `BattleFormation` | Maps the live battle onto arena slot anchors (`AttackerAnchor`/`DefenderAnchor`/`AllActiveAnchors`). 1v1 today; shaped for NvN / N-v-1. |
| `BattleCameraShakeResponder` | Decoupled shake. Reacts to `CameraCueDefender`/`HeavyHit`/`CameraCueFaint`, coalesces same-frame signals into one force-scaled impulse, fires the rig's impulse source. Reaches the active rig via the shared `BattleCameraRigContext`. |
| `ScreenFader` | Full-screen white overlay (code-built top-most UGUI canvas, no prefab) that **masks the camera cut** into and out of battle. The coordinator awaits `FadeAsync(target, seconds)` around staging/`EnterBattle` and around `CloseBattle`'s teardown. |

**Battle in/out transition (fade-masked cut).** Rather than easing the camera back to the player on exit, the coordinator fades to white (`~0.3s`), then switches the camera under the cover. On entry: fade to white → stage + `EnterBattle` → fade from white (the intro sweep plays as it clears). On exit: fade to white → `ExitBattle` (which now sets the Brain blend to **`Cut`** for an instant snap back to the player, restoring the overworld's saved blend a frame later) + arena teardown → fade from white onto the overworld. Applies to both wild and NPC battles.

**Beat → shot role**

| Cue | Shot |
|-----|------|
| `CameraCueIntro` | `Establishing` — wide sweep eased into a slow idle orbit |
| `TurnStarted(isPlayer)` | sets attacker side; the first turn ends the intro |
| `CameraCueAttacker` | `Action` — over-shoulder behind the attacker, looking at the defender |
| `CameraCueDefender` / `HeavyHit` | shake (responder); framing holds on the action |
| `CameraCueFaint` | `LowAngle` on the faller + heavy shake |
| `CameraCueVictory` / `CameraCueCapture` | `Hero` — rises on the player's creature |
| `TurnEnded` | settle back to idle (backstop) |

**Camera ownership / handoff.** The `MainCamera` already carries a `CinemachineBrain`; Malbers drives the overworld transform directly (the Brain is dormant with no live vCam). Enabling a battle vCam makes the Brain blend to it; `ExitBattle` disables them all so the Brain goes dormant again and the overworld resumes (a saved-pose restore is the no-Brain safety net). The director keeps **one** vCam live at a time and sets a short blend from the profile (the Brain default is 2s — too slow for cuts). It never writes `Camera.main` during battle (that fought the Brain — the reason the old static camera looked dead).

**Authoring is first-class.** `CR → Battle → Build Camera Rig Prefab` scaffolds a complete, working rig (five role vCams with framing, target group, impulse source, per-vCam listeners, profile). The `BattleCameraRig` Inspector adds **Preview Shot** / **Preview Formation** (1v1/2v2/N-v-1), scene gizmos, and **drift detection with one-click fixes** (missing role cam, missing impulse listener, no Brain on Main Camera). `CR → Battle → Camera Director Simulator` fires the real cues so you can dry-run the entire choreography with **no real battle** — Begin Sim Battle in Play mode, then click the beats. Rigs are prefabs: committable and revert-safe.

### `IBattleStager`

Owns the visual side of arena entry/exit. `BattleCoordinator` calls it in step 5 of `StartWildBattleAsync` / `StartNpcBattle` after the arena is resolved.

```csharp
public interface IBattleStager
{
    Task<BattleStagingResult> EnterArenaAsync(
        BattleArena arena,
        Guid playerTrainerId,
        Guid opponentTrainerId,
        Guid playerCreatureId,
        Guid opponentCreatureId,
        CancellationToken ct = default);

    Task ExitArenaAsync(CancellationToken ct = default);
}

public readonly struct BattleStagingResult
{
    public bool PlayerTeleported       { get; init; }
    public bool PlayerVisualSpawned    { get; init; }
    public bool OpponentVisualSpawned  { get; init; }
}
```

`BattleStager` (default impl, bound `FromNewComponentOnNewGameObject` in `LocalDevGameInstaller`):

| Stage | What happens |
|-------|--------------|
| **Player teleport** | Finds the active `TrainerWorldBehaviour` via `WorldRegistry`, caches its origin transform, moves it to `arena.PlayerTrainerPosition`. Origin restored on `ExitArenaAsync`. |
| **Player creature visual** | Loads `BaseCreature.AssetKey` via `IGameAssetLoader.LoadAssetByKeyAsync<GameObject>`, instantiates the prefab at `arena.PlayerCreaturePosition`, destroys on exit. |
| **Opponent creature visual** | Same flow at `arena.OpponentCreaturePosition`. |
| **Opponent trainer** | Not teleported. Wild battles have no NPC GO. |

Lookups go `GeneratedCreature` (via `IGeneratedCreatureRepository.GetCreature`) → `BaseCreature` (via `ICreatureRepository.GetCreature`) → `BaseCreature.AssetKey` → `IGameAssetLoader.LoadAssetByKeyAsync`. The chain is fully async + cancellation-aware. Each individual visual step can fail silently — the returned `BattleStagingResult` flags which steps succeeded so the caller can react.

`BattleCoordinator` inspects the result after `EnterArenaAsync` and logs an Error + raises `BattleEvents.StagingFailed("opponent visual" | "player visual")` when a creatureId was passed in but no visual spawned. The battle still proceeds.

`BattleCoordinator.EndBattle` calls `_stager.ExitArenaAsync` alongside `_cameraController.ExitBattle()`, so the same teardown path covers both player teleport restore and creature visual cleanup.

## `SpawnerEncounterBehaviour`

Adds a random 2–5 s delay before triggering a battle. If the player exits the trigger zone during the delay the encounter is cancelled.

| Inspector Field | Type | Default | Description |
|-----------------|------|---------|-------------|
| `_encounterRadius` | float | 5f | `SphereCollider` trigger radius |
| `encounterDelayMin` | float | 2f | Minimum seconds before battle starts after player enters zone |
| `encounterDelayMax` | float | 5f | Maximum seconds before battle starts after player enters zone |

On `OnTriggerEnter` (Player tag), a coroutine `EncounterDelayRoutine` is started. If the player leaves the zone (`OnTriggerExit`) before the delay expires, the coroutine is cancelled. After the delay, `BattleCoordinator.StartWildBattle` is called with the `battleArenaKey` from `SpawnerWorldBehaviour`.

`SpawnerWorldBehaviour` now has a `_battleArenaKey` field that is passed through to `SpawnerEncounterBehaviour.Activate(...)` and embedded in `WildBattleRequest.BattleArenaKey`.

## Wild Battle AI

`BattleCoordinator` injects `IWildBattleAIDomainService` (the DLL interface). The same `WildBattleAIDomainService` runs both client-side (offline) and server-side (via the `/wild-turn` endpoint in online mode).

Decision priority:
1. 20% random chance → use a Status-category ability if one exists
2. Default → use the highest-power non-Status ability

Abilities are loaded from the wild creature's progression set at its current level. Falls back to a global paginated query when no set is assigned.

## `BattleAnimationConfig`

A `ScriptableObject` created via `Assets > Create > CR > Battle > Animation Config`. Maps ability keys to clip names and VFX prefabs. `GetEntry(abilityKey)` falls back to a `"default"` entry if no exact match is found.

Each `BattleAnimationEntry` now includes `attackClipOverride` (string, default empty). When non-empty, this overrides the creature's `defaultAttackClip` from its `CreatureAnimationProfile`.

## `CreatureAnimationProfile`

A `ScriptableObject` created via `Assets > Create > CR > Battle > Creature Animation Profile`. Holds per-creature animator state names.

| Field | Default | Description |
|-------|---------|-------------|
| `defaultAttackClip` | `"Attack"` | Animator state for the default attack (used when ability has no override) |
| `hitClip` | `"Hit"` | Animator state when the creature takes damage |
| `faintClip` | `"Faint"` | Animator state when the creature faints |
| `idleClip` | `"Idle"` | Animator state during idle |

> **Note:** As of the presentation-orchestrator refactor, the `Strike` beat in `BattlePresentationSequencer` raises `CreatureAttacking` with the hard-coded `"Attack"` clip (the serialized anim-config fields on `BattleCoordinator` were removed along with `FireOutcomeEvents`). These `ScriptableObject` types still exist; re-wiring per-ability clip overrides through the sequencer (`BattleAnimationConfig.attackClipOverride` → `CreatureAnimationProfile.defaultAttackClip` → `"Attack"`) is a future enhancement.

## Battle presentation: creature body vs. ability signature

Performance splits along ownership, and the two halves are sourced and played independently:

- **The creature owns its body** — flinch, faint, idle, its **cry**, hit-flash. This is identity, authored in a **shared `CreatureReactionProfile`** the creature's `CreatureDefinition` points at, and played by `CreatureBattlePresenter` on the prefab.
- **The ability owns its signature** — cast VFX, travel projectile, impact burst, and cast/hit/miss SFX. This is per-move, authored on **`AbilityConfig`**, and played positionally by `BattleAbilityFxResponder`.

### `CreatureBattlePresenter` (the creature's body)

`CreatureAnimationProfile`/`BattleAnimationConfig` only decide *which attack clip name* to broadcast. `CreatureBattlePresenter` (`Assets/CR/Game/Battle/Presentation/`) performs the creature's own body language. **Add it to each creature prefab.** It is a self-contained `MonoBehaviour` (no DI — the visual is `Instantiate`d by the stager, not Zenject). The flow:

1. `BattleStager.SpawnCreatureVisualAsync` instantiates the prefab, resolves the creature's `CreatureDefinition` by `baseCreature.ContentKey` (`ContentDefinitionProvider.TryGetCreature`), and calls `presenter.Bind(creatureId, isPlayer, def.reactionProfile.Resolve())`. `Resolve()` flattens any base→variant inheritance chain into the final reactions. This stamps identity (so the presenter answers only to *its own* cues) **and** hands it the resolved reactions.
2. The presenter subscribes to the static `BattleEvents` bus in `OnEnable` / unsubscribes in `OnDisable` (dies cleanly when the stager `Destroy`s the visual on arena exit).
3. Each id-filtered event plays the matching named `CreatureReaction` from the resolved `CreatureBattleReactions` block.

Event → beat map (all filtered to the bound creature id, except victory which uses the bound side):

| `BattleEvents` signal | Beat (named field on `CreatureBattleReactions`) |
|---|---|
| `Bind()` (spawn) | `spawn` |
| `TurnStarted` | `turnStart` |
| `CreatureAttacking` (carries the ability attack clip → drives the Animator; the `attack` beat only layers optional grunt/feedback) | `attack` |
| `CreatureHit` | `hit` |
| `HeavyHit` (same-frame `Hit`+`HeavyHit` coalesced to one) | `heavyHit` → falls back to `hit` |
| `CreatureFainted` | `faint` |
| `LowHpEntered` / `CriticalHpEntered` | `lowHp` / `criticalHp` (→ falls back to `lowHp`) |
| `StatusApplied` | `statusApplied` |
| `CreatureCaptured` | `captured` |
| `LevelUp` | `levelUp` |
| `CameraCueVictory(playerWon)` | `victory` if on the winning side, else `defeat` |
| `TurnEnded` | `idle` |

Each `CreatureReaction` (see [ScriptableObjects → CreatureDefinition](./12-scriptable-objects.md)) bundles three optional **body** channels: **animation** (cross-fade state or `SetTrigger`), **sound** (random `AudioClip` cry, auto-created positional `AudioSource`), and **feedback** (scale-punch, color flash via `MaterialPropertyBlock`, and a `CreatureVibrationTier` that re-raises the shared `BattleEvents.RaiseVibration*` haptics). Its `vfxPrefab` slot is for body-only effects (a faint puff, a level-up sparkle) — **not** the move's VFX.

#### Authoring a profile — `CreatureReactionProfile` inspector

A profile is **15 beats × ~18 fields ≈ 270 controls**, and a typical profile derives from a shared base and overrides two or three beats — so the useful information is *which* beats are authored and where each one's content comes from. The inspector is built around that:

- **Inherits from** — a dropdown of every profile in the project (readable names), not a bare object field.
- **Coverage bar** — `12 of 15 beats covered · 4 authored here`. Inherited beats count as covered, because the presenter cannot tell the difference.
- **Beats grouped by moment** — ENTERING / ATTACKING / TAKING DAMAGE / LEAVING / BATTLE END — each row showing a one-line summary of what will actually play (`Roar · 2 sounds · flash`, taken from the *resolved* chain) and a badge: **here** (local), **inherited**, or **not set**.
- **Opening a beat** shows a plain-language "this plays when…", its fields grouped into Animation / Its voice / Body VFX / Feedback, plus **Override — start from the inherited version** (deep-copies the base's beat so editing it cannot mutate the shared base) and **Clear — go back to inheriting**.

The beat list itself lives in `CreatureReactionProfileBeats` so the creature inspector reads the same catalogue; the summary and coverage rules are pure logic in `CR.Game.Battle.Logic.ReactionBeatDigest` (unit-tested).

The `CreatureDefinition` inspector picks a profile from the same dropdown and reports its coverage inline, with **New profile…** / **Edit reactions** / **Make a variant…**.

> **Fixed:** `CreatureReactionProfile.Resolve()` did not carry the `recall` beat, so a derived profile could author a recall reaction and have it silently dropped in favour of the base's (usually empty) one. Every beat on `CreatureBattleReactions` must appear in `Overlay`.

**Zero-config fallback:** if a beat is unauthored, the presenter still cross-fades default Animator states for the core combat beats (`Attack`/`Hit`/`Faint`/`Idle`) — a freshly-added prefab animates immediately; cry/feedback are opt-in.

#### Standard Animator state names

There is a documented naming convention so creature Animator controllers stay consistent. The canonical names live in one place — `CreatureReactionDefaults` — and are shared by the presenter (its fallback states), the **`CreatureReactionProfile` → "Fill blanks with standard defaults"** button, and the controller generator (below).

| Beat | Standard state | Settle | Notes |
|---|---|---|---|
| `spawn` | `Appear` | → Idle | entrance; falls back to `Idle` |
| `turnStart` | `Ready` | loop | optional ready stance |
| `attack` | `Attack` *(or ability clip)* | → Idle | basic attack; the ability's `animationKey`/clip overrides this name per-move |
| *(heavy move)* | `HeavyAttack` | → Idle | larger creatures / high-power moves; routed via the ability's attack clip override |
| `hit` | `Hit` | → Idle | default feedback: small punch + white flash + Medium vibration |
| `heavyHit` | `HeavyHit` | → Idle | falls back to `Hit`; default feedback: bigger punch + Strong vibration |
| `faint` | `Faint` | hold | default feedback: Strong vibration |
| `lowHp` / `criticalHp` | `LowHp` / `CriticalHp` | loop | optional hurt idles; `criticalHp` falls back to `lowHp` |
| `statusApplied` | `Status` | → Idle | optional |
| `captured` | `Captured` | hold | optional |
| `victory` / `defeat` | `Win` / `Defeat` | hold | optional, battle-end pose |
| `levelUp` | `LevelUp` | → Idle | optional; default feedback: small punch |
| `idle` | `Idle` | loop | resting state (controller default) |

"Settle" is how the generator wires the state: **→ Idle** = a one-shot with an exit-time transition back to Idle; **loop** = plays in place; **hold** = stays on the last frame. No other transitions are needed — the presenter enters states by name via `CrossFadeInFixedTime`, which ignores the transition graph. Every cross-fade is guarded by `Animator.HasState(layer 0, …)`, so a convention name with **no matching state is skipped silently** — the beat's sound and feedback still play. The presenter tries states in order **ability clip → the beat's authored state → the safe default**, playing the first that exists, so a partial controller degrades gracefully (e.g. `HeavyAttack`/`HeavyHit` missing → falls back to `Attack`/`Hit`). Prefer states; `animatorTrigger` is the opt-in alternative (guarded by a parameter check).

#### Generating controllers (no per-creature hand-wiring)

You do **not** build a controller per creature by hand, and you do **not** wire `Idle → every state` arrows. The cute-monster packs ship one stock controller per monster with pack-specific clip names (`Slash Attack`, `Take Damage`, `Die`) that don't match the convention. Two menu items generate proper battle controllers from those clips:

- **`CR → Battle → Build Battle Controller (Selected Prefabs)`** — for the selected creature prefab(s).
- **`CR → Battle → Build Battle Controllers (All CR Creatures)`** — every prefab under `Assets/CR/Prefabs/Creatures`.

For each creature `CreatureBattleControllerBuilder` finds its clips (in its current controller's folder), creates `<Creature>_Battle.controller` with the convention states, maps each to the best name-matched clip (e.g. `Attack`→`Slash Attack`, `Hit`→`Take Damage`, `Faint`→`Die`), adds the one-shot → Idle returns, and assigns it back to the prefab. States with no matching clip (often `Appear`/`Win`/`HeavyAttack`) are skipped — drop a clip into the creature's folder and re-run to fill them. The generator is re-runnable; just make sure each creature's `Idle` clip has **Loop Time** enabled in its import settings.

### `BattleAbilityFxResponder` (the move's VFX/SFX)

The ability's effects flow from `AbilityConfig` (`useVfx`/`travelVfx`/`hitVfx`, `useSfx`/`hitSfx`/`missSfx` — Addressables `AssetReference`s with synced string keys). Those keys ride the battle `outcome`, and `BattleCoordinator.FireOutcomeEvents` packs them — with the caster and target ids it already has — into a single positioned **`AbilityFxCue`** (`BattleEvents.AbilityFx`). This replaced the old scattered, position-less `Sfx/VfxRequested` raises for the attack.

`BattleAbilityFxResponder` (DI'd, bound `FromNewComponentOnNewGameObject().AsSingle().NonLazy()`) consumes the cue:
- resolves caster/target world positions from **`BattleVisualRegistry`** (id→transform; the stager registers each visual on spawn, `Clear()`s on exit),
- loads each effect by key via `IGameAssetLoader`, and spawns **cast** VFX at the caster, **travel** VFX lerping caster→target, **impact** VFX at the target (on a miss: cast + miss SFX only),
- plays cast/hit/miss SFX positionally via `AudioSource.PlayClipAtPoint`.

Positions are captured at cue time, so an effect still lands correctly even if a creature despawns mid-load; any missing piece (no key, no registered visual) is skipped. Status-condition VFX/SFX still use the older position-less `Sfx/VfxRequested` events for now.

> **Authoring gotcha — empty key = silent no-op.** The responder loads each effect by its **string key** (`useVfxKey`/`hitVfxKey`/…), never the `AssetReference` directly. On `AbilityConfig` each effect is a *pair*: the `AssetReference` a designer assigns in the inspector, and the string key that actually syncs to the backend and drives the runtime. If the key is blank, the backend stores `null`, the cue carries `""`, and the responder skips the spawn — so the VFX simply never plays on hit, with no error. The key is now **auto-derived** from the `AssetReference`'s Addressables address: `AbilityConfigEditor` fills a blank key whenever the asset is set, and `AbilityEditorSyncHelper.SyncAbility` derives it at push time as a fallback (`KeyOrDerived`). **Prerequisite:** the VFX/SFX prefab must be marked **Addressable** — derivation reads `FindAssetEntry`, so a non-addressable asset yields no key. If VFX is missing in play, confirm the prefab is addressable, re-open/re-sync the ability, and check the log for `[BattleAbilityFx] load '<key>' failed` (key present but address unbuilt) versus silence (key empty).

## Offline Battle Stack

The offline battle stack uses the DLL's `BattleDomainService` (same class the backend uses) backed by a local SQLite file (`game.bytes`). Battle tables are created by `DatabaseMigrationRunner.MigrateDomain` on startup.

| Component | Role |
|-----------|------|
| `CR.Game.Data.Sqlite.BattleRepository` | DLL SQLite implementation of `IBattleRepository`; stores battles, rounds, creature states, action log in `game.bytes` |
| `CR.Game.Domain.Services.Implementation.Battle.BattleDomainService` | DLL domain service; full offline battle logic — speed-based first-mover, `BattleResolver` damage, escape RNG, wild creature soft-delete |
| `BattleHttpDomainAdapter` | Online path: implements `IBattleDomainService` against the REST API |
| `OnlineOfflineBattleDomainService` | Routes calls to `battle_online` or `battle_offline` binding based on `IsPlayingOnline` |

> **Note:** The legacy Unity-side stack (`IBattleClient` / `BattleClientUnityHttp` / `OfflineBattleClient` / `OfflineBattleService` / `IBattleRepository` under `CR.Game.Battle.Offline` / `SqliteOfflineBattleRepository`) was removed in favour of the DLL's `IBattleDomainService`. New code must not reintroduce those types.

**Every constructor dependency `BattleDomainService` declares must be bound in
`LocalDevGameInstaller`, or resolving `battle_offline` throws at install time and the world never
bootstraps.** As of 2026-09-03 that list gained `IElementalReactionRepository` (Sqlite, reading the
content database — the authored synergy rules) and `IBattleSystemVersionRepository` (already bound,
now also reading the content database, because the active elemental-damage version is content).
`BattleDomainServiceBindingTests` in `cr-api-unity/Tests/ContentSync` pins the rule: it parses the
constructor out of the cr-api source and asserts a matching `Container.Bind<…>` for every required
parameter. It is a text comparison because the installer lives in Assembly-CSharp, which no Unity
asmdef may reference, so no EditMode test can build the container.

The `game.bytes` file is keyed as `LocalDataSources.GameOfflineRepository` and resolved to `database_path_game` in `game_config.yaml` (defaults to `{persistentDataPath}/databases/gameOffline.bytes`).

## `BattleHUD`

`BattleHUD` (`Assets/CR/UI/Battle/BattleHUD.cs`) is a MonoBehaviour overlay built with **UI Toolkit** (UIDocument). It subscribes to Soap `ScriptableEvent` channels via `[Inject(Id = EventChannelIds.X)]` (auto-bound by `EventChannelInstaller`) and never calls the API directly.

**Files:**
- `BattleHUD.cs` — MonoBehaviour; queries elements and wires button callbacks
- `BattleBagPanelHandler.cs` — MonoBehaviour; manages the in-battle Items/Bag panel. Reads pre-cached data from `TeamSync.Team` and `InventorySync.Inventory` — no async fetch on `Open()`.
- `Resources/BattleHUD.uxml` — layout: opponent panel (top-right), player panel (bottom-left), battle log, action menu (Battle / Items / Run), ability panel
- `Resources/BattleHUD.uss` — styles; root has `picking-mode="Ignore"` so clicks pass through to the 3D world
- `UI/Battle/BattleBagPanel.uxml` — bag panel layout (item list, party slots, confirm/cancel)

**Setup:**
1. Add a `UIDocument` + `BattleHUD` MonoBehaviour to a GameObject in the scene. `BattleHUD.Awake` auto-loads `Resources/BattleHUD.uxml` if none is assigned.
2. Add `BattleBagPanelHandler` as a second component on the **same GameObject** (or a sibling with its own UIDocument). Assign its `UIDocument` field.
3. On the `BattleHUD` component, assign the `BattleBagPanelHandler` component to the **Bag Panel Handler** SerializeField.
4. Ensure `TeamSync` and `InventorySync` MonoBehaviours are present in the scene (see [Domain Sync Pattern](16-domain-sync-pattern.md)).
5. Ensure `EventChannelInstaller` is in the `SceneContext` Installers list with `EventWiringManifest.asset` assigned (see [Event Wiring](15-event-wiring.md)) — the HUD's event subscriptions are auto-injected.

The root is hidden (`DisplayStyle.None`) on start and shown when `BattleEvents.BattleStarted` fires.

**Action menu buttons:** Battle (opens ability grid) → Items (opens bag panel via `BattleBagPanelHandler.Open`) → Run (submits `[{"type":4}]`)

**HP bars** are custom `VisualElement` fills; width is set via `style.width = Length.Percent(ratio * 100f)` with a USS `transition-duration: 0.3s` for smooth animation.

### Item targeting in battle

Choosing a consumable from the bag now asks which creature to use it on when the item
heals, revives or cures (`BattleItemTargeting.NeedsChoice` — opponent-targeting items and
capture crystals skip the step). `BattleBagPanelHandler.GetTargetsAsync` refreshes the team,
builds `TargetCandidate` cards through the shared `TargetCandidateBuilder` (also used by the
overworld bag) and judges each with `ItemTargetRule`; the HUD's `target-panel` renders one
row per creature, disabling rows the item cannot be used on and echoing the rule's reason
when one is pressed. `UseOnAsync(itemId, creatureId)` submits the use.

Server refusals (HTTP 400) surface their real `message` body via `ServerErrorMessage.From`
in `SimpleWebClient`, so the HUD log shows "This item cannot be used in battle." rather than
"Bad Request".

### Icons on the HUD

Everything the HUD draws as an icon goes through `UiIcon.Apply` — see [UI Icons](29-ui-icons.md).
`BattleHUD.Init` takes `IBattleCoordinator`, `GameSessionManager`, `IUICoordinator`, `TeamSync`,
`IGameAudio`, `IStatusConditionDomainService` and an `[InjectOptional] IGameAssetLoader` to feed the
icon lookups; all are already bound in `LocalDevGameInstaller`.

| Slot | Key source |
|---|---|
| Ability rows (`.cmd-icon`) | `WildAbilityDto.iconAssetKey`, populated from `BaseAbility.IconAssetKey` by `BattleCoordinator` / `BattleMissionConductor` |
| Bag rows (`.cmd-item-icon`) | `BattleBagItem.IconAssetKey` |
| `.status-badge` | A name → icon-key map built **once per session** from `IStatusConditionDomainService.GetStatusConditionsAsync(0, 200)` |

**The status badge is an icon slot now.** It used to be a `Label` holding a four-letter truncation of
the condition name, which made "Confused" and "Confounded" the same badge. It is the authored sprite
when the condition has one and the two-letter `IconGlyph` otherwise, and `.status-badge` became a
fixed 20×20 box — an absolutely-positioned glyph contributes nothing to layout, so a padding-sized
badge would have collapsed to zero.

The badge lookup is **name-keyed**, because status events carry only the condition's name. Two
conditions with the same name would collide; the server's unique index on `status_conditions.name`
makes that impossible today. The map is loaded once and the "loaded" flag is set *first*, so a failed
read does not retry on every battle.

### Turn narration — every resolved turn must say something

The battle log (`log-text`, four lines, oldest dropped) is the only thing that explains a turn whose
effect is invisible. It used to be driven entirely by effects — damage, faints, status changes — so a
turn that produced none of them showed an attack animation and no text at all. Players read that as
the opponent being unable to act and passing the turn back.

Three lines close that gap:

| Line | Source | Timing |
|---|---|---|
| `"The opponent used Cyclone!"` | `AbilityResolving` channel | announced before the attack animation |
| `"But it missed!"` | `AbilityMissed` channel | at the moment of the miss |
| `"But nothing happened!"` | `BattleEvents.ActionResolved`, direct subscription | after the presentation, as a trailing remark |
| `"The water conducts the charge! Conduction!"` | `ActionOutcome.ReactionLogLine` | after the presentation, before the bonus-damage line |

**The reaction line comes off the outcome, not from a table in the client.** `ActionOutcome` carries
`ReactionLogLine` (populated by `BattleResolver` from the reaction it fired), and the HUD prints it
verbatim, falling back to `"{ReactionName}!"` when the resolver had no line to give. It used to look
the name up in the static `CR.Game.Compat.Battle.ElementalReactionTable` — which was correct only
while reactions were hard-coded. Now that they are authored rows in `elemental_reaction`, that lookup
would have shown the *shipped* line for a rule a designer had since retuned, and nothing at all for
one they added. No runtime Unity code references the static table any more. See
[Battle Extensions → Elemental reactions are content](24-battle-extensions.md) and
[Runtime Content Sync](27-content-sync.md).

Mission lines share the same reasoning. Progress and the ability unlock now write here as well as to
their toast and banner — `"Mission: Pyromaniac (0/3)"` at battle start, `"Pyromaniac 2/3"` on a tick,
`"Pyromaniac complete! Mega Burn unlocked!"` on completion. The toast lasts 2.5 seconds and the
banner queues behind any other completion, so both could pass entirely unseen; the log is the record
that survives the turn. See [Battle Extensions](24-battle-extensions.md).

Note the log keeps only **four lines**. It is a running commentary, not a transcript — anything that
must be readable after a few more turns needs its own surface.

Two things to keep in mind when extending this:

* **Show `AbilityName`, never `AbilityKey`.** The key is an animation key and is deliberately shared
  between abilities that animate alike — twelve abilities currently share `fire_ember`, so the key
  would name the wrong move for eleven of them. `ActionOutcome.AbilityName` carries the display name.
* **The "nothing happened" rule lives in `BattleTurnNarration.IsSilentTurn`** (in the pure
  `CR.Game.Battle.Logic` asmdef, unit-tested) rather than inline in the HUD: an ability that
  connected, dealt no damage, and applied, triggered or removed no condition. A miss is excluded —
  it has its own line.

**Turn flow:**
1. `PlayerTurnStarted` fires → `ActionMenu` shown; ability list cached in `_currentAbilities`; ability buttons pre-populated
2. Player presses **Battle** → `ActionMenu` hidden, `AbilityPanel` shown (2×2 grid of up to 4 abilities)
3. Player presses an ability → `AbilityPanel` hidden; `SubmitPlayerAction` called with `[{"type":0,"abilityId":"<guid>","targetCreatureId":"<opponentId>"}]`
4. Player presses **Items** → `ActionMenu` hidden, `BattleBagPanelHandler.Open` called; on confirm `BattleCoordinator.SubmitPlayerAction` is called (or `EndBattle` on capture)
5. Player presses **Run** → submits `[{"type":4}]`

Ability button labels show `"Name (Power)"` e.g. `"Fire Bolt (50)"`. Buttons with no ability are disabled and styled with `.ability-btn--disabled`. `BattleActionType` enum: Ability=0, Item=2, Switch=3, Run=4.

> **Action-payload fix:** the Item action must serialize as `"type":2`. It previously serialized as `"type":3`, which the server interprets as **Switch** — so item actions silently fell through the Switch handler (item effects still applied only because `UseItemAsync` runs separately). Items now correctly use `BattleActionType.Item` (`"type":2`).

`playerAbilities` is populated by `BattleCoordinator.BuildAbilityListAsync` — it queries `IAbilityRepository.GetAbilitiesForProgressionSetAtLevelAsync` for the player's active creature and maps to `WildAbilityDto` for the HUD. `BattleStateDto` (DLL type) does not include ability lists; they are assembled client-side.

### Battle missions in the HUD

A sidecar mission evaluator (e.g. "apply Burn to the same target 3 times → unlock Mega Burn for this battle") raises `BattleEvents.MissionProgressed` / `MissionCompleted`; `BattleHUD` only renders what it's told — it never evaluates mission rules itself. The evaluator, its content source and the seams it uses are documented in [Battle Extensions](?page=unity/24-battle-extensions).

- **`MissionProgressed(missionName, current, threshold)`** — shows a small corner toast (`mission-toast` / `mission-toast-text` in `BattleHUD.uxml`, top-left, e.g. `"Pyromaniac 2/3"`). Re-firing resets its own fade timer (`IVisualElementScheduledItem`, ~2.5s) rather than stacking, since it always reflects the latest progress. Non-blocking: the element is `picking-mode="Ignore"`.
- **`MissionCompleted(missionName, unlockedAbilityName)`** — shows a prominent top-center banner (`mission-banner` / `mission-banner-text`, ~3s, amber accent) and plays `UiSoundKeys.Confirm`. Completions are queued (`_missionBannerQueue`) so back-to-back unlocks each get their full on-screen time instead of clobbering each other.
- Both elements fade via USS opacity/translate transitions (`.mission-toast--hidden`, `.mission-banner--hidden` in `BattleHUD.uss`) and are hard-reset (no fade) on `BattleStarted`/`BattleEnded` via `ResetMissionUi()` so nothing bleeds into the next battle.
- **Unlocked ability styling:** `WildAbilityDto.unlocked` (set by the mission system, ignored by the battle system itself) drives an accent style on the ability row in `PopulateAbilityList` — `.cmd-row--unlocked` (amber border/fill) plus an `"UNLOCKED"` badge (`.cmd-unlocked-badge`). It stays an ordinary `Button` on the same `Activate(row, ...)` / `clicked` path as every other ability — only the visuals differ.

## Debug stats overlay

`BattleDebugStatsOverlay` (`Assets/CR/UI/Battle/DebugOverlay/BattleDebugStatsOverlay.cs`) is a
dev-only overlay, compiled only in the Editor or a `DEVELOPMENT_BUILD` (`#if UNITY_EDITOR ||
DEVELOPMENT_BUILD` wraps the whole file, including its Zenject binding in
`LocalDevGameInstaller`). While a battle is active, pressing **F3** toggles two panels — one
beside each combat card — dumping everything the client actually knows about that creature:
level, current/max HP, the raw stat block (ATK/DEF/SPA/SPD/SPE), status conditions, held item,
its ability list (name/category/power), and a running log of raw stat modifiers applied by
in-battle conditions.

**Namespace note:** the folder is `.../Battle/DebugOverlay/` but the C# namespace is
`CR.UI.Battle.DebugOverlay`, deliberately avoiding a literal `Debug` segment — a nested namespace
named `Debug` under `CR.UI.Battle` shadows `UnityEngine.Debug` for every *other* file in that
namespace tree (it broke `BattleHUD.cs`'s and `BattleSummaryScreen.cs`'s bare `Debug.LogWarning`/
`Debug.LogError` calls the first time this was tried). `CR.Game.Battle.Debugging` (the
`BattleFxSmokeRunner` namespace) sidesteps the same trap for the same reason.

**Data sources — same as `BattleHUD`, not a new pipeline.** The overlay subscribes directly to
the static `BattleEvents` bus (`BattleStarted`, `CreaturesIdentified`, `PlayerTurnStarted`,
`CreatureSwitchedIn`, `HpChanged`, `StatusApplied`/`StatusRemoved`, `ActionResolved`,
`BattleEnded`) — the same events `BattleHUD` reads — plus `TeamSync.Team` for the player's synced
`GeneratedCreature` (level, HP, the five battle stats, held-item ids). It renders into **the same
`UIDocument`** as `BattleHUD` (found at runtime via `FindFirstObjectByType<BattleHUD>()`, never a
second `UIDocument`), inserting a panel into `top-area` before `opponent-card` and another into
`bottom-area` right after `player-card` — so both track the HUD's own layout. Styling is
`Resources/BattleDebugStatsOverlay.uss` (`.debug-stats-panel`, `.debug-stats-text`), added to the
shared root's `styleSheets` once.

**Opponent stats are genuinely unavailable — not a bug.** The server never sends the opponent's
raw stat block to the client (hidden-info by design — `BattleCreatureSnapshot`, the only
opponent-side DTO that reaches Unity, carries just `CurrentHp`/`Level`/`IsActive`). The opponent
panel reflects that honestly: `HasFullStats = false` renders `"Stats: unavailable (not sent to
client)"` instead of fabricated zeros, held item shows `"Unknown (not sent to client)"`, and the
ability list is empty (abilities are only known for whichever side is mid-turn-selection, i.e. the
player).

**Raw stat modifiers** are read straight from `ActionOutcome` — the same object
`BattlePresentationSequencer.PlayAftermath` consumes — rather than re-derived: `ConditionsApplied`
(each `ActiveBattleCondition.StatChanges`) is attributed to `TargetCreatureId`,
`AttackerConditionsApplied` to `ActingCreatureId` (the same attribution the sequencer uses).
`ConditionsRemoved` carries no per-item target, so removal is applied by condition name to both
tracked creatures — a best-effort call for a debug tool, mirroring the sequencer's own imprecision
there. The log is capped at 12 entries per creature (oldest dropped first) to avoid unbounded
growth over a long battle.

**Input.** A new `Debug/ToggleBattleStats` action (F3, keyboard only) was added to
`CR_GameInput.inputactions` — no pre-existing debug action map existed to reuse. Resolved the same
way `PlayerMenuWindow` resolves `UI/ToggleMenu` (`Resources.Load<InputActionAsset>("CR_GameInput")`
→ `FindActionMap("Debug")` → `FindAction("ToggleBattleStats")`), event-driven via
`InputAction.performed` — never polled from `Update`. The action stays disabled outside the
`Battle` UI context (`IContextAwareScreen.OnContextChanged`), so F3 is inert everywhere else.

**Formatting is pure and unit-tested.** `BattleDebugStatsFormatter`
(`Assets/CR/UI/Battle/DebugOverlay/Logic/`, `CR.UI.Battle.DebugOverlay.Logic` asmdef,
`noEngineReferences: true`) takes a plain `BattleDebugCreatureSnapshot` POCO (no Unity/engine and
no cr-api-model types, so it compiles and runs outside Unity) and returns deterministic `\n`-joined
text — pinned by `BattleDebugStatsFormatterTests` (`CR.UI.Battle.DebugOverlay.Logic.Tests`
asmdef, `UNITY_INCLUDE_TESTS`-gated).

## `WildBattleRequest`

```csharp
public record WildBattleRequest(
    Guid AccountId,
    Guid PlayerTrainerId,
    Guid SpawnerId,
    Guid WildTrainerId,
    string BattleArenaKey = ""
);
```

`BattleArenaKey` is optional. When empty, `BattleCoordinator` skips arena staging and camera transition.

## `NpcBattleRequest`

```csharp
public record NpcBattleRequest(
    Guid NpcId,
    Guid AccountId,
    Guid TrainerId,
    IReadOnlyList<CreatureInventoryEntry> NpcTeam,
    IReadOnlyList<NpcInventoryEntry> NpcItems,
    string BattleArenaKey = ""
);
```

`BattleArenaKey` is set from `NpcInteractionBehaviour._battleArenaKey` (Inspector field on the NPC GameObject). Empty = no arena staging.

## NPC Trainer Battle Flow

1. Player enters `NpcInteractionBehaviour` trigger radius and presses **E**
2. `NpcInteractionBehaviour` checks `NpcTrainerBehaviour.CanBattle` and that no creature grant is pending
3. Builds an `NpcBattleRequest` (including `_battleArenaKey` from the Inspector) and calls `BattleCoordinator.StartNpcBattle(request)`
4. `BattleCoordinator` calls `IBattleDomainService.StartBattleAsync` → `GetBattleStartResultAsync` → `GetBattleStateAsync` to identify active creatures
5. If `BattleArenaKey` resolves, calls `_stager.EnterArenaAsync(...)` → `_cameraController.EnterBattle(arena.CameraLookTarget)` — player teleport + both creature visuals + camera lerp
6. Fires `OnBattleStarted`

## Authoring a Trainer Battle

**CR → Trainer Battle Author** is the one place a trainer battle is made. A trainer
spans five systems (definition asset, spawner-backed team, dialogue conversation, scene object,
cr-api migration seed) and the window's job is to make the `TrainerBattleDefinition` asset the
single source of truth and derive everything else — the spawner/pool/template plumbing stays
exactly what the runtime expects, but the author never sees it.

The window is a **guided checklist**, not a pile of buttons. Each repaint it probes the real
state of the world and renders five rows, in pipeline order, each with an icon *and* a word
(state is never carried by colour alone) and a one-click action that is enabled only when it
can actually run:

### It is a UI Toolkit window, not an inspector dump

This is the project's first **UXML/USS editor window** (`Game/World/Editor/UI/TrainerBattleAuthor.uxml`
+ `.uss`; every other editor tool here is IMGUI). Layout lives in the UXML, all styling in the USS
by named class — the house "no inline styles" rule applies to editor UI too, the single exception
being `display: none` on panels the window toggles.

The layout follows the shape RPG Builder popularised: a **roster rail** on the left listing every
trainer in the project (searchable, each row showing a status pip and an `n/4` readiness count),
and a **dossier** on the right for the selected one — hero header with the trainer's name, chips
for ID / arena / rematch, a readiness meter that turns green at 4/4 "READY TO FIGHT", the
checklist, team cards, a bag-and-rewards summary, and the raw inspector behind *Advanced*
(an `IMGUIContainer`, so nothing is hidden from anyone who wants it).

Palette cools the house grays slightly toward blue (`#1b1e24` ground, `#22262e` cards) so the tool
reads as its own thing rather than a default inspector, keeping the CR accent `#4b9cd3`. Only USS
properties Unity actually supports are used — no box-shadow, no gradients; depth comes from
layered surfaces and 1px borders. Team creatures are shown the way a person would say them
("Wolfpup · Normal", not `creature_wolfpup`), with the raw content key on the tooltip.

The copy is written for anyone, not just the team — steps are named in player terms
("Trainer basics", "Battle team wiring", "Challenge dialogue", "Place in the world",
"Server hand-off"), the internal jargon (content keys, spawner templates, barks, migrations)
stays behind tooltips and the Advanced foldout.

| Step | Done means | Action |
|------|-----------|--------|
| Trainer basics | name, ID, arena and ≥1 team creature, zero validation problems | Show in Project |
| Battle team wiring | every slot's `spawnerTemplateId` equals its deterministic md5 id — **drift is detected live** | Wire team |
| Challenge dialogue | the titled conversation exists in `CR Dialog.asset` (optional — no title means a silent challenge) | Use standard name / Write dialogue |
| Place in the world | `CR_NPC_Trainer_<key>` is in an open scene | Place in scene (position field + "Where I'm looking") |
| Server hand-off | never verifiable from Unity — a hand-off to cr-api | Copy for server |

**Author Everything** runs every actionable step in order. **New Trainer…** creates a
definition from just a display name: the content key is derived (`Scout Maren` →
`npc-trainer-scout-maren`), the bark title defaults to `<key>-bark`, and the arena key is
pre-filled from the open scene's `BattleArena`. The raw inspector still exists, behind an
*Advanced* foldout, for anything the summary card and checklist do not cover.

The rules behind the rows are pure — `TrainerAuthorChecklist` in `CR.Game.World.Logic`
(states: Done / To do / Blocked / Manual, plus the content-key derivation), pinned by
`TrainerAuthorChecklistTests` — so the window renders exactly what the tested rule returns.
Deterministic ids are md5(`"cr-trainer:" + name`) formatted straight from the digest's hex
(never through `new Guid(bytes)`, whose endianness would break parity with the migration).
`cr_author_demo_trainer` / `CrTrainerBattleCommand.Author()` drives the same engine headlessly
and produced the Meadow's Scout Maren.

### Each team slot says how its creature grows

A slot authors the creature, its level, its move list (`progressionSetName`) and — new with the
server push — **`growthProfileName`** (default `"Balanced Growth"`, which is 100% of base stats).
Both name fields are `ContentPicker` dropdowns in the definition inspector and the author window's
team UI, sourced from the growth and progression assets in the project rather than typed, because
the server resolves them **by name**: a name nothing matches refuses the whole team with a `409`.
The window catches it first — the team card shows `⚠ <name>` on an unresolved profile, and
*Validate* names the slot ("no growth profile is called 'X' — it was renamed or deleted, so the
server would refuse this team"). The field is additive, so trainers authored before it deserialize
to the default and nothing had to be re-authored.

### Push, not a hand-written migration

Changing an existing trainer's team used to mean writing a migration by hand — M10020's pattern —
which is why the checklist's last row is a *Manual* hand-off. For edits it no longer is:
**Content Studio → Trainer Battles → ⬆ Push** sends the definition to cr-api (the hidden team
spawner's metadata, one template per slot under its deterministic id, a sweep of every account's
cached copy of that team, and the trainer's `npcType` / rematch flag) and mirrors the same team into
the local SQLite game-data, so an offline playtest sees the edit without a floor re-bake.

The push **recomputes** each slot id from the content key at push time rather than trusting the
stored string, and refuses when the two disagree — a renamed content key would otherwise write the
team under new ids and orphan the rows the definition still points at — then restamps the asset on
success. Leg-by-leg detail lives in
[Content Registry — a trainer battle push is four writes](?page=unity/08-content-registry).

M10020 remains the **fresh-database seed**: a trainer still has to exist in a database nobody has
pushed to, which is what "Server hand-off" and *Copy for server* are still for.

## Wild Creature Battle Flow

1. `SpawnerWorldBehaviour.InitializeAsync` completes → calls `SpawnerEncounterBehaviour.Activate(context, spawnerId, wildTrainerId, battleArenaKey)`
2. Player walks into the trigger → `OnTriggerEnter` starts `EncounterDelayRoutine` (2–5s random)
3. If player stays → `StartWildBattle` fires → `StartWildBattleAsync` begins the turn loop
4. If player exits before delay → coroutine cancelled, no battle
5. Turn loop runs until `outcome.battleEnded == true`, then `BattleEvents.RaiseBattleEnded` fires

## An Encounter That Never Starts Has No Result

`StartWildBattleAsync` wraps its whole body in a `try`/`finally`, and the `finally` used to call
`EndBattle(_resolvedWinnerId, _resolvedReason ?? "loop_complete")` unconditionally. Every early
return therefore produced a battle result — and because `EndBattle` derives `playerWon` from a null
winner, an encounter that could not even find an opponent rendered as a full **DEFEAT** summary
labelled `loop_complete`, with no experience, no items and no events.

`_encounterStaged` now separates the two cases. It is set immediately before the fade-to-white that
covers arena staging and the camera cut:

```csharp
finally
{
    if (_encounterStaged)
        EndBattle(_resolvedWinnerId, _resolvedReason ?? "loop_complete");
    else
        AbortUnstagedEncounter();
}
```

`AbortUnstagedEncounter` is deliberately quiet — the player never left the overworld, so the correct
outcome is to leave them there. It cancels any pending action source, sets the ended/closed flags so
a later `CloseBattle` cannot manufacture a `force_close` result, and raises
`BattleEvents.EncounterAborted` for anything that wants to react.

**A `DEFEAT` screen reading `loop_complete` is not a battle you lost — it is a battle that never
happened.** The cause is upstream, usually an empty spawn pool; the Unity console names the spawner
and the spawn status.

## Pickups

`PickupBehaviour` grants a `pickup_definition`'s rewards once per `(trainer, instance)`, then
despawns. Three things had it permanently stuck.

**The definition did not exist.** Every placed pickup asked for `item_heal_potion_30`; the seeded
definitions are `pickup_small_currency` and `pickup_lost_toy` (`pickup_coin_pile` and
`pickup_bouncy_ball` are *model asset keys* on those two rows, not definitions). The lookup returned
null every time.

**A failed lookup left the pickup inert but visible.** `_collecting` was set on entry and cleared
only in the `catch`, so any early return — missing definition, no session yet — left the flag set
forever. The object stayed in the world and could never be collected again. It is now released in a
`finally` on every path that does not despawn.

**The player could not trigger it.** The player is a Malbers rig carrying a dozen colliders, and only
the root is tagged `Player`, so `other.CompareTag` failed for every child. Checking
`other.transform.root` accepts them all — but that alone would let a 5 m AI detection sphere ("Enemy
Search Health") collect a pickup from across the clearing, so a flat distance check against the
trigger radius decides reach. `OnTriggerStay`, not `Enter`: a detection sphere enters first and is
rejected, and on Enter alone the pickup would never be reconsidered while the player stands on it.

Collection now raises `WorldToast` ("You picked up 50 Coins"), named from the granted reward rather
than the content key, which is an authoring detail.

### WorldToast

A static bus in `CR.Core.Notifications`: gameplay raises, UI listens, and nothing in it knows what a
toast looks like. `AchievementToastPresenter` shows both achievements and these. It keeps its
achievement-specific name because the UI rig references it by class name from a scene — worth
renaming when someone is in the Editor anyway.

## A Failed Encounter Re-Arms Itself, and Tries to Fix the Spawner

`SpawnerEncounterBehaviour` gates on `_encounterInProgress` and clears it in `OnBattleEnded`. Since
an aborted encounter deliberately does *not* raise `OnBattleEnded`, the abort alone would leave that
gate stuck and the zone silent for the rest of the session — the player is already standing inside
the trigger, so `OnTriggerEnter` never fires again.

`IBattleCoordinator.OnEncounterAborted` closes that loop. It carries an `EncounterAbort`
(`SpawnerId`, `Reason`, `Message`); zones filter on the spawner id because one coordinator serves all
of them.

**What happens on failure**

| Step | Behaviour |
|---|---|
| Abort arrives | `_encounterInProgress` cleared, failure counter incremented |
| First failure, `NoCreatureAvailable` | One repair attempt — the spawner is rebuilt from its `SpawnerDefinition` |
| Retry | Encounter re-armed after a backoff delay (base doubled per failure, capped at 30 s) |
| After 3 failures | Stops, with an error naming the spawner. Leaving and re-entering the zone resets the counter |

The backoff and give-up rules live in `EncounterRetryPolicy` (pure, unit-tested). Retrying a broken
zone on the normal 2-5 s encounter delay would turn one content fault into a permanent stream of
failed spawns; giving up loudly is more useful than a retry loop that hides it.

### Repair, and what it can actually fix

`ISpawnerRecoveryService` re-syncs the authored `SpawnerDefinition` into the spawner tables. This
works because **the database pool is derived data** — the asset is the source, and the sync writes it
at world init. A pool that lost its templates (a bad sync, a soft-delete sweep) is rebuilt from the
asset; soft-deleted rows are invisible to the read path, so the sync writes fresh ones.

It cannot fix a definition that is itself wrong. If the asset holds templates with no creature key,
the sync resolves nothing, the prune guard declines to delete anything, and `TryRestoreAsync` returns
false — logged as an error, because the content needs a person and no retry will change that.

`EnsureReadyAsync` runs the same check **when the zone activates**, so the common case is repaired
before the player ever walks into the grass, and an unfixable zone reports itself at world init
rather than mid-play.

## The Spawner Sync Never Prunes From a Config It Could Not Read

`LocalSpawnerSyncClient` reconciles the offline database against `SpawnerDefinition` assets: the
templates in the asset are upserted, and templates the asset no longer mentions are soft-deleted.
That second half is only meaningful if the asset was read in full. A template whose creature or
growth profile cannot be resolved is skipped — and a skipped template looks exactly like a deleted
one from the prune's point of view.

That is how a single dangling creature id on the server erased 23 live templates (see
[Backend — Spawner System](../backend/03-spawner-system.md)). `SpawnerPrunePolicy` now gates both
deletions:

- **Templates** — prune only when every template the pool declared resolved. A pool that declares
  nothing and resolves nothing is a real edit and still prunes.
- **Pools** — a definition declaring *no* pools is treated as a failed read rather than an emptied
  spawner. A spawner with no pools cannot roll anything, so designers effectively never author one,
  whereas a broken pull produces exactly that shape.

Stale rows surviving one extra sync is the recoverable failure. The deletion is not.

## Gotchas

**`CurrentTrainerId` null check.** `BattleCoordinator` verifies a trainer session is active before calling `IBattleDomainService`. If the session trainer ID is null, the call is dropped and an error is logged.

**Battle already in progress.** `BattleCoordinator` guards against concurrent starts with a `_battleInProgress` flag. A second `StartWildBattle` while a battle is active is ignored with a warning.

**`SubmitPlayerAction` without a pending turn.** If called when no `TaskCompletionSource` is waiting, a warning is logged and the call is a no-op.

**`EndBattle` idempotency.** `EndBattle` is guarded by a `_battleEnded` bool flag and returns immediately on repeated calls. This prevents double-invocation when `OperationCanceledException` unwinds the turn loop (e.g. player disconnect) while the `finally` block also calls `EndBattle`. The flag is reset at the start of each new battle in `StartWildBattleAsync`.

**`OperationCanceledException` in the turn loop.** When `EndBattle` cancels the `_playerActionSource` TCS during a forced exit, the awaited `_playerActionSource.Task` throws `OperationCanceledException`. A dedicated `catch (OperationCanceledException)` block before the generic `catch (Exception ex)` swallows this silently — it is not an error, and `EndBattle` in `finally` handles cleanup.

**`BattleHttpDomainAdapter` server address.** Reads `game_config.yaml` key `battle_server_http_address`. In local dev this is `http://localhost:8080`. Ensure the AIO host is running.

**`BattleStager` missing creature `AssetKey`.** If `BaseCreature.AssetKey` is empty or the addressable cannot be loaded, the stager logs and returns null for that visual. `BattleCoordinator` then reads the returned `BattleStagingResult`, logs an Error, and raises `BattleEvents.StagingFailed("opponent visual" | "player visual")`. The battle still runs — only the on-arena prefab is missing.

**`BattleStager` no `TrainerWorldBehaviour` in `WorldRegistry`.** Means no player trainer GO is in the scene yet. Stager logs a warning and skips the teleport; creature visuals still spawn. Usually indicates a scene without `TrainerWorldBehaviour` registered (e.g. main menu testing).

**A trainer's team must not also exist as a `SpawnerDefinition`.** `npc-trainer-meadow-scout-team.asset` did, and `SpawnerDefinitionSyncBehaviour` re-synced it into the local database on every world load — silently reverting whatever had just been pushed. The asset is deleted and Content Studio now excludes `<trainerKey>-team` spawners from the Spawners tab entirely (see [Content Registry](?page=unity/08-content-registry)).

**`BattleHUD` IDs are now `Guid`, not `string`.** Comparisons inside the HUD use `Guid` equality; HpChanged events arriving before `CreaturesIdentified` are cached in `_hpCache` and replayed when the IDs land. Out-of-order or dropped events no longer leave the opponent panel blank.

## Related Pages

- [Battle Persistence](?page=backend/09-battle-persistence) — DB tables, `IBattleDomainService`, REST endpoints
- [Battle Extensions](?page=unity/24-battle-extensions) — the sidecar pattern (`ActionResolved` + `IPlayerAbilityAugmenter`) and battle missions
- [Content Registry](?page=unity/08-content-registry) — content keys and `SpawnerDefinition`
- [World Behaviours](?page=unity/03-world-behaviours) — `SpawnerWorldBehaviour`, `IWorldInitializable`
- [NPC Interaction](?page=unity/04-npc-interaction) — `NpcInteractionBehaviour` fires `OnBattleRequested`
- [Dependency Injection](?page=unity/02-dependency-injection) — `IBattleCoordinator` and `IBattleDomainService` bindings
