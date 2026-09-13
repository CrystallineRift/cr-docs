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
| `Assets/CR/UI/Common/CreatureTargetPicker.cs` | Modal "who do you want to use this on?" overlay, awaited by the Bag |
| `Assets/CR/UI/Common/UiFocusRecovery.cs` | Re-anchors gamepad focus when a screen loses it |
| `Assets/CR/UI/Common/UiIcon.cs` | The one content-icon loader — see [UI Icons](29-ui-icons.md) |
| `Assets/CR/Core/Data/Client/Interface/ICreatureStatusClient.cs` | Per-creature active status conditions, online/offline routed |
| `Assets/CR/UI/PlayerStorageView.cs` | Storage tab — box grid, Data File panel, team swap modal. Its rules live in the engine-free `CR.UI.Storage.Logic` asmdef; see [Creature Storage](26-creature-storage.md) |
| `Assets/CR/UI/Quests/QuestJournalView.cs` | Quests tab — active + completed quests, objectives, rewards |
| `Assets/CR/UI/Journal/JournalView.cs` | Journal tab — achievements + lifetime stat records |
| `Assets/CR/UI/Logic/` | Engine-free rules (`CR.UI.Logic` asmdef) shared by the above, unit tested |
| `Assets/CR/UI/Resources/PlayerMenuWindow.uxml` | Layout — 6 tabs |
| `Assets/CR/UI/Resources/PlayerMenuWindow.uss` | Stylesheet — window chrome, Team, Storage, Quests, Journal |
| `Assets/CR/UI/Resources/BagScreen.uxml` / `Assets/CR/UI/BagScreen.uss` | Bag layout + stylesheet |

## PlayerMenuWindow

:::tip[Gamepad]
**LB / RB cycle the tabs**, wrapping at both ends. `q` / `e` do the same on a keyboard.

The `NavigateTabsLeft` / `NavigateTabsRight` actions had existed in the asset for some time bound to
nothing — and bound to the **arrow keys**, which `Navigate` already uses for focus movement. Dormant
while nothing listened; the moment a handler existed, one arrow press would have both moved focus
and changed tab. They are now on the shoulder buttons, and the arrows do only what they always
should have.

Tab changes go through the same path a click takes, so per-tab data reloads happen identically for
mouse and pad. Presses are ignored while the menu is hidden — silently changing an unseen tab
surfaces later as the menu "opening on the wrong page".
:::

Injected dependencies:

| Injectable | Used by |
|-----------|---------|
| `ICreatureInventoryService`, `ICreatureDomainService`, `IGrowthProfileDomainService`, `IAbilityDomainService`, `ITrainerDomainService`, `IStatService` | `PlayerTeamView` |
| `ICreatureInventoryService`, `ICreatureDomainService`, `IGrowthProfileDomainService` | `PlayerStorageView` |
| `QuestManager` | `QuestJournalView` |
| `IAchievementDomainService`, `IStatService` | `JournalView` |
| `IGameAssetLoader` (optional) | Icon loading in Team / Bag / Journal, always through `UiIcon.Apply` |
| `ICreatureStatusClient` | `BagScreenHandler` — the target picker's status badges and cure-item rules |
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

### Reordering the team

Team order is `trainer_creature_inventory_items.slot_number` (1–6, **gaps allowed** — a creature sent
to storage leaves its slot empty). The lead is whoever holds the lowest occupied slot, not
necessarily slot 1. The view reads the real slot numbers with
`ICreatureInventoryService.GetTeamSlotsAsync` (same order as `GetTeamAsync`) and never derives them
from list position.

Three controls:

- **Move** — a `Button` on every squad card. Press it to arm that creature (card turns amber, header
  reads *Moving &lt;name&gt; — pick a slot*), then press any other card, its *Swap here* button, or an
  empty slot's *Move here (slot N)* target. Pressing the armed card again (*Cancel*) abandons the
  gesture. Empty slots become `Button`s only while a move is armed.
