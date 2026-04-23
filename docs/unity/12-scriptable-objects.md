# Scriptable Objects

Crystalline Rift uses ScriptableObjects as the primary authoring surface for game content. Each SO type serves a specific role: some are the source of truth for backend data (synced to the server), some are purely client-side configuration, and one (`ContentDefinitionProvider`) acts as the central registry that wires everything together.

All SO instances live under `Assets/CR/Content/`. SO type definitions live in `Assets/CR/Core/Data/Registry/Definitions/`.

---

## Registry & Wiring

### ContentDefinitionProvider

**Menu:** `CR/Content/Content Definition Provider`  
**Instance:** `Assets/CR/Content/ContentDefinitionProvider.asset`  
**Backend sync:** None — client-only registry

The single asset that registers all content definitions with the runtime. Assigned to `LocalDevGameInstaller` in the inspector. `ScriptableObjectContentRegistry` reads it at startup to build lookup tables keyed by `content_key`.

| Field | Type | Purpose |
|-------|------|---------|
| `creatures` | `CreatureDefinition[]` | All creature species |
| `items` | `ItemDefinition[]` | All item types |
| `npcs` | `NpcDefinition[]` | All NPC templates |
| `spawners` | `SpawnerDefinition[]` | All spawner zones |

**Every new content SO must be added to this provider** or the runtime registry will not find it.

> **Note:** `QuestDefinition`, `AbilityConfig`, `AbilityProgressionSetConfig`, and `GrowthProfileConfig` are **not** in `ContentDefinitionProvider` — they are looked up directly via `AssetDatabase.FindAssets` in editor tooling, or referenced by GUID from other SOs.

---

## Content Definitions (Backend-Synced)

These SOs are the source of truth for backend data. Each has a `contentKey` that must match the `content_key` column in the corresponding backend database table.

### CreatureDefinition

**Menu:** `CR/Content/Creature Definition`  
**Instances:** `Assets/CR/Content/Defs/Creatures/`  
**Backend sync:** Via Content Studio tool → `/api/v1/creatures/base`

Defines a creature species. Base stats here feed directly into the backend's `base_creature` table.

| Field | Type | Purpose |
|-------|------|---------|
| `contentKey` | string | DB key (e.g. `"cindris"`) — must be unique |
| `displayNameKey` | string | Localization key (e.g. `"creature_cindris_name"`) |
| `element` | string | Elemental type matching backend enum (e.g. `"Fire"`, `"Radiant"`, `"Flora"`) |
| `assetKey` | string | Addressables address for this species' prefab/asset |
| `name` | string | Display name (synced from server, mirrors backend `name` column) |
| `description` | string | Lore text (synced from server) |
| `baseHitPoints` | int | Base HP stat |
| `baseAttack` | int | Base Attack stat |
| `baseSpecialAttack` | int | Base Special Attack stat |
| `baseDefense` | int | Base Defense stat |
| `baseSpecialDefense` | int | Base Special Defense stat |
| `baseSpeed` | int | Base Speed stat |
| `abilityProgressionSetId` | string | GUID of the `AbilityProgressionSetConfig` SO that drives this species' level-up moves. Empty = none |
| `growthProfileId` | string | GUID of the `GrowthProfileConfig` SO that governs stat scaling per level. Empty = none |

---

### NpcDefinition

**Menu:** `CR/Content/NPC Definition`  
**Instances:** `Assets/CR/Content/Defs/NPCs/`  
**Backend sync:** Via Content Studio tool → `/api/v1/npcs`

Defines an NPC template. The `contentKey` here is also the actor `Name` that must be set in the Pixel Crushers Dialogue System database for this NPC (see [Dialogue System Integration](./11-dialogue-integration.md)).

| Field | Type | Purpose |
|-------|------|---------|
| `contentKey` | string | DB key (e.g. `"npc_elder_rowan"`) — must match Dialogue System actor name |
| `displayNameKey` | string | Localization key (e.g. `"npc_elder_rowan_name"`) |
| `npcType` | string | Backend NpcType enum value (`"Npc"` or `"Trainer"`) |

---

### ItemDefinition

