# Changelog

## 2026-08-03 — fixed: loading into combat could leave the screen white

Reported symptom: entering a battle showed a white screen that faded in and never cleared.

The battle paths were not missing the fade-out — both wild and NPC start already do
`cover → stage → reveal`. The bug was in `ScreenFader` itself:

```csharp
if (_run != null) StopCoroutine(_run);   // old fade's TaskCompletionSource never completes
```

`StopCoroutine` does not run the remainder of a coroutine, so a superseded fade's
`TaskCompletionSource` was **never completed and its awaiter hung forever**. Callers sequence
`await cover; …stage…; await reveal;` — so once a cover fade was superseded, the awaiting battle
setup never resumed and the reveal line was never reached. The overlay stayed opaque white.

Three fixes:

1. **A superseded fade now completes its TCS** (`TrySetResult(false)` = "did not finish") instead
   of stranding the awaiter. This is the actual cause.
2. **The fade advances on `Time.unscaledDeltaTime`.** On scaled time a paused game (`timeScale 0`)
   would leave `deltaTime` at 0, so the loop could never advance and the cover would never lift.
3. **The reveal moved into a `finally`** on both the wild and NPC start paths, so a staging failure
   between cover and reveal can no longer strand the player behind an opaque overlay. Added
   `ScreenFader.ClearImmediate()` as a hard safety valve.

Contributing factor worth knowing: `CloseBattle` fires `CloseWithFadeAsync()` **un-awaited**, so a
new battle starting while the previous close-fade is mid-flight supersedes it — which is precisely
how a fade got superseded in normal play. That is now harmless rather than fatal.

Verified live by exercising the defect directly: starting a 3s cover and immediately superseding it
now completes the first task (previously it would never complete), and the overlay settles to
`alpha=0`. Fader alpha measured at 0 both mid-battle and back in the overworld.

**Test gap, stated plainly:** this is coroutine/`TaskCompletionSource` lifecycle, which EditMode
cannot exercise — the project has no PlayMode test assembly (both existing test asmdefs are
pure-logic EditMode). Standing one up is a larger change than the fix; this is currently covered by
live verification only, and a PlayMode regression test is the right follow-up.

## 2026-08-03 (later) — acting on the measurements

Follow-ups driven by the world-init numbers rather than by guesswork.

### Merchants no longer re-roll their entire stock on every world load

`NpcMerchantBehaviour` calls `StockFromSpawnerAsync` on every world load, and the restock guard
only applied when the spawner defined a cooldown. The seeded `starting-merchant-items` spawner has
`restock_cooldown_seconds = 0`, so the guard never fired and every merchant **cleared and re-rolled
its whole inventory on every load** — a serial write loop per merchant, linear in merchant count.
It was also a gameplay exploit: reloading rerolled the shop's contents.

A cooldown of 0 now means *"do not auto-restock"*, not *"restock every time"*. First-time stocking
still happens (empty merchant), an elapsed cooldown still restocks, and `force: true` still
restocks unconditionally. 5 new tests cover each branch.

Measured on the live save: merchant world-init **~40ms → ~19ms**, world init total **~290ms →
~275ms**, and the merchant's stock is now byte-identical across loads (previously re-rolled).

### Bag panel no longer does a query per item mid-battle

`BattleBagPanelHandler` fetched an item definition per distinct backpack item every time the bag
opened — during a battle turn, in front of the player. It now reads the item catalog once and
indexes it (item definitions are bounded content data). The fetch is capped at 500 rows and
**logs a warning if the cap is hit** rather than silently rendering items without definitions.

### Item ownership check de-duplicated

`ItemUseDomainService` had the same inventory-walk copy-pasted for item use and held-item equip.
Both now call one `FindOwnedEntryAsync`. This is a clarity fix, not a speed one — the walk already
stopped at the first match, so its cost is bounded by inventory count.

### Not changed: `TrainerWorldBehaviour` (~40% of world init)

Investigated because the measurement singled it out. Its cost is `LoadVisualAssetsAsync` — the
Addressables load of the rigged character model. That is legitimately expensive I/O, not a code
defect, and it must finish before the player can be shown. Left alone.

Backend 29/29 projects, Unity EditMode 103/103.

## 2026-08-03 — world-init measured: don't parallelize it

The serial `GameInitializer` loop was the last open item from the performance sweep. It is now
**measured rather than assumed**, and the answer is to leave the loop alone.

`GameInitializer` retains per-initializable timings from the last world load
(`LastRunTimings` / `LastRunTotalMs`), read back by the new `cr_worldinit_report` pipeline command.
The instrumentation exists because the loop's own Debug lines scroll out of the 100-line console
buffer long before a load finishes — which is exactly why this question went unanswered for so long.

Three runs, 8 initializables, steady state ≈ **290ms** total (first run 336ms, cold):

| ms | share | initializable |
|----|-------|---------------|
| 106–140 | ~40% | `TrainerWorldBehaviour` |
| 48–59 | ~17% | `QuestWorldBehaviour` |
| 39–43 | ~15% | `NpcWorldBehaviour` (Merchant) |
| 38–48 | ~14% | `SpawnerDefinitionSyncBehaviour` |
| 19–20 | ~7% | `TeamSync` |
| 13 | ~5% | `InventorySync` |
| 4–6 | ~1% | `NpcWorldBehaviour` (Quest Giver) |
| 3–4 | ~1% | `SpawnerWorldBehaviour` |

**Verdict: not worth the redesign.** Perfect parallelism caps out at ~170ms saved, and respecting
the real dependencies (trainer before team/inventory sync, spawner definitions before spawner
state) the realistic floor is ~165ms — about **125ms saved on a one-time load that already sits
behind a fade**. That does not justify adding a dependency-declaration contract to every
initializable plus the race risk that comes with it.

Two findings worth more than the parallelism would have been:

- **`TrainerWorldBehaviour` alone is ~40% of world init.** If load time ever needs to come down,
  optimizing or deferring that single item beats parallelizing all eight.
- **Per-NPC cost scales with content, and that is the real risk.** The merchant NPC costs ~40ms
  against the quest giver's ~4ms; the difference is `StockFromSpawnerAsync` restocking on every
  world load. With two NPCs that is invisible, but it is linear — twenty merchants would add
  roughly 800ms to every load. This is the same "grows with content" shape as the bugs already
  fixed this week, and is the thing to watch as the world fills out.

## 2026-08-02 (round 2 — larger blast radius)

Second pass over the performance backlog, taking the items that needed interface changes or
touched shared code rather than a single call site.

- **Sync-over-async removed from the startup path.** `GameAccountRepository.TryGet(identifier, out
  Account)` blocked on `GetAsync(...).Result` — an HTTP round-trip resolved by blocking Unity's
  main thread, which both stalls the frame and risks deadlocking (the awaited continuation wants
  the thread the caller is holding). It implemented no interface (`IGameRepository` declares the
  async `TryGetAsync`) and had **zero callers**, so it's deleted rather than rewritten. A comment
  marks the spot so a blocking wrapper doesn't come back. The other `.Result` hits in the client
  were checked and are safe — they read handles already known to be complete.
- **Creature batch fetch replaces an N+1 on the party/box path.** `CreatureInventoryService`
  looped `GetCreature` once per slot; this backs team and storage rendering *and* runs twice per
  battle round via `GetTeamAsync`. New `IGeneratedCreatureRepository.GetCreaturesByIdsAsync`
  resolves the whole page in one query (Dapper `IN`, lowercased ids on SQLite to match the stored
  GUID casing), and the service re-orders results to slot order since a batch query guarantees
  none. 6 new SQLite data tests cover soft-deleted exclusion, the current-HP join, mixed-case
  GUID matching, unknown ids and empty/null input.
- **Quest requirement evaluation reads each fact once.** `ConditionEvaluator` re-read the same
  data per requirement — every `HasItem` walked every inventory again, every `QuestCompleted`
  re-read the whole completed list, and stats were re-fetched per requirement. It now uses a
  per-pass read-through memo (item totals summed across inventories once, completed list once,
  each stat key once). Caching is scoped to a single evaluation — requirements are checked against
  a snapshot with no interleaved writes, so this is behaviour-preserving, and a test asserts the
  cache does **not** leak between evaluations. 6 new tests.

Backend 29/29 projects green throughout.

**Deliberately not changed: `GameInitializer` serial world-init.** Every `IWorldInitializable` is
awaited in sequence on world load, and `NpcWorldBehaviour` nests a serial sub-behaviour loop
inside it. Parallelizing looks tempting but is unsafe as written: `IWorldInitializable` declares
no ordering, registration order is just `Awake` order, and there are real implicit dependencies
(trainer load before team/inventory sync, spawner definitions before spawner world state).
Doing this properly needs an explicit phase/priority contract so each initializable declares what
it depends on, and then parallelism *within* a phase — a design change, not a tuning change. It
should also be measured first: the loop already stopwatch-logs each item, so a single instrumented
world load will show whether this is worth the redesign.

## 2026-08-02 (later)

### Performance sweep: unbounded tables and repeated work on hot paths

Follow-up to the merchant freeze — an audit of what actually accumulates in a save, plus a
codebase sweep for serial-await/N+1/per-frame offenders. Fixed:

- **Battle action log was read in full, twice per round.** `GetBattleStateAsync` eagerly loaded
  the entire `battle_action_log` on every call (once before the player's turn, once before the
  AI's) — and **no caller anywhere read the field**. Turn latency grew with battle length for a
  payload nobody consumed. The eager load is gone, and `GetActionLogAsync` is now bounded
  (`maxEntries`, default 200, newest-first then re-ordered chronologically) so it can't become
  unbounded again.
- **Stale battles / leaked wild creatures.** Force-quitting mid-battle left the row `Active`
  forever and stranded its uncaptured wild creature as a live DB row (12 stale battles / 10
  leaked wilds in the dev save). `StartBattleAsync` now sweeps the trainer's stale Active
  battles, marking them `Abandoned` and releasing their wilds. Verified live: an injected stale
  battle came back `Abandoned` with its wild soft-deleted.
- **`spawner_spawn_history` grew forever** — one row per wild encounter since the save was
  created, never pruned. Writes now prune past a 30-day retention window, **throttled** to at
  most one sweep per 10 minutes (the delete is a table scan, so it must not run per spawn).
- **Merchant shop N+1.** Opening the shop cost 3 serial round-trips per stock row, two of them
  redundant: `CalculateBuyPriceAsync` re-reads the NPC *and* re-reads the same item the UI had
  just fetched. The screen now reads the buy multiplier once and does the arithmetic locally
  (3N → N+1).
- **Per-frame `GetComponent` in the battle camera.** `BattleCinematicDirector.Update` resolved
  the establishing camera and its `CinemachineOrbitalFollow` every frame, for the whole duration
  of every battle, for a reference that never changes mid-battle. Now cached, invalidated on
  EnterBattle/ExitBattle.

Save-data cleanup applied to the dev save (backed up first): 12 stale battles closed, 67 wild
creatures released, 52 orphaned `generated_creature_current_stats` rows deleted, spawn history
older than 30 days pruned, action logs for finished battles dropped, `VACUUM`.

New tests: stale-battle sweep (Game.Domain.Services) and three spawn-history pruning tests
(Spawner.Data.Sqlite, including one asserting the throttle so the prune can't regress into a
per-spawn scan). Backend 29/29 projects green.

**Known remaining (documented, not yet fixed)** — ranked, from the same sweep:
`GameInitializer` initializes every `IWorldInitializable` strictly serially on world load (and
`NpcWorldBehaviour` nests a serial sub-behaviour loop inside it); quest-requirement evaluation on
NPC interact is a three-deep serial nest (`QuestDomainService` → `ConditionEvaluator` →
per-inventory item reads); `CreatureInventoryService.GetCreaturesAsync` is an N+1 per creature on
every party/box display; `GameAccountRepository:71` blocks on `.Result` over an HTTP call on the
startup path. These are ordering-sensitive or wider-blast-radius changes and want their own pass.

## 2026-08-02

### Fixed: 10-second freeze when talking to the merchant (quest instance stacking)

The freeze wasn't the shop at all. The stat-event log showed `quest_claim` firing **38 times over
~9 seconds** the moment the merchant NPC was talked to: the non-repeatable "Welcome To CR" quest
had **38 stacked instances** — auto-granted once per boot, because `QuestGranterBehaviour`'s
`grantOnce` only dedupes per session (in-memory) and the backend `AcceptQuestAsync` never checked
for an existing instance. One NPC talk satisfied all 38 at once and the serial claim pipeline
(rewards + stats + achievement eval per claim) stalled the main thread for ~10s.

Fixes:
- `QuestDomainService.AcceptQuestAsync` is now idempotent: a **non-repeatable** template with any
  existing instance (any status) returns that instance instead of creating another; a
  **repeatable** template only re-accepts when no instance is currently in progress. 3 new unit
  tests; Quests 19/19 + Game 386/386 green.
- Player save dedupe: 57 duplicate/orphaned quest instances soft-deleted (kept the oldest per
  template — including 13 orphans of a template that no longer exists in the content DB).
  Verified across three live boots: instance count stable, new templates still accept.
- Known cosmetic residue: the `quests_completed` lifetime stat was inflated to ~45 by the
  duplicate claims.

### Over-the-shoulder camera framing + character micro-stutter fix

- **Character micro-stutter (the "head vibration")** — root-caused by measurement, not guesswork:
  a probe sampling the head bone's per-frame angular delta showed stepped bursts (max 8× the
  mean). `MAnimal.Awake` force-sets the Animator to **Fixed** update (50Hz physics ticks) with
  `Rigidbody.interpolation = None`, so at 60+ fps the pose freezes then double-steps every few
  frames — a ~10Hz aliasing shimmer, most visible on the head. `MalbersMovementController` now
  sets `Animator.updateMode = Normal` + `Rigidbody.interpolation = Interpolate` after MAnimal's
  Awake (Malbers fully supports Normal mode). Measured: maxDelta 1.10° → 0.40° at identical mean
  — stepping eliminated. (The Malbers demo `Aim` component stays disabled too — head IK from a
  FixedUpdate camera raycast, no CR gameplay uses it. Disabling it alone did NOT fix the
  stutter; the update-mode aliasing was the cause.)
