# Unity — Player Menu UI

## Overview

The player menu is a 6-tab overlay opened from the overworld via the `ToggleMenu` input action. It is
the whole out-of-combat UI: the player's squad, their bag, their quest log, their record, and the
game's settings — all without leaving the world scene.

Tabs: **Team | Bag | Storage | Quests | Journal | System**

Every tab reads real data from domain services. Nothing on Team, Bag, Storage, Quests, or Journal is mocked.

## Files

| File | Purpose |
|------|---------|
| `Assets/CR/UI/PlayerMenuWindow.cs` | MonoBehaviour — owns the UIDocument, tab switching, input wiring, System settings |
| `Assets/CR/UI/PlayerTeamView.cs` | Team tab — trainer summary + creature sheet + squad list |
| `Assets/CR/UI/BagScreenHandler.cs` | Bag tab — backpack, item use, held-item equip (also usable standalone) |
| `Assets/CR/UI/PlayerStorageView.cs` | Storage tab — box grid, Data File panel, team swap modal. Its rules live in the engine-free `CR.UI.Storage.Logic` asmdef; see [Creature Storage](26-creature-storage.md) |
| `Assets/CR/UI/Quests/QuestJournalView.cs` | Quests tab — active + completed quests, objectives, rewards |
| `Assets/CR/UI/Journal/JournalView.cs` | Journal tab — achievements + lifetime stat records |
| `Assets/CR/UI/Logic/` | Engine-free rules (`CR.UI.Logic` asmdef) shared by the above, unit tested |
| `Assets/CR/UI/Resources/PlayerMenuWindow.uxml` | Layout — 6 tabs |
| `Assets/CR/UI/Resources/PlayerMenuWindow.uss` | Stylesheet — window chrome, Team, Storage, Quests, Journal |
| `Assets/CR/UI/Resources/BagScreen.uxml` / `Assets/CR/UI/BagScreen.uss` | Bag layout + stylesheet |

## PlayerMenuWindow

Injected dependencies:

| Injectable | Used by |
|-----------|---------|
| `ICreatureInventoryService`, `ICreatureDomainService`, `IGrowthProfileDomainService`, `IAbilityDomainService`, `ITrainerDomainService`, `IStatService` | `PlayerTeamView` |
| `ICreatureInventoryService`, `ICreatureDomainService`, `IGrowthProfileDomainService` | `PlayerStorageView` |
| `QuestManager` | `QuestJournalView` |
| `IAchievementDomainService`, `IStatService` | `JournalView` |
| `IGameAssetLoader` (optional) | Sprite loading in Team / Bag / Journal |
| `IGameSessionService` | `CurrentTrainerId` / `CurrentAccountId` for every tab |
| `IGameDataRepository` | System tab settings persistence |
| `BagScreenHandler` (serialized) | Bag tab |

### Tab behaviour

Each tab reloads its data every time it is selected — a menu is opened after something changed in the
world, so cached content would be stale more often than not.

| Tab | On select |
|-----|-----------|
| `team-tab` | `PlayerTeamView.RenderAsync(trainerId, teamContent, accountId)` |
| `bag-tab` | `BagScreenHandler.RenderInto(bagContent, trainerId)` |
| `quests-tab` | `QuestJournalView.RenderAsync(questsContent)` |
| `journal-tab` | `JournalView.RenderAsync(journalContent, accountId, trainerId)` |
| `options-tab` | Static; settings are wired once in `Start` |

### BagScreenHandler resolution

The Bag tab renders through a scene-referenced `BagScreenHandler`. `ResolveBagScreenHandler()` falls
back to `FindFirstObjectByType<BagScreenHandler>(FindObjectsInactive.Include)` when the serialized
reference is missing, because a scene that lost it previously left the tab permanently blank behind
nothing but a warning. The check uses `== null`, not `??` — Unity's fake null defeats `??` and `?.`.

## Team tab (`PlayerTeamView`)

Constructor:
`(ICreatureInventoryService, ICreatureDomainService, IGrowthProfileDomainService, IAbilityDomainService, ITrainerDomainService, IStatService, ILogger<PlayerTeamView>, IGameAssetLoader?)`

```csharp
Task RenderAsync(Guid trainerId, VisualElement container, Guid accountId = default, CancellationToken ct = default)
```

Three columns:

- **Sidebar** — the trainer's real name and currency (`ITrainerDomainService.GetTrainerAsync`), their
  trainer level and lifetime totals (`IStatService.GetAllAsync`: `battles_won`,
  `creatures_captured_total`, `quests_completed`), party size, and storage count
  (`GetStorageCountAsync`).
