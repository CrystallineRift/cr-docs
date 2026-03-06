# NPC Interaction

NPC interaction in Unity is split across two MonoBehaviours that communicate through shared public properties. This separation keeps world initialization concerns (making backend calls when the world loads) distinct from player interaction concerns (responding to proximity and input).

## Why Two Components?

### Why `NpcWorldBehaviour` and `NpcInteractionBehaviour` Separately?

A single component handling both initialization and interaction would mix two very different concerns:
- **Initialization** is async, runs once at world load, requires `IWorldContext`, and talks to the backend
- **Interaction** is event-driven, runs repeatedly in response to player proximity and input, and only needs the results of initialization

Separating them means:
- `NpcWorldBehaviour` can be tested in isolation with a mock `INpcClient`
- `NpcInteractionBehaviour` can be tested in isolation with a mock `NpcWorldBehaviour` (just set the public properties)
- The interaction radius and prompt logic can be tweaked without touching the backend call logic

The `[RequireComponent]` attribute enforces that both live on the same GameObject and that `SphereCollider` is present — this is a compile-time safety net for the inspector.

### Why `HasCreatureToGive` on `NpcWorldBehaviour` Instead of Re-fetching?

`HasCreatureToGive` is set from the `ensure-starter` response on world load and is cleared locally after a successful `give-creature` call. Re-fetching on every interaction attempt would add latency and an extra round-trip to the backend.

The risk is that the backend and client disagree. This can happen if:
- The player receives the creature on another device
- The server-side state is rolled back due to a transaction failure

The `ensure-starter` call on the next world load corrects this because it re-fetches `HasCreatureToGive` from the server (the NPC team is checked fresh). For the duration of a single session, the client-side value is always consistent with the backend because the creature transfer is atomic — either it succeeds (client sets false) or it fails (client keeps true, player can retry).

## Component Overview

| Component | Responsibility |
|-----------|---------------|
| `NpcWorldBehaviour` | Calls the backend on world init to ensure the NPC exists |
| `NpcInteractionBehaviour` | Handles player proximity + E-press to receive a creature |

Source files:
- `../cr-data/…/NpcWorldBehaviour.cs`
- `../cr-data/…/NpcInteractionBehaviour.cs`

## `NpcWorldBehaviour`

`NpcWorldBehaviour` implements `IWorldInitializable`. It registers with `WorldRegistry` in `Awake` and is called by `GameInitializer` as part of the world bootstrap loop. See [World Behaviours](?page=unity/03-world-behaviours) for the full initialization lifecycle.

### Inspector Fields

| Field | Type | Description |
|-------|------|-------------|
| `_npcContentId` | string (GUID) | Stable content identity from seed data — must match `content_id` in the database |
| `_starterCreatureBaseId` | string (GUID) | Base creature UUID to generate on first visit |

Both must be valid GUIDs. If either is missing or malformed, `InitializeAsync` logs a warning and returns early — the NPC will not be initialized. The NPC GameObject will still be visible in the world but `NpcInteractionBehaviour` will find `HasCreatureToGive = false` and show no prompt.

### How It Works

```csharp
public async Task InitializeAsync(IWorldContext context, CancellationToken ct = default)
{
    // 1. Parse Inspector GUIDs
    if (!Guid.TryParse(_npcContentId, out var contentId))
    {
        _logger.Warning("[NpcWorldBehaviour] _npcContentId is not a valid GUID. NPC will not initialize.");
        return;
    }
    if (!Guid.TryParse(_starterCreatureBaseId, out var starterBaseId))
    {
        _logger.Warning("[NpcWorldBehaviour] _starterCreatureBaseId is not a valid GUID. NPC will not initialize.");
        return;
    }

    // 2. Store session context for later use by NpcInteractionBehaviour
    AccountId = context.AccountId;
    TrainerId = context.TrainerId;

    // 3. Call backend
    var response = await _npcClient.EnsureStarterNpcAsync(new EnsureStarterNpcRequest
    {
        AccountId = context.AccountId,
        TrainerId = context.TrainerId,
        ContentId = contentId,
        StarterCreatureBaseId = starterBaseId,
    }, ct);

    // 4. Store result
    NpcId = response.NpcId;
    HasCreatureToGive = response.HasCreatureToGive;
}
```

`_npcClient` is injected via Zenject's `[Inject]` method (not the constructor, since this is a MonoBehaviour). `NpcWorldBehaviour` depends on `INpcClient` which is bound to `NpcClientUnityHttp` in `LocalDevGameInstaller`. See [HTTP Clients](?page=unity/05-http-clients) for details on how the HTTP client is constructed.

### Public State

| Property | Type | Notes |
|----------|------|-------|
| `NpcId` | Guid | Set after successful `ensure-starter`; `Guid.Empty` until initialized |
| `HasCreatureToGive` | bool | True if NPC has a creature; set false after `give-creature` succeeds |
| `AccountId` | Guid | From world context; used in `give-creature` request |
| `TrainerId` | Guid | From world context; used in `give-creature` request |

`NpcInteractionBehaviour` reads all four properties directly. They are public setters to support testing — in production they are only written by `NpcWorldBehaviour` itself.

### Failure Behavior

If `EnsureStarterNpcAsync` throws (network error, server error, etc.), the exception propagates to `GameInitializer`'s initialization loop. `GameInitializer` logs the error and continues to the next `IWorldInitializable`. `NpcWorldBehaviour`'s public state remains in its default values (`NpcId = Guid.Empty`, `HasCreatureToGive = false`), effectively disabling the interaction for this session.

The player must reload the world (e.g., log out and back in) to retry initialization. There is currently no retry mechanism within a session.

