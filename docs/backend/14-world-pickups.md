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
- **Collected record** (`pickup_collected`) — per-trainer, keyed by `(trainer_id, pickup_instance_id)`. `pickup_instance_id` is the per-placement id (stable on the scene object), so two "gold" pickups are tracked independently. Collection is **one-time and persistent**.

## Granting model

The backend is **data only** — it serves the definition and the collected state. Granting is orchestrated by the consumer (the Unity `PickupBehaviour`):

1. Check `IsCollectedAsync(trainerId, instanceId)`; if already collected, ignore.
2. For each reward in the set: `Quest` → start via the quest manager; everything else → `IRewardGrantService.GrantAsync`.
3. `MarkCollectedAsync(trainerId, instanceId)`, fire VFX/SFX, despawn.

`Quest` is consumer-routed (not handled by `IRewardGrantService`) to keep `CR.Game` free of a dependency on `CR.Quests`.

## Schema

`pickup_definition`: `id`, `content_key`, `rewards` (JSON, default `[]`), `model_asset_key`, `collect_vfx_key` (nullable), `collect_sfx_key` (nullable), `deleted`, `created_at`, `updated_at`.

`pickup_collected`: `id`, `trainer_id`, `pickup_instance_id`, `collected_at`, `deleted`, `created_at`, `updated_at`, with a non-partial `UNIQUE (trainer_id, pickup_instance_id)`.

The collected upsert is **revive-on-write**: a re-collect after a soft-delete revives the existing row rather than colliding on the unique constraint (`INSERT OR IGNORE` + `UPDATE ... SET deleted = 0` on SQLite; `ON CONFLICT ... DO UPDATE SET deleted = false WHERE deleted = true` on Postgres).

Migrations `M7200`–`M7202` (dual-engine, soft-delete, idempotent seeds). `rewards` JSON serializes via Newtonsoft with integer enum ordinals, matching the Unity client's int-enum deserialization convention.

## REST

- `GET /api/v1/pickups` — paginated list of every non-deleted pickup definition, for bulk client sync. `offset`/`limit` query params (default and max `limit` 500). Response: `{ data: [...], offset, limit, total }`, `total` is the full matching row count so a client can detect truncation.
- `GET /api/v1/pickups/{contentKey}` — definition (with deserialized rewards).
- `GET /api/v1/pickups/{trainerId}/collected/{instanceId}` — `{ collected: bool }`.
- `POST /api/v1/pickups/{trainerId}/collected` `{ instanceId }` — record collection (idempotent).
- `GET|POST /api/v1/pickups/sync-config` — Content Studio pull/push.

## Offline parity

The pickup definition (content) and the collected store both follow the online/offline pattern: the collected store is backed by the **PlayerData** SQLite DB offline (same DB as trainer currency/inventory) and the REST endpoints when connected. Collection persists across sessions in both modes.

## Follow-ups

- Unity runtime: `PickupBehaviour`, the pickup HTTP client + online/offline routing, DI bindings, and the SQLite migrator registration.
- Content Studio authoring (`PickupDefinition` SO + tab + sync write service).
