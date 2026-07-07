# Loot System

Battle-victory loot lets a defeated creature yield items, currency, and trainer XP, rolled from **loot tables** that are layered by spawner (zone loot) and creature (species loot).

## Concepts

- **Loot table** (`loot_table`) — owned by either a **spawner** or a **creature**, identified by `owner_type` (`Spawner` | `Creature`) + `owner_content_key`. A table is a named bag of entries.
- **Loot entry** (`loot_entry`) — one possible drop: a `reward_type` (`Experience` | `Currency` | `Item` | `Creature`), an optional `reference_key` (content_key of the item/creature-spawner), a `min_quantity`/`max_quantity` range, and a `drop_chance` (0–1).
- **Layering** — on victory the **spawner** table (from the battle's `spawner_content_key`) and the **defeated creature's** table are both loaded and their entries unioned.
- **Independent per-entry chance** — each entry rolls on its own `drop_chance`; any number from zero to all can drop. Quantity is sampled uniformly in `[min, max]`.

## Roll logic

`LootRollService.Roll(entries, IRandom)` (in `CR.Loot.Domain.Services`) is pure and deterministic under a seeded `IRandom`: for each non-deleted entry it rolls the drop test, samples a quantity, and emits a `RewardGrant`. Unknown/misspelled `reward_type` strings are **skipped** (never coerced to a default). `ILootDomainService.RollVictoryLootAsync(spawnerContentKey, creatureContentKey, ct)` loads both owner tables, unions the entries, and returns the rolled `RewardGrant` list.

## Battle wiring

`BattleDomainService` resolves loot on knockout/victory:

1. Resolve the defeated creature's `content_key`; load its creature loot table.
2. Use the battle's `spawner_content_key` (added by `M8016`, threaded through `StartBattleAsync(..., string? spawnerContentKey, ...)`) to load the spawner loot table.
3. Roll the unioned entries, grant each via `IRewardGrantService`, and attach the resolved drops as `LootAward[]` on the `BattleOutcome`.

Loot `Experience` grants **trainer** XP (`StatKey.TrainerExperiencePoints`) via the stat system. This is separate from and additive to the existing per-creature combat XP awarded by `AwardBattleExperienceAsync` — there is no double-count.

If the battle has no spawner (trainer battles, or a wild battle that did not pass a spawner content_key) only the creature table rolls. A failure to resolve the trainer or roll the table skips loot gracefully without failing the battle action.

## Reward granting

All grant logic is shared: `IRewardGrantService.GrantAsync(accountId, trainerId, RewardGrant, ct)` (in `CR.Game.Domain.Services`) handles `Experience`, `Currency`, `Item`, and `Creature`. `Quest` rewards are not granted here (they are consumer-routed — see [World Pickups](14-world-pickups.md)); loot tables never author `Quest` entries. `QuestDomainService` reward granting delegates to the same service.

## Schema

`loot_table`: `id`, `content_key`, `owner_type`, `owner_content_key`, `deleted`, `created_at`, `updated_at`.

`loot_entry`: `id`, `loot_table_id`, `reward_type`, `reference_key` (nullable), `min_quantity`, `max_quantity`, `drop_chance`, `deleted`, `created_at`, `updated_at`.

Migrations `M7100`–`M7102` (dual-engine, soft-delete, idempotent seeds). Seeded demo tables exist so loot is functional off seeds before any Content Studio authoring.

## REST

- `GET /api/v1/loot-tables/{ownerType}/{ownerContentKey}` — table + entries.
- `GET|POST /api/v1/loot-tables/sync-config` — Content Studio pull/push (write path registers a sync service; returns 501 until wired).

## Offline parity

The offline battle path runs the same `BattleDomainService` against local SQLite in the Unity client, so an offline win rolls and grants loot identically; online wins receive `LootAward[]` from the server outcome.

## Follow-ups

- Thread the spawner `content_key` from the wild-battle encounter so spawner (zone) loot fires (creature-table loot already works in both modes).
- Content Studio authoring (`LootTableDefinition` SO + tab + sync write service).
