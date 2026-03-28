# Changelog

Reverse-chronological log of significant additions to the codebase. Each entry links to the relevant documentation section.

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

### Wild Battle System — Phase 1 backend additions (cr-api)

- `M9003`: `animation_key` (VARCHAR NULL) on `abilities` table — drives `BattleCoordinator.FireOutcomeEvents` clip selection.
- `M1017`: `ability_progression_set_id` (UUID NULL FK) on `creature` table — wild AI and offline `GetBattleStateAsync` use it to fetch the creature's learned abilities.
- `GetAbilitiesForProgressionSetAtLevelAsync` added to `IAbilityRepository`.
- `WildBattleAIDomainService` updated to use the creature's own progression set instead of a global ability query.
- `ActionOutcome.AbilityKey` now populated from `BaseAbility.AnimationKey`.
- → [Battle Persistence — Wild AI](?page=backend/09-battle-persistence#wild-trainer-ai)

---

## 2026-03-23

### Wild Battle System — Phase 0 + Phase 1 (cr-api)

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
