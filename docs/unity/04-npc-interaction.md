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

## Component Overview

| Component | Responsibility |
|-----------|---------------|
| `NpcWorldBehaviour` | Resolves NPC backend identity; dispatches to sub-behaviours |
| `NpcCreatureGrantBehaviour` | Seeds a designer-configured creature team; tracks grant state |
| `NpcTrainerBehaviour` | Seeds creature team + item inventory; caches both; exposes `CanBattle` |
| `NpcMerchantBehaviour` | Marks the NPC as a merchant; exposes `MerchantNpcId` |
| `NpcInteractionBehaviour` | Proximity + E-press dispatcher; fires `OnBattleRequested` |

Source files:
- `../cr-data/…/NpcWorldBehaviour.cs`
- `../cr-data/…/NpcCreatureGrantBehaviour.cs`
- `../cr-data/…/NpcTrainerBehaviour.cs`
- `../cr-data/…/NpcMerchantBehaviour.cs`
- `../cr-data/…/NpcInteractionBehaviour.cs`
- `../cr-data/…/NpcBattleRequest.cs`

## `NpcWorldBehaviour`

`NpcWorldBehaviour` implements `IWorldInitializable`. It registers with `WorldRegistry` in `Awake` and is called by `GameInitializer` as part of the world bootstrap loop. See [World Behaviours](?page=unity/03-world-behaviours) for the full initialization lifecycle.

`NpcWorldBehaviour` is **identity-only**. It calls `POST /api/v1/npc/ensure` to guarantee the NPC row exists on the backend, stores the resolved `NpcId`, and then calls `OnNpcReadyAsync` on all `INpcSubInitializable` components on the same GameObject.

### Inspector Fields

| Field | Type | Description |
|-------|------|-------------|
| `_npcContentKey` | string | Stable designer-facing key — must match `content_key` in the database (e.g. `"cindris_starter_npc"`) |
| `_npcType` | NpcType | The NPC type to write on first creation. Defaults to `Npc`. Set to `Trainer` for trainer NPCs. First-write-wins: if the NPC already exists, this field is ignored. |

There is no `_starterCreatureBaseId` field. Creature team configuration belongs on `NpcCreatureGrantBehaviour` or `NpcTrainerBehaviour`.

### Public State

| Property | Type | Notes |
|----------|------|-------|
| `NpcId` | Guid | Set after `EnsureNpcAsync`; `Guid.Empty` until initialized |
| `AccountId` | Guid | From world context |
| `TrainerId` | Guid | From world context |

### Failure Behavior

If `EnsureNpcAsync` throws (network error, server error, etc.), the exception propagates to `GameInitializer`'s initialization loop. `GameInitializer` logs the error and continues to the next `IWorldInitializable`. Sub-behaviours are not called and remain uninitialized. `NpcInteractionBehaviour` finds no ready state and shows no prompt.

## `NpcBattleRequest` Record

`NpcBattleRequest` is the payload carried by the `OnBattleRequested` event. It bundles everything a battle coordinator needs to start a fight:

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

`NpcItems` contains the items seeded via the `_items` Inspector list on `NpcTrainerBehaviour`. The battle system can use these to grant items to the trainer on victory, or for any other battle-resolution logic.

## `NpcInteractionBehaviour`

`NpcInteractionBehaviour` requires `NpcWorldBehaviour` and `SphereCollider` on the same GameObject (enforced with `[RequireComponent]`). It queries optional sub-behaviours in its `Awake` or `[Inject]` method:

