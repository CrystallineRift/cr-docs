# HTTP Clients

## Overview

All HTTP communication between Unity and the backend uses `SimpleWebClient` as a base class. Each domain gets its own typed client interface + Unity HTTP implementation.

Sources:
- `../cr-data/…/Core/Data/Client/Implementation/SimpleWebClient.cs`
- `../cr-data/…/Npcs/Runtime/Http/NpcClientUnityHttp.cs`

## SimpleWebClient

`SimpleWebClient` is an abstract base class that wraps **Best HTTP** library calls.

### Constructor

```csharp
protected SimpleWebClient(
    ICRLogger logger,
    IGameConfiguration configuration,
    ITokenManager tokenManager,
    string serverConfigKeyAddress)   // key in game_config.yaml, e.g. GameConfigurationKeys.NpcServerHttpAddress
```

The base URL is read from `IGameConfiguration` using the config key. If the key is missing, an error is logged and all requests will fail.

### HTTP Methods

```csharp
protected Task<TR> Get<TR>(string path, ...)
protected Task<TR> Post<TR, TD>(string path, TD data, ...)
protected Task<TR> Put<TR, TD>(string path, TD data, ...)
protected Task Delete(string path, ...)
```

Every request:
1. Calls `ITokenManager.GetAccessTokenAsync()` and adds `Authorization: Bearer <token>`
2. Serialises the body with `Newtonsoft.Json`
3. Awaits the response
4. Maps HTTP status codes to typed exceptions

### Error Mapping

| Status | Exception |
|--------|-----------|
| 400 | `BadRequestException` |
| 401 | `NotAuthorizedException` |
| 403 | `ForbiddenException` |
| 404 | `NotFoundException` |
| other | `InternalServerErrorException` |

### Rate Limit Events

```csharp
public event RateLimitEvent OnRateLimitWarningEvent;   // > 75% of limit used
public event RateLimitEvent OnRateLimitReachedEvent;   // 100% of limit used
```

Subscribe to these to show warnings or throttle client-side requests.

## GameConfigurationKeys

All server address config keys are constants in `GameConfigurationKeys`:

```csharp
public static class GameConfigurationKeys
{
    public const string NpcServerHttpAddress     = "npc_server_http_address";
    public const string AuthServerHttpAddress    = "auth_server_http_address";
    public const string TrainerServerHttpAddress = "trainer_server_http_address";
    // …
}
```

## INpcClient / NpcClientUnityHttp

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
        => await Post<EnsureStarterNpcResponse, EnsureStarterNpcRequest>("/api/v1/npc/ensure-starter", request);

    public async Task<GiveCreatureResponse> GiveCreatureAsync(Guid npcId, GiveCreatureRequest request, CancellationToken ct = default)
        => await Post<GiveCreatureResponse, GiveCreatureRequest>($"/api/v1/npc/{npcId}/give-creature", request);
}
```

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

## Adding a New HTTP Client

1. **Define the interface** in the shared model project:
   ```csharp
   public interface IMyClient
   {
       Task<MyResponse> DoThingAsync(MyRequest request, CancellationToken ct = default);
   }
   ```

2. **Implement** in the Unity project:
   ```csharp
   public class MyClientUnityHttp : SimpleWebClient, IMyClient
   {
       public MyClientUnityHttp(ICRLogger logger, ITokenManager tokenManager, IGameConfiguration config)
           : base(logger, config, tokenManager, GameConfigurationKeys.MyServerHttpAddress) { }

       public async Task<MyResponse> DoThingAsync(MyRequest request, CancellationToken ct = default)
           => await Post<MyResponse, MyRequest>("/api/v1/my-endpoint", request);
   }
   ```

3. **Add config key** to `GameConfigurationKeys` and `game_config.yaml`.

4. **Register** in `LocalDevGameInstaller.cs`:
   ```csharp
   Container.Bind<IMyClient>().To<MyClientUnityHttp>().AsSingle();
   ```
