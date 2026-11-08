# AGENTS.md — TabHarbor: Project Guide for Coding Agents

TabHarbor is a Chrome Manifest V3 extension: click the toolbar icon to open a
dashboard of every open tab, grouped by domain or AI-classified topic. This
file orients you (a coding agent) on the architecture and the house rules
before you change anything.

---

## What TabHarbor is

> **TabHarbor** puts a dashboard of everything you have open one toolbar click
> away, grouped by domain.
>
> - **Opens from the toolbar icon** as a regular tab — the new tab page stays default
> - **Light & dark mode** follows the browser theme automatically, nothing to configure
> - **All open tabs at a glance** grouped by domain on a grid
> - **AI 分类** (optional) regroups tabs by topic via a user-configured AI provider
> - **Close groups with style** — swoosh sound + confetti
> - **Duplicate detection**, **save for later**, **localhost port labels**, **+N more** overflow
> - **Pinned tabs are sacred** — never classified, never closed by "close all"

---

## Architecture

```
extension/
  manifest.json     MV3. No newtab override; entry = action click.
  background.js     Service worker: toolbar badge count + action.onClicked
                    (focus an existing dashboard tab or open a new one).
  index.html        Dashboard shell: header, banner, cards grid, settings
                    modal, AI loading overlay, toast.
  app.js            All logic (~2100 lines):
                    - fetchOpenTabs / getRealTabs / getClassifiableTabs
                      (real = not chrome://-internal; classifiable = real + not pinned)
                    - domain grouping + AI classification pipeline
                      (AI_PROVIDERS, classifyTabsWithAI: dedupe -> batches of 40,
                      3 concurrent lanes, per-batch retry, partial success, abort)
                    - two view modes (domain / ai) + view persistence (aiViewMode)
                    - saved-for-later checklist (deferred/archive)
                    - sound + confetti
  style.css         All theming via CSS vars in :root; dark mode is a single
                    @media (prefers-color-scheme: dark) block that flips the
                    palette. Do NOT hardcode colors in rules — add a var.
  config.local.js   Optional personal overrides (gitignored). Absence is fine.
```

---

## House rules

1. **No inline event handlers.** MV3's CSP (`script-src 'self'`) blocks them
   and each one logs a violation on every page load. Use `data-action` +
   the delegated click listener in app.js, or delegated capture-phase
   listeners for non-bubbling events like `error` on images.
2. **All colors go through CSS variables.** Dark mode only overrides the
   palette in `:root`; a hardcoded color breaks it silently.
3. **Escape every dynamic string** rendered into HTML with `escapeHtml()`.
   Tab titles and even AI-generated category names are untrusted.
4. **Pinned tabs and browser-internal pages** are off-limits for
   classification and "close all" — go through `getClassifiableTabs()`.
5. **Settings and caches** live in `chrome.storage.local`:
   `aiSettings` (provider/baseUrl/model/apiKey), `aiCategories` (last
   classification), `aiViewMode` ('ai' | 'domain'), `savedTabs`.
6. The AI feature is **opt-in and BYO-key**. No request leaves the machine
   unless the user clicks "AI 分类". Keep it that way.

---

## Development

Load the `extension/` folder via `chrome://extensions` → Developer mode →
**Load unpacked**. After changes, hit the ↻ reload on the extension card and
open a fresh dashboard tab. Check the extension's **错误 (Errors)** button on
`chrome://extensions` after changes — it should stay empty.

To update from upstream: this project is independent; sync manually if the
original ([zarazhangrui/tab-out](https://github.com/zarazhangrui/tab-out))
ships something you want.
