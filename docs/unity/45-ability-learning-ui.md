# Ability Learning UI

How the Unity client presents learning, forgetting, tones and the ability economy. The client only presents: it shows the server's offers and costs, and sends intents (learn this move, forget that one, use this tone, submit this action). Learned moves, resources spent and resources gained come back from the server (offline: the same cr-api DLLs on local SQLite). No client code infers learning or computes an outcome.

> Status: merged on cr-api-unity `feature/ability-economy` (not deployed) together with the cr-api side. Spec: `docs/superpowers/specs/2026-10-22-ability-progression-and-economy-design.md` in cr-api-unity. Server side: [Ability Learning](?page=backend/30-ability-learning) and [Ability Economy](?page=backend/29-ability-economy).

## The prompt

`ChoiceDialog` (`Assets/CR/UI/Common`) is a Task-returning modal: `ChoiceDialog.ShowAsync(title, options, cancelLabel, ct)` returns the option index, or -1 on cancel. Built like `MessageDialog` (own UIDocument at scene root, sortingOrder 50, CrTheme tokens only, first enabled option focused, gamepad Cancel = decline). Its pure layout is `ChoiceDialogRows` (with `ChoiceOption`, `ChoiceDialogRow`, `ChoiceDialogLayout` in `CR.UI.Logic`); styling is `ChoiceDialog.uss`. `MessageDialog` stays for OK-only.

`AbilityLearnPrompt.Build(offer, lookup, creatureName)` (pure, `CR.Game.Battle.Logic`) turns the server's `AbilityOffer` into: "Cindris wants to learn Flame Wheel. Forget which move?" with the offer's `CurrentAbilityIds` as options (name, then "Element · Power", from local ability content) plus "Don't learn". Text lives in `AbilityLearnText`. `AbilityOfferQueue` walks a step's offers one at a time. `AbilityLearnPrompter` (`Game/Battle/Presentation`) is the presenter. It implements two interfaces:

- `IAbilityLearnPrompter`: the battle aftermath hook, `RunAsync(awards, trainerId, ct)`.
- `IAbilityOfferPresenter`: `PresentAsync(offers, toneItemId, ct)`, the seam for the bag and `QuestManager`. `NullAbilityOfferPresenter` is the no-op stand-in where no UI exists.

Flow:

1. Show the prompt for the first offer.
2. A choice sends the learn intent through `ICreatureLearnClient` (`CreatureLearnHttpDomainAdapter` online, `CreatureLearnOfflineDomainAdapter` over the DLL `ICreatureLearnService` offline, chosen by `OnlineOfflineCreatureLearnService`). The client names the move to forget, never a slot.
3. `AbilityOfferQueue.Learned` records the `abilityIds` the learn response returned, so the next offer for that creature in the same level-up is shown against those slots, not a cached creature row. An offer the creature now knows is dropped. A short reply invents no slots.
4. After a learn the client raises `GameChange.AbilityLearned(creatureId)`, which invalidates `CacheScope.Creature` and `CacheScope.CreatureSlots` (online).
5. Declining calls nothing. A refusal comes back as a result with an error code, shown through the player error text.

Where it blocks: `BattleCoordinator.PlayStepsAsync`, after `PlayAndReconcileAsync` for a step and before `RaiseActionResolved`, awaits `_learnPrompter.RunAsync(outcome.ExperienceAwards, playerTrainerId, ct)` when `ExperienceAwardLearningExtensions.HasLearning` says an award carries learning. That is right after the level-up beat and before the next step or the summary; the sequencer stays synchronous. Auto-learns (`ExperienceAward.AbilitiesLearned`) show a toast "Cindris learned Flame Wheel!" through the prompter's notification path, a battle-log line, and a line under the LEVEL UP chip on `BattleSummaryScreen`.

Out of battle (bag level-ups, tones with full slots, quest claims), `BagScreenHandler` and `QuestManager` call the same `IAbilityOfferPresenter` on `Offers` before the usual toast and refresh.

## Battle HUD ability list

