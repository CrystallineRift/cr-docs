# Location Discoveries v2 (per-location XP, discovery quests, the ledger)

A player entering an authored `world_location` earns XP and — optionally — a one-time quest, tracked by a
per-trainer discovery ledger rather than a stat flag. Spec:
`cr-api-unity/docs/superpowers/specs/2026-09-27-location-discoveries-v2-design.md`.

## Where things live

| Piece | Location |
|---|---|
| Contracts | `Game/CR.Game.Model/Exploration/` — `IWorldLocationDiscoveryService`, `TrainerLocationDiscoveries`, `TrainerLocationEntry`, `LocationEntryStatus`, `DiscoveredLocation`, `LocationDiscoveryOutcome` |
| Orchestrator | `Game/CR.Game.Domain.Services/Implementation/Exploration/LocationEntryService.cs` (+ `ILocationEntryService`, `LocationEntryResult`) |
| Discovery service | `Talents/CR.Talents.Domain.Services/Implementation/WorldLocationDiscoveryService.cs` |
| Ledger repository | `Talents/` — `ITrainerLocationDiscoveryRepository` + Base/Postgres/Sqlite |
| Migrations | M15010 `world_location.discovery_xp` / `discovery_quest_key`; M15011 `trainer_location_discovery` |
| BFF routes | `Game/CR.Game.Service.BFF/Endpoints/WorldLocationEntryEndpoints.cs` |
| Quest forwarding | `QuestDomainService.ForwardVisitLocationAsync` (mirrors `ForwardTalkAsync`) |
| Unity | `Assets/CR/Progression/Discovery/` — `ILocationEntryClient`/`LocationEntryClientUnityHttp`, `ILocationEntryRouter`/`LocationEntryOnlineOfflineRouter`, `IDiscoveredLocationRegistry`/`DiscoveredLocationRegistry`; `WorldMapDiscoveryReader` (map) |

## Data model

- `world_location` gains `discovery_xp INT NULL` (null → the `LocationDiscovered` rule's default, currently
  25; `0` deliberately pays nothing; range 0–10,000) and `discovery_quest_key VARCHAR(128) NULL` (a quest
  `content_key`, trimmed; not validated against the Quests domain — Talents does not reference Quests, and
  Studio/admin-web pickers already constrain it. An unresolvable key logs a warning at grant time and
  self-heals once fixed).
- `trainer_location_discovery(trainer_id, location_key UNIQUE together, discovered_at, xp_awarded,
  quest_claimed, quest_instance_id)` — the discovery ledger, one row per trainer per location, forever
  (`deleted` exists for the schema rule but nothing writes it; a hand soft-delete hides the discovery from
  reads without re-paying XP). `location_key` is trimmed/lower-cased on write; no FK to `world_location` (a
  key is what triggers, objectives and pickers use — floor and server location **ids** diverge; a rename
  orphans the old row deliberately). `quest_instance_id` has no FK either: the instance may live in another
  database (offline).
- `location_discovered_{key}` and `locations_visited_total` are **no longer gates** — the ledger insert is
  the only first-time gate. Both stats are now pure projections of the `LocationEntered` outcome, written
  by `LifetimeStatProjector` (see [Progress Dispatcher](?page=backend/23-progress-dispatcher) and
  [Stats](?page=backend/08-stats-system)).

## Flow

`LocationEntryService.EnterAsync(accountId, trainerId, locationKey)` — the orchestrator, `CR.Game.Domain.Services`:

1. `WorldLocationDiscoveryService.RecordEntryAsync` — trims the key; an unauthored or over-length key
   returns `UnknownLocation` with no writes at all (not even a stat). Otherwise:
   `INSERT ... ON CONFLICT (trainer_id, location_key) DO NOTHING` (both engines) decides first-time; the
   affected-row count, not a re-read, is authoritative. Everything after this line runs with
   `CancellationToken.None` — the discovery is committed and a client disconnect cannot lose it.
2. XP claim: a conditional `UPDATE ... SET xp_awarded = true WHERE id = @id AND xp_awarded = false`
   (affected == 1 wins) gates `ITrainerProgressionService.AwardAsync(TrainerXpAward.LocationDiscovered(int?
   fixedXp))` — a per-location `discovery_xp` value when set, else the rule amount. Talent XP modifiers still
   apply. A grant failure logs and is at-most-once, same as every other XP source.
3. Discovery quest, only when a `discovery_quest_key` is set and unclaimed: another conditional `UPDATE` on
   `quest_claimed` gates `IQuestDomainService.GrantQuestAsync` (the server-initiated grant added for this
   feature — idempotent, skips the player-accept requirement check; **not** `AcceptQuestAsync`, which can
   409 on unmet requirements). `GrantQuestAsync` now returns `(Instance, Created)`; the orchestrator only
   reports `GrantedQuest` on `Created` (a trainer who already holds the quest gets no duplicate toast). A
   throw from the grant itself releases the claim so the next entry retries; a failure only in
   `SetDiscoveryQuestInstanceAsync` (record-keeping) keeps the claim, since the quest was granted.
