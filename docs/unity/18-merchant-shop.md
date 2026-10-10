# Merchant Shop UI

Player-facing shop opened by interacting (E) with a merchant NPC. Lists the
merchant's stocked inventory with live buy prices, shows the trainer's wallet,
and purchases into the backpack.

## Flow

```
NpcInteractionBehaviour (proximity + E)
  └─ merchant branch (_merchantBehaviour.IsReady)
       └─ MerchantShopScreenHandler.Open(npcId, accountId, trainerId)
            ├─ ITrainerRepository.GetTrainerById      → wallet + backpack inventory id
            ├─ INpcMerchantService.GetMerchantInventoryAsync
            ├─ IItemDomainService.GetItemAsync        → name / description / assetKey
            ├─ INpcMerchantService.CalculateBuyPriceAsync → unit price (BaseValue × BuyMultiplier)
            └─ Buy → INpcMerchantService.PurchaseItemFromMerchantAsync
                      (debits currency + moves stock → backpack, one transaction)
```

The merchant's stock itself comes from the item spawner its NPC registry row names
(see [Item Spawner](../backend/11-item-spawner.md)). On world init
`NpcMerchantBehaviour.InitializeAsync` asks the authority to stock the shop, and the authority
decides whether anything is rolled (see [Restocking](#restocking)).

## Key files

| File | Role |
|------|------|
| `Assets/CR/UI/Shop/MerchantShopScreenHandler.cs` | UI Toolkit screen: rows, wallet, qty stepper, Buy, status line. `IContextAwareScreen` — force-closes when leaving the Overworld context. |
| `Assets/CR/UI/Shop/MerchantShopItem.cs` | Resolved row struct (itemId, name, desc, unitPrice, stock, assetKey). |
| `Assets/CR/UI/Resources/MerchantShopScreen.uxml` | Screen layout (named elements, zero inline styles). |
| `Assets/CR/UI/Resources/MerchantShopItemRow.uxml` | One stock row — designer-editable template; the handler only binds data/callbacks by element name. |
| `Assets/CR/UI/Resources/MerchantShopScreen.uss` | All styling via named classes (BattleBagPanel design language: deep navy, blue borders, dimmed overlay). Loaded from Resources as a fallback when the Inspector field is unassigned, so the screen never renders unstyled. |
| `Assets/CR/Game/World/Behaviours/NpcInteractionBehaviour.cs` | Merchant interact branch; locates the screen lazily (`FindFirstObjectByType`) so shop-less scenes still resolve DI. |

## Behaviour details

- **Affordability**: each row's Buy button shows the total (`unit × qty`) and is
  disabled (+ `.shop-buy-button--disabled`) when the wallet can't cover it.
  The server/domain transaction remains the authoritative funds check.
- **Wallet**: updated from `PurchaseResult.NewBalance` after each purchase; the
  stock list reloads so quantities reflect the sale.
- **Input lock**: the shared Soap `isMenuOpen` BoolVariable (same asset
  `PlayerMenuWindow` uses) gates the Player action map via `PlayerInputGate`.
  The UI map and EventSystem are never disabled.
- **Icons**: `assetKey` → `IGameAssetLoader.LoadAssetByKeyAsync<Sprite>`, with a
  `.shop-item-icon--placeholder` class until/unless a sprite resolves.
- **Sell tab**: visible but disabled — sell flow is a follow-up
  (`SellItemToMerchantAsync` + currency credit already exist domain-side).

## Gamepad navigation

The shop is navigated control by control: the Buy/Sell tabs, the close button, and per row a
quantity minus, a plus and a Buy. Six focusable Buttons and **no focusable containers**.

:::danger[Fixed: this barely worked at all]
Two faults, both of which read as "the controller does nothing".

The screen had exactly **one `:focus` rule**, on `.shop-item-row`, while five different buttons had
only `:hover`. Focus moved from the row onto its own Buy button and nothing on screen changed.

The row was also `focusable="true"` **while containing three focusable Buttons** — a container in the
focus ring that does nothing on Submit, and the reason the highlight vanished the moment you moved
onto a control.
:::

The row is now out of the ring and follows its children instead: a `--focus-within` class is toggled
on `FocusIn` / `FocusOut` of its buttons, since UI Toolkit has no `:focus-within` selector. So there
is always exactly one row lit *and* one control lit, and pressing A always does something.

Initial focus lands on the first **Buy button**, not the row — focus has to start somewhere Submit
means something.

:::tip
When adding a control here, give it a `:focus` rule. A mouse user already knows where their cursor
is; a pad user has only that. Focus styles are deliberately brighter than hover for the same reason.
:::

## Scene wiring (Editor)

1. Add a GameObject with a `UIDocument` (sortingOrder above the HUD) +
   `MerchantShopScreenHandler` to the world UI rig. Leave the UIDocument's
   **Source Asset (visualTreeAsset) empty** — the handler instantiates the UXML
   from Resources itself; an assigned source asset just bakes a stylesheet-less
   copy at startup (the handler hides it defensively, but empty is cleaner).
2. Assign the shared `isMenuOpen` BoolVariable (the stylesheet auto-loads from
   Resources if unassigned).
3. On the merchant NPC GameObject (all required):
   - `NpcWorldBehaviour` — `_npcContentKey` set to the NPC's content key
     (e.g. `demo-merchant-area-1`); this bootstraps the NPC and runs sub-initializers. The key
     needs a Merchant row in the NPC registry, or the shop is refused. (`demo-merchant` will not
     do: the registry has it as a QuestGiver.)
   - `NpcMerchantBehaviour` — sends the "stock this shop" intent on world init. Its
     `_itemSpawnerContentKey` (e.g. `demo-merchant-area-1-items`) does not choose the stock: the
     NPC registry row names the spawner. Keep the field equal to that row's spawner anyway, because
     the audit reads it.
   - `NpcInteractionBehaviour` — `Tags To Interact With` must contain the
     player's Malbers Tag, and `Interact Action` should reference
     CR_GameInput ▸ Player/Interact (when unassigned it resolves "Interact"
     from the project-wide input asset and warns). The action must not have a
     Hold interaction, or a tap of E never fires `performed`.
   - A trigger `SphereCollider` (added/configured automatically).

## Where stock lives: server online, local offline

`INpcMerchantService` is bound to `NpcMerchantOnlineOfflineService`
(`Assets/CR/Npcs/Runtime/Merchant/Logic/`), a router in front of the same `NpcMerchantService`
the server runs. It samples `is_playing_online` **on every call** and routes:

| Mode    | Stock, prices, buy, sell, stock-from-spawner | Authoring ops (add/remove/set multiplier) |
|---------|-----------------------------------------------|-------------------------------------------|
| Online  | `NpcMerchantClientUnityHttp` → `/api/v1/merchants/*` on the **game** server address | `NotSupportedException` — the server owns stock; use Crystalline Rift Studio |
| Offline | local `NpcMerchantService` over `playerData.bytes` | local |

Online is **server-authoritative**: there is no local mirror of merchant stock and no fallback
when the server fails. A shop that silently shows yesterday's local stock when the server is down
is worse than one that says it is unavailable, so a failed server read closes the shop with a
`WorldToast` ("The shop is unavailable right now.") rather than opening an empty one.

Two details of the HTTP half:

- The client uses `GameServerHttpAddress`, not `NpcServerHttpAddress` — that one carries a `/npc`
  prefix and 404s every `/api/v1/merchants` route.
- A refused purchase or sale comes back as **409 with a `PurchaseResult` body**. `SimpleWebClient`
  used to collapse every non-2xx into a generic exception with only the status text; it now throws
  `ConflictException` carrying the body, and the merchant client turns that back into a
  `PurchaseResult { Success = false, ErrorMessage }` — which is what the shop shows the player.

One new endpoint backs this: `GET /api/v1/merchants/{npcId}/multipliers` returns buy and sell
multipliers in one call, so pricing the list is one round trip rather than one per row.

## Restocking

The authority restocks a shop, never the client. Online that is the server; offline it is the same
cr-api `NpcMerchantService` running against `playerData.bytes`. On world load `NpcMerchantBehaviour`
sends one "stock this shop" intent, `StockFromSpawnerAsync(accountId, trainerId, npcId)`. The intent
names neither a spawner nor a re-roll, so the client cannot force one, and asking again is harmless.

The authority rolls from the spawner that the merchant's NPC registry row names (see
[The server picks the stock source](#the-server-picks-the-stock-source)), and that spawner's
`restock_cooldown_seconds` decides:

| The shop | The authority |
|---|---|
| has no stock rows (never stocked, or every item bought out) | rolls it |
| has stock, and the cooldown is `0` | keeps it: 0 means "never auto-restock", not "every time" |
| has stock, and the cooldown has not elapsed since the stock last changed | keeps it |
| has stock, and the cooldown has elapsed | re-rolls it: clears the shop and stocks a fresh roll, so a bought-out item comes back |

"Last changed" is the newest `updated_at` among the shop's `npc_inventory` rows. A roll stamps every
row it writes, and a purchase that leaves a row behind restamps it, so buying from a shop pushes its
restock back and a shop is not re-rolled under a player who is trading with it. A row that sells out
is deleted and leaves no stamp. A roll that comes back empty keeps the old stock. The answer is
`{ stocked }`, the number of distinct items rolled, or 0 when the stock was kept.

### When the client asks

- **Offline:** every world load calls the local service, and in the open world so does every cell
  promotion (each visit). A shop that falls due during play restocks on the next visit.
- **Online:** `NpcMerchantOnlineOfflineService` sends the intent at most once per merchant per
  session, through the `CacheScope.MerchantStocked` memo, which clears on an app restart or an
  account or trainer change. When the server reports a roll (`stocked > 0`), the router raises
  `MerchantRestocked`. That drops the cached stock and multipliers and re-opens the memo, so the next
  load asks once more and is told 0. An online shop that falls due mid-session therefore restocks on
  the first visit of a later session.

### The cooldown

Merchant spawners ship at **900 s** (15 minutes). `M6024SetMerchantRestockCooldowns` sets that on
`starting-merchant-items` and `demo-merchant-area-1-items` … `demo-merchant-area-5-items` wherever
the value was still 0, so a cooldown someone already authored stays. The six
`Assets/CR/Content/Defs/ItemSpawners/*MerchantItems.asset` definitions carry the same 900, so a later
push keeps it. Tune it per spawner: set **Restock Cooldown (s)** on the `ItemSpawnerDefinition` and
push it from Crystalline Rift Studio → Item Spawners. The push sends the value as authored, so
pushing 0 switches that shop's auto-restock off on the server.

:::note[History: the client used to decide]
From 2026-08-22, `NpcMerchantBehaviour` forced a clear-and-re-roll on every world load
(`_refreshStockOnWorldLoad`, which passed `force: true`). That accepted a reload-to-reroll exploit so
that shops would not drain to empty under a cooldown of 0, but it let the client choose an outcome:
when stock is wiped. The route stopped honouring `force` in the 2026-09-27 route lockdown, and with
every merchant spawner seeded at 0, no online shop restocked after that, so a bought-out item never
came back. Since 2026-10-10 the call has no `force` and no spawner key, the merchant spawners have a
real cooldown, and online and offline follow the same rule.
:::

## One merchant per area

Each area's merchant is its own NPC with its own stock source. The prefab ships with **empty**
content keys; `cr_polish_areas` stamps them from the area number via `AreaNpcKeys`:

| Area   | NPC key                | Stock spawner                |
|--------|------------------------|------------------------------|
| Meadow | `demo-merchant-area-1` | `demo-merchant-area-1-items` |
| Cave   | `demo-merchant-area-2` | `demo-merchant-area-2-items` |
| Shore  | `demo-merchant-area-3` | `demo-merchant-area-3-items` |
| Crags  | `demo-merchant-area-4` | `demo-merchant-area-4-items` |
| Dunes  | `demo-merchant-area-5` | `demo-merchant-area-5-items` |

Before this, every area instantiated the same prefab with `demo-merchant` baked in, so five bodies
resolved to one `npcs` row and one `npc_inventory`: buy a potion on the Shore and the Dunes
merchant was short one too. The `demo-` / numbered naming is on purpose — this database carries
forward into the real game, and biome names will not survive that.

The stock spawners are seeded by `M6015SeedAreaMerchantSpawners` and authored as
`ItemSpawnerDefinition` SOs under `Assets/CR/Content/Defs/ItemSpawners/`; the two must agree by
content key, which `AreaMerchantSpawnerSqliteTests` reads back through the real roll service.
Edit a merchant's stock by editing its SO and pushing from Crystalline Rift Studio — the seed is the floor,
the SO is the authored truth.

## The server picks the stock source

Since cr-api PR #72 (live 2026-10-10), the authority decides which spawner stocks a merchant. Offline, that
authority is the domain service running against local SQLite. `NpcMerchantService` looks up the merchant's content
key in the NPC registry, reads that row's `item_spawner_content_key`, and rolls from it. The client sends no
spawner key: `StockFromSpawnerAsync` lost the parameter on 2026-10-10 (before that, the scene's
`_itemSpawnerContentKey` was sent and ignored), and the route ignores the `spawnerContentKey` that v0.1.2 to v0.1.7
still post. Keep `_itemSpawnerContentKey` and the registry row in step anyway, because the audit below reads the
scene field.

A merchant with no registry row, a registry row that is not a Merchant, or a row with no spawner is refused with
`MerchantStockNotAllowedException`, and nothing is written. Online, the route returns 404 for those cases. Offline,
the registry rows come from `M16100SeedNpcRegistry_20261009`. The world load logs a refusal as a warning that names
the NPC's content key. An empty shop with a registry refusal in the log means the registry row is missing; the
scene is not the cause.

## Drift the audit catches

`ContentAuditTool` → `AuditAreaNpcs` reads the five area scenes as text (prefab-instance
overrides, no scene load) and reports, per `AreaNpcAudit`:

- `npc_shared_key` — one content key used by more than one area (the original bug)
- `npc_empty_key` — an NPC the polish pass has not stamped
- `npc_undefined_key` / `npc_undefined_spawner` — scene points at a key no SO defines
- `npc_wrong_type` — a scene merchant whose `NpcDefinition.npcType` is not `Merchant` (the SO is
  what syncs, so the server would get the wrong type; `demo-merchant.asset` shipped this way)
- `npc_missing_for_area` — a numbered area with no merchant / quest giver / stock SO

An empty `_itemSpawnerContentKey` no longer empties a shop: the stock intent goes out regardless, and
the registry decides. An empty shop now has one of two causes, both in the log: a registry refusal
(above), or a spawner that rolled nothing. A spawner the authority does not have, or one that is
inactive, logs `[ItemSpawnerRoll] spawner '…' not found or inactive`; either way
`StockFromSpawner: spawner '…' rolled no items` follows, and any old stock is kept.

See also: [Item Spawner](../backend/11-item-spawner.md),
[Trainer Currency](../backend/12-trainer-currency.md).
