/* cloud-sync.js — keeps the extension's board in sync with the website.
 *
 * Both the extension and the website (https://shorts-scout-d6c36.web.app) read &
 * write ONE shared Firestore document (boards/shared) in OPEN mode — no sign-in.
 * This runs in the background service worker:
 *   - local edit (save a channel, edit niches, etc.) -> pushed up to the cloud
 *   - cloud changed (edited on the website / another device) -> pulled down
 *
 * Strategy: last-write-wins, keyed by a millisecond `_rev` stamp. A periodic
 * alarm pulls every minute; opening the board triggers an immediate pull.
 * The YouTube API key and notebook images are NOT synced (kept per-device).
 */
(function () {
  var PROJECT = "shorts-scout-d6c36";
  // Firebase web API key — not secret (Firestore access is governed by rules).
  var KEY = "AIzaSyA9_wvXRVPqTaTVJN-CvPbfeSEyROodALY";
  var DOC = "https://firestore.googleapis.com/v1/projects/" + PROJECT +
            "/databases/(default)/documents/boards/shared";

  // Keys that mirror between extension <-> website. Must match cloud-app.js.
  var SYNC_KEYS = ["watchlist", "niches", "nicheParents", "tags", "madeBy",
                   "madeFor", "languages", "savedVideos", "snapshots", "notebookMd",
                   "vidiqStats", "vidiqHistory"];

  var suppressPushUntil = 0;   // ignore storage events we caused by pulling
  var pushTimer = null;

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

  // ---- cloud read/write ----------------------------------------------------
  function fetchCloud() {
    return fetch(DOC + "?key=" + KEY).then(function (res) {
      if (res.status === 404) return { rev: 0, fields: {} }; // doc not created yet
      if (!res.ok) throw new Error("pull " + res.status);
      return res.json().then(function (j) {
        var f = j.fields || {};
        return { rev: f._rev ? dec(f._rev) : 0, fields: f };
      });
    });
  }

  function localGet(keys) {
    return new Promise(function (resolve) { chrome.storage.local.get(keys, resolve); });
  }
  function localSet(obj) {
    return new Promise(function (resolve) { chrome.storage.local.set(obj, resolve); });
  }

  function pushNow() {
    return localGet(SYNC_KEYS).then(function (d) {
      var obj = {}, mask = [];
      SYNC_KEYS.forEach(function (k) { if (d[k] !== undefined) { obj[k] = d[k]; mask.push(k); } });
      var rev = Date.now();
      var fields = {};
      mask.forEach(function (k) { fields[k] = enc(obj[k]); });
      fields._rev = enc(rev); mask.push("_rev");
      var q = mask.map(function (k) { return "updateMask.fieldPaths=" + encodeURIComponent(k); }).join("&");
      return fetch(DOC + "?key=" + KEY + "&" + q, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fields: fields })
      }).then(function (res) {
        if (!res.ok) throw new Error("push " + res.status);
        return localSet({ _cloudRev: rev });
      });
    }).catch(function (e) { console.warn("[cloud-sync] push failed", e); });
  }

  function applyRemote(remote) {
    var obj = {};
    SYNC_KEYS.forEach(function (k) { if (remote.fields[k] !== undefined) obj[k] = dec(remote.fields[k]); });
    obj._cloudRev = remote.rev;
    suppressPushUntil = Date.now() + 4000; // don't echo the storage writes back up
    return localSet(obj);
  }

  // Reconcile local <-> cloud. Safety rule: never overwrite a non-empty board
  // with an empty one — seed from whichever side actually has channels.
  function sync() {
    return Promise.all([fetchCloud(), localGet(SYNC_KEYS.concat(["_cloudRev"]))])
      .then(function (r) {
        var remote = r[0], local = r[1];
        var localRev = local._cloudRev || 0;
        var localHasData = (local.watchlist && local.watchlist.length) ||
                           (local.savedVideos && local.savedVideos.length);
        var remoteWL = remote.fields.watchlist ? dec(remote.fields.watchlist) : [];
        var remoteSV = remote.fields.savedVideos ? dec(remote.fields.savedVideos) : [];
        var remoteHasData = (Array.isArray(remoteWL) && remoteWL.length) ||
                            (Array.isArray(remoteSV) && remoteSV.length);

        if (remote.rev > localRev && remoteHasData) return applyRemote(remote);   // cloud is newer & real -> pull
        if (localHasData && !remoteHasData) return pushNow();                      // we have data, cloud is empty -> seed
        if (remote.rev > localRev && !localHasData) return applyRemote(remote);    // we're empty, cloud has a newer state -> pull
        // otherwise: in sync, or both empty -> nothing to do
      })
      .catch(function (e) { console.warn("[cloud-sync] sync failed", e); });
  }

  function schedulePush() {
    clearTimeout(pushTimer);
    pushTimer = setTimeout(pushNow, 1500);
  }

  // ---- wiring --------------------------------------------------------------
  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area !== "local") return;
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

  // The board page (watchlist.js) sends this on open for an instant pull.
  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (msg && msg.type === "CLOUD_SYNC") { sync().then(function () { sendResponse({ ok: true }); }); return true; }
  });

  sync(); // run once when the worker spins up
})();
