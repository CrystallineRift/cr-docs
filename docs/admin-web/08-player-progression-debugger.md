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
