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

Every typed exception derives from `ServerRequestException` (`Assets/CR/Core/Data/Logic/`), so a caller has two levels to choose from: catch one subclass to react to one status (`catch (NotFoundException)` → "treat as absent"), or catch the base type to handle "the server said no, whatever the reason" in one place. Callers that do not expect an error let it propagate to `GameInitializer`'s top-level error handler, which logs it with the component name.

The family lives in the engine-free `CR.Core.Data.Logic` assembly rather than beside `SimpleWebClient` so the whole status → exception → player-text path is unit-tested without Best HTTP or Unity in the loop.

### Why Retry Automatically Now?

`SimpleWebClient` used to have no retry at all, for three reasons: an automatic retry of a write could
double its effect, retries can hide real problems (an auth error that retries forever), and callers that
wanted a second go could simply call again. The first reason is gone. Every write now carries an
`Idempotency-Key` (below), so the server replays the answer to a request it already ran instead of running
it twice, and a lost response is no longer something a caller has to guess about. Retrying is therefore
one policy for the whole client, with no per-route tagging and no "outcome unknown" case: reads and keyed
writes share it. The second reason is answered by the bounds: three retries at most, only for the failures
listed below, and a 401 keeps its single in-request re-auth.

For a failure the client gave up on (or one it never retries) the manual pattern still applies: catch and
let the player try again from the UI:

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

### Retry Strategy (Polly)

Every request goes through `HttpRetryExecutor` (the version check excepted, below), a thin wrapper around one shared
[Polly](https://github.com/App-vNext/Polly) v8 `ResiliencePipeline` (`Polly.Core`). Polly appears nowhere
else: a caller hands the executor one attempt and gets back its result, or the last failure unchanged, as
if nothing had retried. The rules are plain code in `HttpRetryPolicy`, which has no Polly and no engine in
it, so the status table and the delay bounds are ordinary unit tests. Both live in `Assets/CR/Core/Data/Logic/`.

**What is retried** (`HttpRetryPolicy.ShouldRetry`), up to 3 retries, so a call goes on the wire at most 4 times:

| Failure | Retried | Why |
|---|---|---|
| No response to the call's own request (refused, DNS, TLS, connect timeout; `ServerUnreachableException`) | yes | The request may never have arrived. If it did, a keyed write replays. |
| 429 | yes | Rate limited; `Retry-After` is honoured. |
| 502, 503, 504 | yes | The proxy or host could not hand the request over or get an answer back in time. |
| 409 whose JSON body is `{"error":"idempotency_in_progress"}` | yes | Another attempt on the same key is still running. |
| 500, 501, 505 | **no** | See the ruling below. |
| Every other 4xx: 400, 401, 403, 404, a plain 409, 410, 422 | no | These are answers, not hiccups. A 401 keeps its own in-request re-auth. |
| A signed-out session (`SignedOut`) or a missing online entry (`EntryRequired`) | no | Decisions, not hiccups; `EntryRequired` has status 0 but nothing was attempted. |
| A token that could not be fetched because the auth server is unreachable (a bare `StatusCode == 0` from the token manager) | **no** | The auth client has already retried the refresh itself. See "One layer retries a given failure". |
| Cancellation (`OperationCanceledException`) | no | A cancel is not a server failure. |
| Anything whose `Retry-After` is over 10 s | no | The failure surfaces at once with `RetryAfterSeconds` intact. |
| Any failure once the call has been failing for 15 s (`HttpRetryPolicy.RetryBudget`) | no | A host that never answers costs one connect timeout, not four. See "The time budget". |

**Why a 500 is not retried.** A 500 is the server's own code having run and failed, which is usually a bug
or bad data that the next attempt meets again: a retry only delays the error by seconds and multiplies the
load of one failing call. It is also the one failure where retrying a *write* is not safe. When a handler
throws, or answers any 5xx, the idempotency middleware deletes the claim so that a retry may run the handler
again, which makes a retried 500 a second real execution rather than a replay. A handler that applied part of
its effects before failing would apply them twice. 502/503/504 are different: the handler either never ran or
finished unseen, and in the second case the stored answer is replayed. The table is the same for every method,
so a failed read is not retried on a 500 either; the player can try again.

**One layer retries a given failure.** A data call asks the token manager for a bearer before it sends anything. When
the access token has expired, `TokenManager` and `GameAuthRepository` spend the refresh token through
`AuthClientUnityHttp`, which is a `SimpleWebClient` with this same ladder. If the auth server cannot be reached, that
refresh is sent four times (the original and three retries, about 3.5 s of backoff) before the repository gives up with
"the auth server is unavailable" and `TokenManager` throws it as a bare `ServerRequestException` with `StatusCode == 0`.
Were the data call to retry that as well, one call against a dead auth server would put 4 x 4 = 16 refresh POSTs on
`/auth/token/refresh`, a route under the Bootstrap rate limit, and take about 17 s of backoff to say so. So at status 0
only a no-response of the call's *own* request is retried: the `ServerUnreachableException` that `TransmitAsync` raises.
A bare status 0 is the token manager reporting on a request that was not this call's, and it is surfaced as it is.
`HttpRetryLayeringTests` runs the real `TokenManager`, `GameAuthRepository` and `AuthClientUnityHttp` over two scripted
wires (data and auth) and counts what each saw: with the auth server down, 4 refresh POSTs and no data request; with one
refused refresh followed by an answer, 2 refresh POSTs and one data request.

**The time budget.** Best HTTP's defaults here are 20 s to connect and no limit once connected (its
`RequestSettings.RequestTimeout` is `TimeSpan.MaxValue`; nothing in the project overrides either). A host that
drops connections therefore fails an attempt only after the connect timeout, and four of those would be over 80 s where
there used to be one 20 s wait. So a call that has been failing for `HttpRetryPolicy.RetryBudget` (15 s) is not sent
again: when an attempt fails, `HttpRetryExecutor` reads its clock, and past the budget the failure surfaces instead of
starting a backoff. The budget only ends retries. It never cuts an attempt off, so a slow answer that does arrive is
untouched, and failures that come back quickly (a refused connection, a 503, a 429) are far inside it and still get all
three retries. An attempt that connects and is then never answered has no bound at all, with or without retries, because
the request timeout is unset; that gap is left alone because the right limit depends on the slowest legitimate call (a
content manifest on a slow link, a Studio push).

