# Setting Up the World System

## Goal

By the end of this guide you will understand how `GameInitializer` and `WorldRegistry` drive the per-trainer initialization sequence, how to add a new `IWorldInitializable` to an existing scene, and what log output confirms the world system is working correctly.

## Prerequisites

- The `Scene Context` with `LocalDevGameInstaller` is in your scene. See [Configuring Scene DI](?page=guides/05-setup-di-scene-context).
- At least one `IWorldInitializable` MonoBehaviour (e.g. an NPC) is placed in the scene. See [Setting Up an NPC in a Scene](?page=guides/02-setup-npc-scene).

---

## How the World System Works

The world system has three parts:

### 1. WorldRegistry (static list)

`WorldRegistry` is a static class — it is not a MonoBehaviour and does not exist in the scene hierarchy. It maintains a list of every `IWorldInitializable` that has registered itself.

Any MonoBehaviour that implements `IWorldInitializable` must call:
- `WorldRegistry.Register(this)` in `Awake()`
- `WorldRegistry.Unregister(this)` in `OnDestroy()`

On scene unload, `GameInitializer` calls `WorldRegistry.Clear()` as a safety net (via `SceneManager.sceneUnloaded`).

### 2. GameInitializer (created by Zenject, not placed manually)

`GameInitializer` is bound with `FromNewComponentOnNewGameObject().AsSingle().NonLazy()`. This means:

- Zenject creates a new GameObject and adds `GameInitializer` to it at container build time.
- It appears in the Hierarchy at runtime as `GameInitializer`.
- `NonLazy()` guarantees it is instantiated immediately — without this, it is never created and world bootstrap never runs.

`GameInitializer` has `[DefaultExecutionOrder(50)]`. Its `Awake()` subscribes to `GameSessionManager.OnTrainerChanged`. When that event fires (i.e. a trainer is selected), `GameInitializer.RunAsync()` iterates `WorldRegistry.All` and calls `InitializeAsync()` on each item sequentially.

### 3. IWorldInitializable.InitializeAsync

```csharp
public interface IWorldInitializable
{
    Task InitializeAsync(IWorldContext context, CancellationToken ct = default);
}
```

`IWorldContext` provides:
- `context.AccountId` — current account GUID
- `context.TrainerId` — currently selected trainer GUID
- `context.IsOnlineTrainer` — whether the trainer is in online or offline mode

Each `IWorldInitializable` receives this context and uses it to load trainer-specific data (e.g. look up an NPC record for this trainer in the database).

---

## The Initialize Sequence Step by Step

```
Scene loads
  → All Awake() methods run (execution order -10 before 50)
      → NpcWorldBehaviour.Awake()       → WorldRegistry.Register(this)
      → SpawnerWorldBehaviour.Awake()   → WorldRegistry.Register(this)
      → QuestWorldBehaviour.Awake()     → WorldRegistry.Register(this)
      → TrainerWorldBehaviour.Awake()   → WorldRegistry.Register(this)
  → Zenject builds container
      → LocalDevGameInstaller.InstallBindings() runs
      → GameSessionManager is created (FromNewComponentOnNewGameObject)
      → GameInitializer is created (FromNewComponentOnNewGameObject, NonLazy)
      → BattleCoordinator is created (FromNewComponentOnNewGameObject)
  → GameInitializer.[Inject] runs
      → Subscribes to GameSessionManager.OnTrainerChanged
  → GameSessionManager.Start() runs
      → Calls IGameSessionService.InitializeAsync()
      → If a trainer was previously persisted, fires OnTrainerChanged
  → User selects a trainer (or session auto-restores)
      → GameSessionManager.SetTrainerAsync() fires OnTrainerChanged
  → GameInitializer.OnTrainerChanged fires
      → Calls RunAsync(accountId, trainerId, isOnline)
          → Iterates WorldRegistry.All sequentially
          → Calls InitializeAsync(context, ct) on each
```

---

## Script Execution Order

The two key attributes in play:

