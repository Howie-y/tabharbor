/* ================================================================
   TabHarbor — Dashboard App (Pure Extension Edition)

   This file is the brain of the dashboard. Now that the dashboard
   IS the extension page (not inside an iframe), it can call
   chrome.tabs and chrome.storage directly — no postMessage bridge needed.

   What this file does:
   1. Reads open browser tabs directly via chrome.tabs.query()
   2. Groups tabs by domain with a landing pages category
   3. Renders domain cards, banners, and stats
   4. Handles all user actions (close tabs, save for later, focus tab)
   5. Stores "Saved for Later" tabs in chrome.storage.local (no server)
   ================================================================ */

'use strict';


/* ----------------------------------------------------------------
   CHROME TABS — Direct API Access

   Since this page IS the extension's new tab page, it has full
   access to chrome.tabs and chrome.storage. No middleman needed.
   ---------------------------------------------------------------- */

// All open tabs — populated by fetchOpenTabs()
let openTabs = [];

/**
 * fetchOpenTabs()
 *
 * Reads all currently open browser tabs directly from Chrome.
 * Sets the extensionId flag so we can identify TabHarbor's own pages.
 */
async function fetchOpenTabs() {
  try {
    const extensionId = chrome.runtime.id;
    // The dashboard lives at index.html, opened from the toolbar icon
    // (it no longer overrides chrome://newtab).
    const dashboardUrl = `chrome-extension://${extensionId}/index.html`;

    const tabs = await chrome.tabs.query({});
    openTabs = tabs.map(t => ({
      id:       t.id,
      url:      t.url,
      title:    t.title,
      windowId: t.windowId,
      active:   t.active,
      pinned:   t.pinned,
      // Flag TabHarbor's own pages so we can detect duplicate dashboards
      isDashboard: t.url === dashboardUrl,
    }));
  } catch {
    // chrome.tabs API unavailable (shouldn't happen in an extension page)
    openTabs = [];
  }
}

/**
 * closeTabsByUrls(urls)
 *
 * Closes all open tabs whose hostname matches any of the given URLs.
 * After closing, re-fetches the tab list to keep our state accurate.
 *
 * Special case: file:// URLs are matched exactly (they have no hostname).
 */
async function closeTabsByUrls(urls) {
  if (!urls || urls.length === 0) return;

  // Separate file:// URLs (exact match) from regular URLs (hostname match)
  const targetHostnames = [];
  const exactUrls = new Set();

  for (const u of urls) {
    if (u.startsWith('file://')) {
      exactUrls.add(u);
    } else {
      try { targetHostnames.push(new URL(u).hostname); }
      catch { /* skip unparseable */ }
    }
  }

  const allTabs = await chrome.tabs.query({});
  const toClose = allTabs
    .filter(tab => {
      const tabUrl = tab.url || '';
      if (tabUrl.startsWith('file://') && exactUrls.has(tabUrl)) return true;
      try {
        const tabHostname = new URL(tabUrl).hostname;
        return tabHostname && targetHostnames.includes(tabHostname);
      } catch { return false; }
    })
    .map(tab => tab.id);

  if (toClose.length > 0) await chrome.tabs.remove(toClose);
  await fetchOpenTabs();
}

/**
 * closeTabsExact(urls)
 *
 * Closes tabs by exact URL match (not hostname). Used for landing pages
 * so closing "Gmail inbox" doesn't also close individual email threads.
 */
async function closeTabsExact(urls) {
  if (!urls || urls.length === 0) return;
  const urlSet = new Set(urls);
  const allTabs = await chrome.tabs.query({});
  const toClose = allTabs.filter(t => urlSet.has(t.url)).map(t => t.id);
  if (toClose.length > 0) await chrome.tabs.remove(toClose);
  await fetchOpenTabs();
}

/**
 * focusTab(url)
 *
 * Switches Chrome to the tab with the given URL (exact match first,
 * then hostname fallback). Also brings the window to the front.
 */
async function focusTab(url) {
  if (!url) return;
  const allTabs = await chrome.tabs.query({});
  const currentWindow = await chrome.windows.getCurrent();

  // Try exact URL match first
  let matches = allTabs.filter(t => t.url === url);

  // Fall back to hostname match
  if (matches.length === 0) {
    try {
      const targetHost = new URL(url).hostname;
      matches = allTabs.filter(t => {
        try { return new URL(t.url).hostname === targetHost; }
        catch { return false; }
      });
    } catch {}
  }

  if (matches.length === 0) return;

  // Prefer a match in a different window so it actually switches windows
  const match = matches.find(t => t.windowId !== currentWindow.id) || matches[0];
  await chrome.tabs.update(match.id, { active: true });
  await chrome.windows.update(match.windowId, { focused: true });
}

/**
 * closeDuplicateTabs(urls, keepOne)
 *
 * Closes duplicate tabs for the given list of URLs.
 * keepOne=true → keep one copy of each, close the rest.
 * keepOne=false → close all copies.
 */
async function closeDuplicateTabs(urls, keepOne = true) {
  const allTabs = await chrome.tabs.query({});
  const toClose = [];

  for (const url of urls) {
    const matching = allTabs.filter(t => t.url === url);
    if (keepOne) {
      const keep = matching.find(t => t.active) || matching[0];
      for (const tab of matching) {
        if (tab.id !== keep.id) toClose.push(tab.id);
      }
    } else {
      for (const tab of matching) toClose.push(tab.id);
    }
  }

  if (toClose.length > 0) await chrome.tabs.remove(toClose);
  await fetchOpenTabs();
}

/**
 * closeDashboardDupes()
 *
 * Closes all duplicate TabHarbor new-tab pages except the current one.
 */
async function closeDashboardDupes() {
  const extensionId = chrome.runtime.id;
  const newtabUrl = `chrome-extension://${extensionId}/index.html`;

  const allTabs = await chrome.tabs.query({});
  const currentWindow = await chrome.windows.getCurrent();
  const dashboardTabs = allTabs.filter(t =>
    t.url === newtabUrl || t.url === 'chrome://newtab/'
  );

  if (dashboardTabs.length <= 1) return;

  // Keep the active TabHarbor tab in the CURRENT window — that's the one the
  // user is looking at right now. Falls back to any active one, then the first.
  const keep =
    dashboardTabs.find(t => t.active && t.windowId === currentWindow.id) ||
    dashboardTabs.find(t => t.active) ||
    dashboardTabs[0];
  const toClose = dashboardTabs.filter(t => t.id !== keep.id).map(t => t.id);
  if (toClose.length > 0) await chrome.tabs.remove(toClose);
  await fetchOpenTabs();
}


/* ----------------------------------------------------------------
   SAVED FOR LATER — chrome.storage.local

   Replaces the old server-side SQLite + REST API with Chrome's
   built-in key-value storage. Data persists across browser sessions
   and doesn't require a running server.

   Data shape stored under the "deferred" key:
   [
     {
       id: "1712345678901",          // timestamp-based unique ID
       url: "https://example.com",
       title: "Example Page",
       savedAt: "2026-04-04T10:00:00.000Z",  // ISO date string
       completed: false,             // true = checked off (archived)
       dismissed: false              // true = dismissed without reading
     },
     ...
   ]
   ---------------------------------------------------------------- */

/**
 * saveTabForLater(tab)
 *
 * Saves a single tab to the "Saved for Later" list in chrome.storage.local.
 * @param {{ url: string, title: string }} tab
 */
async function saveTabForLater(tab) {
  const { deferred = [] } = await chrome.storage.local.get('deferred');
  deferred.push({
    id:        Date.now().toString(),
    url:       tab.url,
    title:     tab.title,
    savedAt:   new Date().toISOString(),
    completed: false,
    dismissed: false,
  });
  await chrome.storage.local.set({ deferred });
}

/**
 * getSavedTabs()
 *
 * Returns all saved tabs from chrome.storage.local.
 * Filters out dismissed items (those are gone for good).
 * Splits into active (not completed) and archived (completed).
 */
async function getSavedTabs() {
  const { deferred = [] } = await chrome.storage.local.get('deferred');
  const visible = deferred.filter(t => !t.dismissed);
  return {
    active:   visible.filter(t => !t.completed),
    archived: visible.filter(t => t.completed),
  };
}

/**
 * checkOffSavedTab(id)
 *
 * Marks a saved tab as completed (checked off). It moves to the archive.
 */
async function checkOffSavedTab(id) {
  const { deferred = [] } = await chrome.storage.local.get('deferred');
  const tab = deferred.find(t => t.id === id);
  if (tab) {
    tab.completed = true;
    tab.completedAt = new Date().toISOString();
    await chrome.storage.local.set({ deferred });
  }
}

/**
 * dismissSavedTab(id)
 *
 * Marks a saved tab as dismissed (removed from all lists).
 */
async function dismissSavedTab(id) {
  const { deferred = [] } = await chrome.storage.local.get('deferred');
  const tab = deferred.find(t => t.id === id);
  if (tab) {
    tab.dismissed = true;
    await chrome.storage.local.set({ deferred });
  }
}


/* ----------------------------------------------------------------
   UI HELPERS
   ---------------------------------------------------------------- */

/**
 * playCloseSound()
 *
 * Plays a clean "swoosh" sound when tabs are closed.
 * Built entirely with the Web Audio API — no sound files needed.
 * A filtered noise sweep that descends in pitch, like air moving.
 */
function playCloseSound() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const t = ctx.currentTime;

    // Swoosh: shaped white noise through a sweeping bandpass filter
    const duration = 0.25;
    const buffer = ctx.createBuffer(1, ctx.sampleRate * duration, ctx.sampleRate);
    const data = buffer.getChannelData(0);

    // Generate noise with a natural envelope (quick attack, smooth decay)
    for (let i = 0; i < data.length; i++) {
      const pos = i / data.length;
      // Envelope: ramps up fast in first 10%, then fades out smoothly
      const env = pos < 0.1 ? pos / 0.1 : Math.pow(1 - (pos - 0.1) / 0.9, 1.5);
      data[i] = (Math.random() * 2 - 1) * env;
    }

    const source = ctx.createBufferSource();
    source.buffer = buffer;

    // Bandpass filter sweeps from high to low — creates the "swoosh" character
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.Q.value = 2.0;
    filter.frequency.setValueAtTime(4000, t);
    filter.frequency.exponentialRampToValueAtTime(400, t + duration);

    // Volume
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.15, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + duration);

    source.connect(filter).connect(gain).connect(ctx.destination);
    source.start(t);

    setTimeout(() => ctx.close(), 500);
  } catch {
    // Audio not supported — fail silently
  }
}

/**
 * shootConfetti(x, y)
 *
 * Shoots a burst of colorful confetti particles from the given screen
 * coordinates (typically the center of a card being closed).
 * Pure CSS + JS, no libraries.
 */