- **Featured card** — the selected creature's sheet: sprite (`BaseCreature.AssetKey`), level and
  element badges, name + species, HP bar (`hp-low` under 50 %, `hp-critical` under 25 %), an
  experience bar toward the next level, a six-cell stat grid (ATK / DEF / SP.ATK / SP.DEF / SPD), and
  its real ability names (`IAbilityDomainService.GetAbilityAsync` per slot).
- **Squad panel** — one card per party creature with its element, name, first two ability names,
  level and HP. Cards are click- and Submit-activatable and swap the featured creature. Unoccupied
  slots render as empty rows so the 6-slot shape is always visible.

**Level comes from `GeneratedCreature.Level`** — the stored source of truth. The growth profile is
used only to size the experience bar (`GetExperienceRequiredForLevelAsync` for the current and next
level); it is never used to recompute the level itself.

> Removed in this pass: the invented "SOLAR / VERDANT / STORM CLASS" labels and fake ability tags,
> the "TACTICAL FOCUS 94 % / SYNERGY BOND 88 %" bars, the whole "Squad Synergy — 82 %, A+ GRADE"
> panel, and the mock Achievements / Evolution Log / Friends sidebar views. Achievements moved to the
> Journal tab with real unlock data; the other two were dropped rather than shown as meaningless
> numbers.

## Bag tab (`BagScreenHandler`)

Loads the backpack (`IItemInventoryService.GetBackpackAsync`), the party
(`ICreatureInventoryService.GetTeamAsync`), and one `BaseItem` definition per distinct item
(`IItemDomainService.GetItemAsync`).

| Control | Behaviour |
|---------|-----------|
| All / Consumables / Key Items / Held Items | Real filtering via `BagItemPolicy.MatchesCategory` |
| Sort | Alphabetical by resolved display name |
| Discard | **Two-press**: first press arms the button (label becomes the confirmation), second commits `RemoveFromBackpackAsync`. Disarmed by selecting another item or switching pocket. |
| Use | `IItemUseDomainService.UseItemAsync(trainerId, accountId, itemId, targetCreatureId, false, null, null, ct)` |
| Equip (Slot 1 / 2) | `IHeldItemRepository.EquipHeldItemAsync` — the online/offline routed repository |
| Creature strip | Party targets; slot 0 is pre-selected so a healing item is usable in one press |

Item rows and the detail panel show the item's sprite when the content author set `AssetKey`.

### Category and button rules

Both live in `CR.UI.Logic.BagItemPolicy`, translated from the backend definition at the UI boundary
into a `BagItemFacts` (kind + `HeldByCreature` / `UsableOverworld` / `TargetsOwnTeam` flags):

- **Held Items** is wider than `ItemType.Equipment` — an item qualifies if it is equipment **or**
  carries the `HeldByCreature` flag, because content authors express the idea both ways.
- An item whose definition has not loaded yet is `BagItemKind.Unknown` and shows under **All only**.
  Hiding it would make the bag look empty mid-load; guessing a category would file it wrongly.
- Equipment is equipped, never used; everything else is a Use candidate only if flagged
  `UsableOverworld`. A button that does not apply to the item class is hidden; a button that applies
  but lacks a target is shown **disabled**, so the player can see what the item is for.

> Previously `FilterItems` returned every item regardless of the selected tab, and the Equip buttons
> were gated on a hardcoded `isEquipment = false` so they could never appear. `UseItemAsync` was also
> called with `trainerId` in the `accountId` slot; it now passes `IGameSessionService.CurrentAccountId`.

## Quests tab (`QuestJournalView`)

Constructor: `(QuestManager, ILogger<QuestJournalView>)`

A segmented **Active / Completed** toggle over a list of quest cards. Each card shows the template's
name and description, a headline progress bar, every objective with its own marker/bar/counter, the
reward chips, and the actions the instance's state allows (Claim Rewards, Abandon).

Abandon is destructive, so it arms on the first press and commits on the second — same pattern as the
bag's Discard.

Data comes from `QuestManager.RefreshActiveQuestsAsync`, `GetCompletedQuestsAsync`, and
`GetTemplateAsync` (templates cached per render). See `docs/backend/07-quest-system.md` §"Reading
Quests from Unity" for why the completed and template reads are answered locally in both modes.

## Journal tab (`JournalView`)

Constructor: `(IAchievementDomainService, IStatService, ILogger<JournalView>, IGameAssetLoader?)`

A segmented **Achievements / Records** toggle.

- **Achievements** — every authored definition with the trainer's live progress. Sorted earned-first,
  then closest-to-earning, so the list always leads with something meaningful, and headed by an
  "n of m earned" tally. `Hidden` definitions are omitted until unlocked.
