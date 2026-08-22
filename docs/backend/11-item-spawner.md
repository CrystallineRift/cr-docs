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

## One slot, one distinct item

`ItemSpawnerRoller.Roll` used to consume a slot per *roll*, re-picking from the same template list
and merging the quantities into one entry. With `max_slots` above the template count, leftover slots
piled onto whichever template kept winning: area 1 authors `capture_crystal_standard` at 1-3 and
actually stocked **4-12**, flattening the rarity gradient the seed exists to create.

A template is now removed from the candidate list once it wins, so a slot yields one distinct item
and its quantity is a single draw from the authored `[min, max]`. `max_slots` is a **cap**, not a
quota.

> Raising `max_slots` past the template count no longer inflates quantities — it just means every
> template can appear. A spawner with as many slots as templates therefore stocks all of them, so
> put rarity in `max_slots` rather than relying on repeated draws to thin the pool.

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
`StockFromSpawnerAsync` on world-init using its serialized `itemSpawnerContentKey` **with
`force: true`** (`_refreshStockOnWorldLoad`, default on): every world load clears the merchant and
re-rolls. The cooldown rules above still apply to any mid-session restock. This reverses the
earlier "cooldown 0 = keep the first roll forever" behaviour, which left shops draining to empty;
the reload-to-reroll trade is accepted. Online, the same call goes to
`POST /merchants/{npcId}/stock-from-spawner` and the roll happens on the server.

Per-merchant per-load work scales linearly with merchant count — keep an eye on it as the world
fills out.

### One spawner per area merchant

`M6015SeedAreaMerchantSpawners` seeds five spawners, `demo-merchant-area-{1..5}-items`, one per
playtest area (Meadow, Cave, Shore, Crags, Dunes in that order). Only six real items exist, so the
pools differ by weight and quantity rather than goods: shards and potions in area 1, radiant
crystals and the Mentor's Charm weighted toward area 5. Each has a matching `ItemSpawnerDefinition`
SO; `AreaMerchantSpawnerSqliteTests` rolls each through the real `ItemSpawnerDomainService` so a
seeded-but-unrollable spawner fails the build rather than stocking an empty shop.

> **SQLite read trap fixed here.** `spawn_probability` is `DECIMAL(5,4)`, which in SQLite has
> NUMERIC affinity: `1.0` is stored as INTEGER and `0.5` as REAL. Dapper builds its reader plan
> from the first row, and the first row of a different storage class throws
> `InvalidCastException` — for the **whole query**, not one row. `BaseItemSpawnerRepository`
> now `CAST(... AS REAL)`s `spawn_probability` and `rarity_multiplier` on the SQLite path. The
> original `starting-merchant-items` seed had the same mixed shape (shard `1.0`, the rest
> fractional) and was one row order away from the same failure.

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
SOs, overwriting local), plus a global **Push All Content** / **Pull All Content** toolbar at the
top of the window that runs every type in one click (Pull confirms once). Item spawners push via
`SyncItemSpawnerFull` and pull via the config endpoint above.

> **`isActive` round-trips.** The pool and template `isActive` flags are carried in both
> directions — the push body (`ItemSpawnerPoolDto`/`ItemSpawnerTemplateDto`), the domain sync
> models, and the config response. They used to be dropped, so the server defaulted every pool
> and template to active on push and a pull re-ticked the checkbox locally, while
> `ItemSpawnerRoller` kept honouring the flag — a disabled pool went on stocking the shop with
> nothing in the asset to show for it. The **Pull** also stamps the server id onto
> `ItemSpawnerDefinition.id`.

### Pull All backs up first

**Pull All Content** overwrites every content asset in the project and nothing else can undo it —
Unity's undo stack does not cover asset writes from an editor script, and the assets are only
recoverable from git if they happened to be committed. The prompt is therefore three-way:
**Back up, then Pull** (the default), **Pull without backing up**, **Cancel**.

A backup copies `Assets/CR/Content` — definitions and the `ContentDefinitionProvider` whose arrays
the pull rewrites — to `<project>/ContentBackups/<utc-timestamp>_before-pull-all/`. Two details that
matter:

* It lives **outside `Assets/`** (and is gitignored). A second copy of every content asset inside the
  project would be imported by Unity and double the definitions the registry can find, turning a
  safety net into a source of duplicates.
* `.meta` files are copied too. A restored asset with a fresh GUID would break every reference
  pointing at it — a worse outcome than the pull being undone.

**If the backup fails, the pull is cancelled.** Proceeding would defeat the reason the user asked
for one.

**⟲ Restore…** on the same toolbar lists the snapshots newest-first and copies one back. It is
deliberately an overwrite rather than a wipe-and-replace, so a failure part-way through cannot leave
the folder empty; the cost is that assets *created* since the backup survive a restore, and the
pull's console output names them if you want them gone. The last ten backups are kept
(`ContentBackupRetention`, unit-tested — a keep of zero still leaves one, because a misconfigured
retention must never delete the snapshot taken moments earlier).

:::note Pull needs a list route, not just a by-key route
A pull that only fetches `by-content-key/{key}` can refresh assets the project already has but can
never *discover* one that exists only on the server — it does not know what to ask for. Item spawners
worked that way until `GET /api/v1/item-spawners/content-registry` was added, so **Pull All** silently
skipped any server-authored item spawner. Spawners had the same shape of hole for a different reason:
the route existed on `SpawnerEndpoints` but the AIO host, which maps spawner routes by hand, never
mapped it — so the call 404'd and five migration-seeded spawners could never become assets.

If you add a content type, give it a bare-array list route and confirm **Pull All** can bootstrap it
from an empty project. That is the only test that catches this class of gap.
:::

Items **merge** on push — the thin `ItemDefinition` SO
only authors a subset (effect, usage flags, capture modifier, held-item trigger, asset key), so
the push overlays those onto the existing server row and preserves server-only fields (name,
item type, value, stack, tradable/sellable). Spawn pools have no rows of their own — their
Push/Pull operates on the owning spawners.

## Related

- [Spawner System](03-spawner-system.md) — the creature spawner this mirrors.