```csharp
_grantBehaviour   = GetComponent<NpcCreatureGrantBehaviour>();
_trainerBehaviour = GetComponent<NpcTrainerBehaviour>();
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

Fired when the player presses E and `NpcTrainerBehaviour.CanBattle` is true (and no grant is pending). Scene-level coordinators subscribe to this event to launch the battle system.

### Interaction Dispatch Flow

When the player presses **E** inside the trigger:

1. Check `_npcWorld.NpcId != Guid.Empty` — guard against pressing E before init completes
2. **Grant check:** if `_grantBehaviour != null && _grantBehaviour.IsReady && _grantBehaviour.HasCreatureToGive`
   - Call `POST /api/v1/npc/{npcId}/give-creature`
   - On success: `_grantBehaviour.HasCreatureToGive = false`, hide grant prompt
   - Grant takes priority — a trainer NPC that still has a creature to give will not trigger battle
3. **Battle check:** else if `_trainerBehaviour != null && _trainerBehaviour.CanBattle`
   - Build `NpcBattleRequest` from `_npcWorld` + `_trainerBehaviour.CreatureTeam` + `_trainerBehaviour.BattleItems`
   - Fire `OnBattleRequested(request)`
4. If neither applies, no action is taken (player may be interacting before init completes, or NPC has no relevant sub-behaviour)

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

### `GiveCreatureAsync` Detail

```csharp
private async Task GiveCreatureAsync()
{
    var response = await _npcClient.GiveCreatureAsync(
        _npcWorld.NpcId,
        new GiveCreatureRequest
        {
            AccountId = _npcWorld.AccountId,
            TrainerId = _npcWorld.TrainerId,
        },
        CancellationToken.None);

    _grantBehaviour.HasCreatureToGive = false;
    ShowPrompt(PromptType.None);
    _logger.Info($"You received {response.CreatureName}!");
}
```

`CancellationToken.None` is used because cancelling a creature transfer mid-flight could leave the NPC's team in an inconsistent state. The server handles the transfer atomically; if the client cancels before receiving the response, it does not know if the transfer succeeded.

## Setting Up an NPC in the Scene

### Starter / Grant NPC

1. Create a GameObject (e.g., `NPC_Cindris`)
2. Add `NpcWorldBehaviour` — set `_npcContentKey` (e.g. `"cindris_starter_npc"`), leave `_npcType` as `Npc`
3. Add `NpcCreatureGrantBehaviour` — configure `_slots`:
   - Slot 1: `CreatureBaseContentKey = "cindris_grass_starter"`, `SlotNumber = 1`
4. Add `NpcInteractionBehaviour` (`SphereCollider` added automatically)
5. Adjust `_interactionRadius` as needed
6. Ensure the player root GameObject has tag `"Player"`

### Trainer NPC (Battle Only)

1. Create a GameObject (e.g., `NPC_Trainer_Kael`)
2. Add `NpcWorldBehaviour` — set `_npcContentKey`, set `_npcType` to `Trainer`
3. Add `NpcTrainerBehaviour` — configure `_slots` (creature team) and optionally `_items`
4. Add `NpcInteractionBehaviour`
5. Subscribe to `IBattleCoordinator.OnBattleStarted` to open the battle UI when a battle begins:
   ```csharp
   _battleCoordinator.OnBattleStarted += session => { /* open battle UI */ };
   ```
   `NpcInteractionBehaviour` now calls `BattleCoordinator.StartNpcBattle(request)` directly — no additional wiring is needed to connect the interaction to the battle engine. `OnBattleRequested` still fires if you need to react to the interaction itself before the battle starts.

### Trainer NPC (Grant + Battle)

1. Create a GameObject (e.g., `NPC_Trainer_Kael`)
2. Add `NpcWorldBehaviour` — set `_npcContentKey`, set `_npcType` to `Trainer`
3. Add `NpcCreatureGrantBehaviour` — configure `_slots` for first-visit grant
4. Add `NpcTrainerBehaviour` — configure `_slots` for the battle team and `_items` for battle items
5. Add `NpcInteractionBehaviour`
6. Subscribe to `OnBattleRequested` in a scene coordinator

Note: when both are present, `NpcCreatureGrantBehaviour` must appear above `NpcTrainerBehaviour` in the component list (see [World Behaviours — Coexistence](?page=unity/03-world-behaviours)).

### Merchant NPC

1. Create a GameObject (e.g., `NPC_Merchant_Elara`)
2. Add `NpcWorldBehaviour` — set `_npcContentKey`, leave `_npcType` as `Npc`
3. Add `NpcMerchantBehaviour`
4. Add `NpcInteractionBehaviour`
5. In a scene coordinator, query `_merchantBehaviour.MerchantNpcId` to open the shop UI

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
        // session.PlayerTurnKey is set and ready
    }
}
```