function shootConfetti(x, y) {
  const colors = [
    '#c8713a', // amber
    '#e8a070', // amber light
    '#5a7a62', // sage
    '#8aaa92', // sage light
    '#5a6b7a', // slate
    '#8a9baa', // slate light
    '#d4b896', // warm paper
    '#b35a5a', // rose
  ];

  const particleCount = 17;

  for (let i = 0; i < particleCount; i++) {
    const el = document.createElement('div');

    const isCircle = Math.random() > 0.5;
    const size = 5 + Math.random() * 6; // 5–11px
    const color = colors[Math.floor(Math.random() * colors.length)];

    el.style.cssText = `
      position: fixed;
      left: ${x}px;
      top: ${y}px;
      width: ${size}px;
      height: ${size}px;
      background: ${color};
      border-radius: ${isCircle ? '50%' : '2px'};
      pointer-events: none;
      z-index: 9999;
      transform: translate(-50%, -50%);
      opacity: 1;
    `;
    document.body.appendChild(el);

    // Physics: random angle and speed for the outward burst
    const angle   = Math.random() * Math.PI * 2;
    const speed   = 60 + Math.random() * 120;
    const vx      = Math.cos(angle) * speed;
    const vy      = Math.sin(angle) * speed - 80; // bias upward
    const gravity = 200;

    const startTime = performance.now();
    const duration  = 700 + Math.random() * 200; // 700–900ms

    function frame(now) {
      const elapsed  = (now - startTime) / 1000;
      const progress = elapsed / (duration / 1000);

      if (progress >= 1) { el.remove(); return; }

      const px = vx * elapsed;
      const py = vy * elapsed + 0.5 * gravity * elapsed * elapsed;
      const opacity = progress < 0.5 ? 1 : 1 - (progress - 0.5) * 2;
      const rotate  = elapsed * 200 * (isCircle ? 0 : 1);

      el.style.transform = `translate(calc(-50% + ${px}px), calc(-50% + ${py}px)) rotate(${rotate}deg)`;
      el.style.opacity = opacity;

      requestAnimationFrame(frame);
    }

    requestAnimationFrame(frame);
  }
}

/**
 * animateCardOut(card)
 *
 * Smoothly removes a mission card: fade + scale down, then confetti.
 * After the animation, checks if the grid is now empty.
 */
function animateCardOut(card) {
  if (!card) return;

  const rect = card.getBoundingClientRect();
  shootConfetti(rect.left + rect.width / 2, rect.top + rect.height / 2);

  card.classList.add('closing');
  setTimeout(() => {
    card.remove();
    checkAndShowEmptyState();
  }, 300);
}

/**
 * showToast(message)
 *
 * Brief pop-up notification at the bottom of the screen.
 */
function showToast(message) {
  const toast = document.getElementById('toast');
  document.getElementById('toastText').textContent = message;
  toast.classList.add('visible');
  setTimeout(() => toast.classList.remove('visible'), 2500);
}

/**
 * checkAndShowEmptyState()
 *
 * Shows a cheerful "Inbox zero" message when all domain cards are gone.
 */
function checkAndShowEmptyState() {
  const missionsEl = document.getElementById('openTabsMissions');
  if (!missionsEl) return;

  const remaining = missionsEl.querySelectorAll('.mission-card:not(.closing)').length;
  if (remaining > 0) return;

  missionsEl.innerHTML = `
    <div class="missions-empty-state">
      <div class="empty-checkmark">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" d="m4.5 12.75 6 6 9-13.5" />
        </svg>
      </div>
      <div class="empty-title">Inbox zero, but for tabs.</div>
      <div class="empty-subtitle">You're free.</div>
    </div>
  `;

  const countEl = document.getElementById('openTabsSectionCount');
  if (countEl) countEl.textContent = '0 domains';
}

/**
 * timeAgo(dateStr)
 *
 * Converts an ISO date string into a human-friendly relative time.
 * "2026-04-04T10:00:00Z" → "2 hrs ago" or "yesterday"
 */
function timeAgo(dateStr) {
  if (!dateStr) return '';
  const then = new Date(dateStr);
  const now  = new Date();
  const diffMins  = Math.floor((now - then) / 60000);
  const diffHours = Math.floor((now - then) / 3600000);
  const diffDays  = Math.floor((now - then) / 86400000);

  if (diffMins < 1)   return 'just now';
  if (diffMins < 60)  return diffMins + ' min ago';
  if (diffHours < 24) return diffHours + ' hr' + (diffHours !== 1 ? 's' : '') + ' ago';
  if (diffDays === 1) return 'yesterday';
  return diffDays + ' days ago';
}

/**
 * getGreeting() — "Good morning / afternoon / evening"
 */
