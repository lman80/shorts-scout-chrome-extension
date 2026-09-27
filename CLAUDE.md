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
  Includes a **Notebook** (in the ⋯ More menu): an Obsidian-style live Markdown editor — the
  doc is split into blocks (`nbSplitBlocks`, fence-aware) rendered formatted via the vendored
  `marked.min.js` (MIT, bundled — extension-page CSP blocks CDN scripts); clicking a block
  swaps just that block to a raw textarea, clicking away re-renders it (no split view). Images
  pasted/dropped → data URLs in `notebookImages` (keyed by id, referenced as `img:<id>`),
  text in `notebookMd`. Needs `unlimitedStorage`. The board's recent-shorts toggle updates the
  card in place (not a full `render()`) and `render()` preserves `.board` scrollLeft, so
  expanding shorts no longer jumps the horizontal scroll.
- `cloud-sync.js` — background-worker module (`importScripts` from `background.js`) that
  two-way syncs the board with the website. Both read/write ONE shared Firestore doc
  `boards/shared` (project `shorts-scout-d6c36`) in **open mode** (no auth; Firestore rules
  allow read/write on that one doc). Pushes local `chrome.storage.local` edits up (debounced)
  and pulls remote changes down on a 1-min `chrome.alarms` tick + an immediate pull when the
  board opens (watchlist.js sends `{type:"CLOUD_SYNC"}`). Last-write-wins via a `_rev` ms stamp;
  safety rule: never overwrite a non-empty board with an empty one. Synced keys: watchlist,
  niches, nicheParents, tags, madeBy, madeFor, languages, savedVideos, snapshots, notebookMd.
  `apiKey` (sync storage) and `notebookImages` are NOT synced (per-device). Needs manifest
  `alarms` permission + `https://firestore.googleapis.com/*` host permission.
- `web/` — the standalone website (Firebase Hosting at https://shorts-scout-d6c36.web.app).
  `build.py` generates `index.html` from `watchlist.html` and copies `watchlist.js`+`marked.min.js`;
  `cloud-app.js` provides a `window.chrome` shim (storage→Firestore `boards/shared`, sendMessage→
  YouTube API) so the extension's `watchlist.js` runs unchanged. Open mode: no sign-in; the YouTube
  API key is kept in `localStorage` per-device. After changing `watchlist.html`/`watchlist.js`:
  `python3 web/build.py` then `firebase deploy --only hosting` from `web/` (Firebase CLI is logged
  in as imamiller64@gmail.com; gcloud installed for project admin).
- `marked.min.js` — vendored Markdown parser (do not edit; it's the upstream minified file).
- `icon128.png` — toolbar icon
- `README.md` — end-user setup + install instructions

## Key facts
- **Pinned extension ID:** `kneanlohejjephhacgcfikpdpfkoibom`. `manifest.json` carries a `key`
  (RSA public key) so the ID no longer depends on the folder path. Without it, Chrome derives an
  unpacked extension's ID from its absolute path, so **moving the folder created a brand-new
  extension and orphaned all of `chrome.storage.local`** (this happened once; board data came back
  from Firestore, the API key had to be re-entered). Do not remove or change the `key`. The matching
  private key is `shorts-scout-key.pem` (gitignored, only needed to pack a `.crx`).
- Needs a free **YouTube Data API v3** key (stored in `chrome.storage.sync`, never in code).
- Watchlist (saved channels) is stored in `chrome.storage.local` under key `watchlist`
  (array of `{channelId, title, totalViews, subscribers, videoCount, addedAt, refreshedAt,
  thumb, customUrl, niches:[], tags:[], madeBy:[], madeFor:[], languages:[], topCandidate,
  notes, examples:[{url,title}]}`). **topCandidate** is a per-channel gold flag (★ star on the
  card + gold accent, toggle in the Review drawer & in-YouTube save sheet); the toolbar ★ button
  filters to top candidates only, and they get their own Export section. Each channel also has
  a **repVideoId** (representative short): hovering a card's `.card-head` plays it (autoplaying
  muted youtube-nocookie embed on the website; click-to-watch thumbnail on the extension page
  where embeds are blocked — `IS_EXTENSION` switch). Auto-set to the watched short on save
  (content.js `saveChannelEntry`); override via the 📌 pins in the recent-shorts grid and the
  Review drawer (`setRep`). **niches is an array** (multi-select) — a channel shows in every
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
  and **Videos** (saved shorts with notes). Analytics is chart-driven (hand-rolled SVG: `lineChart`,
  `scatterChart`, sparklines — no external lib): scorecard with top/fastest-growing niche, a niche
  **opportunity scatter** (x=median videos, y=median avg/video, log scale, bubble=reach, top-left
  quadrant highlighted), reach leaderboard with momentum, a **"Run deep analysis"** step that pages
  ~150 recent uploads/channel (RECENT msg `maxItems`, into `historyCache`) to compute **weekly views
  per niche** (12-wk line), **momentum** over 7/30/90d windows (`channelWindow`/`channelsWindow` =
  views vs the prior equal window), heating-up/cooling channel lists, and breakdowns by made-for /
  language. A 7/30/90 timeframe toggle (`anWindow`) drives momentum. Snapshots now store per-niche
  reach for the tracked-growth multi-line chart. Headline metric is **avg views/video** =
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

<!-- superfeedback:handling v1 -->
## User feedback (SuperFeedback) — keep the Issues up to date

Users send bugs and ideas from inside the app. Each one becomes a GitHub Issue in
`lman80/shorts-scout-chrome-extension` with the `feedback` label plus a type label (`bug`, `feature`, `other`, `crash`).
The body has the user's message, a screenshot link, a context table (device, OS, app version…)
and often recent logs. **An open Issue counts as "not addressed" on the owner's dashboard**, so
keep them accurate as you work:

1. **At the start of a session**, look at what's waiting:
   `gh issue list -R lman80/shorts-scout-chrome-extension --label feedback --state open`
   Read the ones related to your task (`gh issue view N -R lman80/shorts-scout-chrome-extension`). If the user's request
   is about an area you're changing, fix it too or mention it to the owner.
2. **When you start on one:** `gh issue edit N -R lman80/shorts-scout-chrome-extension --add-label building`
3. **When it's fixed:** put `Fixes #N` in the commit message (GitHub closes it when the commit
   reaches the default branch). If the fix lands any other way, close it yourself:
   `gh issue close N -R lman80/shorts-scout-chrome-extension --reason completed --comment "Fixed in <commit or version>: <one line>"`
   If the Issue also has the `idea` label: `gh issue edit N -R lman80/shorts-scout-chrome-extension --add-label shipped`
   and set its milestone to the version it ships in (users see that on the public roadmap).
4. **Already fixed earlier** (you find the code already does it): close it the same way and cite
   the commit or file that fixed it.
5. **Won't fix, can't reproduce, or duplicate:**
   `gh issue close N -R lman80/shorts-scout-chrome-extension --reason "not planned" --comment "<why, or Duplicate of #M>"`
   Ask the owner before declining a feature request — don't decide product direction yourself.
6. **Before you finish:** every Issue you fixed this session is closed with a comment, and every
   one you started but didn't finish still has `building` and a comment saying where it stands.

Never close an Issue without a comment, never delete Issues, and don't edit the report body
(it holds the context table and, for public ideas, the vote-count line).
<!-- /superfeedback:handling -->
