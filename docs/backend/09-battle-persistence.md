# Battle Persistence

The battle system uses fully DB-backed state. Battle session data — sessions, round keys, submitted inputs, and action logs — is stored in relational tables and survives server restarts. There is no in-memory state.

Creature **HP and status conditions are persistent across battles**: they live on the creature's own tables (`generated_creature_current_stats`, `generated_creature_status_conditions`), not per-battle. HP is written live during a battle on every resolved action, so a creature that took damage still shows that damage in the team menu after the battle ends. The active creature for each trainer is tracked on the `battle` record itself.

## Turn Model

Battles use a **sequential turn model**: exactly one trainer acts per round, resolved immediately on submit. The current round carries an `active_trainer_id` field so the client always knows whose turn it is. The faster creature (by Speed stat) goes first; ties go to the player (trainer1).

This replaced the old simultaneous-submit model where both trainers had to submit before a round could resolve.

## Why DB-Backed?

- **Crash recovery** — `GET /api/v1/battle/{id}/state` returns the correct state after a restart.
- **Horizontal scaling** — any API node can handle any request for a battle.
- **Audit trail** — `battle_action_log` preserves the resolved outcomes of every round.

## Tables

### `battle`

Tracks the overall battle session.

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID PK | Battle session identifier |
| `trainer1_id` | UUID NOT NULL | |
| `trainer2_id` | UUID NOT NULL | |
| `battle_type` | VARCHAR(50) | `"ONEvONE"`, `"Wild"`, etc. |
| `status` | VARCHAR(50) | `"Active"` or `"Ended"` |
| `winner_id` | UUID NULL | Set when status → `"Ended"` |
| `trainer1_active_creature_id` | UUID NULL | Trainer 1's creature currently on field |
| `trainer2_active_creature_id` | UUID NULL | Trainer 2's creature currently on field |
| `started_at` | DATETIME | |
| `ended_at` | DATETIME NULL | |
| `deleted` | BOOLEAN | Soft delete |

`trainer{1,2}_active_creature_id` is set at battle start (first team creature) and updated when a creature faints and is swapped. It is the source of truth for "whose creature is fighting" — there are no per-battle HP rows.

### `battle_round`

One row per round per battle. `active_trainer_id` identifies whose turn it is (added by M8006).

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID PK | |
| `battle_id` | UUID FK → `battle.id` | |
| `round_number` | INT | 1-based |
| `active_trainer_id` | UUID NULL | Whose turn this round |
| `trainer1_key` | VARCHAR(255) | Opaque submission token |
| `trainer2_key` | VARCHAR(255) | |
| `created_at` | DATETIME | |

Unique constraint: `(battle_id, round_number)`.

### `battle_round_input`

Stores each trainer's submitted moves for a round.

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID PK | |
| `battle_id` | UUID | |
| `round_number` | INT | |
| `trainer_id` | UUID | Who submitted |
| `actions_json` | TEXT | JSON-serialised `BattleAction[]` |
| `submitted_at` | DATETIME | |

Unique constraint: `(battle_id, round_number, trainer_id)` — one submission per trainer per round.

### `generated_creature_current_stats`

Persistent current HP per creature, **not** scoped to a battle. Written live during a battle and surviving after it ends. **No row means full HP** (healer pattern — clearing the row restores the creature).

| Column | Type | Notes |
|--------|------|-------|
| `generated_creature_id` | UUID PK | `generated_creature.id` |
| `current_hp` | INT | Current HP between/within battles |

`GeneratedCreature.CurrentHitPoints` (`int?`) is populated via a LEFT JOIN on this table in every `generated_creature` SELECT. `null` → use `HitPoints` (max HP).

### `generated_creature_status_conditions`

Persistent active status conditions per creature (hard-delete, composite PK). Written live during a battle.

| Column | Type | Notes |
|--------|------|-------|
| `generated_creature_id` | UUID | `generated_creature.id` |
| `status_condition_id` | UUID | `status_conditions.id` |
| `turns_remaining` | INT NULL | `null` = indefinite (burn/poison) |
| `applied_in_battle_id` | UUID NULL | Battle that applied the condition |

Composite PK: `(generated_creature_id, status_condition_id)`.

> **Note:** The legacy `battle_creature_state` table has been dropped (migration M8015) and the old per-battle creature-state / condition-change repository methods removed from `IBattleRepository`. HP and status conditions now live exclusively on the persistent creature tables above. The `battle_state_stat_changes` table survives for in-battle standalone stat changes and is now keyed directly by `(battle_id, creature_id)` (migration M8014).

### `battle_action_log`

Append-only log of resolved round outcomes.

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID PK | |
| `battle_id` | UUID | |
| `round_number` | INT | |
| `actions_json` | TEXT | Resolved actions + outcomes JSON |
| `created_at` | DATETIME | |

**Reads are bounded.** `GetActionLogAsync(battleId, maxEntries = 200, ct)` returns the *newest*
`maxEntries` rows re-ordered chronologically — this table grows one row per action for the life of
a battle, so an unbounded `SELECT` here scales with battle length. `GetBattleStateAsync`
deliberately does **not** populate `BattleStateDto.ActionLog`: it runs twice per round (before the
player's turn and before the AI's), and eagerly loading the whole log there made per-turn latency
climb with turn count while no caller read the field. Ask for the log explicitly if you need it.

### `battle_mission_template`