## `NpcInteractionBehaviour`

### Requirements

`NpcInteractionBehaviour` requires `NpcWorldBehaviour` and `SphereCollider` on the same GameObject (enforced with `[RequireComponent]`). It accesses `NpcWorldBehaviour` via `GetComponent<NpcWorldBehaviour>()` in its `[Inject]` method or `Awake`.

### Inspector Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `_interactionRadius` | float | 3f | Trigger sphere radius in world units |

The `SphereCollider` is set to `isTrigger = true` and `radius = _interactionRadius` on `Awake`. Do not manually configure the `SphereCollider` in the Inspector — it is overwritten at runtime.

### Interaction Sequence

1. Player enters `SphereCollider` trigger → `OnTriggerEnter` fires
2. Checks `other.tag == "Player"` (the entering collider's root tag)
3. If `_npcWorld.HasCreatureToGive` is true → calls `ShowPrompt(true)`
4. Player presses **E** while inside the trigger → `GiveCreatureAsync` is called
5. `POST /api/v1/npc/{npcId}/give-creature` → creature transferred to trainer storage
6. On success: `_npcWorld.HasCreatureToGive = false`, `ShowPrompt(false)`, log message
7. Player exits trigger → `OnTriggerExit` fires → `ShowPrompt(false)`

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

    _npcWorld.HasCreatureToGive = false;
    _logger.Info($"You received {response.CreatureName}!");
}
```

`CancellationToken.None` is used for the give-creature call because cancelling a creature transfer mid-flight could leave the NPC's team in an inconsistent state. The server handles the transfer atomically, but if the client cancels the HTTP request before receiving the response, it does not know if the transfer succeeded. Using `CancellationToken.None` ensures the response is always received.

### Edge Cases and Gotchas

**Player presses E before init completes.** If the player is close to the NPC when the world loads and `InitializeAsync` is still running, `NpcId` is `Guid.Empty`. Calling `give-creature` with `Guid.Empty` will return a 400 from the backend. Guard against this by checking `_npcWorld.NpcId != Guid.Empty` before calling `GiveCreatureAsync`.

**Player presses E twice rapidly.** Two concurrent `GiveCreatureAsync` calls with the same `NpcId` will result in one success and one `InvalidOperationException` ("NPC has no creatures to give"). The first to complete sets `HasCreatureToGive = false`. Debounce the E-press input or disable the input as soon as the first call starts.

**NPC has no creature but `HasCreatureToGive` is true on client.** This is possible if the client and server are out of sync. `GiveCreatureAsync` will throw `NotFoundException` or `InvalidOperationException`. Handle this in the exception handler for `GiveCreatureAsync` by setting `HasCreatureToGive = false` and hiding the prompt even on failure.

## Setting Up an NPC in the Scene

1. Create a GameObject (e.g., `NPC_Cindris`)
2. Add `NpcWorldBehaviour` component
3. Add `NpcInteractionBehaviour` component (`SphereCollider` is added automatically via `[RequireComponent]`)
4. In the Inspector on `NpcWorldBehaviour`:
   - Set `_npcContentId` to the seed-data GUID for this NPC (must match `content_id` in the database and in `game_config.yaml` / YAML asset files)
   - Set `_starterCreatureBaseId` to the base creature UUID (must match a row in the `creature` table)
5. Adjust `_interactionRadius` on `NpcInteractionBehaviour` as needed (default 3 world units)
6. Ensure the player's root GameObject has the tag `"Player"` (checked in `OnTriggerEnter`)
7. Verify Zenject has `INpcClient` bound in `LocalDevGameInstaller` (it is bound by default; only check if you added a new scene installer)

## UI Prompt

`ShowPrompt(visible)` currently logs a debug message. To wire it to a world-space UI:

1. Create a `Canvas` (World Space) as a child of the NPC GameObject
2. Add a `TextMeshPro` label reading "Press E to receive creature"
3. In `NpcInteractionBehaviour`, hold a `[SerializeField] private GameObject _promptPanel;` reference
4. Replace the `ShowPrompt` log statement with `_promptPanel.SetActive(visible)`

The prompt panel should be initially inactive in the Inspector so it does not appear before the player enters the trigger radius.

## Common Mistakes / Tips

- **`_npcContentId` and `_starterCreatureBaseId` not set in Inspector.** The NPC silently fails to initialize. Always test a new NPC placement by watching the Unity Console for initialization log messages.
- **Player tag not set.** `OnTriggerEnter` never activates the prompt. The NPC will be "dead" even after correct initialization.
- **Double E-press triggering two transfers.** Add an `_isTransferring` bool guard and set it true before the async call, false after (in a finally block). Reset it to false on failure to allow retry.
- **Wrong `content_id` in Inspector.** If `_npcContentId` does not match any seed row, `GetNpcByContentIdAsync` returns null on every call and `EnsureStarterNpc` creates a new NPC with the Inspector's GUID as its `content_id`. Check the NPC count in the database if you suspect duplicate rows.
- **Using the database `id` instead of `content_id` in the Inspector.** The Inspector field expects the `content_id` value, not the internal row `id`. If you copy the wrong UUID from the database, the NPC lookup will always miss and a duplicate will be created each session.

## Related Pages

- [World Behaviours](?page=unity/03-world-behaviours) — `IWorldInitializable` lifecycle that `NpcWorldBehaviour` implements
- [Starter Creature Flow](?page=backend/05-starter-creature-flow) — end-to-end walkthrough of both components in action
- [NPC System](?page=backend/02-npc-system) — backend domain service behind these interactions
- [HTTP Clients](?page=unity/05-http-clients) — `INpcClient` / `NpcClientUnityHttp` that carries the requests
