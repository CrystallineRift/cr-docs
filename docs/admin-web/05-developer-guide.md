# For Developers: Adding a Field or a Resource

The canonical reference for this is `cr-admin-web/src/components/editors/README.md` — read it
alongside this page; this page is the map, that file is the API doc. See
[Content Editing](01-content-editing.md) for the designer-facing result of what's below.

## Adding a field to an existing resource

Most of the time you are not writing a new editor — `fieldsFromSchema` (`src/lib/zodFields.ts`)
already infers a control from the zod schema: a deep object becomes `object`, an array of objects
becomes `rows` (columns inferred from the item schema), a `z.enum` becomes `select` with the
enum's own values as options. A descriptor's `fields: FieldMeta[]` only needs to *override* what
can't be inferred — a label, a reference target, a visibility rule:

```ts
import type { FieldMeta } from "../types";

const fields: FieldMeta[] = [
  { path: "version", readOnly: true },
  { path: "entry", kind: "siblingRef", siblingRef: { path: "document.nodes", idField: "id" } },
  {
    path: "nodes",
    kind: "rows",
    rowNoun: "Node",
    summary: "{id} · {type} · {text}",
    collapsed: true,
    newRow: (existing) => ({ id: `n${existing.length + 1}`, type: "line" }),
    fields: [
      { path: "type", label: "Type" }, // enum → select automatically
      { path: "text", kind: "textarea", showWhen: { column: "type", in: ["line"] } },
    ],
  },
];
```

A path on a sub-field (inside `fields:`) is **relative to the object or row**, and dotted through
nested objects/lists **without indices** — `nodes.options.next`, not `nodes.0.options.1.next`. A
recursive shape (a dialogue condition's `children`, which is a list of the same condition type)
names its own override list through a thunk — `fields: conditionFields` where
`conditionFields = () => [ ... ]` — rather than inlining it, so the recursion terminates at the type
level, not at runtime.

### `FieldKind` vs `ColumnKind`

A top-level `FieldMeta.kind` is a `FieldKind` (`text`, `number`, `boolean`, `select`, `textarea`,
`json`, `assetKey`, `reference`, `rows`, `object`, `siblingRef`, `map`, `typedParams`, `flags`). A
sub-field or row column's `kind` is a `ColumnKind` — most of the same names, plus `list` and
`numberList` (comma-separated primitives) and `typedMeta`, which only make sense nested. Both are
defined in `src/resources/types.ts`; read the doc comment on each `FieldMeta`/`RowColumn` member
there before adding a new one — most members only apply to specific kinds, and the comment says
which.

### Rules the editors already enforce — don't re-implement them

- **Round trip.** Don't hand-roll a "rebuild the object from form values" step; the generic editors
  copy structures and only touch the member actually edited, so an unmodelled member survives.
- **Enums.** Never hand-type `options` for a `z.enum` member — leave `kind` off (or set it without
  `options`) and the select derives them from the enum itself, so adding an enum value server-side
  doesn't require also updating a hand-written options array here.
- **Clearing.** `nullable` / `optional` are inferred from the zod wrapper (`.nullable()` →
  clears to `null`; `.optional()` → clears by deleting the key). Only set them by hand when the
  schema itself is `z.unknown()` at that path.
- **References.** Use `kind: "reference"` + `ref: { resource, valueField }` rather than a plain
  text field with a comment saying what key it should be — the whole point of the rewrite in this
  codebase is that the picker enforces the right identity (content key vs GUID) instead of trusting
  free text. See [Quest Editing](04-quest-editing.md#the-idkey-bug-fixed) for what goes wrong when
  a reference points at the wrong `valueField`.

## Adding a new resource descriptor

A resource is one object matching `ResourceDescriptor<T>` (`src/resources/types.ts`):

```ts
export const descriptor: ResourceDescriptor<Guild> = {
  key: "guilds",              // route segment: /<group>/<key>
  label: "Guilds",
  group: "content",           // or "combat" — which section it sits in
  idField: "contentKey",
  mode: "per-item",           // or "sync-all" for a whole-set-at-once resource
  list: () => api<Guild[]>("/api/v1/guilds?offset=0&limit=500"),
  save: async (item) => { await api("/api/v1/guilds/bulk", { method: "PUT", json: [item] }); },
  remove: async (id) => { await api(`/api/v1/guilds/by-content-key/${id}`, { method: "DELETE" }); },
  columns: [ /* @tanstack/react-table ColumnDef[], for the list screen */ ],
  schema: guildSchema,        // zod, .loose() so a server-added field round-trips untouched
  fields: [ /* overrides, as above */ ],
  blank: () => ({ /* a new-item template matching the schema's defaults */ }),
};
```

Then register it in `src/resources/registry.ts` so the list/detail routes and any
cross-resource `reference`/`siblingRef` target can find it. A resource whose catalogue is too large
to list in one page adds `search: (query) => Promise<T[]>` so `ReferencePicker` queries it instead
of filtering a cached list (the same two-character minimum the live pages use).

### Test pattern

Every resource has a `descriptor.test.ts` that renders the real descriptor against a realistic
fixture and asserts the round trip, plus `form.test.tsx` (or the shared harness below) for the
editors. The harness used throughout the editors themselves is
`renderFieldsForm(schema, fields, initial)` in `src/test/referenceResource.tsx` — it renders exactly
what `ResourceForm` would for those fields, prints the current values to
`data-testid="form-values"`, and gives you a Save button that runs validation. Use it for a
component-level test; use the real descriptor (as `dialogues/document.test.ts` and
`items/descriptor.test.ts` do) when you want to prove the *actual* shipped fields, not a synthetic
schema, round-trip and validate correctly.

A new array-of-objects member on an existing schema will be inferred as `rows` automatically (this
was a deliberate change from the old default of `json`) — say so in any handoff to another agent or
teammate working the same descriptor, since it changes what a field renders as with no explicit
opt-in.