| Script | `[DefaultExecutionOrder]` |
|---|---|
| `TrainerWorldBehaviour` | -10 |
| `QuestWorldBehaviour` | -10 |
| `GameInitializer` | 50 |

Scripts without a `[DefaultExecutionOrder]` attribute default to order 0, which is between -10 and 50. `NpcWorldBehaviour` and `SpawnerWorldBehaviour` have no explicit order attribute, so they run at default order 0. This is fine because `GameInitializer.Awake()` only subscribes to events at order 50 — it does not call `WorldRegistry.All` at that point.

**You do not need to touch Project Settings > Script Execution Order.** The attributes handle ordering.

---

## Adding a New IWorldInitializable

Follow these steps to make a new system participate in world bootstrap.

### 1. Implement the interface

```csharp
[DefaultExecutionOrder(-10)]  // Add if you need to guarantee registration before GameInitializer
public class MyWorldSystem : MonoBehaviour, IWorldInitializable
{
    private void Awake() => WorldRegistry.Register(this);
    private void OnDestroy() => WorldRegistry.Unregister(this);

    public async Task InitializeAsync(IWorldContext context, CancellationToken ct = default)
    {
        // Use context.TrainerId and context.AccountId to load data for this trainer
    }
}
```

### 2. Inject dependencies via [Inject]

```csharp
private IMyService _myService = null!;

[Inject]
public void Init(IMyService myService)
{
    _myService = myService;
}
```

Never inject in the constructor or in `Awake()` — Zenject calls `[Inject]` methods after `Awake()`.

### 3. Place the GameObject in the scene

Add the script to a GameObject in the scene (or create a new one). It must exist at scene load time, not be instantiated dynamically later, so that `Awake()` runs before `GameInitializer` collects initializables.

### 4. Ensure the service is bound in the installer

If `IMyService` is a new service, add its binding to `LocalDevGameInstaller.InstallBindings()`. See [Configuring Scene DI](?page=guides/05-setup-di-scene-context).

---

## Verification Log Messages

In Play mode, open the Console and look for the world init sequence:

```
[GameInitializer] Injected and subscribed to OnTrainerChanged.
```
Confirms `GameInitializer` was created and subscribed.

```
[GameInitializer] === World init start === accountId=<guid> trainerId=<guid> online=False objects=4
```
Confirms trainer was selected and init is running. `objects=4` means 4 `IWorldInitializable` instances are registered.

```
[GameInitializer] Initializing 'ElderCin' (NpcWorldBehaviour)...
[GameInitializer] 'ElderCin' done in 12ms.
```
Per-item init log. A `FAILED` line here means the initializable threw an exception — check the full exception in the Console.

```
[GameInitializer] === World init complete === 4 ok / 0 failed / 47ms total
```
All initializables succeeded. If `failed > 0`, scroll up in the Console for the specific error.

---

## Common Mistakes

**"WorldRegistry is empty — no IWorldInitializable objects registered."**
No MonoBehaviour called `WorldRegistry.Register(this)` in `Awake()` before `GameInitializer.RunAsync()` was called. The most likely cause: the world behaviour GameObjects were instantiated dynamically after scene load, not present at scene start.

**GameInitializer does not appear in the Hierarchy at runtime.**
The `NonLazy()` call is missing from the binding in `LocalDevGameInstaller`. Without it, Zenject creates the object lazily (only when something resolves `GameInitializer`), which means it is never created if nothing else injects it. Confirm line 354 in `LocalDevGameInstaller.cs`:
```csharp
Container.Bind<CR.Game.World.GameInitializer>().FromNewComponentOnNewGameObject().AsSingle().NonLazy();
```

**World init runs but items count is lower than expected.**
One of your `IWorldInitializable` behaviours is not calling `WorldRegistry.Register(this)` in `Awake()`, or its `Awake()` is being skipped (e.g. the GameObject is inactive). Make sure the GameObject is active in the scene before Play mode starts.

