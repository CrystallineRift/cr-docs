# World Map

The player menu's **Map** tab: every authored area as a stylised node map, which ones this trainer has
discovered, where they are now, and which areas hold an active quest's "visit" target. It is read-only. It
sends nothing to the authority and decides nothing: discovery is the server's outcome online, and the same
domain DLLs' on local SQLite offline. The client only groups and draws it.

> **P2 (current).** Discoveries are real: `IWorldMapDiscoveryReader` → `WorldMapDiscoveryReader`, reading the
> same `GET /api/v1/trainers/{trainerId}/world-locations` (online) / DLL `IWorldLocationDiscoveryService`
> (offline) the discovery registry reads, under the identical `CacheKey.Of(CacheScope.LocationDiscoveries,
> trainerId)` — one memoised fetch answers both the map and the "Discovered:" toast. P1's stand-in,
> `EmptyWorldMapDiscoveryReader` (every area "???", header "Areas 0/6"), is deleted.

## Where things live

| Path | What |
|---|---|
| `Assets/CR/Content/Defs/WorldMap/WorldMap.asset` | `WorldMapDefinition`: nodes, routes, art addresses, the unknown-area switch. Referenced from `ContentDefinitionProvider.worldMap`. |
| `Assets/CR/Core/Data/Registry/Definitions/WorldMapDefinition.cs` | The SO (client-only presentation config: no table, push or floor seed). |
| `Assets/CR/Core/Data/Logic/WorldMap*.cs` | Engine-free rows (`WorldMapArea`, `WorldMapConnection`), scan merge, validation, fixes, starter layout. |
| `Assets/CR/Core/Data/Logic/AreaSceneContentScan.cs` | Reads each area scene's `AreaDefinition` key/name and its doors' `targetAreaKey`. |
| `Assets/CR/UI/WorldMap/Logic/` (`CR.UI.WorldMap.Logic`) | State builder, layout, navigator, quest targets, text, the viewport (zoom and pan), the label placer and style, the current-location rule, all unit-tested. |
| `Assets/CR/UI/WorldMap/WorldMapTab.cs`, `WorldMapCanvas.cs` | The tab and its canvas. |
| `Assets/CR/UI/Resources/WorldMapTab.uss` | Styles (CrTheme tokens only). |
| `Assets/CR/Progression/IWorldMapDiscoveryReader.cs`, `WorldMapDiscoveryReader.cs` | The discovery seam and its real (P2) implementation. |
| `Assets/CR/Core/Data/Editor/WorldMapDefinitionEditor.cs`, `TrainerProgression/WorldMapTools.cs` | Inspector and tools. |

## Authoring

1. **Scan map areas** (Crystalline Rift Studio → WORLD → Trainer Progression → World map row, or the inspector,
   or `cr_world_map_scan`). The first run creates `WorldMap.asset` and wires it into the ContentDefinitionProvider.
   Every run adds a node per area scene (key = `AreaDefinition.areaKey`, else the scene name; name =
   `AreaDefinition.displayName`) and a route per door pair (`AreaDoor.targetAreaKey`, either direction). A scan
   **never removes** a node or route. It reports nodes with no scene, routes with no door, and doors to an area
   with no scene instead.
2. **Arrange**: select the asset. The inspector preview uses the runtime's own layout. Drag a node to move it,
   and drag its dark corner to resize it. Set the region style (Grassland, Settlement, Highland, Cave, Desert,
   Coast). `cr_world_map_starter_layout` restores the v1 positions of the six current areas.
3. **Validate** (inspector, `cr_world_map_validate`). Every finding has a one-line reason and a one-click next step:

| Finding | Why it matters | Fix |
|---|---|---|
| Area scene with no node | The player can stand there but never see it | Scan |
| Node with no scene / duplicate node | Dead or ignored node | Remove node |
| Name differs from the scene | The map and the arrival banner disagree | Take scene's name |
| Door with no route / route with no door | The map lies about how areas connect | Add / Remove route |
| Route to a missing node | Broken data | Remove route |
| Area with no world location | It can **never** be discovered (areas are discovered through their locations) | Open Trainer Progression → place a Location Trigger, Scan areas |
| Location whose area has no node | It won't appear on the map | — |
| Node outside the map / overlapping nodes | Clipped tile / no route can be drawn | Nudge |
| Art address with no Addressables entry | Falls back to the stylised tile | Select sprite |

The Studio row's light turns red with no asset or any error, amber with drift, and green when clean. It is
recomputed at most every 30 s, because validation reads every area scene.

**Art hooks.** Art is stylised in v1 (no painted art yet). Assigning a sprite to *Background art* or a node's
*Node art* makes it Addressable at `map/background` / `map/<areakey>` and writes that address. There is no
separate step. The runtime paints art only on areas the player knows. A "???" silhouette never shows its
painting.

