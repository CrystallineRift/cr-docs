# Dialogue Editing

A dialogue's `document` — the graph a player actually walks through — is a nested JSON object
mirroring `CR.Dialogue.Model` exactly as the server's `DialogueJson` serialises it: camelCase
members, enums written as camelCase strings, `null` members omitted on write. Studio web edits that
graph through the shared structured editors (see [Content Editing](01-content-editing.md)) rather
than a free textarea, with validation still owned by the server.

For how the document format and runner behave at play time, see
[Dialogue System](../unity/31-dialogue-system.md); for what the server checks on save, see
[Dialogue Domain](../backend/21-dialogue-domain.md).

## Layout

Opening a dialogue shows **Version** (read-only), **Entry node** (a `siblingRef` picker over the
document's own `nodes`), then two row lists:

- **Speakers** — one row per speaker: `id`, `kind` (`player` / `npc`, an enum select), an NPC
  reference (shown only when `kind` is `npc`, picked from the `npcs` resource by content key), and
  a display name. Folded, a speaker row reads `{displayName} ({id}) · {kind}`.
- **Nodes** — one row per node, collapsed by default to `{id} · {type} · {text}`. The visible cells
  change with the node's `type`:
  - `line` — **speaker** (`siblingRef` into Speakers, labelled by display name), **text**
    (textarea), **next** (`siblingRef` into Nodes).
  - `choice` — **options**, a nested row list: each option has `id`, `text`, `conditions`,
    `actions`, and `next`.
  - `branch` — **cases** (each a condition plus a `next`) and an **else** fallback.
  - `action` — **actions** to run, then `next`.
  - `end` — an **outcome** select (`completed` / `declined`).
  - Every node type also carries a free **note**, for the author, never read by the game.

### Conditions and actions

A condition or action row has a **type** select, listing the handler types the dialogue system
actually understands (read from `cr-api-unity/Assets/CR/{Quests,Npcs,Progress}/Dialogue/*` —
`quest.accept` / `quest.claim` / `quest.recordTalk`, `npc.openShop`, the composite `all` / `any` /
`not`, `quest.state` / `quest.objectivePending` / `quest.objectiveCount`, `progress.requirement`,
`npc.trainerDefeated`), plus its **args**: a `map` field whose known keys change with the selected
type — a quest or NPC or item reference picked by content key where the handler expects one,
otherwise a plain select for things like `is` / `kind` / `op`. A composite type (`all`/`any`/`not`)
shows a nested, recursive **children** list of the same condition shape instead of args.

## The legacy document field

Before this rewrite, `document` was edited as one free JSON blob, and some dialogues were written
or hand-patched that way. Two consequences:

- The schema behind the structured editors is `.loose()` at every level, so a field the server adds
  later — or one this schema simply doesn't model — round-trips untouched rather than being dropped
  on save.
- A document whose JSON does not match the shapes above at all (wrong casing, an unrecognised node
  or condition `type`, a non-string arg value the server would reject anyway) is not silently
  coerced. It is kept exactly as stored, and the mismatched piece is editable from the **Advanced**
  tab (the whole record as raw JSON) until it is hand-fixed — the structured editors never discard
  or rewrite a shape they don't recognise.

Saving always goes through the server's own validator (`DialogueValidator`): a save can succeed
with warnings (an unreachable node, a node with no way in) that are shown as toasts after the
"Saved" confirmation, or fail with field-level errors that land on the exact node, option, or
condition they're about.