function getGreeting() {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

/**
 * getDateDisplay() — "Friday, April 4, 2026"
 */
function getDateDisplay() {
  return new Date().toLocaleDateString('en-US', {
    weekday: 'long',
    year:    'numeric',
    month:   'long',
    day:     'numeric',
  });
}


/* ----------------------------------------------------------------
   DOMAIN & TITLE CLEANUP HELPERS
   ---------------------------------------------------------------- */

// Map of known hostnames → friendly display names.
const FRIENDLY_DOMAINS = {
  'github.com':           'GitHub',
  'www.github.com':       'GitHub',
  'gist.github.com':      'GitHub Gist',
  'youtube.com':          'YouTube',
  'www.youtube.com':      'YouTube',
  'music.youtube.com':    'YouTube Music',
  'x.com':                'X',
  'www.x.com':            'X',
  'twitter.com':          'X',
  'www.twitter.com':      'X',
  'reddit.com':           'Reddit',
  'www.reddit.com':       'Reddit',
  'old.reddit.com':       'Reddit',
  'substack.com':         'Substack',
  'www.substack.com':     'Substack',
  'medium.com':           'Medium',
  'www.medium.com':       'Medium',
  'linkedin.com':         'LinkedIn',
  'www.linkedin.com':     'LinkedIn',
  'stackoverflow.com':    'Stack Overflow',
  'www.stackoverflow.com':'Stack Overflow',
  'news.ycombinator.com': 'Hacker News',
  'google.com':           'Google',
  'www.google.com':       'Google',
  'mail.google.com':      'Gmail',
  'docs.google.com':      'Google Docs',
  'drive.google.com':     'Google Drive',
  'calendar.google.com':  'Google Calendar',
  'meet.google.com':      'Google Meet',
  'gemini.google.com':    'Gemini',
  'chatgpt.com':          'ChatGPT',
  'www.chatgpt.com':      'ChatGPT',
  'chat.openai.com':      'ChatGPT',
  'claude.ai':            'Claude',
  'www.claude.ai':        'Claude',
  'code.claude.com':      'Claude Code',
  'notion.so':            'Notion',
  'www.notion.so':        'Notion',
  'figma.com':            'Figma',
  'www.figma.com':        'Figma',
  'slack.com':            'Slack',
  'app.slack.com':        'Slack',
  'discord.com':          'Discord',
  'www.discord.com':      'Discord',
  'wikipedia.org':        'Wikipedia',
  'en.wikipedia.org':     'Wikipedia',
  'amazon.com':           'Amazon',
  'www.amazon.com':       'Amazon',
  'netflix.com':          'Netflix',
  'www.netflix.com':      'Netflix',
  'spotify.com':          'Spotify',
  'open.spotify.com':     'Spotify',
  'vercel.com':           'Vercel',
  'www.vercel.com':       'Vercel',
  'npmjs.com':            'npm',
  'www.npmjs.com':        'npm',
  'developer.mozilla.org':'MDN',
  'arxiv.org':            'arXiv',
  'www.arxiv.org':        'arXiv',
  'huggingface.co':       'Hugging Face',
  'www.huggingface.co':   'Hugging Face',
  'producthunt.com':      'Product Hunt',
  'www.producthunt.com':  'Product Hunt',
  'xiaohongshu.com':      'RedNote',
  'www.xiaohongshu.com':  'RedNote',
  'local-files':          'Local Files',
};

function friendlyDomain(hostname) {
  if (!hostname) return '';
  if (FRIENDLY_DOMAINS[hostname]) return FRIENDLY_DOMAINS[hostname];

  if (hostname.endsWith('.substack.com') && hostname !== 'substack.com') {
    return capitalize(hostname.replace('.substack.com', '')) + "'s Substack";
  }
  if (hostname.endsWith('.github.io')) {
    return capitalize(hostname.replace('.github.io', '')) + ' (GitHub Pages)';
  }

  let clean = hostname
    .replace(/^www\./, '')
    .replace(/\.(com|org|net|io|co|ai|dev|app|so|me|xyz|info|us|uk|co\.uk|co\.jp)$/, '');

  return clean.split('.').map(part => capitalize(part)).join(' ');
}

function capitalize(str) {
  if (!str) return '';
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function stripTitleNoise(title) {
  if (!title) return '';
  // Strip leading notification count: "(2) Title"
  title = title.replace(/^\(\d+\+?\)\s*/, '');
  // Strip inline counts like "Inbox (16,359)"
  title = title.replace(/\s*\([\d,]+\+?\)\s*/g, ' ');
  // Strip email addresses (privacy + cleaner display)
  title = title.replace(/\s*[\-\u2010-\u2015]\s*[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g, '');
  title = title.replace(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g, '');
  // Clean X/Twitter format
  title = title.replace(/\s+on X:\s*/, ': ');
  title = title.replace(/\s*\/\s*X\s*$/, '');
  return title.trim();
}

function cleanTitle(title, hostname) {
  if (!title || !hostname) return title || '';

  const friendly = friendlyDomain(hostname);
  const domain   = hostname.replace(/^www\./, '');
  const seps     = [' - ', ' | ', ' — ', ' · ', ' – '];

  for (const sep of seps) {
    const idx = title.lastIndexOf(sep);
    if (idx === -1) continue;
    const suffix     = title.slice(idx + sep.length).trim();
    const suffixLow  = suffix.toLowerCase();
    if (
      suffixLow === domain.toLowerCase() ||
      suffixLow === friendly.toLowerCase() ||
      suffixLow === domain.replace(/\.\w+$/, '').toLowerCase() ||
      domain.toLowerCase().includes(suffixLow) ||
      friendly.toLowerCase().includes(suffixLow)
    ) {
      const cleaned = title.slice(0, idx).trim();
      if (cleaned.length >= 5) return cleaned;
    }
  }
  return title;
}

function smartTitle(title, url) {
  if (!url) return title || '';
  let pathname = '', hostname = '';
  try { const u = new URL(url); pathname = u.pathname; hostname = u.hostname; }
  catch { return title || ''; }

  const titleIsUrl = !title || title === url || title.startsWith(hostname) || title.startsWith('http');

  if ((hostname === 'x.com' || hostname === 'twitter.com' || hostname === 'www.x.com') && pathname.includes('/status/')) {
    const username = pathname.split('/')[1];
    if (username) return titleIsUrl ? `Post by @${username}` : title;
  }

  if (hostname === 'github.com' || hostname === 'www.github.com') {
    const parts = pathname.split('/').filter(Boolean);
    if (parts.length >= 2) {
      const [owner, repo, ...rest] = parts;
      if (rest[0] === 'issues' && rest[1]) return `${owner}/${repo} Issue #${rest[1]}`;
      if (rest[0] === 'pull'   && rest[1]) return `${owner}/${repo} PR #${rest[1]}`;
      if (rest[0] === 'blob' || rest[0] === 'tree') return `${owner}/${repo} — ${rest.slice(2).join('/')}`;
      if (titleIsUrl) return `${owner}/${repo}`;
    }
  }

  if ((hostname === 'www.youtube.com' || hostname === 'youtube.com') && pathname === '/watch') {
    if (titleIsUrl) return 'YouTube Video';
  }

  if ((hostname === 'www.reddit.com' || hostname === 'reddit.com' || hostname === 'old.reddit.com') && pathname.includes('/comments/')) {
    const parts  = pathname.split('/').filter(Boolean);
    const subIdx = parts.indexOf('r');
    if (subIdx !== -1 && parts[subIdx + 1]) {
      if (titleIsUrl) return `r/${parts[subIdx + 1]} post`;
    }
  }

  return title || url;
}


/* ----------------------------------------------------------------
   SVG ICON STRINGS
   ---------------------------------------------------------------- */
const ICONS = {
  tabs:    `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M3 8.25V18a2.25 2.25 0 0 0 2.25 2.25h13.5A2.25 2.25 0 0 0 21 18V8.25m-18 0V6a2.25 2.25 0 0 1 2.25-2.25h13.5A2.25 2.25 0 0 1 21 6v2.25m-18 0h18" /></svg>`,
  close:   `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>`,
  archive: `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M20.25 7.5l-.625 10.632a2.25 2.25 0 0 1-2.247 2.118H6.622a2.25 2.25 0 0 1-2.247-2.118L3.75 7.5m6 4.125l2.25 2.25m0 0l2.25 2.25M12 13.875l2.25-2.25M12 13.875l-2.25 2.25M3.375 7.5h17.25c.621 0 1.125-.504 1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125Z" /></svg>`,
  focus:   `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="m4.5 19.5 15-15m0 0H8.25m11.25 0v11.25" /></svg>`,
};

/**
 * escapeHtml(s)
 *
 * Escapes a string for safe interpolation into HTML — both text content
 * and double-quoted attributes. Tab titles and AI-generated category
 * names are untrusted input (page titles can reach the model via the
 * classification prompt), so every dynamic string rendered into the
 * dashboard goes through this.
 */
function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// MV3's CSP (script-src 'self') blocks the inline onerror handlers that
// favicon <img> tags used to carry — every failed favicon load logged a
// CSP violation on the extension page. Hide broken images via one
// delegated capture-phase listener instead (error events don't bubble).
document.addEventListener('error', (e) => {
  const t = e.target;
  if (t instanceof HTMLImageElement && (t.classList.contains('chip-favicon') || t.closest('.deferred-title'))) {
    t.style.display = 'none';
  }
}, true);

const AI_CATEGORY_COLORS = [
  { bg: 'rgba(90, 122, 98, 0.10)', border: 'rgba(90, 122, 98, 0.25)', text: '#5a7a62' },
  { bg: 'rgba(200, 113, 58, 0.10)', border: 'rgba(200, 113, 58, 0.25)', text: '#c8713a' },
  { bg: 'rgba(90, 107, 122, 0.10)', border: 'rgba(90, 107, 122, 0.25)', text: '#5a6b7a' },
  { bg: 'rgba(179, 90, 90, 0.10)', border: 'rgba(179, 90, 90, 0.25)', text: '#b35a5a' },
  { bg: 'rgba(184, 137, 46, 0.10)', border: 'rgba(184, 137, 46, 0.25)', text: '#b8892e' },
  { bg: 'rgba(106, 90, 179, 0.10)', border: 'rgba(106, 90, 179, 0.25)', text: '#6a5ab3' },
  { bg: 'rgba(58, 152, 180, 0.10)', border: 'rgba(58, 152, 180, 0.25)', text: '#3a98b4' },
  { bg: 'rgba(152, 120, 58, 0.10)', border: 'rgba(152, 120, 58, 0.25)', text: '#98783a' },
];


/* ----------------------------------------------------------------
   AI SETTINGS — chrome.storage.local
   ---------------------------------------------------------------- */

const AI_PROVIDERS = {
  'zhipu': {
    name: '智谱 (BigModel)',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
    defaultModel: 'glm-4-flash',
    modelHint: '推荐: glm-4-flash (免费), glm-4-air, glm-4-plus, glm-4',
    keyHint: '在 open.bigmodel.cn/usercenter/apikeys 获取',
  },
  'zhipu-coding': {
    name: '智谱 Coding Plan',
    baseUrl: '',
    defaultModel: 'glm-4-flash',
    modelHint: '使用智谱 Coding Plan 提供的模型名称',
    keyHint: '使用智谱 Coding Plan 提供的 API Key',
  },
  'openai': {
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1/chat/completions',
    defaultModel: 'gpt-4o-mini',
    modelHint: '推荐: gpt-4o-mini, gpt-4o, gpt-3.5-turbo',
    keyHint: '在 platform.openai.com/api-keys 获取',
  },
  'deepseek': {
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1/chat/completions',
    defaultModel: 'deepseek-chat',
    modelHint: '推荐: deepseek-chat, deepseek-reasoner',
    keyHint: '在 platform.deepseek.com 获取',
  },
  'siliconflow': {
    name: 'SiliconFlow',
    baseUrl: 'https://api.siliconflow.cn/v1/chat/completions',
    defaultModel: 'Qwen/Qwen2.5-7B-Instruct',
    modelHint: '推荐: Qwen/Qwen2.5-7B-Instruct, deepseek-ai/DeepSeek-V3',
    keyHint: '在 cloud.siliconflow.cn 获取',
  },
  'custom': {
    name: '自定义 (OpenAI 兼容)',
    baseUrl: '',
    defaultModel: '',
    modelHint: '输入你的模型名称',
    keyHint: '输入你的 API Key',
  },
};

async function getAISettings() {
  const data = await chrome.storage.local.get('aiSettings');
  const defaults = { provider: 'zhipu', baseUrl: '', model: '', apiKey: '' };
  return Object.assign(defaults, data.aiSettings || {});
}

async function saveAISettings(settings) {
  await chrome.storage.local.set({ aiSettings: settings });
}

/**
 * normalizeApiUrl(url)
 *
 * Ensures the endpoint URL ends with the standard OpenAI-compatible
 * chat completions path. Tolerates user input in any of these forms:
 *   https://host/v4            -> https://host/v4/chat/completions
 *   https://host/v4/           -> https://host/v4/chat/completions
 *   https://host/v4/chat/completions -> (unchanged)
 * This fixes the 404 when a Coding Plan base URL is given without the suffix.
 */
function normalizeApiUrl(url) {
  if (!url) return '';
  let u = url.trim().replace(/\/+$/, ''); // strip trailing slashes
  if (!/\/chat\/completions$/.test(u)) {
    u += '/chat/completions';
  }
  return u;
}

function resolveApiUrl(settings) {
  let url = settings.baseUrl;
  if (!url) {
    const provider = AI_PROVIDERS[settings.provider];
    if (provider && provider.baseUrl) url = provider.baseUrl;
  }
  return normalizeApiUrl(url);
}

function resolveModel(settings) {
  if (settings.model) return settings.model;
  const provider = AI_PROVIDERS[settings.provider];
  if (provider) return provider.defaultModel;
  return '';
}

async function getAICache() {
  const data = await chrome.storage.local.get('aiCategories');
  return data.aiCategories || [];
}

async function saveAICache(categories) {
  await chrome.storage.local.set({ aiCategories: categories });
}

/**
 * loadViewMode() / saveViewMode(mode)
 *
 * Persists whether the user last looked at the domain view or the AI
 * view, so a new tab page restores the same view instead of always
 * resetting to the domain view.
 */
async function loadViewMode() {
  try {
    const data = await chrome.storage.local.get('aiViewMode');
    return data.aiViewMode === 'ai' ? 'ai' : 'domain';
  } catch {
    return 'domain';
  }
}

async function saveViewMode(mode) {
  try {
    await chrome.storage.local.set({ aiViewMode: mode });
  } catch { /* non-fatal */ }
}


/* ----------------------------------------------------------------
   AI CLASSIFICATION — OpenAI-compatible Chat Completions API

   Robustness features:
   - Batches large tab sets to stay within model context/output limits
   - Strips markdown fences + balanced JSON extraction (no greedy pitfalls)
   - Dedupes tab indexes across categories (a tab is never in 2 categories)
   - Surfaces any leftover tabs as an "uncategorized" group (no tab lost)
   - Enforces a 60s request timeout via AbortController
   ---------------------------------------------------------------- */

const AI_BATCH_SIZE = 40;        // tabs per API request
const AI_REQUEST_TIMEOUT_MS = 60000;
const AI_CONCURRENCY = 3;                            // batches in flight at once
const AI_REASONING_MODEL_RE = /reasoner|thinking/i;  // skip temperature for these

/**
 * extractJSONObject(content)
 *
 * Pulls the first balanced JSON object out of a model response,
 * tolerating ```json fences and surrounding prose. Scans every "{"
 * as a candidate start and parses only at balanced "}" closings
 * (string-aware), so prose containing braces or trailing junk after
 * the JSON doesn't break extraction.
 * Returns the parsed object or null.
 */
function extractJSONObject(content) {
  if (!content) return null;
  let s = content.trim();

  // Strip a markdown code fence if present (```json ... ``` or ``` ... ```)
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();

  for (let start = s.indexOf('{'); start !== -1; start = s.indexOf('{', start + 1)) {
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < s.length; i++) {
      const ch = s[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          try { return JSON.parse(s.slice(start, i + 1)); } catch { break; }
        }
      }
    }
  }
  return null;
}

/**
 * classifyBatch(batch)
 *
 * Sends a single batch of tabs to the model and returns
 * [{ name, tabs }] with per-batch dedup + bounds checking.
 */
async function classifyBatch(batch, signal) {
  const settings = await getAISettings();
  const apiUrl = resolveApiUrl(settings);
  const model = resolveModel(settings);

  if (!settings.apiKey) throw new Error('请先在设置中配置 API Key');
  if (!apiUrl) throw new Error('请配置 API Base URL');
  if (!model) throw new Error('请配置模型名称');

  const tabInfo = batch.map((t, i) => ({
    index: i,
    title: (t.title || '').slice(0, 120),
    url: (t.url || '').slice(0, 200),
  }));

  const prompt = `你是一个浏览器标签页分类助手。请将以下 ${tabInfo.length} 个标签页按内容主题进行分类。

标签页列表：
${tabInfo.map(t => `[${t.index}] ${t.title} (${t.url})`).join('\n')}

分类要求：
1. 将相似主题的标签页归为一类
2. 常见分类示例：工作、社交媒体、购物、开发工具、文档/学习、娱乐、新闻资讯、设计工具、AI工具、通信等
3. 根据实际内容灵活分类，不必拘泥于示例
4. 每个标签页必须且只能属于一个分类
5. 你必须覆盖所有 ${tabInfo.length} 个标签页，索引范围 0~${tabInfo.length - 1}，不能遗漏任何一个

请严格按以下JSON格式返回，不要包含任何其他文字：
{"categories":[{"name":"分类名称","tabIndexes":[0,1,2]},{"name":"分类名称","tabIndexes":[3,4]}]}`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), AI_REQUEST_TIMEOUT_MS);
  // Combine the per-request timeout with any external cancel signal.
  const fetchSignal = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;

  let res;
  try {
    res = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${settings.apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: '你是一个浏览器标签页分类助手。只返回JSON，不要包含任何其他文字。确保每个标签页都被分类，不遗漏。' },
          { role: 'user', content: prompt },
        ],
        // Reasoning models spend the output budget on thinking and often
        // reject temperature tuning — omit the knob for them. A generous
        // max_tokens keeps long reasoning + JSON from being truncated.
        ...(AI_REASONING_MODEL_RE.test(model) ? {} : { temperature: 0.3 }),
        max_tokens: 8192,
      }),
      signal: fetchSignal,
    });
  } catch (err) {
    if (err.name === 'AbortError') {
      if (signal && signal.aborted) throw err; // user cancel — let it propagate
      throw new Error('API 请求超时（60s），请稍后重试或减少标签页数量');
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`API 请求失败 (${res.status}): ${errText.slice(0, 200)}`);
  }

  const data = await res.json();
  const content = data.choices?.[0]?.message?.content || '';
  const parsed = extractJSONObject(content);
  if (!parsed || !Array.isArray(parsed.categories)) {
    throw new Error('AI 返回格式异常，请重试');
  }

  const classified = new Set();
  const result = [];
  for (const cat of parsed.categories) {
    const validIndexes = (cat.tabIndexes || []).filter(i =>
      Number.isInteger(i) && i >= 0 && i < batch.length && !classified.has(i)
    );
    if (validIndexes.length === 0) continue;
    validIndexes.forEach(i => classified.add(i));
    result.push({
      name: cat.name || '未命名分类',
      tabs: validIndexes.map(i => batch[i]).filter(Boolean),
    });
  }
  return result;
}