- **Framing**: shoulder offset (0.6, 0.5, 0), camera distance 3.8 (tunable via
  `cr_setup_overworld_camera --distance/--shoulderX/--shoulderY`), and the camera now starts
  each overworld entry at a level ~8° pitch. Previously it inherited whatever pitch the boot or
  battle flow left behind — battle exit re-syncs the rig's pitch from the battle camera (which
  was staring down at the arena), so `OverworldCameraGate` re-frames on `BattleClosed`, one beat
  after the camera cut, still under the reveal fade.
- New probes: `cr_jitter_measure`/`cr_jitter_report` (head-bone angular-delta sampler),
  `cr_toggle_component` (runtime A/B), `cr_trainer_components` (component tree dump), and the
  pipeline `eval` command turned out to be the fastest way to inspect/mutate live state.
  Discovered during testing: walking off the world edge puts the trainer in free-fall (a
  respawn eventually catches it) — invalidated one whole measurement round.

### Look settings, spawn-in gating, and controller support on the startup menu

Batch of overworld input/camera polish:
- **System ▸ Controls settings**: Look Sensitivity slider (0.1–2.0×, persisted as
  `look_sensitivity`) plus Invert Look Y / Invert Look X toggles. `CameraLookSettings` on the
  camera rig applies stored values at startup and live on change; the default is now **0.5×**
  (the Malbers authored 1.0 was too twitchy).
- **Nothing moves until you spawn in**: `PlayerInputGate` is now UIContext-aware — the Player
  action map only enables in the Overworld (was: enabled from scene load, so WASD moved the
  character behind the main menu). `TrainerMovementController` no longer force-enables the map.
  New `OverworldCameraGate` (replaces the orphaned `CameraInputGate`, deleted) allows camera
  rotation only when movement is ready AND context is Overworld.
- **Player hidden on the menu**: new `TrainerVisibilityGate` disables the trainer's renderers
  outside the overworld/battle so the character no longer stands in the world behind the main
  menu. Known cosmetic nit: a Malbers "Dust Track" ground decal can still appear at the feet
  position pre-spawn.
- **Controller works on the startup menus**: MainMenu and CharacterSelect now set an initial
  focused button when shown — gamepad/keyboard navigation needs a focus root to start from,
  and without one the controller did nothing.
- `cr_setup_overworld_camera` now also installs the gate + settings components and clears
  missing-script remnants. Verified headlessly: menu = frozen camera + immobile hidden trainer;
  overworld = visible trainer, live camera (yaw 90→290 on look), movement follows camera;
  sensitivity 0.5 applied on the rig. Note: `NavigateTabsLeft/Right` actions exist in
  `CR_GameInput` but are not yet wired to the player menu's TabView (pre-existing gap).

### Fixed: overworld movement directions + added a real third-person camera

Two long-standing issues in the Malbers movement shim:
1. **Directions were world-space, not camera-relative.** `MalbersMovementController` called
   `MAnimal.Move()` — Malbers' AI/direction entry point, which treats the stick vector as a
   world-space direction ("up" always walked toward world +Z). Player input now goes through
   `SetInputAxis()` with `UseCameraInput = true`, Malbers' camera-relative path.
2. **There was no overworld camera controller at all.** The scene had a `CinemachineBrain` and a
   `CameraInputGate`, but the `ThirdPersonFollowTarget` rig the gate requires was never added, and
   nothing fed look input. New editor command `cr_setup_overworld_camera` instantiates the Malbers
   "CM Third Person Main (New Input)" prefab, targets the scene trainer, retargets Look/Zoom to
   `CR_GameInput` (`Player/Look`, `Player/Zoom`), and sweeps duplicate rigs (idempotent).

Also: `SetSpeed` no longer maps to `MAnimal.TimeMultiplier` (that's a global time scale — it made
everything slow-motion, not faster movement). Verified headlessly with new probes
(`cr_move_probe`, `cr_cam_look_direct`, `cr_ui_gamepad_stick`, key hold/release phases on
`cr_ui_press_key`): camera yaw rotates via the look path, and walking forward with the camera
rotated 112° moves the trainer exactly along the new camera heading. Physical mouse feel check
remains the human gate (synthetic mouse deltas can't cross the editor/play input buffer split).

### Battle log moved to the upper-left

The in-battle notification panel (`.battle-log` in BattleHUD) no longer floats front-and-center
over the action: `.hud-middle` now aligns flex-start with left padding, the log caps at 40%
width, and its text is left-aligned. New probe: `cr_ui_screenshot` captures the real backbuffer
(UI Toolkit overlays included) to `Temp/ui_shot.png` — pipeline `screenshot`/`capture_game_view`
render cameras only and miss UITK.

### Fixed: overworld menu hotkeys were completely dead (I / Escape / Start did nothing)

Three stacked causes, found by probing the live input chain headlessly:
1. The scene's `PlayerMenuWindow.inputActionsAsset` pointed at **Malbers Inputs** — an asset that
   has a `UI` action map (so init "succeeded") but no `ToggleMenu` action, leaving the handler
   silently unsubscribed.
2. The code fallback loaded `InputSystem_Actions` — a **legacy near-duplicate** of the live
   `CR_GameInput` asset that the input gate, movement, and NPC interaction actually use.
3. The earlier "Escape toggles the menu" rebind had been authored into that stale duplicate, so
   the live asset still carried the old `CloseMenu ← Escape` binding.

Fixes: the scene reference now points at `CR_GameInput` (saved via the editor pipeline);
`PlayerMenuWindow.ResolveInputActions()` binds from the first asset that actually contains
`UI/ToggleMenu` (serialized → CR_GameInput → InputSystem_Actions) and logs an error on a bad scene
reference instead of failing silently; Escape moved to `ToggleMenu` in `CR_GameInput` (`CloseMenu`
now unbound); freshly bound actions are disabled outside `UIContext.Overworld` so the hotkey is not
live on the main menu. New headless probes: `cr_ui_input_dump` (context/asset/action/map/device
state) and `cr_ui_press_key` (synthesizes real keyboard input). Verified live: I opens, Escape
closes in the overworld; nothing fires on the main menu. EditMode 103/103 green.

## 2026-07-31

### Fixed: wild-battle loot never actually dropped (and combat XP under-counted)

Live verification of the loot display exposed a backend ordering bug: on a wild win,
battle-end cleanup soft-deletes the uncaptured wild creature **before** the loot roll, and the
roll's `GetCreature` (filtered `deleted = false`) came back null — loot silently skipped on every
real wild victory (`[Battle] Skipping loot roll — could not resolve creature content_key`). The
combat-XP path had the same latent read: `defeated?.Level ?? 1` degraded every battle-ending KO
to level 1. `BattleDomainService` now loads the defeated creature once before the battle-end
branches and passes it to both `AwardBattleExperienceAsync` and `RollAndGrantBattleLootAsync`.
Unit tests missed this because mocks returned the creature regardless of deletion; a new
regression test uses a stateful mock (GetCreature → null after DeleteCreature). Verified live
headlessly: `LOOT [Currency] qty=11` and the VICTORY screen's **ITEMS RECEIVED — Currency +11**.
The smoke harness also gained a 4s summary hold + `ScreenCapture` backbuffer screenshot
(`Temp/smoke_summary.png`) because pipeline screenshot commands render cameras only and miss
UI Toolkit overlays, and its turn budget rose to 15 so wins are reachable.

### Battle loot is now visible: ITEMS RECEIVED shows currency + item drops

The backend already rolled and granted loot on wild-battle wins (currency and items — cindris
drops 10–30 currency, the starter zone adds a 40% heal-potion / 70% currency roll); the summary
screen just never showed it. Now the sequencer raises a new `BattleEvents.LootAwarded` per grant
from the battle-ending outcome's `LootAwards` (aftermath beat), and `BattleSummaryScreen` renders
them: a summed **Currency +N** row first, then items alphabetically with ×quantity, content keys
humanized ("item_heal_potion_30" → "Heal Potion 30"). Aggregation/formatting is pure
`LootSummaryFormat` (`CR.Game.Battle.Logic`) with 13 new test cases. The smoke harness now logs
`LOOT [...]` lines and fights to a win (15-turn budget) so drops are verifiable headlessly.
Note: loot events ride `BattleEvents` directly (like the creature presenters) rather than a new
SO event channel — the channel manifest/codegen step is Editor-authored and can be added later.

## 2026-07-30 (later still)

### Player-configurable Combat Speed + wider battle framing

Combat pacing is now a player setting: pause menu **System ▸ Combat Speed** (Fast 0.75× /
Normal 1× / Relaxed 1.4×) persists `battle_pacing_scale`, which `BattlePresentationSequencer`
applies to every beat duration at battle start (clamped 0.5–2.5; the System card's first
functional setting). Verified live via the smoke harness: turn-to-turn gap stretched 2.3s → 3.1s
at Relaxed. Automation hook: `cr_set_combat_speed --scale <x>`. The battle camera also pulls
back: `BattleCameraProfile.fovWidenMultiplier` (default 1.15) widens all rig vcams on battle
enter and restores the authored lenses on exit.

## 2026-07-30 (later)

### Battle FX verified end-to-end for both sides — by a self-driving smoke test

New pipeline-CLI harness (`cr_battle_fx_smoke_start`/`_status` + `cr_world_dump`,
`BattleFxSmokeRunner`) plays the game like a human: clicks through the startup menu (Continue →
character select), starts a real wild encounter through the spawner's own path, auto-plays two
ability turns, flees/acknowledges the summary, and reports per-side FX verdicts. Final run:
**player Scratch impact spawns at the opponent; wild Fire Blast plays the full staged chain**
(cast SFX+VFX at caster → travel VFX across the arena → impact SFX+VFX at the target on arrival),
zero load warnings. En route it exposed and fixed three real bugs: `BattleCoordinator` raised
`PlayerTurnStarted` before creating the action-wait source (programmatic submits hung the turn);
battle-path `TaskCompletionSource`s lacked `RunContinuationsAsynchronously` (coroutine completions
resumed the round loop inline); and **persistent HP had the whole roster at 0** from prior
playtests, making every battle an instant Loss (save healed; keep a heal flow in mind for real
players). Also surfaced: in online mode content sync mirrors the server, so ability FX must be
**published** to appear online — offline seeds alone aren't enough (Fire Blast got placeholder
fire FX published + seeded). Follow-up to investigate: the player creature dropped out of the
visual registry on turn 2 (`caster=NOT IN REGISTRY`) — FX fell back to captured position, worth a
look alongside faint/recall handling.