- **→ Storage** — a `Button` beside Move, on the **picked card only**. One press moves that creature
  off the team and into storage via `MoveToStorageAsync`, then redraws with the selection back on
  the first card (there is no creature left to follow) and a toast naming what moved. No
  confirmation prompt: the storage screen moves it straight back, and a dialog in front of a
  reversible action is a tax on the common case.
- **Make lead** — a `Button` on the featured card, shown only when the selected creature is not
  already the lead. One press swaps it with the lowest occupied slot.

`TeamStorageOption` (engine-free, in `CR.UI.Logic`, NUnit-tested) holds the three rules behind the
Storage button, each for its own reason. It appears **only on the picked card**, because a Send on
all six is six chances to store the wrong creature by mis-tapping for something done rarely — and
tapping a card already means "this one" here. It is **absent while a reorder is armed**, because an
armed card already reads *swap here* end to end, and a second button inside a card that is itself a
button for something else is how a player does what they did not mean. And it is **disabled for the
last creature on the team**, visible but flat grey with the reason on its tooltip, since an action
that looks available and then fails is worse than one that explains itself up front.

That last rule is enforced **on the server as well**, in `MoveToStorageAsync` — see
[Creature Storage → Keeping one on the team](./26-creature-storage.md). The client is not the only
caller and it can be looking at a stale team; the refusal text the player reads always comes from
the server rather than being written a second time in the view.

Both end in `SwapTeamSlotsAsync(trainerId, from, to)`, which is transactional and fires
`OnSlotsSwapped`; `TeamSync` subscribes to that event so the battle swap list shows the new order
without a reload. After the swap the screen re-renders with the selection following the moved
creature (by id, not index) and pad focus on its new card. A refused swap (`Success == false`)
toasts `ErrorMessage` and redraws; nothing is reordered client-side ahead of the database.

The gesture itself is engine-free in `CR.UI.Logic`: `TeamMoveMode` (armed / cancelled / swap state
machine, `Press(slot)` + `Cancel()`) and `TeamSlotLayout` (`EmptySlots(occupied)`,
`MakeLeadSwap(orderedSlots, index)`), both NUnit-tested. The Move button stops `ClickEvent` and
`NavigationSubmitEvent` propagation so one press cannot arm via the button and then cancel via the
activatable card underneath.

#### Why the server swaps through a temporary slot

Online, the swap is `PUT /trainer/{trainerId}/inventory/creature/{inventoryId}/swap`, which calls
`BaseTrainerCreatureInventoryRepository.SwapCreatureSlots`. Both engines run the **same three-step
script inside a transaction**: slot A → `-1`, slot B → A, `-1` → B. A single `UPDATE … CASE` that
exchanges the two values looks cleaner but fails on PostgreSQL whenever **both slots are occupied**:
the partial `UNIQUE INDEX (inventory_id, slot_number) WHERE NOT deleted` (M4006) is checked per row
as the statement runs — only a `DEFERRABLE` constraint waits for statement end — so the first row to
land on the other's slot raises `23505`, which `PostgresGlobalErrorMiddleware` turns into
**409 Conflict**. Moving into an empty slot touches one row and never tripped it, which is why the
bug looked intermittent (`ITrainerCreatureInventoryClient: Failed to swap creature slots: Conflict`).
SQLite already used the three-step path; `NpcCreatureTeamRepository` (`npc_creature_team_storage`,
same index shape from M2002) has the identical fix. Pinned by
`TrainerCreatureInventoryRepositoryTests.SwapCreatureSlots_BothSlotsOccupied_ShouldExchangeSlots`
and the NPC equivalent, both Postgres-container tests.

## Held items

A creature holds up to two items. They can be given and taken back from **either** the Bag tab (pick
an item, press Slot 1 or Slot 2, then pick the creature in the target picker) or the **Team tab**
(pick a creature, use its two slot buttons).

Both go through `IHeldItemRepository`, which routes to the server online and to cr-api's
`IHeldItemService` offline. Neither screen writes a slot or an inventory itself.

:::danger[Fixed: this used to duplicate items]
The offline path wrote the creature's **slot only** — the item was never removed from the bag. After
equipping, you had a copy in the bag *and* a copy on the creature; do it again and the same item was
on two creatures and still in your bag.

