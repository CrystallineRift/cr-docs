# Creature Generation

`ICreatureGenerationService` is the high-level factory for creating `GeneratedCreature` instances. It is called both by the NPC system (to create a starter creature for a trainer's first encounter) and by the Spawner system (to generate wild creatures from a template). Understanding how stats are calculated and how the service handles edge cases is critical for seeding content correctly.

## Why This Design?

### Why a Shared `ICreatureGenerationService` Across Domains?

Both the NPC starter flow and the Spawner system need to create `GeneratedCreature` rows. Rather than duplicating stat calculation logic in each domain, a single shared service owns all creature creation. The NPC domain calls `CreateAsync` with explicit parameters; the Spawner domain calls `CreateFromSpawnerAsync` which reads parameters from a `CreatureSpawnerTemplate` and then delegates to `CreateAsync`.

This means any change to stat calculation, ability assignment, or signing key generation automatically applies to all creature creation paths without coordinating changes across multiple domains.

### Why Are Stats Pre-Computed at Generation Time?

Stats are calculated and stored on the `generated_creature` row at creation, not re-computed from base stats + level every time the creature is fetched. The reasons:

1. **Query simplicity** — a single row fetch returns everything the battle system needs with no joins to `base_creature` + `growth_profile` at query time
2. **Stability** — if a designer changes a base creature's stats, existing generated creatures are not retroactively altered (intentional: captured creatures should not change after the trainer owns them)
3. **Offline consistency** — the Unity SQLite cache stores the pre-computed stats; they match what the server has without needing to re-derive them

## Interface

Source: `Game/CR.Game.Domain.Services/Interfaces/Creature/ICreatureGenerationService.cs`

```csharp
public interface ICreatureGenerationService
{
    // Create from an explicit request (name, level, nature, abilities…)
    Task<GeneratedCreature> CreateAsync(CreateCreatureRequest request, CancellationToken ct = default);

    // Create from a spawner template (used by the Spawner system)
    Task<GeneratedCreature> CreateFromSpawnerAsync(
        Guid spawnerTemplateId, Guid trainerId, int? seed = null, CancellationToken ct = default);

    // Validate a creation request before committing
    Task<bool> ValidateRequestAsync(CreateCreatureRequest request, CancellationToken ct = default);

    // Helpers for UI / tooling
    Task<IReadOnlyList<Guid>> GetAvailableAbilityProgressionSetsAsync(Guid baseCreatureId, CancellationToken ct = default);
    Task<IReadOnlyList<Guid>> GetAvailableGrowthProfilesAsync(Guid baseCreatureId, CancellationToken ct = default);
}
```

## `CreateCreatureRequest` Model

```csharp
public class CreateCreatureRequest
{
    public Guid BaseCreatureId { get; set; }         // required; which creature species
    public Guid GrowthProfileId { get; set; }        // required; which stat scaling curve
    public int Level { get; set; }                   // required; 1–100
    public Guid? TrainerId { get; set; }             // owner; null for unclaimed
    public Guid? AbilityProgressionSetId { get; set; } // null = no abilities assigned
    public string? GivenName { get; set; }           // null = use base creature name
    public Gender Gender { get; set; }               // Male, Female, Unknown
    public Nature FirstNature { get; set; }          // required
    public Nature? SecondNature { get; set; }        // optional
    public Nature? ThirdNature { get; set; }         // optional
    public IReadOnlyList<Guid>? HeldItemIds { get; set; } // up to 2 held items
    public int? Seed { get; set; }                   // for deterministic generation
}
```

## `CreateAsync` Internals

The implementation in `CreatureGenerationService` follows these steps:

1. **Validate** — calls `ValidateRequestAsync`; throws `ArgumentException("Invalid creature creation request")` on failure. Logs a specific `LogWarning` message per check so the reason is visible in the console.
2. **Fetch base creature** — `ICreatureRepository.GetCreature(BaseCreatureId)`; throws `ArgumentException` if null
3. **Fetch growth profile** — `IGrowthProfileRepository.Get(GrowthProfileId)`; throws if not found
4. **Build `GeneratedCreature`** — assigns all fields, calls `CalculateExperienceForLevel(level)`, calls `GenerateSigningKeyId(trainerId, baseCreatureId)`
5. **Calculate stats** — `CalculateBaseStats(creature, baseCreature, growthProfile, level)`
6. **Apply ability progression** — if `AbilityProgressionSetId` is set, calls `ApplyAbilityProgressionAsync`; this step does NOT throw on failure (errors are logged only) because missing abilities should not block creature creation
7. **Set held items** — assigns up to 2 held item IDs to `FirstHeldItemId` / `SecondHeldItemId`
8. **Persist** — `IGeneratedCreatureRepository.CreateCreatureForCapture(creature, "generated")`

> **Id ownership differs by engine.** The SQLite INSERT includes the `id` column, so the creature keeps
> the id assigned in step 4. The Postgres INSERT omits it and lets the column default mint one,
> returning it via `RETURNING id` — so `CreateCreatureForCapture` writes that value back onto
> `creature.Id` before returning. `CreateAsync` hands the same object back to its caller, and callers
> use `creature.Id` as a foreign key (NPC team seeding writes it into `npc_creature_team_storage` and
> `trainer_creature_inventory_items`). Without the write-back those rows referenced an id that existed
> nowhere on Postgres: the team read back empty and the team reset sweep soft-deleted nothing.

### Experience / Level Formula

The curve is a **table**, `level_experience_requirement`, not a formula evaluated at runtime.
`CreatureProgressionService` reads it row by row and walks the level up while the creature's total
clears the next threshold. Levels are a stored field; nothing re-derives a level from experience.

Seeded by **M10012** as:

```
base_required_experience = ROUND(0.8 × (level − 1)³  +  5 × (level − 1)²)
```

| Level | 2 | 5 | 10 | 20 | 50 | 100 |
|---|---|---|---|---|---|---|
| Total XP | 6 | 131 | 988 | 7,292 | 106,124 | 825,244 |

The **cube** is the shape that matters: it makes the cost of the next level grow like `2.4 × level²`,
which is the same order as the quadratic battle reward, so the two stay in proportion instead of
drifting apart.

The **square term exists to fix the opening**. Under the bare cubic this used to be, level 2 cost 1
experience, level 3 cost 6 and level 4 cost 22 — while a single first win pays 5. Measured against
the real reward curve, counting the fighter's 90% share after the bench cut:

| Your level | 1 | 5 | 10 | 20 | 50 | 100 |
|---|---|---|---|---|---|---|
| Battles per level, before | 0.25 | 1.53 | 2.52 | 3.50 | 4.43 | 4.84 |
| Battles per level, now | 1.50 | 2.94 | 3.63 | 4.25 | 4.80 | 5.05 |

Early levels still come quicker on purpose — they just are not given away.

:::note
Changing the curve is safe for existing saves. A creature's level is stored, not recomputed from its
experience, so raising the requirements demotes nobody; the next level simply costs more.
:::

### The growth profile is a bonus on what is earned

`growth_profile.experience_growth` is a percentage applied to experience **gained**: 150 pays half
again as much, 100 pays exactly what was earned.

It used to scale the level *requirement* instead, which inverted it — the profile named "Fast
Experience" (150) needed 50% more experience per level and was the slowest in the game. The level
curve is now identical for every creature; only the payout differs.

Two entry points, named rather than separated by a flag, because whether an amount is earned or
exact is a fact about the caller:

| Method | Growth bonus | Used by |
|---|---|---|
| `ApplyEarnedExperienceAsync` | applied | battle rewards, experience items, quest payouts |
| `ApplyExperienceAsync` | **not** applied | the level-up item, the admin grant endpoint |

That distinction has teeth: the level-up item computes precisely what the next level costs, so
scaling it would hand a 150% creature one and a half levels.

The bonus rounds **up**, so 1 experience at 150% is 2 — a trait that does nothing at exactly the
sizes you can verify by hand reads as broken. A profile that cannot be read grants the unmodified
amount rather than nothing.

### Stat Calculation

```
base_creature (base stats)
  × growth_profile (per-stat growth multipliers / 100)
  × level multiplier (1 + (level - 1) × 0.1)
  → final stat stored on generated_creature
```

The implementation:

```csharp
var levelMultiplier = 1.0 + (level - 1) * 0.1;

creature.HitPoints = (int)(baseCreature.BaseHitPoints * levelMultiplier
                          * (profile.HitPointsGrowth / 100.0));
// … same for Attack, Defense, Speed, SpecialAttack, SpecialDefense
```

A creature at level 1 uses `levelMultiplier = 1.0`. At level 10, `levelMultiplier = 1.9`. At level 100, `levelMultiplier = 10.9`. Growth profile values of `100` (meaning 100%) scale linearly with the base stat; values below 100 give a flatter growth curve; values above 100 amplify growth.

### Signing Key

```csharp
private string GenerateSigningKeyId(Guid? trainerId, Guid baseCreatureId)
{
    var timestamp = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
    var trainerPart = trainerId?.ToString("N")[..8] ?? "00000000";
    var creaturePart = baseCreatureId.ToString("N")[..8];
    return $"SK_{trainerPart}_{creaturePart}_{timestamp}";
}
```

The signing key is a string like `SK_ab12cd34_ef56gh78_1712345678`. It is stored on `generated_creature.signing_key_id` and is intended for future anti-cheat verification. The key is currently stored but not yet verified.

## `CreateFromSpawnerAsync` Internals

This method bridges the Spawner system to the creature generation pipeline:

1. Validate `spawnerTemplateId` and `trainerId` are non-empty
2. Fetch `CreatureSpawnerTemplate` — throws `InvalidOperationException` if not found or not active
3. `ResolveBaseCreatureIdAsync` — resolves the creature UUID with stale-reference fallback (see below)
4. `DetermineLevelFromTemplate` — picks a random level in `[template.MinLevel, template.MaxLevel]` using `seed` if provided; defaults to level 1 if no range set
5. `ResolveGrowthProfileIdAsync` — resolves the growth profile UUID with stale-reference fallback (see below)
6. Builds `CreateCreatureRequest` with `Gender = Unknown`, `FirstNature = default(Nature)`, and delegates to `CreateAsync`

### Stale-UUID Fallback {#staleuuid-fallback}

When the cr-api backend Postgres database is rebuilt (e.g., during development or a migration rollback), the UUIDs assigned to `BaseCreature` and `GrowthProfile` rows change. The SQLite offline cache (Unity) stores these UUIDs in `creature_spawner_template.base_creature_id` and `growth_profile_id`. If the server then re-syncs content with new UUIDs, the stored foreign keys become stale.

`ResolveBaseCreatureIdAsync` and `ResolveGrowthProfileIdAsync` handle this transparently:

1. **Fast path** — look up by UUID; return immediately if found.
2. **Fallback** — if not found AND the template stores `creature_content_key` / `growth_profile_name`, look up by that key/name instead.
3. **Self-heal** — update `template.BaseCreatureId` / `template.GrowthProfileId` with the newly resolved UUID and persist via `UpdateCreatureSpawnerTemplateAsync`. Subsequent calls hit the fast path.

The fallback keys (`creature_content_key`, `growth_profile_name`) are written to `creature_spawner_template` by `LocalSpawnerSyncClient` when syncing zone configs and `SpawnerDefinition` SOs (migration M5014).

> **Prevention:** `ServerContentSyncService.SyncCreaturesAsync` and `SyncGrowthProfilesAsync` now use `ON CONFLICT(content_key/name) DO UPDATE SET … (without id)` instead of `INSERT OR REPLACE`. This preserves existing UUIDs across re-syncs, eliminating the problem for healthy databases going forward.

### One id per species: `M10022AlignCreatureIdsToAuthored`

The template fallback above only covers `creature_spawner_template`. `generated_creature.base_creature_id` has no content-key fallback, and since `ICreatureRepository` became local-only in Unity, an online capture's server-minted `base_creature_id` is resolved against the local `creature` table alone. The seed migrations M9998/M10000 inserted twelve species under ids of their own; on Postgres those seeds lost to `uix_creature_content_key` (`ON CONFLICT DO NOTHING`) and the server kept the ids the Content Studio push had minted, while every SQLite database (baked floor, player save, online caches) kept the seed ids. Result: those twelve species resolved to nothing in online play — no model in battle, blank portrait — while Cindris/Crabby/Mudcalf (authored before any seed) kept working.

`M10022AlignCreatureIdsToAuthored` (Creatures domain) closes the split on every engine. The canonical id of a species is **the `id` on its `CreatureDefinition` asset** (which equals the dev server's id). For each species it first repoints every column that holds a base-creature id — `generated_creature.base_creature_id`, `creature.evolution_creature_id`, `creature_evolution.from/to_base_creature_id`, `creature_spawner_template.base_creature_id` — wherever it names either the row's current (different) id or the retired seed id, then moves `creature.id` onto the authored id. Rows already pointing at a retired seed id are repointed even when the local `creature` row never carried it (the server's case: captures pushed from offline saves under seed ids). Idempotent, `Schema.Table(...).Exists()`-guarded, `LOWER(CAST(... AS TEXT))` on SQLite and plain `=` on Postgres uuid. Covered by `CR.Data.Migrations.Test/CreatureIdAlignmentSqliteTests` (invariant: every species carries its authored id; no retired seed id survives; drifted row + all references converge; re-run is a no-op). The seed ids in M9998/M10000 are therefore transient — a fully migrated database never carries them, and new seeds should use the asset id directly.

## `BaseCreature` Model

`BaseCreature` is the template record for a creature species stored in the `creature` table. Key fields relevant to the generation pipeline:

| Field | Type | Notes |
|-------|------|-------|
| `Id` | `Guid` | Internal UUID primary key |
| `ContentKey` | `string` | Designer-facing identifier (e.g. `"cindris"`) — NOT NULL, UNIQUE (enforced by M1015) |
| `AssetKey` | `string?` | Addressables address or Resources path for the primary art asset (e.g. `"creatures/cindris"`). Replaced `AssetId: Guid?` in migration M1016. |
| `AbilityProgressionSetId` | `Guid?` | FK to `ability_progression_set_entry.ability_progression_set_id`; the default progression set for this species. Added by M1017. Null means no default set assigned. |
| `GrowthProfileId` | `Guid?` | FK to `growth_profile`; the default growth profile for this species. Added by M1018. Null means no growth profile is pinned to the template (spawner template overrides still apply). |
| `BaseHitPoints` | `int` | Base stat used by the generation formula |
| `BaseAttack` | `int` | — |
| `BaseDefense` | `int` | — |
| `BaseSpeed` | `int` | — |
| `BaseSpecialAttack` | `int` | — |
| `BaseSpecialDefense` | `int` | — |

> **Migration notes:**
> - `M1016ReplaceAssetIdWithAssetKeyOnCreature` dropped the `asset_id UUID` column and added `asset_key TEXT`.
> - `M1017AddAbilityProgressionSetIdToBaseCreature` added `ability_progression_set_id UUID NULL`.
> - `M1018AddGrowthProfileIdToBaseCreature` added `growth_profile_id UUID NULL`, linking a species template to its default growth curve.
> - `M1019NormalizeCreatureIdsToLowercase` normalises existing `id` values in the `creature` table to lowercase hyphenated format. Required because Dapper's `GuidTypeHandler` always writes lowercase UUIDs; migration seed data used uppercase literals, causing `WHERE id = @id` mismatches on SQLite's case-sensitive TEXT comparison.
> - `M1020NormalizeGrowthProfileIdsToLowercase` applies the same lowercase normalisation to `growth_profile.id`.

## `GeneratedCreature` Model

A `GeneratedCreature` is a live instance of a base `creature`. Key fields:

| Field | Notes |
|-------|-------|
| `id` | UUID primary key |
| `base_creature_id` | FK → `creature` |
| `growth_profile_id` | FK → `growth_profile` |
| `given_name` | Player-assigned name (defaults to base creature name) |
| `gender` | `"male"` / `"female"` / `"none"` / `"unknown"` |
| `first/second/third_nature` | Natures affecting stat modifiers |
| `first–fourth_ability_id` | Up to 4 active abilities (nullable) |
| `hit_points`, `attack`, `defense`, `speed`, `special_attack`, `special_defense` | Computed stats |
| `experience_points` | Current XP (encodes level) |
| `current_trainer_id` | FK → `trainers` |
| `first_caught_by_trainer_id` | Original trainer (set at generation, never changed) |
| `signing_key_id` | Anti-cheat signing key string |
| `first/second_held_item_id` | Nullable item IDs |
| `ability_progression_set_id` | Which progression set was used |

### Full Example: Generated Creature JSON

A level 10 Cindris with Hardy nature and standard growth profile (all growths = 100), base HP = 45, base Attack = 35:

```json
{
  "id": "12345678-0000-0000-0000-000000000001",
  "baseCreatureId": "aaaaaaaa-0000-0000-0000-000000000001",
  "growthProfileId": "bbbbbbbb-0000-0000-0000-000000000001",
  "givenName": "Cindris",
  "gender": "unknown",
  "firstNature": "hardy",
  "secondNature": null,
  "thirdNature": null,
  "firstAbilityId": "cccccccc-0000-0000-0000-000000000001",
  "secondAbilityId": null,
  "thirdAbilityId": null,
  "fourthAbilityId": null,
  "hitPoints": 85,
  "attack": 66,
  "defense": 57,
  "speed": 75,
  "specialAttack": 57,
  "specialDefense": 47,
  "experiencePoints": 800,
  "currentTrainerId": "dddddddd-0000-0000-0000-000000000001",
  "firstCaughtByTrainerId": "dddddddd-0000-0000-0000-000000000001",
  "signingKeyId": "SK_dddddddd_aaaaaaaa_1712345678",
  "firstHeldItemId": null,
  "secondHeldItemId": null,
  "abilityProgressionSetId": "eeeeeeee-0000-0000-0000-000000000001",
  "deleted": false,
  "createdAt": "2026-03-13T10:00:00Z",
  "updatedAt": "2026-03-13T10:00:00Z"
}
```

The stat formula: `HP = (int)(45 × 1.9 × 1.0) = 85`, `Attack = (int)(35 × 1.9 × 1.0) = 66`. Level multiplier at 10 = `1.0 + (10-1) × 0.1 = 1.9`.

## Natures

Each creature has up to three natures. Natures are enum values that influence stat growth multipliers applied by the `GrowthProfile`. The game currently stores nature as string representations.

Example natures: `"brave"`, `"timid"`, `"modest"`, `"jolly"`, `"adamant"`, `"hardy"` (neutral).

Starter creatures generated by `EnsureStarterNpcAsync` always receive `Nature.Hardy` (no stat modifier) so the player's first creature is not penalized by a random unfavorable nature.

## Growth Profiles

`growth_profile` defines how a creature's stats scale as it levels up:

| Column | Effect |
|--------|--------|
| `experience_growth` | XP curve steepness (reserved for future use) |
| `hit_points_growth` | HP scaling percentage (e.g., 120 = 20% above base linear) |
| `attack_growth` | Attack scaling percentage |
| `defense_growth` | Defense scaling percentage |
| `speed_growth` | Speed scaling percentage |
| `special_attack_growth` | Sp. Attack scaling percentage |
| `special_defense_growth` | Sp. Defense scaling percentage |

Growth profile values of 100 are neutral linear scaling. Values above 100 produce faster-than-linear growth; below 100 produce slower growth.

### How to Configure a Growth Profile in game_config.yaml

Growth profiles are defined in `cr-data/Assets/Scripts/Data/game_config.yaml`. A typical entry:

```yaml
growth_profiles:
  - content_key: "growth_cindris_standard"
    name: "Cindris Standard"
    experience_growth: 100
    hit_points_growth: 110      # slightly tankier than baseline
    attack_growth: 120          # strong physical attacker
    defense_growth: 90          # fragile defensively
    speed_growth: 130           # fast
    special_attack_growth: 80   # weak special attacker
    special_defense_growth: 90
```

The `content_key` here must match the `content_key` column in the `growth_profile` database table. Designers add entries to the YAML file; the Unity world bootstrap reads them and calls the backend to upsert rows on startup. The database row's `id` (UUID) is what gets stored on `generated_creature.growth_profile_id` — never use the `content_key` as a foreign key.

After adding a new growth profile to YAML, run the game in Unity and the backend `GameInitializer` will upsert it to the database. You can then reference its UUID in spawner templates and NPC slot specs.

## Ability Progression

`ability_progress` records what abilities a creature can learn at each level for a given `set_name`. The generation service:

1. Calls `GetAbilityProgressAtLevelAsync(baseCreatureId, level)` to get all progression entries up to the target level
2. Filters by `ap.SetName == abilityProgressionSetId.ToString()`
3. Sorts by level ascending
4. Takes the first 4 entries and assigns them to `FirstAbilityId` through `FourthAbilityId`

### How Ability Progression Is Set Up at Generation Time

The creature generation call picks the first available ability progression set for the base creature. From `EnsureNpcCreatureTeamAsync` in the actual implementation:

```csharp
var abilitySets = await _creatureGenerationService.GetAvailableAbilityProgressionSetsAsync(
    slot.CreatureBaseId, ct);
var abilitySetId = abilitySets.Count > 0 ? abilitySets[0] : (Guid?)null;

var creature = await _creatureGenerationService.CreateAsync(new CreateCreatureRequest
{
    BaseCreatureId = slot.CreatureBaseId,
    Level = 1,
    GrowthProfileId = growthProfiles[0],
    AbilityProgressionSetId = abilitySetId,   // ← null if no sets exist
    TrainerId = trainerId,
    FirstNature = Nature.Hardy,
    Gender = Gender.Unknown,
    Seed = Guid.NewGuid().GetHashCode(),
}, ct);
```

If `abilitySetId` is null (no progression sets configured), the creature is created with all four ability slots null. This is not an error — it means the creature simply has no moves at generation time.

If `abilitySetId` is set but no `ability_progress` rows exist for that set at the requested level, the creature is created with null abilities (the failure is logged but does not throw).

**Edge case:** If `GetAvailableAbilityProgressionSetsAsync` is called for a base creature, it returns set IDs extracted from `ability_progress.set_name` where the set_name parses as a GUID. If designers use non-GUID set names (e.g. `"starter_set"`), they will not appear in this list. Use UUID-formatted set names stored in the progression entries.

## Quest-gated abilities

`ability_progression_set_entry.unlock_quest_content_key` (added by **M5019**, Spawner domain) turns an
entry into a quest reward. `NULL` — the default, and what every pre-existing row has — means the old
behaviour: learn it on reaching `level`. A non-null value means reaching the level is necessary but
not sufficient; the creature's owning trainer must also have **completed** the quest with that
`content_key`.

A `content_key` rather than a `quest_template.id` because progression sets are Spawner-domain content
and quest templates are Quests-domain content, authored independently in Unity. A designer-facing
string keeps the two domains from needing a foreign key across the seam, and survives a quest
template being re-pushed under a fresh id.

### The gate

`CreatureProgressionService` (Game domain — it is the only layer that already references both Quests
and Spawner) makes the decision through one pure helper:

```csharp
// CR.Game.Domain.Services/Implementation/Creature/AbilityUnlockGate.cs
public static bool IsUnlocked(string? unlockQuestContentKey, ISet<string> completedQuestKeys)
```

- A null/blank gate is always unlocked.
- Otherwise the key must appear in the completed set.
- A null or empty set reads as "nothing completed" — the gate **fails closed**. A trainer row that
  cannot be read, or a quest lookup that throws, leaves the ability locked rather than granting it.

Completed keys come from `IQuestInstanceRepository.GetCompletedInstancesAsync` (account id resolved
via `ITrainerRepository.GetTrainerById`), mapped to content keys through
`IQuestTemplateRepository.GetTemplateAsync`. Repositories, not `IQuestDomainService`: the quest
service depends on `IRewardGrantService`, which now depends on `ICreatureProgressionService`, so
injecting the service here would close a DI cycle.

Three call sites use the same rule:

| Call site | Behaviour |
|---|---|
| `ApplyAbilityChangesForLevelAsync` | A gated entry at the new level is skipped (logged at Debug) while its quest is unfinished. Completed keys are read **once per level**, and not at all when nothing at that level is gated. |
| `CanLearnAbilityAsync` | An ability reachable only through gated entries returns `false` until one of those quests is completed. An ungated route to the same ability short-circuits with no quest lookup. |
| `ApplyQuestUnlocksAsync` | The retroactive pass — see below. |

### Retroactive unlock on quest claim

```csharp
Task<IReadOnlyList<Guid>> ApplyQuestUnlocksAsync(
    Guid accountId, Guid trainerId, string questContentKey, string? onlyAbilityContentKey,
    CancellationToken ct = default);
```

Without this, a creature that passed the entry's level long before finishing the quest would wait for
its next level-up to receive the reward — or never, at level 100. `RewardGrantService` calls it when
it handles a `RewardType.Ability` grant (see
[Quest System → Ability rewards](07-quest-system.md#ability-rewards-quest-gated-ability-unlocks)).

For every creature the trainer owns (team and storage; paged 200 at a time, capped at 25 pages), it
teaches each active entry gated on `questContentKey` where `entry.Level <= creature.Level` and the
ability is not already known. `onlyAbilityContentKey`, when supplied, restricts the grant to entries
whose ability has that content key. Slot assignment and replacement use exactly the same path as
level-up (`ApplyAbilityToCreatureAsync`), and each creature is written **once** regardless of how
many abilities it learned. Returns the ids of the creatures that changed.

Entries are read once per distinct progression set, not once per creature — a full team commonly
shares one set.

### Authoring

The field round-trips through the Content Studio surfaces:

- `POST /api/v1/ability-progression/sets/{id}/entries` — `unlockQuestContentKey` on the request and response
- `POST /api/v1/ability-progression/sets/sync` — `unlockQuestContentKey` per entry; a changed gate on an
  existing (level, slot) pair updates the row in place
- `GET /api/v1/ability-progression/sets` — `unlockQuestContentKey` per entry

## Ability Status Condition Endpoints

Three endpoints manage inline status conditions on abilities. All use inline Dapper SQL against the `CreatureDatabase` connection string (not the keyed `IAbilityRepository`).

### `GET /api/v1/abilities`

Returns a paginated list of abilities with an embedded `conditions` array on each ability. The response is enriched via a multi-join query:

```
ability_status_conditions → status_conditions → status_condition_stat_changes → stat_changes
```

Conditions and stat changes are filtered to `deleted = false`. The join uses `ANY(@ids)` for a single round-trip regardless of page size.

Response shape per ability:
```json
{
  "id": "...",
  "contentKey": "flame-pounce",
  "name": "Flame Pounce",
  "elementType": 1,
  "conditions": [
    {
      "name": "Burn",
      "applyToUser": false,
      "probability": 30,
      "durationTurns": 3,
      "statChanges": [
        { "impactedStat": "Attack", "calculation": "Subtract", "amountMin": 10, "amountMax": 10, "durationTurns": 3 }
      ]
    }
  ]
}
```

`durationTurns` on each `statChange` is `-1` when `duration_kind != 'Turns'` or `duration = -1`.

:::info abilities.content_key (M10011)
Unlike every other content table, `abilities` historically had no `content_key` — only `id` (server-generated) and `name` (not unique). A client syncing abilities was forced to key on `id`, so any server-side id drift (e.g. a dedup pass, or a reseed) inserted a duplicate row instead of updating the existing one in place. `M10011AddContentKeyToAbilities` adds a nullable `content_key` column, backfills it deterministically from each ability's name (kebab-case, e.g. `"Fire Blast"` → `"fire-blast"`, de-duplicating collisions with a numeric suffix), and adds a partial unique index (`WHERE content_key IS NOT NULL`) on both engines. `contentKey` is now on `BaseAbility` and included in the `GET /api/v1/abilities` response above — clients should reconcile synced abilities on `content_key`, not `id`.
:::

### `POST /api/v1/abilities/{id}/sync-conditions`

Atomically replaces all status conditions for an ability. Body is a JSON array of condition entries:

```json
[
  {
    "name": "Burn",
    "applyToUser": false,
    "probability": 30,
    "durationTurns": 3,
    "statChanges": [
      { "impactedStat": "Attack", "calculation": "Subtract", "amountMin": 10, "amountMax": 10 }
    ]
  }
]
```

**Cascade order (teardown):**
1. For each old `status_condition_id`: soft-delete its `stat_changes`, hard-DELETE `status_condition_stat_changes`
2. Hard-DELETE `ability_status_conditions` for this ability
3. Soft-delete old `status_conditions`

**Cascade order (rebuild):**
1. INSERT new `status_conditions` (`type = 'ability'`, `duration_turns` = request value or NULL if -1)
2. INSERT new `stat_changes` (`duration_kind = 'Turns'`, `duration = condition.DurationTurns`)
3. INSERT `status_condition_stat_changes` join rows
4. INSERT `ability_status_conditions` join rows

Returns `{ "conditionCount": N }` on success. Returns 404 if the ability does not exist or is soft-deleted.

> **Schema note:** `ability_status_conditions` and `status_condition_stat_changes` have no `deleted` column; they are hard-deleted during sync and rebuild.

### `GET /ability/status_conditions`

Returns a paginated list of all status conditions (not scoped to a specific ability). Used by the Unity `ItemDefinitionEditor` condition picker to populate `CureStatus` and `HeldStatusImmune` dropdowns.

Query params: `offset` (default 0), `limit` (default 100). Uses `[FromKeyedServices("AbilitiesDB")] IAbilityRepository.GetStatusConditionsPaginated(offset, limit)`. Returns `IEnumerable<BaseStatusCondition>`.

### `DELETE /api/v1/abilities/{id}`

Soft-deletes an ability and cascades through all its conditions:

1. 404 if the ability is not found or is already deleted
2. Same cascade teardown as sync-conditions (hard-delete join rows, soft-delete conditions and stat changes)
3. Soft-deletes the `abilities` row itself (`deleted = true, updated_at = now()`)

Returns `{ "id": "..." }` on success.

## Creature List and Upsert Endpoints

Three endpoints support the Unity Content Creator bidirectional sync:

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/v1/creatures` | Returns all `BaseCreature` rows, paginated. Query params: `offset` (default 0), `limit` (default 500). Response includes all base stat fields, `contentKey`, `assetKey`, `elementType` (int), `abilityProgressionSetId` (nullable UUID), and `updatedAt`. Uses `[FromKeyedServices("CreatureDB")]` `ICreatureRepository`. |
| `PUT` | `/api/v1/creatures/by-content-key/{contentKey}` | Upserts a `BaseCreature` row by `content_key`. If the row exists it is updated in-place; if not it is inserted. Uses ANSI `INSERT … ON CONFLICT (content_key) DO UPDATE SET …` — works on both SQLite and Postgres. Body is a full `BaseCreature` JSON object (all stats + `elementType`, `assetKey`, `abilityProgressionSetId`). Returns `{ contentKey }` on success. |
| `DELETE` | `/api/v1/creatures/by-content-key/{contentKey}` | Soft-deletes the `BaseCreature` row. **Player-data guard:** first counts rows in `generated_creature WHERE NOT deleted AND base_creature_id = @id`. If any trainer-owned creatures reference this species, returns **409 Conflict** with `{ "message": "X trainer creature(s) are based on this species. Remove them before deleting the template." }`. Otherwise sets `deleted = true` and returns 204. Implemented via `IGeneratedCreatureRepository.CountByBaseCreatureIdAsync`. |

These endpoints are registered in `Creatures/CR.Creatures.Service.REST/Endpoints/CreatureEndpoints.cs` alongside the existing creature endpoints.

## Growth Profile List Endpoint

`GET /api/v1/growth-profiles` returns a paginated list of all growth profiles. Query parameters: `offset` (default 0) and `limit` (default 500). Uses the `[FromKeyedServices("CreatureDB")]` `IGrowthProfileRepository`. This endpoint is consumed by the Unity `AbilityLibraryTool` bidirectional sync to compare server-side growth profiles against local `GrowthProfileConfig` ScriptableObjects.

## `GetAvailableGrowthProfilesAsync` Gotcha

Currently this method returns **all** growth profiles in the database rather than filtering to profiles that are compatible with a specific base creature:

```csharp
// For now, return all growth profile IDs
// In a real implementation, this would filter based on creature type, rarity, etc.
var growthProfiles = await _growthProfileRepository.GetPaginated(0, 1000);
```

If you have more than 1,000 growth profiles, this call truncates silently. The method will be replaced with a creature-specific compatibility query when the growth profile compatibility table is added. For now, always keep the `growth_profile` table under 1,000 rows.

## DI Registration

```csharp
// Server (Program.cs via AddGameDomainServices extension)
builder.Services.AddSingleton<ICreatureGenerationService, CreatureGenerationService>();

// Unity (LocalDevGameInstaller.cs)
Container.Bind<CR.Game.Model.Creatures.ICreatureGenerationService>()
    .To<CR.Game.Domain.Services.Implementation.Creature.CreatureGenerationService>()
    .AsSingle();
```

## Ability FX keys must match the catalogue exactly

Combat was silent and effect-less, and neither showed up as a fault. Two causes:

- **33 of 36 abilities had no sound keys at all.** `PlaySfxAsync` returns immediately on an empty
  key — an early return, not an error — so nothing played and nothing was logged.
- **The keys that did exist named addressables that do not.** The data said
  `sfx/sfx-fireball-cast` while the catalogue carries `sfx/sfx-fireball-cast-audio`; the visual keys
  had the same shape of mistake against a `-effects` suffix, and three named nothing at all. An
  off-by-a-suffix key is indistinguishable from silence.

`M10017SeedAbilitySoundKeys` fills every ability by element and category, and repoints the wrong
keys. Two tests pin it: every ability has a cast and an impact sound, and **every key names one of
the addressables the project actually ships**. That second test is the important one — the catalogue
is not readable from the backend, so the known set is listed explicitly and has to be updated
deliberately when audio is added.

These are placeholders and the migration says so: the project owns seven combat sounds, so elements
share them. Replacing one key with a purpose-made clip is the intended next step, and keys are
per-ability precisely so it can be done one at a time.

## One curve, not two

`GrowthProfileDomainService.GetExperienceRequiredForLevelAsync` reads
**`level_experience_requirement`** — the same table `CreatureProgressionService` levels a creature
on. It has to, because it used to compute a curve of its own:

```
100 * level^3 * (experience_growth / 100)
```

Nothing else in the game used that formula, but the team and storage screens did, so the player was
told level 2 costs **700** experience and level 3 another **1900**, while the thresholds a creature
actually levels on — recurved by M10012 to `ROUND(0.8(L-1)³ + 5(L-1)²)` — are **6** and **26**.
Battles pay out around 5. The progression was fine; only the number on screen was wrong, and it made
the game look unplayable.

Two things follow, and both are easy to undo by accident:

- **The growth profile is not applied to the requirement.** `experience_growth` scales what a
  creature EARNS (`CreatureProgressionService.ApplyGrowthBonusAsync`). Scaling the requirement too
  charges the bonus twice, so a 150% profile would level no faster than a 100% one.
- **A displayed number and a gameplay number must come from one source.** Any second copy of a curve
  is a curve that will drift, and it drifts silently — nothing fails, the screen just lies.

There are still private `CalculateLevelFromExperience` helpers in `CreatureProgressionService`,
`CreatureInspectionService` and one Unity view. `creature.Level` is the source of truth and those
should not be used to derive it — see the level-source-of-truth note.

## Common Mistakes / Tips

- **Forgetting to seed growth profiles before calling `EnsureStarterNpcAsync`.** `GetAvailableGrowthProfilesAsync` returns all profiles; if the table is empty, `EnsureStarterNpc` throws. Always run the growth_profile seed migration before the NPC seed migration.
- **Level out of range.** `ValidateRequestAsync` rejects levels outside `[1, 100]`. If you see `ArgumentException: Invalid creature creation request` with no further detail, check the level field.
- **Ability progression set name format.** Set names must be valid GUIDs for `GetAvailableAbilityProgressionSetsAsync` to include them. If you named a set `"default"` or `"starter_set"`, it will not appear in the returned list.
- **Ability failures don't block creation.** If ability assignment fails (e.g., progression entries missing from the DB), the creature is still created with null ability IDs. Check logs for `Error applying ability progression` messages.
- **Nature enum default.** `default(Nature)` in C# is the enum's zero value. Make sure the zero value of the `Nature` enum is `Hardy` (neutral) rather than an invalid or harmful state. The starter NPC flow explicitly passes `Nature.Hardy` to avoid relying on the default.
- **Growth profile UUID vs content_key in spawner templates.** Spawner templates store `growth_profile_id` (UUID). You cannot put a `content_key` string there. Look up the UUID from the `growth_profile` table and use that.
- **`GetAvailableGrowthProfilesAsync` is not filtered by base creature.** Passing a `baseCreatureId` to this method currently does nothing — it returns all 1,000 growth profiles regardless. When the compatibility table exists this will change. For now, `EnsureNpcCreatureTeamAsync` picks `growthProfiles[0]`, so the order in which the DB returns profiles matters.

## Related Pages

- [Spawner System](?page=backend/03-spawner-system) — calls `CreateFromSpawnerAsync` for wild creature generation
- [NPC System](?page=backend/02-npc-system) — calls `CreateAsync` for starter creature creation
- [Starter Creature Flow](?page=backend/05-starter-creature-flow) — end-to-end walkthrough showing where creature generation fits
- [Backend Architecture](?page=backend/01-architecture) — DI wiring, module structure
