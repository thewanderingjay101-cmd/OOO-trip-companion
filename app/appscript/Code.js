/**
 * Trip Companion: one phone-friendly web app for every trip. Each trip is an
 * itinerary doc plus an expense sheet. It only reads those files; it never writes to them.
 *
 * Trips come from the private "Trip Companion Trips" Google Sheet (tab Trips), one row per trip:
 *   Key | Name | Start | End | Doc | Sheet | PIN | Time zone | Place | Notes | Organiser email
 * (Organiser email is optional; it seeds the organiser's row in the app's Members sheet, see Members.js.)
 * Its id is script property TRIPS_SHEET (Project Settings > Script properties). TRIPS_SHEET_ID below
 * is only a fallback and stays blank in the repo, which is public. Adding a row there adds
 * a trip: no editor step, no redeploy. A row without a PIN is ignored.
 *
 * Trips can also still be added in Project Settings > Script properties (the sheet wins on the same key):
 *   Property  TRIP_<key>            e.g. TRIP_26-11-kansai
 *   Value     name=Kansai; start=2026-11-11; end=2026-11-20; doc=<doc id>; sheet=<sheet id>;
 *             pin=<PIN>; tz=Asia/Tokyo; place=Japan
 * (tz and place are optional; they default to Asia/Singapore and blank.)
 *
 * Nobody sees a trip, not even its name, until they enter that trip's PIN.
 * The plain /exec link asks for a PIN and opens the trip that PIN belongs to.
 * /exec?trip=<key> asks for that trip's PIN only. A device that has unlocked trips
 * before opens the current one of them straight away, and its Trip tab lists only
 * the other trips that device has unlocked.
 */
var CACHE_SECONDS = 60;
var LAST_GOOD_SECONDS = 21600;  // last good copy of each trip (6 h, the cache maximum): shown at once while a fresh read runs
var MAX_FAILS = 20;          // wrong PINs allowed per trip per 10 minutes, across everyone
var LOCK_SECONDS = 600;
var MAX_SAVED = 30;          // saved trip keys a device may send in one call
var TRIPS_SHEET_ID = '';  // kept out of the public repo: set script property TRIPS_SHEET to the Trips sheet's id
var TRIPS_CACHE_SECONDS = 60;
var APP_NAME = 'Just Follow';  // app name, shown in the tab and under the Home Screen icon
// Launcher page with the iPhone Home Screen icon (GitHub Pages); script property LAUNCHER overrides, '' hides the link
var LAUNCHER_URL = 'https://thewanderingjay101-cmd.github.io/OOO-trip-companion/';  // also the banner-free front end (calls doPost)
// Suitcase icon, a PNG in Drive shared "Anyone with the link" (script property APP_ICON overrides)
var APP_ICON_URL = 'https://lh3.googleusercontent.com/d/1ZonX6GfUv2dBmzkg8cprNABw9Xeb-oOc=s512';

/** Fills defaults; returns null if the trip lacks a required field. */
function cleanTrip_(t) {
  if (!t.key || !/^[A-Za-z0-9_.-]{1,64}$/.test(t.key)) return null;
  if (!t.doc || !t.sheet || !t.pin || !/^\d{4}-\d\d-\d\d$/.test(t.start || '') || !/^\d{4}-\d\d-\d\d$/.test(t.end || '')) return null;
  t.name = t.name || t.key;
  t.tz = t.tz || 'Asia/Singapore';
  t.place = t.place || '';
  t.organiser = normEmail_(t.organiser);  // optional "Organiser email" column; never sent to the page
  return t;
}

/** Trips from Script properties TRIP_<key>. */
function propTrips_(props) {
  var trips = [];
  Object.keys(props).forEach(function (name) {
    var m = /^TRIP_(.+)$/.exec(name);
    if (!m || name === 'TRIP_PIN') return;
    var t = { key: m[1] };
    String(props[name]).split(';').forEach(function (part) {
      var i = part.indexOf('=');
      if (i > 0) t[part.slice(0, i).trim().toLowerCase()] = part.slice(i + 1).trim();
    });
    t = cleanTrip_(t);
    if (t) trips.push(t);
  });
  return trips;
}

