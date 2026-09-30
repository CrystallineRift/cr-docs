# Starter Creature Flow

This document describes the complete end-to-end flow from Unity world boot through the player receiving their first creature. Understanding this flow is valuable both for debugging problems in the field and for building analogous systems (e.g., quest-giver NPCs that hand out items using the same pattern).

:::caution `give-creature` is retired (410) — the starter NPC now hands over through `receive-gift`
Steps 5-6 below, the "How to Test" curl script's step 5, and the `give-creature returns 500`
section describe the pre-Phase-D flow against `POST /api/v1/npc/{npcId}/give-creature`. That route
is gone (Phase E, 410 `route_retired`). The starter NPC carries a `gift_template_id` like any other
gift-giver and `NpcInteractionBehaviour.GiveCreatureAsync` (the Unity method, same name, different
call) now calls `INpcGiftService.ReceiveGiftAsync` → `POST /api/v1/trainers/{trainerId}/npcs/{npcKey}
/receive-gift` instead — see the two Phase D/E notes on [NPC System](02-npc-system.md#rest-endpoints).
`ensure-starter` itself is unaffected and still used to seed the NPC and read `hasCreatureToGive`.
The narrative below is kept for the underlying idempotency/ledger design, which `receive-gift` still
follows, but treat every `give-creature` call in it as historical. `NpcDomainService
.GiveNpcCreatureToTrainerStorageAsync` itself (steps 5-6 below) was deleted outright (M2 close, L7):
its only caller was the already-410'd Unity give-creature client, deleted in an earlier pass, so the
method had been unreachable dead code with only its own unit tests exercising it — see
[NPC System](02-npc-system.md#step-5--player-receives-the-creature) for the still-live
`receive-gift` equivalent.
:::

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
  ├─ (server-authority A2.4, when INpcGiftLedger is wired — it is, in Program.cs)
  │    the gift ledger claims WHICH creature this trainer gets from this NPC, once,
  │    before anything is moved — see "The gift ledger" below
  ├─ GetNpcTeamAsync  →  is the claimed creature still on the team? (the completion signal)
  ├─ (1) UpdateCreature (CurrentTrainerId = trainerId), if not already
  ├─ (2) Get-or-create trainer storage inventory, file the creature there if not already filed
  └─ (3) RemoveCreatureFromNpcTeamAsync, if still on the team
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

**Concurrency edge case:** If two clients simultaneously press E on the same NPC (which should not be possible in the current single-player design, but could happen in a future multiplayer mode), both call `give-creature`. With the gift ledger wired (below), the loser of the claim race gets the winner's own claimed creature id and proceeds — both calls converge on the same one creature, transferred exactly once (the second call's writes are all idempotent no-ops). Without a ledger (legacy wiring), the second call raced `GetNpcTeamAsync`/`RemoveCreatureFromNpcTeamAsync` directly and could throw `InvalidOperationException("NPC has no creatures to give.")`.

### Step 6 — Transfer Creature

`GiveNpcCreatureToTrainerStorageAsync` handles the transfer. Key details:

- Without a gift ledger it still takes `team.First()` — always slot 1 in practice, sorted by slot number.
- The trainer's storage inventory is created on-demand if it does not exist. This is a "lazy create" pattern — the inventory only comes into existence when the first creature is received.
- `CurrentTrainerId` on the `generated_creature` row is updated to `trainerId` after the transfer. `FirstCaughtByTrainerId` is not changed — it always reflects the original owner.
- `HasCreatureToGive` is set to `false` on the Unity side immediately after the call succeeds (without re-fetching from the backend). If the client crashes before this assignment, the next `ensure-starter` call will correctly return `hasCreatureToGive: false` because the NPC's team is already empty on the server.

#### The gift ledger (server-authority A2.4)

`INpcGiftLedger` (optional ctor param on `NpcDomainService`; Program.cs wires it to
`NpcGiftGrantRepository`) makes a species-only, client-named gift **at most one creature per
(trainer, NPC)**, and makes the transfer itself **resumable** across a partial failure:

1. **Claim.** `GetClaimedCreatureIdAsync` — if this (trainer, NPC) already has a claim (a prior call,
   possibly one that failed partway through), that exact creature id is reused; a retry never
   re-derives a different one from the NPC's current team, which an earlier partial failure may
   already have changed. Otherwise `TryRecordGiftAsync` claims the team's first creature; a race loss
   here means a concurrent call already claimed one, so `GetClaimedCreatureIdAsync` is re-read for the
   winner's id.
2. **Gate.** Only a registered **gift-giver** NPC gives at all — `GiftGiverTypeAsync` (via
   `INpcContentRegistryReader` server-side, so an unregistered/invented content key gives nothing; the
   NPC row's own `NpcType` offline, where the registry isn't synced) must resolve to neither `Trainer`
   nor `Merchant`. A giver with no unspent claim, or the wrong type, throws
   `NpcGiftNotAllowedException`; a claim that's already been fully transferred (the creature is no
   longer on the NPC's team) throws `NpcGiftAlreadyReceivedException`.
3. **Completion signal.** Whether the claimed creature is *still on the NPC's team* decides whether
   this call has anything left to do. While it's still there, the three transfer steps (ownership →
   filed in storage → removed from the NPC team) each individually check their own already-done state
   before writing, so re-running all three from any partial state is safe. Step 2 (filing in storage)
   additionally catches the trainer's own partial UNIQUE index violation on a live `creature_id` as
   "already filed" rather than an error — a concurrent completion can win that specific race.
4. **Unrecoverable claim.** If the claimed creature id no longer exists as a `generated_creature` row
   at all (not "already given" — actually gone), the claim is released (`ReleaseGiftAsync`, logged and
   swallowed on its own failure) so a future call isn't permanently stuck claiming a dead id, and the
   original failure is rethrown.

Team-slot generation (`EnsureNpcCreatureTeamAsync`) gets a parallel rule (server-authority A2.5): a
slot naming a `SpawnerTemplateId` must belong to that NPC's own `"{contentKey}-team"` spawner
(resolved via `ISpawnerRepository`/`ICreatureSpawnerTemplateRepository`, both optional — without them
any template id is accepted) — a mismatched template is skipped with a warning, not an error, and a
species-only (client-named) slot goes through the same gift-giver-type-and-unspent-claim check as
above, limited to **one** species-only slot per call. All of this is opt-in: every new dependency is
an optional constructor parameter, so wiring that predates A2.4/A2.5 (or offline, where some of these
repositories aren't registered) keeps the old unchecked behaviour.

## Trainer Creation Owns the Inventories

`POST /trainer` resolves `ITrainerDomainService` and calls `CreateTrainerAsync`, which creates the
trainer **plus its five inventories** (6-slot team, 100-slot creature storage, 20-slot backpack,
100-slot item storage) in a single transaction and stamps their ids onto the trainer row. It must
never call the bare `ITrainerRepository.CreateTrainer` — that inserts only the trainer row, leaves
every inventory id column NULL, and the first creature grant (e.g. the welcome quest's reward)
throws `InvalidOperationException("Trainer ... has no team inventory configured")` inside
`CreatureInventoryService.GetTeamInventoryIdAsync`. Pinned by
`CR.Api.IntegrationTests.TrainerCreationHttpTests` (real HTTP: account → token → create → assert
all inventory ids non-null).

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
