# Ability Learning

Every evolution line owns one learn list. Creatures learn a move every four to six levels, a fifth move triggers a server-driven learn or forget offer, and crystal tones teach moves that are on no level list. The server decides every learn, forget and teach; the client names the move it wants and the move it will forget, never a slot. Generation above level 1 keeps the last four moves of the line.

> Status: design draft. Code sentences are marked "(lands with slice N)" until merged (slice 1 = learning core, slice 2 = tones). Spec: `docs/superpowers/specs/2026-10-22-ability-progression-and-economy-design.md` in cr-api-unity. Costs and modes: [Ability Economy](?page=backend/27-ability-economy). Client: [Ability Learning UI](?page=unity/44-ability-learning-ui).

## Line sets

One `ability_progression_set` per evolution line, named `line_<base species>`. Level-1 gives three moves: two generics (from Scratch, Tackle, Growl, Harden) plus the element's basic move; Normal lines take three generics. Slot 4 is empty on purpose so the first learned move fills it without a prompt. Then one new move every 4 to 6 levels to about level 30 to 38, the big move at or after evolution, the strong finisher last. Each line also lists one to three **tone-only** moves, absent from the level list.

`ability_slot` means order within a level (1..4); several entries may share a level, and a set may hold any number of entries. `(level, slot)` stays the sync natural key. Quest gates (`unlock_quest_content_key`) are unchanged: a gated entry is skipped until the gate opens, then becomes learnable.

Set ids `a5e00000-0000-4000-8000-0000000000NN` (NN 01..11), entry ids `a5e1NN00-LLSS-4000-8000-000000000000`. Seeds are migrations `M21003` (sets) and `M21002` (generic abilities), lands with slice 1.

| Line (element) | L1 | Level list | Tone-only |
|---|---|---|---|
| line_cindris (Fire) | Scratch, Growl, Ember | 5 Flame Pounce, 9 Slash, 13 Flame Wheel, 18 Focus, 22 Inferno Claw, 28 Fire Blast, 36 Mega Burn | Hyper Beam, Earth Spike |
| line_dragonspark (Lightning) | Growl, Tackle, Spark | 5 Bite, 10 Thunder Fang, 15 Slash, 20 Harden, 25 Flame Wheel, 30 Thunderbolt, 38 Fire Blast | Hyper Beam, Cyclone |
| line_bud (Flora) | Tackle, Growl, Vine Whip | 4 Absorb, 8 Harden, 13 Body Slam, 18 Energy Ball, 26 Sunbeam, 34 Focus | Dawnbreak, Hyper Beam |
| line_sunflowerfairy (Wind) | Growl, Tackle, Gust | 5 Glimmer, 9 Wing Beat, 13 Absorb, 16 Sunbeam, 22 Cyclone, 30 Dawnbreak | Energy Ball, Hyper Beam |
| line_crabby (Water) | Tackle, Harden, Bubble | 5 Scratch, 10 Bubble Beam, 14 Drench, 18 Body Slam, 24 Ice Shard, 30 Hydro Pump | Frost Bite, Spark, Earth Spike, Hyper Beam |
| line_snakelet (Poison) | Scratch, Growl, Acid Drop | 5 Bite, 9 Venom Fang, 13 Slash, 17 Miasma, 21 Body Slam, 28 Focus | Mud Shot, Hyper Beam |
| line_snowbomb (Ice) | Tackle, Growl, Ice Shard | 5 Harden, 9 Frost Bite, 14 Bubble, 19 Body Slam, 24 Drench, 30 Blizzard | Hydro Pump, Hyper Beam |
| line_spike (Ground) | Scratch, Harden, Mud Shot | 5 Growl, 9 Bite, 13 Earth Spike, 18 Slash, 23 Focus, 28 Quake | Venom Fang, Hyper Beam |
| line_wolfpup (Normal) | Scratch, Growl, Tackle | 4 Bite, 8 Focus, 12 Slash, 16 Body Slam, 22 Harden, 30 Hyper Beam | Ember, Thunder Fang |
| line_mudcalf (Normal) | Tackle, Growl, Harden | 5 Scratch, 9 Body Slam, 14 Mud Shot, 19 Slash, 25 Focus, 32 Hyper Beam | Earth Spike, Quake |
| line_gaterbear (Ground) | Scratch, Growl, Mud Shot | 5 Bite, 10 Harden, 14 Earth Spike, 19 Slash, 24 Body Slam, 32 Quake | Frost Bite, Hyper Beam |

