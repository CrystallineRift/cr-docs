# Capture Mechanic

This page documents the capture crystal system for wild creatures in battles.

## Overview

Capture crystals are special items used during wild battles to catch wild creatures. When used, the crystal has a chance to permanently catch the wild creature — it joins the trainer's team when a slot is free, otherwise it goes to storage.

### Capture Levels

There are four tiers of capture crystals, each with a different capture modifier:

| Tier | ID | Modifier | Base Value | Description |
|------|----|----------|------------|-------------|
| Shard Crystal | `capture_crystal_shard` | 0.8× | 80 | Low capture rate |
| Capture Crystal | `capture_crystal_standard` | 1.0× | 100 | Standard catch rate |
| Fine Crystal | `capture_crystal_fine` | 1.5× | 150 | Higher chance of capture |
| Radiant Crystal | `capture_crystal_radiant` | 2.0× | 200 | Greatly increases capture rate |

The **capture modifier** scales the base catch probability:
- Shard Crystal: 80% of standard
- Standard Crystal: 100% (baseline)
- Fine Crystal: 150% of standard
- Radiant Crystal: 200% of standard

## Capture Formula

The capture success chance is calculated as:

```
base_chance = (maxHp - currentHp) / maxHp × capture_modifier
capture_chance = clamp(base_chance, 0.05, 0.95)
```

Where:
- `maxHp` = creature's base maximum HP
- `currentHp` = creature's current HP at the time of capture attempt
- `capture_modifier` = item's `CaptureModifier` value
- The result is clamped between 5% and 95%

### Examples

| Creature HP | Modifier | Calculation | Result |
|-------------|----------|-------------|--------|
| 100/100 HP | 1.0× (Standard) | `(100-100)/100 × 1.0 = 0.0` | **5%** (clamped minimum) |
| 50/100 HP | 1.0× (Standard) | `(100-50)/100 × 1.0 = 0.5` | **50%** |
| 20/100 HP | 1.5× (Fine) | `(100-20)/100 × 1.5 = 1.2` | **95%** (clamped maximum) |
| 10/100 HP | 2.0× (Radiant) | `(100-10)/100 × 2.0 = 1.8` | **95%** (clamped maximum) |
| Fainted (0 HP) | Any | Backend blocks capture | **Fail** |

### Key Rules

