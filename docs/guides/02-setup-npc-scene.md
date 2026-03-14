# Setting Up an NPC in a Scene

## Goal

By the end of this guide you will have a fully wired NPC GameObject in your scene. At Play mode, the NPC will resolve its database identity from the backend (or SQLite cache), and — depending on the sub-behaviours you attach — it will either grant the player a starter creature, engage in a trainer battle, or act as a merchant.

## Prerequisites

- The `Scene Context` with `LocalDevGameInstaller` is already in your scene. See [Configuring Scene DI](?page=guides/05-setup-di-scene-context).
- The world system is set up (`GameInitializer` will be created automatically by Zenject). See [Setting Up the World System](?page=guides/04-setup-world-system).
- You know the `content_key` for this NPC. It is the string defined in `game_config.yaml` (e.g. `npc_elder_cin`). See [NPC System](?page=backend/02-npc-system) for the backend side.
- The player's character has the `Player` tag and a `Collider` component so NPC interaction triggers fire correctly.

---

## NPC Types

There are three NPC sub-behaviours. Each changes what the NPC does when the player approaches:

| Sub-behaviour | What it does |
|---|---|
| `NpcCreatureGrantBehaviour` | One-time creature gift to the player (starter NPC) |
| `NpcTrainerBehaviour` | Trainer battle (NPC has a creature team and items) |
| `NpcMerchantBehaviour` | Stub merchant (marks NPC as a shop — full UI is a TODO) |

`NpcWorldBehaviour` is always required as the root identity resolver. `NpcInteractionBehaviour` provides the `OnTriggerEnter` / `Update` / E-key interaction and is required for any NPC the player can physically interact with.

---

## Step 1 — Create the NPC GameObject

1. In the Hierarchy, right-click the `NPCs` group (or the scene root) and choose **Create Empty**.
2. Rename it to the NPC's descriptive name (e.g. `ElderCin`).
3. In the Inspector, set the Position to where the NPC should stand in the world.

---

## Step 2 — Attach NpcWorldBehaviour

1. With `ElderCin` selected, click **Add Component** in the Inspector.
2. Search for `NpcWorldBehaviour` and add it.
3. Set the two `[SerializeField]` fields:

| Inspector Field | Value |
|---|---|
| **Npc Content Key** | The `content_key` string for this NPC, e.g. `npc_elder_cin` |
| **Npc Type** | Choose from the `NpcType` enum. Use `Npc` for dialogue/grant NPCs, `Trainer` for battle NPCs |

`NpcWorldBehaviour` calls `WorldRegistry.Register(this)` in `Awake()` automatically. It will be initialized by `GameInitializer` when a trainer is selected.

---

## Step 3 — Attach NpcInteractionBehaviour

`NpcInteractionBehaviour` requires `NpcWorldBehaviour` and `SphereCollider` on the same GameObject (`[RequireComponent]` enforces this).

1. Click **Add Component** and add `NpcInteractionBehaviour`.
2. Unity will automatically add a `SphereCollider` component alongside it.
3. Set the Inspector field:

| Inspector Field | Value |
|---|---|
| **Interaction Radius** | Default `3`. Increase for large NPCs, decrease for tight spaces. This sets the `SphereCollider.radius` at runtime. |

The `SphereCollider` will be set to `isTrigger = true` at runtime by the script — you do not need to check it in the Inspector.

---

## Step 4 — Attach a Sub-Behaviour

Choose one or more sub-behaviours based on what this NPC does.

### Starter / Creature Grant NPC

1. Add `NpcCreatureGrantBehaviour` to the same GameObject.
2. In the Inspector, expand **Slots** and click **+** to add a slot entry.
3. For each slot:

| Field | Value |
|---|---|
| **Creature Base Content Key** | A key in `game_config.yaml` whose value is the creature base UUID (e.g. `starter_creature_1_id`) |
| **Slot Number** | `0` for the first (and usually only) slot |

The script looks up the key in `IGameConfiguration` at runtime and resolves it to a creature base GUID.

### Trainer Battle NPC

1. Add `NpcTrainerBehaviour` to the same GameObject.
2. Configure in the Inspector:

| Inspector Field | Value |
|---|---|
| **Allow Rematch** | Check to allow repeated battles after the first (default: true) |
| **Slots** | List of creature slots — each has a **Creature Base Content Key** (from `game_config.yaml`) and a **Slot Number** (0–5) |
| **Items** | List of battle items — each has an **Item Id** (UUID string) and a **Quantity** |

### Merchant NPC

1. Add `NpcMerchantBehaviour` to the same GameObject.
2. No Inspector fields to configure. The merchant will log "Merchant ready (stub)" at init time. Full shop UI is not yet implemented.

---

## Step 5 — Final Hierarchy Check

A fully configured trainer-battle NPC should look like this in the Inspector component list:

```
ElderCin (GameObject)
├── Transform
├── NpcWorldBehaviour
│     Npc Content Key: "npc_elder_cin"
│     Npc Type: Trainer
├── NpcInteractionBehaviour
│     Interaction Radius: 3
├── SphereCollider
│     Is Trigger: (set at runtime)
│     Radius: (set at runtime)
└── NpcTrainerBehaviour
      Allow Rematch: ✓
      Slots:
        [0] creatureBaseContentKey: "trainer_kael_creature_1_id"  slotNumber: 0
      Items: (empty if none)
```

A starter-grant NPC:

```
ElderCin (GameObject)
├── Transform
├── NpcWorldBehaviour
│     Npc Content Key: "npc_elder_cin"
│     Npc Type: Npc
├── NpcInteractionBehaviour
│     Interaction Radius: 3
├── SphereCollider
└── NpcCreatureGrantBehaviour
      Slots:
        [0] creatureBaseContentKey: "starter_creature_1_id"  slotNumber: 0
```

---

## Verification — Play Mode

1. Enter Play mode.
2. Open the Console. Look for these log lines in order:

```
[NpcWorldBehaviour] 'ElderCin' InitializeAsync start. content_key='npc_elder_cin'
[NpcWorldBehaviour] 'ElderCin' — calling EnsureNpcAsync. accountId=... trainerId=... contentKey=npc_elder_cin
[NpcWorldBehaviour] 'ElderCin' — NPC identity ready. id=<guid> type=Trainer
[NpcTrainerBehaviour] 'ElderCin' InitializeAsync start npcId=<guid>
[NpcTrainerBehaviour] NPC <guid> has 1 creatures
[NpcWorldBehaviour] 'ElderCin' — fully initialized. id=<guid> type=Trainer
```

3. Move the player into the NPC's sphere radius. The Console should log `[NpcInteractionBehaviour] Interaction prompt visible=True`.
4. Press **E**. For a trainer NPC: `[BattleCoordinator] NPC battle started.` For a grant NPC: `[NpcInteractionBehaviour] You received <creature name>!`

---

## Common Mistakes

**"_npcContentKey is empty in Inspector. Skipping."**
You forgot to fill in the `Npc Content Key` field on `NpcWorldBehaviour`. The NPC will not initialize.

**"could not resolve config key '...' to a GUID. Slot skipped."**
The key you typed in a slot's `creatureBaseContentKey` does not exist in `game_config.yaml`, or its value is not a valid GUID. Check spelling in the YAML and make sure the backend has run migrations so the creature exists in the database.

**Player walks through the NPC but nothing triggers.**
The player GameObject is missing the `Player` tag. `NpcInteractionBehaviour.OnTriggerEnter` checks `CompareTag("Player")` and silently ignores anything else.

**NPC initializes but battle does not start.**
`NpcTrainerBehaviour.CanBattle` returns `false` if `CreatureTeam.Count == 0` (no creatures resolved for the NPC's slots) or if `_allowRematch` is false and the battle was already fought. Check the logs for slot-resolution warnings.

**WorldRegistry is empty after trainer select.**
`NpcWorldBehaviour.Awake()` was not called before `GameInitializer` collected initializables. Make sure `NpcWorldBehaviour` is in the scene at load time and not instantiated after scene start. See [Setting Up the World System](?page=guides/04-setup-world-system) for execution order notes.