New generic abilities (ids `a5a00000-0000-4000-8000-00000000000N`): Bite (1), Body Slam (2), Harden (3, self Defense up 3 turns), Focus (4, self Attack up 3 turns). Gaterbear is seeded into cr-api with its authored Unity id `5cc4db96-ddc6-4f2b-99ae-e1c1ebdd6e5a` (migration `M21004`; an existing `creature_gaterbear` row under another id is re-keyed).

Invariants pinned by migration tests: every spawnable species has a line set with at least three level-1 entries and no quest gate on them; at most four entries per level; no entry references a soft-deleted ability; no duplicate ability in a set; a generated creature at any band level has four non-empty slots.

## Species default

New nullable column `creature.default_ability_progression_set_id` (migration `M21001`, lands with slice 1). Generation resolves `template.AbilityProgressionSetId ?? species.DefaultAbilityProgressionSetId`. NPC gifts, NPC teams and starters use the species default. The `starter_creature_ability_progression_set_id` config key is deleted from cr-api `appsettings.json`, cr-ops config and Unity `GameSettings`. Spawner templates and trainer slots may still override; blank means inherit.

On the wire the reference is by **set name**: `PUT /api/v1/creatures/by-content-key/{key}` accepts `defaultAbilityProgressionSetName` (409 `unresolved_reference` when unknown; blank clears); GETs return id and name. Migration `M21005` soft-deletes the 18 legacy sets, nulls template and trainer-slot set ids so they inherit, and repoints existing generated creatures by species (slots left as they are). Evolution keeps the instance's set, so evolved forms learn from the same line list.

## Generation rule

For a creature generated above level 1 (wild spawns, NPC teams, gifts, trainer slots): take set entries with `level <= L` ordered by `(level, slot)` and keep the **last four**. That is the moveset the creature would have if it had learned every move and always forgotten the oldest. A level-30 Cindrakar spawns with Flame Wheel, Focus, Inferno Claw, Fire Blast, not Scratch. Quest-gated entries are skipped until the gate opens. The wild AI reads the creature's four slots, not the set.

## Learn rules (`CreatureProgressionService`)

On each level gained, for each active entry at that level whose quest gate passes and whose ability is not already known:

- free slot: learn into the first empty slot, append to `AbilitiesLearned`;
- no free slot: append to `AbilitiesOffered` as an `AbilityOffer`. Never a silent skip.

Also: the level loop passes its loaded creature through, so the creature is saved once (the old double save overwrote learned slots); quest-reward unlocks follow the same rule (the silent slot-1 overwrite is gone); a move already known through a mission unlock is never offered. `AbilityOffer { CreatureId, AbilityId, CurrentAbilityIds[4], Source, Level? }` carries the four slots as they are at offer time. `ExperienceAward`, `ItemUseResult` and `QuestClaimResult` carry `AbilitiesLearned` and `Offers`.

**Learnable** is derived, never stored: active set entries with `level <= creature level`, quest gate passed, ability not currently known. A missed or declined offer is never lost; the Storage panel offers it later.

`CreatureProgressionService.WriteAbilitySlotAsync(creature, slot, abilityId, justification)` is the only code that changes a slot (justification `LevelUp`, `QuestUnlock`, `Tone`, `Intent`) and the sole producer of the `ProgressOutcomeKind.AbilityLearned` outcome. All of this lands with slice 1.

## The learn intent

`POST /api/v1/trainers/{trainerId}/creatures/{creatureId}/abilities/learn`, body `{ abilityId, forgetAbilityId?, toneItemId? }`. `RequirePlayerTrainer` plus idempotency key, listed in `RoutePolicyManifest`. Trainer identity comes from the token. `GET .../abilities/learnable` returns `LearnableAbility[]`.

`ICreatureLearnService` (in `CR.Game.Domain.Services` so the offline router can call it):