/**
 * classifyBatchWithRetry(batch, signal, attempts = 2)
 *
 * Runs classifyBatch, retrying once on failure (network hiccups, JSON
 * glitches). User cancels propagate immediately without retry.
 */
async function classifyBatchWithRetry(batch, signal, attempts = 2) {
  let lastErr;
  for (let a = 0; a < attempts; a++) {
    try {
      return await classifyBatch(batch, signal);
    } catch (err) {
      if ((signal && signal.aborted) || err.name === 'AbortError') throw err;
      lastErr = err;
    }
  }
  throw lastErr;
}

/**
 * classifyTabsWithAI(tabs, { onProgress, signal })
 *
 * Top-level orchestrator:
 *  - dedupes tabs by URL (duplicates waste tokens; the display layer
 *    shows each URL once anyway)
 *  - splits tabs into batches and classifies them with limited
 *    concurrency instead of one-by-one
 *  - retries each failed batch once, then keeps going — one bad batch
 *    no longer throws away every other batch's work
 *  - merges categories by name and guarantees every tab from a
 *    successful batch ends up somewhere
 *  - reports progress via onProgress(doneBatches, totalBatches) and
 *    stops early when `signal` aborts
 *
 * Returns { categories, failedBatches, aborted }. Tabs from failed or
 * aborted batches are intentionally left unclassified — the reconciler
 * surfaces them in the "未分类（新打开）" group, where "仅分类新标签"
 * can pick them up cheaply.
 */
async function classifyTabsWithAI(tabs, { onProgress, signal } = {}) {
  if (!tabs || tabs.length === 0) {
    return { categories: [], failedBatches: 0, aborted: false };
  }

  const seenUrls = new Set();
  const uniqueTabs = tabs.filter(t => {
    const u = t.url || '';
    if (seenUrls.has(u)) return false;
    seenUrls.add(u);
    return true;
  });

  const batches = [];
  for (let i = 0; i < uniqueTabs.length; i += AI_BATCH_SIZE) {
    batches.push(uniqueTabs.slice(i, i + AI_BATCH_SIZE));
  }

  const batchResults = new Array(batches.length).fill(null);
  let nextBatch = 0;

  async function lane() {
    while (nextBatch < batches.length) {
      if (signal && signal.aborted) return;
      const bi = nextBatch++;
      try {
        batchResults[bi] = { ok: true, cats: await classifyBatchWithRetry(batches[bi], signal) };
      } catch (err) {
        batchResults[bi] = { ok: false, cats: [], err };
        if (signal && signal.aborted) return;
      }
      if (onProgress) onProgress(batchResults.filter(Boolean).length, batches.length);
    }
  }

  const lanes = Math.min(AI_CONCURRENCY, batches.length);
  await Promise.all(Array.from({ length: lanes }, lane));

  const failedBatches = batchResults.filter(r => r && !r.ok).length;
  const aborted = !!(signal && signal.aborted);

  // Merge successful batches, combining same-named categories.
  const merged = new Map(); // name -> { name, colorIndex, tabs }
  let colorCounter = 0;
  const coveredTabs = [];
  batchResults.forEach((r, bi) => {
    if (!r || !r.ok) return;
    coveredTabs.push(...batches[bi]);
    for (const cat of r.cats) {
      const existing = merged.get(cat.name);
      if (existing) {
        existing.tabs.push(...cat.tabs);
      } else {
        merged.set(cat.name, {
          name: cat.name,
          colorIndex: colorCounter % AI_CATEGORY_COLORS.length,
          tabs: [...cat.tabs],
        });
        colorCounter++;
      }
    }
  });

  const result = [...merged.values()];

  // Safety net: tabs the model dropped from a *successful* batch land in
  // "未分类". Tabs from failed/aborted batches stay out entirely — the
  // reconciler will offer them as "未分类（新打开）" for incremental retry.
  const seen = new Set();
  result.forEach(c => c.tabs.forEach(t => seen.add(t.url)));
  const uncategorized = coveredTabs.filter(t => !seen.has(t.url));
  if (uncategorized.length > 0) {
    result.push({
      name: '未分类',
      colorIndex: colorCounter % AI_CATEGORY_COLORS.length,
      tabs: uncategorized,
    });
  }

  return { categories: result, failedBatches, aborted };
}

/**
 * testAIConnection(settings)
 *
 * Sends a minimal chat completion to verify the endpoint/model/key
 * combo actually works, without saving anything. Throws with a
 * readable message on any failure.
 */
async function testAIConnection(settings) {
  const apiUrl = resolveApiUrl(settings);
  const model = resolveModel(settings);

  if (!settings.apiKey) throw new Error('请先填写 API Key');
  if (!apiUrl) throw new Error('请填写 API Base URL');
  if (!model) throw new Error('请填写模型名称');

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${settings.apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 1,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`HTTP ${res.status}: ${errText.slice(0, 120)}`);
    }
    await res.json();
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('连接超时（15s）');
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}


/* ----------------------------------------------------------------
   IN-MEMORY STORE FOR OPEN-TAB GROUPS
   ---------------------------------------------------------------- */
let domainGroups = [];

let aiCategories = [];

let currentViewMode = 'domain';

let aiClassifyAbort = null; // AbortController for the in-flight classification

let cardTabsRegistry = {};


/* ----------------------------------------------------------------
   HELPER: filter out browser-internal pages
   ---------------------------------------------------------------- */

/**
 * getRealTabs()
 *
 * Returns tabs that are real web pages — no chrome://, extension
 * pages, about:blank, etc.
 */
function getRealTabs() {
  return openTabs.filter(t => {
    const url = t.url || '';
    return (
      !url.startsWith('chrome://') &&
      !url.startsWith('chrome-extension://') &&
      !url.startsWith('about:') &&
      !url.startsWith('edge://') &&
      !url.startsWith('brave://')
    );
  });
}

/**
 * getClassifiableTabs()
 *
 * Real tabs that automation may act on: browser-internal pages and
 * PINNED tabs are excluded. Pinned tabs are intentionally off-limits
 * for AI classification and "close all" — users pin tabs they want
 * to keep.
 */
function getClassifiableTabs() {
  return getRealTabs().filter(t => !t.pinned);
}

/**
 * checkDashboardDupes()
 *
 * Counts how many TabHarbor pages are open. If more than 1,
 * shows a banner offering to close the extras.
 */
function checkDashboardDupes() {
  const dashboardTabs = openTabs.filter(t => t.isDashboard);
  const banner  = document.getElementById('dashboardDupeBanner');
  const countEl = document.getElementById('dashboardDupeCount');
  if (!banner) return;

  if (dashboardTabs.length > 1) {
    if (countEl) countEl.textContent = dashboardTabs.length;
    banner.style.display = 'flex';
  } else {
    banner.style.display = 'none';
  }
}


/* ----------------------------------------------------------------
   AI CATEGORY VIEW RENDERER
   ---------------------------------------------------------------- */

function renderAICategoryView(categories) {
  if (!categories || categories.length === 0) return '';

  return categories
    .filter(cat => cat.tabs && cat.tabs.length > 0)
    .map((cat, ci) => {
      const color = AI_CATEGORY_COLORS[cat.colorIndex] || AI_CATEGORY_COLORS[0];
      const tabCount = cat.tabs.length;
      const domainGroupsInCat = groupTabsByDomain(cat.tabs);
      const cardsHtml = domainGroupsInCat
        .map((g, gi) => renderDomainCard(g, `ai-${ci}-${gi}`)).join('');

      // The holding pen for tabs opened after the last classification
      // gets a one-click incremental classify button.
      const classifyNewBtn = cat.name === '未分类（新打开）'
        ? ` <button class="action-btn close-tabs" data-action="classify-new-tabs" style="font-size:11px;padding:3px 10px;">${ICONS.tabs} 仅分类新标签</button>`
        : '';

      return `
        <div class="ai-category-section">
          <div class="ai-category-header">
            <div class="ai-category-icon" style="background:${color.bg};border:1px solid ${color.border};">
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="${color.text}" style="width:16px;height:16px"><path stroke-linecap="round" stroke-linejoin="round" d="M9.813 15.904 9 18.75l-.813-2.846a4.5 4.5 0 0 0-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 0 0 3.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 0 0 3.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 0 0-3.09 3.09Z" /></svg>
            </div>
            <span class="ai-category-name" style="color:${color.text}">${escapeHtml(cat.name)}</span>
            <span class="ai-category-count">${tabCount} tab${tabCount !== 1 ? 's' : ''}</span>${classifyNewBtn}
          </div>
          <div class="ai-category-cards missions">${cardsHtml}</div>
        </div>`;
    }).join('');
}

