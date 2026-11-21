# Oaklet Hatch (internal, spoilers)

> **INTERNAL: SPOILERS.** This page gives away the hatch. It is for designers, operators and testers. Nothing in the game, in player-facing text or in a build's readable files may say what the item is or that it becomes Oaklet. Status: merged 2026-11-21, server deployed, shipping in game build v0.2.24 (cr-api #106, cr-api-unity #193, cr-admin-web #46, stacked on the quest-toggles PRs #105, #192, #45). Online, the content (reward spawner, quest, pickup placements) was pushed from the Studio tooling at the v0.2.24 release.

## What the player experiences

1. By Philroe's farm (world cell `World_c0_r3`) there is a large tree (`Prefab_TreeLarge_01` at 1.7 times scale, a landmark bigger than its neighbours). At its base, 6.6 m from the trunk so it clears the collider, lies an ordinary-looking item, a **Heavy Pinecone** ("A big pinecone from under the old tree. Heavier than it looks."). It is a plain Material item: not a key item, stack 99, not tradable, not sellable, no effect.
2. Nothing else happens. No quest marker, journal entry, tracker line, toast or hint appears at any point.
3. The player carries the item. The server counts their steps; once they have walked **5000 steps while carrying it**, the quest completes and auto-claims.
4. A short reveal plays: the pinecone trembles, cracks, bursts, and **Oaklet joins the player** (level 1; to the team, or to storage if the team is full). The pinecone is taken from the bag.

