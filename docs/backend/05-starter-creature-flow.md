# Starter Creature Flow

This document describes the complete end-to-end flow from Unity world boot through the player receiving their first creature. Understanding this flow is valuable both for debugging problems in the field and for building analogous systems (e.g., quest-giver NPCs that hand out items using the same pattern).

## Why This Flow?

The starter creature flow encapsulates two important design decisions:

**Idempotency over session tracking.** Rather than requiring the Unity client to remember "has this player initialized this NPC?", the backend checks on every world load. If the NPC exists, it returns in microseconds. If it does not, it creates it. The Unity client never stores "initialized" flags or has to worry about corruption of that state across app restarts or crashes.

**Backend as source of truth for `HasCreatureToGive`.** The Unity client reads `HasCreatureToGive` from the `ensure-starter` response on every world load. This means even if the player force-quit the game immediately after receiving a creature (before the client could update its own state), the next world load will correctly show no creature available — because the backend's NPC team is already empty.

## Sequence Diagram

```
Unity (NpcWorldBehaviour)
  │
  │  1. WorldRegistry fires InitializeAsync for each IWorldInitializable
  │
  ▼
NpcWorldBehaviour.InitializeAsync(context)
  │
  │  2. POST /api/v1/npc/ensure-starter
  │     { accountId, trainerId, contentId, starterCreatureBaseId }
  │
  ▼
NpcController (REST)
  │
  │  3. NpcDomainService.EnsureStarterNpcAsync(...)
  │
  ▼
NpcDomainService
  ├─ GetNpcByContentIdAsync  →  NPC exists? → return existing
  │
  └─ (first time only)
      ├─ CreateNpcAsync  →  BEGIN TXN
      │    ├─ INSERT npc row
      │    ├─ INSERT inventory (6-slot team)
      │    └─ UPDATE npc with inventory_id → COMMIT
      │
      └─ ICreatureGenerationService.CreateAsync(
             BaseCreatureId = starterCreatureBaseId,
             Level = 1,
             Nature = Hardy,
             Gender = Unknown
         )
            │
            └─ INSERT generated_creature row
                  │
                  └─ AddCreatureToNpcTeamAsync(npcId, creatureId, slot=1)
  │
  │  4. Response: { npcId, hasCreatureToGive: true/false }
  │
  ▼
NpcWorldBehaviour
  │  stores NpcId, HasCreatureToGive = true
  │
  ▼
NpcInteractionBehaviour (player walks into trigger radius)
  │
  │  5. Player presses E
  │
  ▼
  POST /api/v1/npc/{npcId}/give-creature
  { accountId, trainerId }
  │
  ▼
NpcDomainService.GiveNpcCreatureToTrainerStorageAsync(...)
  ├─ GetNpcTeamAsync  →  find first creature (slot 1)
  ├─ RemoveCreatureFromNpcTeamAsync
  ├─ Get or create trainer storage inventory (InventoryType.Creature, 100 slots)
  ├─ Determine next slot (max existing slot + 1)
  ├─ AddCreatureToInventory(storageInventory.Id, creatureId, nextSlot)
  └─ UpdateCreature (CurrentTrainerId = trainerId)
  │
  │  6. Response: { creatureId, creatureName }
  │
  ▼
NpcInteractionBehaviour
  sets HasCreatureToGive = false, logs "You received Sparklefox!"
```

## Step-by-Step

### Step 1 — World Bootstrap

`GameInitializer` subscribes to `GameSessionManager.OnTrainerChanged` via Zenject injection. When a trainer is selected, `GameSessionManager` fires `OnTrainerChanged`, which calls `WorldRegistry.All` to get every `IWorldInitializable` in the current scene and calls `InitializeAsync` on each sequentially.

The `WorldRegistry` is a static dictionary populated by each `IWorldInitializable` MonoBehaviour in its `Awake` method. `GameInitializer` is itself bound with `NonLazy()` in the DI container so it exists and is subscribed before any `Start` or `Awake` in the scene runs. See [World Behaviours](?page=unity/03-world-behaviours) for the full initialization lifecycle.

The `IWorldContext` passed to each `InitializeAsync` carries:
- `AccountId` — the logged-in account
- `TrainerId` — the selected trainer
- `IsOnline` — whether the client has network connectivity

### Step 2 — EnsureStarterNpc

`NpcWorldBehaviour` reads `_npcContentId` and `_starterCreatureBaseId` from its Unity Inspector fields. Both must be valid GUIDs. It calls `INpcClient.EnsureStarterNpcAsync` which POST to `/api/v1/npc/ensure-starter`.

**What happens if the GUID is malformed?** `NpcWorldBehaviour.InitializeAsync` calls `Guid.TryParse`. On failure it logs a warning and returns early. The NPC is not initialized. `HasCreatureToGive` remains false. The player sees the NPC in the world but cannot interact with it. This is a silent failure — check the Unity Console for `[NpcWorldBehaviour] Warning: invalid GUID` messages.

**What if the backend is offline?** `SimpleWebClient` will throw `InternalServerErrorException` or a timeout. `InitializeAsync` does not catch this — the exception propagates up to `GameInitializer`'s foreach loop. Currently `GameInitializer` logs the error and continues to the next `IWorldInitializable`. The NPC will not be initialized but other world behaviours continue normally.

### Step 3 — Idempotent NPC Creation

`NpcDomainService.EnsureStarterNpcAsync` checks `GetNpcByContentIdAsync` first. This query is scoped to `(accountId, trainerId, contentId)` — the combination is effectively the unique key for this NPC in this trainer's world.

