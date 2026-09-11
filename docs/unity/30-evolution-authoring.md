# Evolution Authoring

Evolution rules are authored on the species, in the `CreatureDefinition` inspector, and travel the
same road as every other piece of content: push to the server from Content Studio, pull the
server's copy back, export a seed migration so offline play has them too.

## Where rules live

`CreatureDefinition.evolutions` — a list of `EvolutionRuleEntry`
(`Assets/CR/Core/Data/Registry/Definitions/Evolution/`), in **priority order**: the first rule
whose requirements pass is the one that fires.

| Type | Fields |
|---|---|
| `EvolutionRuleEntry` | `id` (minted on first inspector draw; the server keeps it), `target` (a `CreatureDefinition`), `groups` |
| `EvolutionRequirementGroup` | `requirements` — all must pass |
| `EvolutionRequirementEntry` | `type` (`EvolutionRequirementType` from the compat package), then only the field that type reads: `minLevel`, `item` + `consumeItem`, `condition`, `areaKey` |

Groups are OR; requirements inside a group are AND. "Level 30" **or** "holding a Fire Stone while
Burned" is one rule with two groups.

Requirements carry no ids. A push replaces them under their rule.

## The inspector

Open any creature asset. The **Evolution** foldout (drawn by `CreatureEvolutionSection`) shows the
rule count in its header and lists rules top to bottom in priority order.

- **+ Add evolution rule** appends a branch to another target. Per rule, **▲ / ▼** reorder it and
  **Remove** deletes it.
- Per rule: an asset picker for the target species, then the groups. **+ Add OR group** adds a
  branch; **Remove group** removes one (disabled while it is the only group).
- Per group: "Group N — all of:", the requirement rows, **+ Add requirement**.
- Per requirement: a type dropdown (`Minimum level` / `Held item` / `Status condition` / `In area`,
  paired positionally with `EvolutionRequirementType` so the two can never drift), then only that
  type's fields — a switch in `CreatureEvolutionSection.DrawRequirement` decides which.
- **In area** offers a dropdown of area keys: the scene basenames under `Assets/CR/Scenes/Areas`
  (`_`-prefixed scenes excluded), the vocabulary `trainers.last_area_key` uses.

Validation is inline and red, never silent: `EvolutionRuleValidation.Validate` runs against the
same DTOs a push would send and reports a missing target, a target equal to the species, a rule
with no groups, an empty group, `minLevel < 1`, a null item / condition / empty area key, and a
duplicate requirement in a group — a second minimum level always (a creature has one level), and a
held item / status condition / area repeated with the *same* reference; two different held items in
one group stay authorable, since an unsatisfiable AND is the author's business, not a shape error.
Separately, `EvolutionCycleCheck.FindCycle` walks
species → targets across every `CreatureDefinition` in the project and flags a loop that includes
the open asset. That graph is cached and rebuilt on a Layout pass at most every two seconds, then
patched with the open asset's own (possibly unsaved) edges on every call — the inspector never
scans the AssetDatabase per repaint.

## Content Studio

The **Creatures** tab shows a `⇢ N` badge (`ContentStudioTool.cs`, e.g. `⇢ 2`) on every species
with at least one rule, tooltipped "Evolution rules on this species" — a rule *count*, not a
target name. Unpushed rule edits count in the work pill like any other creature field.

**Push** sends every creature first, then a second pass sends every species' rules to
`PUT /api/v1/creatures/by-content-key/{contentKey}/evolution-rules` — *every* species, including
the ones with no rules: an empty list is how a deleted last rule reaches the server. Push runs
`EvolutionRuleValidation.Validate` first and refuses the step with the same messages the inspector
shows; the server answers a 400 with `errors[]` for anything it disagrees with and a 409 naming a
target species it cannot find.

**Pull** fetches `GET /api/v1/evolution-rules` once, groups the rules by `creatureContentKey` and
writes them onto every provider creature through `EvolutionRuleSoMapper.ApplyDtos`. Targets,
items and conditions are resolved by id through the definitions provider; a rule whose target is
not a known asset is dropped and counted in the status line.

**Revert** on a creature row in the Review window pulls that species' rules with the creature.
**Diff** shows rule changes because the server copy it diffs against now carries the species' rules:
`ContentReviewWindow.BuildDiff` compares the asset's JSON with a clone that `ApplyServerCopy` filled,
and for a creature that clone is now run through `FetchEvolutionRulesFor` +
`EvolutionRuleSoMapper.ApplyDtos`. (`ServerCreatureDto` itself has no `evolutions` field.)

## Getting rules offline

