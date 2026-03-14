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
  │     { accountId, trainerId, contentKey, starterCreatureBaseId }
  │
  ▼
NpcController (REST)
  │
  │  3. NpcDomainService.EnsureStarterNpcAsync(...)
  │
  ▼
NpcDomainService
  ├─ GetNpcByContentKeyAsync  →  NPC exists? → return existing
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
  sets HasCreatureToGive = false, logs "You received Cindris!"
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

`NpcWorldBehaviour` reads `_npcContentKey` (a string such as `"cindris_starter_npc"`) and `_starterCreatureBaseId` from its Unity Inspector fields. `_npcContentKey` must be non-empty; `_starterCreatureBaseId` must be a valid GUID. It calls `INpcClient.EnsureStarterNpcAsync` which POSTs to `/api/v1/npc/ensure-starter`.

**What happens if the content key is empty?** `NpcWorldBehaviour.InitializeAsync` checks for null/whitespace. On failure it logs a warning and returns early. The NPC is not initialized. `HasCreatureToGive` remains false. The player sees the NPC in the world but cannot interact with it. This is a silent failure — check the Unity Console for `[NpcWorldBehaviour] Warning:` messages.

**What if the backend is offline?** `SimpleWebClient` will throw `InternalServerErrorException` or a timeout. `InitializeAsync` does not catch this — the exception propagates up to `GameInitializer`'s foreach loop. Currently `GameInitializer` logs the error and continues to the next `IWorldInitializable`. The NPC will not be initialized but other world behaviours continue normally.

### Step 3 — Idempotent NPC Creation

`NpcDomainService.EnsureStarterNpcAsync` checks `GetNpcByContentKeyAsync` first. This query is scoped to `(accountId, trainerId, contentKey)` — the database enforces a unique index on this combination, making it the effective key for this NPC in this trainer's world.

**First call (new trainer):**
- `GetNpcByContentKeyAsync` returns `null`
- `CreateNpcAsync` runs a three-step transaction (see [NPC System](?page=backend/02-npc-system) for details)
- `ICreatureGenerationService.GetAvailableGrowthProfilesAsync` is called — at least one growth profile must exist
- `ICreatureGenerationService.CreateAsync` generates the starter at level 1 with `Nature.Hardy`
- The creature is placed in the NPC's team at slot 1

**Subsequent calls (returning trainer):**
- `GetNpcByContentKeyAsync` returns the existing NPC
- Returns immediately — no creature generation, no team modification
- `HasCreatureToGive` reflects whether the NPC still has a creature in its team

### Step 4 — Store NPC State in Unity

`NpcWorldBehaviour` stores `NpcId` and `HasCreatureToGive` as public properties. These are read by `NpcInteractionBehaviour` to decide whether to show an interaction prompt.

`HasCreatureToGive` is not persisted in Unity's SQLite — it is fetched fresh from the backend on every world load. This ensures it is always accurate even if the player cleared it on a different device.

### Step 5 — Player Interaction

`NpcInteractionBehaviour` attaches a `SphereCollider` (trigger) with `_interactionRadius`. When the player's collider enters the trigger, `OnTriggerEnter` fires. The component checks `HasCreatureToGive` and whether the entering collider's root has the `"Player"` tag.

If both conditions are true, `ShowPrompt(true)` is called. When the player presses **E** while the prompt is active, `GiveCreatureAsync` is called.

**Concurrency edge case:** If two clients simultaneously press E on the same NPC (which should not be possible in the current single-player design, but could happen in a future multiplayer mode), both would call `give-creature`. The second call would receive `InvalidOperationException("NPC has no creatures to give.")` from the backend. The first client would succeed. Plan for this in the multiplayer architecture.

### Step 6 — Transfer Creature

`GiveNpcCreatureToTrainerStorageAsync` handles the transfer. Key details:

- It takes `team.First()` — always slot 1 in practice. If slot 1 is empty and the creature is in slot 3, this will still take the first creature returned by `GetNpcTeamAsync` which sorts by slot number.
- The trainer's storage inventory is created on-demand if it does not exist. This is a "lazy create" pattern — the inventory only comes into existence when the first creature is received.
- `CurrentTrainerId` on the `generated_creature` row is updated to `trainerId` after the transfer. `FirstCaughtByTrainerId` is not changed — it always reflects the original owner.
- `HasCreatureToGive` is set to `false` on the Unity side immediately after the call succeeds (without re-fetching from the backend). If the client crashes before this assignment, the next `ensure-starter` call will correctly return `hasCreatureToGive: false` because the NPC's team is already empty on the server.

## How to Test the Starter Flow Locally End-to-End

Run `cd Convenience/CR.REST.AIO && dotnet run` to start the server, then:

