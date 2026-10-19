# Optimistic Concurrency (row_version)

Studio content (dialogues, quest templates, the quest map layout) is edited from two places at once: the Unity
Crystalline Rift Studio and the web Studio. `row_version` is the one contract both use to avoid silently overwriting
each other. This page is the single source of the contract; the web and Unity pages link here instead of repeating it.

Applies to four tables: `dialogue` (M14003), `quest_template` (M17004), `quest_map_layout` (M17005) and `talent_tree` (M15105). Other tables
that carry a `row_version` column (for example `spawner`) are unchanged and do not reject stale writes.

## The column

`row_version BIGINT NOT NULL DEFAULT 1`. A new row starts at 1. Every server write that changes the row adds exactly 1:
an update, a children-only change (objectives, rewards, requirements), a re-key, a revive of a soft-deleted row, and a
soft delete. The value the server returns after a write is read back in the same connection or transaction, so a client
can store it and use it as the next `expectedRowVersion`. On the wire it is `rowVersion`, a JSON number.

## Request: `expectedRowVersion`

Each row of a bulk `PUT` (and the `expectedRowVersion` query parameter of a `DELETE`) carries one of:

| Value | Meaning |
|---|---|
| absent or `null` | Unconditional write. For old callers and seeds only (see [Rollout](#rollout)). |
| `0` | Create-only. Conflicts if a live row with that key exists. If only a soft-deleted row exists it is revived (same id, version = deleted version + 1). This is what both clients send for **Recreate**. |
| `n > 0` | Must equal the live row's current version, otherwise 409. Against a soft-deleted row it is also a 409, with `deleted: true`. |
| negative | 400 `invalid_expected_row_version`. |

The web Studio and the Unity Studio always send a number. Reads for the check include soft-deleted rows, because
`content_key` is unique including deleted rows and a key never gets a second row.

## Response: 409

```json
{
  "title": "row-version-conflict",
  "status": 409,
  "items": [
    { "contentKey": "quest-gran", "expectedRowVersion": 3, "currentRowVersion": 5,
      "updatedAt": "2026-10-17T12:00:00Z", "deleted": false }
  ],
  "applied": []
}
```

- `currentRowVersion` is `null` when the row does not exist.
- `applied` lists the keys that were already written before the conflict.
  - Dialogues: always empty. The whole batch is checked first, and the write is one transaction, so a lost race rolls everything back.
  - Quests: also empty when the up-front check finds the conflict (nothing written). If a compare-and-swap is lost mid-batch, `applied` holds the keys already saved; each of those has its new version in the next read.
- A successful bulk response returns the new `rowVersion` for every row.

The write itself is a compare-and-swap: `UPDATE ... SET row_version = row_version + 1 ... WHERE row_version = @read`. If
two writers pass the pre-check together, the loser updates zero rows and gets the same 409. A race on first insert
(unique violation) is also reported as 409.

## Talent trees

A tree is the versioned unit; its talents are children, so a talent change bumps the tree by 1. `PUT /api/v1/talents/trees/bulk`
checks every tree up front (409, nothing written), then compare-and-swaps each tree inside its own transaction; a mid-batch
loss is a 409 with the saved trees in `applied`. A successful response carries each tree's `rowVersion`, and the GET list and
by-key routes return it. The bulk route cannot delete trees.

**No bump on identical content.** Talent trees are edited sync-all, so clients send every tree. The server compares each
incoming tree (tree fields plus talents, normalised) with the stored one; when equal it neither bumps the version nor checks it.
Identical trees in an Apply therefore never bump or conflict. See [Talents](?page=backend/25-talents#row-version).

## Dialogue layout does not conflict

A dialogue document holds both content and a presentation `layout` (node positions). The server compares the incoming
dialogue with the stored one with `layout` removed (name, description, NPC key and the document minus layout). If the
content is equal, the layout and metadata are written **without** bumping `row_version` and without a version check, so
moving cards in the web canvas never causes a conflict or a "Pull" in Unity. Layout is last-writer-wins. The decision is
made from a read just before the write; the write is guarded on the version that was read, and if that changes the
server re-evaluates once and falls into the normal compare-and-swap path. `expectedRowVersion: 0` is never treated as
layout-only, because it means create-only. If content changed, the normal check and bump apply.

## Delete

`DELETE .../by-content-key/{key}?expectedRowVersion=n` bumps the version (a soft delete is a write).

- Dialogue: match returns 204; a live mismatch, an already-deleted row, or a missing row with `n > 0` is a 409; a missing row without an expectation is 404.
- Quest template: without an expectation the old behaviour holds (404 when there is no live row, else delete). With one, mismatch, deleted or missing is a 409. The 200 body is `{ message, rowVersion }`.

## Cache and offline writes

The Unity online cache stores server rows, so it must keep the server's version rather than bump its own. The
repositories take a `preserveRowVersion` option (quests) or `DialogueWriteOptions.PreserveRowVersion` (dialogues): the
supplied version is written verbatim, with no bump and no check, and a deleted row is revived. The Studio's local
ScriptableObject-to-SQLite sync clients pass no expectation and never carry a version.

## Rollout

Old callers that send no `expectedRowVersion` still work. Each such bulk or delete logs a Warning with the caller (name
and account). Once every client sends the field, set `Studio:RequireExpectedRowVersion` to `true`: a write without it is
then a 400 `expected_row_version_required` (dialogues also list the offending `items`). The flag covers dialogue bulk and
delete, quest bulk and delete, the map layout `PUT` and the talent tree bulk `PUT`. Default is `false`. See [Deploy notes](#deploy-notes).

## Deploy notes

1. **Deploy cr-api first.** The new Unity and web builds send `expectedRowVersion` and read `rowVersion`; the server must have the columns and routes before they ship. Build packages (`build-packages.sh`) and copy to Unity as usual; the shipped interface changes are additive.
2. **Pre-create the Stats index off-peak.** M9005 adds `idx_stat_event_trainer_occurred` on `stat_event (trainer_id, occurred_at DESC, id)`. On a large production table run this first, outside peak hours, so the migration finds it and does nothing: `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_stat_event_trainer_occurred ON stat_event (trainer_id, occurred_at DESC, id);`. (`CONCURRENTLY` cannot run inside a transaction block.) The other new indexes (`idx_trainers_lower_name`, `idx_accounts_lower_email`, the admin-action index) are on small tables.
3. **Flip `Studio:RequireExpectedRowVersion` after the Unity release** that sends `expectedRowVersion` is in your users' hands, not before, or older Studios get 400 on every push.
4. **Audit the server-owned stat keys (A7).** The stats endpoint already refuses every client-written key, and the prefixes `readable_read_`, `npc_met_` and `quest_completed_` are now in the server-owned deny-list as well. To find existing rows that were not written by the server, run (read-only; check the `stat_event` column names against the schema first):

```sql
SELECT s.trainer_id, s.stat_key
FROM trainer_stat s
WHERE s.deleted = false
  AND (s.stat_key LIKE 'readable\_read\_%' ESCAPE '\'
    OR s.stat_key LIKE 'npc\_met\_%' ESCAPE '\'
    OR s.stat_key LIKE 'quest\_completed\_%' ESCAPE '\')
  AND NOT EXISTS (SELECT 1 FROM stat_event e
                  WHERE e.trainer_id = s.trainer_id AND e.stat_key = s.stat_key
                    AND e.deleted = false AND e.source <> 'client');
```

5. **One-time Unity Pull for assets that were never pulled.** A Studio asset that has never been pulled has `serverRowVersion` 0, so its first push is create-only. If the server already has a row with that key, the push is a 409 (the row is shown as a conflict, with **Pull this row**). Pull once after upgrading, before pushing, so each asset adopts the server's version.

6. **Talent trees: Pull once, then push.** Talent tree assets in Unity have never been pulled, so they carry version 0. Run **Pull talent trees** once in Studio before any talent push, or each push is a create-only 409. Then rebake the offline floor (package build), whose export refuses while a tree is behind.

## Related

- [Dialogue Server Domain](?page=backend/21-dialogue-domain) for the table and bulk semantics.
- [Quest System](?page=backend/07-quest-system#studio-concurrency-and-story-lines) for the quest fields and the layout document.
- [Talents](?page=backend/25-talents#row-version), [Talent Tree Editor](?page=admin-web/09-talent-tree-editor) and [Talents UI (Unity)](?page=unity/36-talents-ui) for talent trees.
- [Dialogue Authoring (Unity)](?page=unity/32-dialogue-authoring) and [Dialogue Editing](../admin-web/02-dialogue-editing.md) for how each client shows a conflict.