/** A date cell as YYYY-MM-DD: accepts text like 2026-12-05 or a Sheets date serial number. */
function cellDate_(v) {
  if (typeof v === 'number' && v > 20000 && v < 80000) {
    return Utilities.formatDate(new Date(Math.round((v - 25569) * 86400000)), 'UTC', 'yyyy-MM-dd');
  }
  var s = String(v == null ? '' : v).trim();
  var m = /^(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})$/.exec(s);
  return m ? m[1] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[3]).slice(-2) : s;
}

/** A file id from an id or a full Google link. */
function cellFileId_(v) {
  var s = String(v == null ? '' : v).trim();
  var m = /\/d\/([A-Za-z0-9_-]{20,})/.exec(s) || /[?&]id=([A-Za-z0-9_-]{20,})/.exec(s);
  return m ? m[1] : s;
}

/** Trips from the Trips sheet. Header row names the columns, so their order doesn't matter. Throws on read errors. */
function sheetTrips_(sheetId) {
  var res = Sheets.Spreadsheets.Values.get(sheetId, 'Trips!A1:Z300',
    { valueRenderOption: 'UNFORMATTED_VALUE', dateTimeRenderOption: 'SERIAL_NUMBER' });
  var rows = res.values || [];
  if (!rows.length) return [];
  var alias = { key: 'key', name: 'name', trip: 'name', start: 'start', end: 'end', doc: 'doc', itinerary: 'doc',
    sheet: 'sheet', expenses: 'sheet', pin: 'pin', tz: 'tz', timezone: 'tz', place: 'place',
    organiseremail: 'organiser', organizeremail: 'organiser', organiser: 'organiser', organizer: 'organiser' };
  var cols = {};
  rows[0].forEach(function (h, i) {
    var f = alias[String(h || '').toLowerCase().replace(/[^a-z]/g, '')];
    if (f && cols[f] == null) cols[f] = i;
  });
  var trips = [];
  rows.slice(1).forEach(function (r) {
    function get(f) { return cols[f] == null || r[cols[f]] == null ? '' : r[cols[f]]; }
    var t = {
      key: String(get('key')).trim(),
      name: String(get('name')).trim(),
      start: cellDate_(get('start')),
      end: cellDate_(get('end')),
      doc: cellFileId_(get('doc')),
      sheet: cellFileId_(get('sheet')),
      pin: String(get('pin')).trim(),
      tz: String(get('tz')).trim(),
      place: String(get('place')).trim(),
      organiser: String(get('organiser')).trim()
    };
    if (!t.key && t.name && t.start) t.key = t.start.slice(2, 7) + '-' + t.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    t = cleanTrip_(t);
    if (t) trips.push(t);
  });
  return trips;
}

/** Every trip: the Trips sheet plus Script properties (the sheet wins on the same key). Cached for a minute. */
function getTrips_(fresh) {
  var cache = CacheService.getScriptCache();
  if (!fresh) {
    var hit = cache.get('trips-list');
    if (hit) { try { return JSON.parse(hit); } catch (err) { /* read again */ } }
  }
  var props = PropertiesService.getScriptProperties().getProperties();
  var byKey = {};
  propTrips_(props).forEach(function (t) { byKey[t.key] = t; });
  var sheetId = props.TRIPS_SHEET || TRIPS_SHEET_ID;
  var sheetOk = true;
  if (!sheetId) console.error('No Trips sheet: set script property TRIPS_SHEET');
  if (sheetId) {
    try { sheetTrips_(sheetId).forEach(function (t) { byKey[t.key] = t; }); }
    catch (err) { sheetOk = false; console.error('Trips sheet unreadable: ' + err.message); }
  }
  var trips = Object.keys(byKey).map(function (k) { return byKey[k]; });
  trips.sort(function (a, b) { return a.start < b.start ? -1 : a.start > b.start ? 1 : 0; });
  // if the sheet couldn't be read, don't cache, so its trips come back on the next call
  if (sheetOk) { try { cache.put('trips-list', JSON.stringify(trips), TRIPS_CACHE_SECONDS); } catch (err) { /* optional */ } }
  return trips;
}

