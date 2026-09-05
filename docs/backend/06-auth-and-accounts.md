# Auth and Accounts

Authentication uses a **Bearer token** model. The Unity client obtains a token at login and attaches it to every subsequent HTTP request via the `Authorization: Bearer <token>` header. The system supports both email/password login and Discord OAuth as an identity provider.

## Why This Design?

### Why Bearer Tokens and Not Sessions?

Bearer tokens (stateless JWTs or opaque tokens) are a natural fit for a game client that may go offline for extended periods. A session-based approach would require the server to store session state and expire it, creating problems for clients that come back online after hours. A bearer token can encode its own expiry and be validated without a database round-trip for the majority of requests.

The refresh token pattern extends this by allowing short-lived access tokens (less exposure in case of theft) with long-lived refresh tokens stored in secure device storage. Unity's `TokenManager` stores both and automatically exchanges the refresh token for a new access token on 401 responses.

### Why PBKDF2-SHA512 Instead of BCrypt?

The `PasswordHasher` uses `Rfc2898DeriveBytes.Pbkdf2` with SHA512 and 350,000 iterations. This was chosen over BCrypt because:

1. .NET's built-in `Rfc2898DeriveBytes` is FIPS-compliant and has no external library dependency
2. SHA512 is hardware-accelerated on modern CPUs, making the iteration count effective against brute force without excessive legitimate-login latency
3. The iteration count (350,000) matches NIST 2023 recommendations for PBKDF2-SHA512

Each account has its own randomly generated salt (`RandomNumberGenerator.GetBytes(64)`). The salt and hash are both stored on the `accounts` row.

### Why Discord OAuth?

Discord is the primary community platform for Crystalline Rift. Players are already authenticated with Discord before playing, so reusing that identity reduces friction and eliminates the need to manage separate passwords for the majority of the playerbase.

## Account Model

| Column | Notes |
|--------|-------|
| `id` | UUID primary key |
| `email` | Unique, used as login identifier (nullable for Discord-only accounts) |
| `password_hash` | PBKDF2-SHA512 hash (nullable for Discord-only accounts) |
| `salt` | Per-account random salt (byte array, stored as blob) |
| `created_at`, `updated_at` | Audit trail |
| `deleted` | Soft delete |

An account can have multiple trainers (`accounts` → `trainers` one-to-many). Trainers are the in-game character identities; accounts are the authentication identity.

## Anonymous Device Flow (primary online path)

The shipped client is **anonymous-first**: online play never asks for credentials. A device
registers itself, gets a session-backed JWT, and richer providers (Steam ticket verification,
OAuth) *link onto the same account id later* via `third_party_account_links`. No passwords are
stored for this flow.

```bash
# 1. Register the device (idempotent — an already-linked device gets its existing account id back)
curl -s -X POST http://localhost:8080/account \
  -H "Content-Type: application/json" \
  -d '{"type":0,"gameInstallationId":"<device-id>"}'
# → {"accountId":"..."}

# 2. Exchange the device id for tokens
curl -s -X POST http://localhost:8080/auth/game \
  -H "Content-Type: application/json" \
  -d '{"gameInstallationId":"<device-id>"}'
# → {"accessToken":"...","refreshToken":"...","expiresAtUtc":...}
# Unknown device → 401 (the client treats 401 as "register this device first").
```

`/auth/game` persists an `auth_session` row for the token's `jti`, exactly like `/auth/basic`
and `/auth/oauth` — the `OnTokenValidated` revocable-session check accepts its tokens, so this
is a first-class online login, not a guest mode. `/auth/oauth` returns 401 (never 404) for
unknown or stale provider tokens for the same reason: the client's 401 handler is the recovery
path.

On the Unity side, `GameAuthRepository.TryGetAccessToken` walks the **token ladder**
(`AuthTokenLadder`, pure logic + tests): use the live access token, else spend the refresh
token, else run the two calls above from nothing. `SimpleWebClient` retries any 401 once after
forcing that ladder, so a server that wiped its auth database heals on the next request instead
of stranding the player with a dead cached token.

## Auth Flow — Full Login Walkthrough

### Step 1: Register

```bash
curl -s -X POST http://localhost:5000/api/v1/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"player@cr.local","password":"securepass123"}'
```

Response:
```json
{
  "accessToken":  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "refreshToken": "def502003b8f9e...",
  "expiresIn":    3600,
  "accountId":    "aaaaaaaa-0000-0000-0000-000000000001"
}
```

