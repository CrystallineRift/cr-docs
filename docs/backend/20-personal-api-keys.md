# Personal API Keys

Editor tooling authenticates the same way it always has — exchanging a key for a JWT at
`POST /auth/service-token` — but the key a human pastes into Crystalline Rift Studio no longer has
to be one of the two deployment-wide secrets. **Personal API keys** are owned by an account, created
and revoked from Studio web, and carry that account's own scopes.

## Why

`AdminServiceKey` and `EditorServiceKey` (see
[Auth and Accounts → Service Tokens](06-auth-and-accounts.md#service-tokens-content-studio-and-live-ops))
are a single shared secret per scope, and that has four sharp edges:

- **Rotation is an operational event.** Changing a key means an env edit, an API restart, and every
  editor re-pasting the new value.
- **Nothing is revocable per person.** There is no way to cut off one compromised or departed
  editor without rotating the key everyone else is also using.
- **Actions attribute to nobody.** A service-token session's `account_id` is `Guid.Empty`, so a
  content push or a Live Ops action is attributed to the key, not to the person holding it.
- **The dev defaults are public.** `local-dev-admin-service-key` and `local-dev-editor-service-key`
  are checked into the repo, which is fine for local dev and nowhere else.

A personal key fixes all four: it belongs to one account, an admin or the owner can revoke it
without touching anyone else's, and its scopes are derived from that account's roles at exchange
time rather than fixed at creation — pull a role and every key that person holds loses the power on
its next exchange.

## Key format and hashing

A key is `crk_<prefix>_<secret>`:

| Part | Shape |
|---|---|
| `prefix` | 8 characters, `[a-z0-9]` |
| `secret` | 32 bytes from `RandomNumberGenerator`, base64url-encoded, no padding |

The server stores two derived values, never the plaintext:

- `key_prefix` — the lookup half, unique across the whole table (including revoked rows), so one
  indexed read finds the row without scanning.
- `key_hash` — SHA-256 of the **whole** plaintext key, lowercase hex.

The plaintext is shown exactly once, in the create response. Verifying a presented key hashes it
and compares against the stored hash with `CryptographicOperations.FixedTimeEquals` — the same
constant-time comparison the two env keys already use, so a personal key costs an attacker no more
timing information than a service key does.

## Schema

`account_api_key` lives in the Auth domain, added by `M0014CreateAccountApiKeyTable`:

| Column | Type | Notes |
|---|---|---|
| `id` | uuid | PK |
| `account_id` | uuid | `accounts.id`, **no FK constraint** — the Auth schema has never declared one across its own tables, and `account_role` (M0011) sets the same precedent |
| `name` | text | 1..64 chars, operator-chosen label |
| `key_prefix` | text | **unique**, the exchange path's only lookup |
| `key_hash` | text | SHA-256 of the whole plaintext, hex |
| `created_at` | timestamp | default `CurrentUTCDateTime` |
| `last_used_at` | timestamp | null until the key is first exchanged |
| `revoked_at` | timestamp | null while the key is live |
| `deleted` | boolean | project convention; a revoke sets `revoked_at`, never `deleted` — the row stays visible to its owner and to an operator |

Indexed on `key_prefix` (unique) and `account_id`. Both engines, no `isSqlite` branch — every
column type here is already portable, so this is one of the few Auth migrations with no
engine-specific DDL at all.

:::note Version 14 is a global number, not an Auth-domain number
FluentMigrator's `VersionInfo` table is shared across every domain (see
[Backend Architecture → Migration order is one list](01-architecture.md#migration-order-is-one-list)).
`14` was free across the whole namespace, not just within Auth's own migration history — Auth's
prior migration is `M0013AddAccountsEmailUniqueIndexSqlite`, but the number that matters for
collision-checking is the highest version claimed by *any* domain, since whichever domain migrates
first claims a given integer.
:::

## Repository

`IAccountApiKeyRepository` (`CR.Auth.Data`), with Postgres and SQLite implementations registered
keyed (`AuthConstants.AUTH_DB`) and non-keyed in `Program.cs`, the same pattern as
`IAccountRoleRepository`. The SQLite implementation uses the GUID-normalizing connection, like every
other Auth SQLite repository.

| Method | Behaviour |
|---|---|
| `CreateAsync(accountId, name, keyPrefix, keyHash, ct)` | Inserts and returns the row as written — no read-back, since the insert is the only writer of those values |
| `GetByPrefixAsync(keyPrefix, ct)` | Returns the row **including revoked ones**; the exchange path must hash-compare before it decides anything, so a revoked prefix and an unknown one cost the same and answer the same |
| `ListForAccountAsync(accountId, ct)` | Newest first, revoked included |
| `RevokeAsync(accountId, keyId, ct)` | Sets `revoked_at`; `false` if the key does not exist or is owned by another account. The ownership check is part of the `UPDATE`, not a read in front of it, so a caller cannot revoke a key by guessing its id. Revoking an already-revoked key is a no-op that still returns success, so the route above it is idempotent |
| `TouchLastUsedAsync(keyId, utcNow, ct)` | Stamps `last_used_at` on a successful exchange |

## Endpoints

DTOs live in `CR.Auth.Model.REST` (generation and verification in `CR.Auth.Service.REST/Security/ApiKeyFormat.cs`, server-only — the Model project targets netstandard2.1), all JSON camelCase, dates ISO-8601 UTC:

```
ApiKeySummary     { id, name, keyPrefix, createdAt, lastUsedAt?, revokedAt? }
ApiKeyCreated     { key, summary: ApiKeySummary }   // key is plaintext, shown once
CreateApiKeyRequest { name }
```

| Route | Policy | Behaviour |
|---|---|---|
| `GET /account/keys` | `RequirePlayer` | The caller's own keys, newest first, revoked included |
| `POST /account/keys` | `RequirePlayer` | Body `{name}`. `400` if blank or over 64 chars. `401` if the token has no account behind it (a service-key token). `200` → `ApiKeyCreated`, with the plaintext key shown once |
| `DELETE /account/keys/{id}` | `RequirePlayer` | Revoke a key you own. `204`. `404` if it is not yours or does not exist. Idempotent — revoking an already-revoked key still answers `204` |
| `GET /api/v1/admin/accounts/{accountId}/keys` | `RequireAdmin` | That account's keys, for the operator view |
| `DELETE /api/v1/admin/accounts/{accountId}/keys/{id}` | `RequireAdmin` | Body `{reason}`. Revokes the key and writes an `admin_action` row, kind `RevokeApiKey`, metadata `{"keyId":…,"keyPrefix":…}` |
| `POST /auth/service-token` | anonymous | Unchanged request shape — see below |

`GET /account/me` works with a personal-key token exactly as it does with a password-login token,
since the token names a real account — that is how Studio shows *whose* key is doing the talking,
and how the Unity editor will show a key's identity.

### The service-token exchange, in order

`POST /auth/service-token` still takes `{serviceKey}` and tries, in this order:

1. **`AdminServiceKey`** (env) — unchanged, session account is `Guid.Empty`.
2. **`EditorServiceKey`** (env) — unchanged, session account is `Guid.Empty`.
3. **A personal key** — if the presented value parses as `crk_<prefix>_…`, look it up by prefix,
   require `revoked_at IS NULL` and a matching hash, then resolve scopes for **that account** via
   `ScopeResolver.ScopesForAsync(accountId)` and mint the session against the account's own id
   (not `Guid.Empty`). `last_used_at` is touched on success.

Anything that fails every step is a plain `401` — the response never reveals which step it fell
through, so a caller cannot tell "wrong admin key" from "expired personal key" from "not a key at
all."

### Scopes come from roles, not from the key

A personal key carries no scope of its own. Every exchange resolves scopes fresh from the owning
account's **current** roles through `ScopeResolver.ScopesForAsync` — the same resolver a password
login uses (`player` always; `+content:write` for `content_editor`; `+admin` for `admin`, which
still implies the other two). That means:

- Granting a role to the account raises what every key that account holds can do, immediately, with
  no key changes.
- **Removing a role revokes the power without rotating the key.** An admin pulling `content_editor`
  from an account is enough — the person's existing key still authenticates, but its next exchange
  comes back scoped to `player` only.

## Audit

Admin revocation goes through the same audited path as every other Live Ops action (see
[Moderation](18-moderation.md)): `AdminActionKind` gains `RevokeApiKey`, appended as the next free
member (never renumbered, since the integer is what `admin_action.kind` persists), with metadata
`{"keyId":"…","keyPrefix":"…"}` so the audit log names the key without ever holding its hash or
plaintext.

A player revoking their own key via `DELETE /account/keys/{id}` is **not** an admin action and
writes no `admin_action` row — that path is `RequirePlayer`, not an operator surface.

## What stays on env keys

`AdminServiceKey` and `EditorServiceKey` are kept, unchanged, for **CI and bootstrap only** — a
pipeline minting a token with no human account behind it, or the very first exchange before any
account has a personal key. Humans authenticate with a personal key instead. Neither env key's
scope or precedence changes: they are still checked first, in the same order, before a presented
value is even tried as a personal key.

## Operator walkthrough

1. **Create**, in Studio web: **your account (header) → API keys → Create key…**, give it a name. The plaintext
   is shown exactly once, with a Copy button and "This is the only time it is shown" — copy it now.
2. **Paste**, in the Unity editor: **Crystalline Rift Studio → SYSTEM → Configuration →** the
   environment's card **→ Key** row. Activating it exchanges the key at `/auth/service-token` for
   both the editor's content-write auth and its admin auth (one key, one row, replacing the old
   two-row Service key / Admin key split) — whichever scopes the owning account's roles grant.
3. **Revoke** it from either side:
   - **Studio web → your account (click your name in the header) → API keys → Revoke** (with confirm) — for a key you own.
   - **Studio web → System → Accounts →** expand the account **→ API keys panel → Revoke…** (reason
     required) — for any account, as an admin. This is audited (`RevokeApiKey`); a self-revoke is
     not.

Revoked keys stay listed, muted, in both views — a key's row is a record that it existed, not just
a live credential.

## Related

- [Moderation](18-moderation.md) — the `admin_action` audit log an admin's revoke writes into, and
  the actor/audit conventions this endpoint follows.
- [Auth and Accounts](06-auth-and-accounts.md#service-tokens-content-studio-and-live-ops) — the two
  env keys, the scope ladder, and the `POST /auth/service-token` exchange these keys share.
- [Backend Architecture](01-architecture.md#migration-order-is-one-list) — the global `VersionInfo`
  namespace that made `14` the next free migration number.

## Expiry and the per-account cap

A key used to live until somebody noticed it had leaked, and an account could hold as many as it
liked. Since M0016:

- **Every new key expires.** `POST /account/keys` accepts `expiresInDays` (1 to 365); omitted, it
  takes the 90-day default. `account_api_key.expires_at` is null only on keys minted before this
  existed, which keep working exactly as they did.
- **An expired key is refused the same way a revoked one is.** The exchange at
  `POST /auth/service-token` answers a bare 401 either way — which step refused, and why, is not
  something a caller holding a partial key gets to learn.
- **Ten live keys per account.** Revoked and expired keys do not count, so revoking one frees a slot.
  The cap is not about storage: nobody audits a list of thirty keys, and a key an attacker mints
  among many is not noticed.
- `expiresAt` is on `ApiKeySummary`, so Studio can show when a key runs out.

Creating a key is also rate limited along with the rest of the account surface, and the exchange
endpoint is held to 10 requests per minute per IP.
