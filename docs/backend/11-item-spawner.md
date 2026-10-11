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

`spawn_probability` is then an actual **probability**, not a relative weight: each template that a
slot considers passes or fails its own trial, so a `0.15` charm reaches the shelf about 15% of the
time and `max_slots` caps how many items can. A failed trial consumes the template — one trial each
per roll — but not a slot.

> This pairing matters. An earlier version removed a template once picked but still treated the
> number as a weight, so any spawner whose `max_slots` reached its template count drew **every**
> template with certainty: a `p=0.05` Radiant Summoning Shard appeared in 2000 rolls out of 2000, and the
> rarity gradient existed only in the column. Rarity lives in `spawn_probability`; `max_slots` is
> the ceiling on shelf size.

## Stocking a merchant

`NpcMerchantService.StockFromSpawnerAsync(accountId, trainerId, npcId, ct)` is the "stock this
shop" intent. The caller names neither the spawner nor a re-roll. The authority decides both: the
server online, and offline the same service over local SQLite. The client sends it when the player
walks up to a merchant and again as the shop opens, never on world load (see
[Merchant Shop → Restocking](?page=unity/18-merchant-shop#restocking)).

1. **Refuses** an NPC that does not exist for this trainer or is not a merchant. It throws
   `MerchantStockNotAllowedException` and rolls and writes nothing; the route answers 404.
2. **Keeps a shelf that was rolled and that nothing has touched since** (`stock_rolled_at` set,
   `stock_touched_at` null), however long ago the roll was. This is the hot path and by far the
   commonest answer: the NPC row read for step 1 carries the stamps, so it costs that one indexed
   read, with no registry row, spawner, shelf read, transaction or write.
3. Resolves the stock source: the merchant's content key → its NPC registry row → that row's item
   spawner. A content key with no Merchant row in the registry, or whose row names no spawner, is
   refused the same way.
4. **Rolls a shelf that was never rolled** (no `stock_rolled_at`: a new merchant, a cleared shop, or a
   shop that held rows before the stamps existed), replacing any rows it holds.
5. Otherwise the shelf has been **touched** by a purchase or a sale, and **the spawner's cooldown
   decides**. `restock_cooldown_seconds = 0` means "never auto-restock", not "restock every time". Above
   0, the shelf is due once that many seconds have passed since the **last** touch. Every purchase and
   sale re-stamps the touch, so trading with a shop defers its restock, and a shop bought out completely
   waits for the cooldown like any other.
6. **Rolls** the spawner before any transaction opens (the roll reads the spawner, its pools and its
   templates, and none of that should hold a lock on the shelf). Then one transaction claims the shelf
   with `TryClaimMerchantRollInTransactionAsync`, a compare-and-set on `stock_roll_seq` and the touch
   stamp this request read, which sets `stock_rolled_at = now`, clears the touch and adds 1 to the
   sequence, and replaces the shelf with the rolled items (`ReplaceMerchantStockInTransactionAsync`:
   delete the rows, then plain inserts on the same connection, duplicate item ids summed first). A claim
   that matches nothing (another ask rolled first, an operator reset the shelf, or a trade touched it
   after the read) answers 0 and writes nothing. **An empty roll is still a roll:** the claim commits on
   its own, the shelf keeps its rows and a warning is logged, so the asks after it take the hot path.

It returns the number of distinct items stocked, or 0 when the stock was kept. Because the caller
cannot force anything, the call is safe to repeat: a re-roll happens at most once per (trainer,
merchant) per cooldown, and only after a trade.

The trades stamp the shelf inside their own transactions: `PurchaseItemFromMerchantAsync` and
`SellItemToMerchantAsync` call `TouchMerchantStockInTransactionAsync` with `DateTime.UtcNow` right after
the debit and before any `npc_inventory` write, so the lock order is the same everywhere (trainer, then
the `npcs` row, then `npc_inventory`) and a rolled-back trade takes its stamp with it. Authoring writes
reset the shelf rather than stamp it: the clear always (`ResetMerchantStockInTransactionAsync`: rolled
and touched cleared, sequence + 1), and a removal or quantity edit only when it would leave the shelf
empty (`ResetMerchantStockIfEmptiedByInTransactionAsync`). `RestockEligibleItemsAsync` (the limited-stock
`restock` route) has nothing to do with spawners and stamps nothing.

> The gate also keeps the ask cheap. Its zero-cooldown half came first: until that rule arrived on
> 2026-08-03, the seeded `starting-merchant-items` spawner (cooldown 0) made every merchant clear and
> re-roll its full inventory on every load — a serial write loop per merchant, linear in merchant
> count, and a reload-to-reroll exploit on shop contents. Fixing it halved merchant world-init cost
> (~40ms → ~19ms). Since restock v2 (2026-10-10) world init sends no stock call at all.

A merchant's spawner is named by its **NPC registry row**: `item_spawner_content_key` on the
`ContentWorldId` row for the merchant's content key. Crystalline Rift Studio pushes it there from
the Unity `NpcDefinition.itemSpawnerContentKey` (authored on Merchant-type NPCs); offline, the rows
come from `M16100SeedNpcRegistry_20261009`. The scene's `NpcMerchantBehaviour._itemSpawnerContentKey`
is a designer reference that the audit reads; it is not sent.

### Shelf stamps: M16010

`M16010AddMerchantStockStampsToNpcs` adds three columns to `npcs` (the player's copy of the merchant,
per account and trainer; player-data offline): `stock_rolled_at` and `stock_touched_at` (nullable
timestamps, UTC readings) and `stock_roll_seq` (integer, NOT NULL, default 0). They are read through
`NpcColumns` and written only by the dedicated statements above, never by the generic `UpdateNpc`, so a
content push or a stale read-modify-write cannot reset them. The sequence exists because a timestamp
cannot be compared reliably across engines (Postgres keeps microseconds; SQLite stores whatever text its
writer produced).

The backfill is what makes deploying it re-roll nothing: every live merchant (type 0) that holds shelf
rows is stamped rolled at its newest row's `updated_at` and left untouched, so every existing shelf
counts as stocked and untouched. A merchant with no rows (a shop bought out under the old rules) has no
roll to remember and is rolled once by its next ask. Postgres runs one set-based `UPDATE … FROM`
over the shelf aggregate; SQLite, which has no `UPDATE … FROM` on the versions this project targets,
uses a correlated subquery that compares ids with `LOWER()`. The ADD COLUMNs are guarded, so a re-run
changes nothing, and `updated_at` on `npcs` is left alone (it is the NPC definition's edit stamp).
`Down()` drops the columns on Postgres and leaves them on SQLite (no DROP COLUMN there). The NPC
repositories now select the new columns, so M16010 must run on every SQLite database that has an
`npcs` table: player-data and every online cache.

Pinned by `NpcMerchantServiceTests` and `MerchantShelfStampTests` (the rules), `MerchantShelfStampsRepositoryTests`
(Postgres) and `MerchantShelfStampsSqliteTests` (the claim, touch and reset statements, concurrent asks
rolling once), `MerchantShelfStampsMigrationSqliteTests` / `…PostgresTests` (columns, backfill, re-run),
`OfflineMerchantRestockSqliteTests` (the real service over migrated SQLite, called the way the client
calls it offline) and `MerchantRestockHttpTests`.

### Restock cooldowns: M6024

Merchant spawners ship at **900 s**. `M6024SetMerchantRestockCooldowns` sets
`restock_cooldown_seconds = 900` on `starting-merchant-items` and `demo-merchant-area-{1..5}-items`,
only where the value is still 0 and the row is not deleted, so a cooldown authored in Crystalline Rift
Studio stays. It stamps `row_version` and `updated_at` on the rows it changes, as the repository's own
update does, so the Studio's drift sync sees that the server moved. It is ANSI SQL with no `isSqlite`
branch, and a second run matches no row. `Down()` is a deliberate no-op, like M6022's and M6023's: the
rows it set cannot be told apart from a cooldown that was already 900, and putting them back to 0
would stop those shops restocking. Offline adoption needs no content-schema bump, because
`GameDataAdopter` re-adopts when the SHA-256 of the baked bytes changes, and a re-bake that includes
M6024 changes them.

All six were at 0 before M6024. M6014 (2026-06-09) seeded `starting-merchant-items` that way, and
M6015 (2026-08-22) seeded the five area spawners at 0 because the client by then forced a re-roll on
every world load (`_refreshStockOnWorldLoad`, `force: true`). The route stopped honouring `force` in
the 2026-09-27 route lockdown, so from then on no online shop restocked. On 2026-10-10, `force` and
the caller's spawner key were removed from the call altogether.

Pinned by `MerchantRestockCooldownSqliteTests` and `MerchantRestockCooldownPostgresTests` (the
migration) and, in cr-api-unity, `MerchantRestockContentTests` (the six `*MerchantItems` assets and the
committed offline floor carry the same 900). `MerchantRestockHttpTests` posts a v0.1.7 body with
`force: true` and gets `stocked: 0` with the stock untouched, and shows on seeded merchants that a shelf
nothing touched is never restocked, even days past its cooldown; that a bought-out item comes back once
the cooldown has run since the last purchase; that a shop bought out completely waits for the cooldown;
that a partial purchase starts the clock while a sibling shop nobody traded with never restocks; that a
sale touches the shelf; that a group of asks for a due shop rolls it once; and that a purchase landing
between an ask's read and its claim makes the claim lose. It also shows that a player's
`DELETE /api/v1/merchants/{npcId}/inventory` is 403 and leaves the stock as it was, while a content-write
token clears the shop the operator names and the next ask rolls it.

### One spawner per area merchant

`M6015SeedAreaMerchantSpawners` seeds five spawners, `demo-merchant-area-{1..5}-items`, one per
playtest area (Meadow, Cave, Shore, Crags, Dunes in that order). Only six real items exist, so the
pools differ by weight and quantity rather than goods: shards and potions in area 1, radiant
Summoning Shards and the Mentor's Charm weighted toward area 5. Each has a matching `ItemSpawnerDefinition`
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
| POST | `/api/v1/item-spawners/sync-config` | Create/replace a spawner (header + pools + templates) by content key — used by Crystalline Rift Studio. Every `itemContentKey` must resolve: a payload naming an item the server does not have is refused with `409` and nothing is written, because this call replaces the spawner's pools wholesale and skipping the unresolved templates silently emptied it. Now gated behind `AuthorizationPolicies.RequireContentWrite` — it was reachable on any player token. |
| GET  | `/api/v1/item-spawners/{contentKey}/roll?seed=` | Preview a roll (distinct item ids + quantities) |
| GET  | `/api/v1/item-spawners/by-content-key/{contentKey}/config` | Full config (header + pools + templates) — used by Crystalline Rift Studio **Pull** |
| POST | `/api/v1/merchants/{npcId}/stock-from-spawner` | The "stock this shop" intent, sent as the player walks up to a merchant: rolls the merchant's registered spawner into its inventory when the shelf is due (never rolled, or touched by a trade and the cooldown has run since the last one), and answers `{ stocked }` (0 = stock kept). No Idempotency-Key (one that is sent is ignored); limited per account by `cr-merchant-stock` (`RateLimits:MerchantStockPerMinute`, default 30/min, 429 past it). Body `{ trainerId }`; the account comes from the token. The `accountId`, `spawnerContentKey` and `force` that v0.1.2 to v0.1.7 still post bind and are ignored. 404 for a refusal. |

## Authoring (Unity)

Create an **`ItemSpawnerDefinition`** (`Assets → Create → CR → Content → Item Spawner
Definition`): set `contentKey`, `maxSlots` and `restockCooldownSeconds` (**Restock Cooldown (s)**:
how long after the player's last trade with a shop fed by this spawner it may be re-rolled, on the next
walk-up; 0 never restocks, and the merchant spawners use 900), then add pools
and item templates (item content-key picker, probability slider, quantity range). Push it to the
backend with **Crystalline Rift Studio → Item Spawners → ⬆ Push All** (the inspector's own "Sync Full
Config" button was removed — see
[One way to reach the server](../unity/08-content-registry.md#one-way-to-reach-the-server)). On a
Merchant `NpcDefinition`, set **Item Spawner Key** to the spawner's content key; a push writes it to
the NPC registry row, which is what picks the merchant's stock.
`ContentAuditTool` flags item-spawner templates or merchant links that reference unknown
items/spawners.

## Crystalline Rift Studio sync

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
