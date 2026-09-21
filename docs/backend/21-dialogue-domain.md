# The Dialogue Domain (Server)

The server side of [The CR Dialogue System](?page=unity/31-dialogue-system): a content domain that
stores authored conversation documents, validates them on write, and serves them to the running
game. Not merged, not deployed, not playtested — see that page's Status section for what is still
missing.

## Projects

Follows the project's usual per-domain layering (see [Domain module
structure](?page=backend/01-architecture)):

| Project | Role |
|---|---|
| `CR.Dialogue.Data` | `DialogueEntity`, `IDialogueRepository`, `BaseDialogueRepository` (every SQL statement, shared by both engines) |
| `CR.Dialogue.Data.Postgres` / `CR.Dialogue.Data.Sqlite` | Connection-only subclasses of `BaseDialogueRepository` |
| `CR.Dialogue.Data.Migration` (+ `.Postgres`) | `M14001CreateDialogueTable`, the migration runner |
| `CR.Dialogue.Model` | The document model, `DialogueValidator`, `DialogueLimits`, `DialogueJson` — shared with Unity, compiled netstandard2.1 |
| `CR.Dialogue.Runtime` | `DialogueRunner` and the rest of the playback engine — also shared with Unity |
| `CR.Dialogue.Domain.Services` | `IDialogueDomainService`, `ServerDialogueVocabulary` |
| `CR.Dialogue.Model.REST` | Request/response DTOs |
| `CR.Dialogue.Service.REST` | `DialogueEndpoints` |

## The `dialogue` table (M14001)

```csharp
Create.Table("dialogue")
    .WithColumn("id").AsGuid().PrimaryKey()                 // Postgres: SystemMethods.NewGuid default
    .WithColumn("content_key").AsString(255).NotNullable()
    .WithColumn("name").AsString(255).NotNullable()
    .WithColumn("description").AsString(int.MaxValue).NotNullable().WithDefaultValue("")
    .WithColumn("npc_content_key").AsString(255).Nullable()
    .WithColumn("document").AsString(int.MaxValue).NotNullable()
    .WithColumn("deleted").AsBoolean().NotNullable().WithDefaultValue(false)
    .WithColumn("created_at").AsDateTime().NotNullable().WithDefault(SystemMethods.CurrentUTCDateTime)
    .WithColumn("updated_at").AsDateTime().NotNullable().WithDefault(SystemMethods.CurrentUTCDateTime);

Create.UniqueConstraint("uq_dialogue_content_key").OnTable("dialogue").Column("content_key");
Create.Index("idx_dialogue_npc_content_key").OnTable("dialogue").OnColumn("npc_content_key").Ascending();
```

`isSqlite`-guarded per the project's ANSI-SQL convention, but both branches are currently identical —
the only engine-specific detail (`NewGuid` default on Postgres, none on SQLite) is expressed through
FluentMigrator's own API rather than raw SQL. The `content_key` UNIQUE constraint is
**non-partial — it applies to soft-deleted rows too**, on purpose: the repository revives a
soft-deleted row under its existing id instead of ever inserting a second row with the same
`content_key`, so no filtered/partial index is needed. `npc_content_key`'s index is non-unique:
several dialogues may legally target the same NPC (drafts, work in progress); the repository breaks
that tie deterministically rather than the schema forbidding it.

`document` holds the full canonical JSON — up to `DialogueLimits.MaxSerializedBytes` (256 KB, enforced
in the domain service and REST layer, not by the column type).

## Repository semantics (`BaseDialogueRepository`)

One abstract base holds every SQL statement; `CR.Dialogue.Data.Postgres`/`.Sqlite` supply only the
connection. Every statement uses typed Dapper parameters, including `@deleted`, so no boolean is ever
written as a bare literal.

### Soft delete + revive under the same id

`UpsertAsync`/`UpsertManyAsync` match an incoming entity by `content_key` **regardless of
`deleted`** (`FindByContentKeyIncludingDeletedAsync`) — a soft-deleted row is revived under its
EXISTING id rather than colliding with the UNIQUE constraint on a fresh insert. `DeleteByContentKeyAsync`
sets `deleted = true` and returns whether a live row was actually affected.

### The id rule

`InsertNewAsync` honours a caller-supplied `Id` on first insert (`entity.Id == Guid.Empty ? Guid.NewGuid()
: entity.Id`) — this is what lets a Unity `DialogueDefinition` asset and its server row share one id.
Once a row exists, it is **never re-keyed**: every later upsert for that `content_key` keeps the
existing id no matter what id the caller supplies. The domain service (below) is what turns a
disagreement here into a finding instead of a silent no-op.