function pickTrip_(trips, requested) {
  if (!trips.length) return null;
  if (requested) {
    for (var i = 0; i < trips.length; i++) if (trips[i].key === requested) return trips[i];
  }
  var now = new Date();
  var upcoming = null;
  for (var j = 0; j < trips.length; j++) {
    var t = trips[j];
    var today = Utilities.formatDate(now, t.tz, 'yyyy-MM-dd');
    if (today >= t.start && today <= t.end) return t;
    if (!upcoming && today < t.start) upcoming = t;
  }
  return upcoming || trips[trips.length - 1];
}

function findTrip_(key) {
  var trips = getTrips_();
  for (var i = 0; i < trips.length; i++) if (trips[i].key === key) return trips[i];
  return null;
}

function doGet(e) {
  // No trip names or list here: the page learns about a trip only after its PIN (or a saved key) checks out.
  var p = (e && e.parameter) || {};
  var props = PropertiesService.getScriptProperties().getProperties();
  var boot = {
    url: ScriptApp.getService().getUrl(),
    trip: /^[A-Za-z0-9_.-]{1,64}$/.test(p.trip || '') ? p.trip : null,
    // Home Screen key: the page puts it in the link after a correct PIN, so a Home Screen icon opens without the PIN
    k: /^[A-Za-z0-9_-]{16,64}$/.test(p.k || '') ? p.k : null,
    // keys for several trips (ks=tripKey:deviceKey,...), so one Home Screen icon can hold all of a person's trips
    ks: parseKs_(p.ks),
    // add=1: show the PIN box to open one more trip, without auto-opening a saved one
    add: p.add === '1',
    launcher: props.LAUNCHER == null ? LAUNCHER_URL : props.LAUNCHER,
    any: getTrips_().length > 0
  };
  // Home Screen links carry trip keys: if the trip is cached, put it in the page so it shows without another server call
  if (boot.any && (boot.k || Object.keys(boot.ks).length)) boot.pre = preloadTrip_(boot);
  var tpl = HtmlService.createTemplateFromFile('Index');
  tpl.boot = JSON.stringify(boot).replace(/</g, '\\u003c');
  var out = tpl.evaluate()
    .setTitle(APP_NAME)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover');
  // App icon (browser tab, Android Home Screen; iPhone may still use its own letter icon)
  try { out.setFaviconUrl(props.APP_ICON || APP_ICON_URL); } catch (err) { /* icon is optional */ }
  return out;
}

/**
 * JSON API for the front end on GitHub Pages (no "created with Apps Script" banner there).
 * The page POSTs {"fn": "...", "args": [...]} as text/plain (a CORS "simple" request, so no preflight)
 * and gets {"ok": true, "result": <same string the function returns>} or {"ok": false, "error": "<code>"}.
 * Only these functions can be called, with the same PIN and key checks as the Apps Script page.
 * The deployment must stay Execute as: Me, Who has access: Anyone, so the page can call it without a Google sign-in.
 */
var API_FNS = {
  openTrip: function (a) { return openTrip(a[0], a[1], a[2], a[3] === true); },  // never 'cache' from outside
  refreshTrip: function (a) { return refreshTrip(a[0], a[1]); },
  getInbox: function (a) { return getInbox(a[0], a[1]); },
  postInbox: function (a) { return postInbox(a[0], a[1], a[2], a[3], a[4]); },
  getVotes: function (a) { return getVotes(a[0], a[1]); },
  startVote: function (a) { return startVote(a[0], a[1], a[2], a[3], a[4]); },
  castVote: function (a) { return castVote(a[0], a[1], a[2], a[3], a[4]); },
  decideVote: function (a) { return decideVote(a[0], a[1], a[2], a[3], a[4]); }
};
var API_ERRORS = ['needpin', 'wrong', 'locked', 'setup', 'busy', 'empty', 'closed'];

