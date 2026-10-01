# Account Mode &amp; Startup

The game boots with an account already in hand and presents a **mode-first** main menu:
**Continue · Play Online · Play Offline**. Online and offline are two non-crossing worlds — there is
**no reconciliation**: an offline character can never play online, and an online character never plays
offline. The choice is per play session.

## Core model

- **One device-bound account identity.** Derived from the device id already in use
  (`DeviceIdHolder.DeviceId` → `GameInstallationId`). The same id anchors both worlds.
- **Offline world** — local SQLite (player-data / offline DBs). Offline characters. Zero network.
  The account is a silent local anonymous account.
- **Online world** — server-authoritative. The account is a silent **guest** account on the server,
  fetched/created by device id. Local **OnlineCache** DBs cache downloaded content.
- Routing leans on the existing `IsPlayingOnline` flag (read fresh per repository access) and the
  `IsOnlineTrainer` per-character tag. Player data never crosses between worlds.

## Boot: account is always present

`GameSessionManager.Start()` runs the version check, then `IGameSessionService.InitializeAsync()`, then —
if no account was loaded from a persisted session — calls `AccountBootstrapper.EnsureLocalAccountAsync()`.
This guarantees `CurrentAccountId` is never null from frame one, fixing the long-standing "no account at
startup" failure. `EnsureLocalAccountAsync` is **mode-neutral**: it resolves the stored/anonymous local
account and sets the session, but does **not** touch `IsPlayingOnline` — the mode is chosen later at the menu.
If a session already exists, its account (and last mode) is left untouched so Continue can resume.

## Menu (`MainMenuController`)

The live menu is `Assets/MainMenuController.cs` — the existing, scene-wired `IUIScreen` named `"MainMenu"`
(already present in the boot scene with a UIDocument + PanelSettings). It renders
`Assets/CR/UI/Resources/MainMenu.uxml` (styled by `Assets/main-menu.uss`), whose buttons are named
`continue`, `play-online`, `play-offline` (plus `btnOptions` / `btnQuit`) and a `status-message` label.
Buttons are queried and wired in `Start()` (after the UIDocument has built its visual tree and Zenject has
injected) — not `OnEnable`, which is racy against the UIDocument lifecycle.

Because `MainMenuController` is a registered screen, `IUIManager.NavigateToScreen("CharacterSelect")` hides
every registered screen (including the menu) and shows the target — so the menu no longer overlays character
select; no manual hide is needed. (A separate `StartMenuController` prototype was removed in favor of reusing
`MainMenuController`.)

