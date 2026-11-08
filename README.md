# TabHarbor 🛟

**Let your tabs come home.**

TabHarbor is a Chrome extension that puts a dashboard of everything you have open one toolbar click away. Tabs are grouped by domain (or by AI-classified topic), homepages get their own group, and closing a group comes with a satisfying swoosh + confetti. Your default new tab page stays untouched, and the dashboard follows your browser's light/dark theme automatically.

No server. No account. Local by default.

---

## Features

- **Opens from the toolbar icon** — click the TabHarbor button in Chrome's toolbar to open the dashboard as a regular tab; your new tab page stays default
- **Light & dark mode** — follows your browser theme automatically via `prefers-color-scheme`, no toggle to configure
- **See all your tabs at a glance** on a clean grid, grouped by domain
- **AI 分类 (AI classification)** — group tabs by *topic* instead of domain, powered by any OpenAI-compatible API (智谱 BigModel, OpenAI, DeepSeek, SiliconFlow, or a custom endpoint)
- **View toggle** — switch between domain view and AI view once a classification exists
- **Homepages group** pulls Gmail inbox, X home, YouTube, LinkedIn, GitHub homepages into one card
- **Close tabs with style** with swoosh sound + confetti burst
- **Duplicate detection** flags when you have the same page open twice, with one-click cleanup
- **Click any tab to jump to it** across windows, no new tab opened
- **Save for later** bookmark tabs to a checklist before closing them
- **Localhost grouping** shows port numbers next to each tab so you can tell your vibe coding projects apart
- **Expandable groups** show the first 8 tabs with a clickable "+N more"
- **Pinned tabs are sacred** — never classified, never closed by "close all"

---

## Install

**1. Get the code**

```bash
git clone https://github.com/Howie-y/tabharbor.git
```

**2. Load the extension**

1. Open Chrome and go to `chrome://extensions`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked**
4. Select the `extension/` folder inside the repo

**3. Click the TabHarbor icon in the toolbar**

If the icon isn't visible, click the puzzle-piece **Extensions** menu (next to the address bar) and pin **TabHarbor**. Clicking the icon opens the dashboard as a regular tab.

---

## AI 分类 (optional)

AI classification is **off by default** — the extension works fully without it.

**Setup:** click the ⚙️ settings button, pick a provider, enter your model and API key. Use the **测试连接** button to verify before saving.

| Provider | Default model | Notes |
|----------|--------------|-------|
| 智谱 (BigModel) | `glm-4-flash` | glm-4-flash is free |
| 智谱 Coding Plan | `glm-4-flash` | use your Coding Plan key + endpoint |
| OpenAI | `gpt-4o-mini` | |
| DeepSeek | `deepseek-chat` | |
| SiliconFlow | `Qwen/Qwen2.5-7B-Instruct` | |
| 自定义 | — | any OpenAI-compatible `/chat/completions` endpoint |

**How it behaves:**

- Tabs are sent in batches of 40 per API request, with a 60s timeout per batch; up to 3 batches run concurrently, each with one automatic retry, and you can cancel mid-run
- The classification is cached in `chrome.storage.local`; tabs opened afterwards show up in an "未分类（新打开）" group with a one-click **仅分类新标签** incremental retry
- Closing tabs keeps the AI view consistent automatically
- Pinned tabs are excluded from classification and from "close all"

**Privacy:** when you trigger AI classification, tab **titles** (first 120 chars) and **URLs** (first 200 chars) are sent to the provider *you* configured, using *your* API key. Nothing is sent to any other service, and no data is sent at all unless you click "AI 分类". Your API key and settings never leave your machine.

---

## How it works

```
You click the TabHarbor icon in the toolbar
  -> The dashboard opens as a regular tab, themed to match your browser
  -> Your open tabs are grouped by domain
  -> Homepages (Gmail, X, etc.) get their own group at the top
  -> Click any tab title to jump to it
  -> Close groups you're done with (swoosh + confetti)
  -> Save tabs for later before closing them
  -> (optional) Click "AI 分类" to regroup tabs by topic via your AI provider
```

Everything runs inside the extension. Saved tabs, AI settings, and the classification cache are stored in `chrome.storage.local`.

---

## Tech stack

| What | How |
|------|-----|
| Extension | Chrome Manifest V3 |
| Entry point | Toolbar action click (no new-tab override) |
| Storage | chrome.storage.local |
| Sound | Web Audio API (synthesized, no files) |
| Animations | CSS transitions + JS confetti particles |
| Theming | CSS `prefers-color-scheme` (auto light/dark, zero config) |
| AI classification (optional) | OpenAI-compatible Chat Completions API, bring your own key |

---

## Acknowledgments

TabHarbor began as a local customization of [zarazhangrui/tab-out](https://github.com/zarazhangrui/tab-out) (MIT) and grew into its own thing: a new identity, a toolbar-driven entry point (no new-tab takeover), AI-powered classification, automatic theming, and a heavily reworked dashboard. Thank you, [Zara](https://x.com/zarazhangrui) — the harbor was built on your docks.

## License

[MIT](LICENSE) © Howie-y and Zara Zhang
