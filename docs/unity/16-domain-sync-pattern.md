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
| `BattleSync` | Battle scene | — (push-only via events) | `BattleEvents.*` |
| `TeamSync` | World | `IReadOnlyList<GeneratedCreature> Team` | `ICreatureInventoryService.OnTeamUpdated/Added/Removed` |
| `InventorySync` | World | `IReadOnlyList<ItemInventoryEntry> Inventory` | `IItemInventoryService.OnBackpackUpdated/Added/Removed` |

### BattleSync

`Assets/CR/Game/Battle/BattleSync.cs` — subscribes to the static `BattleEvents` bus and writes HP/turn data into Obvious.Soap SOAP variables. No Zenject injection needed.

Inspector fields (all required):

| Field | Type | Purpose |
|-------|------|---------|
| `_playerHp` | `IntVariable` | Player current HP |
| `_playerHpMax` | `IntVariable` | Player max HP |
| `_enemyHp` | `IntVariable` | Enemy current HP |
| `_enemyHpMax` | `IntVariable` | Enemy max HP |
| `_isPlayerTurn` | `BoolVariable` | True when it is the player's turn |

`RefreshAsync` is a no-op — all state is pushed via events. `Clear()` resets all variables to zero/false.

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
