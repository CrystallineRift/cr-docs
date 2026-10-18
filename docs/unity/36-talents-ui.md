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
- **Unlock rules and synergy.** Each talent entry has an `unlockRules` list (kind, a talent picker or tree picker over **all** tree assets, and a minimum), and each effect has an optional `scalesFrom` (a toggle and a source effect type) for synergy effects. Both are documented in [Talents](?page=backend/25-talents#unlock-rules). The totals readout skips synergy effects.
- `TalentTreeDefinition.serverRowVersion` (hidden) holds the version last seen from the server, and `pullIncomplete` flags a tree whose last pull could not be fully applied (an inspector box says why).
- Register new `TalentTreeDefinition` assets on the project's `ContentDefinitionProvider` — its custom
  inspector has a **Talent Trees** foldout and picks up new assets via **Register All Orphans**, the same as
  every other content type there.

### Validation

The inspector's validation strip calls cr-api's real `TalentTreeValidation` (`Talents.Domain.Services`,
shipped in the Compat DLL) directly — the same errors/warnings the server's bulk-push endpoint checks,
computed against **all** tree SOs (rules can point across trees) before anything is pushed. The editor-only subset that used to stand in for
it (`TalentTreeAuthoringValidation`) is deleted; there is one validation, not two that could disagree.

### Starter content

`Exploration`, `Capture` and `Battle` are authored at `Assets/CR/Content/Defs/Talents/`, registered on
the project's `ContentDefinitionProvider`. **Bond Trial** (Capture, tier 5) is now authored too —
`content_key: bond_trial`, `maxRank: 1`, effect `CaptureMission` (=23), `valuesPerRank: [1]`; the empty
tier 5 that used to be this tree's one intentional validation warning is gone locally
(`TalentTreeValidation.Validate`: Errors=0, Warnings=0), but it is **content only, not yet pushed** to
Studio — the live/floor tree still has the empty tier 5 until someone pushes it. **Opportunist** (Capture, tier 3) ships at `CaptureXp +15/30/40%`, the design
spec's retune (the original `+25/50/75%` would have exceeded the `CaptureXp` cap combined with Naturalist).

### Studio push and the offline floor

Crystalline Rift Studio's **Trainer Progression** tab has **Push talent trees**, **Pull talent trees** and
**Export talent floor seed**. Talents have their own button row there; they are not part of the Review window's
composite tab. `TrainerProgressionPipelineCommands` has `cr_talent_trees_push`, `cr_talent_trees_pull` and
`cr_talent_trees_export_seed` for the CLI and agents.

- **Push** is one `PUT /api/v1/talents/trees/bulk` per tree, so conflicts are reported per tree. Each carries the
  tree's `expectedRowVersion` and its unlock rules and `scalesFrom`; the body is built from the DLL's `TalentTreeUpsert` and
  parsed from the raw response (not the status-only helper) so the 409 body is readable. On success each tree's
  `serverRowVersion` is updated. A 409 shows a conflict row on the tree with **Pull this tree** and **Recreate**
  (see [Optimistic Concurrency](?page=backend/28-optimistic-concurrency)).
- **Pull** reads `GET /api/v1/talents/trees` and applies every field, including rules, synergy and version, to the SOs. A
  tree that exists only on the server (for example one made in the web editor) gets a new SO asset under the talent trees
  folder, registered on the `ContentDefinitionProvider`. A tree that could not be fully applied is marked `pullIncomplete`.
  Pull overwrites the local copy of the trees it applies. The pending-pull pill counts trees that are behind the server or
  missing locally, and its **Pull** acts only on those trees.
- **Export seed** refuses, with a clear message, while any tree is behind the server, missing locally or `pullIncomplete`
  (an unreachable server skips only the behind check), so the offline floor cannot be baked from stale content.

**First use after upgrading: Pull once before the first push.** A tree asset that was never pulled has version 0, so its push
is create-only and gets a 409 against the existing server row. If a push names a tree or talent not held locally, the refusal
says to pull first. `TalentTreeSeedMigrationGenerator` (`CR.Core.Data.Logic`) writes the
`SeedTalentTrees_` migration (block 15150-15199, insert-if-absent by `content_key`, both engines) from
the authored SOs, now including the `unlock_rules` column and `ScalesFrom`; a re-export regenerates the file in place. See
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
- a tier grid built from the server's states (`TalentNodeStateMapper`), one row per tier (an empty tier is hidden)
- a detail pane with current/next rank values (from the states' resolved `effects`; a talent with several effects lists each, and rank 0 shows `next`), every lock reason ("Needs 10 points in Capture (you have 4)", "Needs Vanguard rank 3", the tier gate, "choose-one taken", the quest by **name**), a synergy line such as "Creatures' Speed +25% (50% of your move speed bonus)", a respec hint for an `invalid` talent, a Spend button (disabled while a request is in flight or the
  node isn't spendable), and a Respec button behind a one-button `MessageDialog` acknowledgement
- quest-locked nodes name the quest and offer "Show in journal"; a refusal shows `PlayerErrorText` for the
  `TalentSpendError` and re-renders from the returned progress

Node styles include rule-locked and invalid classes. The tab maps `TrainerProgress.TalentStates` and renders it; it never
recomputes a rule, and the old client-side builder (with its own copy of the points-per-tier logic) is deleted. A talent for
which the progress carries no state is shown as available or maxed from its allocation, with no reasons. State **never gates
a spend**: only `ITalentActions`'s own refusal decides whether a rank is granted, and a rule refusal
(`talent-rule-locked`) shows its own text. Effect text goes through `SafeFormat`, which fills `{0}` to `{n}` per effect with
the invariant culture.

## Data and DI (`LocalDevGameInstaller`)

All bindings live next to the World Map bindings.

| Interface | Bound to | Notes |
|---|---|---|
| `ITalentTreeContentReader` | `TalentTreeContentReader` | **Server content, not the SOs.** Online it reads `GET /api/v1/talents/trees` (`ITalentTreeClient`, `TalentTreeClientUnityHttp`), memoised in the player-state cache under `CacheScope.TalentTrees`, so a tree edited in the web Studio reaches players. Offline, or when the fetch fails, it reads local SQLite through `ITalentTreeRepository` (the baked floor). Order online: server, then cache, then floor. The old SO reader remains Editor-only, for the inspector. |
| `ITalentQuestNameLookup` | `QuestTemplateNameLookup` | Looks up a quest's display name from `IQuestTemplateRepository` so a quest-locked talent names its quest, online and offline. |
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

## Movement speed

`MalbersMovementController.SetSpeed(float multiplier)` scales every `MSpeedSet`'s position
(non-root-motion) and animator (root motion) value off a baseline captured once at initialization,
writing fresh constant `FloatReference`s rather than mutating a shared `FloatVar` asset — repeated
calls are non-compounding, since they always re-derive from that baseline, and it never writes a
transform directly. The multiplier itself comes from the pure, EditMode-tested
`TrainerMoveSpeedLogic` (`CR.Core.Movement`), which reads `MoveSpeedMultiplier` off a
`TrainerProgress` via `TrainerModifiers` and defaults to neutral on a null/failed read.

`TrainerModifierApplier` (world-init-gated, code-created the same "search the hierarchy, else create"
way as `AchievementToastPresenter`) is what actually calls `SetSpeed`: it reads
`ITrainerProgressReader` and pushes the multiplier onto `TrainerMovementController.Current` on world
init, after every `IProgressionNotifier.TrainerProgressed`, after a new `TalentsChanged` event
(`TalentOnlineOfflineRouter` raises it on a successful spend/respec), and whenever a new movement
controller comes up (`TrainerMovementController.OnMovementReady`, the same spawn hook the overworld
camera gate already uses). See
[Talents — Effects](?page=backend/25-talents#effects-consumers) for what it reads.

## Related

- [Talents](?page=backend/25-talents) — the server domain this lane is a client of.
- [Trainer Progression (Unity)](?page=unity/34-trainer-progression) — the XP bar, cache scope and toast this tab and reader share.
- [World Map](?page=unity/35-world-map) — the sibling tab this one's load-cancellation and content-reader shape mirrors.