| Button | Behavior |
|---|---|
| **Play Offline** | `AccountBootstrapper.PlayOfflineAsync()` (sets `IsPlayingOnline=false`, resolves local account) → navigate to character select. No network. |
| **Play Online** | Probe the server first (`IConnectivityProbe`). Reachable → `PlayOnlineAsync()` (silent guest: token ladder, then the session adopts the **server's** account id — see "Online session identity") → character select. Unreachable → stay on menu, show "Online unavailable — check your connection." Never enters online. |
| **Continue** | Reads the last chosen mode from the dedicated `LastPlayMode` key (written only on an explicit menu choice — distinct from the `IsPlayingOnline` routing flag) and runs the same path as that mode's button, dropping the player at that mode's **character selection** (not straight into the world). Online resumption is probe-gated identically. Shown only once a mode has been chosen at least once. |

## Online session identity

An online session is keyed by the account the **server** named on the token it issued — never by an account
read out of the device's local auth database. `PlayOnlineAsync()` walks the token ladder
(`IGameAuthRepository.TryGetAccessToken()`: live token → refresh → register this installation anonymously and
authenticate; `GameAuthRepository.PersistAccountTokenLocally` writes the server's account id into
`GameConfigurationKeys.AccountIdKey` on every successful auth), then `OnlineSessionIdentity.Resolve(authenticated,
storedServerAccountId)` (`CR.Core.Data.Logic`, pure) hands that id to `IGameSessionService.SetAccountAsync`. No
token, or a token naming no account → `InvalidOperationException`; the menu shows "Something went wrong" and nothing
starts under a stand-in account.

Before 2026-10-01 `PlayOnlineAsync` reused the offline helper (`EnsureAnonymousAccountAsync`: first no-email row of
`GetAccountsPaginatedAsync`, which routes to the **offline** DB always), so the online session ran under the local
anonymous account (`34dd0b10…`) while the token, every server row and every online-cache row carried the server
account (`bc51456e…`). Every account-scoped online-cache read (`GetTrainersInAccountPaginated`, `GetInventories`,
creature/item entry lists) missed, each remote read re-inserted the rows, and the trainer list came back empty after
a reload. Offline is untouched: `PlayOfflineAsync`/`EnsureLocalAccountAsync` still resolve the local anonymous account
and never reach for a token — online and offline trainers stay separate worlds. Pinned by
`AccountBootstrapperOnlineIdentityTests` (Assets/CR/Tests/Editor) and `OnlineSessionIdentityTests`.

`CharacterSelectController.SelectAsync` passes `IsPlayingOnline` to `SetTrainerAsync` (it used to hard-code `false`,
so an online session persisted `IsOnlineTrainer = false`, `GameInitializer` logged `online=False` and
`WorldContext.IsOnlineTrainer` / `SessionStateBridge` told every consumer the trainer was local).

## Connectivity probe

`IConnectivityProbe.IsServerReachableAsync()` is a lightweight, timeboxed reachability check. The default
`ConnectivityProbe` reuses the existing version-check endpoint — `IVersionCheckRepository.CheckAsync`
already returns `null` when the server is unreachable, so a non-null response means reachable. The probe
never throws (failure is reported as "not reachable") and is injected, so it is mockable in tests. It gates
**Play Online** and **Continue-into-online**, closing the prior gap where online was entered optimistically
via a manual flag with no probe.

## Character ↔ mode locking

Characters created offline live in the offline SQLite DB with `IsOnlineTrainer = false`; characters created
online live on the server with `IsOnlineTrainer = true`. Each character-select screen lists only the current
mode's set — enforced naturally by which repository/DB is queried under `IsPlayingOnline`. No extra cross-mode
guard is needed; an offline character is structurally never offered in online mode, and vice versa.

## Wiring summary

- `IConnectivityProbe` → `ConnectivityProbe` bound `AsSingle()` in `LocalDevGameInstaller`.
- `AccountBootstrapper` (already bound `AsSingle()`) gains `EnsureLocalAccountAsync()` (boot, mode-neutral)
  and a shared `ResolveOfflineAccountIdAsync()` used by both it and `PlayOfflineAsync()`.
- `GameSessionManager.Initialize(...)` injects `AccountBootstrapper` for the boot ensure.

## Not built (intentional)

- No reconcile / merge / push / pull of player progress between offline and online.
- No login gate — online is silent guest; email / login-link is an optional later "secure your account"
  upgrade (reuses the retired `LoginView` UI), never a boot requirement.
- No multi-device support.
- The `ContentUpdateRequired` background content sync remains a separate concern (still a TODO), untouched here.

## Auth `salt` column compatibility

The auth `salt` column is declared TEXT (`AsString`) in the migration while `CR.Auth.Model.REST.Account.Salt`
is a `byte[]`. Real binary salts are stored as BLOB and read back unchanged, but an account row that stored an
empty/text salt (e.g. an anonymous account written with `""`) made Dapper throw
`InvalidCastException: Invalid cast from 'System.String' to 'System.Byte[]'` while deserializing the whole
`Account` — which broke boot account resolution. No live code writes an empty-string salt (anonymous
creation passes `null`, which Dapper binds as `NULL`); the `''` rows are **legacy data** from before
`M0006MakeAccountFieldsNullable`. Two-part fix: (1) `ByteArrayTypeHandler` (registered in `DapperBootstrap`
alongside `GuidTypeHandler`) tolerates a string column value as defense; (2) migration `M0008NormalizeEmptySalt`
sets `salt = NULL WHERE salt = ''` so stored data is corrected. Real binary salts are stored/read as BLOB and
are unaffected.

## Inventory-changed notification (merchant → bag)

A merchant purchase writes the item through the repository inside a transaction and never called the
`IItemInventoryService` events that `InventorySync` listens to, so cached inventory views (the battle bag)
stayed stale. `NpcMerchantService.PurchaseItemFromMerchantAsync` now calls
`IItemInventoryService.NotifyBackpackChanged(accountId, trainerId, inventoryId)` **after commit** (best-effort,
never breaking purchase atomicity), which raises `OnBackpackUpdated`; `InventorySync` already subscribes and
refreshes, so every consumer updates — not just the bag. `BattleBagPanelHandler` keeps a refresh-on-open as
belt-and-suspenders for any other direct-repo writer.

## Deferred / follow-ups

- Retiring the legacy `StartupFlowController` / `LoginView` *as a boot gate* (already disabled in the boot
  scene); keep `LoginView`'s login/create-account UI for a future "secure your account" upgrade.
- `IAuthRepository.GetAnonymousAccountIdAsync` (SQL-level no-email filter returning just the id) to replace the
  `GetAccountsPaginatedAsync(0,100)` scan in `AccountBootstrapper.EnsureAnonymousAccountAsync` (offline path only
  since 2026-10-01) — removes the 100-row fragility and avoids full-`Account` deserialization on the boot path.
- A mid-session re-auth that lands on a different server account (`ReAuthenticateAsync` after a server reset) updates
  `AccountIdKey` but not the running session; the player must return to the menu for the session to follow it.
- EditMode tests for boot-ensure, mode setting, Continue, and probe-fail blocking (probe is mockable).
