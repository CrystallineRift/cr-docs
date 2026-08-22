# Domain Sync Pattern

The **IDomainSync** pattern caches domain service data into plain C# properties on world-scoped MonoBehaviours, so UI components read instantly from memory instead of issuing async service calls on every open.

## Interface

```csharp
// Assets/CR/Game/World/IDomainSync.cs
public interface IDomainSync
{
    Task RefreshAsync(CancellationToken ct = default);
    void Clear();
}
```

## Implementations

| Class | Scope | Caches | Events Subscribed |
|-------|-------|--------|-------------------|
| `TeamSync` | World | `IReadOnlyList<GeneratedCreature> Team` | `ICreatureInventoryService.OnTeamUpdated/Added/Removed` |
| `InventorySync` | World | `IReadOnlyList<ItemInventoryEntry> Inventory` | `IItemInventoryService.OnBackpackUpdated/Added/Removed` |


### TeamSync

`Assets/CR/Game/World/Behaviours/TeamSync.cs` — world-scoped, implements both `IWorldInitializable` and `IDomainSync`.

- **`Awake`**: `WorldRegistry.Register(this)` (order -10 so it registers before `GameInitializer` at order 50)
- **`InitializeAsync`**: stores `TrainerId`, subscribes to team events, calls `RefreshAsync`
- **`RefreshAsync`**: calls `ICreatureInventoryService.GetTeamAsync` and stores result in `Team`
- **`Clear`**: resets `Team` to empty array

### InventorySync

`Assets/CR/Game/World/Behaviours/InventorySync.cs` — identical pattern to TeamSync but for backpack.

- Reads up to 200 items (configurable via `BackpackOffset`/`BackpackLimit` constants)
- Property: `IReadOnlyList<ItemInventoryEntry> Inventory`

## Scene Setup

1. Add a GameObject to the world scene (e.g. `WorldSyncBehaviours`).
2. Add both `TeamSync` and `InventorySync` components to it.
3. Zenject resolves them via `FromComponentInHierarchy()` — no additional wiring needed.

## Consuming Sync Caches

```csharp
// Example: reading from TeamSync in a UI component
[Zenject.Inject]
public void Init(TeamSync teamSync, InventorySync inventorySync, ...)
{
    _teamSync      = teamSync;
    _inventorySync = inventorySync;
}

private void OnBagOpened()
{
    var items = _inventorySync.Inventory;  // instant — no await
    var team  = _teamSync.Team;
    // ... render immediately
}
```

## Background Refresh

When a service event fires (item added, team changed), `SafeRefresh()` runs `RefreshAsync` on the background. Any error is logged; the stale cache remains valid until the next successful refresh.

After a write operation (e.g. item use), call `_ = _inventorySync.RefreshAsync()` to proactively update the cache without waiting for the event.

## Zenject Bindings

`LocalDevGameInstaller.cs` binds both world-scoped sync components:

```csharp
Container.Bind<CR.Game.World.TeamSync>().FromComponentInHierarchy().AsSingle();
Container.Bind<CR.Game.World.InventorySync>().FromComponentInHierarchy().AsSingle();
```

Both components must be present in the scene before `InstallBindings` runs, or Zenject will throw.

## Every domain routes online/offline

A domain is only finished when it has all four pieces. Missing any one of them produces a system
that works in exactly one mode and looks fine in the other:

| Piece | Lives in | Missing it means |
|---|---|---|
| Backend service + REST endpoints | `cr-api/<Domain>/CR.<Domain>.Service.REST` | The client has nowhere to send data |
| Unity HTTP client | `Assets/CR/<Domain>/*ClientUnityHttp.cs` | Online mode silently reads and writes locally |
| Unity SQLite repository | `CR.<Domain>.Data.Sqlite`, bound with a `LocalDataSources` id | No offline play |
| OnlineOffline router | `Assets/CR/<Domain>/Repository/*OnlineOfflineRepository.cs` | Callers have to know which mode they are in |

Routers take their offline half by id — `[Inject(Id = LocalDataSources.Stat.Offline)]` — and read
`GameConfigurationKeys.IsPlayingOnline` fresh on every call, so a mode switch mid-session takes
effect immediately rather than at the next scene load.

### Which address key to use

Use `GameConfigurationKeys.GameServerHttpAddress` for any `/api/v1/...` route. The domain-prefixed
keys (`CreatureServerHttpAddress` and friends) carry a path segment of their own, so combining one
with an `/api/v1` path produces a 404 that looks like a missing endpoint rather than a wrong base URL.

### Writes go to both, reads prefer the server

For player state — stats, achievement unlocks — the router writes **local first, then the server**.
Local is the copy the UI reads and the offline evaluator checks, so it must not wait on the network;
and a failed server write is logged rather than thrown, because losing a player's progress event is
worse for them than a gap in our telemetry is for us. Server writes are idempotent so a replay is safe.

Reads prefer the server and fall back to local on any failure, which keeps a player who drops
connection mid-session from watching their totals disappear.

:::caution
A stubbed client is worse than no client. Stats shipped with an `IStatClient` that called
`GET /api/v1/stats` — a route that did not exist — through `stat_server_http_address`, a key absent
from `game_config.yaml`. It was bound in DI and had no callers, so nothing ever failed and nothing
ever worked. When adding a client, verify the route answers and the config key resolves.
:::

### The routing decision is one tested class

`SyncRouter` in `Assets/CR/Core/Sync/Logic` holds the read and write policy, and every router
delegates to it. It was extracted because each repository had been making the same three judgement
calls by hand — which source to read, what to do when the server is unreachable, whether a write
goes to one place or two — and the hand-written copies had drifted: some fell back on failure, some
threw.

It takes connectivity as a **value**, not a service, and that is the point. A repository that reads
the flag once at construction keeps calling a server the player has already disconnected from; taking
it per call makes a mode switch effective on the very next operation. There is a test for exactly
that (`ModeSwitch_IsHonouredOnTheVeryNextCall`).

The assembly is `noEngineReferences: true`, so the whole policy runs in a plain test process with no
database, no server and no Unity — the offline path can be proven without either half of the system
being present.

## Tests

| Suite | Covers |
|---|---|
| `CR.Core.Sync.Logic.Tests` (Unity, EditMode) | Route selection, fallback-on-failure, write ordering, mode switching, null guards |
| `CR.Stats.Domain.Services.Test` | Stat endpoints: validation before the service is touched, history clamping, each write route calling its own operator |
| `CR.Achievements.Domain.Services.Test` | Unlock endpoint: first unlock vs replay, id validation, repository failure |
| `CR.Quests.Domain.Services.Test` | Completed-quests endpoint: results, empty list, rejected identifiers, service failure |

The write-operator tests are worth keeping: increment, max and set are not interchangeable, and a
route wired to the wrong one would pass a smoke test while quietly overwriting running totals with
deltas.