- **Records** — the trainer's lifetime stat totals, headline keys first
  (`battles_won`, `battles_lost`, captures, defeats, highest level, quests, NPCs, locations, items,
  damage, heals, trainer level, trainer XP) and anything the Stats domain adds later after them,
  alphabetically, with no code change. Generated `creature_level_{guid:N}` keys are filtered out by
  `StatRecordPolicy` — they are bookkeeping for achievement evaluation, and a full storage box would
  bury the real records under dozens of them.

See `docs/backend/15-achievements.md` for how progress is computed and why the unlock record, not the
stat, decides the badge.

## Pure logic (`CR.UI.Logic`)

The rules that are easy to get wrong are kept out of the MonoBehaviours, in the engine-free
`CR.UI.Logic` assembly (`noEngineReferences: true`) with a `Tests/` sibling:

| Type | Rule |
|---|---|
| `BagItemPolicy` (+ `BagCategory`, `BagItemKind`, `BagItemFacts`, `BagActionAvailability`) | Bag tab membership, Use/Equip availability |
| `QuestProgressCalculator` (+ `QuestObjectiveLine`, `QuestProgressSummary`) | Objective roll-up; optional objectives never hold the bar back; zero targets never divide by zero |
| `QuestActionPolicy` (+ `QuestActionAvailability`) | Claim requires `Completed && !RewardsClaimed` |
| `AchievementProgressCalculator` (+ `AchievementProgress`) | Progress toward a threshold; unlock record beats the stat; `Hidden` visibility |
| `StatKeyFormatter` | `battles_won` → "Battles Won", with HP/XP/NPC acronyms preserved |
| `StatRecordPolicy` | Which stat keys are player-facing |

These types deliberately do **not** reference the cr-api enums (`ItemType`, `QuestStatus`, …). The
assembly has no engine and no cr-api references; the view translates at the boundary.

## Input actions (UI action map)

| Action | Effect |
|--------|--------|
| `ToggleMenu` | Opens/closes the menu — bound to `I`, `Escape`, and Gamepad `Start` |
| `CloseMenu` | Closes when visible (currently unbound; Escape toggles instead) |
| `Confirm` | Reserved for future use |

**The live input asset is `Resources/CR_GameInput.inputactions`** — the same asset `PlayerInputGate`,
`TrainerMovementController`, and `NpcInteractionBehaviour` use. `Resources/InputSystem_Actions.inputactions`
is a legacy near-duplicate; do not author new bindings there. `PlayerMenuWindow.ResolveInputActions()`
does not trust the serialized scene reference blindly: it binds from the first asset that actually
contains a `UI/ToggleMenu` action (serialized → `CR_GameInput` → `InputSystem_Actions`) and logs an
error if the scene points at the wrong asset. (A scene mis-wire to `Malbers Inputs` — which has a
`UI` map but no `ToggleMenu` — previously left the menu silently dead in the overworld.)

Input is enabled/disabled by `UICoordinator` via `IContextAwareScreen.OnContextChanged`. The menu only
becomes interactive in `UIContext.Overworld`; `ResolveInputActions` also disables the freshly bound
actions when the current context is not Overworld, so the hotkey is never live on the main menu.

Headless diagnostics (play mode, Unity CLI): `cr_ui_input_dump` reports the coordinator context, the
resolved asset, action/map enabled state, bindings, devices, and EventSystem module; `cr_ui_press_key
--key I` synthesizes a real keyboard press through the Input System to exercise the whole chain.

## Focus and gamepad

UI Toolkit gives no default focus styling, so every interactive class on these screens has a `:focus`
rule (`.quest-section-button`, `.journal-section-button`, `.quest-action-button`, `.squad-card`,
`.dash-nav-item`, `.bag-item-row`, `.bag-tab`, the bag action buttons, the System buttons). Without
one, a controller moves an invisible cursor and the screen reads as frozen.

Buttons use `clicked +=` only. `RegisterCallback<ClickEvent>` is pointer-only, so gamepad Submit on a
focused `Button` would silently do nothing. Plain `VisualElement`s that act as buttons (squad cards)
register **both** `ClickEvent` and `NavigationSubmitEvent`.

## Notes

- `TeamManagementView` is **not** used by `PlayerMenuWindow`. It is still used by
  `GameDataManagerController` and must not be deleted.
- The System tab's Master Volume / Notifications / Reduced Motion / Language rows are still static
  decoration; Look Sensitivity, Invert X/Y and Combat Speed are real and persist via
  `IGameDataRepository`.
- The `.evo-*` and `.friend-*` rules in `PlayerMenuWindow.uss` are now unused; they are kept so the
  stylesheet stays a superset while those features are unbuilt.
