// watchlist.js — the niche board. Columns = niches, cards = saved channels.
// Built around the creator's real decision: find niches/formats that get huge views
// with low effort. The headline metric is AVG VIEWS / VIDEO; "reach" (avg/video ÷ subs)
// flags content that escapes the subscriber base (the algorithm-virality signal).

const UNSORTED = "__unsorted__";
const DEFAULT_TAGS = ["family", "child", "brain rot", "skits", "relatable"];
const DEFAULT_MADE_BY = ["children", "teenagers", "adults", "families"];
const DEFAULT_MADE_FOR = ["babies", "children", "teenagers", "adults"];
const DEFAULT_LANGUAGES = ["English", "Spanish", "Hindi", "Portuguese", "Arabic", "Indonesian", "Japanese", "Korean", "Russian", "French", "German", "Chinese", "Turkish", "Vietnamese", "Italian", "Thai"];
// For migrating language values that were saved as tags.
const KNOWN_LANGUAGES = new Set(
  ["english", "spanish", "español", "espanol", "hindi", "portuguese", "português", "portugues", "arabic", "indonesian", "japanese", "korean", "russian", "french", "français", "francais", "german", "deutsch", "chinese", "mandarin", "cantonese", "turkish", "vietnamese", "thai", "italian", "italiano", "polish", "dutch", "filipino", "tagalog", "urdu", "bengali", "persian", "farsi", "ukrainian", "romanian", "greek", "swedish", "norwegian", "danish", "finnish", "czech", "hungarian", "hebrew", "malay", "tamil", "telugu", "marathi", "punjabi", "swahili", "afrikaans"]
);

// Non-niche multi-select dimensions (Niches are handled separately since they drive columns).
const ATTR_DIMS = [
  { field: "tags", label: "Tags", cls: "lc-tags" },
  { field: "madeBy", label: "Made by", cls: "lc-by", prefix: "by " },
  { field: "madeFor", label: "Made for", cls: "lc-for", prefix: "for " },
  { field: "languages", label: "Language", cls: "lc-lang", icon: "🌐 " },
];
// Stable color per niche (by index) for the column dot.
const NICHE_COLORS = ["#ff0033", "#4aa8ff", "#ffcb47", "#4ade80", "#c084fc", "#ff8a3d", "#2dd4bf", "#f472b6", "#a3e635", "#60a5fa"];

const state = { watchlist: [], niches: [], nicheParents: {}, tags: [], madeBy: [], madeFor: [], languages: [], savedVideos: [], snapshots: [], vidiqStats: {}, vidiqHistory: {}, sort: "avg", view: "board", search: "", filterTop: false };
const collapsedSub = new Set(); // collapsed "parent>child" sub-niche sections on the board
let ignoreNextChange = false;
const recentCache = {}; // channelId -> { loading } | { recent:[...] } | { error }
const expanded = new Set(); // channelIds whose "recent shorts" dropdown is open
let reviewId = null; // channelId currently open in the review drawer
let reviewIndex = 0; // which short within that channel is playing
let hotThreshold = Infinity; // 75th percentile of avg/video, computed each render

// ---- storage ---------------------------------------------------------------

function load() {
  // Ask the background worker to pull the latest from the cloud right away
  // (the periodic alarm also does this every minute). Best-effort.
  try { chrome.runtime.sendMessage({ type: "CLOUD_SYNC" }, () => void chrome.runtime.lastError); } catch (e) {}
  chrome.storage.local.get(["watchlist", "niches", "nicheParents", "boardPrefs", "savedVideos", "snapshots", "tags", "madeBy", "madeFor", "languages", "vidiqStats", "vidiqHistory"], (d) => {
    state.watchlist = (d.watchlist || []).map(normalize);
    state.vidiqStats = d.vidiqStats || {};
    state.vidiqHistory = d.vidiqHistory || {};
    state.niches = d.niches || [];
    state.nicheParents = d.nicheParents || {};
    state.tags = d.tags && d.tags.length ? d.tags : DEFAULT_TAGS.slice();
    state.madeBy = d.madeBy && d.madeBy.length ? d.madeBy : DEFAULT_MADE_BY.slice();
    state.madeFor = d.madeFor && d.madeFor.length ? d.madeFor : DEFAULT_MADE_FOR.slice();
    state.languages = d.languages && d.languages.length ? d.languages : DEFAULT_LANGUAGES.slice();
    state.savedVideos = d.savedVideos || [];
    state.snapshots = d.snapshots || [];
    const changed = migrateLanguages();
    if (!d.tags || !d.madeBy || !d.madeFor || !d.languages || changed) {
      chrome.storage.local.set({ tags: state.tags, madeBy: state.madeBy, madeFor: state.madeFor, languages: state.languages, watchlist: state.watchlist });
    }
    const p = d.boardPrefs || {};
    state.sort = p.sort || "avg";
    state.view = p.view || "board";
    seedNichesFromChannels();
    syncControls();
    render();
    setTimeout(warmRecentStats, 1200); // rep shorts for hover-play
  });
}

function normalize(c) {
  return {
    channelId: c.channelId,
    title: c.title || "",
    totalViews: c.totalViews || 0,
    subscribers: c.subscribers || 0,
    videoCount: c.videoCount || 0,
    thumb: c.thumb || "",
    customUrl: c.customUrl || "",
    addedAt: c.addedAt || 0,
    refreshedAt: c.refreshedAt || c.addedAt || 0,
    niches: Array.isArray(c.niches) ? c.niches : c.niche ? [c.niche] : [], // single niche → array
    tags: Array.isArray(c.tags) ? c.tags : c.status ? [c.status] : [], // migrate old status → tag
    madeBy: Array.isArray(c.madeBy) ? c.madeBy : [],
    madeFor: Array.isArray(c.madeFor) ? c.madeFor : [],
    languages: Array.isArray(c.languages) ? c.languages : [],
    topCandidate: !!c.topCandidate,
    repVideoId: c.repVideoId || "", // the short that represents this channel (hover-to-play)
    v7: typeof c.v7 === "number" ? c.v7 : null, // views on uploads from the last 7 days
    v30: typeof c.v30 === "number" ? c.v30 : null, // views on uploads from the last 30 days
    recentStatsAt: c.recentStatsAt || 0, // when v7/v30 were last computed
    notes: c.notes || "",
    examples: c.examples || [],
  };
}

// Move any language values that were saved as tags over to the Language dimension.
function migrateLanguages() {
  const isLang = (t) => KNOWN_LANGUAGES.has(String(t).toLowerCase());
  let changed = false;
  const globalLangs = state.tags.filter(isLang);
  if (globalLangs.length) {
    state.tags = state.tags.filter((t) => !isLang(t));
    globalLangs.forEach((l) => { if (!state.languages.includes(l)) state.languages.push(l); });
    changed = true;
  }
  state.watchlist.forEach((c) => {
    if (!Array.isArray(c.tags)) return;
    const moved = c.tags.filter(isLang);
    if (!moved.length) return;
    c.tags = c.tags.filter((t) => !isLang(t));
    if (!Array.isArray(c.languages)) c.languages = [];
    moved.forEach((l) => { if (!c.languages.includes(l)) c.languages.push(l); });
    changed = true;
  });
  return changed;
}

function seedNichesFromChannels() {
  for (const c of state.watchlist) {
    (c.niches || []).forEach((n) => {
      if (n && !state.niches.includes(n)) state.niches.push(n);
    });
  }
}

function save() {
  ignoreNextChange = true;
  chrome.storage.local.set({
    watchlist: state.watchlist,
    niches: state.niches,
    nicheParents: state.nicheParents,
    tags: state.tags,
    madeBy: state.madeBy,
    madeFor: state.madeFor,
    languages: state.languages,
    boardPrefs: { sort: state.sort, view: state.view },
  });
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (ignoreNextChange) {
    ignoreNextChange = false;
    return;
  }
  const tag = (document.activeElement || {}).tagName;
  if (tag === "TEXTAREA" || tag === "INPUT" || tag === "SELECT") return;
  if (changes.watchlist) state.watchlist = (changes.watchlist.newValue || []).map(normalize);
  if (changes.niches) state.niches = changes.niches.newValue || [];
  if (changes.nicheParents) state.nicheParents = changes.nicheParents.newValue || {};
  if (changes.tags) state.tags = changes.tags.newValue || [];
  if (changes.madeBy) state.madeBy = changes.madeBy.newValue || [];
  if (changes.madeFor) state.madeFor = changes.madeFor.newValue || [];
  if (changes.languages) state.languages = changes.languages.newValue || [];
  if (changes.savedVideos) state.savedVideos = changes.savedVideos.newValue || [];
  if (changes.snapshots) state.snapshots = changes.snapshots.newValue || [];
  if (changes.vidiqStats) state.vidiqStats = changes.vidiqStats.newValue || {};
  if (changes.vidiqHistory) state.vidiqHistory = changes.vidiqHistory.newValue || {};
  seedNichesFromChannels();
  render();
});

// ---- metrics & helpers -----------------------------------------------------

