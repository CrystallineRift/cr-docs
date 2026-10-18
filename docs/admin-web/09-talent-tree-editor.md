# Talent Tree Editor

The talent tree editor is the default view when you open a tree in the web Studio (`/content/talent-trees/:key`, content-write
scope). It draws a tree the way a player sees it: a grid with one row per tier and one card per talent. The same tree keeps its
**Form** tab (field list) and an **Advanced** tab (raw JSON); all three edit the same value, so a change on one shows on the
others. The server rules it edits are described in [Talents](?page=backend/25-talents).

The canvas is built on React Flow (`@xyflow/react`). The grid is fixed geometry, so there is no auto-layout step.

## The grid

- **Rows are tiers 1 to 5.** A divider before each row reads "Tier N · needs X points in <tree>" (X is the tier gate, 5 points
  per tier below it). Columns are the order inside the tier, by sort order then key. Dragging a card within or between tiers
  writes the tier and a dense sort order.
- **Cards** show a glyph (one bundled SVG per effect type; there is no image URL for Addressables icon keys on the web yet, so
  the icon key itself is shown in the inspector), the name, rank pips, and the effect sentence with the rank 1 value. A drawback
  is marked in red with a warning sign. Talents that share a choose-one group sit in a dashed box with the group label.
- **Rule chips** on a card show what unlocks it: blue for a talent in the same tree, green for a talent or points in another
  tree, gold for a quest. A chip links to its target (selects the card, opens the other tree, or opens the
  [Quest Story Map](07-quest-story-map.md)). Same-tree "talent at rank" rules also draw a prerequisite arrow.
- The **trees rail** on the left lists every tree with its talent count and has **New tree** (the key is a slug of the name).

## Inspector

Select a card to edit it. Keys are slugged from names and hidden unless debug mode is on; a talent's key is frozen after it is
created because rules point at it.

- **Name, icon, max rank.** The icon is an Addressables key picker. Changing max rank resizes every effect's value list.
- **What it does.** One row per effect, written as a sentence. Pick the effect by its label, then type one value per rank
  (the value is the total at that rank, not an increment). Turn on **scales from** for a synergy effect, which reads like
  "Creatures' Speed + [50]% of your [move speed] bonus"; the value list is then a percentage of the source effect's total.
- **Player text.** The description the player reads. `{0}` is the current rank's first effect value; the preview fills it in.
- **Unlock rules.** An AND-list, at most four per talent: "Talent [X] is rank [N]+", "[N]+ points spent in [tree]", plus the
  quest gate shown as "Quest [Q] finished" (stored in `unlockQuestKey`, not in the rules list).
- **Choose-one group** (pick an existing group or **New group**, which slugs its key) and the **drawback** toggle.

## Checks

Pure rules run live over all trees and show as a badge, a popover, a marker on the card and a list in the inspector. They
mirror the server validation so you see problems before saving; the server is still the truth when you save. They cover a rule
loop, a missing talent or tree, a minimum above the target's max rank, a rule that needs more points than the level cap can
ever give, empty tiers between filled ones, more than one capstone, synergy misuse (source must be a plain effect, no
chains, target different from source) and a value outside the effect's cap. A loop through a cross-tree "points in tree" rule is
reported conservatively: that rule counts as depending on every talent in the other tree.

## Modes

The canvas has three modes in a toggle: **Edit**, **Try it** and **All trees**.

- **Try it** is a preview that never touches the form. A level slider (points = level minus 1; the maximum comes from the
  trainer level curve) and click to add a rank, right-click or shift-click to remove one (refused when it would strand a
  talent that depends on it). It runs a TypeScript port of the server's evaluation, pinned by golden fixtures copied from
  cr-api (`src/lib/talents/fixtures/evaluation`, README names the source commit). The totals bar includes synergy values, tier
  dividers show "N more points" or "unlocked", and each quest gate has a "pretend done" switch.
- **All trees** draws the trees side by side with green lines for cross-tree talent and points rules. Clicking a card, a line
  or a tree name jumps to that talent.
- **View as player** (admin only) picks a player and shows that trainer's real build. Unlike Try it, it uses only the server's
  `talentStates` (state, every unmet reason, current and next values), never the TypeScript port. If the read fails, or the
  server sent no states, the picker says "Can't view as player".

The [Player Progression Debugger](08-player-progression-debugger.md) dossier shows the same per-tree states and has an
**Open in talent editor (view as)** link.

## Saving and conflicts

Talent trees are a **sync-all** resource: the server takes the whole set of trees you send. The editor keeps that, with
staging made visible:

- **Save** stages the open tree and stays on the canvas. A bar reads "N trees staged - Saved here, not live yet" with an
  **Apply** button. **Review & Apply** on the list does the same.
- **Apply** sends only the trees that changed, each with its `expectedRowVersion`, then stays on the page and picks up the new
  versions. Trees you did not change are not sent. The bulk route cannot delete, so Delete is hidden on this resource.
- A 409 opens the conflict dialog **per conflicting tree**. **Reload theirs** drops that tree's staged edit and loads the
  server copy. **Compare** shows your version against the server's. **Overwrite** re-stages yours on the server's current
  version, and you Apply again. **Recreate** (the tree was deleted meanwhile) sends version 0. See
  [Optimistic Concurrency](../backend/28-optimistic-concurrency.md).

A Unity Studio push replaces web edits to the same tree, the same precedent as World Locations.

## Related

- [Talents](?page=backend/25-talents) for unlock rules, evaluation, synergy effects and `row_version`.
- [Talents UI (Unity)](?page=unity/36-talents-ui) for the Studio side (rules in the inspector, Pull, conflicts) and the in-game tab.
- [Quest Flow Editor](10-quest-flow-editor.md) shows talents a quest unlocks.
