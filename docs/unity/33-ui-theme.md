# UI Theme (global styling)

Every runtime screen draws its colours, type sizes and corner radii from one stylesheet. Change a
token there and every screen that uses it follows; a screen's own stylesheet keeps only its layout.

## How it's applied

`CrTheme.tss` is a theme stylesheet that imports Unity's default theme and then the CR tokens:

```css
@import url("unity-theme://default");
@import url("CrTheme.uss");
```

It is set as `themeStyleSheet` on **both** runtime PanelSettings, so every runtime `UIDocument`
inherits it without adding a stylesheet of its own:

| PanelSettings | Used by |
|---|---|
| `Assets/CR/UI/Panel Settings.asset` | Core scene menus and HUD |
| `Assets/CR/Resources/Evolution/EvolutionPanelSettings.asset` | Code-created overlays (loaded via `Resources.Load`) |

`MessageDialog` prefers the shared `Evolution/EvolutionPanelSettings` panel over whatever panel it
finds in the scene, because a third-party panel (e.g. the dialogue plugin's) does not carry the
theme and the dialog's tokens would resolve to nothing.

## Files

| File | Purpose |
|---|---|
| `Assets/CR/UI/Theme/CrTheme.uss` | The tokens (`:root`) and shared classes |
| `Assets/CR/UI/Theme/CrTheme.tss` | The theme: default Unity theme + `CrTheme.uss` |
| `Assets/CR/UI/Common/ScaledWindow.cs` | `.cr-window` frame that sizes itself by UI Scale |
| `Assets/CR/UI/Common/UiScaleApplier.cs` | Applies System → Graphics → "UI Scale" to every panel; exposes `ActiveScale` |
| `Assets/CR/Tests/Editor/CrThemeTests.cs` | The guard tests |

## Tokens

Colours are named by **role**, not by value: `--cr-paper-surface` can become dark tomorrow without
touching a screen.

| Family | Look | Used by | Main tokens |
|---|---|---|---|
| **paper** | Light panels | Player menu, Bag screen, Battle HUD cards, battle summary, dialogs | `--cr-paper-bg`, `-surface`, `-sunken`, `-track`, `-row`, `-row-hover`, `-border`, `-border-strong`, `-divider`, `-text`, `-text-strong`, `-text-body`, `-text-muted`, `-text-subtle` |
| **accent** | Sky blue | Paper-screen highlights, buttons | `--cr-accent`, `-strong`, `-bright`, `-soft`, `-softer`, `-tint`, `-deep`; `--cr-focus` (navy fill on a focused/selected control); `--cr-text-on-accent` |
| **glass** | Dark translucent overlays | Market, Shop, battle Bag, target picker, evolution | `--cr-glass-scrim`, `-bg`, `-surface`, `-surface-raised`, `-surface-hover`, `-surface-active`, `-selected`, `-border`, `-border-mid`, `-border-soft`, `-focus`, `-accent`, `-text`, `-text-soft`, `-text-muted`, `-text-dim`; `--cr-currency` |
| **hud** | Warm dark in-world notices | Toasts, quest tracker | `--cr-hud-surface`, `-text`, `-text-muted`, `-accent`; `--cr-reward`, `--cr-dialogue-accent` |
| **status** | Semantic | Any family | `--cr-danger`, `--cr-warning`, `--cr-success`, `--cr-success-bright` |

### Scales

Sizes are px in panel space; UI Scale multiplies all of them.

| Scale | Tokens |
|---|---|
| Font | `--cr-font-2xs` 9 · `xs` 10 · `sm` 11 · `base` 12 · `md` 13 · `lg` 14 · `xl` 16 · `2xl` 18 · `3xl` 20 · `4xl` 22 · `5xl` 24 · `6xl` 28 · `display` 32 |
| Radius | `--cr-radius-xs` 3 · `sm` 4 · `md` 6 · `lg` 8 · `xl` 10 · `2xl` 12 · `3xl` 16 |
| Spacing | `--cr-space-1` 4 · `2` 8 · `3` 12 · `4` 16 · `5` 20 · `6` 24 |

The spacing scale is **for new work** — existing paddings have not been migrated to it.

### Naming new tokens

- `--cr-<family>-<role>[-<variant>]` — e.g. `--cr-glass-surface-hover`, never `--cr-dark-blue`.
- Screen migrations may add a family of their own with a screen prefix (e.g. `--cr-storage-*`,
  `--cr-condition-*`). Same rule: role names, one prefix per family, defined in `CrTheme.uss`.

### Screen-family tokens

Below the core families, `CrTheme.uss` holds ~150 role-named tokens that the screen migration
introduced, grouped by the family that owns them:

| Prefix | Used by |
|--------|---------|
| `--cr-storage-*` | Player menu Storage tab and swap modal; the creature target picker reuses them so the two team pickers read as one control |
| `--cr-status-*` | Paper menus' destructive (rose), done (emerald) and claimable (amber) states. `--cr-danger` (red) stays the generic status colour |
| `--cr-type-*`, `--cr-hp-*` | Creature-class accents, HP bar states |
| `--cr-glass-buy-*`, `--cr-glass-danger-*`, `--cr-glass-focus-ring` | Market / Shop buttons and gamepad focus ring |
| `--cr-currency-*`, `--cr-market-*`, `--cr-bag-*`, `--cr-tier-*` | Wallet accents, Market, battle Bag (incl. capture-crystal rows), tier badges |
| `--cr-evolution-*` | Evolution cutscene and the area banner |
| `--cr-battle-*`, `--cr-condition-*`, `--cr-mission-*` | Battle HUD cards, status-condition badges, mission accents |
| `--cr-dialogue-*`, `--cr-hud-*` | Dialogue panel; toasts + quest tracker share the hud family |

About 70 literal colours remain, on purpose: single-use translucent washes (USS `var()` cannot go
inside `rgba()`), a few deliberately brighter `:focus` states, and the legacy `CharacterSelect.uss` /
`StartupFlow.uss` placeholder screens, which don't belong to any family yet.

## Restyling and adding screens

**Restyle:** change the token's value in `CrTheme.uss`. Nothing else.

**New screen:**

- Use `var(--cr-…)` for every recurring colour, font size and radius — no literals.
- USS can't put `var()` inside `rgba()`, so there is no "accent at 40%". A translucent variant
  that recurs gets its **own token** (that's why glass has `-border`, `-border-mid`, `-border-soft`).
- A token you use must exist — see [Guard](#guard).

## Shared classes

| Class | What it gives you |
|---|---|
| `.cr-window` | Column frame, 1px border, `overflow: hidden`, and the sizing custom properties below |
| `.cr-window--paper` | `--cr-paper-bg` fill, `--cr-paper-border`, `--cr-radius-3xl` corners |
| `.cr-window--glass` | `--cr-glass-bg` fill, `--cr-glass-border`, `--cr-radius-xl` corners, 10px padding |
| `.cr-scrim` | Full-screen absolute dimmer (`--cr-glass-scrim`) that centres its child |
| `.cr-hud-card` | `--cr-hud-surface` fill, `--cr-hud-accent` left border (toasts, quest tracker) |

### `.cr-window` and ScaledWindow

UI Scale grows a panel's content, but a frame sized as a screen percentage would stay the same
size around it. `CR.UI.Common.ScaledWindow` reads three custom properties and sets its own size to
the authored share × `UiScaleApplier.ActiveScale` (via `UiScale.WindowPercent`, capped at 98%):

| Property | Default | Meaning |
|---|---|---|
| `--cr-window-width` | `0.94` | Screen share at 100% UI Scale; `0` leaves the axis to ordinary USS |
| `--cr-window-height` | `0.92` | Same, vertical |
| `--cr-window-centered` | `1` | `1` = absolutely positioned in the middle of the parent; `0` = not |

The parent must be the full-screen layer the share is measured against. `ActiveScale` is 1 when no
applier runs (Editor, UI Builder).

In UXML, use `ScaledWindow` in place of the frame's `ui:VisualElement`
(from `Assets/CR/UI/Resources/PlayerMenuWindow.uxml`):

```xml
<CR.UI.Common.ScaledWindow name="player-menu-window" class="cr-window cr-window--paper player-menu-window">
```

Override the size per screen in its own USS (from `MerchantShopScreen.uss`):

```css
.shop-panel {
    --cr-window-width: 0.70;
    --cr-window-height: 0.78;
    --cr-window-centered: 0;
}
```

## Guard

An undefined token does not error in UI Toolkit — it silently resolves to nothing (transparent
colour, zero size), which reads as a broken screen. `CrThemeTests` (EditMode) catches that:

| Test | Checks |
|---|---|
| `EveryRuntimePanelWearsTheCrTheme` | Both PanelSettings above have `CrTheme.tss` as their theme |
| `TheThemeImportsItsTokens` | `CrTheme.tss` imports `unity-theme://default` and `CrTheme.uss` |
| `EveryTokenAStylesheetUsesIsDefinedInTheTheme` | Every `var(--cr-…)` in any `.uss` under `Assets/CR` is defined in `CrTheme.uss` or by a stylesheet itself (e.g. a `--cr-window-*` override) |

## Editor preview caveat

UI Builder only resolves the tokens if its preview theme is set to `CrTheme.tss`. With the default
Unity theme selected, themed elements preview transparent — that is the preview, not the screen.

## Out of scope

Dev and editor tool stylesheets — GameDataManager, `*Editor.uss`, management views — are not
themed and do not use the `--cr-*` tokens.

## Related

- [Player Menu UI](10-player-menu-ui.md) — paper window, UI Scale setting on the System tab
- [UI Icons](29-ui-icons.md)