**Menu:** `CR/Content/Item Definition`  
**Instances:** `Assets/CR/Content/Defs/Items/`  
**Backend sync:** Via Content Studio tool → `/api/v1/items`

Defines an item type including its effect, usage rules, and held-item trigger.

| Field | Type | Purpose |
|-------|------|---------|
| `contentKey` | string | DB key (e.g. `"item_capture_crystal"`) |
| `displayNameKey` | string | Localization key |
| `assetKey` | string | Addressables address for item icon/prefab |
| `EffectType` | `ItemEffectType` | What this item does when used |
| `EffectParametersJson` | string | JSON matching the EffectType schema (e.g. `{"amount":50}` for RestoreHp) |
| `UsageFlags` | `ItemUsageFlags` | Bitmask — where/how the item can be used (in-battle, overworld, etc.) |
| `IsConsumable` | bool | Whether the item is removed from inventory on use |
| `TriggerType` | `HeldItemTriggerType` | Condition that activates the passive held-item effect |
| `TriggerParametersJson` | string | JSON parameters for the held-item trigger condition |

---

### SpawnerDefinition

**Menu:** `CR/Content/Spawner Definition`  
**Instances:** `Assets/CR/Content/Defs/Spawners/`  
**Backend sync:** Via Content Creator tool → `POST /api/v1/spawners/sync-config` (full hierarchy) or `PUT /api/v1/spawners/by-content-key/{contentKey}` (metadata only)

Defines a spawner zone: capacity, timing, and weighted pools of creature templates.

| Field | Type | Purpose |
|-------|------|---------|
| `contentKey` | string | DB key (e.g. `"starter-wild-zone"`) |
| `battleArenaKey` | string | Looks up the `BattleArena` used for encounters in this zone |
| `displayName` | string | Human-readable zone name (synced from server) |
| `description` | string | Zone description (synced from server) |
| `maxCapacity` | int | Max simultaneous wild creature spawns |
| `spawnCooldownSeconds` | int | Seconds between spawn cycles |
| `pools` | `List<SpawnerPoolConfig>` | Weighted pools — see below |

**SpawnerPoolConfig** (nested, serializable):

| Field | Type | Purpose |
|-------|------|---------|
| `poolName` | string | Internal label for logs/admin |
| `spawnWeight` | int (1–1000) | Relative weight when selecting among pools |
| `rarityMultiplier` | float (0.01–10) | Additional weight multiplier |
| `isActive` | bool | Whether this pool is eligible at runtime |
| `templates` | `List<SpawnerTemplateConfig>` | Creature entries in this pool |

**SpawnerTemplateConfig** (nested, serializable):

| Field | Type | Purpose |
|-------|------|---------|
| `creatureContentKey` | string | `content_key` of the BaseCreature species |
| `growthProfileName` | string | Name of the GrowthProfile for stat generation |
| `variantType` | string | `"normal"`, `"shiny"`, or `"shadow"` |
| `minLevel` / `maxLevel` | int (1–100) | Spawn level range |
| `spawnProbability` | float (0–1) | Relative probability within this pool |
| `minQuantity` / `maxQuantity` | int (1–10) | How many creatures spawn per event |
| `isActive` | bool | Whether this template is eligible at runtime |
| `abilityProgressionSet` | `AbilityProgressionSetConfig?` | Overrides the creature's default ability progression. Leave empty to use the species default |

---

### QuestDefinition

**Menu:** `CR/Quest Definition`  
**Instances:** `Assets/CR/Content/Quests/`  
**Backend sync:** Via inspector "Sync to Backend" / "Sync All Quests" button → `PUT /api/v1/quests/templates/bulk`

Defines a quest template. The backend owns instance/progress data; this SO is the designer's source of truth for quest structure and objectives.

| Field | Type | Purpose |
|-------|------|---------|
| `contentKey` | string | DB key (e.g. `"quest_intro_talk_to_oak"`) |
| `questName` | string | Player-facing quest title |
| `description` | string | Player-facing description |
| `giverNpcContentKey` | string | `content_key` of the NPC that offers this quest |
| `isRepeatable` | bool | Whether the quest can be completed more than once |
| `maxRepeatCount` | int | Max repeats (ignored when `isRepeatable` is false) |
| `sortOrder` | int | Display ordering in quest lists |
| `objectives` | `List<QuestObjectiveDefinition>` | Ordered objectives — see below |
| `rewards` | `List<QuestRewardDefinition>` | Rewards on completion |