**Undiscovered areas** (`unknownAreaDisplay`): `Silhouette` (default) shows every area as a dim "???" from the
start. `HiddenUntilAdjacent` shows an undiscovered area only once a connected area is discovered or current.
The header's total counts every node either way.

## Runtime

- **Bindings** (`LocalDevGameInstaller`): `IWorldMapLayoutSource` → `ContentDefinitionWorldMapLayoutSource`
  (the provider's SO); `IWorldMapDiscoveryReader` → `WorldMapDiscoveryReader`. `PlayerMenuWindow`
  injects both, plus `AreaLoader`, **optionally**. Without them the tab says "The map isn't available yet." and the
  rest of the menu works.
- **State**: an area is *Discovered* iff the read reports ≥1 discovered location in it, and *Current* comes from
  `AreaLoader.CurrentAreaKey` (display only: always named and marked, not counted). Everything else is *Unknown*
  ("???"). Keys compare trimmed and case-insensitive (`Meadow` / `meadow`). Location names come only from the
  discovery read (null until discovered). The map never calls the content route `GET /api/v1/world-locations`
  directly — it reads through `WorldMapDiscoveryReader`, same as the discovery registry.
- **Routes**: solid between two known areas, dashed from a known area to an unknown one, and not drawn between two
  unknown ones. Colours come from `--cr-map-edge` / `--cr-map-edge-unknown` through the canvas's
  `--map-edge-known` / `--map-edge-frontier` custom properties.
- **Quest markers**: in-progress quests' uncompleted `VisitLocation` targets, minus the targets already counted,
  mark the area the discovery read places that location in.
- **`Incomplete`**: true only when the trainer is online and the read fell back to the local cache after a
  remote failure (`FreshSource.LocalAfterRemoteFailure`) — the map still renders that local snapshot rather
  than an error, but flags it as possibly behind. Any other failure (not cancellation) returns
  `WorldMapDiscoveryRead.Failed`, which the tab renders as its own error state, never a false all-"???" fog.
- **Navigation**: one focusable button per area. The d-pad/left stick picks the nearest area inside a 45° cone
  (`WorldMapNavigator`), and nothing in that direction keeps focus where it is. The bumpers change tab and B closes
  the menu, as everywhere (which is why they cannot zoom, below); the triggers zoom and the right stick pans here (the
  menu forwards LT/RT only to tabs with an `ISubTabStrip`, and right-stick scrolling skips the Map tab; the right stick
  is no longer part of `UI/Navigate` at all). Focus starts on the current area, and a region focused off screen is
  brought into view. The detail pane follows focus.
- **States**: loading, loaded, unavailable, no session, and an error ("Couldn't load your map. Reopen the tab to
  retry.") when the read fails or is incomplete. It never shows a false all-"???" fog for an online trainer.
- **Layout** is computed from the tab's own size (not the panel height), so UI Scale needs no correction. Under
  900 px of content width the detail pane stacks under the map.

## The open-world map: markers, zoom and pan

In open mode `OpenWorldMapLayoutSource` ([Open World → World map tab](?page=unity/37-open-world)) shows every region (74
of them) over `world-map.png`, with `nodeDisplay = Markers` and `AllVisible` (no fog). Playtest, v0.1.8: "this map could use
more real estate and be a bit more visible". The cause was a layout bug before it was styling: Unity 6 makes the `TabView`
the **logical** parent of its `Tab`s (the content container is only their hierarchy parent) and USS selectors walk logical
parents, so the rules meant to make a tab fill its page, written through `.unity-tab-view__content-container`, never
matched. The Map's host sat at its content's height (318 px of a 520 px page), with a 315 × 238 picture in a 732 × 240
frame, 74 pills of 50 × 29 px with 208 overlapping pairs, and an info panel a third of the width.

- **The tab fills the page.** The Map tab opts in with the class `tab-fill`, and the rule goes through the logical
  parent (`.player-tab-view > .tab-fill`, `… > .unity-tab__content-container`). The map takes everything but a narrow info
  panel (22%, 200 to 280 px) and keeps its aspect ratio.
- **Tiles or markers** (`WorldMapNodeDisplay`, `WorldMapDefinition.nodeDisplay`): `Tiles` is the legacy map of a few
  areas, each a tile of its authored size with its name inside (nowrap, ellipsis). `Markers` is the continent: each region
  a 16 px marker (`NodeMarkerSize`) with its name floating beside it, plain text with a soft halo from theme tokens, no pill.
- **Viewport** (`WorldMapViewport`, pure): a zoom from 1 (the whole map fitted) to 8 and a centre in map space (0 to 1), so
  it survives panel resizes and UI scale; every move is clamped so the view never shows past the image's edge, and an axis
  the whole map fits on is centred. The map **opens at 2.5× centred on the player's marker** (else the middle of their region;
  a map of 12 nodes or fewer opens whole), clamped at the edges.
- **Controls**: the mouse wheel zooms about the pointer; a drag pans once it passes 5 px (so a click still selects); `+` /
  `-` / `0` on the keyboard; the gamepad's **right stick pans** and the **triggers zoom**. Not the shoulders: `UI/NavigateTabsLeft`
  and `UI/NavigateTabsRight` bind them for the tab strip and `PlayerMenuWindow` steps the tab on `performed`, so a shoulder
  press changed tab (and nudged the zoom by about 1% before it did); `WorldMapPadBindingsTests` reads `InputSystem_Actions`
  and fails if the zoom statement names a control either tab action binds. The right stick is also UI navigation, so while
  it alone is deflected (left stick and d-pad at rest) the canvas takes it as a pan and does not hop focus across regions.
  A press that began on the map and was released outside it no longer blocks the next drag (every press starts afresh), and
  a second finger landing mid-drag no longer takes the drag from the first (a press while a drag is captured returns early).
- **Declutter** (`WorldMapLabelPlacer`, pure): names are placed in priority order (the player's region, discovered regions,
  the rest; ties keep the given order), each on the first side of its marker (right, left, above, below) where it lies
  wholly inside the viewport and touches no name already placed and nothing in `keepClear` (the player's own marker). A
  name with no such side is hidden; zooming in spreads the markers and brings it back. Undiscovered regions keep their names
  because the open-world design shows everything; the legacy silhouette map still shows "???". Names are placed exactly in
  the rect the placer cleared.
- **Measured, not guessed.** The first pass cleared room from a guess of 0.62 em a character and then forced the label to
  that width, so any glyph wider than the guess drew over a neighbour ("The Meadow" needs 76 px against 68 cleared at the
  10 px size; 14 wide capitals 148 against 93, which is what a community pack's CJK names look like). The canvas now gives
  every name its size first and measures it with the label's own `MeasureTextSize`, once per size
  (`WorldMapLabelStyle.WidthFor`: the text, the padding either side, a little slack). A label with no resolved style yet
  (new labels on a canvas that is already laid out, as after a language switch) measures NaN: that pass guesses and a
  follow-up placement 32 ms later measures, a few tries at most. The name size runs from 10 px at the whole-map view to
  15 px with zoom (`FontSize`), in half-pixel steps so a held trigger re-measures a handful of times, not every frame.
- **"You are here"** (`WorldMapCurrentLocation`, pure): the open world pins only the region tracker's key and never falls
  back to the legacy `AreaLoader`, which keeps naming the scene it loaded as the menu backdrop ("Village") while the world
  streams; legacy mode is unchanged. Philroe's wagon stands in region 2a, which the region mask itself calls "Village", so
  that panel text is the region's real name, not a legacy key.
- **Tests**: `WorldMapViewportTests` (clamping, anchor-preserving zoom, edges), `WorldMapLabelPlacerTests` (no overlaps at
  three zooms over the 74-region cluster, priority, sides, keep-clear), `WorldMapCurrentLocationTests`,
  `WorldMapOpenWorldRegionTests`, the `WorldMapLabelStyle` width and half-pixel tests, and `WorldMapTabLayoutTests` through
  `RuntimePanelLayoutHarness` at 1280×800 and 1920×1080 ([Player Menu → Layout](?page=unity/10-player-menu-ui)): the map
  fills its page, every shown name is one nowrap line whose **measured** width fits the rect cleared for it and overlaps
  nothing at three zoom levels (wide capitals and CJK included), names grow with zoom, the player's region is always named,
  markers keep their size, the map opens centred on the player (stopped at an edge near one), zoom and pan stay inside the
  image, a region focused off screen is brought into view, a language switch re-bakes the names on the laid-out canvas, a
  two-finger drag with real pointer events, and a legacy tile map opens whole. Removing the fill class or `white-space:
  nowrap` turns them red.

## Troubleshooting

- **Quest badges and the detail pane's "Locations n/m" line never appear**: the reader found zero
  discovered locations for that area — either nothing has been discovered there yet, or the offline floor
  lacks `world_location` rows (see below).
- **An area never becomes discovered**: its scene has no Location Trigger (Validate shows "never discoverable").
- **The whole map is "???" offline**: the offline floor lacks
  `world_location` (the Talents content seed has not been exported and rebaked). See
  [Trainer Progression in Unity](34-trainer-progression.md).
- **No route lines**: `--map-edge-known` did not resolve. Check `WorldMapTab.uss` is in `Resources` and
  `CrTheme.uss` defines `--cr-map-edge`.
- **Gamepad jumps to the tab header from the map**: the canvas's `NavigationMoveEvent` handler didn't run on
  the focused node. Check that only node buttons are focusable (`WorldMapTabTests.Only_node_buttons_are_focusable`).

## Related

- [Player Menu UI](10-player-menu-ui.md) · [UI Theme](33-ui-theme.md) · [Trainer Progression in Unity](34-trainer-progression.md)
