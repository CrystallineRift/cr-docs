# NPC Interaction

NPC interaction in Unity is built around a composable MonoBehaviour pattern. `NpcWorldBehaviour` resolves the NPC's backend identity, then dispatches to add-on sub-behaviours (`NpcCreatureGrantBehaviour`, `NpcTrainerBehaviour`, `NpcMerchantBehaviour`). `NpcInteractionBehaviour` sits on the same GameObject, inspects whichever sub-behaviours are present, and routes the player's E-key press to the appropriate action.

## Why This Design?

### Why Composable Sub-Behaviours Instead of a Monolithic Component?

An earlier design embedded creature grants, merchant state, and battle setup all in `NpcWorldBehaviour`. This produced a growing list of inspector fields (including `_starterCreatureBaseId`) and branching initialization logic: "if this NPC is a starter do A, if it's a merchant do B." Every NPC prefab carried dead fields for behavior it did not use.

The composable pattern replaces this with opt-in components:
- `NpcWorldBehaviour` handles identity only
- `NpcCreatureGrantBehaviour` is added only to NPCs that grant creatures
- `NpcTrainerBehaviour` is added only to NPCs that battle the player
- `NpcMerchantBehaviour` is added only to merchant NPCs

`NpcInteractionBehaviour` queries `GetComponent` for whichever sub-behaviours are present and dispatches accordingly — no branching inside any single component.

### Why `NpcBattleRequest` as a Record Instead of a Dictionary?

Battle initiation requires several pieces of correlated data: who the NPC is, who the player is, what team the NPC brings, and what items the NPC carries into battle. A typed record makes this explicit and prevents callers from accidentally omitting fields. It also serves as the event payload for `OnBattleRequested`, giving scene-level coordinators a self-contained bundle they can pass directly to the battle system.

### Why an Event (`OnBattleRequested`) Instead of a Direct Call?

`NpcInteractionBehaviour` is a scene-level component that should not know about the battle system's entry point. Firing an event decouples the two: the battle coordinator subscribes at scene load and handles routing. This also supports testing — tests can subscribe to `OnBattleRequested` and assert it fires with correct data without needing the full battle system wired up.

In practice, `NpcInteractionBehaviour` does call `IBattleCoordinator.StartNpcBattle` directly (it has the coordinator injected). The `OnBattleRequested` event is also fired for any additional observers (analytics, cutscenes, etc.) that need to react at interaction time.

### Why `CancellationToken.None` in `GiveCreatureAsync`?

Creature transfers are atomic on the backend side — the server commits the creature to the trainer's inventory in a single transaction. If the client cancels mid-flight and abandons the request, it does not know whether the server completed the transfer. Using `CancellationToken.None` prevents the client from cancelling the request and then falsely concluding the transfer failed. The backend's idempotency guarantee (same NPC cannot give the same slot twice) covers the case where the transfer did complete but the client never received the response.

## Component Overview

| Component | Responsibility |
|-----------|---------------|
| `NpcWorldBehaviour` | Resolves NPC backend identity; dispatches to sub-behaviours |
| `NpcCreatureGrantBehaviour` | Seeds a designer-configured creature team; tracks grant state |
| `NpcTrainerBehaviour` | Seeds creature team + item inventory; caches both; exposes `CanBattle` |
| `NpcMerchantBehaviour` | Marks the NPC as a merchant; exposes `MerchantNpcId` |
| `NpcInteractionBehaviour` | Proximity + E-press dispatcher; fires `OnBattleRequested` |

## `NpcWorldBehaviour`

`NpcWorldBehaviour` implements `IWorldInitializable`. It registers with `WorldRegistry` in `Awake` and is called by `GameInitializer` as part of the world bootstrap loop. See [World Behaviours](?page=unity/03-world-behaviours) for the full initialization lifecycle.

`NpcWorldBehaviour` is **identity-only**. It calls `EnsureNpcAsync` to guarantee the NPC row exists on the backend, stores the resolved `NpcId`, and then calls `InitializeAsync` on all `INpcSubInitializable` components on the same GameObject (in component order).

### Inspector Fields

| Field | Type | Description |
|-------|------|-------------|
| `_npcContentKey` | string | Stable designer-facing key — must match `content_key` in the database (e.g. `"cindris_starter_npc"`) |
| `_npcType` | NpcType | The NPC type to write on first creation. Defaults to `Npc`. Set to `Trainer` for trainer NPCs. First-write-wins. |

