# Evolution

A creature evolves when one of its species' **rules** passes — unless the player stops it, or it is
holding something that already has.

Two things shape the design. The player gets several seconds to change their mind, so nothing is
applied when the evolution starts. And the server and the offline client must agree, so one pure
evaluator decides for both.

## Rules and requirements

A species owns an ordered list of rules. A rule names a target species and carries **groups** of
requirements. The groups are OR; the requirements inside a group are AND. The first rule with a
passing group wins, in author order — so "Bud → Blossom at 12" listed above "Bud → Thornbud with a
Thorn Seed" means the level always wins when both hold.

| Table | Row |
|---|---|
| `evolution_rule` | `creature_id`, `target_creature_id`, `sort_order` (author order) — soft-deleted, `deleted` filtered everywhere |
| `evolution_requirement` | `rule_id`, `group_index`, `sort_order` (position in the group), `requirement_type`, one of `int_value` / `guid_value` / `string_value`, `consume_on_evolve` — value rows owned by their rule, replaced wholesale on every write |

`EvolutionRequirementType` (`CR.Game.Model/Evolution`):

| Type | Value column | Passes when |
|---|---|---|
| `MinLevel = 1` | `int_value` | `facts.Level >= int_value` |
| `HeldItem = 2` | `guid_value` (item id) | the item is in either held slot **or** is the item just used from the bag |
| `StatusCondition = 3` | `guid_value` (condition id) | the at-rest condition is on the creature |
| `InArea = 4` | `string_value` (area key) | equals the owning trainer's `trainers.last_area_key`, ordinal. A trainer with no recorded area **fails** — location never fails open |

`consume_on_evolve` only means something on `HeldItem`, and it is **the only** thing that decides
whether an item is spent. A consumed item is destroyed at Commit — the held slot is cleared in the
same creature write as the species change; it is not returned to the bag. An item used from the bag
is spent only when the winning group carries a `HeldItem` requirement naming it with
`consume_on_evolve` set (a used item satisfies such a requirement the same way a held one does), and
only at Commit: cancelling leaves it in the bag.

So using a Sun Stone on a creature whose winning rule is a plain `MinLevel` evolves it **and keeps
the stone** — the rule says what an evolution costs; the act of using an item does not. The same
applies to a held copy of that item: nothing the winning group did not ask for is destroyed.

Rules live in `CR.Game.Model/Evolution` (`EvolutionRule`, `EvolutionRequirement`) and are read
through `IEvolutionRuleRepository` (`GetByCreatureAsync`, `GetAllAsync`, `ReplaceForCreatureAsync`).
Both reads cost **two queries**, not one per rule: the rules, then every live requirement joined to
its live rule in one pass, grouped in memory. It is a join rather than a `WHERE rule_id IN (...)`
list on purpose — the SQLite GUID normaliser rewrites parameters, not arrays, so an id list would
arrive uppercase and match nothing, and the join needs no id list at all.

`ReplaceForCreatureAsync` writes the whole ordered set in one transaction: rules absent from the
set are soft-deleted along with their requirement rows, present ones upserted by id, and every
listed rule's requirements deleted and re-inserted. The repository writes whatever `SortOrder` the
caller supplies — it is `EvolutionRuleSoMapper.ToDtos` on the Unity side (`SortOrder = i`) that
guarantees a contiguous 0..n-1, not the server.

The upsert is scoped: `WHERE id = @Id AND creature_id = @CreatureId`. A rule id that belongs to a
different species falls through to the INSERT and fails on the primary key rather than silently
re-parenting that species' rule — the shape a duplicated `CreatureDefinition` asset produces, since
Ctrl+D copies the authored rule ids verbatim. The PUT catches it first and answers **409** naming
the rule and its owning species.

## The evaluator

`EvolutionEligibility.Evaluate(rules, facts)` in `CR.Game.Model` is the one place that decides.
Pure, no I/O, because it runs in two places that cannot share a database: online the server
decides, offline the client resolves the same rules against its baked floor. Two implementations
is how the modes quietly stop agreeing.