The online path did remove it, but as two unguarded writes (`UpdateCreature`, then
`RemoveFromBackpack`), so a failure between them landed in the same place and two simultaneous
equips could overwrite each other's slot — destroying whichever lost.

And online held items were **404ing entirely**: the client called `/held/{slot}` with `PUT` while the
server has always mapped `/held-items/{slot}` with `POST`. That is why the offline bug survived so
long — offline was the only path anybody could exercise.

Both now run through one transaction with a **guarded slot write**: the slot is only written if it
still holds what the caller last read. The item leaves one place and arrives in the other, or
neither happens.
:::

Rules the service enforces, in this order:

| Check | Why it is where it is |
|---|---|
| Item is flagged `HeldByCreature` | Refused before anything leaves the bag |
| Creature belongs to this trainer | Owner-gated like evolution |
| A slot is free (or a swap is allowed) | Checked **before** the bag is touched, so the common refusal costs nothing |
| The trainer owns the item | |
| Guarded slot write | Last, so it is the thing that decides the outcome |

Equipping into an **occupied** slot swaps: the occupant returns to the bag *inside the same
transaction*, after the slot write has been won. Returning it earlier would put it in the bag while
it was still in the slot — the duplication again. A swap that loses the guard returns nothing.

Returning an item stacks onto an existing bag entry rather than adding a second row for the same
item.

The Team tab's picker is filtered to items flagged `HeldByCreature`. Offering the rest and letting
the service refuse would be correct and useless — a menu mostly full of things that do not work is
not a menu.

## Bag tab (`BagScreenHandler`)

Loads the backpack (`IItemInventoryService.GetBackpackAsync`) and one `BaseItem` definition per
distinct item (`IItemDomainService.GetItemAsync`, one catalogue page plus a back-fill call for any
straggler authored past the page limit).

| Control | Behaviour |
|---------|-----------|
| All / Consumables / Key Items / Held Items | Real filtering via `BagItemPolicy.MatchesCategory` |
| Sort | Alphabetical by resolved display name |
| Discard | **Two-press**: first press arms the button (label becomes the confirmation), second commits `RemoveFromBackpackAsync`. Disarmed by selecting another item or switching pocket. |
| Use | Opens the target picker when the item is flagged `TargetsOwnTeam`, then `IItemUseDomainService.UseItemAsync(trainerId, accountId, itemId, targetCreatureId, false, null, null, ct)` |
| Equip (Slot 1 / 2) | Always opens the target picker, then `IHeldItemRepository.EquipHeldItemAsync` — the online/offline routed repository |

Item rows and the detail panel paint the item's icon through
`UiIcon.Apply(element, def.IconAssetKey, displayName, _assetLoader, log)` — `item.icon_asset_key`,
not `AssetKey`, which addresses the item's *prefab*. A slot with no authored icon shows the
two-letter `IconGlyph` placeholder. See [UI Icons](29-ui-icons.md).

### The party strip is gone

The bag used to carry a permanently-resident six-slot creature strip along its bottom edge.
`CreatureSelectorStrip.cs` and the `#bag-creature-strip` element are deleted, and the item list is a
`ScrollView` that takes the height back.

The strip answered the targeting question *before* it was asked. The player picked a creature, then
went looking for an item, and any item that did not apply to that creature simply sat there greyed
out with no explanation — a dead button with no visible cause, on a screen that had no room left for
the item list. `BagItemPolicy.Decide` therefore lost its `hasCreatureSelected` parameter: with the
question asked after the press, visible and pressable are the same thing (`CanUse == ShowUse`,
`CanEquip == ShowEquip` whenever an item is selected).

### Target picker (`CreatureTargetPicker`)

Pressing **Use** on a `TargetsOwnTeam` item — or **Equip** on anything — opens a modal overlay over
`#bag-screen` and awaits it:

