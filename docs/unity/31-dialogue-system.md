# The CR Dialogue System

CR authors and runs its own branching dialogue format — node graphs stored as JSON on the backend,
edited in a Unity GraphView window, and played back by a small, engine-free runner shared between
cr-api and cr-api-unity. It exists alongside the legacy Pixel Crushers Dialogue System plugin
(see [Dialogue System Integration](?page=unity/11-dialogue-integration)), which still drives every
NPC that has no CR-authored conversation. Nothing here is merged, deployed, or playtested yet — see
[Status](#status) at the end of this page.

The runner code (`CR.Dialogue.Model`, `CR.Dialogue.Runtime`) is compiled once in cr-api and shipped
into Unity as a netstandard2.1 package (`CR.Game.Compat`) — the same conversation logic runs
server-side (validation, and any future server-driven conversation) and client-side (the actual
playback), so "what a dialogue does" can never drift between the two.

## Why this approach

### Why a custom format instead of extending the Pixel Crushers plugin?

The plugin's data lives in a proprietary Lua-backed database that only exists inside the Unity
Editor at runtime — there is no way to validate it on the server, sync it as ordinary content, or
drive it from a backend condition (a quest's grant mode, a requirement check) without going through
Lua script fields nobody can statically check. CR's format is a plain JSON document with a typed C#
model on both ends: the server can validate it byte-for-byte before it is ever stored, and a
condition or action is a strongly-typed C# class instead of a string of injected Lua.

### Why does the dialogue core know nothing about quests?

A conversation format that hard-codes "quest" as a concept could never be reused for anything that
is not a quest — an NPC that just asks about the weather still needs Line/Choice/Branch nodes. The
core (`CR.Dialogue.Model`, `CR.Dialogue.Runtime`) only knows about nodes, conditions, actions,
speakers and text. Every domain-specific behavior — `quest.accept`, `progress.requirement`,
`npc.trainerDefeated` — is a **module** that plugs into the core through two small interfaces
(`IDialogueConditionEvaluator`, `IDialogueActionHandler`) and lives in ITS OWNER's namespace
(`CR.Quests.Dialogue`, `CR.Progress.Dialogue`, `CR.Npcs.Dialogue`), never inside
`CR.Dialogue.*`. The composition root (`CR.DI.DialogueModuleInstaller`, called from
`LocalDevGameInstaller`) is the only place that wires all of them together.

This is enforced by a real test, not just convention:
`Assets/CR/Tests/Editor/DialogueCoreLayeringTests.cs` scans every `.cs` file under
`Assets/CR/Dialogue` (except the legacy `Implementation/` folder, the Pixel Crushers adapter) for a
`using CR.Quests.Dialogue` / `using CR.Progress.Dialogue` / `using CR.Npcs.Dialogue` line and fails
if it finds one. The project's own comment on that test is honest about its limits: **there is no
asmdef boundary enforcing this yet** — it is a source-text scan, not a compiler error. Do not treat
"it compiles" as proof the layering held; run the test.

### Why first-match-wins for branch cases, not "most specific"?

A Branch node evaluates its `cases` in authored order and takes the `next` of the first one whose
conditions all pass; if none match, it falls through to `else`. There is no scoring, no "most
specific wins" — the author's ordering IS the priority. This mirrors how the six shipped dialogues
are actually written (see [Dialogue Authoring](?page=unity/32-dialogue-authoring)): a guide NPC's hub
node lists "quest ready to turn in" before "quest available" before "quest in progress" before
"idle fallback", and that list order is the entire precedence rule. A scoring system would need its
own conflict-resolution rules on top; ordered evaluation needs none.

### Why is `DialogueEndReason` separate from `DialogueOutcome`?

`DialogueOutcome` (`Completed` / `Declined`) is content — what the author or player chose. It answers
"how did this conversation end, from the story's point of view." `DialogueEndReason` (`Authored` /
`NoTarget` / `Fault` / `Aborted`) is a runner-safety concern — it answers "was this actually a normal
ending, or did the runner have to bail out." The two were originally collapsed into one nullable
outcome, and a caller could not tell "the player declined" from "the runner hit a bug and gave up" —
both looked like `Declined`. Splitting them means a consuming UI can toast the player on `Fault` only,
never on a legitimate ending.

## The document model

A `DialogueDocument` (`CR.Dialogue.Model.Model.DialogueDocument`,
`cr-api/Dialogue/CR.Dialogue.Model/Model/DialogueDocument.cs`) is one conversation graph, stored as
a single JSON blob:

```csharp
public class DialogueDocument
{
    public int Version { get; set; } = 1;
    public string Entry { get; set; }
    public List<DialogueSpeaker> Speakers { get; set; }
    public List<DialogueNode> Nodes { get; set; }
    public Dictionary<string, DialogueNodeLayout> Layout { get; set; } // editor-only, never read by the runner
}
```

### Nodes

Every node (`DialogueNode`) has an `Id`, a `Type` (`DialogueNodeType`), and a set of fields whose
meaning depends on that type — unused fields are flagged by the validator's `member-ignored` warning
(see below).

| Type | Uses | Runner behavior |
|---|---|---|
| `Line` | `Speaker`, `Text`, `Next` | Surfaced as a step; the player continues to `Next` |
| `Choice` | `Options` | Surfaced as a step; the player picks a visible option |
| `Branch` | `Cases`, `Else` | Never surfaced — resolved internally, first matching case wins, else `Else` |
| `Action` | `Actions`, `Next` | Never surfaced — every action runs in order, then falls through to `Next` |
| `End` | `Outcome` | Surfaced as the final step; `Outcome` is `Completed` or `Declined` |

Branch and Action nodes are resolved internally by `DialogueRunner` and never reach `IDialogueView` —
only `Line`, `Choice` and `End` become a `DialogueStep`.

- **`DialogueOption`** (on a Choice): `Id`, `Text`, `Conditions` (all must hold to show the option —
  null/empty means always shown), `Actions` (run in order before advancing), `Next`.
- **`DialogueCase`** (on a Branch): `Conditions` (all must hold for the case to match), `Next`.
- **`DialogueSpeaker`**: `Id`, `Kind` (`Player` or `Npc`), `NpcContentKey` (only meaningful for
  `Npc`), `DisplayName`.
- **`DialogueNodeLayout`**: `X`/`Y` — editor-only node position, never consulted by the runner.

### Conditions and actions

```csharp
public class DialogueCondition
{
    public string Type { get; set; }                       // "all" | "any" | "not" | a module type
    public Dictionary<string, string> Args { get; set; }
    public List<DialogueCondition> Children { get; set; }   // only for all/any/not
}

public class DialogueAction
{
    public string Type { get; set; }                        // always a module type — no core actions exist
    public Dictionary<string, string> Args { get; set; }
}
```

`all`, `any` and `not` are the only CORE condition types — everything else is module-owned, leaf-only,
with its parameters in `Args`. There are no core action types at all: every action is a module's.

Composition semantics, straight from `DialogueRunner.EvaluateConditionAsync`
(`cr-api/Dialogue/CR.Dialogue.Runtime/DialogueRunner.cs`):

- `all` — every child must be true; short-circuits on the first `false` child.
- `any` — at least one child must be true; short-circuits on the first `true` child.
- `not` — exactly one child; the condition is its negation. Zero or more-than-one children is a
  content error (warned, evaluates `false`).

Because of the short-circuit, **a condition evaluator placed after the short-circuit point is not
guaranteed to run** — do not rely on one for a side effect.

### Outcomes, speaker kind, node types

```csharp
public enum DialogueNodeType   { Line, Choice, Branch, Action, End }
public enum DialogueOutcome    { Completed, Declined }
public enum DialogueSpeakerKind{ Player, Npc }
```

### Limits (`CR.Dialogue.Model/DialogueLimits.cs`)

| Constant | Value |
|---|---|
| `MaxSerializedBytes` | 256 KB |
| `MaxNodes` | 500 |
| `MaxOptionsPerChoice` | 20 |
| `MaxCasesPerBranch` | 20 |
| `MaxConditionDepth` | 8 |
| `MaxArgsPerConditionOrAction` | 16 |
| `MaxArgKeyLength` | 64 |
| `MaxArgValueLength` | 512 |
| `MaxNodeTextLength` | 2000 |
| `MaxBulkItems` | 50 (bulk upsert request, not a document limit) |

## The vocabulary: modules own their type strings

A condition or action `Type` string is not free text — it is one of a fixed set of strings, each
owned by exactly one module. This is what `IDialogueVocabulary`/`DialogueVocabulary` enforces:
`DialogueVocabulary`'s constructor throws if two modules declare the same string (a vocabulary that
silently let one collide with another would shadow it at runtime with no diagnostic).

Every type string that exists today, its module, its args, and where it is declared:

### `CR.Quests.Dialogue.QuestDialogueModule` (module id `"quest"`)

| Type | Kind | Args | What it does |
|---|---|---|---|
| `quest.state` | condition | `quest` (QuestKey, required), `is` (Enum: `Available`/`Active`/`ReadyToTurnIn`/`Completed`, required), `giver` (NpcKey, optional — default is the NPC being talked to; explicit empty string means "any giver") | True when the quest is in the given state. `Available` also checks the `giver` filter against the template's `GiverNpcContentKey`. |
| `quest.objectivePending` | condition | `quest` (QuestKey, required), `npc` (NpcKey, optional — default is the NPC being talked to) | True when the quest has an active, incomplete `TalkToNpc` objective whose target matches the NPC (or the objective's target is a wildcard). |
| `quest.objectiveCount` | condition | `quest` (QuestKey, required), `objective` (Int, optional — the objective's sort order, default 0), `min` / `max` (Int, optional — open bound when left out) | True when the quest is in progress and that objective's progress count is within `min..max`. Lets a giver say "one down, two to go" per count. Not for "all done": that is `quest.state ReadyToTurnIn`. A quest not in progress is false. |
| `quest.accept` | action | `quest` (QuestKey, required) | Resolves the content key to a template and calls `IQuestService.AcceptQuestAsync`. An unknown key throws (the runner turns that into `End(Declined)` + a warning). |
| `quest.claim` | action | `quest` (QuestKey, required) | Finds the quest's `Completed && !RewardsClaimed` instance and calls `IQuestService.ClaimRewardsAsync`. None found throws the same way. |
| `quest.recordTalk` | action | `npc` (NpcKey, optional — default is the context NPC) | Calls `IQuestService.OnNpcInteracted(npc)` — see [How a talk is recorded](#how-a-talktonpc-talk-is-recorded), below. |

Implementations: `Assets/CR/Quests/Dialogue/{QuestStateConditionEvaluator,
QuestObjectivePendingConditionEvaluator,QuestAcceptActionHandler,QuestClaimActionHandler,
QuestRecordTalkActionHandler}.cs`. `QuestStateResolver.cs` is the pure state table (no I/O) behind
`quest.state`.

### `CR.Progress.Dialogue.ProgressDialogueModule` (module id `"progress"`)

| Type | Kind | Args | What it does |
|---|---|---|---|
| `progress.requirement` | condition | `kind` (Enum — every `QuestRequirementType` value, required), `op` (Enum — every `RequirementOperator` value, optional, default `GreaterThanOrEqual`), `value` (Int, required), `quest` (QuestKey, only for `QuestCompleted`), `stat` (StatKey, only for `StatThreshold`), `item` (ItemKey, only for `HasItem`/`UsedItem`) | Builds a `QuestRequirement` from the args and calls the SAME `IConditionEvaluator.EvaluateAllAsync` the backend uses to gate `AcceptQuestAsync` — a dialogue-authored requirement behaves identically to a quest-template requirement. `CreatureLevel` can only ask about the trainer's highest creature level from this module (no `creature` arg exists), never one specific creature. |

Implementation: `Assets/CR/Progress/Dialogue/ProgressRequirementConditionEvaluator.cs`.

### `CR.Npcs.Dialogue.NpcDialogueModule` (module id `"npc"`)

| Type | Kind | Args | What it does |
|---|---|---|---|
| `npc.trainerDefeated` | condition | `npc` (NpcKey, required) | `ITrainerDefeatLookup.IsDefeated(npc)` — true if the current account has already beaten that trainer NPC. |
| `npc.openShop` | action | `npc` (NpcKey, optional — default is the NPC being talked to) | Asks for that merchant's shop to open **after the conversation ends** (a screen cannot open over the panel). Recorded on `INpcDialogueRequests`; `NpcInteractionBehaviour` honours it once the conversation's status is `Ended`. |

Implementation: `Assets/CR/Npcs/Dialogue/NpcTrainerDefeatedConditionEvaluator.cs`.

### Server vs client vocabulary

The server keeps its own copy, `CR.Dialogue.Domain.Services.ServerDialogueVocabulary`
(`cr-api/Dialogue/CR.Dialogue.Domain.Services/ServerDialogueVocabulary.cs`) — a plain
`HashSet<string>` of the same nine type strings, used only to flag `unknown-condition`/
`unknown-action` when validating an upserted document. Its own doc comment calls it "the canonical
list" and says a mismatch with Unity's modules must never happen. **The server validator only checks
that the TYPE string is known — it never checks arg names.** `arg-too-long` catches an oversized key
or value, but a required arg being absent, or an arg present that no descriptor declares, is not a
server-side finding at all. That gap is filled client-side by the node editor's own diagnostics — see
[Dialogue Authoring](?page=unity/32-dialogue-authoring#findings-the-node-editor-catches-that-the-server-does-not).

## The runner: safety rules

`DialogueRunner` (`cr-api/Dialogue/CR.Dialogue.Runtime/DialogueRunner.cs`) drives ONE conversation.
It is never a singleton — a fresh instance is created per `StartAsync` call
(`CR.Dialogue.Unity.DialogueService` does exactly this). Its own doc comment states the rules
plainly, and they are load-bearing (every one of them was a review finding against an earlier draft
that would have wedged a real conversation):

- **No `ConfigureAwait(false)` anywhere.** Handlers and evaluators resume real game/UI-thread work
  and must land back on the caller's `SynchronizationContext`.
- **Re-entrancy guard.** A public call (`StartAsync`/`AdvanceAsync`/`ChooseAsync`) made while another
  is still in flight throws `InvalidOperationException` instead of running a pending action twice.
- **Catch-all → `Fault`.** The run phase of every public method is wrapped so ANY non-cancellation
  exception ends the conversation `Declined` with `EndReason.Fault` — warned, never wedged, never
  retryable into a second side effect.
- **Null-safe lists.** A null element anywhere in an authored list (nodes, options, cases, actions,
  conditions, children) is skipped and warned, never dereferenced.
- **Hop guard.** A chain of Branch/Action nodes with no interactive step in between is capped at 1000
  hops (`MaxNonInteractiveHops`) — a content cycle with no Choice node to exit it cannot spin forever.
- **Idempotent `Abort()`.** Calling it after the conversation already ended (naturally, or by a
  previous `Abort()`) just returns the existing `CurrentStep` unchanged.

### `DialogueEndReason`

```csharp
public enum DialogueEndReason
{
    None,       // not an end step at all — a Line or Choice
    Authored,   // an authored End node was reached (its Outcome may itself be malformed → coerced Declined)
    NoTarget,   // a Next/option-Next/unmatched-case-and-Else was legally absent — Outcome stays Completed
    Fault,      // the runner had to bail out: dangling target, hop guard, empty Entry, a throwing
                // action handler, an undefined node type, an unhandled exception, or a Choice whose
                // every option is hidden (content-authored, but nobody could ever pick anything)
    Aborted,    // the caller called Abort() while the conversation was still in progress
}
```

A consuming UI should only warn/toast the player on `Fault` — every other value is either not an end
at all, or a legitimate way for a conversation to stop.

## `DialogueService`: start results, ends exactly once, cannot wedge

`CR.Dialogue.Unity.DialogueService` (`Assets/CR/Dialogue/Service/DialogueService.cs`) is the Unity
side of the pipeline: it resolves a document, builds a fresh `DialogueRunner`, and pumps
`IDialogueView` one step at a time. It is bound `AsSingle` in the persistent Core scene, so it must
never let one bad conversation lock out every later one.

**Start results.** `StartAsync`/`StartForNpcAsync` return a `DialogueStartResult { Status, Outcome }`
instead of a nullable outcome, because a nullable outcome collapsed five distinct "did not run"
reasons into one indistinguishable `null`:

```csharp
public enum DialogueStartStatus { Ended, NoDialogue, Busy, NotReady, Failed }
```

| Status | Meaning | Toasts? |
|---|---|---|
| `Ended` | The conversation genuinely ran; `Outcome` is set. The ONLY status where `Started`/`Ended` both fired. | No |
| `NoDialogue` | The NPC has no dialogue configured, or the content key resolves to no document. Not an error. | No |
| `Busy` | Refused — a conversation was already active. The running one is undisturbed. | No |
| `NotReady` | Gave up waiting for the quest system to become ready (`IQuestService.WhenReady`, bounded 30s). | "Not ready yet, try again in a moment." |
| `Failed` | The content repository threw, the caller's token source was already disposed, or the runner could not produce its first step. | "That conversation ended unexpectedly." (unless the underlying cause was a deliberate cancel before anything started) |

**Ends exactly once.** Every path that can end a conversation AFTER `Started` has fired — a normal
End step, `Abort()`, a caller-token cancellation, a view exception, the runner rejecting an option
id — funnels through one idempotent local (`EndOnce` inside `RunConversationAsync`) that: closes the
view (isolated — a throwing `Close()` is warned, never skips the rest), releases the re-entry claim
(so a new conversation can start from inside an `Ended` handler), raises `Ended`, and — isolated the
same way — shows the "conversation ended unexpectedly" toast only when the ending was not a
deliberate abort/cancel.

**Cannot wedge.** Every await of the VIEW (`ShowLineAsync`/`ShowChoiceAsync`) is raced against the
conversation's own cancellation token via a private `WithCancellationAsync` helper instead of awaited
directly. A view whose task never completes (panel destroyed mid-line, a dead handler) can no longer
prevent `Abort()` from ending the conversation — the wait no longer depends on the view ever noticing
its own token. The abandoned view task, if it later faults, is still observed via a
`ContinueWith(...OnlyOnFaulted)` continuation, so it never surfaces as an unobserved task exception.

The re-entry claim itself is taken synchronously, before the first `await`, so two calls arriving in
the same frame cannot both start a runner — the second sees the claim already taken and returns
`Busy` without touching the first.

## The UI: `DialogueScreenPresenter` and the `isMenuOpen` gate

`CR.UI.Dialogue.DialogueScreenPresenter` (`Assets/CR/UI/Dialogue/DialogueScreenPresenter.cs`) is the
real `IDialogueView` — a code-created UI Toolkit panel (the `EvolutionPresenter`/
`AchievementToastPresenter` pattern: no scene object to drag a reference onto, so it builds its own
`UIDocument` from `Resources` at `Awake`). It replaces `NullDialogueView`, the placeholder that
auto-continues every line and auto-picks the first option — `NullDialogueView` is still in the
project as a fallback for code paths that resolve `IDialogueView` before the real one is bound.

**Input gating** was the one thing nothing else in the project provided: nothing stopped the player
walking away mid-conversation. Opening the panel sets a shared `isMenuOpen` Soap `BoolVariable`
(bound with `Id: "isMenuOpen"`, resolved from `Resources` since the presenter has no scene object to
drag one onto), which `CR.UI.PlayerInputGate` reads to disable the Player action map. Closing restores
the flag to `false` **only when this panel is the one that set it true** — a menu that was already
open when the conversation started is never clobbered shut by the panel's own close. This is a known
limitation, not a bug: `isMenuOpen` is one shared bool every screen sets and clears on its own
(`PlayerMenuWindow.Hide()` clears it unconditionally), so opening and closing the player menu mid-
conversation would un-gate movement if the presenter did not re-assert the flag on every
`OnValueChanged` while it is showing. A reference-counted gate is the structural fix, not yet built.

Other load-bearing details:

- **The look follows the Stitch design "Cinematic Bottom-Bar Dialogue System"** (2026-09-23):
  a floating slate card (`rgba(2,6,23,0.84)`, hairline white border, 16px corners, 96% wide) capped
  at 42% of screen height; a teal speaker pill (rose for a player line, `dialogue--player`) over a
  bold white line; choices in a right-hand column, each a button with a lettered teal badge (A, B,
  …) and an arrow overlaid as absolutely positioned children so `Button.text` stays the option line;
  and a low console strip with an "A CONFIRM" hint on the left and the Continue control on the
  right. The text's ScrollView hides its bar (a visible bar rewrapped a two-line text 2px taller
  and never went away); oversize text still scrolls by wheel or drag. Not in yet: speaker
  portraits (no portrait field on `NpcDefinition`) and the design's Plus Jakarta Sans face (no
  font asset in the project); the default font renders.
- **Sizes come from panel HEIGHT, never raw px in USS.** The shared PanelSettings scales pixels
  against screen WIDTH, so every font size, the badge diameters and the option buttons' padding are
  computed from `_root.resolvedStyle.height` in `ApplyLayout` (on every `GeometryChangedEvent`, and
  again after option buttons are built), not authored as fixed px values.
- **One persistent Continue button**, built once and never rebuilt — only its visibility and the
  panel's text change per step. Rebuilding it every step is exactly what would let a held Submit
  double-advance (old and new button both live for one frame). Option buttons ARE rebuilt every
  Choice step; they are protected by a realtime-based debounce instead
  (`DialoguePanelPolicy.InputAccepted`).
- Sorting order 40 — above the shop (5) and battle summary (10), below the toast rig (60).
- `OnContextChanged(UIContext newContext)` closes the panel whenever the game leaves the Overworld
  context (a battle starting, a cutscene) — `Close()` cancels whatever step is pending, which the
  runner sees as an `OperationCanceledException`, the same shape `Abort()` produces, so the
  conversation ends `Declined` with no fault toast.

## Content storage and the REST surface

A dialogue is a server content type, stored in the `dialogue` table (see
[The Dialogue Domain](?page=backend/21-dialogue-domain) for the full schema and repository
semantics). The short version, from the client's point of view:

- `dialogue.npc_content_key` links a dialogue to the NPC that offers it — the link lives on the
  DIALOGUE row, not on the NPC row. Several dialogues may name the same NPC (e.g. drafts); the
  repository breaks the tie deterministically by the lowest `content_key`, the same on Postgres and
  SQLite (an earlier ORDER BY-based tie-break disagreed between the two engines' collations).
- **The id rule.** A dialogue row is created under whatever id it is first upserted with, and is
  **never re-keyed** after that. `UpsertDialogueRequest.Id` is optional: omit it and the server mints
  one; supply it and it is honoured only on the FIRST insert for that content key. This is what lets
  a Unity `DialogueDefinition` asset and its server row share one id — the local SQLite table is keyed
  by that same id and never re-keys either, so the asset's authored id and the server's id must agree,
  or the two writers (offline sync, online back-fill) disagree about which id a document lives under.
  Three findings enforce this:
  - `id-ignored` (warning) — the content key already exists under a different id; yours was not used.
  - `id-in-use` (error) — the id you supplied already belongs to a DIFFERENT content key (even a
    soft-deleted row still owns its primary key).
  - `duplicate-id` (error, bulk only) — two items in the same request supplied the same id.
- REST routes (`/api/v1/dialogues`): `GET` (list, no document), `GET /by-content-key/{key}`,
  `GET /for-npc/{npcContentKey}`, `PUT /bulk` (up to 50, real all-or-nothing), `DELETE
  /by-content-key/{key}` (soft delete). The three GETs stay on the host's ordinary
  authenticated-player-token fallback; only `PUT /bulk` and `DELETE` require `content:write`.

## The online/offline router

`CR.Dialogue.Unity.DialogueContentOnlineOfflineRepository`
(`Assets/CR/Dialogue/Repository/DialogueContentOnlineOfflineRepository.cs`) is what
`DialogueService` actually reads from — the same shape as
`QuestTemplateOnlineOfflineRepository` (see [The Online/Offline Repository
Pattern](?page=unity/16-domain-sync-pattern)):

- **Local first.** `GetByContentKeyAsync`/`GetForNpcAsync` check the local SQLite `dialogue` table
  (populated by boot-time sync — below) first, and answer from there if present.
- **Server back-fill under the server id.** A local miss, while playing online, asks the server once
  and — if the returned document is valid — writes it into the local table UNDER THE SERVER'S ID
  (`envelope.Id`, never a freshly minted one). This is exactly the id rule above: a later local read
  or offline session then sees the same row the server would have served, no second round trip, no id
  disagreement.
- **Never caches an invalid server document.** Before caching a server hit, it re-runs
  `DialogueValidator.Validate` and only writes rows with zero Error findings — an invalid document
  would otherwise poison the local cache: serve it once, then (because a local row that fails
  validation also answers `null` without asking the server again) refuse that same content key forever
  with nothing able to heal it.
- **One-call index preload.** `PreloadIndexAsync` (`IDialogueIndexPreloader`) fetches the full
  dialogue list ONCE at world init and builds a `HashSet` of every NPC content key that has a
  dialogue. An NPC whose key is in neither the local table nor this index has no dialogue anywhere —
  answered without a per-NPC round trip. If the list comes back at the server's own page cap
  (`PageBounds.MaxLimit`, 500 rows) the index is discarded (left `null`) instead of trusted as
  complete, and every NPC falls back to the slower but correct per-NPC lookup. This index is rebuilt
  once per world init — a dialogue pushed to the server mid-session is invisible to an NPC that had
  none, until the next world init (a known, accepted limit).

## Boot-time sync of authored dialogues

`DialogueWorldBehaviour` (`Assets/CR/Game/World/Behaviours/DialogueWorldBehaviour.cs`) writes every
`DialogueDefinition` asset registered in `ContentDefinitionProvider.dialogues` into the local SQLite
table via `LocalDialogueSyncClient`, and preloads the NPC→dialogue index. **This runs at BOOT
(`Start()` → `SyncAtBootAsync()`), not at world init**, and the reason is a real race that was caught
in play mode:

> World init only starts once a trainer is chosen. An area's NPCs initialize on that same trainer
> change, in a task `AreaLoader` launches unawaited — nothing sequences it against dialogue sync.
> Whenever the NPCs won that race, each looked its dialogue up in a table that had not been written
> yet, and stayed on the Plugin backend for the rest of the session. This happened for real: Scout
> Maren resolved to `Plugin` in a play-mode test before this fix.

Definitions need no trainer and no server, and the local database finishes migrating before the
Zenject container even exists, so there is nothing to wait for at boot. World init still repeats the
sync (in case the boot pass failed), gated behind a re-armable `DialogueSyncGate`
(`IDialogueSyncGate`, `Assets/CR/Dialogue/Service/DialogueSyncGate.cs`): `NpcDialogueBehaviour`
awaits `WhenSynced`, bounded at 10 seconds, before its very first dialogue lookup. If the bound is
hit, the first NPC to run out of patience calls `GiveUp()`, which releases every NPC still queued
behind it for that pass (NPCs in an area initialize one after another, so an ungated wait would cost
N × the bound instead of once) — the next world init re-arms the gate for the next session.

## NPC routing

`NpcInteractionRouting.Decide` (`Assets/CR/Game/World/Behaviours/NpcInteractionRouting.cs`) is a
pure, fully-tested decision table — no scene, no collider, no container — for what one press of
Interact does. Priority (unchanged from before the CR backend existed): creature gift, trainer
battle, market, merchant, conversation.

```
GiveCreature
  > (canBattle: crBusy → IgnoredConversationBusy | CR bark → TrainerBarkCr
               | Plugin bark → TrainerBarkPlugin | else → TrainerBattleNow)
  > Market
  > Merchant
  > (crBusy → IgnoredConversationBusy)
  > (hasConversation: Cr → DialogueCr | Plugin (+player transform known) → DialoguePlugin
                     | Plugin (no player transform) → DialoguePluginBlocked)
  > None
```

`NpcDialogueBehaviour.Backend` (`Assets/CR/Game/World/Behaviours/NpcDialogueBehaviour.cs`) is a
**computed** property — `DialogueBackend.Cr` if `InitializeAsync` found a dialogue for this NPC's
content key, else `DialogueBackend.Plugin` if a `DialogueSystemTrigger` is configured, else `None` —
never latched at init time. NPC init is asynchronous and can lose the race to the player pressing
Interact; latching the backend once turned either failure mode (init not finished yet, or a
dialogue-lookup exception) into an NPC that silently had nothing to say for the rest of the session.

### Merchants talk first, and every NPC can have a dialogue

Route order is gift > trainer > market > merchant > conversation, with one twist: a merchant **with a
CR dialogue** routes to the conversation, and the conversation offers the shop itself through
`npc.openShop` (the demo's Meadow Merchant: repeat the job, shop, or turn in). A merchant without a
dialogue still opens its shop on the first press. While such a merchant's conversation is running,
a press is ignored rather than opening the shop over it.

Whether an NPC has a conversation is data (a dialogue row for its content key), not a prefab
decision: `NpcInteractionBehaviour.Init` adds an injected `NpcDialogueBehaviour` to any NPC whose
prefab lacks one, before `NpcWorldBehaviour` sweeps its sub-initializables at world init. The
merchant prefab is one such, so no prefab or scene edit is needed to give a merchant a dialogue.

### A conversation is tied to the NPC's lifetime

The CR bark/conversation path is started off the NPC behaviour's own `destroyCancellationToken`, so
the conversation cannot outlive the GameObject that triggered it (a despawned or unloaded NPC cannot
leave a phantom conversation running).

### Trainer bark gates the battle on `Completed`

`NpcTrainerBarkPolicy.Decide` (`Assets/CR/Game/World/Behaviours/NpcTrainerBarkPolicy.cs`) is the
pure mapping from a bark's `DialogueStartResult` to whether the fight starts:

| Result | Decision |
|---|---|
| `Status == NoDialogue` (no bark configured) | `StartBattle` |
| `Completed` (i.e. `Status == Ended && Outcome == Completed`) | `StartBattle` |
| Anything else (`Busy`, `NotReady`, `Failed`, or `Ended` with `Outcome == Declined`) | `DropChallenge` |

## How a TalkToNpc talk is recorded

`NpcInteractionRouting.RecordsTalkProgress(route)` decides, per route, whether
`NpcInteractionBehaviour` itself records the interaction for quest progress:

- **On the CR backend**, nothing but an authored `quest.recordTalk` action records a talk. A dialogue
  linked to an NPC that never reaches a `quest.recordTalk` node means the quest objective can NEVER
  progress through that NPC — no error appears anywhere; the audit rule described in [Dialogue
  Authoring](?page=unity/32-dialogue-authoring) exists specifically to catch this before it ships.
- **On the Plugin backend**, `QuestDialogueBridge` records the talk when the conversation *completes*
  (see [Dialogue System Integration](?page=unity/11-dialogue-integration)).
- **When the route is a swallowed press** (`IgnoredConversationBusy`, or either `Dialogue*` route),
  `NpcInteractionBehaviour` records nothing itself — recording here too would double-count a talk the
  conversation (or the busy-refusal) will handle, or has already handled, on its own.
- **When the NPC has nothing to do at all** (route `None`), the press still counts as a talk — this
  is how a `TalkToNpc` objective completes against an NPC with no conversation configured.

## Status

Not merged, not deployed, not playtested. The Pixel Crushers plugin is still fully wired in the
project and still drives every NPC that has no CR-authored dialogue — it is the LEGACY backend, kept
until playtesting is done and slated for removal after that (see [Dialogue System
Integration](?page=unity/11-dialogue-integration)).

- **Package.** The Unity project consumes cr-api's Dialogue assemblies as a file-referenced local
  package (`Packages/manifest.json` → `cr-api/Convenience/CR.Game.Compat/bin/unity-package`). It was
  republished from the head of this branch (the plan's Task 18): the baked `game-data.bytes` records
  schema 14002, and the id-optional upsert, `GetContentKeyByIdAsync` and the localization text-source
  seam are all in the shipped DLLs. Republish again after any later cr-api change.
- **Preview pane.** Built: see [Dialogue Authoring → Preview Pane](?page=unity/32-dialogue-authoring#preview-pane).
- **Only the Meadow Merchant talks right now.** The five guide dialogues and the scout bark are
  parked (moved under `Defs/_Parked/`, out of the provider) so each NPC and quest kind can be
  verified one at a time; a placed guide with no dialogue takes the silent, `DialogueBackend.None`
  path and a trainer with no bark battles at once. See
  [Dialogue Authoring → Active And Parked](?page=unity/32-dialogue-authoring#the-shipped-dialogues-active-and-parked).
- **Localization is wired but empty.** `IDialogueTextResolver.Resolve` receives a `DialogueTextSource`
  (dialogue content key, node id, option id, source text). `LocalDevGameInstaller` binds
  `LocalizedDialogueTextResolver` over `BraceTextResolver`, with `LocalizationDialogueStringTable`
  adapting `LocalizationRepository` as the `IDialogueStringTable`. Every line is looked up under
  `dlg.{contentKey}.{nodeId}[.{optionId}]` first and falls back to the document's own text, which is
  what happens for every line today: no localization file holds a `dlg.*` key. Two things to know
  before adding one. The language is the constant `"en"` (the project has no language setting). And a
  source-language `dialogues.yaml` entry **overrides** the inline text. A broken table costs a
  translation, never the conversation. See [Localization](?page=unity/06-localization).
- **Offline is covered end to end** by `DialogueOfflineEndToEndTests`: the shipped Meadow Guide asset,
  through `LocalDialogueSyncClient`, the content router with `IsPlayingOnline == false` and
  `DialogueService`, with a server client that throws on any call.
- **Known follow-ups**, tracked but not yet done:
  - Server 200-envelope responses elsewhere in the project (not Dialogue's own endpoints, which were
    audited clean) still carry `ErrorMessage = ex.Message` in a handful of other domains' result
    types — a pre-existing issue noted while reviewing Dialogue's own error handling, out of scope for
    this work.
  - Quest objectives are upserted by `sort_order`, not by a stable id — see [The Quest
    System](?page=backend/07-quest-system#objectives-are-upserted-by-sort-order) for what that means
    and why renumbering a surviving objective is dangerous.
  - The Studio Dialogues tab has no inline row-level Delete confirmation split out as its own testable
    method yet (it works; it just is not decomposed for unit testing the way other tabs' delete flows
    are).
  - Crystalline Rift Studio's dialogue pull (`FetchAll`) reads a single page (`limit=500`) with no
    further paging — a dialogue table larger than 500 rows would silently lose rows past the first
    page on Pull All.
