# Standalone Builds (macOS + Windows + Linux/Steam Deck)

How to produce playable desktop builds of Crystalline Rift for macOS, Windows x64, and Linux x64
(Steam Deck) from the macOS editor. The moving pieces: Unity 6 **build profiles**, per-platform **SQLite natives**
shipped inside the CR.Game.Compat package, the baked **game-data.bytes** floor in
StreamingAssets, and **Addressables** content built with the player.

## Build profiles

Profiles live under `Assets/Settings/Build Profiles/`:

| Profile | Target | Notes |
|---|---|---|
| `CR_Game_macOS` | Standalone macOS | Development + script debugging on |
| `CR_Game_Windows` | Standalone Windows x64 | Development + script debugging on; Mono backend (IL2CPP cannot cross-compile Windows from macOS) |
| `CR_Game_Linux_SteamDeck` | Standalone Linux x64 | Steam Deck target; Development + script debugging on; Mono backend |
| `CR_DatabaseManager_Alpha` | Standalone macOS | Pre-existing tooling profile — overrides the scene list; not for the game |

The game profiles follow the **global scene list** (`File > Build Settings` /
`EditorBuildSettings`) — currently `Assets/CR/UI/Test UI.unity` — so adding a scene there flows
into both platforms without touching profiles.

Missing profiles are recreated with **CR → Build → Create Standalone Build Profiles
(macOS + Windows)** (`BuildProfileSetupTool.cs`). Unity 6 has no public profile-creation API, so
the tool calls the internal `BuildProfile.CreateInstance` factory via reflection; if a Unity
upgrade breaks the reflection, the tool logs it and the fallback is the Build Profiles window's
**Add Build Profile** button.

## Scene list

Players boot into **scene 0 of the global scene list** (`ProjectSettings/EditorBuildSettings.asset`),
which every `CR_Game_*` profile inherits. That list is now:

```
0  Assets/CR/Scenes/Core.unity            ← the game (menu, player, UI, Zenject CoreContext)
1–5 Areas/Meadow, Cave, Shore, Crags, Dunes   ← loaded additively at runtime
```

`Assets/CR/UI/Test UI.unity` (the pre-Core scene, still holding two placeholder cylinders) and
`Areas/_AreaTemplate.unity` (an authoring template) are **not in the list**. Until 2026-08-23 Test
UI sat at slot 0, so every player build opened the old scene while the Editor — where you press
Play on Core directly — looked fine. If a build ever shows the cylinders again, check slot 0.
Test UI also must not be open alongside Core in the Editor: both carry a full UI stack and an
EventSystem, and two of each means the menu stops taking input.

## SQLite natives (per platform)

`Microsoft.Data.Sqlite` needs a platform-native `e_sqlite3` next to the managed DLLs.
`build-packages.sh` (`copy_native_libraries`) always bundles **both** into the Unity package:

- `libe_sqlite3.dylib` — macOS arm64 (Apple Silicon; an Intel-mac player would need the
  `osx-x64` dylib instead)
- `e_sqlite3.dll` — Windows x64
- `libe_sqlite3.so` — Linux x64 (Steam Deck)

The file names differ per OS so they coexist in `Runtime/`. **`build-packages.sh` now writes the
PluginImporter `.meta` for each** (`write_native_plugin_meta`): `.so` → Linux64/x86_64,
`.dylib` → macOS, `.dll` → Win64, GUIDs preserved across rebuilds. Before 2026-08-23 Unity
auto-generated a bare stub for the `.so`, which reads as "Any Platform" yet is assigned to
nothing — the Linux player shipped with no SQLite native and the first Steam Deck build fell
over on its very first migration (NullReferenceExceptions under a `CoreContext` error). Because
`bin/` is gitignored, any inspector fix to these flags dies on the next `--clean`; the script is
the only durable place for them.

`Assets/link.xml` preserves every `CR.*.Data.Migration` assembly (FluentMigrator finds
migrations by reflection); add a line there whenever a domain gains a migration project.

A missing native fails at **runtime, not build time** — first DB open throws
`unable to load e_sqlite3`. If a Windows build does this, the dll didn't make it into the
package: re-run `build-packages.sh` and check the "Native libraries found" output lists both.

## Addressables

`AddressableAssetSettings.BuildAddressablesWithPlayerBuild` is set to **Build Addressables
content on Player Build** (was "use per-user preference"), so a player build always carries a
fresh content catalog for its target platform.

**Baked-in vs streamed.** The profile's `Local.*` variables had been repurposed for the MinIO
dev workflow (`Local.BuildPath = ServerData/…`, `Local.LoadPath = http://localhost:9000/…`), so
**no addressable content was shipped inside builds** — every asset tried to stream from the
tester's own localhost. Restored to Unity's true local paths
(`Addressables.BuildPath` / `Addressables.RuntimePath`), so all groups now bake into the build.
`Remote.*` still points at MinIO (now with `[BuildTarget]` instead of a hardcoded
`StandaloneOSX`) for the update pipeline.

**Live updates for shipped builds** (the canonical Addressables content-update flow — baked
floor, streamed deltas):

1. **Build Remote Catalog is currently OFF** (2026-08-23): Remote.LoadPath still pointed at the
   dev MinIO on localhost, so every build's startup catalog check spammed
   `Cannot connect to destination host` on any machine that isn't the dev Mac (first seen on the
   Steam Deck). Turn it back on **only** when a publicly reachable CDN exists, then: ship with
   all groups **local** and *Cannot Change Post Release* (static), remote catalog pointed at that
   host, and keep the release's `addressables_content_state.bin`.
