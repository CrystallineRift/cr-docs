# Event Wiring

The event wiring system lets designers map **C# events** (fired by domain code) to **SOAP ScriptableEvent assets** (fan-out to UI, VFX, audio, animation) without editing code.

## Why it exists

- SOAP's `EventListenerGeneric<T>` already handles *SO event → response* (UI/VFX/audio/anim) via components dropped on GameObjects.
- The missing piece is *C# event → SO event*. Historically that was hand-written bridge `MonoBehaviour`s in `Assets/CR/Core/State/Bridge/`.
- This system replaces those bridges with a data-driven manifest that designers edit in an editor window.

## Components

| Component | Location | Role |
|---|---|---|
| `IEventSourceRegistry` | `Assets/CR/Core/Wiring/` | Resolves event-source instances by type |
| `ZenjectEventSourceRegistry` | `Assets/CR/Core/Wiring/` | Default impl — looks up sources from the DI container |
| `EventWiringEntry` | `Assets/CR/Core/Wiring/` | Serializable `(sourceTypeAqn, eventName, sink)` tuple |
| `EventWiringManifest` (SO) | `Assets/CR/Core/Wiring/` | Holds the flat list of entries |
| `EventWiringExecutor` | `Assets/CR/Core/Wiring/` | Reads manifest, subscribes sources to sinks via reflection |
| `EventWiringRunner` | `Assets/CR/Core/Wiring/` | Zenject `IInitializable` that builds and runs the executor |
| `BattleEventsAdapter` | `Assets/CR/Core/Wiring/Adapters/` | Wraps static `BattleEvents` bus as an injectable with single-arg events |
| `TrainerSessionAdapter` | `Assets/CR/Core/Wiring/Adapters/` | Wraps `GameSessionManager` `EventHandler<T>` events as `Action<T>` |
| `EventWiringEditorWindow` | `Assets/CR/Core/Wiring/Editor/` | Designer-facing UI (menu: `CR → Wiring → Event Wiring Editor`) |
| `EventWiringCodegen` | `Assets/CR/Core/Wiring/Editor/` | Emits IL2CPP-safe concrete bridge from manifest |

## Runtime flow

```
LocalDevGameInstaller binds:
  IEventSourceRegistry → ZenjectEventSourceRegistry
  EventWiringManifest  (optional, via SerializeField on installer)
  BattleEventsAdapter  (NonLazy)
  TrainerSessionAdapter (NonLazy)
  EventWiringRunner    (NonLazy, IInitializable)

At scene load:
  BattleEventsAdapter.Initialize()   → subscribes to static BattleEvents
  TrainerSessionAdapter.Initialize() → subscribes to GameSessionManager
  EventWiringRunner.Initialize()     → builds EventWiringExecutor, wires manifest
```

Each manifest entry causes the executor to:
1. Resolve the source type from the registry.
2. Reflect the named `public event` on that type.
3. Build a delegate that forwards to `sink.Raise(arg)` (1-arg) or `sink.Raise()` (0-arg).
4. Subscribe. Track for unsubscription at dispose.

## Supported event shapes

| Event handler | Sink | Wireable? |
|---|---|---|
| `Action` (0-arg) | `ScriptableEventNoParam` | ✅ |
| `Action<T>` (1-arg) | `ScriptableEvent<T>` where `T` matches | ✅ |
| `Action<T1, T2, …>` (multi-arg) | *any* | ❌ — pack into a data struct first |

Multi-arg events must be packed into a single-field data struct by an **adapter class** before they are wireable. See `BattleEventsAdapter` for the pattern.

## How to add a new event source

Any public Zenject-bound class that exposes `public event Action<T>` in a `CR.*` namespace is **automatically discovered** by the editor.

```csharp
using System;

namespace CR.Quests.Manager
{
    public class QuestManager
    {
        public event Action<QuestInstance>? OnQuestAccepted;
        public event Action<QuestInstance>? OnQuestCompleted;

        private void Accept(QuestInstance q) => OnQuestAccepted?.Invoke(q);
    }
}
```

Requirements:
1. Class lives in a `CR.*` namespace.
2. Bound via Zenject as `AsSingle()` or resolvable by type.
3. Event handler is `Action` or `Action<T>` — multi-arg needs an adapter.

Once compiled, open `CR → Wiring → Event Wiring Editor`, click **Refresh**, and it appears in the source list.

## How to add a new data payload type

Multi-field payloads need:
1. A plain C# data struct under `Assets/CR/Core/State/Events/CustomTypes/`.
2. A matching `ScriptableEvent<T>` subclass so designers can create asset instances.