function groupTabsByDomain(tabs) {
  const groupMap = {};
  for (const tab of tabs) {
    let hostname;
    try {
      if (tab.url && tab.url.startsWith('file://')) {
        hostname = 'local-files';
      } else {
        hostname = new URL(tab.url).hostname;
      }
    } catch { continue; }
    if (!hostname) continue;
    if (!groupMap[hostname]) groupMap[hostname] = { domain: hostname, tabs: [] };
    groupMap[hostname].tabs.push(tab);
  }
  return Object.values(groupMap).sort((a, b) => b.tabs.length - a.tabs.length);
}


/* ----------------------------------------------------------------
   VIEW MODE SWITCHING
   ---------------------------------------------------------------- */

function updateViewToggle() {
  const toggleBtn = document.getElementById('toggleViewBtn');
  const toggleLabel = document.getElementById('toggleViewLabel');
  if (!toggleBtn || !toggleLabel) return;

  if (aiCategories.length > 0) {
    toggleBtn.style.display = 'inline-flex';
    if (currentViewMode === 'domain') {
      toggleLabel.textContent = '按域名';
      toggleBtn.classList.remove('active');
    } else {
      toggleLabel.textContent = 'AI 分类';
      toggleBtn.classList.add('active');
    }
  } else {
    toggleBtn.style.display = 'none';
  }
}

function renderCurrentView() {
  const openTabsMissionsEl = document.getElementById('openTabsMissions');
  if (!openTabsMissionsEl) return;

  // Reset the card→tabs registry on every full render so stale entries
  // from a previous render (or closed cards) don't linger.
  cardTabsRegistry = {};

  if (currentViewMode === 'ai' && aiCategories.length > 0) {
    // Reconcile cached AI categories against currently-open tabs:
    // drop closed tabs, dedupe across categories, and surface new tabs.
    const liveCategories = reconcileAICategories();
    const totalLive = liveCategories.reduce((s, c) => s + c.tabs.length, 0);

    if (totalLive === 0) {
      // Nothing left to show in AI view — fall back to domain view.
      currentViewMode = 'domain';
      saveViewMode('domain');
    } else {
      aiCategories = liveCategories;
      document.getElementById('openTabsSectionTitle').textContent = 'AI 分类';
      document.getElementById('openTabsSectionCount').innerHTML =
        `${liveCategories.length} 个分类 · ${totalLive} 个标签页 &nbsp;&middot;&nbsp; <button class="action-btn close-tabs" data-action="clear-ai-classify" style="font-size:11px;padding:3px 10px;">${ICONS.close} 清除分类</button> <button class="action-btn close-tabs" data-action="close-all-open-tabs" style="font-size:11px;padding:3px 10px;">${ICONS.close} 关闭所有 ${totalLive} 个标签页</button>`;
      openTabsMissionsEl.innerHTML = renderAICategoryView(liveCategories);
      updateViewToggle();
      return;
    }
  }

  // Domain view (also the fallback when AI view is empty)
  document.getElementById('openTabsSectionTitle').textContent = 'Open tabs';
  document.getElementById('openTabsSectionCount').innerHTML =
    `${domainGroups.length} domain${domainGroups.length !== 1 ? 's' : ''} &nbsp;&middot;&nbsp; <button class="action-btn close-tabs" data-action="close-all-open-tabs" style="font-size:11px;padding:3px 10px;">${ICONS.close} Close all ${getClassifiableTabs().length} tabs</button>`;
  openTabsMissionsEl.innerHTML = domainGroups.map(g => renderDomainCard(g)).join('');
  updateViewToggle();
}


/**
 * reconcileAICategories()
 *
 * Aligns the cached AI classification with the live set of open tabs:
 *  - removes tabs that have been closed
 *  - drops a tab if it appears in multiple categories (keeps first)
 *  - collects tabs opened after the last classification into an
 *    "未分类（新打开）" group so nothing is silently hidden
 */
function reconcileAICategories() {
  const openUrls = new Set(getRealTabs().map(t => t.url));
  const seen = new Set();
  const result = [];

  for (const cat of aiCategories) {
    const liveTabs = (cat.tabs || []).filter(t => {
      if (!openUrls.has(t.url)) return false;
      if (seen.has(t.url)) return false;
      seen.add(t.url);
      return true;
    });
    if (liveTabs.length > 0) {
      result.push({ ...cat, tabs: liveTabs });
    }
  }

  // Only offer *classifiable* tabs as "new" — pinned tabs are excluded
  // from classification entirely.
  const newTabs = getClassifiableTabs().filter(t => !seen.has(t.url));
  if (newTabs.length > 0) {
    result.push({
      name: '未分类（新打开）',
      colorIndex: result.length % AI_CATEGORY_COLORS.length,
      tabs: newTabs,
    });
  }

  return result;
}


/* ----------------------------------------------------------------
   OVERFLOW CHIPS ("+N more" expand button in domain cards)
   ---------------------------------------------------------------- */

function buildOverflowChips(hiddenTabs, urlCounts = {}) {
  const hiddenChips = hiddenTabs.map(tab => {
    const label    = cleanTitle(smartTitle(stripTitleNoise(tab.title || ''), tab.url), '');
    const count    = urlCounts[tab.url] || 1;
    const dupeTag  = count > 1 ? ` <span class="chip-dupe-badge">(${count}x)</span>` : '';
    const chipClass = count > 1 ? ' chip-has-dupes' : '';
    const safeUrl   = escapeHtml(tab.url || '');
    const safeTitle = escapeHtml(label);
    let domain = '';
    try { domain = new URL(tab.url).hostname; } catch {}
    const faviconUrl = domain ? `https://www.google.com/s2/favicons?domain=${domain}&sz=16` : '';
    return `<div class="page-chip clickable${chipClass}" data-action="focus-tab" data-tab-url="${safeUrl}" title="${safeTitle}">
      ${faviconUrl ? `<img class="chip-favicon" src="${faviconUrl}" alt="">` : ''}
      <span class="chip-text">${safeTitle}</span>${dupeTag}
      <div class="chip-actions">
        <button class="chip-action chip-save" data-action="defer-single-tab" data-tab-url="${safeUrl}" data-tab-title="${safeTitle}" title="Save for later">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M17.593 3.322c1.1.128 1.907 1.077 1.907 2.185V21L12 17.25 4.5 21V5.507c0-1.108.806-2.057 1.907-2.185a48.507 48.507 0 0 1 11.186 0Z" /></svg>
        </button>
        <button class="chip-action chip-close" data-action="close-single-tab" data-tab-url="${safeUrl}" title="Close this tab">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
        </button>
      </div>
    </div>`;
  }).join('');

  return `
    <div class="page-chips-overflow" style="display:none">${hiddenChips}</div>
    <div class="page-chip page-chip-overflow clickable" data-action="expand-chips">
      <span class="chip-text">+${hiddenTabs.length} more</span>
    </div>`;
}


/* ----------------------------------------------------------------
   DOMAIN CARD RENDERER
   ---------------------------------------------------------------- */

/**
 * renderDomainCard(group, groupIndex)
 *
 * Builds the HTML for one domain group card.
 * group = { domain: string, tabs: [{ url, title, id, windowId, active }] }
 */
function renderDomainCard(group, cardKeyOverride) {
  const tabs      = group.tabs || [];
  const tabCount  = tabs.length;
  const isLanding = group.domain === '__landing-pages__';
  const cardKey   = cardKeyOverride || ('domain-' + group.domain.replace(/[^a-z0-9]/g, '-'));

  // Register this card's actual tabs (incl. dupes) so close actions
  // close exactly what's shown — works correctly in both views and
  // fixes the AI-view over-close bug.
  cardTabsRegistry[cardKey] = tabs;

  // Count duplicates (exact URL match)
  const urlCounts = {};
  for (const tab of tabs) urlCounts[tab.url] = (urlCounts[tab.url] || 0) + 1;
  const dupeUrls   = Object.entries(urlCounts).filter(([, c]) => c > 1);
  const hasDupes   = dupeUrls.length > 0;
  const totalExtras = dupeUrls.reduce((s, [, c]) => s + c - 1, 0);

  const tabBadge = `<span class="open-tabs-badge">
    ${ICONS.tabs}
    ${tabCount} tab${tabCount !== 1 ? 's' : ''} open
  </span>`;

  const dupeBadge = hasDupes
    ? `<span class="open-tabs-badge" style="color:var(--accent-amber);background:rgba(200,113,58,0.08);">
        ${totalExtras} duplicate${totalExtras !== 1 ? 's' : ''}
      </span>`
    : '';

  // Deduplicate for display: show each URL once, with (Nx) badge if duped
  const seen = new Set();
  const uniqueTabs = [];
  for (const tab of tabs) {
    if (!seen.has(tab.url)) { seen.add(tab.url); uniqueTabs.push(tab); }
  }

  const visibleTabs = uniqueTabs.slice(0, 8);
  const extraCount  = uniqueTabs.length - visibleTabs.length;

  const pageChips = visibleTabs.map(tab => {
    let label = cleanTitle(smartTitle(stripTitleNoise(tab.title || ''), tab.url), group.domain);
    // For localhost tabs, prepend port number so you can tell projects apart
    try {
      const parsed = new URL(tab.url);
      if (parsed.hostname === 'localhost' && parsed.port) label = `${parsed.port} ${label}`;
    } catch {}
    const count    = urlCounts[tab.url];
    const dupeTag  = count > 1 ? ` <span class="chip-dupe-badge">(${count}x)</span>` : '';
    const chipClass = count > 1 ? ' chip-has-dupes' : '';
    const safeUrl   = escapeHtml(tab.url || '');
    const safeTitle = escapeHtml(label);
    let domain = '';
    try { domain = new URL(tab.url).hostname; } catch {}
    const faviconUrl = domain ? `https://www.google.com/s2/favicons?domain=${domain}&sz=16` : '';
    return `<div class="page-chip clickable${chipClass}" data-action="focus-tab" data-tab-url="${safeUrl}" title="${safeTitle}">
      ${faviconUrl ? `<img class="chip-favicon" src="${faviconUrl}" alt="">` : ''}
      <span class="chip-text">${safeTitle}</span>${dupeTag}
      <div class="chip-actions">
        <button class="chip-action chip-save" data-action="defer-single-tab" data-tab-url="${safeUrl}" data-tab-title="${safeTitle}" title="Save for later">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M17.593 3.322c1.1.128 1.907 1.077 1.907 2.185V21L12 17.25 4.5 21V5.507c0-1.108.806-2.057 1.907-2.185a48.507 48.507 0 0 1 11.186 0Z" /></svg>
        </button>
        <button class="chip-action chip-close" data-action="close-single-tab" data-tab-url="${safeUrl}" title="Close this tab">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
        </button>
      </div>
    </div>`;
  }).join('') + (extraCount > 0 ? buildOverflowChips(uniqueTabs.slice(8), urlCounts) : '');

  let actionsHtml = `
    <button class="action-btn close-tabs" data-action="close-domain-tabs" data-card-key="${cardKey}">
      ${ICONS.close}
      Close all ${tabCount} tab${tabCount !== 1 ? 's' : ''}
    </button>`;

  if (hasDupes) {
    const dupeUrlsEncoded = dupeUrls.map(([url]) => encodeURIComponent(url)).join(',');
    actionsHtml += `
      <button class="action-btn" data-action="dedup-keep-one" data-dupe-urls="${dupeUrlsEncoded}">
        Close ${totalExtras} duplicate${totalExtras !== 1 ? 's' : ''}
      </button>`;
  }

  return `
    <div class="mission-card domain-card ${hasDupes ? 'has-amber-bar' : 'has-neutral-bar'}" data-card-key="${cardKey}">
      <div class="status-bar"></div>
      <div class="mission-content">
        <div class="mission-top">
          <span class="mission-name">${isLanding ? 'Homepages' : escapeHtml(group.label || friendlyDomain(group.domain))}</span>
          ${tabBadge}
          ${dupeBadge}
        </div>
        <div class="mission-pages">${pageChips}</div>
        <div class="actions">${actionsHtml}</div>
      </div>
      <div class="mission-meta">
        <div class="mission-page-count">${tabCount}</div>
        <div class="mission-page-label">tabs</div>
      </div>
    </div>`;
}


