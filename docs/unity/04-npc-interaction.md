# NPC Interaction

## Overview

NPC interaction in Unity is split across two MonoBehaviours:

| Component | Responsibility |
|-----------|---------------|
| `NpcWorldBehaviour` | Calls the backend on world init to ensure the NPC exists |
| `NpcInteractionBehaviour` | Handles player proximity + E-press to receive a creature |

Source files:
- `../cr-data/…/NpcWorldBehaviour.cs`
- `../cr-data/…/NpcInteractionBehaviour.cs`

## NpcWorldBehaviour

### Inspector Fields

| Field | Type | Description |
|-------|------|-------------|
| `_npcContentId` | string (GUID) | Stable content identity from seed data |
| `_starterCreatureBaseId` | string (GUID) | Base creature UUID to generate on first visit |

Both must be valid GUIDs. If either is missing or malformed, `InitializeAsync` logs a warning and returns early — the NPC will not be initialized.

### How It Works

```csharp
public async Task InitializeAsync(IWorldContext context, CancellationToken ct = default)
{
    // 1. Parse Inspector GUIDs
    if (!Guid.TryParse(_npcContentId, out var contentId)) { /* warn, return */ }
    if (!Guid.TryParse(_starterCreatureBaseId, out var starterBaseId)) { /* warn, return */ }

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

### Public State

| Property | Type | Notes |
|----------|------|-------|
| `NpcId` | Guid | Set after init |
| `HasCreatureToGive` | bool | Set to false after creature is taken |
| `AccountId` | Guid | From world context |
| `TrainerId` | Guid | From world context |

## NpcInteractionBehaviour

### Requirements

`NpcInteractionBehaviour` requires `NpcWorldBehaviour` and `SphereCollider` on the same GameObject (enforced with `[RequireComponent]`).

### Inspector Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `_interactionRadius` | float | 3f | Trigger sphere radius in world units |

### Interaction Sequence

1. Player enters `SphereCollider` trigger → `OnTriggerEnter` fires
2. If `HasCreatureToGive` is true → show interaction prompt
3. Player presses **E** → `GiveCreatureAsync` is called
4. `POST /api/v1/npc/{npcId}/give-creature` → creature transferred to trainer storage
5. `HasCreatureToGive` set to false, prompt hidden

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

## Setting Up an NPC in the Scene

1. Create a GameObject (e.g. `NPC_Cindris`)
2. Add `NpcWorldBehaviour` component
3. Add `NpcInteractionBehaviour` component (SphereCollider is added automatically)
4. In the Inspector on `NpcWorldBehaviour`:
   - Set `_npcContentId` to the seed-data GUID for this NPC (must match `content_id` in the database)
   - Set `_starterCreatureBaseId` to the base creature UUID
5. Adjust `_interactionRadius` on `NpcInteractionBehaviour` as needed
6. Ensure the player's root GameObject has the tag `"Player"` (used by `OnTriggerEnter`)

## UI Prompt

`ShowPrompt(visible)` currently logs a debug message. Wire it to a world-space UI panel to display "Press E to receive creature" in-game.
