# Evolution

A creature that reaches its species' evolution level can become something else — unless the player
stops it, or it is holding something that already has.

The whole design turns on one requirement: **the player gets several seconds to change their mind.**
Everything below follows from that.

## Why three phases

The cutscene runs for seven seconds. Across those seconds the client can crash, lose its
connection, or be force-quit — so the species change is **not applied when the evolution starts**.

| Phase | What it does | What it changes |
|---|---|---|
| `BeginAsync` | Asks permission, records a pending offer | **Nothing** |
| `CommitAsync` | Re-validates, then applies the species change | The creature |
| `CancelAsync` | Records that the player held the button | Nothing |

A run that never comes back leaves a `Pending` row and a creature nobody touched. That is the
failure worth having: nothing happened, and it is offered again at the next level-up.

:::note
`expires_at` is housekeeping, not a security boundary. **Commit re-evaluates eligibility from
scratch** rather than trusting the offer it was handed — between begin and commit the creature may
have been given a blocking held item or traded away, and an old id must not be replayable into an
evolution that is no longer legal. That is the difference between server-*authoritative* and
server-*observed*.
:::

### The ordering inside commit is deliberate

The row is **claimed first**, then the creature is changed. The two writes cannot share a
transaction, so one order had to be chosen:

- **Claim then apply** (what it does): if the claim wins and the creature write fails, the creature
  is unevolved and still eligible, so it is simply offered again. One wasted offer.
- **Apply then claim**: risks evolving a creature whose cancel won the race — which nothing later
  can detect or undo.

### Retries are safe

`Begin` returns an existing open offer rather than stacking a second: two pending offers for one
creature would let it be cancelled through one id and committed through the other. `Commit` and
`Cancel` both succeed when they find the work already done, and say so via `AlreadyResolved` — a
client cannot tell a dropped request from a dropped response, so retrying is the only move it has.

## Eligibility

`EvolutionEligibility` (in `CR.Game.Model`) is the one place that decides. Pure, no I/O, because it
runs in two places that cannot share a database: online the server decides, offline the client
resolves the same rule against its baked floor. Two implementations is how the modes quietly stop
agreeing.

It reports **why**, not just no:

| Reason | Meaning |
|---|---|
| `None` | It can evolve now |
| `NoEvolutionForSpecies` | This species is meant to stay as it is |
| `LevelTooLow` | It evolves, but not yet |
| `BlockedByHeldItem` | Something it is holding is stopping it |
| `IncompleteEvolutionData` | A level with no target, or the reverse — a content bug |

A creature that silently declines to evolve reads as a broken feature, most of all in the held-item
case where the cause is something the player did and can undo. `IncompleteEvolutionData` is separate
from "does not evolve" on purpose: collapsing them would hide a data bug behind a legitimate answer.

The held item is checked **before** the level. Both can be true at once, and the held item is the one
the player can act on — "too low a level" also stops being true later, at which point a creature
carrying a blocker would report nothing at all.

Two things deliberately **fail open**: an unreadable held item does not block, and neither does an
unreadable growth profile. A creature that refuses to evolve because a lookup failed is
indistinguishable from a broken feature.

## The Bindstone

`item.prevents_evolution` — a column, not a new `HeldItemTriggerType` value. Every value that enum
has names an *in-battle event* and battle code switches over it; evolution is not a battle event, so
a value there would either be silently ignored or force a case meaning "never fires".

The stone works by being **held**: `usage_flags = 0` and not consumable. A stone that offered a Use
option is one players try to use on the creature they want to keep, to no effect. Both held-item
slots are checked — a player who put it in the second slot meant it just as much.

## What evolving does and does not change

Changed: the species, and the six stats, recomputed against the new base values through
`CreatureStatCalculator`.

Unchanged: **the level** (evolving is not a level-up — the experience a creature earned belongs to
it, not to the species it used to be) and **the abilities** (an evolved creature keeps its moves).

If the new species or the growth profile cannot be read, the species change still stands and the
stale stats are logged. Stale stats recover on the next level-up; refusing an evolution after the
cutscene has played does not.

## Endpoints

| Route | Purpose |
|---|---|
| `GET /api/v1/creatures/{id}/evolution` | Could this evolve right now, and why not |
| `POST /api/v1/creatures/{id}/evolution/begin` | Offer one, start the clock |
| `POST /api/v1/evolutions/{evolutionId}/commit` | Apply it |
| `POST /api/v1/evolutions/{evolutionId}/cancel` | Decline it |

A refusal from `begin` is a **200 carrying a reason**, not a 400: "this creature is holding a
Bindstone" is a normal answer to a legitimate question, and the client has a sentence to show.

All four are owner-gated — the service refuses a creature that is not the caller's, which is the
other half of what server-authoritative has to mean. The ownership check is on the **caller's
token**, not the request body: each endpoint resolves the acting trainer's account from
`context.GetAccountId()` and 404s if that account doesn't own the `trainerId` the body/route names
— a client-supplied `TrainerId` on `evolution/begin`/`commit`/`cancel` (or the creature's owning
trainer on the `GET` check) can no longer be used to act on or inspect another account's creature.
A token that reaches any of the four with no usable account claim gets `401 Unauthorized`, not an
unhandled 500.

## The lines

Levels are set against the habitat ladder, so evolving happens while working through an area rather
than on catching:

| Species | Becomes | At |
|---|---|---|
| Bud | Blossom | 12 |
| Sunflower Fairy | Sunflora Pixie | 14 |
| Crabby | Shell | 16 |
| Snakelet | Poison Bomb | 18 |
| Dragon Spark | Dragon Fire | 24 |

Both halves of every pair already existed as species and several are catchable in their own right —
normal for the genre, and it meant no new creatures, art or spawner entries.

Seeded by **M10015**, matched by content key rather than hardcoded id: those differ between a freshly
migrated database and one that has had content pushed through Content Studio, and a seed keyed on the
wrong one silently updates nothing.

:::caution
Before M10015, `evolution_level` was null on all 19 creatures — the mechanic was fully built and
could never fire once. Three tests now pin it: the lines wired both ways, no species half-authored,
and the Bindstone actually blocking and actually unusable. These seeds sit behind table-exists
guards, so without the tests they would go inert silently.
:::

## Related

- [Creature Generation](./04-creature-generation.md) — the experience curve and the growth trait
- [Area Scenes](../unity/22-area-scenes.md) — the habitat ladder the levels are chosen against