function compact(n) {
  if (n == null || isNaN(n)) return "—";
  return Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(n);
}
function avgPerVideo(c) {
  return c.videoCount ? c.totalViews / c.videoCount : 0;
}
function reachRatio(c) {
  return c.subscribers ? avgPerVideo(c) / c.subscribers : 0;
}
function fmtReach(c) {
  const r = reachRatio(c);
  if (!r) return "—";
  return r >= 10 ? Math.round(r) + "×" : r.toFixed(1) + "×";
}
function esc(s) {
  return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function channelUrl(c) {
  return `https://www.youtube.com/channel/${c.channelId}`;
}
function findChannel(id) {
  return state.watchlist.find((c) => c.channelId === id);
}
function toggleChannelTag(c, tag) {
  if (!Array.isArray(c.tags)) c.tags = [];
  const i = c.tags.indexOf(tag);
  if (i >= 0) c.tags.splice(i, 1);
  else c.tags.push(tag);
}

function nicheColor(niche) {
  const i = state.niches.indexOf(niche);
  return i < 0 ? "#555" : NICHE_COLORS[i % NICHE_COLORS.length];
}
function median(arr) {
  if (!arr.length) return 0;
  const s = arr.slice().sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function timeAgo(ms) {
  if (!ms) return "never";
  const mins = Math.floor((Date.now() - ms) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const h = Math.floor(mins / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

// vidIQ recent-views helpers
function vq7(c) { const s = (state.vidiqStats || {})[c.channelId]; return s && typeof s.v7 === "number" ? s.v7 : 0; }
function vq30(c) { const s = (state.vidiqStats || {})[c.channelId]; return s && typeof s.v30 === "number" ? s.v30 : 0; }
// Momentum: recent daily pace (7d) vs monthly daily pace (30d). >1 = heating up.
function vqMomentum(c) {
  const s = (state.vidiqStats || {})[c.channelId];
  if (!s || typeof s.v7 !== "number" || typeof s.v30 !== "number" || s.v30 <= 0) return null;
  const pace7 = s.v7 / 7, pace30 = s.v30 / 30;
  if (pace30 <= 0) return null;
  return pace7 / pace30;
}
function sortKey() {
  return {
    avg: avgPerVideo,
    reach: reachRatio,
    views: (c) => c.totalViews,
    subs: (c) => c.subscribers,
    videos: (c) => c.videoCount,
    added: (c) => c.addedAt,
    v7: vq7,
    v30: vq30,
    momentum: (c) => vqMomentum(c) || 0,
  }[state.sort];
}
function sortChannels(list) {
  const k = sortKey();
  return list.slice().sort((a, b) => k(b) - k(a));
}
function matchesSearch(c) {
  if (!state.search) return true;
  const q = state.search.toLowerCase();
  return (c.title || "").toLowerCase().includes(q) || (c.customUrl || "").toLowerCase().includes(q) || (c.niches || []).join(" ").toLowerCase().includes(q);
}
function visibleChannels() {
  return state.watchlist.filter((c) => matchesSearch(c) && (!state.filterTop || c.topCandidate));
}
function computeHotThreshold() {
  const avgs = state.watchlist.map(avgPerVideo).filter((v) => v > 0).sort((a, b) => a - b);
  if (avgs.length < 4) {
    hotThreshold = Infinity;
    return;
  }
  hotThreshold = avgs[Math.floor(avgs.length * 0.75)];
}

// ---- toast -----------------------------------------------------------------

let toastTimer = null;
function toast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 2200);
}

// ---- render dispatch -------------------------------------------------------

function render() {
  computeHotThreshold();
  renderSummary();
  renderUpdated();
  const content = document.getElementById("content");
  const prevBoard = content.querySelector(".board");
  const keepScrollX = prevBoard ? prevBoard.scrollLeft : 0;

  if (!state.watchlist.length) {
    content.innerHTML = `
      <div class="empty">
        <div>
          <div class="big">🎯</div>
          <h2>No channels saved yet</h2>
          <p>On YouTube Shorts, open Shorts Scout and tap <span class="kbd">☆ Save</span> on any channel worth studying.</p>
          <p>They'll land here, where you can sort them into niches and spot the formats that get huge views with little effort.</p>
        </div>
      </div>`;
    return;
  }

  content.innerHTML = "";
  if (state.view === "top") return content.appendChild(renderTopCandidates());
  if (state.view === "analytics") return content.appendChild(renderAnalytics());
  if (state.view === "videos") return content.appendChild(renderVideos());
  if (needsRefresh()) content.appendChild(refreshBanner());
  content.appendChild(state.view === "table" ? renderTable() : renderBoard());
  if (keepScrollX) {
    const nb = content.querySelector(".board");
    if (nb) nb.scrollLeft = keepScrollX;
  }
}

function renderSummary() {
  const total = state.watchlist.reduce((s, c) => s + c.totalViews, 0);
  document.getElementById("summary").innerHTML = `
    <div class="schip"><b>${state.watchlist.length}</b><span>channels</span></div>
    <div class="schip"><b>${state.niches.length}</b><span>niches</span></div>
    <div class="schip"><b>${compact(total)}</b><span>total reach</span></div>`;
}

function renderUpdated() {
  const last = Math.max(0, ...state.watchlist.map((c) => c.refreshedAt || 0));
  document.getElementById("updated").textContent = state.watchlist.length ? `Updated ${timeAgo(last)}` : "";
}

function needsRefresh() {
  return state.watchlist.some((c) => !c.thumb);
}
function refreshBanner() {
  const el = document.createElement("div");
  el.className = "banner";
  const n = state.watchlist.filter((c) => !c.thumb).length;
  el.innerHTML = `<span>${n} channel${n > 1 ? "s" : ""} saved before avatars & live stats were added. Refresh to load them.</span>
    <button class="btn primary" id="bannerRefresh">Refresh now</button>`;
  el.querySelector("#bannerRefresh").onclick = doRefresh;
  return el;
}

// ---- board view ------------------------------------------------------------

function channelsIn(niche) {
  const vis = visibleChannels();
  if (niche === UNSORTED) return vis.filter((c) => !(c.niches || []).some((n) => state.niches.includes(n)));
  return vis.filter((c) => (c.niches || []).includes(niche));
}

// ---- niche hierarchy (parent niche → sub-niches) ---------------------------

function parentOf(n) {
  const p = state.nicheParents[n];
  return p && p !== n && state.niches.includes(p) ? p : "";
}
function childrenOf(p) {
  return state.niches.filter((n) => parentOf(n) === p);
}
function topLevelNiches() {
  return state.niches.filter((n) => !parentOf(n));
}
function nicheTree(p) {
  return [p, ...childrenOf(p)]; // 2-level: parent + its sub-niches
}
function uniqueChannelsInTree(p) {
  const set = nicheTree(p);
  const seen = new Set();
  return visibleChannels().filter((c) => {
    if (!(c.niches || []).some((n) => set.includes(n))) return false;
    if (seen.has(c.channelId)) return false;
    seen.add(c.channelId);
    return true;
  });
}

// Auto-detect parents: a niche is a sub-niche of the longest existing niche whose
// name it ends with (word-aligned). "family skits" → "skits", "kids brain rot" → "brain rot".
function autoGroupNiches() {
  let assigned = 0;
  state.niches.forEach((N) => {
    const Ln = N.toLowerCase();
    let best = "";
    state.niches.forEach((P) => {
      if (P === N) return;
      const Lp = P.toLowerCase();
      if (Ln === Lp) return;
      if (Ln.endsWith(" " + Lp) || Ln.endsWith("'" + Lp)) {
        if (P.length > best.length) best = P;
      }
    });
    if (best && state.nicheParents[N] !== best) {
      state.nicheParents[N] = best;
      assigned++;
    }
  });
  // Flatten to a single level: if a parent itself has a parent, hop to the top.
  state.niches.forEach((N) => {
    let p = state.nicheParents[N];
    let guard = 0;
    while (p && state.nicheParents[p] && state.nicheParents[p] !== p && guard++ < 12) p = state.nicheParents[p];
    if (p) state.nicheParents[N] = p;
  });
  save();
  render();
  toast(assigned ? `Grouped ${assigned} sub-niche${assigned === 1 ? "" : "s"}` : "No new sub-niches found");
}

function renderBoard() {
  const board = document.createElement("div");
  board.className = "board";
  board.appendChild(renderColumn(UNSORTED));
  topLevelNiches().forEach((n) => board.appendChild(renderColumn(n)));
  board.appendChild(renderAddColumn());
  return board;
}

function renderAddColumn() {
  const el = document.createElement("button");
  el.className = "addcol";
  el.innerHTML = `<span class="addcol-plus">＋</span><span>Add niche</span>`;
  el.onclick = promptAddNiche;
  return el;
}

function htmlEl(html) {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

// A collapsible sub-niche section inside a parent niche column.
function renderSubSection(parent, child, channels, suffixLabel) {
  const key = parent + ">" + child;
  const collapsed = collapsedSub.has(key);
  const reach = channels.reduce((s, c) => s + c.totalViews, 0);
  const sec = document.createElement("div");
  sec.className = "subsec";
  const head = document.createElement("div");
  head.className = "subsec-head";
  head.innerHTML = `
    <span class="subsec-caret">${collapsed ? "▸" : "▾"}</span>
    <span class="subsec-dot" style="background:${nicheColor(child)}"></span>
    <span class="subsec-title">${esc(child)}${suffixLabel ? ` <span class="subsec-suffix">${esc(suffixLabel)}</span>` : ""}</span>
    <span class="subsec-reach">${compact(reach)}</span>
    <span class="subsec-count">${channels.length}</span>`;
  head.onclick = () => {
    if (collapsed) collapsedSub.delete(key);
    else collapsedSub.add(key);
    render();
  };
  sec.appendChild(head);
  if (!collapsed) {
    const wrap = document.createElement("div");
    wrap.className = "subsec-body";
    if (channels.length) channels.forEach((c) => wrap.appendChild(renderCard(c)));
    else wrap.innerHTML = `<div class="col-empty">No channels yet.</div>`;
    sec.appendChild(wrap);
  }
  return sec;
}

// Niche recent performance, summed from the real vidIQ 7/30-day views of its
// channels. mom = 7-day pace vs 30-day pace (>1 = the niche is heating up).
// freshT = newest scan time across the niche (for the "re-sync" staleness flag).
function nicheRecent(niche) {
  const chs = uniqueChannelsInTree(niche);
  let v7 = 0, v30 = 0, have = 0, freshT = 0, has7 = false, has30 = false;
  chs.forEach((c) => {
    const s = (state.vidiqStats || {})[c.channelId];
    if (!s) return;
    if (typeof s.v7 === "number") { v7 += s.v7; has7 = true; }
    if (typeof s.v30 === "number") { v30 += s.v30; has30 = true; }
    if (s.v7 != null || s.v30 != null) { have++; if (s.t) freshT = Math.max(freshT, s.t); }
  });
  if (!have) return null;
  const mom = has7 && has30 && v30 > 0 ? (v7 / 7) / (v30 / 30) : null;
  const trend = mom == null ? "flat" : mom >= 1.1 ? "up" : mom <= 0.9 ? "down" : "flat";
  return { v7: has7 ? v7 : null, v30: has30 ? v30 : null, mom, trend, have, total: chs.length, freshT };
}

function renderColumn(niche) {
  const col = document.createElement("div");
  col.className = "col" + (niche === UNSORTED ? " unsorted" : "");
  col.dataset.niche = niche;

  const kids = niche === UNSORTED ? [] : childrenOf(niche);
  const treeChannels = niche === UNSORTED ? channelsIn(UNSORTED) : uniqueChannelsInTree(niche);
  const name = niche === UNSORTED ? "Unsorted" : niche;
  const med = median(treeChannels.map(avgPerVideo).filter((v) => v > 0));
  const reach = treeChannels.reduce((s, c) => s + c.totalViews, 0);

  const nr = niche === UNSORTED ? null : nicheRecent(niche);
  let vpdHtml = "";
  if (niche !== UNSORTED) {
    if (!nr) {
      vpdHtml = `<div class="col-vpd building" title="Run Scan vidIQ (top bar) to pull each channel's real 7/30-day views.">scan vidIQ for 7-day views</div>`;
    } else {
      const sign = (n) => (n >= 0 ? "+" : "");
      const momPct = nr.mom != null ? Math.round((nr.mom - 1) * 100) : null;
      const arrow = nr.trend === "up" ? "🔥" : nr.trend === "down" ? "❄️" : "→";
      const ageH = nr.freshT ? (Date.now() - nr.freshT) / 3600e3 : Infinity;
      const stale = ageH > 24;
      const ageLabel = !isFinite(ageH) ? "?" : ageH < 24 ? Math.round(ageH) + "h" : Math.round(ageH / 24) + "d";
      vpdHtml = `<div class="col-vpd ${nr.trend}" title="Total views the niche's channels got in the last 7 / 30 days (from vidIQ). 🔥/❄️ = the niche's recent pace vs its 30-day average.">
        <b>${nr.v7 != null ? compact(nr.v7) : "—"}</b> views · 7d
        ${momPct != null ? `<span class="vpd-arrow">${arrow} ${sign(momPct)}${momPct}%</span>` : ""}
        <span class="vpd-sub">${nr.v30 != null ? compact(nr.v30) + " · 30d" : ""}${nr.have < nr.total ? `${nr.v30 != null ? " · " : ""}${nr.have}/${nr.total} scanned` : ""}</span>
        ${stale ? `<span class="col-stale">⚠ data ${ageLabel} old — re-sync</span>` : ""}
      </div>`;
    }
  }

  const head = document.createElement("div");
  head.className = "col-head";
  head.innerHTML = `
    <div class="col-titlerow">
      <span class="col-dot" style="background:${niche === UNSORTED ? "#3a3a44" : nicheColor(niche)}"></span>
      <span class="col-title">${esc(name)}</span>
      <span class="col-count">${treeChannels.length}</span>
      ${niche === UNSORTED ? "" : `<button class="col-edit" title="Rename niche">✎</button><button class="col-del" title="Delete niche">✕</button>`}
    </div>
    ${niche !== UNSORTED ? `<div class="col-sub"><span><b>${compact(reach)}</b> reach</span><span>median <b>${med ? compact(med) : "—"}</b>/vid</span>${kids.length ? `<span><b>${kids.length}</b> sub-niche${kids.length === 1 ? "" : "s"}</span>` : ""}</div>` : ""}
    ${vpdHtml}`;
  if (niche !== UNSORTED) {
    head.querySelector(".col-edit").onclick = () => renameNiche(niche);
    head.querySelector(".col-del").onclick = () => deleteNiche(niche);
    const t = head.querySelector(".col-title");
    t.style.cursor = "text";
    t.title = "Double-click to rename";
    t.ondblclick = () => renameNiche(niche);
  }
  col.appendChild(head);

  const body = document.createElement("div");
  body.className = "col-body";

  if (kids.length) {
    // Parent column: a "direct" section for channels tagged with the parent itself,
    // then a collapsible section per sub-niche.
    const direct = sortChannels(channelsIn(niche));
    if (direct.length) body.appendChild(renderSubSection(niche, niche, direct, "· general", false));
    kids.forEach((child) => {
      const cs = sortChannels(channelsIn(child));
      body.appendChild(renderSubSection(niche, child, cs, "", true));
    });
    if (!direct.length && !kids.some((k) => channelsIn(k).length)) {
      body.appendChild(htmlEl(`<div class="col-empty">Drag channels here, or tag them with a sub-niche.</div>`));
    }
  } else {
    const list = sortChannels(channelsIn(niche));
    if (!list.length) {
      body.innerHTML = `<div class="col-empty">${niche === UNSORTED ? "Saved channels appear here.\nDrag them into a niche." : "Drag channels here"}</div>`;
    } else {
      list.forEach((c) => body.appendChild(renderCard(c)));
    }
  }
  col.appendChild(body);

  col.addEventListener("dragover", (e) => {
    e.preventDefault();
    col.classList.add("drop");
  });
  col.addEventListener("dragleave", (e) => {
    if (!col.contains(e.relatedTarget)) col.classList.remove("drop");
  });
  col.addEventListener("drop", (e) => {
    e.preventDefault();
    col.classList.remove("drop");
    const c = findChannel(e.dataTransfer.getData("text/plain"));
    if (c) {
      if (!Array.isArray(c.niches)) c.niches = [];
      if (niche === UNSORTED) {
        if (c.niches.length) {
          c.niches = [];
          save();
          render();
          toast("Cleared niches");
        }
      } else if (!c.niches.includes(niche)) {
        c.niches.push(niche);
        save();
        render();
        toast(`Added to ${niche}`);
      }
    }
  });

  return col;
}

// ---- representative-short hover preview ------------------------------------
// Plays the channel's chosen short on hover. Real autoplay works on the website
// (normal origin); on the extension page YouTube blocks embeds, so we show a
// click-to-watch thumbnail there instead.
const IS_EXTENSION = location.protocol === "chrome-extension:";
let repShowTimer = null, repHideTimer = null;

function ensureRepEl() {
  let p = document.getElementById("rep-preview");
  if (!p) {
    p = document.createElement("div");
    p.id = "rep-preview";
    document.body.appendChild(p);
    p.addEventListener("mouseenter", () => clearTimeout(repHideTimer));
    p.addEventListener("mouseleave", hideRepPreview);
  }
  return p;
}
let repFetching = {}, repCurrent = null;

// Pick the channel's best recent short (most-viewed short, else most-viewed upload).
function repBestShort(recent) {
  const shorts = (recent || []).filter((r) => r.isShort);
  const list = shorts.length ? shorts : (recent || []);
  if (!list.length) return "";
  return list.slice().sort((a, b) => (b.views || 0) - (a.views || 0))[0].videoId;
}
// Remember the user's "sound on" choice across hovers. Browsers only allow
// unmuted autoplay after the user has interacted with the page this load, so we
// track that too and fall back to muted + a one-tap "sound" button otherwise.
function repWantSound() { try { return localStorage.getItem("ss_repSound") === "1"; } catch (e) { return false; } }
let pageInteracted = false;
document.addEventListener("pointerdown", () => { pageInteracted = true; }, true);

function repPlay(p, id, anchor) {
  if (IS_EXTENSION) {
    p.innerHTML = `<a class="rp-open" href="https://www.youtube.com/shorts/${id}" target="_blank" rel="noopener">
      <span class="rp-thumb" style="background-image:url('https://i.ytimg.com/vi/${id}/hqdefault.jpg')"><span class="rp-play">▶</span></span>
      <span class="rp-cap">click to watch</span></a>`;
  } else {
    const sound = repWantSound() && pageInteracted; // unmuted only when the browser will allow it
    p.innerHTML = `<iframe src="https://www.youtube-nocookie.com/embed/${id}?autoplay=1&mute=${sound ? 0 : 1}&playsinline=1&rel=0&controls=1&loop=1&playlist=${id}" allow="autoplay; encrypted-media; picture-in-picture" allowfullscreen></iframe>`
      + (sound ? "" : `<button class="rp-sound" type="button">🔊 Tap for sound</button>`);
    if (!sound) {
      const b = p.querySelector(".rp-sound");
      if (b) b.onclick = (e) => {
        e.preventDefault(); e.stopPropagation();
        try { localStorage.setItem("ss_repSound", "1"); } catch (_) {}
        pageInteracted = true;
        repPlay(p, id, anchor); // reload this preview with sound on
      };
    }
  }
  positionRep(p, anchor);
  p.classList.add("show");
}
function repMsg(p, text) { p.innerHTML = `<div class="rp-msg">${esc(text)}</div>`; }

function showRepPreview(c, anchor) {
  clearTimeout(repHideTimer);
  clearTimeout(repShowTimer);
  repShowTimer = setTimeout(() => {
    const p = ensureRepEl();
    repCurrent = c.channelId;
    if (c.repVideoId) { repPlay(p, c.repVideoId, anchor); return; }
    // No representative short chosen yet → grab the channel's top recent short,
    // play it, and save it so it's instant next time (and syncs everywhere).
    repMsg(p, "Finding a short…");
    positionRep(p, anchor);
    p.classList.add("show");
    if (repFetching[c.channelId]) return;
    repFetching[c.channelId] = true;
    chrome.runtime.sendMessage({ type: "RECENT", channelId: c.channelId, maxItems: 30 }, (res) => {
      repFetching[c.channelId] = false;
      const stillHere = repCurrent === c.channelId;
      const pp = document.getElementById("rep-preview");
      const visible = pp && pp.classList.contains("show");
      if (chrome.runtime.lastError) return;
      if (!res || !res.ok) {
        if (stillHere && visible) repMsg(pp, res && res.error === "NO_API_KEY" ? "Set your API key (🔑) to preview shorts" : "Couldn't load a short");
        return;
      }
      const id = repBestShort(res.recent);
      if (!id) { if (stillHere && visible) repMsg(pp, "No short found for this channel"); return; }
      c.repVideoId = id;
      save(); // persist + sync so it's instant everywhere next time
      if (stillHere && visible) repPlay(pp, id, anchor);
    });
  }, 110);
}
function hideRepPreview() {
  clearTimeout(repShowTimer);
  repHideTimer = setTimeout(() => {
    repCurrent = null;
    const p = document.getElementById("rep-preview");
    if (p) { p.classList.remove("show"); p.innerHTML = ""; }
  }, 130);
}
function positionRep(p, anchor) {
  const r = anchor.getBoundingClientRect();
  const w = 236, h = 416;
  let left = r.right + 12;
  if (left + w > window.innerWidth - 8) left = r.left - w - 12;
  if (left < 8) left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8));
  let top = r.top - 24;
  if (top + h > window.innerHeight - 8) top = window.innerHeight - h - 8;
  if (top < 8) top = 8;
  p.style.cssText = `left:${left}px;top:${top}px;width:${w}px;height:${h}px`;
}
function setRep(c, videoId) {
  c.repVideoId = c.repVideoId === videoId ? "" : videoId;
  save();
  toast(c.repVideoId ? "Set as the channel's short" : "Cleared representative short");
}

// ---- vidIQ scan (extension only) -------------------------------------------
// Open a channel in a hidden background tab, let vidIQ load, capture its 7/30-day
// views (content.js does the reading), then close the tab — so you don't have to
// visit each channel by hand. Runs one at a time.
const SCAN_CONCURRENCY = 15; // scan this many channels at once
const SCAN_MAX_ATTEMPTS = 4;  // retry a channel until BOTH 7d and 30d are captured
let scanQueue = [], scanning = false, scanTotalUnique = 0, scanCompleted = 0, scanCancelled = false;
let scanAttempts = {};
function scanChannel(id) { scanMany([id]); }
function scanMany(ids) {
  ids = (ids || []).filter(Boolean);
  if (!IS_EXTENSION) { toast("Scanning runs in the extension board (it opens YouTube + vidIQ)."); return; }
  if (!ids.length) return;
  ids.forEach((id) => { if (scanAttempts[id] == null) scanAttempts[id] = 0; scanQueue.push(id); });
  scanTotalUnique += ids.length;
  if (!scanning) runScanQueue();
}
function cancelScan() { scanQueue = []; scanCancelled = true; toast("Stopping…"); }
function updateScanBtn() {
  const lbl = document.getElementById("scanAllLabel");
  const btn = document.getElementById("scanAllTop");
  if (lbl) lbl.textContent = scanning ? `Stop · ${scanCompleted}/${scanTotalUnique}` : "Scan vidIQ";
  if (btn) btn.classList.toggle("scanning", scanning);
}
async function runScanQueue() {
  scanning = true; scanCancelled = false; updateScanBtn();
  await Promise.all(Array.from({ length: SCAN_CONCURRENCY }, () => scanWorker()));
  const stopped = scanCancelled;
  let incomplete = 0;
  if (!stopped) {
    const vs = state.vidiqStats || {};
    Object.keys(scanAttempts).forEach((id) => { const s = vs[id] || {}; if (s.v7 == null || s.v30 == null) incomplete++; });
  }
  scanning = false; scanTotalUnique = 0; scanCompleted = 0; scanCancelled = false; scanAttempts = {};
  updateScanBtn();
  render();
  toast(stopped ? "Scan stopped" : incomplete ? `Scan done — ${incomplete} couldn't be read (try again)` : "Scan complete ✓ all captured");
}
async function scanWorker() {
  while (scanQueue.length && !scanCancelled) {
    const id = scanQueue.shift();
    scanAttempts[id] = (scanAttempts[id] || 0) + 1;
    const res = await scanOne(id);
    if (res.got7 && res.got30) { scanCompleted++; }
    else if (scanAttempts[id] < SCAN_MAX_ATTEMPTS && !scanCancelled) { scanQueue.push(id); } // retry until both captured
    else { scanCompleted++; } // gave up after max attempts
    updateScanBtn();
  }
}
function scanOne(id) {
  return new Promise((resolve) => {
    let finished = false, tabId = null, result = { got7: false, got30: false };
    const finish = () => {
      if (finished) return; finished = true;
      clearTimeout(to);
      chrome.runtime.onMessage.removeListener(onMsg);
      if (tabId != null) { try { chrome.tabs.remove(tabId, () => void chrome.runtime.lastError); } catch (e) {} }
      setTimeout(() => resolve(result), 200);
    };
    const onMsg = (msg) => { if (msg && msg.type === "SS_SCAN_DONE" && msg.channelId === id) { result = { got7: !!msg.got7, got30: !!msg.got30 }; finish(); } };
    const to = setTimeout(finish, 26000); // hard cap if vidIQ never loads
    chrome.runtime.onMessage.addListener(onMsg);
    try {
      chrome.tabs.create({ url: `https://www.youtube.com/channel/${id}#ssscan`, active: false }, (tab) => { tabId = tab && tab.id; });
    } catch (e) { finish(); }
  });
}

// Once per session (when stale): for each channel, fetch its recent uploads to
// (a) pick a representative short if none is set, and (b) compute views on
// uploads from the last 7 / 30 days. Throttled; best-effort; cached per channel.
let statsWarmed = false;
function warmRecentStats() {
  if (statsWarmed) return;
  statsWarmed = true;
  const now = Date.now();
  const d7 = now - 7 * 86400e3, d30 = now - 30 * 86400e3;
  // Refetch channels with no stats yet or stats older than ~20h; always fill a missing rep.
  const todo = state.watchlist.filter((c) => c.channelId && (!c.recentStatsAt || now - c.recentStatsAt > 20 * 3600e3 || !c.repVideoId || c.v7 == null));
  if (!todo.length) return;
  const total = todo.length;
  let updated = 0, noKey = false, announced = false;
  const queue = todo.slice();
  const fetchOne = (c) => new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "RECENT", channelId: c.channelId, maxItems: 150 }, (res) => {
      if (chrome.runtime.lastError) return resolve();
      if (res && !res.ok && res.error === "NO_API_KEY") { noKey = true; return resolve(); }
      if (res && res.ok && Array.isArray(res.recent)) {
        let v7 = 0, v30 = 0;
        for (const r of res.recent) {
          if (typeof r.publishedAt !== "number" || typeof r.views !== "number") continue;
          if (r.publishedAt >= d30) v30 += r.views;
          if (r.publishedAt >= d7) v7 += r.views;
        }
        c.v7 = v7; c.v30 = v30; c.recentStatsAt = now;
        if (!c.repVideoId) { const id = repBestShort(res.recent); if (id) c.repVideoId = id; }
        updated++;
        if (!announced) { announced = true; toast(`Loading recent views… (${total} channels)`); }
      }
      resolve();
    });
  });
  const worker = async () => { while (queue.length && !noKey) await fetchOne(queue.shift()); };
  Promise.all([worker(), worker(), worker(), worker()]).then(() => {
    if (noKey && !updated) { toast("Set your YouTube API key (🔑) to load recent views"); return; }
    if (updated) { save(); render(); toast(`Recent views ready ✓ (${updated} channels)`); }
  });
}

