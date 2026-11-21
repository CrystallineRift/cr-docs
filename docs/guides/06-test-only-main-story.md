# Test Only the Main Story

> Status: in review. The switches are on cr-api PR #105 (server) cr-api-unity #192 (Unity Studio and offline play) and cr-admin-web #45 (online Studio); all open, unmerged. Not merged or deployed. Until then none of the controls below exist on a released build.

## Goal

Play or test just the main story quest line by turning side quests off, without deleting anything, then turn them back on.

## Definitions

- **Main story quest**: a quest whose `category` is `MainStory`, or whose story line is a main act line (`line-act-` and a number, optionally followed by `-something`, for example `line-act-3` or `line-act-3-north`). Every other quest is a **side quest**.
- **A quest's area**: the quest's area key (case does not matter; spaces at the ends are ignored). A quest with no area key is in no area, so no area switch affects it. Give a side quest an area key if you want to switch it off by area.
- **Blocked**: a quest whose own **Enabled** switch is off, or a side quest in an area whose **Side quests enabled** switch is off. The area switch never blocks a main story quest. Only a quest's own Enabled switch can.
- **What blocked does** (the server enforces it): the quest is not offered, cannot be started (an attempt is refused with `409 quest-disabled`), does not progress, and its rewards cannot be claimed. Starting from a dialogue, a location discovery or an operator action is refused the same way.
- **What freezes**: a quest already in progress keeps its place and its counts. Events that happen while it is blocked do not count and are not replayed later. Abandoning still works.
- **Nothing is deleted or reset.** Everything is on by default.

## Option A: switch off side quests per area

1. Open **Crystalline Rift Studio** online (Content -> Story -> **Quest areas**) or the Unity Studio's **Quests** tab, **Area side quests** panel.
2. For each area you want to test, clear **Side quests enabled**. The count line shows how many side and main story quests the area has; the main story ones stay on.
3. Online: Save the area. Unity: press **Push** on the panel (the asset is only edited locally until then).
4. Play. In those areas only the main story quests are offered, started and progressed.

## Option B: switch off single quests

1. Open the quest (online Studio Quests form, or the Unity quest inspector).
2. Clear **Enabled** and save or push. The list shows `OFF` on the quest.
3. This works for any quest, main story included, and does not depend on the area.

## Check it

- Online Studio: the Quests list column **Enabled**, and the Quest areas list, show `OFF`. A side quest in a switched-off area shows a note on its form.
- Unity Studio: quest rows show `OFF` or `OFF (area)`.
- The operator quest board (Live Ops, per player) shows `isEnabled` and `blockedReason` for each quest, including frozen ones in progress.
- An operator **Complete** on a blocked quest is refused (`409 QuestDisabled`); switch it back on first.

## Switch back

Set **Side quests enabled** and **Enabled** back on (same places, same save or Push). Quests that were frozen continue from where they were; quests not yet started are offered again. Pull in the Unity Studio to take the server's current switches.

## Offline play

The offline game runs the same quest rules locally. The Studio's area switches and each quest's Enabled flag are written into the local database when the world starts, so the local quest services block quests the same way. To switch things for offline play, change them in the Unity Studio (the asset is what offline reads); a server push is not needed for that. This is in review (cr-api-unity #192) and has not been run end to end against a live server. The server must be deployed first for the online Studio's area page to work.

## Related Pages

- [Quest System, Turning quests off](?page=backend/07-quest-system#turning-quests-off-per-quest-and-per-area)
- [Quest Editing (online Studio)](?page=admin-web/04-quest-editing#turning-quests-off-in-review)
- [Content Registry, Quest switches in the Studio](?page=unity/08-content-registry#quest-switches-in-the-studio-in-review)
- [Optimistic Concurrency, Quest area settings](?page=backend/28-optimistic-concurrency#quest-area-settings)
