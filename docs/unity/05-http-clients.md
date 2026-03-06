# HTTP Clients

All HTTP communication between Unity and the backend uses `SimpleWebClient` as a base class. Each domain gets its own typed client interface and Unity HTTP implementation. This layer is the translation boundary between the C# domain model and the REST API.

## Why This Design?

### Why a Shared `SimpleWebClient` Base Class?

Every HTTP client in the game needs the same infrastructure:
- Attach an authorization header
- Serialize/deserialize JSON
- Map HTTP status codes to typed exceptions
- Support rate limit events

Putting this in a shared base class means:
- New domain clients are 10–20 lines of code
- Token management is always correct — no client can forget to attach the auth header
- Error handling is consistent across all domains
- Rate limit events are available everywhere without reimplementation

The alternative (each client implementing HTTP from scratch) would lead to drift between clients over time and makes it easy to accidentally omit auth headers in a new client.

### Why Not Use Unity's Built-in `UnityWebRequest`?

`UnityWebRequest` is designed for coroutines rather than `async`/`await`. Best HTTP provides a proper async-native API that integrates with `Task`-based async/await patterns used throughout the game's domain services. It also provides better error handling, connection pooling, and timeout configuration than `UnityWebRequest`.

### Why Typed Exceptions Instead of Result Types?

