# Creature Storage & Team Exchange

The player menu's **Storage** tab: a paged box grid, a Data File panel for the selected creature,
and a modal for exchanging it with a team member.

## Where the rules live

`Assets/CR/UI/Storage/Logic/` is an engine-free asmdef — no `UnityEngine`, no cr-api reference. It
owns every decision the screen makes:

| Type | Decides |
|---|---|
| `StorageBrowser` | which creatures a box holds, how many boxes exist, which element chips to offer, whether a swap is allowed |
| `StorageBox` | one page: its slots (padded with nulls), occupancy, capacity, whether paging is possible |
| `StorageEntry` / `TeamMemberSummary` | the flattened shape the grid and the swap modal draw |
| `SwapEligibility` | allowed, or refused with a player-facing reason |
| `AbilityRosterBuilder` | which of a creature's progression entries read as learned, level-locked or quest-locked — and what the player is allowed to see of each |
| `AbilityRosterEntry` / `AbilityRosterSource` / `AbilityRosterState` | the roster row the Data File draws, and the flattened progression entry it came from |

`PlayerStorageView` does layout and nothing else. That split is why 50 tests for this screen run
outside the Editor in a few milliseconds, rather than needing play mode.

## Decisions the tests pin down

**An out-of-range box index is clamped, not rejected.** The box count shrinks whenever a filter
narrows the list or a creature leaves storage. A player sitting on box 4 of 4 must land on the new
last box, not on an exception or an empty grid.

**Exactly `BoxSize` creatures is one box.** Off-by-one here produces a permanently empty second box
that the player can page into.

**Only elements actually present get a chip.** A chip that filters to nothing is a dead control.

**Name sorting is ordinal**, not culture-aware, so the same save pages identically on every machine.

**The last creature able to battle cannot be sent to storage.** Allowing it strands the player, and
the failure surfaces much later as "nothing happens when I walk into grass" rather than at the
moment of the mistake. A *fainted* member can always be swapped out — including when the entire team
has fainted, or a wipe would be unrecoverable.

Refusals travel with the disabled card. A greyed-out slot with no explanation reads as a bug;
"Ignis Fang is your last creature able to battle" reads as a rule.

## The swap is one transaction

`ICreatureInventoryService.SwapTeamAndStorageAsync` — **not** `MoveToStorage` followed by
`MoveToTeam`. Those are two transactions, so a failure between them leaves the team a creature short
with no way to tell which half landed. They also cannot express the common case at all: on a full
team the incoming creature has nowhere to go until the outgoing one has left.

Inside the transaction the order is both removals, then both adds. Two details matter:

- **The outgoing creature's slot is read before anything moves**, and the incoming creature is
  placed into it. Picking the next free slot instead would silently reshuffle the player's battle
  order on every swap.
- **Removals precede adds.** That ordering is what makes a full team work at all.

Both creatures are verified to be where the caller claims *before* the transaction opens, so a stale
UI asks for something impossible and gets a refusal rather than a half-applied write.

`TeamStorageSwapResult` is its own type because `InventorySwapResult` describes two slots inside a
single inventory and carries one `InventoryId`. This operation spans two.

## Gamepad

Slots and swap cards are `Button`s, not clickable `VisualElement`s. `Button` is focusable and its
`clicked` fires for gamepad Submit; a `RegisterCallback<ClickEvent>` handler is mouse-only and would
leave the whole grid dead to a controller. The modal focuses its first *enabled* card on open — an
unfocused modal swallows d-pad input entirely. Every interactive class has a `:focus` rule.

## Grid shape

A box is `BoxColumns` x `BoxRows` = **6 x 4 = 24** slots, and `.storage-grid` is pinned to six slots
wide plus a little slack (`6 x (108 + 8) = 696px`, set to `704px`).

Pinning matters. Left to wrap on whatever width was available, the grid fitted a trailing column
only partly — which reads as a clipped card, not a column. The width and `BoxColumns` have to move
together, and a test asserts `BoxSize` stays a whole number of rows so no box ever ends on a ragged
part-row.

The slack matters too. The grid was first pinned to the *exact* sum (`4 x 116 = 464px`), and under
a fractional UI scale the rounded slot widths overran it by a pixel, so the last column wrapped: a
4-wide box rendered as 3 columns and 8 rows, with the bottom rows cut off below the panel. A few
pixels of slack absorb the rounding and are far too small to admit an extra slot. The reshape to
six wide also uses the empty right half of the browser and keeps all four rows of a box above the
fold.

## After a swap: follow the creature

The view reloads both lists rather than patching them by hand. The swap moved rows in two
inventories, and a hand-patched view is exactly how a UI starts disagreeing with the database.

Reloading is not enough on its own. The outgoing creature lands in whichever storage slot the
incoming one vacated, which is an arbitrary hole in the middle of a box of cards that mostly
look alike. Left there with the selection cleared, a correct swap reads to the player as losing the
creature — reported once as *"the level 7 from my team seems to have disappeared"* when the row was
in fact sitting in storage exactly where it belonged.

