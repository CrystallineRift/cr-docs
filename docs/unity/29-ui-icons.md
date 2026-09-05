# UI Icons

Every 2D icon the game shows — bag rows, shop and market rows, the battle HUD's move list, status
badges, creature portraits — comes from one address space, through one loader, with one placeholder.

## The bug this replaced

There were five near-identical private `ApplyIcon` / `LoadIconAsync` helpers — team, storage, shop,
journal, achievement toast — and **every one of them passed the entity's `AssetKey` to
`LoadAssetByKeyAsync<Sprite>`.** That key addresses a *prefab*, so the load could only ever return
null. Each screen swallowed the null and showed a styled blank, which is why nobody noticed for
months: an empty square is indistinguishable from a not-yet-authored one.

Two things fix that, and neither works without the other:

1. **Icons get their own key.** `icon_asset_key` on `item`, `creature`, `abilities` and
   `status_conditions` (see [Item Effects](../backend/19-item-effects.md)), authored as
   `icons/<type>/<key>`, separate from the prefab's `asset_key`.
2. **One loader.** `UiIcon.Apply` is the only place in `Assets/CR` that calls
   `LoadAssetByKeyAsync<Sprite>`, so the mistake can only be made once.

## Files

| File | Purpose |
|---|---|
| `Assets/CR/Core/Data/Logic/IconAddress.cs` | `For(type, key)` / `TryParse` — the address rule. Engine-free (`CR.Core.Data.Logic`) |
| `Assets/CR/Core/Data/Logic/IconGlyph.cs` | `From(name)` — the two-letter fallback. Same asmdef |
| `Assets/CR/Core/Data/Logic/IconMap.cs`, `IconCopy.cs`, `IconPlan.cs`, `IconMapPlan.cs` | The importer's plan, unit-tested without the Editor |
| `Assets/CR/UI/Common/UiIcon.cs` | The loader |
| `Assets/CR/UI/Resources/UiIcon.uss` | `.ui-icon`, `.ui-icon--placeholder`, `.ui-icon-glyph` |
| `Assets/CR/Core/Data/Editor/IconSlotField.cs` | The shared inspector row on all four SO editors |
| `Assets/CR/Core/Data/Editor/Icons/IconLibraryImporter.cs` | `cr_import_icons` |
| `Assets/CR/Core/Data/Editor/Icons/CreaturePortraitBaker.cs` | `cr_bake_portraits` |
| `Assets/CR/Core/Data/Editor/Icons/IconSpritePublisher.cs` | The one writer for an icon slot |
| `Assets/CR/Core/Data/Editor/Icons/IconImportReport.cs` | What either tool actually did, as text |
| `Assets/CR/Art/Icons/icon-map.json` | Content key → source sprite path |
| `Assets/CR/Art/Icons/README.md` | The artist-facing version of this page |

## Authoring: `icon` + `iconKey`

Four ScriptableObject types carry the same pair:

```csharp
[Tooltip("2D icon shown in the bag, shop, market and battle bag. Assign the sprite; the key below is derived from its Addressables address.")]
public AssetReferenceSprite? icon;

[Tooltip("Addressables address of the icon sprite (icons/items/<contentKey>). Syncs to items.icon_asset_key.")]
public string iconKey = string.Empty;
```

| SO | Address | Backend column |
|---|---|---|
| `ItemDefinition` | `icons/items/<contentKey>` | `item.icon_asset_key` |
| `CreatureDefinition` | `icons/creatures/<contentKey>` | `creature.icon_asset_key` |
| `AbilityConfig` | `icons/abilities/<abilityName>` | `abilities.icon_asset_key` |
| `StatusConditionConfig` | `icons/status/<conditionName>` | `status_conditions.icon_asset_key` |

Abilities and status conditions are keyed by their **name, spaces and all** (`icons/abilities/Fire
Blast`), because `AbilityConfig` has no `contentKey` — only a GUID `id` and `abilityName`. The stored
`iconKey` is the string the runtime loads, so nothing recomputes an address from a name at runtime;
the choice only affects the file name and the address text.