**QuestObjectiveDefinition** (nested, serializable):

| Field | Type | Synced? | Purpose |
|-------|------|---------|---------|
| `objectiveType` | `QuestObjectiveType` | Yes | Type of gameplay action tracked |
| `description` | string | Yes | Player-facing objective text |
| `targetCount` | int | Yes | How many times the action must occur |
| `targetReferenceId` | string | Yes | UUID/content_key of the target entity (NPC, creature, item) |
| `isOptional` | bool | Yes | If true, quest can complete without this objective |
| `sortOrder` | int | Yes | Display ordering |
| `conversationTitle` | string | **No** | _(TalkToNpc only)_ Dialogue System conversation title — set via editor dropdown |
| `conversationId` | int | **No** | _(TalkToNpc only)_ Dialogue System conversation ID — auto-populated from title |

`conversationTitle` and `conversationId` are **game-client-only** and are never included in the backend sync payload.

**QuestObjectiveType values:** `DefeatCreature`, `DefeatAnyCreature`, `DealDamageOfType`, `DealDamage`, `HealAmount`, `WinBattles`, `CaptureCreature`, `CaptureAnyCreature`, `ReachCreatureLevel`, `VisitLocation`, `TalkToNpc`, `CollectItem`, `CompleteQuest`

**QuestRewardDefinition** (nested, serializable):

| Field | Type | Purpose |
|-------|------|---------|
| `rewardType` | `QuestRewardType` | Experience, Currency, Item, Creature, Ability, Badge, Title |
| `quantity` | int | Amount or count |
| `referenceId` | string | UUID of item/creature for Item/Creature rewards |
| `metadata` | string | Optional JSON metadata |

---

## Ability & Progression SOs (Backend-Synced)

These SOs are authored in the Content Studio tool and synced to the backend. They are referenced by GUID (not `content_key`) from other SOs.

### AbilityConfig

**Menu:** `CR/Content/Ability Config`  
**Instances:** `Assets/CR/Content/Abilities/`  
**Backend sync:** Via Content Studio → `/api/v1/abilities`

Defines a single battle ability. `id` is a stable GUID auto-generated on first create — never change it after syncing.

| Field | Type | Purpose |
|-------|------|---------|
| `id` | string (GUID) | Stable identifier — auto-generated, never change |
| `abilityName` | string | Display name |
| `description` | string | Flavour text |
| `elementType` | string | Element (e.g. `"Fire"`, `"Water"`, `"Normal"`) |
| `power` | int | Base damage output |
| `accuracy` | int | Hit chance (0–100) |
| `cost` | int | PP / energy cost |
| `priority` | int | Turn order modifier |
| `targetType` | string | `"Single"`, `"All"`, etc. |
| `category` | string | `"Physical"`, `"Special"`, or `"Status"` |
| `animationKey` | string | Key used to look up `BattleAnimationConfig` entry |
| `conditions` | `AbilityConditionEntry[]` | Status conditions this ability can inflict |

**Audio / VFX content keys** (Addressables addresses — each optional):

| Field | Type | Purpose |
|-------|------|---------|
| `useSfxKey` | string | SFX played when the ability is cast / used |
| `hitSfxKey` | string | SFX played at impact (on a landed hit) |
| `missSfxKey` | string | SFX played when the ability misses |
| `useVfxKey` | string | VFX prefab played on the caster (charge-up / cast effect) |
| `travelVfxKey` | string | Projectile VFX travelling from caster to target |
| `hitVfxKey` | string | VFX prefab played at the target on impact |
| `cameraCueKey` | string | Camera cue / shake / zoom identifier |

> **Migration note:** The previous UUID `assetId` field was dropped in cr-api migration `M1021ReplaceAssetIdsWithKeys` and replaced with the key columns above. Existing data is preserved as NULL keys — populate via Content Studio.

