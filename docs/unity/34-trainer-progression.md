# Trainer Progression in Unity

## Runtime

- **Bindings** (`LocalDevGameInstaller`): Talents content repos over the GameData floor; `ITrainerProgressionService` → `TrainerProgressionService` (DLL) and `ITrainerModifierProvider` → `TalentModifierProvider` (Phase 2, real — `NoTalentModifierProvider` is deleted; see [Talents UI](?page=unity/36-talents-ui)). Every consumer takes the service as an optional constructor parameter, so these bindings switch XP on offline. `ICaptureAttemptService` → `CaptureAttemptService`: offline capture runs the same DLL `ItemUseDomainService` the server runs.
- **Online**: the server grants XP; the client never calls the funnel. Offline: the DLL services grant it on local SQLite.
- **Reporting**: `IProgressionNotifier.ReportTrainerProgress(result.TrainerProgress)` from `QuestManager` (claim, progress), `OnlineOfflineBattleDomainService`, `OnlineOfflineItemDomainService`, `PickupBehaviour`. It invalidates `CacheScope.TrainerProgress` for that trainer and raises `TrainerProgressed`; `TrainerLevelUpToastAdapter` shows **"Trainer level N (+K talent point(s))"** (`ToastKind.LevelUp`, heading "Level Up!") — `K` is the levels gained, singular/plural on `K`, and the points clause is left out at the level cap. The wire `TrainerProgress` this reads from now also carries `SpentPoints`, `AvailablePoints`, `NeedsRespec`, `Allocations`, `Modifiers` and `QuestLockedTalentIds` — see [Talents](?page=backend/25-talents).
- **Reading**: `ITrainerProgressReader` (`TrainerProgressReader`) — the server's `GET …/progression` memoised online (invalidated by BattleClosed, QuestClaimed, QuestProgressRecorded, PickupCollected, CreatureCaptured and every report), the DLL service offline. `PlayerTeamView` shows the derived level and an XP bar (`TrainerXpBar`: "EXP 45/180 to Lv. 3" / "MAX LEVEL").
- **Level requirements** in dialogue (`progress.requirement` kind `TrainerLevel`) derive from `trainer_xp` through the DLL `ConditionEvaluator`.

## Location discoveries (`Assets/CR/Progression/Discovery/`)

Entering a location is an intent, resolved the same way online and offline (see
[Location Discoveries](?page=backend/24-location-discoveries)):

- **`ILocationEntryClient`/`LocationEntryClientUnityHttp`** — online transport: `POST` the BFF's
  `.../world-locations/enter`, `GET .../world-locations` for the discovery list. Its own private request
  DTO, since the server's `EnterWorldLocationRequest` lives in a BFF-only project.
- **`ILocationEntryRouter`/`LocationEntryOnlineOfflineRouter`** — the online/offline seam. Online: calls the
  client, applies a granted quest instance (`ApplyUpdatedInstance` + `OnQuestAccepted`), and invalidates
  `CacheScope.LocationDiscoveries` unless the status is `UnknownLocation`. Offline: calls the DLL
  `ILocationEntryService` over local SQLite. Both paths call `IDiscoveredLocationRegistry.Record` only on a
  fresh `Discovered` status — a revisit never re-records or re-invalidates.
- **`IDiscoveredLocationRegistry`/`DiscoveredLocationRegistry`** — memoises the trainer's discoveries
  (`IPlayerStateCache`, `CacheScope.LocationDiscoveries`, keyed off `IGameSessionService.CurrentTrainerId`)
  and raises a guarded, multi-subscriber `Discovered` event (a throwing subscriber never stops the others).
  `WorldMapDiscoveryReader` reads the **same** cache key, so one fetch answers both the map and the
  discovery toast.
- **`QuestManager.OnLocationVisited`** sends the enter intent through `ILocationEntryRouter` (after the same
  session-admission wait `RecordProgress` uses); `GrantedQuest != null` applies the instance and toasts
  before `ApplyServerProgress(result.Progress)` runs unconditionally — replacing the old
  `RecordProgress(VisitLocation, ...)` call with no double count.
- **`ToastKind.Discovery`/`DiscoveryToastAdapter`** shows "Discovered: {name}" off the registry's
  `Discovered` event, same shape as `AchievementUnlockToastAdapter`.