**Content** for in-battle missions ("apply Burn to the same target three times → unlock
Mega Burn for the rest of this battle"). Created and seeded by `M10004CreateBattleMissionTemplateTable`.
Read by the game through `GET /api/v1/battle-missions`; authored by the Content Studio through the
`content:write` routes below.

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID PK | Postgres defaults to `NewGuid`; SQLite requires the caller to supply it |
| `content_key` | VARCHAR(255) | Designer-facing key, e.g. `mission_pyromaniac`; indexed (**not** unique — uniqueness is enforced by the endpoint, which 409s) |
| `name` | VARCHAR(255) | What the client HUD shows |
| `description` | TEXT NULL | |
| `mission_type` | VARCHAR(50) | What the client tracker counts: `StatusApplication`, `KnockOut` or `ElementalReaction` (`CR.Game.Data.Constants.BattleMissionTypes`) |
| `condition_key` | VARCHAR(100) NULL | Status-condition name (`Burn`) or reaction name (`Conduction`); unused by `KnockOut` |
| `threshold` | INT | Qualifying events needed to complete |
| `same_target` | BOOLEAN | `true` = the count is per target creature; `false` = any qualifying event pools |
| `reward_type` | VARCHAR(50) | Only `AbilityUnlock` exists today (`CR.Game.Data.Constants.BattleMissionRewardTypes`) |
| `reward_ability_id` | UUID NULL | Points at an `abilities` row (no FK constraint) |
| `is_active` | BOOLEAN | Only active rows are served; indexed |
| `created_at` / `updated_at` / `deleted` | DATETIME / BOOLEAN | Standard soft-delete columns |

Ten missions ship seeded — one from `M10004` (`mission_pyromaniac`, rewarding the `Mega Burn` ability
seeded separately by `M10003SeedMegaBurnAbility` in the **Creatures** domain: id
`b1660000-0000-4000-8000-000000000001`, Fire, power 120, `animation_key = fire_ember`), six from
`M10008SeedMoreBattleMissions`, and three from the Creatures domain's `M10018SeedElementalReactions`.
The full list is in [Battle Extensions](?page=unity/24-battle-extensions).

:::note
`M10018`'s three missions are guarded on `battle_mission_template` already existing, because they are
written from the **Creatures** migration set, and `Program.cs` migrates Creatures before Game — so on
a genuinely empty database `M10018` skips its inserts. `M12005SeedBattleMissions_20260903` (**Game**
domain, generated by Content Studio's *Export seed migration*) re-seeds all ten by authored id with
`INSERT OR IGNORE` / `ON CONFLICT DO NOTHING`, so both a fresh database and the long-lived `cr_dev`
end at ten. It is the last Game migration and runs after the table exists; any future mission added
in Studio should be exported the same way rather than hand-written into a Creatures migration.
:::

:::caution
**There is no `battle_mission_instance` table, and that is the design.** Mission progress is
evaluated entirely client-side by a per-battle, in-memory tracker and dies with the battle, so there
is nothing to persist, migrate or reconcile. The only durable trace of a completion is a
`battle_missions_completed` stat increment through the Stats domain. The corollary is that the
server currently trusts the client about unlocks — `SubmitActionAsync` resolves any ability id
present in the `abilities` table and never checks that the creature learned it. See
[Battle Extensions](?page=unity/24-battle-extensions).
:::

`Game/CR.Game.Model/Missions/*` plus `BattleMissionService` / `BattleMissionEndpoints`
(`api/missions`) are an **unwired alternative design** — an in-memory `List<>` store with no
migrations, no DI registration and no route mapping. The live path is
`IBattleMissionTemplateRepository` + `MapBattleMissionTemplateEndpoints` described here.

### Battle lifecycle hygiene

A battle row is only closed by the normal end-of-battle paths, so force-quitting mid-battle leaves
`status = 'Active'` forever *and* strands the uncaptured wild creature as a live
`generated_creature` row. `StartBattleAsync` therefore sweeps first: any still-`Active` battle for
the starting trainer is marked `Abandoned` and run through `WriteBackHpAsync`, which soft-deletes
the stranded wild and clears its current-stats row. Without this, a dev save accumulated 12 stale
battles and 10 leaked wild creatures.

## Repository Layer

### `IBattleRepository`

```csharp
Task<Guid>    CreateBattleAsync(BattleRecord battle);
Task<BattleRecord?> GetBattleAsync(Guid battleId);
Task UpdateBattleStatusAsync(Guid battleId, string status, Guid? winnerId, DateTime? endedAt);
Task SetActiveCreatureAsync(Guid battleId, Guid trainerId, Guid creatureId);

Task CreateRoundAsync(BattleRoundRecord round);
Task<BattleRoundRecord?> GetRoundAsync(Guid battleId, int roundNumber);
Task<BattleRoundRecord?> GetCurrentRoundAsync(Guid battleId);

Task InsertRoundInputAsync(BattleRoundInputRecord input);
Task<IReadOnlyList<BattleRoundInputRecord>> GetRoundInputsAsync(Guid battleId, int roundNumber);

Task InsertActionLogAsync(BattleActionLogRecord entry);
Task<IReadOnlyList<BattleActionLogRecord>> GetActionLogAsync(Guid battleId);

// Standalone (in-battle, not condition-linked) stat changes, keyed by (battle, creature)
Task<IReadOnlyList<BattleStateStatChange>> GetStandaloneStatChangesByBattleCreatureAsync(Guid battleId, Guid creatureId);
Task UpsertStandaloneStatChangesByBattleCreatureAsync(Guid battleId, Guid creatureId, IEnumerable<BattleStateStatChange> statChanges);
```

Persistent HP and conditions are written through `IGeneratedCreatureRepository`:

```csharp
Task UpsertCurrentHitPointsAsync(Guid creatureId, int currentHp);
Task DeleteCurrentStatsAsync(Guid creatureId);
Task ApplyStatusConditionAsync(Guid creatureId, Guid statusConditionId, int? turnsRemaining, Guid? appliedInBattleId);
Task RemoveStatusConditionAsync(Guid creatureId, Guid statusConditionId);
Task<IReadOnlyList<GeneratedCreatureStatusCondition>> GetStatusConditionsAsync(Guid creatureId);
Task RemoveAllStatusConditionsAsync(Guid creatureId);
```

### Implementation

| Class | Location |
|-------|----------|
| `BaseBattleRepository` | `Game/CR.Game.Data/Implementation/BaseBattleRepository.cs` |
| `BattleRepository` (Postgres) | `Game/CR.Game.Data.Postgres/BattleRepository.cs` |
| `BattleRepository` (SQLite) | `Game/CR.Game.Data.Sqlite/BattleRepository.cs` |

### Record Types

Plain POCOs in `Game/CR.Game.Model/Battle/` — one file per table:

- `BattleRecord` — maps to `battle` (includes `Trainer1ActiveCreatureId` / `Trainer2ActiveCreatureId`)
- `BattleRoundRecord` — maps to `battle_round` (includes `ActiveTrainerId`)
- `BattleRoundInputRecord` — maps to `battle_round_input`
- `BattleCreatureSnapshot` — in-battle view of a creature (`TrainerId`, `CreatureId`, `CurrentHp`, `IsActive`), built from persistent creature tables; replaces `BattleCreatureStateRecord` in `BattleStateDto`
- `BattleActionLogRecord` — maps to `battle_action_log`
- `BattleAction` — represents a single submitted action (type, abilityId, itemId, etc.)
- `ActionOutcome` — full resolution result returned from `SubmitActionAsync` (includes `AbilityKey`, `ConditionsApplied`, `AttackerConditionsApplied`, `NeedsSwap`)
- `ActiveBattleCondition` / `ActiveStatChange` — live conditions used by the resolver and in `ActionOutcome`
- `ResolvedConditionDefinition` — pre-loaded condition + stat changes passed into the resolver (lives in `CR.Game.Model/Battle/`)

`GeneratedCreatureStatusCondition` (in `CR.Creatures.Data`) maps to `generated_creature_status_conditions`.

## `IBattleDomainService`

```csharp
public interface IBattleDomainService
{
    Task<BattleStartResult>  StartBattleAsync(Guid trainer1Id, Guid trainer2Id, string battleType, CancellationToken ct);
    Task<BattleStateDto?>    GetBattleStateAsync(Guid battleId, CancellationToken ct);
    Task<ActionOutcome>      SubmitActionAsync(Guid battleId, Guid trainerId, string roundKey, string actionsJson, CancellationToken ct);
    Task<bool>               IsBattleCompleteAsync(Guid battleId, CancellationToken ct);
}
```

`GetBattleStateAsync` returns `null` when the battle ID is not found. `InvalidOperationException` is reserved for invariant violations (submitting to an ended battle, wrong trainer for active turn, double submission).

### `StartBattleAsync`

1. Insert `battle` row (`status = "Active"`, `battle_type`)
2. For each trainer, load their team and set the first creature as active via `SetActiveCreatureAsync` (writes `trainer{1,2}_active_creature_id`). No per-battle creature rows are written.
3. Determine first-turn trainer by comparing the two active creatures' Speed stats (ties → trainer1)
4. Generate round 1 keys, insert `battle_round` row with `active_trainer_id`
5. Return `BattleStartResult` (includes `BattleId`, `ActiveTrainerId`, round keys)

### `SubmitActionAsync`

1. Validate battle exists + is Active
2. Load current round; verify `round.ActiveTrainerId == trainerId`
3. Validate round key
4. Guard against double-submission (unique constraint on `battle_round_input`)
5. Insert `battle_round_input`
6. Read attacker/defender active creature IDs from the `battle` record; build `CreatureSnapshot`s
7. Resolve the action immediately via `BattleResolver.Resolve()` (from `CR.Game.Compat`)
8. Persist HP **live** via `IGeneratedCreatureRepository.UpsertCurrentHitPointsAsync`, and apply/remove conditions via `ApplyStatusConditionAsync` / `RemoveStatusConditionAsync`
9. Write action log entry
10. Check battle-end condition (a creature fainted — but **only end the battle if the owner has no alive backup**, see *Force-Swap on Faint* below). The true winner is threaded through to battle end rather than recording any active-creature faint as an instant Loss.
11. If a creature fainted but its owner has an alive backup: keep the battle Active and set `ActionOutcome.NeedsSwap = true` (with `NextActiveTrainerId` = the trainer who must swap)
12. If battle not over and no swap is forced: create new round with `active_trainer_id = opposingTrainerId`
13. Return `ActionOutcome` including `NextActiveTrainerId` + `NextRoundKey`

HP is written on **every resolved action**, so a creature's damage persists immediately — no end-of-battle write-back step is needed.

### Snapshot Building (`BuildSnapshotAsync`)

For a `(battleId, creatureId)` pair the service loads the `GeneratedCreature` (which already carries `CurrentHitPoints` from the LEFT JOIN), then layers active modifiers:

- Persistent conditions from `GetStatusConditionsAsync`, resolved to their stat changes via `IAbilityRepository.GetStatusConditionsWithStatChanges`.
- In-battle standalone stat changes from `GetStandaloneStatChangesByBattleCreatureAsync(battleId, creatureId)`.

The resulting stat values are floored at 1 before being handed to the resolver.

### Wild Cleanup

When the battle ends, only the Wild Trainer's active creature needs cleanup: if it still belongs to the Wild Trainer (GUID `00000000-0000-0000-0000-000000000001`) and was not captured, it is soft-deleted and its `generated_creature_current_stats` row is cleared via `DeleteCurrentStatsAsync`. Player creatures keep their persistent current HP.

The method is `RetireUncapturedWildCreatureAsync`. It is **only ever called on a path that ends the battle**: draw, loss, win, a successful escape, or the stale-battle sweep at `StartBattleAsync`.

> **Only call it when the battle is over.** It used to also run on the force-swap branch — a branch where the battle *continues*. Soft-deleting the wild creature there removed the opponent from a live battle: it vanished from every `deleted = false` read, so the next `GetBattleStateAsync` produced no active wild creature, `WildBattleAIDomainService` could not find its own state, and it fell through to its `SerialiseRun()` fallback. The player was told they had **escaped** a battle they were still fighting, and lost the win, the XP and the loot. The name was part of the trap: the method was called `WriteBackHpAsync` and writes no HP at all — it only deletes.

## Shared Battle Engine (`CR.Game.Compat`)

The pure calculation logic lives in `Convenience/CR.Game.Compat/Battle/` (targets `netstandard2.1`, usable by both backend and Unity):

| Class | Purpose |
|-------|---------|
| `BattleResolver` | Static `Resolve(action, attacker, defender, abilityDef, resolvedConditions?, seed) → SingleActionResult` |
| `BattleActionParser` | `Parse(json) → List<BattleAction>`, `Serialise(actions) → string` |
| `CreatureSnapshot` | Input to resolver: creature stats + active conditions |
| `SingleActionResult` | Output: damage dealt, final HP, conditions applied/removed/triggered + `AttackerConditionsApplied` |
| `ResolvedConditionDefinition` | Pre-loaded condition + stat changes passed to resolver; avoids N+1 DB queries |

### Damage Formula

Physical/special damage is **data-driven** via a tunable `damage_curve` (see *Damage curves* below). `BattleResolver` applies a fixed formula *shape* whose constants come from the resolved curve:

```
levelFactor = curve.LevelCoeff × attackerLevel + curve.LevelConst
atkStat     = Physical ? Attack  : SpecialAttack
defStat     = Physical ? Defense : SpecialDefense
damage      = floor( levelFactor × Power × atkStat / max(1, defStat) / curve.Divisor + curve.FlatAdd )
              × STAB × typeMultiplier × ability.PowerMultiplier
Status:     damage = 0
```

- **STAB** (same-type attack bonus): when the attacker's element matches the ability's element (and is not `Normal`), damage is multiplied by `curve.StabMultiplier` (default 1.5). Computed in-resolver.
- **typeMultiplier**: elemental effectiveness from the `elemental_damage` table (attack element vs defender element), pre-resolved by `BattleDomainService` and passed into `Resolve` (1.0 when no mapping exists). The elemental table is loaded once per battle and cached — see *The active elemental damage version* below for which version it loads.
- **ability.PowerMultiplier**: per-ability scalar (1.0 default; e.g. 1.5 for a rare/legendary ability).
- Minimum damage is 1 for damaging abilities. Active `StatChange` modifiers are applied to snapshot stats before calling `Resolve`.

#### Damage curves (`damage_curve` table)

Damage tuning lives in a dual-DB (SQLite + Postgres) `damage_curve` table, authored as `DamageCurveDefinition` ScriptableObjects in Unity and synced from the Content Studio **Battle Tuning** tab.

| Column | Type | Notes |
|--------|------|-------|
| `content_key` | text (UNIQUE) | designer key; `"default"` is the global curve |
| `level_coeff` | float | `levelFactor = level_coeff × Level + level_const` |
| `level_const` | float | |
| `divisor` | float | normalization divisor (higher = less damage) |
| `flat_add` | float | flat damage added after normalization |
| `stab_multiplier` | float | same-type-attack bonus (default 1.5) |
| `deleted`, `created_at`, `updated_at` | — | soft-delete + timestamps |

An ability picks a curve via `abilities.damage_curve_key` (nullable → falls back to `"default"`); `abilities.power_multiplier` (float, default 1.0) scales that ability's damage. `BattleDomainService` resolves the effective curve (`ability.DamageCurveKey ?? "default"`, cached per battle) and passes it plus the pre-resolved `typeMultiplier` into `BattleResolver.Resolve` (the resolver stays pure / DB-free).

**REST:** `GET /api/v1/abilities/damage-curves` (list), `PUT /api/v1/abilities/damage-curves/{contentKey}` (upsert).

**Default curve:** `level_coeff = 0.4`, `level_const = 2`, `divisor = 50`, `flat_add = 2`, `stab_multiplier = 1.5` — seeded by migration `M1030`. The `abilities` columns are added by `M1031`.

### Accuracy Check

```
hits = random(0, 100) < ability.Accuracy   (seed-deterministic RNG)
```

Miss → no damage, no conditions, `ActionOutcome.Missed = true`.

### Condition Application

On an ability hit, `BattleResolver` iterates the `resolvedConditions` list passed by the caller. For each condition a probability roll is made; if it succeeds an `ActiveBattleCondition` is constructed with pre-rolled `StatChange` amounts and the condition's `DurationTurns` (or -1 for permanent). Conditions with `ApplyToUser = true` land in `SingleActionResult.AttackerConditionsApplied`; all others in `ConditionsApplied` (defender).

`BattleDomainService` bulk-fetches conditions via `IAbilityRepository.GetStatusConditionsWithStatChanges` (two queries: one for conditions, one JOIN for their stat changes) before calling the resolver. After resolution, defender conditions in `ConditionsApplied` are persisted to `generated_creature_status_conditions` via `ApplyStatusConditionAsync`; `result.ConditionsRemoved` is actually the **attacker's** expiring conditions (the confusing name is on the resolver's result type, not the target) and is never applied to the defender — the defender's own removals come only from `DefenderConditionsConsumed` (primers burned off by an elemental reaction). Attacker conditions in `AttackerConditionsApplied` are persisted the same way; the attacker's expiring/remaining conditions are reconciled separately (see `SingleActionResult.AttackerRemainingConditions` below). Both `ConditionsApplied` and `AttackerConditionsApplied` are included in the `ActionOutcome` returned to the client.

Miss → no conditions applied regardless of probability.

#### Conditions are content, and the content has to exist (M10005)

The engine above is only as real as the rows behind it. `M9990SeedGameData` seeded four status
conditions (Slow, Burn, Confusion, Grounded) but nothing populated `ability_status_conditions` or
`status_condition_stat_changes`, so in every database — Postgres and the baked SQLite floor alike —
**no ability inflicted anything and no condition had an effect**. Two consequences, neither obvious
from the code:

* Growl is the only Status-category ability in the game. Power 0 by design, no condition linked, so
  using it did nothing at all — and since the wild AI picks a status move 20 % of the time, roughly
  one enemy turn in five silently passed. It read as the opponent being unable to attack.
* The Pyromaniac battle mission ("apply Burn to the same target three times") could never complete,
  because nothing could apply Burn.

`M10005SeedAbilityStatusConditions` fills that gap: 22 ability→condition links (Fire→Burn,
Ice/Lightning→Slow, Poison→Poisoned, Ground→Grounded, Radiant→Confusion, Growl→Weakened), a stat
change per condition, and a `duration_turns` on every condition — a NULL duration reads as "lasts the
whole battle".

Two traps worth knowing before authoring more:

* **`damage_per_turn` and `healing_per_turn` on `status_conditions` are inert.** The resolver reads
  damage over time from a stat change with `impacted_stat = HealthPoints`, applied at the start of
  the afflicted creature's turn.
* **`BuildSnapshotAsync` honours only `Add` and `Subtract`.** A `Multiply` stat change silently does
  nothing, so amounts are flat and must be sized against real stat lines (at levels 1-10: attack
  9-14, defense 3-7, speed 23-35).

`probability` is read from the **condition**, not from the `ability_status_conditions` row, so a
condition's chance is the same for every ability that inflicts it.

### `SingleActionResult.AttackerRemainingConditions`

After resolving an action, `SingleActionResult` exposes `AttackerRemainingConditions` — the updated condition list for the attacker after start-of-turn DOT processing and turn-decrement. This list has:

- Permanent conditions (TurnsRemaining == -1) carried through unchanged.
- Conditions with TurnsRemaining > 1 decremented by 1.
- Conditions with TurnsRemaining == 1 moved to `ConditionsRemoved` and dropped from the list.

`BattleDomainService` syncs this list to `generated_creature_status_conditions` on every resolved action: conditions no longer present are removed via `RemoveStatusConditionAsync`, and remaining conditions are re-applied (updating `turns_remaining`) via `ApplyStatusConditionAsync`.

## Run / Escape Mechanics

When a trainer submits a `BattleActionType.Run` action, `BattleDomainService` resolves the attempt immediately using a deterministic escape formula rather than passing through to `BattleResolver`:

```
escapeChance = clamp(50 + (playerSpeed - wildSpeed) × 2, 10, 95)
roll = new Random(battleId.GetHashCode() ^ roundNumber).Next(0, 100)
escaped = roll < escapeChance
```

- **Escape succeeds:** battle status → `"Ended"`, `ActionOutcome.BattleOutcome = Escaped`, `ActionOutcome.BattleEnded = true`. The wild trainer's active creature is soft-deleted (player HP is already persisted).
- **Escape fails:** the opponent acts next — a new round is opened with `active_trainer_id = opponentId`, and `ActionOutcome.BattleEnded = false`. No round key is returned for the fleeing trainer.

The RNG is seeded deterministically from `battleId.GetHashCode() ^ roundNumber`, so the outcome for a given battle state is reproducible.

## Force-Swap on Faint

A battle no longer ends the instant a trainer's active creature faints. If the owner has **at least one alive backup creature** on their team, the battle stays Active and the trainer is required to swap in a replacement.

`BattleDomainService` resolves this via a private check `HasAliveBackupAsync(trainerId, activeCreatureId, ct)` — it loads the trainer's team and returns `true` if any creature other than the now-fainted active one still has HP. When the faint occurs:

- **Owner has an alive backup:** battle status stays `"Active"`, `ActionOutcome.NeedsSwap = true`, and `ActionOutcome.NextActiveTrainerId` is set to the trainer who must choose a replacement. No new round is opened until the swap is submitted.
- **Owner has no alive backup:** battle ends as before; the opponent is the winner.

The wild-trainer sentinel `00000000-0000-0000-0000-000000000001` has no team, so a fainting wild creature still ends the battle (player win) exactly as before.

> **Bug fix:** previously any active-creature faint was recorded as an instant Loss regardless of the remaining team. The backup-aware end check threads the **real** winner through to battle end.

## Switch Action

`BattleActionType.Switch` (enum value `3`) swaps the acting trainer's active creature for a backup. JSON payload shape:

```json
[{"type":3,"newCreatureId":"<guid>"}]
```

The handler validates the target creature is **owned by the acting trainer, alive, and not already active**, then sets it active via `SetActiveCreatureAsync` and passes the turn to the opponent (a new round is opened with `active_trainer_id = opponentId`). A Switch is the action a client submits in response to `ActionOutcome.NeedsSwap`.

### A rejected switch is not a turn

If validation fails, the server sets `ActionOutcome.SwitchRejected = true`, leaves the active creature alone, and re-opens the round for the **same** trainer (`NextActiveTrainerId = trainerId`, `NeedsSwap = true`) so they can pick again. It does not pass the turn to the opponent.

Clients must not animate a send-out when `SwitchRejected` is set. `BattleCoordinator.BuildSideContext` reads the flag directly; the older heuristic — "the acting creature differs from the one currently staged, so it must be a real swap" — is not safe after a faint, because the faint clears the staged id and a *rejected* switch then looks like a genuine one. That is what put a fainted creature back on the field.

The client also rolls back its optimistic HUD update on rejection, and the swap list refreshes team HP before it is drawn (see `BattleBagPanelHandler.LoadBattleDataAsync`) — battle damage is written straight to `generated_creature_current_stats` and raises no team-changed event, so a cached team shows fainted creatures as healthy and invites exactly the pick the server refuses.

## A creature that is already down does not act

`BattleResolver` fires start-of-turn damage-over-time before resolving the action. If that takes the
acting creature to 0 — or it was already at 0 when the action arrived — its action is **skipped
entirely**: no damage, no conditions applied, no reaction. `SingleActionResult.AttackerFaintedBeforeActing`
reports it. The turn still resolves; it just does nothing.

:::danger The corpse used to swing, and it cost the player the win
The reported sequence: the player burns the wild creature, the player's own creature is knocked out,
the player swaps in a replacement, the burn then kills the wild creature — **and the game announced a
defeat.**

Two faults compounded. The dying creature still landed a full attack (measured at 132 damage in the
reproduction) and took the freshly swapped creature with it. With no further backup that resolves as
`trainer1Lost` **and** `trainer2Lost`, which is a Draw — and a Draw carries no winner, so
`playerWon = outcome.WinnerId == playerTrainerId` is false and the summary renders a loss.

An existing test, `SubmitAction_BothCreaturesFaint_SameTurn_EndsInDraw`, had codified this: it put the
attacker on 0 HP and asserted the resulting Draw. It has been rewritten to assert the correct
behaviour — the 0-HP attacker does not swing, the defender survives, and the surviving trainer wins
outright.
:::

### A kill by damage-over-time still pays

The reward paths used to be gated on `trainerId == battle.Trainer1Id` — that is, only when the
player's *own action* felled the defender. A creature that dies to its own burn dies on **its own**
turn, so the acting trainer is the opponent, and the player got no experience and no loot for it. A
win worth nothing reads as the reward system being broken rather than as a rule.

The service now works out who died and who deserves the credit once:

```csharp
bool attackerFelledItself = result?.AttackerFaintedBeforeActing ?? false;

Guid? defeatedCreatureId = attackerFelledItself ? attackerCreatureId : defenderCreatureId;
Guid? creditedCreatureId = attackerFelledItself ? defenderCreatureId : attackerCreatureId;
Guid  creditedTrainerId  = attackerFelledItself ? opponentId : trainerId;
```

Experience, the defeated-creature lookup and the loot roll all key off those, so a condition kill pays
exactly like a direct one. This matters more now than it did: `Frozen` and the reaction damage
multipliers make condition-driven knockouts far more common.

## How battles are tested

Four layers, because each one catches a class the others cannot:

| layer | where | catches |
|---|---|---|
| Pure logic | `ElementalReactionTests`, `ElementalReactionInjectionTests`, `SwapStagingTests` | rule errors, in milliseconds |
| Validation | `ElementalReactionValidationTests`, `ElementalDamageMatrixValidationTests` | content the server would accept and the game could not use |
| Mocked service | `BattleDomainServiceTests`, `BattleConfigurationDomainServiceTests`, `BurnKillOutcomeTests` | branch and outcome logic |
| Repository, both engines | `ElementalReactionRepositorySqliteTests`, `ElementalReactionRepositoryPostgresTests` | boolean columns, uuid casing, fixed-point numerics |
| **End-to-end, real database** | `BattleEndToEndSqliteTests` | the seam mocks skip entirely |
| Content sweeps | `ReactionReachabilitySqliteTests`, `ElementalReactionTableSeedSqliteTests`, `PlaytestReadinessSqliteTests` | dead or unreachable content |
| HTTP | `ElementalReactionHttpTests`, `ElementalDamageHttpTests` | route wiring, scopes, status codes |

`ElementalReactionInjectionTests` pins the one thing the move to authored content could quietly
break: the resolver given `ElementalReactionTable.All` explicitly must produce exactly the same
result as the resolver given nothing at all — same reaction, same damage, same bonus, same log line,
same consumed primer — for every shipped rule.

The third layer is the one that was missing. Everything else was pure logic or mocks, and the bugs
that actually reach a playtest live in the gap between them: a condition applied in one turn has to
be written to `generated_creature_status_conditions`, read back through Dapper into the next turn's
snapshot, and matched **by name** against the reaction table. GUID casing, integer/boolean mapping or
a missing seed each break that chain while every mock in the codebase still passes.

`BattleEndToEndSqliteTests` runs the real `BattleDomainService` over the real SQLite repositories
against a fully migrated database with the real seeded content — only team membership is mocked. It
plays the whole Permafrost chain turn by turn, proves a primer survives a turn and is then consumed,
and replays the burn-kill sequence that produced the false defeat.

It was mutation-checked: removing the `attackerDownBeforeActing` guard makes it fail, and restoring
it makes it pass, so the suite is known to bite rather than merely being green.

`PlaytestReadinessSqliteTests` covers the content faults that ruin a session rather than a build —
a creature with no model, one that spawns knowing no moves or already dead, a duplicated pool entry
that silently doubles an encounter's odds, and a fractional `spawn_probability` (which makes Dapper
throw for the whole query, emptying an entire area's encounter table).

## Elemental Reactions

Synergy between elements, resolved in `BattleResolver` and therefore identical online and offline.
The rules are **authored content**: rows in the `elemental_reaction` table (Creatures domain,
`M12006CreateAndSeedElementalReaction`), served by `GET /api/v1/elemental-reactions` and loaded by
`BattleDomainService` once per battle. The conditions they need are content too, seeded by M10018.

Every reaction reads the same way — **one element primes, another detonates**:

| primer on the target | incoming element | reaction | result |
|---|---|---|---|
| `Soaked` | Lightning | **Conduction** | damage x1.75 |
| `Soaked` | Ice | **Flash Freeze** | damage x1.25, applies `Frozen` |
| `Frozen` | Ground | **Shatter** | damage x2.25 |

### The `elemental_reaction` table

| Column | Type | Notes |
|---|---|---|
| `id` | UUID | Authored id. The three seeded rules use `b1770000-0000-4000-8000-00000000000{1,2,3}` |
| `content_key` | VARCHAR(100) | Designer-facing key, snake_case, **unique across every row including soft-deleted ones** |
| `name` | VARCHAR(100) | Display name; also what `ElementalReaction` battle missions match on |
| `primer_condition` | VARCHAR(100) | `status_conditions.name`, matched case-insensitively |
| `detonator_element` | VARCHAR(50) | `ElementType` name, e.g. `Lightning` |
| `damage_multiplier` | DECIMAL(4,2) | `[0, 10]`. Applied to the ability's damage; 1.0 leaves it alone |
| `applied_condition` | VARCHAR(100) NULL | Condition the reaction leaves behind, or NULL |
| `log_line` | VARCHAR(255) | The sentence the battle log prints |
| `priority` | INTEGER | Ascending = evaluated first when a target carries more than one primer |
| `is_active` | BOOLEAN | False hides the rule from play without deleting the authored row |
| `deleted` | BOOLEAN | Soft delete |

`BattleResolver.Resolve` takes the rules as a parameter (`reactions:`) next to `reactionConditions:`.
Passing `null` falls back to `ElementalReactionTable.All` — the array that used to be the source of
truth is now the **seed default and the resolver's fallback**, and it carries the same ids, keys,
multipliers and priorities that `M12006` writes. A caller with no content layer still gets reactions;
a caller that loaded zero rules gets none, which is a different thing and is treated as such.

`ElementalReactionTable.Find(reactions, detonator, targetConditionNames)` skips inactive rules and
evaluates the rest in ascending `priority`, so the rule that fires never depends on the order the
rows happened to be read in.

### REST

| Route | Auth | Notes |
|---|---|---|
| `GET /api/v1/elemental-reactions` | authenticated | Active rules, priority order. What the game reads and the offline cache mirrors |
| `GET /api/v1/elemental-reactions/all?includeInactive=` | `content:write` | Everything non-deleted |
| `GET /api/v1/elemental-reactions/{id}` | `content:write` | 404 when missing |
| `PUT /api/v1/elemental-reactions/{id}` | `content:write` | Body `ElementalReactionUpsertRequest`. 200 saved row, 400 validation errors, 409 when another id holds the content key |
| `DELETE /api/v1/elemental-reactions/{id}` | `content:write` | 204 soft delete, 404 when already gone |

`ElementalReactionValidation.Validate(request, knownConditionNames, out errors)` is the whole rule
set as a pure function, so the endpoint and the Content Studio's inline form cannot disagree about
what will be accepted: snake_case content key, non-blank name and log line, a parseable element,
multiplier in `[0, 10]`, and primer/payload names that exist in `status_conditions`. A catalog read
that fails skips the last check rather than rejecting every save.

Writes are **update-then-insert**, not `ON CONFLICT`: the update also clears `deleted`, so re-pushing
a soft-deleted reaction revives it under its original id instead of forking a second row under the
same key — which the unique index would reject anyway.

That grammar is deliberate. A player who learns one reaction can guess the next, which is not true
of an arbitrary element-pair matrix.

### Why it is a team mechanic

The primer sits on the **target** and survives between turns, so the creature that sets a reaction up
does not have to be the creature that cashes it in. Soak with one creature, swap, and detonate with
another. Nothing extra tracks this — it falls out of conditions already being persisted per creature.

Reactions are symmetric: wild creatures and NPC trainers set them off under the same rules. The wild
AI picks by highest power and has no notion of setting a combo up, so it triggers them by accident
rather than by plan.

### Rules that keep it a play rather than a passive bonus

- **The primer is always consumed** (`SingleActionResult.DefenderConditionsConsumed`). Without that,
  a soaked target would detonate on every Lightning hit for the whole duration of Soaked, and the
  reaction would stop being something the team sets up.
- **Soaked is weak on its own** (-3 Special Defense). A primer that already hurts means the player
  casts Water for the debuff and never learns the follow-up.
- **Every Water ability soaks at probability 100.** A setup step that only sometimes works reads as
  the game being broken, not as variance.
- **A missed ability sets off nothing**, and a reaction whose payload condition is missing from
  content still deals its damage rather than failing the turn.

### Frozen is a defence collapse, not a skipped turn

"Lose your turn" reads better, but the engine has no such primitive: the round loop is strictly one
trainer per round and nothing consults a condition to decide whether a creature may act. Adding that
reaches into the turn loop and the client. `Frozen` therefore subtracts 6 Defense, 6 Special Defense
and 4 Attack for two turns — stats `BuildSnapshotAsync` genuinely applies — which is what makes the
Shatter follow-up land so hard.

Speed is deliberately **not** the lever: after the opening turn nothing in the resolver reads Speed
except escape chance, so a Speed debuff would have looked severe and done nothing.

### Making it reachable (M10019)

Rules nobody can perform are dead content that looks like a resolver bug. Reading the seeded world
back after M10018 showed how narrow the opening was:

- Every progression set was single-element plus Normal, so **no creature could perform a reaction on
  its own** — each one needed a specific two-creature team the player had no reason to assemble.
- Water first appears in `shore-wild-zone` (5-7); Lightning, Ice and Ground first appear in
  `cave-wild-zone` (9-12). The earliest possible reaction was level 9, and the Shore was spent
  applying Soaked with nothing in it able to exploit that.
- The Crags (15-24) and Dunes have detonator elements and **no Water at all**, so after the Cave the
  wild world could not set a reaction up again.

M10019 closes those with content only — no new art, reusing existing creature models:

| content | what it is for |
|---|---|
| **Drench** (Water, Status, power 0) | Applies Soaked without spending the turn's damage — the support play the team version wants. The resolver checks for a reaction even at 0 damage, so a pure Status move still primes. |
| **StormTide** set — Bubble, Bubble Beam, Spark, Thunderbolt | Conduction, solo. |
| **Permafrost** set — Drench, Ice Shard, Frost Bite, Earth Spike | The entire chain in one movepool: Drench, Flash Freeze, then Shatter. |
| Six spawner templates, levels 5-24 | Puts creatures carrying those sets in the Shore, Cave and Crags — including Water back into the Crags. |

**Why single-creature sets exist at all.** Reactions are deliberately a team mechanic, and that is a
fine design and a terrible tutorial: a player cannot discover a mechanic that only appears when they
happen to field the right pair. Permafrost runs the whole chain by itself, which is how a player
learns the grammar; the team version is what they do with it afterwards.

**Spawn probabilities stay at 1.** Every existing template in these pools uses 1, and mixing whole
numbers with fractions in a SQLite NUMERIC column makes Dapper plan the column from the first row and
then throw for the whole query. Rarity here would have cost a type-handling bug.

:::tip The reachability tests are the point
`ReactionReachabilitySqliteTests` walks the seeded world the way a player does — creatures obtainable
per zone, the moves their progression set teaches — and asserts every reaction has somewhere it can
happen, both solo and as a team. It reads the rules from the `elemental_reaction` table through the
real repository rather than from a list in the test, so authoring a reaction without content to
support it fails the build.

It has already earned its keep: it caught that `shore-wild-zone` (level 5) is where the player first
meets Soaked and originally had nothing that could exploit it — the first thing the mechanic would
have taught is that the condition does nothing.
:::

### In-combat quests

Reactions are also mission objectives. `BattleMissionTracker` gained an `ElementalReaction` mission
type whose `ConditionKey` holds the reaction name, and M10018 seeds three: Storm Chaser (two
Conductions), Cold Snap (two Flash Freezes) and Demolition (one Shatter). As with every mission type,
only the player's own actions count.

:::warning INSERT OR IGNORE hides a taken primary key
Storm Chaser initially used an id M10008 had already assigned to Pyromaniac. `INSERT OR IGNORE` is
not an error on a duplicate key — the row is simply skipped, so the mission never existed and nothing
anywhere said so. Two of three missions shipped and every test still passed, because they counted
rows rather than checking each reaction was represented. The tests now assert that every reaction in
the table has a mission asking for it, and that no two missions share an id.
:::

## The active elemental damage version

The type-matchup matrix is versioned: `elemental_damage` rows carry a `version` column, and
`battle_system_version.active_elemental_damage_version` names the one battles resolve against.

`BattleDomainService.ResolveTypeMultiplierAsync` used to ignore that pointer and take whichever
version sorted highest. Setting the active version therefore persisted and then changed nothing — a
silent no-op that looked like the matrix itself was wrong. The pointer wins now, with one guard:

> The active version is used **when it has rows**. Otherwise the highest version that does is used,
> and the fallback is logged.

The guard is not defensive padding. `M8002` seeds the pointer at `"v1.0"` while the matrix `M9990`
seeds is `"v1.1"`, so a database that has never had the pointer set names a version with no mappings
at all — and honouring that literally would resolve every matchup at 1.0 with nothing in the logs to
say why. `IBattleConfigurationDomainService.GetEffectiveActiveVersionAsync` applies the same rule for
the REST surface, so the version the API reports is the version battles actually use.

`M12008RepointActiveElementalDamageVersion` closes the seed gap itself: when the pointer names a
version with no rows it is moved to `MAX(version)` of `elemental_damage` (so a fresh database and
the baked offline floor both start at `v1.1`), and a pointer that already names a seeded version
is left alone — that one is a designer's choice. The fallback above stays, because a Studio
push can still delete the active version out from under the pointer.

### Negative multipliers

`M9990` seeded Radiant vs Radiant at `-5.0`, commented "drastically harms Radiant targets". It did
not: the resolver floors damage at 1, so the move dealt exactly 1 every time and a Radiant creature
was effectively immune to its own element. `M12007FixRadiantSelfMultiplier` sets it to `0.5` — what
"resisted" means everywhere else in the matrix — and validation now clamps every authored multiplier
to `[0, 10]`, in the endpoint, in `BattleConfigurationDomainService`, and in the Content Studio's grid.

The same migration widens the column from `DECIMAL(3,2)` to `DECIMAL(4,2)` on Postgres. The old
precision capped the value at 9.99, so a designer typing the top of the validated range would have hit
a numeric overflow instead of a readable error. SQLite has no fixed-precision numeric type, so the
widening is Postgres-only.

### REST

| Route | Auth | Notes |
|---|---|---|
| `GET /api/v1/elemental-damage?version=` | authenticated | One version's 100 cells; version omitted means the effective active one. 404 when the version has no mappings |
| `GET /api/v1/elemental-damage/versions` | authenticated | `{ versions, activeVersion }` — the version picker's single read |
| `PUT /api/v1/elemental-damage/versions/{version}` | `content:write` | Whole-matrix write. The **route version wins** over the body's, so a grid opened on one version and saved to another cannot overwrite the wrong matrix |
| `POST /api/v1/elemental-damage/versions/{version}/copy?from=` | `content:write` | 201 with the new matrix, 404 unknown source, 409 target exists. `from` omitted copies the active version |
| `PUT /api/v1/elemental-damage/active` | `content:write` | Body `SetActiveElementalDamageVersionRequest`. 404 for a version with no mappings |
| `DELETE /api/v1/elemental-damage/versions/{version}` | `content:write` | 204, 404 unknown, **409 when the version is active** — deleting what battles resolve against would flatten every matchup |

`ElementalDamageMatrixValidation.Validate` requires exactly one cell per ordered
`(offense, defense)` pair over every `ElementType` — 100 cells — because a version missing a square
resolves that matchup at 1.0 with nothing in the logs, which is indistinguishable from a designer
having chosen 1.0. `UpsertMatrixAsync` parses and range-checks the whole payload before writing
anything, so a rejected push never leaves half a version behind.

## Battle Experience

When the player (`Trainer1`) knocks out an opponent creature (`ActionOutcome.TargetFainted`), `BattleDomainService` awards XP through the existing `ICreatureProgressionService.ApplyExperienceAsync`, which handles level-up, stat growth (`growth_profile`), and ability unlocks.

- **Amount**: `5 × defeatedLevel` (tunable `XpPerDefeatedLevel`).
- **Split**: the fighter (the active creature at the KO) takes `1 − benchShare`; the remainder is divided evenly across the **living bench**. With no living bench, the fighter takes all of it.
- **`benchShare`** = base **10%** + the trainer's `exp_share_bonus_percent` stat (read via `IStatService`), clamped to `[10%, 100%]`.

Per-creature results are returned on `ActionOutcome.ExperienceAwards` (`CreatureId`, `Amount`, `LeveledUp`, `NewLevel`) for the client to render. XP is awarded on **every** opponent knockout, independent of whether the battle ends (so multi-creature trainer battles award per KO).

### EXP-share modifiers (items / skills)

Because `benchShare` reads the `exp_share_bonus_percent` trainer stat, any writer raises the bench's cut:

- **Item** — the `IncreaseExpShare` effect (`ItemEffectType = 12`) increments the stat by its `Percent` parameter (`IncreaseExpShareHandler` on the server; `OfflineItemUseService` mirrors it offline). The sample item `exp_share_charm` ("Mentor's Charm", seeded by `M6009SeedExpShareItem`) grants +20%.
- **Skill / perk** — any future progression that records to the same stat raises it identically.

## Whiteout Team Heal

When a trainer's whole team is knocked out, the team is fully restored via `ICreatureInventoryService.HealTeamAsync(trainerId, ct)` (`Game/CR.Game.Domain.Services`). For each team creature it sets `current_hit_points` to max — reviving fainted creatures — and clears all status conditions (`UpsertCurrentHitPointsAsync` + `RemoveAllStatusConditionsAsync`), returning the number restored. Unity injects the same domain service directly, so one implementation covers the server, Unity-online, and Unity-offline paths.

A REST surface is exposed for the server path (`Game/CR.Game.Service.BFF/Endpoints/TeamEndpoints.cs`):

| Method | Route | Description |
|--------|-------|-------------|
| `POST` | `/api/v1/trainers/{trainerId}/team/heal` | Full team heal + revive + status clear; returns `{ trainerId, healed }` |

The endpoint resolves the caller's account from the request context and requires it to own `trainerId` (else `404`), preventing one account from healing another's team (IDOR). The in-process Unity caller invokes the domain service directly as the owning session.

## Trainer Battles

`battle.battle_type` distinguishes `"Wild"` from `"Trainer"` — the string consts live in `CR.Game.Model.Battle.BattleTypes`. A trainer battle runs through the exact same `BattleDomainService` turn loop as a wild one; the differences are a handful of rules keyed off the battle type.

### The minted battle trainer (identity)

NPC rows are scoped to the *player's* `(accountId, trainerId)` for world isolation, so an NPC cannot fight using the player's own trainer id. Instead each trainer-type NPC gets a **minted battle trainer**: a real `trainers` row with its own `CreatureTeam` inventory, stored on `npcs.battle_trainer_id` (`M2012AddBattleTrainerIdToNpcs`). `NpcDomainService.MintBattleTrainerAsync` creates trainer + inventory inside one transaction and claims the column with a race-safe `UPDATE ... WHERE battle_trainer_id IS NULL`; the loser of a concurrent claim rolls back and re-reads. Because the battle trainer is a real trainer with a real team, `GetTeamAsync`, `HasAliveBackupAsync`, force-swap, and whiteout all work unchanged.

### Team slots are spawner templates

`NpcCreatureSlotSpec.SpawnerTemplateId` points a team slot at a `creature_spawner_template` row (species + exact level + growth profile + progression set). `EnsureNpcCreatureTeamAsync` generates each slot via the existing `CreatureGenerationService.CreateFromSpawnerAsync(templateId, battleTrainerId, seed)` — a trainer's team is literally spawner content, which the Unity authoring tooling hides entirely (see `unity/07-battle-system`).

### No running

`BattleActionType.Run` in a trainer battle is refused server-side **without consuming the turn**: the action is logged, the round is reopened for the *same* trainer, and the outcome returns `ActionOutcome.RunRefused = true` with `NextActiveTrainerId` still the fleeing trainer. The HUD hides the Run button and prints "You can't run from a trainer battle!" if it arrives anyway. This no longer loops forever: after `MaxConsecutiveRefusedRuns` (3) refused Runs in a row from the same trainer, the battle ends as that trainer's loss instead of continuing to reopen the round.

### No capture crystals

`ItemUseDomainService.UseItemAsync` refuses any capture crystal (`IsCaptureCrystal`: effect type
`CaptureCreature` or the `CaptureCrystal` usage flag) when the battle's other trainer is not
`WildTrainerId`, with `"Capture Crystals cannot be used in a trainer battle."` — a 400 from
`ItemEndpoints`, nothing consumed, turn not spent. The Unity bag greys the row and logs the refusal
first; see [Capture Mechanic → Refused in trainer battles](?page=unity/14-capture-mechanic).

### Heal on start

`StartBattleAsync` heals the opposing trainer's full team via `ICreatureInventoryService.HealTeamAsync(trainer2Id, ct)` when the battle type is Trainer, so a rematch never starts against a half-dead team.

### Boosted rewards + NPC loot

`BattleRewardScaling.TrainerBattleExperienceMultiplier = 1.5` and `TrainerBattleCurrencyMultiplier = 2.0` scale victory XP and currency. Loot adds a third owner type: `battle.opponent_content_key` (`M8017AddOpponentContentKeyToBattle`) is stamped at battle start, and `LootDomainService.RollVictoryLootAsync` unions the `Npc`-owned loot table (`LootOwnerType.Npc`) with the spawner- and creature-owned ones.

### Trainer AI

`TrainerBattleAIDomainService` (`ITrainerBattleAIDomainService`, registered in the AIO `Program.cs`) decides the NPC's turn:

1. **Forced swap** (`mustSwap`) → switch to the highest-HP alive backup.
2. **Low HP** (< 35% of the max HP seen for the active creature) with a heal in the bag → drink it.
3. **Otherwise** → delegate to the injected `IWildBattleAIDomainService` for the attack decision.

It never emits Run. Item turns mirror the player's two-step: apply the item effect via `POST /api/v1/npc/{npcId}/use-battle-item` (`NpcDomainService.UseNpcBattleItemAsync` — `RestoreHp`/`RestoreFullHp`, decrements the NPC's bag), then submit the `{"type":2,...}` action to consume the turn.