**AbilityConditionEntry** (nested):

| Field | Type | Purpose |
|-------|------|---------|
| `name` | string | Condition name (e.g. `"Burn"`, `"Paralysis"`) |
| `applyToUser` | bool | True = affects the user; false = affects the target |
| `probability` | int (0–100) | Chance the condition is applied |
| `durationTurns` | int | -1 = permanent; 0+ = number of turns |
| `statChanges` | `AbilityStatChangeEntry[]` | Stat modifications the condition applies |

---

### StatusConditionConfig

**Menu:** `CR/Content/Status Condition Config`  
**Instances:** `Assets/CR/Content/Defs/StatusConditions/`  
**Backend sync:** Via Content Studio → `/api/v1/status-conditions`

Standalone ScriptableObject form of a status condition. Used when a condition is shared across multiple abilities instead of inlined per-ability via `AbilityConditionEntry`.

| Field | Type | Purpose |
|-------|------|---------|
| `id` | string (GUID) | Stable identifier |
| `name` | string | Display name |
| `applyToUser` | bool | True = self-applied; false = target-applied |
| `probability` | int (0–100) | Chance the condition is applied |
| `durationTurns` | int? | Null = permanent |
| `statChanges` | `ConditionStatChangeEntry[]` | Stat modifications applied while active |
| `onHitVfxKey` | string | VFX on impact when the condition is inflicted |
| `onTriggerVfxKey` | string | VFX when the condition ticks each turn |
| `onRemovedVfxKey` | string | VFX when the condition is removed |
| `onApplySfxKey` | string | SFX when first applied |
| `onTickSfxKey` | string | SFX each tick |
| `onRemoveSfxKey` | string | SFX when removed |

> **Migration note:** `on_hit_effect_asset_id`, `on_trigger_effect_asset_id`, and `on_removed_effect_asset_id` UUID columns were dropped in cr-api `M1021ReplaceAssetIdsWithKeys` and replaced with the VFX/SFX key columns above.

---

### AbilityProgressionSetConfig

**Menu:** `CR/Content/Ability Progression Set Config`  
**Instances:** `Assets/CR/Content/ProgressionSets/`  
**Backend sync:** Via Content Studio → `/api/v1/ability-progression-sets`

Maps levels to ability unlocks for a creature species (or a spawner template override). Referenced by `id` (GUID) from `CreatureDefinition.abilityProgressionSetId` and `SpawnerTemplateConfig.abilityProgressionSet`.

| Field | Type | Purpose |
|-------|------|---------|
| `id` | string (GUID) | Stable identifier — auto-generated |
| `setName` | string | Human-readable label |
| `description` | string | Notes on what this set is for |
| `isActive` | bool | Whether this set is available for assignment |
| `entries` | `AbilityProgressionEntry[]` | Level → ability → slot mappings |

**AbilityProgressionEntry** (nested):

| Field | Type | Purpose |
|-------|------|---------|
| `level` | int | Level at which the ability is learned |
| `ability` | `AbilityConfig?` | Reference to the ability SO |
| `abilitySlot` | int (1–4) | Which move slot it occupies |

---

### GrowthProfileConfig

**Menu:** `CR/Content/Growth Profile Config`  
**Instances:** `Assets/CR/Content/GrowthProfiles/`  
**Backend sync:** Via Content Studio → `/api/v1/growth-profiles`

Controls XP rate and per-stat scaling multipliers for a creature. Referenced by `id` (GUID) from `CreatureDefinition.growthProfileId` and `SpawnerTemplateConfig.growthProfileName`.

| Field | Type | Purpose |
|-------|------|---------|
| `id` | string (GUID) | Stable identifier — auto-generated |
| `profileName` | string | Human-readable label (e.g. `"Balanced Growth"`) |
| `description` | string | Notes |
| `experienceGrowth` | float | XP gain multiplier — 100 = normal |
| `hitPointsGrowth` | int | HP scaling — 100 = base stat unchanged at level 1 |
| `attackGrowth` | int | Attack scaling |
| `defenseGrowth` | int | Defense scaling |
| `specialAttackGrowth` | int | Special Attack scaling |
| `specialDefenseGrowth` | int | Special Defense scaling |
| `speedGrowth` | int | Speed scaling |