function doPost(e) {
  var out, req = null;
  try {
    req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    var fn = API_FNS.hasOwnProperty(req.fn) ? API_FNS[req.fn] : null;
    if (!fn) throw new Error('badcall');
    var args = Array.isArray(req.args) ? req.args.slice(0, 6) : [];
    args = args.map(function (v, i) {
      // saved keys object for openTrip (3rd arg); everything else is a short string or number
      if (req.fn === 'openTrip' && i === 2) return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
      if (typeof v === 'boolean' || typeof v === 'number') return v;
      return String(v == null ? '' : v).slice(0, 2000);
    });
    out = { ok: true, result: fn(args) };
  } catch (err) {
    var m = String(err && err.message || err);
    var code = API_ERRORS.filter(function (c) { return m.indexOf(c) > -1; })[0];
    out = { ok: false, error: code || (m === 'badcall' ? 'badcall' : 'error') };
    // unexpected errors go to the Error log with a reference code the page can show
    if (!code && m !== 'badcall') {
      out.ref = logError_(err, { fn: req && req.fn, trip: req && Array.isArray(req.args) ? String(req.args[0] || '').slice(0, 64) : '',
        detail: (e && e.postData ? '' : '(no body) ') + (err && err.stack || '') });
    }
  }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

/**
 * The trip a Home Screen link opens, from the cache only (never reads the doc or sheet, never waits),
 * or null. Only the keys in the link count, exactly as openTrip checks them; the page then calls
 * openTrip in the background to bring it up to date.
 */
function preloadTrip_(boot) {
  try {
    var saved = {};
    Object.keys(boot.ks).forEach(function (k) { saved[k] = 'k:' + boot.ks[k]; });
    if (boot.trip && boot.k) saved[boot.trip] = 'k:' + boot.k;
    var json = openTrip(boot.trip || '', '', saved, 'cache');
    return json ? JSON.parse(json) : null;
  } catch (err) { return null; }
}

/** ks link parameter -> {tripKey: deviceKey}. Only shape-checked here; openTrip checks each key. */
function parseKs_(v) {
  var out = {};
  String(v || '').split(',').slice(0, MAX_SAVED).forEach(function (part) {
    var m = /^([A-Za-z0-9_.-]{1,64}):([A-Za-z0-9_-]{16,64})$/.exec(part.trim());
    if (m) out[m[1]] = m[2];
  });
  return out;
}

/** Key that stands in for the PIN in a Home Screen link. Changing the trip's PIN changes it. */
function deviceKey_(trip) {
  var raw = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, 'trip-companion|' + trip.key + '|' + String(trip.pin).trim());
  return Utilities.base64EncodeWebSafe(raw).replace(/=+$/, '').slice(0, 24);
}

/** Throws 'setup', 'locked' or 'wrong' unless cred is the trip's PIN or its Home Screen key ('k:<key>'). */
function checkAccess_(key, cred) {
  var trip = findTrip_(String(key || ''));
  if (!trip) throw new Error('setup');
  var cache = CacheService.getScriptCache();
  var failKey = 'pin-fails-' + trip.key;
  var fails = Number(cache.get(failKey) || 0);
  if (fails >= MAX_FAILS) throw new Error('locked');
  var c = String(cred || '').trim();
  var isKey = c.indexOf('k:') === 0;
  var ok = isKey ? c.slice(2) === deviceKey_(trip) : c === String(trip.pin).trim();
  if (!ok) {
    // saved keys are long random strings, so a stale one (PIN changed) doesn't count towards the lockout
    if (!isKey) cache.put(failKey, String(fails + 1), LOCK_SECONDS);
    Utilities.sleep(700);
    throw new Error('wrong');
  }
  return trip;
}

/** Trips whose saved key ('k:<key>') this device holds. saved is {tripKey: cred}. Never counts as a wrong PIN. */
function savedTrips_(trips, saved) {
  var out = [];
  if (!saved || typeof saved !== 'object') return out;
  var keys = Object.keys(saved).slice(0, MAX_SAVED);
  trips.forEach(function (t) {
    if (keys.indexOf(t.key) < 0) return;
    var c = String(saved[t.key] || '').trim();
    if (c.indexOf('k:') === 0 && c.slice(2) === deviceKey_(t)) out.push(t);
  });
  return out;
}

/** Finds the trip a PIN belongs to (plain link, no trip named). Wrong PINs count towards one shared lockout. */
function tripForPin_(trips, pin) {
  var cache = CacheService.getScriptCache();
  var fails = Number(cache.get('pin-fails-any') || 0);
  if (fails >= MAX_FAILS) throw new Error('locked');
  var p = String(pin || '').trim();
  var hits = trips.filter(function (t) { return p && p === String(t.pin).trim(); });
  if (!hits.length) {
    cache.put('pin-fails-any', String(fails + 1), LOCK_SECONDS);
    Utilities.sleep(700);
    throw new Error('wrong');
  }
  return pickTrip_(hits);  // trips sharing a PIN: open the current or next one of them
}

