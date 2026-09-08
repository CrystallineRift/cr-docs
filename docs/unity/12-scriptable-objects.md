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

:::tip[`icon` / `iconKey` — four SOs, one rule]
`ItemDefinition`, `CreatureDefinition`, `AbilityConfig` and `StatusConditionConfig` each carry an
`AssetReferenceSprite? icon` plus a `string iconKey`, drawn by the shared `IconSlotField` inspector
row and synced to the matching `icon_asset_key` column.

`iconKey` is **derived from the sprite**, not typed: assigning through the inspector row registers the
sprite addressable at `icons/<type>/<key>` and writes the returned address into `iconKey`. Dropping a
GUID straight into the field leaves a reference that resolves and a key that does not — a silent
no-op.

`iconKey` is not `assetKey`. `assetKey` addresses the entity's *prefab*, and passing it to a sprite
loader can only ever return null. See [UI Icons](29-ui-icons.md).
:::

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
| `assetKey` | string | Addressables address for this species' **prefab** |
| `icon` | `AssetReferenceSprite?` | 2D portrait for team cards, storage slots, market rows and the battle HUD |
| `iconKey` | string | Address of that sprite — `icons/creatures/<contentKey>`. Syncs to `creature.icon_asset_key`. Written by `cr_bake_portraits`, not by hand |
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
| `evolutions` | `List<EvolutionRuleEntry>` | Evolution rules in priority order — target species and OR-groups of AND-requirements. Pushed on their own route after the creature; see [Evolution Authoring](./30-evolution-authoring.md) |

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
| `assetKey` | string | Addressables address for the item's **prefab** |
| `icon` | `AssetReferenceSprite?` | 2D icon shown in the bag, shop, market and battle bag |
| `iconKey` | string | Address of that sprite — `icons/items/<contentKey>`. Syncs to `item.icon_asset_key` |
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
**Backend sync:** Content Studio → Quests → **⬆ Push All** → `PUT /api/v1/quests/templates/bulk`. (The inspector's own "Sync to Backend" / "Sync All Quests" buttons were removed — see [One way to reach the server](08-content-registry.md#one-way-to-reach-the-server).)

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
| `icon` | `AssetReferenceSprite?` | 2D icon shown on the battle HUD's ability rows |
| `iconKey` | string | Address of that sprite — `icons/abilities/<abilityName>` (spaces kept; `AbilityConfig` has no `contentKey`). Syncs to `abilities.icon_asset_key` |
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
| `icon` | `AssetReferenceSprite?` | 2D icon shown in the battle HUD status badge and the Bag's target picker |
| `iconKey` | string | Address of that sprite — `icons/status/<conditionName>`. Syncs to `status_conditions.icon_asset_key` |
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
| `unlockQuestContentKey` | string | Content key of the quest that must be completed first. **Empty = no gate** — the ordinary "learn it at `level`" entry. A value makes the level necessary but not sufficient |

`unlockQuestContentKey` maps to `ability_progression_set_entry.unlock_quest_content_key` (M5019) and
to `AbilityProgressionSetEntry.UnlockQuestContentKey` in `CR.Game.Model`. Empty here is `NULL`
there. The inspector draws it as a dropdown of authored `QuestDefinition` content keys
(`ContentPicker.Quests()`), never free text — the server matches the key exactly, so a typo produces
an entry that reads as authored and can never unlock. See
[Creature Storage → Authoring a gate](26-creature-storage.md#authoring-a-gate-and-keeping-it-through-sync).

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

### BattleMissionDefinition

**Menu:** `CR/Content/Battle Mission`  
**Instances:** `Assets/CR/Content/Defs/BattleMissions/`  
**Backend sync:** Via Content Studio → Battle Missions → `PUT /api/v1/battle-missions/{id}`

One optional in-battle challenge — "burn the same target three times" — and the ability completing
it unlocks for the rest of the fight. Mirrors cr-api's `battle_mission_template` row exactly; the
push body is the server's own `BattleMissionTemplateUpsertRequest` out of `CR.Game.Data.dll`, not a
Unity mirror of it.

| Field | Type | Purpose |
|-------|------|---------|
| `id` | string (GUID) | Stable identifier — auto-generated in `OnValidate`; the route id on push, so it decides create vs update vs revive |
| `contentKey` | string | snake_case key, e.g. `mission_pyromaniac`. Identity on the server — renaming the mission does not rename this |
| `missionName` | string | What the player is offered in the team view and sees in the HUD |
| `description` | string | One line telling the player what to do |
| `missionType` | string | `StatusApplication`, `KnockOut` or `ElementalReaction` — dropdown built from `CR.Game.Data.Constants.BattleMissionTypes.All` |
| `conditionKey` | string | Condition name (`Burn`) or reaction name (`Conduction`). Hidden for `KnockOut`, which ignores it |
| `threshold` | int (≥1) | Qualifying events needed |
| `sameTarget` | bool | Per-target streak vs. any target |
| `rewardType` | string | `AbilityUnlock` today — from `BattleMissionRewardTypes.All` |
| `rewardAbility` | `AbilityConfig` | The unlocked move, authored as a reference rather than a pasted GUID |
| `rewardAbilityId` | string (GUID) | The wire value. Kept in step from `rewardAbility` in `OnValidate`, and kept on its own when the referenced ability has no local asset — otherwise a pull from a richer server would blank the reward on the next push |
| `isActive` | bool | Inactive missions stay on the server but are never offered |

Offline is the one thing pushing does not cover: the baked floor comes from migration seeds only,
so authored missions reach offline play through **⬇ Export Seed Migration** — see
[Battle Extensions](24-battle-extensions.md).

---

### ElementalReactionDefinition

**Menu:** `CR/Content/Elemental Reaction`  
**Instances:** `Assets/CR/Content/Defs/Reactions/`  
**Backend sync:** Via Content Studio → Reactions → `PUT /api/v1/elemental-reactions/{id}`

One elemental synergy: a condition already on the target (the *primer*) plus an incoming ability of
a particular element (the *detonator*) produce an outsized result — "the water conducts the charge".
Mirrors cr-api's `elemental_reaction` row (M12006); the push body is the server's own
`ElementalReactionUpsertRequest` out of `CR.Game.Data.dll`, not a Unity mirror of it.

Reactions were a hard-coded array in `CR.Game.Compat.Battle.ElementalReactionTable` until M12006.
That array survives only as the seed default and the resolver's fallback — edit the rows, not the
array.

| Field | Type | Purpose |
|-------|------|---------|
| `id` | string (GUID) | Stable identifier — auto-generated in `OnValidate`; the route id on push, so it decides create vs update vs revive |
| `contentKey` | string | snake_case key, e.g. `reaction_conduction`. Identity on the server — renaming the reaction does not rename this |
| `reactionName` | string | Display name (`Conduction`). Also what a `ElementalReaction` battle mission matches on |
| `primerCondition` | `StatusConditionConfig` | The condition that must already be on the target, authored as a reference rather than a typed name |
| `primerConditionName` | string | The wire value. Kept in step from the reference in `OnValidate`, and kept on its own when the condition has no local asset |
| `detonatorElement` | string | An `ElementType` name — dropdown, because a typo is a reaction that can never fire |
| `damageMultiplier` | double | Applied to the ability's damage. 1 leaves it alone; the server accepts 0–10 |
| `appliedCondition` | `StatusConditionConfig` | What the reaction leaves behind, or none when it only adds damage |
| `appliedConditionName` | string | The wire value, same rule as the primer |
| `logLine` | string | The battle-log line — the only thing telling the player what happened |
| `priority` | int | Evaluation order, ascending: a target carrying two primers detonates the lowest number |
| `isActive` | bool | Inactive reactions stay on the server but never fire |

Offline is the one thing pushing does not cover: the baked floor comes from migration seeds only, so
authored reactions reach offline play through **⬇ Export Seed Migration** — see
[Battle Extensions](24-battle-extensions.md).

---

### ElementalDamageMatrixConfig

**Menu:** `CR/Content/Elemental Damage Matrix`  
**Instances:** `Assets/CR/Content/Defs/ElementalDamage/` — one asset per version  
**Backend sync:** Via Content Studio → Elemental Damage → `PUT /api/v1/elemental-damage/versions/{version}`

One version of the type-matchup matrix: what every element does to every other element. Mirrors the
`elemental_damage` rows carrying that `version` string.

| Field | Type | Purpose |
|-------|------|---------|
| `version` | string | The version the rows are keyed on, e.g. `v1.1`. Must match `^v\d+(\.\d+)*$` |
| `isActive` | bool | Whether battles resolve against this version. Read-only in the inspector — it mirrors `battle_system_version`, and only **Set Active** moves it |
| `cells` | `ElementalDamageCellEntry[]` | Every ordered (offense, defense) pair — 100 of them. Edit through the grid, not the list |

`cells` is always completed to the full 100 before a push: cr-api refuses a partial matrix, because
a version missing a square resolves that matchup at 1.0 with nothing in the logs to say so, which is
indistinguishable from a designer having chosen 1.0. `ElementalDamageMatrixMapping.Complete` fills
gaps with the neutral 1.0 and fixes the row-major order the grid and the exported seed both use.

Offline follows the same rule as reactions: **⬇ Export Seed Migration** writes the selected version
(and, when it is the active one, the `battle_system_version` pointer) into cr-api.

---

## Client-Only SOs (No Backend Sync)

These SOs configure client presentation and are never sent to the server.

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

### BattleCameraProfile

**Menu:** `CR/Battle/Camera Profile`  
**Backend sync:** None

Feel/timing values for the cinematic battle camera (see [Battle System → Cinematic Camera](?page=unity/07-battle-system)). Lives on an asset so tweaks made while in Play mode persist. Per-shot **framing** is authored on the `vcam_*` children of the `BattleCameraRig` prefab, not here. Created automatically by `CR → Battle → Build Camera Rig Prefab`.

| Field | Type | Purpose |
|-------|------|---------|
| `blendSeconds` | float | Brain blend time between shots during battle (overrides the slow 2s default) |
| `orbitDegreesPerSecond` | float | Idle/establishing orbit speed |
| `introRadiusMultiplier` | float | Intro sweep starts this × the authored orbit radius, then eases in |
| `introHoldSeconds` | float | Intro sweep duration (also ends on the first turn) |
| `actionHoldSeconds` | float | Dwell on the attack shot so the push-in/impact read |
| `faintHoldSeconds` | float | Dwell on the low-angle faint shot |
| `shakeForceNormal` / `shakeForceHeavy` | float | Impulse force for a normal hit vs a heavy hit / faint |

---

### CreatureReactionProfile

**Menu:** `CR/Battle/Creature Reaction Profile`  
**Backend sync:** None — client-only.

A creature's in-battle **body language** (animation + its cry + feedback), authored once and **shared** across many creatures. A `CreatureDefinition` points at one via its `reactionProfile` field; the battle stager resolves it by content key, calls `Resolve()`, and hands the result to the `CreatureBattlePresenter` on the prefab (see [Battle System → CreatureBattlePresenter](./07-battle-system.md)). This covers the creature's **own body only**: a move's offensive VFX/SFX come from `AbilityConfig`, not here.

**Inheritance / overrides.** A profile has an optional **`baseProfile`**. Leave it empty for a standalone/base profile (author all beats). Set it to derive a variant — fill in only the beats you want to change; blank beats inherit from the base. Chain them for per-evolution flavor (base → evolved → shiny), or just duplicate an asset to fork it. `Resolve()` flattens the chain (most-derived beat wins) into the final `CreatureBattleReactions`. The inspector shows a **Resolved (source per beat)** readout — `local` / `inherited` / `—` — and a **Create Variant…** button that makes a child profile in one click.

The reactions themselves are a flat `CreatureBattleReactions` set of named `CreatureReaction` fields: `spawn`, `turnStart`, `attack`, `hit`, `heavyHit`, `faint`, `lowHp`, `criticalHp`, `statusApplied`, `captured`, `victory`, `defeat`, `levelUp`, `idle`. Within a resolved profile, blank beats fall back (`heavyHit`→`hit`, `criticalHp`→`lowHp`) or to a default Animator state for the core combat beats.

The inspector's **"Set Standard Defaults"** button pre-fills the standard Animator state-name convention (`Spawn`, `Hit`, `HeavyHit`, `Faint`, `Victory`, `Idle`, …) plus a little impact feedback onto any un-authored beat — non-destructively. (Use it on a **base** profile; on a derived one it would override the inherited beats.) See the convention table in [Battle System → Standard Animator state names](./07-battle-system.md). Names with no matching state in the controller are skipped safely, so you only build the states you want.

Each `CreatureReaction` field (all optional):

| Field | Type | Purpose |
|-------|------|---------|
| `animatorState` | string | Animator state to cross-fade into (empty = use the presenter's default for the beat) |
| `animatorTrigger` | string | If set, `SetTrigger(this)` instead of cross-fading a state |
| `crossfadeSeconds` | float | Cross-fade duration (ignored when using a trigger) |
| `sounds` | `AudioClip[]` | The creature's cry/grunt — one chosen at random, played at its position |
| `volume` / `pitchJitter` | float | One-shot volume; random ± pitch so repeats vary |
| `vfxPrefab` | `GameObject` | **Body-only** effect (faint puff, level-up sparkle) — *not* the move's VFX. Empty = none |
| `vfxAnchor` | string | Child transform name to spawn at (recursive search; empty = root) |
| `vfxParented` | bool | Parent the VFX to the creature so it follows movement |
| `vfxLifetime` | float | Auto-destroy the VFX after N seconds (0 = self-managed) |
| `scalePunch` / `scalePunchSeconds` | float | Scale-pop amount (e.g. 0.15 = 15%) and duration (0 = none) |
| `flashColor` / `flashSeconds` | Color / float | Brief color flash via `MaterialPropertyBlock` (alpha 0 = no flash) |
| `vibration` | `CreatureVibrationTier` | `None`/`Light`/`Medium`/`Strong` — re-raises the shared `BattleEvents` haptic event |

> Move VFX/SFX (the fireball, impact burst, cast whoosh) live on **`AbilityConfig`** (`useVfx`/`travelVfx`/`hitVfx`, `useSfx`/`hitSfx`/`missSfx`) and are played positionally by `BattleAbilityFxResponder` — see the [Battle System](./07-battle-system.md) page.

---

### Dialogue Database (`CR Dialog.asset`)

**Location:** `Assets/CR/CR Dialog.asset`  
**Backend sync:** None — plugin-native format

This is the Pixel Crushers Dialogue System's own `DialogueDatabase` ScriptableObject. It stores all actors, conversations, and dialogue entries in the plugin's format. `DialogueManager` loads it at runtime; all CR systems access it through `IDialogueHandler` (see [Dialogue System Integration](./11-dialogue-integration.md)).

This asset is authored in the Pixel Crushers **Dialogue Editor** window (`Tools → Pixel Crushers → Dialogue System → Dialogue Editor`), not the standard inspector.

**Important:** Every NPC actor in this database must have its `Name` field set to match the NPC's `content_key`.

---

## Summary: What Syncs to the Backend

Every row below pushes the same way: **Content Studio → the owning tab → ⬆ Push All** (or the global ⬆ Push All Content). Inspectors no longer carry their own sync buttons — see [One way to reach the server](08-content-registry.md#one-way-to-reach-the-server).

| SO | Sync mechanism | Endpoint |
|----|---------------|----------|
| `CreatureDefinition` | Content Studio tool | `/api/v1/creatures/base` |
| `NpcDefinition` | Content Studio tool | `/api/v1/npcs` |
| `ItemDefinition` | Content Studio tool | `/api/v1/items` |
| `SpawnerDefinition` | Content Studio tool | `/api/v1/spawners/sync-config` |
| `QuestDefinition` | Content Studio tool | `/api/v1/quests/templates/bulk` |
| `AbilityConfig` | Content Studio tool | `/api/v1/abilities` |
| `AbilityProgressionSetConfig` | Content Studio tool | `/api/v1/ability-progression-sets` |
| `GrowthProfileConfig` | Content Studio tool | `/api/v1/growth-profiles` |
| `BattleMissionDefinition` | Content Studio tool | `/api/v1/battle-missions/{id}` (offline copy via exported seed migration) |
| `ElementalReactionDefinition` | Content Studio tool | `/api/v1/elemental-reactions/{id}` (offline copy via exported seed migration) |
| `ElementalDamageMatrixConfig` | Content Studio tool | `/api/v1/elemental-damage/versions/{version}` (offline copy via exported seed migration) |
| `ContentDefinitionProvider` | — | Client-only registry |
| `BattleAnimationConfig` | — | Client-only |
| `CreatureAnimationProfile` | — | Client-only |
| `CreatureReactionProfile` | — | Client-only |
| `BattleCameraProfile` | — | Client-only |
| `CR Dialog.asset` (DialogueDatabase) | — | Client-only (Pixel Crushers) |
