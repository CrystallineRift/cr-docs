# Quest Flow Editor

The flow view is the default tab when you open one quest in the web Studio (`/content/quests/:key`, content-write scope). It
lays the quest out in the order a player lives it, left to right, in four columns. The **Form** tab (see
[Quest Editing](04-quest-editing.md)) and the **Advanced** tab (raw JSON) stay; all edit the same quest. For the whole
story at once use the [Quest Story Map](07-quest-story-map.md), which has a button here.

The columns are plain React, not a React Flow canvas, so there are no arrows inside the quest.

## The four columns

1. **How it starts.** Who gives the quest (or "Starts by itself", subtitle "Auto when available"), the requirements as sentences with **Add requirement**
   (a new one defaults to "Quest completed" with the target empty), and the conversations that offer the quest
   (from `GET /api/v1/dialogues/quest-links`, `offers`).
2. **Goals.** One block per objective: the type as a sentence, a target picker, a count, the journal text, and required or
   optional. Add and remove goals here.
3. **Turn in.** Whether the quest is handed in at the giver or completes right away, and the conversations that pay it out.
4. **Rewards.** One block per reward.

Selecting any block opens the **inspector** on the right. It uses the same fields and pickers as the Form tab's quest columns,
with plain labels. Keys are not typed; they come from pickers.

## Goal order is fixed once saved

A goal's `sortOrder` is its identity: players' progress is stored by position. So saved goals cannot be reordered (drag is
disabled, with the tooltip "Order is fixed once saved - players' progress is tracked by position"). A new, unsaved goal is
added at the end, one past the highest number used so far this session. Deleting a goal leaves a gap and keeps the other
goals' numbers. A goal counts as saved when it has an id, or when a save moved the quest's `rowVersion` during this visit.

## Neighbours

- **Comes after** lists the quests this one requires (its `QuestCompleted` requirements).
- **Unlocks next** lists the quests that require this one, **and** the talents gated by it (a talent whose `unlockQuestKey`
  is this quest, found in `GET /api/v1/talents/trees`; there is no separate route). A talent links to the
  [Talent Tree Editor](09-talent-tree-editor.md) with that talent selected.

## Checks and View as player

The same checks as the story map are shown, filtered to this quest. An admin can **View as player**: the quest's status for
that player (counts per goal, "waiting to turn in") comes from the progression read. Without admin the picker does nothing.
See [Player Progression Debugger](08-player-progression-debugger.md).

## Saving and conflicts

The header **Save** (and the inspector) saves the quest through the quests bulk route and reads the new `rowVersion` from
`templates[0]` of the response, then **stays on the page** (quests now stay after save). A 409 opens the conflict dialog:
Compare, Overwrite, Reload, or Recreate if the quest was deleted. See
[Optimistic Concurrency](../backend/28-optimistic-concurrency.md).

## Related

- [Quest Editing](04-quest-editing.md) for the objective, reward and requirement targets.
- [Quest System](../backend/07-quest-system.md) for the data model.
