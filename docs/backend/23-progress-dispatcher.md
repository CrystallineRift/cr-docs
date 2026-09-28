# Progress Dispatcher (server-derived progress)

Every lifetime stat, quest objective, quest completion and achievement is **derived by the authority from
outcomes it produced itself** — never reported by a client. Online the authority is the server; offline it is
the same cr-api DLLs over the player's local SQLite. Spec: `cr-api-unity/docs/superpowers/specs/2026-09-27-server-authority-design.md` §4.4–§4.9 (phase B).

## Where things live

| Piece | Location |
|---|---|
| Contract | `Game/CR.Game.Model/Progression/` — `ProgressOutcomeKind`, `ProgressOutcome`, `ProgressFacts`, `IProgressOutcomeSink`, `IProgressOutcomeHandler`, `ProgressReport` (+ `ProgressObjectiveDto`, `ProgressQuestDto`), `ProgressReportBuilder`, `ProgressOutcomeSinkExtensions.SafeRecordAsync`, `ProgressReportExtensions.MergedWith`; `Game/CR.Game.Model/Achievements/AchievementUnlockNotice`; `Game/CR.Game.Model/Npcs/INpcTalkService` |
| Dispatcher | `Quests/CR.Quests.Domain.Services/Implementation/ProgressDispatcher.cs` — the one `IProgressOutcomeSink` |
| Handlers | `LifetimeStatProjector` (order 100), `QuestObjectiveProjector` (order 200); 400+ reserved |
| Achievement evaluation | `CR.Game.Model.Achievements.IAchievementEvaluator` (optional ctor dep on `ProgressDispatcher`) → `AchievementDomainService.EvaluateAsync(accountId, trainerId, ct)`, called once per root call via `AchievementEvaluatorExtensions.SafeEvaluateAsync` — see [Achievements](15-achievements.md#evaluation) |
| Counted keys | M16004 `quest_objective_counted_ref(quest_objective_progress_id, reference_key)` UNIQUE, back-filled from the legacy `counted_reference_ids` JSON (read-only; dropped in phase E) |
| Talk intent | `Npcs/CR.Npcs.Domain.Services/Implementation/NpcTalkService.cs`, route `POST /api/v1/trainers/{trainerId}/npcs/{npcKey}/talk` |
| Unity | `Assets/CR/Core/DI/ProgressBindings.cs` (offline dispatcher + talk), `Assets/CR/Npcs/Talk/` (talk client + router), `QuestManager.ApplyServerProgress` |

## How one outcome flows

1. A **producer** wins its own compare-and-set (capture ownership, pickup claim, item consume, `npc_met_` counter, quest completion), grants its own XP, and — still inside its `TrainerProgressTracker` bracket — calls `IProgressOutcomeSink.RecordAsync/RecordAllAsync` through `SafeRecordAsync` (a dispatcher failure is logged and never fails the producer: outcomes are **at-most-once**).
2. `ProgressDispatcher` runs every handler in order for each outcome. A handler that throws is logged; the others still run.
3. A handler may **enqueue** a follow-up (a completed quest enqueues `QuestCompleted`); the dispatcher drains the FIFO queue inside the same root call, capped at **32** outcomes (the rest is dropped and logged at Error — a quest chain completing itself).
4. After the queue drains, achievements are evaluated **once per root call** per trainer; unlocks land in `ProgressReport.NewlyUnlocked`.
5. The producer sets `ProgressReport.TrainerProgress` from its bracket and returns the report on its own result: `ItemUseResult.Progress`, `PickupCollectResult.Progress`, `NpcTalkResult.Progress`, `QuestClaimResult.Progress` (XP only). The client applies it through `QuestManager.ApplyServerProgress` — the one entry.

## Producers (the only callers of the sink)

| Outcome | Producer | Emitted after |
|---|---|---|
| `CreatureCaptured` | `CaptureAttemptService` | ownership transfer + capture XP |
| `ItemCollected` (Via=Pickup) | `PickupDomainService.CollectAsync` | the claim won; one per granted Item reward |
| `ItemUsed`, `KeyItemActivated` | `ItemUseDomainService` | consume + effect succeeded |
| `NpcTalked` | `NpcTalkService` | key validated; FirstTime when `npc_met_{key}` goes 0 → 1 |
| `QuestCompleted` | `QuestObjectiveProjector` | the completion compare-and-set (InProgress → Completed, 1 row) |
| `BattleWon`, `CreatureDefeated`, `TrainerDefeated`, `LocationEntered` | the compat route `POST /api/v1/quests/progress` (until C2 / sub-project #2 own them) | the old client's report, `Amount` forced to 1 |

## Outcome → derived writes

| Outcome | Lifetime stat (projector) | Objective types |
|---|---|---|
| BattleWon | `battles_won` +1 | WinBattles |
| BattleLost | `battles_lost` +1 | — |
| CreatureDefeated | `creatures_defeated_total` +1 | DefeatCreature, DefeatCreaturesFromList (list), DefeatAnyCreature |
| TrainerDefeated | `trainers_defeated_total` +1 | DefeatTrainer, DefeatTrainersFromList (list), DefeatAnyTrainer |
| CreatureCaptured | `creatures_captured_total` +1 | CaptureCreature, CaptureAnyCreature |
| ItemCollected | `items_collected_total` +Quantity | CollectItem (+Quantity) |
| ItemUsed / KeyItemActivated | — (`items_used_*` is `ItemUseDomainService`'s own record) | UsedItem / ActivateKeyItem (target = item content key) |
| NpcTalked | `npcs_talked_to_total` +1 **only on FirstTime** (distinct NPCs) | TalkToNpc (distinct keys per quest instance) |
| LocationEntered | — (`TrainerProgressionService` writes the location stats until #2) | VisitLocation (distinct keys per quest instance) |
| QuestCompleted | `quests_completed` +1, `quest_completed_{key}` +1 — at completion, not claim | CompleteQuest (target = quest content key) |

Counting: additive objectives use a clamped atomic `UPDATE … CASE WHEN current_count + @n >= @target …`;
talk/visit/list objectives insert the subject key into `quest_objective_counted_ref` (revive-on-write, so a
restarted quest counts again) and raise the count monotonically to the number of live keys (for a list: the
overlap with the list as it is now). A **targeted** objective needs a matching subject; a targeted talk or
visit objective must have Count 1 (the template route answers 400 `invalid_objective`, Studio refuses the push).

## The compat route `POST /api/v1/quests/progress`

Kept for shipped clients until phase E. Reportable: `WinBattles`, the six defeat types (until C2),
`VisitLocation` (until #2 forwards it), `TalkToNpc` (forwarded to `NpcTalkService`; an unknown key answers 200
with nothing counted). The specific and list defeat events count nothing — the "any" event every shipped client
also sends becomes the one outcome. Every other type answers **400 `server_derived`**.

## Stat-writer registry

One registered writer per key, pinned by `Stats/CR.Stats.Domain.Services.Test/StatWriterRegistryTests.cs` (a
scan of every production stat write). Adding a writer means adding its row there **and** here.

| Key | Sole writer |
|---|---|
| `battles_won`, `battles_lost`, `creatures_defeated_total`, `trainers_defeated_total`, `creatures_captured_total`, `items_collected_total`, `npcs_talked_to_total`, `quests_completed`, `quest_completed_{key}` | `LifetimeStatProjector` |
| `npc_met_{key}` | `NpcTalkService` |
| `trainer_xp` | `TrainerProgressionService` (and `RewardGrantService`'s raw fallback when Talents is not wired) |
| `trainer_level`, `species_captured_{id}`, `locations_visited_total`, `location_discovered_{key}` | `TrainerProgressionService` (the two location keys move to the projector with #2) |
| `items_used_total`, `items_used_{key}` | `ItemUseDomainService` |
| `exp_share_bonus_percent` | `IncreaseExpShareHandler` |
| `stat_perm_boost_{stat}` | `BoostStatPermHandler` |
| `damage_dealt_total`, `highest_creature_level`, `creature_level_{id}`, `battle_missions_completed` | none on the server until C2 |
| `damage_healed_total` | **retired** — no writer; `HealAmount` objectives are refused |

Every key above is server-owned: `POST /api/v1/stats/*` refuses it for players (only `battle_missions_completed`
stays client-incrementable until C2). Key normalisation for `npc_met_` and `quest_completed_`: trimmed, lower-case.

## Online and offline

- **Online:** the server runs the dispatcher; Unity never constructs one. `StatOnlineOfflineRepository` writes
  nothing while online (Error logged), and `AchievementUnlockedOnlineOfflineRepository` never posts an unlock.
- **Offline:** `ProgressBindings.Install` binds the same dispatcher, projectors and `NpcTalkService` over local
  SQLite. The talk key check is **off** offline (the floor has no NPC registry). Offline item use is still a Unity
  re-implementation (`OfflineItemUseService`) until C2, so offline non-capture item use emits no `ItemUsed` yet.

## Pitfalls

- **Push the NPC registry before deploying.** Online, a talk to an NPC the registry lacks is a 404 and counts
  nothing — a "talk to X" quest stalls. The Unity router logs a Warning naming the key.
- A producer must emit only after its own compare-and-set; a derived write outside `LifetimeStatProjector` fails
  the registry test and is a review blocker.
- A new outcome kind: append to `ProgressOutcomeKind` (never renumber), add the projector case and the objective
  map row, add its registry row, and delete the client reporter in the same change.