Steps walked without the item in the **backpack** do not count and are not replayed. ("Carrying" means the backpack; the quest's start requirement `HasItem` counts every inventory.) The item's pickup looks like every other item pickup, with the tint its rarity gives it (Uncommon, green: derived from the rule, not seen in play). The quest starts in the same session as the pickup: an auto-grant sweep follows the collect.

## How it is built (nothing is special-cased by name)

| Piece | What | Where it is documented |
|---|---|---|
| Item `item_heavy_pinecone` | Seeded by cr-api migration 21403; pickup definition `item_heavy_pinecone` by 21404 | [Quest System](?page=backend/07-quest-system#migrations) |
| Tree find spot `tree-spot-farm-01` | One data row in the **Act 1** layout (`Act1/story.json`, `Act1Corridor.asset`), which owns cell `World_c0_r3`: a large tree by Philroe's farm with the pickup at its base | [Open World, Tree find spots](?page=unity/37-open-world#tree-find-spots) |
| Reward spawner `hatch-oaklet` | One template: `creature_oaklet`, level 1, Balanced Growth, normal variant, quantity 1; reward-only (not a world spawner) | [Spawner System](?page=backend/03-spawner-system) |
| Quest `quest-heavy-pinecone` | See below | [Quest System](?page=backend/07-quest-system#walk-steps-take-item-and-hidden-quests) |
| Step counting | Server counts steps from the positions it receives | [Server-Counted Steps](?page=backend/31-server-counted-steps) |
| Reveal | Generic: any claim that takes an item and spawns a creature | [Hidden Quests and the Claim Reveal](?page=unity/52-hidden-quests-and-claim-reveal#the-claim-reveal) |

**The quest `quest-heavy-pinecone`** (name "A Heavy Pinecone", shown to operators only): category Bonus (a **side** quest), `areaKey` **`Meadow`** (the same area as the other quests at Philroe's farm, for example Runaway Cargo, so the switch a tester flips for the farm's side quests covers it; the world location's talents area is Village, which is not the quest's area), `isHidden` true, grant mode `AutoWhenAvailable`, reward claim mode `AutoOnCompletion`, not repeatable. Requirement: `HasItem(item_heavy_pinecone)`. One objective: `WalkSteps`, target 5000, carried item `item_heavy_pinecone`. Rewards: `TakeItem(item_heavy_pinecone x1)` then `Creature(hatch-oaklet)`.

Why `AutoWhenAvailable` with a `HasItem` requirement instead of a quest the pickup grants: if the quest is blocked by a toggle when the item is picked up, it simply starts later, when it is unblocked and the player still has the item; and a later spot's item restarts counting for a player who lost the first one.

## How the quest toggles apply

The hatch quest is an ordinary side quest in the area `Meadow` ([Turning quests off](?page=backend/07-quest-system#turning-quests-off-per-quest-and-per-area)):

- With **Meadow side quests off**, or the quest's **Enabled** off, the quest is not offered, the auto-accept is refused quietly, steps do not count, it cannot complete or be claimed. Switching back on resumes from the same step count (steps taken while blocked are not replayed).
- Picking up the item is not a quest action and still works while blocked.
- The main story is not affected by the area switch. Nothing is known to make the main story depend on this quest (the Studios' dependency warnings only see `QuestCompleted` requirements and `CompleteQuest` objectives; this was not separately checked for the hatch quest).
- The Studios and the moderation board show it, marked hidden.

## How to test it quickly

Server and offline rules are covered by tests; the quickest checks are:

1. **Automated.** cr-api `HatchHttpTests` (a Studio-style push, the hatch end to end including species `creature_oaklet`, 409 `quest-item-missing`, the carry condition, the toggles, a hidden round trip, the location PUT shapes), `QuestWalkStepsHatchSqliteTests`, the exhaustive `StepCounter` tests; Unity `HatchOfflineChainTests` (the whole offline chain on SQLite), `HatchClientTests`, `QuestHiddenTests`, `ClaimRevealTests`, `StoryTreeSpotRowTests`.
2. **Capture.** `cr_world_capture_tree_spot --args spot=tree-spot-farm-01,layout=Act1Corridor` writes top, wide and close stills of the tree and the item (pickup orb shown); `cr_hatch_capture <folder>` writes `reveal-NN.png` frames, `reveal-before.png`, `reveal-after.png` and `bag-item.png` (the bag capture goes through the real bag action policy). Captures now exist for the pull requests (tree, item in the bag, hatch reveal). They are stills and a GIF from the editor, not a play session.
3. **By hand, online.** Push order after merging: the item already exists by seed; push spawners (`hatch-oaklet`), then quests, then run `cr_pickup_placements_scan` / `_push`. Pick the item up, then check the operator board (Live Ops, the trainer's quests): the quest shows as hidden with its step count. 5000 steps are 3.75 km of movement (0.75 m per step; at most 7.5 m/s credited and at most 60 s of elapsed time credited per position report, so 450 m or 600 steps per report), so to test the end of the chain quickly lower the objective's target count in a **local, unpushed** copy of the quest, or use the offline chain test.
4. **Toggles.** Switch off Meadow side quests in either Studio, or clear the quest's Enabled, and check that the board shows `blockedReason` and the step count freezes; switch back and check it resumes.

## What was NOT tested

- **No Play-mode run** (before release) of the tree, the pickup, the walk or the reveal (they were checked from captured stills and a GIF, and from tests).
- **No end-to-end run against a live server** before release (no real position stream through the production `PUT /trainer/{id}/location`, no live claim).
- The granter and pickup MonoBehaviours have no dedicated test (from the quest-toggles work).
- The pushed content (quest, spawner, placement) has not been pushed to a server by anyone.

## Decisions as shipped

The owner approved the design and changed nothing, so these shipped as built:

- **The item can be discarded.** It is an ordinary item, so a player can throw it away, and with one spot a player who does cannot finish the quest until another spot exists. Alternatives not taken: the spot gives a new one when the player has none and has not hatched yet, or the item cannot be discarded.
- **The wild pools were removed.** #188 put Oaklet in three wild pools (`a1-shoulder-wild`, `meadow-wild-zone-2`, `meadow-wild-zone-3`); the release removes those three entries (commit `beb27471a`), so the hatch is the only source. Revert that commit to bring wild Oaklets back. See [Spawner System, Oaklet in the early zones](?page=backend/03-spawner-system#oaklet-in-the-early-zones).
- **The quest's area key is `Meadow`.**
- **Old unclaimed quests.** The session-start unclaimed-reward sweep also pays long-completed, unclaimed auto-claim quests on existing saves. Intended.

## Pushes done at release

Online, the item and its pickup definition come from the server migrations, but the reward spawner `hatch-oaklet`, the quest `quest-heavy-pinecone` and the pickup placements have to be pushed after a deploy, in that order (spawners, quests, placements), or the quest, the reward and the pickup do not exist online. For v0.2.24 this was done on 2026-11-21 through the Studio tooling: `hatch-oaklet` synced, `quest-heavy-pinecone` synced (server row version 1, recorded in the asset by cr-api-unity #194), and 268 pickup placements registered (an additive push that never removes). Offline play needs no push.

## Related Pages

- [Server-Counted Steps](?page=backend/31-server-counted-steps), [Quest System](?page=backend/07-quest-system), [Hidden Quests and the Claim Reveal](?page=unity/52-hidden-quests-and-claim-reveal), [Test only the main story](?page=guides/06-test-only-main-story), [AI Content Ledger](?page=content/01-ai-content-ledger)
