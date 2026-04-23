# Dialogue System Integration

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
        │ (OnNpcInteracted)    │ (AcceptQuestAsync)
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

## Critical Convention: Actor Names as NPC Content Keys

> **This convention is not enforced at compile time. Violating it silently breaks TalkToNpc quest progress.**

Every NPC actor in the Dialogue System database must have its `Name` field set to the NPC's `content_key` as it appears in the backend database. `QuestDialogueBridge` calls `IDialogueHandler.GetConversationActorName(id)` to retrieve this name and passes it directly to `QuestManager.OnNpcInteracted(actorName)`.

Example: An NPC with backend `content_key = "npc_elder_rowan"` must have **Name = `npc_elder_rowan`** in the Dialogue System actor database.

## IDialogueHandler API

```csharp
// Actor lookups
string GetNpcById(int id);               // by numeric actor ID
string GetNpcById(string id);            // by actor name
string GetConversationActorName(int conversationId); // primary actor name for a conversation

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

## TalkToNpc Quest Objectives with Conversation Binding

`QuestObjectiveDefinition` has two game-client-only fields that bind a TalkToNpc objective to a specific Dialogue System conversation:

| Field | Type | Purpose |
|-------|------|---------|
| `conversationTitle` | `string` | Human-readable title, for editor display |
| `conversationId` | `int` (default -1) | Numeric ID, used at runtime |

**These fields are NOT sent to the backend.** `BuildQuestPayload` in `QuestDefinitionEditor` uses an explicit anonymous object that does not include them.

### Setting Up a TalkToNpc Objective (Editor)

1. Open a `QuestDefinition` asset.
2. In **Objectives**, add an objective with `Objective Type = TalkToNpc`.
3. Select the **Target NPC** (must match backend `content_key`).
4. Enter **Play mode** (required — the Dialogue System database is only available at runtime).
5. The **Conversation** dropdown populates with all conversations in the database.
6. Select the conversation that should complete this objective.
7. Exit Play mode. `conversationTitle` and `conversationId` are serialized and persist.

> The **↺** refresh button re-queries the database if the dropdown is stale.

### Runtime Flow

When a player completes a conversation:
1. `PixelCrushersDialogueHandler.OnConversationCompleted` fires with the conversation ID.
2. `QuestDialogueBridge` calls `GetConversationActorName(id)` → resolves actor name (= NPC content key).
3. `QuestManager.OnNpcInteracted(actorName)` is called.
4. The backend records `TalkToNpc` progress against any active objective whose `targetReferenceId` matches the actor name.

Aborted conversations do not advance any objective.

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