`EvolutionFacts` is everything a rule can ask about: `Level`, `HeldItemIds` (both slots),
`HeldItemPreventsEvolution` (a Bindstone resolved by the caller), `StatusConditionIds`, `AreaKey`,
and `UsedItemId` (set only on the item-use trigger).

Order of decisions:

1. No rules → `Blocked(NoEvolutionForSpecies)`.
2. `HeldItemPreventsEvolution` → `Blocked(BlockedByHeldItem)`. Before the rules, because it is the
   one cause the player can undo.
3. Rules in `sort_order`; within a rule, groups in `group_index`. The first rule with a passing
   group → `Ready(target, ruleId, itemsToConsume)`.
4. A rule with no target, no groups, an empty group, or a requirement whose value column for its
   type is null cannot be evaluated. It is **skipped**, its id collected in
   `UnevaluableRuleIds`, and the remaining rules are tried — one broken rule must not make its
   species unevolvable through the good rules beside it. A skipped rule contributes no
   `FailedGroups`, not even from the groups it got through before the bad requirement.
5. Otherwise → `Blocked(RequirementsNotMet)` with `FailedGroups`: per rule, per group, the
   requirement types that failed, so a client can say "needs level 30 or a Fire Stone".
6. If **every** group that failed did so purely on `InArea`, that is reported as
   `NotInRequiredArea` instead — the player can walk somewhere else, so say that. Deliberately
   strict: one group that also wants a level or an item means the honest answer is still
   `RequirementsNotMet`, because walking would not be enough.
7. If **no** rule was evaluable at all → `Blocked(IncompleteEvolutionData)`, with every offending
   rule id in `UnevaluableRuleIds`. Content bugs are reported, not hidden.

| Reason | Meaning |
|---|---|
| `None` | It can evolve now |
| `NoEvolutionForSpecies` | This species is meant to stay as it is |
| `BlockedByHeldItem` | Something it is holding is stopping it |
| `RequirementsNotMet` | It has rules; none passes yet (`FailedGroups` says which) |
| `IncompleteEvolutionData` | Every rule is half authored — a content bug (`UnevaluableRuleIds` names them) |
| `NotInRequiredArea = 6` | It is ready except for where it is standing |

`LevelTooLow` is gone; `RequirementsNotMet` subsumes it.

The `NotInRequiredArea` conversion lives in `EvolutionEligibility.Evaluate` itself, not at a caller.
It used to live in `EvolutionService`, which meant `CreatureProgressionService`'s level-up path —
which calls the evaluator directly — reported `RequirementsNotMet` for the same creature Begin would
have told to walk east. Both triggers now say the same thing, because there is only one place that
says it.

A species whose rules are all half authored also gets a `LogWarning` from the level-up path naming
the offending rule ids: a species that quietly stops evolving is the bug nobody notices for a
release.

## The facts builder

`EvolutionFactsBuilder` (`CR.Game.Domain.Services/Implementation/Evolution`) does the I/O the
evaluator refuses to: level, both held slots plus the `PreventsEvolution` lookup, at-rest status
conditions, the owning trainer's `LastAreaKey`, and the used item id it is handed. Check, Begin,
Commit and the level-up hook all go through it, so the four cannot drift.

Each lookup fails in the direction that keeps the feature honest rather than broken. An unreadable
held item is still listed in `HeldItemIds` (so a `HeldItem` requirement can still match it by id)
but never sets `HeldItemPreventsEvolution` — a lookup failure must not silently turn into a Bindstone
block. Unreadable status conditions are treated as none. An unreadable trainer leaves `AreaKey` null,
and `InArea` then fails: location is the one fact a rule should never assume open.

Separately, at Commit, if the **growth profile** cannot be found the species change still applies —
it is the thing the player asked for and watched happen — but the stat recompute is skipped and a
warning is logged rather than the evolution being refused after the fact. A missing **target
species** is the opposite case and is refused: it is resolved before the ledger row is claimed, and
a commit that cannot resolve its target fails with the offer left `Pending`, so the same offer works
again the moment the species is back. Writing the change anyway would leave a live creature carrying
a `BaseCreatureId` that resolves to nothing, which nothing later can detect or undo.

