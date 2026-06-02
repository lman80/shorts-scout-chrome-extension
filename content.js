// content.js — runs on youtube.com.
// Default (auto) state: a medium card with the short's views + channel basics (cheap).
// Click "load": expands to the full card with 1M/10M milestones + recent shorts (deep scan).

(function () {
  let requestCounter = 0;
  let activeRequestId = null;
  let lastVideo = null;
  let lastQuick = null; // { video, channel } from the cheap auto fetch
  let autoShow = true; // toggled from settings

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

  function openTab(url) {
    chrome.runtime.sendMessage({ type: "OPEN_TAB", url });
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

  function wireClose() {
    const c = panel.querySelector(".ssct-close");
    if (c) c.onclick = () => (panel.style.display = "none");
  }

  function shell(inner) {
    panel.innerHTML = `
      <div class="ssct-head">
        <span class="ssct-title">Shorts Scout</span>
        <button class="ssct-close" type="button" aria-label="Close">✕</button>
      </div>
      <div class="ssct-body">${inner}</div>`;
    wireClose();
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

  // Wire the Copy / Open channel buttons (shared by medium + recent views).
  function wireChannelActions(channelUrl) {
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
  }

  function channelActionsHtml() {
    return `
      <div class="ssct-actions">
        <button class="ssct-act" type="button" data-act="copy">📋 Copy channel URL</button>
        <button class="ssct-act" type="button" data-act="open">↗ Open channel</button>
      </div>`;
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
      ${channelActionsHtml()}
      <button class="ssct-scan" type="button" data-act="recent">📂 Show recent shorts</button>
    `);

    const recentBtn = panel.querySelector('[data-act="recent"]');
    if (recentBtn) recentBtn.onclick = () => showRecent(channel.channelId);
    wireChannelActions(channelUrl);
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
      ${channelActionsHtml()}
      ${recentGrid(recent, channel.channelId)}
      <button class="ssct-count" type="button" data-act="count">Count videos over 1M / 10M ▸</button>
      <a class="ssct-link" href="${channelUrl}" target="_blank" rel="noopener">Open channel ↗</a>
    `);

    wireChannelActions(channelUrl);
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
    if (!autoShow) {
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

  // Dock button reopens / refreshes the medium card (cheap), e.g. after closing it.
  btn.addEventListener("click", () => {
    const vid = currentVideoId();
    if (!vid) return;
    if (lastQuick) renderQuick(lastQuick.video, lastQuick.channel);
    else runQuick(vid);
  });

  // ---- settings --------------------------------------------------------------

  chrome.storage.sync.get(["autoShow"], (data) => {
    autoShow = data.autoShow !== false; // default ON
    syncVisibility();
    scheduleQuick();
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "sync" && changes.autoShow) {
      autoShow = changes.autoShow.newValue !== false;
      syncVisibility();
      scheduleQuick();
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