function avatarHtml(c, cls = "") {
  if (c.thumb) return `<img class="avatar ${cls}" src="${esc(c.thumb)}" alt="" referrerpolicy="no-referrer">`;
  const letter = (c.title || "?").trim().charAt(0).toUpperCase();
  return `<div class="avatar ph ${cls}">${esc(letter)}</div>`;
}

function renderCard(c) {
  const card = document.createElement("div");
  card.className = "card" + (c.topCandidate ? " topcand" : "");
  card.draggable = true;

  const avg = avgPerVideo(c);
  const hot = avg >= hotThreshold;
  const handle = c.customUrl ? esc(c.customUrl.startsWith("@") ? c.customUrl : "@" + c.customUrl) : "";
  const vq = (state.vidiqStats || {})[c.channelId] || {}; // real 7/30-day views from vidIQ
  const mom = vqMomentum(c); // recent pace vs monthly pace (>1 heating up)
  const momPill = mom == null ? "" :
    `<span class="pill mom ${mom >= 1.15 ? "up" : mom <= 0.85 ? "down" : "flat"}" title="Recent 7-day pace vs the 30-day average. 🔥 = speeding up, ❄️ = cooling.">${mom >= 1.15 ? "🔥" : mom <= 0.85 ? "❄️" : "→"} ${mom >= 1 ? "+" : ""}${Math.round((mom - 1) * 100)}%</span>`;

  const nicheChipsHtml = (c.niches || []).length
    ? `<div class="card-niches">${(c.niches || []).map((n) => `<span class="nichechip" style="--nc:${nicheColor(n)}">${esc(n)}<b data-rmniche="${esc(n)}" title="Remove">×</b></span>`).join("")}</div>`
    : "";

  const tagChips = labelChipsHtml(c);

  const exHtml = (c.examples || [])
    .map((ex, i) => `<a class="ex" href="${esc(ex.url)}" target="_blank" rel="noopener"><span class="lbl">${esc(ex.title || ex.url)}</span><span class="rm" data-rmex="${i}" title="Remove">✕</span></a>`)
    .join("");

  card.innerHTML = `
    ${c.topCandidate ? `<div class="card-topflag">★ TOP CANDIDATE</div>` : ""}
    ${nicheChipsHtml}
    ${tagChips}
    <div class="card-head">
      ${avatarHtml(c)}
      <div class="card-id">
        <a class="card-name" href="${channelUrl(c)}" target="_blank" rel="noopener">${esc(c.title) || "Channel"}</a>
        <div class="card-handle">${handle || "&nbsp;"}</div>
      </div>
      <button class="card-star ${c.topCandidate ? "on" : ""}" title="${c.topCandidate ? "Top candidate" : "Mark as top candidate"}">${c.topCandidate ? "★" : "☆"}</button>
      <button class="card-x" title="Remove">✕</button>
    </div>

    <div class="metrics">
      <div class="metric ${hot ? "hot" : ""}">
        ${hot ? '<span class="flame">🔥</span>' : ""}
        <b>${avg ? compact(avg) : "—"}</b>
        <span>avg / video</span>
      </div>
      <div class="metric">
        <b>${fmtReach(c)}</b>
        <span>reach / video</span>
      </div>
    </div>

    <div class="substats">
      <span class="pill">▶ <b>${compact(c.totalViews)}</b></span>
      <span class="pill">👤 <b>${compact(c.subscribers)}</b></span>
      <span class="pill">🎬 <b>${compact(c.videoCount)}</b></span>
      ${momPill}
    </div>

    <div class="recentviews" title="Real views gained, read from vidIQ. Click ⟳ to scan this channel now, or it captures when you open the channel on YouTube.">
      <span class="rv${vq.v7 != null ? " has" : ""}"><b>${typeof vq.v7 === "number" ? compact(vq.v7) : "—"}</b><i>views · 7d</i></span>
      <span class="rv${vq.v30 != null ? " has" : ""}"><b>${typeof vq.v30 === "number" ? compact(vq.v30) : "—"}</b><i>views · 30d</i></span>
      ${IS_EXTENSION ? `<button class="rv-scan" data-act="scan" title="Scan now with vidIQ (opens this channel briefly, reads the numbers, closes it)">⟳</button>` : ""}
    </div>

    <div class="controls">
      <button class="ico" data-act="niches" title="Edit niches">📁 Niches</button>
      <button class="ico" data-act="labels" title="Edit tags, made by/for, language">🏷 Labels</button>
    </div>

    <div class="foot">
      <button class="ico" data-act="review">▶ Review</button>
      <button class="ico" data-act="notes">📝 Notes</button>
      <button class="ico" data-act="copy">📋 URL</button>
    </div>

    <textarea class="notes${c.notes ? " open" : ""}" placeholder="What's the format? Why does it work? Hooks, length, style…">${esc(c.notes)}</textarea>

    <div class="examples">${exHtml}<button class="ex-add">＋ example</button></div>

    <button class="recent-toggle">${expanded.has(c.channelId) ? "▴ Hide recent shorts" : "▾ Recent shorts"}</button>
    <div class="recent-panel${expanded.has(c.channelId) ? " open" : ""}">${expanded.has(c.channelId) ? recentPanelHtml(c) : ""}</div>`;

  wireCard(card, c);
  return card;
}

function recentPanelHtml(c) {
  const cache = recentCache[c.channelId];
  if (!cache || cache.loading) return `<div class="rs-msg">Loading recent shorts…</div>`;
  if (cache.error) return `<div class="rs-msg">${esc(cache.error)}</div>`;
  const all = cache.recent || [];
  const shorts = all.filter((r) => r.isShort);
  const list = (shorts.length >= 4 ? shorts : all).slice(0, 9);
  if (!list.length) return `<div class="rs-msg">No recent shorts found.</div>`;

  const cells = list
    .map(
      (r) => `
    <a class="rs-item" href="https://www.youtube.com/shorts/${r.videoId}" target="_blank" rel="noopener" title="${esc(r.title)}">
      <span class="rs-thumb" style="background-image:url('${esc(r.thumb)}')">
        <span class="rs-pin${c.repVideoId === r.videoId ? " on" : ""}" data-pin="${r.videoId}" title="Use as this channel's representative short (hover-to-play)">📌</span>
        <span class="rs-views">${compact(r.views)}</span>
      </span>
      <span class="rs-ago">${timeAgo(r.publishedAt)}</span>
    </a>`
    )
    .join("");
  return `<div class="rs-grid">${cells}</div>
    <a class="rs-all" href="https://www.youtube.com/channel/${c.channelId}/shorts" target="_blank" rel="noopener">Open all shorts on YouTube ↗</a>`;
}

// Wire the 📌 "set representative short" buttons inside a recent-shorts panel.
function wireRepPins(scope, c) {
  scope.querySelectorAll("[data-pin]").forEach((b) => {
    b.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      setRep(c, b.dataset.pin);
      scope.querySelectorAll(".rs-pin").forEach((x) => x.classList.toggle("on", x.dataset.pin === c.repVideoId));
    };
  });
}

// Toggle the recent-shorts panel IN PLACE (no full board re-render) so the board's
// horizontal scroll position isn't reset.
function toggleRecent(c, card) {
  const panel = card.querySelector(".recent-panel");
  const btn = card.querySelector(".recent-toggle");
  if (expanded.has(c.channelId)) {
    expanded.delete(c.channelId);
    panel.classList.remove("open");
    panel.innerHTML = "";
    btn.textContent = "▾ Recent shorts";
    return;
  }
  expanded.add(c.channelId);
  btn.textContent = "▴ Hide recent shorts";
  panel.classList.add("open");
  const cache = recentCache[c.channelId];
  if (cache && cache.recent) {
    panel.innerHTML = recentPanelHtml(c);
    wireRepPins(panel, c);
    return;
  }
  panel.innerHTML = `<div class="rs-msg">Loading recent shorts…</div>`;
  if (cache && cache.loading) return;
  recentCache[c.channelId] = { loading: true };
  chrome.runtime.sendMessage({ type: "RECENT", channelId: c.channelId }, (resp) => {
    if (chrome.runtime.lastError || !resp) recentCache[c.channelId] = { error: "Couldn't load — is the extension loaded?" };
    else if (!resp.ok) recentCache[c.channelId] = { error: resp.error === "NO_API_KEY" ? "Set your API key first" : "Couldn't load recent shorts" };
    else recentCache[c.channelId] = { recent: resp.recent || [] };
    if (expanded.has(c.channelId)) { panel.innerHTML = recentPanelHtml(c); wireRepPins(panel, c); }
  });
}

function toggleChannelNiche(c, niche) {
  if (!Array.isArray(c.niches)) c.niches = [];
  const i = c.niches.indexOf(niche);
  if (i >= 0) c.niches.splice(i, 1);
  else c.niches.push(niche);
}

// Inline multi-select NICHE editor. Toggling a niche changes which columns the card
// appears in, so the board is re-laid-out when the editor closes (not on each toggle).
function refreshCardNicheDisplay(card, c) {
  let disp = card.querySelector(".card-niches");
  const list = c.niches || [];
  if (list.length) {
    if (!disp) {
      disp = document.createElement("div");
      disp.className = "card-niches";
      card.insertBefore(disp, card.firstChild);
    }
    disp.innerHTML = list.map((n) => `<span class="nichechip" style="--nc:${nicheColor(n)}">${esc(n)}<b data-rmniche="${esc(n)}" title="Remove">×</b></span>`).join("");
    disp.querySelectorAll("[data-rmniche]").forEach((b) => {
      b.onclick = () => {
        toggleChannelNiche(c, b.dataset.rmniche);
        save();
        render();
      };
    });
  } else if (disp) {
    disp.remove();
  }
}
function toggleCardNicheEditor(card, c) {
  const existing = card.querySelector(".card-nicheedit");
  if (existing) {
    existing.remove();
    render(); // reflow columns now that niches may have changed
    return;
  }
  const ed = document.createElement("div");
  ed.className = "card-nicheedit";
  ed.innerHTML =
    state.niches.map((n) => `<button class="nicheopt ${(c.niches || []).includes(n) ? "on" : ""}" data-niche="${esc(n)}" style="--nc:${nicheColor(n)}">${esc(n)}</button>`).join("") +
    `<button class="nicheopt new" data-newniche>＋ New</button>`;
  card.querySelector(".controls").insertAdjacentElement("afterend", ed);
  ed.querySelectorAll("[data-niche]").forEach((b) => {
    b.onclick = () => {
      toggleChannelNiche(c, b.dataset.niche);
      b.classList.toggle("on");
      save();
      refreshCardNicheDisplay(card, c);
    };
  });
  ed.querySelector("[data-newniche]").onclick = () => {
    const name = (prompt("New niche name:") || "").trim();
    if (!name) return;
    if (!state.niches.includes(name)) state.niches.push(name);
    if (!Array.isArray(c.niches)) c.niches = [];
    if (!c.niches.includes(name)) c.niches.push(name);
    save();
    ed.remove();
    toggleCardNicheEditor(card, c);
    refreshCardNicheDisplay(card, c);
  };
}