There is no `_starterCreatureBaseId` field. Creature team configuration belongs on `NpcCreatureGrantBehaviour` or `NpcTrainerBehaviour`.

### Public State

| Property | Type | Notes |
|----------|------|-------|
| `NpcId` | Guid | Set after `EnsureNpcAsync`; `Guid.Empty` until initialized |
| `AccountId` | Guid | From world context |
| `TrainerId` | Guid | From world context |

### Failure Behavior

If `EnsureNpcAsync` throws (network error, server error, etc.), the exception propagates to `GameInitializer`'s initialization loop. `GameInitializer` logs the error and continues to the next `IWorldInitializable`. Sub-behaviours are not called and remain uninitialized. `NpcInteractionBehaviour` finds `NpcId == Guid.Empty` and shows no prompt.

## `NpcBattleRequest` Record

`NpcBattleRequest` is the payload carried by the `OnBattleRequested` event:

```csharp
public record NpcBattleRequest(
    Guid NpcId,
    Guid AccountId,
    Guid TrainerId,
    IReadOnlyList<CreatureInventoryEntry> NpcTeam,
    IReadOnlyList<NpcInventoryEntry> NpcItems
);
```

| Field | Source |
|-------|--------|
| `NpcId` | `NpcWorldBehaviour.NpcId` |
| `AccountId` | `NpcWorldBehaviour.AccountId` |
| `TrainerId` | `NpcWorldBehaviour.TrainerId` |
| `NpcTeam` | `NpcTrainerBehaviour.CreatureTeam` |
| `NpcItems` | `NpcTrainerBehaviour.BattleItems` |

## `NpcInteractionBehaviour`

`NpcInteractionBehaviour` requires `NpcWorldBehaviour` and `SphereCollider` on the same GameObject (enforced with `[RequireComponent]`). It queries optional sub-behaviours in its `Awake` or `[Inject]` method:

```csharp
_grantBehaviour    = GetComponent<NpcCreatureGrantBehaviour>();
_trainerBehaviour  = GetComponent<NpcTrainerBehaviour>();
_merchantBehaviour = GetComponent<NpcMerchantBehaviour>();
```

### Inspector Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `_interactionRadius` | float | 3f | Trigger sphere radius in world units |

The `SphereCollider` is set to `isTrigger = true` and `radius = _interactionRadius` on `Awake`. Do not manually configure the `SphereCollider` in the Inspector — it is overwritten at runtime.

### `OnBattleRequested` Event

```csharp
public event Action<NpcBattleRequest> OnBattleRequested;
```

Fired when the player presses E and `NpcTrainerBehaviour.CanBattle` is true (and no grant is pending). Scene-level coordinators subscribe to this event to react at interaction time (analytics, cutscenes). The battle itself is started by `NpcInteractionBehaviour` calling `IBattleCoordinator.StartNpcBattle` directly.

### Interaction Dispatch Flow

When the player presses **E** inside the trigger:

1. Check `_npcWorld.NpcId != Guid.Empty` — guard against pressing E before init completes
2. **Grant check:** if `_grantBehaviour != null && _grantBehaviour.IsReady && _grantBehaviour.HasCreatureToGive`
   - Call `EnsureNpcAsync` endpoint with give-creature action
   - On success: `_grantBehaviour.HasCreatureToGive = false`, hide grant prompt
   - Grant takes priority — a trainer NPC that still has a creature to give will not trigger battle
3. **Battle check:** else if `_trainerBehaviour != null && _trainerBehaviour.CanBattle`
   - Build `NpcBattleRequest` from `_npcWorld` + `_trainerBehaviour.CreatureTeam` + `_trainerBehaviour.BattleItems`
   - Fire `OnBattleRequested(request)`
   - Call `IBattleCoordinator.StartNpcBattle(request)` directly
4. If neither applies, no action is taken

```csharp
private async Task OnInteractAsync()
{
    if (_npcWorld.NpcId == Guid.Empty) return;

    // 1. Grant takes priority
    if (_grantBehaviour != null && _grantBehaviour.IsReady && _grantBehaviour.HasCreatureToGive)
    {
        await GiveCreatureAsync();
        return;
    }

    // 2. Battle
    if (_trainerBehaviour != null && _trainerBehaviour.CanBattle)
    {
        var request = new NpcBattleRequest(
            _npcWorld.NpcId,
            _npcWorld.AccountId,
            _npcWorld.TrainerId,
            _trainerBehaviour.CreatureTeam,
            _trainerBehaviour.BattleItems
        );
        OnBattleRequested?.Invoke(request);
    }
}
```

