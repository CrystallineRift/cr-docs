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

### Linux graphics APIs (Vulkan first)

Linux players are built with the graphics API list `[Vulkan, OpenGLCore]`. Unity uses the first API the machine supports, so the Steam Deck runs Vulkan and a machine without Vulkan falls back to OpenGL Core. Before this change the Linux target used Unity's automatic list and the Deck ran OpenGL Core (`Creating GLContext ... OpenGL Core 4.5` in Player.log), where the PSO trace does nothing (see the Loading Screens page).

The list is applied **at build time only**. `PlayerBuildRunner.Run` (the one place CI's `CiBuild` and both Editor windows go through) wraps `BuildPipeline.BuildPlayer` in `LinuxGraphicsOverride`, which sets the StandaloneLinux64 list, builds, and puts `PlayerSettings` back in a `finally`. `ProjectSettings/ProjectSettings.asset` is never edited by a build, and Windows and macOS builds are untouched. The build log prints the list used: `[BuildPlayers] Linux graphics APIs: Vulkan, OpenGLCore`.

Choose a different list with the command-line argument `-crLinuxGraphics <value>` or the environment variable `CR_LINUX_GRAPHICS` (the argument wins):

| Value | Linux graphics APIs |
|---|---|
| `vulkan` (also the default when nothing is set) | Vulkan, OpenGLCore |
| `gl` | OpenGLCore only |
| `auto` | Unity's own list, untouched (the behaviour before this change) |

An unknown value falls back to the default and logs a warning that names the bad value. CI example: `CR_LINUX_GRAPHICS=gl ci/build.sh 0.2.20 StandaloneLinux64` (the Unity process inherits the environment); the argument form is for running Unity by hand, for example `-executeMethod CR.Core.Data.Editor.Build.CiBuild.Run -crTargets Linux -crLinuxGraphics gl`.

The content (Addressables) build for a Linux target runs under the same override as the player build (`CiBuild` and the Content Deploy tool when the active target is Linux), so bundles and player always agree; the same `[BuildPlayers] Linux graphics APIs: ...` line is logged for that step. If restoring the settings after a build ever fails, the build still succeeds and the log carries an error saying how to restore by hand. `-crLinuxGraphics gl` and `-crLinuxGraphics=gl` are equivalent; a flag with no value, or whose value starts with `-`, logs a warning and is ignored.

**Player-side escape hatch.** A Vulkan build can still be forced onto OpenGL Core at launch without rebuilding: add `-force-glcore` to the Steam launch options (`-force-vulkan` forces the other way). These are Unity's own player arguments; nothing in the game parses or rejects them. Use it if a Deck's Vulkan driver misbehaves, and expect the PSO trace to be skipped while on OpenGL Core.

The pure policy is `CR.Core.PlayerBuild.Logic.LinuxGraphicsPolicy` (tests in `LinuxGraphicsPolicyTests`); the apply-and-restore scope is tested by `LinuxGraphicsOverrideTests`.

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

**Open-world cells are not all in this list.** Cells named in `WorldLayout.addressableCells` ship as Addressables bundles (group `WorldCells`) instead of Build Settings entries. Since 2026-11-11 that is `World_c7_r1` and `World_c7_r4`; the list above plus those bundles is what a player carries. A scene ships exactly one way: `cr_world_validate` reports a built cell that is in both or in neither. Anything that needs "the scenes that ship" calls `ShippedScenes.AllPaths()` rather than reading `EditorBuildSettings.scenes`. See [Open World → Cells from Addressables](?page=unity/37-open-world#cells-from-addressables-pilot-2026-11-11). `ci/build.sh` needs nothing new: `BuildAddressablesWithPlayerBuild` builds the `WorldCells` bundles before the player, and with Local paths they land in the player's StreamingAssets with the other groups.

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

### Moving WorldCells to remote hosting (not enabled)

> **Not enabled.** Nothing below is switched on. `WorldCells` is Local, Build Remote Catalog is off, and every player (Steam, offline, Deck, CI) carries its cells. This section records what flipping the group would take, so the pilot is a known size of work and not a surprise.

What is already in place: the group is one bundle per cell with retry count 3; the loader (`AddressablesCellSceneLoader`) fails a missing bundle like any failed cell load, and the streamer retries and gives up as it does today; `CellPrefetcher` fetches the bundles of addressable cells just past the Dormant ring in the direction of travel (`Addressables.DownloadDependenciesAsync`, one in flight, handle released) and does nothing while bundles are local.

What flipping needs, in order:

1. **Profile.** Point the group's build and load paths at `Remote.BuildPath` (`ServerData/[BuildTarget]`) and `Remote.LoadPath` (`https://content.crystallinerift.com/content/[BuildTarget]`, which `CiBuild` already sets from `CONTENT_URL`). In the group's schema, change the two path dropdowns from Local to Remote. Keep Pack Separately, LZ4 and the retry count. `WorldCellsGroup.Configure` and the `WorldCellsContentTests` schema test pin Local today and must change with it.
2. **Remote catalog.** Turn **Build Remote Catalog** on (`m_BuildRemoteCatalog`) with the catalog's load path on the content host. Today it is off, which is why the player never asks the CDN for a catalog. With it on, every group's `Remote.*` assets stream, and every other group must stay Local and Cannot Change Post Release so the rest of the game still comes from the player. Players already run `AddressablesCatalogUpdater` at startup; if the CDN is unreachable the baked catalog is used.
3. **Build and publish.** `ci/build.sh` then writes the remote group's bundles and catalog to `ServerData/<BuildTarget>/`. `ci/publish.sh` already syncs `ServerData/<T>/` to `content/<T>/` (bundles immutable with a one-year cache header, `.hash` and `.json` no-cache) and invalidates `/content/*`; it skips the step only while no `ServerData/` exists. Confirm the CloudFront behaviour for `/content/*` stays unsigned, since players fetch bundles without a signature (the player zips under `/builds/` are the signed ones).
4. **Offline and Steam builds stay local.** The bundle location is baked into each player's catalog, so one project cannot ship both without a second profile. For builds that must run without a network (the Steam release, offline play), keep a profile where `WorldCells` is Local and build those players with it; hosted builds use the Remote profile. The loader code is the same either way. The Editor's Use Asset Database mode is unaffected.
5. **Content updates.** After a release with remote cells, a changed cell is shipped with **Check for Content Update Restrictions** and **Update a Previous Build** against that release's `addressables_content_state.bin` (the file the CI build dirties; keep it per release), then `ci/publish.sh`.

**First visit versus the edge hold.** A cell whose bundle is not on the device yet has to be downloaded before it can load. With no prefetch that wait lands inside the load: the streamer's load takes seconds instead of a few frames, `WorldEdgeHold` covers the screen and gates input while a built cell within about 4 m is not Active (and toasts "still loading" after 5 s), and the load's retry and give-up logic runs against download time. The prefetcher exists to move that download ahead of the player: it fetches the cells one band past the Dormant ring in the direction of travel, so on a normal walk the bundle is cached before the cell enters the Dormant ring. A player who teleports (a wagon ride) or outruns the fetch still meets the hold. Measure on the Deck over a real connection before moving more than the pilot cells: first-visit time per cell, how often the edge hold shows, bundle sizes per cell (shared dependencies such as terrain layers and materials are duplicated into each Pack Separately bundle unless a shared group holds them; run Addressables Analyze before moving the next cells).

## Offline data floor

`Assets/StreamingAssets/CR/game-data.bytes` ships in every build and is the offline content
floor. **A player build never migrates it**: `GameDataAdopter` copies it as-is, and the content
repositories in the linked cr-api package query whatever columns the package's migrations add. So
the committed floor must carry every migration the package runs, and `game-data_schema_version.txt`
must name the package's head. v0.2.0 shipped the v0.1.9 floor (schema 20002) against a package at
20005: every quest and dialogue sync failed at boot with `no such column: quest_line`.

After backend changes, re-run `build-packages.sh` (it re-bakes the floor and copies it into
`Assets/StreamingAssets/CR/`) and **commit both floor files** before building players; a build uses
the committed floor, and the auto-copy only lands in the working tree. To keep the production overlay
rows a fresh bake drops (story creatures pushed from Studio, such as the gaterbear), migrate the
committed floor forward instead:
`dotnet run --project cr-api/Convenience/CR.Data.Migrations.Tool -- <out.bytes> <out_version.txt> --base Assets/StreamingAssets/CR/game-data.bytes`.
Two guards catch a stale floor: `BundledFloorSchemaTests` (EditMode) and `ci/check-floor-schema.sh`,
which fails the build-game run before the build starts.

## Build checklist

1. `build-packages.sh` fresh (DLLs + both natives + baked floor current) — or **CR > Content >
   Rebake Offline Floor** / `unity cmd cr_rebake_floor` when only content changed — and the two
   floor files committed (see Offline data floor above).
2. Addressables group is whole: the Ability Workbench **Publish** re-registers every ability's
   FX/SFX (`AbilityPublishPipeline`), which is how `CRContent` is rebuilt if entries go missing;
   an Addressables build (`BuildPlayerContent`) with `error=''` confirms no dangling assets.
3. Server address config: builds read the shipping defaults in `Assets/CR/Resources/configuration/GameSettings.asset`
   (never your Studio overrides). A non-Development build **fails the build guard** unless
   `defaultEnvironmentId` is `production` and `defaultWorldMode` equals
   `GameSettingsShipCheck.ShippingWorldMode` — **Open since v0.1.7** (the open world ships). The message says what
   to fix. A missing, empty or unknown `world_mode` still parses as Legacy (a parse rule, not the shipping
   default), and the per-machine Studio override can still pick Legacy for testing. Offline mode works anywhere.
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

## Release builds in CI (`build-game`)

A version tag (`v0.1.8`) on cr-api-unity, or a manual dispatch, runs the GitHub workflow
`.github/workflows/build-game.yml` on the self-hosted Mac runner (`[self-hosted, macOS, unity]`). It
builds the Windows, Linux and macOS players and publishes them to the content CDN, where Crystalline
Rift Studio's Builds page finds them through `GET /api/v1/builds` (see
[Architecture](?page=backend/01-architecture)). The steps are scripts under `ci/`:

1. **`ci/check-vendor-untracked.sh`** fails the run when paid vendor source that installs outside `Assets/`
   is tracked by git: today the Text Animator package, `Packages/com.febucci.text-animator-unity`, which the
   `Assets/**` ignore rules never reach (`.gitignore` names it, without a trailing slash so the symlink the
   next step makes is ignored too, and this catches a forced add).
2. **`ci/link-assets.sh "$CR_ASSET_SOURCE"`** makes the runner's checkout buildable. About 13 GB of
   Asset Store packs under `Assets/` and `Packages/` are not in git, so the script walks the source
   project (the live checkout on the same Mac) and symlinks in whatever the checkout lacks: a missing
   directory whole, a missing file on its own. Tracked files are never touched, so the code that ships is
   exactly the commit. Two things are never borrowed:
   - **SQLite sidecars.** Names ending in `-wal`, `-shm` or `-journal` (and their `.meta` files) are
     skipped. The open Editor keeps `game-data.bytes` in WAL mode, and linking its sidecars shipped
     symlinks to the Editor's live database state inside the players' `StreamingAssets/CR` (the
     0.1.8-playtest1 Mac app had them; on any other machine they dangle). `ci/build.sh` also deletes any
     sidecar already under `Assets/StreamingAssets` before it builds, because older runner checkouts keep
     the links they were given. (cr-api-unity PR #73.)
   - **`Assets/CR`.** The game's own code and content are all tracked, so anything untracked there is
     someone's uncommitted work in progress, and a build must ship the commit, not that. The script
     skips the subtree (`NEVER_LINK`). In the live project the only ignored files under `Assets/CR` are
     `.DS_Store` and `.idea` files. (cr-api-unity PR #74.)

   It also skips `Library`, `Temp`, `Logs`, `Builds`, `ServerData`, `obj`, `UserSettings`, `.git`,
   `.idea`, `.vs` and dot-files at every level.
3. **`ci/check-fx-keys.sh`** fails the run when an ability's sound or effect key, or an address in the
   feedback manifest, names nothing in the Addressables catalogue, before 40 minutes go into a build.
4. **`ci/check-floor-schema.sh`** bakes the package head with the linked cr-api checkout's Migrations.Tool
   and fails the run when the committed floor lacks one of those migration versions or
   `game-data_schema_version.txt` disagrees with the head: a player build never migrates the floor
   (v0.2.0 shipped one 11 migrations behind).
5. **`ci/build.sh <version> [targets]`** runs Unity headless (`CR.Core.Data.Editor.Build.CiBuild.Run`) to
   build Addressables and the players, then zips each one as
   `Builds/CrystallineRift-<Windows|Linux|Mac>-<version>.zip`.
6. **`ci/publish.sh <version>`** uploads `builds/<version>/` (immutable), `builds/latest/`,
   `builds/latest.json` and the version's `manifest.json`, then has `ci/builds-index.sh` merge the version
   into `builds/index.json`. The zips are served only through signed URLs; the JSON stays public.

The runner keeps `Library/` and the asset links between runs (`clean: false`), and resets tracked files
with `git reset --hard HEAD` before each build. A three-platform build takes about 40 minutes.

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

## Deploying to the Steam Deck

**CR > Build > Deploy to Steam Deck…** builds the Linux player and pushes it straight to the Deck
over the network. It replaces the manual loop (build → zip → upload to Drive → download on the Deck
→ unzip → re-add to Steam), which was ten steps, six of which existed only because the transport was
a zip through cloud storage.

The window asks for the Deck's IP, the user (`deck`) and the destination folder, remembers them in
`EditorPrefs`, then runs three steps: the Linux build via the existing `PlayerBuildRunner`, an
`ssh mkdir -p` for the destination, and `rsync` of `Builds/Linux/` into it.

### One-time setup

1. On the Deck, in Desktop Mode → Konsole: `passwd` to set a password, then
   `sudo systemctl enable --now sshd`.
2. On the Mac, use the window's **Copy key-setup command(s)** button and paste into Terminal. This
   has to happen in a real terminal — it needs a password prompt, which the Editor cannot provide.

   :::warning The key goes Mac → Deck, not Deck → Mac
   The keypair must live on the **Mac**, with only its public half copied to the Deck. Generating a
   key on the Deck and copying its `.pub` back to the Mac feels like the same act and accomplishes
   nothing: the private half never leaves the Deck, so the Mac has nothing to authenticate with.
   ssh then quietly falls back to asking for a password — which looks like the connection working
   if you type one in, and then fails inside the Editor, where there is nobody to type it.

   The tell is a `~/.ssh/id_ed25519.pub` whose comment reads `deck@steamdeck`, with no matching
   private key beside it. The window checks for the **private** half for this reason, and offers
   `ssh-keygen` first when it is missing.
   :::
3. Deploy once, then add the printed path as a non-Steam game on the Deck.

Step 3 happens **once, ever**. The destination folder is fixed
(`/home/deck/Games/CrystallineRift`) precisely so the Steam shortcut keeps pointing at a path that
never changes; later deploys replace the bytes underneath it.

The window tracks which of its three actions actually finished as a `SteamDeckOutcome`
(`Connected` / `Deployed` / `LogFetched`), not just whether the last SSH call returned without
error — a mere connectivity check (**Test Connection**) used to leave the window reading
"Deployed." even though no build had been pushed. Only `Deployed` shows the Steam-shortcut path
line, and only `LogFetched` (with a log actually saved) shows the **show saved log** button — it
used to be unreachable because nothing ever set the outcome that gates it.

### Why rsync rather than a copy

rsync transfers only changed blocks, so a code-only rebuild is a small delta rather than a
whole-game copy — that, not the saved clicks, is what makes redeploying quick. `--partial` means a
dropped Wi-Fi connection resumes instead of restarting.

`-a` is not optional: it preserves the executable bit. Without it the Deck receives a file it
cannot launch, which presents as Steam doing nothing at all when you press play.

### When the game opens and immediately closes on the Deck

The window on screen is gone before it can show anything, so the player log is the only account of
what happened. **Fetch Player.log from the Deck** reads it over the same SSH connection; by hand it
is at `~/.config/unity3d/CR/Crystalline Rift/Player.log`.

Two things about that path are worth knowing, because both look like the log being "in the wrong
place":

- It is **not** under the deploy folder. Unity writes to `~/.config/unity3d/<Company>/<Product>/`
  wherever the game is installed, and the path is built from the *company* and *product* names, not
  the executable name — here `CR` / `Crystalline Rift`, so it contains a space.
- Because of that space the path must be quoted in the remote command, and **a tilde inside double
  quotes is not expanded** — the shell looks for a directory literally named `~` and the read fails
  every time. The fetch uses `$HOME`, which does expand inside quotes. Typing the `~` form yourself
  in a terminal is fine; it is only the quoted form that breaks.

The fetch pulls the **tail**, not the whole file: a real session on this Deck produced a 10MB log
with a 43MB predecessor, and streaming that into an Editor window is a hang.

Check these in order:

1. **Is Steam running it under Proton?** A non-Steam game on the Deck frequently gets a
   compatibility tool forced onto it, and a native Linux ELF started under Proton exits instantly
   with no window. Properties → Compatibility → **uncheck** "Force the use of a specific Steam Play
   compatibility tool". This costs nothing to rule out and looks exactly like a crash.
2. **Run it from Konsole** in Desktop Mode: `cd ~/Games/CrystallineRift && ./CrystallineRift.x86_64`.
   Anything that kills the player before Unity initialises — a missing system library, the wrong
   architecture — prints here and never reaches the log.
3. **Read the log** for a managed exception. CR runs its SQLite migrations synchronously during
   Zenject installation at boot, so a data-layer failure takes the whole player down before the
   first frame.

Before suspecting missing files, confirm the build is actually complete — `Plugins/x86_64/
libe_sqlite3.so`, `StreamingAssets/CR/game-data.bytes`, and `StreamingAssets/aa/StandaloneLinux64/`
should all be present, and `file CrystallineRift.x86_64` should report `ELF 64-bit LSB executable,
x86-64`. `rsync -a` preserves the executable bit, which is the one file attribute whose loss
presents as "nothing happens at all".

### Frame pacing on the Deck (uneven / "janky" movement)

Nothing in the project used to set a frame cap or vsync: the **PC** quality level shipped
`vSyncCount: 0` and Unity's default `Application.targetFrameRate` is `-1`, so a desktop build
rendered as fast as the GPU allowed. The Deck's Player.log says so directly — `Default vsync count 0`
right under `Desktop is 1280 x 800 @ 60 Hz`. With frames arriving at whatever rate the APU manages
each instant, Gamescope shows whichever frame happens to be finished at each 60 Hz (or 40 Hz)
scan-out, and the character's 50 Hz physics + interpolated animation gets sampled unevenly: motion
looks uneven even when the average frame rate is fine, and the APU runs flat out for nothing.

The rule now lives in one place, `FramePacingPolicy` (`Assets/CR/Core/Display/Logic`, engine-free,
NUnit-tested) and is applied by `FramePacingBootstrap` before the first scene loads — a static
`RuntimeInitializeOnLoadMethod`, so it cannot be missing from a build:

| Platform | `vSyncCount` | `targetFrameRate` | Why |
|---|---|---|---|
| Windows / macOS / Linux (Deck) | 1 | -1 | vsync is the only pacing locked to real scan-out; a cap that disagrees with the refresh rate fights it |
| Android / iOS | ignored | panel refresh rate (30–120, fallback 60) | mobile ignores `vSyncCount`; Unity's default cap there is 30 |

`Time.maximumDeltaTime` is never lowered, only raised to a 0.1s floor so one long frame does not
drop simulated time. The PC quality level's `vSyncCount` was also set to 1 so the Editor Game view
and the first frame agree with the policy.

**Verify on the Deck** after a build + deploy: `grep FramePacing ~/.config/unity3d/CR/Crystalline\ Rift/Player.log`
should print `vSyncCount=1 targetFrameRate=-1`. If the Deck is set to 40 Hz in the Quick Access menu
the game locks to 40 fps; that is expected and smooth. For raw performance (not pacing) also note the
Linux profile builds **Development + script debugging** (`Starting managed debugger on port …` in the
log), and Deck builds made before Linux became Vulkan-first (see [Linux graphics APIs](#linux-graphics-apis-vulkan-first)) ran
**OpenGL Core**, not Vulkan — both cost frame time and are worth turning off / switching when measuring.

### Testing on the Steam Deck: frame rate, log report, scripts

**`[Perf]` lines.** `HitchRecorder` (on in the Editor and development builds, otherwise with `-crHitchLog` or `CR_HITCH_LOG=1`) logs a frame-rate line every 10 seconds of frame time and one for the whole session at quit:

```
[Perf] 10 s | avg 57.8 fps | 1% low 41.0 fps | worst 87 ms | frames 578
[Perf] session | avg 55.0 fps | 1% low 30.0 fps | worst 900 ms | frames 5000
```

`1% low` is the frame rate at the 99th-percentile frame time (accurate to 0.1 ms; the figures come from a fixed histogram, so logging allocates nothing per frame). Boot and loading windows are logged too; readers should ignore the first minute, as the report does.

**Player.log report.** `cr_deck_log_report --args "<path to a Player.log> [--expect <version>]"` (an Editor CLI command; `--expect 0.2.21-deck1` makes the build-stamp check FAIL when the log's stamp has another version), or **Report on this log** in the Deploy window after **Fetch Player.log from the Deck**, prints one PASS / WARN / FAIL line per check, each with the log line it was decided on:

| Check | Verdict |
|---|---|
| Build stamp | PASS for a parsed stamp (`vX.Y.Z · commit · date`), shown with its version. `no stamp at` is WARN; `is not a build stamp` and `could not read the stamp` are FAIL; no `[BuildStamp]` line is WARN. With `--expect <version>` (a leading `v` is ignored), a stamp of another version is FAIL and a missing `[BuildStamp]` line is FAIL |
| Graphics API | WARN when any OpenGL line is present (`Creating GLContext`, `OpenGL Core 4`, `OPENGL LOG:`), checked before Vulkan; PASS for Vulkan; WARN when neither is found |
| Render pipeline | PASS only on `[DeckRender] Steam Deck detected; render pipeline set to ...`; `no Deck pipeline asset` and `could not select Deck pipeline` are FAIL; no `[DeckRender]` line is WARN |
| Frame pacing | PASS when the `[FramePacing]` line is present (its refresh rate, vsync count and frame cap give the target fps used by the frame-rate check); WARN when absent |
| Boot timings | PASS with the db, content, shaders and total times from the `[Boot]` line. WARN when no timings line follows, when `Database gate not ready` / `faulted` / `wait failed`, `Shader first-run check failed`, `Shader warm-up failed` or `Boot sequence failed` was logged, or when the menu opened while shaders were still compiling (`shader compile still running`) |
| database is locked | FAIL if any line contains it, whatever its tag (the v0.2.19 fix: must be 0; the v0.2.18 baseline has 10); PASS at 0 |
| Hitches | PASS with no `[Hitch]` lines. FAIL for any hitch of 30 000 ms or more; WARN for a worst hitch of 1 000 ms or more; WARN for 20 or more hitches of 250 ms or more; otherwise PASS. Shows the worst and the count |
| Spawner-sync hitches | WARN when no `[ContentSync] Syncing N spawners` line is in the log. Counts hitches of 100 to 190 ms between that line and the next `[ContentSync]` line (or 5000 log lines if none follows): FAIL at 10 or more (the v0.2.19 fix removes this run), WARN for 1 to 9, PASS for none |
| Null shader errors | FAIL on any `Parameter name: shader` or `(Parameter 'shader')` line (v0.2.19 fix: must be 0); PASS at 0 |
| Shader.Find nulls | FAIL on any `[Shaders] Shader.Find(...) is null` line or `[Shaders] Resources/... is missing` line (v0.2.19 fix: must be 0); PASS at 0 |
| Shader warm-up | PASS with variant and graphics-state counts from `[ShaderWarmup] warm-up done`; WARN when it ended early, was cut short, or never ran |
| PSO trace load | PASS when the warm-up warmed one or more graphics states. WARN, with the reason, for `no PSO trace at`, `PSO trace skipped` (recorded for another platform or API) or `has no PSO trace support`; WARN when no trace was warmed |
| PSO trace recording | PASS with `saved N graphics states`, or PASS as "not a recording session" when `-crPsoTrace` was not used; WARN when recording started but nothing was saved; FAIL on `[PsoTrace] could not` |
| SQLite pool | PASS with the counts from the `[SqlitePool]` quit line (v0.2.20); WARN when the pool was switched off, the line is absent, or it never reused a connection (hits 0) |
| Frame rate | Median average fps and lowest 1 % low over the `[Perf]` windows that start after the first 60 s. The target is the frame cap, else the refresh rate divided by the vsync count, from `[FramePacing]` (fallback 60). FAIL below 50 % of target (median); WARN below 90 % (median) or when the lowest 1 % low is below 50 % of target; otherwise PASS. WARN when there are no `[Perf]` lines or every window is inside the first 60 s. The output states the numbers |

**A check never passes without evidence.** An empty log turns every check into WARN. A log with no `Initialize engine version` line starts mid-session (a tail fetch), and then the checks that pass only because nothing bad was seen (database is locked, Hitches, Spawner-sync hitches, both shader-null checks, PSO trace recording) turn into WARN. Hitches and Spawner-sync hitches also turn into WARN when the hitch recorder was off (no `[Hitch]` or `[Perf]` line; launch with `-crHitchLog`). A problem that is found still FAILs in a tail.

The Deploy window fetches only the last 2000 lines, so a long session's start-up lines may be missing; the report then says it read only the tail and start-up checks may WARN for that reason. `ci/deck-fetch-log.sh` fetches the whole file (it writes to a temp file and replaces `--out` only when ssh succeeded and the log is not empty).

The Vulkan wording Unity itself prints has not been captured from a Deck yet. The analyser recognises Vulkan from Unity's usual lines, the Mesa `RADV` driver name and the game's own PSO messages; if the check says "no graphics-API line", read the first Vulkan log and extend `DeckLogAnalyzer.VulkanMarkers`.

**PSO trace.** See "Recording the Steam Deck's Vulkan PSO trace" in the Loading Screens page. The Deploy window button **Fetch PSO trace from the Deck** copies it with `scp -O` (the classic protocol, so the Deck's shell expands `$HOME` and honours the quotes around the space in `Crystalline Rift`; needs OpenSSH 8.7 or newer on the Mac).

**Deploy folder and build folder guards** (Deploy window and `ci/deck-deploy.sh` alike): the folder on the Deck must be absolute, have no `.` or `..` segments, no whitespace, quotes or shell metacharacters, and at least 4 path components (`/home/deck/Games/cr` passes; `/home/deck` and `/home/deck/Games` are refused), because `rsync --delete` runs against it. The local build folder must not be empty or `/`, and must contain `CrystallineRift.x86_64` before anything is copied.

**Headless scripts** (bash, run from the project root, each takes `--dry-run` to print the exact commands and `-h` for usage):

| Script | Does |
|---|---|
| `ci/deck-deploy.sh <host> [--user deck] [--dest /home/deck/Games/CrystallineRift] [--build-dir Builds/Linux] [--no-delete]` | `mkdir -p` on the Deck, rsync with the Deploy window's flags and excludes, then reads `build-stamp.txt` back and compares it with the local one; exits 1 on a mismatch |
| `ci/deck-fetch-log.sh <host> [--user deck] [--out <file>]` | copies the whole Player.log to `DeckLogs/Player-<time>.log` |
| `ci/deck-pso-fetch.sh <host> [--user deck] [--api Vulkan] [--platform LinuxPlayer]` | copies the trace into `Assets/StreamingAssets/CR/Shaders/` of the checkout it runs from, refusing any name that is not `pso-<Platform>-<GraphicsApi>.graphicsstate`, and prints the next steps |

`ci/tests/deck-scripts-test.sh` runs each script against a fake host with `--dry-run` and checks the printed commands and the refusals; it puts shims for `ssh`, `scp` and `rsync` first on `PATH` and fails if any was started.

### Design notes

- Arguments are built as a **list** and handed to `ProcessStartInfo.ArgumentList`, so no shell ever
  parses them. `SteamDeckDeployPlan.Validate` additionally rejects a host or path beginning with
  `-` (rsync would read it as an option, and rsync has options that run commands), a host
  containing `:` (rsync splits host from path there), and a destination of `/` (`--delete` is
  pointed at that folder).
- ssh runs with `BatchMode=yes`. Without it, an unconfigured key makes ssh wait for a password on a
  terminal that does not exist inside the Editor, and the deploy hangs forever looking like a slow
  copy. With it, the failure arrives in seconds and the window explains the two usual causes.
- The external process writes to a `ConcurrentQueue` from its threadpool callbacks and touches no
  Unity API; the window drains it from `Update()` on the main thread. There is a watchdog on both
  the short steps and the copy.
- The rules — validation, rsync arguments, the trailing-slash handling that decides whether rsync
  copies a folder's *contents* or nests it one level deeper — are in
  `SteamDeck/Logic/SteamDeckDeployPlan.cs` (asmdef `CR.Core.SteamDeckDeploy.Logic`, no engine
  references) with NUnit tests beside them.

macOS ships **openrsync** (`rsync 2.6.9 compatible`), not GNU rsync 3.x. The flags used here
(`-a --partial --human-readable -v --delete -e`) are all accepted by it, and the executable bit
survives — both verified against openrsync rather than assumed.

## Build and Editor speed

What a player build spends its time on (measured on the v0.1.9 and v0.1.10 CI runs, M4 Max):

| Phase | Warm cache | Cold shader cache |
|---|---|---|
| Addressables, per target | 30–130 s | same |
| Player, per target | 5–7 min | 30–40 min |
| Three targets end to end | ~30 min | ~115 min |

Almost all of the gap is **shader variant compilation**. `Library/ShaderCache` on the runner is kept
between runs (`clean: false`), so a normal build hits it tens of thousands of times. A package
update that touches URP includes (the Oct 2026 upgrade did) invalidates the whole cache once; the
next build is back to warm numbers. Builds run on the same Mac as the live Editor, so the Editor
crawls while a build is running.

Settings that keep the numbers down (all in the repo):

- **One quality level.** `ProjectSettings/QualitySettings.asset` carries only `PC`. The former
  `Mobile` level had its own URP asset (`Assets/Settings/Mobile_RPAsset.asset`, now unreferenced).
  It already listed Standalone under excluded platforms, so desktop builds were not compiling its
  variants; it is gone so nobody re-enables it by accident, because every URP asset a build's
  quality list includes adds its keyword set to the shader variants.
- **Vendor textures capped at 1024 px.** `VendorTextureSizeCap` (an `AssetPostprocessor` in
  `Assets/CR/Core/Data/Editor/Build/`) applies `VendorTextureCapPolicy` on every texture import:
  anything under `Assets/` that is not project content (`Assets/CR`, `Assets/Settings`,
  StreamingAssets, Addressables data) is capped at 1024 when its source is larger. Cubemaps,
  `.hdr`/`.exr` panoramas and `Skybox`/`Lightmap` paths are exempt. Textures were 2.6 GB of the
  3.0 GB v0.1.10 player. Unity writes the capped size back into the texture's `.meta`
  (`DefaultTexturePlatform` block), so the runner's symlinked packs carry it too. Adding the
  postprocessor reimported every texture once (about 6 minutes on the M4 Max); it has no
  `GetVersion` on purpose so that never repeats. `unity cmd cr_vendor_texture_cap_scan` audits
  (count of oversized sources not yet capped, expected 0); `cr_vendor_texture_cap_apply` rewrites
  and reimports any that slipped in while the postprocessor was absent.
- **BoZo `Resources/` folders renamed to `Catalog/`.** The pack's demo save/creator systems load
  outfits, decals and texture packages by name from `Resources`, which drags every outfit texture
  into every build. CR references outfits directly, so only `Materials/Resources` (the
  `BSMC_StylizedShader` material package `OutfitSystem` loads at runtime) keeps the name. Vendor
  packs are not in git; redo the rename after an Asset Store restore.
- **Artifact garbage collection on.** `EditorSettings.asset` `m_ArtifactGarbageCollection: 1`
  removes unreferenced `Library/Artifacts` on Editor start instead of a Library wipe and full
  reimport. Asset Inventory's preview generation had left 17 GB of orphaned artifacts.
- **Domain reload stays ON for Play.** It was switched off for a day (2026-10-12) and reverted:
  without a reload, the second and later Plays never signal the quest readiness gate for a new
  trainer, the dialogue service gives up after 30 s and the prologue letter never unlocks the
  stone. `LoreReadable` now warns with the start status when a read does not end. Turning the
  reload off again means first finding the state that survives a Play without it.

Not in the repo, but on the dev machine: Asset Inventory 4 generates previews by importing whole
packs into `Assets/_AssetInventoryPreviewsTemp`, which turned every asset refresh into a 20–40 s
stall while indexing. `~/.local/share/AssetInventoryConfig.json` now has
`recreatePreviewsAfterIndexing: false` and `bulkPreviewThreshold: 0`; previews come from the
packages' bundled images, and the Preview Wizard still generates the rest on demand.

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
- **Steam Deck**: build output is a folder (`CrystallineRift.x86_64` + `CrystallineRift_Data/`).
  Use **CR > Build > Deploy to Steam Deck…** (above) rather than copying by hand. Deck is
  1280×800 — the profile uses default fullscreen; UI Toolkit panels scale, but verify HUD
  readability on-device. Gamepad input needs Input System bindings beyond the current
  keyboard/mouse maps. Launching over SSH instead of through Steam gives **no Steam Input**, so
  controller testing still has to go through Game Mode.
- macOS native is arm64-only; the profile's architecture should stay Apple Silicon unless the
  osx-x64/universal dylib is added.
- `applicationIdentifier` still carries the URP template default
  (`com.Unity-Technologies.com.unity.template.urp-blank`) — cosmetic for desktop players
  (affects macOS bundle id), worth fixing before any external distribution.
