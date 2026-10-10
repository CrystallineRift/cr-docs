# Merchant Shop UI

Player-facing shop opened by interacting (E) with a merchant NPC. Lists the
merchant's stocked inventory with live buy prices, shows the trainer's wallet,
and purchases into the backpack.

## Flow

```
NpcInteractionBehaviour (proximity + E)
  ├─ EnterRange, merchant on offer → NpcMerchantBehaviour.OnPlayerApproached → "stock this shop" ask
  └─ merchant branch (_merchantBehaviour.IsReady)
       └─ MerchantShopScreenHandler.Open(npcId, accountId, trainerId)
            ├─ ITrainerRepository.GetTrainerById      → wallet + backpack inventory id
            ├─ INpcMerchantService.ReadShelfAsync     → the ask (joined, or skipped inside 60 s), then
            │                                           GetMerchantInventoryAsync
            ├─ IItemDomainService.GetItemAsync        → name / description / assetKey
            ├─ INpcMerchantService.CalculateBuyPriceAsync → unit price (BaseValue × BuyMultiplier)
            └─ Buy → INpcMerchantService.PurchaseItemFromMerchantAsync
                      (debits currency + moves stock → backpack, one transaction)
```

The merchant's stock itself comes from the item spawner its NPC registry row names
(see [Item Spawner](?page=backend/11-item-spawner)). World init never asks for stock: the "stock this
shop" intent goes out when the player walks up to the merchant and again as the shop opens, and the
authority decides whether anything is rolled (see [Restocking](#restocking)).

## Key files

| File | Role |
|------|------|
| `Assets/CR/UI/Shop/MerchantShopScreenHandler.cs` | UI Toolkit screen: rows, wallet, qty stepper, Buy, status line. `IContextAwareScreen` — force-closes when leaving the Overworld context. |
| `Assets/CR/UI/Shop/MerchantShopItem.cs` | Resolved row struct (itemId, name, desc, unitPrice, stock, assetKey). |
| `Assets/CR/UI/Resources/MerchantShopScreen.uxml` | Screen layout (named elements, zero inline styles). |
| `Assets/CR/UI/Resources/MerchantShopItemRow.uxml` | One stock row — designer-editable template; the handler only binds data/callbacks by element name. |
| `Assets/CR/UI/Resources/MerchantShopScreen.uss` | All styling via named classes (BattleBagPanel design language: deep navy, blue borders, dimmed overlay). Loaded from Resources as a fallback when the Inspector field is unassigned, so the screen never renders unstyled. |
| `Assets/CR/Game/World/Behaviours/NpcInteractionBehaviour.cs` | Merchant interact branch; locates the screen lazily (`FindFirstObjectByType`) so shop-less scenes still resolve DI. |
| `Assets/CR/Game/World/Behaviours/NpcMerchantBehaviour.cs` | Marks the NPC as a merchant; `OnPlayerApproached` sends the walk-up "stock this shop" ask (the first one after load waits 0 to 2 s). World init asks nothing. |
| `Assets/CR/Npcs/Runtime/Merchant/Logic/MerchantStockAsks.cs` | The session's record per merchant: joins an ask in flight, skips one within 60 s of the last, records the time before the call. Used by the router in both modes. |
| `Assets/CR/Npcs/Runtime/Merchant/Logic/MerchantShelfExtensions.cs` | `ReadShelfAsync`: the shop's "ask, then read". |
| `Assets/CR/Npcs/Runtime/Merchant/Logic/MerchantAskJitter.cs` | The random 0 to 2 s wait before a merchant's first ask. |

## Behaviour details

- **Affordability**: each row's Buy button shows the total (`unit × qty`) and is
  disabled (+ `.shop-buy-button--disabled`) when the wallet can't cover it.
  The server/domain transaction remains the authoritative funds check.
- **Wallet**: updated from `PurchaseResult.NewBalance` after each purchase; the
  stock list reloads so quantities reflect the sale.
- **Refused purchase**: the shelf is read again (the server gives no error code for "not enough in
  stock", and the list on screen may predate a restock), and the refusal stays in the status line.
- **Closed while loading**: a shop closed while its ask or read was in flight does not build its
  panel afterwards.
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

| Mode    | Stock, prices, buy, sell, stock-from-spawner | Authoring ops (add/remove/clear/set multiplier) |
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
cr-api `NpcMerchantService` running against `playerData.bytes`. The client only sends the "stock this
shop" intent, `StockFromSpawnerAsync(accountId, trainerId, npcId)`. The intent names neither a spawner
nor a re-roll, so the client cannot force one, and asking again is harmless.

### When the client asks

Never on world load, login, area load or cell streaming. `NpcMerchantBehaviour.InitializeAsync` only
records whose shop it is and sets `IsReady`, so a world full of merchants costs no stock call until the
player goes near one. The intent goes out at two moments, the same online and offline:

- **The player walks up to the merchant.** `NpcInteractionBehaviour.EnterRange`, after the offer check,
  calls `NpcMerchantBehaviour.OnPlayerApproached()`. A merchant with nothing on offer (not ready yet, or
  an escort that is walking) does not ask; it asks once `OnTriggerStay` finds it on offer. A player who
  spawns or is restored inside the range gets there on the first Stay. The first ask after the merchant
  came to life waits a random 0 to 2 s (`MerchantAskJitter`), so a crowd that logs in next to a shop
  does not ask in the same instant. Later asks do not wait.
- **The shop opens.** `MerchantShopScreenHandler` reads the shelf through `ReadShelfAsync`
  (`MerchantShelfExtensions`): ask first, then read. The re-read after a purchase does not ask again.

`NpcMerchantOnlineOfflineService` rations both through one session-scoped record per merchant
(`MerchantStockAsks`):

- An ask already in flight is joined, never repeated. A shop opened during the walk-up ask waits for
  it, then reads the shelf it left.
- Otherwise an ask less than 60 s after the last one about that merchant is not made, and answers 0.
- The time is recorded **before** the call, whatever the outcome. A refusal, a 429 and an unreachable
  server debounce exactly like a success, so a failing route is not asked again on every approach. The
  clock is monotonic, so changing the system clock moves nothing.
- When the authority reports a roll (`stocked > 0`), the router invalidates that merchant's
  `MerchantStock` cache key and nothing else (no other merchant, no prices). The next read of that shelf
  goes back to the server.
- Offline, a clear, a removal or a quantity edit (each can reset a shelf) forgets that merchant's last
  ask, so the next approach asks at once.

Online, a failed ask is warned about and surfaces as the router's `InvalidOperationException`
("… was not stocked …"), never as a local re-roll. Offline, the local refusal reaches the caller as it
is. `NpcMerchantBehaviour` never throws from an ask: a refusal or a failure is one warning naming the
NPC, a cancellation is routine, anything else is an error with its exception, and the common answer
(0, stock kept) is a Debug line. When the shop's own ask fails, the shop shows the shelf as it stands.

The online body is `{ trainerId }` and nothing else: the account comes from the token and the NPC from
the route. The route takes no Idempotency-Key and ignores one that is sent (`SimpleWebClient` attaches
one to every write, see [HTTP Clients](?page=unity/05-http-clients)). A repeated or retried ask is
harmless, because the roll is a compare-and-set.

### What the authority decides

The shelf's history lives on the player's copy of the merchant (`npcs`, per account and trainer;
player-data offline), in three columns that `M16010AddMerchantStockStampsToNpcs` adds:

| Column | Meaning |
|---|---|
| `stock_rolled_at` | When the shelf was last rolled. Null means never rolled (or cleared), so the next ask rolls it. |
| `stock_touched_at` | When a purchase or a sale last touched the shelf. Null means nothing has traded with it since its roll. |
| `stock_roll_seq` | +1 on every roll and every reset. The roll's compare-and-set claims against it. |

The authority rolls from the spawner that the merchant's NPC registry row names (see
[The server picks the stock source](#the-server-picks-the-stock-source)), and decides:

| The shelf | The authority |
|---|---|
| rolled, and nothing has touched it since | keeps it, however long ago the roll was. This is the common answer, and it costs one row read (the NPC row the refusal check reads anyway): no registry, spawner or shelf read, and no write |
| never rolled (no `stock_rolled_at`), or cleared | rolls it, replacing any rows it holds |
| touched, and the spawner's cooldown is `0` | keeps it: 0 means "never auto-restock" |
| touched, and the cooldown has not run since the **last** touch | keeps it |
| touched, and the cooldown has run since the last touch | re-rolls it, so a bought-out item comes back |

- **The clock runs from the last trade, not from the roll.** Every purchase and every sale re-stamps
  `stock_touched_at`. A shelf someone is buying from is never replaced under them, and a shop bought out
  completely waits for the cooldown like any other.
- **Untouched stock never restocks, and a re-roll needs a trade.** There is at most one re-roll per
  (trainer, merchant) per cooldown. The roll clears the touch, so the shelf is back to "rolled and
  untouched".
- **Concurrent asks roll once.** The roll is drawn first. Then one transaction claims the shelf with a
  compare-and-set on `stock_roll_seq` **and** the touch stamp the ask read, and writes the new rows
  (`ReplaceMerchantStockInTransactionAsync`). The ask whose claim matches writes; any other matches
  nothing and writes nothing. A purchase or sale that commits between an ask's read and its claim moves
  the touch stamp, so that claim loses too: the shelf is not replaced under the buyer, and the next ask
  decides on the shelf as the trade left it.
- **An empty roll is still a roll.** The claim commits (the roll is on record and the touch is cleared),
  the shelf keeps its rows, and a warning is logged, so later asks take the one-read path instead of
  rolling again on every approach. The price: a shelf with no rows whose first roll comes up empty stays
  empty until a sale and the cooldown, or an operator's clear, bring it round again. That is what a
  guaranteed (probability 1) item in every merchant spawner is for. The Cave, Shore, Crags and Dunes
  spawners have none yet, so their first roll comes up empty 0.16% to 2.8% of the time.
- **Trades stamp inside their own transaction**, right after the debit and before any `npc_inventory`
  write, so a rolled-back trade leaves no stamp. The lock order everywhere is the trainer, then the
  `npcs` row, then `npc_inventory`. Every stamp a request writes is a C# `DateTime.UtcNow` reading, so
  the database's time zone does not matter.

The answer is `{ stocked }`, the number of distinct items rolled, or 0 when the shelf was kept.

**Deploying M16010 re-rolls nothing.** Its backfill stamps every live merchant that holds rows as rolled
at its newest row and leaves it untouched, so every existing shelf counts as stocked and untouched. A
merchant with no rows (a shop bought out under the old rules) has no roll to remember, and its next ask
rolls it once. A content push never re-rolls a shelf either: a changed spawner reaches a shelf at its
next legitimate roll. (Whether operators want an explicit "reset this merchant's shelves" action is an
open question.)

**Clearing a shop is content-write only (Crystalline Rift Studio / operators); the client cannot clear
or force a re-roll.** A clear forgets the shelf's history (rolled and touched cleared, sequence + 1), so
the next ask rolls it. A player who could clear a shop could therefore re-roll it past the cooldown.
`DELETE /api/v1/merchants/{npcId}/inventory` needs a content-write token, and the operator names
`accountId` and `trainerId` in the query; a player token gets 403 and the shop is left as it was. An
authoring removal or quantity edit that empties a shelf resets it the same way, so an emptied shelf
cannot stay "stocked and untouched" for ever. In the client,
`NpcMerchantOnlineOfflineService.ClearMerchantInventoryAsync` is an offline-only authoring write like the
others (see [Where stock lives](#where-stock-lives-server-online-local-offline)): online it throws
`NotSupportedException` and sends nothing. Offline it still clears the local database, and no game code
calls it. See [NPC System → Merchant REST Endpoints](?page=backend/02-npc-system#merchant-rest-endpoints).

### The cooldown

Merchant spawners ship at **900 s** (15 minutes after the last trade). `M6024SetMerchantRestockCooldowns` sets that on
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
real cooldown, and online and offline follow the same rule. The first version of that change (never
released) still asked on every world load, once per merchant per session online, and counted the
cooldown from the shelf's newest row, so a shop bought out completely rolled again at once and a
deploy would have re-rolled every shop. Restock v2 (the same day) replaced both: asks come from walking
up to a merchant, and only a touched shelf restocks.
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
the registry rows come from `M16100SeedNpcRegistry_20261009`. The walk-up ask logs a refusal as a warning that names
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
`StockFromSpawner: spawner '…' rolled no items for NPC …; the roll is recorded and the shelf keeps its rows`
follows. The empty roll is recorded, so that shelf is not rolled again until a sale and the cooldown,
or an operator's clear (see [What the authority decides](#what-the-authority-decides)).

See also: [Item Spawner](?page=backend/11-item-spawner),
[Trainer Currency](?page=backend/12-trainer-currency).
