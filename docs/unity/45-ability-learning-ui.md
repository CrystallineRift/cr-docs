# Ability Learning UI

How the Unity client presents learning, forgetting, tones and the ability economy. The client only presents: it shows the server's offers and costs, and sends intents (learn this move, forget that one, use this tone, submit this action). Learned moves, resources spent and resources gained come back from the server (offline: the same cr-api DLLs on local SQLite). No client code infers learning or computes an outcome.

> Status: design draft. Code sentences are marked "(lands with slice N)" until merged. Spec: `docs/superpowers/specs/2026-10-22-ability-progression-and-economy-design.md` in cr-api-unity. Server side: [Ability Learning](?page=backend/30-ability-learning) and [Ability Economy](?page=backend/29-ability-economy).

## The prompt (lands with slice 1)

`ChoiceDialog` (`Assets/CR/UI/Common`) is a Task-returning modal: `ChoiceDialog.ShowAsync(title, options, cancelLabel, ct)` returns the option index, or -1 on cancel. Built like `MessageDialog` (own UIDocument at scene root, sortingOrder 50, CrTheme tokens only, first enabled option focused, gamepad Cancel = decline). `MessageDialog` stays for OK-only.

`AbilityLearnPrompter` (pure rules in `CR.Game.Battle.Logic`, thin presenter in `Presentation`) takes the server's `AbilityOffer`s and builds: "Cindris wants to learn Flame Wheel. Forget which move?" with the offer's `CurrentAbilityIds` as options (name, element, power, the active mode's cost, from local ability content) plus "Don't learn". Flow:

1. Show the prompt for the first offer.
2. A choice sends the learn intent (`ICreatureLearnClient`, HTTP adapter online, offline adapter over the DLL `ICreatureLearnService`, behind `OnlineOfflineCreatureLearnService`). The client names the move to forget, never a slot.
3. The next offer in the same level-up uses the `abilityIds` the learn response returned, not a cached creature row.
4. After a learn the client raises `GameChange.AbilityLearned(creatureId)` so the creature cache scope is invalidated (online).
5. Declining is not calling anything.

Where it blocks: `BattleCoordinator.PlayStepsAsync`, after `PlayAndReconcileAsync` for a step and before `RaiseActionResolved`, it awaits `_learnPrompter.RunAsync(outcome.ExperienceAwards)`. That is right after the level-up beat and before the next step or the summary; the sequencer stays synchronous. Auto-learns show a toast "Cindris learned Flame Wheel!" through the existing `AbilityUnlockToastAdapter` path, a battle-log line, and a line under the LEVEL UP chip on the summary.

Out of battle (bag level-ups, tones with full slots, quest claims), `BagScreenHandler` and `QuestManager` run the same prompter on `Offers` before the usual toast and refresh.

## Battle HUD ability list (lands with slice 1)

The HUD renders `BattleStateDto.ActiveCreatureAbilities`, computed by the server from the creature's four slots plus mission-unlocked moves. It no longer lists the progression set at level 1. Names and icons come from local content. `WildAbilityDto.currentPp/maxPp` become real values.

## HUD per mode (lands with slice 3)

| Mode | Resource display |
|---|---|
| Free | Exactly today's HUD |
| Energy | Second bar under HP on both cards (`--cr-energy` token, new), label "E 62/90" |
| BuilderSpender | Row of 10 charge pips under HP (opponent too); pips fill on builders |
| TurnPool | "Surge 3/10" on the player card, opponent's shown small |
| PowerPoints | "12/15" at the right of each ability row, no bar |

Ability rows get a cost badge at the right ("5 E", "+1" or "-6" Charge, "3" Surge). Unaffordable rows get `cmd-row--unaffordable`: dimmed but still focusable; pressing shows "Not enough Energy" in the log and does not submit. A **Rest** row with a short description follows the four moves in cost modes. A `ResourceChange` phase in `BattleBeatPlan` after Impact or Miss lets the sequencer animate the bar. The summary screen is unchanged apart from the learn lines.

## Client setting (lands with slice 3)

`AbilityCostModeSetting` (`IAbilityCostModeSetting { Mode, Changed, SetServerValue, RefreshAsync }`) merges Editor override (Studio Configuration panel), then the server value when online, then the remembered value offline. The last-seen server mode is remembered in player data (never the content floor). A small overlay `IAppConfigRepository` returns the floor's `app_config` row with the mode replaced, so offline domain services see the same mode with no write to `game-data.bytes`. The mode itself is picked online in cr-admin-web Game Config.

## Bag and tone flow (lands with slice 2)

`ItemTargetIntent` gains a `Teach` kind. `ItemTargetRule` verdicts: `NotResonant`, `AlreadyKnown`, `TooLowLevel`, with `ItemUseText` lines. The bag greys non-resonant targets using the same pure `ToneResonance` rule as the server (a courtesy; the server still decides). Result text: "Cindris learned Flame Wheel from the Ember Tone.", "...the tone shattered.", "...the Echoing tone still hums." When the result carries `Offers` (full slots, `Deferred`), the bag suppresses the "Used X" toast, runs the prompter, then refreshes; the learn intent with `toneItemId` consumes the tone. Tonics read energy from `BattleStateDto.CreatureStates`, not the creature row; text "recovered N Energy" (lands with slice 3).

## Storage Learnable (lands with slice 1)

The Storage "Data File" panel's `AbilityRosterBuilder` gains a `Learnable` state (level reached, move not known) with a **Learn** button, which runs the same prompt and the same intent. It is the recovery path for declined or missed offers, and it replaces any need for a move tutor.

## Tests

Pure logic is tested in EditMode: `AbilityLearnPrompter` (uses offer slots, then learn-response slots), `ChoiceDialogRows`, HUD list logic in `CR.UI.Logic`, `BattleBeatPlan` ResourceChange, `AbilityCostModeSetting` precedence, bag `ItemTargetRule` tone verdicts and toast suppression. Related: [Battle System](?page=unity/07-battle-system), [Battle Bag UI](?page=unity/13-battle-bag-ui).