The HUD renders `BattleStateDto.ActiveCreatureAbilities`, computed by the server from the creature's four slots plus mission-unlocked moves. `AbilityListBuilder.Build(serverOptions, lookup)` maps each `BattleAbilityOption` to a `WildAbilityDto` row: order, `Cost`, `Affordable`, `Reason`, `CurrentPp`/`MaxPp` and `MissionUnlocked` come from the server; local content supplies only name, icon, category and power. A move the client has no content for is skipped (and logged); an empty server list falls back to the old local list. It no longer lists the progression set at level 1.

## HUD per mode

`BattleResourceHud` (`CR.UI.Logic`, pure) projects the server's snapshot into a `BattleResourceView`; `BattleCardResources` (`UI/Battle`) draws it on each creature card; `BattleHUD` owns the rows.

| Mode | Resource display |
|---|---|
| Free | Exactly today's HUD |
| Energy | Second bar under HP on both cards (`--cr-energy` and `--cr-energy-track` tokens in `CrTheme.uss`), label "E 62/90" |
| BuilderSpender | Row of Charge pips under HP (opponent too); filled pips use `charge-pip--filled` |
| TurnPool | "Surge 3/10" label for each trainer's pool (`ForSurge`) |
| PowerPoints | "12/15" PP badge at the right of each ability row, no bar |

The cost badge text (`BattleResourceHud.CostBadgeText`) is "5 E" (Energy), "+1 C" or "-6 C" (Charge: the server's signed delta; positive builds, negative spends), "3 S" (Surge) and "12/15" (PP); empty in Free and for a zero cost. Unaffordable rows (the server's `Affordable` false) get `cmd-row--unaffordable`: dimmed but still focusable; pressing logs `BattleResourceHud.UnaffordableText(reason)` ("Not enough Energy", "Not enough Charge", "Not enough Surge", "No PP left", from the server's reason codes, which alias `AbilityAffordability`) and does not submit. An unknown reason falls back to the generic "cannot afford" line. A **Rest** row ("Rest", "Recover a little") follows the four moves in the cost modes; choosing it submits `[{"type":6}]` (an intent only; the server decides what is recovered, and refuses it in Free).

A `ResourceChange` phase in `BattleBeatPlan` (`BattlePhase.ResourceChange`, after Impact/Miss, or alone for a Rest or item step) lets the sequencer raise `BattleEvents.ResourceChanged(creatureId, kind, before, after)`; the HUD redraws with `BattleResourceHud.AfterStep`, which follows the server's stamp and the signed Charge delta. Rest narration is `BattleTurnNarration.IsRest`. The summary screen is unchanged apart from the learn lines.

## Client setting

`AbilityCostModeSetting` (`IAbilityCostModeSetting { Mode, Changed, SetServerValue, RefreshAsync }`) resolves in this order: Editor override (`AbilityCostModeOverride`: Inherit, Free, BuilderSpender, Energy, TurnPool, PowerPoints; stored in EditorPrefs by `EditorPrefsGameSettingsOverrides`, never in the committed `GameSettings` asset, set in the Studio Configuration panel), then the server value when online, then the value remembered from the last server answer, then the floor's `app_config` row, then Free. The server value arrives on every version check: `VersionCheckResponse.AbilityCostMode` (`ability_cost_mode`, with `ability_cost_mode_name`) feeds `SetServerValue`, which remembers it in player data (never the content floor). `OverlayAppConfigRepository` wraps the floor `IAppConfigRepository` (bound under `OverlayAppConfigRepository.FloorId`) and returns the floor row with the mode replaced by the effective one, so the offline domain services see the same mode with no write to `game-data.bytes`. The mode itself is picked online in cr-admin-web Game Config. It is the second server flag read at startup; see [Roaming Encounters](?page=unity/43-roaming-encounters).

## Bag and tone flow

`ItemTargetKind` gains `Teach` (tones), `RestoreEnergy` (Tonics) and `BoostSurge` (Surge Shard, targets no creature, battle only). `ItemTargetRule.Evaluate` returns verdicts with `ItemUseText` lines: `TargetNotResonant` ("Does not resonate"), `TargetTooLowLevel` ("Needs level N"), `TargetAlreadyKnown` ("Already knows this move") for `Teach`, in the server's order (resonance, level, known); and `TargetEnergyFull` for `RestoreEnergy` (a null current Energy against a known maximum is the server's "full" convention). Unknown facts are never a refusal. The bag greys targets using the same pure `ToneResonance` rule as the server (a courtesy; the server still decides). `TargetCandidate` carries `CurrentEnergy`/`MaxEnergy`, `ElementType`, `SpeciesKey` and `KnownAbilityIds`, read from `BattleStateDto.CreatureStates` where available.

