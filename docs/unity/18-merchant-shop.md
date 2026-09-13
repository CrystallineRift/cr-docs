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

The merchant's stock itself comes from its item spawner
(see [Item Spawner](../backend/11-item-spawner.md)) via
`NpcMerchantBehaviour.InitializeAsync` on world init.

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
     (e.g. `demo-merchant`); this bootstraps the NPC and runs sub-initializers.
   - `NpcMerchantBehaviour` — `_itemSpawnerContentKey`
     (e.g. `starting-merchant-items`); stocks the merchant on world init.
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

## Stock refreshes on every world load

`NpcMerchantBehaviour` passes `force: true` (`_refreshStockOnWorldLoad`, on by default): each time
the world loads, the merchant's inventory is **cleared and re-rolled** from its spawner. The
spawner's own `restock_cooldown_seconds` only governs mid-session restocks now.

This is a deliberate trade. The earlier rule (cooldown 0 = never re-roll) closed a
reload-to-reroll exploit but meant the shop was the first roll forever, draining to empty as the
player bought — which is what "the merchant isn't being used" looked like in practice.

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

## Drift the audit catches

`ContentAuditTool` → `AuditAreaNpcs` reads the five area scenes as text (prefab-instance
overrides, no scene load) and reports, per `AreaNpcAudit`:

- `npc_shared_key` — one content key used by more than one area (the original bug)
- `npc_empty_key` — an NPC the polish pass has not stamped
- `npc_undefined_key` / `npc_undefined_spawner` — scene points at a key no SO defines
- `npc_wrong_type` — a scene merchant whose `NpcDefinition.npcType` is not `Merchant` (the SO is
  what syncs, so the server would get the wrong type; `demo-merchant.asset` shipped this way)
- `npc_missing_for_area` — a numbered area with no merchant / quest giver / stock SO

An empty shop still logs the two usual causes (missing `_itemSpawnerContentKey` on the NPC, or
missing local spawner config).

See also: [Item Spawner](../backend/11-item-spawner.md),
[Trainer Currency](../backend/12-trainer-currency.md).
