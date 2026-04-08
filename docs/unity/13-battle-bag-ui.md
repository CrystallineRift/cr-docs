# Battle Bag Panel

This page documents the battle bag UI panel that displays items during battles and handles item usage.

## Overview

The Battle Bag Panel is an overlay UI that appears during battles when the player presses the Bag button. It shows all usable battle items and allows the player to select targets for those items.

## UI Structure

```
┌─────────────────────────────────────────────────┐
│ ← Back      Bag                    ✕           │  Header
├──────────────────┬──────────────────────────────┤
│                  │ Select Target                 │
│  Item List       ├──────────────────────────────┤
│  - Potion        │ [Party Slot 1]               │
│  - Poke Ball     │ [Party Slot 2]               │
│  - Capture       │ [Party Slot 3]               │
│    Crystal       │ ...                          │
│                  │ ─────────────────────────────│
│                  │ Wild Creature (opponent)     │  Opponent target
├──────────────────┴──────────────────────────────┤
│                    [Use Item] [Cancel]          │  Footer
└─────────────────────────────────────────────────┘
```

## Components

### BattleBagPanelHandler

The `BattleBagPanelHandler` MonoBehaviour manages the panel:

**Location:** `Assets/CR/UI/Battle/BattleBagPanelHandler.cs`

**Responsibilities:**
- Load and display usable battle items
- Cache item usage flags for filtering
- Handle item selection and target selection
- Wire up confirm/cancel actions
- Display capture crystal visual indicators

**Zenject Injection:**
```csharp
[Zenject.Inject]
public void Init(
    IBattleCoordinator battleCoordinator,
    IItemUseRepository itemUseRepository,
    IItemInventoryService itemInventoryService,
    IItemDomainService itemDomainService,
    ICreatureInventoryService creatureInventoryService,
    ILogger<BattleBagPanelHandler> logger,
    CR.UI.IUICoordinator coordinator)
```

### BattleHUD

The panel is opened from `BattleHUD` via the Bag button:

```csharp
// In BattleHUD
var bagPanel = FindObjectOfType<BattleBagPanelHandler>();
bagPanel.Open(trainerId, playerCreatureId, battleId, roundNumber);
```

## Item Display Logic

### Item Filtering

Items are filtered to show only those usable in battle:

```csharp
private bool IsUsableInBattle(ItemInventoryEntry entry)
{
    if (entry.Quantity <= 0) return false;
    if (!_itemFlagsCache.TryGetValue(entry.ItemId, out var flags)) return true;
    return flags.HasFlag(ItemUsageFlags.UsableInBattle);
}
```

### Item Selection Flow

1. **Player clicks an item row** → `OnItemRowClicked()`
2. **Row is highlighted** with `.bag-item-row--selected`
3. **Opponent target** is shown if item has `TargetsOpponent` flag
4. **Capture crystals** show tier info (Standard/Fine/Radiant)
5. **Confirm button** is enabled when both item and target are selected

### Capture Crystal Visuals

Capture crystals are distinguished by:

1. **Blue left border** - CSS class `.bag-item-row--capture-crystal`
2. **Crystal indicator** - Blue bar on the left side (4px wide)
3. **Effect text** - Shows tier name and max catch percentage

Example item row text:
- `capture_crystal_standard (Standard, 95%)`
- `capture_crystal_fine (Fine, 100%)`

## Data Model

### ItemUsageFlags

Controls where and how items can be used. Battle items need `UsableInBattle`.

```csharp
[Flags]
public enum ItemUsageFlags : short
{
    None             = 0,
    UsableInBattle   = 1,
    UsableOverworld  = 2,
    TargetsOwnTeam   = 4,
    TargetsOpponent  = 8,
    HeldByCreature   = 16,
    MultiTarget      = 32,
    CaptureCrystal   = 64,  // New flag for capture items
}
```

### ItemEffectType

Defines what an item does when used. Capture crystals use:

```csharp
public enum ItemEffectType : short
{
    None             = 0,
    // ... other effects
    CaptureCreature  = 11,
}
```

### Effect Parameter Classes (`CR.Game.Model.Items.EffectParameters`)

Each `ItemEffectType` with runtime data has a corresponding typed params class. These are stored as JSON in the `EffectParametersJson` column and deserialized via `EffectParameterSerializer` (Newtonsoft.Json, camelCase keys, `Stat` enum alias support).

