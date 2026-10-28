# Side Content Packets

Data-driven side content. A designer writes one JSON **packet**; `cr_side_author` turns it into quests, NPCs, trainers, readables and world
locations, idempotently. No C# per quest.

**Server authority.** A packet never reports an outcome. Quests it makes are ordinary quest rows; the authority (the server online, the local cr-api
domain services offline) advances objectives and pays rewards. The tool only writes content definitions and registry keys.

Related: [Dungeon Scaffold](?page=unity/47-dungeon-scaffold), [Dialogue Authoring](?page=unity/32-dialogue-authoring), [Content Pipeline](?page=unity/17-content-pipeline), [Open World](?page=unity/37-open-world), [World Navigability](?page=unity/49-world-navigability) (zones, pickups and readables a packet places must stand on reachable ground; `cr_nav_snap_rows`).

## Where things live

| Path (under `Assets/CR/`) | What |
|---|---|
| `Game/Story/Content/Side/<packet>.json` | The packets. `packet` field must equal the file name. README beside them is the short form of this page. |
| `Game/Story/Logic/SideContent/` | Engine-free: `SidePacketParser`, `SidePacketLint`, `SideKeyFormats`, `SideSpeciesWindows`, `SideLedger`, `SideRegistryMerge`, `SideStagingMerge`, `SideDialogueLinks`. |
| `Game/Story/Editor/SideContent/` | Materialisers: `SideQuestAssets`, `SideNpcAssets`, `SideTrainerAssets`, `SideDialogueAssets`, `SideLocationAssets`, `SideProviderRegistration`, and the commands (`SideContentCommands`). |
| `Game/Story/Content/Side/side-ledger.json` | Keys each packet authored. |

## Commands

| Command | Does |
|---|---|
| `cr_side_lint --args <packet>\|all` | Lint only. Errors and warnings; writes nothing. |
| `cr_side_author --args <packet>\|all [dry]` | Lint, then (only with no errors) materialise. `dry` = lint only. |

Headless, no `unity cmd`:

```
Unity -batchmode -quit -projectPath <lane> -executeMethod CR.Game.Story.Editor.SideContent.SideContentCommands.AuthorFromCommandLine -sideArgs "<packet>|all"
```

`LintFromCommandLine` likewise. Exit code 1 when a packet has errors.

## Packet schema

```json
{
  "packet": "a1-example",
  "quests": [{
    "key": "quest-meadow-lost-charm", "name": "The Lost Charm", "description": "...", "giverNpc": "npc-meadow-wren",
    "objectives": [{ "type": "VisitLocation", "target": "story-meadow-pond", "count": 1, "optional": false, "sortOrder": 0, "description": "..." }],
    "rewards": [{ "type": "Experience", "qty": 60 }, { "type": "Item", "ref": "item_heal_potion_30", "qty": 2 }],
    "requirements": [{ "type": "StoryBeat", "stat": "road-open" }, { "type": "QuestCompleted", "ref": "quest-other" }],
    "grantMode": "OfferedByGiver", "claimMode": "ReturnToGiver", "category": "Bonus", "areaKey": "6",
    "questLine": "line-side-meadow", "lineStep": 1, "isRepeatable": false, "grantsBeats": [], "region": "6a"
  }],
  "npcs": [{ "key": "npc-meadow-wren", "name": "Wren", "type": "QuestGiver", "regionKey": "6a",
             "itemSpawnerKey": "", "giftCreature": "", "dialogue": "dialogue-meadow-wren" }],
  "trainers": [{ "key": "trainer-meadow-scout", "npcKey": "npc-meadow-scout", "displayName": "Scout", "arenaKey": "meadow-arena",
                 "team": [{ "species": "creature_cindris", "level": 5, "progressionSet": "", "growthProfile": "Balanced Growth" }],
                 "items": [{ "item": "item_heal_potion_30", "quantity": 1 }],
                 "loot": [{ "rewardType": "Currency", "min": 20, "max": 30, "dropChance": 1.0 }],
                 "allowRematch": true, "lossAllowed": false, "barkDialogue": "dialogue-meadow-scout" }],
  "readables": [{ "key": "readable-6a-meadow-sign", "title": "Old sign", "text": "First paragraph.\n\nSecond paragraph.", "region": "6a" }],
  "locations": [{ "key": "story-meadow-pond", "displayName": "Meadow Pond", "region": "6a" }]
}
```

Unknown members are errors.