`NpcInteractionBehaviour.OnBattleRequested` still fires and can be subscribed for custom pre-battle hooks (analytics, cutscenes, etc.). Subscribe to `OnBattleStarted` if you only care about confirmed battle start; subscribe to `OnBattleRequested` if you need to act at interaction time before the battle engine initializes.

Always unsubscribe in `OnDisable`/`OnDestroy` to prevent stale delegate references after scene unload.

## Edge Cases and Gotchas

**Player presses E before init completes.** `NpcId` is `Guid.Empty`. The guard at the top of `OnInteractAsync` returns early. No backend call is made.

**Player presses E twice rapidly.** Two concurrent `GiveCreatureAsync` calls with the same `NpcId` will result in one success and one `InvalidOperationException` from the backend. Debounce with an `_isInteracting` bool guard:

```csharp
if (_isInteracting) return;
_isInteracting = true;
try { await OnInteractAsync(); }
finally { _isInteracting = false; }
```

**Grant and battle both available.** Grant always takes priority (step 2 runs before step 3 in the dispatch flow). Once the grant is claimed, subsequent E-presses check battle.

**`NpcTrainerBehaviour` before `NpcCreatureGrantBehaviour` in component order.** Sub-behaviours run in `GetComponents` order. If `NpcTrainerBehaviour.InitializeAsync` fetches the team before `NpcCreatureGrantBehaviour` seeds it, the cached team may be empty on first visit. Ensure `NpcCreatureGrantBehaviour` appears before `NpcTrainerBehaviour` in the Inspector's component list.

**`_npcType` not set to `Trainer` on a trainer NPC.** The NPC will be created with type `Npc` in the database. This is a first-write-wins field — fix requires a direct database update. Always set `_npcType = Trainer` on trainer NPC GameObjects before the first world load.

## Common Mistakes / Tips

- **`_npcContentKey` not set in Inspector.** `NpcWorldBehaviour.InitializeAsync` logs a warning and returns early. Sub-behaviours are never called. Always verify the Inspector field.
- **`_starterCreatureBaseId` field no longer exists on `NpcWorldBehaviour`.** Creature team seeding is now `NpcCreatureGrantBehaviour._slots` or `NpcTrainerBehaviour._slots`. If you are migrating an old prefab, remove the old field reference and add the appropriate sub-behaviour.
- **Player tag not set.** `OnTriggerEnter` never activates. The NPC appears in the world but is non-interactive.
- **Not unsubscribing `OnBattleRequested`.** A destroyed coordinator with a live subscription can cause `NullReferenceException` after scene unload. Always unsubscribe in `OnDisable`.
- **Wrong `content_key` in Inspector.** `EnsureNpcAsync` creates a new NPC row each time it sees an unknown key. Check the NPC count in the database if you suspect duplicates.
- **`NpcTrainerBehaviour._items` using a non-GUID string.** Each `itemId` must be a valid UUID string. The behaviour logs a warning and skips invalid entries. Future work: replace `itemId` string with a `contentKey` string once items have `content_key` support.

## Related Pages

- [World Behaviours](?page=unity/03-world-behaviours) — `INpcSubInitializable`, `NpcWorldBehaviour` identity pattern, composable component setup
- [NPC System](?page=backend/02-npc-system) — `EnsureNpcAsync`, `EnsureNpcCreatureTeamAsync`, `EnsureNpcItemsAsync`, REST endpoints
- [Starter Creature Flow](?page=backend/05-starter-creature-flow) — end-to-end walkthrough of world init through player interaction
- [HTTP Clients](?page=unity/05-http-clients) — `INpcClient` / `NpcClientUnityHttp` that carries the requests
- [Battle System](?page=unity/07-battle-system) — `BattleCoordinator`, `BattleSession`, full NPC trainer battle flow
