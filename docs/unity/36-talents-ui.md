# Talents UI (Unity) — Phase 2 lane

This lane ships everything Talents-in-Unity that does **not** need the cr-api Talents domain work
(new tables, `TalentBuild`, `TalentRules`, `TalentTreeValidation`, `TalentService`, REST endpoints — none
of that exists yet). It is the authoring side and the tab, wired to a fully faked seam.

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

`TalentTreeAuthoringValidation` (`CR.Core.Data.Logic`, pure) covers every design-spec rule that is
computable from SO content alone: unique tree/talent ids and content keys, tier 1-5, max rank 1-5,
`ValuesPerRank.Count == MaxRank`, at most one tier-5 (capstone) talent, exclusive-group tier/membership
rules, gate feasibility (ranks spendable below each tier gate, one side of each exclusive group, quest-gated
talents excluded), and `unlockQuestKey` shape. It warns on an empty tier 5.

This is **not** the design spec's `TalentTreeValidation` — that type will ship from cr-api's
`Talents.Domain.Services` once the server phase lands (see the `// TODO(talents-server-phase)` marker at
`TalentTreeDefinitionEditor`'s validation call site), at which point a later phase deletes
`TalentTreeAuthoringValidation` and calls the real one instead, from the same call site.

### Starter content

`Exploration`, `Capture` (minus **Bond Trial** — an empty tier 5, the one intentional validation warning)
and `Battle` are authored at `Assets/CR/Content/Defs/Talents/`, registered on the project's
`ContentDefinitionProvider`. **Opportunist** (Capture, tier 3) ships at `CaptureXp +15/30/40%`, the design
spec's retune (the original `+25/50/75%` would have exceeded the `CaptureXp` cap combined with Naturalist).

## The Talents tab

`PlayerMenuWindow` gains a `talents-tab` between Map and Journal, backed by `TalentsTab`
(`Assets/CR/UI/Talents/`). It mirrors `WorldMapTab`'s shape: it rebuilds its skeleton and cancels its own
in-flight load on every `RenderAsync` call, and `PlayerMenuWindow.OnTabChanged`/`Hide` cancel it the same
way the Map tab's load is cancelled.

It renders:
- a header with the trainer's XP bar (when `ITrainerProgressReader` is bound) and an "Available N · Spent M"
  points readout, and a "Respec required" banner when the read progress says so
- a tree selector row (click/D-pad only, **not** the menu's L1/R1 bumpers — those already switch
  `PlayerMenuWindow` tabs)
- a tier grid built by `CR.UI.Talents.Logic.TalentNodeStateBuilder`, one row per tier (an empty tier, like
  Capture's tier 5, is hidden)
- a detail pane with current/next rank values, a Spend button (disabled while a request is in flight or the
  node isn't spendable), and a Respec button behind a one-button `MessageDialog` acknowledgement

**`TalentNodeStateBuilder` is display-only and temporary.** It computes the grid's `Locked` /
`QuestLocked` / `Available` / `Maxed` / `Excluded` states from the seam's own DTOs because cr-api's real
`TalentRules`/`TalentBuild` don't exist yet. It is replaced by server-provided, per-talent state — the
authority's `TrainerProgress.Allocations`/`Modifiers` evaluated with the real `TalentRules` — once the
Talents server phase lands, and is deleted then. **It must never gate a spend**: only `ITalentActions`'s
refusal (today always `TalentUnavailable`, from `NoOpTalentActions`) decides whether a rank is granted.

## The fake seam (today) → the real one (later)

| Interface | Bound today | Bound once the server phase lands |
|---|---|---|
| `ITalentTreeContentReader` | `TalentTreeDefinitionContentReader` — reads the authored SOs directly, no server/GameData dependency | adds the online GameData back-fill (design spec §4.6) |
| `ITalentProgressReader` | `EmptyTalentProgressReader` — every talent unallocated, no points, nothing quest-locked | the real reader over `TrainerProgress.Allocations`/`Modifiers`/`QuestLockedTalentIds` |
| `ITalentActions` | `NoOpTalentActions` — every spend refused `TalentUnavailable`, respec a no-op | `TalentOnlineOfflineRouter` (design spec §10.1) |

All three bindings live in `LocalDevGameInstaller`, next to the World Map bindings. None of the UI code
(`TalentsTab`, `TalentTreeDefinitionEditor`) changes when they're rebound — only the binding.

## Explicitly pending (not this lane)

- The router, `TalentClientUnityHttp`, and any online/offline sync for talent spends.
- `TrainerModifierApplier` / `MalbersMovementController.SetSpeed` (movement-speed talents) — needs
  `TrainerProgress.Modifiers` from cr-api.
- The "teach a talent" quest objective, Studio push/pull for talent trees, and any admin routes.
