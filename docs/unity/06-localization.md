# Localization

> **Status, updated 2026-10-05.** Player-facing translation now works through CSV **language packs**
> (below). The older per-domain YAML tables further down still exist but almost nothing reads them.
>
> | Part | State |
> |---|---|
> | Language packs (CSV) in `StreamingAssets/Localization` and `persistentDataPath/Localization` | **Works** |
> | Settings → Player Menu → System → Game → **Language** dropdown, saved as the display language | **Works** |
> | Dialogue lines and choice options | **Translatable** (keys `dlg.{dialogueKey}.{nodeId}[.{optionId}]`) |
> | NPC display names | **Translatable** (refresh on the next area load) |
> | UI text (Phase 1 screens, see [UI text](#ui-text)) | **Translatable** |
> | Item, creature, ability and status names, quest text, other UI chrome | **Not translatable yet.** The YAML tables exist (English only) but nothing reads them. |
> | `TryGetText(key, out text)` (no language) | An **English** lookup. Pass a language to `TryGetText(language, key, out text)` for anything else. |
> | `quests.yaml` | **Removed (2026-09-21).** Quest text is authored on the `QuestDefinition`. |
>
> A translation that is missing, empty, or whose language pack is gone falls back to the authored
> (English) text. Stale translations (the English changed after the pack was written) still show.

## Language Packs

A pack is one UTF-8 CSV file. The file name (without `.csv`) is the language code, for example
`fr.csv` or `pt-br.csv`. The code is validated: no path characters, so the file cannot reach outside
the Localization folder.

### Format

UTF-8 with or without a BOM (Excel writes one), RFC 4180, CRLF or LF. The delimiter, `,` or `;`, is
auto-detected from the first non-blank record, because Excel in EU locales saves `;`. A header row is
required. Columns are matched **by header name**, case-insensitively, in any order.

| Column | Meaning | Required |
|---|---|---|
| `key` | Localization key, for example `dlg.merchant-meadow.offer.accept`. Lookup is case-insensitive. | yes |
| `translation` | The translated text. Empty means not translated and the row is ignored. | yes |
| `source` | English text at export or update time. For the translator; the game never reads it. | no |
| `source_hash` | First 8 hex chars of SHA-256 of the normalized source (trimmed, LF, NFC). Drives stale detection. | no |
| `context` | Who speaks and where, for example `Meadow Merchant · Line · speaker: Kael`. | no |
| `status` | Written by Update Pack: `ok`, `stale`, `new`, `orphaned`. The game ignores it. | no |

Unknown columns are ignored, so translators can add a notes column. At most 64 columns are read; any
extra are dropped.

**Metadata rows** are ordinary rows with reserved keys, so they survive a spreadsheet round-trip:
`_meta.language_name` (the label in Settings, defaults to the code) and `_meta.author` (optional,
shown after the name as "Name — Author"). The value goes in `translation`.

```csv
key,source,translation,source_hash,context,status
_meta.language_name,,Français,,,
_meta.author,,Camille,,,
dlg.merchant-meadow.progress-first-battle,"The tall grass is where they hide. Win one battle and you'll feel the difference.","Les hautes herbes, c'est là qu'ils se cachent. Gagne un combat et tu sentiras la différence.",3fa91c02,Meadow Merchant · Line,ok
npc_demo_merchant_area_1_display,Meadow Merchant,Marchand du Pré,9b1e44d7,NPC display name,ok
```

Keep placeholders such as `{player}` in the translation. Brace substitution runs after the
translation is chosen.

### Limits

Packs are untrusted input and never crash or block the game. Bad rows are skipped and logged as one
warning per file (counts plus the first five reasons).

- File size at most 5 MB (an oversized file is refused whole), 50,000 rows, 2,000 characters per field.
- A duplicate key keeps its last row. A row with an empty key or empty translation is skipped silently.
- An empty file (0 bytes, which also covers named pipes) is skipped with a warning.
- Up to 64 columns; extra columns are dropped.

### Where packs live

| Folder | Path |
|---|---|
| Official | The build's `StreamingAssets/Localization` folder, for example `<install>/<name>_Data/StreamingAssets/Localization/` on Linux and Windows players, or `Crystalline Rift.app/Contents/Resources/Data/StreamingAssets/Localization/` on macOS |
| User, macOS | `~/Library/Application Support/CR/Crystalline Rift/Localization/` |
| User, Steam Deck / Linux | `~/.config/unity3d/CR/Crystalline Rift/Localization/` |

The user folder is created if missing. The in-game **Open folder** button in Settings opens it, which is the
easiest way to find it (on Steam Deck, in desktop mode). If the same language code exists in both
folders, the user pack wins **per key**.

### Loading

Packs load once, on the first localization read (inside `LocalizationRepository`): official folder
first, then user. There is no hot reload, so **restart the game after adding or editing a pack**.

### Choosing the language

Settings → Player Menu → System → Game has a **Language** dropdown: English first, then installed
packs by name ("Name — Author"), an **Open folder** button and a hint. The choice is saved. A saved
language whose pack is gone shows English and keeps the saved setting, so the pack works again when it
comes back. If two packs would show the same label, each gets " (code)" appended. A pack with no
usable rows is skipped with a "no translations found" warning in the log (check the delimiter and the
`translation` column).

Dialogue lines, choice options and NPC display names follow the setting. NPC names refresh on the next
area load.

### Modder how-to

1. In the Editor run **CR → Localization → Export Translation Template…** (or the `cr_loc_export`
   command) and share the file. It lists every translatable string with an empty `translation`.
2. Fill the `translation` column; set `_meta.language_name` and optionally `_meta.author`.
3. Save as **CSV UTF-8** (Excel: "CSV UTF-8 (Comma delimited)"), named `<code>.csv`.
4. Drop it in the user Localization folder.
5. Restart the game and pick the language in Settings.

### Updating a pack

When the game's text changes, run **CR → Localization → Update Pack…** and choose the existing pack.
It rewrites the file in place, keeping the previous one as a `.bak` next to it (overwritten each run),
and sets each row's `status`:

| Status | Meaning |
|---|---|
| `ok` | Source hash matches; the translation is current. |
| `stale` | The English changed. The old translation is kept, source and hash are refreshed. Re-check it. |
| `new` | A string with no translation yet. |
| `orphaned` | The pack has the key but the game no longer does. Kept at the bottom, never dropped. |

The summary lists counts per status plus placeholder problems (a `{token}` missing from or added in
the translation), dialogues skipped, NPC names that could not be read, and rows not carried over.
Parked dialogues (`Content/Defs/_Parked`) are excluded from export and update.

Both commands also run headless as `cr_loc_export` and `cr_loc_update` (`CrLocalizationCommands`),
with the file path in `--args`.

### In the Dialogue Editor

Findings appear as Warnings (there is no Info severity) with codes `loc.summary`, `loc.node` and
`loc.placeholder`, recomputed when the editor opens and on **Refresh Pick Lists**. See
[Dialogue Authoring](?page=unity/32-dialogue-authoring).

### Code map

- `Assets/CR/Localization/Logic/` (no-engine assembly `CR.Localization.Logic`): `CsvReader`, `CsvWriter`,
  `LocalizationPackParser`, `LocalizationSourceHash`, `LocalizationLanguageCode`, `LocalizationPackMerge`,
  `LocalizationLanguageOptions`, `LocalizationStringSource`, `LocalizationPackUpdate`,
  `LocalizationPlaceholderCheck`, `LocalizationPackCsv`.
- `Assets/CR/Localization/Runtime/`: `LocalizationTable`, `LocalizationPackLoader`, `LocalizationPackFolders`,
  `ILanguageSetting`, `LanguageSetting`.
- `Assets/CR/Localization/Editor/`: `LocalizationEditorSources`, `LocalizationMenu`.
- `Assets/CR/Dialogue/Editing/`: `DialogueLocalizationLines`, `DialogueLocalizationFacts`, `DialogueLocalizationDiagnostics`.

### Known gaps

- **Item, creature, ability and status names** (and quest text) are not translatable yet; they have no pack reader.
- **No rename tracking.** Renaming a dialogue content key or node id changes the derived key; the old rows show as `orphaned` and the new ones as `new`.
- **RTL and CJK fonts** are not handled; the game's fonts and layout are Latin-script left-to-right.
- **No hot reload**, pack browser or Steam Workshop distribution.

## UI text

Screen text (labels, buttons, tooltips, dropdown choices, error messages) is translatable through the
same language packs. **Phase 1** covers the core, the adapters, export, the checks and the first
screens; the rest of the screens follow in Phase 2.

### Keys

UXML text is keyed automatically: `ui.<uxml asset>.<element name>[.label|.tooltip]`, all lowercase.

- Nested template elements are keyed by the template file they live in.
- `text` binds only on `TextElement` types (Label, Button and so on). `.label` binds only on `BaseField`
  types (Toggle, TextField, Slider, DropdownField and so on). `.tooltip` binds the tooltip.
- Add the class `loc-skip` to exclude an element and its whole subtree.
- Elements named `unity-*` are Unity internals and are skipped.
- An element with no name cannot be keyed. Export and the checks report it, so name every text element.

Text set by code lives in a `[LocCatalogue]` class (below), with keys like `ui.menu.*`.

### Core types

`Assets/CR/Localization/Logic` (no engine):

- `LocString(key, english)`: a key plus its authored English. The key is lowercased; DEBUG and Editor builds validate it.
- `LocFormatString(key, english, params placeholders)`: the same with named placeholders. In the Editor a mismatch between the English and the declared placeholders throws.
- `LocFormat`: `{name}` substitution, invariant culture. An unknown placeholder is left as written.
- `ILocalizer`, `EnglishLocalizer`, and the static `Loc` (`Get`, `Format`, `Changed`, `Install`, `Reset`). `Loc` is English until a localizer is installed. `Install` raises `Changed` once; `Reset` is silent.
- `[LocCatalogue]` marks a class whose `LocString` fields are exported. `UiTextKey` and `UiTextProperty` build and name the UXML keys.

Runtime (`Assets/CR/Localization/Runtime`):

- `Localizer` resolves current language, then `en`, then the authored English. It caches the language and warms the repository on the main thread.
- `LocalizerInstallation` installs the localizer into `Loc` for the lifetime of the Core SceneContext, and resets only if it is still the current one.
- `UxmlTextAdapter` backs `uiDocument.Localize()`. `LocalizedElementRegistry` re-applies text live.

### Catalogues

| Catalogue | Keys | Where |
|---|---|---|
| `MenuText` | `ui.menu.*` | `Assets/CR/UI/Text` |
| `SettingsText` | `ui.settings.*` | `Assets/CR/UI/Text` |
| `DialogText` | `ui.dialog.*` | `Assets/CR/UI/Text` |
| `ErrorText` | `ui.error.*` | `CR.Core.Data.Logic` (`Assets/CR/Core/Data/Logic/Text`) |

`PlayerErrorText` and `ServerErrorMessage` keep their API. Server message bodies pass through
untranslated. `ServerErrorMessage.From`, the wording for authors and logs, stays English.

### Authoring a screen

1. Name every text element in the UXML.
2. Put strings set by code in a `[LocCatalogue]` class.
3. Call `uiDocument.Localize()` once, where the tree exists. For screens that re-clone on `SetActive`, call it inside `Bind()`.
4. Use the `VisualElement` extensions for code-set text: `Localize`, `LocalizeFormat`, `LocalizeLabel`, `LocalizeTooltip`, `LocalizeChoices` (keeps the selected index) and `OnLanguageChanged` (idempotent per element).
5. Add the screen to `LocalizationUxmlScope.Enforced`.
6. Run **CR → Localization → Check UI Strings**.

### Live switching

Changing the language in Settings re-applies text at once, no restart. An element that detaches goes
dormant and re-applies when it attaches again. **Code wins**: if code changed an element's text after
the localizer set it, the registry leaves that text alone, so code-set text must go through
`LocalizeFormat` or `OnLanguageChanged` to follow the language.

Dialogue and pack loading are unchanged: packs still load once, so adding a pack still needs a restart.

### Export

One **Export Translation Template** now includes dialogue, NPC names, UXML and catalogue rows. The
summary reports unnamed UI elements, catalogue errors and unreadable UXML. Editor and admin UXML are
excluded (`Editor/` folders plus the `LocalizationUxmlScope.Excluded` list).

### Checks

- An EditMode project test runs over `LocalizationUxmlScope.Enforced`. Phase 1 list: **MainMenu, PlayerMenuWindow, SignedOutDialog**.
- **CR → Localization → Check UI Strings** is report-only and covers every player screen.

### Phase status

| Phase | Scope |
|---|---|
| 1 (done) | Core, adapters, export, checks, Main Menu, Player Menu and Settings, MessageDialog, SignedOutDialog, error texts |
| 2 (per screen) | Market, Bag, Team, Storage, Battle HUD and summary, Quest journal, tracker and achievements, Character select and create, Link Email, dialogue screen chrome, world map, area banner, evolution, level-up toast, the remaining `*Text` classes, toasts (`NoticeText`) |
| 3 | Content names, server error codes, fonts (CJK and RTL), a text-length layout pass |

### Known limits

- Fonts are Latin only; CJK and RTL text will not render correctly yet.
- A dropdown whose translated choices are duplicates may shift the selected index on a language change.
- Server message bodies are not translated.
- Screens outside the Phase 1 list stay English until their Phase 2 pass.

## Dialogue keys

A dialogue document keeps its source-language text, and a translation is looked up by a key DERIVED
from where the line lives: `dlg.{dialogueContentKey}.{nodeId}` for a line,
`dlg.{dialogueContentKey}.{nodeId}.{optionId}` for a choice option
(`CR.Dialogue.Runtime.DialogueTextSource.Key`, `LocalizedDialogueTextResolver`). No translation falls
back to the authored text. Node and option ids survive rewording, so nobody maintains a key list by
hand.

## Legacy YAML tables

> The rest of this page describes the older per-domain YAML loader. It works as described, but the
> tables are English only, `display_language` in `game_config.yaml` does not exist (the language is
> the saved Settings choice), and only `NpcDisplayNameResolver` reads them.


All user-facing strings in CR — quest names, objective text, ability names, creature descriptions, item tooltips, status effect names — live in YAML files loaded at runtime by `LocalizationRepository`. The database `name`/`description` columns are retained as canonical fallbacks for server-side tooling, but the client always renders from localization files.

## Why This Approach?

### Why YAML files instead of a database table?

Localization files are static design-time content, not runtime state. Keeping them as YAML files in source control means:
- Translators work in plain text files with no database access required
- Diffs are readable in pull requests
- Language files can be shipped as separate asset bundles in future without schema changes

### Why per-domain, per-language files?

A single `localization.yaml` with all languages embedded per key scales poorly. With separate files (`quests.yaml`, `quests.fr.yaml`), a translator for French only touches `*.fr.yaml` files and never sees English strings or other domains. Merging translation branches is clean.

### Why a singleton `LocalizationRepository` instead of ScriptableObjects?

`LocalizationRepository` is shared between the Unity client (`CR.Core`) and the backend (`CR.Game.Localization` shared library). A Unity ScriptableObject would not be usable from the .NET backend. The plain C# singleton works in both runtimes.

The singleton is initialized via a static constructor, which means it is created the first time `LocalizationRepository.Instance` is accessed. There is no explicit initialization call — access the property and the YAML files are loaded automatically.

### Why `Resources.LoadAll` Instead of Addressables?

`Resources.LoadAll<TextAsset>("configuration/localization")` loads all YAML files in the folder in one call, with no manifest to maintain. Addressables would require updating a catalog every time a language file is added. The trade-off is that all localization files are always loaded, even languages the player is not using — acceptable for now given the small file sizes.

## How `LocalizationRepository` Works Internally

From `Assets/CR/Core/Data/Repository/Implementation/GameCore/LocalizationRepository.cs`:

```csharp
private LocalizationRepository()
{
    var assets = Resources.LoadAll<TextAsset>("configuration/localization");
    // ... load and parse each YAML file
}

private void LoadFromFiles(IEnumerable<(string name, string content)> files)
{
    var deserializer = new DeserializerBuilder()
        .WithNamingConvention(UnderscoredNamingConvention.Instance)
        .Build();

    foreach (var (name, content) in files)
    {
        // Asset name "quests" → language "en"
        // Asset name "quests.fr" → language "fr"
        var parts = name.Split('.');
        var language = parts.Length >= 2 ? parts[parts.Length - 1] : "en";

        var entries = deserializer.Deserialize<Dictionary<string, string>>(content);
        foreach (var (key, value) in entries)
        {
            var normalizedKey = key.ToLower();
            if (!LocalizedTextElements.TryGetValue(normalizedKey, out var localizedText))
            {
                localizedText = new LocalizedText();
                LocalizedTextElements[normalizedKey] = localizedText;
            }
            localizedText.Mappings[language] = value;
        }
    }
}
```

Key behaviors:
- Keys are normalized to lowercase at load time — `Quest_Talk_To_Elder_Name` and `quest_talk_to_elder_name` resolve to the same entry
- Language is determined by the asset name suffix — no language code in the suffix means English (`en`)
- All YAML files are merged into a single `Dictionary<string, LocalizedText>` — the `LocalizedText` value holds a per-language mapping
- Only keys that differ from English need to appear in a language file; missing keys fall back to the English mapping

## File Structure

```
Assets/CR/Resources/
  configuration/
    game_config.yaml
    localization/
      quests.yaml          ← English (default)
      quests.fr.yaml       ← French overrides
      quests.de.yaml       ← German overrides
      abilities.yaml
      creatures.yaml
      items.yaml
      statuses.yaml
```

Each file is a flat YAML map of `key: text`. No nesting.

**`quests.yaml`** (English / default):
```yaml
# Quest display strings — default language (English)
# Naming: quest_{content_key}_{field}

quest_talk_to_elder_name: Talk to the Elder
quest_talk_to_elder_description: Find and speak with the village elder to begin your adventure.
quest_talk_to_elder_objective_1: Talk to the Elder

quest_welcome_to_cr_name: Welcome to CR
quest_welcome_to_cr_description: Speak with the village elder to begin your journey and receive your first companion.
quest_welcome_to_cr_objective_1: Speak with the village elder
```

Only keys that differ from the default need to appear in a language file:

**`quests.fr.yaml`** (French overrides):
```yaml
quest_talk_to_elder_name: Parler à l'Ancien
quest_talk_to_elder_description: Trouvez et parlez à l'ancien du village pour commencer votre aventure.
quest_talk_to_elder_objective_1: Parler à l'Ancien
```

## Key Naming Convention

All keys are lowercase snake_case. The pattern is:

```
{domain}_{content_key}_{field}
```

| Component | Meaning |
|---|---|
| `domain` | `quest`, `ability`, `creature`, `item`, `status`, `npc` |
| `content_key` | The `content_key` value from the domain's database table — globally unique |
| `field` | `name`, `description`, `objective_1`, `objective_2`, … |

Examples:

| Key | Domain | Field |
|---|---|---|
| `quest_talk_to_elder_name` | quest | name |
| `quest_talk_to_elder_objective_1` | quest | first objective |
| `ability_tackle_description` | ability | flavour text |
| `creature_starter_1_name` | creature | display name |
| `item_potion_description` | item | bag screen tooltip |
| `status_burn_name` | status effect | displayed condition name |

Rules:
- All lowercase, underscores only — no hyphens (YamlDotNet's `UnderscoredNamingConvention` does not handle hyphens)
- Numeric suffix (`_1`, `_2`, …) follows `sort_order` from the database for ordered fields like objectives
- `content_key` is set by the designer in the database seed and in `game_config.yaml` — it is the contract between the two

### NPC-specific keys

NPCs use their `content_key` directly:

```yaml
# In a new npcs.yaml file
npc_cindris_guide_name: Cindris Guide
npc_cindris_guide_greeting: Welcome, trainer! Your journey begins here.
npc_kael_trainer_name: Trainer Kael
npc_kael_trainer_greeting: Ready to see what your creatures are made of?
```

The file `npcs.yaml` is not yet in the codebase — create it alongside the existing domain files. Unity picks it up automatically on next Play.

## Reading Text at Runtime

```csharp
// Uses GameConfiguration.DisplayLanguage automatically
if (LocalizationRepository.Instance.TryGetText("quest_welcome_to_cr_name", out var name))
{
    questNameLabel.text = name;
}
else
{
    _logger.Warn("[QuestUI] Localization key not found: quest_welcome_to_cr_name");
    questNameLabel.text = "???"; // fallback
}

// Explicit language override
LocalizationRepository.Instance.TryGetText("fr", "quest_welcome_to_cr_name", out var nameFr);
```

`TryGetText` returns `false` if:
- The key does not exist in any loaded file
- The requested language has no mapping for the key AND no English fallback exists

Always check the return value before using `out` text in UI code. A missing key should show a visible placeholder (not an empty string) so it is easy to identify untranslated content during QA.

The active language is stored in `GameConfiguration.Instance.DisplayLanguage` (read from `game_config.yaml` using the `display_language` key). Change that value to switch the language for the entire session.

## How `LocalizationRepository` Is Accessed from MonoBehaviours

`LocalizationRepository` is a plain C# singleton — not a Zenject binding. Access it directly:

```csharp
public class QuestUIPanel : MonoBehaviour
{
    [SerializeField] private string _questContentKey;
    [SerializeField] private TMP_Text _nameLabel;
    [SerializeField] private TMP_Text _descriptionLabel;

    private void OnEnable()
    {
        var repo = LocalizationRepository.Instance;

        if (repo.TryGetText($"quest_{_questContentKey}_name", out var name))
            _nameLabel.text = name;

        if (repo.TryGetText($"quest_{_questContentKey}_description", out var desc))
            _descriptionLabel.text = desc;
    }
}
```

Do not inject `LocalizationRepository` via Zenject — it is not bound in `LocalDevGameInstaller`. The singleton pattern means it is always available without DI.

The repository is loaded lazily on first access. If the `Resources/configuration/localization/` folder is empty or missing, `LocalizationRepository` logs a warning and every `TryGetText` call returns `false`. This should be treated as a setup error — the folder and at least the English base files must exist.

## Fallback Behavior

When `TryGetText(language, key, out text)` is called, `LocalizedText.TryGetInLanguage` is invoked. The fallback chain:

1. Try the requested language mapping
2. If not found, try the English (`en`) mapping
3. If not found, return `false`

This means:
- A key present only in English returns the English value for all languages
- A key missing from both the language file and the English file returns `false`
- There is no chain beyond English — if a German translation is missing, it falls back to English, not to French

If `TryGetText` returns `false`, your code should display a visible placeholder (e.g., `"[key_not_found]"` or the raw key name) rather than an empty string, so untranslated strings are immediately visible during QA.

## Adding a New Localized String

This is the most common localization task.

### Step 1 — Choose the key

Follow the `{domain}_{content_key}_{field}` convention. For a new creature named "Pyroclaw":

```
creature_pyroclaw_name
creature_pyroclaw_description
```

The `content_key` part (`pyroclaw`) must match the `content_key` column in the backend `creature_base` table seed data.

### Step 2 — Add to the English base file

Open `Assets/CR/Resources/configuration/localization/creatures.yaml` and add:

```yaml
creature_pyroclaw_name: Pyroclaw
creature_pyroclaw_description: A fierce fire-type creature found near volcanic vents.
```

### Step 3 — Add translations (if available)

For each language file that should translate this string:

```yaml
# creatures.fr.yaml
creature_pyroclaw_name: Griffépyro
creature_pyroclaw_description: Une créature de feu féroce trouvée près des évents volcaniques.
```

Keys not added to the language file fall back to English automatically.

### Step 4 — Access in code

```csharp
if (LocalizationRepository.Instance.TryGetText("creature_pyroclaw_name", out var name))
    creatureNameLabel.text = name;
```

No code changes are needed if the key follows the convention — just add to the YAML and access by key.

## Adding a New Language

### Step 1 — Create override files

For each domain file that has strings to translate, create a `{domain}.{langcode}.yaml` file in `Resources/configuration/localization/`:

```
abilities.es.yaml
creatures.es.yaml
quests.es.yaml
items.es.yaml
statuses.es.yaml
```

### Step 2 — Add translated strings

Only include keys that differ from English. Keys not present fall back to English.

```yaml
# quests.es.yaml
quest_talk_to_elder_name: Hablar con el Anciano
quest_talk_to_elder_description: Encuentra y habla con el anciano del pueblo para comenzar tu aventura.
quest_talk_to_elder_objective_1: Hablar con el Anciano
```

### Step 3 — Set the language in `game_config.yaml`

```yaml
display_language: es
```

### Step 4 — Test in Unity

Hit Play. `LocalizationRepository` loads all files on first access. Spanish strings should appear in any UI that calls `TryGetText`. Keys missing from the Spanish files display in English.

No code changes are required anywhere in the codebase to add a new language — the YAML file suffix is the only configuration needed.

## Adding a New Localization Domain

To add strings for a new domain (e.g., `guilds`):

1. Create `Assets/CR/Resources/configuration/localization/guilds.yaml`
2. Follow the `{domain}_{content_key}_{field}` key convention:
   ```yaml
   # guilds.yaml
   guild_silver_dawn_name: Silver Dawn Guild
   guild_silver_dawn_description: A prestigious guild known for strategic battles.
   ```
3. Unity picks it up automatically on next Play — no code changes, no manifest to update.
4. For translations, create `guilds.{langcode}.yaml` alongside.

## Shared Backend Library

The same `LocalizationRepository` logic lives in `cr-api`. The backend version loads from a file-system directory instead of Unity `Resources`:

```csharp
var repo = new LocalizationRepository("/path/to/localization/directory");
repo.TryGetText("en", "quest_talk_to_elder_name", out var text);
```

This enables REST endpoints to accept a `?lang=en` query parameter and return localised strings server-side if needed. The file format and key conventions are identical between Unity and the backend.

### Server-side usage example

```csharp
var repo = new LocalizationRepository(localizationDirectory);
var lang = request.Headers["Accept-Language"].FirstOrDefault() ?? "en";
repo.TryGetText(lang, $"quest_{questTemplate.ContentKey}_name", out var localizedName);
```

## Common Mistakes

- **Key not found.** Check the key is lowercase snake_case and exactly matches a key in the YAML file. `TryGetText` normalizes both the lookup key and language to lowercase before searching, but typos in the YAML itself (e.g., a capital letter) produce a different normalized key at load time and will not match the lowercase lookup.
- **Language file not loaded.** Confirm the file is inside `Resources/configuration/localization/`. Files anywhere else are not picked up by `Resources.LoadAll`. Check the filename — Unity strips the `.yaml` extension to produce the asset name.
- **Hyphen in key.** YamlDotNet's `UnderscoredNamingConvention` does not handle hyphens. Use underscores only in all localization keys.
- **Missing fallback.** If a language file omits a key and the English file also omits it, `TryGetText` returns `false`. Add the key to the English base file first — the language file only needs the translated value.
- **Accessing `LocalizationRepository.Instance` before `Resources` is ready.** If you access the singleton in a static initializer or before Unity's runtime is fully started (e.g., from a test without a Unity context), `Resources.LoadAll` returns an empty array and the singleton initializes with no entries. This can appear as "key not found" errors in test environments.
- **Key collision between domains.** If two domains both define a key with the same name (e.g., both `creatures.yaml` and `items.yaml` define `generic_description`), the last file loaded wins. Use the `{domain}_` prefix consistently to prevent collisions.
- **Displaying raw key on missing translation.** If `TryGetText` returns false and your code sets the label to an empty string instead of a placeholder, missing keys are invisible during QA. Always show a visible fallback string such as the raw key or `"[missing]"`.
- **Setting `display_language` to an unsupported code.** If `display_language: xx` is set in `game_config.yaml` but no `*.xx.yaml` files exist, all `TryGetText(key)` calls fall back to English silently. This is correct behavior but can be confusing — verify the language code matches the file suffix exactly.

## Related Pages

- [Unity Project Setup](?page=unity/01-project-setup) — `game_config.yaml` and the `display_language` config key
- [Quest System](?page=backend/07-quest-system) — `content_key` values used in quest localization keys
- [NPC Interaction](?page=unity/04-npc-interaction) — NPC dialogue strings and `content_key` conventions
- [Dependency Injection](?page=unity/02-dependency-injection) — `LocalizationRepository` is a plain C# singleton, not a Zenject binding