So the view follows it:

1. Select the outgoing creature, so the Data File names it.
2. Page to its box via `StorageBrowser.BoxIndexOf(entries, id, filter, sort)`, which answers under
   the *current* filter and sort rather than assuming storage order.
3. If `BoxIndexOf` returns `-1` the active element chip hides the creature — clear the chip and ask
   again, rather than paging to a box it is not on. This is the one path that can make a stored
   creature genuinely invisible.
4. Confirm in words: *"Cindris moved to storage — Box 01."*

`BoxIndexOf` returning `-1` for hidden and `-1` for absent is deliberate: both mean "the grid will
not draw it", which is the only thing the caller acts on.

## The Data File's ability roster

The Data File lists the selected creature's **whole progression roster**, not just the four moves in
its slots. A player deciding whether to train a creature is really asking what it becomes, and the
four-slot view answers only what it is.

Each row is one entry of the creature's `ability_progression_set`, in one of three states:

| State | Shown as | When |
|---|---|---|
| `Learned` | ability name + `Lv N` (the entry's level) | the ability's id sits in one of the four slot columns |
| `LevelLocked` | ability name + `Lv N` | not known, and no gate is hiding it — the level is still ahead, or the move was replaced |
| `QuestLocked` | `???` + `Complete: <quest name>` | not known, and gated on a quest this trainer has not completed |

The masking is `AbilityRosterBuilder`'s decision, not the view's. A rule about what the player is
allowed to know that only exists inside a layout method is a rule nothing can test — so the builder
returns the string to print, and `PlayerStorageView` picks a USS class and nothing else.

### The rules mirror the backend exactly

The client roster and the server's grant must agree, or the player is told to finish a quest that
grants nothing, or shown a name for something they can never use. So `AbilityRosterBuilder` follows
[`AbilityUnlockGate.IsUnlocked`](../backend/04-creature-generation.md#quest-gated-abilities) to the
letter:

- **A null or blank gate is not a gate.** Empty is the pre-M5019 behaviour every ordinary entry keeps.
- **An unreadable completion set fails closed.** `completedQuestKeys: null` reads as "nothing
  completed" — every gate stays shut. `PlayerStorageView` returns empty on a failed quest read for
  the same reason: a missing reward is visible to the player, a phantom one is a broken promise.
- **Keys compare case-insensitively and trimmed.** Content keys travel through YAML, SQLite and JSON;
  a gate must not fail over capitalisation.
- **An already-known ability is `Learned` regardless of its gate** — a creature caught holding a
  gated move is never told to go earn what it has.
- **One row per ability, best state first.** The same ability legitimately appears twice in a set (a
  gated early route and an ungated later one). An ungated route defeats its gated duplicate, exactly
  as `CanLearnAbilityAsync` short-circuits the quest check.

Rows sort by level, then slot — across states, so the roster reads as a timeline rather than three
groups.

### Where the data comes from

| Piece | Source |
|---|---|
| entries | `IAbilityProgressionSetEntryRepository.GetActiveAbilityProgressionSetEntriesAsync(creature.AbilityProgressionSetId)` |
| known ability ids | `GeneratedCreature.First/Second/Third/FourthAbilityId` |
| ability names | `IAbilityDomainService.GetAbilityAsync` |
| completed quest keys | `QuestManager.GetCompletedQuestContentKeysAsync` |
| gate quest names | `IQuestTemplateRepository.GetByContentKeyAsync`, falling back to the content key |

All four are `[Inject(Optional = true)]` on `PlayerMenuWindow`: without them the Abilities block is
simply absent, rather than the whole Storage tab failing to build over one section of one panel.

**Nothing queries from a layout pass.** `Redraw()` runs on every selection, chip and page change.
The roster is cached per creature and computed once per `RenderAsync` — including when it comes back
empty *or throws*, so a creature whose roster cannot be read shows an empty block once instead of
re-querying forever. Completed quest keys are read once per load and cleared on reload, because a
claim between two openings can have taught a stored creature something.

USS lives in `PlayerMenuWindow.uss`: `.storage-datafile-ability` plus `--learned`, `--locked` and
`--quest` modifiers. No inline styles.

## Authoring a gate, and keeping it through sync

The gate is authored on `AbilityProgressionSetConfig` → entry → **Unlock Quest**, which maps to
`ability_progression_set_entry.unlock_quest_content_key` (migration **M5019**) and to
`AbilityProgressionSetEntry.UnlockQuestContentKey` in `CR.Game.Model`. Empty here is `NULL` there.

The inspector field is a **dropdown of authored `QuestDefinition` content keys**
(`ContentPicker.Quests()`), never a text box: the value is a content key the server matches exactly,
and a typo produces an entry that reads as authored and can never unlock.

Three-way parity — SO ↔ SQLite ↔ server — needs the column in **every** writer, and two local ones
were dropping it:

| Writer | Path |
|---|---|
| `LocalAbilityLibrarySyncClient.SyncProgressionSetAsync` | offline "push" — SO straight into local SQLite |
| `ContentSyncWriter.WriteProgressionSetsAsync` | online content sync — server rows into the local cache |

Both reconcile by `(level, ability_slot)` and write **only what they can see differs**. Selecting
the row without its gate made a changed gate compare equal, so the writer reported "same ability at
same slot/level — no-op" and the gate never landed: the ability then unlocked offline at its level
with no quest completed. Both now `SELECT`, `INSERT` and `UPDATE` the column, and treat a changed
gate as a change.

Two details these writers get right and a new one must too:

- **An unset gate is `NULL`, never `""`.** Readers test for null to mean "not gated"; an empty
  string is a gate naming a quest that cannot exist, and the entry would never unlock.
- **The gate rides every push payload.** `/api/v1/ability-progression/sets/sync` reconciles by
  `(level, slot)` and rewrites the row from the payload, so an *omitted* gate is an *erased* gate,
  not an unchanged one. `AbilityEditorSyncHelper.SyncProgressionSet` (Content Studio) and
  `AbilityLibrarySyncHttpClient` both send it.

> Content Studio's progression **pull** still applies top-level set fields only — entries are a
> manual update. `ServerProgressionEntryDto` now carries `unlockQuestContentKey`, so an entry-level
> pull has the field the day someone writes one.

## Telling the player it happened

Claiming a quest whose reward is an `Ability` grants the move server-side —
`ICreatureProgressionService.ApplyQuestUnlocksAsync`, reported back on
`QuestClaimResult.AbilityUnlockedCreatureIds`. Nothing in the world otherwise announces it: the move
just appears in a menu the player may not open for an hour.

So `QuestManager.ClaimRewardsAsync` re-broadcasts it as `OnAbilitiesUnlocked(IReadOnlyList<Guid>)`,
and `AchievementToastPresenter` (which hosts every toast source, despite the name) shows
**"New ability learned!"**. One toast per claim, not per creature — a quest that unlocks a move for a
whole team would otherwise queue six identical toasts. *Which* creature learned *what* is the Data
File's job.

## Gotcha: the service ships in a DLL

`SwapTeamAndStorageAsync` lives in `CR.Game.Domain.Services.dll`. Unity cannot see a new domain
method until `cr-api/Convenience/CR.Game.Compat/build-packages.sh` has run — the symptom is
`CS1061: 'ICreatureInventoryService' does not contain a definition for ...` against source that is
plainly correct.

## Reordering within the team

Swapping two *team* slots is `SwapTeamSlotsAsync(trainerId, slot1, slot2)` — one transaction, and
the target may be an empty slot (SQLite does it in three UPDATEs through a −1 holding slot;
Postgres in one `UPDATE … FROM`). Because slots have gaps, callers read the real numbers with
`GetTeamSlotsAsync` (`TeamSlotEntry { SlotNumber, CreatureId }`, same order as `GetTeamAsync`)
rather than assuming `index + 1`. The Team tab's Move / Make lead controls are the consumer — see
[Player Menu UI](10-player-menu-ui.md#reordering-the-team).

## Keeping one on the team

`MoveToStorageAsync(trainerId, creatureId)` refuses when the creature is the **only** one on the
team: *"That is your last creature — keep at least one on your team."* An empty team is not a quiet
state — the world carries on and the next encounter trigger opens a battle with nobody to send out —
and `TeamRemovalFailureReason` had named `LastCreatureInTeam` since long before anything checked for
it.

Two details worth keeping:

- It counts **occupied slots** (`GetTeamSlotsAsync`), not `GetTeamAsync`. That one resolves every
  creature row and drops the ones it cannot read, so a single unreadable row would under-count the
  team and wave through the exact move the guard exists to stop.
- The refusal **refuses**: it returns before the transaction opens, and a test asserts neither
  inventory is touched. A rule that produces a message while the move still happens is worse than no
  rule.

The client hides the affordance for a last creature too (see
[Player Menu UI](10-player-menu-ui.md#reordering-the-team)), but the client is not the only caller
and the server is where the rule actually lives.

## Related

- [Battle Extensions](24-battle-extensions.md) — the same pure-logic-in-an-asmdef pattern
- [Merchant Shop UI](18-merchant-shop.md)
- [Creature Generation → Quest-gated abilities](../backend/04-creature-generation.md#quest-gated-abilities) — the gate the roster mirrors
- [Quest System → Ability rewards](../backend/07-quest-system.md) — where the retroactive unlock is triggered
- [Content Sync](27-content-sync.md) — `ContentSyncWriter` and the rest of the online content path