/* ----------------------------------------------------------------
   SAVED FOR LATER — Render Checklist Column
   ---------------------------------------------------------------- */

/**
 * renderDeferredColumn()
 *
 * Reads saved tabs from chrome.storage.local and renders the right-side
 * "Saved for Later" checklist column. Shows active items as a checklist
 * and completed items in a collapsible archive.
 */
async function renderDeferredColumn() {
  const column         = document.getElementById('deferredColumn');
  const list           = document.getElementById('deferredList');
  const empty          = document.getElementById('deferredEmpty');
  const countEl        = document.getElementById('deferredCount');
  const archiveEl      = document.getElementById('deferredArchive');
  const archiveCountEl = document.getElementById('archiveCount');
  const archiveList    = document.getElementById('archiveList');

  if (!column) return;

  try {
    const { active, archived } = await getSavedTabs();

    // Hide the entire column if there's nothing to show
    if (active.length === 0 && archived.length === 0) {
      column.style.display = 'none';
      return;
    }

    column.style.display = 'block';

    // Render active checklist items
    if (active.length > 0) {
      countEl.textContent = `${active.length} item${active.length !== 1 ? 's' : ''}`;
      list.innerHTML = active.map(item => renderDeferredItem(item)).join('');
      list.style.display = 'block';
      empty.style.display = 'none';
    } else {
      list.style.display = 'none';
      countEl.textContent = '';
      empty.style.display = 'block';
    }

    // Render archive section
    if (archived.length > 0) {
      archiveCountEl.textContent = `(${archived.length})`;
      archiveList.innerHTML = archived.map(item => renderArchiveItem(item)).join('');
      archiveEl.style.display = 'block';
    } else {
      archiveEl.style.display = 'none';
    }

  } catch (err) {
    console.warn('[tabharbor] Could not load saved tabs:', err);
    column.style.display = 'none';
  }
}

/**
 * renderDeferredItem(item)
 *
 * Builds HTML for one active checklist item: checkbox, title link,
 * domain, time ago, dismiss button.
 */
function renderDeferredItem(item) {
  let domain = '';
  try { domain = new URL(item.url).hostname.replace(/^www\./, ''); } catch {}
  const faviconUrl = `https://www.google.com/s2/favicons?domain=${domain}&sz=16`;
  const ago = timeAgo(item.savedAt);

  return `
    <div class="deferred-item" data-deferred-id="${item.id}">
      <input type="checkbox" class="deferred-checkbox" data-action="check-deferred" data-deferred-id="${item.id}">
      <div class="deferred-info">
        <a href="${item.url}" target="_blank" rel="noopener" class="deferred-title" title="${escapeHtml(item.title || '')}">
          <img src="${faviconUrl}" alt="" style="width:14px;height:14px;vertical-align:-2px;margin-right:4px">${escapeHtml(item.title || item.url)}
        </a>
        <div class="deferred-meta">
          <span>${domain}</span>
          <span>${ago}</span>
        </div>
      </div>
      <button class="deferred-dismiss" data-action="dismiss-deferred" data-deferred-id="${item.id}" title="Dismiss">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
      </button>
    </div>`;
}

/**
 * renderArchiveItem(item)
 *
 * Builds HTML for one completed/archived item (simpler: just title + date).
 */
function renderArchiveItem(item) {
  const ago = item.completedAt ? timeAgo(item.completedAt) : timeAgo(item.savedAt);
  return `
    <div class="archive-item">
      <a href="${item.url}" target="_blank" rel="noopener" class="archive-item-title" title="${escapeHtml(item.title || '')}">
        ${escapeHtml(item.title || item.url)}
      </a>
      <span class="archive-item-date">${ago}</span>
    </div>`;
}


/* ----------------------------------------------------------------
   MAIN DASHBOARD RENDERER
   ---------------------------------------------------------------- */

/**
 * renderStaticDashboard()
 *
 * The main render function:
 * 1. Paints greeting + date
 * 2. Fetches open tabs via chrome.tabs.query()
 * 3. Groups tabs by domain (with landing pages pulled out to their own group)
 * 4. Renders domain cards
 * 5. Updates footer stats
 * 6. Renders the "Saved for Later" checklist
 */
async function renderStaticDashboard() {
  // --- Header ---
  const greetingEl = document.getElementById('greeting');
  const dateEl     = document.getElementById('dateDisplay');
  if (greetingEl) greetingEl.textContent = getGreeting();
  if (dateEl)     dateEl.textContent     = getDateDisplay();

  // --- Fetch tabs ---
  await fetchOpenTabs();
  const realTabs = getRealTabs();

  // --- Group tabs by domain ---
  // Landing pages (Gmail inbox, Twitter home, etc.) get their own special group
  // so they can be closed together without affecting content tabs on the same domain.
  const LANDING_PAGE_PATTERNS = [
    { hostname: 'mail.google.com', test: (p, h) =>
        !h.includes('#inbox/') && !h.includes('#sent/') && !h.includes('#search/') },
    { hostname: 'x.com',               pathExact: ['/home'] },
    { hostname: 'www.linkedin.com',    pathExact: ['/'] },
    { hostname: 'github.com',          pathExact: ['/'] },
    { hostname: 'www.youtube.com',     pathExact: ['/'] },
    // Merge personal patterns from config.local.js (if it exists)
    ...(typeof LOCAL_LANDING_PAGE_PATTERNS !== 'undefined' ? LOCAL_LANDING_PAGE_PATTERNS : []),
  ];

  function isLandingPage(url) {
    try {
      const parsed = new URL(url);
      return LANDING_PAGE_PATTERNS.some(p => {
        // Support both exact hostname and suffix matching (for wildcard subdomains)
        const hostnameMatch = p.hostname
          ? parsed.hostname === p.hostname
          : p.hostnameEndsWith
            ? parsed.hostname.endsWith(p.hostnameEndsWith)
            : false;
        if (!hostnameMatch) return false;
        if (p.test)       return p.test(parsed.pathname, url);
        if (p.pathPrefix) return parsed.pathname.startsWith(p.pathPrefix);
        if (p.pathExact)  return p.pathExact.includes(parsed.pathname);
        return parsed.pathname === '/';
      });
    } catch { return false; }
  }

  domainGroups = [];
  const groupMap    = {};
  const landingTabs = [];

  // Custom group rules from config.local.js (if any)
  const customGroups = typeof LOCAL_CUSTOM_GROUPS !== 'undefined' ? LOCAL_CUSTOM_GROUPS : [];

  // Check if a URL matches a custom group rule; returns the rule or null
  function matchCustomGroup(url) {
    try {
      const parsed = new URL(url);
      return customGroups.find(r => {
        const hostMatch = r.hostname
          ? parsed.hostname === r.hostname
          : r.hostnameEndsWith
            ? parsed.hostname.endsWith(r.hostnameEndsWith)
            : false;
        if (!hostMatch) return false;
        if (r.pathPrefix) return parsed.pathname.startsWith(r.pathPrefix);
        return true; // hostname matched, no path filter
      }) || null;
    } catch { return null; }
  }

  for (const tab of realTabs) {
    try {
      if (isLandingPage(tab.url)) {
        landingTabs.push(tab);
        continue;
      }

      // Check custom group rules first (e.g. merge subdomains, split by path)
      const customRule = matchCustomGroup(tab.url);
      if (customRule) {
        const key = customRule.groupKey;
        if (!groupMap[key]) groupMap[key] = { domain: key, label: customRule.groupLabel, tabs: [] };
        groupMap[key].tabs.push(tab);
        continue;
      }

      let hostname;
      if (tab.url && tab.url.startsWith('file://')) {
        hostname = 'local-files';
      } else {
        hostname = new URL(tab.url).hostname;
      }
      if (!hostname) continue;

      if (!groupMap[hostname]) groupMap[hostname] = { domain: hostname, tabs: [] };
      groupMap[hostname].tabs.push(tab);
    } catch {
      // Skip malformed URLs
    }
  }

  if (landingTabs.length > 0) {
    groupMap['__landing-pages__'] = { domain: '__landing-pages__', tabs: landingTabs };
  }

  // Sort: landing pages first, then domains from landing page sites, then by tab count
  // Collect exact hostnames and suffix patterns for priority sorting
  const landingHostnames = new Set(LANDING_PAGE_PATTERNS.map(p => p.hostname).filter(Boolean));
  const landingSuffixes = LANDING_PAGE_PATTERNS.map(p => p.hostnameEndsWith).filter(Boolean);
  function isLandingDomain(domain) {
    if (landingHostnames.has(domain)) return true;
    return landingSuffixes.some(s => domain.endsWith(s));
  }
  domainGroups = Object.values(groupMap).sort((a, b) => {
    const aIsLanding = a.domain === '__landing-pages__';
    const bIsLanding = b.domain === '__landing-pages__';
    if (aIsLanding !== bIsLanding) return aIsLanding ? -1 : 1;

    const aIsPriority = isLandingDomain(a.domain);
    const bIsPriority = isLandingDomain(b.domain);
    if (aIsPriority !== bIsPriority) return aIsPriority ? -1 : 1;

    return b.tabs.length - a.tabs.length;
  });

  // --- Render domain cards ---
  const openTabsSection      = document.getElementById('openTabsSection');
  const openTabsMissionsEl   = document.getElementById('openTabsMissions');

  if (domainGroups.length > 0 && openTabsSection) {
    openTabsSection.style.display = 'block';
    renderCurrentView();
  } else if (openTabsSection) {
    openTabsSection.style.display = 'none';
  }

  // --- Footer stats ---
  const statTabs = document.getElementById('statTabs');
  if (statTabs) statTabs.textContent = openTabs.length;

  // --- Check for duplicate TabHarbor tabs ---
  checkDashboardDupes();

  // --- Render "Saved for Later" column ---
  await renderDeferredColumn();
}

