# Quest Story Map

The story map (**Content → Story map**, `/content/quest-map`, content-write scope) shows every quest as a card and every
prerequisite as an arrow, so a writer can see the whole story and rewire it without opening each quest. It is built on
React Flow with ELK auto-layout (the same setup as the [Dialogue Canvas](06-dialogue-canvas.md)).

## What it shows

- **Cards** are quests. Quests that share a **story line** sit in the same coloured lane, ordered by **step**.
- **Arrows** are prerequisites: a requirement of type `QuestCompleted` (blocks until the other quest is done) or
  `QuestNotStarted`. The target comes from the server-resolved `referenceContentKey`, never from a client-side id lookup. A
  requirement whose target was deleted shows as a "broken prerequisite" check.
- **Conversation chips** on a card show the dialogues that offer, pay out or count a talk for the quest (from quest-links).
  A quest that starts automatically (`AutoWhenAvailable`) gets a "Starts automatically" badge and skips the offer check.
- A legend explains the arrows and the card states; filters narrow by area, line or "has checks".

- A talent that is gated by a quest (`unlockQuestKey`) links here from the [Talent Tree Editor](09-talent-tree-editor.md) (its gold quest chip opens the map focused on that quest).

## Checks

Pure rules over the loaded quests flag, for example: a quest nobody offers, a prerequisite loop, a broken prerequisite, a
step with no line. The toolbar "checks" button shows only the cards that have findings. A prerequisite loop is also
refused by the server (`400 requirement_cycle`), and the map answers with "That would make a loop: A → B → A".

## Editing

- Drag an arrow from one card to another to add a prerequisite (confirmed); select an arrow and delete it to remove one.
- The inspector edits name, description, giver, line and step, and can remove objectives and rewards. Full objective and
  reward editing stays on the quest page ([Quest Editing](04-quest-editing.md)), linked from the inspector. A quest opens on its **Flow** tab ([Quest Flow Editor](10-quest-flow-editor.md)), which has a **Story map** button back here.
- **Story line** is a select of the existing lines plus **New story line...**; a new line gets a slug key and a name, and the
  step defaults to the next free one in the lane. Writers never type quest or conversation keys; they are derived from names.
- **Create conversation** adds a dialogue for the quest's giver, linked to the quest.

Every save from the map re-reads the quest first (`by-content-key`), patches it, and saves with that fresh `rowVersion`, so
the children it did not touch are not overwritten. A 409 opens the same conflict dialog as the dialogue editor.

## Layout document

Card positions, lane colours and line names are stored server-side as a **layout document** per scope
(`GET`/`PUT /api/v1/quests/map-layout/{scope}`, table `quest_map_layout`, content-write policy). It is presentation only: it has
no effect on gameplay, is not sent to the game client, and has no Unity counterpart. Limits: at most 2000 positions, 256 KB,
lane colours as `#rrggbb`. It uses `row_version` like quests; if a save conflicts, the map merges the server's copy with your
moved cards and edited lines and retries once, then shows the dialog. Cards without a saved position are placed by ELK.

## View as a player

An admin can pick a player in the toolbar to colour cards by that player's quest state (locked, available, in progress, ready
to turn in, completed, abandoned, failed) with a count per state. Without admin the picker is ignored and nothing is fetched.
See [Player Progression Debugger](08-player-progression-debugger.md).