## 2026-07-30

### Content loop is now fully headless (Unity Pipeline CLI)

`com.unity.pipeline` (0.4.0-exp.1) + Unity CLI beta.3 drive the open Editor from the shell:
compile (`recompile`), tests (`run_tests` — 91/91 EditMode green headlessly), console reads, and
now CR's own tooling via `[CliCommand]`s in `CrPipelineCommands`: `cr_fx_seed_status`,
`cr_export_fx_seeds`, `cr_rebake_floor`. The rebake exposed two real bugs, both fixed: the temp
output directory was never created (SQLite "unable to open database file" — also latent in the
menu variant), and spawning `dotnet` from the Editor inherits Unity's `DYLD_*`/`DOTNET_*`/
`MSBuild*` environment, which must be stripped. Verified end-to-end: status → export → rebake →
floor at schema 9997 with authored FX intact.

## 2026-07-21

### Enemy FX weren't playing: stale floor seed (+ Publish now warns about it)

Authored Scratch FX (`fx/clawslash-circus`) existed on the AbilityConfig but never reached the
offline floor — the seed migration hadn't been re-exported after the authoring session, so enemy
Scratch raised cues with empty keys. Regenerated `M9997SyncAuthoredAbilityFx` from the current
assets (Ember, Hydro Pump, **Scratch** now carry FX) and rebaked the floor. To stop this drift
from recurring silently, **Publish now includes an "Offline floor seed" step**: it compares the
generator's output against the exported migration and warns (non-blocking) when an export +
rebake is needed.

### FX picker: Piloto Studio pack + adopt-on-use into the content folder

The Piloto Studio pack (19 prefabs incl. the Claw Slashes set) was invisible to the Workbench FX
picker — scan roots are a hardcoded list and didn't include `Assets/Piloto Studio`. Added. Beyond
that, effects are now **adopted on use**: picking (or drag-and-dropping — Publish catches those)
an asset from any pack copies it into `Assets/CR/Content/Effects` (audio under `Effects/Audio`),
stamps the copy with its source GUID for idempotent reuse, claims byte-identical pre-existing
hand-copies instead of duplicating, and assigns + registers the addressable against the CR-owned
copy. Content no longer references third-party folders directly. Rules live in pure
`FxAdoptionRule` with 10 new EditMode tests.

## 2026-07-19

### In-Editor floor rebake + FX seed migration export

Two new menu items close the content-authoring loop without a terminal.
**CR → Content → Export Ability FX Seed Migration** snapshots every AbilityConfig's presentation
values (animation/camera/FX keys — auto-derived from AssetReferences when blank — plus FX
lifecycle) into cr-api's `M9997SyncAuthoredAbilityFx`, regenerated in place with stable ordering
by the pure, unit-tested `AbilityFxSeedMigrationGenerator` (7 new tests). The export is
authoritative and the dialog offers a chained floor rebake.
**CR → Content → Rebake Offline Floor** runs the cr-api Migrations.Tool in the background
(cancelable progress bar, no main-thread stalls), copies the fresh `game-data.bytes` into
StreamingAssets, and reports the schema version; **Full Package Rebuild** shells the whole
`build-packages.sh` for when cr-api C# changed. The initial `M9997` (all 16 abilities) ships with
this change — floor is at schema **9997** — and it compiles warning-free and passes the full
migration test suite on both engines.

### Ability FX stages now sequence and auto-stop

Previously all three ability effects (cast, projectile, impact) spawned **simultaneously** and were
hard-destroyed after a flat 4 seconds — impact appeared while the projectile was still flying, and
looping effects lingered. The responder now plays stages in order (impact waits for projectile
arrival, impact SFX at the moment of arrival) and, per new ability-level config, **stops each stage
shortly after the next one starts**: `fx_auto_stop` + `fx_stop_delay_ms` columns (M9996, defaults
on/50ms) flow ability → battle outcome → `AbilityFxCue`; stopping cuts particle emission so live
particles fade instead of popping, with the 4s lifetime kept as a safety net. Authored in the
AbilityConfig **Advanced ▸ FX lifecycle** section and carried through publish (workbench + runtime
sync clients) and the offline cache sync. Stage sequencing rules extracted into pure
`AbilityFxStagePlan` (`CR.Game.Battle.Logic`) with 6 new EditMode tests. Along the way the runtime
ability sync DTO was found to be dropping **all** FX keys on publish (would have nulled server FX
columns) — fixed.

### Pre-existing Postgres test breakage fixed (suite fully green)

