# Quest Helpers

Added 2026-10-28. An optional setting that shows the player where the next step of one quest is. Everything here is display: the client never decides what the next objective is or whether it is done. It reads the quest service (online: server responses; offline: the local cr-api domain services), and the toggle and tracked quest are preferences only.

## Player-facing behaviour

- **Setting:** Settings > Gameplay > **Quest helpers**. A client preference, default **off**, stored per trainer. Visible online and offline (it is not a server rule).
- **Track:** the quest journal has a **Track** / **Untrack** button on in-progress quests. One quest is tracked at a time. The tracked quest is pinned first on the HUD quest tracker ([Quest tracker](?page=backend/07-quest-system#quest-tracker-unity-hud)). Completing, claiming or abandoning it clears the choice; with nothing tracked the tracker keeps its auto-pick and the helper follows the card shown first.
- **Which step:** the helper is the first incomplete required objective (the same `NextRequired` rule the HUD tracker uses) that has an authored marker. When the quest is ready to turn in there is no helper. Objectives without a marker show nothing.
- **In the world:** a beam, a ground ring and a glow on the marked spot, only in the overworld and only while the setting is on. Distances at which the beam fades or hides are tuned in Play and are not fixed here.
- **On the map:** the area node containing the marker's scene pulses (area-node pulse; exact map position is not used).

## Authoring: the objective helper marker

Each objective may carry a `helperMarker { sceneKey, x, y, z, radius, targetKey }`. `radius` is the area for capture and defeat objectives; `targetKey` is the optional content key of the thing to interact with. The server stores it ([Quest System](?page=backend/07-quest-system)) but never uses it for an outcome.

In the Unity quest inspector (`QuestDefinitionEditor`, `QuestHelperMarkerDrawer`), per objective, a **Helper marker** block:

- **Scene** dropdown, **position**, **radius**, **target key**.
- **Pick in scene** (click in the Scene view), **Use selected** (takes the selected object's transform and key; lock the inspector first so selecting an object in the scene does not change the inspector), **Fast travel** (opens the scene and frames the marker), **Clear**.
- Gizmo discs show each marker while the quest asset is selected.
- A warning appears on objective types that can be pointed at (visit, talk, read, trainer, capture) when no marker is set (`QuestHelperMarkerRules`).

**Studio:** Push always sends `helperMarker` for every objective (an empty `sceneKey` means clear), so Pull before Push or a stale local asset will clear a marker authored elsewhere. The offline path (`LocalQuestTemplateSyncClient`) and the baked floor carry the same field.

## Code map

| Area | Files |
|---|---|
| Setting and per-trainer persistence | `Assets/CR/Core/Feedback/Logic/QuestHelper*.cs`, `GameDataQuestHelperPersistence`, `GameConfigurationKeys` |
| Selection (pure, tested) | `Assets/CR/UI/Logic/QuestHelperTarget*.cs`, `QuestTrackerSelector` |
| Presenters (world marker, map pulse) | `Assets/CR/UI/Quests/QuestHelper*` |
| Authoring | `Assets/CR/Core/Data/Editor/QuestHelperMarker*.cs`, `Assets/CR/Core/Data/Logic/QuestHelperMarkerRules.cs`, `QuestDefinition` |

## Related

- [Quest System](?page=backend/07-quest-system), [Player Menu UI](?page=unity/10-player-menu-ui), [Content Pipeline](?page=unity/17-content-pipeline)
