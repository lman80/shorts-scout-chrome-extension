# Project notes for AI agents

## What this is
**Shorts Scout** — a Google Chrome extension (Manifest V3) that helps a YouTube Shorts
creator research shorts: it shows a short's view count and the channel's stats on the
`youtube.com/shorts` page, with an opt-in deep scan that counts how many of the
channel's videos are over 1M / 10M views.

## GitHub
- **Repo:** https://github.com/lman80/shorts-scout-chrome-extension
- **Visibility:** PRIVATE
- **Owner / account:** lman80
- **Remote:** `origin` (https). This local folder is the working copy.

To publish changes:
```
git add -A && git commit -m "..." && git push
```

## Layout
- `manifest.json` — MV3 config
- `background.js` — service worker; all YouTube Data API v3 calls + caching
- `content.js` — injected UI on youtube.com (medium auto card, recent-shorts view, deep-scan panel, watchlist)
- `content.css` — panel styling
- `options.html` / `options.js` — API key + thresholds + auto-show settings (chrome.storage.sync)
- `watchlist.html` / `watchlist.js` — full-page niche board (Kanban: columns = niches,
  cards = saved channels). Opened in a tab from the in-panel watchlist's "⤢ Board" button.
  Includes a **Notebook** (toolbar button): a Markdown editor (write/split/preview) that
  renders via the vendored `marked.min.js` (MIT, bundled — extension-page CSP blocks CDN
  scripts). Images are pasted/dropped, stored as data URLs in `notebookImages` (keyed by id,
  referenced in the md as `img:<id>`), markdown text in `notebookMd`. Needs `unlimitedStorage`.
- `marked.min.js` — vendored Markdown parser (do not edit; it's the upstream minified file).
- `icon128.png` — toolbar icon
- `README.md` — end-user setup + install instructions

## Key facts
- Needs a free **YouTube Data API v3** key (stored in `chrome.storage.sync`, never in code).
- Watchlist (saved channels) is stored in `chrome.storage.local` under key `watchlist`
  (array of `{channelId, title, totalViews, subscribers, videoCount, addedAt, refreshedAt,
  thumb, customUrl, niches:[], tags:[], madeBy:[], madeFor:[], languages:[], notes,
  examples:[{url,title}]}`). **niches is an array** (multi-select) — a channel shows in every
  matching board column; `normalize()` migrates a legacy single `niche` string into the array.
  **Niche hierarchy:** `nicheParents` (storage key, map child→parent) groups sub-niches under a
  parent. A board column is rendered per top-level niche with collapsible sub-niche sections;
  the column header shows the parent's rolled-up total (sum across `nicheTree`). `autoGroupNiches()`
  assigns parents by longest word-aligned suffix match ("family skits"→skits, "kids brain rot"→
  brain rot). The toolbar "Groups" dialog manages the hierarchy (auto-group + per-niche parent
  dropdowns). Analytics niche leaderboard groups by top-level parent.
  Besides niches+tags there are three more multi-select label dimensions: **madeBy**
  (children/teenagers/adults/families), **madeFor** (babies/children/teenagers/adults), and
  **languages** (common YT languages). Each has its own global options list in storage
  (keys `tags`, `madeBy`, `madeFor`, `languages`) seeded with defaults; `ATTR_DIMS` drives the
  generic chip editors (board "🏷 Labels" inline editor, drawer sections, save sheet).
  `migrateLanguages()` moves any language-named value out of tags into languages (matched
  against `KNOWN_LANGUAGES`). Manage niche/tag names via the column ✎/✕ buttons and the
  toolbar "Tags" dialog (rename propagates to all channels). Niche column order is
  under key `niches` (string[]). Individually saved shorts are under `savedVideos`
  (`{videoId, title, channelId, channelTitle, views, thumb, niche, notes, addedAt}`).
  Refresh history (for tracked-growth analytics) is under `snapshots`
  (`{t, totalViews, subscribers, channels}`). All per-machine (local, not sync).
- The board (`watchlist.html`) has four views: **Board** (niche columns, drag-drop),
  **Table** (sortable), **Analytics** (niche reach leaderboard, recent velocity via the
  RECENT message, channel momentum = recentAvg/lifetimeAvg, tracked growth from snapshots),
  and **Videos** (saved shorts with notes). Headline metric is **avg views/video** =
  totalViews/videoCount. **▶ Review** opens a side drawer with categorize chips + a
  scrollable 3-col grid of the channel's recent shorts (tap = watch, 🔖 = save). YouTube's
  embedded player fails on extension pages (Error 152/153, no valid referrer) and the full
  shorts webpage can't be iframed (X-Frame-Options), so the drawer's "⧉ Open real shorts
  page" opens the genuine page in a docked popup window (chrome.windows.create, type popup)
  that follows along on "Next unsorted channel". **⬇ Export** writes a Markdown backup with a
  lossless JSON appendix. Channels carry multi-select **tags** (array `tags`), stored under
  key `tags` (string[], seeded with: family, child, brain rot, skits, relatable; user can
  add more). Tags replaced the old single `status` field — `normalize()` migrates any legacy
  `status` into a tag. Tag editing: board card "🏷 Tags" inline editor, the Review drawer's
  TAGS chips, and the save sheet.
- In the in-YouTube panel, **☆ Save** opens a sheet (niche/tags/notes chips) and
  **🔖 Save this short** saves an individual video with notes (both write to storage.local).
- Quota budget: 10,000 units/day. Quick auto fetch ≈ 2 units/short; recent-shorts view
  ≈ 2 units; full milestone scan ≈ videoCount/50 × 2 units (only on explicit opt-in).
- After editing, you must reload the extension at `chrome://extensions` AND hard-refresh
  the YouTube tab (the SPA does not reload the content script on navigation).