**Step 1 — data struct:**

```csharp
// Assets/CR/Core/State/Events/CustomTypes/QuestRewardData.cs
namespace CR.Core.State
{
    public struct QuestRewardData
    {
        public string QuestId;
        public int GoldAwarded;
        public int ExpAwarded;

        public QuestRewardData(string questId, int gold, int exp)
        {
            QuestId = questId;
            GoldAwarded = gold;
            ExpAwarded = exp;
        }
    }
}
```

**Step 2 — ScriptableEvent subclass:**

```csharp
// Assets/CR/Core/State/Events/CustomTypes/ScriptableEventQuestReward.cs
using Obvious.Soap;
using UnityEngine;

namespace CR.Core.State
{
    [CreateAssetMenu(
        fileName = "scriptable_event_quest_reward.asset",
        menuName = "Soap/CR/ScriptableEvents/QuestReward")]
    public class ScriptableEventQuestReward : ScriptableEvent<QuestRewardData>
    {
    }
}
```

**Step 3 — create the asset:**

Right-click in the Project window → `Create → Soap → CR → ScriptableEvents → QuestReward`. It now appears in the sink picker.

## How to wrap multi-arg or legacy events

If the source fires `Action<A, B, C>` — or a `static` event, or an `EventHandler<T>` — you need an **adapter** class that exposes a single-arg `Action<SomeData>` event.

Pattern (see `BattleEventsAdapter.cs`):

```csharp
public sealed class FooAdapter : IInitializable, IDisposable
{
    public event Action<FooData>? FooHappened;

    public void Initialize() => StaticBus.Something += OnSomething;
    public void Dispose()    => StaticBus.Something -= OnSomething;

    private void OnSomething(string a, int b, bool c)
        => FooHappened?.Invoke(new FooData(a, b, c));
}
```

Then bind it in `LocalDevGameInstaller`:

```csharp
Container.BindInterfacesAndSelfTo<FooAdapter>().AsSingle().NonLazy();
```

The adapter is now discoverable by the editor.

## Designer workflow

1. `CR → Wiring → Event Wiring Editor` (menu).
2. Click **New Manifest** (first time) or drop an existing `EventWiringManifest` asset into the picker.
3. Drag the manifest into `LocalDevGameInstaller → Event Wiring Manifest` so it's loaded at runtime.
4. In the editor window, expand a source type, pick a SOAP sink from the dropdown, click **+ Wire**.
5. Entries appear on the right. Toggle off to mute, **X** to delete.

## Codegen for IL2CPP

Reflection-based subscription works in Mono/editor but can be fragile under IL2CPP. For production:

1. Select a manifest asset in the Project window.
2. `CR → Wiring → Generate Bridge From Selected Manifest`.
3. Output: `Assets/CR/Core/Wiring/Generated/GeneratedEventWiringBridge.cs`.
4. In `LocalDevGameInstaller`, bind `GeneratedEventWiringBridge` instead of (or alongside) `EventWiringRunner`:

```csharp
Container.BindInterfacesAndSelfTo<GeneratedEventWiringBridge>().AsSingle().NonLazy();
```

The generated class uses plain `+= handler` subscriptions — no reflection. Re-run codegen whenever you change the manifest.

## Currently wireable events

### Battle (`BattleEventsAdapter`)
| Event | Payload |
|---|---|
| `BattleEventStarted` | `string` battleId |
| `PlayerTurnStarted` | `PlayerTurnStartedData` |
| `TurnStarted` | `TurnStartedData` (player + opponent; includes `IsPlayer`) |
| `TurnEnded` | `string` actingCreatureId |
| `AbilityResolving` | `AbilityResolvingData` (abilityKey, element, category) |
| `CreatureAttacking` | `CreatureAttackingData` |
| `CreatureHit` | `string` creatureId |
| `HpChanged` | `HpChangedData` |
| `CreatureFainted` | `string` creatureId |
| `AbilityMissed` | `AbilityMissedData` |
| `DotDamage` | `DotDamageData` |
| `StatusApplied` | `StatusEventData` |
| `StatusTriggered` | `StatusTriggerData` (with damage) |
| `StatusRemoved` | `StatusEventData` |
| `BattleEventEnded` | `bool` playerWon |
| `RunAttempted` | `bool` success |
| `CreaturesIdentified` | `CreaturesIdentifiedData` |
| `ItemHpRestored` | `ItemHpRestoredData` |
| `ItemCreatureRevived` | `string` creatureId |
| `ItemStatusCured` | `StatusCuredData` |
| `ItemStatBoosted` | `StatChangeData` |
| `OpponentStatDebuffed` | `StatChangeData` |
| `CreatureCaptured` | `string` creatureName |

