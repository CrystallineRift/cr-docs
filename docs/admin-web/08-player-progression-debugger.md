# Player Progression Debugger

When a player says "my quest is stuck", an admin can see why. The debugger is a **Story progression** section on the player
dossier (Live ops → Players), plus a **View as** picker on the [Story Map](07-quest-story-map.md) and the
[Dialogue Canvas](06-dialogue-canvas.md). It is **read-only** and **admin only** (`RequireAdmin`); editor and content-write
keys get 403, and a 403 shows "Progression is admin only". Reading writes no `admin_action` row.

## Opening it

Search a player on the Players page and open a trainer, or deep link with `?account=` and `?trainer=`. The trainer id comes
from the route; NPC trainers are never listed or readable.

## Sections

- **Quests**, grouped by state. Each row shows the state and, for quests the player cannot start, the requirement sentences
  with the player's current value where the server can compute it (for example "(now 3)"). States: Locked, Available, In progress, Ready to turn in,
  Completed, Abandoned, Failed.
- **Flags**: the player's server-owned flags (`trainer_stat`), filterable by category. At most 2000 are returned; if there
  are more the section says it is truncated. (The API also returns defeated trainer NPCs and item totals; the page does not show them yet.)
- **Timeline**: the player's stat events and admin actions merged, newest first, 50 at a time with **Load older**.

## How state is decided

The server computes the state over **all** instances of a template: In progress wins; otherwise Completed (or Ready to turn
in when the quest returns to its giver and is not yet claimed); otherwise the latest Abandoned or Failed; otherwise
Available or Locked. Available and Locked use the same check as the NPC's offer list, so the debugger never disagrees with
what the player is offered. Because that is the offer check, a repeatable quest that was claimed shows as Available or
Locked, not Completed. See [Quest System](../backend/07-quest-system.md).

## View as a player

Picking **View as** loads that player's progress and applies it to the editors: the map colours cards by state; the canvas
marks branch cases and conditional choice options with a tick, cross or ? (tooltips "Holds for this player", "Does not hold for this player", "Not known for this player") and seeds **Play** with the player's real world
("Viewing as {trainer}"). Anything the payload cannot answer (for example a creature level or used-item requirement) is
listed under "Not known for this player" instead of guessed. If the fetch fails the page says "Can't view as player" and
seeds nothing.

## API

Documented in [Moderation](../backend/18-moderation.md#progression-debugger-routes): `GET /api/v1/admin/trainers/{id}/progression`
and `/timeline`. Stat events come from [Stats](../backend/08-stats-system.md).

## Story beats and quests on the dossier

The trainer card on the player dossier shows **Story beats** (sorted chips) and **Quests** (active and completed keys). Support
can **Grant** a beat (key and reason) or **Revoke** one (reason dialog per chip). `act1-done` has Revoke disabled with the
tooltip "Restored automatically; cannot be revoked". Both actions are admin-only and write an `admin_action` row (kinds 21 and
22). Fields are optional in the page's types, so an older server shows the sections empty. See
[Moderation](../backend/18-moderation.md#story-beat-admin-routes-2026-10-18).

### Lost to (P1a)

The Quests section also shows a **Lost to** row built from the trainer's `trainer_lost_<npcKey>` flags (set by the server when the trainer lost to a `lossAllowed` opponent). It shares the one progression query with the other sections. The list is raw NPC keys, and the progression flags are capped at 2000, so on a truncated list a `trainer_lost_` key could be missing.

## Quests and Achievements tabs

Since 2026-10-20 each trainer on the dossier has three tabs: **Overview** (the existing cards above), **Quests** and
**Achievements**. Unlike the debugger sections these tabs can change state; every action asks for a reason and writes an
`admin_action` row. Server rules: [Moderation](../backend/18-moderation.md#quest-and-achievement-admin-2026-10-20).

- **Quests.** A table of the trainer's instances with a status chip, objectives (current / required), dates and whether the rewards
  were claimed, and a **Complete** button. Complete runs the quest through normal completion and pays its rewards, so beats, stats
  and follow-up quests happen too. The button is hidden only for a one-shot quest that is completed and claimed; a repeatable
  quest always offers it and the dialog warns that it **pays again**. The dialog also lists unmet requirements. Below the table, a
  searchable **Never started** list shows quests the trainer has no instance of, with what they still need; Complete works on
  those too (the quest is granted first).
- **Partial payout.** If rewards were only partly paid, the result stays on the page as a note listing what was paid and what was
  not. There is no retry button: a second Complete would answer "already done". Top up the missing rewards with **Grant currency**,
  **Grant items** or **Grant XP**.
- **Achievements.** The full board with Unlocked, Locked and Revoked chips (Revoked is distinct from Locked), criteria progress
  and rewards, with unique-item rewards marked. **Grant** is offered on anything not unlocked (the key is prefilled) and
  **Revoke** on unlocked entries. Revoke now sticks: the achievement stays revoked even if the player still meets the criteria,
  until an operator grants it. Revoke also takes back **unique** item rewards from the backpack; the toast lists "Taken back: key x n"
  and "Shortfall: key k not held" for any that were not there. Currency, XP and other rewards are not taken back.
