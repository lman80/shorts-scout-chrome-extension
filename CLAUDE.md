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
- `content.js` — injected UI on youtube.com (medium auto card, recent-shorts view, deep-scan panel)
- `content.css` — panel styling
- `options.html` / `options.js` — API key + thresholds + auto-show settings (chrome.storage.sync)
- `icon128.png` — toolbar icon
- `README.md` — end-user setup + install instructions

## Key facts
- Needs a free **YouTube Data API v3** key (stored in `chrome.storage.sync`, never in code).
- Quota budget: 10,000 units/day. Quick auto fetch ≈ 2 units/short; recent-shorts view
  ≈ 2 units; full milestone scan ≈ videoCount/50 × 2 units (only on explicit opt-in).
- After editing, you must reload the extension at `chrome://extensions` AND hard-refresh
  the YouTube tab (the SPA does not reload the content script on navigation).