## Why three phases

The cutscene runs for several seconds. Across those seconds the client can crash, lose its
connection, or be force-quit — so the species change is **not applied when the evolution starts**.

| Phase | What it does | What it changes |
|---|---|---|
| `BeginAsync(creatureId, trainerId, usedItemId?)` | Evaluates, records a pending offer with the winning `rule_id` and `used_item_id` | **Nothing** |
| `CommitAsync` | Re-evaluates, applies the species change, then consumes | The creature, and the consumed items |
| `CancelAsync` | Records that the player held the button | Nothing — a used stone stays in the bag |

A run that never comes back leaves a `Pending` row and a creature nobody touched. That is the
failure worth having: nothing happened, and it is offered again at the next trigger.

:::note
`ExpiresAt` is housekeeping, not a security boundary. **Commit re-evaluates eligibility from
scratch** — with the offer's `used_item_id` folded back into the facts — rather than trusting the
offer it was handed. Between begin and commit the creature may have been given a Bindstone,
walked out of the area, or been traded away.
:::

Commit's outcomes:

- Eligible and the winning rule's target equals the offer's target → claim the ledger row, apply
  the species swap and stat recompute, **then** consume (clear the flagged held slots; remove the
  used item from the backpack). Consumption failures are logged and never undo the evolution.
- Not eligible → the refusal path, reason attached.
- Eligible but a **different** target now wins (left the area, another branch qualifies) →
  `EvolutionResult.OfferStale = true`, the row marked `EvolutionStatus.Stale`. The client shows
  "stopped evolving" and the next trigger re-offers.

The row is claimed first, then the creature is changed. If the claim wins and the creature write
fails, the creature is unevolved and still eligible — one wasted offer. The other order risks
evolving a creature whose cancel won the race, which nothing later can detect or undo.

## The two triggers

**Level-up.** `CreatureProgressionService.ApplyLevelUpChangesAsync` runs the facts builder and
the evaluator after the level is written and reports `ReadyToEvolve` / `EvolvesIntoCreatureId` /
`EvolutionBlockedBecause` on the apply result. No Begin here — the client Begins on the way out of
battle, once the summary screen is done.

Note what this means: the server *records* readiness, it does not act on it. Something on the
client has to ask, and **who gets asked is a client-side decision** — see "Who gets asked" below.
A creature the server calls ready that nobody asks about simply stays unevolved.

**Item use.** `TriggerEvolutionHandler` (effect type 10) calls
`IEvolutionService.BeginAsync(target, trainer, usedItemId: itemId)`. A refusal comes back as a
**400** whose body carries the handler's player-facing sentence (`ItemEndpoints` answers every
unsuccessful handler that way, for every item effect). The bag shows that sentence verbatim —
`SimpleWebClient` turns the 400 into a `ServerRequestException` carrying it, and
`ItemUseFailureText.For` hands it to the toast — so online says exactly what offline says. An offer
comes back with `EvolutionTriggered = true` and the offer itself on the `Evolution`
property (an `EvolutionOffer`) of the item-use result, and `ItemUseDomainService` **skips
consumption** when a handler reports it: the stone is consumed at Commit, not at use. The handler
no longer takes a target parameter — the rules decide the target.

## Who gets asked

The client decides which creatures are offered to `BeginAsync`, and it asks about **the whole
team**, not only the creatures that levelled. `EvolutionCandidates.Sweep(leveledInBattle, team)`
(pure logic, in `CR.Game.Evolution.Logic`) builds the list: everyone who just levelled first, then
the rest of the team, de-duplicated, with empty ids dropped. Order is load-bearing — the presenter
plays the **first** eligible candidate and stops, so a creature the player just watched level up
must come before a team-mate that has been quietly ready for a while.

