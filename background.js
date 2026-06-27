// background.js — service worker. All YouTube Data API calls happen here so they
// aren't subject to youtube.com's page CSP, and the API key never lives in the page.

// Two-way cloud sync with the website (shared Firestore board). See cloud-sync.js.
importScripts("cloud-sync.js");

const API = "https://www.googleapis.com/youtube/v3";

// Best-effort in-memory cache of channels for this session, keyed by channelId.
// Saves a call when several consecutive shorts share a channel. Lost if the
// service worker is recycled — that's fine, it just refetches.
const channelCache = new Map();

async function getApiKey() {
  const { apiKey } = await chrome.storage.sync.get("apiKey");
  return apiKey || "";
}

async function getThresholds() {
  const { thresholds } = await chrome.storage.sync.get("thresholds");
  return thresholds && thresholds.length ? thresholds : [1000000, 10000000];
}

// Generic fetch wrapper that surfaces API errors clearly.
async function apiGet(path, params, apiKey) {
  const url = new URL(`${API}/${path}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  url.searchParams.set("key", apiKey);

  const res = await fetch(url.toString());
  const data = await res.json();
  if (!res.ok) {
    const reason =
      data?.error?.errors?.[0]?.reason || data?.error?.message || res.status;
    throw new Error(`YouTube API error: ${reason}`);
  }
  return data;
}

// Resolve a /shorts/<id> video into its stats + channelId.
async function getVideo(videoId, apiKey) {
  const data = await apiGet(
    "videos",
    { part: "statistics,snippet", id: videoId },
    apiKey
  );
  const item = data.items?.[0];
  if (!item) throw new Error("Video not found (it may be private or removed).");
  return {
    videoId,
    title: item.snippet?.title || "",
    channelId: item.snippet?.channelId,
    channelTitle: item.snippet?.channelTitle || "",
    views: Number(item.statistics?.viewCount || 0),
    likes: Number(item.statistics?.likeCount || 0),
    comments: Number(item.statistics?.commentCount || 0),
  };
}

// Channel-level totals + the uploads playlist id we page through later.
async function getChannel(channelId, apiKey) {
  const data = await apiGet(
    "channels",
    { part: "statistics,snippet,contentDetails", id: channelId },
    apiKey
  );
  const item = data.items?.[0];
  if (!item) throw new Error("Channel not found.");
  const thumbs = item.snippet?.thumbnails || {};
  return {
    channelId,
    title: item.snippet?.title || "",
    totalViews: Number(item.statistics?.viewCount || 0),
    subscribers: Number(item.statistics?.subscriberCount || 0),
    videoCount: Number(item.statistics?.videoCount || 0),
    thumb: (thumbs.medium || thumbs.default || {}).url || "",
    customUrl: item.snippet?.customUrl || "",
    uploadsPlaylist: item.contentDetails?.relatedPlaylists?.uploads,
  };
}

// "PT1M5S" -> 65 (seconds). Used to tell shorts (<=3min) from long videos.
function isoDurationToSec(iso) {
  const m = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso || "");
  if (!m) return null;
  return Number(m[1] || 0) * 3600 + Number(m[2] || 0) * 60 + Number(m[3] || 0);
}

async function getChannelCached(channelId, apiKey) {
  let c = channelCache.get(channelId);
  if (!c) {
    c = await getChannel(channelId, apiKey);
    channelCache.set(channelId, c);
  }
  return c;
}

// From a list of publish timestamps (ms), derive last-upload + posting cadence.
function computeUploadStats(timestamps) {
  const ts = timestamps
    .filter((t) => !isNaN(t))
    .sort((a, b) => b - a); // newest first
  if (!ts.length) return null;

  const lastUpload = ts[0];
  // Use up to the 30 most recent uploads to estimate cadence.
  const recent = ts.slice(0, 31);
  let perWeek = null;
  let avgGapDays = null;
  if (recent.length >= 2) {
    const spanMs = recent[0] - recent[recent.length - 1];
    const intervals = recent.length - 1;
    const avgGapMs = spanMs / intervals;
    if (avgGapMs > 0) {
      avgGapDays = avgGapMs / 86400000;
      perWeek = 7 / avgGapDays;
    }
  }
  return { lastUpload, avgGapDays, perWeek, sampleSize: recent.length };
}

// Walk the uploads playlist, fetch view counts in batches of 50, tally how many
// videos clear each threshold, and collect publish dates for cadence.
async function scanChannelVideos(channelId, apiKey, onProgress) {
  const channel = await getChannelCached(channelId, apiKey);
  const thresholds = await getThresholds();
  const tiers = thresholds.map((t) => ({ threshold: t, count: 0 }));

  let highest = { views: 0, title: "", videoId: "" };
  const publishTimes = [];
  const recent = []; // newest uploads, with thumbnails, for the in-panel grid
  let scanned = 0;
  let pageToken = "";
  let pages = 0;
  const MAX_PAGES = 40; // safety cap: 40 * 50 = 2000 videos

  do {
    const page = await apiGet(
      "playlistItems",
      {
        part: "contentDetails",
        playlistId: channel.uploadsPlaylist,
        maxResults: 50,
        ...(pageToken ? { pageToken } : {}),
      },
      apiKey
    );

    const items = page.items || [];
    for (const it of items) {
      const when = it.contentDetails?.videoPublishedAt;
      if (when) publishTimes.push(new Date(when).getTime());
    }

    const ids = items.map((i) => i.contentDetails?.videoId).filter(Boolean);
    if (ids.length) {
      const stats = await apiGet(
        "videos",
        { part: "statistics,snippet,contentDetails", id: ids.join(",") },
        apiKey
      );
      for (const v of stats.items || []) {
        const views = Number(v.statistics?.viewCount || 0);
        scanned++;
        for (const tier of tiers) {
          if (views >= tier.threshold) tier.count++;
        }
        if (views > highest.views) {
          highest = { views, title: v.snippet?.title || "", videoId: v.id };
        }
        // Keep the newest ~24 uploads (the playlist is newest-first) for the grid.
        if (recent.length < 24) {
          const durationSec = isoDurationToSec(v.contentDetails?.duration);
          const t = v.snippet?.thumbnails || {};
          recent.push({
            videoId: v.id,
            title: v.snippet?.title || "",
            thumb: (t.medium || t.high || t.default || {}).url || "",
            views,
            publishedAt: new Date(v.snippet?.publishedAt || 0).getTime(),
            durationSec,
            isShort: durationSec != null && durationSec <= 180,
          });
        }
      }
    }

    pageToken = page.nextPageToken || "";
    pages++;
    onProgress?.({ scanned, total: channel.videoCount });
  } while (pageToken && pages < MAX_PAGES);

  return {
    channel,
    scanned,
    capped: !!pageToken,
    tiers,
    highest,
    recent,
    upload: computeUploadStats(publishTimes),
  };
}

// Cheap: just the newest page of uploads (1 playlistItems + 1 videos call = 2 units).
// Enough for the recent-shorts grid + last-upload + cadence — no full channel walk.
async function fetchRecentUploads(channel, apiKey, maxItems = 50) {
  const recent = [];
  const publishTimes = [];
  let pageToken = "";
  let pages = 0;
  while (recent.length < maxItems && pages < 6) {
    const page = await apiGet(
      "playlistItems",
      { part: "contentDetails", playlistId: channel.uploadsPlaylist, maxResults: 50, ...(pageToken ? { pageToken } : {}) },
      apiKey
    );
    const items = page.items || [];
    const ids = items.map((i) => i.contentDetails?.videoId).filter(Boolean);
    if (ids.length) {
      const stats = await apiGet(
        "videos",
        { part: "statistics,snippet,contentDetails", id: ids.join(",") },
        apiKey
      );
      for (const v of stats.items || []) {
        const when = new Date(v.snippet?.publishedAt || 0).getTime();
        publishTimes.push(when);
        if (recent.length < maxItems) {
          const durationSec = isoDurationToSec(v.contentDetails?.duration);
          const t = v.snippet?.thumbnails || {};
          recent.push({
            videoId: v.id,
            title: v.snippet?.title || "",
            thumb: (t.medium || t.high || t.default || {}).url || "",
            views: Number(v.statistics?.viewCount || 0),
            publishedAt: when,
            durationSec,
            isShort: durationSec != null && durationSec <= 180,
          });
        }
      }
    }
    pageToken = page.nextPageToken || "";
    pages++;
    if (!pageToken) break;
  }
  return { recent, upload: computeUploadStats(publishTimes) };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;
  // Cloud-sync messages are handled by cloud-sync.js — don't touch them here.
  if (msg.type === "CLOUD_SYNC" || msg.type === "SWITCH_BOARD" || msg.type === "SAVE_PROFILES") return;
  // Open a URL in a new tab (background by default; foreground if msg.active).
  if (msg.type === "OPEN_TAB") {
    chrome.tabs.create({ url: msg.url, active: !!msg.active });
    sendResponse({ ok: true });
    return; // synchronous
  }

  (async () => {
    try {
      const apiKey = await getApiKey();
      if (!apiKey) throw new Error("NO_API_KEY");

      if (msg.type === "QUICK") {
        // Lightweight: just the short's views + the channel's total views.
        const video = await getVideo(msg.videoId, apiKey);
        const channel = await getChannelCached(video.channelId, apiKey);
        sendResponse({ ok: true, video, channel });
        return;
      }

      if (msg.type === "REFRESH_CHANNELS") {
        // Re-fetch current stats + avatars for saved channels. channels.list takes
        // up to 50 ids per call (1 unit each), so this is very cheap.
        const ids = msg.ids || [];
        const out = {};
        for (let i = 0; i < ids.length; i += 50) {
          const batch = ids.slice(i, i + 50);
          const data = await apiGet(
            "channels",
            { part: "statistics,snippet", id: batch.join(",") },
            apiKey
          );
          for (const item of data.items || []) {
            const t = item.snippet?.thumbnails || {};
            out[item.id] = {
              title: item.snippet?.title || "",
              totalViews: Number(item.statistics?.viewCount || 0),
              subscribers: Number(item.statistics?.subscriberCount || 0),
              videoCount: Number(item.statistics?.videoCount || 0),
              thumb: (t.medium || t.default || {}).url || "",
              customUrl: item.snippet?.customUrl || "",
            };
          }
        }
        sendResponse({ ok: true, channels: out });
        return;
      }

      if (msg.type === "RECENT") {
        // Cheap recent-shorts grid + cadence, no full milestone scan.
        // maxItems lets Analytics pull deeper history (paged) for trend analysis.
        const channel = await getChannelCached(msg.channelId, apiKey);
        const { recent, upload } = await fetchRecentUploads(channel, apiKey, Math.min(200, Math.max(1, msg.maxItems || 50)));
        sendResponse({ ok: true, channel, recent, upload });
        return;
      }

      if (msg.type === "ANALYZE") {
        const tabId = sender.tab?.id;
        const video = await getVideo(msg.videoId, apiKey);

        // Push the short's own stats to the panel immediately, before the
        // (slower) channel scan finishes.
        if (tabId != null) {
          chrome.tabs.sendMessage(tabId, {
            type: "VIDEO_READY",
            requestId: msg.requestId,
            video,
          });
        }

        const result = await scanChannelVideos(
          video.channelId,
          apiKey,
          (progress) => {
            if (tabId != null) {
              chrome.tabs.sendMessage(tabId, {
                type: "SCAN_PROGRESS",
                requestId: msg.requestId,
                progress,
              });
            }
          }
        );
        sendResponse({ ok: true, video, ...result });
      }
    } catch (err) {
      sendResponse({ ok: false, error: err.message });
    }
  })();
  return true; // keep the message channel open for the async response
});

// Clicking the toolbar icon opens the watchlist board (focusing it if already open).
chrome.action.onClicked.addListener(() => {
  const url = chrome.runtime.getURL("watchlist.html");
  chrome.tabs.query({}, (tabs) => {
    const existing = (tabs || []).find((t) => t.url && t.url.indexOf(url) === 0);
    if (existing) {
      chrome.tabs.update(existing.id, { active: true });
      if (existing.windowId != null) chrome.windows.update(existing.windowId, { focused: true });
    } else {
      chrome.tabs.create({ url });
    }
  });
});