| Section | Field notes |
|---|---|
| quest `objectives[].type`, `rewards[].type`, `requirements[].type` | Enum member names: `QuestObjectiveType`, `QuestRewardType`, `QuestRequirementType`. Requirement operators: `>=`, `<=`, `==`. |
| quest `grantMode` / `claimMode` / `category` | Quest enum member names. Side quests: `OfferedByGiver` + `ReturnToGiver`, `grantsBeats` empty. |
| quest `region` | Registry region (leaf like `6a` rolls up to `6`); `areaKey` is the area key. |
| npc `type` | `NpcType` member (`QuestGiver`, `Trainer`, `Healer`, ...). `dialogue` = hand-written file key. |
| trainer | A **definition** (`trainer-*`). Its placement NPC (`npc-*`, type `Trainer`, named by `npcKey`) is what quests target and what the region overlay places. `growthProfile` and `progressionSet` are existing content names. |
| readable `text` | One narrated line per paragraph (blank line separated). |
| location | `story-<slug>`; becomes a World Location Catalog row. |

## Lint rules

Errors unless marked.

| Area | Rule |
|---|---|
| Keys | `quest-<slug>`, `npc-<slug>`, `trainer-<slug>`, `readable-<region>-<slug>` (region = the readable's own, e.g. `6a`), `story-<slug>` (locations), `dialogue-<slug>`. Unique in the packet, across packets, and against provider, registry, staging and catalog (the packet's own earlier output excluded via the ledger). |
| Objectives | Type valid and not dead (`DealDamage`, `DealDamageOfType`, `ReachCreatureLevel`, `HealAmount` are refused). Count >= 1. Targets exist (species, location, readable, NPC, item, quest). Trainer objectives target `Trainer` NPCs. `DefeatCreaturesFromList` / `DefeatTrainersFromList` count <= distinct targets. `CollectItem` on a common shop item is a **warning** (counts held items on accept). |
| Rewards | Badge and Title refused (not implemented). Item and creature refs must exist (items read from the committed floor item table). |
| Requirements | `QuestCompleted` / `QuestNotStarted` quests resolve (packet or registered, no cycles). `StoryBeat` only registry beats. |
| Side quests | `grantsBeats` empty. An offered / return-to-giver quest needs a giver that exists. |
| Trainers | Arena key in the registry. 1 to 6 team slots. Species exist. Level inside its stage window (same table as [World content lint](?page=unity/37-open-world#world-content-lint)). Items and loot exist. |
| Dialogues | File exists for each NPC `dialogue`. Giver dialogue runs `quest.accept` / `quest.claim`. A dialogue naming an unknown quest is refused. A talk objective on an NPC whose dialogue never runs `quest.recordTalk` is a **warning**. |

## What author writes

| Output | Path |
|---|---|
| Quests | `Content/Defs/Quests/<quest>.asset`. New quests get a fresh id and next sortOrder. Registered in `ContentDefinitionProvider` in dependency order (prerequisite listed first). |
| NPCs | `Content/Defs/NPCs/<npc>.asset` |
| Dialogues | `Content/Defs/Dialogues/<key>.asset`, from the staging JSON. An existing asset keeps its editor layout. |
| Trainers | `OpenWorld/Data/Trainers/<trainer>.json`, then the existing `cr_author_trainer` builder (`Content/Defs/Trainers/<trainer>.asset`). |
| Readables | `Content/Text/<readable>.json` and its dialogue asset. |
| World locations | Rows in the World Location Catalog. An existing row keeps its id and XP tuning. |
| Text staging | `quests.json` (name, description, objective texts) and `names.json` (`npcs` display names). Quest text is set from the packet, so `cr_quests_import_staging` finds nothing to do. |
| Registry | `story-registry.json`: every key under its parent region (`6a` to `6`; healers under `healers`; quests under `region`, else the giver's region, else `side`). |
| Side ledger | `Side/side-ledger.json`. |

**Idempotent.** A second run changes nothing. The **side ledger** records which keys each packet authored so a re-run does not collide with itself.
Keys dropped from a packet are reported, never deleted.

## Dialogue is hand-written

NPC dialogues are NOT generated. Write `Content/Text/dialogue-<npc>.json` by hand ([Dialogue Authoring](?page=unity/32-dialogue-authoring)). A quest giver
needs four branches:

| Branch | Runs |
|---|---|
| Offer (quest not started) | `quest.accept` on the player's choice |
| In progress | Reminder text; `quest.recordTalk` when a talk objective targets this NPC |
| Turn-in (objectives done) | `quest.claim` |
| Done | Closing line |

The tool checks the file exists, a giver's dialogue runs `quest.accept` / `quest.claim` for its quests, every quest a dialogue names exists, then
runs the repo's dialogue content audit (`DialogueAudit`; findings narrowed to the packet are printed). The dialogue only sends intents; the authority
decides.

## Order and rollout

1. **Author before scaffold.** Run `cr_side_author` before `cr_dungeon_scaffold` for any dungeon whose quests/NPCs the spec names.
2. **Arena key first.** A trainer's `arenaKey` must already be in `story-registry.json` (a dungeon scaffold allocates arena keys; a hand arena is added by hand).
3. Author is local. Nothing is pushed: `cr_content_push --args all` for server content, `cr_world_locations_push` for the new `story-*` locations. The offline floor rebake is a separate step (the floor is committed at the package head; see [Content Pipeline](?page=unity/17-content-pipeline)).
