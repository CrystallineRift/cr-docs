# HTTP Clients

All HTTP communication between Unity and the backend uses `SimpleWebClient` as a base class. Each domain gets its own typed client interface and Unity HTTP implementation. This layer is the translation boundary between the C# domain model and the REST API.

## Why This Design?

### Why a Shared `SimpleWebClient` Base Class?

Every HTTP client in the game needs the same infrastructure:
- Attach an authorization header
- Serialize/deserialize JSON
- Map HTTP status codes to typed exceptions
- Handle rate limit events

Putting this in a shared base class means:
- New domain clients are 10–20 lines of code
- Token management is always correct — no client can forget to attach the auth header
- Error handling is consistent across all domains
- Rate limit events are available everywhere without reimplementation

The alternative (each client implementing HTTP from scratch) would lead to drift between clients over time and makes it easy to accidentally omit auth headers in a new client.

### Why Not Use Unity's Built-in `UnityWebRequest`?

`UnityWebRequest` is designed for coroutines rather than `async`/`await`. Best HTTP provides a proper `async`-native API that integrates with `Task`-based patterns used throughout the game's domain services. It also provides better error handling, connection pooling, and timeout configuration.

### Why Typed Exceptions Instead of Result Types?

Typed exceptions (`NotFoundException`, `BadRequestException`, etc.) let callers handle only the specific errors they care about and let unexpected errors propagate as unhandled exceptions (which become visible in Unity's Console). A result type pattern would require every caller to check `if (result.IsError)` everywhere, obscuring the happy path.

Callers that need to handle a specific error (e.g., 404 for an optional resource) can catch the specific exception type. Callers that do not expect an error let it propagate to `GameInitializer`'s top-level error handler, which logs it with the component name.

### Why Is There No Retry Strategy?

There is no automatic retry in `SimpleWebClient`. The reasons:
- Automatic retries can hide real problems (e.g., an auth error that retries indefinitely)
- Most operations in this game are idempotent at the backend level (e.g., `EnsureNpcAsync` is safe to call multiple times), so callers that need retry can call the operation again on transient failure
- The game's initialization flow already has a natural retry: if world init fails, the player can trigger it again by re-selecting their trainer

For callers that need retry (e.g., a UI button that the player can press again), wrap the call in a try/catch and re-enable the button on failure:

```csharp
private async void OnButtonClick()
{
    _button.interactable = false;
    try
    {
        await _client.DoThingAsync(request, _ct);
    }
    catch (Exception ex)
    {
        _logger.Warn($"Request failed: {ex.Message}. Player can retry.");
        _button.interactable = true;
    }
}
```

## `SimpleWebClient`

`SimpleWebClient` is an abstract base class that wraps **Best HTTP** library calls.

Source: `Assets/CR/Core/Data/Client/Implementation/SimpleWebClient.cs`

### Constructor

There are two constructors:

```csharp
// Unauthenticated — for clients that don't need a token (e.g., OAuth)
protected SimpleWebClient(
    ICRLogger logger,
    IGameConfiguration configuration,
    string serverConfigKeyAddress)

// Authenticated — uses ITokenManager to attach Bearer token
protected SimpleWebClient(
    ICRLogger logger,
    IGameConfiguration configuration,
    ITokenManager tokenManager,
    string serverConfigKeyAddress)
```

The base URL is read from `IGameConfiguration` using the config key at construction time via `configuration.TryGet(serverConfigKeyAddress, out _serverAddress)`. If the key is missing from `game_config.yaml`, `_serverAddress` is null and an error is logged immediately: `Invalid HttpClient configuration. address: {key}`. Every subsequent request will fail to build a valid URL.

### Request Lifecycle

Every authenticated request follows this sequence:

1. `ITokenManager.GetAccessTokenAsync()` — retrieves the current Bearer token; refresh happens inside `TokenManager` if needed
2. Constructs the full URL: `{_serverAddress}/{path}` (note: path leading slash is stripped)
3. Creates a Best HTTP request with `Authorization: Bearer <token>` header
4. Serializes the request body using `Newtonsoft.Json` (`JSonDataStream<TD>`) for POST/PUT
5. Sends the request and awaits `GetHTTPResponseAsync()`
6. Checks the HTTP status code via `CheckForResponseForErrors` and throws a typed exception if not 2xx (200, 203, 204 are accepted)
7. Deserializes the response body with `Newtonsoft.Json` into the typed response type
8. Returns the deserialized response

### HTTP Methods

```csharp
protected Task<TR> Get<TR>(string path, Action<HTTPRequest> before = null,
    Action<HTTPResponse> after = null, string authToken = null)

protected Task<TR> Post<TR, TD>(string path, TD data, Action<HTTPRequest> before = null,
    Action<HTTPResponse> after = null, string authToken = null)

protected Task<TR> Put<TR, TD>(string path, TD data, Action<HTTPRequest> before = null,
    Action<HTTPResponse> after = null, string authToken = null)

protected Task Delete(string path, Action<HTTPRequest> before = null,
    Action<HTTPResponse> after = null, string authToken = null)
```

The `before` and `after` callbacks allow per-request customization (e.g., adding extra headers, reading a response header). These are rarely needed — most clients use the simple path/data overloads.

Note that the current `SimpleWebClient` does not accept `CancellationToken` in its method signatures. Cancellation must be handled at the caller level by wrapping the task. This is a known gap — calls that need cancellation (e.g., initialization calls) should structure the caller to abandon the result on cancellation even if the HTTP request itself completes.

### Error Mapping

The actual status codes handled by `CheckForResponseForErrors`:

| Status | Exception | Notes |
|--------|-----------|-------|
| 200, 203, 204 | (none — success) | All treated as success |
| 400 | `BadRequestException` | Invalid request body, missing fields |
| 401 | `NotAuthorizedException` | Invalid or expired token |
| 403 | `ForbiddenException` | Valid token but insufficient permissions |
| 404 | `NotFoundException` | Resource not found |
| other | `InternalServerErrorException` | All other codes |

Note that 409 (Conflict) and 429 (Rate Limit) are not explicitly handled — they fall through to `InternalServerErrorException`. If you need to handle these specifically, catch `InternalServerErrorException` and inspect the message.

### How the Authentication Token Is Attached

`AddAuthorizationToRequest` is called before every request:

```csharp
private async Task AddAuthorizationToRequest(string authToken, HTTPRequest request)
{
    if (_tokenManager != null)
    {
        authToken = string.IsNullOrEmpty(authToken)
            ? await _tokenManager.GetAccessTokenAsync()
            : authToken;
    }
    request.AddHeader("Authorization", $"Bearer {authToken}");
}
```

If the client was constructed with `ITokenManager`, the token is always fetched fresh. Token refresh is handled inside `ITokenManager.GetAccessTokenAsync()` — if the stored token is expired, `TokenManager` calls the auth endpoint to refresh it before returning. If refresh fails, `GetAccessTokenAsync` throws `NotAuthorizedException`, which propagates from the HTTP call.

Callers can override the token by passing a non-null `authToken` argument to the `Get`/`Post` methods, but this is only used in the OAuth flow and not in normal game operations.

### Rate Limit Events

```csharp
public event RateLimitEvent OnRateLimitWarningEvent;   // > 75% of limit used
public event RateLimitEvent OnRateLimitReachedEvent;   // 100% of limit used

public delegate void RateLimitEvent(int remaining, int limit, string endpoint);
```

The events fire based on `x-ratelimit-remaining` and `x-ratelimit-limit` response headers. If the backend does not include these headers, the events never fire. Subscribe in the UI system to surface a "slow down" message to the player.

## `GameConfigurationKeys`

All server address config keys are constants in `GameConfigurationKeys`:

```csharp
public static class GameConfigurationKeys
{
    public const string NpcServerHttpAddress      = "npc_server_http_address";
    public const string AuthServerHttpAddress     = "auth_server_http_address";
    public const string TrainerServerHttpAddress  = "trainer_server_http_address";
    public const string CreatureServerHttpAddress = "creature_server_http_address";
    public const string QuestServerHttpAddress    = "quest_server_http_address";
    public const string StatServerHttpAddress     = "stat_server_http_address";
    // ...
}
```

When adding a new HTTP client, add the key constant here before using it in the client's constructor. This is a compile-time safety net — using a string literal in the constructor instead of a constant is a common mistake that causes silent failures if the key is misspelled.

## `INpcClient` / `NpcClientUnityHttp`

The NPC client is the canonical example of the typed client pattern. From the actual source:

```csharp
public class NpcClientUnityHttp : SimpleWebClient, INpcClient
{
    public NpcClientUnityHttp(ICRLogger logger, ITokenManager tokenManager,
        IGameConfiguration configuration)
        : base(logger, configuration, tokenManager, GameConfigurationKeys.NpcServerHttpAddress) { }

    public async Task<EnsureStarterNpcResponse> EnsureStarterNpcAsync(
        EnsureStarterNpcRequest request, CancellationToken ct = default)
    {
        Logger.Debug($"[NpcClient] EnsureStarterNpcAsync trainerId={request.TrainerId} contentKey={request.ContentKey}");
        return await Post<EnsureStarterNpcResponse, EnsureStarterNpcRequest>(
            "/api/v1/npc/ensure-starter", request);
    }

    public async Task<GiveCreatureResponse> GiveCreatureAsync(
        Guid npcId, GiveCreatureRequest request, CancellationToken ct = default)
    {
        Logger.Debug($"[NpcClient] GiveCreatureAsync npcId={npcId} trainerId={request.TrainerId}");
        return await Post<GiveCreatureResponse, GiveCreatureRequest>(
            $"/api/v1/npc/{npcId}/give-creature", request);
    }

    public async Task<EnsureNpcResponse> EnsureNpcAsync(
        EnsureNpcRequest request, CancellationToken ct = default)
        => await Post<EnsureNpcResponse, EnsureNpcRequest>("/api/v1/npc/ensure", request);

    public async Task<EnsureNpcCreatureTeamResponse> EnsureNpcCreatureTeamAsync(
        Guid npcId, EnsureNpcCreatureTeamRequest request, CancellationToken ct = default)
        => await Post<EnsureNpcCreatureTeamResponse, EnsureNpcCreatureTeamRequest>(
            $"/api/v1/npc/{npcId}/ensure-creature-team", request);

    public async Task<GetNpcItemsResponse> GetNpcItemsAsync(
        Guid npcId, Guid accountId, Guid trainerId, CancellationToken ct = default)
        => await Get<GetNpcItemsResponse>(
            $"/api/v1/npc/{npcId}/items?accountId={accountId}&trainerId={trainerId}");
}
```

Note that `NpcClientUnityHttp` does not implement offline behavior — it always makes HTTP calls. The repository pattern (in `LocalDevGameInstaller`) handles the online/offline routing for data access. Clients like `INpcClient` that are purely action-oriented (not data queries) are always online-only.

## All Registered Clients

From `LocalDevGameInstaller.cs`:

| Interface | Implementation |
|-----------|---------------|
| `IAuthClient` | `AuthClientUnityHttp` |
| `IOAuthClient` | `OAuthClientUnityHttp` |
| `IAccountClient` | `AccountClientUnityHttp` |
| `ITrainerClient` | `TrainerClientUnityHttp` |
| `ITrainerInventoryClient` | `TrainerInventoryClientUnityHttp` |
| `ITrainerCreatureInventoryClient` | `TrainerCreatureInventoryClientUnityHttp` |
| `ICreatureClient` | `CreatureClientUnityHttp` |
| `IGrowthProfileClient` | `GrowthProfileClientUnityHttp` |
| `IGeneratedCreatureClient` | `GeneratedCreatureClientUnityHttp` |
| `ITrainerItemInventoryClient` | `TrainerItemInventoryClientUnityHttp` |
| `IAbilityClient` | `AbilityClientUnityHttp` |
| `INpcClient` (namespace `CR.Npcs.Http`) | `NpcClientUnityHttp` |
| `IQuestClient` | `QuestClientUnityHttp` |
| `IStatClient` | `StatClientUnityHttp` |

All are bound `AsSingle()` — one instance per container lifetime, shared across all consumers. This is safe because `SimpleWebClient` is stateless aside from the base URL and injected dependencies (which are also singletons).

## Adding a New HTTP Client — Step by Step

### Step 1 — Add the config key to `GameConfigurationKeys`

```csharp
// In GameConfigurationKeys.cs
public const string GuildServerHttpAddress = "guild_server_http_address";
```

### Step 2 — Add the address to `game_config.yaml`

```yaml
# game_config.yaml
guild_server_http_address: "http://localhost:8080/guild"
```

### Step 3 — Define the interface

```csharp
// In the Unity project or a shared contracts assembly
public interface IGuildClient
{
    Task<GetGuildResponse> GetGuildAsync(Guid guildId, CancellationToken ct = default);
    Task<JoinGuildResponse> JoinGuildAsync(JoinGuildRequest request, CancellationToken ct = default);
}
```

### Step 4 — Implement the client

```csharp
public class GuildClientUnityHttp : SimpleWebClient, IGuildClient
{
    public GuildClientUnityHttp(ICRLogger logger, ITokenManager tokenManager,
        IGameConfiguration configuration)
        : base(logger, configuration, tokenManager, GameConfigurationKeys.GuildServerHttpAddress) { }

    public async Task<GetGuildResponse> GetGuildAsync(Guid guildId, CancellationToken ct = default)
    {
        Logger.Debug($"[GuildClient] GetGuildAsync guildId={guildId}");
        return await Get<GetGuildResponse>($"/api/v1/guilds/{guildId}");
    }

    public async Task<JoinGuildResponse> JoinGuildAsync(JoinGuildRequest request,
        CancellationToken ct = default)
    {
        Logger.Debug($"[GuildClient] JoinGuildAsync trainerId={request.TrainerId}");
        return await Post<JoinGuildResponse, JoinGuildRequest>("/api/v1/guilds/join", request);
    }
}
```

### Step 5 — Register in `LocalDevGameInstaller`

```csharp
// In the HTTP clients section of InstallBindings()
Container.Bind<IGuildClient>().To<GuildClientUnityHttp>().AsSingle();
```

### Step 6 — Add the backend endpoint

Ensure the backend's `Program.cs` maps the corresponding endpoint group. See [Backend Architecture](?page=backend/01-architecture) for the endpoint registration pattern.

## Error Handling in Callers

**During world initialization** (`InitializeAsync`): errors propagate to `GameInitializer` which logs them and continues. The NPC or behaviour that failed will have partial state. No explicit try/catch is needed in most behaviours — let the exception propagate.

**During player-triggered interactions** (button presses, E-key, etc.): catch exceptions and give the player feedback:

```csharp
private async Task OnInteractAsync()
{
    if (_isInteracting) return;
    _isInteracting = true;
    try
    {
        var response = await _npcClient.GiveCreatureAsync(_npcId, request);
        ShowSuccessUI(response.CreatureName);
    }
    catch (NotFoundException)
    {
        // NPC row missing — should not happen after world init, but handle gracefully
        _logger.Warn("[NpcInteraction] NPC not found during give-creature.");
        ShowErrorUI("This NPC is not available right now.");
    }
    catch (NotAuthorizedException)
    {
        // Token expired and refresh failed — redirect to login
        _sessionManager.ClearSession();
    }
    catch (Exception ex)
    {
        _logger.Error($"[NpcInteraction] Unexpected error: {ex.Message}");
        ShowErrorUI("Something went wrong. Please try again.");
    }
    finally
    {
        _isInteracting = false;
    }
}
```

The typed exception hierarchy makes it easy to distinguish actionable errors (auth failures → redirect to login) from unexpected errors (show generic message).

## Offline Mode Considerations

HTTP clients are **not used in offline mode**. When `IGameSessionRepository.IsOnline` is false, the online/offline router in the repository layer routes to the SQLite implementation instead of calling any HTTP client.

However, action-oriented clients like `INpcClient` (mutations rather than queries) do not have offline equivalents. If the session is offline, calls to `INpcClient.EnsureNpcAsync` will fail. World behaviours should check `context.IsOnline` before calling backend-only operations:

```csharp
public async Task InitializeAsync(IWorldContext context, CancellationToken ct = default)
{
    if (!context.IsOnline)
    {
        _logger.Info("[NpcWorldBehaviour] offline — NPC interaction disabled.");
        return;
    }
    // ... proceed with EnsureNpcAsync
}
```

### Domains with offline support

| Client | Offline equivalent | Notes |
|--------|-------------------|-------|
| `ITrainerClient` | `TrainerRepository` (SQLite) | Routed by `TrainerOnlineOfflineRepository` |
| `ICreatureClient` | `GeneratedCreatureRepository` (SQLite) | Trainer's party available offline |
| `INpcClient` | None | NPC interactions require a live backend |
| `IQuestClient` | `QuestSqliteRepository` (partial) | Routed by `QuestOnlineOfflineRepository` |
| `IAuthClient` | None | Token refresh requires a live backend |
| `IStatClient` | None | Stats are debug-only, online only |

## Request/Response Serialization

All request and response bodies are serialized as JSON using `Newtonsoft.Json`. Key settings:

- Property names: `camelCase` (e.g., `accountId`, not `AccountId`)
- GUID format: lowercase hyphenated string (e.g., `"aabb1234-..."`)
- DateTime format: ISO 8601 UTC string
- Missing properties: silently default (null, 0, `Guid.Empty`) — no exception

The `JSonDataStream<TD>` class (internal to `SimpleWebClient`) handles serialization of the request body. Deserialization uses `JsonConvert.DeserializeObject<TR>(response.DataAsText)` with default settings.

If a response property name does not match (e.g., backend returns `creatureId` but the C# model has `CreatureId` with no `[JsonProperty]`), Newtonsoft.Json silently ignores it and the property is its default value. This is a common source of subtle bugs — verify JSON field names match by comparing the backend DTO to the Unity response model.

## Common Mistakes / Tips

- **Wrong key in `GameConfigurationKeys`.** If the key string does not match `game_config.yaml`, `SimpleWebClient`'s base URL is null. Every request fails with "Invalid HttpClient configuration" logged at construction time. Double-check the exact string match.
- **Path leading slash handling.** `SimpleWebClient` strips a leading `/` from the path: `path = path.StartsWith("/") ? path.Substring(1, ...) : path`. This means `/api/v1/npc/ensure` and `api/v1/npc/ensure` are equivalent. Consistency is preferred — the codebase uses the leading slash convention.
- **JSON property name mismatch.** The response deserializes to all defaults without throwing. Add debug logging of `response.DataAsText` in the `after` callback if a response object is unexpectedly empty.
- **Not handling `NotAuthorizedException`.** If `GetAccessTokenAsync` fails to refresh and throws, the caller receives `NotAuthorizedException`. Without a handler, the game will show an unhandled exception. Catch this in top-level handlers and redirect to the login flow.
- **Creating a new client implementation for each endpoint.** All endpoints for a domain should be on one client class (e.g., all NPC operations on `NpcClientUnityHttp`). Do not create a separate `NpcEnsureStarterClient` and `NpcGiveCreatureClient`.
- **`CancellationToken` parameter exists on interface but is not passed to `SimpleWebClient` methods.** The current `SimpleWebClient` does not accept `CancellationToken` in its `Get`/`Post` methods. The `ct` parameter on `INpcClient` methods exists for future compatibility. If Best HTTP adds native cancellation support, the base class will be updated. For now, wrap calls in a `Task.WhenAny` if you need timeout behavior.
- **Registering the client before `ITokenManager` is bound.** `TokenManager` is bound before HTTP clients in `LocalDevGameInstaller`. If you add a new client binding before the auth section, its constructor will fail to resolve `ITokenManager`. Keep all client bindings in the HTTP clients section (after auth).

## Related Pages

- [Unity Project Setup](?page=unity/01-project-setup) — `game_config.yaml` setup, server address keys
- [Dependency Injection](?page=unity/02-dependency-injection) — how clients are registered with `AsSingle()`
- [NPC Interaction](?page=unity/04-npc-interaction) — example of `INpcClient` usage in a world behaviour
- [Auth and Accounts](?page=backend/06-auth-and-accounts) — `ITokenManager` that `SimpleWebClient` depends on
- [Backend Architecture](?page=backend/01-architecture) — the endpoints these clients call
