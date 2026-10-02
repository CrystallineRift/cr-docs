# Quest Editing

A quest template's objectives, rewards, and requirements each store a free-text
`targetReferenceId` / `referenceId` / `referenceId` column that the server never validates — it is
simply compared, later, against whatever key the game client or a domain service emits for that
particular type. Studio web's job is to put the *right* picker on that cell for each type, pointed
at the *right* identity (a content key, or occasionally a GUID), so an operator can't type a value
that will silently never match. For the template/instance data model and the objective/reward/
requirement enums themselves, see [Quest System](../backend/07-quest-system.md).

## Objective target, by type

| Objective type | Target cell | Identity |
|---|---|---|
| 0 Defeat creature, 4 Capture creature, 8 Reach creature level | Creature (empty matches any) | **creature content key** — `QuestManager.RecordProgress` reports the base creature's content key |
| 2 Deal damage of type | Element (empty matches any) | the `ElementType` **name** as a string (no emitter yet; authored as a hint) |
| 9 Defeat creatures from a list | Creatures (comma-separated) | content keys, `targetReferenceIds` |
| 10 Visit location | Location (empty matches any) | **world-location content key** — `LocationEntryService` reports `Location.ContentKey` |
| 11 Talk to NPC | NPC (empty matches any) | **NPC content key** |
| 20 Collect item, 21 Activate key item, 22 Used item | Item (empty matches any) | **item content key** — see "The id/key bug", below |
| 30 Complete quest | Quest | **quest content key** |
| 40 Defeat trainer | Trainer (empty matches any) | a typed trainer-battle content key (no trainer-battle resource here yet, so it's text, not a picker) |
| 42 Defeat trainers from a list | Trainers (comma-separated) | trainer-battle content keys |
| 50 Reach talent rank | Talent key (empty matches any) | a typed talent content key (talents are nested inside talent-trees, so there's no flat resource to pick from either) |

An empty target on any of the "(empty matches any)" rows matches any instance of that type — a
`Defeat creature` objective with no creature picked completes on defeating *anything*.

## Requirement and reward targets

Requirements compare by **GUID**, not content key, for every reference type (`QuestCompleted` →
quest id, `HasItem` → item id, `CreatureLevel` → creature id) — `ConditionEvaluator` reads the
template row by its real id, not by a designer-facing key, and the upsert route also accepts a
quest *content key* and resolves it to the id for you. Rewards split the other way: a reward's
`Item` target is an item **content key**; a reward's `Creature` target is, perhaps surprisingly, a
**spawner** content key, not a creature key — `RewardGrantService` resolves it through
`GetSpawnerTemplateByContentKeyAsync`, because what actually gets handed to the player depends on
that spawner's pools.

## The id/key bug (fixed)

Objective types 21 (Activate key item) and 22 (Used item) used to point their target picker at
items **by id** (GUID), the same way requirements do. That was wrong: `ItemUseDomainService` emits
`ItemUsed` / `KeyItemActivated` outcomes with `SubjectKey = item.ContentKey` — the GUID only travels
as `SourceId` — and `QuestObjectiveProjector.TargetMatches` compares `TargetReferenceId` against
that *content-key* subject. A quest authored with the id picker could never advance, because a
stored GUID never equals a content key; only leaving the target blank ("matches any") worked. Both
objective types now use the same item-by-content-key picker as objective 20 (Collect item). An
older template that still stores a GUID in one of these two fields shows as `key (not found)` in the
picker rather than being silently kept as if it were valid — re-pick the item to fix it.

## `targetMetadata` / reward `metadata`

Both columns are persisted and echoed back by the server, and the `typedMeta` kind (see
[Content Editing](01-content-editing.md)) is wired up to show a per-type form the same way an
item's `effectParameters` does — but as of this rewrite **no objective type or reward type on
cr-api parses metadata at all**: the objective projector, the lifetime-stat projector, the
condition evaluator, and the reward grant service read only `type` / `count` / the reference id(s)
/ `quantity`. So every type's spec is currently empty, and the cell is hidden entirely unless an
older row already has something stored in it — which is shown as a raw-text field with a warning,
kept until cleared, rather than dropped. Adding a parsed shape for a type server-side is a one-line
spec addition here once that lands.
