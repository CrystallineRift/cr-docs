# Oaklet Hatch (internal, spoilers)

> **INTERNAL: SPOILERS.** This page gives away the hatch. It is for designers, operators and testers. Nothing in the game, in player-facing text or in a build's readable files may say what the item is or that it becomes Oaklet. Status: in review: cr-api #106, cr-api-unity #193, cr-admin-web #46, all stacked on the quest-toggles PRs (#105, #192, #45). Not merged, not deployed.

## What the player experiences

1. By Philroe's farm there is a large tree. At its base lies an ordinary-looking item, a **Heavy Pinecone** ("A big pinecone from under the old tree. Heavier than it looks."). It is a plain Material item: not a key item, stack 99, not tradable, not sellable, no effect.
2. Nothing else happens. No quest marker, journal entry, tracker line, toast or hint appears at any point.
3. The player carries the item. The server counts their steps; once they have walked **5000 steps while carrying it**, the quest completes and auto-claims.
4. A short reveal plays: the pinecone trembles, cracks, bursts, and **Oaklet joins the player** (level 1; to the team, or to storage if the team is full). The pinecone is taken from the bag.

Steps walked without the item in the bag do not count and are not replayed.

## How it is built (nothing is special-cased by name)

| Piece | What | Where it is documented |
|---|---|---|
| Item `item_heavy_pinecone` | Seeded by cr-api migration 21403; pickup definition `item_heavy_pinecone` by 21404 | [Quest System](?page=backend/07-quest-system#migrations) |
| Tree find spot `tree-spot-farm-01` | One data row: a large tree by Philroe's farm, world cell `World_c0_r3`, with the pickup at its base | [Open World, Tree find spots](?page=unity/37-open-world#tree-find-spots-in-review) |
| Reward spawner `hatch-oaklet` | One template: `creature_oaklet`, level 1, Balanced Growth, normal variant, quantity 1; reward-only (not a world spawner) | [Spawner System](?page=backend/03-spawner-system) |
| Quest `quest-heavy-pinecone` | See below | [Quest System](?page=backend/07-quest-system#walk-steps-take-item-and-hidden-quests-in-review) |
| Step counting | Server counts steps from the positions it receives | [Server-Counted Steps](?page=backend/31-server-counted-steps) |
| Reveal | Generic: any claim that takes an item and spawns a creature | [Hidden Quests and the Claim Reveal](?page=unity/52-hidden-quests-and-claim-reveal#the-claim-reveal) |

**The quest `quest-heavy-pinecone`** (name "A Heavy Pinecone", shown to operators only): category Bonus (a **side** quest), `areaKey` **`Village`**, `isHidden` true, grant mode `AutoWhenAvailable`, reward claim mode `AutoOnCompletion`, not repeatable. Requirement: `HasItem(item_heavy_pinecone)`. One objective: `WalkSteps`, target 5000, carried item `item_heavy_pinecone`. Rewards: `TakeItem(item_heavy_pinecone x1)` then `Creature(hatch-oaklet)`.

Why `AutoWhenAvailable` with a `HasItem` requirement instead of a quest the pickup grants: if the quest is blocked by a toggle when the item is picked up, it simply starts later, when it is unblocked and the player still has the item; and a later spot's item restarts counting for a player who lost the first one.

## How the quest toggles apply

The hatch quest is an ordinary side quest in the area `Village` ([Turning quests off](?page=backend/07-quest-system#turning-quests-off-per-quest-and-per-area)):

- With **Village side quests off**, or the quest's **Enabled** off, the quest is not offered, the auto-accept is refused quietly, steps do not count, it cannot complete or be claimed. Switching back on resumes from the same step count (steps taken while blocked are not replayed).
- Picking up the item is not a quest action and still works while blocked.
- The main story is not affected by the area switch. Nothing is known to make the main story depend on this quest (the Studios' dependency warnings only see `QuestCompleted` requirements and `CompleteQuest` objectives; this was not separately checked for the hatch quest).
- The Studios and the moderation board show it, marked hidden.

## How to test it quickly

Server and offline rules are covered by tests; the quickest checks are:

1. **Automated.** cr-api `HatchHttpTests` (a Studio-style push, the hatch end to end including species `creature_oaklet`, 409 `quest-item-missing`, the carry condition, the toggles, a hidden round trip, the location PUT shapes), `QuestWalkStepsHatchSqliteTests`, the exhaustive `StepCounter` tests; Unity `HatchOfflineChainTests` (the whole offline chain on SQLite), `HatchClientTests`, `QuestHiddenTests`, `ClaimRevealTests`, `StoryTreeSpotRowTests`.
2. **Capture.** `cr_world_capture_tree_spot --args spot=tree-spot-farm-01` for the tree and item; `cr_hatch_capture <folder>` for the reveal.
3. **By hand, online.** Push order after merging: the item already exists by seed; push spawners (`hatch-oaklet`), then quests, then run `cr_pickup_placements_scan` / `_push`. Pick the item up, then check the operator board (Live Ops, the trainer's quests): the quest shows as hidden with its step count. 5000 steps need at least 3750 m of movement (0.75 m per step, 12 m/s credited at most, at most 60 s of elapsed time credited per position report), so to test the end of the chain quickly lower the objective's target count in a **local, unpushed** copy of the quest, or use the offline chain test.
4. **Toggles.** Switch off Village side quests in either Studio, or clear the quest's Enabled, and check that the board shows `blockedReason` and the step count freezes; switch back and check it resumes.

## What was NOT tested

- **No Play-mode run** of the tree, the pickup, the walk or the reveal (they were checked from captured stills and a GIF, and from tests).
- **No end-to-end run against a live server** (no real position stream through the production `PUT /trainer/{id}/location`, no live claim).
- The granter and pickup MonoBehaviours have no dedicated test (from the quest-toggles work).
- The pushed content (quest, spawner, placement) has not been pushed to a server by anyone.

## Open decision: the wild pools

#188 (merged) put Oaklet in three wild pools (`a1-shoulder-wild`, `meadow-wild-zone-2`, `meadow-wild-zone-3`). To keep the hatch a surprise, cr-api-unity #193 removes those three entries in a **separate, droppable commit**. Until the owner decides, both outcomes are possible; see [Spawner System, Oaklet in the early zones](?page=backend/03-spawner-system#oaklet-in-the-early-zones).

## Related Pages

- [Server-Counted Steps](?page=backend/31-server-counted-steps), [Quest System](?page=backend/07-quest-system), [Hidden Quests and the Claim Reveal](?page=unity/52-hidden-quests-and-claim-reveal), [Test only the main story](?page=guides/06-test-only-main-story), [AI Content Ledger](?page=content/01-ai-content-ledger)
