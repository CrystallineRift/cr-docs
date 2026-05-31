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
| `PlayerMustSwap` | `(string trainerId)` | Player's active creature fainted but has a backup; HUD must force a swap |
| `BattleEnded` | `(bool playerWon, string outcomeLabel)` | Show result screen |
| `RunAttempted` | `(bool success)` | Show escape message |

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
    └─ FireOutcomeEvents (HP bars, faint animations)
    └─ if outcome.BattleEnded → RaiseBattleEnded → break
       else advance activeTrainerId (Guid) + NextRoundKey
```

`SubmitPlayerAction(string actionJson)` is called by the HUD (or any input handler) to unblock the `TaskCompletionSource` awaited in the loop. The action JSON matches the backend's action format, e.g. `[{"type":0,"abilityId":"...","targetCreatureId":"..."}]`.

The wild trainer GUID is `00000000-0000-0000-0000-000000000001` (defined in `WildTrainerIds.WildTrainerId`).

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
2. **`OnBattleClosed`** (arena already restored) → `ICreatureInventoryService.HealTeamAsync(trainerId)` → teleport the player to the merchant → `"Your team was healed."`

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

Assign a `CreatureAnimationProfile` to `BattleCoordinator._defaultAnimProfile`. `BattleCoordinator.FireOutcomeEvents` resolves clip names as: `BattleAnimationConfig.attackClipOverride` → `CreatureAnimationProfile.defaultAttackClip` → hard-coded fallback `"Attack"`.

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

**Zero-config fallback:** if a beat is unauthored, the presenter still cross-fades default Animator states for the core combat beats (`Attack`/`Hit`/`Faint`/`Idle`) — a freshly-added prefab animates immediately; cry/feedback are opt-in.

#### Standard Animator state names

There is a documented naming convention so creature Animator controllers stay consistent. The canonical names live in one place — `CreatureReactionDefaults` — and are shared by the presenter (its fallback states), the **`CreatureReactionProfile` → "Set Standard Defaults"** button, and the controller generator (below).

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

## Offline Battle Stack

The offline battle stack uses the DLL's `BattleDomainService` (same class the backend uses) backed by a local SQLite file (`game.bytes`). Battle tables are created by `DatabaseMigrationRunner.MigrateDomain` on startup.

| Component | Role |
|-----------|------|
| `CR.Game.Data.Sqlite.BattleRepository` | DLL SQLite implementation of `IBattleRepository`; stores battles, rounds, creature states, action log in `game.bytes` |
| `CR.Game.Domain.Services.Implementation.Battle.BattleDomainService` | DLL domain service; full offline battle logic — speed-based first-mover, `BattleResolver` damage, escape RNG, wild creature soft-delete |
| `BattleHttpDomainAdapter` | Online path: implements `IBattleDomainService` against the REST API |
| `OnlineOfflineBattleDomainService` | Routes calls to `battle_online` or `battle_offline` binding based on `IsPlayingOnline` |

> **Note:** The legacy Unity-side stack (`IBattleClient` / `BattleClientUnityHttp` / `OfflineBattleClient` / `OfflineBattleService` / `IBattleRepository` under `CR.Game.Battle.Offline` / `SqliteOfflineBattleRepository`) was removed in favour of the DLL's `IBattleDomainService`. New code must not reintroduce those types.

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

**Turn flow:**
1. `PlayerTurnStarted` fires → `ActionMenu` shown; ability list cached in `_currentAbilities`; ability buttons pre-populated
2. Player presses **Battle** → `ActionMenu` hidden, `AbilityPanel` shown (2×2 grid of up to 4 abilities)
3. Player presses an ability → `AbilityPanel` hidden; `SubmitPlayerAction` called with `[{"type":0,"abilityId":"<guid>","targetCreatureId":"<opponentId>"}]`
4. Player presses **Items** → `ActionMenu` hidden, `BattleBagPanelHandler.Open` called; on confirm `BattleCoordinator.SubmitPlayerAction` is called (or `EndBattle` on capture)
5. Player presses **Run** → submits `[{"type":4}]`

Ability button labels show `"Name (Power)"` e.g. `"Fire Bolt (50)"`. Buttons with no ability are disabled and styled with `.ability-btn--disabled`. `BattleActionType` enum: Ability=0, Item=2, Switch=3, Run=4.

> **Action-payload fix:** the Item action must serialize as `"type":2`. It previously serialized as `"type":3`, which the server interprets as **Switch** — so item actions silently fell through the Switch handler (item effects still applied only because `UseItemAsync` runs separately). Items now correctly use `BattleActionType.Item` (`"type":2`).

`playerAbilities` is populated by `BattleCoordinator.BuildAbilityListAsync` — it queries `IAbilityRepository.GetAbilitiesForProgressionSetAtLevelAsync` for the player's active creature and maps to `WildAbilityDto` for the HUD. `BattleStateDto` (DLL type) does not include ability lists; they are assembled client-side.

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

## Wild Creature Battle Flow

1. `SpawnerWorldBehaviour.InitializeAsync` completes → calls `SpawnerEncounterBehaviour.Activate(context, spawnerId, wildTrainerId, battleArenaKey)`
2. Player walks into the trigger → `OnTriggerEnter` starts `EncounterDelayRoutine` (2–5s random)
3. If player stays → `StartWildBattle` fires → `StartWildBattleAsync` begins the turn loop
4. If player exits before delay → coroutine cancelled, no battle
5. Turn loop runs until `outcome.battleEnded == true`, then `BattleEvents.RaiseBattleEnded` fires

## Gotchas

**`CurrentTrainerId` null check.** `BattleCoordinator` verifies a trainer session is active before calling `IBattleDomainService`. If the session trainer ID is null, the call is dropped and an error is logged.

**Battle already in progress.** `BattleCoordinator` guards against concurrent starts with a `_battleInProgress` flag. A second `StartWildBattle` while a battle is active is ignored with a warning.

**`SubmitPlayerAction` without a pending turn.** If called when no `TaskCompletionSource` is waiting, a warning is logged and the call is a no-op.

**`EndBattle` idempotency.** `EndBattle` is guarded by a `_battleEnded` bool flag and returns immediately on repeated calls. This prevents double-invocation when `OperationCanceledException` unwinds the turn loop (e.g. player disconnect) while the `finally` block also calls `EndBattle`. The flag is reset at the start of each new battle in `StartWildBattleAsync`.

**`OperationCanceledException` in the turn loop.** When `EndBattle` cancels the `_playerActionSource` TCS during a forced exit, the awaited `_playerActionSource.Task` throws `OperationCanceledException`. A dedicated `catch (OperationCanceledException)` block before the generic `catch (Exception ex)` swallows this silently — it is not an error, and `EndBattle` in `finally` handles cleanup.

**`BattleHttpDomainAdapter` server address.** Reads `game_config.yaml` key `battle_server_http_address`. In local dev this is `http://localhost:8080`. Ensure the AIO host is running.