1. `BagScreenHandler.BuildCandidatesAsync()` re-reads the team (`GetTeamAsync`), resolves each
   creature's species, and fans the per-creature status lookups out through `Task.WhenAll`. The
   team is **re-read on every press** rather than cached from the last load, because using an item is
   exactly what changes the HP and conditions the cards draw.
2. `CreatureTargetPicker.PickAsync(host, title, candidates, verdict)` builds one `Button` per
   candidate — portrait, name, `Lv n`, an HP meter and a status-badge row — and asks
   `ItemTargetRule.Evaluate(intent, candidate)` once per card.
3. A refused card is **disabled but still shown**, with its reason underneath. "Why can't I use this
   here" is the question a hidden card cannot answer.
4. `PickAsync` completes with the chosen creature id, or `null` on cancel. A cancel means the item was
   never used, so there is nothing for the caller to unwind.
5. The result is spoken through `WorldToast.Show(ItemUseResultText.Describe(result, itemName,
   creatureName))`, and a successful use reloads the bag so quantities and party HP are current.

Every card is a `Button` rather than a focusable `VisualElement`, so gamepad Submit reaches it through
the built-in behaviour instead of a hand-rolled `ClickEvent`/`NavigationSubmitEvent` pair. The picker
lands focus on the first *enabled* card (falling back to Cancel) — an unfocused modal swallows d-pad
input entirely, and focusing a disabled card is the same dead end.

Portraits and status chips are painted by `UiIcon.Apply`. A condition with no authored icon stays a
plain text chip; one with an icon becomes a 14px sprite chip whose tooltip is the condition name —
the decision is `StatusBadge.HasIcon`, in `CR.UI.Logic` so it is unit-tested. See
[UI Icons](29-ui-icons.md).

:::note[One fetch, two facts (`SpeciesInfo`)]
The portrait key and the species name come off the **same** base-creature read.
`BagScreenHandler` caches `Dictionary<Guid, SpeciesInfo>` keyed by `BaseCreatureId` —
`SpeciesInfoAsync` returns `SpeciesInfo.From(baseCreature?.Name, baseCreature?.IconAssetKey)`, and
`DisplayNameFor` / `IconKeyFor` read the two halves back. Reads are deduplicated by species and fanned
out with `Task.WhenAll`, so a team of six Cindris is one call, not six.

This is worth its own type because the bag previously resolved the species purely to read `.Name` and
threw the row away — so every card was built with `null` in the `IconKey` slot even after the icon
column existed. The one call that had the answer had already discarded it.

`SpeciesInfo.From` owns two normalisations so the MonoBehaviour cannot forget them: a row with **no
usable name is no entry at all** (the display-name fallback has to reach the id stub rather than draw
a nameless card), and a **blank icon key becomes `null`** (`""` is an address the loader dutifully
looks up and never finds; `null` is what the slot reads as "draw the placeholder").
:::

Three exits, all funnelled through one idempotent `Complete`:

- **Cancel button**, or `NavigationCancelEvent` (B / Escape) registered on the overlay.
- **A card press**.
- **`DetachFromPanelEvent`** — the bag rebuilds its whole tree on every `RenderInto`, and deactivates
  its GameObject on a context change. Either throws the modal away with the tree it hangs on, and
  without this handler the `TaskCompletionSource` would never complete, leaking the caller's async
  state machine and its captured candidate list for the rest of the session. A detach reads as a
  cancel.

The result is set **before** `RemoveFromHierarchy()`, because that call raises
`DetachFromPanelEvent` synchronously and would otherwise re-enter `Complete` and answer the caller
with a cancel on the very press that succeeded. The `TaskCompletionSource` uses
`RunContinuationsAsynchronously` so the awaiting caller never resumes mid-teardown.

### `ItemTargetRule` — what each item refuses, and why

The rules live in the engine-free `CR.UI.Logic` assembly and are unit-tested without a scene, a
database or a server. The **server enforces the same rules and is the authority**; this exists so the
picker can grey a card out *before* the player commits, rather than letting them spend a potion and
then showing a refusal toast.

