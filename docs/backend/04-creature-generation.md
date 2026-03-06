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

The inverse (computing level from XP) used in the Spawner system:

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

If the `growthProfile` object does not cast to `CR.Game.Model.Stats.GrowthProfile`, the service falls back to simple linear scaling using only `levelMultiplier`. This fallback should never occur in production but protects against type mismatches in test environments where mock objects are used.

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

The signing key is a string like `SK_ab12cd34_ef56gh78_1712345678`. It is stored on `generated_creature.signing_key_id` and is intended for future anti-cheat verification — a server can validate that a creature's stats match what would have been generated for that trainer, base creature, and timestamp. The key is currently stored but not yet verified.

## `CreateFromSpawnerAsync` Internals

This method bridges the Spawner system to the creature generation pipeline:

1. Validate `spawnerTemplateId` and `trainerId` are non-empty
2. Fetch `CreatureSpawnerTemplate` — throws `InvalidOperationException` if not found or not active
3. `SelectBaseCreatureFromTemplate` — returns `template.BaseCreatureId`; throws if empty
4. `DetermineLevelFromTemplate` — picks a random level in `[template.MinLevel, template.MaxLevel]` using `seed` if provided
5. `SelectGrowthProfileFromTemplate` — returns `template.GrowthProfileId`; throws if empty
6. Builds `CreateCreatureRequest` with `Gender = Unknown`, `FirstNature = default(Nature)`, and delegates to `CreateAsync`

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

## Natures

Each creature has up to three natures. Natures are enum values that influence stat growth multipliers applied by the `GrowthProfile`. The game currently stores nature as string representations.

Example natures: `"brave"`, `"timid"`, `"modest"`, `"jolly"`, `"adamant"`, `"hardy"` (neutral).

Starter creatures generated by `EnsureStarterNpcAsync` always receive `Nature.Hardy` (no stat modifier) so the player's first creature is not penalized by a random unfavorable nature.

## Growth Profiles

`growth_profile` defines how a creature's stats scale as it levels up:

| Column | Effect |
|--------|--------|
| `experience_growth` | XP curve steepness (not currently used in formula; reserved) |
| `hit_points_growth` | HP scaling percentage (e.g., 120 = 20% above base linear) |
| `attack_growth` | Attack scaling percentage |
| `defense_growth` | Defense scaling percentage |
| `speed_growth` | Speed scaling percentage |
| `special_attack_growth` | Sp. Attack scaling percentage |
| `special_defense_growth` | Sp. Defense scaling percentage |

Growth profile values of 100 are neutral linear scaling. Values above 100 produce faster-than-linear growth; below 100 produce slower growth. This lets designers create "tank" creatures (high HP/Defense growth) vs "sweeper" creatures (high Attack/Speed growth) using the same base stat sheet.

## Ability Progression

`ability_progress` records what abilities a creature can learn at each level for a given `set_name`. The generation service:

1. Calls `GetAbilityProgressAtLevelAsync(baseCreatureId, level)` to get all progression entries up to the target level
2. Filters by `ap.SetName == abilityProgressionSetId.ToString()`
3. Sorts by level ascending
4. Takes the first 4 entries and assigns them to `FirstAbilityId` through `FourthAbilityId`

**Edge case:** If `GetAvailableAbilityProgressionSetsAsync` is called for a base creature, it returns set IDs extracted from `ability_progress.set_name` where the set_name parses as a GUID. If designers use non-GUID set names, they will not appear in this list and will not be assignable via the API helpers.

## `GetAvailableGrowthProfilesAsync` Gotcha

Currently this method returns **all** growth profiles in the database rather than filtering to profiles that are compatible with a specific base creature. The comment in the implementation acknowledges this:

```csharp
// For now, return all growth profile IDs
// In a real implementation, this would filter based on creature type, rarity, etc.
var growthProfiles = await _growthProfileRepository.GetPaginated(0, 1000);
```

If you have more than 1,000 growth profiles, this call truncates silently. The method will be replaced with a creature-specific compatibility query when the growth profile compatibility table is added.

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
- **Nature enum default.** `default(Nature)` in C# is the enum's zero value. Make sure the zero value is a reasonable default (e.g., `Hardy`) rather than an invalid state.

## Related Pages

- [Spawner System](?page=backend/03-spawner-system) — calls `CreateFromSpawnerAsync` for wild creature generation
- [NPC System](?page=backend/02-npc-system) — calls `CreateAsync` for starter creature creation
- [Starter Creature Flow](?page=backend/05-starter-creature-flow) — end-to-end walkthrough showing where creature generation fits
- [Backend Architecture](?page=backend/01-architecture) — DI wiring, module structure