**First call (new trainer):**
- `GetNpcByContentIdAsync` returns `null`
- `CreateNpcAsync` runs a three-step transaction (see [NPC System](?page=backend/02-npc-system) for details)
- `ICreatureGenerationService.GetAvailableGrowthProfilesAsync` is called — at least one growth profile must exist
- `ICreatureGenerationService.CreateAsync` generates the starter at level 1 with `Nature.Hardy`
- The creature is placed in the NPC's team at slot 1

**Subsequent calls (returning trainer):**
- `GetNpcByContentIdAsync` returns the existing NPC
- Returns immediately — no creature generation, no team modification
- `HasCreatureToGive` reflects whether the NPC still has a creature in its team

### Step 4 — Store NPC State in Unity

`NpcWorldBehaviour` stores `NpcId` and `HasCreatureToGive` as public properties. These are read by `NpcInteractionBehaviour` to decide whether to show an interaction prompt.

`HasCreatureToGive` is not persisted in Unity's SQLite — it is fetched fresh from the backend on every world load. This ensures it is always accurate even if the player cleared it on a different device.

### Step 5 — Player Interaction

`NpcInteractionBehaviour` attaches a `SphereCollider` (trigger) with `_interactionRadius`. When the player's collider enters the trigger, `OnTriggerEnter` fires. The component checks `HasCreatureToGive` and whether the entering collider's root has the `"Player"` tag.

If both conditions are true, `ShowPrompt(true)` is called. Currently this logs to console — wire it to a world-space UI panel to show a visual prompt. When the player presses **E** while the prompt is active, `GiveCreatureAsync` is called.

**Concurrency edge case:** If two clients simultaneously press E on the same NPC (which should not be possible in the current single-player design, but could happen in a future multiplayer mode), both would call `give-creature`. The second call would receive `InvalidOperationException("NPC has no creatures to give")` from the backend and the exception would propagate to the client. The first client would succeed. Plan for this in the multiplayer architecture.

### Step 6 — Transfer Creature

`GiveNpcCreatureToTrainerStorageAsync` handles the transfer. Key details:

- It takes `team.First()` — always slot 1 in practice. If slot 1 is empty and the creature is in slot 3, this will still take the first creature returned by `GetNpcTeamAsync` which sorts by slot number.
- The trainer's storage inventory is created on-demand if it does not exist. This is a "lazy create" pattern — the inventory only comes into existence when the first creature is received.
- `CurrentTrainerId` on the `generated_creature` row is updated to `trainerId` after the transfer. `FirstCaughtByTrainerId` is not changed — it always reflects the original owner.
- `HasCreatureToGive` is set to `false` on the Unity side immediately after the call succeeds (without re-fetching from the backend). If the client crashes before this assignment, the next `ensure-starter` call will correctly return `hasCreatureToGive: false` because the NPC's team is already empty on the server.

## Key Files

| File | Role |
|------|------|
| `../cr-data/…/NpcWorldBehaviour.cs` | Calls EnsureStarterNpc on world init; stores NpcId + HasCreatureToGive |
| `../cr-data/…/NpcInteractionBehaviour.cs` | Trigger + E-press interaction; calls GiveCreatureAsync |
| `../cr-data/…/GameInitializer.cs` | Drives world init via WorldRegistry; handles trainer session changes |
| `../cr-api/Npcs/…/NpcDomainService.cs` | Backend orchestration for both ensure-starter and give-creature |
| `../cr-api/Npcs/…/Interface/INpcDomainService.cs` | Contract |
| `../cr-api/Game/…/CreatureGenerationService.cs` | Creates the starter creature |

## Failure Modes Reference

| Failure | Symptom | Root Cause |
|---------|---------|------------|
| NPC does not initialize | No interaction prompt ever appears | Malformed GUID in Inspector, backend unreachable, or no growth profiles in DB |
| `ensure-starter` returns 500 | NPC created but no creature in team | Base creature has no growth profiles |
| `give-creature` returns 500 | Player cannot receive creature | NPC team is empty (prior failure in creation) or storage inventory error |
| Creature appears in storage but not visible in UI | UI bug or stale cache | Trainer creature inventory cache not refreshed after transfer |
| `hasCreatureToGive` is wrong | Player interaction prompt shown/hidden incorrectly | Client and server out of sync — check `ensure-starter` response on last world load |

## Common Mistakes / Tips

- **Placing two `NpcWorldBehaviour` components with the same `_npcContentId` in the same scene.** Both will call `ensure-starter` with the same `contentId`. The second call returns the same NPC. Both `NpcInteractionBehaviour` components share the same `NpcId`. Pressing E on either will transfer the creature, but the first to call wins. Use unique `_npcContentId` values per NPC GameObject.
- **Not assigning the `"Player"` tag to the player's root GameObject.** `NpcInteractionBehaviour.OnTriggerEnter` checks for this tag. Without it, entering the sphere trigger does nothing.
- **Setting `_starterCreatureBaseId` to a non-existent UUID.** `GetAvailableGrowthProfilesAsync` returns empty and `EnsureStarterNpc` throws. The NPC row is not created. Fix: ensure the UUID matches a row in the `creature` table.
- **Interaction radius set to 0.** The `SphereCollider` trigger will never fire. Set `_interactionRadius` to at least 1–3 world units.

## Related Pages

- [NPC System](?page=backend/02-npc-system) — NpcDomainService internals, team management, data model
- [Creature Generation](?page=backend/04-creature-generation) — stat calculation, growth profiles, ability progression
- [World Behaviours](?page=unity/03-world-behaviours) — IWorldInitializable lifecycle, WorldRegistry, GameInitializer
- [NPC Interaction](?page=unity/04-npc-interaction) — Unity component details, Inspector setup, UI wiring
- [HTTP Clients](?page=unity/05-http-clients) — how INpcClient calls are made, error handling