2. To push an update: **Check for Content Update Restrictions** (moves changed static assets
   into a generated remote group) → **Update a Previous Build** → upload the new bundles +
   catalog to the CDN.
3. Players check the remote catalog at startup (`AddressablesCatalogUpdater`), download only
   changed bundles into cache, and load everything else from the baked copy. If the CDN is
   unreachable, the baked catalog is used — builds never hard-fail on it.

## Offline data floor

`Assets/StreamingAssets/CR/game-data.bytes` ships in every build and is the offline content
floor. After backend content changes, re-run `build-packages.sh` (re-bakes the floor) before
building players, or offline play in the build won't see the new content.

## Build checklist

1. `build-packages.sh` fresh (DLLs + both natives + baked floor current) — or **CR > Content >
   Rebake Offline Floor** / `unity cmd cr_rebake_floor` when only content changed.
2. Addressables group is whole: the Ability Workbench **Publish** re-registers every ability's
   FX/SFX (`AbilityPublishPipeline`), which is how `CRContent` is rebuilt if entries go missing;
   an Addressables build (`BuildPlayerContent`) with `error=''` confirms no dangling assets.
3. Server address config: builds read `Assets/CR/Resources/configuration/game_config.yaml` —
   `localhost:8080` only works on a machine running the AIO backend; offline mode works anywhere.
4. **CR > Build > Build Players…** — tick Windows / macOS / Linux, hit **Build** (see below). The
   manual route still works: **File > Build Profiles**, pick a `CR_Game_*` profile → **Build**.
5. Windows build output must keep `<name>_Data/` next to the exe; macOS output is a single
   `.app`.

## Build Players window

`CR/Build/Build Players…` (`Assets/CR/Core/Data/Editor/Build/PlayerBuild/BuildPlayersWindow.cs`)
builds any combination of the three standalone targets from one click. Tick the targets, choose
whether it is a Development build (default on, matching the profiles), press **Build**.

- **Sequential, not parallel.** One Editor process cannot build two players at once —
  `BuildPipeline.BuildPlayer` blocks and switches the active platform — so the queue runs
  Windows → macOS → Linux in that fixed order, one `EditorApplication.delayCall` apart so the
  window repaints its status between targets. The Editor is busy during each build; it comes back
  between them.
- **Each target is its own row**: queued → building… → `✓ 1.2 GB in 94s` with a **Reveal** button,
  or `✗ N error(s) — see Console`. A failure does not stop the queue; the rest still build and the
  console gets one summary line (`Build Players: 2/3 succeeded — …`) at the end.
- **Profiles come from `Assets/Settings/Build Profiles/CR_Game_*.asset`.** A missing one is created
  on the spot through `BuildProfileSetupTool` before the build runs.
- **Output:** `Builds/<Target>/CrystallineRift.exe|.app|.x86_64`. `Builds/` is git-ignored.

The pure rules — target → profile asset, target → output path, queue order, summary text — live in
`PlayerBuild/Logic/PlayerBuildPlan.cs` (asmdef `CR.Core.PlayerBuild.Logic`, no engine references)
with NUnit tests beside it, so the queue and naming are checked without an Editor.

## Distributing the macOS build

A downloaded copy shows **“CR_Alpha” is damaged and can’t be opened** — that's Gatekeeper, not
corruption. Browsers stamp downloads with the `com.apple.quarantine` xattr, and quarantined apps
need a notarized Developer ID signature; Unity builds are only ad-hoc signed. Locally-built
copies are never quarantined, so the machine that built it never sees the error.

- **Tester workaround**: `xattr -cr ~/Downloads/CR_Alpha.app`, then open normally.
  (Right-click → Open does not bypass the "damaged" variant.)
- **Package with** Finder Compress or `ditto -c -k --sequesterRsrc --keepParent CR_Alpha.app
  CR_Alpha.zip` — other zip tools strip symlinks/exec bits and break the bundle for real (same
  error even after `xattr`).
- **Real fix** (before wider distribution): Developer ID cert → `codesign --deep --force
  --options runtime`, `xcrun notarytool submit --wait`, `xcrun stapler staple`.

## Troubleshooting

- **`CS0103: The name 'AotHelper' does not exist`** (in `com.unity.services.core` editor code,
  typically after switching build target): a second vanilla `Newtonsoft.Json.dll` is shadowing
  Unity's AOT-patched `com.unity.nuget.newtonsoft-json` copy. The CR.Game.Compat package
  deliberately does **not** ship Newtonsoft — if the error appears, find and delete the duplicate
  (`find Assets ~/path/to/unity-package -name "Newtonsoft.Json.dll"`); CR DLLs bind to Unity's
  copy at load time.

## Known limits

- Windows and Linux builds from macOS are **Mono** scripting backend (IL2CPP cross-compile
  needs the target OS, or for Linux the `com.unity.toolchain.macos-arm64-linux-x86_64` sysroot
  package).
- **Steam Deck**: build output is a folder (`CR.x86_64` + `CR_Data/`). To run: copy to the Deck
  (desktop mode), `chmod +x CR.x86_64`, add as a non-Steam game (or push via Steam devkit tools)
  and it runs in Game Mode. Deck is 1280×800 — the profile uses default fullscreen; UI Toolkit
  panels scale, but verify HUD readability on-device. Gamepad input needs Input System bindings
  beyond the current keyboard/mouse maps.
- macOS native is arm64-only; the profile's architecture should stay Apple Silicon unless the
  osx-x64/universal dylib is added.
- `applicationIdentifier` still carries the URP template default
  (`com.Unity-Technologies.com.unity.template.urp-blank`) — cosmetic for desktop players
  (affects macOS bundle id), worth fixing before any external distribution.
