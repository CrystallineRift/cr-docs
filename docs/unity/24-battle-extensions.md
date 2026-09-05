# Battle Extensions

Some features react to combat without *being* combat: in-battle missions, combo meters, style
scoring, tutorial hints, achievement watchers. The temptation is to add them to the turn loop, where
all the information already is. Every one of those additions makes `BattleCoordinator` and
`BattleDomainService` harder to reason about, and none of them are needed to resolve a turn.

Crystalline Rift's answer is a **sidecar**: a class that lives outside the battle system, observes it
through one outbound event, and contributes through one inbound interface. The first sidecar is
[battle missions](#worked-example-battle-missions) — *"apply Burn to the same target three times →
unlock Mega Burn for the rest of this battle."* It shipped without a single line of change to how a
turn resolves.

This page documents the pattern first and the feature second, because the pattern is the reusable
part.

## The two seams

| Seam | Direction | Signature | Raised / called in |
|------|-----------|-----------|--------------------|
| `BattleEvents.ActionResolved` | Battle → extension | `Action<ActionOutcome>` | `BattleCoordinator` turn loop, immediately after `PlayAndReconcileAsync` |
| `IPlayerAbilityAugmenter.Augment` | Extension → battle | `void Augment(string activeCreatureId, List<WildAbilityDto> abilities)` | `BattleCoordinator`, between `BuildAbilityListAsync` and `RaisePlayerTurnStarted` |

That is the whole contract. An extension that needs more than these two seams is probably a battle
feature, not an extension — see [When *not* to use this](#when-not-to-use-this).

### Outbound: `ActionResolved`

```csharp
// Assets/CR/Game/Battle/BattleCoordinator.cs — turn loop
await PlayAndReconcileAsync(outcome, playerTrainerId.Value, wildTrainerId, ct);

// The outbound extension seam: sidecars observe resolved actions here.
BattleEvents.RaiseActionResolved(outcome);
```

Two properties of this placement matter:

- **After presentation, not before.** `PlayAndReconcileAsync` awaits
  `IBattlePresentationSequencer.PlayOutcomeAsync`, so by the time the event fires the hit has already
  been animated. A reaction to the hit — a mission toast, a combo bump — lands *after* the hit it
  reacts to instead of on top of it.
- **Once per action, for both sides.** The event is raised in the shared tail of the loop, so it
  fires for the player's actions and the wild AI's alike. Filtering by
  `ActionOutcome.ActingTrainerId` is the extension's job, not the coordinator's.

`ActionOutcome` (`CR.Game.Model.Battle`, a cr-api DLL type) is the full resolved record: acting
trainer, target creature, damage, faint flags, `ConditionsApplied` (what landed on the target) and
`AttackerConditionsApplied` (what the attacker gained). Everything an observer needs is already in
it, which is why the seam is one event and not six.

### Inbound: `IPlayerAbilityAugmenter`

```csharp
// Assets/CR/Game/Battle/Missions/IPlayerAbilityAugmenter.cs
public interface IPlayerAbilityAugmenter
{
    void Augment(string activeCreatureId, List<WildAbilityDto> abilities);
}
```

```csharp
// Assets/CR/Game/Battle/BattleCoordinator.cs — player branch only
var abilities = await BuildAbilityListAsync(activeCreature?.CreatureId, ct);

// The inbound extension seam: mission-unlocked moves join the list here.
// Player turns only — the wild AI must never see injected options.
_abilityAugmenter?.Augment(activeCreatureId, abilities);

_playerActionSource = new TaskCompletionSource<string>(TaskCreationOptions.RunContinuationsAsynchronously);
BattleEvents.RaisePlayerTurnStarted(activeCreatureId, abilities);
```

- **Player turns only.** The wild AI branch calls `_wildAI.DecideActionAsync(state, ...)` and never
  touches the augmented list, so an injected move cannot leak into the opponent's options.
- **Optional by construction.** The coordinator takes it as
  `[InjectOptional] IPlayerAbilityAugmenter? abilityAugmenter = null` and null-conditionals the call.
  Battles run identically in a container that binds no extension at all — which is what makes this a
  seam rather than a dependency.

## Why an unlocked move "just works"

The reason this pattern is cheap is a property of the resolver: **there is no ownership check on
abilities.**

```csharp
// cr-api — Game/CR.Game.Domain.Services/Implementation/Battle/BattleDomainService.cs
if (action.Type == BattleActionType.Ability && action.AbilityId.HasValue)
{
    try { abilityDef = await _abilityRepo.GetAbility(action.AbilityId.Value); }
    catch { /* ability not found — treat as miss */ }
}
```

A submitted ability is looked up by id in the `abilities` table and resolved. Nothing validates that
the id is in the creature's learned set or its ability-progression set. So an injected move is not a
special case anywhere downstream — it goes through the same damage math, the same accuracy roll, the
same `animation_key`, the same VFX/SFX keys, the same `AbilityFxCue`, the same
`BattlePresentationSequencer` beats. The extension contributes *one list entry* and gets the entire
pipeline for free.

Contrast with the `Switch` action a few lines below, which *does* validate
(`newCreature.CurrentTrainerId == trainerId`). The asymmetry is deliberate-by-accident: switching to
a creature you do not own would be a correctness bug, while using an ability you have not learned was
simply never a scenario until missions existed.

:::caution
**Online play currently trusts the client about unlocks.** Mission evaluation is entirely
client-side, and the server accepts any ability id it can find in the `abilities` table. A modified
client could submit Mega Burn on turn one without earning it. This is acceptable for a
single-player/demo posture and is a known follow-up — server-side validation would mean the battle
service tracking per-battle unlock grants, which is exactly the battle-system change this pattern was
built to avoid. Do not build anything competitive or PvP-facing on top of client-evaluated unlocks
until that lands.
:::

## When to reach for a sidecar

| Use a sidecar when… | Modify the battle system when… |
|---------------------|--------------------------------|
| The feature only needs to *know* what happened | The feature changes how an action resolves (damage, accuracy, turn order) |
| Its contribution is an option the player may take | Its contribution must be forced, blocked or auto-applied mid-turn |
| Its state is per-battle and disposable | Its state must persist, sync, or be authoritative |
| The battle must still run correctly with it absent | The battle is incorrect without it |
| It can be evaluated from `ActionOutcome` alone | It needs mid-resolution hooks (pre-damage, on-crit, per-tick) |

### When *not* to use this

A new **status condition**, a **damage formula change**, a **priority/turn-order rule**, or anything
the opponent AI must account for are battle-system changes. Bolting them onto `ActionResolved` means
reacting one action too late, and there is no inbound seam that can alter a resolution in flight —
`Augment` only adds options to a menu.

## Elemental reactions are content

*A primer condition already on the target plus an incoming ability of a particular element produce
an outsized result — Soaked + Lightning is Conduction, Frozen + Ground is Shatter.*

Until 2026-09-03 the three reactions were a hard-coded `static readonly` list:
`CR.Game.Compat.Battle.ElementalReactionTable.All`. Retuning one meant editing C#, rebuilding the
compat packages and restarting the API. They are now rows in `elemental_reaction` (Creatures
`M12006`), served by `GET /api/v1/elemental-reactions`, authored in Content Studio, and cached for
offline play by the runtime content sync.

**The static table did not go away — it became the fallback default.** `BattleResolver.Resolve`
takes an optional `IReadOnlyList<ElementalReaction>`; passing `null` falls back to
`ElementalReactionTable.All`, and `BattleDomainService` falls back to it when a database read
returns nothing or throws. A hiccup reading the table costs the authored *edits*, not every reaction
in the fight. Treat the static list as the seed values in code form, and the table as the truth.

What that means on the Unity side:

| Concern | Where it lands |
|---|---|
| Offline copy of the rules | `ContentSync` domain `ElementalReactions` → `elemental_reaction` in `game-data.bytes`. See [Runtime Content Sync](27-content-sync.md). |
| Offline read | `IElementalReactionRepository` (Sqlite, content database), bound in `LocalDevGameInstaller` and injected into the `battle_offline` `BattleDomainService`. |
| Online read | The server's own repository; nothing client-side. |
| The battle log line | `ActionOutcome.ReactionLogLine`, printed verbatim by `BattleHUD`. **No runtime Unity code reads the static table.** See [Battle System → Turn narration](07-battle-system.md). |
| Which reaction fired, for missions | `ActionOutcome.ReactionName` — still the reaction's display **name**, so `condition_key` on an `ElementalReaction` mission still reads `"Conduction"`. |

Two consequences worth stating plainly:

- **A reaction mission's `condition_key` now names authored content.** `mission_storm_chaser` counts
  `"Conduction"` because a row called Conduction exists, not because the enum does. Rename the
  reaction and the mission stops counting — the reachability check in
  `BattleMissionSeedSqliteTests` is what catches that before a player does.
- **The multiplier range is `[0, 10]`, enforced on both sides.** Server-side validation rejects
  anything outside it; `ContentSyncWriter` clamps on write, so a payload that bypassed validation
  still cannot put a negative multiplier into battle math. (`M12007` exists because a
  Radiant→Radiant `-5.0` did exactly that in the damage matrix.)

The type-matchup matrix travels the same road: `elemental_damage` gains REST routes, per-version
Content Studio editing, and an offline pull that also writes
`battle_system_version.active_elemental_damage_version` — the pointer naming the version battles
resolve against.

### Authoring reactions and the damage matrix in Content Studio

Both now sit in the COMBAT group beside Abilities and Conditions, and both follow the tab contract
every other content type follows — with the same extra step battle missions have, because their
offline copy is not written by the push either.

**Reactions (tab 16).** `ElementalReactionDefinition` assets in `Assets/CR/Content/Defs/Reactions/`.

| Control | What it does |
|---------|--------------|
| **+ New Reaction** | Creates the asset |
| **⬆ Push All** | `PUT /api/v1/elemental-reactions/{id}` per reaction, duplicate content keys refused before the plan is built |
| **⬇ Pull** | `GET /api/v1/elemental-reactions/all?includeInactive=true`, applied by id — this is how the three seeded reactions become editable assets |
| **Delete** (per row) | Confirms, deletes the `.asset`, then `DELETE /api/v1/elemental-reactions/{id}` |
| **⬇ Export Seed Migration** | `Creatures/CR.Creatures.Data.Migration/M<n>SeedElementalReactions_<date>.cs` |

The primer and payload are pickers over the project's `StatusConditionConfig` assets, and the
detonator is a dropdown over `ElementType`. That is not tidiness: a reaction whose primer no content
defines can never fire, and one whose payload no content defines fires and leaves nothing behind —
both fail silently, mid-battle, and look like the reaction system is broken. The inspector's
validation strip and the list's **Invalid** chip run cr-api's own `ElementalReactionValidation`
against the same condition list, so what they say is what the push would say.

The exported migration **upserts** each row rather than inserting when absent: M12006 already seeds
those three content keys, so an insert-only seed would leave a retuned Conduction detonating for
1.75 offline while the server served the new number.

**Elemental Damage (tab 17).** One `ElementalDamageMatrixConfig` per version in
`Assets/CR/Content/Defs/ElementalDamage/`, edited as a 10×10 grid — rows attack, columns defend,
green above 1.0, red below, a red outline on anything outside `[0, 10]`, and every cell's tooltip
naming its pair.

| Control | What it does |
|---------|--------------|
| **Version** dropdown | Which version's grid is shown |
| **Copy as new version…** | `POST /api/v1/elemental-damage/versions/{version}/copy?from=`, then pulls the result back |
| **Set Active** | `PUT /api/v1/elemental-damage/active`, then re-pulls — the pointer moves for every version at once |
| **Delete version…** (Advanced) | `DELETE /api/v1/elemental-damage/versions/{version}`; the server refuses while it is active |
| **⬆ Push All** | One whole-matrix `PUT` per version |
| **⬇ Pull** | `GET …/versions`, then `GET …?version=` per version, plus the active pointer |
| **⬇ Export Seed Migration** | `Creatures/CR.Creatures.Data.Migration/M<n>SeedElementalDamage_<date>.cs` for the selected version |

A push always carries all 100 squares. cr-api refuses a partial matrix on purpose — a matchup with
no row resolves at 1.0 with nothing in the logs to say so, which is indistinguishable from a designer
having chosen 1.0 — so `ElementalDamageMatrixMapping.Complete` fills any gap with the neutral value
before sending rather than letting the push fail. The exported migration upserts on
`(offense_element, defending_element, version)` and, **only when the exported version is the active
one**, points `battle_system_version` at it — guarded on that table existing, because the pointer
belongs to the Game domain and this migration is a Creatures one.

Both exporters share `SeedMigrationFileWriter` with the battle-mission exporter: one implementation
of "regenerate the previous export in place, otherwise take the repo-wide highest migration number
plus one".

## Worked example: battle missions

*"Set the same target burning three times → unlock Mega Burn for the rest of this battle."*

### Components

| Piece | Path | Role |
|-------|------|------|
| `BattleMissionTracker` | `Assets/CR/Game/Battle/Logic/BattleMissionTracker.cs` | Pure rules engine. Folds one `ActionOutcome` into every active mission, reports what moved |
| `MissionDefinition` / `MissionProgressEvent` | `Assets/CR/Game/Battle/Logic/` | The content record and the per-observation result |
| `BattleMissionConductor` | `Assets/CR/Game/Battle/Missions/BattleMissionConductor.cs` | The sidecar. Owns both seams, resolves rewards, raises HUD events, writes the stat |
| `IBattleMissionTemplateSource` | `Assets/CR/Game/Battle/Missions/` | Content source; SQLite + HTTP implementations behind `BattleMissionTemplateRoutedSource` |
| `BattleHUD` | `Assets/CR/UI/Battle/BattleHUD.cs` | Renders progress toast, completion banner, unlocked-ability badge |
| `battle_mission_template` | cr-api `Game/CR.Game.Data.Migration/M10004CreateBattleMissionTemplateTable.cs` | The table + the seeded `mission_pyromaniac` row |
| `GET /api/v1/battle-missions` | cr-api `Game/CR.Game.Service.BFF/Endpoints/BattleMissionTemplateEndpoints.cs` | Read-only content endpoint |

### End-to-end flow

```
BattleEvents.BattleStarted
        │
        ├─ BattleMissionConductor.OnBattleStarted
        │      └─ fire-and-forget LoadTrackerAsync
        │             └─ IBattleMissionTemplateSource.GetActiveMissionsAsync
        │                    └─ BattleMissionTemplateRoutedSource → SyncRouter.ReadAsync
        │                           ├─ online  → GET /api/v1/battle-missions
        │                           └─ offline → battle_mission_template in game-data.bytes
        │             └─ new BattleMissionTracker(missions, playerTrainerId)
        │
   ── turn loop ─────────────────────────────────────────────────────────────
        │
        ├─ [player turn] BuildAbilityListAsync  →  Augment(...)  →  PlayerTurnStarted
        │                                             ▲
        │                                             └── conductor appends unlocked WildAbilityDto
        │
        ├─ SubmitActionAsync → server resolves (no ownership check) → ActionOutcome
        ├─ PlayAndReconcileAsync  (presentation plays)
        └─ BattleEvents.ActionResolved(outcome)
                 └─ conductor → tracker.Observe(outcome) → MissionProgressEvent[]
                        ├─ not complete → BattleEvents.MissionProgressed  → HUD toast
                        └─ complete     → IAbilityDomainService.GetAbilityAsync(rewardId)
                                          ├─ cache WildAbilityDto { unlocked = true }
                                          ├─ BattleEvents.MissionCompleted → HUD banner
                                          └─ IStatService.IncrementAsync("battle_missions_completed")
   ──────────────────────────────────────────────────────────────────────────
        │
BattleEvents.BattleClosed → conductor drops the tracker and the unlock cache
```

### The tracker is pure, and per-battle

`BattleMissionTracker` lives in the `CR.Game.Battle.Logic` asmdef, which has `"references": []` and
`"noEngineReferences": true` — no Unity API, no repositories, no `async`. It takes a
`IReadOnlyList<MissionDefinition>` and the player's trainer id, and exposes exactly two members:
`Observe(ActionOutcome)` and `UnlockedAbilityIds`.

That purity is a consequence of the design, not a stylistic choice. *"Burn the same target three
times"* is a fact about **this fight**, so the state dies with the tracker. Concretely, that means the
mission feature ships with:

- **no persistence** — nothing to save, nothing to load;
- **no migrations for progress** — only the template table is content;
- **no online/offline routing for progress** — there is nothing to reconcile;
- **no cross-session bugs** — a mission cannot arrive half-finished from a previous battle.

The only durable trace a mission leaves is one stat increment on completion.

### Rules the tracker encodes

`Assets/CR/Game/Battle/Logic/Tests/BattleMissionTrackerTests.cs` — 11 EditMode tests, runnable
without a scene, a database or a server.

| Rule | Test |
|------|------|
| Three qualifying applications on one target complete and unlock | `ThreeBurnsOnTheSameTarget_CompleteAndUnlock` |
| Every qualifying application reports `Current`/`Threshold` progress | `ProgressIsReportedWithEachQualifyingBurn` |
| `SameTarget` means the *same* target — progress is the best per-target streak, not a pool | `BurnsSpreadAcrossDifferentTargets_DoNotComplete` |
| With `SameTarget = false` any three qualifying applications complete | `WithSameTargetOff_AnyThreeBurnsComplete` |
| Only the player's own actions count; the opponent burning you is not progress | `TheOpponentsBurns_NeverCount` |
| Only the mission's `ConditionKey` counts | `OtherConditions_NeverCount` |
| Self-inflicted conditions never count (`AttackerConditionsApplied` is ignored) | `SelfInflictedConditions_NeverCount` |
| A completed mission stops reporting entirely and unlocks exactly once | `ACompletedMission_StopsReportingAndUnlocksOnlyOnce` |
| An outcome with no conditions moves nothing | `AnOutcomeWithNoConditions_MovesNothing` |
| One action applying two burns counts twice | `OneActionApplyingTwoBurns_CountsTwice` |
| Condition matching is case-insensitive | `ConditionMatching_IgnoresCase` |

The two subtle ones are worth internalising. **Best streak, not pool**: with `SameTarget = true` the
tracker keeps a count per target creature and compares `perTarget.Values.Max()` against the
threshold, so burning A, then B, then A reports 2 — not 3. **Counts per application, not per
action**: a single action that lands two Burns advances the mission by two, because
`CountQualifyingApplications` counts matching entries in `ConditionsApplied` rather than testing for
presence.

### The conductor

`BattleMissionConductor` implements `IPlayerAbilityAugmenter` and `IDisposable`, and is the only
class that touches both seams. Its responsibilities:

1. **Lifecycle** — subscribes to `BattleStarted` / `ActionResolved` / `BattleClosed` in its
   constructor, unsubscribes in `Dispose`. On `BattleStarted` it clears the unlock cache and kicks
   off the template load; on `BattleClosed` it drops the tracker and the cache.
2. **Observation** — feeds each `ActionOutcome` to the tracker and turns each returned
   `MissionProgressEvent` into either `BattleEvents.RaiseMissionProgressed` or the completion path.
3. **Reward resolution** — on completion, resolves the reward ability id through
   `IAbilityDomainService.GetAbilityAsync` and caches a `WildAbilityDto` with `unlocked = true`,
   built from the ability's real `Name`, `AnimationKey`, `Category`, `Power` and `Cost`.
4. **Telemetry** — `IStatService.IncrementAsync(accountId, trainerId, "battle_missions_completed", 1,
   $"mission:{missionName}")`. `IStatService` resolves to the DLL `StatService` over
   `StatOnlineOfflineRepository`, so the write is local-first and mirrors to the server when online —
   see [Stats System](?page=backend/08-stats-system).
5. **Contribution** — `Augment` appends every cached unlock that is not already in the list, so a
   creature that legitimately knows Mega Burn never sees it twice.

Every failure path degrades rather than throws: a missing reward ability logs a warning and skips the
unlock, a failed ability lookup still fires the banner, and a failed stat write leaves the unlock
standing. A battle must never break because a mission could not.

:::caution
**The template load is deliberately fire-and-forget.** `BattleStarted` is a synchronous event, so
`OnBattleStarted` cannot await content. It launches `LoadTrackerAsync` and returns; until it lands,
`_tracker` is null and `OnActionResolved` returns early. The practical consequence is that a mission
may start counting from the second or third action of a battle rather than the first, on a cold
offline read. A late mission was judged better than a stalled battle — do not "fix" this by awaiting
inside the event handler.
:::

### Mission definitions are content

Missions follow the same content standard as every other domain: authored in the backend, baked into
the offline floor, read through a router.

| Layer | Where |
|-------|-------|
| Table + seed | `battle_mission_template`, migrations **M10004** + **M10008** (cr-api `Game/CR.Game.Data.Migration`) and **M10018** (Creatures) |
| Reward ability | `Mega Burn` seeded by **M10003** (cr-api `Creatures/CR.Creatures.Data.Migration/M10003SeedMegaBurnAbility.cs`) into `abilities` |
| Server read | `GET /api/v1/battle-missions` → `IBattleMissionTemplateRepository.GetActiveTemplatesAsync` (active, non-deleted, ordered by name) |
| Server authoring | `GET /all`, `GET /{id}`, `PUT /{id}`, `DELETE /{id}` under `/api/v1/battle-missions`, all behind `AuthorizationPolicies.RequireContentWrite` — see [Battle Persistence](?page=backend/09-battle-persistence) |
| Unity online | `BattleMissionTemplateHttpSource` (`SimpleWebClient` on `GameServerHttpAddress`) |
| Unity offline | `BattleMissionTemplateSqliteSource` reading `battle_mission_template` from the baked GameData DB |
| Routing | `BattleMissionTemplateRoutedSource` → `SyncRouter.ReadAsync` — server when online, floor when offline **or when the server read fails** |

`M10004` lives in the Game domain and `CR.Data.Migrations` references
`CR.Game.Data.Migration`, so the table and its seed row are in `game-data.bytes` — a fresh install
has the Pyromaniac mission before it ever contacts a server. See
[Content Pipeline](?page=unity/17-content-pipeline).

Schema (both engines, `isSqlite`-guarded in the migration):

| Column | Type | Notes |
|--------|------|-------|
| `id` | GUID | PK |
| `content_key` | VARCHAR(255) | Designer-facing key, e.g. `mission_pyromaniac`; indexed |
| `name` / `description` | VARCHAR / TEXT | `name` is what the HUD shows |
| `mission_type` | VARCHAR(50) | What the tracker counts: `StatusApplication`, `KnockOut` or `ElementalReaction` — the constants live in `CR.Game.Data.Constants.BattleMissionTypes`, which ships to Unity in `CR.Game.Data.dll`, so editor dropdowns read them rather than repeating the literals |
| `condition_key` | VARCHAR(100) | Condition name (`Burn`) or reaction name (`Conduction`); unused by `KnockOut` |
| `threshold` | INT | Qualifying events needed |
| `same_target` | BOOLEAN | Per-target streak vs. free pool |
| `reward_type` | VARCHAR(50) | Only `AbilityUnlock` exists today (`CR.Game.Data.Constants.BattleMissionRewardTypes`) |
| `reward_ability_id` | GUID (nullable) | FK-by-convention into `abilities` |
| `is_active` | BOOLEAN | Only active rows are served; indexed |
| `created_at` / `updated_at` / `deleted` | — | Standard soft-delete columns |

### DI wiring

```csharp
// Assets/CR/Core/DI/LocalDevGameInstaller.cs
Container.Bind<Game.Battle.Missions.IBattleMissionTemplateSource>()
    .WithId(LocalDataSources.BattleMission.Offline)
    .FromInstance(new Game.Battle.Missions.BattleMissionTemplateSqliteSource(
        new CRUnityLoggerAdapter(typeof(Game.Battle.Missions.BattleMissionTemplateSqliteSource)),
        connectionStringFactory.GetConnectionString(LocalDataSources.GameData.OfflineSource)))
    .AsCached();
Container.Bind<Game.Battle.Missions.IBattleMissionTemplateSource>()
    .WithId(LocalDataSources.BattleMission.Online)
    .To<Game.Battle.Missions.BattleMissionTemplateHttpSource>()
    .AsCached();
Container.Bind<Game.Battle.Missions.IBattleMissionTemplateSource>()
    .To<Game.Battle.Missions.BattleMissionTemplateRoutedSource>()
    .AsCached();

Container.Bind(typeof(Game.Battle.Missions.BattleMissionConductor),
               typeof(Game.Battle.Missions.IPlayerAbilityAugmenter))
    .To<Game.Battle.Missions.BattleMissionConductor>()
    .AsSingle()
    .NonLazy();
```

Three details that are easy to get wrong:

- **`.NonLazy()` is load-bearing.** The conductor subscribes to the static `BattleEvents` in its
  constructor and nothing else resolves it. Drop `NonLazy` and it is never constructed, so missions
  silently never observe a battle — no error, no log, just nothing happening.
- **One instance, two contracts.** Binding `typeof(BattleMissionConductor)` *and*
  `typeof(IPlayerAbilityAugmenter)` to a single `AsSingle` registration is what makes the observer and
  the augmenter the same object. Two separate bindings would give two conductors, and the one holding
  the unlocks would not be the one the coordinator injects.
- **`AsCached`, not `AsSingle`, for the id-keyed sources.** Three bindings share the
  `IBattleMissionTemplateSource` contract; under Zenject 6+, `AsSingle` is one-instance-per-contract
  globally and the id-keyed pair would collide. The routed source pulls its two dependencies with
  `[Inject(Id = LocalDataSources.BattleMission.Offline)]` / `.Online` — without those attributes the
  plain-typed parameters would resolve back to the id-less routed binding and self-reference.

### HUD

`BattleHUD` renders three things and evaluates none of them: a progress toast on
`MissionProgressed`, a queued completion banner on `MissionCompleted`, and an accent style plus
`"UNLOCKED"` badge on any ability row whose `WildAbilityDto.unlocked` is true. The full UXML/USS
detail is documented in
[Battle System → Battle missions in the HUD](?page=unity/07-battle-system).

`unlocked` is a pure presentation flag: the battle system never reads it, and the row stays an
ordinary `Button` on the same submit path as every learned move.

## The player picks one mission

Ten missions ship, and exactly **one runs at a time** — the player chooses which in the team view's
sidebar, beside the run summary.

| content_key | `mission_type` | `condition_key` | `threshold` | `same_target` | Unlocks | Seeded by |
|---|---|---|---|---|---|---|
| `mission_pyromaniac` | `StatusApplication` | `Burn` | 3 | yes | Mega Burn | M10004 |
| `mission_deep_freeze` | `StatusApplication` | `Slow` | 3 | yes | Blizzard | M10008 |
| `mission_mind_games` | `StatusApplication` | `Confusion` | 2 | yes | Dawnbreak | M10008 |
| `mission_earthbound` | `StatusApplication` | `Grounded` | 3 | yes | Quake | M10008 |
| `mission_venomancer` | `StatusApplication` | `Poisoned` | 3 | yes | Miasma | M10008 |
| `mission_wildfire` | `StatusApplication` | `Burn` | 4 | no | Cyclone | M10008 |
| `mission_clean_sweep` | `KnockOut` | *(empty)* | 2 | no | Hyper Beam | M10008 |
| `mission_storm_chaser` | `ElementalReaction` | `Conduction` | 2 | yes | Thunderbolt | M10018 |
| `mission_cold_snap` | `ElementalReaction` | `Flash Freeze` | 2 | yes | Blizzard | M10018 |
| `mission_demolition` | `ElementalReaction` | `Shatter` | 1 | yes | Quake | M10018 |

`mission_clean_sweep` is the first non-status mission — see *Adding a new mission type* below. The
three `ElementalReaction` missions were first seeded from the **Creatures** domain (`M10018`), guarded
on `battle_mission_template` existing — which a Creatures-before-Game fresh database fails. The Game
domain's `M12005SeedBattleMissions_20260903` (exported from Content Studio) re-seeds all ten
idempotently, so every database — fresh Postgres, `cr_dev`, and the baked `game-data.bytes` floor —
carries all ten.

### The choice is client state, on purpose

`IBattleMissionSelection` stores the chosen `content_key` in `PlayerPrefs`, **keyed by trainer id**
so two characters on one device do not inherit each other's loadout. That is not a shortcut: the
conductor is a Unity sidecar that evaluates missions from the outcome stream, online and offline
alike, so nothing on the server ever needs to know which mission was picked. A per-trainer table
would be four data layers and a REST route to move one string that never crosses the wire.

`BattleMissionConductor.ChooseActive` narrows the loaded list to the selection, with two fallbacks
that both matter: an **unset** choice runs the first mission (so a fresh save is not mission-less),
and a choice naming content that no longer exists — renamed, deactivated, or saved by an older
build — is logged and replaced rather than silently leaving the player with nothing.

### Missions must be reachable, and a test enforces it

A mission asks the player to do something. If no ability in the game can do that thing, the mission
is not *hard*, it is **broken** — and it is indistinguishable from a bug in the tracker. So
`BattleMissionSeedSqliteTests` holds every seeded mission up against the abilities that actually
exist: every `StatusApplication` mission must name a condition some ability can inflict with
non-zero probability, every reward ability must exist, and every mission type must be one the
tracker implements.

That check is why no mission uses `Weakened`: exactly one ability (Growl) applies it.

## Authoring missions in Content Studio

Missions used to be a migration and nothing else: a designer who wanted "burn four different
creatures" wrote C# in cr-api, rebuilt the compat packages and restarted the API. Content Studio →
**Battle Missions** (COMBAT group) is the same content, edited the way every other content type
already is — with one extra step no other tab has, because missions are the first content whose
offline copy is not written by the push.

### The tab

| Control | What it does |
|---------|--------------|
| **+ New Battle Mission** | Creates a `BattleMissionDefinition` asset in `Assets/CR/Content/Defs/BattleMissions/` |
| **⬆ Push All** | `PUT /api/v1/battle-missions/{id}` per mission. Refuses duplicate content keys before sending, and reports the server's own 400/409 `message` on the offending row |
| **⬇ Pull** | `GET /api/v1/battle-missions/all?includeInactive=true`, applied by id; server-only rows become new assets. This is how the ten seeded missions become editable — the project ships with no mission assets at all |
| **Delete** (per row) | Confirms, deletes the `.asset`, then `DELETE /api/v1/battle-missions/{id}` (soft delete). A mission that a migration seeds comes back on the next floor rebake — the dialog says so |
| **⬇ Export Seed Migration** | Writes the authored set into cr-api as a seed migration (see below) |

All write routes carry an editor service token (`EditorServiceAuth`), same as every other Studio
push. The transport is `BattleMissionEditorSyncHelper`, which reuses `AbilityEditorSyncHelper`'s
HTTP helpers rather than copying them — one place for the Studio server override, the token attach
and the single 401 retry after a server restart.

`GET /api/v1/battle-missions` — the active-only feed the *game* reads — is deliberately untouched by
any of this.

### One validation rule, not two

`BattleMissionTemplateUpsertRequest` and `BattleMissionTemplateValidation` ship to Unity in
`CR.Game.Data.dll`, so the inspector's "the server would refuse this" strip, the list's **Invalid**
chip and the push pre-check all call **the server's own validator**. There is no Unity mirror of the
rules to drift out of step, and the message the author reads before pushing is the message the
endpoint would have returned.

The same applies to the dropdowns: mission type and reward type are rendered from
`BattleMissionTypes.All` / `BattleMissionRewardTypes.All`, never from literals. The condition
dropdown switches on the chosen type — the project's `StatusConditionConfig` names for
`StatusApplication`, the project's `ElementalReactionDefinition` names for `ElementalReaction`
(falling back to `ElementalReactionTable.All` only when no reaction assets exist yet), hidden entirely for
`KnockOut`, which ignores `condition_key`. A value the asset already holds stays selectable even
when this project has no matching content, so pulling from a richer server never silently retargets
a mission.

`BattleMissionContentKey` derives the snake_case key from the display name ("Deep Freeze" →
`mission_deep_freeze`) behind a **Derive** button. It is offered, never forced: the content key is
identity on the server, so rewriting it on a rename would move the row.

### Pushing is not enough — the offline step

The offline floor is baked from migration seeds **and nothing else** (see
[Content Pipeline](?page=unity/17-content-pipeline)). Content Studio does not write the local
SQLite. So a mission that has only been pushed exists online and does not exist for a disconnected
player.

**⬇ Export Seed Migration** closes that gap. It writes
`cr-api/Game/CR.Game.Data.Migration/M<version>SeedBattleMissions_<yyyyMMdd>.cs` from the authored
assets, then the operator runs the cr-api migrations and rebakes the floor. The generated file:

- seeds the **authored id**, so the offline row and the server row are the same row;
- branches on engine — `INSERT OR IGNORE` + `1`/`0` on SQLite, `ON CONFLICT DO NOTHING` +
  `true`/`false` on Postgres;
- guards every insert on `WHERE NOT EXISTS (… content_key)`, so re-running it against a database
  that already has the mission is a no-op rather than a UNIQUE violation;
- deletes on `Down()` only where **both** the content key and the id match, so a rollback cannot
  take rows an earlier migration seeded under the same key;
- takes the **repo-wide highest** migration number plus one, not the folder's — numbering is one
  sequence across every domain in cr-api, and it doubles as the content-schema bump `GameDataAdopter`
  needs to adopt a freshly baked floor.

A previously exported file is regenerated in place; a second export never leaves two migrations
claiming the same content keys.

Exporting does not run the migration and does not rebuild any package. It writes one file.

## Recipe: adding a new mission

For a mission that reuses the existing `StatusApplication` type, **no Unity code changes at all** —
it is a content row.

The short path is [Content Studio → Battle Missions](#authoring-missions-in-content-studio): create
the asset, push it, export the seed migration, rebake. Write the migration by hand only when there
is no editor to hand:

1. Write a migration in cr-api `Game/CR.Game.Data.Migration` that inserts into
   `battle_mission_template`. Follow M10004: guard `isSqlite`, use `1`/`0` and `INSERT OR IGNORE` on
   SQLite, `true`/`false` and `ON CONFLICT DO NOTHING` on Postgres.
2. If the reward is a new ability, seed it into `abilities` in the **Creatures** domain (see M10003)
   and reference its id as `reward_ability_id`. Give it an `animation_key` and FX keys, or it will
   resolve and hit with no visuals.
3. Rebuild the offline floor: `cd cr-api/Convenience/CR.Game.Compat && ./build-packages.sh --clean`,
   then copy the refreshed `game-data.bytes` into Unity.
4. Restart the API so the endpoint serves the new row.

### Adding a new mission *type*

A new `mission_type` (e.g. `"DamageDealt"`, `"CriticalHits"`) is the only case that needs code, and
it is confined to the pure asmdef:

1. Add the counting branch in `BattleMissionTracker.Observe` — a new
   `Count…` helper reading the relevant `ActionOutcome` fields, alongside the existing
   `StatusApplication` branch.
2. Add tests in `BattleMissionTrackerTests` covering the qualifying case, the near-miss case, and
   the "opponent did it" case. The tracker is pure, so these run in EditMode with no fixtures.
3. Insert template rows using the new `mission_type`.

Nothing in `BattleCoordinator`, `BattleDomainService` or the HUD changes.

## Recipe: a different extension

To add a combo meter, style scorer or tutorial hinter:

1. Put the rules in a pure class in the `CR.Game.Battle.Logic` asmdef, taking `ActionOutcome` in and
   returning a result record. Unit-test it there.
2. Write a conductor that subscribes to `BattleEvents.ActionResolved`, feeds the rules class, and
   raises new `BattleEvents` for the HUD. Add raise helpers next to `RaiseMissionProgressed`.
3. If — and only if — the extension needs to offer the player an option, implement
   `IPlayerAbilityAugmenter`. Note there is currently **one** augmenter seam: `BattleCoordinator`
   injects a single `IPlayerAbilityAugmenter`, so two extensions that both want to inject abilities
   would need a composite implementation binding, not a second binding of the same contract.
4. Bind it `.AsSingle().NonLazy()` and, if it also augments, bind both contracts to the one
   registration.
5. Have the HUD subscribe and render. The HUD must not evaluate rules.

## Gotchas

**The conductor must be `NonLazy`.** Nothing resolves it. See the DI section above — the failure mode
is total silence.

**`BattleEvents` is static.** The conductor subscribes in its constructor and unsubscribes in
`Dispose`. It is safe because the binding is `AsSingle`, but a second registration (or a
scene-placed component *also* bound with `FromNewComponentOnNewGameObject`) would double-subscribe
and double-count every mission. The tell-tale is each progress toast appearing twice.

**Missions are player-scoped by trainer id, resolved late.** The tracker is constructed with
`_session.CurrentTrainerId ?? Guid.Empty`. If a battle somehow starts before a trainer session
exists, every outcome fails the `ActingTrainerId` check and no mission ever ticks.

**`"battle_missions_completed"` is a raw string.** Unlike `battles_won` and friends it is not in
`StatKey` (cr-api `Stats/CR.Stats.Data/Constants/StatKey.cs`). Anything that later reads this stat —
an achievement, the journal — must match the literal exactly. Promoting it to a `StatKey` constant is
the obvious cleanup.

**Progress is not resumable.** Quitting mid-battle discards mission progress by design. There is no
row to clean up, but do not build UI that promises otherwise.

### A transient toast is not "shown"

Mission progress reached the player only through a corner toast that fades after 2.5s, and the
unlock only through a banner that queues behind any other completion and then fades. Both are
correct code — and the reported bug was *"the mission and Mega Burn never show up in the combat log
or the output of combat."* The tracker was working the whole time; the player was looking at the
log, which is where a record belongs.

Progress and completion now `AppendLog` as well, and they do it **before** the early return on a
missing toast element, so a UXML rename degrades to "no toast" rather than "no evidence missions
exist". The log is persistent and scrollable; the toast stays as the glanceable version.

The general rule: anything a player is meant to *notice* needs a durable surface, not only a timed
one. Ask where someone would look for it a minute later.

### A mission can only count what the content can produce

`mission_pyromaniac` counts `Burn` applications, and for a long time it could never complete: no
ability in any database inflicted Burn, because `ability_status_conditions` was empty everywhere
(fixed by `M10005SeedAbilityStatusConditions`). The tracker was correct, the conductor was correct,
and the mission was unreachable.

When you add a mission type keyed on some game event, check that something in the seeded content
actually raises that event — a query against the migrated database, not a reading of the code.

## Tests

| Suite | Location | Covers |
|-------|----------|--------|
| `BattleMissionTrackerTests` | Unity `Assets/CR/Game/Battle/Logic/Tests/` (EditMode, 11 tests) | Every counting rule above |
| `BattleMissionSeedMigrationGeneratorTests` | Unity `Assets/CR/Game/Battle/Logic/Tests/` (EditMode, 17 tests) | The exported migration's text: both engine branches, idempotency guard, authored id preserved and lowercased, quote/backslash escaping, `Down()` matching id *and* key, stable ordering |
| `BattleMissionContentKeyTests` | Unity `Assets/CR/Game/Battle/Logic/Tests/` (EditMode, 21 tests) | The snake_case rule, and that a derived key always passes it |
| `BattleMissionTemplateRepositorySqliteTests` | cr-api `Game/CR.Game.Data.Test/` (2 tests) | Seeded Pyromaniac row is returned; inactive and soft-deleted rows are excluded |
| `BattleMissionTemplateEndpointsTests` | cr-api `Game/CR.Game.Domain.Services.Test/Endpoints/` (4 tests) | 200 with templates, 200 with empty list, `Problem` on repository throw, cancellation token propagation |

## Related Pages

- [Battle System](?page=unity/07-battle-system) — `BattleCoordinator`, the turn loop, `BattleEvents`, the mission HUD
- [Battle Persistence](?page=backend/09-battle-persistence) — `battle_mission_template`, the endpoint, `BattleDomainService`
- [Domain Sync Pattern](?page=unity/16-domain-sync-pattern) — `SyncRouter`, the online/offline read contract
- [Content Pipeline](?page=unity/17-content-pipeline) — how `battle_mission_template` reaches `game-data.bytes`
- [Stats System](?page=backend/08-stats-system) — where `battle_missions_completed` lands
- [Dependency Injection](?page=unity/02-dependency-injection) — `AsSingle` vs `AsCached`, `NonLazy`, id-keyed bindings
