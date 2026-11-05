# World Map Editor

The world map editor (**Content → World map**, `/content/world-map`, content-write scope) edits the layout behind the player
menu's **Map** tab: one node per area, the routes between them, and how each node is tinted. It is a plain SVG canvas, not
React Flow, so a node is a rectangle you can see and drag. Without content-write the page is read-only: you can pan, zoom and
select to read the values, but nothing can be changed or saved.

> **What this edits.** The Studio edits the **server copy** of the map (`GET`/`PUT /api/v1/world-map/{scope}`, scope `main`).
> The Unity `WorldMapDefinition` ScriptableObject is still the source the game client reads today; moving the client over to
> the server copy is a follow-up. See [World Map (Unity)](../unity/35-world-map.md).

## The canvas

- **Pan** by dragging the empty background; **zoom** with the mouse wheel (0.5x to 4x, about the pointer) or the **+** and
  **-** buttons. **Reset view** returns to the whole map.
- **Select** a node by clicking it. Drag the body to move it; the centre is kept inside the map. Drag the **dark square in the
  bottom-right corner** to resize: the pointer is one corner of the node, so the size is twice its distance from the centre,
  held between 0.04 and 1 of the map.
- Node `x` and `y` are the **centre** in 0..1 map space; the map is `aspect` times wider than tall (1.6 for the Steam Deck).
- Tints follow the region style: Grassland, Settlement, Highland, Cave, Desert, Coast. Routes are drawn under the nodes.
- **Connect** mode: click one node, then another, to add a route (a duplicate or a loop onto the same node is refused). Esc
  cancels. A route is selected by clicking its line; **Delete** removes it, as does **Remove** in the Routes list.
- **Undo / Redo** (buttons, Ctrl-Z, Ctrl-Y). One drag is one step, and the keystrokes in one inspector field are one step.

## The inspector and panels

The inspector edits the selected node: area key, display name, style, `x`, `y`, `width`, `height` and an optional art
address. Renaming an area key carries the routes that named it. **Add node** takes a key (a key already on the map, ignoring
case and spacing, is refused); **Delete node** removes the node and its routes. **Map settings** holds the aspect, the
undiscovered-area switch, the node display and the background art address, plus a *preview image URL* (https only, never
saved) to line nodes up with a painting.

## Findings

The findings panel checks what the browser can see, and offers a one-click fix where there is an obvious one:

| Finding | Fix |
|---|---|
| Empty area key / duplicate key | Remove node |
| Node partly outside the map | Nudge inside |
| Overlapping nodes (epsilon 0.0001, as in Unity) | Nudge apart (0.01 margin, as in Unity) |
| Route to a node that is not there, or to itself | Remove route |
| Isolated node (no routes, on a map of more than one) | none |
| Area with no world location (can never be discovered) / location whose area has no node | none |

The last row reads `GET /api/v1/world-locations`; if that read fails those two checks are switched off and the panel says so.
**Scene, door and art checks run in the Unity inspector** (Validate), because they need the project's scenes and Addressables.

## Starting a map, saving and conflicts

With no map on the server the page offers **Load Unity starter layout** (the six areas of `WorldMap.asset`: Cave, Crags,
Dunes, Meadow, Shore, Village, aspect 1.6, with their routes), **Start blank**, and an **Import JSON** box that takes a
version 1 document and names the first problem it finds.

**Save** sends the whole document with `expectedRowVersion` (0 on the first save). A 409 opens the same conflict dialog as the
other editors: **Reload theirs**, **Compare**, or **Overwrite** (which asks twice). Leaving the page with unsaved changes
asks first.

## The document

```json
{
  "version": 1,
  "aspect": 1.6,
  "backgroundAddress": "map/background",
  "unknownAreaDisplay": "Silhouette",
  "nodeDisplay": "Tiles",
  "nodes": [
    { "areaKey": "Meadow", "displayName": "Sunlit Meadow", "x": 0.5, "y": 0.5,
      "width": 0.16, "height": 0.12, "style": "grassland" }
  ],
  "routes": [ { "from": "Meadow", "to": "Village" } ]
}
```

Area keys compare trimmed and case-insensitively, as in Unity.

## Related

- [World Map (Unity)](../unity/35-world-map.md) for the tab, discovery and the Unity-side validation.
- [Optimistic Concurrency](../backend/28-optimistic-concurrency.md) for `expectedRowVersion` and the 409.
- [Quest Story Map](07-quest-story-map.md) for the other server-stored layout document.