Typed exceptions (`NotFoundException`, `BadRequestException`, etc.) let callers handle only the specific errors they care about and let unexpected errors propagate as unhandled exceptions (which become visible in Unity's Console). A result type pattern would require every caller to check `if (result.IsError)` everywhere, obscuring the happy path.

Callers that need to handle a specific error (e.g., 404 for an optional resource) can catch the specific exception. Callers that do not expect an error let it propagate to `GameInitializer`'s top-level error handler.

## `SimpleWebClient`

`SimpleWebClient` is an abstract base class that wraps **Best HTTP** library calls.

Source: `../cr-data/…/Core/Data/Client/Implementation/SimpleWebClient.cs`

### Constructor

```csharp
protected SimpleWebClient(
    ICRLogger logger,
    IGameConfiguration configuration,
    ITokenManager tokenManager,
    string serverConfigKeyAddress)   // key in game_config.yaml, e.g. GameConfigurationKeys.NpcServerHttpAddress
```

The base URL is read from `IGameConfiguration` using the config key at construction time. If the key is missing from `game_config.yaml`, the base URL is null and every subsequent request will throw immediately with a clear error message. Check `GameConfigurationKeys` for the correct key name — using a typo'd string key is a common setup mistake.

### Request Lifecycle

Every request follows this sequence:

1. `ITokenManager.GetAccessTokenAsync()` — retrieves the current access token; if expired, `TokenManager` automatically calls `RefreshAccessTokenAsync` first
2. Constructs the full URL: `{baseUrl}{path}`
3. Creates a Best HTTP request with `Authorization: Bearer <token>` header
4. Serializes the request body with `Newtonsoft.Json` (for POST/PUT)
5. Sends the request and awaits the response
6. Checks the HTTP status code and maps to a typed exception if not 2xx
7. Deserializes the response body with `Newtonsoft.Json` into the typed response object
8. Returns the deserialized response

### HTTP Methods

```csharp
protected Task<TR> Get<TR>(string path, CancellationToken ct = default)
protected Task<TR> Post<TR, TD>(string path, TD data, CancellationToken ct = default)
protected Task<TR> Put<TR, TD>(string path, TD data, CancellationToken ct = default)
protected Task Delete(string path, CancellationToken ct = default)
```

Always pass the `CancellationToken` from the calling context. This allows proper cancellation when scenes unload or initialization is aborted (see [World Behaviours](?page=unity/03-world-behaviours)).

### Error Mapping

| Status | Exception |
|--------|-----------|
| 400 | `BadRequestException` |
| 401 | `NotAuthorizedException` |
| 403 | `ForbiddenException` |
| 404 | `NotFoundException` |
| 409 | `ConflictException` |
| 429 | `RateLimitException` |
| other | `InternalServerErrorException` |

`NotAuthorizedException` (401) from a request can indicate either an expired token or a genuinely invalid credential. `TokenManager` should handle the 401 case by attempting a refresh before the exception propagates. If the refresh also fails (returns 401), the client should redirect to the login screen.

### Rate Limit Events

```csharp
public event RateLimitEvent OnRateLimitWarningEvent;   // > 75% of limit used
public event RateLimitEvent OnRateLimitReachedEvent;   // 100% of limit used
```

Subscribe to these to show warnings or throttle client-side requests. `RateLimitEvent` carries the current usage percentage and the time until the limit resets. In practice, subscribe to these events in the UI system to surface a "slow down" message to the player.

The events fire based on `X-RateLimit-*` headers returned by the backend. If the backend does not include these headers, the events never fire.

## `GameConfigurationKeys`

All server address config keys are constants in `GameConfigurationKeys`:

```csharp
public static class GameConfigurationKeys
{
    public const string NpcServerHttpAddress     = "npc_server_http_address";
    public const string AuthServerHttpAddress    = "auth_server_http_address";
    public const string TrainerServerHttpAddress = "trainer_server_http_address";
    public const string CreatureServerHttpAddress = "creature_server_http_address";
    // …
}
```

When adding a new HTTP client, add the key constant here before using it in the client's constructor. This is a compile-time safety net — using a string literal in the constructor instead of a constant is a common mistake that causes silent failures if the key is misspelled.

## `INpcClient` / `NpcClientUnityHttp`

The NPC client is the canonical example of the typed client pattern:

```csharp
public interface INpcClient
{
    Task<EnsureStarterNpcResponse> EnsureStarterNpcAsync(EnsureStarterNpcRequest request, CancellationToken ct = default);
    Task<GiveCreatureResponse> GiveCreatureAsync(Guid npcId, GiveCreatureRequest request, CancellationToken ct = default);
}

public class NpcClientUnityHttp : SimpleWebClient, INpcClient
{
    public NpcClientUnityHttp(ICRLogger logger, ITokenManager tokenManager, IGameConfiguration configuration)
        : base(logger, configuration, tokenManager, GameConfigurationKeys.NpcServerHttpAddress) { }

    public async Task<EnsureStarterNpcResponse> EnsureStarterNpcAsync(EnsureStarterNpcRequest request, CancellationToken ct = default)
        => await Post<EnsureStarterNpcResponse, EnsureStarterNpcRequest>("/api/v1/npc/ensure-starter", request, ct);

    public async Task<GiveCreatureResponse> GiveCreatureAsync(Guid npcId, GiveCreatureRequest request, CancellationToken ct = default)
        => await Post<GiveCreatureResponse, GiveCreatureRequest>($"/api/v1/npc/{npcId}/give-creature", request, ct);
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
| `INpcClient` | `NpcClientUnityHttp` |

All are bound `AsSingle()` — one instance per container lifetime, shared across all consumers. This is safe because `SimpleWebClient` is stateless aside from the base URL and injected dependencies (which are also singletons).

## Adding a New HTTP Client

### 1. Define the interface in the shared model project

```csharp
// In CR.<Domain>.Model.REST or a shared contracts project
public interface IMyClient
{
    Task<MyResponse> DoThingAsync(MyRequest request, CancellationToken ct = default);
}
```

### 2. Implement in the Unity project

```csharp
public class MyClientUnityHttp : SimpleWebClient, IMyClient
{
    public MyClientUnityHttp(ICRLogger logger, ITokenManager tokenManager, IGameConfiguration config)
        : base(logger, config, tokenManager, GameConfigurationKeys.MyServerHttpAddress) { }

    public async Task<MyResponse> DoThingAsync(MyRequest request, CancellationToken ct = default)
        => await Post<MyResponse, MyRequest>("/api/v1/my-endpoint", request, ct);
}
```

### 3. Add config key to `GameConfigurationKeys` and `game_config.yaml`

```csharp
// GameConfigurationKeys.cs
public const string MyServerHttpAddress = "my_server_http_address";
```

```yaml
# game_config.yaml
my_server_http_address: "http://localhost:5000"
```

### 4. Register in `LocalDevGameInstaller.cs`

```csharp
Container.Bind<IMyClient>().To<MyClientUnityHttp>().AsSingle();
```

### 5. Add the backend endpoint

Ensure the backend's `Program.cs` maps the corresponding endpoint group. See [Backend Architecture](?page=backend/01-architecture) for the endpoint registration pattern.

## Offline Mode Considerations

HTTP clients are **not used in offline mode**. When `IGameSessionRepository.IsOnline` is false, the online/offline router in the repository layer (e.g., `TrainerOnlineOfflineRepository`) routes to the SQLite implementation instead of calling any HTTP client.

However, action-oriented clients like `INpcClient` (which perform mutations rather than queries) do not have offline equivalents. If the client is offline, calls to `INpcClient.EnsureStarterNpcAsync` will fail. `NpcWorldBehaviour.InitializeAsync` should check `context.IsOnline` before calling the backend:

```csharp
if (!context.IsOnline)
{
    // Restore from local SQLite cache if available
    // Or disable the NPC interaction for this session
    return;
}
```

This guard is not yet implemented in all behaviours — it is a known gap to address before the offline mode feature is complete.

## Request/Response Serialization

All request and response bodies are serialized as JSON using `Newtonsoft.Json`. The serialization settings match the backend's ASP.NET JSON settings:

- Property names: `camelCase` (e.g., `accountId`, not `AccountId`)
- GUID format: lowercase hyphenated string (e.g., `"aabb1234-..."`)
- DateTime format: ISO 8601 UTC string

If a response property name does not match, `Newtonsoft.Json` silently ignores it (default behavior) and the C# property will be its default value (`null`, `0`, `Guid.Empty`, etc.). This is a common source of subtle bugs — always verify the JSON field names match between the backend DTO and the Unity request/response models.

## Common Mistakes / Tips

- **Wrong key in `GameConfigurationKeys`.** If the key string does not match `game_config.yaml`, `SimpleWebClient`'s base URL is null. Every request throws with "base URL is null or empty". Double-check the exact string match.
- **Forgetting to pass `ct` to `Post`/`Get`.** Scene unloads cannot cancel in-flight requests. Always pass `ct` through.
- **Using `CancellationToken.None` for initialization calls.** Initialization calls should use the `ct` from `InitializeAsync`. Using `None` prevents clean cancellation when the player switches trainers or the scene unloads during a slow request.
- **JSON property name mismatch.** The response deserializes to all defaults without throwing. Add response validation or use `[JsonProperty]` attributes to make the mapping explicit.
- **Not handling `NotAuthorizedException`.** If `GetAccessTokenAsync` fails to refresh and throws, the caller receives `NotAuthorizedException`. Without a handler, the game will show an unhandled exception. Catch this in top-level handlers and redirect to the login flow.
- **Creating a new client implementation for each endpoint.** All endpoints for a domain should be on one client class (e.g., all NPC operations on `NpcClientUnityHttp`, not a separate `NpcEnsureStarterClient` and `NpcGiveCreatureClient`).

## Related Pages

- [Unity Project Setup](?page=unity/01-project-setup) — `game_config.yaml` setup, server address keys
- [Dependency Injection](?page=unity/02-dependency-injection) — how clients are registered with `AsSingle()`
- [NPC Interaction](?page=unity/04-npc-interaction) — example of `INpcClient` usage in a world behaviour
- [Auth and Accounts](?page=backend/06-auth-and-accounts) — `ITokenManager` that `SimpleWebClient` depends on
- [Backend Architecture](?page=backend/01-architecture) — the endpoints these clients call
