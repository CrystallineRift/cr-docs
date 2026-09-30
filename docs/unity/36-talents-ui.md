# Talents UI (Unity)

Authoring, Studio push, and the player-facing tab for the three Phase 2 talent trees
(Exploration, Capture, Battle). The server domain (tables, `TalentBuild`, `TalentRules`,
`TalentTreeValidation`, `TalentService`, REST endpoints) has landed — see
[Talents](?page=backend/25-talents) — and every seam below is wired to it, online and offline.

## Authoring

- **`TalentTreeDefinition`** SO (`Assets → Create → CR → Content → Talent Tree`), one per tree, holding a
  list of `TalentEntry` (each with a list of `TalentEffectEntry`). Assets live at
  `Assets/CR/Content/Defs/Talents/` — this repo's actual content-asset convention, not the design spec's
  `Assets/CR/Data/Content/Talents/`.
- `TalentEntry.id` is a GUID minted once; `TalentTreeDefinition.OnValidate` mints a fresh one for any entry
  whose id is empty **or** duplicated within the asset (a paste/duplicate).
- The custom inspector (`TalentTreeDefinitionEditor`) shows a tier-grid preview (rows = tiers 1-5), an
  effect-type dropdown per effect, a per-rank value list auto-sized to `maxRank`, drawback/exclusive/quest-gate
  badges, an `unlockQuestKey` dropdown of authored `QuestDefinition` content keys, a "totals at max" readout
  per effect type, and inline validation.
- Register new `TalentTreeDefinition` assets on the project's `ContentDefinitionProvider` — its custom
  inspector has a **Talent Trees** foldout and picks up new assets via **Register All Orphans**, the same as
  every other content type there.

### Validation

The inspector's validation strip calls cr-api's real `TalentTreeValidation` (`Talents.Domain.Services`,
shipped in the Compat DLL) directly — the same errors/warnings the server's bulk-push endpoint checks,
computed against the SOs before anything is pushed. The editor-only subset that used to stand in for
it (`TalentTreeAuthoringValidation`) is deleted; there is one validation, not two that could disagree.

### Starter content

`Exploration`, `Capture` (minus **Bond Trial** — an empty tier 5, the one intentional validation warning)
and `Battle` are authored at `Assets/CR/Content/Defs/Talents/`, registered on the project's
`ContentDefinitionProvider`. **Opportunist** (Capture, tier 3) ships at `CaptureXp +15/30/40%`, the design
spec's retune (the original `+25/50/75%` would have exceeded the `CaptureXp` cap combined with Naturalist).

### Studio push and the offline floor