### Demo content

`M10020SeedMeadowDemoTrainer` seeds "Scout Maren" (`npc-trainer-meadow-scout`): a 3-slot spawner-template team (wolfpup lvl 4 / bud lvl 5 / crabby lvl 6), an `Npc`-owned loot table (heal potion @ 0.6 + 25–60 currency), and the `meadow-arena` battle arena key. Seed coverage: `Convenience/CR.Data.Migrations.Test/MeadowTrainerSeedSqliteTests.cs`; end-to-end coverage (run-refused, heal-on-start, boosted XP + NPC loot through real sqlite repos): `Game/CR.Game.Data.Test/TrainerBattleEndToEndSqliteTests.cs`; AI coverage: `Game/CR.Game.Domain.Services.Test/Battle/TrainerBattleAITests.cs`.

## Wild Trainer

A system "Wild" trainer with well-known GUID `00000000-0000-0000-0000-000000000001` is seeded by `M9990SeedGameData`. All spawned wild creatures are assigned to this trainer. When a battle ends, `WriteBackHpAsync` soft-deletes the wild trainer's active creature (if uncaptured) and clears its `generated_creature_current_stats` row.

## Wild Turn Endpoint

`POST /api/v1/battle/{battleId}/wild-turn` is called by the Unity client when `ActionOutcome.NextActiveTrainerId == WildTrainerId` in online mode. It calls `IWildBattleAIDomainService.DecideActionAsync()` and submits the result via `SubmitActionAsync`, returning the `ActionOutcome`.