**Backoff** (`HttpRetryPolicy.RetryDelay`): 0.5 s, 1 s, 2 s, each varied by up to 25% either way so clients
that failed together do not all return together. A `Retry-After` header is a *minimum*: the wait is the larger of
the backoff and the header. A `Retry-After` over `MaxRetryAfterSeconds` (10) is not waited for. The email link
flow relies on that: a 429 on `account/email/code` carries a cooldown of about a minute, which must reach
`LinkAccountPresenter` through `ServerRequestException.RetryAfterSeconds` rather than hang the call on a spinner.

**The session a call belongs to.** `SimpleWebClient` reads `OnlineSessionGate.Generation` once, before the first
attempt, and hands the executor a "session is still current" check. It is asked after every failure and again
after every backoff: a call is not re-sent once the session was signed out or a new online entry began (a mode
switch, another trainer). A write must not be re-sent into a session it did not start in, where it would run as
someone else. The caller then gets the failure that led to the backoff.

**Threads.** Every attempt resumes on the caller's synchronisation context (the Unity main thread): an attempt raises the
rate-limit events and writes the log. Polly would resume on the thread pool by default.

**Where retries are off.** `VersionCheckClientUnityHttp` overrides `RetryExecutor` with
`HttpRetryExecutor.SingleAttempt`. `GameSessionManager.Start` awaits the version check before the database gate on
every launch, and `ConnectivityProbe` uses it to ask whether the server is there right now: both want their "no" at
once, not after three backoffs on every launch without a network. Offline play's domain calls go to the local services
rather than these clients, so they are untouched.

**Cancellation.** `HttpRetryExecutor.ExecuteAsync` takes a `CancellationToken` and a cancel ends the retries (even
mid-backoff), but the `Get`/`Post`/`Put`/`Delete` methods do not take one yet (a known gap, see Request Lifecycle).
An aborted Best HTTP request surfaces as `TaskCanceledException`, which is never retried.