4. Emits `ProgressOutcome { Kind = LocationEntered, Facts[FirstTime] = (Status == Discovered), AreaKey }` to
   the dispatcher (`IProgressOutcomeSink`) — after the XP grant, inside the same `TrainerProgressTracker`
   bracket. The dispatcher writes the derived stats, advances `VisitLocation` objectives (distinct keys,
   capped at target) and evaluates achievements once. A dispatcher failure logs and returns an empty report;
   the discovery still stands.
5. Returns `LocationEntryResult { Status, Location, GrantedQuest, Progress }`.

An unauthored key advances nothing — not even a `VisitLocation` objective — because the key is the only
thing the authority can check; a client-reported location would be an unchecked outcome.

## The opening's two locations (M15014, 2026-10-10)

> **Pending deploy (cr-api `integration/round2b`):** the migration is on the integration branch only; the Studio location push
> follows the quest push.

`M15014SeedOpeningStoryLocations` (Talents, both engines, insert-if-absent by content key, hand-written and deliberately
not named `SeedTalentContent_` so a Studio re-export does not regenerate over it) seeds the two places the opening's first
quests visit. The ids must match `WorldLocations.asset`, because the floor and the server carry the same id:

| Key | Id | Name | Area | Discovery XP | Discovery quest |
|---|---|---|---|---|---|
| `story-ahksun-landing` | `474137a8-828f-4c04-b87a-19d84305b0ac` | Ahksun's Landing | Meadow | 10 | none |
| `story-philroes-wagon` | `03292c37-6a09-4774-828e-b890c7e852ed` | Philroe's Wagon | Meadow | 0 | `quest-first-battle` |