The offline floor is baked from migration seeds and nothing else. Pushing updates the server;
offline play does not see a rule until it is a seed:

1. Author, then **Push** (so the server and the assets agree on ids).
2. Creatures tab → **Export seed** (or `CR/Content/Export Evolution Rule Seed Migration`). This
   writes `cr-api/Creatures/CR.Creatures.Data.Migration/M<version>SeedEvolutionRules_<date>.cs` (M13005 today) —
   regenerated in place; the version stays the highest in the repository, which is also what makes
   the client adopt the freshly baked floor. "Already up to date" means the assets and the file
   agree byte for byte.

   :::note The number is global, not per domain
   `SeedMigrationFileWriter.HighestMigrationVersion` scans **every** domain's migrations and takes
   the next free number, which is why a Creatures seed can land in Moderation's 13xxx band (M13005
   did). Every migrator shares one `VersionInfo` table, so a number used once is gone: a
   hand-written migration must check the whole repository for its next number, not just its own
   domain folder.
   :::
3. Rebuild the compat package: `cd cr-api/Convenience/CR.Game.Compat && ./build-packages.sh`.
4. `CR/Content/Rebake Offline Floor`.

The seed upserts rules by their authored id, replaces requirements with deterministic ids, and
retires any rule of a covered species that the export no longer lists — so deleting a rule in the
inspector reaches offline play through the same export. The generator
(`EvolutionRuleSeedMigrationGenerator`, `CR.Game.Battle.Logic`) is pure and its text is pinned
by tests.

## Runtime sync

The online cache pulls rules through `ServerContentSyncService.SyncEvolutionRulesAsync`
(`ContentDomain.EvolutionRules`) from the same `GET /api/v1/evolution-rules`, writing
`evolution_rule` / `evolution_requirement` directly and retiring rules the server no longer
returns. Offline evaluation reads the baked floor through `IEvolutionRuleRepository`, the same
evaluator the server runs.

## In game

