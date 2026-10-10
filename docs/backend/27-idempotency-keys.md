# Idempotency Keys

Every player *write intent* (a POST that changes state, not a POST that only reads) can be retried
safely with an `Idempotency-Key` header: a client-generated GUID scoped to one logical user action. A
retry with the same key and the same body replays the first call's response instead of running the
handler again — the boundary is the same shape as the server-authority rule elsewhere in the codebase:
the *client* decides when it is retrying, the *server* decides what happened, exactly once.

## Why this exists

A mobile client on a flaky connection cannot tell "the server never got my request" from "the server
got it, did the write, and the response was lost on the way back." Retrying blindly without a dedup key
risks a double effect — two swaps, two talent spends, two battle turns submitted for the same round.
The `Idempotency-Key` header removes that ambiguity: the same key always resolves to the same outcome.

## The header and its semantics

| Situation | Response |
|---|---|
| First time this key has been seen for this account | The handler runs normally. |
| Same key, same request (method + resolved path + query + body) as a `Completed` claim | The stored response is replayed verbatim, with an `Idempotent-Replayed: true` header added. The handler does **not** run again. |
| Same key, a *different* request, against a `Completed` claim | `422 Unprocessable Entity`, `{"error":"idempotency_key_reused"}`. The key was reused for a different call — a client bug, not a retry. |
| Same key, a claim that is still `InProgress` (another request with this key has not finished) | `409 Conflict`, `{"error":"idempotency_in_progress"}`, `Retry-After: 1`. The client should back off and retry. |
| Header missing or not a GUID | Governed by `Idempotency:RequireKey` — see below. |

The request hash mixes in the HTTP method and the *resolved* request path (not just the route
template) and query string, not only the body: several of these routes send an empty body (e.g.
`receive-gift`), and hashing the body alone would let one key silently replay across two different
targets (two different NPCs, two different trainers) that both happen to post nothing.

## `Idempotency:RequireKey`

A missing/malformed header is accepted by default (`Idempotency:RequireKey: false`, `appsettings.json`)
— the request proceeds unkeyed and a warning is logged. Flipping the switch to `true` makes the header
mandatory on every route that requires one (`400 Bad Request`, `{"error":"idempotency_key_required"}`
otherwise). This is a **user step**: flip it alongside the client's `MinClientVersion` gate bump once
every shipped client attaches the header, the same pattern used elsewhere in this codebase for a
behavior change that would otherwise break an old client outright.

## Which routes require it

