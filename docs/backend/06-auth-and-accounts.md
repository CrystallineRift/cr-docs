# Auth and Accounts

## Overview

Authentication uses a **Bearer token** model. The Unity client obtains a token at login and attaches it to every subsequent HTTP request via the `Authorization: Bearer <token>` header.

## Account Model

| Column | Notes |
|--------|-------|
| `id` | UUID primary key |
| `email` | Unique, used as login identifier |
| `password_hash` | BCrypt or PBKDF2 hash |
| `salt` | Per-account salt |
| `created_at`, `updated_at` | Audit trail |
| `deleted` | Soft delete |

An account can have multiple trainers (`accounts` → `trainers` one-to-many).

## Auth Flow

```
1. Client: POST /api/v1/auth/login  { email, password }
         → 200 { accessToken, refreshToken, expiresIn }

2. Client stores tokens (ObscuredPrefs / secure storage)

3. All subsequent requests:
   Authorization: Bearer <accessToken>

4. On 401: Client calls POST /api/v1/auth/refresh { refreshToken }
         → 200 { accessToken, refreshToken, expiresIn }
```

## ITokenManager

Source: `../cr-api/Auth/CR.Auth.Model.REST/Interface/ITokenManager.cs`

```csharp
public interface ITokenManager
{
    Task<string> GetAccessTokenAsync();
    Task RefreshAccessTokenAsync();
}
```

`TokenManager` (Unity implementation) stores the access and refresh tokens. `SimpleWebClient` calls `GetAccessTokenAsync()` before every request.

## Unity DI Wiring

```csharp
// LocalDevGameInstaller.cs
Container.Bind<ITokenValidator>().To<DiscordTokenValidator>().AsSingle();
Container.Bind<ITokenManager>().To<TokenManager>().AsSingle();

Container.Bind<IAuthClient>().To<AuthClientUnityHttp>().AsSingle();
Container.Bind<IOAuthClient>().To<OAuthClientUnityHttp>().AsSingle();
Container.Bind<IAccountClient>().To<AccountClientUnityHttp>().AsSingle();
```

## Discord OAuth

Crystalline Rift supports Discord OAuth as an auth provider. `DiscordTokenValidator` validates Discord tokens server-side and issues a CR access token in return.

Flow:
```
1. Unity opens Discord OAuth URL in browser
2. Discord redirects to cr-api callback with code
3. cr-api exchanges code for Discord user info
4. cr-api creates/upserts account, issues CR tokens
5. Tokens returned to Unity
```

## Game Auth & Session Repositories

`IGameAuthRepository` and `IGameAccountRepository` are higher-level repositories used by game services that need to read auth state without dealing with raw token management.

`IGameSessionRepository` persists the current session (accountId, trainerId, isOnline) to SQLite so it survives app restarts.

## REST Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/v1/auth/login` | Email/password login |
| `POST` | `/api/v1/auth/refresh` | Refresh access token |
| `POST` | `/api/v1/auth/logout` | Invalidate refresh token |
| `GET`  | `/api/v1/auth/oauth/discord` | Start Discord OAuth flow |
| `GET`  | `/api/v1/auth/oauth/discord/callback` | Discord OAuth callback |

## Modules

```
cr-api/Auth/
  CR.Auth.Data/             ← IAuthRepository
  CR.Auth.Data.Migration/   ← schema migrations
  CR.Auth.Data.Postgres/    ← PostgreSQL impl
  CR.Auth.Data.Sqlite/      ← SQLite impl (Unity offline)
  CR.Auth.Model.REST/       ← ITokenManager, LoginRequest/Response…
  CR.Auth.Service.REST/     ← ASP.NET endpoints
```