- After a battle, **the whole team** is checked — not only the creatures that levelled — and the
  first the server offers plays the cutscene. `EvolutionReadySweep` runs the same check ~2s after
  world init, which is what catches a creature that crossed its threshold outside a fight (an
  operator's XP grant, an experience item, a creature acquired above its level). From the bag, using
  a `TriggerEvolution` item on a roster creature plays it straight from the offer on the item-use
  result. See [Evolution → Who gets asked](../backend/16-evolution.md).
- **It is staged in an arena.** `EvolutionStageDirector` teleports the player onto a battle arena's
  trainer mark, stands the creature on the creature anchor, hands the camera to
  `BattleCinematicDirector` **and then asks for a shot** — `IBattleCameraController.FocusOn(subject)`,
  which aims the rig's `Hero` role (its single-creature shot, the one the victory beat uses) at the
  creature and holds it. That call is not optional decoration: `EnterBattle` deliberately starts
  *dormant*, leaving every battle camera disabled so the Brain keeps showing the overworld until a
  battle cue arrives, and an evolution raises no cues. Without `FocusOn` the entire cutscene played
  under the overworld follow camera — the creature was somewhere down there while the camera watched
  the player's back. The shot moves to the new species on the first `Reveal` frame, because the old
  model is switched off underneath it and a camera following a disabled transform frames nothing.
  Then it runs five beats — arrive, charge, blend, reveal, depart — from
  `EvolutionStagePlan`. The effect spawns on **charge**; the old model shrinks away as the new one
  grows in through **blend**; the new species is held through **reveal**.
- **Which arena.** Arenas live *inside area scenes* — Meadow carries `meadow-arena`, Crags carries
  `crags-arena` — so the only arena loaded at any moment is the one belonging to the area the player
  is standing in. `EvolutionStageChoice.ResolveArena` therefore treats the authored key as a
  *preference*: it is used when that arena is loaded, and otherwise the evolution is staged in
  whichever arena is here, which is the same arena the player's battles use. Leave `defaultArenaKey`
  empty to always mean "wherever they are".

  This was a live bug worth remembering. The director used to insist on its configured arena, and
  the shipped default named `sandbox_arena_1` — an arena that exists in no area scene. The condition
  "preferred arena not loaded" was therefore *always* true, every evolution silently fell through to
  the flat 2D overlay, and the staged cutscene never ran once. A default that names something
  nonexistent fails as a total outage, not as a wrong choice.
- **What an author controls** lives in `Assets/CR/Resources/Evolution/EvolutionPresentationConfig.asset`:
  the default arena, per-species arena overrides ("this one evolves in *that* arena"), one effect
  row per `ElementType`, and the five beat lengths. Effects are referenced through the asset rather
  than from code, so replacing a placeholder is an inspector drag with no rebuild. The effect follows
  the element of the species being evolved **into** — the moment is about what it becomes — falling
  back to the old element when the new one cannot be read.
- **The titling is the arrival banner's card.** The same `EvolutionOverlay.uxml` serves both
  presentations, and `.evolution-root--staged` rewrites it: the backdrop clears, the species icons
  and the progress track go away, and what is left is the name card the game already shows when you
  walk into an area — same ground (`rgba(8,10,18,0.72)`, radius 4), same bold letter-spaced line,
  same accent rule beneath it — sitting in a band in the lower third so it never covers the creature
  the camera is holding. The `What?` headline is dropped when staged: it is the fallback panel's
  opening beat, where it is the only thing on screen, and the headline stays empty until the closing
  line.
- **The staged card's sizes come from code, not from USS.** This panel scales its pixels against
  screen **width**, so a card authored in px grows with the width of the monitor until it is a slab
  — the bug that cost the arrival banner a rewrite. The evolution card shares that maths rather than
  rediscovering it: `AreaBannerLayout.For(bandHeight)` drives font size, padding and the rule, with
  the band itself a percentage of screen height (`70%` top, `BandHeightFraction` tall) applied on
  `GeometryChangedEvent`. The prompt below it is sized from the same font at `0.42`.
- **The blend is a placeholder.** Old scales out, new scales in, under the effect's peak. A true
  cross-dissolve needs a shader across creature materials the project does not own yet; the effect
  covers the seam, and swapping it later touches only those lines.

:::caution The player is a spectator, and must not be strandable
While it plays, the UI context is `Cutscene`: `UIContextRules` gives gameplay input to nobody, and
`EncounterSuppression` holds off every spawner, which previously had no such flag at all — the only
thing keeping a wild battle out of a cutscene was the player happening not to walk into a trigger.

Because it teleports, a crash mid-cutscene would leave the player inside an arena with no walking
route home. `EvolutionReturnPoint` is written to storage **before** anything moves and cleared only
once they are back, so a point still there at world init means the last session ended mid-evolution,
and `EvolutionReturnRescue` puts them back. A point belonging to another area is kept, not deleted —
they may load into that area later and still need it.

Teardown runs in a `finally` behind a fade: a cutscene that throws must not leave someone parked in
an arena with no input and no encounters, which is indistinguishable from a hang.
:::

- **Timing matters at the battle seam.** Candidates are raised on `BattleClosed`, not when the
  summary's button is pressed. `CloseBattle` tears the battle's arena down and hands the camera back
  asynchronously, so raising them earlier put the cutscene's `EnterBattle` in a race with the
  battle's `ExitBattle` over the same Cinemachine hand-off.
- Where no arena is loaded **anywhere**, the director declines and the original 2D overlay plays instead — the
  evolution still happens. That overlay strobes the old and new species icons, the cycle shrinking from
  `EvolutionStrobe.SlowPeriod` (0.9s) toward `EvolutionStrobe.FastPeriod` (0.14s) as
  `EvolutionStrobe.Period(progress)` reads the fill, with `ShowsTarget(phase, progress)` deciding
  which sprite is up each half-cycle. The hold-to-cancel track runs on `UI/Cancel`.
- Copy comes from `EvolutionCopy`: the headline "What?", then "{name} is evolving!",
  "{fromName} evolved into {toName}!", "{name} stopped evolving.", and a refusal sentence shared
  word for word with the server's `TriggerEvolutionHandler` — "It is holding something that stopped
  it changing." for a Bindstone, "It can't evolve here." for a rule gated on an area the creature is
  not in, and "{item} has no effect on this creature." otherwise. `EvolutionCopy.Refusal` is the
  only copy of those sentences on the client; the level-up path's toast calls into it rather than
  keeping a second one, and stays silent on the area case (nothing the player did prompted the
  check). `{name}` is the nickname when the player set one, else the species display name —
  `EvolutionDisplayName.For` decides, reading the `GeneratedCreature` the presenter loads alongside
  the two species rows.
- On dismiss `EvolutionEvents.Completed(creatureId, newBaseCreatureId)` fires and the team roster
  and bag refresh.

## Related

- [Evolution (backend)](../backend/16-evolution.md) — the tables, the evaluator, the triggers
- [ScriptableObjects](./12-scriptable-objects.md) — `CreatureDefinition`
- [Content Sync](./27-content-sync.md) — push/pull mechanics shared by every tab
- [Area Scenes](./22-area-scenes.md) — where area keys come from
