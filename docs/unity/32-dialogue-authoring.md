# Dialogue Authoring

A designer's path through the CR dialogue system: create a dialogue, edit its graph, catch problems
before they ship, and push to the server. See [Dialogue System](?page=unity/31-dialogue-system) for
how the document format and runner actually work, and
[Dialogue Domain](?page=backend/21-dialogue-domain) for what the server checks on push.

**Status: not merged, not deployed, not playtested.** See [Status](#status) below.

## Creating a Dialogue

### From the Studio

Crystalline Rift Studio → **Dialogues** tab: **+ New Dialogue** creates a blank `DialogueDefinition`
asset with a fresh id. The tab lists every `DialogueDefinition` under
`Assets/CR/Content/Defs/Dialogues/`, each row showing node count, linked NPC, a validity chip
(**Valid** / *n* **warning(s)** / *n* **error(s)**, errors-first — from the same real
`DialogueValidator` the server runs, cached per asset and only re-run when its document actually
changes), a **Ping** button, and a **Delete** button that removes the asset from the tab. Clicking a
row expands an inline detail view; the tab also runs the content audit (below) in its own panel and
carries the usual Push All / Pull All buttons.

### From the scaffold menu (for a guide NPC)

Select an `NpcDefinition` asset and run **CR → Dialogue → Create guide dialogue for selected NPC**.
This reads only content assets (offline, no server needed): every `QuestDefinition` the NPC gives,
or whose `TalkToNpc` objective targets it, becomes a quest fact
(`DialogueGuideQuestFact`), and `DialogueGuideScaffold.Build` turns those facts into a starter
document — one hub Branch node whose cases are, **first match wins**:

1. every `ReturnToGiver` quest given by this NPC that is ready to turn in
2. every quest whose `TalkToNpc` objective targets this NPC and is still pending
3. every `OfferedByGiver` quest given by this NPC that is available
4. every quest given by this NPC that is currently active
5. every quest given by this NPC that is completed (most recently listed quest first, so a player
   who just finished something hears about it before an older thanks line)
6. else, the idle line (`Else`)

An `AutoWhenAvailable` quest never gets an offer case (case 3); an `AutoOnCompletion` quest never
gets a turn-in case (case 1) — the scaffold builds only what a giver can legally present.
Placeholder line text is bracket-tagged (`"[offer: Thin the Meadow] Placeholder offer line —
rewrite me."`) so it is easy to grep for what still needs writing; option labels ("Accept.",
"Decline.", "Thank you.") are left plain since they are generic UI text, not narrative content. The
menu refuses — one log line, no modal — when a dialogue already links to the NPC or already claims
the content key it would use (`dialogue-guide-{npcContentKey}`).

## The Node Editor

`CR → Dialogue → Open Dialogue Editor` (or double-click a `DialogueDefinition` asset). The window
is a thin shell over `DialogueEditorSession` — the testable owner of the asset ⇄ in-memory-document
⇄ undo relationship — so nothing described below depends on the window actually being open to be
correct.

**Add, connect, delete.** The toolbar adds a node of a chosen type at the click position; dragging
from a port to another node's input connects them (`Connect`); a node's context menu removes it
(`RemoveNode`) or duplicates it (`DuplicateNode`, offsetting the copy). Every structural op goes
through `DialogueGraphEditing` and is refused, not partially applied, if it would break an
invariant (e.g. connecting a port that does not exist) — a refusal changes nothing in the document
or on the asset.

**Arrange.** The toolbar's **Arrange** button lays the whole graph out left to right so that no two
nodes overlap, as one undo step, then frames it. It uses each node's size *on screen* (a hub with
twelve cases is several times the height of an End node; a fixed grid overlaps one or wastes the
other). Columns are conversation depth: a node sits one column right of its deepest predecessor, so
every forward edge runs left to right and a shared End lands right of everything that reaches it. An
edge that loops back (to the hub, say) is ignored for placement and simply draws right to left.
Within a column, nodes keep the order of the ports that lead to them, which keeps edges from
crossing, and are pulled level with their neighbours where there is room. Nodes the entry cannot
reach are laid out the same way, below. The algorithm is `DialogueAutoLayout` (pure, tested).
A node with **no** stored position (a document created in the web Studio has none) is *shown* where
Arrange would put it rather than piled on the origin; nothing is written until you arrange or drag.