// Generic multi-select label dimensions (tags / made by / made for / language).
function chanArr(c, field) {
  return Array.isArray(c[field]) ? c[field] : [];
}
function toggleAttr(c, field, val) {
  if (!Array.isArray(c[field])) c[field] = [];
  const i = c[field].indexOf(val);
  if (i >= 0) c[field].splice(i, 1);
  else c[field].push(val);
}
function labelChipsHtml(c) {
  let html = "";
  for (const d of ATTR_DIMS) {
    html += chanArr(c, d.field)
      .map((v) => `<span class="labelchip ${d.cls}">${d.icon || ""}${esc((d.prefix || "") + v)}</span>`)
      .join("");
  }
  return html ? `<div class="card-tags">${html}</div>` : "";
}
function refreshCardLabels(card, c) {
  let disp = card.querySelector(".card-tags");
  const html = labelChipsHtml(c);
  if (html) {
    if (!disp) {
      disp = document.createElement("div");
      disp.className = "card-tags";
      const niches = card.querySelector(".card-niches");
      if (niches) niches.insertAdjacentElement("afterend", disp);
      else card.insertBefore(disp, card.firstChild);
    }
    disp.outerHTML = html; // replace wrapper with fresh one
  } else if (disp) {
    disp.remove();
  }
}
// Compact dropdown widget: a row of dimension buttons; clicking one reveals its
// options inline below. Used on cards, in the drawer, and (mirrored) in the panel.
function labelsWidgetHtml(c) {
  const btns = ATTR_DIMS.map(
    (d) => `<button class="msd-btn" type="button" data-field="${d.field}">${esc(d.label)}<span class="msd-count" data-cnt="${d.field}">${chanArr(c, d.field).length || ""}</span><span class="msd-caret">▾</span></button>`
  ).join("");
  return `<div class="msd-wrap"><div class="msd-row">${btns}</div><div class="msd-panel"></div></div>`;
}
function wireLabelsWidget(scope, c, onChange) {
  const panel = scope.querySelector(".msd-panel");
  const renderPanel = (field) => {
    const d = ATTR_DIMS.find((x) => x.field === field);
    panel.innerHTML =
      state[field].map((v) => `<button class="msd-opt ${chanArr(c, field).includes(v) ? "on" : ""}" data-val="${esc(v)}">${esc(v)}</button>`).join("") +
      `<button class="msd-opt new" data-newval>＋ New</button>`;
    const setCount = () => {
      const badge = scope.querySelector(`[data-cnt="${field}"]`);
      if (badge) badge.textContent = chanArr(c, field).length || "";
    };
    panel.querySelectorAll("[data-val]").forEach((b) => {
      b.onclick = () => {
        toggleAttr(c, field, b.dataset.val);
        b.classList.toggle("on");
        setCount();
        save();
        onChange && onChange();
      };
    });
    panel.querySelector("[data-newval]").onclick = () => {
      const name = (prompt(`New ${d.label} option:`) || "").trim();
      if (!name) return;
      if (!state[field].includes(name)) state[field].push(name);
      if (!Array.isArray(c[field])) c[field] = [];
      if (!c[field].includes(name)) c[field].push(name);
      save();
      renderPanel(field);
      setCount();
      onChange && onChange();
    };
  };
  scope.querySelectorAll(".msd-btn").forEach((btn) => {
    btn.onclick = () => {
      const active = btn.classList.contains("active");
      scope.querySelectorAll(".msd-btn").forEach((b) => b.classList.remove("active"));
      if (active) {
        panel.classList.remove("open");
        panel.innerHTML = "";
        return;
      }
      btn.classList.add("active");
      panel.classList.add("open");
      renderPanel(btn.dataset.field);
    };
  });
}

function toggleCardLabelEditor(card, c) {
  const existing = card.querySelector(".card-labeledit");
  if (existing) return existing.remove();
  const ed = document.createElement("div");
  ed.className = "card-labeledit";
  ed.innerHTML = labelsWidgetHtml(c);
  card.querySelector(".controls").insertAdjacentElement("afterend", ed);
  wireLabelsWidget(ed, c, () => refreshCardLabels(card, c));
}

function wireCard(card, c) {
  card.addEventListener("dragstart", (e) => {
    e.dataTransfer.setData("text/plain", c.channelId);
    e.dataTransfer.effectAllowed = "move";
    card.classList.add("dragging");
  });
  card.addEventListener("dragend", () => card.classList.remove("dragging"));

  card.querySelector(".card-x").onclick = () => removeChannel(c.channelId);
  card.querySelector(".card-star").onclick = () => {
    c.topCandidate = !c.topCandidate;
    const wantNote = c.topCandidate && !(c.notes && c.notes.trim());
    save();
    render();
    if (wantNote) {
      // re-open this card's notes so they can jot why
      const fresh = document.querySelector(`.card .card-name[href="${channelUrl(c)}"]`);
      const cardEl = fresh && fresh.closest(".card");
      if (cardEl) {
        cardEl.querySelector(".notes").classList.add("open");
        cardEl.querySelector(".notes").focus();
      }
    }
    toast(c.topCandidate ? "★ Marked top candidate" : "Unmarked");
  };
  card.querySelector('[data-act="niches"]').onclick = () => toggleCardNicheEditor(card, c);
  card.querySelectorAll("[data-rmniche]").forEach((b) => {
    b.onclick = () => {
      toggleChannelNiche(c, b.dataset.rmniche);
      save();
      render();
    };
  });
  card.querySelector('[data-act="labels"]').onclick = () => toggleCardLabelEditor(card, c);
  card.querySelector('[data-act="review"]').onclick = () => openReview(c.channelId);
  card.querySelector('[data-act="copy"]').onclick = (e) => {
    navigator.clipboard.writeText(channelUrl(c));
    toast("Channel URL copied");
  };
  const notes = card.querySelector(".notes");
  card.querySelector('[data-act="notes"]').onclick = () => notes.classList.toggle("open");
  const scanBtn = card.querySelector('[data-act="scan"]');
  if (scanBtn) scanBtn.onclick = () => scanChannel(c.channelId);
  notes.onchange = () => {
    c.notes = notes.value;
    save();
  };
  card.querySelector(".ex-add").onclick = () => addExample(c);
  card.querySelectorAll("[data-rmex]").forEach((b) => {
    b.onclick = (e) => {
      e.preventDefault();
      c.examples.splice(Number(b.dataset.rmex), 1);
      save();
      render();
    };
  });
  card.querySelector(".recent-toggle").onclick = () => toggleRecent(c, card);

  // Hover the channel header → play the representative short.
  const head = card.querySelector(".card-head");
  if (head) {
    head.classList.add("has-rep"); // hoverable: plays the pick, or auto-grabs one
    head.addEventListener("mouseenter", () => showRepPreview(c, head));
    head.addEventListener("mouseleave", hideRepPreview);
  }
  // Pins inside an already-open recent panel (after a full re-render).
  if (expanded.has(c.channelId)) wireRepPins(card.querySelector(".recent-panel"), c);
}

// ---- table view ------------------------------------------------------------

function renderTable() {
  const wrap = document.createElement("div");
  wrap.className = "tablewrap";
  const list = sortChannels(visibleChannels());

  const cols = [
    { key: "name", label: "Channel", sort: null },
    { key: "niche", label: "Niche", sort: null },
    { key: "avg", label: "Avg / video", sort: "avg" },
    { key: "reach", label: "Reach", sort: "reach" },
    { key: "views", label: "Total views", sort: "views" },
    { key: "subs", label: "Subs", sort: "subs" },
    { key: "videos", label: "Videos", sort: "videos" },
    { key: "tags", label: "Tags", sort: null },
    { key: "rm", label: "", sort: null },
  ];

  const thead = cols
    .map((col) => `<th data-sort="${col.sort || ""}">${col.label}${col.sort && state.sort === col.sort ? ' <span class="arr">▼</span>' : ""}</th>`)
    .join("");

  const rows = list
    .map((c) => {
      const avg = avgPerVideo(c);
      const hot = avg >= hotThreshold;
      const nicheCell = (c.niches || []).length ? (c.niches || []).map((n) => `<span class="nichechip" style="--nc:${nicheColor(n)}">${esc(n)}</span>`).join(" ") : '<span class="num-dim">—</span>';
      const tagCell = (c.tags || []).length ? (c.tags || []).map((t) => `<span class="tagchip">${esc(t)}</span>`).join(" ") : '<span class="num-dim">—</span>';
      return `<tr data-id="${c.channelId}">
        <td><div class="tcell-name">${avatarHtml(c)}<a href="${channelUrl(c)}" target="_blank" rel="noopener">${esc(c.title) || "Channel"}</a></div></td>
        <td><div class="t-tags">${nicheCell}</div></td>
        <td class="${hot ? "num-hot" : ""}">${hot ? "🔥 " : ""}${avg ? compact(avg) : "—"}</td>
        <td>${fmtReach(c)}</td>
        <td>${compact(c.totalViews)}</td>
        <td>${compact(c.subscribers)}</td>
        <td>${compact(c.videoCount)}</td>
        <td><div class="t-tags">${tagCell}</div></td>
        <td style="white-space:nowrap"><button class="trev" title="Review shorts">▶</button> <button class="trm" title="Remove">✕</button></td>
      </tr>`;
    })
    .join("");

  wrap.innerHTML = `<table class="tbl"><thead><tr>${thead}</tr></thead><tbody>${rows}</tbody></table>`;

  wrap.querySelectorAll("th[data-sort]").forEach((th) => {
    const s = th.dataset.sort;
    if (s) th.onclick = () => {
      state.sort = s;
      syncControls();
      save();
      render();
    };
  });
  wrap.querySelectorAll("tr[data-id]").forEach((tr) => {
    const c = findChannel(tr.dataset.id);
    if (!c) return;
    tr.querySelector(".trev").onclick = () => openReview(c.channelId);
    tr.querySelector(".trm").onclick = () => removeChannel(c.channelId);
  });

  return wrap;
}

// ---- mutations -------------------------------------------------------------

function removeChannel(id) {
  const i = state.watchlist.findIndex((c) => c.channelId === id);
  if (i < 0) return;
  const name = state.watchlist[i].title;
  state.watchlist.splice(i, 1);
  save();
  render();
  toast(`Removed ${name || "channel"}`);
}

function addExample(c) {
  const url = prompt("Paste a YouTube short/video URL to pin as an example:");
  if (!url) return;
  const title = (prompt("Optional label (blank = use the URL):") || "").trim();
  c.examples = c.examples || [];
  c.examples.push({ url: url.trim(), title });
  save();
  render();
}

function addNiche(name) {
  name = (name || "").trim();
  if (!name) return;
  if (state.niches.includes(name)) return toast("That niche already exists");
  state.niches.push(name);
  save();
  render();
  toast(`Added niche: ${name}`);
}
function promptAddNiche() {
  const name = prompt("New niche name:");
  if (name) addNiche(name);
}
function renameNiche(oldName) {
  const name = (prompt("Rename niche:", oldName) || "").trim();
  if (!name || name === oldName) return;
  if (state.niches.includes(name)) return alert("A niche with that name already exists.");
  state.niches = state.niches.map((n) => (n === oldName ? name : n));
  state.watchlist.forEach((c) => { if (Array.isArray(c.niches)) c.niches = c.niches.map((n) => (n === oldName ? name : n)); });
  // Keep the parent map in sync (both keys and values).
  const np = {};
  Object.entries(state.nicheParents).forEach(([k, v]) => {
    np[k === oldName ? name : k] = v === oldName ? name : v;
  });
  state.nicheParents = np;
  save();
  render();
}
function deleteNiche(name) {
  if (!confirm(`Delete the "${name}" niche? Channels keep their other niches.`)) return;
  state.niches = state.niches.filter((n) => n !== name);
  state.watchlist.forEach((c) => { if (Array.isArray(c.niches)) c.niches = c.niches.filter((n) => n !== name); });
  delete state.nicheParents[name];
  // Orphan any sub-niches that pointed at it.
  Object.keys(state.nicheParents).forEach((k) => { if (state.nicheParents[k] === name) delete state.nicheParents[k]; });
  save();
  render();
}

// ---- tag management --------------------------------------------------------

function renameTag(oldName) {
  const name = (prompt("Rename tag:", oldName) || "").trim();
  if (!name || name === oldName) return;
  if (state.tags.includes(name)) return alert("A tag with that name already exists.");
  state.tags = state.tags.map((t) => (t === oldName ? name : t));
  state.watchlist.forEach((c) => {
    if (Array.isArray(c.tags)) c.tags = c.tags.map((t) => (t === oldName ? name : t));
  });
  save();
  render();
  openTagManager();
}
function deleteTag(name) {
  if (!confirm(`Delete tag "${name}"? It will be removed from every channel.`)) return;
  state.tags = state.tags.filter((t) => t !== name);
  state.watchlist.forEach((c) => {
    if (Array.isArray(c.tags)) c.tags = c.tags.filter((t) => t !== name);
  });
  save();
  render();
  openTagManager();
}
function openTagManager() {
  let m = document.getElementById("tagmodal");
  if (!m) {
    m = document.createElement("div");
    m.id = "tagmodal";
    document.body.appendChild(m);
  }
  const rows = state.tags.length
    ? state.tags
        .map(
          (t) => `<div class="tm-row">
            <span class="tm-name">${esc(t)}</span>
            <div class="tm-actions"><button class="tm-edit" data-t="${esc(t)}">Rename</button><button class="tm-del" data-t="${esc(t)}">Delete</button></div>
          </div>`
        )
        .join("")
    : `<div class="rs-msg" style="padding:18px">No tags yet — add one below.</div>`;
  m.innerHTML = `<div class="tm-back"></div><div class="tm-inner">
    <div class="tm-head"><b>Manage tags</b><button class="tm-x" title="Close">✕</button></div>
    <div class="tm-list">${rows}</div>
    <div class="tm-add"><input id="tm-new" type="text" placeholder="New tag name…" /><button class="btn primary" id="tm-addbtn">Add</button></div>
  </div>`;
  m.classList.add("open");
  m.querySelector(".tm-x").onclick = closeTagManager;
  m.querySelector(".tm-back").onclick = closeTagManager;
  m.querySelectorAll(".tm-edit").forEach((b) => (b.onclick = () => renameTag(b.dataset.t)));
  m.querySelectorAll(".tm-del").forEach((b) => (b.onclick = () => deleteTag(b.dataset.t)));
  const addTag = () => {
    const v = m.querySelector("#tm-new").value.trim();
    if (!v) return;
    if (!state.tags.includes(v)) {
      state.tags.push(v);
      save();
    }
    openTagManager();
  };
  m.querySelector("#tm-addbtn").onclick = addTag;
  m.querySelector("#tm-new").addEventListener("keydown", (e) => {
    if (e.key === "Enter") addTag();
  });
}
function closeTagManager() {
  const m = document.getElementById("tagmodal");
  if (m) {
    m.classList.remove("open");
    m.innerHTML = "";
  }
}