Registration:
1. Validates the email is not already in use
2. Generates a random 64-byte salt via `RandomNumberGenerator.GetBytes(64)`
3. Derives the hash: `Rfc2898DeriveBytes.Pbkdf2(password, salt, 350_000, SHA512, 64)`
4. Inserts the `accounts` row
5. Returns the same access + refresh token pair as a successful login

### Step 2: Login (subsequent sessions)

```bash
TOKEN=$(curl -s -X POST http://localhost:5000/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"player@cr.local","password":"securepass123"}' \
  | jq -r '.accessToken')
```

Response has the same shape as register. The `accountId` in the response is used to scope all subsequent API calls.

### Step 3: Use the token

```bash
# All subsequent requests attach the bearer token
curl -s http://localhost:5000/api/v1/trainers \
  -H "Authorization: Bearer $TOKEN" \
  | jq .
```

### Step 4: Token refresh

When the access token expires (default 1 hour), the client presents the refresh token:

```bash
NEW_TOKENS=$(curl -s -X POST http://localhost:5000/api/v1/auth/refresh \
  -H "Content-Type: application/json" \
  -d '{"refreshToken":"def502003b8f9e..."}')
TOKEN=$(echo $NEW_TOKENS | jq -r '.accessToken')
REFRESH_TOKEN=$(echo $NEW_TOKENS | jq -r '.refreshToken')
```

Each refresh call **rotates the refresh token** — the old one is invalidated and a new one is issued. Store the new refresh token immediately. If the client presents an already-rotated refresh token (possible sign of theft), the server can invalidate the entire token family.

### Step 5: Logout

```bash
curl -s -X POST http://localhost:5000/api/v1/auth/logout \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"refreshToken":"def502003b8f9e..."}'
```

Server-side revocation of the refresh token. The access token remains technically valid until it expires (there is no per-access-token revocation list). For most game scenarios this is acceptable — the 1-hour window is short enough.

## Token Lifetime and Sessions

Access tokens are short-lived (default **1 hour**). Refresh tokens are long-lived (default **30 days**). The `expiresIn` field in the login/refresh response contains the access token lifetime in seconds.

The Unity `TokenManager` proactively refreshes before expiry. `IGameSessionRepository` persists the current session (accountId, trainerId, isOnline) to SQLite so it survives app restarts. When Unity starts, `GameSessionManager` reads from this repository to restore the previous session without requiring the player to log in again. If the stored access token is still valid, the player is dropped back into the game immediately.

**Token refresh flow:** Access token expires → Unity `SimpleWebClient` receives 401 → calls `TokenManager.RefreshAccessTokenAsync()` → presents refresh token to `/api/v1/auth/refresh` → stores new access + refresh tokens → retries original request. This is transparent to other Unity systems.

## Service Tokens (Content Studio and Live Ops)

Tooling that is not a player — the Unity editor's Content Studio, operator/live-ops screens — does not log in as an account. It exchanges a **pre-shared service key** for a short-lived JWT at `POST /auth/service-token` (`ServiceTokenEndpoints.cs`). The issued token's session row uses `Guid.Empty` as its `account_id`: a service token is deliberately tied to no player account, so it carries no `player` scope and cannot touch player-owned data.

There are **two** keys, each read from configuration and each granting a different scope:

| Config key | Dev default | Scope granted | What it unlocks |
|---|---|---|---|
| `AdminServiceKey` | `local-dev-admin-service-key` | `admin` | Operator-only routes (`AuthorizationPolicies.RequireAdmin`) — plus everything the other two policies cover |
| `EditorServiceKey` | `local-dev-editor-service-key` | `content:write` | Content authoring push/pull (`AuthorizationPolicies.RequireContentWrite`) |

The admin key is checked **first**, then the editor key. Both comparisons are constant-time (SHA-256 of each key, then `CryptographicOperations.FixedTimeEquals`) so response timing never leaks key contents. A key whose configuration value is **missing or blank disables that exchange entirely** — it never matches, so an unconfigured admin key cannot be unlocked by presenting an empty `serviceKey`. Any key matching neither returns 401.

**`admin` implies `content:write` and `player`.** `AuthorizationPolicies.HasScope` (`AuthorizationPolicies.cs`) passes when the principal's scopes contain either the requested scope *or* `admin`, so a single admin token satisfies `RequireAdmin`, `RequireContentWrite`, and `RequirePlayer`. The reverse is not true: a `content:write` token is forbidden (403) from admin and player routes.

The scope rides in the JWT's `scope` claim (`AuthClaims.Scope`). `JwtAuthentication.CreateToken` writes it as a **single string claim** holding one scope value; readers (`ClaimsPrincipalExtensions.GetScopes`) also accept repeated `scope` claims and a space-delimited value, so multi-scope tokens would still be read correctly.

