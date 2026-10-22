# Ability Economy

One server flag, `app_config.ability_cost_mode`, picks how abilities are paid for in battle: not at all (`Free`, today's behaviour), with a Charge that builders fill and big moves spend (`BuilderSpender`), with a persistent per-creature Energy pool (`Energy`), with a per-round Surge pool shared by the team (`TurnPool`), or with per-move power points (`PowerPoints`). Every ability carries all four cost numbers, so one content set serves every mode, and the mode is switched online from the Studio Game Config page. The flag ships as `Free`, so nothing changes until it is flipped.

> Status: server code merged on cr-api `feature/ability-economy` (migrations `M21006` to `M21008`, `M21104`, `M21201` to `M21203`). The Unity client is merged on cr-api-unity `feature/ability-economy` (see Ability Learning UI). Spec: `docs/superpowers/specs/2026-10-22-ability-progression-and-economy-design.md` in cr-api-unity. Plan: `docs/superpowers/plans/2026-10-22-ability-economy.md`. Learn lists, tones and the learn intent are on [Ability Learning](?page=backend/30-ability-learning); the client side is [Ability Learning UI](?page=unity/45-ability-learning-ui).

## Server-authoritative

The client sends intents only: submit an action (ability, switch, item, **Rest**), use an item. The server (offline: the same cr-api DLLs on local SQLite) decides what each action costs, whether it is affordable, what is spent and what is gained. `BattleStateDto.AbilityCostMode` and every `ActionOutcome.AbilityCostMode` stamp the mode so presentation never guesses. The client never reports a resource value.

## The flag

`app_config.ability_cost_mode SMALLINT NOT NULL DEFAULT 0` (migration `M21201AddAbilityCostModeToAppConfig`; `SMALLINT` on Postgres, `INTEGER` on SQLite). C# enum `AbilityCostMode`:

| Value | Name | One-line rule |
|---|---|---|
| 0 | `Free` | No costs. Exactly today's battle. Rest is refused (400 `battle-rest-not-available`, message `rest_not_available`). |
| 1 | `BuilderSpender` | Free moves build Charge, big moves spend it. |
| 2 | `Energy` | Every move spends Energy from a pool that persists between battles. |
| 3 | `TurnPool` | A Surge pool that grows one per round; moves are gated by it. Nothing banks. |
| 4 | `PowerPoints` | Each move has PP that runs dry. Refilled by Rest, items, healers, whiteout. |

| Where | How |
|---|---|
| Admin read | `GET /api/v1/admin/app-config` returns `AppConfigResponse(RoamingSpawners, AbilityCostMode, AbilityCostModeName, UpdatedAtUtc)` |
| Admin write | `PUT /api/v1/admin/app-config/ability-cost-mode` body `{ mode }` (`SetAbilityCostModeRequest`; the enum name or its integer), validated against the enum (400 on an unknown value). `IAppConfigRepository.SetAbilityCostModeAsync(mode)` (`AppConfigAdminEndpoints.cs`) |
| Policy | `RequireAdmin`, listed in `RoutePolicyManifest` |
| Client, online | `ability_cost_mode` (int) and `ability_cost_mode_name` (string) on the anonymous `GET /api/v1/version-check` (`VersionCheckEndpoints.cs`) |
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
| `max_pp` (the old `cost`, renamed by `M21006AbilityCostColumns`, values kept) | PowerPoints: uses before the move runs dry | 35 / 20 / 10 / 5 |
| `energy_cost` (new) | Energy spent per use | 0 (generics) or 5 (element basics) / 15 / 30 / 40 |
| `charge_delta` (new, signed) | BuilderSpender: positive builds, negative spends | +2 (Growl, Harden, Focus; `M21006AbilityCostColumns.DoubleChargeKeys`) or +1 (other basics) / -3 / -6 / -9 |
| `pool_cost` (new) | TurnPool: Surge needed this round | 1 / 3 / 5 / 8 |

Tiers: basic (Scratch, Tackle, Growl, Harden, Focus, Bite, element basics), mid (Slash, Body Slam, element mids), big (Fire Blast, Hydro Pump, Thunderbolt, Blizzard, Quake, Cyclone, Dawnbreak, Energy Ball, Miasma, Mega Burn), ultimate (Hyper Beam). Plumbing in cr-api: `BaseAbility` (`MaxPp`, `EnergyCost`, `ChargeDelta`, `PoolCost`), `M21006` (rename `cost` to `max_pp`, add `energy_cost`, `charge_delta`, `pool_cost`, seed by the tiers above in `M21006AbilityCostColumns.Tiers`; abilities no list matched are tiered by `max_pp`), `BaseAbilityRepository` upserts, the `GET /api/v1/abilities` projection and `AbilityEndpoints.cs`. A `maxPp` in a payload wins over the legacy `cost` key. Unity side: `AbilityConfig` carries `maxPp`, `energyCost`, `chargeDelta` and `poolCost`, and `ContentSyncWriter` does not clamp the signed `charge_delta` (see [Ability Learning UI](?page=unity/45-ability-learning-ui)).

## Resource tables

| Mode | Resource | Owner | Lives | Starts | Cap |
|---|---|---|---|---|---|
| BuilderSpender | Charge | creature | `battle_creature_charge (id, battle_id, creature_id, charge, updated_at, deleted)` (`M21202CreateBattleCreatureChargeTable`, unique on battle + creature), battle-scoped, deleted at battle end | 0 each battle; kept across switch-out | 10 |
| Energy | Energy | creature | `generated_creature_current_stats.current_energy` (nullable INT, `M21007AddCurrentEnergyToCurrentStats`; null = full), persists out of battle like HP | full | `MaxEnergy(level) = 40 + 2 * level` |
| TurnPool | Surge | trainer (shared by the team) | `battle.trainer1_surge_bonus`, `battle.trainer2_surge_bonus` (`M21203AddSurgeBonusToBattle`, INT default 0; `BattleRecord.Trainer1SurgeBonus/Trainer2SurgeBonus`) | pool each round = `min(round_number, 10) + bonus` | 10 plus bonus, hard cap 12 |
| PowerPoints | PP per move | creature | `generated_creature_ability_pp (generated_creature_id, ability_id, current_pp, ...)` (`M21008CreateGeneratedCreatureAbilityPpTable`); no row = full | full | the move's `max_pp` |

A newly learned move starts at full PP; forgetting drops its row. Tuning constants (energy curve, in-battle regen of +5 Energy per round, Charge cap, Surge cap, Rest amounts) live in one pure static class `AbilityCostTuning` in `CR.Game.Compat` (`Convenience/CR.Game.Compat/Economy/`), shipped to Unity: `EnergyBase 40`, `EnergyPerLevel 2`, `EnergyRegenPerRound 5`, `ChargeCap 10`, `SurgeCap 10`, `SurgeHardCap 12`, `RestEnergyShare 0.25`, `RestChargeGain 2`, `RestSurgeBonus 1`, `RestPpShare 0.25`, `MaxEnergy(level)`.

## Policy: affordability and payment

Pure static `AbilityCostPolicy` in `CR.Game.Compat.Economy`, over the records `AbilityCosts(MaxPp, EnergyCost, ChargeDelta, PoolCost)` and `ResourceState` (`Energy`, `MaxEnergy`, `Charge`, `Surge`, `SurgeBonus`, `CurrentPp`, `MaxPp`):

- `Evaluate(mode, costs, state, roundNumber)` returns `AbilityAffordability(Affordable, Cost, Reason)`; reasons `not-enough-energy`, `not-enough-charge`, `not-enough-surge`, `no-pp`.
- `Pay(mode, costs, state)`, `Regen(mode, state)`, `Rest(mode, state)`, `RestPp(maxPp, currentPp)` and `SurgePool(round, bonus)` return the new state / value.

It is used by submit legality, round resolution, the wild AI, and the HUD list in `BattleStateDto`. The Unity bag and HUD use it for display only (lands with slice 3, Unity).

The server side wraps it in `BattleResourceLedger` (internal, `Implementation/Battle/`): reads the mode once per (battle, round) from `IAppConfigRepository` (any read failure means Free), loads and saves each mode's resource (`current_energy`, `battle_creature_charge`, surge bonus columns, PP rows) and names the unit (`energy`, `charge`, `surge`, `pp`). The battle rules are in `BattleDomainService.Economy.cs` (partial class): `GetUnaffordableReasonAsync`, `IsRestAvailableAsync`, pay, Rest, Energy regen, state snapshot fields and active ability options.

- **Submit:** `BattleTurnDomainService.IsAbilityLegalAsync` also runs the policy. Failure is `TurnSubmitStatus.Unaffordable`, HTTP 400 with code `battle-unaffordable-ability` (message `unaffordable_ability`, the detail is the `AbilityAffordability` reason; `BattleActionsEndpoints.cs`); the round is not consumed (same as `illegal_ability`).
- **Resolution:** pay on use, hit or miss. An attacker interrupted before acting pays nothing. BuilderSpender builders add Charge after their action resolves (capped). Energy regen applies in the tick phase for both living creatures. TurnPool spends nothing (the pool is a gate), so `Apply` is a no-op except for bonuses. PowerPoints spends one PP per use (a missing PP row counts as full); no regen in battle; 0 PP is unaffordable.
- **AI:** the AI brain (`WildBattleAIDomainService`) filters known moves to affordable ones first, then the existing heuristic. Nothing affordable means `Rest` (`WildBattleAIDomainService`). The wild brain reads the creature's four slots; only when all four are empty does it fall back to the progression set (and paginated abilities).
- **Whiteout and Healer NPC:** `CreatureInventoryService.HealTeamAsync` also clears `current_energy` (full) and PP rows. Charge rows are deleted when a battle ends or is abandoned (`IBattleRepository.DeleteChargesAsync`).

## Rest

`BattleActionIntentKind.Rest` / `BattleActionType.Rest = 6`. Available in the four cost modes. In `Free` it is refused: `TurnSubmitStatus.IllegalAbility` with message `rest_not_available`, mapped to 400 `battle-rest-not-available`. The submit path maps `BattleActionIntentKind.Rest` to `BattleAction { Type = Rest }`. Consumes the turn and gives:

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
| `ItemEffectType.RestoreEnergy = 14` | Tonic (30), Super Tonic (80), Full Tonic (100 %) | Params `{ amount, percent }`. Usable in battle and overworld. Params `RestoreEnergyParams`. Own creature only. Energy mode: fails `item-creature-energy-full` at full Energy (`current_energy` null or max). PowerPoints mode: restores PP on every known move, fails `item-creature-pp-full` when all full. Other modes: `item-wrong-mode`. `RestoreEnergyHandler`. Result fields `EnergyRestored`, `PpRestored` |
| `ItemEffectType.BoostSurge = 15` | Surge Shard | +1 Surge bonus for this battle, battle only. `BoostSurgeHandler`. Fails `item-battle-only` outside battle, `item-wrong-mode` outside TurnPool, `item-surge-maxed` at the bonus ceiling (`SurgeHardCap - SurgeCap` = 2). Result field `SurgeBonusGained` |

Item error codes (`ItemErrorCodes`): `item-creature-energy-full`, `item-creature-pp-full`, `item-wrong-mode`, `item-battle-only`, `item-surge-maxed`, `item-own-creature-only`.

Seeded by `M21104SeedEnergyItems` (item ids `a5d00000-0000-4000-8000-00000000000N`, keys `item_tonic_30`, `item_super_tonic`, `item_full_tonic`, `item_surge_shard`): prices Tonic 200, Super Tonic 600, Full Tonic 1500, Surge Shard 300 (builder tunes). Merchant stock the way `M6015` seeds potions: every merchant spawner that already stocks `item_heal_potion_30` also sells the Tonic (probability 0.9, max 4); Super Tonic (0.5, max 2), Full Tonic (0.3, max 1) and Surge Shard (0.5, max 2) go on the starting merchant and the area 1 (Meadow) merchant. Spawners already stamped keep their stock until a restock re-rolls them. See also [Item Effects](?page=backend/19-item-effects). `ItemUseResult.ItemName` is now set by `ItemUseDomainService` on success, and the player's own in-battle item outcome gains the previously missing `HpRestored` and `ItemName`. Item steps are stamped with the economy fields (`StampItemEconomyAsync`).

## Wire shapes

- `BattleCreatureSnapshot` adds `MaxHp, Energy, MaxEnergy, Charge, MaxCharge` (zero outside their mode).
- `BattleStateDto` adds `AbilityCostMode, PlayerSurge, PlayerSurgeCap, OpponentSurge, ActiveCreatureAbilities[]` (class `BattleStateDto`, `IBattleDomainService.cs`). Each `BattleAbilityOption`: `{ AbilityId, Cost, Affordable, Reason?, CurrentPp?, MaxPp?, MissionUnlocked }`. Free mode: cost 0, always affordable.
- `ActionOutcome` adds `AbilityCostMode, ResourceKind ("energy" | "charge" | "surge" | "pp" | null), AttackerResourceBefore, AttackerResourceAfter, EnergyRestored, PpRestored, SurgeBonusGained`, stamped per step through `EconomyStamp.ApplyTo`, so the HUD animates spend and gain. A Rest step in PowerPoints sums every known move. `ItemUseResult` carries `EnergyRestored`, `PpRestored`, `SurgeBonusGained`.
- `BattleActionType.Rest = 6`; `BattleActionIntentKind.Rest`.

## Where the code lives

- `Convenience/CR.Game.Compat/Economy/`: `AbilityCostPolicy`, `AbilityCostTuning`, `AbilityCosts`, `AbilityAffordability`, `ResourceState`.
- `Game/CR.Game.Model/Config/AbilityCostMode.cs`, `AppConfig.cs` (`AbilityCostMode`), `Game/CR.Game.Data/*AppConfig*` (`SetAbilityCostModeAsync`).
- `Game/CR.Game.Domain.Services/Implementation/Battle/`: `BattleResourceLedger.cs`, `BattleDomainService.Economy.cs`, `BattleDomainService.cs`, `BattleDomainService.Rounds.cs`, `WildBattleAIDomainService.cs`; `Implementation/Item/Handlers/RestoreEnergyHandler.cs`, `BoostSurgeHandler.cs`.
- `Npcs/CR.Npcs.Domain.Services/Implementation/Battle/BattleTurnDomainService.cs` (submit gate), `Npcs/CR.Npcs.Service.REST/Endpoints/BattleActionsEndpoints.cs` (error mapping).
- Migrations: Game `M21201`, `M21202`, `M21203`; Creatures `M21006`, `M21007`, `M21008`; Items `M21104`. The offline floor (`game-data.bytes`) is rebaked at `M21201`.