:::warning[The key is derived from the sprite — an empty key is a silent no-op]
`IconSlotField` writes both halves together: assigning the sprite registers it addressable at
`IconAddress.For(type, key)` and fills `iconKey` from the address the registrar returns. Assign the
sprite through the inspector row rather than dropping a GUID into the field, or you get an
`AssetReference` that resolves and a key that does not, and the icon silently never appears.
:::

`IconSlotField` is one shared implementation for all four editors (`ItemDefinitionEditor:88`,
`CreatureDefinitionEditor:93`, `AbilityConfigEditor:211`, `StatusConditionConfigEditor:39`) rather
than four copies of the same three-step. It writes through the caller's **live** `SerializedObject`,
because the row is drawn inline in `OnInspectorGUI` and a second `SerializedObject` would race the
editor's own `ApplyModifiedProperties`. It also caches loaded sprites in a bounded static dictionary
keyed on `(GUID, subObjectName)` so it does not hit `AssetDatabase` on every repaint.

### `IconAddress`

```csharp
IconAddress.For("items", "item_antidote")   // "icons/items/item_antidote"
IconAddress.TryParse("icons/items/x", …)    // true  -> ("items", "x")
IconAddress.TryParse("creatures/cindris", …)// false -> a PREFAB address, not one of ours
```

Type constants: `IconAddress.Items`, `.Creatures`, `.Abilities`, `.Status`.

The type segment is what keeps two content types that share a key apart — an item and a creature may
both be authored as `ember`, and one address for both would hand the creature's portrait to the bag
row. `TryParse` keeps **every** remaining segment as the key: an address whose tail was silently
truncated would resolve to a *different* asset rather than failing, and that is the kind of wrong that
only shows up as a missing icon.

### `IconGlyph`

`IconGlyph.From(name)` is the first two non-blank characters of a name, upper-cased with
`CultureInfo.InvariantCulture`, or `"?"` when there is nothing to abbreviate. Invariant casing on
purpose: a Turkish locale would turn the "i" of "Ice" into "İ", a different glyph in the same UI
depending on the player's machine.

## `UiIcon.Apply`

```csharp
UiIcon.Apply(VisualElement target, string? iconKey, string fallbackText,
             IGameAssetLoader? loader, ICRLogger? log = null)
```

What it does, in order:

1. Adds `.ui-icon` to `target` and makes sure `UiIcon.uss` is on the panel root — immediately if the
   element is attached, otherwise via a **one-shot** `AttachToPanelEvent` callback that unregisters
   itself. (`UiIcon.EnsureStyleSheet(root)` does the same eagerly; a screen that calls it once when it
   builds saves the per-row callback.)
2. Cancels whatever this slot was loading. Safe to call again on the same element: a list that rebinds
   its rows mid-load cannot end up with the old row's sprite over the new row's icon.
3. **Puts the placeholder up first, always.** `.ui-icon--placeholder` on the slot plus a
   `pickingMode: Ignore` `Label.ui-icon-glyph` child with `IconGlyph.From(fallbackText)`. A slot that
   kept the previous row's sprite until the new one resolved would attribute one creature's art to
   another for as long as the catalogue took to answer.
4. Returns early with no loader or a blank key — the placeholder is the answer.
5. Otherwise starts a fire-and-forget load against a fresh `CancellationTokenSource`, and on success
   sets `style.backgroundImage`, drops the placeholder class and removes the glyph label.

Three details worth knowing:

- **In-flight loads live in a `ConditionalWeakTable<VisualElement, CancellationTokenSource>`, not in
  `userData`.** `userData` belongs to whoever built the element — `GeneratedCreatureListView` and
  `TeamManagementView` keep their own state there — and an earlier version wrote into it while
  refusing to clear anything it did not recognise. The weak table also means a screen torn down
  mid-load leaks nothing.
- **The result is `sprite == null`, never `is null` or `??`.** Unity fake null only compares equal
  through `==`.
- **It is deliberately not gated on `target.panel != null`.** Every one of the five loaders it
  replaces had that check, and so dropped the sprite for any row whose load finished before it was
  parented. Staleness is handled by the per-element token instead.

### USS

`UiIcon.uss` sets `-unity-background-scale-mode: scale-to-fit` (letterbox rather than distort),
centres its children and clips overflow. It deliberately sets **no width or height** — a slot is sized
by whatever it already is: `.featured-portrait` is 100% of a card, `.status-badge` is a 20×20 chip, a
bag row icon is 28px. Sizing here would flatten all of them into one shape the moment a screen adopted
the loader.