- `GameChange.LocationEntered` invalidates `ActiveQuests, TrainerProgress, Stats, LocationDiscoveries,
  AchievementBoard`.
- **Discovery XP / discovery quest authoring** — each catalog row's drawer (`WorldLocationEntryDrawer`, both
  the catalog inspector and the Studio World Locations tab) has a "Use rule default" XP toggle and a
  quest picker (`ContentPicker.Quests()`); `TrainerProgressionEditorSyncHelper.PushLocations` carries both
  fields, and "⬇ Pull tuning from server" / `cr_world_locations_pull` copies name/XP/quest key back from the
  server into the catalog (never adds or removes rows). See the `cr-world-locations` skill's "Discovery XP
  override and discovery quest" section, and [Location Discoveries — Admin /
  authoring](?page=backend/24-location-discoveries#admin-authoring).
- **World map** — `WorldMapDiscoveryReader` (real, replacing the P1 `EmptyWorldMapDiscoveryReader` stand-in)
  answers both `IWorldMapDiscoveryReader` and the discovery registry from one memoised read; see
  [World Map](35-world-map.md).

## Authoring (Crystalline Rift Studio → WORLD → World Locations, then Trainer Progression)

1. Place a `LocationTriggerBehaviour` in an area scene and set `_locationContentKey`.
2. **Scan areas** (`cr_world_locations_scan`) — merges every area's trigger keys into `Assets/CR/Content/Defs/Progression/WorldLocations.asset`. Entries no scene holds are kept and reported; delete the row to retire one. A key in two scenes keeps its first area and is reported; a key held by two catalog rows keeps the first row, and the dropped row is reported by key and id in the Studio status line / CLI result.
3. **Push locations** (`cr_world_locations_push`) — PUT the whole catalog with replace; reports id divergence. Steps 2–3 and **⬇ Pull tuning from server** live on the **World Locations** tab (WORLD group, between Pickup Placements and Trainer Progression); the catalog is also a content tab, so the header work pill, the Review window and Push All count an unpushed catalog edit like any other definition (Push All sends it whole, with the same drift line). Steps 4–5, the talent trees and the world map row stay on **Trainer Progression**, which links to World Locations.
4. **Export floor seed** (`cr_talent_content_export_seed`) — writes the Talents seed migration into cr-api (curve + rules read from the server). `cr_talent_content_seed_status` says current/stale. The first export, `M15040SeedTalentContent_20261009` (8 locations, from production), is pending merge on cr-api `content/talent-seed-2026-10-09`; see [Trainer Progression (backend)](?page=backend/22-trainer-progression#offline-floor). Needs a Studio content key for the target server (Local or Production) — the exporter and the push both go through the same authenticated content-write path as any other Studio push.
5. Rebake: `cr-api/Convenience/CR.Game.Compat/build-packages.sh` (or `cr_rebake_floor`).

The level curve and XP rules are edited in cr-admin-web (Content → Trainer Level Curve / Trainer XP Rules). Its World Locations editor is for reading and renaming only: the Studio push above replaces the whole list and retires any location created elsewhere — add locations here, in the catalog.

**World map row.** The same tab has a *World map* row (status light, **Scan map areas**, **Open map**), which
builds the player menu's Map tab layout from the area scenes. An area needs at least one location here to ever be
discovered on the map. See [World Map](35-world-map.md).

## Deploy checklist

Location XP, the `explorer` achievement, and the Journal's "locations visited" count are all dead on
Production until locations have been pushed to Production (step 3 above, Studio pointed at
Production) — nothing throws or logs loudly while `world_location` is empty.

`ConnectionStrings__TalentDatabase` is no longer a prerequisite: when the key is missing from
`/opt/cr/.env` the API uses the `StatDatabase` connection string for the Talents tables and logs one
`[startup] ConnectionStrings:TalentDatabase is not set; …` line. (The Unity client never reads the
key — its Talents repositories open the GameData floor directly.)

Do the push before or with the API deploy that ships this feature — see
[Trainer Progression (backend) — Deploy prerequisites](?page=backend/22-trainer-progression#deploy-prerequisites).