// ---- niche groups (hierarchy) manager --------------------------------------

function openGroupsManager() {
  let m = document.getElementById("groupmodal");
  if (!m) {
    m = document.createElement("div");
    m.id = "groupmodal";
    document.body.appendChild(m);
  }
  const childRow = (n) => {
    const opts = ['<option value="">— top level —</option>']
      .concat(topLevelNiches().filter((p) => p !== n).map((p) => `<option value="${esc(p)}"${parentOf(n) === p ? " selected" : ""}>${esc(p)}</option>`))
      .join("");
    return `<div class="tm-row gm-childrow"><span class="tm-name">${parentOf(n) ? "↳ " : ""}${esc(n)}</span>
      <div class="tm-actions"><select class="gm-parent" data-n="${esc(n)}">${opts}</select></div></div>`;
  };
  let rowsHtml = "";
  if (!state.niches.length) {
    rowsHtml = `<div class="rs-msg" style="padding:18px">No niches yet.</div>`;
  } else {
    topLevelNiches().forEach((p) => {
      const kids = childrenOf(p);
      if (kids.length) {
        rowsHtml += `<div class="tm-row gm-parentrow"><span class="tm-name">${esc(p)} <span class="gm-badge">${kids.length} sub</span></span></div>`;
        kids.slice().sort((a, b) => a.localeCompare(b)).forEach((k) => (rowsHtml += childRow(k)));
      } else {
        rowsHtml += childRow(p);
      }
    });
  }
  m.innerHTML = `<div class="tm-back"></div><div class="tm-inner">
    <div class="tm-head"><b>Niche groups</b><button class="tm-x" title="Close">✕</button></div>
    <div class="gm-auto-bar"><button class="btn primary" id="gm-auto">✨ Auto-group by suffix</button><span class="gm-hint">"family skits" → <b>Skits</b> · "kids brain rot" → <b>brain rot</b></span></div>
    <div class="tm-list">${rowsHtml}</div>
  </div>`;
  m.classList.add("open");
  m.querySelector(".tm-x").onclick = closeGroupsManager;
  m.querySelector(".tm-back").onclick = closeGroupsManager;
  m.querySelector("#gm-auto").onclick = () => {
    autoGroupNiches();
    openGroupsManager();
  };
  m.querySelectorAll(".gm-parent").forEach((sel) => {
    sel.onchange = (e) => {
      const n = sel.dataset.n;
      const v = e.target.value;
      if (v) state.nicheParents[n] = v;
      else delete state.nicheParents[n];
      save();
      render();
      openGroupsManager();
    };
  });
}
function closeGroupsManager() {
  const m = document.getElementById("groupmodal");
  if (m) {
    m.classList.remove("open");
    m.innerHTML = "";
  }
}

// ---- refresh from API ------------------------------------------------------

let refreshing = false;
function doRefresh(silent) {
  if (refreshing || !state.watchlist.length) return;
  refreshing = true;
  const btn = document.getElementById("refresh");
  if (btn) btn.classList.add("spin");
  const ids = state.watchlist.map((c) => c.channelId);
  chrome.runtime.sendMessage({ type: "REFRESH_CHANNELS", ids }, (resp) => {
    refreshing = false;
    if (btn) btn.classList.remove("spin");
    if (chrome.runtime.lastError) return silent || toast("Refresh failed — is the extension loaded?");
    if (!resp || !resp.ok) return silent || toast(resp && resp.error === "NO_API_KEY" ? "Set your API key first" : "Refresh failed");
    let n = 0;
    const now = Date.now();
    for (const c of state.watchlist) {
      const u = resp.channels[c.channelId];
      if (u) {
        c.title = u.title || c.title;
        c.totalViews = u.totalViews;
        c.subscribers = u.subscribers;
        c.videoCount = u.videoCount;
        c.thumb = u.thumb || c.thumb;
        c.customUrl = u.customUrl || c.customUrl;
        c.refreshedAt = now;
        n++;
      }
    }
    save();
    recordSnapshot();
    render();
    if (!silent) toast(`Refreshed ${n} channel${n === 1 ? "" : "s"}`);
  });
}

// ---- review drawer (watch a channel's shorts + categorize in place) --------

// A docked popup window showing the channel's REAL YouTube shorts page (the full
// webpage can't be iframed, so this is the closest: a real window on the right).
let shortsWinId = null;
let shortsTabId = null;
function openShortsWindow(url) {
  if (shortsWinId != null) {
    if (shortsTabId != null) chrome.tabs.update(shortsTabId, { url });
    chrome.windows.update(shortsWinId, { focused: false });
    return;
  }
  const width = 480;
  const availH = (window.screen && screen.availHeight) || 900;
  const availW = (window.screen && screen.availWidth) || 1440;
  chrome.windows.create({ url, type: "popup", width, height: Math.max(500, availH - 60), left: Math.max(0, availW - width - 16), top: 20, focused: false }, (w) => {
    if (!w) return;
    shortsWinId = w.id;
    shortsTabId = w.tabs && w.tabs[0] && w.tabs[0].id;
  });
}
if (chrome.windows && chrome.windows.onRemoved) {
  chrome.windows.onRemoved.addListener((id) => {
    if (id === shortsWinId) { shortsWinId = null; shortsTabId = null; }
  });
}

function reviewList() {
  const cache = recentCache[reviewId];
  if (!cache || !cache.recent) return [];
  const all = cache.recent;
  const shorts = all.filter((r) => r.isShort);
  return shorts.length >= 3 ? shorts : all;
}

function openReview(channelId) {
  reviewId = channelId;
  reviewIndex = 0;
  document.body.classList.add("drawer-open");
  document.getElementById("drawer").classList.add("open");
  // If the real-shorts side window is open, follow along to the new channel.
  if (shortsWinId != null) openShortsWindow(`https://www.youtube.com/channel/${channelId}/shorts`);
  const cache = recentCache[channelId];
  if (!cache || (!cache.recent && !cache.loading && !cache.error)) {
    recentCache[channelId] = { loading: true };
    chrome.runtime.sendMessage({ type: "RECENT", channelId }, (resp) => {
      if (chrome.runtime.lastError || !resp) recentCache[channelId] = { error: "Couldn't load — is the extension loaded?" };
      else if (!resp.ok) recentCache[channelId] = { error: resp.error === "NO_API_KEY" ? "Set your API key first" : "Couldn't load shorts" };
      else recentCache[channelId] = { recent: resp.recent || [] };
      if (reviewId === channelId) renderDrawer();
    });
  }
  renderDrawer();
}

function closeReview() {
  reviewId = null;
  document.body.classList.remove("drawer-open");
  document.getElementById("drawer").classList.remove("open");
}

function setReviewIndex(i) {
  const list = reviewList();
  if (!list.length) return;
  reviewIndex = (i + list.length) % list.length;
  renderDrawer();
}

function nextUnsorted() {
  const pool = sortChannels(state.watchlist.filter((c) => !(c.niches || []).some((n) => state.niches.includes(n))));
  const next = pool.find((c) => c.channelId !== reviewId) || pool[0];
  if (next && next.channelId !== reviewId) openReview(next.channelId);
  else {
    toast("No more unsorted channels 🎉");
    closeReview();
  }
}

function renderDrawer() {
  const drawer = document.getElementById("drawer");
  const c = findChannel(reviewId);
  if (!c) return closeReview();
  const cache = recentCache[reviewId];

  let viewer;
  if (!cache || cache.loading) viewer = `<div class="rs-msg">Loading shorts…</div>`;
  else if (cache.error) viewer = `<div class="rs-msg">${esc(cache.error)}</div>`;
  else {
    const list = reviewList();
    if (!list.length) viewer = `<div class="rs-msg">No shorts found for this channel.</div>`;
    else {
      const cells = list
        .map((r, i) => {
          const saved = state.savedVideos.some((v) => v.videoId === r.videoId);
          return `<div class="dw-item">
            <button class="dw-itemthumb" data-watch="${r.videoId}" style="background-image:url('${esc(r.thumb)}')" title="Watch in side window">
              <span class="dw-itempin${c.repVideoId === r.videoId ? " on" : ""}" data-pin="${r.videoId}" title="Use as this channel's representative short (hover-to-play)">📌</span>
              <span class="dw-itemsave${saved ? " on" : ""}" data-save="${i}" title="${saved ? "Saved" : "Save short"}">🔖</span>
              <span class="dw-itemviews">${compact(r.views)}</span>
            </button>
            <div class="dw-itemtitle">${esc(r.title) || "Short"}</div>
            <div class="dw-itemago">${timeAgo(r.publishedAt)}</div>
          </div>`;
        })
        .join("");
      viewer = `<div class="dw-hint">${list.length} recent shorts · tap to watch · 🔖 save · 📌 set as the channel's short</div><div class="dw-grid">${cells}</div>`;
    }
  }

  const nicheChips = state.niches.map((n) => `<button class="chip ${(c.niches || []).includes(n) ? "on" : ""}" data-niche="${esc(n)}">${esc(n)}</button>`).join("");

  drawer.innerHTML = `
    <div class="dw-head">
      ${avatarHtml(c)}
      <div style="flex:1;min-width:0">
        <div class="dw-name">${esc(c.title) || "Channel"}</div>
        <a class="dw-link" href="${channelUrl(c)}/shorts" target="_blank" rel="noopener">Open on YouTube ↗</a>
      </div>
      <button class="dw-x" title="Close (Esc)">✕</button>
    </div>
    <div class="dw-body">
      <button class="dw-topcand ${c.topCandidate ? "on" : ""}" data-act="topcand">${c.topCandidate ? "★ Top candidate" : "☆ Mark as top candidate"}</button>
      <div>
        <div class="dw-label">Niches <span class="an-hint" style="text-transform:none;letter-spacing:0">select any — channels can do several</span></div>
        <div class="chips">${nicheChips}<button class="chip new" data-newniche>＋ New</button></div>
      </div>
      <div>
        <div class="dw-label">Labels <span class="an-hint" style="text-transform:none;letter-spacing:0">tags · made by/for · language</span></div>
        ${labelsWidgetHtml(c)}
      </div>
      <button class="dw-realpage" title="Pop the real YouTube shorts page into a window docked on the right">⧉ Open real shorts page (side window)</button>
      ${viewer}
    </div>
    <div class="dw-foot"><button class="dw-next">Next unsorted channel →</button></div>`;

  drawer.querySelector(".dw-x").onclick = closeReview;
  drawer.querySelectorAll("[data-niche]").forEach((b) => {
    b.onclick = () => {
      toggleChannelNiche(c, b.dataset.niche);
      b.classList.toggle("on");
      save();
      render();
    };
  });
  wireLabelsWidget(drawer, c, () => render());
  drawer.querySelector('[data-act="topcand"]').onclick = () => {
    c.topCandidate = !c.topCandidate;
    save();
    render();
    renderDrawer();
  };
  const nn = drawer.querySelector("[data-newniche]");
  if (nn) nn.onclick = () => {
    const name = (prompt("New niche name:") || "").trim();
    if (!name) return;
    if (!state.niches.includes(name)) state.niches.push(name);
    if (!Array.isArray(c.niches)) c.niches = [];
    if (!c.niches.includes(name)) c.niches.push(name);
    save();
    render();
    renderDrawer();
    toast(`→ ${name}`);
  };
  drawer.querySelector(".dw-next").onclick = nextUnsorted;
  const dwReal = drawer.querySelector(".dw-realpage");
  if (dwReal) dwReal.onclick = () => openShortsWindow(`${channelUrl(c)}/shorts`);

  const list = reviewList();
  drawer.querySelectorAll(".dw-itemthumb").forEach((el) => {
    el.onclick = (e) => {
      if (e.target.closest(".dw-itemsave") || e.target.closest(".dw-itempin")) return; // handled below
      openShortsWindow(`https://www.youtube.com/shorts/${el.dataset.watch}`);
    };
  });
  drawer.querySelectorAll(".dw-itemsave").forEach((el) => {
    el.onclick = (e) => {
      e.stopPropagation();
      saveShortFromList(list[Number(el.dataset.save)]);
    };
  });
  drawer.querySelectorAll(".dw-itempin").forEach((el) => {
    el.onclick = (e) => {
      e.stopPropagation();
      setRep(c, el.dataset.pin);
      renderDrawer();
    };
  });
}

function saveShortFromList(cur) {
  const c = findChannel(reviewId);
  if (!cur) return;
  const existing = state.savedVideos.find((v) => v.videoId === cur.videoId);
  const notes = prompt(existing ? "Edit notes on this short:" : "Notes on this short (optional):", existing ? existing.notes : "");
  if (notes === null) return; // cancelled
  if (existing) existing.notes = notes;
  else
    state.savedVideos.push({
      videoId: cur.videoId,
      title: cur.title || "",
      channelId: c ? c.channelId : "",
      channelTitle: c ? c.title : "",
      views: cur.views || 0,
      thumb: cur.thumb || `https://i.ytimg.com/vi/${cur.videoId}/hqdefault.jpg`,
      niche: c && c.niches && c.niches[0] ? c.niches[0] : "",
      notes: notes || "",
      addedAt: Date.now(),
    });
  saveVideos();
  renderDrawer();
  toast(existing ? "Notes updated" : "Short saved 🔖");
}

document.addEventListener("keydown", (e) => {
  if (reviewId && e.key === "Escape") {
    const tag = (document.activeElement || {}).tagName;
    if (tag !== "INPUT" && tag !== "TEXTAREA" && tag !== "SELECT") closeReview();
  }
});

// ---- markdown export -------------------------------------------------------

