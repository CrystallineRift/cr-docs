# Trainer Currency

Trainers carry a spendable currency balance used by the merchant economy and quest rewards.

## Data model

| Field | Where | Notes |
|-------|-------|-------|
| `trainers.currency` | `M4012AddCurrencyToTrainer` | `BIGINT NOT NULL DEFAULT 500` — new **and existing** trainers start with 500. |
| `TrainerBase.Currency` | `CR.Game.Model/Trainers/TrainerBase.cs` | `long`; rides every trainer SELECT and the `/trainer/{id}` GET automatically. |

The balance can never go negative — that invariant is enforced in SQL, not in callers.

## Adjusting the balance

All changes flow through two repository methods on `ITrainerRepository`
(implemented once in `BaseTrainerRepository`, shared by Postgres and SQLite):

```csharp
Task<bool> TryAdjustCurrencyAsync(Guid trainerId, long delta);
Task<bool> TryAdjustCurrencyInTransactionAsync(Guid trainerId, long delta, IDbTransaction? txn = null);
```

Both run a **conditional UPDATE**:

```sql
update trainers set currency = currency + @delta
 where id = @id and currency + @delta >= 0 and not deleted
```

`false` (zero rows) means the trainer is missing *or* the debit would overdraw —
this is the race-safe guard, so callers treat `false` as "insufficient funds".
`currency` is deliberately **not** part of `_updateTrainerSql`: profile/appearance
updates cannot clobber the balance.

## Who debits / credits

| Flow | Where | Behaviour |
|------|-------|-----------|
| Merchant purchase | `NpcMerchantService.PurchaseItemFromMerchantAsync` | Fast-fails with "Insufficient funds" before the transaction, then debits `ceil(totalPrice)` **inside** the purchase transaction as its first statement — a failed debit rolls back the whole purchase. `PurchaseResult.NewBalance` carries the post-purchase balance. |
| Merchant sell | `NpcMerchantService.SellItemToMerchantAsync` | Credits `floor(totalPrice)` inside the sale transaction; `SellResult.NewBalance`. |
| Quest reward | `QuestDomainService.GrantRewardAsync` | `QuestRewardType.Currency` credits `reward.Quantity` (previously this case incorrectly aliased to the Item grant). |

## No client adjust endpoint — by design

There is deliberately **no** REST endpoint that accepts a raw currency delta:
a client-controlled delta would let players mint money. Balance changes happen
only through the server-side reason-coded flows above. The Unity
`TrainerOnlineRepository` therefore throws `NotImplementedException` for the
adjust methods; offline play uses the shared SQLite repository directly (the
local player owns their own save).

## Offline (Unity)

The player-data SQLite database picks up `M4012` automatically on next boot via
`RunDatabaseMigrationsSynchronously` after a `build-packages.sh` rebuild;
existing saves gain the column with the 500 default.

## Tests

- `TrainerRepositoryTests` (Docker/Postgres): default-500, credit/debit, over-debit rejected.
- `NpcMerchantServiceTests`: exact debit, insufficient-funds fast-fail (no inventory movement), debit-race rollback, sell credit.
- `QuestDomainServiceTests`: Currency reward credits and does not touch the item-grant path.

## Merchant atomicity (A2, 2026-09-27)

Purchase: debit (guarded) → take the merchant's stock by guarded decrement inside the same transaction
(`INpcInventoryRepository.TryTakeMerchantStockInTransactionAsync`, quantity and the limited-stock counter together) → add to the bag.
A lost stock take rolls back, refunding the debit ("This item is out of stock."). Sell: take the sold units from the bag entry by
guarded decrement **before** crediting; twenty parallel sales of the last unit credit once.

Since merchant restock v2 (2026-10-10, M16010) both trades also stamp the merchant's shelf touched
(`INpcRepository.TouchMerchantStockInTransactionAsync`, `npcs.stock_touched_at = DateTime.UtcNow`) inside
the same transaction, right after the debit and before any `npc_inventory` write. The lock order is
therefore trainer, then the merchant's `npcs` row, then `npc_inventory`, the same as the restock roll's,
and a trade that rolls back takes its stamp with it. The restock cooldown runs from that stamp, so a
shelf is only ever re-rolled after a trade (see
[Item Spawner → Stocking a merchant](?page=backend/11-item-spawner#stocking-a-merchant)).
`APurchaseThatLosesItsTake_RollsBackTheStampAndTheMoneyTogether` (`OfflineMerchantRestockSqliteTests`)
and `ASale_TouchesTheShelf_InItsTransaction` (`MerchantRestockHttpTests`) pin it.
