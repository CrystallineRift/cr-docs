# Item Editing

An item's `effectParameters` and `triggerParameters` are each a JSON string whose shape depends on
a sibling field — `effectType` for the first, `triggerType` for the second. Studio web edits both
with the `typedParams` kind (see [Content Editing](01-content-editing.md)): pick the type, and the
form below it becomes exactly the parameter class that type's handler deserialises on the server.
For the server-side model — the `item` table, the enums, and what each effect actually does in
battle — see [Item Effects and Status Cures](../backend/19-item-effects.md).

## How the typed form works

- **Mirrors the server class.** Each variant's fields mirror the C# parameter class
  (`cr-api` `CR.Game.Model.Items.EffectParameters/*.cs`) field for field, with the server's own
  defaults as the starting values — a type switch resets the parameters to that type's defaults,
  not to empty. Enum fields (`Stat`, `Calculation`, `ElementType`, threshold `direction`) render as
  selects with humanised labels ("Special Attack", "Add % of current").
- **Reference pickers, not free text.** `CureStatus` and `HeldStatusImmune` take a list of status
  conditions; because the server matches those by `name` case-insensitively, the field is a
  multi-reference chip picker over the `status-conditions` resource by name, not a typed list.
- **Serialisation is byte-compatible with the seed migrations.** Saving writes every schema key, in
  schema order, camelCase, compact JSON (`{"amount":200,"percent":false}`) — the same string shape
  `EffectParameterSerializer` and the content migrations already use. A type with no parameters
  (see below) serialises to `null`.
- **Reads tolerate the server's own leniency.** Keys are read case-insensitively, `Stat` aliases
  (`hp`, `spa`, `spd`, …) and numeric/ordinal values are canonicalised on load, and a key the stored
  JSON omits is filled from the class default — all mirroring what `EffectParameterSerializer`
  itself accepts. None of this is written back until something is actually edited.

## Effect and trigger types with no parameters

These `effectType` values show "*X* takes no parameters." instead of a form — their handler class
has no fields:

`None`, `Restore Full HP`, `Cure All Status`, `Level Up`, `Trigger Evolution`, `Capture Creature`
(reads `captureModifier` on the item itself, not on the effect), `Held: Revive Once`.

Both `triggerType` values `None` and `On Faint` are likewise parameterless; `On Condition Applied`
and `On Stat Stage Threshold` are the two that take a form.

## When the structured form steps aside

A stored `effectParameters`/`triggerParameters` string can defeat the typed form in a few ways —
it predates this rewrite, was hand-edited, or targets a type the current descriptor has no variant
for. In every case the string is kept **byte for byte** and shown as a plain, validated textarea
instead of the typed fields, with a reason attached (unknown field, not an object, duplicate key, a
key the server's class doesn't have, or an unmapped discriminator value). Nothing is silently
dropped or rewritten:

- An **"Edit as JSON"** toggle sits on every typed form regardless, for an operator who wants to
  paste a value directly.
- Once a raw value parses and matches a known shape, **"Use form"** appears to switch back — it
  never jumps in on its own while you're still typing.
- A value that parses but fails the variant's own schema (wrong type on a known key) stays on the
  form with an inline error on that field and blocks Save until it's fixed or reverted.

This is the same escape hatch described generally in
[Content Editing](01-content-editing.md#the-detail-edit-form) — items are simply the resource
where a typed field, rather than a whole record, is the thing that can fall back to raw JSON.