`WildBattleAIDomainService` heuristics (in priority order):
1. 20% random chance → use a Status-category ability, **but only one that actually inflicts a
   condition**
2. Default → pick the highest-power non-Status ability

The status filter matters more than it looks. A Status ability deals no damage by design, so the
condition it applies is its entire contribution; picking one that inflicts nothing spends the turn on
nothing and shows the player no message explaining why. The roll is only made when such an ability
exists, so a creature whose only status move is inert never wastes a turn on it.

The AI loads abilities from the wild creature's own progression set when available. It looks up the
`GeneratedCreature` by `CreatureId`, reads `AbilityProgressionSetId`, and calls
`IAbilityRepository.GetAbilitiesForProgressionSetAtLevelAsync(setId, level)` to get only abilities the
creature has actually learned. The level comes from the battle state, falling back to the stored
`GeneratedCreature.Level` — it was once hardcoded to `1`, which pinned every wild creature to its
starting moves no matter how high its level. If the generated creature has no progression set, or if
the progression-set lookup fails, it falls back to `GetAbilitiesPaginated(0, 50)` — note that this
fallback lets a creature attack with moves it never learned, so it is a safety net, not a design.

The Unity client uses the same DLL `WildBattleAIDomainService` for offline battles, bound via `IWildBattleAIDomainService`.