**`BattleStager` missing creature `AssetKey`.** If `BaseCreature.AssetKey` is empty or the addressable cannot be loaded, the stager logs and returns null for that visual. `BattleCoordinator` then reads the returned `BattleStagingResult`, logs an Error, and raises `BattleEvents.StagingFailed("opponent visual" | "player visual")`. The battle still runs — only the on-arena prefab is missing.

**`BattleStager` no `TrainerWorldBehaviour` in `WorldRegistry`.** Means no player trainer GO is in the scene yet. Stager logs a warning and skips the teleport; creature visuals still spawn. Usually indicates a scene without `TrainerWorldBehaviour` registered (e.g. main menu testing).

**`BattleHUD` IDs are now `Guid`, not `string`.** Comparisons inside the HUD use `Guid` equality; HpChanged events arriving before `CreaturesIdentified` are cached in `_hpCache` and replayed when the IDs land. Out-of-order or dropped events no longer leave the opponent panel blank.

## Related Pages

- [Battle Persistence](?page=backend/09-battle-persistence) — DB tables, `IBattleDomainService`, REST endpoints
- [Content Registry](?page=unity/08-content-registry) — content keys and `SpawnerDefinition`
- [World Behaviours](?page=unity/03-world-behaviours) — `SpawnerWorldBehaviour`, `IWorldInitializable`
- [NPC Interaction](?page=unity/04-npc-interaction) — `NpcInteractionBehaviour` fires `OnBattleRequested`
- [Dependency Injection](?page=unity/02-dependency-injection) — `IBattleCoordinator` and `IBattleDomainService` bindings
