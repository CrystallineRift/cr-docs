# Creature Generation

## Overview

`ICreatureGenerationService` is the high-level factory for creating `GeneratedCreature` instances. It lives in `CR.Game.Model.Creatures` and is implemented in `CR.Game.Domain.Services`.

Source: `../cr-api/Game/CR.Game.Model/Creatures/ICreatureGenerationService.cs`

## Interface

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

## GeneratedCreature Model

A `GeneratedCreature` is a live instance of a base `creature`. Key fields:

| Field | Notes |
|-------|-------|
| `id` | UUID primary key |
| `base_creature_id` | FK → `creature` |
| `growth_profile_id` | FK → `growth_profile` |
| `given_name` | Player-assigned name |
| `gender` | `"male"` / `"female"` / `"none"` |
| `first/second/third_nature` | Natures affecting stat modifiers |
| `first–fourth_ability_id` | Up to 4 active abilities |
| `hit_points`, `attack`, `defense`, `speed`, `special_attack`, `special_defense` | Computed stats |
| `experience_points` | Current XP |
| `current_trainer_id` | FK → `trainers` |
| `signing_key_id` | Integrity signing key |

## Natures

Each creature has up to three natures. Natures are string values that influence stat growth multipliers applied by the `GrowthProfile`.

Example natures: `"brave"`, `"timid"`, `"modest"`, `"jolly"`, `"adamant"`.

## Growth Profiles

`growth_profile` defines how a creature's stats scale as it levels up:

| Column | Effect |
|--------|--------|
| `experience_growth` | XP curve steepness |
| `hit_points_growth` | HP per level multiplier |
| `attack_growth` | Attack per level multiplier |
| `defense_growth` | Defense per level multiplier |
| `speed_growth` | Speed per level multiplier |
| `special_attack_growth` | Sp. Attack per level multiplier |
| `special_defense_growth` | Sp. Defense per level multiplier |

## Ability Progression

`ability_progress` records what abilities a creature can learn at each level for a given `set_name`. The generation service looks up the set matching the template's `ability_progression_set_id` and assigns abilities to slots 1–4 based on the creature's starting level.

## Stat Calculation Flow

```
base_creature (base stats)
  + growth_profile (per-level multipliers)
  + natures (stat modifiers)
  + level
  → final stats stored on generated_creature
```

## DI Registration

```csharp
// Server (Program.cs)
builder.Services.AddSingleton<ICreatureGenerationService, CreatureGenerationService>();

// Unity (LocalDevGameInstaller.cs)
Container.Bind<CR.Game.Model.Creatures.ICreatureGenerationService>()
    .To<CR.Game.Domain.Services.Implementation.Creature.CreatureGenerationService>()
    .AsSingle();
```