Crystalline Rift Studio's **Trainer Progression** tab has **Push talent trees** (`PUT
/api/v1/talents/trees/bulk`, mirroring the Achievements tab's bulk push — Local/Production server
switch, the shared `AbilityEditorSyncHelper` transport) and **Export talent floor seed**.
`TrainerProgressionPipelineCommands` has `cr_talent_trees_push`/`cr_talent_trees_export_seed` for the
CLI and agents. `TalentTreeSeedMigrationGenerator` (`CR.Core.Data.Logic`) writes the
`SeedTalentTrees_` migration (block 15150-15199, insert-if-absent by `content_key`, both engines) from
the authored SOs; a re-export regenerates the file in place. See
[Talents — Content delivery](?page=backend/25-talents#content-delivery) for the server side of both.

## The Talents tab

`PlayerMenuWindow` gains a `talents-tab` between Map and Journal, backed by `TalentsTab`
(`Assets/CR/UI/Talents/`). It mirrors `WorldMapTab`'s shape: it rebuilds its skeleton and cancels its own
in-flight load on every `RenderAsync` call, and `PlayerMenuWindow.OnTabChanged`/`Hide` cancel it the same
way the Map tab's load is cancelled.

It renders:
- a header with the trainer's XP bar (`ITrainerProgressReader`) and an "Available N · Spent M"
  points readout, and a "Respec required" banner when the read progress says so
- a tree selector row (click/D-pad only, **not** the menu's L1/R1 bumpers — those already switch
  `PlayerMenuWindow` tabs)
- a tier grid built by `CR.UI.Talents.Logic.TalentNodeStateBuilder`, one row per tier (an empty tier, like
  Capture's tier 5, is hidden)
- a detail pane with current/next rank values, a Spend button (disabled while a request is in flight or the
  node isn't spendable), and a Respec button behind a one-button `MessageDialog` acknowledgement
- quest-locked nodes name the quest and offer "Show in journal"; a refusal shows `PlayerErrorText` for the
  `TalentSpendError` and re-renders from the returned progress

`TalentNodeStateBuilder` computes the grid's `Locked`/`QuestLocked`/`Available`/`Maxed`/`Excluded` states
from `TalentRules` over the authority's `TrainerProgress` — the real DLL rules, not a re-implementation.
**It must never gate a spend**: only `ITalentActions`'s own refusal decides whether a rank is granted.

## Data and DI (`LocalDevGameInstaller`)

All bindings live next to the World Map bindings.

| Interface | Bound to | Notes |
|---|---|---|
| `ITalentTreeContentReader` | `TalentTreeDefinitionContentReader` | Reads the authored SOs directly for content (no server/GameData dependency); `TalentTreeContentReader`'s online back-fill (spec §4.6) fills a local id miss from `GET /api/v1/talents/trees`. |
| `ITalentProgressReader` | `TalentProgressReader` | **Not a separate client.** It delegates straight to the already-real `CR.Progression.ITrainerProgressReader` — the XP bar's own cached online/offline read — because the wire `TrainerProgress` that endpoint returns now carries `Allocations`/`Modifiers`/`QuestLockedTalentIds`. One less client, one less cache scope to invalidate. |
| `ITalentActions` | `TalentOnlineOfflineRouter` | Online: `ITalentClient` (`TalentClientUnityHttp`, `POST .../talents/{id}/spend` and `.../respec`; a 409 refusal is caught as `ServerRequestException` and its `{error, progress}` body parsed into the same non-exceptional `TalentSpendResult` the offline path returns — never thrown to the tab). Offline: the DLL `ITalentService` (`CR.Game.Model.Progression.ITalentService`, bound from `Talents.Domain.Services.Implementation.TalentService` — every ctor dependency was already registered by earlier progression bindings). Either way it invalidates `CacheScope.TrainerProgress` and reports `GameChange.TalentChanged`. |
| `ITalentService` (offline) | `TalentService` | The same DLL the server runs, against local SQLite — resolves `IQuestInstanceRepository`/`IQuestTemplateRepository`/`ITrainerRepository`/`ITrainerProgressionService`/`IProgressOutcomeSink` from bindings already in place. |

None of the UI code (`TalentsTab`, `TalentTreeDefinitionEditor`) changes when a binding is rebound —
only the binding.

**Offline parity for the effect consumers** ([Talents §6](?page=backend/25-talents#effects-consumers))
needed no Unity-side logic: every offline domain service (`ICaptureAttemptService`,
`IBattleDomainService`, `IPickupDomainService`, `ICreatureSpawnDomainService`, `ILootDomainService`) is
a plain constructor-injected binding, so their optional `ITrainerModifierProvider?` parameters
auto-resolve through the single non-keyed `TalentModifierProvider` binding above once the packaged
DLLs are rebuilt.

## Level-up toast

`TrainerLevelUpToastText` reads `"Trainer level N (+K talent point(s))"` — `K` is the levels gained,
singular/plural on `K`, and the points clause is left out at the level cap.

## Movement speed — still pending

`MalbersMovementController.SetSpeed(float multiplier)` and a `TrainerModifierApplier` reading
`MoveSpeedMultiplier` from `ITrainerProgressReader` (spec §10.4) have **not** landed yet — the one
client-applied talent effect is the remaining gap before this lane is feature-complete. `SetSpeed`/
`IMovementController` already exist; the multiplier is already computed server- and offline-side. See
[Talents — Effects](?page=backend/25-talents#effects-consumers) for what it will read once wired.

## Related

- [Talents](?page=backend/25-talents) — the server domain this lane is a client of.
- [Trainer Progression (Unity)](?page=unity/34-trainer-progression) — the XP bar, cache scope and toast this tab and reader share.
- [World Map](?page=unity/35-world-map) — the sibling tab this one's load-cancellation and content-reader shape mirrors.
