# Changelog

Reverse-chronological log of significant additions to the codebase. Each entry links to the relevant documentation section.

---

## 2026-04-19

### Ability + condition asset content keys

Replaces the unused UUID `asset_id` foreign-key columns on abilities and status_conditions with a flat content-key model that mirrors the `creature.asset_key` pattern (M1016). Designers populate Addressables `AssetReference` slots in Unity SOs; the matching string keys are synced to the backend and round-trip through the battle outcome so the client can play the right sound/VFX without coupling the resolver to assets.

**Backend (cr-api)**
- `M1021ReplaceAssetIdsWithKeys` — drops `abilities.asset_id` and `status_conditions.{on_hit,on_trigger,on_removed}_effect_asset_id`. Adds `abilities.{use,hit,miss}_sfx_key`, `abilities.{use,travel,hit}_vfx_key`, `abilities.camera_cue_key`, `status_conditions.{on_hit,on_trigger,on_removed}_vfx_key`, `status_conditions.{on_apply,on_tick,on_remove}_sfx_key`.
- `BaseAbility`, `Ability`, `BaseStatusCondition`, `StatusCondition`, `ActiveBattleCondition` — model fields updated. `AssetId` and `OnHit/Trigger/RemovedEffectAssetId` properties removed.
- `ActionOutcome` — surfaces seven ability key fields directly (UseSfxKey, HitSfxKey, MissSfxKey, UseVfxKey, TravelVfxKey, HitVfxKey, CameraCueKey).
- `BattleResolver` + `BattleDomainService` — pass keys into `ActiveBattleCondition` and outcome payloads.
- `BaseAbilityRepository`, `AbilityEndpoints`, `Program.cs` status-condition endpoints, `M9990SeedGameData`, `CreaturesSchemaExtensions` — SQL + DTOs updated to round-trip new columns.

**Unity (cr-api-unity)**
- `AbilityConfig`, `StatusConditionConfig` — paired `AssetReferenceT<AudioClip>`/`AssetReferenceGameObject` + `string ___Key` fields. Editors render an "Audio / VFX" section with an `← from asset` button that auto-derives the Addressables address into the key field.
- `AbilityEditorSyncHelper` — `TryDeriveAddressableKey` helper, sync DTOs and PUT payloads include the new keys.
- `BattleEvents` — `SfxRequested(string)` and `VfxRequested(string)` events. Wired into `BattleEventsAdapter`.
- `BattleCoordinator` — fires `SfxRequested`/`VfxRequested` from outcome keys at cast-time and impact-time, and from `ActiveBattleCondition` keys on apply / trigger / removed.
- `StatusConditionListView` — UI search and editor form switched to the new key fields.
- → [Event Wiring](?page=unity/15-event-wiring) (audio/VFX request events added)

### Wiring system — editor, codegen, and juice events

Followups to the variable wiring system + a batch of cinematic / haptic events for battle UX.

**Unity (cr-api-unity)**
- `VariableWiringEditorWindow` — designer-facing editor at `CR → Wiring → Variable Wiring Editor` (mirrors event wiring editor shape).
- `VariableWiringDiscovery` — shared helper for value-type resolution + variable asset enumeration.
- `VariableWiringCodegen` — IL2CPP-safe bridge generator at `CR → Wiring → Generate Variable Bridge From Selected Manifest`. Output: `Assets/CR/Core/Wiring/Generated/GeneratedVariableWiringBridge.cs`.
- `BattleEvents` — added camera cues (`CameraCueIntro`, `CameraCueAttacker`, `CameraCueDefender`, `CameraCueFaint`, `CameraCueCapture`, `CameraCueVictory`), derived game-feel events (`HeavyHit`, `LowHpEntered`, `CriticalHpEntered`), and 0-arg vibration tiers (`VibrationLight/Medium/Strong`).
- `BattleCoordinator` — fires camera cues at lifecycle points + derives `HeavyHit` (>30% maxHp damage), `LowHpEntered`/`CriticalHpEntered` (downward 30%/10% threshold crossings, once per descent), and tier-appropriate vibration cues.
- `BattleEventsAdapter` — wires all juice events for SOAP routing.
- `BattleBagPanelHandler` — fires `CameraCueCapture` + strong vibration on capture success.
- → [Event Wiring](?page=unity/15-event-wiring) (camera cues / game-feel / vibration tables added)

