# Dialogue System Integration (Legacy)

> **This page documents the LEGACY Pixel Crushers integration.** As of `feature/cr-dialogue`, CR has
> its own dialogue system — a typed document format authored in a node editor and run by an
> engine-free interpreter — documented at [Dialogue System](?page=unity/31-dialogue-system) and
> [Dialogue Authoring](?page=unity/32-dialogue-authoring). The Pixel Crushers plugin described on
> this page is still fully wired in the project and still drives every NPC that has **no**
> CR-authored dialogue (`NpcDialogueBehaviour.Backend == DialogueBackend.Plugin`); it is planned for
> removal once the CR system has been playtested, not before. New dialogue content should use the CR
> system, not this one.

The Pixel Crushers Dialogue System plugin handles all NPC dialogue data and presentation. CR code never references `DialogueManager` directly — all access goes through `IDialogueHandler`, which decouples game logic from the plugin and makes systems independently testable.

## Architecture

```
Pixel Crushers Dialogue System
        │ (plugin events + masterDatabase + Lua functions)
        ▼
PixelCrushersDialogueHandler   ←── IDialogueHandler
        │ (OnConversationCompleted)          │ (OnQuestAcceptedFromDialogue)
        ▼                                    ▼
  QuestDialogueBridge ──────────────────────────
        │ (TalkToNpcAsync)     │ (AcceptQuestAsync)
        ▼                      ▼
    QuestManager           QuestManager
```

| Class | Location | Role |
|-------|----------|------|
| `IDialogueHandler` | `Assets/CR/Dialogue/Interface/` | Contract — no plugin types exposed |
| `PixelCrushersDialogueHandler` | `Assets/CR/Dialogue/Implementation/` | MonoBehaviour wrapping `DialogueManager`; registers `AcceptQuest` Lua function |
| `QuestDialogueBridge` | `Assets/CR/Quests/Dialogue/` | Routes completed conversations to quest progress; routes `AcceptQuest` Lua calls to `QuestManager.AcceptQuestAsync` |

## Why This Design?

### Why an Interface Over `DialogueManager` Directly?

`DialogueManager` is a static class with a singleton instance. Code that calls it directly is tightly coupled to the plugin — swapping plugins, mocking in tests, or supporting multiple dialogue systems becomes expensive. `IDialogueHandler` exposes only what CR systems need (actor/conversation lookups and three events). The plugin can be replaced by updating `PixelCrushersDialogueHandler` without touching any consumer.

### Why a Separate `QuestDialogueBridge`?

`QuestManager` is the authority on quest state. `IDialogueHandler` is the authority on dialogue events. Neither should know about the other. `QuestDialogueBridge` is a lightweight seam that connects the two — easy to test in isolation and trivial to extend (e.g., analytics, cutscene triggers) without modifying either system.

### Why the Abort-Detection Flag?

The Pixel Crushers `conversationEnded` event fires for **both** normal completion and cancellation. There is no parameter to distinguish them. The `DialogueSystemEvents` component exposes `onConversationCancelled`, which fires only on cancel, BEFORE `conversationEnded`. `PixelCrushersDialogueHandler` sets a `_wasAborted` flag in the cancel handler and reads it in the ended handler to route the event correctly.

## Critical Convention: a dedicated `content_key` Actor Field

> **This convention is not enforced at compile time. Violating it silently drops the talk (a warning is logged).**

