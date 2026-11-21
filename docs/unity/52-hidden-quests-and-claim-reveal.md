# Hidden Quests and the Claim Reveal

> Status: in review: cr-api-unity #193 (`feat/oaklet-hatch`, stacked on the quest-toggles PR #192), on top of cr-api #106. Not merged. Not run end to end in Play mode or against a live server; see [What was not tested](#what-was-not-tested). First user: the hidden hatch quest, see [Oaklet Hatch (internal, spoilers)](?page=guides/07-oaklet-hatch-internal).

Three generic client pieces that the server building blocks need ([Quest System](?page=backend/07-quest-system#walk-steps-take-item-and-hidden-quests-in-review), [Server-Counted Steps](?page=backend/31-server-counted-steps)). The client never decides anything about a quest: it reads the authority's answer, and shows or does not show.

## What a hidden quest hides

A quest template with `isHidden` runs like any other (offered, auto-accepted, progressed, claimed, blocked by the toggles). The client shows the player nothing about it:

| Surface | How it skips a hidden quest |
|---|---|
| Quest journal (active and completed) | The template lookup is `Hidden`; `QuestTemplateVisibility.ToLookup` is the one place a template becomes the lookup every quest UI uses |
| HUD tracker | Same lookup; no tracker line |
| Helper marker and beam | `QuestServiceHelperTargetExtensions` skips a hidden quest: no marker, no beam |
| "New quest" toast | `QuestManager` does not announce a hidden template |
| Objective progress and completion banners, HUD counter, feedback manifest (sounds, banners) | `QuestStateBridge` raises nothing for a hidden quest's events |
| "Quest Complete" / return-to-giver card | `QuestRewardDispatcher` shows no toast for a hidden quest |
| Per-area "{Area} Quests" achievements | The Studio leaves hidden quests out when it generates them (`AreaAchievementQuestInputs`) |
| Wording | The `WalkSteps` objective has the neutral text "Go for a walk" so a non-hidden quest that uses it still reads sensibly; no screen lists a hidden one |

`HiddenQuestRegistry` remembers what the authority said about each template (`QuestManager` reads and records every template **before** it raises an event about it); a template nobody has said anything about is treated as not hidden. It is memory for the presenters only and decides nothing.

Operators and designers still see hidden quests in the Studios (a `HIDDEN` badge on the Unity Quests tab row, a **Hidden** field in the inspector), and in the moderation board.

## Steps from the client

The client only reports where the player stands. `TrainerLocationReporter` is the one place the position is sent: online it calls `PUT /trainer/{id}/location` with `includeProgress: true` and applies the answer's `progress` through the quest manager's one progress path (so a hidden walk-steps quest completes, auto-claims and reveals like any other); a server that predates step counting answers the bare `true`, which the client reads as "saved, no progress"; offline it calls the same `ITrainerLocationService` the server uses, over the local SQLite trainer row. `TrainerLocationTracker` and `AreaLoader` use it when it is bound. See [Server-Counted Steps, Offline parity](?page=backend/31-server-counted-steps#offline-parity). `StepCountingBindings.Install` registers the offline pieces in the installer.

## The claim reveal

When a reward claim took an item **and** spawned a creature, the game plays a short reveal: the item (its icon) trembles ("The <item> is trembling..."), cracks ("It's cracking open!"), bursts in a soft flash, the creature appears, then "<creature> joined you!" and where it went ("It joined your team." or "Your team is full, so it was sent to storage.").

- **Driven only by the claim answer.** `ClaimReveal.From` looks at the taken items and spawned creature ids of one claim answer and nothing else; it is keyed on no quest, item or species. `QuestManager` tells the `IClaimRevealObserver` (`ClaimRevealPresenter`) about every paid claim, online or offline. A claim with no taken item, or no creature, is not a reveal. The claim id (the quest instance id) makes a claim reveal once however many paths report it.
- **Before the burst, nothing names the creature.** The words before it name only the item the player is already carrying.
- **It can never block play.** The overlay takes no clicks, any button press skips it, it ends by itself, and a reveal that arrives while a menu, a battle or a cutscene has the screen waits in `ClaimRevealQueue` and plays when the overworld is free. It is purely presentational: a failure in the observer is logged and never reaches the claim.

## Quiet refusals and unclaimed quests

`QuestRefusal.IsClaimDeferred` extends `IsQuestDisabled`: a claim the authority could not pay **yet** passes quietly (no error log, no broken dialogue) when the quest is turned off, the item it takes is missing (`quest-item-missing`) or the reward is unavailable (`quest-reward-unavailable`). Nothing was spent, so the claim waits. The dialogue claim handler and the reward dispatcher use it.

`QuestUnclaimedSweep` runs once per session start and claims every Completed, unclaimed instance whose template pays on completion (a crash, a quit, or a deferred claim leaves one), through the same dispatcher. Quests that wait for their giver are left to the giver.

## Content fingerprint

The quest content fingerprint covers `isHidden` and the salt was bumped again (`cs2` to `cs3`), so every quest re-syncs into local SQLite once after the update (`LocalQuestTemplateSyncClient`, `QuestTemplateSnapshotExtensions`).

## Studio

See [Content Registry, Hidden quests, Walk steps and Take item](?page=unity/08-content-registry#hidden-quests-walk-steps-and-take-item-in-review).

## What was not tested

Tests cover the visibility rules, the reveal logic and sequence, the refusal helpers, the offline hatch chain on SQLite and the tree-spot row (`HatchClientTests`, `HatchOfflineChainTests`, `QuestHiddenTests`, `ClaimRevealTests`, `StoryTreeSpotRowTests`); the full suite was reported green (13067 total, 13065 passed, 2 skipped). **Not tested:** no Play-mode run and no end-to-end run against a live server. The reveal's on-screen look was checked from captured stills and a GIF, not live play.

## Related Pages

- [Quest System](?page=backend/07-quest-system), [Server-Counted Steps](?page=backend/31-server-counted-steps), [Quest Helpers](?page=unity/50-quest-helpers), [Open World, Tree find spots](?page=unity/37-open-world#tree-find-spots-in-review)