### Wiring system — deferred items shipped

Followups to the Event Wiring system covering quest rewards, capture/exp/level events, and SOAP variable assignments.

**Unity (cr-api-unity)**
- `QuestRewardAdapter` — wraps `QuestRewardDispatcher.OnRewardsDispatched` (`Action<QuestInstance, IReadOnlyList<QuestRewardTemplate>>`) as a single-arg `Action<QuestRewardsDispatchedData>` for SOAP wiring.
- `QuestRewardsDispatchedData`, `ScriptableEventQuestRewardsDispatched` — payload + SO event type.
- `BattleEvents` — added `CaptureAttempted`, `CaptureFailed`, `ExpGained`, `LevelUp`. Wired into `BattleEventsAdapter`.
- `ExpGainedData`, `ScriptableEventExpGained` — payload + SO event type for exp gain (capture/levelup use existing `ScriptableEventString`).
- `BattleBagPanelHandler` — fires `CaptureAttempted` pre-roll, `CaptureFailed` on failed capture, `ExpGained`/`LevelUp` from item-use results.
- `VariableWiringEntry`, `VariableWiringManifest`, `VariableWiringExecutor`, `VariableWiringRunner`, `VariableWriteMode` — designer-driven mapping of C# events to SOAP `Bool`/`Int`/`Float`/`StringVariable` assignments. Replaces job #2 of legacy state bridges.
- `LocalDevGameInstaller` — binds `QuestRewardAdapter`, `VariableWiringRunner`, optional `VariableWiringManifest`.
- → [Event Wiring](?page=unity/15-event-wiring) (now also covers Variable Wiring + new event tables)

---

## 2026-04-15

### Items — domain service replaces Unity-local repository

Item use is now routed through the DLL `IItemUseDomainService` contract instead of the Unity-local `IItemUseRepository`. This aligns the Unity client with the backend contract and removes duplicated model types.

**Unity (cr-api-unity)**
- `IItemUseRepository`, `ItemUseModels`, `ItemUseOnlineRepository`, `ItemUseOnlineOfflineRepository` — **deleted**.
- `ItemHttpDomainAdapter` — new HTTP adapter implementing `IItemUseDomainService`. Posts to `POST /api/v1/trainers/{trainerId}/items/{itemId}/use`.
- `OnlineOfflineItemDomainService` — new router; delegates to the HTTP adapter (online) or `OfflineItemUseService` (offline) based on `IsPlayingOnline`.
- `OfflineItemUseService` — refactored to implement `IItemUseDomainService` directly (was `IItemUseRepository`).
- `BattleBagPanelHandler`, `BagScreenHandler` — inject `IItemUseDomainService` instead of `IItemUseRepository`.
- `LocalDevGameInstaller` — keyed bindings `"item_online"` / `"item_offline"` + unkeyed default router.
- → [Battle Bag UI](?page=unity/13-battle-bag-ui) · [Item System](?page=unity/10-item-system)

### Quest acceptance from dialogue

Dialogue scripts can now trigger quest acceptance by calling `AcceptQuest("template-uuid")` in a Pixel Crushers Dialogue System Script field. No code changes needed per quest.

