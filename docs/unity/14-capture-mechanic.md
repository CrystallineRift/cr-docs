# Capture Mechanic

This page documents the capture crystal system for wild creatures in battles.

## Overview

Capture crystals are special items used during wild battles to catch wild creatures. When used, the crystal has a chance to permanently catch the wild creature — it joins the trainer's team when a slot is free, otherwise it goes to storage.

### Capture Levels

There are four tiers of capture items, each with a different capture modifier. Players see them as
**Summoning Shards** (M6023, live 2026-10-08); the content keys kept the `capture_crystal_*` names, and the
code still says "capture crystal" (`CaptureCrystalRule`, `IsCaptureCrystal`).

| Tier (display name) | Content key | Modifier | Base Value | Description |
|------|----|----------|------------|-------------|
| Rough Summoning Shard | `capture_crystal_shard` | 0.8× | 80 | Low summoning rate |
| Summoning Shard | `capture_crystal_standard` | 1.0× | 100 | Standard summoning rate |
| Fine Summoning Shard | `capture_crystal_fine` | 1.5× | 150 | Higher chance of summoning |
| Radiant Summoning Shard | `capture_crystal_radiant` | 2.0× | 200 | Greatly increases summoning rate |

The **capture modifier** scales the base catch probability:
- Rough Summoning Shard: 80% of standard
- Summoning Shard: 100% (baseline)
- Fine Summoning Shard: 150% of standard
- Radiant Summoning Shard: 200% of standard