**Trainer changed event fires twice, triggering world init twice.**
`OnTrainerChanged` fires once per `SetTrainerAsync()` call. If you call `SetTrainerAsync()` in multiple places at startup, init will run multiple times. `GameInitializer` cancels the previous run via `CancellationTokenSource` when a new one starts, so only the last run completes — but it is wasteful. Trace the call sites for `SetTrainerAsync`.

**`InitializeAsync` for one item hangs and no subsequent items run.**
`GameInitializer` runs items sequentially (not in parallel). If one item awaits indefinitely, the rest will not start. Check for missing `await` on async calls, or an HTTP request that never times out. Consider adding a timeout `CancellationToken` with a deadline.

---

## Tweak and rebuild the corridor (open world, Act 1)

The terrain and dressing between the 1a summit and Philroe's farm are generated by the corridor builder from
`Assets/CR/Game/OpenWorld/Data/Corridor/Act1Corridor.asset`. Change the asset (or record a hand tweak), rebuild, check, render.
Background and the full command list: [Open World → Terrain and the corridor builder](?page=unity/37-open-world). A one-page walkthrough
lives at `CR/docs/2026-10-09-corridor-builder-guide.html`.

All commands run against the open Editor (`P` = the cr-api-unity path):

```bash
unity cmd --project-path $P --timeout 600 cr_world_build_corridor --args dry        # what would change, every adjustment with its reason
unity cmd --project-path $P --timeout 600 cr_world_build_corridor                   # build (all steps, all cells)
unity cmd --project-path $P --timeout 600 cr_world_check_corridor --args navmesh    # ok, or FAIL n with lines in Temp/CorridorBuild/check.txt
unity cmd --project-path $P --timeout 600 cr_world_render_corridor                  # PNGs in Temp/CorridorRenders/
```

### Move a path, polygon or landmark

1. Select `Act1Corridor.asset` (menu **CR/World/Corridor/Select Layout**). The Scene view shows paths coloured by kind, polygons,
   contours with height labels and landmark gizmos; drag xz handles or use the height slider (Undo works on the asset).
2. Or edit the numbers in the inspector (Landmarks, Paths, Polygons…).
3. Inspector **Build** (or **Build cell** for one cell), then **Check**, then **Render**. Use the step toggles to rebuild only what you
   changed (for a landmark move: `dressing`; for a path: `height+paint+details`).

### Keep a hand tweak

Nudge a generated object in its cell scene, select it and run **CR/World/Corridor/Record Selection As Override** (or **…As Removed** to
drop it). The next build keeps the tweak. Without this, the build puts the object back.

### Story objects

Story and gameplay objects (waypoints, triggers, NPCs, the gate, fences) are moved only by adjustment rows. A row matches its object
by xz at `from` or `to`; anything else is reported "moved by hand" and left alone. To move one for good, edit its row (`to` + `reason`)
and rebuild with `steps=adjust`. Never edit component fields through the builder.

### After a build that added or recreated objects

```bash
unity cmd --project-path $P cr_world_audit_vendor_lods --args 0,4      # and 0,3 / 1,4 / 1,3; add ,fix to revert overrides
unity cmd --project-path $P cr_world_add_lods --args 0,4               # each cell
unity cmd --project-path $P --timeout 600 cr_world_build_corridor       # 0 changes; re-records the content hashes
unity cmd --project-path $P cr_world_refresh_activatables --args ""
unity cmd --project-path $P cr_world_bake_proxy --args 0,4             # each cell
unity cmd --project-path $P cr_world_validate                          # 0 errors
```

### Undo everything

`cr_world_revert_corridor --args confirm` restores every touched object from the manifest, empties the builder's containers and parks
the terrains. The blockout comes back.

### Common mistakes

**The check fails with `hash … changed since the last build`.** A builder object was edited by hand (or `cr_world_add_lods` ran). Record
the tweak as an override, or run a full build to re-record the hashes.

**A story object is reported "moved by hand".** It is neither at its row's `from` nor its `to`. Record it, or fix the row.

**A cell scene shows as modified after a check.** The check is read-only; if a cell was open with unsaved edits, save or revert it
yourself. Builds refuse to run over unsaved edits in an open cell.
