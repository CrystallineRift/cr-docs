# Item Effects and Status Cures

What an item does when a player uses it, who is allowed to refuse, and what the client is allowed to
predict.

The rule underneath everything on this page: **the server decides.** The Bag's target picker
([Player Menu UI](../unity/10-player-menu-ui.md)) greys a card out before the player commits, but it
is a courtesy — it exists so a player does not spend a potion to be told "no", not because the client
is trusted with the answer.

## The `item` table

`item` is the whole item catalogue. It is authored content, so it ships in the baked offline floor
(`Assets/StreamingAssets/CR/game-data.bytes`) as well as living in Postgres.

| Column | Type | Notes |
|---|---|---|
| `id` | UUID / TEXT | PK. Must match the authored `ItemDefinition.id` — a seed id loses to an authored id |
| `name` | TEXT | `NOT NULL` |
| `description` | TEXT | |
| `asset_key` | TEXT | Addressables address of the item's **prefab** |
| `item_type` | INTEGER | `ItemType`, `NOT NULL` |
| `max_stack_size` | INTEGER | `NOT NULL`, default `99` |
| `is_tradable` | INTEGER / BOOLEAN | `NOT NULL`, default true |
| `is_sellable` | INTEGER / BOOLEAN | `NOT NULL`, default true |
| `base_value` | INTEGER | `NOT NULL`, default `0` |
| `created_at` / `updated_at` | DATETIME | `NOT NULL`, default now |
| `deleted` | INTEGER / BOOLEAN | `NOT NULL`, default false — soft delete, as everywhere |
| `content_key` | TEXT | Designer-facing key (`item_antidote`) |
| `effect_type` | INTEGER | `ItemEffectType`, `NOT NULL`, default `0` |
| `effect_parameters` | TEXT | JSON, shape decided by `effect_type` |
| `usage_flags` | INTEGER | `ItemUsageFlags` bitmask, `NOT NULL`, default `0` |
| `trigger_type` | INTEGER | `HeldItemTriggerType`, `NOT NULL`, default `0` |
| `trigger_parameters` | TEXT | JSON for the held-item passive |
| `is_consumable` | INTEGER / BOOLEAN | `NOT NULL`, default false — decides whether one unit is deducted on a successful use |
| `capture_modifier` | NUMERIC | Capture-crystal odds multiplier |
| `prevents_evolution` | INTEGER / BOOLEAN | `NOT NULL`, default false |
| `icon_asset_key` | TEXT | **M6021** adds it, **M6022** backfills it. Addressables address of the 2D icon, `icons/items/<content_key>` |

`asset_key` and `icon_asset_key` are two different address spaces on purpose: the first points at a
GameObject, the second at a `Sprite`. Passing the prefab key to a sprite loader can only ever return
null, which is exactly the bug that hid five broken icon slots for months — see
[UI Icons](../unity/29-ui-icons.md).

`icon_asset_key` is **nullable with no default.** A defaulted string would point every un-authored row
at an Addressables key that does not exist, and the UI could not tell "no icon" from "icon missing".

Four migrations own this column:

| Migration | Domain | Does |
|---|---|---|
| `M6021AddIconAssetKeyToItem` | Items | Adds `item.icon_asset_key` |
| `M12012AddIconAssetKeyToContent` | Creatures | Adds it to `creature`, `abilities`, `status_conditions` |
| `M6022BackfillItemIconAssetKey` | Items | `UPDATE item SET icon_asset_key = 'icons/items/' \|\| content_key WHERE icon_asset_key IS NULL` |
| `M12013BackfillContentIconAssetKey` | Creatures | The same rule per table: `'icons/creatures/' \|\| content_key`, `'icons/abilities/' \|\| name`, `'icons/status/' \|\| name` |

