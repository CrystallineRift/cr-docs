# Lore Text (keyword styling and the dialogue typewriter)

Story text names things the player has to learn: soulstones, Summoning Shards, Seekers, krytori, the
Actuators, Mirandale. One pipeline colours those words wherever body text appears, gives the two most
magical ones a quiet motion effect where the screen can show it, and types dialogue out line by line.
It is **presentation only**: it reads a vocabulary file and two player preferences and never touches
game state, so the server-authoritative rule has nothing to decide here. The server and the offline
domain services never see any of it.

## What the player sees

| Category | Colour family | Look | Examples |
|---|---|---|---|
| **Relic** | violet | colour; first occurrence shimmers (low-amplitude wave) on animated surfaces | soulstone, Summoning Shard (and the bare word "shard") |
| **Creature** | green | colour | krytori / krytorus |
| **Person** | sky blue | colour | Seeker, Equal, Ahksun, Philroe, Izzandra, Menothas |
| **Place** | amber | colour; Astral Realm and pillar pulse slowly (fade) on animated surfaces | Mirandale, Mount Tahrok, Criederys, Astral Realm, pillar |
| **Order** | rose | colour + **bold small caps** (the one type change) | Actuator(s), Actuators' Court, Covenant, Edict of Daemamion |
| **Event** | fuchsia | colour | Pilgrimage Season, Festival of the Souls |

- **First occurrence per text block** (one dialogue node, one bark, one objective line) is styled; a
  term may opt into `"emphasis": "every"` (proper names, if a line should keep naming someone). A
  term's **effect** only ever applies to its first occurrence, whatever its emphasis.
- **Where**: dialogue body (animated), dialogue option lines (rich), area banner flavour line (animated),
  world barks, HUD quest tracker lines, journal description and objectives (light palette), the flavour
  line of the discovery toast. **Never** names or titles: speaker names, quest names, place names, option
  letters.
- **Animated surfaces** are the two labels that are Text Animator `AnimatedLabel`s (dialogue body, banner
  flavour). Everything else gets UI Toolkit rich text (`<color>`, `<b>`, `<smallcaps>`) and never moves.

### Settings (System → Game)

| Row | Values | Effect |
|---|---|---|
| **Text Effects** | Full / Static colour / Plain | Full: colour + effects. Static colour: colour only; Text Animator behaviours are switched off globally. Plain: story text exactly as written. |
| **Dialogue Text Speed** | Instant / Fast / Normal | Instant shows each line at once; Fast (default) types about 80 letters a second; Normal about 40, longer stops at punctuation. |

Both persist like Combat Speed (`GameConfigurationKeys.LoreTextMode` = `full` / `static` / `plain`;
`DialogueTextSpeed` = `instant` / `fast` / `normal`; unset reads as Full / Fast) through
`ITextDisplaySettings` / `TextDisplaySettings`, and take effect from the next line shown.

## The pipeline

```
content text ─► localization packs ─► BraceTextResolver ─► LoreText.Decorate(text, surface, palette) ─► label
```

`LoreText.Decorate(string localized, LoreSurface surface, LorePalette palette)` is a pure function over
already-localized text (`CR.Localization.Logic`, no engine references). `surface` says what the label
can render; the player's **mode** may lower it:

| Surface | Output | Used for |
|---|---|---|
| `Plain` | the input, author tags removed | Text Effects = Plain |
| `Rich` | `<color=#rrggbb>word</color>` (+ `<b><smallcaps>` for Order) | any `Label` |
| `Animated` | Rich + the term's Text Animator tag (`<crrelic>` / `<crastral>`) around the first occurrence | `AnimatedLabel` only |

Mode lowering: Full keeps the surface, Static colour turns Animated into Rich, Plain turns everything
into Plain. Screens call it just before assigning text (`Label.SetLoreText(text, palette)` in
`CR.UI.Common` picks Rich or Animated from the label type). `LoreText` is static state like `Loc`
(`Install(glossary)`, `Mode`, `Reset()`), installed by `LoreTextInstallation` (Zenject `IInitializable`);
**nothing installed means text comes back unchanged**, which is why existing tests are unaffected.

Palette by background: `LorePalette.Dark` for the dialogue panel, banner, barks, HUD tracker and toasts;
`LorePalette.Light` for the paper panels (the journal).

## The glossary

`Assets/CR/Game/Story/Content/Text/glossary.json`, next to `names.json`. One authored file;
`Assets/CR/Resources/Story/LoreGlossary.asset` (a `LoreGlossarySource`) only references it, the way
`LocationFlavour.asset` ships the flavour lines.