### Transactional bulk upsert with one replay on a first-insert race

`UpsertAsync` (single item): on a unique-constraint violation caught outside a transaction, it retries
ONCE as an UPDATE against whatever row another writer's concurrent first-time INSERT just created —
this closes the classic SELECT-then-INSERT race for a brand-new `content_key` without surfacing a 500.

`UpsertManyAsync` (bulk): every entity in the batch is upserted inside ONE connection and ONE
transaction — either every row lands or (any failure at all: a constraint violation, a cancellation)
none do. Unlike the single-item path, **a race is not retried per-row inside the transaction** — once
any statement in a Postgres transaction fails, every further statement on it throws "current
transaction is aborted," so the fix has to be at the batch level: `UpsertManyAsync` catches a
unique-violation from the whole attempt and replays the ENTIRE batch once, on a fresh connection and
transaction. The batch is idempotent by `content_key`, so the second attempt's SELECT sees the other
writer's row and takes the UPDATE path. A second violation propagates as a real failure.

Unique-violation detection is by exception MESSAGE substring
(`"UNIQUE constraint failed"` / `"duplicate key value violates unique constraint"`), not a
driver-specific exception type — this base class is shared by both engines and compiled for
netstandard2.1 for Unity's offline build, so it can never reference either database driver package.

### Ordinal tie-break for an NPC with several dialogues

`GetByNpcContentKeyAsync` fetches up to 16 live candidate rows (`NpcCandidateLimit`) with **no SQL
`ORDER BY`/`LIMIT 1`**, and picks the one whose `content_key` is the `StringComparer.Ordinal` minimum
in C#. This was a deliberate fix: an ORDER BY-based tie-break disagreed between SQLite's BINARY
collation and Postgres's locale collation on case and underscore handling, which meant online and
offline play could resolve a different dialogue for the same NPC. A dedicated test proved this red
ONLY on Postgres before the fix (expected `DLG_AB`, got `dlg_a_b`).

### SQL npc filter, paging

`GetAllAsync(offset, limit, npcContentKey)` applies the `npc_content_key` filter **in SQL**, not in
memory — a filtered page never scans more of the table than the page itself. `limit`/`offset` are
clamped through `CR.Game.Common.PageBounds` (max 500 rows per page, default 100 when non-positive;
negative offset treated as zero). The SQL `ORDER BY content_key` only drives which rows LIMIT/OFFSET
selects (engine-dependent collation, same caveat as the NPC tie-break); each returned page is then
re-sorted ordinally in C# before it comes back, so a single page is internally stable regardless of
which engine served it — paging itself is display-only, not a guaranteed absolute order across pages.

## Why This Design?

### Why validate structure and type vocabulary, but not argument shapes?