```bash
# Admin token
curl -s -X POST http://localhost:8080/auth/service-token \
  -H "Content-Type: application/json" \
  -d '{"serviceKey":"local-dev-admin-service-key"}' | jq -r .accessToken

# Content Studio token
curl -s -X POST http://localhost:8080/auth/service-token \
  -H "Content-Type: application/json" \
  -d '{"serviceKey":"local-dev-editor-service-key"}' | jq -r .accessToken
```

The dev default for `AdminServiceKey` lives in `CR.REST.AIO/appsettings.Development.json` only — the standalone `CR.Auth.Service.REST/config.yml` and `CR.Game.Service.BFF/config.yml` carry `EditorServiceKey` but deliberately no admin key, so those hosts have no admin exchange until one is supplied per environment. **These literals are development-only** — production hosts must supply real secrets via environment/secret configuration, and a production host that leaves `AdminServiceKey` unset simply has no admin exchange, which is the safe default. `AdminActorName` (default `editor`) sits alongside them and is the human label stamped onto audited operator actions.

## How to Test Auth with curl

```bash
# Register (first time)
curl -s -X POST http://localhost:5000/api/v1/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"test@cr.local","password":"test1234"}' | jq .

# Login
curl -s -X POST http://localhost:5000/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"test@cr.local","password":"test1234"}' | jq .

# Verify the token works (get trainer list — empty initially)
curl -s http://localhost:5000/api/v1/trainers?accountId=<accountId> \
  -H "Authorization: Bearer <accessToken>" | jq .

# Test refresh
curl -s -X POST http://localhost:5000/api/v1/auth/refresh \
  -H "Content-Type: application/json" \
  -d '{"refreshToken":"<refreshToken>"}' | jq .

# Logout
curl -s -X POST http://localhost:5000/api/v1/auth/logout \
  -H "Authorization: Bearer <accessToken>" \
  -H "Content-Type: application/json" \
  -d '{"refreshToken":"<refreshToken>"}' | jq .
```

## Multi-Trainer Setup (One Account, Multiple Trainers)

A trainer is not created automatically with the account — it is a separate `POST /api/v1/trainers` call. This allows one account to hold multiple trainers (alts).

```bash
# Create first trainer
curl -s -X POST http://localhost:5000/api/v1/trainers \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"name\":\"MainTrainer\",\"accountId\":\"$ACCOUNT_ID\"}" | jq .

# Create second trainer (same account)
curl -s -X POST http://localhost:5000/api/v1/trainers \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"name\":\"AltTrainer\",\"accountId\":\"$ACCOUNT_ID\"}" | jq .

# List all trainers for account
curl -s "http://localhost:5000/api/v1/trainers?accountId=$ACCOUNT_ID" \
  -H "Authorization: Bearer $TOKEN" | jq .
```

Each trainer has its own independent world state — NPCs, spawners, creatures, quest progress, and stats are all scoped to `(accountId, trainerId)`. The first trainer selection fires `OnTrainerChanged` in Unity, which triggers world initialization.

In the Unity `GameSessionManager`, the player selects which trainer to play from a trainer selection screen. Once a trainer is selected, that `TrainerId` is passed in every subsequent API call. Switching trainers re-triggers world initialization for the new trainer.

## `ITokenManager`

Source: `Auth/CR.Auth.Model.REST/Interface/ITokenManager.cs`

```csharp
public interface ITokenManager
{
    Task<string> GetAccessTokenAsync();
    Task RefreshAccessTokenAsync();
}
```

`TokenManager` (Unity implementation) stores the access and refresh tokens in `ObscuredPrefs` (Anti-Cheat Toolkit) — an obfuscated `PlayerPrefs` wrapper that prevents trivial memory inspection or file editing to extract tokens. `SimpleWebClient` calls `GetAccessTokenAsync()` before every request. If the stored token is within its expiry window, it returns immediately. If expired, it calls `RefreshAccessTokenAsync` first.

## Discord OAuth Flow

```
1. Unity opens Discord OAuth URL in system browser
   (https://discord.com/api/oauth2/authorize?client_id=...&redirect_uri=...&scope=identify)

2. Player authorizes in browser
   Discord redirects to cr-api callback URL with authorization code

3. cr-api: GET /api/v1/auth/oauth/discord/callback?code=...
   cr-api exchanges code for Discord access token via Discord API
   cr-api fetches Discord user profile (user_id, username, avatar)

4. cr-api upserts account:
   - If account with this discord_user_id exists → use it
   - If not → create new account linked to the Discord identity

5. cr-api issues CR access + refresh tokens

6. Tokens returned to Unity (via deep-link callback or polling)
```