Result text (`ItemUseResultText`): "Cindris learned Flame Wheel from the Ember Tone." plus "The tone shattered." or "The Echoing ... Tone still hums." (from the server's `ItemRetained`); "Cindris recovered N Energy."; "Cindris restored N PP."; "Surge +N.". When the result carries `Offers` (full slots, `Deferred`), the bag suppresses the "Used X" toast, runs the presenter, then refreshes; the learn intent with `toneItemId` consumes the tone.

Offline, `ItemUseOfflineBindings` registers the `TeachAbilityHandler`, `RestoreEnergyHandler` and `BoostSurgeHandler` with the shared `ItemUseDomainService`, and `ItemUseOfflineBindings.InstallToneGate` binds the real `ToneTeachGate` (see [Item Effects](?page=backend/19-item-effects)).

## Storage Learnable

The Storage "Data File" panel's `AbilityRosterBuilder` has an `AbilityRosterState.Learnable` state (the authority lists it as learnable now: level reached, move not known) with a **Learn** button in `PlayerStorageView`. `StorageLearnOffer.Build` makes an offer (source `"storage"`) from the cached slots and the same presenter runs the same prompt and the same intent; the server re-checks, so a stale view is refused, never written. It is the recovery path for declined or missed offers, and it replaces any need for a move tutor. The list comes from `ICreatureLearnClient.GetLearnableAsync`.

## Content and authoring

- `CreatureDefinition.defaultProgressionSet` (an `AbilityProgressionSetConfig`) is the species default; it is pushed as `defaultAbilityProgressionSetName`, and a Pull keeps the species default when the server omits the column. The old starter set key is removed.
- Line sets: `LineSetAuthoring` (Editor) builds the 11 `line_*` progression-set assets in `Assets/CR/Content/Defs/ProgressionSets/` from `line-sets.json` (read by `LineSetManifest`, `LineSetDef`, `LineSetEntryDef`). The legacy element sets are deleted or renamed into the line sets.
- `AbilityConfig` carries `maxPp`, `energyCost`, `chargeDelta` and `poolCost`. `AbilityCostAuthoring` (menu CR / Content / Abilities / Apply Floor Costs) mirrors the four columns from the committed floor into every ability asset by name, so a Push All is a no-op. `AbilityConfigEditor` shows them; `SyncAbilityDto` and `ContentSyncWriter` carry them.
- Tones: `ToneItemAuthoring` creates the 24 `tone_*` `ItemDefinition` assets from `tones.json`, a copy of the floor rows. `EnergyItemAuthoring` does the same for the four energy items (`item_tonic_30`, `item_super_tonic`, `item_full_tonic`, `item_surge_shard`) from `energy_items.json`. Assets mirror the seeded id, effect JSON, flags and consumable bit exactly so a Studio push cannot rewrite the server row. No tone art exists yet; the placeholder glyph draws.
- The offline floor `Assets/StreamingAssets/CR/game-data.bytes` is rebaked and committed at the final server head (schema 21203 and later); a build never migrates it.

## Tests

Pure logic is tested in EditMode: `AbilityLearnPrompterTests` (offer slots, then learn-response slots), `ChoiceDialogRowsTests`, `BattleResourceHudTests`, `BattleCoordinatorRoundLoopTests` (prompt hook, resource beats), `AbilityCostModeSettingTests` (precedence), `OverlayAppConfigRepositoryTests`, `ItemTargetRuleTests` (tone and Energy verdicts), `ItemUseResultTextTests`, `ToneGateAndHandlerBindingsTests`, `CreatureLearnClientTests`, `QuestManagerOfferPresenterTests`, `StorageLearnOfferTests`, `AbilityRosterBuilderTests`, plus `AbilityCostAssetsMatchFloorTests`, `ToneItemDefinitionTests` and `EnergyItemDefinitionTests` guarding assets against the floor. Related: [Battle System](?page=unity/07-battle-system), [Battle Bag UI](?page=unity/13-battle-bag-ui).
