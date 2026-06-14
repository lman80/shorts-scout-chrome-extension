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

const state = { watchlist: [], niches: [], nicheParents: {}, tags: [], madeBy: [], madeFor: [], languages: [], savedVideos: [], snapshots: [], sort: "avg", view: "board", search: "" };
const collapsedSub = new Set(); // collapsed "parent>child" sub-niche sections on the board
let ignoreNextChange = false;
const recentCache = {}; // channelId -> { loading } | { recent:[...] } | { error }
const expanded = new Set(); // channelIds whose "recent shorts" dropdown is open
let reviewId = null; // channelId currently open in the review drawer
let reviewIndex = 0; // which short within that channel is playing
let hotThreshold = Infinity; // 75th percentile of avg/video, computed each render

// ---- storage ---------------------------------------------------------------

function load() {
  chrome.storage.local.get(["watchlist", "niches", "nicheParents", "boardPrefs", "savedVideos", "snapshots", "tags", "madeBy", "madeFor", "languages"], (d) => {
    state.watchlist = (d.watchlist || []).map(normalize);
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

function sortKey() {
  return {
    avg: avgPerVideo,
    reach: reachRatio,
    views: (c) => c.totalViews,
    subs: (c) => c.subscribers,
    videos: (c) => c.videoCount,
    added: (c) => c.addedAt,
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
  return state.watchlist.filter(matchesSearch);
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
  if (state.view === "analytics") return content.appendChild(renderAnalytics());
  if (state.view === "videos") return content.appendChild(renderVideos());
  if (needsRefresh()) content.appendChild(refreshBanner());
  content.appendChild(state.view === "table" ? renderTable() : renderBoard());
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

function renderColumn(niche) {
  const col = document.createElement("div");
  col.className = "col" + (niche === UNSORTED ? " unsorted" : "");
  col.dataset.niche = niche;

  const kids = niche === UNSORTED ? [] : childrenOf(niche);
  const treeChannels = niche === UNSORTED ? channelsIn(UNSORTED) : uniqueChannelsInTree(niche);
  const name = niche === UNSORTED ? "Unsorted" : niche;
  const med = median(treeChannels.map(avgPerVideo).filter((v) => v > 0));
  const reach = treeChannels.reduce((s, c) => s + c.totalViews, 0);

  const head = document.createElement("div");
  head.className = "col-head";
  head.innerHTML = `
    <div class="col-titlerow">
      <span class="col-dot" style="background:${niche === UNSORTED ? "#3a3a44" : nicheColor(niche)}"></span>
      <span class="col-title">${esc(name)}</span>
      <span class="col-count">${treeChannels.length}</span>
      ${niche === UNSORTED ? "" : `<button class="col-edit" title="Rename niche">✎</button><button class="col-del" title="Delete niche">✕</button>`}
    </div>
    ${niche !== UNSORTED ? `<div class="col-sub"><span><b>${compact(reach)}</b> reach</span><span>median <b>${med ? compact(med) : "—"}</b>/vid</span>${kids.length ? `<span><b>${kids.length}</b> sub-niche${kids.length === 1 ? "" : "s"}</span>` : ""}</div>` : ""}`;
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

function avatarHtml(c, cls = "") {
  if (c.thumb) return `<img class="avatar ${cls}" src="${esc(c.thumb)}" alt="" referrerpolicy="no-referrer">`;
  const letter = (c.title || "?").trim().charAt(0).toUpperCase();
  return `<div class="avatar ph ${cls}">${esc(letter)}</div>`;
}

function renderCard(c) {
  const card = document.createElement("div");
  card.className = "card";
  card.draggable = true;

  const avg = avgPerVideo(c);
  const hot = avg >= hotThreshold;
  const handle = c.customUrl ? esc(c.customUrl.startsWith("@") ? c.customUrl : "@" + c.customUrl) : "";

  const nicheChipsHtml = (c.niches || []).length
    ? `<div class="card-niches">${(c.niches || []).map((n) => `<span class="nichechip" style="--nc:${nicheColor(n)}">${esc(n)}<b data-rmniche="${esc(n)}" title="Remove">×</b></span>`).join("")}</div>`
    : "";

  const tagChips = labelChipsHtml(c);

  const exHtml = (c.examples || [])
    .map((ex, i) => `<a class="ex" href="${esc(ex.url)}" target="_blank" rel="noopener"><span class="lbl">${esc(ex.title || ex.url)}</span><span class="rm" data-rmex="${i}" title="Remove">✕</span></a>`)
    .join("");

  card.innerHTML = `
    ${nicheChipsHtml}
    ${tagChips}
    <div class="card-head">
      ${avatarHtml(c)}
      <div class="card-id">
        <a class="card-name" href="${channelUrl(c)}" target="_blank" rel="noopener">${esc(c.title) || "Channel"}</a>
        <div class="card-handle">${handle || "&nbsp;"}</div>
      </div>
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
      <span class="rs-thumb" style="background-image:url('${esc(r.thumb)}')"><span class="rs-views">${compact(r.views)}</span></span>
      <span class="rs-ago">${timeAgo(r.publishedAt)}</span>
    </a>`
    )
    .join("");
  return `<div class="rs-grid">${cells}</div>
    <a class="rs-all" href="https://www.youtube.com/channel/${c.channelId}/shorts" target="_blank" rel="noopener">Open all shorts on YouTube ↗</a>`;
}

function toggleRecent(c) {
  if (expanded.has(c.channelId)) {
    expanded.delete(c.channelId);
    render();
    return;
  }
  expanded.add(c.channelId);
  if (recentCache[c.channelId] && !recentCache[c.channelId].loading) {
    render();
    return;
  }
  recentCache[c.channelId] = { loading: true };
  render();
  chrome.runtime.sendMessage({ type: "RECENT", channelId: c.channelId }, (resp) => {
    if (chrome.runtime.lastError || !resp) recentCache[c.channelId] = { error: "Couldn't load — is the extension loaded?" };
    else if (!resp.ok) recentCache[c.channelId] = { error: resp.error === "NO_API_KEY" ? "Set your API key first" : "Couldn't load recent shorts" };
    else recentCache[c.channelId] = { recent: resp.recent || [] };
    if (expanded.has(c.channelId)) render();
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
  card.querySelector(".recent-toggle").onclick = () => toggleRecent(c);
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
function doRefresh() {
  if (refreshing || !state.watchlist.length) return;
  refreshing = true;
  const btn = document.getElementById("refresh");
  btn.classList.add("spin");
  const ids = state.watchlist.map((c) => c.channelId);
  chrome.runtime.sendMessage({ type: "REFRESH_CHANNELS", ids }, (resp) => {
    refreshing = false;
    btn.classList.remove("spin");
    if (chrome.runtime.lastError) return toast("Refresh failed — is the extension loaded?");
    if (!resp || !resp.ok) return toast(resp && resp.error === "NO_API_KEY" ? "Set your API key first" : "Refresh failed");
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
    toast(`Refreshed ${n} channel${n === 1 ? "" : "s"}`);
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
              <span class="dw-itemsave${saved ? " on" : ""}" data-save="${i}" title="${saved ? "Saved" : "Save short"}">🔖</span>
              <span class="dw-itemviews">${compact(r.views)}</span>
            </button>
            <div class="dw-itemtitle">${esc(r.title) || "Short"}</div>
            <div class="dw-itemago">${timeAgo(r.publishedAt)}</div>
          </div>`;
        })
        .join("");
      viewer = `<div class="dw-hint">${list.length} recent shorts · tap one to watch in the side window, 🔖 to save</div><div class="dw-grid">${cells}</div>`;
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
      if (e.target.closest(".dw-itemsave")) return; // handled below
      openShortsWindow(`https://www.youtube.com/shorts/${el.dataset.watch}`);
    };
  });
  drawer.querySelectorAll(".dw-itemsave").forEach((el) => {
    el.onclick = (e) => {
      e.stopPropagation();
      saveShortFromList(list[Number(el.dataset.save)]);
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
      const name = `[${mdEsc(c.title || "Channel")}](${channelUrl(c)})${handle ? " " + mdEsc(handle) : ""}`;
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

// Recent activity for a channel, derived from its latest shorts (publishedAt + views).
function velocity(c) {
  const cache = recentCache[c.channelId];
  if (!cache || !cache.recent) return null;
  const all = cache.recent;
  const shorts = all.filter((r) => r.isShort);
  const list = shorts.length >= 5 ? shorts : all;
  const now = Date.now();
  const day = 864e5;
  const within = (d) => list.filter((r) => r.publishedAt && r.publishedAt >= now - d * day);
  const sum = (arr) => arr.reduce((s, r) => s + (r.views || 0), 0);
  const v7 = within(7), v30 = within(30), v90 = within(90);
  const forAvg = v90.length ? v90 : list.slice(0, 20);
  const recentAvg = forAvg.length ? sum(forAvg) / forAvg.length : 0;
  const lifetimeAvg = c.videoCount ? c.totalViews / c.videoCount : 0;
  return { views7: sum(v7), views30: sum(v30), views90: sum(v90), uploads7: v7.length, uploads30: v30.length, recentAvg, lifetimeAvg, momentum: lifetimeAvg ? recentAvg / lifetimeAvg : 0 };
}

let fetchingAll = false;
function fetchAllRecent() {
  if (fetchingAll) return;
  const todo = state.watchlist.filter((c) => !(recentCache[c.channelId] && recentCache[c.channelId].recent));
  if (!todo.length) return render();
  fetchingAll = true;
  const total = todo.length;
  let done = 0;
  const tick = () => {
    const el = document.getElementById("an-progress");
    if (el) el.textContent = `Loading… ${done}/${total}`;
  };
  const next = () => {
    if (!todo.length) {
      fetchingAll = false;
      render();
      toast("Activity loaded");
      return;
    }
    const c = todo.shift();
    recentCache[c.channelId] = { loading: true };
    chrome.runtime.sendMessage({ type: "RECENT", channelId: c.channelId }, (resp) => {
      recentCache[c.channelId] = chrome.runtime.lastError || !resp || !resp.ok ? { recent: [] } : { recent: resp.recent || [] };
      done++;
      tick();
      next();
    });
  };
  render();
  tick();
  next();
}

function anCard(value, label) {
  return `<div class="an-card"><b>${value}</b><span>${esc(label)}</span></div>`;
}
function anBar(label, value, max, sub, color) {
  const pct = max > 0 ? Math.max(2, Math.round((value / max) * 100)) : 0;
  return `<div class="an-bar">
    <div class="an-bar-top"><span class="an-bar-label">${esc(label)}</span><b>${compact(value)}</b></div>
    <div class="an-bar-track"><div class="an-bar-fill" style="width:${pct}%;background:${color || "var(--red)"}"></div></div>
    ${sub ? `<div class="an-bar-sub">${sub}</div>` : ""}
  </div>`;
}
function sparkline(values) {
  if (values.length < 2) return "";
  const w = 600, h = 90, pad = 5;
  const min = Math.min(...values), max = Math.max(...values), rng = max - min || 1;
  const pts = values.map((v, i) => `${(pad + (i / (values.length - 1)) * (w - 2 * pad)).toFixed(1)},${(h - pad - ((v - min) / rng) * (h - 2 * pad)).toFixed(1)}`);
  return `<svg class="an-spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
    <path d="M${pad},${h - pad} L${pts.join(" L")} L${w - pad},${h - pad} Z" fill="rgba(255,0,51,0.12)"/>
    <path d="M${pts.join(" L")}" fill="none" stroke="var(--red)" stroke-width="2.5" vector-effect="non-scaling-stroke"/>
  </svg>`;
}

function renderAnalytics() {
  const wrap = document.createElement("div");
  wrap.className = "analytics";
  if (!state.watchlist.length) {
    wrap.innerHTML = `<div class="empty"><div><div class="big">📈</div><h2>Analytics needs data</h2><p>Save some channels first, then this tab breaks down reach by niche and shows what's heating up.</p></div></div>`;
    return wrap;
  }

  const totViews = state.watchlist.reduce((s, c) => s + c.totalViews, 0);
  const totSubs = state.watchlist.reduce((s, c) => s + c.subscribers, 0);
  const totVids = state.watchlist.reduce((s, c) => s + c.videoCount, 0);
  const med = median(state.watchlist.map(avgPerVideo).filter((v) => v > 0));

  // Group by top-level (parent) niche so a parent's total rolls up its sub-niches.
  const groups = [...topLevelNiches(), ""]
    .map((n) => ({ niche: n, channels: n === "" ? state.watchlist.filter((c) => !(c.niches || []).some((x) => state.niches.includes(x))) : uniqueChannelsInTree(n) }))
    .filter((g) => g.channels.length);

  const vmap = {};
  state.watchlist.forEach((c) => {
    const v = velocity(c);
    if (v) vmap[c.channelId] = v;
  });
  const haveVel = Object.keys(vmap).length;
  const agg = { v7: 0, v30: 0, v90: 0, up30: 0 };
  Object.values(vmap).forEach((v) => { agg.v7 += v.views7; agg.v30 += v.views30; agg.v90 += v.views90; agg.up30 += v.uploads30; });

  const cards = `<div class="an-cards">
    ${anCard(compact(totViews), "total reach")}
    ${anCard(state.watchlist.length, "channels")}
    ${anCard(compact(totSubs), "combined subs")}
    ${anCard(compact(totVids), "videos tracked")}
    ${anCard(med ? compact(med) : "—", "median avg/video")}
    ${anCard(state.niches.length, "niches")}
  </div>`;

  const nicheReach = groups
    .map((g) => ({ name: g.niche || "Unsorted", reach: g.channels.reduce((s, c) => s + c.totalViews, 0), count: g.channels.length, med: median(g.channels.map(avgPerVideo).filter((v) => v > 0)) }))
    .sort((a, b) => b.reach - a.reach);
  const maxReach = Math.max(1, ...nicheReach.map((n) => n.reach));
  const leaderboard = nicheReach.map((n, i) => anBar(n.name, n.reach, maxReach, `${n.count} channel${n.count > 1 ? "s" : ""} · median ${n.med ? compact(n.med) : "—"}/video`, NICHE_COLORS[i % NICHE_COLORS.length])).join("");

  let activity;
  if (haveVel < state.watchlist.length) {
    activity = `<div class="an-fetch">
      <div><div class="an-fetch-t">Recent activity & momentum</div>
      <div class="an-fetch-s">Pull each channel's latest shorts to see views in the last 7 / 30 / 90 days and who's heating up. ~2 API units per channel.</div></div>
      <button class="btn primary" id="an-fetchbtn">${fetchingAll ? `<span id="an-progress">Loading…</span>` : `Load recent activity (${state.watchlist.length})`}</button>
    </div>`;
  } else {
    const tiles = `<div class="an-cards">
      ${anCard(compact(agg.v7), "views · last 7 days")}
      ${anCard(compact(agg.v30), "views · last 30 days")}
      ${anCard(compact(Math.round(agg.v30 / 30)), "views / day (30d)")}
      ${anCard(agg.up30, "shorts posted · 30d")}
    </div>`;
    const nicheVel = groups.map((g) => ({ name: g.niche || "Unsorted", v30: g.channels.reduce((s, c) => s + ((vmap[c.channelId] && vmap[c.channelId].views30) || 0), 0) })).sort((a, b) => b.v30 - a.v30);
    const maxV = Math.max(1, ...nicheVel.map((n) => n.v30));
    const velBars = nicheVel.map((n, i) => anBar(n.name, n.v30, maxV, "last 30 days", NICHE_COLORS[i % NICHE_COLORS.length])).join("");
    const rows = state.watchlist.filter((c) => vmap[c.channelId]).map((c) => ({ c, v: vmap[c.channelId] })).sort((a, b) => b.v.momentum - a.v.momentum);
    const momRows = rows.map(({ c, v }) => {
      const m = v.momentum, dir = m >= 1.15 ? "up" : m <= 0.85 ? "down" : "flat", pct = v.lifetimeAvg ? Math.round((m - 1) * 100) : 0;
      return `<tr>
        <td><div class="tcell-name">${avatarHtml(c)}<a href="${channelUrl(c)}/shorts" target="_blank" rel="noopener">${esc(c.title) || "Channel"}</a></div></td>
        <td>${esc((c.niches || []).join(", ") || "—")}</td><td>${compact(v.views30)}</td><td>${v.uploads30}</td><td>${compact(v.recentAvg)}</td><td>${compact(v.lifetimeAvg)}</td>
        <td class="mom mom-${dir}">${dir === "up" ? "▲" : dir === "down" ? "▼" : "–"} ${pct > 0 ? "+" : ""}${pct}%</td></tr>`;
    }).join("");
    activity = `${tiles}
      <div class="an-section-t">Niche momentum <span class="an-hint">views in the last 30 days</span></div>
      <div class="an-bars">${velBars}</div>
      <div class="an-section-t">Channel momentum <span class="an-hint">recent avg vs lifetime avg — who's heating up</span></div>
      <div class="tablewrap" style="padding:0">
        <table class="tbl"><thead><tr><th>Channel</th><th>Niche</th><th>30d views</th><th>30d posts</th><th>Recent avg</th><th>Lifetime avg</th><th>Momentum</th></tr></thead><tbody>${momRows}</tbody></table>
      </div>`;
  }

  let growth;
  const snaps = (state.snapshots || []).filter((s) => s.totalViews);
  if (snaps.length >= 2) {
    const first = snaps[0], last = snaps[snaps.length - 1];
    const days = Math.max(1, (last.t - first.t) / 864e5);
    const perDay = (last.totalViews - first.totalViews) / days;
    const delta = last.totalViews - first.totalViews;
    growth = `<div class="an-section-t">Tracked growth <span class="an-hint">from your refresh history</span></div>
      <div class="an-cards">
        ${anCard((perDay >= 0 ? "+" : "") + compact(perDay), "reach / day (measured)")}
        ${anCard((delta >= 0 ? "+" : "") + compact(delta), `since ${new Date(first.t).toLocaleDateString()}`)}
        ${anCard(snaps.length, "snapshots")}
      </div>${sparkline(snaps.map((s) => s.totalViews))}`;
  } else {
    growth = `<div class="an-section-t">Tracked growth</div>
      <div class="rs-msg" style="text-align:left;padding:14px 0">Hit <b>Refresh</b> periodically (e.g. weekly) — Shorts Scout will chart your watchlist's real reach-per-day here over time.${snaps.length ? " (1 snapshot so far — need 2.)" : ""}</div>`;
  }

  wrap.innerHTML = `
    <div class="an-section-t first">Overview</div>${cards}
    <div class="an-section-t">Niches by total reach <span class="an-hint">which niches command the most views</span></div>
    <div class="an-bars">${leaderboard}</div>
    <div class="an-section-t">Recent activity</div>${activity}
    ${growth}`;
  const fb = wrap.querySelector("#an-fetchbtn");
  if (fb) fb.onclick = () => fetchAllRecent();
  return wrap;
}

// ---- saved videos view -----------------------------------------------------

function saveVideos() {
  ignoreNextChange = true;
  chrome.storage.local.set({ savedVideos: state.savedVideos });
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
  const snaps = (state.snapshots || []).slice();
  const last = snaps[snaps.length - 1];
  const entry = { t: Date.now(), totalViews, subscribers, channels: state.watchlist.length };
  if (last && Date.now() - last.t < 6 * 3600e3) snaps[snaps.length - 1] = entry; // collapse same-session
  else snaps.push(entry);
  state.snapshots = snaps.slice(-400);
  ignoreNextChange = true;
  chrome.storage.local.set({ snapshots: state.snapshots });
}

// ---- notebook (Markdown + images) ------------------------------------------

let nbImages = {};
let nbSaveTimer = null;

function openNotebook() {
  const nb = document.getElementById("notebook");
  chrome.storage.local.get(["notebookMd", "notebookImages"], (d) => {
    nbImages = d.notebookImages || {};
    nb.innerHTML = `
      <div class="nb-bar">
        <div class="brand"><div class="logo">📓</div><div><h1>Notebook</h1><div class="tag">SHORTS SCOUT</div></div></div>
        <span class="nb-saved" id="nb-saved"></span>
        <span style="flex:1"></span>
        <div class="nb-modes" id="nb-modes">
          <button data-m="write">Write</button>
          <button data-m="split" class="on">Split</button>
          <button data-m="preview">Preview</button>
        </div>
        <button class="nb-x" title="Close">✕</button>
      </div>
      <div class="nb-body mode-split" id="nb-body">
        <div class="nb-edit"><textarea id="nb-text" spellcheck="false" placeholder="# My ideas&#10;&#10;Write in **Markdown**. Paste or drop screenshots right in.&#10;&#10;- [ ] a checklist&#10;- bullet points&#10;&#10;> a quote"></textarea></div>
        <div class="nb-preview"><div class="md" id="nb-md"></div></div>
      </div>`;
    nb.classList.add("open");

    const ta = nb.querySelector("#nb-text");
    ta.value = d.notebookMd || "";
    const preview = nb.querySelector("#nb-md");
    const saved = nb.querySelector("#nb-saved");

    const renderPreview = () => {
      const src = ta.value || "";
      let html;
      try {
        html = window.marked ? marked.parse(src) : esc(src).replace(/\n/g, "<br>");
      } catch (e) {
        html = esc(src).replace(/\n/g, "<br>");
      }
      preview.innerHTML = html || `<div class="nb-empty">Nothing yet — start writing on the left.</div>`;
      preview.querySelectorAll("img").forEach((img) => {
        const m = (img.getAttribute("src") || "").match(/^img:(.+)$/);
        if (m && nbImages[m[1]]) img.src = nbImages[m[1]];
      });
      preview.querySelectorAll("a").forEach((a) => { a.target = "_blank"; a.rel = "noopener"; });
    };
    renderPreview();

    const scheduleSave = () => {
      saved.textContent = "Saving…";
      clearTimeout(nbSaveTimer);
      nbSaveTimer = setTimeout(() => {
        chrome.storage.local.set({ notebookMd: ta.value }, () => { saved.textContent = "Saved ✓"; });
      }, 500);
    };
    ta.addEventListener("input", () => { renderPreview(); scheduleSave(); });

    const body = nb.querySelector("#nb-body");
    nb.querySelectorAll("#nb-modes button").forEach((b) => {
      b.onclick = () => {
        nb.querySelectorAll("#nb-modes button").forEach((x) => x.classList.remove("on"));
        b.classList.add("on");
        body.className = "nb-body mode-" + b.dataset.m;
        if (b.dataset.m !== "write") renderPreview();
      };
    });
    nb.querySelector(".nb-x").onclick = closeNotebook;

    // Paste an image directly.
    ta.addEventListener("paste", (e) => {
      const items = (e.clipboardData || {}).items || [];
      for (const it of items) {
        if (it.type && it.type.startsWith("image/")) {
          e.preventDefault();
          addNotebookImage(it.getAsFile(), ta, renderPreview, scheduleSave);
        }
      }
    });
    // Drag-and-drop image files.
    const editDiv = nb.querySelector(".nb-edit");
    ["dragenter", "dragover"].forEach((ev) => editDiv.addEventListener(ev, (e) => { e.preventDefault(); editDiv.classList.add("drag"); }));
    ["dragleave", "drop"].forEach((ev) => editDiv.addEventListener(ev, (e) => { e.preventDefault(); editDiv.classList.remove("drag"); }));
    editDiv.addEventListener("drop", (e) => {
      const files = (e.dataTransfer || {}).files || [];
      for (const f of files) if (f.type && f.type.startsWith("image/")) addNotebookImage(f, ta, renderPreview, scheduleSave);
    });

    ta.focus();
  });
}

function addNotebookImage(file, ta, renderPreview, scheduleSave) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    const id = "im" + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36);
    nbImages[id] = reader.result;
    const s = ta.selectionStart;
    const snippet = `\n![screenshot](img:${id})\n`;
    ta.value = ta.value.slice(0, s) + snippet + ta.value.slice(ta.selectionEnd);
    ta.selectionStart = ta.selectionEnd = s + snippet.length;
    chrome.storage.local.set({ notebookImages: nbImages });
    renderPreview();
    scheduleSave();
  };
  reader.readAsDataURL(file);
}

function closeNotebook() {
  const nb = document.getElementById("notebook");
  nb.classList.remove("open");
  nb.innerHTML = "";
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
document.getElementById("addNiche").onclick = promptAddNiche;
document.getElementById("manageTags").onclick = openTagManager;
document.getElementById("manageGroups").onclick = openGroupsManager;
document.getElementById("notebookBtn").onclick = openNotebook;
document.getElementById("export").onclick = exportMarkdown;

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