This was a real bug. The candidate list used to be exactly "creatures that levelled in the battle
that just ended", which made *levelling in a battle* the only route into an evolution. A creature
that crossed its threshold any other way — an operator's `Grant XP…`, an experience item, or being
handed over already above the level its rule asks for — was never asked, and stayed unevolved with
the server reporting `readyToEvolve: true` the whole time. Content Studio even prints "ready to
evolve into Cindralis" when it grants the experience, a promise nothing on the client kept.

Two moments ask:

| Moment | Source | Covers |
|---|---|---|
| A battle finishes closing | `BattleSummaryScreen.OnBattleClosedRaised` | Levelling in a fight, plus anyone else on the team who is owed one |
| ~2s after world init | `EvolutionReadySweep` (`IWorldInitializable`, bound `FromNewComponentOnNewGameObject().NonLazy()`) | XP grants, experience items, creatures acquired above their threshold |

World load is the only moment available for the second row: nothing tells a running client that the
server changed a creature underneath it. So **an XP grant made mid-session pays off on the next
load, not instantly** — worth knowing before concluding the trigger is still broken. The grace delay
is not cosmetic either: the sweep can start a cutscene that teleports the player, and doing that on
the frame the world finishes loading lands on top of `EvolutionReturnRescue` (execution order 10;
the sweep is 20, so the player is put back before anything moves them again).

Candidates are questions, never answers. Eligibility stays the server's call, made per creature — a
wider sweep costs one request per team member at the two moments a cutscene may start, and cancels
nothing: a player who declined can decline again, or hold the Bindstone.

## The Bindstone

`item.prevents_evolution` — a column, not a new `HeldItemTriggerType` value. Every value that enum
has names an *in-battle event* and battle code switches over it; evolution is not a battle event.

The stone works by being **held**: `usage_flags = 0` and not consumable. Both held-item slots are
checked — a player who put it in the second slot meant it just as much.

## What evolving does and does not change

Changed: the species, the six stats (recomputed against the new base values through
`CreatureStatCalculator`), and whatever the winning group said to consume.

Unchanged: **the level** (evolving is not a level-up) and **the abilities** (an evolved creature
keeps its moves).

## Endpoints

| Route | Purpose |
|---|---|
| `GET /api/v1/creatures/{id}/evolution` | Could this evolve right now, and why not — `FailedGroups` included |
| `POST /api/v1/creatures/{id}/evolution/begin` | Offer one, start the clock (the trainer id is in the body) |
| `POST /api/v1/evolutions/{evolutionId}/commit` | Apply it |
| `POST /api/v1/evolutions/{evolutionId}/cancel` | Decline it |
| `GET /api/v1/evolution-rules` | Every live rule with its requirement groups — runtime content sync and Content Studio pull |
| `GET /api/v1/creatures/by-content-key/{contentKey}/evolution-rules` | One species' rules |
| `PUT /api/v1/creatures/by-content-key/{contentKey}/evolution-rules` | Replace one species' rules (`RequireContentWrite`). 200 with the stored list; 400 with `{message, errors[]}` on validation; 404 unknown species; 409 unknown target species, or a rule id another species already owns |

The four player routes are owner-gated on the caller's token: each resolves the acting trainer's
account from `context.GetAccountId()` and 404s if that account doesn't own the trainer named. A
token with no usable account claim gets `401 Unauthorized`.

**Neither route takes a used item id from the wire.** Nothing out here verifies that the caller owns
the item, so a `usedItemId` query parameter would satisfy any `HeldItem` requirement for free — and
Commit re-evaluates with the offer's stored item, so the replay would pass there too. Both routes
pass `null`. `IEvolutionService.CheckAsync` / `BeginAsync` still take the parameter, because the
server's item-use flow (`ItemUseDomainService` → `TriggerEvolutionHandler`) supplies it after
verifying ownership, and the offline client calls the same service in-process. Using an item is the
only way one enters the facts.

## The lines