### Proximity Detection

1. Player enters `SphereCollider` trigger → `OnTriggerEnter` fires
2. Checks `other.tag == "Player"`
3. Evaluates which prompt to show:
   - Grant pending → show "Press E to receive creature"
   - Can battle → show "Press E to battle"
   - Neither → no prompt
4. Player exits trigger → `OnTriggerExit` fires → hide all prompts

### How the Battle Sub-Behaviour Triggers a Battle

`NpcInteractionBehaviour` injects `IBattleCoordinator` via Zenject:

```csharp
[Inject]
public void Init(IBattleCoordinator battleCoordinator, /* ... */)
{
    _battleCoordinator = battleCoordinator;
}
```

When the player presses E and `CanBattle` is true, the interaction builds an `NpcBattleRequest` and passes it to `_battleCoordinator.StartNpcBattle(request)`. This starts the battle state machine, which:
1. Validates both trainers have creatures
2. Creates a `BattleSession` with the NPC's team
3. Fires `IBattleCoordinator.OnBattleStarted` with the session

Any scene-level UI (e.g., battle screen controller) subscribes to `OnBattleStarted` to display the battle UI. See [Battle System](?page=unity/07-battle-system) for the full flow.

## Scene Setup Checklist

### Prerequisites (do once per scene)

- The main scene must have a `GameContext` component with `LocalDevGameInstaller` attached
- The player root GameObject must have tag `"Player"`
- `IBattleCoordinator` must be bound in `LocalDevGameInstaller` (it is, as `BattleCoordinator`)
- Battle UI controller (if any) must subscribe to `IBattleCoordinator.OnBattleStarted` in `OnEnable`

### Starter / Grant NPC

1. Create a GameObject (e.g., `NPC_Cindris`)
2. Add `NpcWorldBehaviour` — set `_npcContentKey` (e.g. `"cindris_starter_npc"`), leave `_npcType` as `Npc`
3. Add `NpcCreatureGrantBehaviour` — configure `_slots`:
   - Slot 0: `CreatureBaseContentKey = "cindris_grass_starter"`, `SlotNumber = 1`
4. Add `NpcInteractionBehaviour` — `SphereCollider` is added automatically
5. Adjust `_interactionRadius` as needed
6. Verify `_npcContentKey` matches the `content_key` column in the backend `npc` table seed data

### Trainer NPC (Battle Only)

1. Create a GameObject (e.g., `NPC_Trainer_Kael`)
2. Add `NpcWorldBehaviour` — set `_npcContentKey`, set `_npcType` to `Trainer`
3. Add `NpcTrainerBehaviour` — configure `_slots` (set `creatureBaseContentKey` directly in the Inspector, e.g. `"cindris"` or `"starter_1"`) and optionally `_items` (UUID strings)
4. Add `NpcInteractionBehaviour`
5. Verify each `creatureBaseContentKey` in `_slots` matches the `content_key` column in the `creature` table (seeded values: `"cindris"`, `"starter_1"`, `"starter_2"`, `"starter_3"`)

### Trainer NPC (Grant + Battle)

1. Create a GameObject (e.g., `NPC_Trainer_Kael`)
2. Add `NpcWorldBehaviour` — set `_npcContentKey`, set `_npcType` to `Trainer`
3. Add `NpcCreatureGrantBehaviour` — configure `_slots` for first-visit grant
4. Add `NpcTrainerBehaviour` — configure `_slots` for the battle team and `_items` for battle items
5. Add `NpcInteractionBehaviour`
6. **Verify component order**: `NpcCreatureGrantBehaviour` must be above `NpcTrainerBehaviour` in the Inspector list

### Merchant NPC

1. Create a GameObject (e.g., `NPC_Merchant_Elara`)
2. Add `NpcWorldBehaviour` — set `_npcContentKey`, leave `_npcType` as `Npc`
3. Add `NpcMerchantBehaviour`
4. Add `NpcInteractionBehaviour`
5. In a scene coordinator, query `_merchantBehaviour.MerchantNpcId` to open the shop UI

## Dialogue NPCs: NpcDialogueBehaviour

`NpcDialogueBehaviour` is the dialogue marker sub-behaviour. It wraps the Pixel Crushers
`DialogueSystemTrigger` on the same GameObject (configured with trigger = **On Use**) and
exposes two members to the interaction system:

- `HasConversation` — true when a conversation is assigned and none is currently running
  (guarded by the shared `isInConversation` BoolVariable set by `DialogueStateBridge`)
- `StartConversation(Transform actor)` — forwards to `DialogueSystemTrigger.OnUse(actor)`,
  which checks the trigger's accepted tags/conditions against the player transform

The dialogue branch is the **lowest-priority** dispatch in `NpcInteractionBehaviour`
(after grant, trainer battle, and merchant). It does not call
`QuestManager.OnNpcInteracted` — `QuestDialogueBridge` records that when the conversation
completes, so triggering would double-count.

> **Do not use the Pixel Crushers `ProximitySelector`/`Selector` use-key on the player.**
> It polls its own raw key globally and fires whichever `Usable` is in range, even while
> the player is interacting with a different NPC. Disable or remove those components;
> all interaction flows through the single `Player/Interact` input action.

Setup: add `DialogueSystemTrigger` (On Use, conversation assigned) + `NpcDialogueBehaviour`
(assign the shared `isInConversation` BoolVariable) + `NpcInteractionBehaviour` to the NPC.
See [Dialogue Integration](?page=unity/11-dialogue-integration) for the conversation/quest
bridge details.

## Adding a New Sub-Behaviour Type

To add a new sub-behaviour (see `NpcMerchantBehaviour` for an `INpcSubInitializable`
example, or `NpcDialogueBehaviour` for a plain marker wrapper):

1. Implement the component. If it needs NPC identity at world init, implement
   `INpcSubInitializable` — `NpcWorldBehaviour` discovers and drives it (sub-behaviours do
   NOT register with `WorldRegistry`).
2. Register any new service dependencies in `LocalDevGameInstaller`.
3. If it affects interaction, add a `GetComponent` query in `NpcInteractionBehaviour`'s
   `Awake`, include it in the range gate, and extend the dispatch flow in
   `PerformInteraction`.
4. Add the component to the relevant NPC GameObjects.

## In-Range Indicator

While the player is inside an interactable NPC's range, `NpcInteractionBehaviour`
shows a world-space badge above the NPC's head (`NpcInteractionIndicator`): a
billboarded, gently bobbing gold "E" built procedurally from TextMeshPro.

- **Custom visual**: assign a prefab to the behaviour's `Prompt Indicator Prefab`
  field — it is parented to the NPC at `Prompt Height` (default 2.2) and toggled
  with range. Add `NpcInteractionIndicator` to the prefab root if you want the
  billboard + bob animation; leave it off for static visuals.
- The indicator appears only when an interaction is actually available (same
  gate as the Interact subscription: grant/trainer/merchant/dialogue).
- Range state self-heals at interact time: disabled Malbers bone colliders never
  raise `OnTriggerExit`, so the behaviour prunes stale colliders and re-checks
  distance before performing.

## Subscribing to Battle Events

`NpcInteractionBehaviour` internally calls `IBattleCoordinator.StartNpcBattle(request)` — you do not need to wire this yourself. The recommended hook for UI and scene transitions is `IBattleCoordinator.OnBattleStarted`:

```csharp
public class BattleUIController : MonoBehaviour
{
    [Inject] private IBattleCoordinator _battleCoordinator;

    private void OnEnable()  => _battleCoordinator.OnBattleStarted += HandleBattleStarted;
    private void OnDisable() => _battleCoordinator.OnBattleStarted -= HandleBattleStarted;

    private void HandleBattleStarted(BattleSession session)
    {
        // session.Kind == BattleRequestKind.NpcTrainer
        // Open battle UI, pass session data
    }
}
```

`NpcInteractionBehaviour.OnBattleRequested` still fires and can be subscribed for custom pre-battle hooks (analytics, cutscenes, etc.).

Always unsubscribe in `OnDisable`/`OnDestroy` to prevent stale delegate references after scene unload.

## Edge Cases and Gotchas

**Player presses E before init completes.** `NpcId` is `Guid.Empty`. The guard at the top of `OnInteractAsync` returns early. No backend call is made.

**Player presses E twice rapidly.** Two concurrent `GiveCreatureAsync` calls with the same `NpcId` will result in one success and one error from the backend. Debounce with an `_isInteracting` bool guard:

```csharp
if (_isInteracting) return;
_isInteracting = true;
try { await OnInteractAsync(); }
finally { _isInteracting = false; }
```

