# Content Editing in the Web Studio

`cr-admin-web` ("Studio web") edits the same content tables as Crystalline Rift Studio (the Unity
editor), through the same REST routes, from a browser. Every content type — items, creatures,
quests, dialogues, abilities, loot tables, spawners, and the rest — is described once, as a
**resource descriptor**, and two generic screens (a list, a detail/edit form) render whatever that
descriptor declares. A descriptor is a `.ts` file: a zod schema (the shape and the validation), a
table of columns for the list, and a `FieldMeta[]` that says how each field should be edited. Adding
a field to an existing resource, or a whole new resource, is almost never a new UI component — see
[For Developers](05-developer-guide.md).

This page covers the parts every resource shares: the form, the list, and the catalogue of editor
kinds a designer meets while filling one in. For the three content types with their own authoring
rules, see [Dialogue Editing](02-dialogue-editing.md), [Item Editing](03-item-editing.md), and
[Quest Editing](04-quest-editing.md).

## The detail / edit form

A resource's detail screen has a header (**← Back**, the title, record actions such as Duplicate or
Delete), a scrolling body, and a **pinned footer** that never scrolls out of view holding the save
state, **Cancel**, and **Save**.

- **Sections.** Fields are grouped by the descriptor's `group` into labelled sections with a
  divider between them. Within a section, fields sit in a two-column grid; a field whose editor is
  inherently block-shaped (`rows`, `object`, `map`, `textarea`, `typedParams`, a multi-reference
  chip list, or any field switched to raw JSON) spans both columns instead of sharing a row.
- **Validation summary.** A failed Save does not just redden fields — a summary panel above the
  footer lists every failing leaf by path (`Entries › #2 › Quantity — At least one.`). Each line is
  a button: clicking it scrolls to and focuses the actual invalid control, however deeply nested.
  (A failing field inside a *folded* row card is a known gap — the jump lands on the card, not the
  unfolded cell; unfold the row by hand to see it.)
- **Advanced tab.** Next to **Form** is an **Advanced** tab: the whole record as raw JSON, still
  validated against the same schema. It exists for two reasons — a value the structured editors
  cannot represent (a legacy or hand-written blob; see [Item Editing](03-item-editing.md) for the
  common case), and a quick multi-field edit an experienced operator would rather type than click
  through. Switching back to Form is disabled while the JSON does not parse.
- **Per-field raw-JSON toggle.** Independent of the Advanced tab, every `object`, `rows`, and `map`
  field has its own small "Raw JSON" toggle beside its label, off by default, so one stubborn field
  can be hand-edited without leaving the structured form for everything else. The toggle back to the
  structured editor is disabled while that field's text does not parse.
- **Read-only mode.** A descriptor with no `save` (and no `syncAll`) renders the same layout with a
  **Read-only** pill, every control inert, and **Close** instead of Save. A field with no editable
  control in this mode (because there is nothing to edit) shows its value as a definition list,
  table, or chip row — never raw JSON punctuation.
- **Round trip, by construction.** Opening a record and saving it with no edits sends back exactly
  what was loaded: objects and rows are copied, never rebuilt, so a member no editor covers survives
  unchanged. A cleared control stores `null` for a schema-nullable member, removes the key for a
  schema-optional member, and `""` / `0` otherwise — matching whatever shape the server itself
  writes. Enum selects always list the zod enum's own values; a stored value outside them renders as
  `value (unknown)` and is never silently rewritten.

## List screens

Every resource's list page shows a count pill that follows the active filter (`1 of 500`), a filter
box you can jump to by pressing **`/`** anywhere on the page and clear with **Escape** or an inline
✕, and a primary **+ New** button (hidden for a read-only descriptor). Two distinct empty states:
**no rows at all** ("No creatures yet." + *Create the first one*) and **no rows match the filter**
("No creatures match “x”." + *Clear filter*) — so an empty catalogue and an over-narrow search read
differently. Table rows open their detail screen on click or **Enter**.

## The editor kinds

A descriptor's `FieldMeta` (top level) or `RowColumn` (inside a `rows`/`object` field) names a
`kind`; `ResourceForm` and `RowsEditor` pick the control. Most of a descriptor's fields need no
`kind` at all — `fieldsFromSchema` infers one from the zod shape (a deep object → `object`, an array
of objects → `rows`, an enum → `select`) and the descriptor only overrides what needs a label,
reference target, or visibility rule.

| Kind | Renders | Notes |
|---|---|---|
| `text` / `number` / `boolean` / `textarea` | A plain input | `number` takes `min`/`max`/`step`, enforced in the browser the same way zod enforces them server-side |
| `select` | A dropdown over a zod enum's own values | Never hand-typed for an enum member — leave `kind` off and the options derive automatically |
| `reference` | `ReferencePicker`: a searchable dropdown over another resource | Leads with the operator's last 5 picks for that target, links **Open ⟶** to the picked row's own detail screen in a new tab, and prints the stored key under the chosen name. `multiple: true` edits an array of keys as removable chips. Clear stores the schema's blank (`null` if nullable, else `""`). A stored key the catalogue does not carry renders as `key (not found)` and is kept, not swapped. |
| `siblingRef` | `SiblingRefSelect`: a dropdown over the ids of *another array in the same record* | Reads that array live from the open form, so a node added a moment ago is already pickable. Used for a dialogue node's `next`, a document's `entry`, and similar in-record links. An id the sibling list no longer carries shows as `id (not found)`. |
| `assetKey` | `AssetKeyPicker`: a text field with the Addressables catalogue (`GET /api/v1/game-assets`) as suggestions | Free text stays allowed — content is often authored before the asset exists — but a key outside the catalogue is flagged "not in the asset catalogue — still stored." |
| `rows` | `RowsEditor`: one card per array element | Add, remove (confirms when the row has content), reorder by drag or **Alt+↑/↓** (focus follows the row), duplicate, and collapse to a one-line `summary` template. Columns are given explicitly or inferred from the row's zod schema. |
| `object` | `ObjectEditor`: a collapsible card | Controls inferred from the nested zod object schema, refined by a `fields` override list given relative to the object. |
| `map` | `MapEditor`: a `Record<string,string>` | Known keys (`mapKeys`, or `mapKeysBy` keyed off a sibling column) render as labelled fields above a free-form key/value row list for anything else; unknown keys are preserved. |
| `flags` | `FlagsEditor`: a bitmask integer as one labelled checkbox per bit | `options` name the bits; a `0` entry reads as "none"; a bit the descriptor does not name is kept, never dropped, on save. |
| `typedParams` | A sub-form chosen by a sibling discriminator field | How an item's `effectParameters`/`triggerParameters` are edited — see [Item Editing](03-item-editing.md). |
| `typedMeta` (row column only) | The same idea, one row-column cell at a time | How a quest objective's/reward's `metadata` is (not yet) edited — see [Quest Editing](04-quest-editing.md). |
| `json` | A plain JSON textarea with the parse error shown inline | The fallback for a shape with no structured control, and for any string the typed editors above cannot represent. |

See `cr-admin-web/src/components/editors/README.md` for the field-by-field API (`FieldMeta`,
`RowColumn`, `ReferenceTarget`, `SiblingRef`, `MapKeySpec`) that a descriptor writes against.
