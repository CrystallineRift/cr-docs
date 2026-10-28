# Roaming Encounters (API + Unity)

One admin switch turns every spawner from **Ambush** to **Roaming**. Ambush (flag off, the default) is the old behaviour: an invisible trigger, a 2 to 5 s delay, and the server rolls the species at battle start. Roaming shows each spawner's creatures as 3D models wandering inside the spawn radius, and walking into one battles **that** creature. Flag off is exactly today's behaviour.

> Status: built across the cr-api, cr-api-unity and cr-admin-web lanes (not yet merged or played). Names below match the as-built lane reports. Spec: `docs/superpowers/specs/2026-10-11-roaming-encounters-design.md` in cr-api-unity.

## Server-authoritative

The client sends intents only: "trainer T is at spawner S" and "trainer T touched slot N of window W at spawner S". The server (offline: the same cr-api DLLs on local SQLite) decides species, level, whether the slot is still available, and the battle. Model positions are cosmetic and never sent. Identity comes from the token, never the body.

## The flag

`app_config.roaming_spawners` (boolean, default false, Game domain, global for all spawners).

| Where | How |
|---|---|
| Client, online | `roaming_spawners` field (snake_case only) on the anonymous `GET /api/v1/version-check` response. Read at session start and at each online entry (`ConnectivityProbe`); a server flip mid-session is seen at the next one. No separate fetch path. |
| Admin read | `GET /api/v1/admin/app-config` returns `AppConfigResponse { roamingSpawners, updatedAtUtc }` |
| Admin write | `PUT /api/v1/admin/app-config/roaming-spawners` body `{ enabled }`, 200 with `AppConfigResponse` |
| Policy | Both admin routes are `RequireAdmin` and listed in `RoutePolicyManifest` |
| Offline | Read from the local `app_config` row (`IAppConfigRepository`, 30 s ration, refreshed when a spawner area initialises). The row is in the floor bake, so a bundled build carries prod's value at bake time. An unreadable row means off |
| Offline player choice | System tab → Gameplay rules → **Roaming Spawns** checkbox (offline play only; the section is hidden while playing online). `IRoamingSpawnersFlag.SetOfflineChoiceAsync` keeps the pick in player data (`offline_roaming_spawners`) and writes it to the local `app_config` row the offline authority reads, re-applying it at each refresh because re-adopting the content floor replaces the row. It sits above the floor row and below the Editor override; online play never sees it |
| Editor | `RoamingSpawnersOverride` (`Inherit`, `On`, `Off`) in the EditorPrefs overrides (`IGameSettingsOverrides.RoamingSpawners`), set from the Studio Configuration panel (`StudioConfigurationPanel`). It is **not** a `GameSettings` field, so the committed asset never ships it. Editor only, wins over the other sources |

The second server flag riding the same version-check answer is `ability_cost_mode` (see [Ability Learning UI](?page=unity/45-ability-learning-ui)): `AbilityCostModeSetting` merges the Editor override (`AbilityCostModeOverride`, same Studio Configuration panel), the server value, the remembered value and the floor row, and `OverlayAppConfigRepository` hands the offline services the floor `app_config` row with the effective mode. Offline, the player's own pick (System tab → Gameplay rules → **Battle System** dropdown, `IAbilityCostModeSetting.SetOfflineChoice`, kept in player data as `offline_ability_cost_mode`) sits above the remembered value and the floor row; online it is ignored. The dropdown lists every `AbilityCostMode` and `GameplayRulesSettingsView.BattleSystemChoices` is tested to cover the enum. The overlay replaces only `ability_cost_mode`; every other field, `roaming_spawners` included, passes through from the floor row.

