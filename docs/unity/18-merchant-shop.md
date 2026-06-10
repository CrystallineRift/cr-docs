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
| `Assets/CR/UI/Resources/MerchantShopScreen.uxml` | Layout (named elements, zero inline styles). |
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

## Scene wiring (Editor)

1. Add a GameObject with a `UIDocument` (sortingOrder above the HUD) +
   `MerchantShopScreenHandler` to the world UI rig.
2. Assign the shared `isMenuOpen` BoolVariable (the stylesheet auto-loads from
   Resources if unassigned).
3. On the merchant NPC: `NpcMerchantBehaviour._itemSpawnerContentKey`
   (e.g. `starting-merchant-items`).

## Offline stock source

Offline play reads `item_spawner` config from the local game-data database.
`M6014SeedStartingMerchantSpawner` seeds the `starting-merchant-items` spawner
(spawner + pool + five templates, mirroring the `StartingMerchantItems` SO) the
same way `M5009` seeds the starter creature spawner — without it, merchants
stock nothing offline. An empty shop logs the two usual causes (missing
`_itemSpawnerContentKey` on the NPC, or missing local spawner config).

See also: [Trainer Currency](../backend/12-trainer-currency.md).