**Library.** Two managed DLLs are vendored in `Assets/Plugins/Polly/`: `Polly.Core` 8.5.2 and
`Microsoft.Bcl.TimeProvider` 8.0.0, the unmodified netstandard2.0 builds from NuGet. Nothing else of Polly's
dependency chain is shipped, because the project already supplies it and a second copy would be a duplicate
plugin: `Microsoft.Bcl.AsyncInterfaces` comes from the `com.cr.game.compat` package (9.0.0.2),
`System.Threading.Tasks.Extensions` and `System.ComponentModel.Annotations` are facades in Unity's Mono class
libraries (the same ones `System.Text.Json` and FluentMigrator already bind to), and
`System.Runtime.CompilerServices.Unsafe` comes from `Assets/Plugins/Roslyn/`. `Assets/link.xml` preserves both
Polly assemblies. Every build profile (Steam Deck, Windows, macOS, DatabaseManager Alpha) inherits the project-wide
scripting settings: the Mono backend for standalone targets (Android is the only IL2CPP override) at the default
stripping level, on .NET Standard 2.1; no profile overrides any of it. The preserve entries are insurance: they keep
both Polly assemblies whole if a profile moves to IL2CPP or stronger stripping. They do not protect the class-library
assemblies Polly calls into (`System.ComponentModel.DataAnnotations`, for its options validation); if a stripped build
ever loses those, add them to `link.xml` too.

**Testing.** `HttpRetryPolicyTests` is the status table, the Retry-After ceiling and the delay bounds.
`HttpRetryExecutorTests` drives the real Polly pipeline with an attempt that fails on cue (attempt counts, the
schedule, the time budget against a scripted clock, cancellation before and during a backoff, session changes,
main-thread resumption). `SimpleWebClientRetryTests` runs the whole client against a scripted transport
(`SimpleWebClient.TransmitAsync` is the seam, returning a `TransportReply`): the key on every write and none on a read,
one key across retries and the 401 re-send, and the guards around a retry. `HttpRetryLayeringTests` is the data client
and the auth client together behind the real token manager (see "One layer retries a given failure").
`VersionCheckClientUnityHttpTests` pins the opt-out.

### Idempotency Keys

The server supports (see [Idempotency Keys](../backend/27-idempotency-keys.md)) an `Idempotency-Key` header on
player write routes: a retry with the same key and the same request replays the first response instead of
running the handler again; the same key with a *different* request is a 422 (`idempotency_key_reused`); the
same key while the first attempt is still running is the 409 `idempotency_in_progress` that the client retries.

`SimpleWebClient` is the only place a key is minted or attached:

- **One key per logical call.** `ExecuteAsync` mints a GUID before the retry loop starts. Every attempt uses it:
  each Polly retry and the 401 re-send inside an attempt (the body is re-serialised identically, so the server's
  request hash matches).
- **Decided by the verb of the request actually built.** `SendOnceAsync` attaches the key when
  `request.MethodType.CarriesIdempotencyKey()` (`HttpMethodExtensions`): every verb except GET, HEAD, OPTIONS and
  TRACE, so POST, PUT, PATCH and DELETE. A read never carries one.
- **Exactly one header.** It is set (not added) after the caller's `before` hook has run, so a hook that adds its
  own `Idempotency-Key` cannot leave a second value on the request. `AccountClientUnityHttp` used to mint its own
  key for the two email-link POSTs in a `before` hook; that is gone, and those calls get the shared key.
- **Callers do nothing.** Every write through `SimpleWebClient` is keyed automatically. Anonymous bootstrap routes
  (`/auth/*`, `POST /account`) are sent with a key too, which the server ignores because it has no principal to
  scope one to; they are retried like everything else but are not replay-protected.

**Production switch.** The server accepts a missing key (`Idempotency:RequireKey` is off, with a warning in the
log), which is what keeps old clients working. Once a minimum client version that sends keys on every write is
enforced (the release that ships this change, v0.1.8 on the current plan, behind a `MinClientVersion` bump), set
`Idempotency__RequireKey=true` in the production `/opt/cr/.env` and restart the API so unkeyed writes get a 400
(`idempotency_key_required`). Doing it earlier locks out every client that predates this change.

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

The base URL is read from `IGameConfiguration` using the config key at construction time via `configuration.TryGet(serverConfigKeyAddress, out _serverAddress)`. `IGameConfiguration` is implemented by `SettingsGameConfiguration`, which answers every `*_server_http_address` key with the resolved environment's API base URL (see [Game settings](?page=unity/08-content-registry)). A key it does not answer — a typo, or a client with no entry there — leaves `_serverAddress` null and an error is logged immediately: `Invalid HttpClient configuration. address: {key}`. Every subsequent request will fail to build a valid URL.