`ItemTargetIntent.From(ItemEffectType, effectParametersJson)` reduces the backend effect to the one
question the picker has to ask; `ItemTargetRule.Evaluate` answers it per candidate
(`Assets/CR/UI/Logic/ItemTargetRule.cs`).

| `ItemEffectType` | Intent | Rejected when | Reason shown |
|---|---|---|---|
| `RestoreHp`, `RestoreFullHp` | `Heal` | The creature is fainted (`CurrentHp <= 0`) | `Fainted — use a Revive` |
| | | It is at or above its maximum HP | `HP already full` |
| `ReviveCreature` | `Revive` | The creature is standing | `Not fainted` |
| `CureStatus` | `CureStatus` | None of the named conditions is on the creature | `No <A> or <B> to cure` |
| `CureAllStatus` | `CureAll` | The creature has no active conditions at all | `No status to cure` |
| *(equip flow)* | `Equip` | Never | — |
| Anything else | `Other` | Never | — |

Three deliberate non-refusals:

- **Faint is checked before full.** "HP already full" is technically true of a fainted creature at
  0/0 and would point the player at the wrong item.
- **Unknown HP is never a refusal.** `TargetCandidate.MaxHp == 0` is the single encoding of "this
  creature's stats did not resolve" (`IsHpKnown`), and both `Heal` and `Revive` return `Ok` in that
  case. An earlier version substituted `1` for an unresolved maximum and read a null current HP as
  "full", producing a creature at 1/1 that the rule then refused a potion with "HP already full" —
  refusing on a fact nobody has is the worst of the three options.
- **A `CureStatus` item with no readable condition list cures anything.** That state only arises from
  a malformed or absent parameter blob — an authoring fault — and refusing every target over it would
  make the item look broken. `ItemTargetIntent.From` never throws; it returns the kind with an empty
  list.

Condition matching is **case-insensitive and trimmed**: names are authored twice, once in the item's
effect parameters and once in the status catalogue, and the two spellings drift.

`Equip` is unconditionally allowed, including on a fainted creature — handing an item over to carry
is not a use, and barring it would make a reviving held item impossible to give to the creature that
needs it.

### Toasts

Every use now says what happened. `ItemUseResultText.Describe` reads the server's own
`ItemUseResult` rather than the item's description, in this precedence order:

| Condition | Line |
|---|---|
| `!Success` | `ErrorMessage` verbatim, or `"<item> had no effect."` when the server sent none |
| `CreatureRevived` | `"<creature> was revived!"` |
| `HpRestored > 0` | `"<creature> recovered <n> HP."` |
| `ConditionsCured` non-empty | `"<creature> was cured of <names>."` |
| `LeveledUp` | `"<creature> grew to level up!"` |
| `ExperienceGranted > 0` | `"<creature> gained <n> EXP."` |
| `EvolutionTriggered` | `"<creature> is evolving!"` |
| `StatBoosted` set | `"<creature>'s <stat> rose."` |
| anything else | `"Used <item> on <creature>."`, or `"Used <item>."` when untargeted |

Revive leads even when it also restored HP: coming back is the headline, and the HP line alone would
read as though the creature had been standing the whole time. A refusal prefers the server's sentence
because it is the only text that knows the reason. Equip has its own line,
`"<creature> is holding <item>."`; an `InvalidOperationException` out of `EquipHeldItemAsync` is
toasted verbatim, and any other exception falls back to `"<item> could not be equipped right now."`

Previously a refusal was written to the Unity console and nothing else, so from inside the game a
potion that healed and a potion the server rejected looked identical: the button flashed and the bag
sat there.

### Per-creature status conditions

The picker needs condition *names* (and their icons) to grey out an antidote for a creature that is
not poisoned and say why. The creature row carries only condition ids, and the names live in a
separate catalogue, so `ICreatureStatusClient` is that join behind one interface:

| Binding | Implementation | Source |
|---|---|---|
| `LocalDataSources.CreatureStatus.Online` | `CreatureStatusClientUnityHttp` | `GET api/v1/trainers/{trainerId}/creatures/{creatureId}/status-conditions` off `GameConfigurationKeys.TrainerInventoryServerHttpAddress` |
| `LocalDataSources.CreatureStatus.Offline` | `CreatureStatusSqliteClient` | `IGeneratedCreatureRepository` + the local status catalogue |
| *(default)* | `CreatureStatusOnlineOfflineClient` | the usual connectivity switch |