**Unity (cr-api-unity)**
- `PixelCrushersDialogueHandler` — registers the `AcceptQuest` Lua function in `Start()` and unregisters in `OnDestroy()`. Raises `IDialogueHandler.OnQuestAcceptedFromDialogue`.
- `IDialogueHandler` — `event Action<string> OnQuestAcceptedFromDialogue` added.
- `QuestDialogueBridge` — subscribes to `OnQuestAcceptedFromDialogue` and calls `QuestManager.AcceptQuestAsync(guid)`.
- → [Dialogue Integration — Quest Acceptance](?page=unity/11-dialogue-integration#quest-acceptance-from-dialogue)

### Quest reward dispatcher

Quest rewards are now claimed and surfaced to the HUD automatically on quest completion.

**Unity (cr-api-unity)**
- `QuestRewardDispatcher` — bound `NonLazy`; subscribes to `QuestManager.OnQuestCompleted`, calls `ClaimRewardsAsync`, increments `StatKey.QuestsCompleted`, and fires `OnRewardsDispatched` for the HUD.
- → [Quest System](?page=unity/quest-system)

---

## 2026-04-17

### Quest creature reward — stale UUID bug fix

Fixes crash chain when claiming quest rewards that spawn creatures. Root causes: `INSERT OR REPLACE` caused UUID churn on content re-sync; seed UUIDs were uppercase, causing SQLite TEXT mismatch; fresh-DB race between `SyncCreaturesAsync` and `SpawnerDefinitionSyncBehaviour`; `QuerySingleAsync` threw instead of returning null.

**Backend (cr-api)**
- `BaseCreatureRepository.GetCreature` — `QuerySingleAsync` → `QuerySingleOrDefaultAsync`; return type `Task<BaseCreature?>`.
- `ICreatureRepository.GetCreature` — signature updated to `Task<BaseCreature?>`.
- `CreatureGenerationService.CreateFromSpawnerAsync` — added `ResolveBaseCreatureIdAsync` / `ResolveGrowthProfileIdAsync` with content-key/name fallback and self-heal (updates stale UUID on template for next call).
- `CreatureSpawnerTemplate` model — added `CreatureContentKey: string?` and `GrowthProfileName: string?`.
- Migration M1019 — normalises `creature.id` to lowercase in SQLite.
- Migration M1020 — normalises `growth_profile.id` to lowercase in SQLite.
- Migration M5014 — adds `creature_content_key` and `growth_profile_name` columns to `creature_spawner_template`.
- `BaseCreatureSpawnerTemplateRepository` — INSERT/UPDATE SQL includes new columns.
- → [Spawner System](?page=backend/03-spawner-system) · [Creature Generation — Stale-UUID Fallback](?page=backend/04-creature-generation#staleuuid-fallback)

**Unity (cr-api-unity)**
- `ServerContentSyncService.SyncCreaturesAsync` — `INSERT OR REPLACE` → `ON CONFLICT(content_key) DO UPDATE SET` (preserves `id`); `c.Id.ToLowerInvariant()`.
- `ServerContentSyncService.SyncGrowthProfilesAsync` — `ON CONFLICT(name) DO UPDATE SET`; `p.Id.ToLowerInvariant()`.
- `LocalSpawnerSyncClient` — stores `CreatureContentKey` and `GrowthProfileName` in spawner templates.
- `CreatureOnlineOfflineRepository` / `CreatureOnlineRepository` — `GetCreature` returns `Task<BaseCreature?>`.

---

## 2026-04-08

### Typed item effect parameters

Item effect parameters are now strongly-typed structs instead of raw JSON blobs, giving both the backend and Unity a clean, validated contract for every effect type.

**Backend (cr-api)**
- 14 typed param classes added under `CR.Game.Model.Items.EffectParameters` (e.g. `HealFlatParams`, `BoostStatPermParams`, `CureStatusParams`, `CaptureParams`, …).
- `EffectParameterSerializer` (Newtonsoft.Json, camelCase, null-safe) handles serialization for all handlers.
- `StatEnumConverter` maps legacy string aliases (`"HP"`, `"spa"`, `"spd"`) to the `Stat` enum for backwards compatibility with existing item data.
- 6 item-effect handlers and 2 evaluators refactored to use typed deserialization.
- `BattleResolver` held-item methods refactored; `ApplyHeldTypeBoost` now takes `ElementType?`.
- `GET /api/v1/ability/status_conditions` list endpoint added.
- 75 unit tests added covering the serializer, all 6 handlers, and both evaluators.
- → [Item System](?page=backend/06-item-system)

**Unity editor (cr-api-unity)**
- `ItemDefinitionEditor`: structured inspector fields per `EffectType` (enum dropdowns, sliders, condition picker) — replaces raw JSON `TextArea`. Existing SO assets auto-migrate on open.
- `OfflineItemUseService`: removes `TryResolveEffectType` hack; uses `item.EffectType` / `EffectParameters` from SQLite; fixes `CureStatus` singular/plural bug; switches to `EffectParameterSerializer` + `Stat` enum for `BoostStatPerm`.
- → [Item System](?page=unity/10-item-system)

---

## 2026-04-07

### Capture crystal — bag UI and item flag

`CaptureCrystal` (value `64`) added to the `ItemUsageFlags` enum in both backend and Unity, enabling the battle bag UI to identify and present capture items distinctly from consumables.

**Backend (cr-api)**
- `ItemUsageFlags.CaptureCrystal = 64` added.

**Unity editor (cr-api-unity)**
- `ItemUsageFlags.CaptureCrystal = 64` mirrored.
- `BattleBagPanel`: `IsCaptureCrystal()` and `GetCaptureLevelText()` helpers added.
- `PopulateItemList()` shows capture crystal tier info inline; `OnItemRowClicked()` displays tier and auto-selects the opponent as the target.
- USS styles added for capture crystal indicator rows.
- → [Capture Mechanic](?page=unity/14-capture-mechanic)

---

## 2026-04-01

### Data-driven content keys — ContentKeys.cs removed, Addressables catalog wired

The `ContentKeys.cs` constants file has been deleted. It was editor-only scaffolding that created the false impression that adding new content requires a code change and rebuild. The runtime has always been fully data-driven (server manifest → `ServerContentRegistry` → `GameAssetLoader`); the file was never consulted at runtime.

`AddressablesCatalogUpdater.UpdateAsync()` is now called at startup inside `ContentRegistryInitializer.FetchAndUpgradeAsync()` (behind the `CR_ADDRESSABLES` define). This means running game clients will download updated Addressables catalogs from the CDN before loading any assets — new content shipped to the CDN will land without a rebuild.

**cr-api-unity changes:**
- `Assets/CR/Core/Data/Registry/ContentKeys.cs` — **deleted**
- `ContentRegistryInitializer` — calls `AddressablesCatalogUpdater.UpdateAsync()` before fetching the server manifest
- `ContentStudioTool` — "Add to ContentKeys.cs" checkbox and `AddConstantToContentKeys()` method removed
- `ContentAuditTool` — "missing ContentKeys constant" warning category removed
- `CreatureDefinitionEditor`, `NpcDefinitionEditor`, `SpawnerDefinitionEditor`, `ItemDefinitionEditor` — ContentKeys help text and "Add to ContentKeys" button removed
- `DefinitionEditorExtensions` — `ExistsInContentKeys()` and `DrawContentKeyInfo()` helpers removed
- → [Content Registry](?page=unity/08-content-registry)
- → [Addressables Setup](?page=unity/09-addressables-setup)

---

### Growth profile assignment on creature species templates

`BaseCreature` (and `CreatureDefinition` in Unity) can now reference a `GrowthProfile` directly, so a species template carries its default stat-scaling curve rather than relying solely on spawner templates or manual generation calls.

**Backend (cr-api)**
- `BaseCreature` gains `GrowthProfileId Guid?` — FK to the `growth_profile` table.
- `M1018AddGrowthProfileIdToBaseCreature` — adds `growth_profile_id UUID NULL` to the `creature` table.
- `BaseCreatureRepository` — `growth_profile_id` included in all SELECT, INSERT, UPDATE, and upsert (ON CONFLICT) queries.
- → [Creature Generation — BaseCreature Model](?page=backend/04-creature-generation#basecreature-model)

**Unity editor (cr-api-unity)**
- `CreatureDefinition` SO gains a `growthProfileId` string field (same pattern as `abilityProgressionSetId` — paste the GUID from a `GrowthProfileConfig` SO).
- `ContentCreatorSyncHelper` — `ServerCreatureDto` carries `growthProfileId`; `FetchAllCreatures`, `ApplyToCreature`, `CreatureDiffersFromServer`, and `BuildCreatureJson` all handle the new field bidirectionally.
- `ContentStudioTool` diff view shows `growthProfileId` conflicts in the Creatures sync panel.
- → [Content Registry — CreatureDefinition Inspector Fields](?page=unity/08-content-registry#creaturedefinition-inspector-fields)

### UICoordinator — battle bag panel and overworld bag screen

- `BagScreenHandler` and `BattleBagPanelHandler` migrated to the `IContextAwareScreen` pattern; both hide on coordinator registration (no more Awake hacks).
- `BattleBagPanel.uxml` gets a **← Back** button that restores the battle action menu without closing the battle.
- `PlayerMenuWindow.EnableInput` / `DisableInput` narrowed to game-specific actions only — no longer disables Unity's shared UI action map, which was blocking all UIToolkit click events during battle.

### Battle fixes

- Wild team capped at 1 creature per encounter (was accumulating across encounters).
- `OfflineBattleService` now looks up `BaseCreature.BaseHitPoints` for max HP and `GivenName` for display name.
- Wild AI falls back to `GetAbilitiesPaginated(0,4)` when a creature has no progression set — AI now always takes a turn.
- Battle ends and logs when the player's creature faints.

---

## 2026-03-28

### Content deletion — server soft-delete from Content Studio

Unregistering a definition or resolving an "Only Server" sync row can now remove the backend record rather than always pulling it back.

**Backend (cr-api `feature/content-delete-endpoints`)**
- `DELETE /api/v1/creatures/by-content-key/{contentKey}` — soft-deletes the `BaseCreature` template. Guarded by `IGeneratedCreatureRepository.CountByBaseCreatureIdAsync`: if any trainer-owned `generated_creature` rows reference the species, returns 409 Conflict instead of deleting.
- `DELETE /api/v1/spawners/by-content-key/{contentKey}` — soft-deletes the global spawner template (no guard — spawner templates have no per-trainer rows).
- → [Creature Generation — API Endpoints](?page=backend/04-creature-generation#creature-list-and-upsert-endpoints)
- → [Spawner System — API Endpoints](?page=backend/03-spawner-system#content-creator-sync-bidirectional)

**Unity editor (cr-data `feature/content-delete-sync`)**
- `ContentCreatorSyncHelper` gains `DeleteCreature(contentKey)` and `DeleteSpawner(contentKey)` methods (blocking HTTP DELETE); `SendDelete` extracts JSON error bodies so server messages (e.g. the 409 creature guard) surface to the user.
- **Unregister flow** — after removing a Creature or Spawner definition from the provider, a dialog asks "Also delete from server?" with **Delete from server** / **Keep on server** options.
- **Sync "Only Server" rows** — Creature and Spawner rows now require explicit resolution. Each row shows **[Pull]** and **[Delete]** toggle buttons. Apply is blocked until every row has a choice. (NPCs, Abilities, Progression Sets, and Growth Profiles still auto-pull.)
- → [Content Registry — Removing Content from the Backend](?page=unity/08-content-registry#removing-content-from-the-backend)

---

## 2026-03-25

### BattleHUD ability selection menu
- **`BattleHUD`** gains a real ability sub-panel (up to 4 buttons). Pressing **Battle** now opens the ability picker rather than auto-submitting a default attack.
- `BattleEvents.PlayerTurnStarted` signature updated: carries `List<WildAbilityDto>` (name + power + id) instead of a bare `string[]`.
- `BattleStateResponse` gains a `playerAbilities` field populated by `OfflineBattleService` from the creature's progression set.
- `WildAbilityDto` gains a `name` field (shared by player and wild ability lists).
- → [Battle System — BattleHUD](?page=unity/07-battle-system#battlehud)

---

## 2026-03-24

### Wild Battle System — Phases 2–5 (Unity client)

**Arena system** (`CR.Game.Battle.Arena`)
- `BattleArena` MonoBehaviour: biome-specific environment GameObjects, trainer/creature spawn points, camera look target, `SetBiome()` / `Activate()` / `Deactivate()`.
- `BattleArenaRegistry` (`IWorldInitializable`): discovers all `BattleArena` in scene at init, keyed by `arenaKey`.
- `BattleCameraController`: lerps main camera to `cameraLookTarget` on `EnterBattle`, restores on `ExitBattle`.
- Editor tool: **CR > Battle > Create Placeholder Arena** scaffolds an arena GameObject with default biome structure.
- → [Battle System — Arena](?page=unity/07-battle-system#battle-arena)

**Offline battle stack** (`CR.Game.Battle.Offline`)
- `IBattleRepository` + `SqliteOfflineBattleRepository`: persists battle state to a local SQLite DB (crash-recovery; 4 tables: `battle`, `battle_round`, `battle_creature_state`, `battle_action_log`).
- `OfflineBattleService`: uses `BattleResolver` from `CR.Game.Compat` for in-memory resolution; calls `IGeneratedCreatureRepository` for HP write-back on battle end.
- `OfflineBattleClient`: implements `IBattleClient` for fully offline play.
- `OnlineOfflineBattleClient`: routes `IBattleClient` calls to HTTP or offline based on `IsPlayingOnline`.
- → [Battle System — Offline Stack](?page=unity/07-battle-system#offline-battle-stack)

**Turn loop and coordinator** (`CR.Game.Battle.BattleCoordinator`)
- Sequential turn loop driven by `TaskCompletionSource<string>`; player action awaited until `SubmitPlayerAction()` resolves it.
- `StartBattleAsync` response carries `activeTrainerId` + `roundKey`; avoids an extra `GetRoundKey` round-trip.
- Arena activation and camera transition wired into the wild battle start flow.
- `BattleEvents` static class: 8 events (`BattleStarted`, `PlayerTurnStarted`, `CreatureAttacking`, `CreatureHit`, `HpChanged`, `CreatureFainted`, `BattleEnded`, `RunAttempted`).
- → [Battle System — Turn Loop](?page=unity/07-battle-system#wild-battle-turn-loop)

**Wild AI client** (`CR.Game.Battle.AI`)
- `LocalWildBattleAIService`: offline heuristics — heal at <30% HP if item available, 20% chance for a status ability, else highest-power ability.
- → [Battle System — Wild AI](?page=unity/07-battle-system#local-wild-battle-ai)

**UI** (`CR.UI.Battle.BattleHUD`)
- HP bars, creature names, 4-line scrolling battle log.
- → [Battle System — BattleHUD](?page=unity/07-battle-system#battlehud)

**DI wiring** (`LocalDevGameInstaller`)
- Full offline battle stack bound: `SqliteOfflineBattleRepository`, `OfflineBattleService`, `OfflineBattleClient`, `BattleClientUnityHttp`, `OnlineOfflineBattleClient` as `IBattleClient`.
- `LocalWildBattleAIService`, `BattleArenaRegistry`, `BattleCameraController` bound.
- → [Battle System — DI](?page=unity/07-battle-system#installer-binding)

**SpawnerEncounterBehaviour**
- Random 2–5 s encounter delay with trigger-exit cancel.
- → [Battle System — Wild Creature Battle Flow](?page=unity/07-battle-system#wild-creature-battle-flow)

---

### Wild Battle System — ability animations and progression set (cr-api)

- `M9003`: `animation_key` (VARCHAR NULL) on `abilities` table — drives `BattleCoordinator.FireOutcomeEvents` clip selection.
- `M1017`: `ability_progression_set_id` (UUID NULL FK) on `creature` table — wild AI and offline `GetBattleStateAsync` use it to fetch the creature's learned abilities.
- `GetAbilitiesForProgressionSetAtLevelAsync` added to `IAbilityRepository`.
- `WildBattleAIDomainService` updated to use the creature's own progression set instead of a global ability query.
- `ActionOutcome.AbilityKey` now populated from `BaseAbility.AnimationKey`.
- → [Battle Persistence — Wild AI](?page=backend/09-battle-persistence#wild-trainer-ai)

---

## 2026-03-23

### Wild Battle System — core backend (cr-api)

**Shared engine (`CR.Game.Compat.Battle`)**
- `BattleResolver`: pure-static damage resolver (physical/special/status formula, accuracy roll, DOT conditions).
- `BattleActionParser`: JSON serialiser/deserialiser for `BattleAction[]`.
- `CreatureSnapshot` + `SingleActionResult` records.
- → [Battle Persistence — BattleResolver](?page=backend/09-battle-persistence#battleresolver)

**Sequential turn model**
- `M8006`: `active_trainer_id` on `battle_round` — replaces simultaneous-submit with single-actor-per-round.
- `IBattleDomainService.SubmitActionAsync` replaces `SubmitInputAsync`; resolves immediately and returns `ActionOutcome` with `NextActiveTrainerId` + `NextRoundKey`.
- Speed-based first-mover; ties go to trainer1 (player).
- → [Battle Persistence — Turn Model](?page=backend/09-battle-persistence#turn-model)

**Wild trainer + AI**
- Wild Trainer seeded with GUID `00000000-0000-0000-0000-000000000001`.
- `WildBattleAIDomainService` + `POST /api/v1/battle/{id}/wild-turn` endpoint.
- → [Battle Persistence — Wild AI](?page=backend/09-battle-persistence#wild-trainer-ai)

**Endpoints added**
- `POST /api/v1/battle/start` — returns `activeTrainerId` + `roundKey` in one call.
- `POST /api/v1/battle/{id}/submit` — resolves immediately, returns `ActionOutcome`.
- `POST /api/v1/battle/{id}/wild-turn` — AI picks + submits wild action server-side.
- `POST /api/v1/battle/{id}/run` — escape with speed-based formula.
- `GET /api/v1/battle/{id}/summary` — post-battle creature state summary.
- → [Battle Persistence — REST Endpoints](?page=backend/09-battle-persistence#rest-endpoints)

---

## 2026-03-17

### Content and asset refactor (cr-api)

- `asset_key` replaces `asset_id` on `creature` and `item` tables (M1016, M6003).
- `game_assets` table and `GET /api/v1/assets/manifest` endpoint.
- Merchant REST endpoints added.
- → [Asset Management](?page=backend/10-asset-management)

---

## 2026-03-10

### Battle persistence foundation (cr-api)

- `M8004`: 5 battle tables (`battle`, `battle_round`, `battle_round_input`, `battle_creature_state`, `battle_action_log`).
- `IBattleRepository`, `BattleDomainService`, initial REST endpoints.
- → [Battle Persistence](?page=backend/09-battle-persistence)

---

## Earlier

For history prior to 2026-03-10 see the [git log](https://github.com/CrystallineRift/cr-api/commits/main) and [cr-data commits](https://github.com/CrystallineRift/cr-data/commits/main).