- The wagon is the first real use of a discovery quest in the story: its first entry grants First Battle (the grant skips the
  requirement check, `GrantQuestAsync`), then reports `LocationEntered`, which advances Toward the Lights' `VisitLocation`
  objective in the same response. The response's `grantedQuest` is First Battle on the first entry and null afterwards or when
  the trainer already holds it; `progress.completedQuests` carries the quests the entry completed, and the discovery stat
  `location_discovered_story-philroes-wagon` (First Battle's requirement) is written in the same call. An in-progress,
  completed or claimed First Battle is returned untouched; an abandoned or failed one is restarted in place.
- Discovery XP 0 grants nothing; the landing pays 10. These two places also count toward `locations_visited_total`, so the
  Explorer achievement (visit 3 locations) now fires earlier for a new trainer.
- **A replacing push retires every location it does not name**, so the Unity catalog must hold both entries (with these ids)
  before any replacing push, or the push retires the rows. A push writes what it is sent: a null `discovery_quest_key` clears
  the stored one.
- **Offline needs them on the floor.** The offline authority reads `world_location` from the baked GameData floor and answers
  an unknown key with `UnknownLocation` and no writes, so until the floor carries M15014's rows Find Ahksun can never complete
  and the wagon grants nothing; nothing at runtime puts them there. `OpeningLocationFloorTests` (Unity) holds the package's
  floor to the catalog and the committed floor (`Assets/StreamingAssets/CR/game-data.bytes`) to the package: when the installed
  package seeds both rows and the committed floor lacks one, the run **fails** (rebake it). It is skipped only when the package
  does not seed them either.
- Deploy order: cr-api (enum value, evaluator, M15014), then the Studio quest push, then the Studio location push with both
  entries in the catalog. Philroe's hub and the quest chain are described in [Quest System](?page=backend/07-quest-system) and
  [Opening Story](?page=unity/38-story-opening).

## Idempotency

| Case | Result |
|---|---|
| Replayed intent (response lost) | Row already exists → `Revisited`; XP/quest claims already taken → no second grant. |
| Two concurrent first entries | One `INSERT ... DO NOTHING` wins (`Discovered`); the other is `Revisited`. Only one XP claim and one quest claim can win. |
| Crash after insert, before the XP claim | The next entry wins the claim and pays. |
| Crash after the XP claim, before the grant | XP lost — at-most-once by design, logged. |
| Quest grant throws | Claim released; the next entry retries. |
| Crash between quest claim and grant | Quest never granted; claim stays set. **Accepted gap** — the fix is an admin `quest_claimed = false` update, not a stale-claim timeout. |
| A discovery quest authored after the trainer already discovered the location | Granted on the trainer's next entry (`quest_claimed` is still false) — there is no special case. Changing a location's quest after granting the old one grants nothing new. |

## Routes

| Route | Auth | Notes |
|---|---|---|
| `POST /api/v1/trainers/{trainerId}/world-locations/enter` | RequirePlayer + player-trainer guard (404 for another account's trainer) | Body `{ locationKey }`; 400 blank/over-length key; 200 `LocationEntryResult` (including `status: 0`, `UnknownLocation`, for an unknown key — not 404); 401 without a token |
| `GET /api/v1/trainers/{trainerId}/world-locations` | same | 200 `TrainerLocationDiscoveries` — every **live** location, `name`/`discoveredAt` redacted (null) until discovered; the one discovery read (world map consumes it) |

The server does not check the player's world position against `area_key` — the client's last-known
position is not authoritative, matching pickups. Location XP is small and flat; a plausibility check can be
added later without changing the contract.

## Quest system integration

Before Phase E, `POST /api/v1/quests/progress` with `objectiveType = VisitLocation` was **forwarded**
(`QuestDomainService.ForwardVisitLocationAsync`) into `LocationEntryService.EnterAsync` through a
narrow adapter (`LocationEntryForwarderAdapter`, resolving `ILocationEntryService` lazily via
`IServiceProvider` — a direct constructor dependency would cycle, since `LocationEntryService` itself
depends on `IQuestDomainService`; a factory-registered cycle is invisible to .NET DI's own detector and
hung a test for 1h49m before this fix). **Phase E retired the compat route and deleted `QuestDomainService.ForwardVisitLocationAsync`** — `POST
.../world-locations/enter` (this page's own route, above) is now the only door into
`LocationEntryService.EnterAsync`; `VisitLocation` objectives only ever advance from a genuine entry
through it, never a client-reported progress event. The M2 fix pass deleted the now-dead
`LocationEntryForwarderAdapter`/`ILocationEntryForwarder` (the DI indirection `ForwardVisitLocationAsync`
used to call through) — `QuestDomainService`'s ctor no longer takes that dependency. See
[Quest System — the retired compat route](?page=backend/07-quest-system) and
[Progress Dispatcher](?page=backend/23-progress-dispatcher).

## Unity (online/offline)

- `LocationEntryOnlineOfflineRouter`: online calls `ILocationEntryClient` (own private request DTO — the
  server's `EnterWorldLocationRequest` lives in the BFF-only project), applies a returned quest instance and
  invalidates `CacheScope.LocationDiscoveries` unless the status is `UnknownLocation`; offline calls the same
  `ILocationEntryService` DLL against local SQLite. Both paths call `IDiscoveredLocationRegistry.Record` on a
  fresh `Discovered` status.
- `IDiscoveredLocationRegistry` memoises discoveries per trainer (`IPlayerStateCache`, `CacheScope
  .LocationDiscoveries`) and raises a guarded, multi-subscriber `Discovered` event — the source for the
  "Discovered: {name}" toast (`ToastKind.Discovery`, `DiscoveryToastAdapter`) and for
  `WorldMapDiscoveryReader` (see [World Map](?page=unity/35-world-map)).
- `LocationTriggerBehaviour` sends the intent once per trigger instance and trainer: a trainer switch while the cell stays
  loaded re-arms it (`IGameSessionService.OnTrainerChanged`), because the opening's first quests are completed by walking onto
  two of these and the next new trainer of a session must be credited like the first. The authority stays idempotent, so a
  re-fire only costs a call.
- `QuestManager.OnLocationVisited` sends the enter intent through `ILocationEntryRouter`; a granted quest
  applies its instance and toasts before `ApplyServerProgress` runs — no double-counting against the old
  `RecordProgress` path, which this replaces.
- `GameChange.LocationEntered` invalidates `ActiveQuests, TrainerProgress, Stats, LocationDiscoveries,
  AchievementBoard`.

## Admin / authoring

- The World Locations catalog (Crystalline Rift Studio) is the source of truth for `discovery_xp` and
  `discovery_quest_key`, same as name/area (see
  [Trainer Progression — Admin web](?page=backend/22-trainer-progression#admin-web-world-locations)); an
  admin-web tweak survives only until the next Studio push, unless pulled first
  (`cr_world_locations_pull` / Studio's "Pull tuning from server").
- Studio's drift line (after Push / Pull, `WorldLocationTuningSync.Diff`) compares everything the push sends —
  name, area, XP override, discovery quest — and every row on either side: a catalog key the server lacks,
  and a server key the catalog lacks (which a replace push would retire). The server's `discoveryXp` is
  `int?` with no override flag, so `WorldLocationServerMapping.FromServer` derives it (a number is an
  override, null is the rule default); reading the JSON straight into the catalog row used to throw on a
  null and read every override as drift. "⬆ Push locations" asks before it runs, because replace retires.
- Content Audit: `location-discovery-quest-missing` (the key doesn't resolve to a registered, non-parked
  quest) and `location-discovery-quest-repeatable` (refuse-level — the grant is idempotent only for a
  non-repeatable template); `visit-location-target-uncatalogued` for a `VisitLocation` objective whose target
  isn't a catalog key.