All three answer `IReadOnlyList<CreatureStatusConditionView>` — `(StatusConditionId, Name,
IconAssetKey, TurnsRemaining)` — and return **empty, never null**, on a failed lookup.
`BagScreenHandler.StatusesForAsync` also swallows and logs: a status lookup failing must not take the
picker down with it, and a card with no badges is worth far more than no card. See
[Item Effects and Status Cures](../backend/19-item-effects.md) for the endpoint's auth and 404
semantics.

### Focus recovery (`UiFocusRecovery`)

A single click on a menu's background clears UI Toolkit focus, and from then on the stick, the d-pad
and Submit all do nothing — the screen looks alive but ignores the controller entirely. UI Toolkit
never restores focus by itself, and setting it once when the screen opens is not enough.

`UiFocusRecovery.Install(root, candidate)` watches `FocusOutEvent` on the screen root plus
`NavigationMoveEvent`/`NavigationSubmitEvent` on the **panel root** (navigation events go to the
focused element, which by definition is not inside this screen when focus is stranded), and
re-anchors a frame later via `root.schedule.Execute`. The decision itself is
`FocusRecoveryPolicy.ShouldRestore(screenVisible, focusIsUsable, hasCandidate)`; "visible" walks
ancestors, because a screen is hidden with `display: none` on its root and the focused button itself
still reports `Flex`.

Two installs are live at once while the picker is open, deliberately:

- The bag installs on `#bag-screen` with `tab-all` as its candidate.
- The picker installs on its own overlay with the first enabled card as its candidate. Without it,
  losing focus inside the modal hands the controller to the bag's candidate — the All tab, *behind*
  the modal, where nothing the player does can reach the question they were just asked.

They cooperate rather than fight: both fire on the same bubbling `FocusOutEvent`, the deeper handler
schedules first, and whichever restores first turns the other into a no-op because `ShouldRestore`
then sees a usable focus.

The panel root outlives every screen on it, so the two navigation callbacks are held in locals and
unregistered by identity: `Install` hooks on `AttachToPanelEvent` and unhooks on
`DetachFromPanelEvent`. Without that, every bag open and every Use press would leak a pair plus the
whole detached tree its closure captures.

### Category and button rules

Both live in `CR.UI.Logic.BagItemPolicy`, translated from the backend definition at the UI boundary
into a `BagItemFacts` (kind + `HeldByCreature` / `UsableOverworld` / `TargetsOwnTeam` flags):

- **Held Items** is wider than `ItemType.Equipment` — an item qualifies if it is equipment **or**
  carries the `HeldByCreature` flag, because content authors express the idea both ways.
- An item whose definition has not loaded yet is `BagItemKind.Unknown` and shows under **All only**.
  Hiding it would make the bag look empty mid-load; guessing a category would file it wrongly.
- **Equip** follows the same wide rule as the Held Items tab: `ItemType.Equipment` **or** the
  `HeldByCreature` flag. **Use** follows the item's kind, not its flags: anything that is not
  equipment and is flagged `UsableOverworld`. A dual-use item such as the heal potion (a consumable
  that is also holdable so it auto-triggers in battle) therefore offers **both** buttons; a capture
  crystal (battle-only consumable) offers neither. A button that does not apply to the item class is
  hidden. There is no longer a third "shown but disabled" state — targeting is asked for after the
  press, so once an item is selected `CanUse == ShowUse` and `CanEquip == ShowEquip`.