## REST Endpoints

Defined in `Game/CR.Game.Service.BFF/Endpoints/BattleEndpoints.cs` and `WildBattleEndpoints.cs`:

| Method | Route | Description |
|--------|-------|-------------|
| `POST` | `/api/v1/battle/start` | Creates a battle; returns `BattleId` + first `ActiveTrainerId` + round key |
| `GET` | `/api/v1/battle/{id}/state` | Returns full `BattleStateDto` |
| `GET` | `/api/v1/battle/{id}/round-key?trainerId=` | Returns current round key for a given trainer |
| `POST` | `/api/v1/battle/{id}/submit` | Submits a trainer's action for the active turn; returns `ActionOutcome` |
| `POST` | `/api/v1/battle/{id}/run` | Attempts to flee; triggers escape-chance formula |
| `GET` | `/api/v1/battle/{id}/summary` | Returns post-battle summary (outcome, creature HP grid) |
| `POST` | `/api/v1/battle/{id}/wild-turn` | Triggers Wild AI turn (online mode only); body is empty `{}` |

All endpoints require bearer authentication.

In-battle mission content is served separately, from
`Game/CR.Game.Service.BFF/Endpoints/BattleMissionTemplateEndpoints.cs`:

| Method | Route | Policy | Description |
|--------|-------|--------|-------------|
| `GET` | `/api/v1/battle-missions` | *(host fallback: any authenticated user)* | All active, non-deleted rows, ordered by name. The game's content feed — response shape is frozen; Unity's `MissionDefinition` deserializes it |
| `GET` | `/api/v1/battle-missions/all?includeInactive=true` | `RequireContentWrite` | Every non-deleted row, ordered by name. `includeInactive=false` narrows it to active rows |
| `GET` | `/api/v1/battle-missions/{id:guid}` | `RequireContentWrite` | One row; `404` when missing or soft-deleted |
| `PUT` | `/api/v1/battle-missions/{id:guid}` | `RequireContentWrite` | Upsert. Returns `200` with the persisted row, in the same shape `GET` returns |
| `DELETE` | `/api/v1/battle-missions/{id:guid}` | `RequireContentWrite` | Soft delete. `204` on success, `404` when there is no live row |