### Request Lifecycle

Each `Get`/`Post`/`Put`/`Delete` is one *logical call*. `ExecuteAsync` mints the call's `Idempotency-Key` and reads the
session generation once, then runs `HandleResponse` under the retry executor (see [Retry Strategy](#retry-strategy-polly)).
The steps below are one attempt; a failure the policy retries goes back to step 1 after its backoff.

Every authenticated request follows this sequence:

1. `ITokenManager.GetAccessTokenAsync()` — retrieves the current Bearer token; refresh happens inside `TokenManager` if needed. A token that cannot be had (signed out, no online entry, the auth server unreachable) throws here, before anything is sent, and this client does not retry it: the refresh already went through the auth client's own retries
2. Constructs the full URL: `{_serverAddress}/{path}` (note: path leading slash is stripped)
3. Creates a Best HTTP request with `Authorization: Bearer <token>` header
4. Serializes the request body using `Newtonsoft.Json` (`JSonDataStream<TD>`) for POST/PUT
5. Attaches the call's `Idempotency-Key` (writes only), then sends the request through `TransmitAsync`, which awaits `GetHTTPResponseAsync()` and turns the answer into a `TransportReply` (status, reason, body, headers, path)
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

`CheckForResponseForErrors` hands the status, reason phrase and body to `ServerResponseClassifier.ForStatus`, which returns the exception to throw (or null for any 2xx). `SendOnceAsync` additionally wraps Best HTTP's `AsyncHTTPException` — refused connection, DNS, TLS, timeout — so a request that never got an answer surfaces through the same family:

| Status | Exception | `IsTransient` | Default message (no usable body) |
|--------|-----------|---------------|----------------------------------|
| 2xx | (none — success) | | |
| 400 | `BadRequestException` | no | "Request refused." |
| 401 | `NotAuthorizedException` | no | "Sign-in required." |
| 402 | `PaymentRequiredException` | no | "Not enough funds." |
| 403 | `ForbiddenException` | no | "Not allowed." |
| 404 | `NotFoundException` | no | "Not found." |
| 409 | `ConflictException` | no | "Already changed - refresh and try again." |
| 429 | `ServerRequestException` | yes | "Too many requests - slow down." |
| other 4xx / 3xx / 1xx | `ServerRequestException` | no | "Request refused." |
| 5xx | `InternalServerErrorException` | yes | "Server error - try again." |
| no response | `ServerUnreachableException` (`StatusCode == 0`) | yes | "Can't reach the server." |

Every instance carries:

- `StatusCode` — the HTTP status, or `0` when nothing came back.
- `Message` — **always player-facing text**, chosen by `ServerErrorMessage.ForPlayer`. For a 4xx the body's explanation wins when the server gave a short one (≤ 200 characters); otherwise the status's default wording above. Never the reason phrase ("I'm a teapot", "Found"), and never a 5xx body — that is the server talking to its operators (`Error creating account: <exception>`), so it stays on `Body` and goes to the log. UI may show `Message` verbatim.
- `Body` — the raw response body (empty string, never null) for callers that deserialise a structured refusal, e.g. the market's result object on a 409.
- `IsTransient` — true when retrying later could plausibly succeed (no response, 429, or 5xx). It answers "might trying again help?" for a screen; the client's own automatic retry set is narrower (see [Retry Strategy](#retry-strategy-polly)): it leaves out 500.
- `RetryAfterSeconds` — what the response's `Retry-After` header asked for (0 when absent), for a screen that shows a cooldown.
- `ServerUnreachableException.TransportMessage` — Best HTTP's own wording, for the log.

The body is parsed for **every** status, not only 400, because cr-api is not uniform about where the reason lives. `ServerErrorMessage` tries `message`, `errorMessage` (market result objects), `error`, `detail` then `title` (ASP.NET ProblemDetails — `detail` first because only it says what actually happened), then a short bare-text body; JSON arrays, markup, malformed JSON and non-string fields are never shown. A bare JSON string document — what `Results.BadRequest("AreaKey is required.")` serialises to — is unquoted and unescaped rather than shown to the player with its literal quotes intact. Two entry points read the result differently:

- `ForPlayer(status, reason, body)` — what `ServerRequestException.Message` carries: body (4xx only, capped) → status default. Used by the classifier.
- `From(status, reason, body)` — what an author or a log wants: body (any status, any length) → status default → reason phrase → "Request refused.". Used by the editor sync helpers' `DescribeFailure`, where a 500's detail and a 409's full list of missing names are exactly the point.

Cancellation is deliberately **not** part of the family: an aborted request still surfaces as `TaskCanceledException` / `OperationCanceledException`, because a cancel is not a server failure and nothing should be shown for it.

The 401 path is the one status the client acts on itself. `AuthRetryPolicy.ShouldReauthenticate(status, hasTokenManager, callerToken)` (engine-free, unit-tested) says when: only a 401 on a request whose token came from the token manager. A caller-supplied token is the caller's to refresh, and a client built without a token manager (`AuthClientUnityHttp`, `VersionCheckClientUnityHttp`) cannot retry — which is what stops a 401 from the refresh endpoint retrying itself. When it applies, `HandleResponse` re-authenticates (`IRejectedTokenRecovery.ReAuthenticateAsync(sentToken)` when the token manager offers it, otherwise `ITokenManager.RefreshAccessTokenAsync()`) and re-sends exactly once, with the same `Idempotency-Key`, before letting the second failure propagate. This stays inside a single attempt of the retry executor; it is not a Polly retry.

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

The NPC client is the canonical example of the typed client pattern. From the actual source — note
that `EnsureNpcCreatureTeamAsync` below calls a route Phase E retired (410) on the server; the method
is unused dead surface on the client now (`StartEncounterAsync` builds NPC teams itself) but kept
here only to illustrate the typed-client shape, not as a route still worth calling — see
[NPC System](?page=backend/02-npc-system). `GiveCreatureAsync` itself (and
`INpcWorldRepository.GiveCreatureAsync` / `NpcOnlineOfflineRepository.GiveCreatureAsync` that used
to call it) was deleted outright in M2 close (L6): `receive-gift` replaced the gift path, and there
was no illustrative reason left to keep a method for a retired route with zero callers:

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

### Step 2 — Make `SettingsGameConfiguration` answer the key

There is no yaml file to edit any more. Every `*_server_http_address` key resolves to the selected
environment's API base URL (`Local`, `Production`, … from `BackendEnvironments.asset`), so a client
for the same host needs no new setting; add the key to the table in `SettingsGameConfiguration` (and
its all-keys test) so the lookup answers it.

```csharp
// resolves to the environment's apiBaseUrl, e.g. "http://localhost:8080"
configuration.TryGet(GameConfigurationKeys.GuildServerHttpAddress, out var address);
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

**During player-triggered interactions** (button presses, E-key, etc.): catch and give the player feedback. The rule for *what* to show lives in one pure function, `PlayerErrorText.For(Exception)` (`Assets/CR/Core/Data/Logic/PlayerErrorText.cs`):

| Exception | Returns |
|-----------|---------|
| `ServerRequestException` (any subclass) | its `Message` — already player-facing |
| `OperationCanceledException` / `TaskCanceledException` | `null` — show nothing, the player cancelled |
| `AggregateException` | the first non-cancellation inner exception (flattened), or the first inner exception if all are cancellations — then the rules above |
| anything else | `PlayerErrorText.Generic` ("Something went wrong.") — a bug's message is for the log, never the screen |

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
        // A status this screen has its own answer for.
        _logger.Warn("[NpcInteraction] NPC not found during give-creature.");
        ShowErrorUI("This NPC is not available right now.");
    }
    catch (Exception ex)
    {
        // Everything else: server refusals show their own wording, bugs show the generic line,
        // a cancel shows nothing.
        _logger.Error($"[NpcInteraction] Give-creature failed: {ex.Message}");
        var why = PlayerErrorText.For(ex);
        if (why != null) ShowErrorUI(why);
    }
    finally
    {
        _isInteracting = false;
    }
}
```

Where this is wired today:

- `BattleBagPanelHandler` catches `ServerRequestException` (every status, not only 400) and raises `BattleEvents.RaiseItemUseRefused(ex.Message)` so the battle log explains the refusal. `ServerUnreachableException` is caught first and worded differently — "Couldn't reach the server - the item may still have been used." — because a timed-out request may have been applied server-side; the bag is refreshed so the next open shows the server's quantities.
- `PlayerTeamView` (give / take back a held item) and `MerchantShopScreenHandler` (purchase) and `CharacterCreateController` route their catch-all through `PlayerErrorText.For`. `PlayerTeamView` keeps a separate `catch (InvalidOperationException)` first because the held-item repository states *its* refusals in player terms.
- `MarketManager` keeps its own per-operation wording (`MarketErrorText`) for 400/402/403/404/409 and falls back to the exception's now player-facing `Message` for everything else (401, 5xx, unreachable).
- `VersionCheckClientUnityHttp` still returns `null` for any `ServerRequestException` (the documented "treat as offline" contract) but logs transient and non-transient failures differently.
- The editor sync helpers (`ContentCreatorSyncHelper`, `AbilityEditorSyncHelper`) use `System.Net.Http` rather than `SimpleWebClient`, so they call `ServerErrorMessage.From` in the shared `AbilityEditorSyncHelper.DescribeFailure` (PUT/POST and DELETE alike) to get the same body parsing. Because the message now carries body text, a helper that needs to branch on *which* failure it was uses `SendWithStatus` and compares the status code — never `message.Contains("404")`, which a 409 body mentioning "404" would satisfy and, for status conditions, would rewrite the asset's authored id.

Never show `ex.Message` of an arbitrary `Exception` to the player — an `Object reference not set…` line is a bug report, not feedback.

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

- **Wrong key in `GameConfigurationKeys`.** If the key string is not one `SettingsGameConfiguration` answers, `SimpleWebClient`'s base URL is null. Every request fails with "Invalid HttpClient configuration" logged at construction time. Double-check the exact string match.
- **Path leading slash handling.** `SimpleWebClient` strips a leading `/` from the path: `path = path.StartsWith("/") ? path.Substring(1, ...) : path`. This means `/api/v1/npc/ensure` and `api/v1/npc/ensure` are equivalent. Consistency is preferred — the codebase uses the leading slash convention.
- **JSON property name mismatch.** The response deserializes to all defaults without throwing. Add debug logging of `response.DataAsText` in the `after` callback if a response object is unexpectedly empty.
- **Not handling `NotAuthorizedException`.** If `GetAccessTokenAsync` fails to refresh and throws, the caller receives `NotAuthorizedException`. Without a handler, the game will show an unhandled exception. Catch this in top-level handlers and redirect to the login flow.
- **Catching `AsyncHTTPException` or `InternalServerErrorException` for "server down".** Neither is what you get any more: no response is `ServerUnreachableException`, and a 5xx is `InternalServerErrorException` — both `ServerRequestException` with `IsTransient == true`. Catch the base type and check `IsTransient` if you want to offer a retry.
- **Reading `ex.Message` expecting a reason phrase.** `Message` is the server's explanation when it sent one, else a player-facing default. The reason phrase and status are on `StatusCode`; the raw body is on `Body`.
- **Creating a new client implementation for each endpoint.** All endpoints for a domain should be on one client class (e.g., all NPC operations on `NpcClientUnityHttp`). Do not create a separate `NpcEnsureStarterClient` and `NpcGiveCreatureClient`.
- **`CancellationToken` parameter exists on interface but is not passed to `SimpleWebClient` methods.** The current `SimpleWebClient` does not accept `CancellationToken` in its `Get`/`Post` methods. The `ct` parameter on `INpcClient` methods exists for future compatibility. If Best HTTP adds native cancellation support, the base class will be updated. For now, wrap calls in a `Task.WhenAny` if you need timeout behavior.
- **Registering the client before `ITokenManager` is bound.** `TokenManager` is bound before HTTP clients in `LocalDevGameInstaller`. If you add a new client binding before the auth section, its constructor will fail to resolve `ITokenManager`. Keep all client bindings in the HTTP clients section (after auth).

## Related Pages

- [Unity Project Setup](?page=unity/01-project-setup) — `GameSettings` and environment setup, server address keys
- [Dependency Injection](?page=unity/02-dependency-injection) — how clients are registered with `AsSingle()`
- [NPC Interaction](?page=unity/04-npc-interaction) — example of `INpcClient` usage in a world behaviour
- [Auth and Accounts](?page=backend/06-auth-and-accounts) — `ITokenManager` that `SimpleWebClient` depends on
- [Backend Architecture](?page=backend/01-architecture) — the endpoints these clients call
