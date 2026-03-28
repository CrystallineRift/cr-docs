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

1. **Validate** — calls `ValidateRequestAsync`; throws `ArgumentException` on failure
2. **Fetch base creature** — `ICreatureRepository.GetCreature(BaseCreatureId)`; throws if not found
3. **Fetch growth profile** — `IGrowthProfileRepository.Get(GrowthProfileId)`; throws if not found
4. **Build `GeneratedCreature`** — assigns all fields, calls `CalculateExperienceForLevel(level)`, calls `GenerateSigningKeyId(trainerId, baseCreatureId)`
5. **Calculate stats** — `CalculateBaseStats(creature, baseCreature, growthProfile, level)`
6. **Apply ability progression** — if `AbilityProgressionSetId` is set, calls `ApplyAbilityProgressionAsync`; this step does NOT throw on failure (errors are logged only) because missing abilities should not block creature creation
7. **Set held items** — assigns up to 2 held item IDs to `FirstHeldItemId` / `SecondHeldItemId`
8. **Persist** — `IGeneratedCreatureRepository.CreateCreatureForCapture(creature, "generated")`

### Experience / Level Formula

```csharp
private long CalculateExperienceForLevel(int level)
    => (long)(Math.Pow(level, 3) * 0.8);
```

Level 1 → 0 XP, Level 5 → 100 XP, Level 10 → 800 XP, Level 50 → 100,000 XP, Level 100 → 800,000 XP. This is the standard cubic curve used in many creature-collection games.

The inverse (computing level from XP):

```csharp
private int CalculateLevelFromExperience(long experiencePoints)
    => (int)Math.Floor(Math.Pow(experiencePoints / 0.8, 1.0 / 3.0)) + 1;
```

Both formulas must stay in sync. If you change the experience curve, update both the generation service and the spawn history level-back-calculation.

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
3. `SelectBaseCreatureFromTemplate` — returns `template.BaseCreatureId`; throws if empty
4. `DetermineLevelFromTemplate` — picks a random level in `[template.MinLevel, template.MaxLevel]` using `seed` if provided
5. `SelectGrowthProfileFromTemplate` — returns `template.GrowthProfileId`; throws if empty
6. Builds `CreateCreatureRequest` with `Gender = Unknown`, `FirstNature = default(Nature)`, and delegates to `CreateAsync`

## `BaseCreature` Model

`BaseCreature` is the template record for a creature species stored in the `creature` table. Key fields relevant to the generation pipeline:

| Field | Type | Notes |
|-------|------|-------|
| `Id` | `Guid` | Internal UUID primary key |
| `ContentKey` | `string` | Designer-facing identifier (e.g. `"cindris"`) — NOT NULL, UNIQUE (enforced by M1015) |
| `AssetKey` | `string?` | Addressables address or Resources path for the primary art asset (e.g. `"creatures/cindris"`). Replaced `AssetId: Guid?` in migration M1016. |
| `AbilityProgressionSetId` | `Guid?` | FK to `ability_progression_set_entry.ability_progression_set_id`; the default progression set for this species. Added by M1017. Null means no default set assigned. |
| `BaseHitPoints` | `int` | Base stat used by the generation formula |
| `BaseAttack` | `int` | — |
| `BaseDefense` | `int` | — |
| `BaseSpeed` | `int` | — |
| `BaseSpecialAttack` | `int` | — |
| `BaseSpecialDefense` | `int` | — |

> **Migration note:** `M1016ReplaceAssetIdWithAssetKeyOnCreature` dropped the `asset_id UUID` column and added `asset_key TEXT` in its place. If you have existing data with `asset_id` values, those UUIDs must be translated to string keys via the `game_assets` table before running M1016.

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
