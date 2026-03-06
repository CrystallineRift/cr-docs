# Starter Creature Flow

## End-to-End Overview

This describes what happens when a player enters the world and an NPC offers them a starter creature.

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
      ├─ CreateNpcAsync  →  insert npc row + team inventory
      │
      └─ ICreatureGenerationService.CreateAsync(starterCreatureBaseId, level=5…)
            │
            └─ insert generated_creature row
                  │
                  └─ AddCreatureToNpcTeamAsync(npcId, creatureId, slot=1)
  │
  │  4. Response: { npcId, hasCreatureToGive: true }
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
  ├─ GetNpcTeamAsync  →  find first creature
  ├─ RemoveCreatureFromNpcTeamAsync
  └─ TrainerCreatureInventoryService.AddToStorageAsync(trainerId, creatureId)
  │
  │  6. Response: { creatureId, creatureName }
  │
  ▼
NpcInteractionBehaviour
  sets HasCreatureToGive = false, logs "You received Sparklefox!"
```

## Step-by-Step

### Step 1 — World bootstrap

`GameInitializer` subscribes to `GameSessionManager.OnTrainerChanged`. When a trainer is selected, it calls `WorldRegistry.All` to get every `IWorldInitializable` in the scene and calls `InitializeAsync` on each sequentially.

### Step 2 — EnsureStarterNpc

`NpcWorldBehaviour` reads `_npcContentId` and `_starterCreatureBaseId` from its Unity Inspector fields. Both must be valid GUIDs. It calls `INpcClient.EnsureStarterNpcAsync`.

### Step 3 — Idempotent NPC creation

`NpcDomainService` looks up the NPC by `contentId`. If it exists, it returns immediately with the existing `NpcId` and current `HasCreatureToGive` state. If it does not exist, it creates the NPC and generates the starter creature into the NPC's team.

### Step 4 — Store NPC state in Unity

`NpcWorldBehaviour` stores `NpcId` and `HasCreatureToGive`. These are read by `NpcInteractionBehaviour`.

### Step 5 — Player interaction

`NpcInteractionBehaviour` attaches a `SphereCollider` (trigger) with `_interactionRadius`. When the player enters the trigger and `HasCreatureToGive` is `true`, it shows an interaction prompt. Pressing **E** calls `GiveCreatureAsync`.

### Step 6 — Transfer creature

`GiveNpcCreatureToTrainerStorageAsync` moves the creature from the NPC's team into the trainer's storage. The NPC's `HasCreatureToGive` becomes `false` from that point on.

## Key Files

| File | Role |
|------|------|
| `../cr-data/…/NpcWorldBehaviour.cs` | Calls EnsureStarterNpc on world init |
| `../cr-data/…/NpcInteractionBehaviour.cs` | Trigger + E-press interaction |
| `../cr-data/…/GameInitializer.cs` | Drives world init via WorldRegistry |
| `../cr-api/Npcs/…/NpcDomainService.cs` | Backend orchestration |
| `../cr-api/Npcs/…/Interface/INpcDomainService.cs` | Contract |