Every seeded row landed with the column null — M6020 and M12011 ran before the column existed — so the
two backfills derive the key from what the Unity icon importer already uses as the address. They are
`WHERE icon_asset_key IS NULL`, so they never overwrite an authored key, and `Down()` is a documented
no-op on both. **A seed migration numbered above 6022 / 12013 must set `icon_asset_key` itself** — a
backfill runs once per database. See [UI Icons](../unity/29-ui-icons.md) for the full rule table.

The two `Add` migrations guard `Up()` on the column not already existing (and M12012 on each table
existing, because the per-domain SQLite runners point the Creatures assembly at databases that do not
carry every Creatures table), and both return early on SQLite in
`Down()` — the shipped SQLite has no
`DROP COLUMN`, and a leftover nullable column is inert.

## Enums

All three live in `cr-api/Game/CR.Game.Model/Items/`. A seed must cast from these, never type the
number: `M6007`/`M6009`/`M6013` once wrote `item_type = 1` for consumables and the Bag offered
**Equip** on a Radiant Crystal.

### `ItemType : short`

| Value | Name | Meaning |
|---|---|---|
| 0 | `Consumable` | Potions, food, crystals |
| 1 | `Equipment` | Held items |
| 2 | `KeyItem` | Progression; not sold or traded |
| 3 | `Material` | Crafting |
| 4 | `Currency` | Transactions |

### `ItemUsageFlags : short` (`[Flags]`)

| Value | Name |
|---|---|
| 0 | `None` |
| 1 | `UsableInBattle` |
| 2 | `UsableOverworld` |
| 4 | `TargetsOwnTeam` |
| 8 | `TargetsOpponent` |
| 16 | `HeldByCreature` |
| 32 | `MultiTarget` |
| 64 | `CaptureCrystal` |

The 15 creature consumables carry `7` = `UsableInBattle | UsableOverworld | TargetsOwnTeam`. Capture
crystals carry `9` = `UsableInBattle | TargetsOpponent`. The heal potion carries `19` =
`UsableInBattle | UsableOverworld | HeldByCreature` — a dual-use item, drinkable from the bag *and*
holdable so it auto-triggers in battle.

:::warning[Flag gates check absence]
`HeldByCreature` alone does not mean "held only". `ItemUseDomainService.IsHeldOnly` refuses direct use
only when the item carries `HeldByCreature` **and neither** `UsableInBattle` **nor**
`UsableOverworld`. A blanket `HasFlag(HeldByCreature)` refusal previously 400'd every potion use.
:::

### `ItemEffectType : short`

| Value | Name | Handler | Notes |
|---|---|---|---|
| 0 | `None` | — | No handler is registered; use fails with `No handler registered for effect type 'None'.` |
| 1 | `RestoreHp` | `RestoreHpHandler` | `{"amount":n,"percent":bool}` |
| 2 | `RestoreFullHp` | `RestoreFullHpHandler` | No parameters |
| 3 | `ReviveCreature` | `ReviveCreatureHandler` | `{"percentHp":n}` |
| 4 | `CureStatus` | `CureStatusHandler` | `{"conditions":["Poisoned"]}` |
| 5 | `CureAllStatus` | `CureAllStatusHandler` | No parameters |
| 6 | `BoostStatTemp` | `BoostStatTempHandler` | Battle only |
| 7 | `BoostStatPerm` | `BoostStatPermHandler` | |
| 8 | `LevelUp` | `LevelUpHandler` | |
| 9 | `GrantExperience` | `GrantExperienceHandler` | |
| 10 | `TriggerEvolution` | `TriggerEvolutionHandler` | Begins an evolution through `IEvolutionService` with the item as `usedItemId` — this handler is the only path that supplies one, after `ItemUseDomainService` has verified ownership; no parameters — the species' rules pick the target. Consumed at Commit and only when the winning group's `HeldItem` requirement names it with `consume_on_evolve`, so a stone used on a creature evolving on level alone is not spent |
| 11 | `CaptureCreature` | `CaptureCreatureHandler` | See [Capture Mechanic](../unity/14-capture-mechanic.md) |
| 12 | `IncreaseExpShare` | `IncreaseExpShareHandler` | |
| 20–25 | `HeldStatBoost`, `HeldDamageReduce`, `HeldTypeBoost`, `HeldRegenHp`, `HeldStatusImmune`, `HeldReviveOnce` | *(none)* | Held-item passives, evaluated by `IHeldItemTriggerEvaluator`, never by a use handler |