function mdEsc(s) {
  return String(s || "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim();
}

function exportMarkdown() {
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10);
  const L = [];
  L.push("# Shorts Scout — Watchlist");
  L.push("");
  L.push(`_Exported ${now.toLocaleString()}_`);
  L.push("");
  L.push(`**${state.watchlist.length} channels** across **${state.niches.length} niches**.`);
  L.push("");
  L.push("> **avg/video** = total views ÷ video count (the low-effort/high-payoff signal). **reach** = avg/video ÷ subscribers (>1× means a video out-reaches the whole subscriber base — strong algorithm virality).");
  L.push("");

  const tops = state.watchlist.filter((c) => c.topCandidate);
  if (tops.length) {
    L.push(`## ★ Top candidates (${tops.length})`);
    L.push("");
    for (const c of tops) {
      const niches = (c.niches || []).length ? ` _(${mdEsc((c.niches || []).join(", "))})_` : "";
      L.push(`- [${mdEsc(c.title || "Channel")}](${channelUrl(c)})${niches} — ${compact(avgPerVideo(c))}/video`);
      if (c.notes && c.notes.trim()) L.push(`  - ${mdEsc(c.notes)}`);
    }
    L.push("");
  }

  const groups = [...state.niches, ""]; // "" = Unsorted, last
  for (const niche of groups) {
    const inN = niche === "" ? state.watchlist.filter((c) => !(c.niches || []).some((n) => state.niches.includes(n))) : state.watchlist.filter((c) => (c.niches || []).includes(niche));
    if (!inN.length) continue;
    const sorted = sortChannels(inN);
    L.push(`## ${niche || "Unsorted"} (${inN.length})`);
    L.push("");
    L.push("| Channel | Avg/video | Reach | Total views | Subs | Videos | Tags |");
    L.push("|---|--:|--:|--:|--:|--:|---|");
    for (const c of sorted) {
      const handle = c.customUrl ? (c.customUrl.startsWith("@") ? c.customUrl : "@" + c.customUrl) : "";
      const name = `${c.topCandidate ? "★ " : ""}[${mdEsc(c.title || "Channel")}](${channelUrl(c)})${handle ? " " + mdEsc(handle) : ""}`;
      const tags = (c.tags || []).length ? mdEsc((c.tags || []).join(", ")) : "—";
      L.push(`| ${name} | ${compact(avgPerVideo(c))} | ${fmtReach(c)} | ${compact(c.totalViews)} | ${compact(c.subscribers)} | ${compact(c.videoCount)} | ${tags} |`);
    }
    L.push("");
    const hasLabels = (c) => ["madeBy", "madeFor", "languages"].some((f) => (c[f] || []).length);
    const detailed = sorted.filter((c) => (c.notes && c.notes.trim()) || (c.examples && c.examples.length) || hasLabels(c));
    for (const c of detailed) {
      L.push(`**${mdEsc(c.title || "Channel")}**`);
      if ((c.madeBy || []).length) L.push(`- Made by: ${mdEsc((c.madeBy || []).join(", "))}`);
      if ((c.madeFor || []).length) L.push(`- Made for: ${mdEsc((c.madeFor || []).join(", "))}`);
      if ((c.languages || []).length) L.push(`- Language: ${mdEsc((c.languages || []).join(", "))}`);
      if (c.notes && c.notes.trim()) L.push(`- Notes: ${mdEsc(c.notes)}`);
      if (c.examples && c.examples.length) {
        L.push(`- Examples:`);
        c.examples.forEach((ex) => L.push(`  - [${mdEsc(ex.title || ex.url)}](${ex.url})`));
      }
      L.push("");
    }
  }

  if (state.savedVideos && state.savedVideos.length) {
    L.push(`## Saved shorts (${state.savedVideos.length})`);
    L.push("");
    for (const v of state.savedVideos) {
      const meta = [mdEsc(v.channelTitle || ""), v.niche ? `_${mdEsc(v.niche)}_` : "", v.views ? `${compact(v.views)} views` : ""].filter(Boolean).join(" · ");
      L.push(`- [${mdEsc(v.title || "Short")}](https://www.youtube.com/shorts/${v.videoId})${meta ? " — " + meta : ""}`);
      if (v.notes && v.notes.trim()) L.push(`  - ${mdEsc(v.notes)}`);
    }
    L.push("");
  }

  L.push("---");
  L.push("");
  L.push("## Raw data (for backup / reconstruction)");
  L.push("");
  L.push("_This JSON is the complete, lossless copy. An AI (or the extension) can rebuild the entire board from it._");
  L.push("");
  L.push("```json");
  L.push(JSON.stringify({ exportedAt: now.toISOString(), niches: state.niches, tags: state.tags, madeBy: state.madeBy, madeFor: state.madeFor, languages: state.languages, watchlist: state.watchlist, savedVideos: state.savedVideos, snapshots: state.snapshots }, null, 2));
  L.push("```");

  const blob = new Blob([L.join("\n")], { type: "text/markdown" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `shorts-scout-watchlist-${dateStr}.md`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast("Exported Markdown backup");
}

// ---- analytics -------------------------------------------------------------

const historyCache = {}; // channelId -> { loading } | { recent:[...] } | { error }  (deep, for trends)
let anWindow = 30; // momentum timeframe in days
let analyzing = false;
const DAY = 864e5;

function chHistory(c) {
  const h = historyCache[c.channelId];
  if (h && h.recent) return h.recent;
  const r = recentCache[c.channelId];
  return r && r.recent ? r.recent : null;
}
function chShorts(c) {
  const all = chHistory(c);
  if (!all) return null;
  const shorts = all.filter((r) => r.isShort);
  return shorts.length >= 5 ? shorts : all;
}
function sumViews(list) { return list.reduce((s, r) => s + (r.views || 0), 0); }
function channelWindow(c, days, now) {
  const list = chShorts(c) || [];
  const cur = list.filter((r) => r.publishedAt >= now - days * DAY && r.publishedAt <= now);
  const prev = list.filter((r) => r.publishedAt >= now - 2 * days * DAY && r.publishedAt < now - days * DAY);
  const v = sumViews(cur), pv = sumViews(prev);
  return { views: v, uploads: cur.length, prevViews: pv, growth: pv > 0 ? (v - pv) / pv : null };
}
function weeklyViews(list, weeks, now) {
  const arr = new Array(weeks).fill(0);
  list.forEach((r) => {
    const ago = now - r.publishedAt;
    if (ago < 0) return;
    const idx = Math.floor(ago / (7 * DAY));
    if (idx < weeks) arr[weeks - 1 - idx] += r.views || 0;
  });
  return arr;
}
function channelsWindow(channels, days, now) {
  let v = 0, pv = 0, up = 0, have = 0;
  channels.forEach((c) => {
    const list = chShorts(c);
    if (!list) return;
    have++;
    const w = channelWindow(c, days, now);
    v += w.views; pv += w.prevViews; up += w.uploads;
  });
  return { views: v, prevViews: pv, uploads: up, have, growth: pv > 0 ? (v - pv) / pv : null };
}
function channelsWeekly(channels, weeks, now) {
  const total = new Array(weeks).fill(0);
  channels.forEach((c) => {
    const s = chShorts(c);
    if (!s) return;
    weeklyViews(s, weeks, now).forEach((vv, i) => (total[i] += vv));
  });
  return total;
}

// ---- chart primitives ----
function anCard(value, label, accent) {
  return `<div class="an-card${accent ? " accent" : ""}"><b>${value}</b><span>${esc(label)}</span></div>`;
}
function anBar(label, value, max, sub, color) {
  const pct = max > 0 ? Math.max(2, Math.round((value / max) * 100)) : 0;
  return `<div class="an-bar">
    <div class="an-bar-top"><span class="an-bar-label">${label}</span><b>${compact(value)}</b></div>
    <div class="an-bar-track"><div class="an-bar-fill" style="width:${pct}%;background:${color || "var(--red)"}"></div></div>
    ${sub ? `<div class="an-bar-sub">${sub}</div>` : ""}
  </div>`;
}
function miniSpark(values, color) {
  if (!values || values.length < 2) return "";
  const w = 90, h = 26, max = Math.max(1, ...values);
  const pts = values.map((v, i) => `${((i / (values.length - 1)) * w).toFixed(1)},${(h - (v / max) * (h - 2) - 1).toFixed(1)}`);
  return `<svg class="msp" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"><path d="M${pts.join(" L")}" fill="none" stroke="${color || "var(--blue)"}" stroke-width="2" vector-effect="non-scaling-stroke"/></svg>`;
}
function lineChart(series, xLabels, opt) {
  opt = opt || {};
  const w = opt.w || 760, h = opt.h || 260, pl = 54, pr = 18, pt = 16, pb = 30;
  const n = xLabels.length;
  const vals = series.flatMap((s) => s.data).filter((v) => v != null && !isNaN(v));
  const max = Math.max(1, ...vals), min = 0;
  const X = (i) => pl + (n <= 1 ? 0 : (i / (n - 1)) * (w - pl - pr));
  const Y = (v) => h - pb - ((v - min) / (max - min || 1)) * (h - pt - pb);
  let grid = "", ylab = "";
  for (let s = 0; s <= 4; s++) {
    const v = min + (max - min) * (s / 4), y = Y(v);
    grid += `<line x1="${pl}" y1="${y.toFixed(1)}" x2="${w - pr}" y2="${y.toFixed(1)}" stroke="var(--line)"/>`;
    ylab += `<text x="${pl - 8}" y="${(y + 3).toFixed(1)}" text-anchor="end" class="ax">${compact(v)}</text>`;
  }
  let xlab = "";
  const every = Math.max(1, Math.ceil(n / 6));
  xLabels.forEach((l, i) => { if (i % every === 0 || i === n - 1) xlab += `<text x="${X(i).toFixed(1)}" y="${h - pb + 18}" text-anchor="middle" class="ax">${esc(l)}</text>`; });
  let paths = "";
  series.forEach((s) => {
    const pts = s.data.map((v, i) => `${X(i).toFixed(1)},${Y(v || 0).toFixed(1)}`);
    paths += `<path d="M${pts.join(" L")}" fill="none" stroke="${s.color}" stroke-width="2.4"/>`;
  });
  return `<svg class="chart-svg" viewBox="0 0 ${w} ${h}">${grid}<line x1="${pl}" y1="${pt}" x2="${pl}" y2="${h - pb}" stroke="var(--line2)"/><line x1="${pl}" y1="${h - pb}" x2="${w - pr}" y2="${h - pb}" stroke="var(--line2)"/>${ylab}${xlab}${paths}</svg>`;
}
function scatterChart(points, opt) {
  opt = opt || {};
  const w = opt.w || 760, h = opt.h || 340, pl = 50, pr = 22, pt = 22, pb = 40;
  const lg = (v) => Math.log10(Math.max(1, v));
  let minX = Math.min(...points.map((p) => lg(p.x))), maxX = Math.max(...points.map((p) => lg(p.x)));
  let minY = Math.min(...points.map((p) => lg(p.y))), maxY = Math.max(...points.map((p) => lg(p.y)));
  if (minX === maxX) { minX -= 0.5; maxX += 0.5; }
  if (minY === maxY) { minY -= 0.5; maxY += 0.5; }
  const padX = (maxX - minX) * 0.14 || 0.5, padY = (maxY - minY) * 0.16 || 0.5;
  minX -= padX; maxX += padX; minY -= padY; maxY += padY;
  const X = (v) => pl + ((lg(v) - minX) / (maxX - minX)) * (w - pl - pr);
  const Y = (v) => h - pb - ((lg(v) - minY) / (maxY - minY)) * (h - pt - pb);
  const medX = median(points.map((p) => p.x)) || 1, medY = median(points.map((p) => p.y)) || 1;
  const cx = X(medX), cy = Y(medY);
  const opp = `<rect x="${pl}" y="${pt}" width="${Math.max(0, cx - pl).toFixed(1)}" height="${Math.max(0, cy - pt).toFixed(1)}" fill="rgba(74,222,128,0.08)"/>`;
  const cross = `<line x1="${cx.toFixed(1)}" y1="${pt}" x2="${cx.toFixed(1)}" y2="${h - pb}" stroke="var(--line2)" stroke-dasharray="3 3"/><line x1="${pl}" y1="${cy.toFixed(1)}" x2="${w - pr}" y2="${cy.toFixed(1)}" stroke="var(--line2)" stroke-dasharray="3 3"/>`;
  const maxR = Math.max(1, ...points.map((p) => p.r || 1));
  let bub = "";
  points.forEach((p) => {
    const r = 7 + Math.sqrt((p.r || 1) / maxR) * 16;
    const x = X(p.x), y = Y(p.y);
    bub += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r.toFixed(1)}" fill="${p.color}33" stroke="${p.color}" stroke-width="1.6"/>`;
    bub += `<text x="${x.toFixed(1)}" y="${(y - r - 4).toFixed(1)}" text-anchor="middle" class="ax2">${esc(p.label)}</text>`;
  });
  const labels = `<text x="${((pl + w - pr) / 2).toFixed(1)}" y="${h - 6}" text-anchor="middle" class="axt">${esc(opt.xlabel || "")} →</text>` +
    `<text x="13" y="${((pt + h - pb) / 2).toFixed(1)}" text-anchor="middle" transform="rotate(-90 13 ${((pt + h - pb) / 2).toFixed(1)})" class="axt">${esc(opt.ylabel || "")} →</text>` +
    `<text x="${pl + 6}" y="${pt + 13}" class="axt opp">↖ best opportunities</text>`;
  return `<svg class="chart-svg" viewBox="0 0 ${w} ${h}">${opp}${cross}${bub}${labels}</svg>`;
}
function growthChip(g) {
  if (g == null) return `<span class="gchip flat">– n/a</span>`;
  const pct = Math.round(g * 100), cls = g >= 0.1 ? "up" : g <= -0.1 ? "down" : "flat";
  return `<span class="gchip ${cls}">${cls === "up" ? "▲" : cls === "down" ? "▼" : "–"} ${pct > 0 ? "+" : ""}${pct}%</span>`;
}

function runDeepAnalysis() {
  if (analyzing) return;
  const todo = state.watchlist.filter((c) => !(historyCache[c.channelId] && historyCache[c.channelId].recent));
  if (!todo.length) return render();
  analyzing = true;
  const total = todo.length;
  let done = 0;
  const tick = () => { const el = document.getElementById("an-progress"); if (el) el.textContent = `Analyzing… ${done}/${total}`; };
  const next = () => {
    if (!todo.length) { analyzing = false; render(); toast("Deep analysis ready"); return; }
    const c = todo.shift();
    historyCache[c.channelId] = { loading: true };
    chrome.runtime.sendMessage({ type: "RECENT", channelId: c.channelId, maxItems: 150 }, (resp) => {
      historyCache[c.channelId] = chrome.runtime.lastError || !resp || !resp.ok ? { recent: [] } : { recent: resp.recent || [] };
      done++; tick(); next();
    });
  };
  render(); tick(); next();
}

// "Hot right now" — insights built from the real vidIQ 7/30-day views.
function vidiqInsights() {
  const withV7 = state.watchlist.filter((c) => vq7(c) > 0);
  if (!withV7.length) {
    return `<div class="an-section-t first">🔥 Hot right now <span class="an-hint">real views from vidIQ</span></div>
      <div class="rs-msg" style="text-align:left;padding:12px 0">Hit <b>Scan vidIQ</b> (top bar) to pull every channel's real last-7/30-day views — then this shows your hottest channels, what's heating up, and which niches are winning right now.</div>`;
  }
  const sign = (p) => (p >= 0 ? "+" : "");
  // Hottest channels by last-7-day views
  const topHot = withV7.slice().sort((a, b) => vq7(b) - vq7(a)).slice(0, 8);
  const maxHot = vq7(topHot[0]) || 1;
  const hotBars = topHot.map((c) => {
    const m = vqMomentum(c);
    const sub = `${compact(vq30(c))} in 30d${m != null ? ` · ${m >= 1 ? "🔥" : "❄️"} ${sign(Math.round((m - 1) * 100))}${Math.round((m - 1) * 100)}% pace` : ""}`;
    return anBar(esc(c.title || "Channel"), vq7(c), maxHot, sub, "#ff7a5a");
  }).join("");
  // Heating up — biggest positive momentum (needs a meaningful 7-day base)
  const floor = median(withV7.map(vq7).filter((v) => v > 0)) * 0.25;
  const heating = withV7.filter((c) => vqMomentum(c) != null && vq7(c) >= floor)
    .map((c) => ({ c, m: vqMomentum(c) })).sort((a, b) => b.m - a.m).slice(0, 6);
  const heatRows = heating.map(({ c, m }) => {
    const p = Math.round((m - 1) * 100);
    return `<div class="an-hotrow"><span class="nm">${esc(c.title || "Channel")}</span><b class="mo ${p >= 0 ? "up" : "down"}">${p >= 0 ? "🔥 +" : "❄️ "}${p}%</b><span class="sb">${compact(vq7(c))}/7d</span></div>`;
  }).join("");
  // Hottest niches by total last-7-day views
  const nicheHot = topLevelNiches().map((n) => {
    const chs = uniqueChannelsInTree(n);
    return { n, v7: chs.reduce((s, c) => s + vq7(c), 0), count: chs.filter((c) => vq7(c) > 0).length };
  }).filter((x) => x.v7 > 0).sort((a, b) => b.v7 - a.v7);
  const maxN = (nicheHot[0] && nicheHot[0].v7) || 1;
  const nicheBars = nicheHot.slice(0, 10).map((x) => anBar(esc(x.n), x.v7, maxN, `${x.count} channel${x.count === 1 ? "" : "s"} scanned`, nicheColor(x.n))).join("");

  return `
    <div class="an-section-t first">🔥 Hottest channels <span class="an-hint">most views in the last 7 days (vidIQ)</span></div>
    <div class="an-bars">${hotBars}</div>
    ${heatRows ? `<div class="an-section-t">Heating up <span class="an-hint">7-day pace vs the 30-day average</span></div><div class="an-hotlist">${heatRows}</div>` : ""}
    <div class="an-section-t">Hottest niches <span class="an-hint">total views last 7 days</span></div>
    <div class="an-bars">${nicheBars}</div>
    <div class="an-divider"></div>`;
}

function renderAnalytics() {
  const wrap = document.createElement("div");
  wrap.className = "analytics";
  if (!state.watchlist.length) {
    wrap.innerHTML = `<div class="empty"><div><div class="big">📈</div><h2>Analytics needs data</h2><p>Save channels first, then this dashboard breaks down which niches win and which are trending up.</p></div></div>`;
    return wrap;
  }
  const now = Date.now();
  const W = anWindow;
  const groups = [...topLevelNiches(), ""].map((n) => ({ niche: n || UNSORTED, name: n || "Unsorted", color: n ? nicheColor(n) : "#3a3a44", channels: n === "" ? state.watchlist.filter((c) => !(c.niches || []).some((x) => state.niches.includes(x))) : uniqueChannelsInTree(n) })).filter((g) => g.channels.length);
  const haveHist = state.watchlist.some((c) => chShorts(c));

  const ns = groups.map((g) => ({
    ...g,
    reach: g.channels.reduce((s, c) => s + c.totalViews, 0),
    medAvg: median(g.channels.map(avgPerVideo).filter((v) => v > 0)),
    medVids: median(g.channels.map((c) => c.videoCount).filter((v) => v > 0)) || 1,
    win: channelsWindow(g.channels, W, now),
    weekly: channelsWeekly(g.channels, 12, now),
  }));

  const totViews = state.watchlist.reduce((s, c) => s + c.totalViews, 0);
  const totSubs = state.watchlist.reduce((s, c) => s + c.subscribers, 0);
  const medAll = median(state.watchlist.map(avgPerVideo).filter((v) => v > 0));
  const bestNiche = ns.filter((g) => g.niche !== UNSORTED && g.medAvg > 0).sort((a, b) => b.medAvg - a.medAvg)[0];
  const fastest = ns.filter((g) => g.niche !== UNSORTED && g.win.growth != null).sort((a, b) => b.win.growth - a.win.growth)[0];
  const cards = `<div class="an-cards">
    ${anCard(compact(totViews), "total reach")}
    ${anCard(state.watchlist.length, "channels")}
    ${anCard(compact(totSubs), "combined subs")}
    ${anCard(medAll ? compact(medAll) : "—", "median avg/video")}
    ${anCard(bestNiche ? esc(bestNiche.name) : "—", "top niche · avg/video", true)}
    ${anCard(fastest ? esc(fastest.name) : (haveHist ? "—" : "?"), fastest ? `fastest growing · ${fastest.win.growth >= 0 ? "+" : ""}${Math.round(fastest.win.growth * 100)}% (${W}d)` : `fastest growing (${W}d)`, true)}
  </div>`;

  const scatterPts = ns.filter((g) => g.niche !== UNSORTED && g.medAvg > 0).map((g) => ({ x: g.medVids, y: g.medAvg, r: g.reach, color: g.color, label: g.name }));
  const scatter = scatterPts.length >= 2 ? scatterChart(scatterPts, { xlabel: "videos / channel (median)", ylabel: "avg views / video" }) : `<div class="rs-msg" style="padding:18px">Add a couple of niches to see the opportunity map.</div>`;

  const byReach = ns.slice().sort((a, b) => b.reach - a.reach);
  const maxReach = Math.max(1, ...byReach.map((g) => g.reach));
  const leaderboard = byReach.map((g) => anBar(`${esc(g.name)}  ${haveHist && g.win.growth != null ? growthChip(g.win.growth) : ""}`, g.reach, maxReach, `${g.channels.length} ch · median ${g.medAvg ? compact(g.medAvg) : "—"}/video`, g.color)).join("");

  const tf = `<div class="an-tf">${[7, 30, 90].map((d) => `<button class="${d === W ? "on" : ""}" data-win="${d}">${d}d</button>`).join("")}</div>`;

  let trends;
  if (!haveHist) {
    trends = `<div class="an-fetch">
      <div><div class="an-fetch-t">Trends, momentum & rising channels</div>
      <div class="an-fetch-s">Pull each channel's recent upload history to chart weekly views per niche, week / month / 3-month momentum, and who's heating up. ~6 API units per channel.</div></div>
      <button class="btn primary" id="an-deepbtn">${analyzing ? `<span id="an-progress">Analyzing…</span>` : `Run deep analysis (${state.watchlist.length})`}</button>
    </div>`;
  } else {
    const weeks = 12, labels = [];
    for (let i = 0; i < weeks; i++) { const d = new Date(now - (weeks - 1 - i) * 7 * DAY); labels.push(`${d.getMonth() + 1}/${d.getDate()}`); }
    const lineNiches = byReach.filter((g) => g.niche !== UNSORTED).slice(0, 6);
    const series = lineNiches.map((g) => ({ name: g.name, color: g.color, data: g.weekly }));
    const legend = lineNiches.map((g) => `<span class="leg"><span class="leg-dot" style="background:${g.color}"></span>${esc(g.name)}</span>`).join("");
    const trendChart = series.length ? `${lineChart(series, labels, { h: 280 })}<div class="legend">${legend}</div>` : `<div class="rs-msg">No recent uploads found.</div>`;

    const momRows = ns.filter((g) => g.niche !== UNSORTED).map((g) => {
      const g7 = channelsWindow(g.channels, 7, now).growth, g30 = channelsWindow(g.channels, 30, now).growth, g90 = channelsWindow(g.channels, 90, now).growth;
      return `<tr><td><span class="leg-dot" style="background:${g.color}"></span> ${esc(g.name)}</td><td>${compact(channelsWindow(g.channels, 30, now).views)}</td><td>${growthChip(g7)}</td><td>${growthChip(g30)}</td><td>${growthChip(g90)}</td></tr>`;
    }).join("");

    const chs = state.watchlist.map((c) => ({ c, w: channelWindow(c, W, now) })).filter((x) => x.w.growth != null);
    const rising = chs.slice().sort((a, b) => b.w.growth - a.w.growth).slice(0, 6);
    const cooling = chs.slice().sort((a, b) => a.w.growth - b.w.growth).slice(0, 6);
    const chList = (arr) => arr.map(({ c, w }) => `<div class="rc-row"><div class="tcell-name">${avatarHtml(c)}<a href="${channelUrl(c)}/shorts" target="_blank" rel="noopener">${esc(c.title) || "Channel"}</a></div><div class="rc-spark">${miniSpark(chShorts(c) ? weeklyViews(chShorts(c), 10, now) : [], w.growth >= 0 ? "var(--green)" : "var(--red-dim)")}</div>${growthChip(w.growth)}</div>`).join("");

    trends = `
      <div class="an-section-t">Weekly views by niche <span class="an-hint">views from shorts posted each week (last 12)</span></div>
      <div class="an-chartbox">${trendChart}</div>
      <div class="an-section-t">Momentum by niche <span class="an-hint">vs the period before — week / month / 3-month</span></div>
      <div class="tablewrap" style="padding:0"><table class="tbl"><thead><tr><th>Niche</th><th>30d views</th><th>7-day</th><th>30-day</th><th>90-day</th></tr></thead><tbody>${momRows}</tbody></table></div>
      <div class="an-section-t">Heating up vs cooling <span class="an-hint">channel momentum over ${W} days</span></div>
      <div class="rc-grid"><div class="rc-col"><div class="rc-h up">▲ Heating up</div>${chList(rising) || '<div class="rs-msg">—</div>'}</div><div class="rc-col"><div class="rc-h down">▼ Cooling</div>${chList(cooling) || '<div class="rs-msg">—</div>'}</div></div>`;
  }

  let growth;
  const snaps = (state.snapshots || []).filter((s) => s.totalViews);
  if (snaps.length >= 2) {
    const first = snaps[0], last = snaps[snaps.length - 1];
    const days = Math.max(1, (last.t - first.t) / DAY);
    const perDay = (last.totalViews - first.totalViews) / days;
    const labels = snaps.map((s) => { const d = new Date(s.t); return `${d.getMonth() + 1}/${d.getDate()}`; });
    const gs = [{ name: "Total reach", color: "var(--red)", data: snaps.map((s) => s.totalViews) }];
    const nicheKeys = {};
    snaps.forEach((s) => Object.keys(s.niches || {}).forEach((k) => (nicheKeys[k] = 1)));
    Object.keys(nicheKeys).slice(0, 5).forEach((k) => gs.push({ name: k, color: nicheColor(k), data: snaps.map((s) => (s.niches && s.niches[k]) || 0) }));
    const legend = gs.map((s) => `<span class="leg"><span class="leg-dot" style="background:${s.color}"></span>${esc(s.name)}</span>`).join("");
    growth = `<div class="an-section-t">Tracked growth <span class="an-hint">measured from your refresh history</span></div>
      <div class="an-cards">${anCard((perDay >= 0 ? "+" : "") + compact(perDay), "reach / day (measured)")}${anCard((last.totalViews - first.totalViews >= 0 ? "+" : "") + compact(last.totalViews - first.totalViews), `since ${new Date(first.t).toLocaleDateString()}`)}${anCard(snaps.length, "snapshots")}</div>
      <div class="an-chartbox">${lineChart(gs, labels, { h: 240 })}<div class="legend">${legend}</div></div>`;
  } else {
    growth = `<div class="an-section-t">Tracked growth</div><div class="rs-msg" style="text-align:left;padding:14px 0">Hit <b>Refresh</b> (in the ⋯ More menu) every week or so — Shorts Scout charts your real reach-over-time here, per niche.${snaps.length ? " (1 snapshot so far — need 2.)" : ""}</div>`;
  }

  function attrBars(field, title) {
    const rows = (state[field] || []).map((v) => {
      const chans = state.watchlist.filter((c) => (c[field] || []).includes(v));
      if (!chans.length) return null;
      return { v, med: median(chans.map(avgPerVideo).filter((x) => x > 0)), n: chans.length };
    }).filter(Boolean).sort((a, b) => b.med - a.med);
    if (!rows.length) return "";
    const mx = Math.max(1, ...rows.map((r) => r.med));
    return `<div class="an-section-t">${title} <span class="an-hint">median avg views/video</span></div><div class="an-bars">${rows.map((r) => anBar(esc(r.v), r.med, mx, `${r.n} channel${r.n > 1 ? "s" : ""}`, "var(--blue)")).join("")}</div>`;
  }

  wrap.innerHTML = `
    ${vidiqInsights()}
    <div class="an-head"><div class="an-section-t first" style="margin:0">Overview</div>${tf}</div>
    ${cards}
    <div class="an-section-t">Niche opportunity map <span class="an-hint">top-left = fewer videos, higher avg views · bubble = total reach</span></div>
    <div class="an-chartbox">${scatter}</div>
    <div class="an-section-t">Niches by reach <span class="an-hint">${haveHist ? `with ${W}-day momentum` : "total views"}</span></div>
    <div class="an-bars">${leaderboard}</div>
    ${trends}
    ${growth}
    ${attrBars("madeFor", "By target audience (made for)")}
    ${attrBars("languages", "By language")}`;

  wrap.querySelectorAll(".an-tf button").forEach((b) => (b.onclick = () => { anWindow = Number(b.dataset.win); render(); }));
  const db = wrap.querySelector("#an-deepbtn");
  if (db) db.onclick = () => runDeepAnalysis();
  return wrap;
}


// ---- saved videos view -----------------------------------------------------

function saveVideos() {
  ignoreNextChange = true;
  chrome.storage.local.set({ savedVideos: state.savedVideos });
}

// ---- Top Candidates: your ★ channels, ranked by recent views, with notes ----
function renderTopCandidates() {
  const wrap = document.createElement("div");
  wrap.className = "topcands";
  const q = (state.search || "").toLowerCase();
  let cands = state.watchlist.filter((c) => c.topCandidate);
  if (q) cands = cands.filter((c) => (c.title || "").toLowerCase().includes(q) || (c.niches || []).join(" ").toLowerCase().includes(q) || (c.tags || []).join(" ").toLowerCase().includes(q));
  cands.sort((a, b) => (vq7(b) || 0) - (vq7(a) || 0) || (b.totalViews || 0) - (a.totalViews || 0));
  if (!cands.length) {
    wrap.innerHTML = `<div class="empty"><div><div class="big">★</div><h2>No top candidates yet</h2><p>Mark a channel a top candidate with its ★ (on the card, the Review drawer, or the in-YouTube save sheet). Your best-of-the-best show up here, ranked by views in the last 7 days, with a notes box for each.</p></div></div>`;
    return wrap;
  }
  const head = document.createElement("div");
  head.className = "tc-head";
  head.innerHTML = `★ Top Candidates <span>${cands.length} · ranked by views in the last 7 days</span>`;
  wrap.appendChild(head);
  cands.forEach((c, i) => wrap.appendChild(renderTopCard(c, i + 1)));
  return wrap;
}

function renderTopCard(c, rank) {
  const el = document.createElement("div");
  el.className = "tc-card";
  const mom = vqMomentum(c);
  const momHtml = mom == null ? "" : `<span class="tc-mom ${mom >= 1.1 ? "up" : mom <= 0.9 ? "down" : "flat"}">${mom >= 1.1 ? "🔥" : mom <= 0.9 ? "❄️" : "→"} ${mom >= 1 ? "+" : ""}${Math.round((mom - 1) * 100)}%</span>`;
  const niches = (c.niches || []).map((n) => `<span class="tc-niche" style="background:${nicheColor(n)}">${esc(n)}</span>`).join("");
  el.innerHTML = `
    <div class="tc-rank">#${rank}</div>
    ${avatarHtml(c, "tc-av")}
    <div class="tc-body">
      <div class="tc-row1">
        <a class="tc-name" href="${channelUrl(c)}" target="_blank" rel="noopener">${esc(c.title) || "Channel"}</a>
        <button class="tc-star" title="Remove from top candidates">★</button>
      </div>
      ${niches ? `<div class="tc-niches">${niches}</div>` : ""}
      <div class="tc-stats">
        <span class="tc-stat hot"><b>${vq7(c) ? compact(vq7(c)) : "—"}</b> views · 7d ${momHtml}</span>
        <span class="tc-stat"><b>${vq30(c) ? compact(vq30(c)) : "—"}</b> · 30d</span>
        <span class="tc-stat"><b>${compact(avgPerVideo(c))}</b> avg/video</span>
        <span class="tc-stat"><b>${compact(c.subscribers)}</b> subs</span>
        <span class="tc-stat"><b>${compact(c.totalViews)}</b> total</span>
      </div>
      <textarea class="tc-notes" placeholder="Notes — the format, the hook, why it works, what to copy…">${esc(c.notes || "")}</textarea>
      <div class="tc-actions"><button class="tc-review">▶ Review shorts</button></div>
    </div>`;
  el.querySelector(".tc-star").onclick = () => { c.topCandidate = false; save(); render(); };
  el.querySelector(".tc-notes").onchange = (e) => { c.notes = e.target.value; save(); };
  el.querySelector(".tc-review").onclick = () => openReview(c.channelId);
  return el;
}

function renderVideos() {
  const wrap = document.createElement("div");
  wrap.className = "videos";
  if (!state.savedVideos.length) {
    wrap.innerHTML = `<div class="empty"><div><div class="big">🔖</div><h2>No saved shorts yet</h2><p>On YouTube Shorts, open Shorts Scout and tap <span class="kbd">🔖 Save this short</span> to bookmark a specific video and take notes on it.</p><p>You can also save one straight from the <b>▶ Review</b> drawer.</p></div></div>`;
    return wrap;
  }
  const q = state.search.toLowerCase();
  const vids = state.savedVideos
    .filter((v) => !q || (v.title || "").toLowerCase().includes(q) || (v.channelTitle || "").toLowerCase().includes(q) || (v.niche || "").toLowerCase().includes(q))
    .slice()
    .sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));

  wrap.innerHTML = `<div class="an-section-t first">Saved shorts (${state.savedVideos.length})</div>`;
  const grid = document.createElement("div");
  grid.className = "vid-grid";
  vids.forEach((v) => grid.appendChild(renderSavedVideo(v)));
  wrap.appendChild(grid);
  return wrap;
}