`RequireContentWrite` is `CR.Auth.Service.REST.Security.AuthorizationPolicies.RequireContentWrite` —
the same policy the ability, spawner and ability-progression authoring routes use, satisfied by the
token the Content Studio gets from `POST /auth/service-token`. A player-scoped token gets `403`;
an anonymous caller gets `401` on every route here, including `GET ""`, because the host installs a
`RequireAuthenticatedUser` fallback policy (`CrAuthExtensions`). A repository throw returns
`Results.Problem` rather than a 500 stack, and the cancellation token is propagated to Dapper.

### Upsert validation

Enforced by `CR.Game.Data.Validation.BattleMissionTemplateValidation.Validate` — a pure static in
`CR.Game.Data`, which ships to Unity, so the Studio's form and the server cannot disagree about what
will be accepted. The first failure wins; the message is returned as `400 { "message": … }`.

| Rule | Message fragment |
|------|------------------|
| `contentKey` non-blank | `contentKey is required` |
| `contentKey` matches `^[a-z0-9]+(_[a-z0-9]+)*$` | `snake_case` |
| `name` non-blank | `name is required` |
| `missionType` ∈ `BattleMissionTypes.All` | `missionType must be one of` |
| `rewardType` ∈ `BattleMissionRewardTypes.All` | `rewardType must be one of` |
| `threshold` ≥ 1 | `threshold must be at least 1` |
| `conditionKey` non-blank when `missionType` is `StatusApplication` or `ElementalReaction` | `conditionKey is required` |
| `rewardAbilityId` present and non-empty when `rewardType` is `AbilityUnlock` | `rewardAbilityId is required` |

