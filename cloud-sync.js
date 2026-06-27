/* cloud-sync.js — keeps the extension's board in sync with the website.
 *
 * MULTI-BOARD: there is one shared "Team" board (Firestore doc boards/shared) plus
 * a personal board per user (boards/<id>). The active board is chosen per-device
 * (chrome.storage.local key `activeBoard`, default "shared") and is NEVER written
 * into a board document. The list of boards ("users") lives in a small registry
 * doc boards/__index__ so every teammate sees the same switcher.
 *
 * Both the extension and the website read & write these docs in OPEN mode — no
 * sign-in. This runs in the background service worker:
 *   - local edit (save a channel, edit niches, etc.) -> pushed up to the ACTIVE board
 *   - cloud changed (edited on the website / another device) -> pulled down
 *   - switch board -> flush the current board, then load the chosen board into local
 *
 * Strategy: last-write-wins, keyed by a millisecond `_rev` stamp. A periodic alarm
 * pulls every minute; opening the board triggers an immediate pull. The YouTube API
 * key and notebook images are NOT synced (kept per-device).
 */
(function () {
  var PROJECT = "shorts-scout-d6c36";
  // Firebase web API key — not secret (Firestore access is governed by rules).
  var KEY = "AIzaSyA9_wvXRVPqTaTVJN-CvPbfeSEyROodALY";
  var BASE = "https://firestore.googleapis.com/v1/projects/" + PROJECT +
             "/databases/(default)/documents/boards/";
  function docUrl(id) { return BASE + encodeURIComponent(id); }
  var REG_ID = "registry"; // registry doc listing all boards (users). NOTE: ids like
                            // __index__ are RESERVED in Firestore and 400 — keep this plain.

  // Keys that mirror between extension <-> website. Must match cloud-app.js.
  // (activeBoard + boardProfiles are NOT here — they are not part of a board.)
  var SYNC_KEYS = ["watchlist", "niches", "nicheParents", "tags", "madeBy",
                   "madeFor", "languages", "savedVideos", "snapshots", "notebookMd",
                   "vidiqStats", "vidiqHistory", "topOrder", "mediaItems", "productions"];

  function emptyFor(k) {
    if (k === "nicheParents" || k === "vidiqStats" || k === "vidiqHistory") return {};
    if (k === "notebookMd") return "";
    return [];
  }

  var suppressPushUntil = 0;   // ignore storage events we caused by pulling
  var pushTimer = null;
  var switching = false;       // don't push/pull a board mid-switch

  // ---- Firestore value <-> JS conversion -----------------------------------
  function enc(v) {
    if (v === null || v === undefined) return { nullValue: null };
    if (typeof v === "boolean") return { booleanValue: v };
    if (typeof v === "number")
      return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
    if (typeof v === "string") return { stringValue: v };
    if (Array.isArray(v)) return { arrayValue: { values: v.map(enc) } };
    if (typeof v === "object") {
      var fields = {};
      for (var k in v) if (Object.prototype.hasOwnProperty.call(v, k)) fields[k] = enc(v[k]);
      return { mapValue: { fields: fields } };
    }
    return { stringValue: String(v) };
  }
  function dec(val) {
    if (!val) return null;
    if ("nullValue" in val) return null;
    if ("booleanValue" in val) return val.booleanValue;
    if ("integerValue" in val) return parseInt(val.integerValue, 10);
    if ("doubleValue" in val) return val.doubleValue;
    if ("stringValue" in val) return val.stringValue;
    if ("timestampValue" in val) return val.timestampValue;
    if ("arrayValue" in val) return (val.arrayValue.values || []).map(dec);
    if ("mapValue" in val) {
      var o = {}, f = val.mapValue.fields || {};
      for (var k in f) o[k] = dec(f[k]);
      return o;
    }
    return null;
  }

  // ---- local storage helpers -----------------------------------------------
  function localGet(keys) {
    return new Promise(function (resolve) { chrome.storage.local.get(keys, resolve); });
  }
  function localSet(obj) {
    return new Promise(function (resolve) { chrome.storage.local.set(obj, resolve); });
  }
  function getActive() {
    return localGet(["activeBoard"]).then(function (d) { return d.activeBoard || "shared"; });
  }

  // ---- cloud read/write ----------------------------------------------------
  function fetchDoc(id) {
    return fetch(docUrl(id) + "?key=" + KEY).then(function (res) {
      if (res.status === 404) return { rev: 0, fields: {} }; // doc not created yet
      if (!res.ok) throw new Error("pull " + res.status);
      return res.json().then(function (j) {
        var f = j.fields || {};
        return { rev: f._rev ? dec(f._rev) : 0, fields: f };
      });
    });
  }

  function pushNow() {
    if (switching) return Promise.resolve();
    return getActive().then(function (active) {
      return localGet(SYNC_KEYS).then(function (d) {
        var mask = [], fields = {};
        SYNC_KEYS.forEach(function (k) { if (d[k] !== undefined) { fields[k] = enc(d[k]); mask.push(k); } });
        var rev = Date.now();
        fields._rev = enc(rev); mask.push("_rev");
        var q = mask.map(function (k) { return "updateMask.fieldPaths=" + encodeURIComponent(k); }).join("&");
        return fetch(docUrl(active) + "?key=" + KEY + "&" + q, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ fields: fields })
        }).then(function (res) {
          if (!res.ok) throw new Error("push " + res.status);
          return localSet({ _cloudRev: rev });
        });
      });
    }).catch(function (e) { console.warn("[cloud-sync] push failed", e); });
  }

  // Overlay a remote board's fields onto local (used by same-board pulls).
  function applyRemote(remote) {
    var obj = {};
    SYNC_KEYS.forEach(function (k) { if (remote.fields[k] !== undefined) obj[k] = dec(remote.fields[k]); });
    obj._cloudRev = remote.rev;
    suppressPushUntil = Date.now() + 4000; // don't echo the storage writes back up
    return localSet(obj);
  }

  // Replace local entirely with a board (used when SWITCHING). Resets every key
  // first so nothing bleeds across boards, then overlays the target's fields.
  function loadBoardIntoLocal(remote) {
    var obj = {};
    SYNC_KEYS.forEach(function (k) { obj[k] = (remote.fields[k] !== undefined) ? dec(remote.fields[k]) : emptyFor(k); });
    obj._cloudRev = remote.rev || 0;
    suppressPushUntil = Date.now() + 4000;
    return localSet(obj);
  }

  // Reconcile local <-> cloud for the ACTIVE board. Safety rule: never overwrite a
  // non-empty board with an empty one — seed from whichever side has channels.
  function sync() {
    if (switching) return Promise.resolve();
    return getActive().then(function (active) {
      return Promise.all([fetchDoc(active), localGet(SYNC_KEYS.concat(["_cloudRev"]))])
        .then(function (r) {
          var remote = r[0], local = r[1];
          var localRev = local._cloudRev || 0;
          var localHasData = (local.watchlist && local.watchlist.length) ||
                             (local.savedVideos && local.savedVideos.length);
          var remoteWL = remote.fields.watchlist ? dec(remote.fields.watchlist) : [];
          var remoteSV = remote.fields.savedVideos ? dec(remote.fields.savedVideos) : [];
          var remoteHasData = (Array.isArray(remoteWL) && remoteWL.length) ||
                              (Array.isArray(remoteSV) && remoteSV.length);

          if (remote.rev > localRev && remoteHasData) return applyRemote(remote);   // cloud newer & real -> pull
          if (localHasData && !remoteHasData) return pushNow();                      // we have data, cloud empty -> seed
          if (remote.rev > localRev && !localHasData) return applyRemote(remote);    // we're empty, cloud has newer -> pull
          // otherwise: in sync, or both empty -> nothing to do
        });
    }).then(syncRegistry).catch(function (e) { console.warn("[cloud-sync] sync failed", e); });
  }

  // ---- board registry (the list of users/boards) ---------------------------
  function fetchRegistry() {
    return fetch(docUrl(REG_ID) + "?key=" + KEY).then(function (res) {
      if (res.status === 404) return null;
      if (!res.ok) throw new Error("reg " + res.status);
      return res.json().then(function (j) {
        var f = j.fields || {};
        return f.profiles ? dec(f.profiles) : [];
      });
    });
  }
  function pushProfiles(profiles) {
    var fields = { profiles: enc(profiles), _rev: enc(Date.now()) };
    var q = "updateMask.fieldPaths=profiles&updateMask.fieldPaths=_rev";
    return fetch(docUrl(REG_ID) + "?key=" + KEY + "&" + q, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fields: fields })
    }).then(function (res) { if (!res.ok) throw new Error("reg push " + res.status); });
  }
  function syncRegistry() {
    return fetchRegistry().then(function (profiles) {
      if (!profiles || !profiles.length) {
        var seed = [{ id: "shared", name: "Ashton" }, { id: "team", name: "Team" }];
        return pushProfiles(seed).then(function () { return localSet({ boardProfiles: seed }); });
      }
      if (!profiles.some(function (p) { return p.id === "shared"; })) profiles.unshift({ id: "shared", name: "Ashton" });
      return localSet({ boardProfiles: profiles }).then(function () {
        // Recover a dangling active board (e.g. a deleted user) -> back to the main board.
        return localGet(["activeBoard"]).then(function (d) {
          var a = d.activeBoard || "shared";
          if (!profiles.some(function (p) { return p.id === a; })) return localSet({ activeBoard: "shared" });
        });
      });
    }).catch(function (e) { console.warn("[cloud-sync] registry", e); });
  }

  // ---- switch board --------------------------------------------------------
  // Atomic: flush the current board, fetch the target, REPLACE local with the
  // target's data (resetting every key — a new board loads EMPTY), and only then
  // commit `activeBoard`. `switching` stays true the whole time so no stray push
  // ever writes one board's data into another. If the fetch fails, nothing changes.
  function switchBoard(to) {
    switching = true;
    return pushNow_force()                                  // 1. flush current board -> its own doc
      .then(function () { return fetchDoc(to); })           // 2. fetch the target board
      .then(function (remote) {
        return loadBoardIntoLocal(remote)                   // 3. local := target data (empties for a new board)
          .then(function () { return localSet({ activeBoard: to }); }); // 4. commit active LAST
      })
      .then(function () { return syncRegistry(); })
      .then(function () { switching = false; })             // 5. release the guard only when fully done
      .catch(function (e) { switching = false; console.warn("[cloud-sync] switch failed", e); throw e; });
  }
  // Like pushNow but bypasses the `switching` guard (used at the start of a switch).
  function pushNow_force() {
    return getActive().then(function (active) {
      return localGet(SYNC_KEYS).then(function (d) {
        var mask = [], fields = {};
        SYNC_KEYS.forEach(function (k) { if (d[k] !== undefined) { fields[k] = enc(d[k]); mask.push(k); } });
        if (!mask.length) return;
        fields._rev = enc(Date.now()); mask.push("_rev");
        var q = mask.map(function (k) { return "updateMask.fieldPaths=" + encodeURIComponent(k); }).join("&");
        return fetch(docUrl(active) + "?key=" + KEY + "&" + q, {
          method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ fields: fields })
        }).then(function (res) { if (!res.ok) throw new Error("flush " + res.status); });
      });
    });
  }

  function schedulePush() {
    clearTimeout(pushTimer);
    pushTimer = setTimeout(pushNow, 1500);
  }

  // ---- wiring --------------------------------------------------------------
  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area !== "local") return;
    if (switching) return;
    if (Date.now() < suppressPushUntil) return;             // change we caused by pulling
    var touched = Object.keys(changes).some(function (k) { return SYNC_KEYS.indexOf(k) >= 0; });
    if (touched) schedulePush();
  });

  chrome.alarms.create("cloudPull", { periodInMinutes: 1 });
  chrome.alarms.onAlarm.addListener(function (a) { if (a.name === "cloudPull") sync(); });
  if (chrome.runtime.onStartup) chrome.runtime.onStartup.addListener(sync);
  if (chrome.runtime.onInstalled) chrome.runtime.onInstalled.addListener(function () {
    chrome.alarms.create("cloudPull", { periodInMinutes: 1 });
    sync();
  });

  // Messages from the board page (watchlist.js).
  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg) return;
    if (msg.type === "CLOUD_SYNC") { sync().then(function () { sendResponse({ ok: true }); }); return true; }
    if (msg.type === "SWITCH_BOARD") { switchBoard(msg.to).then(function () { sendResponse({ ok: true }); }, function () { sendResponse({ ok: false }); }); return true; }
    if (msg.type === "SAVE_PROFILES") {
      localSet({ boardProfiles: msg.profiles })
        .then(function () { return pushProfiles(msg.profiles); })
        .then(function () { sendResponse({ ok: true }); })
        .catch(function () { sendResponse({ ok: false }); });
      return true;
    }
  });

  sync(); // run once when the worker spins up
})();