The glyph label is absolutely positioned across the slot so it can never widen it — a two-letter label
inside a 9px status badge would otherwise push the badge out of its row.

`.ui-icon--placeholder` is a faint tinted plate: "nothing here yet" reads better than a transparent
box, which reads as a bug. Because `UiIcon.uss` is attached to the *panel root* at runtime, its
single-class rule lands last, so themed empty states are restated with two-class selectors
(`.status-badge.ui-icon--placeholder`, `.cmd-icon.ui-icon--placeholder`,
`.featured-portrait.ui-icon--placeholder`, …) rather than being flattened to one neutral grey.

### Logging — what it actually does

:::note[Missing icons are quiet by design]
A key that resolves to nothing logs **one `log?.Debug(...)` line per failed `Apply` call**, never a
warning:

```
[UiIcon] Nothing addressable at icon key 'icons/items/item_revive' — the placeholder stays.
```

An exception out of the load logs the same way (`Could not load icon '<key>': <message>`), and an
`OperationCanceledException` — a rebind — logs nothing at all. Un-authored icons are the expected
state during content work, and a warning per row would bury the console on every bag open.

The only `Debug.LogWarning` in the class is the missing-stylesheet one, and it is guarded by a static
`_styleSheetMissingLogged` flag so it fires **once per session**.

Note what this is *not*: there is no per-key deduplication. A bag of 40 rows whose icons are all
un-authored writes 40 Debug lines per open, and a list that rebinds writes them again. That is
tolerable because the lines are Debug — but on a Steam Deck build with Debug logging enabled, a
long session in the bag or the market is the place to look if the log file grows. If that becomes a
problem, a `HashSet<string>` of already-reported keys inside `UiIcon` is the one-line fix.
:::

## Where icons are painted

| Screen | Slot | Key source |
|---|---|---|
| Bag rows + detail | `bag-detail-icon`, row icon | `BaseItem.IconAssetKey` |
| Team featured card + squad cards | `.featured-portrait` | `CreatureContentDef.IconKey` ← `BaseCreature.IconAssetKey` |
| Storage box slots | `.storage-slot-portrait` | `StorageEntry.IconKey` |
| Journal achievement cards + toasts | card icon | `AchievementDefinition.IconAssetKey` |
| Merchant shop rows | `.shop-item-icon` | `MerchantShopItem.IconAssetKey` |
| Market browse + my-listings rows | row icon | `IGameContentRegistry.TryGetCreature(SpeciesContentKey).IconKey` |
| Battle HUD ability rows | `.cmd-icon` | `WildAbilityDto.iconAssetKey` |
| Battle HUD bag rows | `.cmd-item-icon` | `BattleBagItem.IconAssetKey` |
| Battle HUD status badges | `.status-badge` | a name → key map built once per session from `IStatusConditionDomainService` |
| Bag target picker | `.target-picker-portrait` | `TargetCandidate.IconKey` ← `SpeciesInfo.IconKey` ← `BaseCreature.IconAssetKey` |
| Bag target picker | `.target-picker-badge--icon` | `StatusBadge.IconKey`, only when `StatusBadge.HasIcon` |

### A status chip is two shapes, not one

`CreatureTargetPicker.BuildBadge(StatusBadge)` returns different elements depending on
`StatusBadge.HasIcon` (`!string.IsNullOrWhiteSpace(IconKey)`, in the engine-free assembly so it is
unit-tested):

| `HasIcon` | Element | Why |
|---|---|---|
| false | a `Label` chip carrying the condition name | A word reads fine. Handing a `Label` to `UiIcon.Apply` would leave its own text sitting behind the glyph child the placeholder adds — two overlapping strings |
| true | a 14×14 `VisualElement` (`.target-picker-badge--icon`, `tooltip` = the name) painted by `UiIcon.Apply` | The sprite replaces the word; the name survives as the tooltip and as the glyph fallback |

`.target-picker-badge--icon .ui-icon-glyph { font-size: 7px }` is a two-selector rule so it beats
`UiIcon.uss`'s `.ui-icon-glyph { font-size: 11px }` on specificity regardless of attach order — an
11px glyph inside a 14px chip clips.