Client side, `IRoamingSpawnersFlag` merges those sources and raises `Changed`. The admin UI is in [Studio: System Game Config](#studio-system-game-config) below.

## Population: deterministic, nothing stored

| Term | Rule |
|---|---|
| Window length | `bucketSeconds = spawner.spawn_cooldown_seconds` (zero or less means 300) |
| Bucket | `floor(unixNow / bucketSeconds)` |
| Slots | `count = clamp(spawner.max_capacity, 1, 6)` (zero or less means 3) |
| Seed | `splitmix64(fnv1a64(trainerId bytes + spawnerId bytes + bucket))` |

The PRNG is our own (fnv1a64 into splitmix64), not `System.Random`, so the server and the offline DLL agree on every platform. The roll is the **same** weighted selection `CreatureSpawnDomainService` uses at battle start (pool weight times rarity multiplier plus the talent shift, the template `spawn_probability`, level uniform in the template's min to max), refactored to take an `IRandomSource`. The default source is today's random; population and validation use the seeded one. One code path, so Ambush and Roaming draw from identical odds.

### Asking for the population

`POST /api/v1/spawners/{spawnerKey}/population`, body `{ trainerId }`. `RequirePlayer` + `RequirePlayerTrainer`; limiter `cr-spawner-population` at 30/min per account; no Idempotency-Key (safe to repeat; the client uses `SimpleWebClient.PostOnce`).

```
SpawnerPopulationResponse { spawnerKey, roaming: bool, bucket: long, bucketSeconds: int,
  bucketEndsAtUtc, slots: [ { slot: int, speciesKey, level: int, seed: long } ] }
```

Flag off: `roaming=false`, empty `slots`, no DB write. Slots already claimed in this bucket are omitted (one indexed SELECT).

## Claims

`spawn_claim` is the only new table (Spawner domain, `M5020`): `trainer_id`, `spawner_id`, `bucket` (bigint), `slot` (int), `claimed_at`, `deleted`. Primary key `(trainer_id, spawner_id, bucket, slot)`. Each insert also runs a lazy purge, `DELETE ... WHERE trainer_id = @t AND claimed_at < now - 2 days`, so rows are bounded.

**Any contact claims the slot**: win, capture, loss, the player fleeing, or the creature fleeing. The sighting is gone until the next window. There is no battle-end hook.

## Battle start

`EncounterIntent` gains `Bucket` (`long?`) and `Slot` (`int?`). In `BattleEncounterDomainService.StartEncounterAsync`, for `Kind = Wild`:

| Flag | Request | Result |
|---|---|---|
| on | bucket and slot present, bucket current or previous | recompute the window's roll, insert the claim, battle uses the slot's species and level, the random roll is skipped |
| on | bucket not current or previous | `422 spawn_bucket_expired` |
| on | claim already exists (PK hit) | `409 spawn_slot_claimed` |
| on | bucket or slot missing | `422 roaming_requires_slot` (closes the ambush-path farm) |
| off | any | fields ignored, today's path |

The `cr-battle-start` limiter and Idempotency-Key are unchanged.

## Unity client

| Piece | Role |
|---|---|
| `SpawnerEncounterBehaviour` (on `CR_EncounterZone`) | Flag off: untouched. Flag on: the ambush trigger is disabled and `RoamingSpawnerBehaviour` (same prefab, off by default) is enabled |
| `RoamingSpawnerBehaviour` | Asks for the population when the player enters an awareness sphere of `roamRadius + 20 m` (`RoamingAwarenessRelay` child trigger); re-asks at `bucketEndsAtUtc` while inside; one request in flight per spawner; 60 s debounce (`RoamingAsks`, same shape as `MerchantStockAsks`). Spawns one `WildCreatureBehaviour` per slot at a seeded point in the roam disk, snapped to terrain. The disk is the encounter zone's new `roamRadius` (default 15 m), separate from the spawn radius |
| `ISpawnerPopulationClient` | Online: the `POST` above. Offline: the same domain service on local SQLite, through the router pattern of `OnlineOfflineBattleEncounterDomainService` |
| `WildCreatureBehaviour` | Thin MonoBehaviour (Assembly-CSharp): the model, its trigger, its animator |
| `RoamWalker` | Pure logic in `CR.Game.World.Logic`, unit-tested: seeded waypoints inside the disk, pause 2 to 6 s, walk 1.2 m/s, turn toward the target, Y by downward raycast (the `EscortWalker` pattern), slopes over 35 degrees rejected. No NavMesh, no Malbers AI |
| `CreatureWorldAnimatorBuilder` | Editor command. Generates `<key>_World.controller` (Idle, Walk, float `Speed`) from each Cute Series pack's `@Idle` and `@Walk Forward In Place` clips, and adds a `CreatureWorldAnimation` component (the controller reference) to each creature prefab. `BattleStager` is unchanged. The builder falls back to Move, Slither, Fly, Roll or Run Forward In Place when a pack has no Walk clip. The Gaterbear placeholder is a Wolf Pup variant and walks with the Wolf Pup clips |

The model is loaded with `IGameAssetLoader.LoadAssetByKeyAsync<GameObject>("creatures/<species>")`, the same key `BattleStager` uses. `WildCreatureBehaviour` swaps the Animator controller at spawn.

### Culling and cap

Models live only while the spawner's cell is Active (the zone is enabled only while its cell is Active, so no streamer subscription is needed) **and** the player is within `roamRadius + 60 m`. Global cap of 12 models; the nearest spawners win. Population is re-asked on return and never cached across cells.

### Contact

A child trigger sphere of 1.2 m, tag Player. On contact the model freezes facing the player, then `BattleCoordinator.StartWildBattleAsync(WildBattleRequest + Bucket + Slot)` runs. No 2 to 5 s delay. After any battle there is a 3 s grace that ignores contacts. A server 409 or 422 despawns that model and re-asks. One Feel moment, `feel/wild-contact`, goes through the existing bridge. No new UI and no new settings.

## Offline

Same boundary, same code: the router calls the cr-api domain services against the player's local SQLite. Local `spawn_claim` is the authority for offline play only and never syncs to the server. The flag comes from the local `app_config` row (floor bake) unless the Editor override is set.

## Load notes

- Ask on arrival and at window rollover only: 1 SELECT, 30/min cap.
- Battle start adds one PK insert. The flag rides the existing version-check.
- Rows are at most the contacts per trainer per 2 days. Nothing is shared between players, so no herd effect.
- Steam Deck: at most 12 Cute Series models, Animator `CullCompletely`, one raycast per 0.2 s each; worst case under 2 ms.

## Known limits (v1)

Terrain-only wandering can walk into props (a SphereCast follow-up is noted). Out of scope: per-spawner modes, creatures that notice, chase or flee, shared populations, nameplates, and the creature surviving a flee.

## Studio: System Game Config

Admin only. cr-admin-web page `src/pages/system/GameConfigPage.tsx` (resource `src/resources/system-game-config/page.tsx`, hook `src/api/hooks/useAppConfig.ts`), under the System group of the nav. It shows a **Roaming spawners** checkbox with the last-updated time. Toggling is an optimistic TanStack mutation against `PUT /api/v1/admin/app-config/roaming-spawners`; a failure rolls the checkbox back and shows an error toast. A non-admin gets 403 and does not see the page. Deploy cr-api first, then the web Studio. Players pick the change up at their next session start or resume.

## Tests

API: seeded-roll determinism and Ambush-odds equality (both paths), population (flag off, claimed slots omitted), claim PK and purge, `EncounterIntent` validation errors, route-policy manifest. Unity: `RoamWalker` and `SplitMix64` (pure), flag precedence incl. Editor override, population client router online/offline, `SpawnerEncounterBehaviour` switching, culling cap. Web: Vitest + msw (read, toggle, 403 gating), `nav.test.ts` count 33 to 34.

## Not yet checked in play

Wander feel and slopes, contact then battle on Deck, frame time with 12 models, the prefab edits by the animator builder (battle visuals still bind), flag flip on resume.