function renderSavedVideo(v) {
  const card = document.createElement("div");
  card.className = "vid-card";
  const url = `https://www.youtube.com/shorts/${v.videoId}`;
  const nicheOpts = ['<option value="">— niche —</option>'].concat(state.niches.map((n) => `<option value="${esc(n)}"${n === v.niche ? " selected" : ""}>${esc(n)}</option>`)).join("");
  card.innerHTML = `
    <div class="vid-thumb" style="background-image:url('${esc(v.thumb)}')"><button class="vid-play">▶</button><span class="vid-views">${compact(v.views)} views</span></div>
    <div class="vid-body">
      <a class="vid-title" href="${url}" target="_blank" rel="noopener">${esc(v.title) || "Short"}</a>
      <div class="vid-ch">${esc(v.channelTitle) || ""}</div>
      <select class="vid-niche">${nicheOpts}</select>
      <textarea class="vid-notes" placeholder="Notes on this video…">${esc(v.notes)}</textarea>
      <button class="vid-rm">Remove</button>
    </div>`;
  card.querySelector(".vid-niche").onchange = (e) => { v.niche = e.target.value; saveVideos(); };
  const nt = card.querySelector(".vid-notes");
  nt.onchange = () => { v.notes = nt.value; saveVideos(); };
  card.querySelector(".vid-play").onclick = () => openVideoModal(v);
  card.querySelector(".vid-rm").onclick = () => {
    const i = state.savedVideos.findIndex((x) => x.videoId === v.videoId);
    if (i >= 0) { state.savedVideos.splice(i, 1); saveVideos(); render(); }
  };
  return card;
}