### Trainer session (`TrainerSessionAdapter`)
| Event | Payload | Fires when |
|---|---|---|
| `TrainerChanged` | `TrainerChangedData` | Any trainer transition |
| `TrainerLoaded` | `TrainerChangedData` | `null → value` only |
| `TrainerCleared` | `TrainerChangedData` | `value → null` only |
| `AccountChanged` | `AccountChangedData` | Any account transition |

### Quests (`QuestManager`, direct)
| Event | Payload |
|---|---|
| `OnQuestAccepted` | `QuestInstance` |
| `OnQuestCompleted` | `QuestInstance` |
| `OnQuestAbandoned` | `Guid` |
| `OnObjectiveUpdated` | `QuestObjectiveProgress` |

### Quest rewards (`QuestRewardAdapter`)
| Event | Payload |
|---|---|
| `RewardsDispatched` | `QuestRewardsDispatchedData` (Quest + flat reward list) |

### Capture / progression (`BattleEventsAdapter`)
| Event | Payload |
|---|---|
| `CaptureAttempted` | `string` targetCreatureId — fires the moment the crystal is thrown, before the roll |
| `CaptureFailed` | `string` targetCreatureId — fires when the roll fails (creature breaks free) |
| `ExpGained` | `ExpGainedData` (creatureId, amount, leveledUp) |
| `LevelUp` | `string` creatureId |

### Camera cues (`BattleEventsAdapter`)
Semantic hooks for cinematic moments. Wire to `ScriptableEventString` / `ScriptableEventBool` sinks, then have a `BattleCameraDirector` listen and orchestrate framing / FOV / dolly.

| Event | Payload | Fires when |
|---|---|---|
| `CameraCueIntro` | `string` battleId | Battle starts |
| `CameraCueAttacker` | `string` creatureId | Attacker begins their action |
| `CameraCueDefender` | `string` creatureId | Hit lands |
| `CameraCueFaint` | `string` creatureId | Creature faints (use for slow-mo) |
| `CameraCueCapture` | `string` creatureId | Capture succeeds (orbit-cam) |
| `CameraCueVictory` | `bool` playerWon | Battle ends |

### Game-feel derived (`BattleEventsAdapter`)
Computed in `BattleCoordinator` from existing outcome data. Tunable thresholds: heavy hit = damage > 30% maxHp; low/critical thresholds 30%/10%.

| Event | Payload | Fires when |
|---|---|---|
| `HeavyHit` | `HpChangedData` | Damage exceeds 30% of target's maxHp — wire to screen shake |
| `LowHpEntered` | `string` creatureId | HP fraction crosses 30% downward (once per descent) — wire to heartbeat SFX, red border |
| `CriticalHpEntered` | `string` creatureId | HP fraction crosses 10% downward (once per descent) — wire to faster heartbeat / panic music |

### Vibration tiers (`BattleEventsAdapter`)
0-arg semantic haptic hooks. Wire each to a `ScriptableEventNoParam` and have one `HapticsResponder` translate the tier into platform-specific calls.

| Event | Fires when |
|---|---|
| `VibrationLight` | Misses, minor UI ticks |
| `VibrationMedium` | Standard hit landed |
| `VibrationStrong` | Heavy hit, faint, capture success, battle end |

### Audio / VFX requests (`BattleEventsAdapter`)
String payloads carrying Addressables keys that designers populate on `AbilityConfig` / `StatusConditionConfig` SOs. The keys round-trip through the backend as plain TEXT columns and surface in `ActionOutcome` (cast-time, hit-time) and `ActiveBattleCondition` (apply/trigger/removed). Wire to a `ScriptableEventString` sink, then have an `AssetResponder` listen and load via `Addressables.LoadAssetAsync`.

| Event | Payload | Fires when |
|---|---|---|
| `SfxRequested` | `string` Addressables address | Ability cast/hit/miss SFX, status apply/tick/remove SFX |
| `VfxRequested` | `string` Addressables address | Ability cast/travel/hit VFX, status apply/trigger/removed VFX |

Empty/null keys are filtered out before raise — designers can leave any slot blank without producing noise.

## Variable wiring

Event wiring covers Job #1 of the legacy bridges (raise SOAP events).
**Variable wiring** covers Job #2: assign SOAP `BoolVariable` / `IntVariable` /
`FloatVariable` / `StringVariable` values when a C# event fires.

### Components