### Upsert, conflict and revive semantics

The route id is authoritative — a body `id` is ignored. Before writing, the endpoint looks the
`content_key` up **ignoring `deleted`**; if a *different* id holds it, the write is refused with
`409` naming the holder. So a content key belongs to one id for good: re-creating a deleted mission
means `PUT`ting its original id, which revives it.

`UpsertAsync` is update-then-insert rather than `ON CONFLICT`: the `UPDATE` also clears `deleted`,
so writing over a soft-deleted row revives it in place instead of leaving a second row under the
same key. An entity with `Guid.Empty` for its id adopts the id already holding its content key
(again ignoring `deleted`) before falling back to a fresh GUID. Booleans are passed as Dapper
parameters, never as `0`/`1`/`true` literals, and the id predicate is the one place the two engines
differ: SQLite compares `LOWER(id) = LOWER(@id)` because its ids are TEXT, while Postgres compares
a real `uuid` (which has no `lower()` overload). `updated_at` is set to `CURRENT_TIMESTAMP` on every
write.

## DI Wiring

```csharp
// Convenience/CR.REST.AIO/Program.cs

builder.Services.AddSingleton<IBattleRepository>(new BattleRepository(logger, configuration));
builder.Services.AddScoped<IBattleDomainService, BattleDomainService>();
builder.Services.AddSingleton<IWildBattleAIDomainService, WildBattleAIDomainService>();

builder.Services.AddScoped<IBattleMissionTemplateRepository>(sp =>
    new BattleMissionTemplateRepository(battleLogger, configuration));

// BattleDomainService takes both of these: reactions are authored content it loads at battle
// start, and the version pointer decides which matrix version the fight resolves against.
builder.Services.AddScoped<IElementalReactionRepository>(sp =>
    new CR.Creatures.Data.Postgres.ElementalReactionRepository(battleLogger, configuration));
builder.Services.AddScoped<IBattleSystemVersionRepository>(sp =>
    new BattleSystemVersionRepository(battleLogger, configuration));
builder.Services.AddScoped<IBattleConfigurationDomainService, BattleConfigurationDomainService>();

new GameDatabaseMigrator().Migrate(configuration);

app.MapBattleEndpoints();
app.MapWildBattleEndpoints();
app.MapBattleMissionTemplateEndpoints();
app.MapElementalReactionEndpoints();
app.MapElementalDamageEndpoints();
```

## Migrations