function openVideoModal(v) {
  let m = document.getElementById("vmodal");
  if (!m) { m = document.createElement("div"); m.id = "vmodal"; document.body.appendChild(m); }
  m.innerHTML = `<div class="vm-back"></div><div class="vm-inner"><button class="vm-x" title="Close">✕</button>
    <div class="vm-player"><iframe src="https://www.youtube-nocookie.com/embed/${v.videoId}?autoplay=1&rel=0&playsinline=1&modestbranding=1" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen></iframe></div></div>`;
  m.classList.add("open");
  m.querySelector(".vm-x").onclick = closeVideoModal;
  m.querySelector(".vm-back").onclick = closeVideoModal;
}
function closeVideoModal() {
  const m = document.getElementById("vmodal");
  if (m) { m.classList.remove("open"); m.innerHTML = ""; }
}

// ---- snapshots (for tracked growth) ---------------------------------------

function recordSnapshot() {
  const totalViews = state.watchlist.reduce((s, c) => s + c.totalViews, 0);
  const subscribers = state.watchlist.reduce((s, c) => s + c.subscribers, 0);
  const niches = {};
  topLevelNiches().forEach((p) => { niches[p] = uniqueChannelsInTree(p).reduce((s, c) => s + c.totalViews, 0); });
  const snaps = (state.snapshots || []).slice();
  const last = snaps[snaps.length - 1];
  const entry = { t: Date.now(), totalViews, subscribers, channels: state.watchlist.length, niches };
  if (last && Date.now() - last.t < 6 * 3600e3) snaps[snaps.length - 1] = entry; // collapse same-session
  else snaps.push(entry);
  state.snapshots = snaps.slice(-400);
  ignoreNextChange = true;
  chrome.storage.local.set({ snapshots: state.snapshots });
}

// ---- notebook (Obsidian-style live Markdown editor) ------------------------

let nbImages = {};
let nbSaveTimer = null;
let nbOutside = null;
let nbBlockSeq = 1;

function nbSplitBlocks(md) {
  const lines = (md || "").replace(/\r\n/g, "\n").split("\n");
  const blocks = [];
  let cur = [], inFence = false;
  const flush = () => { if (cur.join("\n").trim() !== "") blocks.push({ id: nbBlockSeq++, text: cur.join("\n") }); cur = []; };
  for (const ln of lines) {
    if (/^\s*```/.test(ln)) inFence = !inFence;
    if (!inFence && ln.trim() === "") flush();
    else cur.push(ln);
  }
  flush();
  return blocks;
}
function nbRenderMd(s) {
  try { return window.marked ? marked.parse(s) : esc(s).replace(/\n/g, "<br>"); } catch (e) { return esc(s).replace(/\n/g, "<br>"); }
}
function nbResolveImgs(el) {
  el.querySelectorAll("img").forEach((img) => {
    const m = (img.getAttribute("src") || "").match(/^img:(.+)$/);
    if (m && nbImages[m[1]]) img.src = nbImages[m[1]];
  });
}
function nbNewImageId() { return "im" + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36); }

function openNotebook() {
  const nb = document.getElementById("notebook");
  chrome.storage.local.get(["notebookMd", "notebookImages"], (d) => {
    nbImages = d.notebookImages || {};
    nb.innerHTML = `
      <div class="nb-bar">
        <div class="brand"><div class="logo">📓</div><div><h1>Notebook</h1><div class="tag">SHORTS SCOUT</div></div></div>
        <span class="nb-saved" id="nb-saved"></span>
        <span style="flex:1"></span>
        <span class="nb-tip">Click any block to edit its Markdown · click away to format · paste or drop images</span>
        <button class="nb-x" title="Close">✕</button>
      </div>
      <div class="nb-scroll"><div class="nb-doc" id="nb-doc"></div></div>`;
    nb.classList.add("open");
    const doc = nb.querySelector("#nb-doc");
    const saved = nb.querySelector("#nb-saved");
    let blocks = nbSplitBlocks(d.notebookMd || "");
    let editing = null; // block id being edited, or null

    const persist = () => {
      saved.textContent = "Saving…";
      clearTimeout(nbSaveTimer);
      nbSaveTimer = setTimeout(() => {
        chrome.storage.local.set({ notebookMd: blocks.map((b) => b.text).join("\n\n") }, () => (saved.textContent = "Saved ✓"));
      }, 400);
    };
    const grow = (ta) => { ta.style.height = "auto"; ta.style.height = ta.scrollHeight + "px"; };
    const idxOf = (id) => blocks.findIndex((b) => b.id === id);

    function stopEdit() {
      if (editing == null) return;
      const i = idxOf(editing);
      if (i >= 0 && !blocks[i].text.trim()) blocks.splice(i, 1); // drop empty block
      editing = null;
    }
    function startEdit(id) {
      if (editing === id) return;
      stopEdit();
      editing = id;
      renderDoc(true);
    }

    function renderDoc(focus) {
      doc.innerHTML = "";
      if (!blocks.length && editing == null) {
        const el = document.createElement("div");
        el.className = "nb-block";
        el.innerHTML = `<div class="nb-rendered md"><p class="nb-ph">Click here and start writing in Markdown…</p></div>`;
        el.addEventListener("mousedown", (e) => { e.preventDefault(); const b = { id: nbBlockSeq++, text: "" }; blocks.push(b); editing = b.id; renderDoc(true); });
        doc.appendChild(el);
        return;
      }
      blocks.forEach((b) => {
        const el = document.createElement("div");
        el.className = "nb-block";
        el.dataset.id = b.id;
        if (b.id === editing) {
          const ta = document.createElement("textarea");
          ta.className = "nb-raw";
          ta.value = b.text;
          ta.spellcheck = false;
          el.appendChild(ta);
          ta.addEventListener("input", () => { b.text = ta.value; grow(ta); persist(); });
          ta.addEventListener("keydown", (e) => nbKey(e, b, ta));
          ta.addEventListener("paste", (e) => nbPaste(e, b, ta));
        } else {
          const r = document.createElement("div");
          r.className = "nb-rendered md";
          r.innerHTML = b.text.trim() ? nbRenderMd(b.text) : `<p class="nb-ph">empty block</p>`;
          nbResolveImgs(r);
          r.querySelectorAll("a").forEach((a) => { a.target = "_blank"; a.rel = "noopener"; });
          el.appendChild(r);
          el.addEventListener("mousedown", (e) => { if (e.target.closest("a")) return; e.preventDefault(); startEdit(b.id); });
        }
        doc.appendChild(el);
      });
      const tail = document.createElement("div");
      tail.className = "nb-tail";
      tail.addEventListener("mousedown", (e) => { e.preventDefault(); stopEdit(); const b = { id: nbBlockSeq++, text: "" }; blocks.push(b); editing = b.id; renderDoc(true); });
      doc.appendChild(tail);
      if (focus && editing != null) {
        const ta = doc.querySelector(`.nb-block[data-id="${editing}"] .nb-raw`);
        if (ta) { ta.focus(); grow(ta); const L = ta.value.length; ta.setSelectionRange(L, L); }
      }
    }

    function nbKey(e, b, ta) {
      if (e.key === "Escape") { e.preventDefault(); stopEdit(); renderDoc(); return; }
      // Backspace at very start merges into the previous block.
      if (e.key === "Backspace" && ta.selectionStart === 0 && ta.selectionEnd === 0) {
        const i = idxOf(b.id);
        if (i > 0) {
          e.preventDefault();
          const prev = blocks[i - 1];
          const at = prev.text.length;
          prev.text = prev.text + (prev.text && b.text ? "\n" : "") + b.text;
          blocks.splice(i, 1);
          editing = prev.id;
          renderDoc(true);
          const ta2 = doc.querySelector(`.nb-block[data-id="${prev.id}"] .nb-raw`);
          if (ta2) { ta2.focus(); ta2.setSelectionRange(at, at); }
        }
      }
    }
    function nbPaste(e, b, ta) {
      const items = (e.clipboardData || {}).items || [];
      for (const it of items) {
        if (it.type && it.type.startsWith("image/")) {
          e.preventDefault();
          const file = it.getAsFile();
          const rd = new FileReader();
          rd.onload = () => {
            const id = nbNewImageId();
            nbImages[id] = rd.result;
            const s = ta.selectionStart, snip = `![screenshot](img:${id})`;
            ta.value = ta.value.slice(0, s) + snip + ta.value.slice(ta.selectionEnd);
            b.text = ta.value;
            ta.selectionStart = ta.selectionEnd = s + snip.length;
            chrome.storage.local.set({ notebookImages: nbImages });
            grow(ta);
            persist();
          };
          rd.readAsDataURL(file);
        }
      }
    }

    // Drop images anywhere in the doc.
    doc.addEventListener("dragover", (e) => { e.preventDefault(); doc.classList.add("drag"); });
    doc.addEventListener("dragleave", (e) => { if (!doc.contains(e.relatedTarget)) doc.classList.remove("drag"); });
    doc.addEventListener("drop", (e) => {
      e.preventDefault();
      doc.classList.remove("drag");
      const files = (e.dataTransfer || {}).files || [];
      for (const f of files) {
        if (f.type && f.type.startsWith("image/")) {
          const rd = new FileReader();
          rd.onload = () => {
            const id = nbNewImageId();
            nbImages[id] = rd.result;
            chrome.storage.local.set({ notebookImages: nbImages });
            if (editing != null) {
              const b = blocks[idxOf(editing)];
              const ta = doc.querySelector(".nb-raw");
              const snip = `\n![screenshot](img:${id})\n`;
              const s = ta.selectionStart;
              ta.value = ta.value.slice(0, s) + snip + ta.value.slice(ta.selectionEnd);
              b.text = ta.value;
              grow(ta);
            } else {
              blocks.push({ id: nbBlockSeq++, text: `![screenshot](img:${id})` });
            }
            persist();
            renderDoc(true);
          };
          rd.readAsDataURL(f);
        }
      }
    });

    // Clicking outside the doc commits the active block (formats it).
    nbOutside = (e) => { if (editing != null && !e.target.closest("#nb-doc")) { stopEdit(); renderDoc(); } };
    document.addEventListener("mousedown", nbOutside, true);

    nb.querySelector(".nb-x").onclick = closeNotebook;
    renderDoc();
  });
}

function closeNotebook() {
  const nb = document.getElementById("notebook");
  nb.classList.remove("open");
  nb.innerHTML = "";
  if (nbOutside) { document.removeEventListener("mousedown", nbOutside, true); nbOutside = null; }
}


// ---- toolbar ---------------------------------------------------------------

function syncControls() {
  document.getElementById("sort").value = state.sort;
  document.querySelectorAll("#viewseg button").forEach((b) => b.classList.toggle("on", b.dataset.view === state.view));
}

document.getElementById("sort").onchange = (e) => { state.sort = e.target.value; save(); render(); };
document.getElementById("search").oninput = (e) => { state.search = e.target.value; render(); };
document.querySelectorAll("#viewseg button").forEach((b) => {
  b.onclick = () => { state.view = b.dataset.view; syncControls(); save(); render(); };
});
document.getElementById("refresh").onclick = doRefresh;
const scanAllBtn = document.getElementById("scanAll");
if (scanAllBtn) {
  if (!IS_EXTENSION) scanAllBtn.style.display = "none"; // can't open YouTube+vidIQ from the website
  scanAllBtn.onclick = () => scanMany(state.watchlist.map((c) => c.channelId));
}
const scanAllTop = document.getElementById("scanAllTop");
if (scanAllTop) {
  if (!IS_EXTENSION) scanAllTop.style.display = "none";
  scanAllTop.onclick = () => (scanning ? cancelScan() : scanMany(state.watchlist.map((c) => c.channelId)));
}
document.getElementById("addNiche").onclick = promptAddNiche;
document.getElementById("manageTags").onclick = openTagManager;
document.getElementById("manageGroups").onclick = openGroupsManager;
document.getElementById("notebookBtn").onclick = openNotebook;
document.getElementById("export").onclick = exportMarkdown;
document.getElementById("filterTop").onclick = (e) => {
  state.filterTop = !state.filterTop;
  e.currentTarget.classList.toggle("on", state.filterTop);
  render();
};

// "More" dropdown: toggle, close on outside click, close after picking an item.
const moreMenu = document.getElementById("moreMenu");
document.getElementById("moreBtn").onclick = (e) => {
  e.stopPropagation();
  moreMenu.classList.toggle("open");
};
moreMenu.querySelectorAll(".menu-item").forEach((b) => b.addEventListener("click", () => moreMenu.classList.remove("open")));
document.addEventListener("click", (e) => {
  if (!e.target.closest(".menu-wrap")) moreMenu.classList.remove("open");
});

load();