`DiscordTokenValidator` on the Unity side validates Discord tokens when using the OAuth path. The server-side `OAuthLinkingEndpoints` handles the callback and account upsert logic.

## Unity DI Wiring

```csharp
// LocalDevGameInstaller.cs
Container.Bind<ITokenValidator>().To<DiscordTokenValidator>().AsSingle();
Container.Bind<ITokenManager>().To<TokenManager>().AsSingle();

Container.Bind<IAuthClient>().To<AuthClientUnityHttp>().AsSingle();
Container.Bind<IOAuthClient>().To<OAuthClientUnityHttp>().AsSingle();
Container.Bind<IAccountClient>().To<AccountClientUnityHttp>().AsSingle();
```

All auth-related clients use `GameConfigurationKeys.AuthServerHttpAddress` as their base URL, read from `game_config.yaml`. In `CR.REST.AIO`, auth endpoints are served at the same host as all other endpoints, so `auth_server_http_address` and `npc_server_http_address` will be identical in a local development setup.

## REST Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/v1/auth/register` | Create account + return tokens |
| `POST` | `/api/v1/auth/login` | Email/password login → access + refresh tokens |
| `POST` | `/api/v1/auth/refresh` | Exchange refresh token for new access token (rotates refresh token) |
| `POST` | `/api/v1/auth/logout` | Invalidate refresh token (server-side revocation) |
| `GET`  | `/api/v1/auth/oauth/discord` | Redirect to Discord OAuth consent screen |
| `GET`  | `/api/v1/auth/oauth/discord/callback` | Discord OAuth callback — issues CR tokens |
| `POST` | `/auth/service-token` | Exchange a pre-shared service key for a scoped, account-less token (`admin` or `content:write`) |

Auth is wired into the ASP.NET pipeline via `builder.AddCrAuth()` (extension method in `CrAuthExtensions.cs`). All non-auth endpoints require a valid bearer token.

## Security Considerations

- **Tokens are never logged.** `Program.cs` adds `Authorization` to the HTTP logging request headers list, but this is only enabled in development (`app.UseHttpLogging()` inside `if (app.Environment.IsDevelopment())`). In production, token headers are not captured in logs.
- **Access token lifetime.** Access tokens are short-lived (default 1 hour). Refresh tokens are long-lived (default 30 days).
- **Refresh token rotation.** Each `POST /api/v1/auth/refresh` call issues a new refresh token and invalidates the old one.
- **Soft-deleted accounts.** When `deleted = true`, the account still exists in the database but login attempts return 401. Refresh tokens issued before deletion continue to validate until they expire.
- **Salt storage.** The salt is stored as a binary blob alongside the hash. If the `accounts` table is compromised, the attacker has both the salt and hash — security relies entirely on the PBKDF2 iteration count making brute-force prohibitively slow.

## Common Mistakes / Tips

- **Wrong `auth_server_http_address` in `game_config.yaml`.** All auth requests will 404 or connect refused. Ensure this points to the same host as `npc_server_http_address` when running `CR.REST.AIO`.
- **Expired refresh token in `ObscuredPrefs`.** After a long hiatus (refresh token expiry period), `TokenManager.RefreshAccessTokenAsync` returns 401. The client must redirect to the login screen. Make sure the login scene is wired to `IAuthClient.LoginAsync`.
- **Forgetting `builder.AddCrAuth()` in a new standalone host.** Requests to protected endpoints will return 401 for all clients. The method configures the JWT validation middleware.
- **Testing with hard-coded credentials.** Use environment variables or `config.yml` overrides for test account credentials. Never commit credentials to source control.
- **Calling trainer endpoints without a trainer.** After registration, the trainer list is empty. You must create a trainer via `POST /api/v1/trainers` before calling NPC, quest, or spawner endpoints — they all require a `trainerId`.
- **Reusing a rotated refresh token.** After calling `/auth/refresh`, the old refresh token is invalid. If your test script stores the token in a variable and re-runs, it will attempt the old token and receive 401. Always update the stored refresh token after every refresh call.

## Related Pages

- [Backend Architecture](?page=backend/01-architecture) — middleware, DI wiring, `Program.cs` startup
- [Unity Project Setup](?page=unity/01-project-setup) — `game_config.yaml` key for auth server address
- [HTTP Clients](?page=unity/05-http-clients) — how `SimpleWebClient` attaches the bearer token to every request
- [Dependency Injection](?page=unity/02-dependency-injection) — auth bindings in `LocalDevGameInstaller`
