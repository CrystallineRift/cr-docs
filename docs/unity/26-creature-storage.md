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

`PlayerStorageView` does layout and nothing else. That split is why 31 tests for this screen run
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

A box is `BoxColumns` x `BoxRows` = **4 x 6 = 24** slots, and `.storage-grid` is pinned to a width of
exactly four slots (`4 x (108 + 8) = 464px`).

Pinning matters. Left to wrap on whatever width was available, the grid fitted a fifth column only
partly — which reads as a clipped card, not a column. The width and `BoxColumns` have to move
together, and a test asserts `BoxSize` stays a whole number of rows so no box ever ends on a ragged
part-row.

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

## Gotcha: the service ships in a DLL

`SwapTeamAndStorageAsync` lives in `CR.Game.Domain.Services.dll`. Unity cannot see a new domain
method until `cr-api/Convenience/CR.Game.Compat/build-packages.sh` has run — the symptom is
`CS1061: 'ICreatureInventoryService' does not contain a definition for ...` against source that is
plainly correct.

## Related

- [Battle Extensions](24-battle-extensions.md) — the same pure-logic-in-an-asmdef pattern
- [Merchant Shop UI](18-merchant-shop.md)