Four Postgres test projects had been failing for unrelated, pre-existing reasons; all fixed and
`run-all-tests.sh` is green across all 29 projects. Root causes: test SQL still inserting the
`asset_id` column dropped by M1021 (2 Spawner projects); a real product bug — unguarded
`LOWER(id)` in `BaseGrowthProfileRepository.Get` crashing on Postgres `uuid` (engine-branched like
its siblings); `GeneratedCreatureRepositoryTests` inserting `Guid.Empty` progression-set FKs
(SQLite doesn't enforce FKs, Postgres does); and `BaseItemRepository.BuildParams` missing
`captureModifier` — Postgres parsed the unbound `@captureModifier` as an operator + bogus column
(the item upsert was also missing the value entirely, which would have crashed item content sync).
Also fixed a ~5%-flaky capture test (`Times.Never` verify was counting invocations from earlier
roll attempts).

## 2026-07-18

### Battle FX now reach the database (dedup + seeded FX keys)

Ability sounds/visuals never played because the FX-key columns on `abilities` were `NULL`
everywhere the battle actually reads: the `M9994` demo seed wrote explicit `NULL`s, the `M9990`
authored seed carried no FX columns at all, and creatures' progression entries pointed at
duplicate demo rows (a second Ember/Scratch under different ids). New migration
`M9995DedupAbilitiesAndSeedAbilityFx`: canonical ability id = the Unity `AbilityConfig` asset id;
all references (`ability_progression_set_entry`, `ability_status_conditions`,
`generated_creature` slots) remapped onto canonical rows; duplicates soft-deleted; Ember's
`fire_ember` animation key carried over; the bogus `creatures/crabby` hit-VFX on Scratch cleared;
and the authored FX keys (Ember + Hydro Pump, the Ability Workbench starter set) seeded so the
baked floor carries them. Floor rebaked to schema **9995** (clients re-adopt automatically).
Covered by a new `AbilityDedupAndFxSeedTests` fixture running the full migration chain
(`CR.Data.Migrations.Test`, SQLite + Postgres, 33 green). Docs: canonical-id section on
[Battle Persistence](?page=backend/09-battle-persistence); the Ability Workbench
"Remember the floor" section now states the real rule — published FX keys must be copied into a
seed migration to survive a rebake. Remaining 14 abilities still need FX authored in the
Workbench.

## 2026-07-08

### Standalone build readiness (macOS + Windows)

Desktop builds unblocked. `build-packages.sh` now always bundles **both** SQLite natives
(`libe_sqlite3.dylib` osx-arm64 + `e_sqlite3.dll` win-x64) into the Unity package — previously it
shipped only the primary architecture, which would have crashed a Windows build on first DB open.
New **CR → Build → Create Standalone Build Profiles** menu (`BuildProfileSetupTool.cs`) creates
`CR_Game_macOS` / `CR_Game_Windows` profiles via the internal Unity 6 factory (reflection);
Addressables switched to build content with the player. New [Standalone Builds](?page=unity/21-standalone-builds)
page covers profiles, natives, the offline data floor, and known limits (Mono-only Windows
cross-build, arm64-only mac native). Follow-up: the package no longer ships `Newtonsoft.Json.dll` —
the vanilla copy shadowed Unity's AOT-patched `com.unity.nuget.newtonsoft-json` on build-target
switch, breaking `com.unity.services.core` editor compilation (`AotHelper` CS0103); CR DLLs bind
to Unity's copy. Also added a Linux x64 profile (`CR_Game_Linux_SteamDeck`) and `libe_sqlite3.so`
to the bundled natives for Steam Deck.

### Addressables now bake into builds (shipped builds had none)

The profile's `Local.BuildPath`/`Local.LoadPath` had been repurposed for the MinIO dev workflow
(build to `ServerData/`, load from `http://localhost:9000/…StandaloneOSX`), so distributed builds
contained zero addressable content and streamed everything from the tester's own localhost.
Restored true local paths (all groups bake into the player), pointed `Default Local Group` at
them too, and fixed `Remote.LoadPath` to use `[BuildTarget]`. Live-update path (baked floor +
streamed deltas via remote catalog + content-update builds) documented on the
[Standalone Builds](?page=unity/21-standalone-builds) page.

### Captured creatures join the team when there's room

Capture placement was hard-wired to storage — a comment claimed `AddToStorageAsync` handled
team-if-space internally, but it never touched the team. New
`ICreatureInventoryService.AddToTeamOrStorageAsync` places the catch on the team when a slot is
free (next free slot, capacity 6) and falls back to storage; `InventoryAddResult.AddedToTeam`
reports the destination. Both capture paths (online `CaptureCreatureHandler`, offline
`OfflineItemUseService`) now use it, so behavior is identical either way. Covered by 3 new
placement tests + updated handler tests (385 green in `CR.Game.Domain.Services.Test`).

### Battle FX pipeline debug logging

`BattleAbilityFxResponder` logs the resolved cue (keys + registry hits) and every spawn/load
result; `BattleEventDebugLogger` subscribes to `AbilityFx`; `BattleStager` logs the registry id
each visual registers under. One battle run in the console now pinpoints which link of the
ability-FX chain (cue → keys → registry → Addressables load) is broken.

## 2026-07-07

### Test infrastructure repaired + suite fully green (979 tests, 29.2% line coverage)

Round 2 added 206 tests — a new Auth test suite (61 tests, 3 projects: SQLite repo, JWT/model, password/claims security) and +145 Game.Domain.Services tests (wild AI, item-use service + 5 untested handlers, creature inspection/progression, battle FX-key propagation, read paths). **Testing exposed 7 production bugs**: 4 in Auth (OAuth SQL vs missing columns, `PasswordHashed` never mapped on read, `GetAccountId()` claim-type mismatch, unenforced email uniqueness — dormant while the game is device-bound, must be repaired before online-account work) and 3 in Game (creature summary computes level from XP instead of stored `Level`; dead replace-ability branch means full-roster creatures learn nothing on level-up; wild-AI heal heuristic documented but absent). All pinned as regression tests.

`run-all-tests.sh` had been running a hardcoded 6 of 25 test projects (one nonexistent) and its `--coverage` flag produced broken MSBuild switches — "all tests green" covered a quarter of the suite. Fixed: auto-discovery of every `*Test*.csproj`, working coverage collection (bash-array quoting), `coverlet.collector` added to the 5 projects that silently emitted no data. Six broken projects repaired (stale damage-formula expectations, missing `SKIP_DOCKER_TESTS` guards, an NUnit setup-ordering NRE, test DDL missing evolution columns, a `CS0104` build ambiguity, xUnit throw-instead-of-skip fixtures, a quest-objective upsert test-data bug). Currency test gaps closed with a new `CR.Trainers.Data.Sqlite.Test` project. Unity: Ability Workbench decision logic extracted into `CR.AbilityWorkbench.Logic` with ~47 tests across 6 fixtures. Full report: `CR/guides/cr-coverage-report.html`.

### Ability Workbench — guided FX authoring for abilities

New editor tooling so a designer ships a fully-effected ability without touching GUIDs, key strings, or the Addressables window (branch `feature/ability-workbench`). Built after research confirmed the battle FX pipeline itself was intact and effects weren't playing purely because ability FX/SFX keys were never authored (17 of 18 abilities had no VFX keys, none had SFX).

- **Reworked `AbilityConfig` inspector**: readiness strip (`Basics ✓ · Effects 2/3 · Sound 0/3 · Not published`), visual Cast/Travel/Impact effect slot cards, auditionable sound rows, status-effect summary rows, and a single **Publish** button; every technical field (keys, raw AssetReferences, individual sync buttons) moved under an **Advanced** foldout. ([Ability Workbench](?page=unity/20-ability-workbench))
- **FX Library picker**: virtualized thumbnail grid over the project's ~400 FX prefabs (ParticleSystem + VFX Graph detection) with element filter chips and heavy-asset warnings; one pick assigns the slot, registers the asset addressable (`fx/<name>` / `sfx/<name>` in `CRContent`, collision-uniquified), and derives the key.
- **Publish pipeline**: validate → register addressables → derive keys → sync ability → sync status effects, reported as a plain-language checklist; Content Studio **Publish All** adds a reachability probe and cancelable progress bar. Readiness logic lives in a pure, unit-tested asmdef (`CR.AbilityWorkbench.Logic`).
- **Edit-mode FX preview**: ▶ Preview plays cast → travel → impact between marker capsules using explicit `ParticleSystem.Simulate`/`VisualEffect.Simulate` ticking, reading the scene sequencer's timing values when present; leak-proof cleanup incl. domain-reload sweep and a **CR → Ability Workbench → Clear FX Preview** safety.
- **FX templates**: `AbilityFxTemplate` SO + "Start from template…" fills all six slots in one click (starter set hand-authored under `Assets/CR/Content/Editor/FxTemplates/`).
- **Visibility**: Content Studio ability rows show readiness chips (`FX 2/3 · SFX 0/3 · Published`); Content Audit gained an **Ability FX** category — assigned-but-not-addressable (with Fix), keys addressing nothing, and keys resolving to non-FX assets (catches the mis-authored `Scratch → creatures/crabby`).

## 2026-06-26

### NPC ensure crash + offline content adoption — durable fix

A fresh offline character could crash at world bootstrap with an NPC `UNIQUE` violation, and re-baked offline content kept vanishing. Four root causes, all fixed durably (branch `feature/account-mode-startup`).

- **NPC ensure is now an atomic, revive-aware upsert (cr-api).** `NpcDomainService.EnsureNpcAsync` no longer does check-then-insert; `BaseNpcRepository.EnsureNpcAsync` runs one dual-engine `INSERT … ON CONFLICT(account_id, trainer_id, content_key) DO UPDATE SET deleted = 0/false, npc_type = <no-downgrade: keep existing when the incoming type is the default Npc> RETURNING id`. Because the `npcs` UNIQUE index `uix_npc_account_trainer_content_key` is **non-partial**, soft-deleted rows still occupy the slot — so a plain insert collided; the upsert revives them in place and is race-safe against concurrent ensures. Team inventory is created only when the returned row is genuinely new (`CreatureTeamInventoryId == null`). New `CR.Npcs.Data.Sqlite.Test` covers idempotency, soft-delete revive, and no-downgrade. ([NPC System](?page=backend/02-npc-system))
- **Per-trainer NPC tables → player-data (Unity).** `INpcRepository` / `INpcCreatureTeamRepository` were wrongly bound to `LocalDataSources.GameData.OfflineSource` (read-only, adoption-overwritten content DB); now bound to `PlayerData.OfflineSource` in `LocalDevGameInstaller`, co-located with `npc_inventory` (FK integrity + merchant purchase on one physical DB). `npcs` rows are per-`(account, trainer)` runtime save-data created by `EnsureNpcAsync`, not designer content — binding them to the adopted `game-data.bytes` let adoption wipe runtime NPCs. ([Project Setup](?page=unity/01-project-setup) · [Content Pipeline](?page=unity/17-content-pipeline))
- **Single `GameInitializer` (Unity).** It is placed in the boot scene **and** was bound `FromNewComponentOnNewGameObject().NonLazy()`, creating a second instance → `OnTrainerChanged` subscribed twice → two concurrent `RunAsync` passes (double world bootstrap, which surfaced the NPC `UNIQUE` crash). Binding changed to `FromComponentInHierarchy().AsSingle().NonLazy()` so exactly one (scene) instance runs. ([World Behaviours](?page=unity/03-world-behaviours))
- **Content-hash adoption gate + auto-bake (Unity).** `GameDataAdopter` previously re-adopted only when the bundled schema version (`game-data_schema_version.txt` = `MAX(VersionInfo)`) exceeded the adopted copy — so content-only re-bakes at the same migration head silently never re-adopted (the "offline content keeps vanishing" bug). It now also compares a SHA-256 of the bundled `game-data.bytes` against a `.srchash` marker next to the adopted copy and re-adopts on any byte difference. `build-packages.sh` now auto-copies the freshly baked `game-data.bytes` + version file into `cr-api-unity/Assets/StreamingAssets/CR` (the manual `CR → Bake Game-Data DB` editor menu is now optional). ([Project Setup](?page=unity/01-project-setup) · [Content Pipeline](?page=unity/17-content-pipeline))

### Offline content floor — authored demo content seeded into migrations

Fixes the recurring "no creatures / no wild encounters / no merchant" on a fresh offline character. Root cause: the baked GameData floor (`StreamingAssets/CR/game-data.bytes`, adopted into `persistentDataPath` by `GameDataAdopter`) is produced by `build-packages.sh` from **migration seeds only** — but the demo spawner chain and its creatures had only ever been authored at runtime (they lived in the old shared `crgame.bytes`), so they were absent from every bake and vanished on each adopt/re-bake. The persistentDataPath copy is a disposable cache regenerated from the floor, so it could not be hand-edited "forward" either.

Fix: the authored content is now seeded as migrations, so `build-packages.sh` bakes it every time.
- `Creatures/CR.Creatures.Data.Migration/M9994SeedDemoCreatures.cs` — 3 creatures (Cindris/Crabby/Mudcalf), 1 growth profile, 4 abilities.
- `Spawner/CR.Spawner.Data.Migration/M5018SeedDemoSpawnerContent.cs` — `welcome-npc-reward-spawner`, 2 spawner pools, 2 creature-spawner templates, 2 ability-progression sets + 5 entries.

Both dual-engine (Postgres + SQLite, `isSqlite`-guarded) and idempotent (`INSERT OR IGNORE` / `ON CONFLICT DO NOTHING`). The bumped schema version (9994) makes `GameDataAdopter` re-adopt automatically. (At the time of this entry, content-only floor changes at the same version did **not** auto-readopt and needed a version bump or deleting the adopted copy — **superseded later the same day** by the SHA-256 content-hash adoption gate; see "NPC ensure crash + offline content adoption — durable fix" above.) Verified: a clean `build-packages.sh --clean` bake now yields creature=7, spawner_pool=2, creature_spawner_template=2, ability_progression_set_entry=5, FK-clean, with the `starter-wild-zone → pool → template → Cindris` chain intact.

## 2026-06-25

### Content Studio — editable server address

The target server is no longer buried in `game_config.yaml`. The Content Studio banner has a **Server** field (with a ⟳ apply-&-test button) that overrides `game_server_http_address` per-machine via EditorPrefs (`ContentCreatorSyncHelper.ServerAddressPrefKey`) — no yaml edit or Unity restart, and it shows exactly what every sync/ping targets. Both `ContentCreatorSyncHelper.GetBaseUrl` and `AbilityEditorSyncHelper.GetBaseUrl` honor the override (empty = fall back to the config value, exposed as `ConfigBaseUrl`). Note the AIO's default `dotnet run` binds **http://localhost:5124** (its launch profile), not `:8080` — so either run it with `--urls http://localhost:8080` or point this field at `:5124`.

### Content Studio — connection-poll fixes (lag + stuck "Checking…")

Follow-up to the live-status/server-field work:
- **Lag:** removed `EditorGUIUtility.AddCursorRect` on the status dot — it forced the window to repaint every frame while hovered, and Content Studio's heavy OnGUI made that lag the editor.
- **Stuck on "Checking…":** the background ping task touched Unity APIs off the main thread — first resolving the URL (`EditorPrefs`/`Resources`), then updating the UI from the `ContinueWith` (`Repaint`/`EditorApplication.delayCall`). Off-thread Unity calls fail silently, so the dot never repainted out of "Checking…" and `_pingInFlight` looked wedged. Rewritten so the URL resolves on the main thread, the `Task.Run` body touches **no** Unity APIs (it only writes plain result fields), and the main-thread `OnEditorTick` drains the result to log + repaint. Added an 8s watchdog and made the dot click / ⟳ always re-check (abandon any in-flight ping) so it can never get wedged.

### Content Studio — live connection status

The banner connection dot now polls on a timer instead of only when the window repaints (so it no longer reads stale "Disconnected" while the server is up). `ContentStudioTool` drives `SchedulePingIfNeeded` from `EditorApplication.update` (subscribed in `OnEnable`, removed in `OnDisable`), the poll interval is 30s, and the dot is now a click-to-recheck button (`ForcePing` backdates the last-ping time and re-pings immediately, showing a transient "● Checking…").

## 2026-06-24

### Online mode — inventory sync, config paths, dead menu object

Three follow-on fixes from the online-mode build log:

- **Item-inventory client was a stub.** `InventorySync.RefreshAsync` (online) threw `NotImplementedException` because `TrainerItemInventoryClientUnityHttp.GetItems/GetItemInventories/AddItemToInventory` were unimplemented. Implemented all three against the existing server routes (`GET/POST /trainer/{trainerId}/inventory/item[/{inventoryId}]`), modeled on the working creature client.
- **Inventory base-address 404s.** `trainer_inventory_server_http_address` / `trainer_creature_inventory_server_http_address` carried bogus `/trainer-inventory` / `/trainer-creature-inventory` prefixes, but the server mounts inventory routes at **root** (`/trainer/...`) — so every call 404'd (`ITrainerCreatureInventoryClient … Not Found`). Dropped both to `http://localhost:8080`. (Same class as the `game_server_http_address` vs service-prefixed-address gotcha.) Also fixed `TrainerCreatureInventoryClientUnityHttp.AddCreatureToInventory` to `POST` (server's verb) instead of `PUT`.
- **Config DB paths were machine-specific absolutes.** `game_config.yaml` hardcoded every `database_path_*` to `/Users/efranford/Library/Application Support/DefaultCompany/My project/crgame.bytes` — wrong (default) product dir, single-file (defeating the two-DB split), and unportable. Replaced with relative `database_path_game_data: game-data.bytes` + `database_path_player_data: playerData.bytes` (resolve under the real `persistentDataPath`); dropped the stale per-domain `*_offline`/`*_online_cache` overrides so online-cache DBs fall back to their own per-domain files (now migrated via `MigratableSources`). Removed a dead `StartMenuController` GameObject (deleted-script reference) from the boot scene.

