/* cloud-app.js — turns the Shorts Scout board into a standalone website.
 *
 * OPEN MODE: no sign-in. The board lives in one shared Firestore document
 * (boards/shared) that anyone with the site URL can read & write. Keep the URL
 * private. Your YouTube API key is kept on this device only (localStorage), so
 * it is never written into the public shared document.
 *
 * It provides a real `window.chrome` shim so the EXACT extension board code
 * (watchlist.js) runs unchanged:
 *   - chrome.storage.local  -> Firestore (synced across all your devices)
 *   - chrome.runtime.sendMessage(RECENT / REFRESH_CHANNELS / OPEN_TAB) -> direct YouTube API
 *   - chrome.tabs / chrome.windows -> window.open
 */
(function () {
  // ---- Firebase init -------------------------------------------------------
  if (!window.FIREBASE_CONFIG || window.FIREBASE_CONFIG.apiKey === "REPLACE_ME") {
    document.addEventListener("DOMContentLoaded", () =>
      showGate(`<h2>Almost there</h2><p>Open <code>firebase-config.js</code> and paste your Firebase config, then reload. See <b>SETUP.md</b>.</p>`)
    );
    return;
  }
  firebase.initializeApp(window.FIREBASE_CONFIG);
  const db = firebase.firestore();
  // MULTI-BOARD: the active board ("user") is chosen per-device. "shared" is the
  // Team board; personal boards live at boards/<id>. The list of boards lives in
  // a registry doc so every teammate sees the same switcher.
  function getActiveBoard() { try { return JSON.parse(localStorage.getItem("ss_activeBoard")) || "shared"; } catch (e) { return "shared"; } }
  const ACTIVE = getActiveBoard();
  const DOC = db.collection("boards").doc(ACTIVE);   // the board we're viewing
  const REG = db.collection("boards").doc("registry"); // registry of all boards (plain id; __index__ is reserved)

  let cloudData = {}; // mirrors chrome.storage.local
  const listeners = [];
  let booted = false;
  let writeTimer = null;

  // Kept per-device in localStorage (never written to the public shared doc):
  //  - notebookImages: too big for one Firestore doc (1MB cap)
  //  - apiKey: secret-ish; don't expose it in world-readable data
  const LOCAL_KEYS = new Set(["notebookImages", "apiKey"]);
  // Keys that must NEVER be written into a board document (per-device or registry).
  const NO_BOARD = new Set(["notebookImages", "apiKey", "boardProfiles", "activeBoard", "_cloudRev", "_rev"]);
  function loadLocalKeys() {
    LOCAL_KEYS.forEach((k) => {
      try { const v = localStorage.getItem("ss_" + k); if (v != null) cloudData[k] = JSON.parse(v); } catch (e) {}
    });
  }

  // ---- chrome shim ---------------------------------------------------------
  window.chrome = {
    storage: {
      local: {
        get(keys, cb) {
          const out = {};
          const arr = keys == null ? Object.keys(cloudData) : Array.isArray(keys) ? keys : [keys];
          arr.forEach((k) => (out[k] = cloudData[k]));
          cb && cb(out);
        },
        set(obj, cb) {
          Object.assign(cloudData, obj);
          let cloudDirty = false;
          Object.keys(obj).forEach((k) => {
            if (LOCAL_KEYS.has(k)) {
              try { localStorage.setItem("ss_" + k, JSON.stringify(obj[k])); } catch (e) {}
            } else cloudDirty = true;
          });
          if (cloudDirty) scheduleWrite();
          cb && cb();
        },
      },
      onChanged: { addListener(fn) { listeners.push(fn); } },
    },
    runtime: {
      lastError: undefined,
      getURL(p) { return p; },
      sendMessage(msg, cb) {
        handleMsg(msg).then((r) => cb && cb(r)).catch((e) => cb && cb({ ok: false, error: e && e.message }));
      },
      onStartup: { addListener() {} },
      onInstalled: { addListener() {} },
    },
    tabs: { create(o) { window.open(o.url, "_blank"); }, update(id, o) { if (o && o.url && winMap[id]) try { winMap[id].location = o.url; } catch (e) {} } },
    windows: {
      create(o, cb) { const w = window.open(o.url, "ss_shorts", "width=480,height=900"); winMap[1] = w; cb && cb({ id: 1, tabs: [{ id: 1 }] }); },
      update() {},
      remove(id) { if (winMap[id]) try { winMap[id].close(); } catch (e) {} },
      onRemoved: { addListener() {} },
    },
  };
  const winMap = {};

  // ---- Firestore sync ------------------------------------------------------
  function scheduleWrite() {
    clearTimeout(writeTimer);
    setStatus("Saving…");
    writeTimer = setTimeout(async () => {
      const payload = {};
      Object.keys(cloudData).forEach((k) => { if (!NO_BOARD.has(k)) payload[k] = cloudData[k]; });
      payload._rev = Date.now(); // lets the extension detect this change and pull it
      try {
        await DOC.set(payload, { merge: true });
        setStatus("Saved ✓");
      } catch (e) {
        setStatus("Save failed");
        console.error("Firestore write failed", e);
      }
    }, 700);
  }

  function applyRemote(data) {
    const changes = {};
    Object.keys(data || {}).forEach((k) => {
      if (LOCAL_KEYS.has(k)) return;
      if (JSON.stringify(cloudData[k]) !== JSON.stringify(data[k])) {
        changes[k] = { newValue: data[k] };
        cloudData[k] = data[k];
      }
    });
    if (Object.keys(changes).length) listeners.forEach((fn) => { try { fn(changes, "local"); } catch (e) {} });
  }

  // ---- YouTube Data API (runs in-browser with your key) --------------------
  function ytKey() { return cloudData.apiKey || ""; }
  async function ytApi(path, params) {
    const url = new URL("https://www.googleapis.com/youtube/v3/" + path);
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
    url.searchParams.set("key", ytKey());
    const res = await fetch(url.toString());
    const data = await res.json();
    if (!res.ok) {
      const reason = (data.error && data.error.errors && data.error.errors[0] && data.error.errors[0].reason) || res.status;
      throw new Error("YouTube API: " + reason);
    }
    return data;
  }
  function isoDur(iso) { const m = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso || ""); if (!m) return null; return +(m[1] || 0) * 3600 + +(m[2] || 0) * 60 + +(m[3] || 0); }
  async function ytChannel(id) {
    const d = await ytApi("channels", { part: "statistics,snippet,contentDetails", id });
    const it = d.items && d.items[0];
    if (!it) throw new Error("Channel not found");
    const t = it.snippet && it.snippet.thumbnails || {};
    return {
      channelId: id, title: (it.snippet && it.snippet.title) || "",
      totalViews: +((it.statistics && it.statistics.viewCount) || 0),
      subscribers: +((it.statistics && it.statistics.subscriberCount) || 0),
      videoCount: +((it.statistics && it.statistics.videoCount) || 0),
      thumb: ((t.medium || t.default || {}).url) || "",
      customUrl: (it.snippet && it.snippet.customUrl) || "",
      uploadsPlaylist: it.contentDetails && it.contentDetails.relatedPlaylists && it.contentDetails.relatedPlaylists.uploads,
    };
  }
  async function ytRecent(channelId, maxItems) {
    const channel = await ytChannel(channelId);
    const recent = []; let pageToken = "", pages = 0;
    while (recent.length < maxItems && pages < 6) {
      const page = await ytApi("playlistItems", Object.assign({ part: "contentDetails", playlistId: channel.uploadsPlaylist, maxResults: 50 }, pageToken ? { pageToken } : {}));
      const items = page.items || [];
      const ids = items.map((i) => i.contentDetails && i.contentDetails.videoId).filter(Boolean);
      if (ids.length) {
        const stats = await ytApi("videos", { part: "statistics,snippet,contentDetails", id: ids.join(",") });
        for (const v of stats.items || []) {
          if (recent.length >= maxItems) break;
          const ds = isoDur(v.contentDetails && v.contentDetails.duration);
          const t = (v.snippet && v.snippet.thumbnails) || {};
          recent.push({ videoId: v.id, title: (v.snippet && v.snippet.title) || "", thumb: ((t.medium || t.high || t.default || {}).url) || "", views: +((v.statistics && v.statistics.viewCount) || 0), publishedAt: new Date((v.snippet && v.snippet.publishedAt) || 0).getTime(), durationSec: ds, isShort: ds != null && ds <= 180 });
        }
      }
      pageToken = page.nextPageToken || ""; pages++;
      if (!pageToken) break;
    }
    return { ok: true, channel, recent };
  }
  async function ytRefresh(ids) {
    const out = {};
    for (let i = 0; i < ids.length; i += 50) {
      const batch = ids.slice(i, i + 50);
      const d = await ytApi("channels", { part: "statistics,snippet", id: batch.join(",") });
      for (const it of d.items || []) {
        const t = (it.snippet && it.snippet.thumbnails) || {};
        out[it.id] = { title: (it.snippet && it.snippet.title) || "", totalViews: +((it.statistics && it.statistics.viewCount) || 0), subscribers: +((it.statistics && it.statistics.subscriberCount) || 0), videoCount: +((it.statistics && it.statistics.videoCount) || 0), thumb: ((t.medium || t.default || {}).url) || "", customUrl: (it.snippet && it.snippet.customUrl) || "" };
      }
    }
    return { ok: true, channels: out };
  }
  async function handleMsg(msg) {
    if (!msg) return { ok: true };
    if (msg.type === "OPEN_TAB") { window.open(msg.url, "_blank"); return { ok: true }; }
    if (msg.type === "CLOUD_SYNC") { return { ok: true }; } // website is already live via onSnapshot
    if (msg.type === "SWITCH_BOARD") {
      // Flush the CURRENT board, remember the chosen one, then the page reloads onto it.
      const payload = {};
      Object.keys(cloudData).forEach((k) => { if (!NO_BOARD.has(k)) payload[k] = cloudData[k]; });
      payload._rev = Date.now();
      try { await DOC.set(payload, { merge: true }); } catch (e) { console.error("flush failed", e); }
      localStorage.setItem("ss_activeBoard", JSON.stringify(msg.to));
      return { ok: true };
    }
    if (msg.type === "SAVE_PROFILES") {
      cloudData.boardProfiles = msg.profiles;
      try { await REG.set({ profiles: msg.profiles, _rev: Date.now() }, { merge: true }); } catch (e) { console.error("profiles save failed", e); }
      return { ok: true };
    }
    if (!ytKey()) return { ok: false, error: "NO_API_KEY" };
    if (msg.type === "RECENT") return await ytRecent(msg.channelId, Math.min(200, Math.max(1, msg.maxItems || 50)));
    if (msg.type === "REFRESH_CHANNELS") return await ytRefresh(msg.ids || []);
    return { ok: true };
  }

  // ---- gate / account / settings UI ---------------------------------------
  function showGate(inner) {
    let g = document.getElementById("cloud-gate");
    if (!g) { g = document.createElement("div"); g.id = "cloud-gate"; document.body.appendChild(g); }
    g.innerHTML = `<div class="cg-box"><div class="cg-logo">📊</div>${inner}</div>`;
    g.style.display = "grid";
  }
  function hideGate() { const g = document.getElementById("cloud-gate"); if (g) g.style.display = "none"; }

  function mountAccountBar() {
    let bar = document.getElementById("cloud-acct");
    if (!bar) { bar = document.createElement("div"); bar.id = "cloud-acct"; document.body.appendChild(bar); }
    bar.innerHTML = `
      <span class="ca-status" id="cloud-status"></span>
      <button class="ca-btn" id="ca-key" title="Set YouTube API key (stored on this device only)">🔑 API key</button>
      <button class="ca-btn" id="ca-import" title="Import data from the extension's Export">⬆ Import</button>`;
    document.getElementById("ca-key").onclick = () => {
      const k = prompt("Paste your YouTube Data API v3 key (kept on this device only):", cloudData.apiKey || "");
      if (k != null) { chrome.storage.local.set({ apiKey: k.trim() }); alert("Saved on this device. Refresh stats / analytics now work."); }
    };
    document.getElementById("ca-import").onclick = importData;
  }
  function setStatus(t) { const el = document.getElementById("cloud-status"); if (el) el.textContent = t; }

  // Import by picking the Export file directly (the .md or .json the extension
  // produces). No copy/paste needed.
  function importData() {
    const inp = document.createElement("input");
    inp.type = "file";
    inp.accept = ".md,.json,.txt,text/markdown,application/json,text/plain";
    inp.style.display = "none";
    document.body.appendChild(inp);
    inp.onchange = () => {
      const f = inp.files && inp.files[0];
      inp.remove();
      if (!f) return;
      const reader = new FileReader();
      reader.onload = () => parseAndImport(String(reader.result || ""), f.name);
      reader.onerror = () => alert("Couldn't read that file.");
      reader.readAsText(f);
    };
    inp.click();
  }
  function parseAndImport(raw, fileName) {
    let json = (raw || "").trim();
    const m = json.match(/```json\s*([\s\S]*?)```/); // the Export .md has a ```json block
    if (m) json = m[1];
    let data;
    try { data = JSON.parse(json); }
    catch (e) { return alert(`Couldn't read "${fileName || "that file"}". Pick the file you got from the extension's ⋯ More → Export (its name ends in .md or .json).`); }
    const keys = ["niches", "nicheParents", "tags", "madeBy", "madeFor", "languages", "watchlist", "savedVideos", "snapshots"];
    const obj = {};
    keys.forEach((k) => { if (data[k] !== undefined) obj[k] = data[k]; });
    if (!Object.keys(obj).length) return alert("That file didn't contain any watchlist data. Make sure it's the Export from the extension.");
    if (!confirm(`Import ${(obj.watchlist || []).length} channels (and your niches/tags) — this replaces the current board. Continue?`)) return;
    chrome.storage.local.set(obj);
    alert("Imported ✓ Your board should fill in now.");
  }

  // ---- boot ----------------------------------------------------------------
  function bootBoard() {
    if (booted) return;
    booted = true;
    hideGate();
    const s = document.createElement("script");
    s.src = "watchlist.js";
    document.body.appendChild(s);
  }

  document.addEventListener("DOMContentLoaded", () => {
    showGate(`<h1>Shorts Scout</h1><p>Loading your board…</p>`);
    loadLocalKeys();
    cloudData.activeBoard = ACTIVE; // which board this device is viewing
    // Keep the list of boards (users) in sync from the shared registry doc.
    REG.onSnapshot((snap) => {
      const d = snap.data();
      if (!d || !Array.isArray(d.profiles) || !d.profiles.length) {
        const seed = [{ id: "shared", name: "Ashton" }, { id: "team", name: "Team" }];
        applyRemote({ boardProfiles: seed });
        REG.set({ profiles: seed, _rev: Date.now() }, { merge: true }).catch(() => {});
        return;
      }
      applyRemote({ boardProfiles: d.profiles });
      // Recover a dangling active board (e.g. a removed user) -> reload onto the main board.
      if (!d.profiles.some((p) => p.id === ACTIVE) && ACTIVE !== "shared") {
        localStorage.setItem("ss_activeBoard", JSON.stringify("shared"));
        location.reload();
      }
    }, (err) => console.warn("registry", err));
    DOC.onSnapshot((snap) => {
      if (snap.metadata.hasPendingWrites) return; // ignore our own writes
      const data = snap.data() || {};
      if (!booted) { Object.assign(cloudData, data); mountAccountBar(); bootBoard(); }
      else applyRemote(data);
    }, (err) => { console.error(err); showGate(`<h2>Couldn't load the board</h2><p>${err.message}</p>`); });
  });
})();