```json
{
  "key": "summoning-shard",
  "category": "relic",
  "forms": ["Summoning Shard", "Summoning Shards", "shard", "shards"],
  "caseSensitive": false,
  "emphasis": "first",
  "effect": "relic",
  "styleOverride": null,
  "note": "free text for authors; the game ignores it"
}
```

| Field | Meaning |
|---|---|
| `key` | lowercase words joined by `-`; what `<cr:term=…>` and the pack rows name |
| `category` | `relic` `creature` `person` `place` `order` `event` |
| `forms` | every spelling and number the word takes; the plural, the irregular (krytorus / krytori) and each spelling the story uses are listed explicitly, never stemmed |
| `caseSensitive` | true for common words ("Equal", "Seeker", "Edict"): the capitalised form is the lore term, the ordinary word stays plain |
| `emphasis` | `first` (default) or `every` |
| `effect` | optional `relic` or `astral`; only used on animated surfaces |
| `styleOverride` | optional named look replacing the category's: `plain` `bold` `italic` `smallcaps` `order` `serif` |

Rules `LoreGlossary.Validate()` enforces (and `LoreGlossaryContentTests` runs against the shipped file): key
shape and uniqueness, at least one form, no markup or `|` in a form, **no form claimed twice** (ignoring
case, spacing and apostrophe style), known `styleOverride`.

**Adding a term**: add it to `glossary.json` (choose the category, list every form), run the tests, add a
row to the AI content ledger. Nothing else: the asset references the file.

### Matching rules

- Whole words, longest form first at a position: "Summoning Shard" wins over "shard".
- The character after a match must not continue the word, so "Equal" never matches in "equally".
- A possessive keeps its apostrophe outside the colour: `soulstone's`, `Actuators'`. Either apostrophe
  (`'` or `’`) matches either; spaces inside a form match any run of white space.
- Existing `<…>` rich-text tags and `{…}` resolver tokens pass through untouched and are never matched inside.
- Decoration only ever **adds** tags: removing them gives back the input (a content test checks every
  shipped line).

### Translations

A language pack may carry a row `gloss.<key>.forms` whose value is that language's forms separated by
`|`. It **replaces** the English forms for that language (a missing or blank row keeps English). The
matcher is rebuilt after every language change (`Loc.Changed`). The Localization export includes one such
row per term (`LoreGlossaryStringSource`), so translators get them in the template.

## Authoring tags

Content may use UI Toolkit rich text and three author tags, mapped by `Decorate` and never shown:

| Tag | Effect |
|---|---|
| `<cr:em>words</cr:em>` | emphasis: bold italic in the palette's emphasis colour (white on dark, ink on light) |
| `<cr:term=soulstone>the stone</cr:term>` | style these words as that term, matched or not; counts as the first occurrence |
| `<cr:no>soulstone</cr:no>` | leave these words unstyled and do not use up the first occurrence |

Content text can **not** contain raw Text Animator tags (`<wave>`, `<shake>`, `<rainb>` …): effects come
from the glossary under the player's setting, and a raw one would ignore it and show as literal text on
a plain label. The Dialogue Editor's findings list reports one as an **error**
(`DialogueLoreTagDiagnostics`, code `lore.raw-effect-tag`) and unknown, unclosed or key-less author tags
as warnings; `LoreGlossaryContentTests` scans every shipped dialogue line, content text row and story-text
string.

## Palette and theme tokens

Rich text cannot read USS variables, so `LorePalette` repeats the theme's colours in C#. They live in
`CrTheme.uss` as `--cr-lore-<category>-on-dark` / `-on-light` (and `--cr-lore-emphasis-…`), and
`CrThemeTests.TheLoreTokensMatchTheCSharpPalette` fails when the two drift. `LorePaletteTests` holds every
colour to 4.5:1 against the surfaces it sits on. **Change a colour in both places.**

## Type: the Order look and the serif hook

Only Plus Jakarta Sans ships, so Order terms are **bold small caps** (`<b><smallcaps>`). A term's
`styleOverride: "serif"` is the hook for an engraved face later: until a font asset exists it falls back to
the category's look, so it is safe to author now. To switch it on, create a TextCore font asset from the
TTF, make the panel text settings able to resolve it, and return
`new LoreWrap("<font=\"Cinzel SDF\">", "</font>")` from `LoreStyleExtensions.SerifWrap`. Font wanted:
**Cinzel** (SIL OFL; inscriptional capitals, reads as carved law); **Cormorant SC** is the softer choice.

## Text Animator

The package is `Packages/com.febucci.text-animator-unity` (3.20.1) with its settings assets under
`Assets/Plugins/Febucci`; neither is tracked in git, so a fresh clone must restore them like the other
purchased packs (Asset Store id 341308). Notes for anyone touching it:

- The game's own effects are assets under `Assets/CR/Resources/Lore/`: `CrRelicShimmer` (tag `crrelic`, a
  position effect, amplitude 0.8, slow) and `CrAstralPulse` (tag `crastral`, a colour effect easing to
  40% opacity on a loop), collected in `LoreEffects`. Tune them in the Inspector. `UseLoreEffects()` points a
  label at the database. Tags are namespaced `cr…` so no vendor tag can collide.
- Use `AnimatedLabel.SetText` / `.Text`, never `.text`: assigning `.text` skips Text Animator's parser.
  `SetLoreText` does the right thing for both label kinds.
- Each `AnimatedLabel` runs its own 60 Hz scheduler job, so only the two body labels are animated.
- Static colour / Plain also call `TextAnimatorSettings.SetEffectsActive(false)`; `LoreTextInstallation`
  puts it back on dispose. The global switch for appearance effects is separate (`TextAnimatorSettings.asset`).

## Dialogue typewriter

The dialogue body is an `AnimatedLabel`; when Dialogue Text Speed is not Instant a line is typed by its
`Typewriter` with per-speed waits (`DialogueTextSpeedExtensions.Waits`). The press rule lives in the pure
`DialogueLineReveal` and is what keeps one press from skipping a line:

1. While a line types, a **Continue / Submit / Cancel press only completes the line** (the whole line shows).
2. The **next** press advances. The completing press also re-arms the input debounce, so a double tap
   cannot do both.
3. A **choice's options stay hidden until its prompt is complete** (Continue is the one thing to press;
   an option cannot be chosen, and Cancel cannot decline, while the prompt types). A choice with no prompt
   of its own, the usual case, shows its options at once.
4. A safety timeout (`RevealTimeoutSeconds`) completes any line the typewriter fails to finish, and a
   typewriter that throws falls back to showing the line whole. The panel carries the class
   `dialogue--typing` while a line types; the story smoke waits on it so it clicks once per line.

With no `ITextDisplaySettings` bound (tests, an older scene) lines are instant, exactly as before.

**How the package's typewriter behaves** (measured in EditMode against 3.20.1, and what the tests rely on):

- `AnimatedLabel.SetText` shows the whole line at once; `Typewriter.ShowText` hides it and reveals it as the label's
  animation loop (`Animate()`, a 60 Hz scheduler job in Play Mode) ticks, firing `OnTextShowed` when done.
  `SkipTypewriter()` shows everything and fires `OnTextShowed` too, so the presenter finishes its own state first
  and ignores that echo.
- The label's `TypewriterSettings` attribute is not read by this package version (the settings provider behind it is
  never assigned), so the built-in fallback applies: typewriter on, starting from every event. That is harmless
  because the fallback only types text given through `ShowText`.
- The package never fills in `AnimatedLabel.Behaviors`; the tests read the parsed regions from the label's protected
  `animator` by reflection.
- Effect tags are consumed by the parser: after `SetText("The <color=…><crrelic>soulstone</crrelic></color> hums.")`
  `label.text` holds only the colour tag, and `Characters` counts the words without any tag.

## Not covered yet

Creature and item descriptions, the capture-lesson hint and the battle log are not decorated (the first pass is
the story surfaces above); each is one `LoreText.Decorate` call at the point it assigns text. Pack rows exist for
forms only; the colours and looks are not translatable. A second serif face needs the font asset (see Type).

## Tests

| Test | Covers |
|---|---|
| `LoreMatcherTests`, `LoreTextEngineTests` (Localization.Logic.Tests) | matcher, boundaries, plurals, possessives, tags and braces skipped, first vs every, Plain = input, author tags, style overrides, effect once, pack form override |
| `LoreGlossaryTests`, `LoreContentTests`, `LoreTextTests`, `LorePaletteTests`, `LoreGlossaryRowTests`, `LoreTextModeTests` | validation, raw-tag checks, the facade and language change, contrast, export rows, mode mapping |
| `DialogueLineRevealTests`, `DialogueTextSpeedTests` (UI.Logic.Tests) | press semantics, speeds and timeouts |
| `LoreGlossaryContentTests` | the shipped glossary, its asset, the story vocabulary, no raw tags anywhere, decoration only adds tags |
| `CrThemeTests` | theme tokens equal the C# palette |
| `LoreAnimatedLabelTests` | the layouts use `AnimatedLabel`, the effect assets load and parse as effects |
| `DialogueScreenTypewriterTests`, `LoreSurfacesTests`, `TextDisplaySettingsTests`, `LoreTextInstallationTests`, `DialogueLoreTagDiagnosticsTests` | the presenter, each screen, the preferences, the installation, the editor findings |

The typewriter and the motion only run in Play Mode, so they are live checks: type a line and watch the
shimmer on "soulstone", press once (line completes) and again (next line), then switch each setting.