> **Data trap (fixed 2026-09-04).** `ItemType.Consumable` is `0` and `Equipment` is `1`. The capture
> crystal, exp-share charm and heal potion seeds (M6007 / M6009 / M6013) wrote `item_type = 1`, so
> every seeded consumable classified as equipment and the bag offered Equip on a Radiant Crystal.
> The seeds now write `0` and `M6019FixSeededConsumableItemType` corrects rows on already-migrated
> databases (Postgres and every Unity SQLite file, including the online caches). The authored
> `ItemDefinition` SO has no item-type field — the seed is the only source of `item_type`, so a new
> seed must copy the enum value from `ItemType.cs`, never guess it.

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
| `ItemTargetIntent` (+ `ItemTargetKind`) | Reduces `ItemEffectType` + its parameter JSON to one targeting question; never throws |
| `ItemTargetRule` (+ `TargetCandidate`, `TargetVerdict`, `StatusBadge`) | Whether one item may be used on one creature, and the sentence when it may not |
| `SpeciesInfo` | The species name + portrait key a card needs, off one fetch; blank name → no entry, blank key → `null` |
| `ItemUseResultText` | The one line the toast shows for an `ItemUseResult` |
| `FocusRecoveryPolicy` | When a stranded screen should re-anchor focus |
| `QuestProgressCalculator` (+ `QuestObjectiveLine`, `QuestProgressSummary`) | Objective roll-up; optional objectives never hold the bar back; zero targets never divide by zero |
| `QuestActionPolicy` (+ `QuestActionAvailability`) | Claim requires `Completed && !RewardsClaimed` |
| `AchievementProgressCalculator` (+ `AchievementProgress`) | Progress toward a threshold; unlock record beats the stat; `Hidden` visibility |
| `StatKeyFormatter` | `battles_won` → "Battles Won", with HP/XP/NPC acronyms preserved |
| `StatRecordPolicy` | Which stat keys are player-facing |
| `ContextScreenRegistry` (+ `UIContext`, `IContextAwareScreen`) | Screen registration and context dispatch behind `UICoordinator` — see below |

**Engine-free, not cr-api-free.** The assembly keeps `noEngineReferences: true` — nothing here
touches a Unity type — but the targeting rules do consume the shipped cr-api model directly:
`ItemTargetIntent` reads `ItemEffectType` and the real `EffectParameterSerializer`, and
`ItemUseResultText` reads `ItemUseResult`. Recreating those in Unity is the failure the project
already banned, and `CR.Game.Model.dll` / `CR.Items.Domain.Services.dll` reference no engine
assembly, so consuming them keeps the assembly engine-free. `BagItemPolicy` still translates at the
boundary via `BagItemFacts`, because tab membership is a UI rule with no backend counterpart.
`CR.UI.Logic.Tests` has `overrideReferences: true` and therefore lists both DLLs explicitly in its
`precompiledReferences`.

### Screens may leave mid-dispatch (`ContextScreenRegistry`)

Screens register with `IUICoordinator` in `OnEnable` and unregister in `OnDisable`. Some of them
react to a context change by deactivating their own GameObject (`BagScreenHandler` does this on
anything but Overworld) — and `OnDisable` runs synchronously, so the screen **unregisters itself
while the coordinator is still dispatching**. `ContextScreenRegistry.SetContext` therefore iterates a
snapshot and skips any screen that left before its turn; a screen registered mid-dispatch was
already synced by `Register()` and is not told twice.

This is not theoretical: with the bag tab visited once (the bag GameObject stays active behind the
closed menu), the next wild encounter's `SetContext(Battle)` threw `Collection was modified` out of
`BattleEvents.RaiseBattleStarted`, and the battle ended `loop_complete` before its first turn. The
rule is pinned by `ContextScreenRegistryTests`.

Two more guards close the same hole from the other sides:

- **The bag is put away with the menu.** `PlayerMenuWindow.Hide()` calls
  `BagScreenHandler.Dismiss()` — silent (no `OnClosed`, which is the *user* closing the bag and
  re-shows the menu), deactivates the bag GameObject and drops its host container. The bag's own
  `OnContextChanged` (anything but Overworld) calls the same `Dismiss()`. A closed menu therefore
  leaves no live context listener behind.
- **A subscriber that throws cannot abort the raiser.** `BattleEvents` dispatches through
  `IsolatedDispatch` — see *Battle System → Static `BattleEvents`*.

