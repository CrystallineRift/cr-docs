# Localization

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
