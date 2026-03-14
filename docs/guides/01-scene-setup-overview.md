# Scene Setup Overview

## Goal

After reading this page you will understand the overall structure of a CR game scene: which root GameObjects exist, what purpose each serves, and how they relate to each other. Individual setup details are covered in the linked guides below.

## Prerequisites

- Unity 2022 LTS with the CR project open (`cr-data/My project/`)
- Zenject package installed (it is already included under `Assets/Plugins/Zenject/`)
- Familiarity with Unity's Hierarchy and Inspector windows

---

## The Root GameObject Inventory

The current `SampleScene` contains the following root-level GameObjects. Any new world scene should mirror this layout.

```
SampleScene
├── Main Camera          — standard Unity camera with URP camera component
├── Directional Light    — scene lighting
├── Global Volume        — URP post-processing volume
├── Database Manager     — UIDocument + GameDataManagerUI (dev-only data browser)
├── Scene Context        — Zenject DI root; holds LocalDevGameInstaller
└── GameObject           — placeholder / scratch object
```

When NPC, Spawner, or Trainer world objects are added they become additional root objects (or children of a grouping object you create). See the naming conventions below.

---

## The DI Root: Scene Context

`Scene Context` is the Zenject entry point for the scene. It carries:

- A `SceneContext` component (from Zenject) — sets `_autoRun: true` so the container builds automatically on scene load.
- A `LocalDevGameInstaller` component — the MonoInstaller that registers every repository, domain service, and world bootstrap object.

Do not add more than one `SceneContext` to a scene. All bindings for a scene go through one installer (or multiple installers listed in the SceneContext's `Mono Installers` list).

See [Configuring Scene DI](?page=guides/05-setup-di-scene-context) for the complete setup walkthrough.

---

## The World Bootstrap Chain

Two objects are created **at runtime by Zenject** (not placed manually in the Hierarchy), because they are bound with `FromNewComponentOnNewGameObject()`:

| Bound type | Created by | Purpose |
|---|---|---|
| `GameSessionManager` | Zenject at startup | Tracks current account/trainer; fires `OnTrainerChanged` |
| `GameInitializer` | Zenject at startup (NonLazy) | Listens for `OnTrainerChanged`; drives `WorldRegistry` init |
| `BattleCoordinator` | Zenject at startup | Manages battle lifecycle; implements `IBattleCoordinator` |

Because these are injected GameObjects, they appear in the Hierarchy at runtime under names like `GameInitializer`, `GameSessionManager`, and `BattleCoordinator` — but they are absent in the saved scene file.

See [Setting Up the World System](?page=guides/04-setup-world-system) for details on `GameInitializer` and `WorldRegistry`.

---

## World GameObjects (placed manually)

Any MonoBehaviour that needs to participate in the per-trainer initialization sequence must be placed in the scene and implement `IWorldInitializable`. These objects register themselves with `WorldRegistry` in `Awake()` and are initialized by `GameInitializer` when a trainer is selected.

Common world objects you will add:

| Script | Purpose |
|---|---|
| `NpcWorldBehaviour` | Resolves an NPC's database identity on trainer select |
| `SpawnerWorldBehaviour` | Ensures a wild creature spawner exists for the current trainer |
| `TrainerWorldBehaviour` | Loads the player trainer's visual assets |
| `QuestWorldBehaviour` | Loads active quests into `QuestManager` |

Group these under a parent for clarity:

```
SampleScene
├── Scene Context
├── Main Camera
├── Directional Light
├── Global Volume
├── NPCs
│   ├── ElderCin          (NpcWorldBehaviour + NpcInteractionBehaviour + SphereCollider)
│   └── MerchantNale      (NpcWorldBehaviour + NpcMerchantBehaviour + SphereCollider)
├── Spawners
│   └── GroveSpawner      (SpawnerWorldBehaviour + SpawnerEncounterBehaviour + SphereCollider)
└── Player
    └── Trainer           (TrainerWorldBehaviour + TrainerBehavior)
```

---

## Naming Conventions

- Use descriptive names for world objects: `ElderCin`, `GroveSpawner`, `PlayerTrainer`.
- Avoid generic names like `NPC1` — the name appears in log output and makes debugging harder.
- The `SceneContext` GameObject must be named exactly `Scene Context` (Zenject relies on the component, not the name, but consistency is the convention in this project).
- GameObjects created by Zenject at runtime receive the class name as their GameObject name automatically.

---

## Script Execution Order

Two CR scripts declare a custom execution order:

| Script | `[DefaultExecutionOrder]` | Reason |
|---|---|---|
| `TrainerWorldBehaviour` | -10 | Must `Register()` with `WorldRegistry` before `GameInitializer` (order 50) collects all initializables |
| `QuestWorldBehaviour` | -10 | Same reason |
| `GameInitializer` | 50 | Runs after all world behaviours have registered |

You do not need to configure Script Execution Order in Project Settings for these — the `[DefaultExecutionOrder]` attribute handles it. See [Setting Up the World System](?page=guides/04-setup-world-system) for more detail.

---

## Cross-Links

- [Setting Up an NPC in a Scene](?page=guides/02-setup-npc-scene)
- [Setting Up a Battle Scene](?page=guides/03-setup-battle-scene)
- [Setting Up the World System](?page=guides/04-setup-world-system)
- [Configuring Scene DI](?page=guides/05-setup-di-scene-context)
- [World Behaviours reference](?page=unity/03-world-behaviours)
- [Dependency Injection reference](?page=unity/02-dependency-injection)