1. **Cannot capture fainted creatures** - If `currentHp <= 0`, the capture attempt fails immediately
2. **Cannot capture enemy creatures** - Only wild creatures can be captured. In a trainer battle the crystal is refused *before* anything is spent — see [Refused in trainer battles](#refused-in-trainer-battles).
3. **Maximum 95% chance** - Even at low HP with high modifiers, the chance caps at 95%
4. **Minimum 5% chance** - Even at full health with high modifiers, there's always a small chance
5. **Crystals are consumed on use** - Both successful and failed captures use the crystal

## Backend Implementation

### Data Model

The `item` table includes the `capture_modifier` column:

```sql
-- Migration: M6006AddCaptureModifierToItem
ALTER TABLE item ADD COLUMN capture_modifier REAL DEFAULT 0;
```

Items with `effect_type = 11` (CaptureCreature) use this modifier.

### Item Usage Flow

1. **Validation** (`ItemUseDomainService.ValidateItemUseAsync`)
   - Item must be `UsableInBattle`
   - Target must be the opposing wild creature
   - Item must not be a held item

2. **Capture Attempt** (`CaptureCreatureHandler.ApplyAsync`)
   - Loads wild creature's current HP from battle state
   - Calculates capture chance using the formula above
   - Rolls against the chance
   - On success: reassigns creature ownership, then places it via
     `ICreatureInventoryService.AddToTeamOrStorageAsync` — team if a slot is free
     (next free slot, max 6), storage otherwise. `InventoryAddResult.AddedToTeam`
     reports where it went. The offline mirror (`OfflineItemUseService`) uses the
     same method, so online and offline placement behave identically.

### REST Endpoint

```http
POST /api/v1/trainers/{trainerId}/items/{itemId:guid}/use
Content-Type: application/json

{
  "targetCreatureId": "uuid-of-wild-creature",
  "targetIsOpponent": true,
  "battleId": "uuid-of-battle",
  "roundNumber": 3
}
```

**Response on success:**
```json
{
  "success": true,
  "creatureCaptured": true,
  "capturedCreatureId": "uuid-of-captured-creature"
}
```

**Response on fail:**
```json
{
  "success": true,
  "creatureCaptured": false,
  "errorMessage": "Capture attempt failed."
}
```

**Response on validation failure:**
```json
{
  "success": false,
  "errorMessage": "Capture Crystals can only be used during a wild battle."
}
```

## Refused in trainer battles

A trainer's creature can never be captured, so throwing a crystal at one would cost the crystal
*and* the turn for nothing. Both ends refuse the throw before anything is consumed.

**Server.** `ItemUseDomainService.UseItemAsync` calls `IsCaptureCrystal(item)` — true when
`EffectType == CaptureCreature` **or** the `CaptureCrystal` usage flag is set (seeded crystals carry
`UsableInBattle | TargetsOpponent` = 9 and *not* the flag, so the effect type is the reliable tell).
When the battle's other trainer is not `BattleDomainService.WildTrainerId` the use fails with
`"Capture Crystals cannot be used in a trainer battle."` regardless of how the client flagged the
target, and `ItemEndpoints` returns it as **400** `{ "message": ... }`. Nothing is removed from the
bag and the round is not consumed. Pinned by the "Capture crystals" tests in
`ItemUseDomainServiceTests`.

**Client.** `CR.Game.Battle.Logic.CaptureCrystalRule` (engine-free, `Game/Battle/Logic`) owns the
same decision:

| Member | Role |
|---|---|
| `IsCaptureCrystal(effectIsCapture, hasCaptureFlag)` | mirrors the server tell |
| `IsTrainerBattle(kindIsNpcTrainer, battleType, trainerBattleType)` | `BattleSession.Kind == NpcTrainer` first, then a case-insensitive `BattleTypes.Trainer` match; the legacy `"ONEvONE"` type string is *not* a trainer tell |
| `Refusal(isCaptureCrystal, isTrainerBattle)` | `null` when allowed, else `TrainerBattleRefusal` = "Capture Crystals can't be used in a trainer battle!" |

`BattleBagPanelHandler` tracks `IsTrainerBattle` from `IBattleCoordinator.OnBattleStarted` /
`OnBattleEnded`, stamps `BattleBagItem.BlockedReason` on every crystal row while it is true, and in
`ExecuteUseAsync` raises `BattleEvents.ItemUseRefused(reason)` and returns before the capture VFX or
the server call. Should a refusal still come back from the server (a 400 `BadRequestException`, or
`ItemUseResult.Success == false`), the same event carries the server's message. `BattleHUD` greys a
blocked row with `cmd-item-row--disabled` — still focusable, so choosing it logs the reason instead
of spending the item — and `OnItemUseRefused` appends the message to the battle log. Wild battles
are untouched; a battle whose kind is unknown is left to the server so a stale flag never blocks a
legitimate throw. Tests: `Game/Battle/Logic/Tests/CaptureCrystalRuleTests`.

## Unity Client Integration

### Battle Bag Panel

The `BattleBagPanelHandler` displays capture crystals with visual indicators:

- **Blue left border** indicates a capture crystal item
- **Effect preview** shows tier name (Standard/Fine/Radiant)
- **Opponent target** is automatically shown when a capture crystal is selected
- **Greyed row + log line** in a trainer battle (`BlockedReason`, see above)

### Item Definition

In Unity, capture crystals use the `ItemDefinition` ScriptableObject:

```csharp
[System.Serializable]
public class ItemDefinition : ContentDefinition
{
    public ItemEffectType EffectType;
    public ItemUsageFlags UsageFlags;
    public float CaptureModifier;  // 0.8, 1.0, 1.5, or 2.0
    // ... other fields
}
```

### Visual Indicators

```css
/* USS styles for capture crystals */
.bag-item-row--capture-crystal {
    border-color: rgba(100, 150, 255, 0.5);
    background-color: rgba(25, 35, 55, 0.75);
}

.bag-crystal-indicator {
    width: 4px;
    height: 100%;
    background-color: rgb(80, 160, 255);
    margin-right: 6px;
}
```

### Battle Events

When a capture succeeds, the system raises:

```csharp
BattleEvents.RaiseCreatureCaptured(capturedCreatureId, "");
```

The `BattleCoordinator` then ends the battle with reason `"capture"`.

## Offline Support

Offline (local SQLite) battles roll **identical odds** to the server:

- The pure formula lives in `CR.Game.Domain.Services/Implementation/Item/CaptureChanceCalculator.cs`
  (shipped to Unity in the DLL package) and is used by both the server
  `CaptureCreatureHandler` and the Unity `OfflineItemUseService`
  (`Assets/CR/Game/Battle/Offline/OfflineItemUseService.cs`).
- The offline `CaptureCreature` case mirrors the server handler: wild-battle /
  opponent / fainted validations, ownership reassignment
  (`CurrentTrainerId`, `FirstCaughtByTrainerId`, `CaptureDate`), and
  `ICreatureInventoryService.AddToStorageAsync`.

### Opponent target resolution

Clients may use a capture crystal against "the opponent" without knowing its
creature id (`targetCreatureId == Guid.Empty`). Both the server handler and the
offline service resolve the wild side's active creature from the battle record
(`Trainer1/2ActiveCreatureId` on the side whose trainer is the well-known
`BattleDomainService.WildTrainerId`). The `BattleHUD` additionally passes its
tracked opponent id through `BattleBagPanelHandler.PrepareAsync/Open`, so the
empty-target path is only a fallback.

## Migration History

| Migration | Description |
|-----------|-------------|
| M6006AddCaptureModifierToItem | Added `capture_modifier` column to `item` table |
| M6007SeedCaptureCrystals | Seeded the four capture crystal tiers |

## Related Documentation

- [Battle System](unity/07-battle-system.md)
- [Battle Bag Panel](unity/13-battle-bag-ui.md)
- [Item System](backend/09-item-system.md)