## Menu open means the world stops (`PlayerInputGate`)

While the menu is open the camera must not rotate and the trainer must not move: input belongs to
the UI alone. `PlayerInputGate` (on `InputManagement` in `Core.unity`) does this by disabling the
**Player** action map of `CR_GameInput`. The UI map is never touched, so menu navigation always
survives.

Disabling that one map covers everything, including the camera:

- **Movement** — `TrainerMovementController` → `IMovementController` → `MalbersMovementController`
  reads `Player/Move`, `Sprint`, `Jump`.
- **Camera look and zoom** — the Cinemachine rig's `MInputLinkLook` is bound to `Player/Look` and
  `Player/Zoom` (wired by `cr_setup_overworld_camera`). The link subscribes to `canceled` as well
  as `performed`, so a stick still held when the menu opens delivers a zero and the camera stops
  dead instead of drifting on its last value.

The decision itself is `GameplayInputRule.GameplayEnabled(inOverworld, menuOpen, inBattle)` in the
engine-free `CR.UI.Input.Logic` asmdef — gameplay input is live only in the overworld with no menu
and no battle. It is tested there rather than in the scene.

**The signal is a shared `BoolVariable` asset**, `Assets/CR/Content/Defs/Variables/IsMenuOpen.asset`.
`PlayerMenuWindow` and `MerchantShopScreenHandler` set it true while open; the gate subscribes to
`OnValueChanged`. All three must point at the *same* asset — this is a silent failure mode: when
the asset went missing, the scene kept its reference GUID but every field resolved to null, the
menu signalled nothing, and the camera kept rotating behind the panel. The gate logs
`No isMenuOpen BoolVariable assigned` in that case; treat that warning as a broken menu.

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
`.dash-nav-item`, `.bag-item-row`, `.bag-tab`, the bag action buttons, the System buttons,
`.target-picker-card` and `.target-picker-cancel`). Without one, a controller moves an invisible
cursor and the screen reads as frozen. `.target-picker-card:disabled` is styled too (opacity 0.45),
because a refused card is meant to read as a rule rather than a bug.

Buttons use `clicked +=` only. `RegisterCallback<ClickEvent>` is pointer-only, so gamepad Submit on a
focused `Button` would silently do nothing. Plain `VisualElement`s that act as buttons (squad cards)
register **both** `ClickEvent` and `NavigationSubmitEvent`.

### Controls on the Bag and its picker

| Input | Where | Effect |
|---|---|---|
| LB / RB, `q` / `e` | Menu | Cycle tabs (`NavigateTabsLeft` / `NavigateTabsRight` on the UI map) |
| D-pad / stick / arrows | Anywhere | UI Toolkit `Navigate` — focus movement only |
| Submit (A / Enter) | Bag row | Selects the item and refreshes the action buttons |
| Submit (A / Enter) | Use / Equip | Opens the target picker when one is needed |
| Submit (A / Enter) | Picker card | Chooses that creature; disabled cards cannot be submitted |
| Cancel (B / Escape) | Picker | `NavigationCancelEvent` on the overlay — closes it as a cancel |
| `I` / `Escape` / Start | Overworld | `ToggleMenu`; `PlayerMenuWindow.Hide()` also calls `BagScreenHandler.Dismiss()` |

`ToggleMenu` is also bound to Escape, so Escape with the picker open is worth an eyes-on check during
playtest: whichever of the two wins, the picker's `DetachFromPanelEvent` handler completes the await
as a cancel, so no path leaves an item half-used or a modal stranded.

## Notes

- `TeamManagementView` is **not** used by `PlayerMenuWindow`. It is still used by
  `GameDataManagerController` and must not be deleted.
- The System tab's Master Volume / Notifications / Reduced Motion / Language rows are still static
  decoration; Look Sensitivity, Invert X/Y and Combat Speed are real and persist via
  `IGameDataRepository`.
- The `.evo-*` and `.friend-*` rules in `PlayerMenuWindow.uss` are now unused; they are kept so the
  stylesheet stays a superset while those features are unbuilt.