This used to require the actor's **Name** field to equal the NPC's `content_key`. That convention is
gone (audit B4): every NPC actor in the Dialogue System database must instead have a **`content_key`
Text field** set to the NPC's `content_key` as it appears in the backend database — the actor's display
`Name` is free to be a human-readable label. `QuestDialogueBridge` calls
`IDialogueHandler.GetConversationActorContentKey(id)` (`PixelCrushersDialogueHandler.cs`, reading the
actor's `content_key` field via `Field.LookupValue`) and sends `QuestManager.TalkToNpcAsync(npcKey)` with
whatever it returns. Unlike the old `GetConversationActorName`, there is **no fallback to the display
name** — an actor with no `content_key` field sends no talk at all, and `QuestDialogueBridge` logs a
warning naming the conversation.

Example: An NPC with backend `content_key = "npc_elder_rowan"` must have an actor field
**content_key = `npc_elder_rowan`**; its Name field can be `"Elder Rowan"`.

`GetConversationActorName` (Name-based, with its own fallback behaviour) still exists on
`IDialogueHandler` for other lookups (e.g. `DialogueHandlerTest`), but no production caller uses it to
resolve the NPC content key anymore — that is `GetConversationActorContentKey`'s job.

## IDialogueHandler API

```csharp
// Actor lookups
string GetNpcById(int id);               // by numeric actor ID
string GetNpcById(string id);            // by actor name
string GetConversationActorName(int conversationId);        // primary actor's Name field
string GetConversationActorContentKey(int conversationId);  // primary actor's content_key field (no fallback) — what talk uses

// Conversation lookups
int    GetConversationId(string conversationTitle);
string GetConversationTitle(int conversationId);

// Events (payload = conversation ID)
event Action<int>    OnConversationStarted;
event Action<int>    OnConversationCompleted;
event Action<int>    OnConversationAborted;

// Fired when a dialogue node calls AcceptQuest("template-uuid") in its Script field
event Action<string> OnQuestAcceptedFromDialogue;
```

All lookups return `string.Empty` or `-1` (for IDs) when the dialogue system is not running or the entity is not found, and log a warning. They never throw.

## DI Wiring

Both the handler and bridge are bound in `LocalDevGameInstaller.cs` as `NonLazy` — this ensures they instantiate at scene load and subscribe to events before any conversation can start.

```csharp
Container.Bind<IDialogueHandler>()
    .To<PixelCrushersDialogueHandler>()
    .FromNewComponentOnNewGameObject()
    .AsSingle()
    .NonLazy();

Container.Bind<QuestDialogueBridge>()
    .AsSingle()
    .NonLazy();
```

`PixelCrushersDialogueHandler` is a `MonoBehaviour` bound via `FromNewComponentOnNewGameObject()`. Its event subscriptions to the Pixel Crushers plugin happen in `Start()`, after Zenject installation completes.

## Starting Conversations: NpcDialogueBehaviour

Conversations start through the same Interact flow as every other NPC interaction —
**not** through the Pixel Crushers `ProximitySelector`/`Selector` use-key, which polls
its own raw key globally and fires whichever `Usable` is in range even when the player
is interacting with a different NPC (e.g. a merchant standing nearby).

Setup on a dialogue NPC GameObject:

| Component | Role |
|-----------|------|
| `DialogueSystemTrigger` | Pixel Crushers trigger, set to **On Use**, with the conversation assigned |
| `NpcDialogueBehaviour` | CR wrapper: exposes `HasConversation` / `StartConversation` to the interaction system; assign the shared `isInConversation` BoolVariable so an open conversation can't re-trigger |
| `NpcInteractionBehaviour` | Proximity + Interact action; its dialogue branch (lowest priority, after grant/trainer/merchant) calls `NpcDialogueBehaviour.StartConversation(player)` |

On the **player**, disable or remove the `ProximitySelector` (and `Selector`) components —
otherwise both systems respond to E and conversations fire while shopping.

The dialogue branch deliberately does **not** call `QuestManager.TalkToNpcAsync`
directly: `QuestDialogueBridge` sends the talk intent when the conversation
*completes*, so sending it at trigger time would double-count (and would count
aborted conversations).

## TalkToNpc Quest Objectives

> **Removed.** `QuestObjectiveDefinition` no longer has `conversationTitle`/`conversationId` fields —
> they were the game-client-only binding this section used to document, and they are gone as of the
> CR dialogue work (`QuestDefinition.cs` has no such fields at HEAD). A `TalkToNpc` objective on the
> Plugin backend is now matched purely by the NPC's `content_key` (`targetReferenceId`), the same way
> it always was for the CR backend. If you are looking at an old prefab or a stale editor screenshot
> that still shows a Conversation dropdown on a quest objective, it is out of date.

### Runtime Flow

Talk is a client **intent**, never a client-reported outcome (server-authority CORE RULE): the client
only says "the player talked to this NPC," and the authority — the server online, the offline DLL
`NpcTalkOnlineOfflineService` otherwise — decides what that counts toward.

When a player completes a conversation:
1. `PixelCrushersDialogueHandler.OnConversationCompleted` fires with the conversation ID.
2. `QuestDialogueBridge` calls `GetConversationActorContentKey(id)` → the NPC's `content_key` (see the
   convention above — no fallback to the display name).
3. `QuestManager.TalkToNpcAsync(npcKey)` is called, which routes through `INpcTalkService`
   (`Assets/CR/Npcs/Talk/`) to the server (online) or the DLL talk service (offline).
4. An unrecognised `npcKey` comes back `NpcTalkStatus.UnknownNpc` and counts nothing (a warning is
   logged); otherwise the authority returns a `ProgressReport`, which `QuestManager.ApplyServerProgress`
   applies — updated objectives, any newly completed quest, achievement unlocks and trainer XP/level, all
   from the one report. This is the same entry point `OnLocationVisited` and item use funnel through.

Aborted conversations do not advance any objective (no talk is sent at all).

## Quest Acceptance from Dialogue

Players accept quests by clicking a dialogue choice (e.g. "Yes, I'll help"). The dialogue designer adds a Lua call to that node's **Script** field:

```
AcceptQuest("550e8400-e29b-41d4-a716-446655440000")
```

The UUID is the quest template's `id` column from the backend database.

### How It Works

1. `PixelCrushersDialogueHandler.Start()` registers `AcceptQuest(string templateId)` as a Lua function with the Pixel Crushers runtime via `Lua.RegisterFunction`.
2. When the node fires, `LuaAcceptQuest(templateId)` is called → raises `OnQuestAcceptedFromDialogue`.
3. `QuestDialogueBridge.HandleQuestAccepted(templateId)` parses the UUID and calls `QuestManager.AcceptQuestAsync(guid)`.
4. `QuestManager` routes through `IQuestRepository` (online/offline), fires `OnQuestAccepted`, and adds the instance to `ActiveQuests`.

### Designer Notes

- The `AcceptQuest` Lua call belongs in the **Script** field of the node where the player **confirms** acceptance — not the offer node.
- Pass the quest template UUID as a string literal. If the string is not a valid UUID, `QuestDialogueBridge` logs a warning and ignores the call.
- Aborted conversations do NOT cancel an already-accepted quest; `AcceptQuest` fires when the node resolves, before the abort-detection flag is checked.

## Smoke Test

`DialogueHandlerTest` (`Assets/CR/Dialogue/Tests/`) is a MonoBehaviour that can be added to any scene GameObject. In Play mode it logs all lookup results and subscribes to the three events to confirm they fire correctly. Set the inspector fields to actor IDs/names and conversation titles that exist in your database.

## Related Pages

- [Dialogue System](?page=unity/31-dialogue-system) — the CR dialogue system that replaces this
  integration for new content, including the routing rule that decides which NPC uses which backend.
- [Dialogue Authoring](?page=unity/32-dialogue-authoring) — the designer workflow for CR dialogues.
- [NPC Interaction](?page=unity/04-npc-interaction) — `NpcDialogueBehaviour.Backend` and the shared
  Interact dispatch both backends go through.
