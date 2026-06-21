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
  let nicheParents = {}; // child niche -> parent niche, mirrored from storage
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

  // ViewStats' most-viewed Shorts for the latest full day ("top short today").
  const TOP_SHORT_TODAY_URL =
    "https://www.viewstats.com/top-list?filterBy=views&interval=ms_yesterday&madeForKids=true&movies=true&musicChannels=true&tab=videos&videoType=shorts";

  function wireHeader() {
    const c = panel.querySelector(".ssct-close");
    if (c) c.onclick = collapsePanel;
    const w = panel.querySelector(".ssct-watch-open");
    if (w) w.onclick = () => renderWatchlist();
    const t = panel.querySelector(".ssct-topshort");
    if (t) t.onclick = () => openTab(TOP_SHORT_TODAY_URL);
  }

  function shell(inner) {
    panel.innerHTML = `
      <div class="ssct-head">
        <span class="ssct-title">Shorts Scout</span>
        <div class="ssct-head-right">
          <button class="ssct-topshort" type="button" title="Open ViewStats: most-viewed Shorts today">🔥 Top short today</button>
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
    let selTop = d.top !== undefined ? d.top : existing ? !!existing.topCandidate : false;

    // Selected values per dimension.
    const sel = {};
    SHEET_DIMS.forEach((dim) => {
      let init = d[dim.field] !== undefined ? d[dim.field] : existing ? existing[dim.field] : undefined;
      if (dim.field === "tags" && !init && existing && existing.status) init = [existing.status];
      sel[dim.field] = (init || []).slice();
    });

    const dimBtns = SHEET_DIMS.map(
      (dim) => `<button class="msd-btn" type="button" data-field="${dim.field}">${dim.label}<span class="msd-count" data-cnt="${dim.field}">${sel[dim.field].length || ""}</span><span class="msd-caret">▾</span></button>`
    ).join("");

    shell(`
      <div class="ssct-sheet">
        <div class="ssct-sheet-title">${existing ? "Edit saved channel" : "Save channel"}</div>
        <div class="ssct-channel-name">${esc(channel.title) || "Channel"}</div>
        <button class="ssct-topcand${selTop ? " on" : ""}" type="button" data-act="top">${selTop ? "★ Top candidate" : "☆ Mark as top candidate"}</button>
        <div class="ssct-label">Niches <span style="text-transform:none;letter-spacing:0;color:#777">— tap a main niche to open its sub-niches</span></div>
        <div class="ssct-chips2" data-group="niche"></div>
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
    const reopenDraft = () => ({ niches: selNiches, ...sel, notes: getNotes(), top: selTop });

    const topBtn = panel.querySelector('[data-act="top"]');
    topBtn.onclick = () => {
      selTop = !selTop;
      topBtn.classList.toggle("on", selTop);
      topBtn.textContent = selTop ? "★ Top candidate" : "☆ Mark as top candidate";
    };

    // Niches grouped by main niche → sub-niches, alphabetical. Tap a main niche
    // to drop down its sub-niches; tap any to (de)select.
    const nicheWrap = panel.querySelector('[data-group="niche"]');
    const nicheExpanded = new Set();
    const subNichesOf = (parent) => niches.filter((n) => nicheParents[n] === parent).sort((a, b) => a.localeCompare(b));
    function renderNiches() {
      const parentVals = Object.values(nicheParents).filter(Boolean);
      const topLevel = Array.from(new Set(niches.filter((n) => !nicheParents[n]).concat(parentVals)))
        .sort((a, b) => a.localeCompare(b));
      const html = topLevel.map((n) => {
        const kids = subNichesOf(n);
        if (!kids.length) {
          return `<button class="ssct-chip2${selNiches.includes(n) ? " on" : ""}" data-niche="${esc(n)}">${esc(n)}</button>`;
        }
        const members = [n].concat(kids);
        const cnt = members.filter((m) => selNiches.includes(m)).length;
        const open = nicheExpanded.has(n);
        const subs = members.map((m) => `<button class="ssct-chip2 sub${selNiches.includes(m) ? " on" : ""}" data-niche="${esc(m)}">${esc(m === n ? m + " · all" : m)}</button>`).join("");
        return `<div class="ssct-nichegrp${open ? " open" : ""}">` +
          `<button class="ssct-chip2 parent${cnt ? " has" : ""}" data-parent="${esc(n)}">${esc(n)} <span class="ssct-caret">▾</span>${cnt ? `<span class="ssct-cnt">${cnt}</span>` : ""}</button>` +
          `<div class="ssct-subniches"${open ? "" : " hidden"}>${subs}</div></div>`;
      }).join("");
      nicheWrap.innerHTML = html + `<button class="ssct-chip2 new" data-newniche>＋ New</button>`;
      nicheWrap.querySelectorAll("[data-parent]").forEach((b) => {
        b.onclick = () => { const p = b.dataset.parent; nicheExpanded.has(p) ? nicheExpanded.delete(p) : nicheExpanded.add(p); renderNiches(); };
      });
      nicheWrap.querySelectorAll("[data-niche]").forEach((b) => {
        b.onclick = () => { const n = b.dataset.niche; const i = selNiches.indexOf(n); if (i >= 0) selNiches.splice(i, 1); else selNiches.push(n); renderNiches(); };
      });
      nicheWrap.querySelector("[data-newniche]").onclick = () => {
        const name = (prompt("New niche name:") || "").trim();
        if (!name) return;
        if (!niches.includes(name)) { niches.push(name); chrome.storage.local.set({ niches }); }
        if (!selNiches.includes(name)) selNiches.push(name);
        renderNiches();
      };
    }
    renderNiches();

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

    panel.querySelector(".ssct-sheet-save").onclick = () => saveChannelEntry(channel, selNiches, sel, getNotes(), selTop);
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

  function saveChannelEntry(channel, nichesArr, labels, notes, topCand) {
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
    e.topCandidate = !!topCand;
    e.notes = notes;
    // Default the channel's representative short to whatever the user is watching now.
    if (!e.repVideoId) {
      const cur = (lastQuick && lastQuick.video && lastQuick.video.videoId) || currentVideoId() || "";
      if (cur) e.repVideoId = cur;
    }
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
  chrome.storage.local.get(["watchlist", "niches", "nicheParents", "savedVideos", "panelCollapsed", "tags", "madeBy", "madeFor", "languages"], (data) => {
    watchlist = data.watchlist || [];
    niches = data.niches || [];
    nicheParents = data.nicheParents || {};
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
    if (area === "local" && changes.nicheParents) nicheParents = changes.nicheParents.newValue || {};
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

  // ---- vidIQ stats capture --------------------------------------------------
  // Reads the numbers vidIQ paints onto channel pages — "Views gained (7 days)"
  // and the 30-day chart value — and saves them per channel so the board can show
  // real recent-views data. In normal browsing vqTick reads them passively; in
  // scan mode (#ssscan, opened by the board) we actively open vidIQ's "View
  // channel stats" popup and read both. Best-effort; silent when vidIQ is absent.
  const VQ_SCAN = location.hash.indexOf("ssscan") >= 0;
  const vqSaved = {}; // channelId -> last-saved {v7, v30}
  let vqLastModal = { id: null, t: 0 };

  // Tolerant number parse: "+6.8M"->6800000, "20K"->20000, "1,234"->1234,
  // "-6.8M"->-6800000. Handles commas, decimals, K/M/B, +/-, nbsp, unicode minus.
  function vqNum(s) {
    if (s == null) return null;
    s = String(s).replace(/[   ]/g, " ").replace(/−/g, "-").trim();
    const m = /(-?[\d.,]+)\s*([KkMmBb])?/.exec(s);
    if (!m) return null;
    let n = parseFloat(m[1].replace(/,/g, ""));
    if (!isFinite(n)) return null;
    const u = (m[2] || "").toUpperCase();
    if (u === "K") n *= 1e3; else if (u === "M") n *= 1e6; else if (u === "B") n *= 1e9;
    return Math.round(n);
  }

  // Collect text from a subtree INCLUDING open shadow roots + same-origin iframes,
  // so we can see vidIQ's popup even when it renders inside a shadow root.
  function vqWalkText(root) {
    let out = "";
    const seen = new Set();
    const walk = (node) => {
      if (!node || seen.has(node)) return;
      const ty = node.nodeType;
      if (ty === 3) { out += node.nodeValue + " "; return; }
      if (ty !== 1 && ty !== 9 && ty !== 11) return;
      seen.add(node);
      if (node.shadowRoot) walk(node.shadowRoot);
      if (node.tagName === "IFRAME") { try { const d = node.contentDocument; if (d && d.body) walk(d.body); } catch (e) {} }
      const kids = node.childNodes || [];
      for (let i = 0; i < kids.length; i++) walk(kids[i]);
    };
    walk(root);
    return out;
  }
  // Cheaper read for passive browsing: only walk vidIQ's own containers.
  function vqScopedText() {
    const roots = document.querySelectorAll('.vidiq-scope, [class*="vidiq"], [id*="vidiq"]');
    if (!roots.length) return "";
    let out = "";
    for (const r of roots) out += vqWalkText(r) + " ";
    return out;
  }
  // ---- vidIQ "Channel stats" popup ------------------------------------------
  // vidIQ renders in the LIGHT DOM under elements whose class contains "vidiq".
  // The popup has 3 sections in order — "Views gained", "Subscribers gained",
  // "Videos published" — each with its OWN 7D/30D/3M/6M/1Y range toggles and a
  // single accent-coloured "+N" value reflecting the selected range. There are
  // NO "(7 days)"/"(30 days)" labels and no "Total views". So we drive the real
  // toggles: because Views-gained renders FIRST, the first toggle and the first
  // accent number in the popup are its own — no fragile container climbing, and
  // a native scoped query (not a whole-page walk, which froze the scan tab).
  const VQ_NUM_RE = /^[+\-−]?[\d.,]+\s*[KkMmBb]?$/;
  function vqLeaf(label) {
    for (const e of document.querySelectorAll('[class*="vidiq" i] *')) {
      if (e.children.length === 0 && (e.textContent || "").trim() === label) return e;
    }
    return null;
  }
  function vqClickLabel(label) {
    const el = vqLeaf(label);
    if (!el) return false;
    (el.closest("button,[role=button],[role=tab],a,[tabindex],[class*='cursor-pointer']") || el).click();
    return true;
  }
  function vqOpenStats() { return vqClickLabel("View channel stats"); }
  function vqClickTF(label) { return vqClickLabel(label); } // first 7D/30D = Views-gained's
  // First accent-styled number in the popup = the Views-gained value.
  function vqValue() {
    const e = [...document.querySelectorAll('[class*="vidiq" i] [class*="text-accent" i]')].find((x) => VQ_NUM_RE.test((x.textContent || "").trim()));
    return e ? vqNum(e.textContent) : null;
  }
  // The popup is open once its range toggles are present.
  function vqPopupOpen() { return !!vqLeaf("7D") && !!vqLeaf("30D"); }

  function vqChannelId() {
    const meta = document.querySelector('meta[itemprop="identifier"], meta[itemprop="channelId"]');
    if (meta && /^UC[\w-]{20,}$/.test(meta.content || "")) return meta.content;
    const canon = document.querySelector('link[rel="canonical"]');
    const m = canon && /\/channel\/(UC[\w-]{20,})/.exec(canon.href || "");
    return m ? m[1] : null;
  }
  // Passive-only: the inline "Quick channel stats" panel's "Views gained (7 days) +N".
  function vq7Inline(text) {
    const m = /Views gained\s*\(7\s*days?\)[\s\S]{0,40}?([+\-−]?\s*[\d.,]+\s*[KkMmBb]?)/i.exec(text);
    return m ? vqNum(m[1]) : null;
  }
  function vqMaybeSave(id, patch) {
    const prev = vqSaved[id] || {};
    let changed = false;
    for (const k in patch) if (patch[k] != null && prev[k] !== patch[k]) changed = true;
    if (!changed) return;
    vqSaved[id] = Object.assign({}, prev, patch);
    chrome.storage.local.get(["vidiqStats"], (d) => {
      const map = d.vidiqStats || {};
      map[id] = Object.assign({}, map[id], patch, { t: Date.now() });
      chrome.storage.local.set({ vidiqStats: map });
    });
  }
  // Append a permanent history point (kept per channel) so trends survive forever.
  function vqAppendHistory(id) {
    chrome.storage.local.get(["vidiqStats", "vidiqHistory"], (d) => {
      const st = (d.vidiqStats || {})[id];
      if (!st || (st.v7 == null && st.v30 == null)) return;
      const hist = d.vidiqHistory || {};
      const arr = hist[id] || [];
      const now = Date.now();
      const point = { t: now, v7: st.v7 != null ? st.v7 : null, v30: st.v30 != null ? st.v30 : null };
      const last = arr[arr.length - 1];
      if (last && now - last.t < 12 * 3600e3) arr[arr.length - 1] = point; // same day → replace
      else arr.push(point);
      hist[id] = arr.slice(-80);
      chrome.storage.local.set({ vidiqHistory: hist });
    });
  }
  // Passive capture while you browse a channel (NOT in scan tabs). Best-effort,
  // read-only: grabs the inline 7-day stat if vidIQ's quick panel shows it. The
  // 30-day needs the popup's range toggles, which the scan path drives.
  function vqTick() {
    const id = vqChannelId();
    if (!id) return;
    const v7 = vq7Inline(vqScopedText());
    if (v7 != null) vqMaybeSave(id, { v7 });
  }
  if (!VQ_SCAN) setInterval(vqTick, 1500);

  // Scan mode: the board opens the channel in a hidden tab with #ssscan. We open
  // vidIQ's "View channel stats" popup ONCE, then — in its "Views gained" section
  // — click 7D and read the value, then click 30D and read the value, exactly how
  // a person would. Each value is captured once it CHANGES from the prior range
  // (so we never store the wrong timeframe), with a settle-timeout fallback.
  if (VQ_SCAN) {
    const startedAt = Date.now();
    let got7 = false, got30 = false, clickedOpen = false, done = false;
    let phase = "open", tStep = 0, clickTries = 0, missTicks = 0, base = null;
    function finishScan(reason) {
      if (done) return; done = true;
      clearInterval(iv);
      const id = vqChannelId();
      if (id && (got7 || got30)) vqAppendHistory(id);
      try { console.log("[Shorts Scout] scan", id, "v7:" + got7, "v30:" + got30, "(" + (reason || "") + ") " + Math.round((Date.now() - startedAt) / 1000) + "s"); } catch (e) {}
      chrome.runtime.sendMessage({ type: "SS_SCAN_DONE", channelId: id, got7: got7, got30: got30 });
    }
    const iv = setInterval(() => {
      if (done) return;
      const id = vqChannelId();
      const el = Date.now() - startedAt;
      if (!id) { if (el > 32000) finishScan("no-channel"); return; }
      const open = vqPopupOpen();

      if (phase === "open") {
        if (open) { phase = "click7"; return; }                 // popup is open
        if (el > 26000) return finishScan(clickedOpen ? "no-paint" : "no-button");
        if (!clickedOpen) { if (vqOpenStats()) clickedOpen = true; } // open it once
        return;
      }
      if (!open) {                                              // popup vanished after opening
        if (++missTicks > 25) return finishScan(got7 || got30 ? "partial" : "lost-popup");
        return;
      }
      missTicks = 0;

      if (phase === "click7") {
        base = vqValue();                                       // value before selecting 7D
        if (vqClickTF("7D")) { tStep = el; clickTries = 0; phase = "read7"; }
        else if (++clickTries > 6) { clickTries = 0; phase = "click30"; } // no 7D button → skip
        return;
      }
      if (phase === "read7") {
        const v = vqValue();
        if (v != null && (v !== base || el - tStep > 2500)) { got7 = true; vqMaybeSave(id, { v7: v }); base = v; phase = "click30"; }
        else if (el - tStep > 4500) { base = v; phase = "click30"; } // unreadable → move on
        return;
      }
      if (phase === "click30") {
        if (vqClickTF("30D")) { tStep = el; clickTries = 0; phase = "read30"; }
        else if (++clickTries > 6) { clickTries = 0; phase = "done"; } // no 30D button → done
        return;
      }
      if (phase === "read30") {
        const v = vqValue();
        if (v != null && (v !== base || el - tStep > 2500)) { got30 = true; vqMaybeSave(id, { v30: v }); phase = "done"; }
        else if (el - tStep > 4500) phase = "done";
        return;
      }

      if (phase === "done" || (got7 && got30)) return finishScan("ok");
      if (el > 32000) return finishScan(got7 || got30 ? "partial" : "timeout");
    }, 300);
  }

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