async function renderDashboard() {
  await renderStaticDashboard();
}


/* ----------------------------------------------------------------
   EVENT HANDLERS — using event delegation

   One listener on document handles ALL button clicks.
   Think of it as one security guard watching the whole building
   instead of one per door.
   ---------------------------------------------------------------- */

document.addEventListener('click', async (e) => {
  const actionEl = e.target.closest('[data-action]');
  if (!actionEl) return;

  const action = actionEl.dataset.action;

  // ---- Open settings modal ----
  if (action === 'open-settings') {
    const modal = document.getElementById('settingsModal');
    const statusEl = document.getElementById('settingsStatus');
    if (modal) {
      modal.style.display = 'flex';
      if (statusEl) { statusEl.textContent = ''; statusEl.className = 'setting-status'; }
      const settings = await getAISettings();
      document.getElementById('providerSelect').value = settings.provider || 'zhipu';
      document.getElementById('apiKeyInput').value = settings.apiKey || '';
      document.getElementById('modelInput').value = settings.model || '';
      document.getElementById('baseUrlInput').value = settings.baseUrl || '';
      updateProviderUI();
    }
    return;
  }

  // ---- Close settings modal ----
  if (action === 'close-settings') {
    const modal = document.getElementById('settingsModal');
    if (modal) modal.style.display = 'none';
    return;
  }

  // ---- Save settings ----
  if (action === 'save-settings') {
    const provider = document.getElementById('providerSelect').value;
    const model = document.getElementById('modelInput').value.trim();
    const apiKey = document.getElementById('apiKeyInput').value.trim();
    const statusEl = document.getElementById('settingsStatus');

    // Built-in providers always use their official endpoint — the (hidden)
    // Base URL field is ignored so a value typed for another provider can
    // never leak into this one's config.
    const providerInfo = AI_PROVIDERS[provider];
    const baseUrl = (providerInfo && providerInfo.baseUrl)
      ? ''
      : document.getElementById('baseUrlInput').value.trim();

    if (!apiKey) {
      if (statusEl) { statusEl.textContent = '请输入 API Key'; statusEl.className = 'setting-status error'; }
      return;
    }
    if (!baseUrl && !(providerInfo && providerInfo.baseUrl)) {
      if (statusEl) { statusEl.textContent = '请输入 API Base URL'; statusEl.className = 'setting-status error'; }
      return;
    }

    await saveAISettings({ provider, baseUrl, model, apiKey });
    if (statusEl) { statusEl.textContent = '设置已保存'; statusEl.className = 'setting-status success'; }
    setTimeout(() => { document.getElementById('settingsModal').style.display = 'none'; }, 800);
    return;
  }

  // ---- Test the AI connection with the values currently in the form ----
  if (action === 'test-connection') {
    const provider = document.getElementById('providerSelect').value;
    const model = document.getElementById('modelInput').value.trim();
    const apiKey = document.getElementById('apiKeyInput').value.trim();
    const baseUrl = document.getElementById('baseUrlInput').value.trim();
    const statusEl = document.getElementById('settingsStatus');
    const testBtn = actionEl;

    if (statusEl) { statusEl.textContent = '测试中…'; statusEl.className = 'setting-status'; }
    if (testBtn) testBtn.disabled = true;
    try {
      await testAIConnection({ provider, baseUrl, model, apiKey });
      if (statusEl) { statusEl.textContent = '连接成功 ✓'; statusEl.className = 'setting-status success'; }
    } catch (err) {
      if (statusEl) { statusEl.textContent = '连接失败: ' + err.message; statusEl.className = 'setting-status error'; }
    } finally {
      if (testBtn) testBtn.disabled = false;
    }
    return;
  }

  // ---- AI classify tabs ----
  if (action === 'ai-classify') {
    const settings = await getAISettings();
    if (!settings.apiKey) {
      const modal = document.getElementById('settingsModal');
      const statusEl = document.getElementById('settingsStatus');
      if (modal) {
        modal.style.display = 'flex';
        if (statusEl) { statusEl.textContent = '请先配置 API Key'; statusEl.className = 'setting-status error'; }
      }
      return;
    }

    const loadingOverlay = document.getElementById('aiLoadingOverlay');
    const loadingSub = document.getElementById('aiLoadingSub');
    const classifyBtn = document.getElementById('aiClassifyBtn');
    aiClassifyAbort = new AbortController();
    try {
      if (loadingOverlay) loadingOverlay.style.display = 'flex';
      if (loadingSub) loadingSub.textContent = '准备中…';
      if (classifyBtn) classifyBtn.disabled = true;

      const realTabs = getClassifiableTabs(); // pinned tabs stay untouched
      if (realTabs.length === 0) {
        showToast('没有可分类的标签页');
        return;
      }

      const { categories, failedBatches, aborted } = await classifyTabsWithAI(realTabs, {
        signal: aiClassifyAbort.signal,
        onProgress: (done, total) => {
          if (loadingSub) loadingSub.textContent = `批次 ${done}/${total}…`;
        },
      });

      if (categories.length > 0) {
        aiCategories = categories;
        currentViewMode = 'ai';
        await saveAICache(categories);
        await saveViewMode('ai');
        renderCurrentView();
      }

      const totalClassified = categories.reduce((s, c) => s + c.tabs.length, 0);
      if (aborted) {
        showToast(`已取消：已分类 ${totalClassified}/${realTabs.length} 个，剩余在「未分类（新打开）」`);
      } else if (failedBatches > 0) {
        showToast(`${failedBatches} 个批次失败：已分类 ${totalClassified}/${realTabs.length} 个，可用「仅分类新标签」重试`);
      } else {
        showToast(`AI 已将 ${totalClassified}/${realTabs.length} 个标签页分为 ${categories.length} 类`);
      }
    } catch (err) {
      console.error('[tabharbor] AI classify failed:', err);
      showToast('AI 分类失败: ' + err.message);
    } finally {
      aiClassifyAbort = null;
      if (loadingOverlay) loadingOverlay.style.display = 'none';
      if (classifyBtn) classifyBtn.disabled = false;
    }
    return;
  }

  // ---- Cancel a running AI classification ----
  if (action === 'cancel-ai-classify') {
    if (aiClassifyAbort) aiClassifyAbort.abort();
    return;
  }

  // ---- Toggle view mode ----
  if (action === 'toggle-view') {
    currentViewMode = currentViewMode === 'domain' ? 'ai' : 'domain';
    saveViewMode(currentViewMode);
    renderCurrentView();
    return;
  }

  // ---- Classify only the tabs opened after the last run ----
  if (action === 'classify-new-tabs') {
    const settings = await getAISettings();
    if (!settings.apiKey) {
      const modal = document.getElementById('settingsModal');
      const statusEl = document.getElementById('settingsStatus');
      if (modal) {
        modal.style.display = 'flex';
        if (statusEl) { statusEl.textContent = '请先配置 API Key'; statusEl.className = 'setting-status error'; }
      }
      return;
    }

    const classifiedUrls = new Set();
    aiCategories.forEach(c => (c.tabs || []).forEach(t => classifiedUrls.add(t.url)));
    const newTabs = getClassifiableTabs().filter(t => !classifiedUrls.has(t.url));
    if (newTabs.length === 0) {
      showToast('没有需要分类的新标签页');
      return;
    }

    const loadingOverlay = document.getElementById('aiLoadingOverlay');
    const loadingSub = document.getElementById('aiLoadingSub');
    const classifyBtn = document.getElementById('aiClassifyBtn');
    aiClassifyAbort = new AbortController();
    try {
      if (loadingOverlay) loadingOverlay.style.display = 'flex';
      if (loadingSub) loadingSub.textContent = '准备中…';
      if (classifyBtn) classifyBtn.disabled = true;

      const { categories, failedBatches, aborted } = await classifyTabsWithAI(newTabs, {
        signal: aiClassifyAbort.signal,
        onProgress: (done, total) => {
          if (loadingSub) loadingSub.textContent = `批次 ${done}/${total}…`;
        },
      });

      // Merge the new categories into the existing classification.
      for (const cat of categories) {
        const existing = aiCategories.find(c => c.name === cat.name);
        if (existing) existing.tabs.push(...cat.tabs);
        else aiCategories.push(cat);
      }
      // The "new tabs" holding pen is obsolete once its tabs are classified.
      aiCategories = aiCategories.filter(c => c.name !== '未分类（新打开）' && (c.tabs || []).length > 0);

      currentViewMode = 'ai';
      await saveAICache(aiCategories);
      await saveViewMode('ai');
      renderCurrentView();

      const totalNew = categories.reduce((s, c) => s + c.tabs.length, 0);
      if (aborted) showToast(`已取消：本次分类 ${totalNew}/${newTabs.length} 个`);
      else if (failedBatches > 0) showToast(`${failedBatches} 个批次失败，可再次点击「仅分类新标签」重试`);
      else showToast(`已将 ${totalNew} 个新标签页并入分类`);
    } catch (err) {
      console.error('[tabharbor] AI classify (new tabs) failed:', err);
      showToast('AI 分类失败: ' + err.message);
    } finally {
      aiClassifyAbort = null;
      if (loadingOverlay) loadingOverlay.style.display = 'none';
      if (classifyBtn) classifyBtn.disabled = false;
    }
    return;
  }

  // ---- Clear the AI classification cache ----
  if (action === 'clear-ai-classify') {
    aiCategories = [];
    await saveAICache([]);
    currentViewMode = 'domain';
    await saveViewMode('domain');
    renderCurrentView();
    showToast('已清除 AI 分类');
    return;
  }

  // ---- Close duplicate TabHarbor tabs ----
  if (action === 'close-duplicate-dashboards') {
    await closeDashboardDupes();
    playCloseSound();
    const banner = document.getElementById('dashboardDupeBanner');
    if (banner) {
      banner.style.transition = 'opacity 0.4s';
      banner.style.opacity = '0';
      setTimeout(() => { banner.style.display = 'none'; banner.style.opacity = '1'; }, 400);
    }
    showToast('Closed extra TabHarbor tabs');
    return;
  }

  const card = actionEl.closest('.mission-card');

  // ---- Expand overflow chips ("+N more") ----
  if (action === 'expand-chips') {
    const overflowContainer = actionEl.parentElement.querySelector('.page-chips-overflow');
    if (overflowContainer) {
      overflowContainer.style.display = 'contents';
      actionEl.remove();
    }
    return;
  }

  // ---- Focus a specific tab ----
  if (action === 'focus-tab') {
    const tabUrl = actionEl.dataset.tabUrl;
    if (tabUrl) await focusTab(tabUrl);
    return;
  }

  // ---- Close a single tab ----
  if (action === 'close-single-tab') {
    e.stopPropagation(); // don't trigger parent chip's focus-tab
    const tabUrl = actionEl.dataset.tabUrl;
    if (!tabUrl) return;

    // Close the tab in Chrome directly
    const allTabs = await chrome.tabs.query({});
    const match   = allTabs.find(t => t.url === tabUrl);
    if (match) await chrome.tabs.remove(match.id);
    await fetchOpenTabs();

    // Keep in-memory stores consistent so AI view stays accurate.
    domainGroups.forEach(g => { g.tabs = g.tabs.filter(t => t.url !== tabUrl); });
    domainGroups = domainGroups.filter(g => g.tabs.length > 0);
    aiCategories.forEach(cat => { cat.tabs = cat.tabs.filter(t => t.url !== tabUrl); });
    aiCategories = aiCategories.filter(cat => cat.tabs.length > 0);

    playCloseSound();

    // Animate the chip row out
    const chip = actionEl.closest('.page-chip');
    if (chip) {
      const rect = chip.getBoundingClientRect();
      shootConfetti(rect.left + rect.width / 2, rect.top + rect.height / 2);
      chip.style.transition = 'opacity 0.2s, transform 0.2s';
      chip.style.opacity    = '0';
      chip.style.transform  = 'scale(0.8)';
      setTimeout(() => {
        chip.remove();
        // If the card now has no tabs, remove it too
        const parentCard = document.querySelector('.mission-card:has(.mission-pages:empty)');
        if (parentCard) animateCardOut(parentCard);
        document.querySelectorAll('.mission-card').forEach(c => {
          if (c.querySelectorAll('.page-chip[data-action="focus-tab"]').length === 0) {
            animateCardOut(c);
          }
        });
      }, 200);
    }

    // Update footer
    const statTabs = document.getElementById('statTabs');
    if (statTabs) statTabs.textContent = openTabs.length;

    showToast('Tab closed');
    return;
  }

  // ---- Save a single tab for later (then close it) ----
  if (action === 'defer-single-tab') {
    e.stopPropagation();
    const tabUrl   = actionEl.dataset.tabUrl;
    const tabTitle = actionEl.dataset.tabTitle || tabUrl;
    if (!tabUrl) return;

    // Save to chrome.storage.local
    try {
      await saveTabForLater({ url: tabUrl, title: tabTitle });
    } catch (err) {
      console.error('[tabharbor] Failed to save tab:', err);
      showToast('Failed to save tab');
      return;
    }

    // Close the tab in Chrome
    const allTabs = await chrome.tabs.query({});
    const match   = allTabs.find(t => t.url === tabUrl);
    if (match) await chrome.tabs.remove(match.id);
    await fetchOpenTabs();

    // Animate chip out
    const chip = actionEl.closest('.page-chip');
    if (chip) {
      chip.style.transition = 'opacity 0.2s, transform 0.2s';
      chip.style.opacity    = '0';
      chip.style.transform  = 'scale(0.8)';
      setTimeout(() => chip.remove(), 200);
    }

    showToast('Saved for later');
    await renderDeferredColumn();
    return;
  }

  // ---- Check off a saved tab (moves it to archive) ----
  if (action === 'check-deferred') {
    const id = actionEl.dataset.deferredId;
    if (!id) return;

    await checkOffSavedTab(id);

    // Animate: strikethrough first, then slide out
    const item = actionEl.closest('.deferred-item');
    if (item) {
      item.classList.add('checked');
      setTimeout(() => {
        item.classList.add('removing');
        setTimeout(() => {
          item.remove();
          renderDeferredColumn(); // refresh counts and archive
        }, 300);
      }, 800);
    }
    return;
  }

  // ---- Dismiss a saved tab (removes it entirely) ----
  if (action === 'dismiss-deferred') {
    const id = actionEl.dataset.deferredId;
    if (!id) return;

    await dismissSavedTab(id);

    const item = actionEl.closest('.deferred-item');
    if (item) {
      item.classList.add('removing');
      setTimeout(() => {
        item.remove();
        renderDeferredColumn();
      }, 300);
    }
    return;
  }

  // ---- Close all tabs in a domain group ----
  if (action === 'close-domain-tabs') {
    const cardKey = actionEl.dataset.cardKey;
    const tabsToClose = cardTabsRegistry[cardKey];
    if (!tabsToClose || tabsToClose.length === 0) return;

    // Close exactly the tabs registered for THIS card (unique URLs).
    // Exact matching also closes duplicate copies of the same URL.
    const urls = [...new Set(tabsToClose.map(t => t.url))];
    await closeTabsExact(urls);

    if (card) {
      playCloseSound();
      animateCardOut(card);
    }

    // Keep the in-memory stores consistent for both views.
    const closedUrlSet = new Set(urls);
    domainGroups.forEach(g => {
      g.tabs = g.tabs.filter(t => !closedUrlSet.has(t.url));
    });
    domainGroups = domainGroups.filter(g => g.tabs.length > 0);
    aiCategories.forEach(cat => {
      cat.tabs = cat.tabs.filter(t => !closedUrlSet.has(t.url));
    });
    aiCategories = aiCategories.filter(cat => cat.tabs.length > 0);
    delete cardTabsRegistry[cardKey];

    const groupLabel = card?.querySelector('.mission-name')?.textContent || 'group';
    showToast(`Closed ${urls.length} tab${urls.length !== 1 ? 's' : ''} from ${groupLabel}`);

    const statTabs = document.getElementById('statTabs');
    if (statTabs) statTabs.textContent = openTabs.length;
    return;
  }

  // ---- Close duplicates, keep one copy ----
  if (action === 'dedup-keep-one') {
    const urlsEncoded = actionEl.dataset.dupeUrls || '';
    const urls = urlsEncoded.split(',').map(u => decodeURIComponent(u)).filter(Boolean);
    if (urls.length === 0) return;

    await closeDuplicateTabs(urls, true);
    playCloseSound();

    // Hide the dedup button
    actionEl.style.transition = 'opacity 0.2s';
    actionEl.style.opacity    = '0';
    setTimeout(() => actionEl.remove(), 200);

    // Remove dupe badges from the card
    if (card) {
      card.querySelectorAll('.chip-dupe-badge').forEach(b => {
        b.style.transition = 'opacity 0.2s';
        b.style.opacity    = '0';
        setTimeout(() => b.remove(), 200);
      });
      card.querySelectorAll('.open-tabs-badge').forEach(badge => {
        if (badge.textContent.includes('duplicate')) {
          badge.style.transition = 'opacity 0.2s';
          badge.style.opacity    = '0';
          setTimeout(() => badge.remove(), 200);
        }
      });
      card.classList.remove('has-amber-bar');
      card.classList.add('has-neutral-bar');
    }

    showToast('Closed duplicates, kept one copy each');
    return;
  }

  // ---- Close ALL open tabs ----
  if (action === 'close-all-open-tabs') {
    // Same filter the UI counts with — internal pages and pinned tabs
    // stay open ("chromewebstore.google.com" starts with "chrome" too,
    // which is why the old startsWith('chrome') check was wrong).
    const allUrls = getClassifiableTabs().map(t => t.url);
    await closeTabsByUrls(allUrls);
    playCloseSound();

    document.querySelectorAll('#openTabsMissions .mission-card').forEach(c => {
      shootConfetti(
        c.getBoundingClientRect().left + c.offsetWidth / 2,
        c.getBoundingClientRect().top  + c.offsetHeight / 2
      );
      animateCardOut(c);
    });

    showToast('All tabs closed. Fresh start.');
    return;
  }
});