```
M8004CreateBattleTables              ← creates the battle tables
M8006AddActiveTurnToBattleRound      ← adds active_trainer_id to battle_round
M1029CreateGeneratedCreatureStatusConditionsTable  ← persistent per-creature conditions
M1017AddAbilityProgressionSetIdToBaseCreature  ← adds ability_progression_set_id (UUID NULL) to creature table
M9003AddAnimationKeyToAbilities      ← adds animation_key (VARCHAR NULL) to abilities table
M9990SeedGameData                    ← seeds Wild Trainer (guarded: skips if account table absent)
M9995DedupAbilitiesAndSeedAbilityFx  ← collapses duplicate ability rows onto canonical ids + seeds authored FX keys
M9996AddAbilityFxLifecycleColumns    ← adds fx_auto_stop (default true) + fx_stop_delay_ms (default 50) to abilities
M10003SeedMegaBurnAbility            ← (Creatures) seeds the Mega Burn reward ability
M10004CreateBattleMissionTemplateTable ← creates battle_mission_template + seeds mission_pyromaniac
M12006CreateAndSeedElementalReaction ← (Creatures) creates elemental_reaction + seeds the three shipped rules
M12007FixRadiantSelfMultiplier       ← (Creatures) Radiant vs Radiant -5.0 -> 0.5; widens damage_multiplier to DECIMAL(4,2)
M12008RepointActiveElementalDamageVersion ← (Creatures) moves a dangling battle_system_version.active_elemental_damage_version to MAX(version); guarded on both tables existing
M12009SeedElementalReactions_20260904 ← (Creatures, Studio export) authored reaction snapshot; upserts by content_key
M12010SeedElementalDamage_20260904    ← (Creatures, Studio export) authored v1.1 matrix snapshot; INSERT-if-absent by (offense, defense, version)
```

`M12009`'s and `M12010`'s `Down()` (like `M12005`'s) branch their id predicate by engine rather than
wrapping every id comparison in `LOWER()`: `lower(uuid)` is not a Postgres function, so the old
single-branch SQL threw `42883` on rollback there even though it worked on SQLite.
`M12010.Up()` also no longer overwrites `battle_system_version.active_elemental_damage_version` when
an operator has already pointed it at a real matrix version — it only sets the pointer when the
existing value is absent or dangling.

Additional migrations add `trainer{1,2}_active_creature_id` to `battle` and create `generated_creature_current_stats` for persistent HP.

`ability_progression_set_id` links a `creature` row to an `AbilityProgressionSet`, enabling wild AI to restrict ability selection to the abilities the creature has actually learned at its current level. `null` means no set assigned — the AI falls back to a global ability query.

`animation_key` on the `abilities` table drives client-side animation clip selection. `null` means the creature's `defaultAttackClip` (from `CreatureAnimationProfile`) is used instead.

### Canonical ability ids and FX-key seeding (M9995)

Ability ids accumulated duplicates across seed migrations: `M9990` seeded one set of rows while
the `M9994` demo seed added second rows for **Ember** and **Scratch** under different ids, and
progression entries pointed at the demo rows — which carried `NULL` in every `*_sfx_key`/`*_vfx_key`
column, so battles raised FX cues with empty keys and nothing played. The **canonical id for every
ability is the id its Unity `AbilityConfig` asset carries** (the id the Ability Workbench publishes
against). `M9995` remaps all references (`ability_progression_set_entry`, `ability_status_conditions`,
`generated_creature` slots) onto the canonical rows, soft-deletes the duplicates, and seeds the
authored FX keys (Ember + Hydro Pump starter set) so the baked floor carries them. Newly authored
FX must be added to a seed migration to survive a floor rebake — see the Ability Workbench page.

`fx_auto_stop` / `fx_stop_delay_ms` (M9996) control FX playback lifecycle: when on (the default),
each FX stage — cast, then projectile — is stopped `fx_stop_delay_ms` milliseconds after the next
stage starts, so looping effects don't play forever. The values ride the battle outcome
(`ActionOutcome.FxAutoStop`/`FxStopDelayMs`) into the client's `AbilityFxCue`; the responder cuts
particle emission (existing particles fade) rather than hard-destroying the instance. Authored per
ability in the Unity AbilityConfig **Advanced** section.

## Tests

### Domain Service Tests (`Game/CR.Game.Domain.Services.Test/`)

| Test | Verifies |
|------|---------|
| `StartBattle_FasterWildCreature_WildGoesFirst` | Speed-based first turn |
| `StartBattle_SpeedTie_PlayerGoesFirst` | Tie-breaking rule |
| `SubmitAction_PlayerTurn_ResolvesImmediatelyAndCreatesNextRound` | Sequential flow |
| `SubmitAction_WrongTrainerForActiveTurn_ThrowsInvalidOperation` | Turn order enforcement |
| `SubmitAction_PhysicalAbility_UsesAttackOverDefense` | Physical damage formula |
| `SubmitAction_SpecialAbility_UsesSpecialAttackOverSpecialDefense` | Special damage formula |
| `SubmitAction_StatusAbility_NoDamage` | Status ability handling |
| `SubmitAction_MissedAccuracy_NoDamageNoConditions` | Miss handling |
| `SubmitAction_TargetFaints_BattleEndsWithCorrectWinner` | Battle-end detection |
| `SubmitAction_BothCreaturesFaint_SameTurn_EndsInDraw` | Draw condition |
| `SubmitAction_AfterBattleEnded_ThrowsInvalidOperation` | Post-battle guard |
| `SubmitAction_RunAction_Escapes_WhenSpeedAdvantage` | Escape formula: 95% chance → succeeds |
| `SubmitAction_RunAction_Fails_WhenSlowerThanWild` | Escape formula: 10% chance → fails |
| `SubmitAction_ConditionDot_DamagesAttackerAtStartOfTurn` | DOT fires at start of turn |
| `SubmitAction_ConditionExpires_RemovedAfterTurnsElapse` | Expired conditions are removed |

### Resolver Condition Tests (`Game/CR.Game.Domain.Services.Test/Battle/BattleResolverConditionTests.cs`)

Pure logic tests — `BattleResolver.Resolve()` called directly with `ResolvedConditionDefinition` lists. Covers probability proc/miss, `applyToUser` routing to `AttackerConditionsApplied`, zero/null probability, amount range rolling, miss suppression, `DurationTurns` mapping to `TurnsRemaining`, and `null` resolved-conditions guard.

### Battle mission template tests

| Suite | Tests | Verifies |
|-------|-------|---------|
| `Game/CR.Game.Data.Test/BattleMissionTemplateRepositorySqliteTests.cs` | 12 | The seeded Pyromaniac row round-trips out of SQLite; inactive and soft-deleted rows are excluded from both readers; insert / update / id-adoption / revive-in-place upserts leave exactly one row per content key; `updated_at` moves on update; soft delete returns `false` the second time; content-key lookup is case-insensitive and can include deleted rows |
| `Game/CR.Game.Data.Test/BattleMissionTemplateValidationTests.cs` | 27 | Every validation rule, both directions, plus `ToEntity` preferring the route id over a body id |
| `Game/CR.Game.Data.Postgres.Test/BattleMissionTemplateRepositoryPostgresTests.cs` | 7 | The same authoring behaviour against real PostgreSQL — where the boolean columns, `uuid` comparison and `CURRENT_TIMESTAMP` all behave differently from SQLite |
| `Game/CR.Game.Domain.Services.Test/Endpoints/BattleMissionTemplateEndpointsTests.cs` | 26 | Handler-level status mapping: 200/empty/`Problem`/cancellation on the feed, `includeInactive` passthrough, 404s, the eight 400s, the 409 (and that neither ever reaches `UpsertAsync`), 204 vs 404 on delete |
| `Convenience/CR.Api.IntegrationTests/BattleMissionTemplateHttpTests.cs` | 10 | The whole stack: anonymous 401 everywhere, player-token 403 on every editor route but 200 on the feed, and an editor-token `PUT → GET /{id} → GET /all → DELETE → gone from both feeds` round trip using the same `/auth/service-token` exchange the Studio makes |

## Gotchas

**`BattleDomainService` must be `AddScoped`, not `AddSingleton`.** It depends on `IDbConnectionFactory` which opens scoped DB connections.

**`active_trainer_id` determines whose turn it is.** Do not compare round keys to decide who can submit — always check `round.ActiveTrainerId == trainerId`.

**`ActionOutcome.NextRoundKey` is single-use.** Returned from `SubmitActionAsync` for the next round; valid only until that round resolves.

**`ActiveBattleCondition` / `ActiveStatChange` are plain classes (not records) in `CR.Game.Model`.** Using `record` + `init` in a multi-TFM assembly causes `MissingMethodException` at runtime when the net8.0 build is loaded by a netstandard2.1 consumer. Condition objects are constructed with object-initializer syntax.

**HP and conditions are persistent, not per-battle.** A creature with `current_hp` damage carries it into the next battle and shows it in the team menu. To "heal" a creature, delete its `generated_creature_current_stats` row (`DeleteCurrentStatsAsync`) and its conditions (`RemoveAllStatusConditionsAsync`) — no row means full HP.

## Related Pages

- [Battle System](?page=unity/07-battle-system) — Unity client: `BattleCoordinator`, `IBattleClient`, session events
- [Battle Extensions](?page=unity/24-battle-extensions) — how `battle_mission_template` is consumed, and why mission progress never reaches the database
- [Backend Architecture](?page=backend/01-architecture) — DDD layering, repository pattern
- [NPC System](?page=backend/02-npc-system) — NPC trainer team seeding feeds creature states at battle start
- [Content Registry](?page=unity/08-content-registry) — content keys identify creature species in battle state
