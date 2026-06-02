# Shorts Scout — YouTube Shorts research extension

A Chrome extension for YouTube Shorts creators. While you watch shorts in your
browser, click one button to see:

- **This short's stats** — total views (big, up front), likes, comments
- **The channel's totals** — total views, subscribers, total video count
- **How many of the channel's videos are over 1M / 10M views** (thresholds configurable)
- **Upload activity** — when they last uploaded and how often they post (e.g. `4/wk`)
- **Top video** — the channel's highest-viewed upload

The Analyze button is a round 📊 icon that parks itself right next to YouTube's own
like/comment/share column, so it's where your eyes already are.

Everything is **on-demand** — nothing calls the API until you click **📊 Analyze short**,
so you stay well under the free daily quota.

## One-time setup

### 1. Get a free YouTube Data API key (~5 minutes)
1. Go to <https://console.cloud.google.com/> and create a project.
2. **APIs & Services → Library** → search **YouTube Data API v3** → **Enable**.
3. **APIs & Services → Credentials → Create credentials → API key**.
4. Copy the key (starts with `AIza…`). Optionally click the key and restrict it to
   the YouTube Data API.

### 2. Load the extension
1. Open Chrome → `chrome://extensions`.
2. Toggle **Developer mode** on (top-right).
3. Click **Load unpacked** and select this folder.
4. Click the Shorts Scout toolbar icon (the red bar-chart) → paste your API key →
   **Save**. (You can also set custom view thresholds here, e.g. `1000000, 10000000`.)

## How to use
1. Go to `youtube.com/shorts` (incognito is fine — the extension works there if you
   allow it in incognito: `chrome://extensions` → Shorts Scout → Details → **Allow in incognito**).
2. A red **📊 Analyze short** button sits in the bottom-right.
3. When a short looks promising, click it. The panel shows the short's stats
   instantly, then scans the channel and fills in the totals + "videos over 1M/10M"
   counts (with a live progress bar).

## Quota notes
- Each analyze = 1 video call + 1 channel call + (videoCount ÷ 50) × 2 calls for the scan.
- A 500-video channel ≈ 20 quota units. The free tier is 10,000 units/day, so you can
  deep-scan hundreds of channels a day.
- Channels with more than 2,000 videos are capped at 2,000 scanned (the panel tells you
  when this happens). Raise `MAX_PAGES` in `background.js` to go further.

## Files
| File | Purpose |
|------|---------|
| `manifest.json` | Extension config (Manifest V3) |
| `background.js` | Service worker — all YouTube Data API calls + channel scan |
| `content.js` | Injects the button + results panel on youtube.com |
| `content.css` | Panel styling |
| `options.html` / `options.js` | API key + thresholds settings |
| `icon128.png` | Toolbar icon |

## Privacy
Your API key is stored in `chrome.storage.sync` (your browser only) and is sent only to
Google's official `googleapis.com` YouTube Data API. No other servers are contacted.