### Online mode boot crash — unmigrated online-cache databases

A standalone build in **online** mode crashed with `no such table: creature` / `no such table: trainer_item_inventory_items`, spamming thousands of `SqliteException`s. Root cause: the online repos are **cache-then-server-fill** (e.g. `CreatureOnlineRepository.GetCreature` reads the local cache; on a miss it fetches from the server and writes the row back into a per-domain **online-cache SQLite**). Those cache DBs (`baseCreatureOnlineCache.bytes`, `trainerItemInventoryOnline.bytes`, …) are neither adopted (game-data only) nor populated from game-data/player-data — and startup migrated **only 4** of them (player-data + trainer/auth/creature caches). The other caches had no schema, so the server-fill `INSERT` threw `no such table`. (Offline mode was unaffected — its content repos read the adopted, populated game-data DB.)

- New `LocalDataSources.MigratableSources` enumerates **every** writable local DB to migrate (player-data + all `OnlineCacheSource`; game-data excluded — it's adopted).
- `LocalDevGameInstaller.KickOffMigrations` now resolves + dedupes that whole set on the main thread and migrates each off-thread behind `DbReadyGate`, instead of a hand-picked four. Add new cached domains' `OnlineCacheSource` to the list.

### Ability VFX-on-hit — auto-derive the synced content key

Move VFX wasn't playing on hit. The runtime chain (`BattleDomainService` → `outcome` → `BattlePresentationSequencer` `Strike` beat → `AbilityFxCue` → `BattleAbilityFxResponder` → `BattleVisualRegistry`) was wired correctly and the responder is bound `NonLazy`; the break was in authoring. `AbilityConfig` carries each effect as a pair — the `AssetReference` a designer assigns, and the **string key** that actually syncs and drives the runtime — and the key was only populated when the designer manually clicked "← from asset". Assign-but-don't-click left the key blank → backend stored `null` → the cue carried `""` → the responder skipped the spawn, silently.

- **`AbilityConfigEditor.DrawAssetWithKeyRow`** now auto-fills a blank key from the asset's Addressables address whenever the asset is set (the inspector comment finally matches the code). Designers can still override.
- **`AbilityEditorSyncHelper.SyncAbility`** self-heals at push time via a new `KeyOrDerived(storedKey, assetRef)` helper (and an `AssetReference` overload of `TryDeriveAddressableKey`), so a bulk/Content-Studio push can't ship a null VFX/SFX key.
- **Prerequisite:** the VFX/SFX prefab must be **Addressable** — derivation reads `FindAssetEntry`. Recovery for existing abilities: ensure the prefab is addressable (Content Studio "Fix All Addressables"), then re-open or re-sync the ability. Disambiguator in the log — `[BattleAbilityFx] load '<key>' failed` means key present but address unbuilt; silence means the key is still empty.

### Migration seed idempotency — content_key collisions

The AIO Postgres migration crashed with `23505 duplicate key … idx_item_spawner_content_key_unique`: content seeds used `ON CONFLICT (id) DO NOTHING`, which only guards the primary key, but content tables have a UNIQUE on `content_key` — and Content Studio pushes content with fresh UUIDs, so the same `content_key` can already exist under a different id.

- **Single-table seeds:** `ON CONFLICT (id) DO NOTHING` → `ON CONFLICT DO NOTHING` (no target) across all cr-api migrations — ignores a conflict on *any* unique constraint, the true equivalent of SQLite `INSERT OR IGNORE`.
- **FK-chain seeds (parent + child rows under hardcoded ids):** `ON CONFLICT` alone isn't enough — skipping just the parent orphans the child FKs. These now gate the whole seed on the parent's `content_key` being absent (`INSERT … SELECT … WHERE NOT EXISTS`), so it's all-or-nothing per parent and a clean no-op once the content exists. Fixed: item-spawner (`M6014`), creature spawner (`M5009`), quests (`M7006`/`M7008`), loot (`M7102`), achievements (`M7303`).
- Runtime `ON CONFLICT … DO UPDATE` upserts (achievement-unlocked did-I-win, pickup-collected, etc.) are a different, correct pattern and were left untouched.

## 2026-06-23

### Startup — database migration moved off the main thread

Boot no longer freezes on the database. SQLite is synchronous under Dapper (`await` doesn't yield), so the every-boot, reflection-heavy FluentMigrator pass was blocking the Unity main thread.

- **Removed a duplicate migration pass.** The `DatabaseMigrations` (-100) component re-ran the same player-data + online-cache migrations the installer already ran — roughly half the boot migration cost, deleted.
- **Migration runs off the main thread behind `DbReadyGate`.** `LocalDevGameInstaller.KickOffMigrations` captures connection strings + does the working-dir repoint on the main thread, then runs the writable-DB migrations in a `Task.Run` and signals `DbReadyGate`. Startup DB consumers — `GameSessionManager.Start` (after the version check, which is network and overlaps migration) and `MainMenuController` (in the play action) — `await DbReadyGate.Ready` before their first query, which is what guarantees the schema exists (replacing the old synchronous install-time block). A migration failure faults the gate and is logged, instead of hard-aborting the Zenject container.
- **Menu shows instantly.** `MainMenuController.Start` no longer does a redundant session init on the menu's critical path (Continue visibility reads only the `LastPlayMode` pref); the play action awaits the gate (brief "Preparing…" only if migration is somehow still running).
- **Scope:** game-data.bytes adoption stays synchronous on purpose — it's cheap on normal boots (a version check; the heavy file copy only happens on first install / content upgrade) and keeping it synchronous avoids racing the content-registry read of game-data.
- A dead `.Result` sync-over-async in `GameAccountRepository.TryGet` was left as-is — it's unused legacy (the Discord `GameAccountManager` path), to be deleted with that subsystem rather than patched.

## 2026-06-21

### Offline gameplay audit — fixes

A multi-system audit of the recently-built features surfaced several offline correctness bugs, now fixed.

- **Quest & achievement funnel wired into the core loop.** `QuestManager.OnBattleWon` / `OnCreatureDefeated` / `OnCreatureCaptured` / `OnItemCollected` previously had no callers, so most quests and achievements could not progress. Now: `BattleCoordinator.EndBattle` fires `OnBattleWon` on victory; the opponent-faint branch fires `OnCreatureDefeated(baseContentKey)`; `BattleBagPanelHandler` fires `OnCreatureCaptured(baseContentKey)` on capture success; `PickupBehaviour` fires `OnItemCollected` for item rewards. (Damage/heal/level-up hooks, battle-loot item-collected, and merchant-purchase-as-collected are deferred — the first two need new client consumption of `ActionOutcome.LootAwards`.)
- **Item rewards land in the backpack.** `RewardGrantService` granted items via `TrainerInventoryDomainService.AddItemAsync`, which selected `FirstOrDefault()` of the trainer's two `Item` inventories (no `ORDER BY`) — items could land in **Storage** and never show in the bag. Now uses `IItemInventoryService.AddToBackpackAsync` (targets `ItemBackpackInventoryId` and raises the change event). Fixes loot, quest, and achievement item rewards.
- **Creature rewards are placed.** `RewardGrantService` creature rewards spawned an owned creature but never added it to team/storage (pickups/loot left it unlisted). Now placed into the first open team slot, falling back to storage.
- **Offline consumables decrement.** `OfflineItemUseService` never removed consumed items (capture crystals/potions were infinite). Successful consumable use now calls `RemoveFromBackpackAsync` (raises the change event so the count updates live).
- **Capture can't orphan a creature.** Capture now adds to storage **before** claiming ownership; a full storage fails the capture cleanly (and the crystal isn't consumed) instead of reporting success with a lost creature.
- **Merchant sell raises the backpack event** (symmetry with purchase) so the bag isn't stale after selling.
- **Legacy `TrainerInventoryDomainService` correctness.** `GetInventoryItemAsync`/`GetItemQuantityAsync` compared an inventory-container id to an item id (always missed) — fixed to sum entries by `ItemId`; `UpdateItemQuantity` no longer deletes legitimate multi-slot stacks (data loss).

### Account mode & startup — menu consolidation

- **Reused the live `MainMenuController`** (`IUIScreen` "MainMenu") for the mode-first menu instead of a separate prototype — fixes dead Play Online/Offline buttons (the menu UXML's `btnStart` had been replaced) and the menu overlaying character select (a registered screen is hidden by `NavigateToScreen`). The `StartMenuController` prototype was removed.

## 2026-06-20

### Battle bag — stale inventory fix

- **Purchased items now appear in the battle bag.** A merchant purchase wrote the item straight through the repository without raising the inventory-changed events `InventorySync` listens for, so cached views (the battle bag) omitted just-bought capture crystals. Root fix: `NpcMerchantService.PurchaseItemFromMerchantAsync` now calls `IItemInventoryService.NotifyBackpackChanged(...)` **after commit** (best-effort, preserves purchase atomicity), which raises `OnBackpackUpdated`; `InventorySync` already subscribes and refreshes, so **every** consumer updates. `BattleBagPanelHandler` also refreshes on open as belt-and-suspenders for any other direct-repo writer.

### Account mode &amp; startup

- **An account always exists at boot.** `GameSessionManager` now calls `AccountBootstrapper.EnsureLocalAccountAsync()` after session init when no account is loaded — a mode-neutral resolve of the device-bound local account (it does not set the online/offline flag). Fixes the long-standing "no account at startup" failure. ([Account Mode &amp; Startup](unity/19-account-mode-startup.md))
- **Mode-first menu.** The existing live `MainMenuController` (`IUIScreen` "MainMenu") presents Continue · Play Online · Play Offline (its single "Start" button replaced). Continue remembers the last *mode* only and routes to that mode's character selection. Because it's a registered screen, `NavigateToScreen("CharacterSelect")` hides it automatically — no manual hide. Buttons are queried/wired in `Start()` (not the race-prone `OnEnable`). The separate `StartMenuController` prototype was removed in favor of reusing `MainMenuController`.
- **Connectivity-gated online entry.** New `IConnectivityProbe` / `ConnectivityProbe` (reuses the version-check endpoint for reachability) gates Play Online and Continue-into-online; unreachable → block + explain, never enters online.
- **No reconciliation.** Offline and online are two non-crossing worlds; characters are mode-locked via `IsOnlineTrainer`. Online keeps its OnlineCache DBs. Login/email-link remains an optional later upgrade. Boot-entry-point consolidation and EditMode tests are follow-ups.
- **Auth `salt` read fix.** Boot account resolution surfaced a latent mismatch — the auth `salt` column is TEXT but `Account.Salt` is `byte[]`, so a legacy string-valued salt (`''`, from before the column was made nullable) threw `InvalidCastException` during Dapper deserialization. Two-part fix: `ByteArrayTypeHandler` (registered in `DapperBootstrap`) tolerates it as defense, and migration `M0008NormalizeEmptySalt` sets `salt = NULL WHERE salt = ''` so stored data is corrected. No live code writes empty-string salt (anonymous creation passes `null`).

### Achievements

- **New `CR.Achievements` domain.** Achievements unlock on gameplay triggers (battle won, creature captured/defeated, item collected, quest completed, location visited, NPC talked to, creature level reached), record a per-trainer badge, and grant zero or more rewards. `achievement_definition` + child `achievement_reward` are baked content (GameData); `achievement_unlocked` is per-trainer state (PlayerData) with a did-I-win-the-insert upsert so re-triggers never double-grant. ([Achievements](backend/15-achievements.md))
- **Stats-driven, no parallel counter.** `threshold` (default 1 = binary) is checked against existing lifetime `StatKey` aggregates via one batched read. Referenced achievements are `threshold == 1` in this version.
- **Rides the quest funnel.** `QuestDomainService` takes an optional `IAchievementDomainService`; after the lifetime-stat write it evaluates and returns unlocks on `QuestProgressResult.NewlyUnlocked` / `QuestClaimResult.NewlyUnlocked`. Online and offline behave identically. `M7300`–`M7303` + `M9993` content bump.
- **Unity.** `QuestManager` re-broadcasts `OnAchievementUnlocked`; `AchievementToastPresenter` shows the unlock toast; new `LocationTriggerBehaviour` (the first caller of `QuestManager.OnLocationVisited`) drives location achievements. Trophy screen + Content Studio authoring deferred.

## 2026-06-17

### Loot tables + world pickups (backend)

- **Battle-victory loot.** New `CR.Loot` domain: loot tables layered by spawner (zone) and creature (species), independent per-entry drop chance, pure `LootRollService`. `BattleDomainService` rolls + grants on victory and returns `LootAward[]` on the outcome. `M8016` adds `spawner_content_key` to `battle` so the spawner table can roll. Loot `Experience` grants trainer XP, separate from per-creature combat XP. ([Loot System](backend/13-loot-system.md))
- **World pickups.** New `CR.Pickups` domain: reusable `pickup_definition` (rewards JSON) + per-trainer `pickup_collected` (one-time persistent, revive-on-write upsert). Rewards grant a creature/item/currency/XP/quest set; `Quest` is consumer-routed. ([World Pickups](backend/14-world-pickups.md))
- **Shared reward core.** `RewardType` + `RewardGrant` + `IRewardGrantService` extracted from `QuestDomainService.GrantRewardAsync`; quests now delegate. No new dependency cycles.
- Unity client (offline repos/routers, `PickupBehaviour`, DI, migrators, Content Studio authoring) is a follow-on phase.

## 2026-06-12

### Unity — warning cleanup + ability sync repair

- **Ability content sync fixed.** `ServerContentSyncService.SyncAbilitiesAsync` still inserted the `asset_id` column dropped by `M1021` — every boot logged `table abilities has no column named asset_id` and abilities never synced. The INSERT now matches the current schema and carries the full fx-key set (`use/hit/miss_sfx_key`, `use/travel/hit_vfx_key`, `camera_cue_key`), `damage_curve_key`, and `power_multiplier` from the server instead of nulling them.
- **Zenject install-time resolve removed.** `LocalDevGameInstaller` constructs `ConfigurationRepository` + `DatabaseConnectionStringFactory` directly and binds `FromInstance` — no more "resolving during install" warning. ([Dependency Injection](unity/02-dependency-injection.md))
- **USS pseudo-classes.** UI Toolkit doesn't support `:first-child`/`:last-child`; replaced with explicit `--first`/`--last` classes (BagScreen tabs, BattleSummary xp rows) and removed the cosmetic rule from the content-editor sheets.
- **Malbers** `IKProcessorOnAnimIK` gets `[Serializable]` (SerializeReference warning).

## 2026-06-09

### Capture offline + trainer currency + merchant shop

- **Offline capture works.** `OfflineItemUseService` now handles `CaptureCreature`, sharing the exact server formula via the new `CaptureChanceCalculator` (clamp 5–95%). Ownership reassignment + storage add mirror the server handler. ([Capture Mechanic](unity/14-capture-mechanic.md))
- **Opponent-target fix (online too).** Capture against `Guid.Empty` now resolves the wild side's active creature from the battle record; `BattleHUD` also passes its real opponent id into the bag panel.
- **Trainer currency.** `trainers.currency` (M4012, default 500), race-safe conditional-UPDATE adjust methods, merchant purchase debit / sell credit inside the purchase transaction, `QuestRewardType.Currency` payouts, `NewBalance` on purchase/sell results. No client adjust endpoint by design. ([Trainer Currency](backend/12-trainer-currency.md))
- **Merchant shop UI.** E on a merchant opens `MerchantShopScreenHandler`: stock from the item spawner, live prices (BaseValue × BuyMultiplier), wallet, qty stepper, Buy disabled when unaffordable. Sell tab stubbed. ([Merchant Shop](unity/18-merchant-shop.md))
- **Content:** `StartingMerchantItems` spawner authored (crystals + heal potion), `demo-merchant` wired as Merchant, `M6013` seeds Heal Potion (base_value 50), legacy `item_capture_crystal` orphan deleted.
- `run-all-tests.sh` fixed (cd leak + unsupported `--parallel` switch) — Docker repo suites run again.

## 2026-05-28

### Unity — battle wiring consolidated

- **BattleStateBridge + BattleSync deleted.** All event→SO and event→Variable routing now flows through `EventWiringManifest` (codegen) and `VariableWiringManifest` (reflection). Single source of truth, no duplicate raises.
- **`EventChannelInstaller`** + `EventChannelIds` constants — consumers use `[Inject(Id = EventChannelIds.X)]` instead of `[SerializeField]` SO drags. Adding a new event = one manifest row, zero per-consumer Inspector work.
- **`BattleCoordinator.EndBattle` split into `EndBattle` + `CloseBattle`.** EndBattle raises resolution; CloseBattle exits the arena. New `BattleEvents.BattleClosed` + `ScriptableEventBattleClosed` SO. `_battleInProgress` stays true across the summary so input gates suppress the full lifecycle.
- **`BattleSummaryScreen`** — new post-battle modal (UI Toolkit). Outcome banner + Experience Gained list + Items Received + scrollable Synopsis of every notable battle event. OK calls `CloseBattle`. Run-away auto-dismisses after 1.2s.
- **`PlayerInputGate`** also gates on battle (Player map disabled from `BattleStarted` until `BattleClosed`). Trainer movement runs through `TrainerMovementController` → `IMovementController` → `MalbersMovementController`; gating the Player map naturally stops the shim.
- **Starter selection (cr-api):** `BattleDomainService.SeedForTrainerAsync` now picks the first non-fainted creature by slot order (fallback to slot 0 if all fainted). Locked with a new test.
- **Combat HUD redesign** — Figma "Monster Curator" light theme. Command card swaps modes (Attack / Bag / Swap / Run). Focus = navy fill + scale lift (USS has no box-shadow).
- **Bag** — real `BaseItem.Name` / `Description` in both dashboard and combat bags (no more GUID prefixes).
- **Team-availability dots** on the player card: full fill = fightable, ~15% = fainted, empty = no slot.


Reverse-chronological log of significant additions to the codebase. Each entry links to the relevant documentation section.

---

## 2026-05-24

### Two-database content pipeline — game-data artifact, spawner/NPC globalization

The offline SQLite store is split into two databases with separate lifecycles: a read-only **game-data DB** (global authored content) and a mutable **player-data DB** (per-trainer saves). Content ships as a versioned `game-data.bytes` artifact and is patched via Addressables; player saves are migrated in place. Spawner and NPC content are globalized.

**Backend (cr-api)**
- `CR.Data.Migrations.Tool` (`Program.cs`) — default output renamed `crgame.bytes` → `game-data.bytes`; after running all migrations it runs **12 referential-integrity checks** (spawner/template/pool, ability progression, status-condition stat changes, quest template→objective/reward/requirement) and exits non-zero on any dangling content reference, failing the build.
- `build-packages.sh` — generates the pre-built `game-data.bytes` (+ `game-data_schema_version.txt`) into `bin/unity-package/StreamingAssets/CR/`; aborts the package build if generation or the integrity checks fail.
- `M5016RetirePerTrainerSpawner` — soft-deletes per-trainer spawner clones (`account_id`/`trainer_id` non-null); global template rows are the sole source of truth. `account_id`/`trainer_id`/`current_count` columns kept dormant.
- `CreatureSpawnDomainService` — spawning is stateless: no capacity/cooldown enforcement; validation checks only `is_active` (with a `BypassValidation` flag); spawning never mutates the template. Falls back to the global template's pools by `content_key`.
- `M2010GlobalizeNpcContent` — NPC content globalized via the `ContentWorldId` sentinel (`00000000-0000-0000-0000-000000000001` as both account/trainer); dedups stray content-world rows, re-points child rows, adds a partial content-key index. Genuine player NPC instances untouched.
- → [Spawner System](?page=backend/03-spawner-system) · [NPC System](?page=backend/02-npc-system)

**Unity (cr-api-unity)**
- `LocalDataSources` — adds `GameData` (`database_path_game_data`) and `PlayerData` (`database_path_player_data`) offline sources; content repos route to game-data, player-state repos to player-data (Part C-1).
- `DatabaseMigrations.RunMigrations()` — migrates both offline databases plus online-cache DBs. Cold-start adopt of the baked artifact (atomic copy + fail-closed schema-version gate, reusing `AddressablesCatalogUpdater`) tracked as Part C-2 (TODO).
- → [Content Pipeline (Two-Database Model)](?page=unity/17-content-pipeline) · [Project Setup](?page=unity/01-project-setup) · [Content Registry](?page=unity/08-content-registry) · [Addressables Setup](?page=unity/09-addressables-setup)

---

## 2026-04-19

### Ability + condition asset content keys

Replaces the unused UUID `asset_id` foreign-key columns on abilities and status_conditions with a flat content-key model that mirrors the `creature.asset_key` pattern (M1016). Designers populate Addressables `AssetReference` slots in Unity SOs; the matching string keys are synced to the backend and round-trip through the battle outcome so the client can play the right sound/VFX without coupling the resolver to assets.

**Backend (cr-api)**
- `M1021ReplaceAssetIdsWithKeys` — drops `abilities.asset_id` and `status_conditions.{on_hit,on_trigger,on_removed}_effect_asset_id`. Adds `abilities.{use,hit,miss}_sfx_key`, `abilities.{use,travel,hit}_vfx_key`, `abilities.camera_cue_key`, `status_conditions.{on_hit,on_trigger,on_removed}_vfx_key`, `status_conditions.{on_apply,on_tick,on_remove}_sfx_key`.
- `BaseAbility`, `Ability`, `BaseStatusCondition`, `StatusCondition`, `ActiveBattleCondition` — model fields updated. `AssetId` and `OnHit/Trigger/RemovedEffectAssetId` properties removed.
- `ActionOutcome` — surfaces seven ability key fields directly (UseSfxKey, HitSfxKey, MissSfxKey, UseVfxKey, TravelVfxKey, HitVfxKey, CameraCueKey).
- `BattleResolver` + `BattleDomainService` — pass keys into `ActiveBattleCondition` and outcome payloads.
- `BaseAbilityRepository`, `AbilityEndpoints`, `Program.cs` status-condition endpoints, `M9990SeedGameData`, `CreaturesSchemaExtensions` — SQL + DTOs updated to round-trip new columns.

**Unity (cr-api-unity)**
- `AbilityConfig`, `StatusConditionConfig` — paired `AssetReferenceT<AudioClip>`/`AssetReferenceGameObject` + `string ___Key` fields. Editors render an "Audio / VFX" section with an `← from asset` button that auto-derives the Addressables address into the key field.
- `AbilityEditorSyncHelper` — `TryDeriveAddressableKey` helper, sync DTOs and PUT payloads include the new keys.
- `BattleEvents` — `SfxRequested(string)` and `VfxRequested(string)` events. Wired into `BattleEventsAdapter`.
- `BattleCoordinator` — fires `SfxRequested`/`VfxRequested` from outcome keys at cast-time and impact-time, and from `ActiveBattleCondition` keys on apply / trigger / removed.
- `StatusConditionListView` — UI search and editor form switched to the new key fields.
- → [Event Wiring](?page=unity/15-event-wiring) (audio/VFX request events added)

### Wiring system — editor, codegen, and juice events

Followups to the variable wiring system + a batch of cinematic / haptic events for battle UX.

**Unity (cr-api-unity)**
- `VariableWiringEditorWindow` — designer-facing editor at `CR → Wiring → Variable Wiring Editor` (mirrors event wiring editor shape).
- `VariableWiringDiscovery` — shared helper for value-type resolution + variable asset enumeration.
- `VariableWiringCodegen` — IL2CPP-safe bridge generator at `CR → Wiring → Generate Variable Bridge From Selected Manifest`. Output: `Assets/CR/Core/Wiring/Generated/GeneratedVariableWiringBridge.cs`.
- `BattleEvents` — added camera cues (`CameraCueIntro`, `CameraCueAttacker`, `CameraCueDefender`, `CameraCueFaint`, `CameraCueCapture`, `CameraCueVictory`), derived game-feel events (`HeavyHit`, `LowHpEntered`, `CriticalHpEntered`), and 0-arg vibration tiers (`VibrationLight/Medium/Strong`).
- `BattleCoordinator` — fires camera cues at lifecycle points + derives `HeavyHit` (>30% maxHp damage), `LowHpEntered`/`CriticalHpEntered` (downward 30%/10% threshold crossings, once per descent), and tier-appropriate vibration cues.
- `BattleEventsAdapter` — wires all juice events for SOAP routing.
- `BattleBagPanelHandler` — fires `CameraCueCapture` + strong vibration on capture success.
- → [Event Wiring](?page=unity/15-event-wiring) (camera cues / game-feel / vibration tables added)

### Wiring system — deferred items shipped

Followups to the Event Wiring system covering quest rewards, capture/exp/level events, and SOAP variable assignments.

**Unity (cr-api-unity)**
- `QuestRewardAdapter` — wraps `QuestRewardDispatcher.OnRewardsDispatched` (`Action<QuestInstance, IReadOnlyList<QuestRewardTemplate>>`) as a single-arg `Action<QuestRewardsDispatchedData>` for SOAP wiring.
- `QuestRewardsDispatchedData`, `ScriptableEventQuestRewardsDispatched` — payload + SO event type.
- `BattleEvents` — added `CaptureAttempted`, `CaptureFailed`, `ExpGained`, `LevelUp`. Wired into `BattleEventsAdapter`.
- `ExpGainedData`, `ScriptableEventExpGained` — payload + SO event type for exp gain (capture/levelup use existing `ScriptableEventString`).
- `BattleBagPanelHandler` — fires `CaptureAttempted` pre-roll, `CaptureFailed` on failed capture, `ExpGained`/`LevelUp` from item-use results.
- `VariableWiringEntry`, `VariableWiringManifest`, `VariableWiringExecutor`, `VariableWiringRunner`, `VariableWriteMode` — designer-driven mapping of C# events to SOAP `Bool`/`Int`/`Float`/`StringVariable` assignments. Replaces job #2 of legacy state bridges.
- `LocalDevGameInstaller` — binds `QuestRewardAdapter`, `VariableWiringRunner`, optional `VariableWiringManifest`.
- → [Event Wiring](?page=unity/15-event-wiring) (now also covers Variable Wiring + new event tables)

---

## 2026-04-15

### Items — domain service replaces Unity-local repository

Item use is now routed through the DLL `IItemUseDomainService` contract instead of the Unity-local `IItemUseRepository`. This aligns the Unity client with the backend contract and removes duplicated model types.

**Unity (cr-api-unity)**
- `IItemUseRepository`, `ItemUseModels`, `ItemUseOnlineRepository`, `ItemUseOnlineOfflineRepository` — **deleted**.
- `ItemHttpDomainAdapter` — new HTTP adapter implementing `IItemUseDomainService`. Posts to `POST /api/v1/trainers/{trainerId}/items/{itemId}/use`.
- `OnlineOfflineItemDomainService` — new router; delegates to the HTTP adapter (online) or `OfflineItemUseService` (offline) based on `IsPlayingOnline`.
- `OfflineItemUseService` — refactored to implement `IItemUseDomainService` directly (was `IItemUseRepository`).
- `BattleBagPanelHandler`, `BagScreenHandler` — inject `IItemUseDomainService` instead of `IItemUseRepository`.
- `LocalDevGameInstaller` — keyed bindings `"item_online"` / `"item_offline"` + unkeyed default router.
- → [Battle Bag UI](?page=unity/13-battle-bag-ui) · [Item System](?page=unity/10-item-system)

### Quest acceptance from dialogue

Dialogue scripts can now trigger quest acceptance by calling `AcceptQuest("template-uuid")` in a Pixel Crushers Dialogue System Script field. No code changes needed per quest.

**Unity (cr-api-unity)**
- `PixelCrushersDialogueHandler` — registers the `AcceptQuest` Lua function in `Start()` and unregisters in `OnDestroy()`. Raises `IDialogueHandler.OnQuestAcceptedFromDialogue`.
- `IDialogueHandler` — `event Action<string> OnQuestAcceptedFromDialogue` added.
- `QuestDialogueBridge` — subscribes to `OnQuestAcceptedFromDialogue` and calls `QuestManager.AcceptQuestAsync(guid)`.
- → [Dialogue Integration — Quest Acceptance](?page=unity/11-dialogue-integration#quest-acceptance-from-dialogue)

### Quest reward dispatcher

Quest rewards are now claimed and surfaced to the HUD automatically on quest completion.

**Unity (cr-api-unity)**
- `QuestRewardDispatcher` — bound `NonLazy`; subscribes to `QuestManager.OnQuestCompleted`, calls `ClaimRewardsAsync`, increments `StatKey.QuestsCompleted`, and fires `OnRewardsDispatched` for the HUD.
- → [Quest System](?page=unity/quest-system)

---

## 2026-04-17

### Quest creature reward — stale UUID bug fix

Fixes crash chain when claiming quest rewards that spawn creatures. Root causes: `INSERT OR REPLACE` caused UUID churn on content re-sync; seed UUIDs were uppercase, causing SQLite TEXT mismatch; fresh-DB race between `SyncCreaturesAsync` and `SpawnerDefinitionSyncBehaviour`; `QuerySingleAsync` threw instead of returning null.

**Backend (cr-api)**
- `BaseCreatureRepository.GetCreature` — `QuerySingleAsync` → `QuerySingleOrDefaultAsync`; return type `Task<BaseCreature?>`.
- `ICreatureRepository.GetCreature` — signature updated to `Task<BaseCreature?>`.
- `CreatureGenerationService.CreateFromSpawnerAsync` — added `ResolveBaseCreatureIdAsync` / `ResolveGrowthProfileIdAsync` with content-key/name fallback and self-heal (updates stale UUID on template for next call).
- `CreatureSpawnerTemplate` model — added `CreatureContentKey: string?` and `GrowthProfileName: string?`.
- Migration M1019 — normalises `creature.id` to lowercase in SQLite.
- Migration M1020 — normalises `growth_profile.id` to lowercase in SQLite.
- Migration M5014 — adds `creature_content_key` and `growth_profile_name` columns to `creature_spawner_template`.
- `BaseCreatureSpawnerTemplateRepository` — INSERT/UPDATE SQL includes new columns.
- → [Spawner System](?page=backend/03-spawner-system) · [Creature Generation — Stale-UUID Fallback](?page=backend/04-creature-generation#staleuuid-fallback)

**Unity (cr-api-unity)**
- `ServerContentSyncService.SyncCreaturesAsync` — `INSERT OR REPLACE` → `ON CONFLICT(content_key) DO UPDATE SET` (preserves `id`); `c.Id.ToLowerInvariant()`.
- `ServerContentSyncService.SyncGrowthProfilesAsync` — `ON CONFLICT(name) DO UPDATE SET`; `p.Id.ToLowerInvariant()`.
- `LocalSpawnerSyncClient` — stores `CreatureContentKey` and `GrowthProfileName` in spawner templates.
- `CreatureOnlineOfflineRepository` / `CreatureOnlineRepository` — `GetCreature` returns `Task<BaseCreature?>`.

---

## 2026-04-08

### Typed item effect parameters

Item effect parameters are now strongly-typed structs instead of raw JSON blobs, giving both the backend and Unity a clean, validated contract for every effect type.

**Backend (cr-api)**
- 14 typed param classes added under `CR.Game.Model.Items.EffectParameters` (e.g. `HealFlatParams`, `BoostStatPermParams`, `CureStatusParams`, `CaptureParams`, …).
- `EffectParameterSerializer` (Newtonsoft.Json, camelCase, null-safe) handles serialization for all handlers.
- `StatEnumConverter` maps legacy string aliases (`"HP"`, `"spa"`, `"spd"`) to the `Stat` enum for backwards compatibility with existing item data.
- 6 item-effect handlers and 2 evaluators refactored to use typed deserialization.
- `BattleResolver` held-item methods refactored; `ApplyHeldTypeBoost` now takes `ElementType?`.
- `GET /api/v1/ability/status_conditions` list endpoint added.
- 75 unit tests added covering the serializer, all 6 handlers, and both evaluators.
- → [Item System](?page=backend/06-item-system)

**Unity editor (cr-api-unity)**
- `ItemDefinitionEditor`: structured inspector fields per `EffectType` (enum dropdowns, sliders, condition picker) — replaces raw JSON `TextArea`. Existing SO assets auto-migrate on open.
- `OfflineItemUseService`: removes `TryResolveEffectType` hack; uses `item.EffectType` / `EffectParameters` from SQLite; fixes `CureStatus` singular/plural bug; switches to `EffectParameterSerializer` + `Stat` enum for `BoostStatPerm`.
- → [Item System](?page=unity/10-item-system)

---

## 2026-04-07

### Capture crystal — bag UI and item flag

`CaptureCrystal` (value `64`) added to the `ItemUsageFlags` enum in both backend and Unity, enabling the battle bag UI to identify and present capture items distinctly from consumables.

**Backend (cr-api)**
- `ItemUsageFlags.CaptureCrystal = 64` added.

**Unity editor (cr-api-unity)**
- `ItemUsageFlags.CaptureCrystal = 64` mirrored.
- `BattleBagPanel`: `IsCaptureCrystal()` and `GetCaptureLevelText()` helpers added.
- `PopulateItemList()` shows capture crystal tier info inline; `OnItemRowClicked()` displays tier and auto-selects the opponent as the target.
- USS styles added for capture crystal indicator rows.
- → [Capture Mechanic](?page=unity/14-capture-mechanic)

---

## 2026-04-01

### Data-driven content keys — ContentKeys.cs removed, Addressables catalog wired

The `ContentKeys.cs` constants file has been deleted. It was editor-only scaffolding that created the false impression that adding new content requires a code change and rebuild. The runtime has always been fully data-driven (server manifest → `ServerContentRegistry` → `GameAssetLoader`); the file was never consulted at runtime.

`AddressablesCatalogUpdater.UpdateAsync()` is now called at startup inside `ContentRegistryInitializer.FetchAndUpgradeAsync()` (behind the `CR_ADDRESSABLES` define). This means running game clients will download updated Addressables catalogs from the CDN before loading any assets — new content shipped to the CDN will land without a rebuild.

**cr-api-unity changes:**
- `Assets/CR/Core/Data/Registry/ContentKeys.cs` — **deleted**
- `ContentRegistryInitializer` — calls `AddressablesCatalogUpdater.UpdateAsync()` before fetching the server manifest
- `ContentStudioTool` — "Add to ContentKeys.cs" checkbox and `AddConstantToContentKeys()` method removed
- `ContentAuditTool` — "missing ContentKeys constant" warning category removed
- `CreatureDefinitionEditor`, `NpcDefinitionEditor`, `SpawnerDefinitionEditor`, `ItemDefinitionEditor` — ContentKeys help text and "Add to ContentKeys" button removed
- `DefinitionEditorExtensions` — `ExistsInContentKeys()` and `DrawContentKeyInfo()` helpers removed
- → [Content Registry](?page=unity/08-content-registry)
- → [Addressables Setup](?page=unity/09-addressables-setup)

---

### Growth profile assignment on creature species templates

`BaseCreature` (and `CreatureDefinition` in Unity) can now reference a `GrowthProfile` directly, so a species template carries its default stat-scaling curve rather than relying solely on spawner templates or manual generation calls.

**Backend (cr-api)**
- `BaseCreature` gains `GrowthProfileId Guid?` — FK to the `growth_profile` table.
- `M1018AddGrowthProfileIdToBaseCreature` — adds `growth_profile_id UUID NULL` to the `creature` table.
- `BaseCreatureRepository` — `growth_profile_id` included in all SELECT, INSERT, UPDATE, and upsert (ON CONFLICT) queries.
- → [Creature Generation — BaseCreature Model](?page=backend/04-creature-generation#basecreature-model)

**Unity editor (cr-api-unity)**
- `CreatureDefinition` SO gains a `growthProfileId` string field (same pattern as `abilityProgressionSetId` — paste the GUID from a `GrowthProfileConfig` SO).
- `ContentCreatorSyncHelper` — `ServerCreatureDto` carries `growthProfileId`; `FetchAllCreatures`, `ApplyToCreature`, `CreatureDiffersFromServer`, and `BuildCreatureJson` all handle the new field bidirectionally.
- `ContentStudioTool` diff view shows `growthProfileId` conflicts in the Creatures sync panel.
- → [Content Registry — CreatureDefinition Inspector Fields](?page=unity/08-content-registry#creaturedefinition-inspector-fields)

### UICoordinator — battle bag panel and overworld bag screen

- `BagScreenHandler` and `BattleBagPanelHandler` migrated to the `IContextAwareScreen` pattern; both hide on coordinator registration (no more Awake hacks).
- `BattleBagPanel.uxml` gets a **← Back** button that restores the battle action menu without closing the battle.
- `PlayerMenuWindow.EnableInput` / `DisableInput` narrowed to game-specific actions only — no longer disables Unity's shared UI action map, which was blocking all UIToolkit click events during battle.

### Battle fixes

- Wild team capped at 1 creature per encounter (was accumulating across encounters).
- `OfflineBattleService` now looks up `BaseCreature.BaseHitPoints` for max HP and `GivenName` for display name.
- Wild AI falls back to `GetAbilitiesPaginated(0,4)` when a creature has no progression set — AI now always takes a turn.
- Battle ends and logs when the player's creature faints.

---

## 2026-03-28

### Content deletion — server soft-delete from Content Studio

Unregistering a definition or resolving an "Only Server" sync row can now remove the backend record rather than always pulling it back.

**Backend (cr-api `feature/content-delete-endpoints`)**
- `DELETE /api/v1/creatures/by-content-key/{contentKey}` — soft-deletes the `BaseCreature` template. Guarded by `IGeneratedCreatureRepository.CountByBaseCreatureIdAsync`: if any trainer-owned `generated_creature` rows reference the species, returns 409 Conflict instead of deleting.
- `DELETE /api/v1/spawners/by-content-key/{contentKey}` — soft-deletes the global spawner template (no guard — spawner templates have no per-trainer rows).
- → [Creature Generation — API Endpoints](?page=backend/04-creature-generation#creature-list-and-upsert-endpoints)
- → [Spawner System — API Endpoints](?page=backend/03-spawner-system#content-creator-sync-bidirectional)

**Unity editor (cr-data `feature/content-delete-sync`)**
- `ContentCreatorSyncHelper` gains `DeleteCreature(contentKey)` and `DeleteSpawner(contentKey)` methods (blocking HTTP DELETE); `SendDelete` extracts JSON error bodies so server messages (e.g. the 409 creature guard) surface to the user.
- **Unregister flow** — after removing a Creature or Spawner definition from the provider, a dialog asks "Also delete from server?" with **Delete from server** / **Keep on server** options.
- **Sync "Only Server" rows** — Creature and Spawner rows now require explicit resolution. Each row shows **[Pull]** and **[Delete]** toggle buttons. Apply is blocked until every row has a choice. (NPCs, Abilities, Progression Sets, and Growth Profiles still auto-pull.)
- → [Content Registry — Removing Content from the Backend](?page=unity/08-content-registry#removing-content-from-the-backend)

---

## 2026-03-25

### BattleHUD ability selection menu
- **`BattleHUD`** gains a real ability sub-panel (up to 4 buttons). Pressing **Battle** now opens the ability picker rather than auto-submitting a default attack.
- `BattleEvents.PlayerTurnStarted` signature updated: carries `List<WildAbilityDto>` (name + power + id) instead of a bare `string[]`.
- `BattleStateResponse` gains a `playerAbilities` field populated by `OfflineBattleService` from the creature's progression set.
- `WildAbilityDto` gains a `name` field (shared by player and wild ability lists).
- → [Battle System — BattleHUD](?page=unity/07-battle-system#battlehud)

---

## 2026-03-24

### Wild Battle System — Phases 2–5 (Unity client)

**Arena system** (`CR.Game.Battle.Arena`)
- `BattleArena` MonoBehaviour: biome-specific environment GameObjects, trainer/creature spawn points, camera look target, `SetBiome()` / `Activate()` / `Deactivate()`.
- `BattleArenaRegistry` (`IWorldInitializable`): discovers all `BattleArena` in scene at init, keyed by `arenaKey`.
- `BattleCameraController`: lerps main camera to `cameraLookTarget` on `EnterBattle`, restores on `ExitBattle`.
- Editor tool: **CR > Battle > Create Placeholder Arena** scaffolds an arena GameObject with default biome structure.
- → [Battle System — Arena](?page=unity/07-battle-system#battle-arena)

**Offline battle stack** (`CR.Game.Battle.Offline`)
- `IBattleRepository` + `SqliteOfflineBattleRepository`: persists battle state to a local SQLite DB (crash-recovery; 4 tables: `battle`, `battle_round`, `battle_creature_state`, `battle_action_log`).
- `OfflineBattleService`: uses `BattleResolver` from `CR.Game.Compat` for in-memory resolution; calls `IGeneratedCreatureRepository` for HP write-back on battle end.
- `OfflineBattleClient`: implements `IBattleClient` for fully offline play.
- `OnlineOfflineBattleClient`: routes `IBattleClient` calls to HTTP or offline based on `IsPlayingOnline`.
- → [Battle System — Offline Stack](?page=unity/07-battle-system#offline-battle-stack)

**Turn loop and coordinator** (`CR.Game.Battle.BattleCoordinator`)
- Sequential turn loop driven by `TaskCompletionSource<string>`; player action awaited until `SubmitPlayerAction()` resolves it.
- `StartBattleAsync` response carries `activeTrainerId` + `roundKey`; avoids an extra `GetRoundKey` round-trip.
- Arena activation and camera transition wired into the wild battle start flow.
- `BattleEvents` static class: 8 events (`BattleStarted`, `PlayerTurnStarted`, `CreatureAttacking`, `CreatureHit`, `HpChanged`, `CreatureFainted`, `BattleEnded`, `RunAttempted`).
- → [Battle System — Turn Loop](?page=unity/07-battle-system#wild-battle-turn-loop)

**Wild AI client** (`CR.Game.Battle.AI`)
- `LocalWildBattleAIService`: offline heuristics — heal at <30% HP if item available, 20% chance for a status ability, else highest-power ability.
- → [Battle System — Wild AI](?page=unity/07-battle-system#local-wild-battle-ai)

**UI** (`CR.UI.Battle.BattleHUD`)
- HP bars, creature names, 4-line scrolling battle log.
- → [Battle System — BattleHUD](?page=unity/07-battle-system#battlehud)

**DI wiring** (`LocalDevGameInstaller`)
- Full offline battle stack bound: `SqliteOfflineBattleRepository`, `OfflineBattleService`, `OfflineBattleClient`, `BattleClientUnityHttp`, `OnlineOfflineBattleClient` as `IBattleClient`.
- `LocalWildBattleAIService`, `BattleArenaRegistry`, `BattleCameraController` bound.
- → [Battle System — DI](?page=unity/07-battle-system#installer-binding)

**SpawnerEncounterBehaviour**
- Random 2–5 s encounter delay with trigger-exit cancel.
- → [Battle System — Wild Creature Battle Flow](?page=unity/07-battle-system#wild-creature-battle-flow)

---

### Wild Battle System — ability animations and progression set (cr-api)

- `M9003`: `animation_key` (VARCHAR NULL) on `abilities` table — drives `BattleCoordinator.FireOutcomeEvents` clip selection.
- `M1017`: `ability_progression_set_id` (UUID NULL FK) on `creature` table — wild AI and offline `GetBattleStateAsync` use it to fetch the creature's learned abilities.
- `GetAbilitiesForProgressionSetAtLevelAsync` added to `IAbilityRepository`.
- `WildBattleAIDomainService` updated to use the creature's own progression set instead of a global ability query.
- `ActionOutcome.AbilityKey` now populated from `BaseAbility.AnimationKey`.
- → [Battle Persistence — Wild AI](?page=backend/09-battle-persistence#wild-trainer-ai)

---

## 2026-03-23

### Wild Battle System — core backend (cr-api)

**Shared engine (`CR.Game.Compat.Battle`)**
- `BattleResolver`: pure-static damage resolver (physical/special/status formula, accuracy roll, DOT conditions).
- `BattleActionParser`: JSON serialiser/deserialiser for `BattleAction[]`.
- `CreatureSnapshot` + `SingleActionResult` records.
- → [Battle Persistence — BattleResolver](?page=backend/09-battle-persistence#battleresolver)

**Sequential turn model**
- `M8006`: `active_trainer_id` on `battle_round` — replaces simultaneous-submit with single-actor-per-round.
- `IBattleDomainService.SubmitActionAsync` replaces `SubmitInputAsync`; resolves immediately and returns `ActionOutcome` with `NextActiveTrainerId` + `NextRoundKey`.
- Speed-based first-mover; ties go to trainer1 (player).
- → [Battle Persistence — Turn Model](?page=backend/09-battle-persistence#turn-model)

**Wild trainer + AI**
- Wild Trainer seeded with GUID `00000000-0000-0000-0000-000000000001`.
- `WildBattleAIDomainService` + `POST /api/v1/battle/{id}/wild-turn` endpoint.
- → [Battle Persistence — Wild AI](?page=backend/09-battle-persistence#wild-trainer-ai)

**Endpoints added**
- `POST /api/v1/battle/start` — returns `activeTrainerId` + `roundKey` in one call.
- `POST /api/v1/battle/{id}/submit` — resolves immediately, returns `ActionOutcome`.
- `POST /api/v1/battle/{id}/wild-turn` — AI picks + submits wild action server-side.
- `POST /api/v1/battle/{id}/run` — escape with speed-based formula.
- `GET /api/v1/battle/{id}/summary` — post-battle creature state summary.
- → [Battle Persistence — REST Endpoints](?page=backend/09-battle-persistence#rest-endpoints)

---

## 2026-03-17

### Content and asset refactor (cr-api)

- `asset_key` replaces `asset_id` on `creature` and `item` tables (M1016, M6003).
- `game_assets` table and `GET /api/v1/assets/manifest` endpoint.
- Merchant REST endpoints added.
- → [Asset Management](?page=backend/10-asset-management)

---

## 2026-03-10

### Battle persistence foundation (cr-api)

- `M8004`: 5 battle tables (`battle`, `battle_round`, `battle_round_input`, `battle_creature_state`, `battle_action_log`).
- `IBattleRepository`, `BattleDomainService`, initial REST endpoints.
- → [Battle Persistence](?page=backend/09-battle-persistence)

---

## Earlier

For history prior to 2026-03-10 see the [git log](https://github.com/CrystallineRift/cr-api/commits/main) and [cr-data commits](https://github.com/CrystallineRift/cr-data/commits/main).