The battle HUD's status badge used to be a four-letter truncation of the condition name, which made
"Confused" and "Confounded" the same badge. It is now an icon slot with the two-letter glyph as its
fallback, and `.status-badge` had to become a fixed 20×20 box — an absolutely-positioned glyph
contributes nothing to layout, so a padding-sized badge would have collapsed to zero.

The status-badge lookup is **name-keyed**, because status events carry only the condition's name. Two
conditions with the same name would collide; the server's unique index on `status_conditions.name`
makes that impossible today, but the coupling is worth knowing about.

## Importing icons from a pack

Icons come out of purchased art packs. Pointing an `ItemDefinition` straight at a pack asset means the
day someone re-imports, renames or prunes `Assets/Third Party`, every bag row goes blank and nothing
tells you which ones. So CR owns a copy.

### 1. Get the packs

Three Asset Store packs back the three hand-mapped sections. They are downloaded through the indexed
Asset Store library (see [Area Scenes](22-area-scenes.md) for `cr_asset_search` / `cr_asset_status`):

| ForeignId | Pack | Publisher | Section |
|---|---|---|---|
| `217341` | 3000+ RPG Item Icons | Blink | `items` |
| `265728` | Fantasy Status Icons | Hippo | `status` |
| `200510` | 500 RPG Spell Icons - Fantasy | Blink | `abilities` |

`cr_asset_download` takes a comma-separated `ids` argument (from `cr_asset_search`), and
`cr_asset_status` polls the same ids. It reflects into Unity's own `AssetStoreUtils.Download` through
AssetInventory's `AssetDownloader`, so it **only works in a signed-in Editor** — there is no offline
path. Progress lands in the Asset Store cache on disk, which is why `cr_asset_status` reads the
filesystem rather than any object the command owns, and stays correct across separate CLI
invocations. `cr_asset_import` then imports what came down.

:::note[Named CLI flags and `--args`]
`CrIconCommands` declares its parameter as `[CliArg("args", …)]` on purpose: the `unity` CLI hands
everything after `--args` to the server as a **single string under the key `args`**, so `args` is the
only parameter name that reliably binds. `cr_asset_download`'s parameter is named `ids`, so drive it
from the Editor or check the binding before scripting it — an argument that does not bind arrives
empty and the command answers `no ids given` rather than failing loudly.
:::

### 2. Fill in `icon-map.json`

`Assets/CR/Art/Icons/icon-map.json` maps a content key to the **project path** of a source sprite:

```json
{
  "items":     { "item_antidote": "Assets/Third Party/RPG Icons/potion_green.png", "item_revive": "" },
  "status":    { "Asleep": "" },
  "abilities": { "Fire Blast": "" }
}
```

Three sections — `items`, `status`, `abilities`. Creatures are **absent on purpose**: their icons are
rendered from prefabs by the portrait baker, never hand-mapped. The file ships complete and empty (23
item keys, 11 status names, 37 ability names, all `""`) so it can be filled in a few keys at a time.

| Value | Reported as | Meaning |
|---|---|---|
| `""` or whitespace | **missing** | No icon chosen yet. The normal state of a fresh map, never an error |
| a path not on disk | **not found** | A typo, and it is meant to be loud |
| a real path | **copied** | Imported, made addressable, written to the definition |

The keys are whatever a designer actually types: `ItemDefinition.contentKey`,
`StatusConditionConfig.conditionName`, `AbilityConfig.abilityName`. Newtonsoft binds `IconMap`'s
public lowercase fields by name, and an omitted section deserializes to null, which
`IconMapPlan.Build` plans as nothing rather than throwing.

### 3. Run it

```
CR → Icons → Import From Map
unity cmd --project-path <project> cr_import_icons
unity cmd --project-path <project> cr_import_icons --args map=Assets/CR/Art/Icons/other-map.json
```

Per entry the importer copies the source to
`Assets/CR/Art/Icons/<Items|Status|Abilities>/<key><ext>` (the source's extension survives, so a
`.jpg` pack icon is not renamed into a lie), imports it as a **256px sprite** with
`alphaIsTransparency` and no mipmaps, registers it addressable at `IconAddress.For(section, key)`, and
writes `icon` + `iconKey` onto the matching definition.

