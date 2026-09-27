# Trainer Progression in Unity

## Runtime

- **Bindings** (`LocalDevGameInstaller`): Talents content repos over the GameData floor; `ITrainerProgressionService` → `TrainerProgressionService` (DLL) and `ITrainerModifierProvider` → `NoTalentModifierProvider`. Every consumer takes the service as an optional constructor parameter, so these bindings switch XP on offline. `ICaptureAttemptService` → `CaptureAttemptService`: offline capture (`OfflineItemUseService`) runs the same code as the server.
- **Online**: the server grants XP; the client never calls the funnel. Offline: the DLL services grant it on local SQLite.
- **Reporting**: `IProgressionNotifier.ReportTrainerProgress(result.TrainerProgress)` from `QuestManager` (claim, progress), `OnlineOfflineBattleDomainService`, `OnlineOfflineItemDomainService`, `PickupBehaviour`. It invalidates `CacheScope.TrainerProgress` for that trainer and raises `TrainerProgressed`; `TrainerLevelUpToastAdapter` shows "Trainer level N" (`ToastKind.LevelUp`, heading "Level Up!").
- **Reading**: `ITrainerProgressReader` (`TrainerProgressReader`) — the server's `GET …/progression` memoised online (invalidated by BattleClosed, QuestClaimed, QuestProgressRecorded, PickupCollected, CreatureCaptured and every report), the DLL service offline. `PlayerTeamView` shows the derived level and an XP bar (`TrainerXpBar`: "EXP 45/180 to Lv. 3" / "MAX LEVEL").
- **Level requirements** in dialogue (`progress.requirement` kind `TrainerLevel`) derive from `trainer_xp` through the DLL `ConditionEvaluator`.

## Authoring (Crystalline Rift Studio → WORLD → Trainer Progression)

1. Place a `LocationTriggerBehaviour` in an area scene and set `_locationContentKey`.
2. **Scan areas** (`cr_world_locations_scan`) — merges every area's trigger keys into `Assets/CR/Content/Defs/Progression/WorldLocations.asset`. Entries no scene holds are kept and reported; delete the row to retire one.
3. **Push locations** (`cr_world_locations_push`) — PUT the whole catalog with replace; reports id divergence.
4. **Export floor seed** (`cr_talent_content_export_seed`) — writes the Talents seed migration into cr-api (curve + rules read from the server). `cr_talent_content_seed_status` says current/stale. Needs a Studio content key for the target server (Local or Production) — the exporter and the push both go through the same authenticated content-write path as any other Studio push.
5. Rebake: `cr-api/Convenience/CR.Game.Compat/build-packages.sh` (or `cr_rebake_floor`).

The level curve and XP rules are edited in cr-admin-web (Content → Trainer Level Curve / Trainer XP Rules). Its World Locations editor is for reading and renaming only: the Studio push above replaces the whole list and retires any location created elsewhere — add locations here, in the catalog.

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