The five legacy lines were folded into rules by **M12018** (one rule, one group, one `MinLevel`
requirement each, with deterministic ids so a re-run changes nothing) and the old
`creature.evolution_level` / `evolution_creature_id` columns nulled. All three of its statements
share one predicate — a level **and** a target — so a half-authored species (a level, no target)
is skipped whole: no rule, no requirement, and its legacy columns left intact for whoever finishes
authoring it. Guarding the requirement insert on the level alone would strand a row under a
`rule_id` that was never created, holding a fixed uuid5 id that can never be re-used.

| Species | Becomes | Rule |
|---|---|---|
| Bud | Blossom | `MinLevel 12` |
| Sunflower Fairy | Sunflora Pixie | `MinLevel 14` |
| Crabby | Shell | `MinLevel 16` |
| Snakelet | Poison Bomb | `MinLevel 18` |
| Dragon Spark | Dragon Fire | `MinLevel 24` |
| Cindris | Cindralis | `MinLevel 8` |
| Cindralis | Cindrakar | `MinLevel 20` |

The last two are the Cindris line, seeded by **M13004** (`SeedCindraLine`). Cindralis shares Dragon
Fire's model (`creatures/dragonfire`) rather than carrying art of its own; each species still has its
own portrait, because a portrait is what tells two species sharing a model apart on a team card.

:::danger The species seed must run before the rules seed
The rule insert is guarded on **both** species already existing — a rule pointing at an absent
species is a row no reader can follow. A rules migration numbered below the species it targets
therefore writes nothing at all, and says nothing about it: the bake reports success and the floor
comes out with the species present and the links missing.

This is why the exported rules migration is **M13005**, above the species seed at M13004, and why it
was renumbered from 13003 when the Cindris line was added. `CindraLineSeedSqliteTests` pins the
ordering directly — renumbering the species seed above the rules seed fails three of its tests.
:::

**M13005** (`SeedEvolutionRules_<date>`) is the authored set exported from Content Studio (see
[Evolution Authoring](../unity/30-evolution-authoring.md)) and is what the offline floor is baked
from. It upserts rules by id, replaces requirements, and retires any rule of a covered species
that the export no longer lists, along with the requirements sitting under those retired rules.

:::caution A deploy can retire a live Studio push
The retire sweep runs over `Covered`, which lists only the species this export actually carries
rules for — five today, not all fifteen seeded species. Within those species it is still not a
one-way mirror: deploying a build whose M13005 predates a Studio push will retire the rules that
push added to one of them, on any database that has not yet run 13003. Nothing is lost — re-push
from Content Studio and the rules come back under the same ids — but if rules an author pushed last
week vanish after a deploy, this is why, and the fix is to re-export M13005 from the Editor so the
seed and the authored set agree again.

A species the export carries no rules for is never swept, so a push that gives a brand-new species
its first rule survives any deploy. That is also why deleting a species' last rule in the Studio
does not propagate through the seed: on a live server the push retires the rule directly, and the
offline floor is baked from seeds alone, so the deleted rule was never in it to begin with.
:::

:::note Why a Creatures migration carries a 13xxx number
`SeedMigrationFileWriter` takes the next free number across **every** domain's migrations, not just
the domain it is writing into — which is why the evolution seeds sit above Moderation's M13001/M13002 rather
than in the Creatures band. There is no per-domain `IVersionTableMetaData`, so every migrator shares
one `VersionInfo` table and a number used once is used for good. A hand-written migration must
therefore check the whole repository for its next number, never just its own domain folder.
:::

:::caution
Seeds sit behind table-exists guards, so without tests they go inert silently. Pinned:
`M12018` folds the five lines both ways; `M13005` leaves every live rule with a seeded species on
both ends and at least one requirement; the Bindstone actually blocks and is actually unusable.
:::

## Related

- [Evolution Authoring](../unity/30-evolution-authoring.md) — rules in Content Studio, push/pull, the seed export
- [Item Effects](./19-item-effects.md) — the `TriggerEvolution` effect
- [Creature Generation](./04-creature-generation.md) — the experience curve and the growth trait
- [Area Scenes](../unity/22-area-scenes.md) — the area keys `InArea` compares against