The names, descriptions and the refusal messages below are display copy, listed as AI drafts in the
[AI content ledger](?page=content/01-ai-content-ledger). Clients key off the `ItemErrorCodes` value
(`code` in the 400 body), never the message text.

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
5. **Crystals are consumed on use** - Both successful and failed captures use the crystal, **unless
   a talent saves it**: on a failed roll, the trainer's `CrystalSaveChance` talent modifier (0-50%,
   [Talents §6.2](?page=backend/25-talents#effects-consumers)) rolls with the same `ICaptureRoll`; a
   save sets `ItemUseResult.ItemRetained = true` and `ItemUseDomainService` refunds the item already
   taken under the claim-before-pay ordering (no change to that ordering — the client sees "Your
   crystal survived" as presentation only, never a client-decided outcome)

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

2. **Capture Attempt** (`CaptureCreatureHandler.ApplyAsync` → shared `CaptureAttemptService.AttemptAsync`)
   - Loads wild creature's current HP from battle state
   - Calculates capture chance using the formula above
   - Rolls against the chance
   - On success: places the creature **before** claiming ownership, then claims it, then awards
     capture XP. See the shared implementation below.

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
  "errorMessage": "Summoning Shards can only be used during a wild battle."
}
```

The handler's refusals, each with its `ItemErrorCodes` value: `item-capture-wild-battle-only`
("Summoning Shards can only be used during a wild battle."), `item-capture-must-target-opponent`
("Summoning Shards must target the opposing wild creature."), `item-capture-wrong-target` ("Summoning
Shards can only be used on the wild creature you are battling."), and from `CaptureAttemptService`
`item-capture-wild-only` ("Summoning Shards can only be used on wild creatures.").

## Refused in trainer battles

A trainer's creature can never be captured, so throwing a crystal at one would cost the crystal
*and* the turn for nothing. Both ends refuse the throw before anything is consumed.

**Server.** `ItemUseDomainService.UseItemAsync` calls `IsCaptureCrystal(item)` — true when
`EffectType == CaptureCreature` **or** the `CaptureCrystal` usage flag is set (seeded crystals carry
`UsableInBattle | TargetsOpponent` = 9 and *not* the flag, so the effect type is the reliable tell).
When the battle's other trainer is not `BattleDomainService.WildTrainerId` the use fails with
`"Summoning Shards cannot be used in a trainer battle."` (`ItemErrorCodes.CaptureNotInTrainerBattle`,
`item-capture-not-in-trainer-battle`) regardless of how the client flagged the target, and `ItemEndpoints`
returns it as **400** `{ "code": ..., "message": ... }`. Nothing is removed from the
bag and the round is not consumed. Pinned by the "Capture crystals" tests in
`ItemUseDomainServiceTests`.

**Client.** `CR.Game.Battle.Logic.CaptureCrystalRule` (engine-free, `Game/Battle/Logic`) owns the
same decision:

| Member | Role |
|---|---|
| `IsCaptureCrystal(effectIsCapture, hasCaptureFlag)` | mirrors the server tell |
| `IsTrainerBattle(kindIsNpcTrainer, battleType, trainerBattleType)` | `BattleSession.Kind == NpcTrainer` first, then a case-insensitive `BattleTypes.Trainer` match; the legacy `"ONEvONE"` type string is *not* a trainer tell |
| `Refusal(isCaptureCrystal, isTrainerBattle)` | `null` when allowed, else `TrainerBattleRefusal` = "Summoning Shards can't be used in a trainer battle!" |

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

Offline (local SQLite) battles roll **identical odds** to the server, because both modes run **one**
implementation, `CaptureAttemptService` (`CR.Game.Domain.Services`, shipped to Unity in the DLL
package): wild + not fainted → chance
`clamp((max−cur)/max × crystal × trainerMultiplier, 0.05, 0.95)` → roll → place on team/storage (a
full storage fails the capture and the crystal is not consumed) → claim ownership
(`CurrentTrainerId`, `FirstCaughtByTrainerId`, `CaptureDate`) → capture XP (+ first-of-species). The
server's `CaptureCreatureHandler` resolves the wild target from the battle record and delegates to
it; Unity's `OfflineItemUseService`
(`Assets/CR/Game/Battle/Offline/OfflineItemUseService.cs`) delegates the same way — there is no
separate offline capture logic to drift out of sync. `ItemUseResult.TrainerProgress` carries the XP
result (see [Trainer Progression](?page=backend/22-trainer-progression) /
[Trainer Progression in Unity](?page=unity/34-trainer-progression)).

Placing **before** claiming ownership matters: a capture whose storage is full leaves the creature
still wild rather than owned-but-unlisted, so the throw can be retried cleanly instead of stranding
the creature.

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
| M6023RenameCaptureCrystalsToSummoningShards | Renamed the four tiers to Summoning Shards (names and descriptions; content keys and ids unchanged). Each UPDATE fires only while the row still carries the M6007 name, so a Studio-authored name is never overwritten. Both engines. Live 2026-10-08 (cr-api PR #68) |

## Related Documentation

- [Battle System](unity/07-battle-system.md)
- [Battle Bag Panel](unity/13-battle-bag-ui.md)
- [Item System](backend/09-item-system.md)
- [Talents](?page=backend/25-talents) — `CrystalSaveChance`, `CaptureChancePercent`, `CaptureXpPercent`
- [Trainer Progression](?page=backend/22-trainer-progression) — capture XP and first-of-species bonus
- [Trainer Progression in Unity](?page=unity/34-trainer-progression) — offline capture bindings

## Capture CAS (A2, 2026-09-27)

`CaptureAttemptService` claims the creature with `ICreatureCaptureClaim.TryClaimFromWildAsync` (wild → trainer, only while still
wild) **before** placing it; a lost claim is a failure with no XP, and a failed placement returns the creature to the wild.
Offline binds the claim to the player-data `GeneratedCreatureRepository` (`ServerAuthorityBindingsExtensions`). Online, the server
also requires the throw to target the active wild creature of the caller's own live wild battle.

## Capture progress (server-authority phase B)

`CaptureAttemptService` emits `CreatureCaptured` (species content key) after the ownership transfer and the
capture XP; the item-use response carries it in `ItemUseResult.Progress`, and `OnlineOfflineItemDomainService`
applies it through `QuestManager.ApplyServerProgress` in both modes. The battle bag no longer reports captures,
and a capture ends the battle **without** counting as a battle win (`BattleEndReason.Capture`).

## The guaranteed throw (Bond Trial, #7 capture missions)

A talent-granted mission pool (see [Capture Missions](?page=backend/capture-missions)) can complete
mid-battle and arm a **guaranteed capture**: `CaptureAttemptService.IsGuaranteedAsync` checks the six
conditions in that page's §6.5 (the battle is Active, the thrower is Trainer1, the opponent is the
wild sentinel, the target is the wild's own active creature, and `battle.guaranteed_capture_ready` is
set) and, when they all hold, sets `chance = 1.0f` — bypassing `CalculateChance` and the clamp above
entirely, but still rolled through the same `_roll.Next() <= chance` comparison, so the roll seam
itself is untouched. The flag clears only after a committed capture
(`ClearGuaranteedCaptureAsync`); a storage-full capture still commits, so it clears the flag too. A
refused throw (wrong target, ended battle, trainer battle) never touches the flag.

This is display-only from the client's side: Unity never computes the chance itself, so there is
nothing for it to fake. `BattleBagPanelHandler` tracks `BattleEvents.CaptureReady` (raised by
`BattleMissionConductor` on the mission's completion and again on every later
`ActionOutcome.GuaranteedCaptureReady = true`) and swaps the crystal row's percentage for "Sure catch"
through the pure `CaptureChanceLabel.For(chance, captureReady)`
(`Assets/CR/Game/Battle/Logic/CaptureChanceLabel.cs`). `BattleHUD` shows a persistent "Capture ready"
badge for the same event, cleared alongside the rest of the mission UI on battle start/close. See
[Battle Extensions](?page=unity/24-battle-extensions) for the mission-pool wiring and
[Battle Bag Panel](?page=unity/13-battle-bag-ui) for the label itself.