// ---- Archive toggle — expand/collapse the archive section ----
document.addEventListener('click', (e) => {
  const toggle = e.target.closest('#archiveToggle');
  if (!toggle) return;

  toggle.classList.toggle('open');
  const body = document.getElementById('archiveBody');
  if (body) {
    body.style.display = body.style.display === 'none' ? 'block' : 'none';
  }
});

// ---- Archive search — filter archived items as user types ----
document.addEventListener('input', async (e) => {
  if (e.target.id !== 'archiveSearch') return;

  const q = e.target.value.trim().toLowerCase();
  const archiveList = document.getElementById('archiveList');
  if (!archiveList) return;

  try {
    const { archived } = await getSavedTabs();

    if (q.length < 2) {
      // Show all archived items
      archiveList.innerHTML = archived.map(item => renderArchiveItem(item)).join('');
      return;
    }

    // Filter by title or URL containing the query string
    const results = archived.filter(item =>
      (item.title || '').toLowerCase().includes(q) ||
      (item.url  || '').toLowerCase().includes(q)
    );

    archiveList.innerHTML = results.map(item => renderArchiveItem(item)).join('')
      || '<div style="font-size:12px;color:var(--muted);padding:8px 0">No results</div>';
  } catch (err) {
    console.warn('[tabharbor] Archive search failed:', err);
  }
});


// ---- Click outside modal to close ----
document.addEventListener('click', (e) => {
  const overlay = e.target.closest('.modal-overlay');
  if (overlay && e.target === overlay) {
    overlay.style.display = 'none';
  }
});

// ---- Provider select change: update hints and defaults ----
function updateProviderUI() {
  const providerKey = document.getElementById('providerSelect').value;
  const provider = AI_PROVIDERS[providerKey];
  if (!provider) return;

  const baseUrlGroup = document.getElementById('baseUrlGroup');
  const baseUrlInput = document.getElementById('baseUrlInput');
  const modelInput = document.getElementById('modelInput');
  const modelHint = document.getElementById('modelHint');
  const apiKeyHint = document.getElementById('apiKeyHint');

  if (provider.baseUrl) {
    baseUrlGroup.style.display = 'none';
    if (!baseUrlInput.value) baseUrlInput.value = '';
  } else {
    baseUrlGroup.style.display = 'block';
  }

  if (!modelInput.value) modelInput.placeholder = provider.defaultModel || '输入模型名称';
  if (modelHint) modelHint.textContent = provider.modelHint || '';
  if (apiKeyHint) apiKeyHint.textContent = provider.keyHint || '';
}

document.addEventListener('change', (e) => {
  if (e.target.id === 'providerSelect') {
    // Switching providers must not inherit the previous provider's
    // endpoint/model — stale values used to win over the new provider's
    // built-ins and silently broke requests.
    document.getElementById('baseUrlInput').value = '';
    document.getElementById('modelInput').value = '';
    updateProviderUI();
  }
});


/* ----------------------------------------------------------------
   INITIALIZE
   ---------------------------------------------------------------- */
async function init() {
  const cached = await getAICache();
  if (cached && cached.length > 0) {
    aiCategories = cached;
    // Restore the view the user last looked at, instead of always
    // resetting to the domain view on every new tab page.
    if (await loadViewMode() === 'ai') currentViewMode = 'ai';
    updateViewToggle();
  }
  await renderDashboard();
}
init();