Re-running is safe and is the expected workflow. It is `File.Copy` + `ImportAsset`, **not**
`AssetDatabase.CopyAsset`: `CopyAsset` copies the `.meta` too and risks minting a new GUID for an
existing destination, which would dangle the addressable entry while the old entry still owned the
address, and the address uniquifier would then quietly hand the icon a *suffixed* address. Copying
only the bytes keeps the destination's `.meta`, GUID, addressable entry and every reference to it.

The address is minted from the **definition's own key**, not the map key, so a case-mismatched map
entry (`"burn"` for a condition named `Burn`) cannot register an address the inspector would never
produce. An entry with no matching definition still gets copied and made addressable — so the file is
not lost — and is reported under *skipped*.

A duplicate key reports rather than first-winning:
`<key>: two <Type> assets share this key — using <path>, ignoring <path>`.

`IconMapPlan` sanitises the **file name** but not the content key, so a key containing `../` cannot
escape the icon folders.

## Baking creature portraits

Creatures are the one content type whose icon should never be drawn by hand: the art already exists as
the prefab the battle stager instantiates, and a portrait rendered from it cannot go stale the way a
hand-exported PNG does. Re-running after a model change is the whole point.

```
CR → Icons → Bake Creature Portraits
unity cmd --project-path <project> cr_bake_portraits
unity cmd --project-path <project> cr_bake_portraits --args key=creature_cindris
```

Output: `Assets/CR/Art/Icons/Creatures/<contentKey>.png`, 256px (`IconSpritePublisher.MaxTextureSize`,
the same budget as the imported icons), addressable at `icons/creatures/<contentKey>`, written onto
the `CreatureDefinition`.

The render is the preview-scene technique `FxThumbnailBaker` uses — a `PreviewRenderUtility` with its
own scene, camera and lights, `BeginStaticPreview` → `camera.Render()` → `EndStaticPreview` — because
Unity's built-in `AssetPreview` gives no control over framing, lighting or background alpha, and a
portrait needs a transparent background to sit on a HUD.

Framing constants (all in `CreaturePortraitBaker`): pitch 20°, yaw **215°**, field of view 30°, margin
1.08. The yaw is `180 + 35` rather than `35` because Unity models face `+Z` — a camera parked on `−Z`
photographs the creature's back. The camera is pulled back to fit the bounding **sphere**: at 30° that
needs `radius / sin(fov/2) ≈ 3.9 × radius`, not a fixed `2.2 ×`, which would crop tall creatures.

The baker classifies its own output, because a preview render that silently produces one flat colour is
the failure worth catching — the file is written, the report says "baked", and nobody looks at the PNG
until a HUD is full of empty squares:

| Outcome | Bucket | Behaviour |
|---|---|---|
| Every pixel one flat colour | `failed` | **The file is not written.** `check the render pipeline and the prefab's renderers` |
| No pixel has alpha < 255 | `notes` | Written and assigned, plus `rendered with an OPAQUE background — the portrait will sit on a solid rectangle in the HUD` |
| Otherwise | `copied` ("baked") | `<key> → <destination> @ <address>` |

`OPAQUE` is a `Notes` entry, not `Skipped`, on purpose: the entry succeeded, and inflating "skipped"
would make the count line lie.

### Why the baker renders twice

The first bake of every creature came back `OPAQUE`: under URP, `EndStaticPreview` chooses its own
readback format and drops the clear colour's alpha, so a `Color.clear` background arrives as a solid
dark-grey square. Rather than fight the pipeline with an owned `RenderTexture`, the baker renders each
creature **twice** — once over black, once over white — and hands both buffers to
`PortraitMatte.Resolve` (`Assets/CR/Core/Data/Logic/PortraitMatte.cs`, engine-free, so it is unit
tested like any other logic):

- a pixel that is pure background differs by exactly 255 between the two renders → alpha 0;
- a pixel the creature fully covers does not differ → alpha 255;
- an edge pixel differs in proportion to how much background shows through → that difference is the
  missing coverage, `alpha = 255 − avg(white − black)`.