```bash
# 1. Register account
RESPONSE=$(curl -s -X POST http://localhost:5000/api/v1/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"test@cr.local","password":"testpass123"}')
TOKEN=$(echo $RESPONSE | jq -r '.accessToken')
ACCOUNT_ID=$(echo $RESPONSE | jq -r '.accountId')

# 2. Create a trainer
TRAINER_ID=$(curl -s -X POST http://localhost:5000/api/v1/trainers \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"name\":\"TestTrainer\",\"accountId\":\"$ACCOUNT_ID\"}" \
  | jq -r '.id')

# 3. Get a valid creature base ID (from the creature table seed data)
CREATURE_ID=$(curl -s http://localhost:5000/api/v1/creatures \
  -H "Authorization: Bearer $TOKEN" \
  | jq -r '.creatures[0].id')

# 4. Call ensure-starter
NPC_RESPONSE=$(curl -s -X POST http://localhost:5000/api/v1/npc/ensure-starter \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{
    \"accountId\":             \"$ACCOUNT_ID\",
    \"trainerId\":             \"$TRAINER_ID\",
    \"contentKey\":            \"test_starter_npc\",
    \"starterCreatureBaseId\": \"$CREATURE_ID\"
  }")
NPC_ID=$(echo $NPC_RESPONSE | jq -r '.npcId')
echo "hasCreatureToGive: $(echo $NPC_RESPONSE | jq -r '.hasCreatureToGive')"

# 5. Give the creature to the trainer
curl -s -X POST http://localhost:5000/api/v1/npc/$NPC_ID/give-creature \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"accountId\":\"$ACCOUNT_ID\",\"trainerId\":\"$TRAINER_ID\"}" \
  | jq .

# 6. Call ensure-starter again — hasCreatureToGive should be false
curl -s -X POST http://localhost:5000/api/v1/npc/ensure-starter \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{
    \"accountId\":             \"$ACCOUNT_ID\",
    \"trainerId\":             \"$TRAINER_ID\",
    \"contentKey\":            \"test_starter_npc\",
    \"starterCreatureBaseId\": \"$CREATURE_ID\"
  }" | jq .hasCreatureToGive
# → false
```

Prerequisites for this to work:
- `growth_profile` table must have at least one row (run growth profile seed migrations first)
- `creature` table must have at least one row (run creature seed migrations first)
- The connection string in `config.yml` must point to a running Postgres instance or valid SQLite file

## What to Do If Starter Selection Fails

### Error: `ensure-starter` returns 500

**Most likely cause:** `ICreatureGenerationService.GetAvailableGrowthProfilesAsync` returned empty. The `growth_profile` table has no rows. Fix: run all seed migrations in order, ensuring the growth profile seed runs before the creature seed.

**Second likely cause:** `starterCreatureBaseId` does not reference a row in the `creature` table. `GetCreature` throws `InvalidOperationException` which the middleware maps to 500. Fix: check the UUID against the `creature` table. Use `GET /api/v1/creatures` to list valid creature IDs.

**Error codes to watch:**

| HTTP Status | Meaning for `ensure-starter` |
|-------------|------------------------------|
| 400 | Bad request — malformed UUID, missing required field |
| 404 | Base creature ID not found in DB |
| 500 | Growth profiles empty, DB connection failure, or unexpected exception |

### Error: `give-creature` returns 500

The NPC's team is empty. This means either:
1. `ensure-starter` failed silently on the first call (check logs for the 500 that was swallowed)
2. The creature was already transferred (calling `give-creature` twice)

Check the NPC's team directly: `GET /api/v1/npc/{npcId}/team?accountId=...&trainerId=...`. If it returns an empty list, the creature has already been transferred or was never created.

### Retry Behavior

There is no automatic retry built into the server-side flow. The Unity client's `NpcWorldBehaviour.InitializeAsync` calls the backend once per world load. If the call fails, the next world load will retry. For the starter flow this is sufficient — the player simply re-enters the world (e.g., by returning to the title screen and selecting their trainer again).

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
| `ensure-starter` returns 500 | NPC created but no creature in team | Base creature has no growth profiles, or `starterCreatureBaseId` doesn't exist |
| `give-creature` returns 500 | Player cannot receive creature | NPC team is empty (prior failure in creation) or storage inventory error |
| Creature appears in storage but not visible in UI | UI bug or stale cache | Trainer creature inventory cache not refreshed after transfer |
| `hasCreatureToGive` is wrong | Player interaction prompt shown/hidden incorrectly | Client and server out of sync — check `ensure-starter` response on last world load |

## Common Mistakes / Tips

- **Placing two `NpcWorldBehaviour` components with the same `_npcContentKey` in the same scene.** Both will call `ensure-starter` with the same `contentKey`. The second call returns the same NPC. Both `NpcInteractionBehaviour` components share the same `NpcId`. Pressing E on either will transfer the creature, but the first to call wins. Use unique `_npcContentKey` values per NPC GameObject.
- **Not assigning the `"Player"` tag to the player's root GameObject.** `NpcInteractionBehaviour.OnTriggerEnter` checks for this tag. Without it, entering the sphere trigger does nothing.
- **Setting `_starterCreatureBaseId` to a non-existent UUID.** `GetAvailableGrowthProfilesAsync` returns empty and `EnsureStarterNpc` throws. The NPC row is not created. Fix: ensure the UUID matches a row in the `creature` table.
- **Interaction radius set to 0.** The `SphereCollider` trigger will never fire. Set `_interactionRadius` to at least 1–3 world units.
- **Trainer already has a starter (wrong assumption).** `ensure-starter` is idempotent. Calling it after the player already has a creature just returns the existing NPC with `hasCreatureToGive: false`. There is no error — the system handles this correctly without any client-side guard.
- **`starterCreatureBaseId` uses the generated creature's UUID instead of the base creature's UUID.** `starterCreatureBaseId` must reference the `creature` table (base species), not the `generated_creature` table. Base creature IDs are stable across deploys; generated creature IDs are per-trainer instances.
- **Content key casing mismatch.** `content_key` comparisons are case-sensitive in both Postgres and SQLite. `"Cindris_Starter_Npc"` and `"cindris_starter_npc"` are different keys. Be consistent — use lowercase_snake_case throughout.

## Related Pages

- [NPC System](?page=backend/02-npc-system) — NpcDomainService internals, team management, data model
- [Creature Generation](?page=backend/04-creature-generation) — stat calculation, growth profiles, ability progression
- [World Behaviours](?page=unity/03-world-behaviours) — IWorldInitializable lifecycle, WorldRegistry, GameInitializer
- [NPC Interaction](?page=unity/04-npc-interaction) — Unity component details, Inspector setup, UI wiring
- [HTTP Clients](?page=unity/05-http-clients) — how INpcClient calls are made, error handling