**Grant and battle both available.** Grant always takes priority (step 2 runs before step 3 in the dispatch flow). Once the grant is claimed, subsequent E-presses check battle.

**`NpcTrainerBehaviour` before `NpcCreatureGrantBehaviour` in component order.** Sub-behaviours run in `GetComponents` order (top to bottom in Inspector). If `NpcTrainerBehaviour.InitializeAsync` fetches the team before `NpcCreatureGrantBehaviour` seeds it, the cached team may be empty on first visit.

## Common Mistakes / Tips

- **`_npcContentKey` not set in Inspector.** `NpcWorldBehaviour.InitializeAsync` logs a warning and returns early. Sub-behaviours are never called. Always verify the Inspector field before first play.
- **`_starterCreatureBaseId` field no longer exists on `NpcWorldBehaviour`.** Creature team seeding is now `NpcCreatureGrantBehaviour._slots` or `NpcTrainerBehaviour._slots`. If you are migrating an old prefab, remove the old field reference and add the appropriate sub-behaviour.
- **Player tag not set.** `OnTriggerEnter` never activates. The NPC appears in the world but is non-interactive. Check `GameObject.tag == "Player"` on the player root.
- **Not unsubscribing `OnBattleRequested`.** A destroyed coordinator with a live subscription can cause `NullReferenceException` after scene unload. Always unsubscribe in `OnDisable`.
- **Wrong `content_key` in Inspector.** `EnsureNpcAsync` creates a new NPC row each time it sees an unknown key. Check the NPC count in the database if you suspect duplicates — each distinct `content_key` creates its own row per trainer.
- **`NpcTrainerBehaviour._items` using a non-GUID string.** Each `itemId` must be a valid UUID string. The behaviour logs a warning and skips invalid entries. Future work: replace `itemId` string with a `contentKey` string once items have `content_key` support.
- **`_npcType` not set on a typed NPC.** The NPC is created with type `Npc` in the database. Since the drift-reconcile change, setting the Inspector field to an explicit type (Merchant/Trainer/QuestGiver) heals the stored row on the next world init — `EnsureNpcAsync` updates `npc_type` when an explicit non-default type differs. The default `Npc` never downgrades an existing row.
- **SphereCollider radius too small.** The player must physically enter the sphere for `OnTriggerEnter` to fire. If the trigger radius is smaller than the player's collider, the player may walk through without triggering. Set `_interactionRadius` to at least 1.5f for standard NPC interactions.
- **Missing `INpcSubInitializable` injection binding.** If `NpcDialogueBehaviour` (or any custom sub-behaviour) injects a service that is not bound in `LocalDevGameInstaller`, Zenject will throw at scene load. Always add the binding before adding the component to a scene object.

## The interact button

`Player/Interact` in `CR_GameInput.inputactions`:

| Device | Binding |
|---|---|
| Keyboard | `E` |
| Gamepad | `<Gamepad>/buttonWest` — **X** on an Xbox layout, Square on PlayStation |

The badge `NpcInteractionIndicator` floats above an interactable NPC is **device-aware**: it shows
`X` when a gamepad was the last device touched and `E` otherwise, so it always names a button that
actually works. The choice lives in `InteractionGlyphPolicy` (pure, unit-tested); a connected
gamepad wins ties, including at startup before any input has arrived.

To change the binding, edit the action asset — do **not** hardcode a new letter in the indicator.

:::caution
`buttonWest` is also bound to `Player/Attack`. Nothing in CR reads that action today, so the two do
not currently conflict, but anything that starts consuming `Attack` will collide with interaction on
the same physical button.
:::

## Related Pages

- [World Behaviours](?page=unity/03-world-behaviours) — `INpcSubInitializable`, `NpcWorldBehaviour` identity pattern, composable component setup
- [NPC System](?page=backend/02-npc-system) — `EnsureNpcAsync`, `EnsureNpcCreatureTeamAsync`, `EnsureNpcItemsAsync`, REST endpoints
- [Starter Creature Flow](?page=backend/05-starter-creature-flow) — end-to-end walkthrough of world init through player interaction
- [HTTP Clients](?page=unity/05-http-clients) — `INpcClient` / `NpcClientUnityHttp` that carries the requests
- [Dependency Injection](?page=unity/02-dependency-injection) — how sub-behaviour dependencies are registered and injected
- [Battle System](?page=unity/07-battle-system) — `BattleCoordinator`, `BattleSession`, full NPC trainer battle flow