| Class | Fields | EffectType |
|---|---|---|
| `RestoreHpParams` | `Amount: int`, `Percent: bool` | RestoreHp |
| `ReviveCreatureParams` | `PercentHp: int` | ReviveCreature |
| `BoostStatTempParams` | `ImpactedStat: Stat`, `Stages: int` | BoostStatTemp |
| `BoostStatPermParams` | `ImpactedStat: Stat`, `Calculation: Calculation`, `Amount: int` | BoostStatPerm |
| `CureStatusParams` | `Conditions: List<string>` | CureStatus |
| `GrantExperienceParams` | `Amount: int` | GrantExperience |
| `TriggerEvolutionParams` | `TargetBaseCreatureId: Guid?` | TriggerEvolution |
| `HeldStatBoostParams` | `ImpactedStat: Stat`, `PercentBonus: double` | HeldStatBoost |
| `HeldDamageReduceParams` | `PercentReduction: double` | HeldDamageReduce |
| `HeldTypeBoostParams` | `ElementType: ElementType`, `PercentBonus: double` | HeldTypeBoost |
| `HeldStatusImmuneParams` | `Conditions: List<string>` | HeldStatusImmune |
| `HeldRegenHpParams` | `PercentPerTurn: double` | HeldRegenHp |
| `OnConditionAppliedTriggerParams` | `Conditions: List<string>` | (trigger) |
| `OnStatStageThresholdTriggerParams` | `ImpactedStat: Stat`, `Threshold: int`, `Direction: string` | (trigger) |

**`StatEnumConverter`** maps legacy JSON aliases on read: `"HP"`, `"hp"`, `"hitpoints"` → `Stat.HealthPoints`; `"spa"` → `Stat.SpecialAttack`; `"spd"` → `Stat.SpecialDefense`. Writes canonical enum names going forward.

**`ItemDefinitionEditor`** uses structured fields for each `EffectType` — no raw JSON TextArea. Enum dropdowns are generated from `Enum.GetNames(typeof(Stat))` etc. Condition names for `CureStatus`/`HeldStatusImmune` are fetched from `GET /ability/status_conditions`.

## User Interactions

### Selecting a Capture Crystal

When a capture crystal is selected:

1. The opponent target panel becomes visible
2. The effect text shows the crystal tier
3. Player must select either:
   - A party member (for items that target own team)
   - The opponent (for capture crystals and opponent-targeting items)

### Confirming Item Use

The `bag-confirm-button` is enabled only when:
- An item is selected
- A valid target is selected

Clicking the button calls:

```csharp
var request = new ItemUseRequest(
    targetCreatureId,
    targetIsOpponent,
    currentBattleId,
    currentRoundNumber);

var result = await _itemUseRepository.UseItemAsync(
    trainerId, itemId, request);
```

### Capture Success

On successful capture:

1. `BattleEvents.RaiseCreatureCaptured(capturedCreatureId, "")` is raised
2. `BattleCoordinator.EndBattle(null, "capture")` is called
3. Battle ends immediately
4. Captured creature is added to trainer's storage

## Event Flow

```
Player clicks Bag button
        ↓
BattleHUD opens BattleBagPanel
        ↓
Panel loads items + party creatures
        ↓
Player selects item
        ↓
OnItemRowClicked()
        ↓
Show/hide opponent target based on flags
        ↓
Player selects target
        ↓
OnConfirmClicked()
        ↓
Call UseItemAsync on backend
        ↓
BattleEvents.RaiseCreatureCaptured (if captured)
        ↓
End battle
        ↓
Close panel
```

## USS Styles

Key styles for the panel:

```css
/* Panel container */
.battle-bag-panel {
    position: absolute;
    background-color: rgba(10, 14, 26, 0.96);
    border: 1px solid rgba(80, 140, 220, 0.6);
    border-radius: 8px;
}

/* Item row selected */
.bag-item-row--selected {
    background-color: rgba(40, 80, 160, 0.8);
    border-color: rgba(100, 170, 255, 0.7);
}

/* Capture crystal indicator */
.bag-crystal-indicator {
    width: 4px;
    background-color: rgb(80, 160, 255);
}
```

## Related Documentation

- [Battle System](unity/07-battle-system.md)
- [Capture Mechanic](unity/14-capture-mechanic.md)
