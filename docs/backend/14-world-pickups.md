# World Pickups

A **pickup** is a placed world object with a model that, when the player walks over it, grants a set of rewards (creature / item / currency / XP / quest) exactly once per trainer, persistently.

## Concepts

- **Pickup definition** (`pickup_definition`) — reusable content: a `content_key`, a `rewards` set (JSON), a `model_asset_key`, and optional `collect_vfx_key` / `collect_sfx_key`. Authored once, referenced by many placements.
- **Reward set** — a JSON array on the definition. Each element is `{ rewardType, referenceKey, quantity }` where `rewardType` is the integer ordinal of `RewardType` (`Experience=0, Currency=1, Item=2, Creature=3, Quest=4`) and `referenceKey` is the content_key (null for Currency/Experience). Example "lost toy" pickup:

  ```json
  [
    { "rewardType": 2, "referenceKey": "toy_bouncy_ball", "quantity": 1 },
    { "rewardType": 4, "referenceKey": "quest_return_the_toy", "quantity": 1 }
  ]
  ```

  It grants the toy item **and** starts the return quest.

  A reward's `referenceKey` must resolve to real content or the grant is silently skipped with a
  warning: `toy_bouncy_ball` is seeded by `M6018SeedBouncyBallToy` (Items domain — the pickup seed
  shipped before the item existed, and the pickup granted nothing). `quest_return_the_toy` has no
  authored quest template yet; the client logs and skips it until the quest is authored in Content
  Studio.
- **Collected record** (`pickup_collected`) — per-trainer, keyed by `(trainer_id, pickup_instance_id)`. `pickup_instance_id` is the per-placement id (stable on the scene object), so two "gold" pickups are tracked independently. Collection is **one-time and persistent**.

## Granting model

Collection has **one owner both modes**: `IPickupDomainService.CollectAsync(accountId, trainerId, contentKey, instanceId)`:

1. If `IsCollected` → returns `AlreadyCollected`, grants nothing.
2. Definition lookup by content key → missing key returns `DefinitionNotFound`, marks nothing.
3. Every non-`Quest` reward is granted through `IRewardGrantService.GrantAsync`; `Quest` rewards are returned **ungranted** in `PickupCollectResult.QuestRewards` for the consumer to route (QuestManager owns quest acceptance and its events, and `CR.Game` stays free of a dependency on `CR.Quests`).
4. `MarkCollected`, and the result carries `GrantedRewards` + `SpawnedCreatureIds`.

Online this runs **on the server** behind `POST /api/v1/pickups/{trainerId}/collect` — reward grants touch server-owned state (currency, backpack, creatures) that the client may not write; the old client-side grant loop died on `TryAdjustCurrencyAsync` (`NotImplementedException`: currency adjustments are server-side only). Offline the same method runs in-process against the local SQLite DBs.

## Schema

`pickup_definition`: `id`, `content_key`, `rewards` (JSON, default `[]`), `model_asset_key`, `collect_vfx_key` (nullable), `collect_sfx_key` (nullable), `deleted`, `created_at`, `updated_at`.

`pickup_collected`: `id`, `trainer_id`, `pickup_instance_id`, `collected_at`, `deleted`, `created_at`, `updated_at`, with a non-partial `UNIQUE (trainer_id, pickup_instance_id)`.

The collected upsert is **revive-on-write**: a re-collect after a soft-delete revives the existing row rather than colliding on the unique constraint (`INSERT OR IGNORE` + `UPDATE ... SET deleted = 0` on SQLite; `ON CONFLICT ... DO UPDATE SET deleted = false WHERE deleted = true` on Postgres).

Migrations `M7200`–`M7202` (dual-engine, soft-delete, idempotent seeds). `rewards` JSON serializes via Newtonsoft with integer enum ordinals, matching the Unity client's int-enum deserialization convention.

## REST

- `GET /api/v1/pickups` — paginated list of every non-deleted pickup definition, for bulk client sync. `offset`/`limit` query params (default and max `limit` 500). Response: `{ data: [...], offset, limit, total }`, `total` is the full matching row count so a client can detect truncation.
- `GET /api/v1/pickups/{contentKey}` — definition (with deserialized rewards).
- `GET /api/v1/pickups/{trainerId}/collected/{instanceId}` — `{ collected: bool }`.
- `GET /api/v1/pickups/{trainerId}/collected` — every collected instance id for the trainer; fetched once per world load so already-collected pickups never spawn. Ownership-checked (token account must own the trainer, else 404).
- `POST /api/v1/pickups/{trainerId}/collect` `{ contentKey, instanceId }` — the server-authoritative collect: grants non-quest rewards and marks collected in one place, returns `PickupCollectResult` (`status`: Collected / AlreadyCollected / DefinitionNotFound, `grantedRewards`, `questRewards`, `spawnedCreatureIds`). Ownership-checked. Pinned by `PickupCollectHttpTests` (currency actually credits, second collect grants nothing, IDOR 404).
- `POST /api/v1/pickups/{trainerId}/collected` `{ instanceId }` — record collection only (idempotent; legacy/low-level).
- `GET|POST /api/v1/pickups/sync-config` — Content Studio pull/push.

## Offline parity

The pickup definition (content) and the collected store both follow the online/offline pattern: the collected store is backed by the **PlayerData** SQLite DB offline (same DB as trainer currency/inventory) and the collect/collected-list endpoints when connected. Collection persists across sessions in both modes. The Unity `PickupCollectedRegistry` loads the collected set once per world load (server online, local DB offline) and every `PickupBehaviour` destroys itself at spawn when its instance is in the set.

## Follow-ups

- Content Studio authoring (`PickupDefinition` SO + tab + sync write service).
