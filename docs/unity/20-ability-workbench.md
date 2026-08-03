# Ability Workbench

The Ability Workbench is the editor tooling around `AbilityConfig` authoring. It exists so a
non-technical designer can take an ability from "empty asset" to "fully-effected, published, and
verified" without ever touching a GUID, key string, AssetReference field, or the Addressables
window. Everything technical stays available under an **Advanced** foldout.

## The designer workflow

1. Open an ability (inspector, or inline in Content Studio's Abilities tab).
2. Read the **readiness strip**: `Basics ✓ · Effects 2/3 · Sound 0/3 · Not published`.
3. Fill the **Effects** slot cards (Cast / Travel / Impact) via **Choose Effect…** — this opens
   the FX Library picker. Travel is optional (projectile moves only).
4. Fill the **Sound** rows (Cast / Hit / Miss) the same way; the ▶ button auditions the clip.
   Miss is optional.
5. Or skip 3–4 entirely: **Start from template…** fills all six slots from an
   `AbilityFxTemplate` in one click.
6. **▶ Preview** plays cast → travel → impact between two marker capsules in the Scene view,
   edit-mode, using the scene sequencer's real timing values when a battle scene is open.
7. Click **Publish**. One button runs: validate → register addressables (the ability *and* every
   assigned effect/sound) → derive keys → sync ability → sync status effects, and reports each
   step as a plain-language checklist.

## Components

| Piece | File(s) | What it does |
|---|---|---|
| Readiness calc | `Assets/CR/Core/AbilityWorkbench/Logic/` | Pure `AbilityReadiness.Compute(snapshot)` — shared by the inspector strip, Studio chips, and audit. Own asmdef (`CR.AbilityWorkbench.Logic`) with EditMode tests; `AbilitySnapshotBuilder` (editor) gathers the Addressables facts. |
| Inspector | `Assets/CR/Core/Data/Editor/AbilityConfigEditor.cs` | Simple view (strip, slot cards, sound rows, status effects, Publish) + Advanced foldout (keys, raw refs, individual sync buttons, priority/multiplier/camera cue, FX lifecycle: **Auto-Stop FX** + **Stop Delay (ms)** — stop each stage shortly after the next one starts; default on / 50ms). |
| FX picker | `.../Editor/AbilityWorkbench/AssetPickerWindow.cs`, `FxLibraryScanner.cs` | Virtualized thumbnail grid over the project's FX prefabs (ParticleSystem/VFX Graph detection), element filter chips (canned path searches), size warnings on >500 KB prefabs; audio mode with audition. One pick = assign + register addressable + derive key. Scan roots are hardcoded in the scanner — extend the array when adding an FX pack. |
| FX thumbnails | `.../Editor/AbilityWorkbench/FxThumbnailBaker.cs` | Real baked previews for effect slot cards and picker cells: instantiates the prefab in a preview scene, simulates particles/VFX Graph to mid-burst (0.5 s), renders one URP frame. PNGs cache under `Library/CRFxThumbnails/` (machine-local), invalidated when the prefab is newer; picker bakes are budgeted per repaint. Safety valve: **CR → Ability Workbench → Clear FX Thumbnails**. |
| Publish pipeline | `.../Editor/AbilityWorkbench/AbilityPublishPipeline.cs` | Ordered steps with per-step results; `RunAll` (Studio "Publish All") probes server reachability first and shows a cancelable progress bar. Publish state is session-only (chip goes gray after a domain reload — honest, not stale). |
| Preview | `.../Editor/AbilityWorkbench/AbilityFxPreviewer.cs` | Edit-mode rig (HideAndDontSave + marker component + domain-reload sweep); explicit `ParticleSystem.Simulate` ticking and `VisualEffect.Simulate` for VFX Graph. Safety valve: **CR → Ability Workbench → Clear FX Preview**. |
| Templates | `.../Editor/AbilityWorkbench/AbilityFxTemplate.cs` | Editor-only SO holding a six-slot FX loadout. Store assets under `Assets/CR/Content/Editor/FxTemplates/` (never in the shippable `Defs/` tree). |
| Studio chips | `ContentStudioTool.cs` (Abilities tab) | Per-row readiness chips (`FX 2/3 · SFX 0/3`) + **Publish All**. |
| Audit | `ContentAuditTool.cs` (`Ability FX` category) | Per-slot checks: asset assigned but not addressable (Fix button registers + fills key), key with no Addressable entry, key resolving to a non-FX asset (e.g. a creature prefab on a hit-VFX key). |

## Address conventions

**Pack assets are adopted on use** (`FxAssetAdopter` + pure `FxAdoptionRule`): any effect picked
(or drag-and-dropped — Publish catches those and repoints the reference) from outside `Assets/CR/`
is copied into `Assets/CR/Content/Effects` (clips under `Effects/Audio`) and the config references
the CR-owned copy — third-party packs can be reorganized or trimmed without breaking content.
Adoption is idempotent: copies are stamped with the source GUID (importer userData), re-picking
the same pack asset reuses the existing copy, and a byte-identical hand-copy already in the folder
is claimed rather than duplicated. Dependencies (materials/textures) still resolve into the pack;
Addressables bundles them automatically.

Effect prefabs register as `fx/<name-kebab>`, clips as `sfx/<name-kebab>`, in the `CRContent`
group. `AddressableContentRegistrar.EnsureAssetAddressable` keeps an existing address if the
asset is already registered, and uniquifies (folder suffix, then GUID prefix) when FX packs
repeat prefab basenames. All registrar calls are behind `CR_ADDRESSABLES`; without the define the
workbench degrades visibly ("addressables unavailable") instead of failing to compile.

## Readiness rules

- A slot is **Ready** when its AssetReference resolves to an Addressables entry — regardless of
  the stored key string (mirrors the sync path's `KeyOrDerived` fallback), or when a bare key is
  set (the audit validates that the key actually resolves).
- **Essential** effects = Cast + Impact; essential sounds = Cast + Hit. Travel and Miss are
  optional and never block.
- Blocking errors: empty name, accuracy outside 1–100, negative cost, missing target type.
  Status-category moves with Power > 0 warn but don't block.

## Authoring starter templates (one-time)

Create 4–6 `AbilityFxTemplate` assets by hand (Assets → Create → CR → Editor → Ability FX
Template) under `Assets/CR/Content/Editor/FxTemplates/` — e.g. Fire Projectile, Melee Slash,
Water Beam, Buff. Use the FX picker on a scratch ability to find good prefabs in the Vefects /
VFX_Klaus / Piloto Studio packs, then drag the same prefabs into the template. Templates are ordinary assets:
designers can tweak or add more at any time.

## Remember the floor

Publishing syncs keys to the **server** only. Offline play reads the baked `game-data.bytes`
floor, and the floor is baked **from migration seeds alone** — keys that live only in the server
DB or in the `AbilityConfig` assets vanish on the next rebake. The canonical id for an ability is
the id on its `AbilityConfig` asset — never invent a new one.

Drift is surfaced automatically: every **Publish** run ends with an "Offline floor seed" step
that compares the current configs against the exported migration and warns when an export +
rebake is pending (publish alone only reaches the server).

The same operations are exposed as dialog-free **Pipeline CLI commands** (`CrPipelineCommands`,
requires `com.unity.pipeline` + the Unity CLI): `unity cmd cr_fx_seed_status`,
`unity cmd cr_export_fx_seeds`, and `unity cmd --timeout 300 cr_rebake_floor` run against the
open Editor — automation (or an agent) can run the whole export→rebake loop without touching
menus. Note for anything that spawns `dotnet` from the Editor: strip Unity's inherited
`DYLD_*`/`DOTNET_*`/`MSBuild*` env vars first (see `GameDataFloorTools.ExtendPath`).

Two menu items close the loop after an authoring session (no terminal needed):

1. **CR → Content → Export Ability FX Seed Migration** (`AbilityFxSeedMigrationExporter`) —
   snapshots every AbilityConfig's presentation values (animation, camera cue, all six FX/SFX
   keys — auto-derived from the AssetReference when the string key is blank — and the FX
   lifecycle settings) into cr-api's `M9997SyncAuthoredAbilityFx`. The file is **regenerated in
   place** (rows sorted by name, so diffs read cleanly) by pure, unit-tested
   `AbilityFxSeedMigrationGenerator` (`CR.AbilityWorkbench.Logic`). The export is
   *authoritative*: clearing a key on the config clears the column. Databases that already ran
   the migration (the live server) receive changes via Publish instead; the floor is rebaked from
   scratch so it always reflects the latest export.
2. **CR → Content → Rebake Offline Floor** (`GameDataFloorTools`) — runs the cr-api
   Migrations.Tool in the background, copies the fresh `game-data.bytes` + schema-version file
   into `StreamingAssets/CR`, refreshes the AssetDatabase, and reports the schema version. The
   exporter offers this as a one-click follow-up. Use **CR → Content → Full Package Rebuild**
   instead when cr-api *C#* changed, not just content — that shells the whole
   `build-packages.sh`.
