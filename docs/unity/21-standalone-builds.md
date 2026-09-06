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
log) and the player picks **OpenGL Core**, not Vulkan — both cost frame time and are worth turning
off / switching when measuring.

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