## `ItemUseDomainService.UseItemAsync`

`cr-api/Game/CR.Game.Domain.Services/Implementation/Item/ItemUseDomainService.cs`. The handlers are
injected as `IEnumerable<IItemEffectHandler>` and indexed by `EffectType`, so adding an effect means
adding a handler and registering it — the service itself does not change.

Checks run in this order, and every one of them returns `ItemUseResult.Fail` with a player-readable
sentence:

| Order | Check | Refusal |
|---|---|---|
| 1 | Item exists | `Item not found.` |
| 2 | The trainer owns it (`FindOwnedEntryAsync` walks the trainer's inventories and stops at the first hit) | `You do not own this item.` |
| 3 | In battle and not `UsableInBattle` | `This item cannot be used in battle.` |
| 4 | Out of battle and not `UsableOverworld` | `This item cannot be used outside of battle.` |
| 5 | `IsHeldOnly` | `This is a held item and must be equipped to a creature, not used directly.` |
| 6 | Capture crystal in a trainer battle | `Capture Crystals cannot be used in a trainer battle.` |
| 7 | Opponent-targeted without `TargetsOpponent`, in a trainer battle | `This item cannot target an opponent in a trainer battle.` |
| 8 | A handler exists for `effect_type` | `No handler registered for effect type '<type>'.` |
| 9 | The handler's own rules | see below |

"In battle" is `battleId.HasValue` — the Bag passes `null`, so an overworld use is checked against
`UsableOverworld` even though the client never says which it is.

Check 6 is deliberately made **regardless of how the client flagged the target**: a trainer's creature
can never be captured, and a wasted crystal plus the turn it cost is the worst outcome for the player.

After a successful handler:

1. One unit is removed **only if `is_consumable`**.
2. `items_used_total` and `items_used_<content_key>` are incremented in the Stats domain.
3. A `UsedItem` quest progress event fires, and an `ActivateKeyItem` one as well when
   `item_type = KeyItem`. Both are wrapped in try/catch — a quest failure must not undo a use that
   already happened.

One exception to consumption: when a handler reports `EvolutionTriggered = true`, the item is
**not** consumed here. The evolution's Commit consumes it, so a cancelled evolution leaves the
stone in the bag. See [Evolution](./16-evolution.md).

## Handler refusal rules

`cr-api/Game/CR.Game.Domain.Services/Implementation/Item/Handlers/`

A refusal is an answer, not a crash — but it still travels as a **400**: `ItemEndpoints` returns
`BadRequest(new { message = result.ErrorMessage })` for every unsuccessful handler. So the sentences
below reach the player through the error path, not the success path: `SimpleWebClient` turns the 400
into a `ServerRequestException` carrying the message, and `ItemUseFailureText.For` (beside
`ItemUseResultText`) hands it straight to the toast. Offline the same sentence arrives on
`ItemUseResult.ErrorMessage` and `ItemUseResultText.Describe` shows it. Both modes therefore say the
same words.

| Handler | Refuses when | Sentence |
|---|---|---|
| `RestoreHpHandler` | Target missing | `Target creature not found.` |
| | `CurrentHitPoints <= 0` | `Cannot restore HP of a fainted creature. Use Revive instead.` |
| | The heal would add nothing | `Creature is already at full HP.` |
| `RestoreFullHpHandler` | Same three | Same three |
| `ReviveCreatureHandler` | Target missing | `Target creature not found.` |
| | `CurrentHitPoints > 0` | `Creature has not fainted.` |
| `CureStatusHandler` | Nothing active at all | `None of the target conditions are active on this creature.` |
| | None of the named conditions is active | the same sentence |
| `CureAllStatusHandler` | **never** | — |
| `BoostStatTempHandler` | No `battleId` | `BoostStatTemp is only supported in battle.` |
| | The stat is already at the stage limit | `<stat> is already at the maximum/minimum stage limit.` |
| `BoostStatPermHandler` | Target missing | `Target creature not found.` |
| `LevelUpHandler` | Already at max level | `Creature is already at the maximum level.` |
| `GrantExperienceHandler` | Target missing | `Target creature not found.` |
| `IncreaseExpShareHandler` | `Percent <= 0` | `Item grants no EXP-share bonus.` |
| `TriggerEvolutionHandler` | No rule matches this item, a Bindstone is held, the only unmet requirement is the area, or the creature isn't the caller's | `It is holding something that stopped it changing.` (Bindstone), `It can't evolve here.` (every failing group failed on `InArea` alone), or `<item> has no effect on this creature.` otherwise |
| `CaptureCreatureHandler` | Not a wild battle / wrong target / fainted target / missing records | see [Capture Mechanic](../unity/14-capture-mechanic.md) |

A restore that lands is reported as `HpRestored` = the delta actually applied, not the item's
nominal amount. A revive reports `HpRestored` = the HP the creature woke up with **and**
`CreatureRevived = true`, which is why `ItemUseResultText` leads with the revive.

:::note[`CureAllStatus` never fails]
`CureAllStatusHandler` reads the active conditions, removes them all and returns success with a
possibly-empty `ConditionsCured` list. Using a Full Heal on a healthy creature therefore **succeeds
on the server and consumes the item.** `CureStatusHandler` refuses in the same situation. The Bag's
`ItemTargetRule` greys `CureAll` out on a healthy creature (`No status to cure`), so the player is
not led into it, but the divergence is real and lives in the handler, not the UI.
:::

Cure matching is by **name**, case-insensitively (`StringComparer.OrdinalIgnoreCase`), joined through
`IAbilityRepository.GetStatusConditionsWithStatChanges(ids, ct)` — only the conditions actually on the
creature are looked up, never the whole catalogue. Name is the only identity the handler reads, which
is why `item_ice_melt` still cures `Frozen` even though `Frozen` was seeded by a different migration
under a different id than the consumables batch expected.

## Offline mirror and its divergences

`cr-api-unity/Assets/CR/Game/Battle/Offline/OfflineItemUseService.cs` implements the same
`IItemUseDomainService` interface against local SQLite, and `OnlineOfflineItemDomainService` picks
between it and `ItemHttpDomainAdapter` on connectivity. The HP, revive and cure arithmetic is
copied line for line, including the refusal sentences.

Where the two do **not** agree:

| Effect | Server | Offline |
|---|---|---|
| Ownership, usage flags, held-only | Checked (steps 2–5 above) | **Not checked.** `ValidateItemUseAsync` returns `Valid()` unconditionally |
| `CureAllStatus` on a healthy creature | Succeeds, cures nothing, consumes the item | **Fails** with `None of the target conditions are active on this creature.` (`CureConditionsAsync` shares one code path with `CureStatus`) |
| `BoostStatTemp` | Battle-only; enforces the stage limit; writes a modifier | Returns `Success = true` and **persists nothing** — a reported boost that does not exist |
| `TriggerEvolution` | Begins an offer; consumes at Commit | Same — `OfflineItemUseService` calls the same `IEvolutionService` over the baked rules |
| `items_used_total` / `items_used_<key>` stats | Written | **Not written** |
| `UsedItem` / `ActivateKeyItem` quest events | Raised | **Not raised** |
| `IncreaseExpShare` | Handler writes the stat | Same — the one stat the offline path does write |

The first row is by design: offline there is no adversary to guard against, and the bag it reads is
the same database it writes. The rest are gaps, and `BoostStatTemp` is the one worth fixing — a
reported boost that does not exist.

## Seeded items

`M6020SeedCreatureConsumables` seeds the 15 creature consumables. All are `item_type = 0`
(`Consumable`), `usage_flags = 7`, `is_consumable = true`, `max_stack_size = 99`, ids
`a1c00001-0000-4000-8000-00000000000{1..f}` — the authored `ItemDefinition` ids, verbatim and
lowercase.

Read back from the baked floor
(`sqlite3 Assets/StreamingAssets/CR/game-data.bytes "SELECT content_key,name,item_type,usage_flags,effect_type,effect_parameters FROM item WHERE deleted=0 ORDER BY content_key"`):

| `content_key` | Name | `effect_type` | `effect_parameters` | `base_value` |
|---|---|---|---|---|
| `item_antidote` | Antidote | 4 `CureStatus` | `{"conditions":["Poisoned"]}` | 60 |
| `item_awakening` | Awakening | 4 `CureStatus` | `{"conditions":["Asleep"]}` | 60 |
| `item_burn_salve` | Burn Salve | 4 `CureStatus` | `{"conditions":["Burn"]}` | 60 |
| `item_clarity_tonic` | Clarity Tonic | 4 `CureStatus` | `{"conditions":["Confusion"]}` | 80 |
| `item_fortify_tonic` | Fortify Tonic | 4 `CureStatus` | `{"conditions":["Weakened"]}` | 80 |
| `item_full_heal` | Full Heal | 5 `CureAllStatus` | *(none)* | 250 |
| `item_hyper_potion` | Hyper Potion | 1 `RestoreHp` | `{"amount":200,"percent":false}` | 300 |
| `item_ice_melt` | Ice Melt | 4 `CureStatus` | `{"conditions":["Frozen"]}` | 60 |
| `item_max_potion` | Max Potion | 2 `RestoreFullHp` | *(none)* | 600 |
| `item_max_revive` | Max Revive | 3 `ReviveCreature` | `{"percentHp":100}` | 800 |
| `item_paralyze_heal` | Paralyze Heal | 4 `CureStatus` | `{"conditions":["Paralyzed"]}` | 60 |
| `item_quickstep` | Quickstep | 4 `CureStatus` | `{"conditions":["Slow"]}` | 80 |
| `item_revive` | Revive | 3 `ReviveCreature` | `{"percentHp":50}` | 400 |
| `item_skyroot` | Skyroot | 4 `CureStatus` | `{"conditions":["Grounded"]}` | 80 |
| `item_super_potion` | Super Potion | 1 `RestoreHp` | `{"amount":80,"percent":false}` | 120 |

The rest of the seeded catalogue, for context: `capture_crystal_shard` / `_standard` / `_fine` /
`_radiant` (flags 9, effect 11), `exp_share_charm` (flags 7, effect 12, `{"Percent":20}`),
`item_heal_potion_30` (flags 19, effect 1), `bindstone` (`Equipment`), `toy_bouncy_ball` (`KeyItem`).

Each of the fifteen has a matching `ItemDefinition` asset at
`Assets/CR/Content/Defs/Items/<contentKey>.asset` whose `id` is the seed GUID verbatim, lowercase,
with `displayNameKey = <contentKey>_display` and `iconKey = icons/items/<contentKey>`; all fifteen are
registered on `ContentDefinitionProvider.asset`, without which the offline
`ScriptableObjectContentRegistry` would never see them. Asleep and Paralyzed have
`StatusConditionConfig` assets at `Assets/CR/Content/Defs/StatusConditions/`, found by
`AssetDatabase.FindAssets` and so needing no registration.

A seed id loses to an authored id — a `content_key` unique index silently discards the seed's GUID
when the two disagree — so those ids are not optional. They were verified field-by-field against the
baked floor, not against a live server: if a deployed database ever holds these items under different
GUIDs, the first Studio pull rewrites `def.id` and the two namespaces split silently. One
`GET /api/v1/items` is worth doing before the first push to an unfamiliar server.

The seed is idempotent on both engines — `INSERT OR IGNORE` on SQLite, `ON CONFLICT DO NOTHING` on
Postgres, both untargeted so they cover the primary key and every unique index — and is pinned by
`SeededCreatureConsumablesSqliteTests` and `SeededCreatureConsumablesTests` (Postgres), each of which
re-migrates after dropping the `VersionInfo` row and compares a full per-row fingerprint rather than a
count.

## Status conditions

`M12011SeedStatusHooks` adds `Asleep` and `Paralyzed`. **`Frozen` was already seeded** by
`M10018SeedElementalReactions` under `c0d00000-0000-4000-8000-000000000004`, as the primer half of
the Shatter reaction; re-authoring it under a new id would have been silently swallowed by the
idempotency clause and the authored id would never have existed.

The full catalogue, from the baked floor:

| Name | Type | `duration_turns` | `probability` | Stat change | Cured by |
|---|---|---|---|---|---|
| Asleep | Debuff | 2 | 50 | Speed −6 | `item_awakening`, `item_full_heal` |
| Burn | Debuff | 4 | 75 | HealthPoints −5 | `item_burn_salve`, `item_full_heal` |
| Confusion | Debuff | 3 | 50 | SpecialAttack −4 | `item_clarity_tonic`, `item_full_heal` |
| Frozen | Debuff | 2 | 100 | Defense −6, SpecialDefense −6, Attack −4 | `item_ice_melt`, `item_full_heal` |
| Grounded | Debuff | 3 | 50 | Speed −10 | `item_skyroot`, `item_full_heal` |
| Paralyzed | Debuff | 3 | 40 | Speed −4 | `item_paralyze_heal`, `item_full_heal` |
| Poisoned | Debuff | 4 | 60 | HealthPoints −4 | `item_antidote`, `item_full_heal` |
| Slow | Debuff | 3 | 50 | Speed −8 | `item_quickstep`, `item_full_heal` |
| Soaked | Debuff | 3 | 100 | SpecialDefense −3 | **`item_full_heal` only** |
| Weakened | Debuff | 3 | 100 | Attack −3 | `item_fortify_tonic`, `item_full_heal` |

Amounts are stored **positive** under `calculation = 'Subtract'`. `BattleResolver` applies
`Calculation.Subtract` as `current - sc.Amount`, so a negative amount there would read as a buff.
Each stat change's `duration` matches its condition's own `duration_turns`.

:::note[A seed needs an inflictor]
A cure item for a condition nothing can inflict is a dead item: `CureStatusHandler` could only ever
reach its refusal. M12011 therefore also seeds four `ability_status_conditions` links:

| Ability | Condition |
|---|---|
| Spark | Paralyzed |
| Thunder Fang | Paralyzed |
| Miasma | Asleep |
| Energy Ball | Asleep |

Link `probability` is `100`, as every row in `ability_status_conditions` is. The real proc rate is the
**condition's** own probability (50 for Asleep, 40 for Paralyzed), because `BattleResolver` rolls
against `rc.Definition.Probability`; `100` on the link means "this link is not itself a filter".
No seeded ability is named for sleep — Miasma ("a cloud that settles and
stays") and Energy Ball are the nearest available reads, not natural fits, and a real Spore or Lullaby
ability would be the right long-term home.

Spark and Thunder Fang now carry two conditions each (Slow from M10005, Paralyzed from M12011), rolled
independently — both Speed drops, so a creature that catches both is at Speed −12.
:::

:::note[Already-migrated databases: M12014]
M10018, M10019 and M12011 originally wrote their `status_condition_stat_changes` and
`ability_status_conditions` rows against hard-coded condition ids. Where Crystalline Rift Studio had already
minted a same-named condition under an id of its own, the seed's own condition insert was silently
swallowed by the name conflict and the dependent link was left naming an id nothing holds — neither
join table has a foreign key, so nothing ever raised an error; the cure and the ability-inflicted
condition above simply did nothing. Those three migrations were amended to resolve the id by name at
insert time (see the changelog), which only helps a database created afterward.
`M12014RepairSeededIconsAndConditionLinks` is the forward repair: it re-points a dangling link at the
live condition of the same name, on both engines, and leaves an already-resolving link — including
one Crystalline Rift Studio authored — untouched.
:::

Two open design notes, both recorded in the M12011 header: Asleep and Paralyzed are pure Speed drops,
and M10018 documents that after the opening turn nothing in the resolver reads Speed except escape
chance — so they are close to cosmetic. And `Soaked` has no single-condition cure item.

## `GET /api/v1/trainers/{trainerId}/creatures/{creatureId}/status-conditions`

`cr-api/Game/CR.Game.Service.BFF/Endpoints/CreatureStatusEndpoints.cs`, registered in
`Convenience/CR.REST.AIO/Program.cs` next to `MapItemEndpoints()`.

The Bag needs a condition's name and icon to decide whether a cure item applies and to say what it
would cure. Those live in the Creatures catalogue, while the active rows carry only an id and a turn
counter. Nothing else on the API returns them together, and the client cannot join the two itself.

```
GET /api/v1/trainers/{trainerId:guid}/creatures/{creatureId:guid}/status-conditions

200 -> IReadOnlyList<CreatureStatusConditionView>
       [ { "statusConditionId": "…", "name": "Poisoned", "iconAssetKey": "icons/status/Poisoned", "turnsRemaining": 3 } ]
401 -> no token
404 -> the creature does not exist, OR it is not this trainer's
```

`CreatureStatusConditionView` is `(Guid StatusConditionId, string Name, string? IconAssetKey,
int? TurnsRemaining)` in `CR.Game.Model/Creatures/`.

**Authorization: no policy of its own**, which is not the same as anonymous. `AddCrAuth` installs
`options.FallbackPolicy = new AuthorizationPolicyBuilder().RequireAuthenticatedUser().Build()`
(`Auth/CR.Auth.Service.REST/Security/CrAuthExtensions.cs`), so an unauthenticated request gets **401**.
This matches `POST /api/v1/trainers/{trainerId}/items/{itemId}/use`, which also declares no policy.
Pinned by `CreatureStatusEndpointsHttpTests.GetStatusConditions_Unauthenticated_Returns401`.

:::warning[Parked: the caller is not bound to the trainer]
What the endpoint checks is that the **creature in the path belongs to the trainer in the path**
(`GeneratedCreature.CurrentTrainerId != trainerId` → 404), exactly as `ItemEndpoints`' held-item reads
do. It does **not** check that the caller's account owns that trainer. Binding caller → trainer is a
follow-up in the auth ladder, and it lands for this route and its item-use sibling together.
:::

Both 404 branches are pinned separately (`GetStatusConditions_ForUnknownCreature_Returns404` and the
wrong-owner test), because a regression to `Ok(empty)` would tell the Bag that a creature which does
not exist is simply healthy.

A condition whose definition has been soft-deleted still ticks on the creature, so the row is returned
with `Name = "Unknown"` and a null icon rather than being dropped — the pip stays visible rather than
silently dropping a live effect. "Unknown" rather than the GUID: the Bag renders `Name` straight into
the picker, and a 36-character GUID there reads as a bug to the player. The id is still on the view for
a log line.

An empty condition list short-circuits before the catalogue read.

## Related

- [Player Menu UI](../unity/10-player-menu-ui.md) — the Bag, the target picker, `ItemTargetRule`
- [Battle Bag UI](../unity/13-battle-bag-ui.md) — the in-battle item panel
- [UI Icons](../unity/29-ui-icons.md) — `icon_asset_key`, `IconAddress`, the importer
- [Capture Mechanic](../unity/14-capture-mechanic.md) — `CaptureCreature` in detail
- [Creature Generation](04-creature-generation.md) — status conditions in the battle resolver