/**
 * Called from the page. key: trip from the link ('' for the plain link). cred: a typed PIN or a
 * Home Screen key ('k:<key>'), or '' to use only saved keys. saved: {tripKey: 'k:<key>'} from this device.
 * Throws 'needpin' when a PIN is needed. Returns the trip data plus deviceKey and mine (the trips this
 * device may list: the ones its saved keys or this PIN unlock) with keys, {tripKey: deviceKey} for each.
 * Trips may share a PIN on purpose (same travellers): typing it unlocks all of them at once.
 * fast (newer pages): true may return the last good copy, flagged stale, so the page shows at once and
 * calls again with false for fresh data. 'cache' (doGet only) returns null instead of reading the files.
 */
function openTrip(key, cred, saved, fast) {
  var trips = getTrips_();
  if (!trips.length) throw new Error('setup');
  key = String(key || '');
  cred = String(cred || '').trim();
  var mine = savedTrips_(trips, saved);
  var trip;
  if (cred) trip = key ? checkAccess_(key, cred) : tripForPin_(trips, cred);
  else {
    if (key) trip = mine.filter(function (t) { return t.key === key; })[0];
    else trip = pickTrip_(mine);
    if (!trip) throw new Error('needpin');
  }
  var typed = cred && cred.indexOf('k:') !== 0;
  trips.forEach(function (t) {
    var add = t.key === trip.key || (typed && cred === String(t.pin).trim());
    if (add && !mine.some(function (m) { return m.key === t.key; })) mine.push(t);
  });
  mine.sort(function (a, b) { return a.start < b.start ? -1 : a.start > b.start ? 1 : 0; });
  var data = getTripData_(trip, false, fast);
  if (!data) return null;
  if (!data.stale && fast !== 'cache') ensureInbox_(trip);
  data.deviceKey = deviceKey_(trip);
  data.mine = mine.map(function (t) { return { key: t.key, name: t.name, start: t.start, end: t.end }; });
  data.keys = {};
  mine.forEach(function (t) { data.keys[t.key] = deviceKey_(t); });
  return JSON.stringify(data);
}

/** Older pages (before 11 Nov 2026) call this; same check as before. */
function unlock(key, pin) {
  var trip = checkAccess_(key, pin);
  var data = getTripData_(trip, false);
  data.deviceKey = deviceKey_(trip);
  return JSON.stringify(data);
}

/** Pull-to-refresh: same check as unlock, but always reads the doc and sheet afresh. */
function refreshTrip(key, pin) {
  var trip = checkAccess_(key, pin);
  var data = getTripData_(trip, true);
  data.deviceKey = deviceKey_(trip);
  return JSON.stringify(data);
}

/** A gzip+base64 cache entry back to an object, or null. */
function unzipCached_(hit) {
  if (!hit) return null;
  try {
    return JSON.parse(Utilities.ungzip(Utilities.newBlob(Utilities.base64Decode(hit), 'application/x-gzip')).getDataAsString());
  } catch (err) { return null; }
}

/**
 * Trip data from the doc and sheet. Cached 60 s; a last good copy is kept 6 h.
 * fresh: skip the cache. fast: true may return the last good copy (data.stale = true);
 * 'cache' returns null rather than reading the files.
 */
