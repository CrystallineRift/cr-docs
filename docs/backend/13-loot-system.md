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

1. Load the defeated creature **before** battle-end cleanup runs — cleanup soft-deletes an
   uncaptured wild creature, after which `GetCreature` (which filters `deleted = false`) can no
   longer see it. The pre-loaded creature feeds both the loot roll's `content_key` resolution and
   the combat-XP level lookup (previously both read after the delete: loot silently skipped and
   XP degraded to level 1 on every wild win).
2. Use the battle's `spawner_content_key` (added by `M8016`, threaded through `StartBattleAsync(..., string? spawnerContentKey, ...)`) to load the spawner loot table.
3. Roll the unioned entries, grant each via `IRewardGrantService`, and attach the resolved drops as `LootAward[]` on the `BattleOutcome`.

Loot `Experience` grants **trainer** XP (`StatKey.TrainerExperiencePoints`) via the stat system. This is separate from and additive to the existing per-creature combat XP awarded by `AwardBattleExperienceAsync` — there is no double-count.

If the battle has no spawner (trainer battles, or a wild battle that did not pass a spawner content_key) only the creature table rolls. A failure to resolve the trainer or roll the table skips loot gracefully without failing the battle action.

## Victory currency and level scaling

Loot tables are level-blind: an entry says "10–30 currency" whatever the opponent's level. Two
changes make a win scale with the creature that lost it, both driven by
`BattleRewardScaling` (`CR.Game.Domain.Services/Implementation/Battle/`).

**Guaranteed victory currency.** Every wild win grants currency computed from the defeated
creature's level, before and independently of the loot roll. It needs only the level, which is
already in hand — not a resolved `content_key` and not an authored loot table. Both of those were
missing for the entire playable roster (see the note under *Schema*), so most wins paid nothing at
all. Currency is now a property of winning rather than of whether somebody authored a table.

**Scaled loot quantities.** A rolled grant of `Currency` or `Experience` is multiplied by a growth
factor for the level. `Item` and `Creature` grants are **not** scaled: those quantities are counts,
not amounts, and multiplying them hands out inventories. At level 1 the multiplier is exactly 1.0,
so authored content behaves as written until a level says otherwise.

Both curves are quadratic in the level, and deliberately so. A creature's next level costs
`0.8 x (level - 1)^3` experience, so the cost of advancing grows like `level^2`. The previous flat
`5 x level` award fell further behind at every level — roughly 3 wins per level at 10, 10 at 20,
and 48 at the level cap. Matching the curve's shape holds it near 2.5–4.5 wins per level
throughout. Levels are clamped to `[1, 100]` for scaling purposes so a corrupt level field cannot
mint an unbounded amount into the economy.

## Reward granting

All grant logic is shared: `IRewardGrantService.GrantAsync(accountId, trainerId, RewardGrant, ct)` (in `CR.Game.Domain.Services`) handles `Experience`, `Currency`, `Item`, and `Creature`. `Quest` rewards are not granted here (they are consumer-routed — see [World Pickups](14-world-pickups.md)); loot tables never author `Quest` entries. `QuestDomainService` reward granting delegates to the same service.

## Schema

`loot_table`: `id`, `content_key`, `owner_type`, `owner_content_key`, `deleted`, `created_at`, `updated_at`.

`loot_entry`: `id`, `loot_table_id`, `reward_type`, `reference_key` (nullable), `min_quantity`, `max_quantity`, `drop_chance`, `deleted`, `created_at`, `updated_at`.

Migrations `M7100`–`M7102` (dual-engine, soft-delete, idempotent seeds). Seeded demo tables exist so loot is functional off seeds before any Crystalline Rift Studio authoring.

`M7103` seeds a loot table for each of the five area spawners (`meadow-`, `cave-`, `shore-`,
`crags-`, `dunes-wild-zone`). Until it existed, the only two tables in the database belonged to the
creature `cindris` and the spawner `starter-wild-zone`, neither of which any playable area uses —
so every wild battle in the game rolled against an empty entry set and dropped nothing. The five
tables are identical on purpose: all five areas draw from the same level band (2–10), so tiering
the drops by area would encode a difficulty difference the spawner data does not have. They carry
items only; currency comes from the victory award above and a table row would pay a second,
level-blind amount for the same win.

`M10007` is a no-op version bump. New content below the current maximum migration number is
invisible to Unity's `GameDataAdopter`, which only replaces an adopted `game-data` copy when the
bundled `MAX(Version)` is strictly greater.

## REST

- `GET /api/v1/loot-tables` — paginated list of every non-deleted loot table (with entries), for bulk client sync. `offset`/`limit` query params (default and max `limit` 500). Response: `{ data: [...], offset, limit, total }`, `total` is the full matching row count so a client can detect truncation.
- `GET /api/v1/loot-tables/{ownerType}/{ownerContentKey}` — table + entries.
- `GET|POST /api/v1/loot-tables/sync-config` — Crystalline Rift Studio pull/push (write path registers a sync service; returns 501 until wired).

## Offline parity

The offline battle path runs the same `BattleDomainService` against local SQLite in the Unity client, so an offline win rolls and grants loot identically; online wins receive `LootAward[]` from the server outcome.

## Follow-ups

- Crystalline Rift Studio authoring (`LootTableDefinition` SO + tab + sync write service).
