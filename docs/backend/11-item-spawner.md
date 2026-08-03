# Item Spawner & Merchant Stock

The item spawner system stocks inventories (currently merchant NPCs) with items chosen
from designer-authored, weighted pools. It is the **item-side mirror of the creature
spawner** — the same `Spawner → Pool → Template` hierarchy with weights, rarities, and
probabilities — reusing the existing `npc_inventory` table as the resolved stock store.

## Why mirror the creature spawner

Designers already author creature spawners (weighted pools, rarity, per-entry probability).
Items reuse that exact mental model, so a `general_store` item spawner reads just like a
creature spawn zone. Item stocking needs none of the creature-generation machinery (levels,
growth profiles, world placement, spawn history), so the item tables are a trimmed parallel
rather than a reuse of the creature tables.

| Creature spawner | Item spawner |
|---|---|
| `spawner` (capacity, cooldown) | `item_spawner` (`max_slots`, `restock_cooldown_seconds`) |
| `spawner_pool` (`spawn_weight`, `rarity_multiplier`) | `item_spawner_pool` (`spawn_weight`, `rarity_multiplier`) |
| `creature_spawner_template` (`spawn_probability`, qty) | `item_spawner_template` (`spawn_probability`, `min/max_quantity`) |
| `SpawnerDefinition` SO + Sync Config | `ItemSpawnerDefinition` SO + Sync Config |

## Data model

- **`item_spawner`** — `content_key`, `max_slots`, `restock_cooldown_seconds`, soft-delete.
- **`item_spawner_pool`** — `item_spawner_id`, `spawn_weight`, `rarity_multiplier`, `is_active`.
- **`item_spawner_template`** — `pool_id`, `item_id`, `item_content_key`, `spawn_probability`
  (0–1), `min_quantity`, `max_quantity`, `is_active`.

Tables are created by migrations **M6010–M6012** (dual SQLite/Postgres, ANSI SQL) in
`CR.Items.Data.Migration`.

## Roll algorithm

`ItemSpawnerRoller.Roll(pools, templates, maxSlots, rng)` (pure, seedable, no DB) fills up to
`max_slots` distinct items:

1. **Guaranteed first** — every active template with `spawn_probability >= 1.0` is always
   stocked (one slot each). This is how "always carries Potions" is expressed.
2. **Weighted fill** — remaining slots pick a **pool by `spawn_weight × rarity_multiplier`**,
   then a **template within that pool by `spawn_probability`**; quantity is uniform in
   `[min_quantity, max_quantity]`.
3. Quantities for the same item are merged, so the result is a distinct item list.

Inactive/deleted pools and templates, and zero-weight pools, are excluded.

## Stocking a merchant

`NpcMerchantService.StockFromSpawnerAsync(accountId, trainerId, npcId, spawnerContentKey, force)`:

1. Stocks unconditionally when the merchant is **empty** (first time its zone loads).
2. Otherwise honors the spawner cooldown. **`restock_cooldown_seconds = 0` means "never
   auto-restock"**, not "restock every time" — a merchant that already has stock is left alone
   unless its cooldown is both defined and elapsed. `force: true` always re-rolls.
3. When a restock is due: rolls the spawner, **clears** the merchant's `npc_inventory`, and
   inserts the rolled items.

> The zero-cooldown rule matters because step 3 runs from `NpcMerchantBehaviour` on **every**
> world load. Before this rule, the seeded `starting-merchant-items` spawner (cooldown 0) made
> every merchant clear and re-roll its full inventory on every load — a serial write loop per
> merchant, linear in merchant count, and a reload-to-reroll exploit on shop contents. Fixing it
> halved merchant world-init cost (~40ms → ~19ms).

A merchant is linked to a spawner via the Unity `NpcDefinition.itemSpawnerContentKey`
(authored on Merchant-type NPCs); the link is passed to the stock call rather than persisted
on the NPC row.

At runtime, `NpcMerchantBehaviour` (a composable `INpcSubInitializable`) calls
`StockFromSpawnerAsync` on world-init using its serialized `itemSpawnerContentKey`, so a
merchant fills its stock the first time its zone loads (and re-rolls once the cooldown elapses).
Because this is per-merchant per-load work, it scales linearly with merchant count — keep an eye
on it as the world fills out.

## REST

| Method | Route | Purpose |
|---|---|---|
| POST | `/api/v1/item-spawners/sync-config` | Create/replace a spawner (header + pools + templates) by content key — used by Content Studio |
| GET  | `/api/v1/item-spawners/{contentKey}/roll?seed=` | Preview a roll (distinct item ids + quantities) |
| GET  | `/api/v1/item-spawners/by-content-key/{contentKey}/config` | Full config (header + pools + templates) — used by Content Studio **Pull** |
| POST | `/api/v1/merchants/{npcId}/stock-from-spawner` | Roll a spawner into a merchant's inventory (`{ accountId, trainerId, spawnerContentKey, force }`) |

## Authoring (Unity)

Create an **`ItemSpawnerDefinition`** (`Assets → Create → CR → Content → Item Spawner
Definition`): set `contentKey`, `maxSlots`, optional `restockCooldownSeconds`, then add pools
and item templates (item content-key picker, probability slider, quantity range). **Sync Full
Config** pushes it to the backend. On a Merchant `NpcDefinition`, set **Item Spawner Key** to
the spawner's content key. Content Studio also has an **Item Spawners** tab (list / create /
sync), and `ContentAuditTool` flags item-spawner templates or merchant links that reference
unknown items/spawners.

## Content Studio sync

Every content tab has **Push** (SOs → server, upsert by content key) and **Pull** (server →
SOs, overwriting local), plus a global **Push All Content** / **Pull All Content** toolbar that
runs every type in one click (Pull confirms once). Item spawners push via `SyncItemSpawnerFull`
and pull via the config endpoint above. Items **merge** on push — the thin `ItemDefinition` SO
only authors a subset (effect, usage flags, capture modifier, held-item trigger, asset key), so
the push overlays those onto the existing server row and preserves server-only fields (name,
item type, value, stack, tradable/sellable). Spawn pools have no rows of their own — their
Push/Pull operates on the owning spawners.

## Related

- [Spawner System](03-spawner-system.md) — the creature spawner this mirrors.
