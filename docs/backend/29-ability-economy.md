# Ability Economy

One server flag, `app_config.ability_cost_mode`, picks how abilities are paid for in battle: not at all (`Free`, today's behaviour), with a Charge that builders fill and big moves spend (`BuilderSpender`), with a persistent per-creature Energy pool (`Energy`), with a per-round Surge pool shared by the team (`TurnPool`), or with per-move power points (`PowerPoints`). Every ability carries all four cost numbers, so one content set serves every mode, and the mode is switched online from the Studio Game Config page. The flag ships as `Free`, so nothing changes until it is flipped.

> Status: design draft. Sentences about code are marked "(lands with slice N)" until the code is merged (slice 3 = economy; see delivery order in the spec). Spec: `docs/superpowers/specs/2026-10-22-ability-progression-and-economy-design.md` in cr-api-unity. Plan: `docs/superpowers/plans/2026-10-22-ability-economy.md`. Learn lists, tones and the learn intent are on [Ability Learning](?page=backend/30-ability-learning); the client side is [Ability Learning UI](?page=unity/45-ability-learning-ui).

## Server-authoritative

The client sends intents only: submit an action (ability, switch, item, **Rest**), use an item. The server (offline: the same cr-api DLLs on local SQLite) decides what each action costs, whether it is affordable, what is spent and what is gained. `BattleStateDto.AbilityCostMode` and every `ActionOutcome.AbilityCostMode` stamp the mode so presentation never guesses. The client never reports a resource value.

## The flag

`app_config.ability_cost_mode SMALLINT NOT NULL DEFAULT 0` (migration `M8020`, lands with slice 3). C# enum `AbilityCostMode`:

| Value | Name | One-line rule |
|---|---|---|
| 0 | `Free` | No costs. Exactly today's battle. Rest is refused (`rest_not_available`). |
| 1 | `BuilderSpender` | Free moves build Charge, big moves spend it. |
| 2 | `Energy` | Every move spends Energy from a pool that persists between battles. |
| 3 | `TurnPool` | A Surge pool that grows one per round; moves are gated by it. Nothing banks. |
| 4 | `PowerPoints` | Each move has PP that runs dry. Refilled by Rest, items, healers, whiteout. |

| Where | How |
|---|---|
| Admin read | `GET /api/v1/admin/app-config` returns `AppConfigResponse` with `abilityCostMode` |
| Admin write | `PUT /api/v1/admin/app-config/ability-cost-mode` body `{ mode }`, validated against the enum (400 on an unknown value). `IAppConfigRepository.SetAbilityCostModeAsync(mode)` |
| Policy | `RequireAdmin`, listed in `RoutePolicyManifest` |
| Client, online | `ability_cost_mode` (int and name) on the anonymous `GET /api/v1/version-check` |
| Offline | The last-seen server mode is remembered in player data (never in the content floor) and overlaid on the floor's `app_config` row by a small overlay `IAppConfigRepository` in Unity, so the offline DLLs see one mode without writing `game-data.bytes`. The floor default stays `Free` |
| Editor | Override (`Inherit/Free/BuilderSpender/Energy/TurnPool`) in the Studio Configuration panel; wins over the other sources; not shipped |

Merge order on the client (`AbilityCostModeSetting`, modelled on `RoamingSpawnersFlag`): Editor override, then server value when online, then the remembered value offline. Battle services read the mode once per round. A mode flip between rounds applies to the next round with no error and no negative resources.

`min_client_version` is raised in the release that ships this, because older clients cannot render costs or the Rest action.

## Switching the mode (Studio)

cr-admin-web, System, Game Config (studio.crystallinerift.com): a select listing all five modes with a one-line description each. This is where the mode is picked online. The Unity Studio Configuration panel only holds the Editor override. Same page as the roaming flag, see [Roaming Encounters](?page=unity/43-roaming-encounters).

## Cost columns

Every ability carries all four numbers.

| Column | Meaning | basic / mid / big / ultimate |
|---|---|---|
| `max_pp` (the existing `cost`, renamed, values kept) | PowerPoints: uses before the move runs dry | 35 / 20 / 10 / 5 |
| `energy_cost` (new) | Energy spent per use | 0 (generics) or 5 (element basics) / 15 / 30 / 40 |
| `charge_delta` (new, signed) | BuilderSpender: positive builds, negative spends | +1 (Growl, Harden; Focus +2) / -3 / -6 / -9 |
| `pool_cost` (new) | TurnPool: Surge needed this round | 1 / 3 / 5 / 8 |

Tiers: basic (Scratch, Tackle, Growl, Harden, Focus, Bite, element basics), mid (Slash, Body Slam, element mids), big (Fire Blast, Hydro Pump, Thunderbolt, Blizzard, Quake, Cyclone, Dawnbreak, Energy Ball, Miasma, Mega Burn), ultimate (Hyper Beam). Plumbing (lands with slice 3): `BaseAbility`, the `abilities` migration (rename `cost` to `max_pp`, add three columns), both upserts, the `GET /api/v1/abilities` projection, Unity `AbilityConfig` and `ContentSyncWriter` (must not clamp the signed `charge_delta`), cr-admin-web abilities form.

## Resource tables

| Mode | Resource | Owner | Lives | Starts | Cap |
|---|---|---|---|---|---|
| BuilderSpender | Charge | creature | `battle_creature_charge (battle_id, creature_id, charge)`, battle-scoped, deleted at battle end | 0 each battle; kept across switch-out | 10 |
| Energy | Energy | creature | `generated_creature_current_stats.current_energy` (null = full), persists out of battle like HP | full | `MaxEnergy(level) = 40 + 2 * level` |
| TurnPool | Surge | trainer (shared by the team) | `battle.trainer1_surge_bonus`, `battle.trainer2_surge_bonus` | pool each round = `min(round_number, 10) + bonus` | 10 plus bonus, hard cap 12 |
| PowerPoints | PP per move | creature | `generated_creature_ability_pp (generated_creature_id, ability_id, current_pp)`; no row = full | full | the move's `max_pp` |

A newly learned move starts at full PP; forgetting drops its row. Tuning constants (energy curve, in-battle regen of +5 Energy per round, Charge cap, Surge cap, Rest amounts) live in one pure class `AbilityCostTuning` in `CR.Game.Compat`, shipped to Unity.

## Policy: affordability and payment

Pure `AbilityCostPolicy` in `CR.Game.Compat`: `Evaluate(mode, ability, resource, roundNumber)` returns `{ affordable, cost, reason }`, and `Apply(mode, ability, resource)` returns the new resource. It is used by submit legality, round resolution, both AIs, the HUD list in `BattleStateDto`, and the Unity bag and HUD for display (all lands with slice 3).

- **Submit:** `BattleTurnDomainService.IsAbilityLegalAsync` also runs the policy. Failure is `TurnSubmitStatus.Unaffordable`, HTTP 400 `unaffordable_ability`; the round is not consumed (same as `illegal_ability`).
- **Resolution:** pay on use, hit or miss. An attacker interrupted before acting pays nothing. BuilderSpender builders add Charge after their action resolves (capped). Energy regen applies in the tick phase for both living creatures. TurnPool spends nothing (the pool is a gate), so `Apply` is a no-op except for bonuses. PowerPoints spends one PP per use; no regen in battle; 0 PP is unaffordable.
- **AI:** wild and trainer brains filter known moves to affordable ones first, then the existing heuristic. Nothing affordable means `Rest`. The wild brain reads the creature's four slots, not the progression set.
- **Whiteout and Healer NPC:** `HealTeamAsync` also clears `current_energy` (full) and PP rows. Charge rows are deleted when a battle ends or is abandoned.

## Rest

`BattleActionIntentKind.Rest` / `BattleActionType.Rest = 6`. Available in the four cost modes (refused in `Free` with `rest_not_available`). Consumes the turn and gives:

| Mode | Rest gives |
|---|---|
| BuilderSpender | +2 Charge |
| Energy | +25 % of max Energy |
| TurnPool | +1 Surge bonus for this battle |
| PowerPoints | +25 % of max PP to every move |

The HUD shows a Rest row after the four moves. Rest is the no-stuck guarantee: no creature is ever left without a usable action, in any mode.

## Items

| Effect | Item(s) | Notes |
|---|---|---|
| `ItemEffectType.RestoreEnergy = 14` | Tonic (30), Super Tonic (80), Full Tonic (100 %) | Params `{ amount, percent }`. Usable in battle and overworld. Fails `creature-energy-full`. In PowerPoints mode the same items restore PP on every known move (fails `creature-pp-full` when all full). Result fields `EnergyRestored`, `PpRestored` |
| `ItemEffectType.BoostSurge = 15` | Surge Shard | +1 Surge bonus for this battle, battle only. Fails `item-wrong-mode` outside TurnPool |

Sold by merchants (seeded stock the way `M6015` seeds potions): every merchant that sells Heal Potions sells Tonics; Super Tonic, Full Tonic and Surge Shard at town merchants. Prices Tonic 200, Super Tonic 600, Full Tonic 1500, Surge Shard 300 (builder tunes). A few pickup definitions too. See also [Item Effects](?page=backend/19-item-effects). The player's own in-battle item outcome also gains the previously missing `HpRestored` and `ItemName`.

## Wire shapes

- `BattleCreatureSnapshot` adds `maxHp, energy, maxEnergy, charge, maxCharge`.
- `BattleStateDto` adds `abilityCostMode, playerSurge, playerSurgeCap, opponentSurge, activeCreatureAbilities[]`. Each ability entry: `{ abilityId, cost, affordable, reason?, currentPp?, maxPp?, missionUnlocked }`.
- `ActionOutcome` adds `abilityCostMode, attackerResourceBefore, attackerResourceAfter, resourceKind, energyRestored, ppRestored, surgeBonusGained`, so the HUD animates spend and gain per step.

## Where the code lives

All lands with slice 3 unless noted: `Game/CR.Game.Compat` (`AbilityCostPolicy`, `AbilityCostTuning`), `Game/CR.Game.Model/Config/AbilityCostMode.cs` (slice 1 DTOs), `Game/CR.Game.Domain.Services` battle services, Game migrations `M21201` to `M21203`, Creatures migrations `M21006` to `M21008`, Items migration `M21104`.
