# Dialogue Canvas

The dialogue canvas is the default view when you open a dialogue in the web Studio (`/content/dialogues/:id`). It
draws the conversation as a graph you can edit directly. The same dialogue also keeps its **Form** tab (the row-list
editor, see [Dialogue Editing](02-dialogue-editing.md)) and an **Advanced** tab (raw document JSON); all three edit the
same document, so a change on one shows on the others.

The canvas is built on React Flow (`@xyflow/react`). Auto-layout uses `elkjs`, imported from `elkjs/lib/elk.bundled.js`
so it needs no Web Worker under the production CSP; an end-to-end test (`e2e/editors.spec.ts`) runs Tidy under that CSP.

## Cards and arrows

Five card types, one per node type: **line** ("says"), **choice**, **branch**, **action** and **end**. Edges are coloured by
kind: next, option, case, else and the entry marker. A collapsible legend in the corner of the canvas shows the cards and
edge kinds. Dropping a connection on empty canvas offers to create a node; options and cases can be reordered with arrow
buttons or by dragging.

Conditions and actions are not typed as text. The inspector shows a **sentence builder**: you pick a rule and fill its
slots (quest, NPC, item, stat or a fixed choice). The rule list, the sentences and the slot kinds come from the server
(`GET /api/v1/dialogues/vocabulary`), so they always match what the game understands. If that call fails the canvas uses a
bundled copy and shows a muted note. Content keys are hidden unless debug mode is on; new dialogues get a key derived from
the name.

Limits are shown where you hit them: "n / 20 options", "n / 20 rules", a character counter on node text, and a 16-argument
cap on a rule. Add is disabled at the cap.

## Checks

While you edit, the canvas sends the dialogue to `POST /api/v1/dialogues/validate` (after a short pause) and shows the
server's findings as badges on cards and in a checks popover. The same validator runs on save, so nothing here is a
second opinion. If the check call is down, the page says "Checks unavailable" and Save still works. Warnings include
missing or unknown rule arguments and lore tags that are open or unclosed.

## Quests in this conversation

The inspector lists the quests this conversation offers, pays out, counts a talk for, or checks (from
`GET /api/v1/dialogues/quest-links`), with an **Open on map** link to the [Quest Story Map](07-quest-story-map.md).
Quest rules on cards show the quest's name, not its key. Links into `/content/*` appear only for users with the content-write scope.

## Play

**Play** runs the conversation in a preview using the same rules as the game runner (ported and tested against golden
playthroughs). It starts at the entry node, shows the transcript and the path on the canvas, and lets you pick options.
Conditions the preview cannot know are "pretend" switches: flip one and the run restarts from the entry with the new world.
The preview refuses to start while the dialogue has error findings. See also *View as a player* on the
[Player Progression Debugger](08-player-progression-debugger.md), which seeds these switches from a real player.

## Saving and conflicts

Save sends the dialogue with the `rowVersion` you loaded. If someone else (the Unity Studio, another web user) saved first,
the server answers 409 and a **conflict dialog** opens. **Compare** shows both versions with the server's `updatedAt`;
**Overwrite theirs** is a second, confirmed step; **Reload** discards your edits and loads theirs. If the row was
deleted meanwhile, you can **Recreate** it (sent as `expectedRowVersion: 0`). After a successful save the canvas stays open
on the new version. Moving cards (layout only) never conflicts; see
[Optimistic Concurrency](../backend/28-optimistic-concurrency.md) for the contract.

## Parity with Unity

The Unity node editor and this canvas must agree on auto-layout, the scaffold used for new area guides, and the rule
vocabulary. These are pinned by shared fixtures (each with a README naming the source commit) and tests on both sides; if
the vocabulary ever differs, the server descriptors are corrected, never Unity. See
[Dialogue Authoring](../unity/32-dialogue-authoring.md).