Node positions live in the document (`layout`), so they are pushed and pulled like the rest of it,
and arranging marks the dialogue as changed in the Studio. They are not *content*: the shipped-asset
pin test compares documents with positions left out (`DialogueDocumentNormalizer.ContentEqual`).

**Following a line.** Every connection is drawn in its own colour, behind the nodes, so a line
crossing a node it has nothing to do with never covers that node's text. Colours follow the
conversation: a fork (a hub's cases, a choice's options) starts a new colour per port, and a node
with one output carries on in the colour it was reached by, so "hub case → offer → choice" reads as
one line and the choice's options then split into their own (`DialogueEdgeColors`). Hover a line and
the whole conversation it belongs to lights up while everything else steps back: everything that
can lead to that line from the entry, and everything it can lead on to, but none of its sibling
branches (`DialogueThreads`). A line that loops back to the hub is never followed, or every
conversation would be part of every other. Click a line to keep the trace and open the **Thread**
tab, which writes that conversation out step by step, showing of a hub only the case that leads
into it and of a choice only the options that stay inside it. Clicking a step selects its node.
Escape, clicking the empty canvas or the tab's Clear button ends the trace; an edit re-traces it.

**Find.** Cmd/Ctrl+F (or the toolbar's Find) opens a find bar. Every node containing the text is
marked and the current match is framed; Enter / Shift+Enter, F3 / Shift+F3 or Cmd/Ctrl+G page through
them in conversation order, wrapping at either end. It searches what you can see or type: ids, spoken
text, speaker, notes, option text and ids, condition and action types and argument values, the prose
summaries the nodes show, and an End's outcome. The counter says where the hit is ("3 / 7 · text,
option"). An edit keeps the cursor on the node it was on if that node still matches. Escape closes.

**Inspector.** Selecting a node opens a field inspector for its type: text and speaker for a Line,
option list with per-option condition/action editors for a Choice, case list with per-case condition
editors for a Branch, an action list for an Action node, outcome for an End node.

**Typed condition and action editors.** Every condition/action `Type` is picked from the real
registered vocabulary (`DialogueDescriptorRegistry`, built from the same `IDialogueModule`s the game
uses), and each argument gets a picker matching its `DialogueArgKind` — a quest key picks from real
`QuestDefinition` content keys, an NPC key from real NPCs, an enum from the real enum's values (read
live, never hand-typed) — instead of a free-text field a typo can silently break.

### Findings list

The findings list merges two sources, errors first then by node id:

1. **`DialogueDocumentDiagnostics`** — the real server `DialogueValidator`, run locally. Every code
   in [Dialogue Domain → every finding code](?page=backend/21-dialogue-domain#every-finding-code)
   can appear here before you ever push.
2. **`DialogueArgDiagnostics`** — checks the server deliberately does not do, because the server
   validator has no vocabulary of argument shapes, only of type strings:
   - **`missing-required-arg`** (Error) — a required argument is absent or blank. The message names
     which option or case it is on (`"'Quest State' in option 'accept' is missing required arg
     'quest'."`) so five options that each carry the same condition type don't produce five
     identical, unlocatable lines.
   - **`unknown-arg`** (Warning) — an argument is present that no descriptor for that type declares.
     Flagged, never silently dropped.

   An unknown condition/action *type* (not a core combinator, no descriptor at all) is not
   re-reported here — `DialogueDocumentDiagnostics` already covers that as `unknown-condition`/
   `unknown-action`.

### The red banner

A banner appears across the top of the window, and the whole edit area is disabled, whenever the
session cannot edit (`!session.CanEdit`): the asset was deleted out from under the window, or its
`documentJson` could not be parsed at all (an unreadable document is shown empty rather than
silently discarding whatever the author had). The banner text is exactly
`session.LoadError` — read it, it names the parse failure.

### "Changed outside the editor"

Every write checks whether the asset's `documentJson` still equals what this session last read or
wrote (`HasChangedOutside`) — not just on window focus, since a pull, a git checkout, or a second
editor window on the same asset can all change it while this window has focus. If it has changed,
the write is refused, the newer version is loaded in its place, and the refused edit is discarded:
*"This dialogue changed outside the editor (a pull, a checkout or another window). The new version
was loaded and your last edit was not applied."* The session never silently overwrites something it
has not seen.

### Undo

Structural edits run against the in-memory document **first**; only on success does the session call
`Undo.RecordObject` (capturing the asset's still-old `documentJson`) and re-serialize the document
into it. A refused edit therefore never touches the asset's serialized field, never calls
`Undo.RecordObject` for nothing, and never marks the asset dirty. Field-level edits (text, a
dropdown value) always commit under their own undo step, since a text field cannot itself violate a
graph invariant.

## The Content Audit

`DialogueContentAudit.Run` (`Assets/CR/Core/Data/Logic/DialogueContentAudit.cs`) is a pure,
never-throwing rule engine over every dialogue document and every quest's facts — a project-wide
check the per-dialogue validator and node-editor diagnostics cannot do, because they each see only
one document. Run it from **CR → Dialogue → Run content audit** (console output), from the Studio
Dialogues tab's own audit panel, or as part of the EditMode test gate
(`DialogueContentAuditRealAssetTests`).

| Rule | Code(s) | Protects against |
|---|---|---|
| 1. Accept target has the matching grant mode | `accept-target-not-offered-by-giver` (Error) | A `quest.accept` action targeting a quest whose `grantMode` is not `OfferedByGiver` — the accept can never legally happen from dialogue. |
| 2. Claim target has the matching claim mode | `claim-target-not-return-to-giver` (Error) | A `quest.claim` action targeting a quest whose `rewardClaimMode` is not `ReturnToGiver`. |
| 3. Every `OfferedByGiver` quest is reachable | `offered-by-giver-no-dialogue` / `offered-by-giver-no-dialogue-yet` (Info while no dialogue exists yet at all) / `offered-by-giver-accept-unreachable` (Error) | A quest nobody can ever be offered: its giver has no dialogue, or has one but no reachable `quest.accept` for it. |
| 4. Every `ReturnToGiver` quest is reachable | `return-to-giver-no-dialogue` / `return-to-giver-no-dialogue-yet` (Info) / `return-to-giver-claim-unreachable` (Error) | A reward nobody can ever collect: the giver has no dialogue, or has one but no reachable `quest.claim`. |
| 5. At most one dialogue per NPC | `duplicate-npc-dialogue` (Error) | Two dialogues linked to the same NPC — the server's ordinal tie-break silently shadows every one but the first; the audit says so instead of leaving it to be discovered live. |
| 6. Every reachable `TalkToNpc` objective has a `quest.recordTalk` | `talk-objective-no-dialogue-yet` (Info) / `talk-objective-record-talk-unreachable` (Error) | The single most dangerous gap in the whole system: on the CR backend, **nothing else records a talk.** A `TalkToNpc` objective whose target NPC has a dialogue but no reachable `quest.recordTalk` for that NPC can never progress, and nothing anywhere will ever say why. Resolved against the NPC the dialogue is actually **linked to** (`dialogue.npcContentKey`), not the document's first listed speaker — a second speaker, or a stale speaker id left over from a rename, must not fool this check. |
| 7. Auto grant/claim quests are never manually reachable | `auto-when-available-quest-manually-accepted` / `auto-when-available-quest-offered-in-branch` / `auto-on-completion-quest-manually-claimed` (all Error) | An `AutoWhenAvailable` quest that still appears as a `quest.accept` target or inside a `quest.state is Available` branch case; an `AutoOnCompletion` quest that still appears as a `quest.claim` target. Auto quests are never offered or claimed by hand — see [authoring rules that bite](#authoring-rules-that-bite). |
| 8. `AutoWhenAvailable` is never repeatable | `auto-when-available-quest-repeatable` (Error) | The game's auto-grant sweep skips repeatable quests (nothing caps repeats, so granting one forever would never stop) — an `AutoWhenAvailable` + repeatable quest is therefore never granted at all. |
| 9. Dialogue id non-blank, valid, unique | `dialogue-id-blank` / `dialogue-id-invalid` / `dialogue-id-duplicate` (all Error) | A blank or malformed id; two `DialogueDefinition` assets sharing one id (e.g. a Ctrl+D duplicate) — the repository never re-keys, so the second insert is silently skipped with one warn line server-side. |
| 10. No dangling quest/NPC/item reference | `dangling-quest-ref` / `dangling-npc-ref` / `dangling-item-ref` (Error), or `key-arg-kinds-not-supplied` (Info) if the caller didn't supply the facts needed to check | A renamed or deleted quest, NPC, or item content key still referenced by an argument. The one rule that catches this class of error — a caller that forgot to build the key-arg facts sees an explicit Info, never a silent "0 errors" on content full of dangling keys. |
| 11. Every dialogue validates clean | `dialogue-validation-error` (Error) | Any `DialogueDocumentDiagnostics`/`DialogueArgDiagnostics` error (the same checks the node editor's own findings list runs), surfaced project-wide so a broken document doesn't have to be opened individually to be noticed. |
| 12. A giver doesn't stand on its own `VisitLocation` map | `giver-shares-visit-location-map` (Error), or `placement-not-checkable` (Info) when NPC-area placement facts weren't supplied | A quest whose giver NPC stands in the same area its own `VisitLocation` objective sends the player to — a design smell (the objective sends the player somewhere they already are). |

Reachability (rules 3/4/6) walks `Next`/`Else`/option/case targets from the document's `Entry` —
**conditions are ignored.** An author-satisfiable condition is not this tool's job to prove; it only
asks "does *some* path through the graph structure reach this action," not "will a player ever see
it." Rules 3/4 are Info instead of Error while literally no dialogue exists anywhere yet (content not
authored, not a design failure); from the moment any dialogue exists, the same situation becomes
what it looks like — a quest that can never be offered or claimed — and is promoted to Error.

## Push / Pull / Review

**Push** validates every dialogue against the server's own rules before sending (the Studio's audit
panel and the node editor's own findings both run the real `DialogueValidator`), then calls
`PUT /api/v1/dialogues/bulk`. A push can come back with server findings the local checks could not
predict (a database-level constraint, a race) — every finding the server returns is shown, per
dialogue, the same way a validation error is shown anywhere else in the tab.

**Pull** brings server dialogues in as local assets — the empty-state hint on the tab
("No DialogueDefinition assets found. ⬇ Pull brings the server's dialogues in as assets.") is
literal. A pulled dialogue is keyed by the **server's** id: adopting a server row into a brand-new
local asset uses the server's id rather than minting a fresh one, which is what makes a later push
from that same asset land as an update instead of a second row. An unreadable or empty document is
never shown as "Valid" — it gets a real finding and full diagnostics in its chip, not a green
checkmark that hides the problem.

**Review** — the tab's per-row Diff/Push/Revert flow used by every other content type ([Content
Registry → Review window](?page=unity/08-content-registry)) applies to dialogues the same way.

## The Six Shipped Dialogues

Under `Assets/CR/Content/Defs/Dialogues/`, ids minted once at creation and never touched again:

| contentKey | NPC | Nodes | Role |
|---|---|---|---|
| `dialogue-guide-area-1` | `demo-questgiver-area-1` | 30 | Meadow Guide — the only guide with every state: offer, ready-to-turn-in, in-progress, completed, idle, plus the welcome talk-objective. |
| `dialogue-guide-area-2` | `demo-questgiver-area-2` | 8 | Cave Guide. |
| `dialogue-guide-area-3` | `demo-questgiver-area-3` | 14 | Shore Guide. |
| `dialogue-guide-area-4` | `demo-questgiver-area-4` | 8 | Crags Guide. |
| `dialogue-guide-area-5` | `demo-questgiver-area-5` | 3 | Dunes Guide — has nothing to offer yet; idle-only. |
| `npc-trainer-meadow-scout-bark` | `npc-trainer-meadow-scout` | 2 | Pre-battle bark; the battle starts when the conversation completes (see [Dialogue System → Trainer bark gates the battle](?page=unity/31-dialogue-system#trainer-bark-gates-the-battle-on-completed)). |

Each follows the scaffold's branch order above. The Meadow Guide's hub, for example, checks
`Thin the Meadow`/`A Second Companion`/`Supplies for Hearthmere` readiness before their offers,
the welcome talk-objective before the welcome offer, and falls to an idle line only when nothing
else matches — the same first-match-wins order [Dialogue System](?page=unity/31-dialogue-system)
describes for the runner in general.

The same content push also changed all ten shipped `QuestDefinition` assets' `giverNpcContentKey`/
`grantMode`/`rewardClaimMode` to match this dialogue set — see
[Quest System](?page=backend/07-quest-system) for the full table.

## Authoring Rules That Bite

- **An `AutoWhenAvailable` quest is never offered.** It grants itself the moment its requirements
  are satisfied (`QuestAutoGranter`, sweeping on every session-ready signal and every rewards-claim
  event). Putting it behind a `quest.accept` action, or inside a `quest.state is Available` branch
  case, authors dead content the audit will flag (rule 7) — the player will never see that branch,
  because the quest is already active by the time they could.
- **`AutoWhenAvailable` + repeatable is never granted, at all.** The auto-grant sweep
  (`QuestAutoGrantPolicy.Select`) skips repeatable quests outright — nothing caps how many times a
  repeatable quest could re-grant itself, so the sweep excludes the whole category rather than risk
  an infinite grant loop. The quest simply never appears anywhere (audit rule 8).
- **`ReturnToGiver` with no giver pays out immediately.** `QuestRewardClaimPolicy.Decide` maps
  `ReturnToGiver` + no giver to `ClaimNow` — the same as `AutoOnCompletion` — specifically so a
  quest never strands its own reward behind a giver that does not exist. If a quest is meant to
  require a return trip, it must have a `giverNpcContentKey`.
- **On the CR backend, only `quest.recordTalk` records a talk for an NPC that has a dialogue.**
  Unlike the legacy Plugin path (where `QuestDialogueBridge` records any completed conversation
  automatically), a CR-authored dialogue linked to an NPC records nothing on its own. A `TalkToNpc`
  objective targeting that NPC needs a reachable `quest.recordTalk` action somewhere in its
  dialogue, or the objective can never progress — with no error anywhere to say so. This is exactly
  what audit rule 6 exists to catch before it ships.
- **NEVER renumber a surviving quest objective's `sortOrder`.** The server upserts quest objectives
  **by sort order**, not by a stable identity — see
  [Quest System → objectives are upserted by sort order](?page=backend/07-quest-system#objectives-are-upserted-by-sort-order).
  Changing a surviving objective's `sortOrder` (even without touching anything else about it) makes
  the server treat it as a *different* objective: the old one is soft-deleted (silently completing
  it, or dropping in-progress state) and a new one is inserted with a fresh id that no player's
  progress row references. This bit a real content change during this project — a review caught
  Supplies for Hearthmere's surviving `TalkToNpc` objective renumbered to `sortOrder 0` when its
  sibling `VisitLocation` objective was dropped, which would have re-keyed it. The fix was to leave
  the surviving objective's `sortOrder` exactly where it was (`1`), not renumber down to fill the
  gap.

## Preview Pane

The Dialogue Editor's right-hand side has two tabs: **Inspector** and **Preview**. Preview answers
"what does the player hear when Thin the Meadow is ready to turn in and A Second Companion is still
available?" without entering play mode. It runs the REAL `DialogueRunner` on a **copy** of the
document against a simulated world you control. It never touches a game service, never dirties the
asset and records no undo step.

**The world (left).** One row per distinct condition the document asks about:

- A **dropdown per quest** for every `quest.state`-shaped condition (one quest-key arg plus one enum
  arg): `Unavailable` plus only the states this document actually asks about for that quest. Picking
  a state sets every condition asking about it true and the quest's others false. State names match
  case-insensitively, like the real evaluator.
- A **toggle** for every other condition (`quest.objectivePending`, `progress.requirement`,
  `npc.trainerDefeated`, anything a module adds), labelled with the same summary the graph shows.

Combinators (`all` / `any` / `not`) have no row: the runner evaluates them from their leaves. Every
change restarts the conversation from the entry.

**The conversation (right).** Lines with **Continue**, choices as buttons, actions as `[type args]`
rows, and the end with its outcome and reason (a dangling target shows as `Fault` here instead of
throwing). The node being previewed is highlighted and framed in the graph; your own selection, and
so the node the Inspector edits, is left alone.

**Apply quest effects** (on by default): `quest.accept` moves that quest to `Active` and `quest.claim`
to `Completed` in the simulated world, so **Restart** shows what the NPC says next. Every other
action is only recorded.

The world survives edits: the pane re-binds after every change to the document (a node drag
included) and carries over the value of every condition that still exists. Preview is refused, with
the reasons listed, while the document has validator **errors** or the asset could not be loaded;
warnings do not block it. Placeholders are substituted but text is not translated (see Status).

## Findings The Node Editor Catches That The Server Does Not

Repeated here for cross-reference: `missing-required-arg` and `unknown-arg` (see
[The Node Editor → Findings list](#findings-list) above). The server validator
(`DialogueValidator`) only knows condition/action *type strings*, never their argument shapes — see
[Dialogue Domain → Why validate structure and type vocabulary, but not argument shapes?](?page=backend/21-dialogue-domain#why-validate-structure-and-type-vocabulary-but-not-argument-shapes).

## Status

- **Not merged, not deployed, not playtested.**
- **The Content Studio's Dialogues tab has a row-level Delete, but no dedicated inspector.** Unlike
  `QuestDefinition`/`NpcDefinition`/etc., there is no `DialogueDefinitionEditor` custom Inspector —
  selecting a `DialogueDefinition` asset directly in the Project window shows Unity's default
  Inspector, not a dialogue-aware one. A known follow-up is an inline-inspector Delete action with a
  testable confirmation split (`DeleteDialogueConfirmed`), for parity with the tab's own delete.
- **Pull does not page past 500 rows.** The Studio's dialogue pull reads one page at the server's
  own cap; a dialogue table larger than that would silently lose rows past the first page on Pull
  All.
- **Localization is wired but empty.** The game looks every line up in the localization table first
  (see [Dialogue System → Status](?page=unity/31-dialogue-system#status)) and no `dlg.*` key exists,
  so the player sees the document's own text. Nothing in the authoring tools writes or reads a
  translation table yet; the Dialogue Editor and its Preview are source-language only.
- **The six dialogues and ten quest changes ship as a server migration**, M14002. See
  [Dialogue Domain](?page=backend/21-dialogue-domain#the-content-migration-m14002). It leaves rows
  that already exist alone, so an edit made here still reaches the server only through a Studio push.

## Related Pages

- [Dialogue System](?page=unity/31-dialogue-system) — the runtime this content plays against
- [Dialogue Domain](?page=backend/21-dialogue-domain) — server validation, storage, the id rule
- [Quest System](?page=backend/07-quest-system) — grant/payout modes, the objective sort-order rule
- [Content Registry](?page=unity/08-content-registry) — the Studio's Review window, Push/Pull pattern shared by every content type
