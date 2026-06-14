// content.js — runs on youtube.com.
// Default (auto) state: a medium card with the short's views + channel basics (cheap).
// Click "load": expands to the full card with 1M/10M milestones + recent shorts (deep scan).

(function () {
  let requestCounter = 0;
  let activeRequestId = null;
  let lastVideo = null;
  let lastQuick = null; // { video, channel } from the cheap auto fetch
  let autoShow = true; // toggled from settings
  let watchlist = []; // saved channels, mirrored from chrome.storage.local
  let niches = []; // niche column names, mirrored from storage
  let savedVideos = []; // individually saved shorts, mirrored from storage
  let collapsed = false; // when true, the panel stays hidden until reopened via the dock button
  let tags = []; // available tag names, mirrored from storage
  let madeBy = [];
  let madeFor = [];
  let languages = [];
  const DEFAULT_TAGS = ["family", "child", "brain rot", "skits", "relatable"];
  const DEFAULT_MADE_BY = ["children", "teenagers", "adults", "families"];
  const DEFAULT_MADE_FOR = ["babies", "children", "teenagers", "adults"];
  const DEFAULT_LANGUAGES = ["English", "Spanish", "Hindi", "Portuguese", "Arabic", "Indonesian", "Japanese", "Korean", "Russian", "French", "German", "Chinese", "Turkish", "Vietnamese", "Italian", "Thai"];
  const SHEET_DIMS = [
    { field: "tags", label: "Tags" },
    { field: "madeBy", label: "Made by" },
    { field: "madeFor", label: "Made for" },
    { field: "languages", label: "Language" },
  ];
  function dimList(field) {
    return field === "tags" ? tags : field === "madeBy" ? madeBy : field === "madeFor" ? madeFor : languages;
  }

  // ---- helpers ---------------------------------------------------------------

  function currentVideoId() {
    const m = location.pathname.match(/^\/shorts\/([A-Za-z0-9_-]{6,})/);
    return m ? m[1] : null;
  }

  function fmt(n) {
    if (n == null || isNaN(n)) return "—";
    return Number(n).toLocaleString("en-US");
  }

  function compact(n) {
    if (n == null || isNaN(n)) return "—";
    return Intl.NumberFormat("en-US", {
      notation: "compact",
      maximumFractionDigits: 1,
    }).format(n);
  }

  function relTime(ms) {
    if (!ms || isNaN(ms)) return "—";
    const day = 86400000;
    const diff = Date.now() - ms;
    if (diff < day) return "today";
    const days = Math.round(diff / day);
    if (days < 14) return `${days}d ago`;
    if (days < 60) return `${Math.round(days / 7)}w ago`;
    if (days < 730) return `${Math.round(days / 30)}mo ago`;
    return `${Math.round(days / 365)}y ago`;
  }

  // Precise "X hours ago" for recent uploads; falls back to days/weeks for older.
  function preciseAgo(ms) {
    if (!ms || isNaN(ms)) return "—";
    const mins = Math.floor((Date.now() - ms) / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 48) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days < 14) return `${days}d ago`;
    if (days < 60) return `${Math.round(days / 7)}w ago`;
    if (days < 730) return `${Math.round(days / 30)}mo ago`;
    return `${Math.round(days / 365)}y ago`;
  }

  function cadenceText(u) {
    if (!u || u.perWeek == null) return "—";
    const p = u.perWeek;
    if (p >= 1) return `${p >= 10 ? Math.round(p) : p.toFixed(1)}/wk`;
    return `1 / ${Math.round(u.avgGapDays)}d`;
  }

  function esc(s) {
    return String(s || "").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  }

  function openTab(url, active) {
    chrome.runtime.sendMessage({ type: "OPEN_TAB", url, active: !!active });
  }

  function openBoard() {
    openTab(chrome.runtime.getURL("watchlist.html"), true);
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (e) {
      // Fallback for when the async clipboard API is blocked.
      try {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        const ok = document.execCommand("copy");
        ta.remove();
        return ok;
      } catch (_) {
        return false;
      }
    }
  }

  function statCell(value, label) {
    return `<div class="ssct-stat"><b>${value}</b><span>${label}</span></div>`;
  }

  // ---- UI elements -----------------------------------------------------------

  const dock = document.createElement("div");
  dock.id = "ssct-dock";
  dock.style.display = "none";

  const btn = document.createElement("button");
  btn.id = "ssct-btn";
  btn.type = "button";
  btn.innerHTML = `<span class="ssct-btn-ico">📊</span>`;
  btn.title = "Analyze this short";
  dock.appendChild(btn);

  const panel = document.createElement("div");
  panel.id = "ssct-panel";
  panel.style.display = "none";

  function mount() {
    if (!document.body.contains(dock)) document.body.appendChild(dock);
    if (!document.body.contains(panel)) document.body.appendChild(panel);
  }

  function findActionsColumn() {
    const selectors = [
      "ytd-reel-player-overlay-renderer #actions",
      "#actions.ytd-reel-player-overlay-renderer",
      "ytd-reel-video-renderer #actions",
      "ytd-shorts #actions",
    ];
    for (const s of selectors) {
      const el = document.querySelector(s);
      if (el) {
        const r = el.getBoundingClientRect();
        if (r.height > 120 && r.width < 220 && r.left > window.innerWidth * 0.35) {
          return r;
        }
      }
    }
    return null;
  }

  function positionDock() {
    if (dock.style.display === "none") return;
    const r = findActionsColumn();
    if (r) {
      dock.style.left = `${Math.round(r.right + 14)}px`;
      dock.style.right = "auto";
      dock.style.top = `${Math.round(r.top + r.height / 2)}px`;
      dock.style.bottom = "auto";
      dock.style.transform = "translateY(-50%)";
    } else {
      dock.style.left = "auto";
      dock.style.right = "24px";
      dock.style.top = "auto";
      dock.style.bottom = "120px";
      dock.style.transform = "none";
    }
  }

  function syncVisibility() {
    const onShort = !!currentVideoId();
    dock.style.display = onShort ? "flex" : "none";
    if (!onShort) panel.style.display = "none";
    if (onShort) positionDock();
  }

  // ---- panel shell -----------------------------------------------------------

  function collapsePanel() {
    collapsed = true;
    chrome.storage.local.set({ panelCollapsed: true });
    panel.style.display = "none";
  }

  function wireHeader() {
    const c = panel.querySelector(".ssct-close");
    if (c) c.onclick = collapsePanel;
    const w = panel.querySelector(".ssct-watch-open");
    if (w) w.onclick = () => renderWatchlist();
  }

  function shell(inner) {
    panel.innerHTML = `
      <div class="ssct-head">
        <span class="ssct-title">Shorts Scout</span>
        <div class="ssct-head-right">
          <button class="ssct-watch-open" type="button" title="Open watchlist">★ <span class="ssct-watch-count">${watchlist.length}</span></button>
          <button class="ssct-close" type="button" aria-label="Collapse" title="Collapse — stays hidden until you reopen with the 📊 button">✕</button>
        </div>
      </div>
      <div class="ssct-body">${inner}</div>`;
    wireHeader();
  }

  function heroHtml(video) {
    return `
      <div class="ssct-hero">
        <div class="ssct-hero-num">${fmt(video ? video.views : null)}</div>
        <div class="ssct-hero-label">views on this short</div>
        ${
          video
            ? `<div class="ssct-hero-sub">${compact(video.likes)} likes · ${compact(
                video.comments
              )} comments</div>`
            : ""
        }
      </div>`;
  }

  // ---- MEDIUM state (auto, cheap) -------------------------------------------

  // ---- watchlist (saved channels) -------------------------------------------

  function inWatchlist(channelId) {
    return watchlist.some((w) => w.channelId === channelId);
  }

  function saveWatchlist() {
    chrome.storage.local.set({ watchlist });
  }

  function toggleWatch(channel) {
    const i = watchlist.findIndex((w) => w.channelId === channel.channelId);
    if (i >= 0) {
      watchlist.splice(i, 1);
    } else {
      watchlist.push({
        channelId: channel.channelId,
        title: channel.title || "",
        totalViews: channel.totalViews,
        subscribers: channel.subscribers,
        videoCount: channel.videoCount,
        thumb: channel.thumb || "",
        customUrl: channel.customUrl || "",
        addedAt: Date.now(),
        refreshedAt: Date.now(),
      });
    }
    saveWatchlist();
  }

  function updateWatchCount() {
    const c = panel.querySelector(".ssct-watch-count");
    if (c) c.textContent = watchlist.length;
  }

  function renderWatchlist() {
    const items = watchlist.slice().sort((a, b) => b.addedAt - a.addedAt);
    const rows = items.length
      ? items
          .map(
            (w) => `
        <div class="ssct-wl-item">
          <div class="ssct-wl-info">
            <div class="ssct-wl-title">${esc(w.title) || "Channel"}</div>
            <div class="ssct-wl-sub">${compact(w.subscribers)} subs · ${compact(
              w.totalViews
            )} views</div>
          </div>
          <div class="ssct-wl-btns">
            <button class="ssct-wl-btn" data-open="${w.channelId}" title="Open channel">↗</button>
            <button class="ssct-wl-btn" data-remove="${w.channelId}" title="Remove">✕</button>
          </div>
        </div>`
          )
          .join("")
      : `<p class="ssct-muted">No channels saved yet. Tap ☆ Save on a channel to add it here.</p>`;

    shell(`
      <div class="ssct-wl-head">
        <button class="ssct-wl-back" type="button">← Back</button>
        <span class="ssct-section-label">Watchlist · ${items.length}</span>
        <button class="ssct-wl-board" type="button" title="Open the full niche board">⤢ Board</button>
      </div>
      <div class="ssct-wl-list">${rows}</div>
    `);

    const board = panel.querySelector(".ssct-wl-board");
    if (board) board.onclick = () => openBoard();
    const back = panel.querySelector(".ssct-wl-back");
    if (back)
      back.onclick = () => {
        if (lastQuick) renderQuick(lastQuick.video, lastQuick.channel);
        else panel.style.display = "none";
      };
    panel.querySelectorAll("[data-open]").forEach((b) => {
      b.onclick = () =>
        openTab(`https://www.youtube.com/channel/${b.dataset.open}`);
    });
    panel.querySelectorAll("[data-remove]").forEach((b) => {
      b.onclick = () => {
        const i = watchlist.findIndex((w) => w.channelId === b.dataset.remove);
        if (i >= 0) {
          watchlist.splice(i, 1);
          saveWatchlist();
        }
        renderWatchlist();
      };
    });
    panel.style.display = "block";
  }

  // ---- channel action buttons (copy / open / save) --------------------------

  function channelActionsHtml(channel) {
    const saved = inWatchlist(channel.channelId);
    return `
      <div class="ssct-actions">
        <button class="ssct-act" type="button" data-act="copy">📋 Copy URL</button>
        <button class="ssct-act" type="button" data-act="open">↗ Open</button>
        <button class="ssct-act ${
          saved ? "ssct-act-saved" : ""
        }" type="button" data-act="star">${saved ? "★ Saved" : "☆ Save"}</button>
      </div>`;
  }

  function wireChannelActions(channel) {
    const channelUrl = `https://www.youtube.com/channel/${channel.channelId}`;

    const open = panel.querySelector('[data-act="open"]');
    if (open) open.onclick = () => openTab(channelUrl);

    const copy = panel.querySelector('[data-act="copy"]');
    if (copy) {
      copy.onclick = async () => {
        const ok = await copyText(channelUrl);
        const original = copy.innerHTML;
        copy.innerHTML = ok ? "✓ Copied!" : "Copy failed";
        copy.classList.toggle("ssct-act-ok", ok);
        setTimeout(() => {
          copy.innerHTML = original;
          copy.classList.remove("ssct-act-ok");
        }, 1300);
      };
    }

    const star = panel.querySelector('[data-act="star"]');
    if (star) star.onclick = () => openSaveSheet(channel);
  }

  // ---- save sheets (niche / status / notes when saving) ---------------------

  function chipRow(items, selected, attr) {
    return items
      .map(
        (it) =>
          `<button class="ssct-chip2${it.value === selected ? " on" : ""}" data-${attr}="${esc(it.value)}">${esc(it.label)}</button>`
      )
      .join("");
  }

  function openSaveSheet(channel, draft) {
    const existing = watchlist.find((w) => w.channelId === channel.channelId);
    const d = draft || {};
    let selNiches = d.niches !== undefined ? d.niches.slice() : existing ? (existing.niches || (existing.niche ? [existing.niche] : [])).slice() : [];
    const notesVal = d.notes !== undefined ? d.notes : existing ? existing.notes : "";

    // Selected values per dimension.
    const sel = {};
    SHEET_DIMS.forEach((dim) => {
      let init = d[dim.field] !== undefined ? d[dim.field] : existing ? existing[dim.field] : undefined;
      if (dim.field === "tags" && !init && existing && existing.status) init = [existing.status];
      sel[dim.field] = (init || []).slice();
    });

    const nicheChipsHtml = niches.map((n) => `<button class="ssct-chip2${selNiches.includes(n) ? " on" : ""}" data-niche="${esc(n)}">${esc(n)}</button>`).join("");
    const dimBtns = SHEET_DIMS.map(
      (dim) => `<button class="msd-btn" type="button" data-field="${dim.field}">${dim.label}<span class="msd-count" data-cnt="${dim.field}">${sel[dim.field].length || ""}</span><span class="msd-caret">▾</span></button>`
    ).join("");

    shell(`
      <div class="ssct-sheet">
        <div class="ssct-sheet-title">${existing ? "Edit saved channel" : "Save channel"}</div>
        <div class="ssct-channel-name">${esc(channel.title) || "Channel"}</div>
        <div class="ssct-label">Niches <span style="text-transform:none;letter-spacing:0;color:#777">— select any</span></div>
        <div class="ssct-chips2" data-group="niche">${nicheChipsHtml}<button class="ssct-chip2 new" data-newniche>＋ New</button></div>
        <div class="ssct-label">Labels</div>
        <div class="msd-wrap"><div class="msd-row">${dimBtns}</div><div class="msd-panel"></div></div>
        <div class="ssct-label">Notes</div>
        <textarea class="ssct-sheet-notes" placeholder="What's the format? Why does it work?">${esc(notesVal)}</textarea>
        <div class="ssct-sheet-btns">
          <button class="ssct-sheet-save">${existing ? "Update" : "★ Save"}</button>
          ${existing ? '<button class="ssct-sheet-remove">Remove</button>' : ""}
          <button class="ssct-sheet-cancel">Cancel</button>
        </div>
      </div>`);
    panel.style.display = "block";

    const getNotes = () => panel.querySelector(".ssct-sheet-notes").value;
    const reopenDraft = () => ({ niches: selNiches, ...sel, notes: getNotes() });

    const nicheWrap = panel.querySelector('[data-group="niche"]');
    nicheWrap.querySelectorAll("[data-niche]").forEach((b) => {
      b.onclick = () => {
        const n = b.dataset.niche;
        const i = selNiches.indexOf(n);
        if (i >= 0) selNiches.splice(i, 1);
        else selNiches.push(n);
        b.classList.toggle("on");
      };
    });
    nicheWrap.querySelector("[data-newniche]").onclick = () => {
      const name = (prompt("New niche name:") || "").trim();
      if (!name) return;
      if (!niches.includes(name)) {
        niches.push(name);
        chrome.storage.local.set({ niches });
      }
      if (!selNiches.includes(name)) selNiches.push(name);
      openSaveSheet(channel, reopenDraft());
    };

    // Compact label dropdowns: a row of buttons, each reveals its options inline below.
    const msdPanel = panel.querySelector(".msd-panel");
    const renderDimPanel = (field) => {
      const dim = SHEET_DIMS.find((d) => d.field === field);
      msdPanel.innerHTML =
        dimList(field).map((v) => `<button class="ssct-chip2${sel[field].includes(v) ? " on" : ""}" data-val="${esc(v)}">${esc(v)}</button>`).join("") +
        `<button class="ssct-chip2 new" data-newval>＋ New</button>`;
      const setCount = () => {
        const badge = panel.querySelector(`[data-cnt="${field}"]`);
        if (badge) badge.textContent = sel[field].length || "";
      };
      msdPanel.querySelectorAll("[data-val]").forEach((b) => {
        b.onclick = () => {
          const v = b.dataset.val;
          const i = sel[field].indexOf(v);
          if (i >= 0) sel[field].splice(i, 1);
          else sel[field].push(v);
          b.classList.toggle("on");
          setCount();
        };
      });
      msdPanel.querySelector("[data-newval]").onclick = () => {
        const name = (prompt(`New ${dim.label} option:`) || "").trim();
        if (!name) return;
        const arr = dimList(field);
        if (!arr.includes(name)) {
          arr.push(name);
          chrome.storage.local.set({ [field]: arr });
        }
        if (!sel[field].includes(name)) sel[field].push(name);
        renderDimPanel(field);
        setCount();
      };
    };
    panel.querySelectorAll(".msd-btn").forEach((btn) => {
      btn.onclick = () => {
        const active = btn.classList.contains("active");
        panel.querySelectorAll(".msd-btn").forEach((b) => b.classList.remove("active"));
        if (active) {
          msdPanel.classList.remove("open");
          msdPanel.innerHTML = "";
          return;
        }
        btn.classList.add("active");
        msdPanel.classList.add("open");
        renderDimPanel(btn.dataset.field);
      };
    });

    panel.querySelector(".ssct-sheet-save").onclick = () => saveChannelEntry(channel, selNiches, sel, getNotes());
    panel.querySelector(".ssct-sheet-cancel").onclick = () => renderQuick((lastQuick && lastQuick.video) || null, channel);
    const rm = panel.querySelector(".ssct-sheet-remove");
    if (rm)
      rm.onclick = () => {
        const i = watchlist.findIndex((w) => w.channelId === channel.channelId);
        if (i >= 0) {
          watchlist.splice(i, 1);
          saveWatchlist();
          updateWatchCount();
        }
        renderQuick((lastQuick && lastQuick.video) || null, channel);
      };
  }

  function saveChannelEntry(channel, nichesArr, labels, notes) {
    let e = watchlist.find((w) => w.channelId === channel.channelId);
    if (!e) {
      e = {
        channelId: channel.channelId,
        title: channel.title || "",
        totalViews: channel.totalViews,
        subscribers: channel.subscribers,
        videoCount: channel.videoCount,
        thumb: channel.thumb || "",
        customUrl: channel.customUrl || "",
        addedAt: Date.now(),
        refreshedAt: Date.now(),
        examples: [],
      };
      watchlist.push(e);
    }
    e.niches = nichesArr || [];
    e.tags = labels.tags || [];
    e.madeBy = labels.madeBy || [];
    e.madeFor = labels.madeFor || [];
    e.languages = labels.languages || [];
    e.notes = notes;
    saveWatchlist();
    updateWatchCount();
    renderQuick((lastQuick && lastQuick.video) || null, channel);
  }

  // Save a single short (with notes), independent of saving the channel.
  function openVideoSheet(video, channel) {
    if (!video || !video.videoId) return;
    const existing = savedVideos.find((v) => v.videoId === video.videoId);
    let selNiche = existing ? existing.niche : "";
    const notesVal = existing ? existing.notes : "";
    const nicheItems = [{ value: "", label: "Unsorted" }].concat(niches.map((n) => ({ value: n, label: n })));

    shell(`
      <div class="ssct-sheet">
        <div class="ssct-sheet-title">${existing ? "Edit saved short" : "Save this short"}</div>
        <div class="ssct-channel-name">${esc(video.title) || "Short"}</div>
        <div class="ssct-muted" style="font-size:12px;margin-bottom:8px">${esc(channel && channel.title) || ""} · ${compact(video.views)} views</div>
        <div class="ssct-label">Niche</div>
        <div class="ssct-chips2" data-group="niche">${chipRow(nicheItems, selNiche, "niche")}<button class="ssct-chip2 new" data-newniche>＋ New</button></div>
        <div class="ssct-label">Notes on this video</div>
        <textarea class="ssct-sheet-notes" placeholder="The hook, why it went viral, what to copy…">${esc(notesVal)}</textarea>
        <div class="ssct-sheet-btns">
          <button class="ssct-sheet-save">${existing ? "Update" : "🔖 Save short"}</button>
          ${existing ? '<button class="ssct-sheet-remove">Remove</button>' : ""}
          <button class="ssct-sheet-cancel">Cancel</button>
        </div>
      </div>`);
    panel.style.display = "block";

    const getNotes = () => panel.querySelector(".ssct-sheet-notes").value;
    const nicheWrap = panel.querySelector('[data-group="niche"]');
    nicheWrap.querySelectorAll("[data-niche]").forEach((b) => {
      b.onclick = () => {
        selNiche = b.dataset.niche;
        nicheWrap.querySelectorAll(".ssct-chip2").forEach((x) => x.classList.remove("on"));
        b.classList.add("on");
      };
    });
    nicheWrap.querySelector("[data-newniche]").onclick = () => {
      const name = (prompt("New niche name:") || "").trim();
      if (!name) return;
      if (!niches.includes(name)) {
        niches.push(name);
        chrome.storage.local.set({ niches });
      }
      selNiche = name;
      openVideoSheet({ ...video }, channel);
    };

    panel.querySelector(".ssct-sheet-save").onclick = () => {
      let v = savedVideos.find((x) => x.videoId === video.videoId);
      if (v) {
        v.niche = selNiche;
        v.notes = getNotes();
      } else {
        savedVideos.push({
          videoId: video.videoId,
          title: video.title || "",
          channelId: video.channelId || (channel && channel.channelId) || "",
          channelTitle: video.channelTitle || (channel && channel.title) || "",
          views: video.views || 0,
          thumb: `https://i.ytimg.com/vi/${video.videoId}/hqdefault.jpg`,
          niche: selNiche || "",
          notes: getNotes(),
          addedAt: Date.now(),
        });
      }
      chrome.storage.local.set({ savedVideos });
      renderQuick((lastQuick && lastQuick.video) || video, channel);
    };
    panel.querySelector(".ssct-sheet-cancel").onclick = () => renderQuick((lastQuick && lastQuick.video) || video, channel);
    const rm = panel.querySelector(".ssct-sheet-remove");
    if (rm)
      rm.onclick = () => {
        const i = savedVideos.findIndex((x) => x.videoId === video.videoId);
        if (i >= 0) {
          savedVideos.splice(i, 1);
          chrome.storage.local.set({ savedVideos });
        }
        renderQuick((lastQuick && lastQuick.video) || video, channel);
      };
  }

  function renderQuick(video, channel) {
    lastQuick = { video, channel };
    const channelUrl = `https://www.youtube.com/channel/${channel.channelId}`;
    shell(`
      ${heroHtml(video)}
      <div class="ssct-channel-name">${esc(channel.title) || "Channel"}</div>
      <div class="ssct-grid">
        ${statCell(compact(channel.totalViews), "channel views")}
        ${statCell(compact(channel.subscribers), "subscribers")}
        ${statCell(fmt(channel.videoCount), "videos")}
      </div>
      ${channelActionsHtml(channel)}
      <button class="ssct-savevid" type="button" data-act="savevid">${savedVideos.some((v) => v.videoId === (video && video.videoId)) ? "🔖 Short saved — edit" : "🔖 Save this short"}</button>
      <button class="ssct-scan" type="button" data-act="recent">📂 Show recent shorts</button>
    `);

    const recentBtn = panel.querySelector('[data-act="recent"]');
    if (recentBtn) recentBtn.onclick = () => showRecent(channel.channelId);
    const saveVid = panel.querySelector('[data-act="savevid"]');
    if (saveVid) saveVid.onclick = () => openVideoSheet(video, channel);
    wireChannelActions(channel);
    panel.style.display = "block";
  }

  // CHEAP recent-shorts view (no full scan).
  function showRecent(channelId) {
    const vidAtClick = currentVideoId();
    shell(`${heroHtml(lastQuick && lastQuick.video)}<div class="ssct-status">Loading recent shorts…</div>`);
    panel.style.display = "block";
    chrome.runtime.sendMessage({ type: "RECENT", channelId }, (resp) => {
      if (currentVideoId() !== vidAtClick) return; // moved on
      if (chrome.runtime.lastError || !resp) return renderError("Couldn't load recent shorts.");
      if (!resp.ok) return renderError(resp.error || "Unknown error");
      renderRecent(resp);
    });
  }

  function renderRecent(resp) {
    const channel = resp.channel;
    const upload = resp.upload;
    const recent = resp.recent || [];
    const video = lastQuick && lastQuick.video;
    const channelUrl = `https://www.youtube.com/channel/${channel.channelId}`;
    const topRecent = recent.reduce((m, r) => Math.max(m, r.views || 0), 0);

    shell(`
      ${heroHtml(video)}
      <div class="ssct-channel-name">${esc(channel.title) || "Channel"}</div>
      <div class="ssct-grid">
        ${statCell(compact(channel.totalViews), "channel views")}
        ${statCell(compact(channel.subscribers), "subscribers")}
        ${statCell(fmt(channel.videoCount), "videos")}
        ${statCell(relTime(upload && upload.lastUpload), "last upload")}
        ${statCell(cadenceText(upload), "upload rate")}
        ${statCell(topRecent ? compact(topRecent) : "—", "top recent")}
      </div>
      ${channelActionsHtml(channel)}
      ${recentGrid(recent, channel.channelId)}
      <button class="ssct-count" type="button" data-act="count">Count videos over 1M / 10M ▸</button>
      <a class="ssct-link" href="${channelUrl}" target="_blank" rel="noopener">Open channel ↗</a>
    `);

    wireChannelActions(channel);
    wireLinks();
    const count = panel.querySelector('[data-act="count"]');
    if (count) count.onclick = () => analyze();
    panel.style.display = "block";
  }

  // ---- error / loading -------------------------------------------------------

  function renderError(message) {
    if (message === "NO_API_KEY") {
      shell(`
        <p class="ssct-warn">No API key set.</p>
        <p class="ssct-muted">Click the Shorts Scout toolbar icon, paste your free
        YouTube Data API key, and Save — then try again.</p>`);
    } else {
      shell(`<p class="ssct-warn">${message}</p>`);
    }
    panel.style.display = "block";
  }

  function renderLoading() {
    shell(`${heroHtml(lastVideo)}<div class="ssct-status">Scanning channel…</div>`);
    panel.style.display = "block";
  }

  function renderProgress(progress) {
    const status = panel.querySelector(".ssct-status");
    if (!status) return;
    const pct = progress.total
      ? Math.min(100, Math.round((progress.scanned / progress.total) * 100))
      : 0;
    status.innerHTML = `Scanning channel… ${fmt(progress.scanned)}${
      progress.total ? " / " + fmt(progress.total) : ""
    } <span class="ssct-pct">${pct}%</span>`;
  }

  // ---- recent shorts grid ----------------------------------------------------

  function recentGrid(recent, channelId) {
    const all = recent || [];
    const shorts = all.filter((r) => r.isShort);
    const list = (shorts.length >= 4 ? shorts : all).slice(0, 8);
    if (!list.length) return "";

    const shortsTab = `https://www.youtube.com/channel/${channelId}/shorts`;
    const cells = list
      .map((r) => {
        const url = `https://www.youtube.com/shorts/${r.videoId}`;
        return `
        <a class="ssct-vid" href="${url}" data-url="${url}" title="${esc(r.title)}">
          <span class="ssct-thumb" style="background-image:url('${esc(r.thumb)}')">
            <span class="ssct-vviews">${compact(r.views)} views</span>
          </span>
          <span class="ssct-vtitle">${esc(r.title)}</span>
          <span class="ssct-vago">${preciseAgo(r.publishedAt)}</span>
        </a>`;
      })
      .join("");

    return `
      <div class="ssct-section-row">
        <span class="ssct-section-label">Recent shorts</span>
        <a class="ssct-shortstab" href="${shortsTab}" data-url="${shortsTab}">Open tab ↗</a>
      </div>
      <div class="ssct-vids">${cells}</div>`;
  }

  function wireLinks() {
    panel.querySelectorAll(".ssct-vid, .ssct-shortstab").forEach((a) => {
      a.addEventListener("click", (e) => {
        e.preventDefault();
        openTab(a.dataset.url);
      });
    });
  }

  // ---- BIG state (deep scan result) -----------------------------------------

  function renderResult(data) {
    const { video, channel, tiers, scanned, capped, upload, highest, recent } = data;

    const chips = tiers
      .map(
        (t) => `
        <div class="ssct-chip">
          <b>${fmt(t.count)}</b>
          <span>over ${compact(t.threshold)}</span>
        </div>`
      )
      .join("");

    const cappedNote = capped
      ? `<p class="ssct-muted ssct-note">Stopped at ${fmt(
          scanned
        )} videos (very large channel).</p>`
      : "";

    shell(`
      ${heroHtml(video)}

      <div class="ssct-chips">${chips}</div>

      <div class="ssct-channel-name">${esc(channel.title) || "Channel"}</div>
      <div class="ssct-grid">
        ${statCell(compact(channel.totalViews), "channel views")}
        ${statCell(compact(channel.subscribers), "subscribers")}
        ${statCell(fmt(channel.videoCount), "videos")}
        ${statCell(relTime(upload && upload.lastUpload), "last upload")}
        ${statCell(cadenceText(upload), "upload rate")}
        ${statCell(highest && highest.views ? compact(highest.views) : "—", "top video")}
      </div>

      ${recentGrid(recent, channel.channelId)}

      ${cappedNote}
      <a class="ssct-link" href="https://www.youtube.com/channel/${
        channel.channelId
      }" target="_blank" rel="noopener">Open channel ↗</a>
    `);
    wireLinks();
    panel.style.display = "block";
  }

  // ---- actions ---------------------------------------------------------------

  // MEDIUM: cheap auto fetch (short views + channel basics).
  let quickTimer = null;
  let quickReqId = 0;

  function scheduleQuick() {
    clearTimeout(quickTimer);
    if (!autoShow || collapsed) {
      panel.style.display = "none";
      return;
    }
    const vid = currentVideoId();
    if (!vid) return;
    panel.style.display = "none"; // hide until data is ready (no flicker)
    quickTimer = setTimeout(() => runQuick(vid), 700); // debounce
  }

  function runQuick(vid) {
    const id = ++quickReqId;
    try {
      chrome.runtime.sendMessage({ type: "QUICK", videoId: vid }, (resp) => {
        if (id !== quickReqId) return; // user moved to another short
        if (chrome.runtime.lastError) {
          // Almost always: the extension was reloaded but this page wasn't.
          renderError("Shorts Scout was updated — please refresh this page (⌘R).");
          return;
        }
        if (!resp) {
          renderError("No response from the extension background.");
          return;
        }
        if (!resp.ok) {
          renderError(resp.error || "Couldn't load stats.");
          return;
        }
        renderQuick(resp.video, resp.channel);
      });
    } catch (e) {
      renderError("Shorts Scout was updated — please refresh this page (⌘R).");
    }
  }

  // BIG: full deep scan (only when the user opts in via "Count over 1M/10M").
  function analyze() {
    const videoId = currentVideoId();
    if (!videoId) return;

    lastVideo = (lastQuick && lastQuick.video) || null;
    renderLoading();

    const requestId = ++requestCounter;
    activeRequestId = requestId;

    chrome.runtime.sendMessage({ type: "ANALYZE", videoId, requestId }, (resp) => {
      if (activeRequestId !== requestId) return;
      if (chrome.runtime.lastError) return renderError(chrome.runtime.lastError.message);
      if (!resp) return renderError("No response from extension background.");
      if (!resp.ok) return renderError(resp.error || "Unknown error");
      renderResult(resp);
    });
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.requestId !== activeRequestId) return;
    if (msg.type === "VIDEO_READY") {
      lastVideo = msg.video;
      renderLoading();
    } else if (msg.type === "SCAN_PROGRESS") {
      renderProgress(msg.progress);
    }
  });

  // Dock button reopens the panel (and clears the collapsed state so it resumes auto-showing).
  btn.addEventListener("click", () => {
    const vid = currentVideoId();
    if (!vid) return;
    if (collapsed) {
      collapsed = false;
      chrome.storage.local.set({ panelCollapsed: false });
    }
    if (lastQuick) renderQuick(lastQuick.video, lastQuick.channel);
    else runQuick(vid);
  });

  // ---- settings --------------------------------------------------------------

  chrome.storage.sync.get(["autoShow"], (data) => {
    autoShow = data.autoShow !== false; // default ON
    syncVisibility();
    scheduleQuick();
  });
  chrome.storage.local.get(["watchlist", "niches", "savedVideos", "panelCollapsed", "tags", "madeBy", "madeFor", "languages"], (data) => {
    watchlist = data.watchlist || [];
    niches = data.niches || [];
    savedVideos = data.savedVideos || [];
    collapsed = !!data.panelCollapsed;
    tags = data.tags && data.tags.length ? data.tags : DEFAULT_TAGS.slice();
    madeBy = data.madeBy && data.madeBy.length ? data.madeBy : DEFAULT_MADE_BY.slice();
    madeFor = data.madeFor && data.madeFor.length ? data.madeFor : DEFAULT_MADE_FOR.slice();
    languages = data.languages && data.languages.length ? data.languages : DEFAULT_LANGUAGES.slice();
    updateWatchCount();
    syncVisibility();
    scheduleQuick();
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "sync" && changes.autoShow) {
      autoShow = changes.autoShow.newValue !== false;
      syncVisibility();
      scheduleQuick();
    }
    if (area === "local" && changes.watchlist) {
      watchlist = changes.watchlist.newValue || [];
      updateWatchCount();
    }
    if (area === "local" && changes.niches) niches = changes.niches.newValue || [];
    if (area === "local" && changes.tags) tags = changes.tags.newValue || [];
    if (area === "local" && changes.madeBy) madeBy = changes.madeBy.newValue || [];
    if (area === "local" && changes.madeFor) madeFor = changes.madeFor.newValue || [];
    if (area === "local" && changes.languages) languages = changes.languages.newValue || [];
    if (area === "local" && changes.savedVideos) savedVideos = changes.savedVideos.newValue || [];
    if (area === "local" && changes.panelCollapsed) {
      collapsed = !!changes.panelCollapsed.newValue;
      if (collapsed) panel.style.display = "none";
    }
  });

  // ---- SPA + layout tracking -------------------------------------------------
  mount();
  syncVisibility();
  scheduleQuick();

  let lastPath = location.pathname;
  setInterval(() => {
    if (location.pathname !== lastPath) {
      lastPath = location.pathname;
      activeRequestId = null;
      lastQuick = null; // stats belong to the previous short
      mount();
      syncVisibility();
      scheduleQuick();
    } else {
      positionDock();
    }
  }, 500);

  window.addEventListener("resize", positionDock);
  window.addEventListener("scroll", positionDock, true);
})();