| Component | Location | Role |
|---|---|---|
| `VariableWriteMode` (enum) | `Assets/CR/Core/Wiring/` | `SetConstant` or `SetFromArg` |
| `VariableWiringEntry` | `Assets/CR/Core/Wiring/` | `(sourceTypeAqn, eventName, variable, mode, constantValue)` |
| `VariableWiringManifest` (SO) | `Assets/CR/Core/Wiring/` | List of entries (`CR → Wiring → Variable Wiring Manifest`) |
| `VariableWiringExecutor` | `Assets/CR/Core/Wiring/` | Reflection bridge that performs assignments |
| `VariableWiringRunner` | `Assets/CR/Core/Wiring/` | Zenject `IInitializable` that runs the executor at scene load |

### Write modes

| Mode | Event arity | Behavior |
|---|---|---|
| `SetConstant` | 0 or 1 | Parses `constantValue` against the variable's value type and assigns. Args (if any) are ignored. |
| `SetFromArg` | 1 only | Casts the event payload to the variable's value type and assigns. Type must match. |

### Supported parsing for `SetConstant`

| Variable | Constant text examples |
|---|---|
| `BoolVariable` | `true`, `false` |
| `IntVariable` | `0`, `42`, `-1` |
| `FloatVariable` | `1.0`, `-3.14` |
| `StringVariable` | any (use empty string for reset) |

### Example: replacing `BattleStateBridge` variable updates

| Source / event | Variable | Mode | Constant |
|---|---|---|---|
| `IBattleCoordinator.OnBattleStarted` | `isInBattleVariable` | SetConstant | `true` |
| `IBattleCoordinator.OnBattleEnded` | `isInBattleVariable` | SetConstant | `false` |
| `IBattleCoordinator.OnBattleEnded` | `activeBattleIdVariable` | SetConstant | (empty) |
| `BattleEventsAdapter.BattleEventStarted` | `activeBattleIdVariable` | SetFromArg | — |
| `BattleEventsAdapter.BattleEventEnded` | `playerWonVariable` | SetFromArg | — |

Drop a `VariableWiringManifest` into
`LocalDevGameInstaller → Variable Wiring Manifest`. The runner is bound NonLazy
and runs once at scene load, no-ops if the manifest slot is empty.

### Migrating away from a bridge

For each variable assignment in a bridge `Handle*` method:
1. Add a `VariableWiringEntry` covering it.
2. Verify the variable updates correctly.
3. Remove the assignment line (or the whole bridge once all rows are covered).

### Editor

Menu: `CR → Wiring → Variable Wiring Editor`. Same shape as the event wiring editor — pick a manifest, browse C# event sources from `CR.*` assemblies, attach a `ScriptableVariable` asset, choose mode + constant. Click **+ Wire**.

### IL2CPP codegen

Reflection-based wiring works in Mono/Editor but is fragile under IL2CPP. For production:
1. Select a `VariableWiringManifest` in the Project window.
2. `CR → Wiring → Generate Variable Bridge From Selected Manifest`.
3. Output: `Assets/CR/Core/Wiring/Generated/GeneratedVariableWiringBridge.cs`.
4. Bind it in `LocalDevGameInstaller` instead of (or alongside) `VariableWiringRunner`:

```csharp
Container.BindInterfacesAndSelfTo<GeneratedVariableWiringBridge>().AsSingle().NonLazy();
```

The generated class uses typed `+= handler` subscriptions and direct `.Value =` writes.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Editor window shows 0 sources | Namespace filter mismatch | Ensure source type is under `CR.*` |
| Source missing from list after adding | Assembly not reloaded | Recompile, click **Refresh** in the editor |
| Entry logs "no registered source instance" | Source not bound in DI | Add `Container.Bind<T>().AsSingle()` |
| Entry logs "cannot build handler" | Multi-arg event | Wrap in an adapter class |
| Entry logs "sink arg mismatch" | Data struct/SO mismatch | Ensure `ScriptableEvent<T>` uses the same `T` as the event payload |
| Wiring fires twice | Old bridge `MonoBehaviour` still present | Disable/delete the legacy bridge component in the scene |

## Migration from bridges

The legacy bridges in `Assets/CR/Core/State/Bridge/` (e.g. `BattleStateBridge`, `QuestStateBridge`) are still present and do two jobs:

1. Raise SOAP events (now replaceable by wiring).
2. Update SOAP `StringVariable`/`BoolVariable`/`IntVariable` state.

Job #1 can be migrated piecemeal: add wire entries for each bridge raise, then remove the bridge line. Leave the bridge in place until all its raises are covered by wiring.

Job #2 (variable updates) is not yet covered by this system — keep the bridge, or replace with a dedicated state-variable adapter in a follow-up.