function getTripData_(trip, fresh, fast) {
  var cache = CacheService.getScriptCache();
  var cacheKey = 'trip-data-gz-' + trip.key, lastKey = 'trip-data-last-' + trip.key;
  if (!fresh) {
    var hits = fast ? cache.getAll([cacheKey, lastKey]) : { };
    if (!fast) hits[cacheKey] = cache.get(cacheKey);
    var hit = unzipCached_(hits[cacheKey]);
    if (hit) return hit;
    if (fast) {
      hit = unzipCached_(hits[lastKey]);
      if (hit) { hit.stale = true; return hit; }
    }
    if (fast === 'cache') return null;
  }
  var doc = Docs.Documents.get(trip.doc, { includeTabsContent: true });
  // Sheets advanced service: works with read-only access (SpreadsheetApp needs full edit access)
  var res = Sheets.Spreadsheets.Values.batchGet(trip.sheet, {
    ranges: ['Summary!A1:O60', 'Settlement!A1:N60', 'Expenses!A1:J500'],
    valueRenderOption: 'FORMATTED_VALUE'
  });
  function vals(i) { return (res.valueRanges[i] && res.valueRanges[i].values) || []; }
  var data = buildTripData(doc, vals(0), vals(1), vals(2));
  data.mode = 'live';
  data.meta = { key: trip.key, name: trip.name, tz: trip.tz, place: trip.place,
    doc: trip.doc, sheet: trip.sheet, start: trip.start, end: trip.end };
  addChanges_(trip, data);  // changes since this morning (Changes.js); never fails the read
  try {
    var gz = Utilities.base64Encode(Utilities.gzip(Utilities.newBlob(JSON.stringify(data), 'application/json')).getBytes());
    if (gz.length < 95000) { cache.put(cacheKey, gz, CACHE_SECONDS); cache.put(lastKey, gz, LAST_GOOD_SECONDS); }
  } catch (err) { /* caching is optional */ }
  return data;
}

/* ---------- Inbox: trip members send expenses and requests; Claude applies them on a schedule ----------
 * Each trip gets its own "<name> Trip Inbox" spreadsheet, created by this script the first time
 * someone writes (the drive.file scope only lets the script write to files it created itself,
 * so the itinerary doc and expense sheet stay read-only). Its id is kept in script property INBOX_<key>.
 * Columns: Time | From | Message | Status | Reply | Done at | Re. Status starts as "Waiting".
 * Status: Waiting, Done, Pending (Claude asks a question in Reply), Skipped, Voting (a group vote is open, see
 * Votes.js; the scheduled run leaves it alone). Reply is left empty
 * unless a question is needed. Re holds the row number of the Pending message an answer replies to.
 */
var INBOX_RANGE = 'Inbox!A1:G';

/** True on the test backend (script property APP_ENV = test). The live backend leaves APP_ENV unset. */
function isTest_() {
  return String(PropertiesService.getScriptProperties().getProperty('APP_ENV') || '').trim().toLowerCase() === 'test';
}

/** Inbox title. Live: "<Trip> Trip Inbox", which the scheduled inbox run looks for. The test backend's inboxes
 * start with "TEST" and never end in "Trip Inbox", so that run never picks them up. */
function inboxTitle_(trip) {
  return isTest_() ? 'TEST ' + trip.name.replace(/^TEST\s+/i, '') + ' Inbox (beta)' : trip.name + ' Trip Inbox';
}

function inboxId_(trip, create) {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('INBOX_' + trip.key);
  if (id || !create) return id;
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    id = props.getProperty('INBOX_' + trip.key);
    if (id) return id;
    var ss = Sheets.Spreadsheets.create({
      properties: { title: inboxTitle_(trip), timeZone: trip.tz },
      sheets: [{ properties: { title: 'Inbox', gridProperties: { frozenRowCount: 1 } } }]
    });
    id = ss.spreadsheetId;
    Sheets.Spreadsheets.Values.update({ values: [['Time', 'From', 'Message', 'Status', 'Reply', 'Done at', 'Re']] },
      id, 'Inbox!A1:G1', { valueInputOption: 'RAW' });
    props.setProperty('INBOX_' + trip.key, id);
    return id;
  } finally { lock.releaseLock(); }
}

function inboxRows_(id) {
  var res = Sheets.Spreadsheets.Values.get(id, INBOX_RANGE, { valueRenderOption: 'FORMATTED_VALUE' });
  var rows = (res.values || []).slice(1);
  return rows.map(function (r, i) {
    return { row: i + 2, time: r[0] || '', from: r[1] || '', text: r[2] || '', status: r[3] || 'Waiting', reply: r[4] || '', done: r[5] || '', re: Number(r[6]) || 0 };
  }).filter(function (m) { return m.text; });
}

/** Latest inbox messages for the app (newest last). */
function getInbox(key, cred) {
  var trip = checkAccess_(key, cred);
  var id = inboxId_(trip, false);
  return JSON.stringify(id ? inboxRows_(id).slice(-150) : []);
}

/** Adds one message. from must be a traveller name the app offered; text up to 1500 characters.
 * re (optional) is the row of a Pending message this one answers. */