1. The creature belongs to the caller (team or storage).
2. Without `toneItemId`: the ability must be in `learnable(creature)`. With `toneItemId`: the trainer owns the item, it teaches this ability, and resonance passes.
3. `forgetAbilityId` is required exactly when all four slots are full (`forget-required`), and must currently occupy a slot (`forget-mismatch`). The server resolves the slot.
4. Writes through `WriteAbilitySlotAsync`, then consumes a one-shot tone and records the use once (`IItemUseDomainService.RecordDeferredUseAsync`). The tone is consumed after a successful write, so a failure never eats it.
5. Result `{ learned, forgotten?, slot, toneConsumed, abilityIds[4] }`.

Errors (400 `{code}`): `ability-not-learnable`, `forget-required`, `forget-mismatch`, `tone-not-resonant`, `ability-already-known`. Allowed during an active battle; the next round's legality reads the slots live. Declining is simply not calling. The tone path replaces a seam that returns `tone-not-resonant` until slice 2.

## Tones (lands with slice 2)

A tone is a cut crystal that hums one move into a creature. `ItemEffectType.TeachAbility = 13`, params `TeachAbilityParams { abilityId, elements[], speciesKeys[], minLevel? }` (by ability **id**, because `abilities.content_key` is nullable). Flags `UsableOverworld | TargetsOwnTeam`; not usable in battle. One-shot tones are consumable and shatter; **Echoing** tones are `is_consumable = false` and return `ItemRetained`.

Families: Ember (Fire), Tide (Water, Ice), Stone (Ground), Storm (Lightning, Wind), Bloom (Flora, Radiant), Venom (Poison), Common (any). Content key `tone_<family>_<ability>` or `tone_echoing_<family>_<ability>`; display name "Family Tone: Move". Ids `a5c00000-0000-4000-8000-0000000000NN`. One icon per family, not per move.

### Resonance

`Resonates(tone, creature)` is true when the tone's `elements` and `speciesKeys` are both empty, or `creature.ElementType` is in `elements`, or `creature.ContentKey` is in `speciesKeys`; and `creature.Level >= minLevel` when set. It is a pure `ToneResonance` class in `CR.Game.Compat`, so the bag greys non-resonant targets with the rule the server enforces.

### Flow

`TeachAbilityHandler`: target owned, resonant, ability not known. Free slot: learn, consume (one-shot) or retain (echoing), one `ItemUsed`. No free slot: `Success = true`, `Offers = [offer]`, `ItemRetained = true`, `Deferred = true` (the dispatcher skips consumption, stats and the `ItemUsed` outcome; HTTP 200). The client then prompts and calls the learn intent with `toneItemId`, which consumes and counts once. Declining records nothing. An echoing tone counts one use per completed learn.

### Seeded tones

| Family | One-shot | Echoing |
|---|---|---|
| Ember (Fire) | Fire Blast, Inferno Claw | Flame Wheel |
| Tide (Water, Ice) | Hydro Pump, Blizzard, Frost Bite (+gaterbear) | Drench |
| Stone (Ground) | Quake, Earth Spike (+cindris, crabby lines, mudcalf) | Mud Shot (+snakelet line) |
| Storm (Lightning, Wind) | Thunderbolt, Cyclone (+dragonspark line) | Thunder Fang (+wolfpup), Spark (+crabby line) |
| Bloom (Flora, Radiant) | Dawnbreak, Energy Ball | Absorb |
| Venom (Poison) | Miasma, Venom Fang (+spike) | Acid Drop |
| Common (any) | Hyper Beam (min level 30), Ember (+wolfpup) | Slash, Body Slam |

### Sources

Three existing grant paths: world pickups (`pickup_definition` rows with an Item reward, authored in cr-admin-web; placements are done later in Studio), merchant stock (Common and Echoing tones at town merchants, elemental one-shots at the merchant nearest that region, prices by tier; seeds `M21101` tones, `M21102` stock, `M21103` pickup definitions), and quest rewards (`RewardType.Item` naming a tone key).

## Where the code lives

`Game/CR.Game.Domain.Services/Implementation/Creature/` (`CreatureProgressionService`, `CreatureGenerationService`, `CreatureLearnService`), `Game/CR.Game.Service.BFF/Endpoints/CreatureLearnEndpoints.cs`, `Game/CR.Game.Compat` (`ToneResonance`), `Items/CR.Items.Domain.Services` (`TeachAbilityHandler`), Creatures migrations `M21001` to `M21005`, Items migrations `M21101` to `M21103`. Related: [Item Effects](?page=backend/19-item-effects), [Creature Generation](?page=backend/04-creature-generation).
