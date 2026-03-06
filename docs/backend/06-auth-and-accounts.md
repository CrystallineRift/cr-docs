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

Each account has its own randomly generated salt (`RandomNumberGenerator.GetBytes(64)`). The salt and hash are both stored on the `accounts` row. The `VerifyPassword` method re-derives the hash from the input password + stored salt and compares using `SequenceEqual` (constant-time comparison to prevent timing attacks).

### Why Discord OAuth?

Discord is the primary community platform for Crystalline Rift. Players are already authenticated with Discord before playing, so reusing that identity reduces friction and eliminates the need to manage separate passwords for the majority of the playerbase. The Discord OAuth flow issues CR-native tokens (not Discord tokens) to the Unity client — the Discord token is only used server-side to identify the account.

## Account Model

| Column | Notes |
|--------|-------|
| `id` | UUID primary key |
| `email` | Unique, used as login identifier |
| `password_hash` | PBKDF2-SHA512 hash (hex string) |
| `salt` | Per-account random salt (byte array, stored as blob) |
| `created_at`, `updated_at` | Audit trail |
| `deleted` | Soft delete |

An account can have multiple trainers (`accounts` → `trainers` one-to-many). Trainers are the in-game character identities; accounts are the authentication identity. A player might have a "main" trainer and an "alt" trainer on the same account.

## Auth Flow

```
1. Client: POST /api/v1/auth/login  { email, password }
         → 200 { accessToken, refreshToken, expiresIn }

2. Client stores tokens (ObscuredPrefs / secure storage)

3. All subsequent requests:
   Authorization: Bearer <accessToken>

4. On 401: Client calls POST /api/v1/auth/refresh { refreshToken }
         → 200 { accessToken, refreshToken, expiresIn }

5. On refresh failure (401): redirect to login screen
```

`SimpleWebClient` in Unity attaches the token to every request via `ITokenManager.GetAccessTokenAsync()`. If the access token is expired, `TokenManager` can proactively refresh before attaching. The `NotAuthorizedException` from `SimpleWebClient` triggers a refresh attempt in most client implementations.

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

## Game Auth and Session Repositories

`IGameAuthRepository` and `IGameAccountRepository` are higher-level repositories used by game services that need to read auth state without dealing with raw token management. These are backed by the Unity SQLite databases for offline scenarios — the account data is cached locally so the game knows "who is logged in" even without a network connection.

`IGameSessionRepository` persists the current session (accountId, trainerId, isOnline) to SQLite so it survives app restarts. When Unity starts, `GameSessionManager` reads from this repository to restore the previous session without requiring the player to log in again. If the stored access token is still valid, the player is dropped back into the game immediately.

## REST Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/v1/auth/login` | Email/password login → access + refresh tokens |
| `POST` | `/api/v1/auth/refresh` | Exchange refresh token for new access token |
| `POST` | `/api/v1/auth/logout` | Invalidate refresh token (server-side revocation) |
| `GET`  | `/api/v1/auth/oauth/discord` | Redirect to Discord OAuth consent screen |
| `GET`  | `/api/v1/auth/oauth/discord/callback` | Discord OAuth callback — issues CR tokens |

Endpoint implementation is in `Auth/CR.Auth.Service.REST/Endpoints/`:
- `TokenEndpoints.cs` — maps `/auth/login`, `/auth/refresh`, `/auth/logout`
- `AuthenticationEndpoints.cs` — email/password account creation and verification
- `OAuthLinkingEndpoints.cs` — Discord OAuth flow
- `AccountEndpoints.cs` — account profile CRUD

Auth is wired into the ASP.NET pipeline via `builder.AddCrAuth()` (extension method in `CrAuthExtensions.cs`) which configures JWT bearer validation with the CR signing key. All non-auth endpoints require a valid bearer token via the `[Authorize]` attribute or equivalent middleware.

## Modules

```
cr-api/Auth/
  CR.Auth.Data/             ← IAuthRepository (account CRUD)
  CR.Auth.Data.Migration/   ← schema migrations
  CR.Auth.Data.Postgres/    ← PostgreSQL impl
  CR.Auth.Data.Sqlite/      ← SQLite impl (Unity offline)
  CR.Auth.Model.REST/       ← ITokenManager, LoginRequest/Response, Account model
  CR.Auth.Service.REST/     ← ASP.NET endpoints, PasswordHasher, CrAuthExtensions
```

## Security Considerations

- **Tokens are never logged.** `Program.cs` adds `Authorization` to the HTTP logging request headers list, but this is only enabled in development (`app.UseHttpLogging()` inside `if (app.Environment.IsDevelopment())`). In production, token headers are not captured in logs.
- **Soft-deleted accounts.** When `deleted = true`, the account still exists in the database but login attempts return 401. Refresh tokens issued before deletion continue to validate until they expire or are explicitly revoked. Plan for a forced revocation pass when processing account deletion requests.
- **Salt storage.** The salt is stored as a binary blob alongside the hash. If the `accounts` table is compromised, the attacker has both the salt and hash — security relies entirely on the PBKDF2 iteration count making brute-force prohibitively slow.

## Common Mistakes / Tips

- **Wrong `auth_server_http_address` in `game_config.yaml`.** All auth requests will 404 or connect refused. Ensure this points to the same host as `npc_server_http_address` when running `CR.REST.AIO`.
- **Expired refresh token in `ObscuredPrefs`.** After a long hiatus (refresh token expiry period), `TokenManager.RefreshAccessTokenAsync` returns 401. The client must redirect to the login screen. Make sure the login scene is wired to `IAuthClient.LoginAsync`.
- **Forgetting `builder.AddCrAuth()` in a new standalone host.** Requests to protected endpoints will return 401 for all clients. The method configures the JWT validation middleware.
- **Testing with hard-coded credentials.** Use environment variables or `config.yml` overrides for test account credentials. Never commit credentials to source control.

## Related Pages

- [Backend Architecture](?page=backend/01-architecture) — middleware, DI wiring, `Program.cs` startup
- [Unity Project Setup](?page=unity/01-project-setup) — `game_config.yaml` key for auth server address
- [HTTP Clients](?page=unity/05-http-clients) — how `SimpleWebClient` attaches the bearer token to every request
- [Dependency Injection](?page=unity/02-dependency-injection) — auth bindings in `LocalDevGameInstaller`
