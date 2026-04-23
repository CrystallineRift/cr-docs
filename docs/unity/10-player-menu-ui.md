# Unity — Player Menu UI

## Overview

The player menu is a 4-tab overlay opened from the overworld via the `ToggleMenu` input action. It gives the player access to their team, bag, journal, and options without leaving the world scene.

Tabs: **Team | Bag | Journal | Options**

## Files

| File | Purpose |
|------|---------|
| `Assets/CR/UI/PlayerMenuWindow.cs` | MonoBehaviour — owns the UIDocument, tab switching, input wiring |
| `Assets/CR/UI/PlayerTeamView.cs` | View class — fetches the team and renders CCG-style creature cards |
| `Assets/CR/UI/Resources/PlayerMenuWindow.uxml` | UI layout — 4 tab buttons + 4 content panels |
| `Assets/CR/UI/Resources/PlayerMenuWindow.uss` | Stylesheet — window chrome + creature card styles |

## PlayerMenuWindow

Injected dependencies:

| Injectable | Use |
|-----------|-----|
| `ICreatureInventoryService` | Passed to `PlayerTeamView` |
| `ICreatureDomainService` | Passed to `PlayerTeamView` |
| `IGrowthProfileDomainService` | Passed to `PlayerTeamView` |
| `IItemInventoryService`, `IItemDomainService`, `ITrainerDomainService`, `IAuthRepository` | Passed to `InventoryListView` (bag fallback) |
| `IGameSessionService` | Provides `CurrentTrainerId` for the Team tab |
| `BagScreenHandler` (serialized) | Optional — if assigned, Bag tab opens as an overlay instead of inline |

### Tab indices

| Index | Tab | Behaviour |
|-------|-----|-----------|
| 0 | Team | Calls `PlayerTeamView.RenderAsync` with the current trainer ID |
| 1 | Bag | Hides the menu and calls `BagScreenHandler.Show`; on close, returns to Team tab (index 0) |
| 2 | Journal | Shows a placeholder label |
| 3 | Options | Shows the GDM button and Quit to Main Menu button |

Tab navigation wraps at 4 (`% 4`) via `NavigateTabsLeft` / `NavigateTabsRight` input actions.

## PlayerTeamView

Constructor: `(ICreatureInventoryService, ICreatureDomainService, IGrowthProfileDomainService, ILogger<PlayerTeamView>)`

Public API:

```csharp
Task RenderAsync(Guid trainerId, VisualElement container)
```

Clears `container`, fetches `GetTeamAsync(trainerId)`, and renders up to 6 creature cards. Empty slots are filled with placeholder cards to always show 6 rows.

### Creature card layout

```
[ icon 48x48 ]  [ Name            ]  [ Lv. X ]
                [ species (gray)  ]
                [ ████░░░ HP: X/Y ]
```

- Display name uses `GivenName` if set, else `BaseCreature.Name`.
- Species label only appears when `GivenName` differs from the species name.
- Level is resolved via `IGrowthProfileDomainService.GetLevelFromExperienceAsync`. Shown as "Lv. ?" if `GrowthProfileId == Guid.Empty`.
- HP bar fill colour: green by default, `hp-low` class when < 50 %, `hp-critical` class when < 25 %.
- `BaseHitPoints == 0` falls back to `HitPoints` as the max HP.

### CSS classes

| Class | Applied to |
|-------|-----------|
| `.creature-card` | Card root `VisualElement` |
| `.creature-card-empty` | Added to empty-slot cards in addition to `.creature-card` |
| `.creature-card-icon` | 48 × 48 circular placeholder |
| `.creature-card-info` | Centre column |
| `.creature-card-name` | Name label |
| `.creature-card-species` | Species sub-label (conditional) |
| `.creature-card-hp-row` | HP row container |
| `.creature-card-hp-track` | HP bar background |
| `.creature-card-hp-fill` | HP bar fill — also gets `.hp-low` / `.hp-critical` |
| `.creature-card-hp-text` | "HP: X/Y" label |
| `.creature-card-level` | "Lv. X" label |
| `.creature-card-empty-label` | Centred label inside empty slots |

## Input actions (UI action map)

| Action | Effect |
|--------|--------|
| `ToggleMenu` | Opens/closes the menu |
| `CloseMenu` | Closes when visible |
| `NavigateTabsLeft` | Previous tab (wraps) |
| `NavigateTabsRight` | Next tab (wraps) |
| `Confirm` | Reserved for future use |

Input is enabled/disabled by `UICoordinator` via `IContextAwareScreen.OnContextChanged`. The menu only becomes interactive in `UIContext.Overworld`.

## Notes

- `TeamManagementView` is **not** used by `PlayerMenuWindow`. It is still used by `GameDataManagerController` and must not be deleted.
- The GDM and Quit buttons live inside `options-content` in the UXML.