The over-black render is the premultiplied colour, so dividing it by the recovered alpha gives the
straight RGB a PNG wants. The difference is averaged over the three channels so one noisy channel
(specular, anti-aliasing) cannot decide a pixel on its own. `PortraitMatteTests` pins the arithmetic:
pure background → transparent, fully covered → colour kept and opaque, half-covered edge → alpha 128
with its straight colour, plus rejection of mismatched or partial buffers.

The blank/opaque classification above still runs on the matted result, so a pipeline change that
breaks either render is still caught at bake time.

## The report

Both tools return an `IconImportReport` — the whole output of a one-shot command, so it lists names
rather than only counts ("3 missing" tells you nothing you can act on):

```
copied 0, skipped 0, missing 71, not found 0, failed 0, notes 0

missing (no source in the map) (71):
  items/capture_crystal_shard
  …
```

Buckets: `Copied` (relabelled `baked` for the portrait tool), `Skipped`, `Missing`, `NotFound`,
`Failed`, `Notes`.

## Sync to the backend

Icon keys ride the existing Content Studio push/pull. `ContentCreatorSyncHelper` and
`AbilityEditorSyncHelper` carry `iconAssetKey` on every DTO in both directions:

- **Push** uses `SyncFieldMerge.PreferLocalUnlessBlank(local, server)` — an authored key wins, a blank
  local field leaves the server's value alone, and both blank push `null` rather than `""`.
- **Pull** uses `PreferServerUnlessBlank`. The two directions deliberately disagree, and each has its
  own tests.
- The item push runs the local value through `KeyOrDerived(def.iconKey, def.icon)` first, so a designer
  who assigned the sprite but never derived the string still gets the icon to the server.

`GET /api/v1/abilities` hand-writes its projection field by field rather than serialising
`BaseAbility`, so `iconAssetKey` had to be added there explicitly
(`Creatures/CR.Creatures.Service.REST/Endpoints/AbilityEndpoints.cs:162`) — a standing trap for every
future model property, pinned now by `AbilityListIconAssetKeyHttpTests`.

The content manifest carries it too: `CreatureManifestEntry.iconAssetKey` and
`ItemManifestEntry.iconAssetKey` feed `ServerContentRegistry`, so an online player's registry has icon
keys without a separate fetch.

### The online cache

`ContentSyncWriter` upserts server content into the online cache DB, which runs the same migrations,
so `icon_asset_key` is present there. It is written for **two** of the four tables:

| Table | Icon key in the cache | Why |
|---|---|---|
| `abilities` | Written — column list, `VALUES`, and `ON CONFLICT … DO UPDATE SET icon_asset_key = excluded.icon_asset_key` | `SyncAbilityDto.IconAssetKey`, from `AbilityEndpoints`' `iconAssetKey` projection |
| `creature` | Written, same three places | `SyncCreatureDto.IconAssetKey`; `/api/v1/creatures` returns `BaseCreature`, which carries it |
| `item` | Not written | This class has no `INSERT INTO item` at all — items are not synced through it |
| `status_conditions` | **Not written** — parked | The writer does touch the table, but with `INSERT OR IGNORE` so it can never overwrite migration-seeded columns the server does not carry. More to the point, the ability endpoint's nested `conditions` objects carry no `id` and no `iconAssetKey` — only name, `applyToUser`, `probability`, `durationTurns` and `statChanges`. Adding the column would mean inventing a DTO field the wire never fills |

Both written bindings go through `NullIfBlank(...) ?? DBNull.Value`, matching every other optional
string column in the file: `""` becomes `NULL`, so a blank key can never be stored as an address the
loader dutifully looks up and never finds.

Closing the `status_conditions` gap is a **cr-api** change first — the ability endpoint's `conditions`
projection needs an id and an `iconAssetKey` before the writer has anything to store. Until then, an
online client's status-badge icons are whatever the baked floor gave it, which since the backfill
below is the derived `icons/status/<name>`.

## Seeded rows: the backfill

M6021 and M12012 add the columns; every seeded row landed with them null, so before the backfill the
whole game rendered the placeholder glyph and nothing anywhere reported an error. Two migrations
derive the key from what the importer already used as the address:

| Migration | Table | Rule |
|---|---|---|
| `M6022BackfillItemIconAssetKey` | `item` | `'icons/items/' \|\| content_key` |
| `M12013BackfillContentIconAssetKey` | `creature` | `'icons/creatures/' \|\| content_key` |
| | `abilities` | `'icons/abilities/' \|\| name` |
| | `status_conditions` | `'icons/status/' \|\| name` |

The name-keyed tables keep the display name verbatim — `icons/abilities/Thunder Fang`,
`icons/status/Asleep` — because that is the address `IconLibraryImporter` registered. Lower-casing or
de-spacing the key produces an address the catalog does not contain, which reads as a missing icon
rather than a failure.

Both are `WHERE icon_asset_key IS NULL` (plus "the source column is non-null and non-empty"), so they
are idempotent and never overwrite a key a designer authored. Each `UPDATE` is guarded on its table
**and** its column existing, matching M12012, because the runner is also pointed at per-domain
databases where only some of the three Creatures tables live. `Down()` is a no-op on both: the values
are derivable, and blanking the column would take authored keys with it. Soft-deleted rows are
backfilled too — a derived key on a hidden row is inert, and skipping them would cost an
engine-specific boolean literal for no gain.

:::warning[A later seed is not covered]
A backfill runs **once per database**. Anything seeded by a migration numbered **above 6022 / 12013**
lands with `icon_asset_key` null and stays that way, and so does anything Content Studio pushes
afterwards without a key. Nothing today is affected — the highest item seed is M6020 and the highest
creature/ability/condition seed is M12011 — but a new seed migration must set `icon_asset_key` itself
(`'icons/<type>/' || <key>`, verbatim) or re-register this rule in its own migration. No test guards
it.
:::

After the backfill the baked floor (`Assets/StreamingAssets/CR/game-data.bytes`, schema version
12013) carries a key on every row **with a `content_key`**: 23 items on `icons/items/%`, and zero
remaining nulls on `creature`, `abilities` or `status_conditions`. Two `item` rows with an empty
`content_key` — junk with nothing to derive a key from — are correctly skipped by
`M6022BackfillItemIconAssetKey` and stay unbackfilled. The art is registered at those addresses too:
`cr_import_icons` has run against the filled map (`copied 70, skipped 1` — `toy_bouncy_ball` has a
sprite but no `ItemDefinition`) and `cr_bake_portraits` wrote all 15 portraits with `notes 0`, so 85
definitions carry an `iconKey` and `CRContent` holds 86 `icons/` entries. A slot that still draws the
two-letter glyph is therefore a real miss (a new seed above 6022 / 12013 that did not set
`icon_asset_key`, or a key the map does not know), not the intermediate state it used to be.

Two status chips come from the Blink **spell** set because Hippo's sheet has nothing for them —
`Weakened` (Arcanist12) and `Soaked` (Enchanter16) — so they sit on square painted backgrounds unlike
the other nine. Swap them in `icon-map.json` and re-run the importer when a better source turns up.

## Gotchas

- **`asset_key` is not `icon_asset_key`.** The first addresses a prefab. If a sprite load returns null
  and the key looks like `creatures/cindris`, that is the bug.
- **A blank `iconKey` is not an error anywhere.** Every layer treats it as "not authored yet" and
  falls back to the glyph. That is the point, and it is also why a genuinely broken key is easy to
  miss — check the import report, not the screen.
- **Editor code is guarded.** `IconSlotField` and everything under `Editor/Icons/` is `#if
  UNITY_EDITOR`, and the addressable registration is additionally `#if CR_ADDRESSABLES`.
- **`EnsureAddressable` returns the *existing* address** when the asset is already addressable. That
  is what makes re-runs idempotent, but it also means a destination PNG that somehow already carries a
  different address keeps it, and `iconKey` records that other address rather than `icons/…`. Worth an
  eye on the first run's report.

## Related

- [Item Effects and Status Cures](../backend/19-item-effects.md) — the `icon_asset_key` columns
- [ScriptableObjects](12-scriptable-objects.md) — the `icon` / `iconKey` fields per SO
- [Content Registry](08-content-registry.md) — `IconKey` on the content defs and the manifest
- [Addressables Setup](09-addressables-setup.md) — how addresses are registered
- [Player Menu UI](10-player-menu-ui.md) — the Bag and its target picker
- [Battle System](07-battle-system.md) — HUD ability/bag icons and status badges