`DialogueValidator` lives in `CR.Dialogue.Model` — the assembly shared between cr-api and Unity —
and has no knowledge of what arguments any particular condition/action type expects, only whether the
TYPE STRING itself is one a supplied `IDialogueVocabulary` recognizes. Argument shape (which keys are
required, what kind of value each expects) is owned entirely by the modules that define those types
(`quest.state`'s `quest`/`is`/`giver`, `progress.requirement`'s `kind`/`op`/`value`/…), and a module
lives with its domain, not with the document format. Teaching the shared validator every module's arg
shape would mean the model assembly has to change every time a new dialogue action ships — exactly
the coupling the [core/module separation](?page=unity/31-dialogue-system#why-does-the-dialogue-core-know-nothing-about-quests)
exists to avoid. The cost is real: a missing or misnamed arg passes server-side validation silently.
It is caught instead by the Unity node editor, which DOES know every module's arg shape (it is built
from the same `IDialogueModule` descriptors the game registers) — see [Dialogue Authoring → Findings
the node editor catches that the server does
not](?page=unity/32-dialogue-authoring#findings-the-node-editor-catches-that-the-server-does-not).

## Validation

`DialogueValidator.ValidateSerialized`/`Validate` (`CR.Dialogue.Model/DialogueValidator.cs`) never
throws, even on hostile input — see [The CR Dialogue System](?page=unity/31-dialogue-system#the-document-model)
for the document model itself.

### Every finding code

Every finding code the validator can produce:

| Code | Severity | Meaning |
|---|---|---|
| `document-too-large` | Error | Received or re-serialized bytes exceed `MaxSerializedBytes` (256 KB) |
| `malformed-json` | Error | Null input, or the JSON failed to parse (message carries JSON path/line only, never a CLR type name) |
| `too-many-nodes` | Error | Node count exceeds `MaxNodes` (500) — a hard stop, checked before any graph walk; no other finding accompanies it |
| `null-element` | Error | A list (nodes, speakers, options, cases, actions, conditions, children) contains a null element |
| `duplicate-node-id` | Error | Two or more nodes share an id |
| `no-entry` | Error | `Entry` is blank |
| `entry-missing` | Error | `Entry` does not match any node id |
| `malformed-node` | Error | An undefined `DialogueNodeType`/`DialogueOutcome`/`DialogueSpeakerKind` int value |
| `unknown-speaker` | Error | A node's `Speaker` id does not match any declared speaker |
| `text-too-long` | Error | Node text exceeds `MaxNodeTextLength` (2000 chars) |
| `member-ignored` | Warning | A node sets a field its type does not use (e.g. `Options` on a Line) |
| `line-without-text` | Error | A Line node has blank text |
| `choice-without-options` | Error | A Choice node has zero options |
| `too-many-options` | Error | Choice options exceed `MaxOptionsPerChoice` (20) |
| `option-without-id` | Error | A Choice option has no id |
| `duplicate-option-id` | Error | Two options on the same Choice share an id |
| `too-many-cases` | Error | Branch cases exceed `MaxCasesPerBranch` (20) |
| `dangling-target` | Error | A `Next`/`Else`/option-`Next`/case-`Next` names a node id that does not exist |
| `malformed-condition` | Error | `not` with != 1 child, or `all`/`any` with 0 children |
| `unknown-condition` | Error | A condition type is neither a core combinator nor known to the supplied vocabulary |
| `unknown-action` | Error | An action type is not known to the supplied vocabulary |
| `too-many-args` | Error | A condition/action's `Args` exceed `MaxArgsPerConditionOrAction` (16) |
| `arg-too-long` | Error | An arg key/value exceeds `MaxArgKeyLength`(64)/`MaxArgValueLength`(512) |
| `condition-too-deep` | Error | Condition nesting exceeds `MaxConditionDepth` (8) |
| `unreachable-node` | Warning | A node is not reachable from `Entry` |
| `no-end-reachable` | Error | No End node is reachable from `Entry` |
| `loop-without-choice` | Warning | A cycle exists with no Choice node in it to let the player exit |

**The validator only ever checks that a condition/action TYPE string is known — never its arg
names.** `arg-too-long` is a length check, not a shape check. A required arg being missing, or an
extra arg no module declares, is not a server-side finding at all; that gap is filled entirely
client-side (`DialogueArgDiagnostics`, see [Dialogue
Authoring](?page=unity/32-dialogue-authoring#findings-the-node-editor-catches-that-the-server-does-not)).
This was confirmed by review: all six shipped dialogue documents validate 0 errors / 0 warnings
against the real server validator, even though arg names are never checked there.

Safety rules, from the validator's own doc comment: `too-many-nodes` is checked before any
serialization or graph walk and short-circuits with only that one finding; cycle detection (Tarjan's
SCC) is iterative with an explicit stack so it cannot recurse unboundedly on a hostile graph; every
list read goes through one helper that skips (and reports) null elements instead of dereferencing
them; the size-measuring serialization is wrapped so an over-deep or self-referential document reports
`condition-too-deep` from the graph walk instead of letting a `JsonException` escape.

### Domain-level validation (`DialogueDomainService`)

Beyond the document itself, the domain service validates the row's own fields — content key
(required, ≤255 chars, no whitespace), name (required, ≤255 chars), description (≤4000 chars,
trimmed), NPC content key (≤255 chars). The 255-char caps on content key and name deliberately match
the `varchar(255)` column widths, closing a review finding where a 300-char name passed the earlier,
looser check and then failed mid-batch with a Postgres `22001` (value too long) — after some earlier
items in the same bulk request had already been written, defeating the all-or-nothing guarantee.

### The id findings

- **`id-ignored`** (warning) — the content key already exists under a different id than the one
  supplied; the supplied id was not used. The row is never re-keyed.
- **`id-in-use`** (error) — the supplied id already belongs to a DIFFERENT content key (a
  soft-deleted row still owns its primary key — this check is not fooled by `deleted`).
- **`duplicate-id`** (error, bulk only) — two items in the same bulk request supply the same id.

`IDialogueDomainService.UpsertAsync` (the single-item write path) currently has **no production
caller** — the REST layer's `PUT /bulk` route always calls `UpsertManyAsync`, even for a single-item
array. `UpsertAsync` exists as a complete, independently-tested API surface, not dead code, but
nothing in this branch actually reaches it outside tests.

## Authorization

The three GET routes (`GET /api/v1/dialogues`, `/by-content-key/{key}`, `/for-npc/{npcContentKey}`)
stay on the host's fallback authenticated-user policy — an ordinary player token reads dialogues, the
same as it reads any other content. Only `PUT /api/v1/dialogues/bulk` and `DELETE
/by-content-key/{contentKey}` require `AuthorizationPolicies.RequireContentWrite`
(`CR.Dialogue.Service.REST/Endpoints/DialogueEndpoints.cs`) — the Content Studio's authoring surface.
The accepted risk this leaves: any authenticated player can enumerate every dialogue document, same
as every other piece of shipped content (it is already baked into the client).

## REST behavior, status codes

- `PUT /bulk` reads and bounds the request body manually (`IHttpMaxRequestBodySizeFeature`, set
  BEFORE a single byte is read) instead of relying on `[FromBody]` model binding, so nothing buffers
  the whole payload before the endpoint's own size checks run. The cap is
  `MaxBulkItems × (MaxSerializedBytes + 8 KB slack) + 64 KB` — 50 items at 256 KB each, plus slack for
  the rest of each item's fields and JSON structure.
- `415` when the request is not `application/json`.
- `413` when the body exceeds the computed cap (Kestrel's own `BadHttpRequestException.StatusCode` is
  trusted, not hardcoded, so a genuine 413 actually surfaces as 413).
- `400` for: an empty batch, more than `MaxBulkItems` (50) items, a duplicate `contentKey` within one
  request, a duplicate `id` within one request, or any item with an error finding. **Real
  all-or-nothing**: every item is validated before anything is written, and the whole batch is written
  in a single database transaction — a failure no validator could see (a constraint, a race) rolls
  back every row, never a partial write.
- Findings in a 400 response are capped at 100 per item (`MaxFindingsPerItem`), with a `Truncated`
  count when more existed — a hostile document (e.g. an array of thousands of nulls, well within the
  256 KB cap) produces one `null-element` finding per element; capping keeps a bad item from blowing
  up the size of the 400 response it is rejected with.
- `200` on success: `{ count, items: [{ contentKey, warnings }] }` — `warnings` carries every
  non-error finding (e.g. `id-ignored`, `member-ignored`) even though the write went through.
- A malformed request body is reported as `malformed-json` with only the JSON path/line, never the
  raw parser message (which can otherwise name the server's own DTO types).

### The global error middleware

`PostgresGlobalErrorMiddleware` (`Common/CR.Common.Data.Postgres/Server/PostgresGlobalErrorMiddleware.cs`)
is not Dialogue-specific but every Dialogue endpoint's unhandled-exception path runs through it. As of
this branch it answers every unhandled exception with a FIXED message per status code — never
`Exception.Message`, which used to leak SQL fragments, constraint names, connection details or file
paths. Status mapping: a Postgres unique-violation (`SqlState 23505`) → 409 "That already exists.";
`KeyNotFoundException` → 404 "Not found."; a Kestrel/model-binding `BadHttpRequestException` → whatever
4xx it already chose ("The request could not be processed."); anything else → 500 "An unexpected
error occurred." The response body's only per-request detail is an opaque `traceId`
(`context.TraceIdentifier`) that joins a bug report to the full, unredacted exception in the server
log — the full exception is logged, never returned. This was itself a pre-existing security issue
across the whole host (not introduced by this work) that got fixed alongside it, because Dialogue's
own review surfaced the same pattern in the shared middleware.

## OpenAPI

The four `/api/v1/dialogues*` routes are present in `cr-api/openapi.yaml`, regenerated as part of
this work (including the later-declared 413/415 responses on the bulk route).

## The content migration (M14002)

**Planned, not built.** There is no M14002 (or any migration beyond M14001) in
`CR.Dialogue.Data.Migration` at HEAD of this branch. The plan calls for a content-seed migration that
inserts the six shipped dialogues (and matching quest rows) so a fresh database ships with the
authored content already present, the same way other domains seed their launch content — this has not
been written. Any note elsewhere in this documentation set that assumes M14002 exists is describing
intent, not the current schema; check `CR.Dialogue.Data.Migration` directly before relying on it. Per
the ledger for this work, any future M14002 must seed dialogue rows under the SAME ids as the
corresponding `DialogueDefinition` assets (`content/dialogue-asset-ids.json` in the implementation
job's working notes) — the repository never re-keys a row, so a mismatched seed id would permanently
diverge from the asset.

## Related pages

- [The CR Dialogue System](?page=unity/31-dialogue-system) — the client-side runner, service, UI and
  NPC routing this domain feeds.
- [Dialogue Authoring](?page=unity/32-dialogue-authoring) — the designer-facing workflow.
- [The Quest System](?page=backend/07-quest-system) — grant/payout modes, `quest.accept`/`quest.claim`
  targets, and objective upsert-by-sort-order.