function postInbox(key, cred, from, text, re) {
  var trip = checkAccess_(key, cred);
  from = String(from || '').replace(/\s+/g, ' ').trim().slice(0, 40);
  text = String(text || '').trim().slice(0, 1500);
  if (!from || !text) throw new Error('empty');
  var cache = CacheService.getScriptCache(), rk = 'inbox-rate-' + trip.key;
  var n = Number(cache.get(rk) || 0);
  if (n >= 60) throw new Error('busy');
  cache.put(rk, String(n + 1), 600);
  var id = inboxId_(trip, true);
  re = Math.floor(Number(re) || 0);
  if (re < 2 || re > 100000) re = '';
  var now = Utilities.formatDate(new Date(), trip.tz, 'yyyy-MM-dd HH:mm');
  // a leading = + - @ would be read as a formula; RAW input keeps it as text anyway
  Sheets.Spreadsheets.Values.append({ values: [[now, from, text, 'Waiting', '', '', re]] }, id, 'Inbox!A:G',
    { valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS' });
  return JSON.stringify(inboxRows_(id).slice(-150));
}

/** Creates the trip's inbox the first time the trip is opened, so new trips need no setup step. Never fails the open. */
function ensureInbox_(trip) {
  try { inboxId_(trip, true); } catch (err) { console.error('Inbox for ' + trip.key + ': ' + err.message); }
}

/** Optional: creates every trip's inbox now and logs the links (trips also get one automatically when first opened). */
function setupInboxes() {
  getTrips_(true).forEach(function (t) {
    var id = inboxId_(t, true);
    Logger.log('%s inbox: https://docs.google.com/spreadsheets/d/%s/edit', t.key, id);
  });
}

/**
 * Optional time-driven trigger (Triggers > Add trigger > warmUp > Time-driven > every 10 minutes).
 * Re-reads every trip that is on now or starts within 14 days, so the app finds fresh data in the
 * cache and Google keeps the script warm. Only reads; never writes to any trip file.
 */
function warmUp() {
  var trips = getTrips_(true), now = new Date();
  // add new organisers to the Members sheet, at most every 6 hours, and only once that sheet exists (setupMembers)
  var cache = CacheService.getScriptCache();
  if (membersId_(false) && !cache.get('organisers-seeded')) {
    try { seedOrganisers_(); cache.put('organisers-seeded', '1', 21600); } catch (err) { console.error('seedOrganisers: ' + err.message); }
  }
  trips.forEach(function (t) {
    var today = Utilities.formatDate(now, t.tz, 'yyyy-MM-dd');
    var soon = Utilities.formatDate(new Date(now.getTime() + 14 * 86400000), t.tz, 'yyyy-MM-dd');
    if (t.end < today || t.start > soon) return;
    try { getTripData_(t, true); } catch (err) { console.error('warmUp ' + t.key + ': ' + err.message); }
  });
}

/** Run this from the editor to check every trip's files and settings. */
function testRead() {
  var sheetId = PropertiesService.getScriptProperties().getProperty('TRIPS_SHEET') || TRIPS_SHEET_ID;
  if (sheetId) {
    try { Logger.log('Trips sheet: %s trip(s) with a PIN', sheetTrips_(sheetId).length); }
    catch (err) { Logger.log('Trips sheet: FAILED %s', err.message); }
  }
  var trips = getTrips_(true);
  if (!trips.length) Logger.log('No trips set up. Add a row (with a PIN) to the Trips sheet.');
  var seen = {};
  trips.forEach(function (t) {
    var p = String(t.pin).trim();
    if (seen[p]) Logger.log('Note: %s and %s share a PIN, so that PIN unlocks both.', seen[p], t.key);
    seen[p] = t.key;
  });
  trips.forEach(function (t) {
    try {
      var d = getTripData_(t, true);
      var stops = d.plan.days.reduce(function (a, x) { return a + x.items.length; }, 0);
      Logger.log('%s (%s): days=%s stops=%s todo=%s expenses=%s total=%s',
        t.key, t.name, d.plan.days.length, stops, d.trip.todo.length, d.expenses.count, d.expenses.total_spend);
    } catch (err) {
      Logger.log('%s: FAILED %s', t.key, err.message);
    }
  });
}