---

## Client-Only SOs (No Backend Sync)

These SOs configure client presentation and are never sent to the server.

### SpawnerZoneConfig

**Menu:** `CR/Content/Spawner Zone Config`  
**Backend sync:** None — attaches to `SpawnerWorldBehaviour` on scene objects

A scene-level spawner config used by `SpawnerWorldBehaviour`. Overlaps with `SpawnerDefinition` but is structured for direct scene attachment rather than the central registry. Contains the same pool/template nested types as `SpawnerDefinition`.

---

### BattleAnimationConfig

**Menu:** `CR/Battle/Animation Config`  
**Backend sync:** None

Maps ability keys to animation clip names and VFX prefabs. One instance per project; looked up at battle start to drive the animator.

| Field | Type | Purpose |
|-------|------|---------|
| `entries` | `List<BattleAnimationEntry>` | Per-ability animation data |

**BattleAnimationEntry** (nested):

| Field | Type | Purpose |
|-------|------|---------|
| `abilityKey` | string | Must match `AbilityConfig.animationKey` (use `"default"` for the fallback entry) |
| `attackClipName` | string | Animator state name for the attack animation |
| `hitClipName` | string | Animator state name when hit |
| `faintClipName` | string | Animator state name when fainting |
| `projectilePrefab` | `GameObject` | Optional projectile spawned during attack |
| `impactVFXPrefab` | `GameObject` | Optional impact effect on hit |
| `attackClipOverride` | string | Overrides the creature's `defaultAttackClip` for this ability. Leave empty to use the creature's default |

---

### CreatureAnimationProfile

**Menu:** `CR/Battle/Creature Animation Profile`  
**Backend sync:** None

Defines the default animation clip names for a creature's Animator. Assigned per-creature on the battle prefab.

| Field | Type | Purpose |
|-------|------|---------|
| `defaultAttackClip` | string | Animator state for default attack (when ability has no `animationKey`) |
| `hitClip` | string | Animator state when hit |
| `faintClip` | string | Animator state when fainting |
| `idleClip` | string | Animator state for idle |

---

### Dialogue Database (`CR Dialog.asset`)

**Location:** `Assets/CR/CR Dialog.asset`  
**Backend sync:** None — plugin-native format

This is the Pixel Crushers Dialogue System's own `DialogueDatabase` ScriptableObject. It stores all actors, conversations, and dialogue entries in the plugin's format. `DialogueManager` loads it at runtime; all CR systems access it through `IDialogueHandler` (see [Dialogue System Integration](./11-dialogue-integration.md)).

This asset is authored in the Pixel Crushers **Dialogue Editor** window (`Tools → Pixel Crushers → Dialogue System → Dialogue Editor`), not the standard inspector.

**Important:** Every NPC actor in this database must have its `Name` field set to match the NPC's `content_key`.

---

## Summary: What Syncs to the Backend

| SO | Sync mechanism | Endpoint |
|----|---------------|----------|
| `CreatureDefinition` | Content Studio tool | `/api/v1/creatures/base` |
| `NpcDefinition` | Content Studio tool | `/api/v1/npcs` |
| `ItemDefinition` | Content Studio tool | `/api/v1/items` |
| `SpawnerDefinition` | Content Creator tool | `/api/v1/spawners/sync-config` |
| `QuestDefinition` | Inspector "Sync to Backend" button | `/api/v1/quests/templates/bulk` |
| `AbilityConfig` | Content Studio tool | `/api/v1/abilities` |
| `AbilityProgressionSetConfig` | Content Studio tool | `/api/v1/ability-progression-sets` |
| `GrowthProfileConfig` | Content Studio tool | `/api/v1/growth-profiles` |
| `ContentDefinitionProvider` | — | Client-only registry |
| `SpawnerZoneConfig` | — | Client-only scene config |
| `BattleAnimationConfig` | — | Client-only |
| `CreatureAnimationProfile` | — | Client-only |
| `CR Dialog.asset` (DialogueDatabase) | — | Client-only (Pixel Crushers) |