Coverage is driven straight off `RoutePolicyManifest` (`RoutePolicyCoverageTests.cs`), the same source
of truth `RoutePolicyCoverageTests` itself checks every mapped route against: any non-`GET` row whose
policy is `Pol.Player` or `Pol.Authenticated` and whose ownership is `Own.Guard`, `Own.Handler`, or
`Own.Account` — i.e. a route that reads identity from the token and writes state scoped to that
account/trainer — must carry `.RequireIdempotencyKey()`. `Pol.Content`, `Pol.Admin`, and `Pol.Retired`
are out of scope blanket (operator/content-write surfaces and dead 410 routes, not player-facing
retry-prone client intents), and so is `Pol.Anon` (auth bootstrap/account creation: no authenticated
principal exists yet to claim the idempotency record's `principal_id` against).

`IdempotencyKeyCoverageHttpTests.Every_player_write_route_in_the_manifest_requires_an_idempotency_key`
enforces this: it fails the build the day a new in-scope route is added without also calling
`.RequireIdempotencyKey()`, unless the route is listed in the test's `Exemptions` dictionary with a
written reason. Four routes are exempted today:

| Route | Why |
|---|---|
| `PUT /trainer/{trainerId:guid}/location` | A continuous position-sync tick fired on every world-location change during normal movement, not a discrete gameplay intent. Last-write-wins, nothing additive a duplicate could double. |
| `POST /api/v1/trainers/{trainerId:guid}/creatures/by-ids` | A read (bulk fetch by id list) shaped as `POST` only because the id list doesn't fit a `GET` query string — no mutation. |
| `POST /api/v1/npc/ensure` | Idempotent by construction — creates a bare NPC only if one doesn't already exist. |
| `POST /api/v1/pickups/{trainerId:guid}/collected` | Mark-only bookkeeping keyed by `instanceId`, grants nothing. The reward-granting route is `/collect`, which **is** keyed. |

This covers every player write intent in the manifest today, including trainer create/update/delete,
trainer inventory create/update/delete, team heal, account link/password/personal-API-key
create+revoke, `/auth/oauth/link`, evolution begin/commit/cancel, stats increment/max/set, market
list/cancel/buy, merchant purchase/sell/stock-from-spawner, quest accept/abandon/
claim-rewards, item use, held-item equip/unequip, pickup collect, plus the original curated set
(battle-start, `receive-gift`, `talk`, `world-locations/enter`, `talents/spend`, `talents/respec`, and
the whole `TrainerCreatureIntentEndpoints` group).

**Deferred:** the `Exemptions` dictionary's staleness check only catches an exemption that stopped
applying (route removed or reclassified) — it does not stop someone from adding a new exemption for a
route that should actually be keyed. The written-reason requirement is a norm the test does not enforce.

## How it is implemented

`IdempotencyKeyMiddleware.cs` (`CR.Auth.Service.REST/Security`) is **middleware**, not a per-route
endpoint filter: it must buffer and hash the raw request body before minimal-API model binding
consumes the request stream, and ASP.NET Core middleware runs ahead of that — an endpoint filter's
`Arguments` are already bound by the time the filter delegate itself runs. `.RequireIdempotencyKey()`
only attaches a marker (`IdempotencyKeyMetadata`) to the route; `app.UseIdempotencyKeys()` (registered
once in `Program.cs`, after `UseAuthentication()`/`UseAuthorization()`/`UseRateLimiter()`) is the one
place that reads it, claims/completes/deletes the ledger row, and replays or forwards accordingly.

The ledger table is `idempotency_record` (`M16009CreateIdempotencyRecordTable`, Auth domain — the same
home as `RateLimitPolicies` and personal API keys, since this is cross-cutting REST security
infrastructure rather than any one gameplay domain's data). The claim itself is a plain `INSERT` that
relies on catching the unique-index violation on `(principal_id, idem_key)` rather than branching
`ON CONFLICT` (Postgres) vs `INSERT OR IGNORE` (SQLite) syntax — the same message-matching idiom
`NpcDomainService`'s guarded storage insert already uses. A small, bounded sweep of expired rows runs
lazily inside every claim attempt (`LIMIT 20`), so the table cannot grow without bound purely from
callers who never retry, without needing a background job.

**Ruling:** `idempotency_record` does not use the soft-delete (`deleted` column) convention the rest of
the schema follows — the column is present for schema-convention consistency but is never set to
`true`. This table is a short-lived dedup cache, not domain state worth an audit trail, and the whole
point of `expires_at` is bounded growth; keeping every expired claim forever (soft-deleted or not)
would defeat that. Expired rows are hard-deleted by the lazy sweep.

A 5xx response is never stored: the caller cannot tell whether the write actually happened, so a claim
that ended in a 5xx is deleted (same for an unhandled exception), letting a retry with the same key run
the handler again rather than being permanently stuck replaying a failure.

## Testing

- `IdempotencyKeyMiddlewareTests` (`CR.Auth.Service.REST.Test`) — the full state machine against a
  `DefaultHttpContext`, no TestServer/Docker needed: passthrough for an unguarded route, the
  `RequireKey` on/off branches, new-claim success (`CompleteAsync`), new-claim 5xx and handler-throw
  (`DeleteAsync`, never `CompleteAsync`), replay/reused/in-progress outcomes, and the
  method+path+body hash mix.
- `IdempotencyRecordRepositoryTests` (`CR.Auth.Data.Sqlite.Test`) — the claim state machine directly
  against a real migrated SQLite database: new → in-progress → replay → hash-mismatch, delete-then-retry,
  and the expiry sweep freeing a key for reuse.
- `IdempotencyKeyHttpTests` / `IdempotencyKeyCoverageHttpTests` (`CR.Api.IntegrationTests`, Docker) —
  end-to-end through the real AIO host and Postgres against `team-storage-swap` (a write with an
  observable, order-sensitive side effect): replay returns the exact first response and does not
  re-run the swap, a reused key with a different body is `422` and changes nothing, a pre-seeded
  `InProgress` claim is `409` and never reaches the handler, and a pre-seeded expired claim does not
  block a fresh one. The coverage test enumerates every mapped route and fails if an in-scope player
  write route is missing the metadata and is not listed in `Exemptions`.

## Client side

Not yet implemented — see [HTTP Clients](../unity/05-http-clients.md#server-idempotency-keys-planned)
for the planned shape (one key per logical user action, attached by the shared web layer, reused
across Polly retries of that same call).
