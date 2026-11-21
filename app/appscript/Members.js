/**
 * The app's own data sheet ("Just Follow Members"), session helpers and the error log.
 *
 * The script creates the spreadsheet itself the first time it is needed (drive.file scope, like the
 * trip inboxes), so it can write there while trip docs and expense sheets stay read-only to it.
 * Its id is kept in script property MEMBERS_SHEET. The test backend (APP_ENV = test) makes its own
 * "TEST Just Follow Members", so testing never touches the live one.
 *
 * Nothing here runs while a trip opens: openTrip, refreshTrip and the inbox calls don't read this sheet.
 * Later tasks (sign-in, organiser tools, votes, profiles) build on these helpers.
 *
 * Tabs and columns are matched by name. New tabs are only ever added; existing tabs, columns and rows
 * are never moved, cleared or rebuilt.
 */
var MEMBERS_TABS = {
  'People': ['Email', 'Name', 'Created', 'Last seen', 'Status'],
  'Members': ['Trip', 'Email', 'Role', 'Name', 'Added', 'Added by', 'Status'],
  'Sessions': ['Token hash', 'Email', 'Created', 'Expires', 'Device'],
  'Trip settings': ['Trip', 'Setting', 'Value', 'Updated', 'Updated by'],
  'Join requests': ['Time', 'Trip', 'Email', 'Name', 'Message', 'Status', 'Decided by', 'Decided at'],
  'Votes': ['Vote', 'Trip', 'Question', 'Options', 'Created by', 'Created', 'Closes', 'Status', 'Result'],
  'Ballots': ['Vote', 'Email', 'Choice', 'Time'],
  'Notification settings': ['Email', 'Trip', 'Setting', 'Value', 'Updated'],
  'Profiles': ['Email', 'Answers', 'Type', 'Updated'],
  'Error log': ['Time', 'Ref', 'Function', 'Trip', 'Person', 'Message', 'Detail']
};
var SESSION_DAYS = 90;            // how long a sign-in lasts
var SESSION_CACHE_SECONDS = 600;  // a checked session is trusted from the cache for 10 minutes

function membersTitle_() {
  return (isTest_() ? 'TEST ' : '') + 'Just Follow Members';
}

/** The Members spreadsheet id, or null. create: make it (with every tab) if it doesn't exist yet. */
function membersId_(create) {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('MEMBERS_SHEET');
  if (id || !create) return id;
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    id = props.getProperty('MEMBERS_SHEET');
    if (id) return id;
    var ss = Sheets.Spreadsheets.create({
      properties: { title: membersTitle_(), timeZone: Session.getScriptTimeZone() },
      sheets: Object.keys(MEMBERS_TABS).map(function (t) {
        return { properties: { title: t, gridProperties: { frozenRowCount: 1 } } };
      })
    });
    id = ss.spreadsheetId;
    Sheets.Spreadsheets.Values.batchUpdate({
      valueInputOption: 'RAW',
      data: Object.keys(MEMBERS_TABS).map(function (t) { return { range: "'" + t + "'!A1", values: [MEMBERS_TABS[t]] }; })
    }, id);
    props.setProperty('MEMBERS_SHEET', id);
    return id;
  } finally { lock.releaseLock(); }
}

/** Adds any tab that is missing (and its header row). Never changes a tab that is already there. */
function ensureMembersTabs_(id) {
  var have = Sheets.Spreadsheets.get(id, { fields: 'sheets.properties.title' }).sheets
    .map(function (s) { return s.properties.title; });
  var missing = Object.keys(MEMBERS_TABS).filter(function (t) { return have.indexOf(t) < 0; });
  if (!missing.length) return [];
  Sheets.Spreadsheets.batchUpdate({ requests: missing.map(function (t) {
    return { addSheet: { properties: { title: t, gridProperties: { frozenRowCount: 1 } } } };
  }) }, id);
  Sheets.Spreadsheets.Values.batchUpdate({
    valueInputOption: 'RAW',
    data: missing.map(function (t) { return { range: "'" + t + "'!A1", values: [MEMBERS_TABS[t]] }; })
  }, id);
  return missing;
}

/** Rows of a tab as objects keyed by header name, each with its sheet row number in _row. */
function membersRows_(tab) {
  var id = membersId_(true);
  var res = Sheets.Spreadsheets.Values.get(id, "'" + tab + "'!A1:Z", { valueRenderOption: 'UNFORMATTED_VALUE' });
  var rows = res.values || [];
  var head = (rows[0] || []).map(String);
  return rows.slice(1).map(function (r, i) {
    var o = { _row: i + 2 };
    head.forEach(function (h, j) { o[h] = r[j] == null ? '' : r[j]; });
    return o;
  });
}

/** Appends one row to a tab, placing values by header name (columns it doesn't know stay empty). */
function membersAppend_(tab, obj) {
  var id = membersId_(true);
  var head = (Sheets.Spreadsheets.Values.get(id, "'" + tab + "'!1:1").values || [[]])[0].map(String);
  var row = head.map(function (h) { return obj[h] == null ? '' : obj[h]; });
  Sheets.Spreadsheets.Values.append({ values: [row] }, id, "'" + tab + "'!A:A",
    { valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS' });
}

/** Writes some named cells of one existing row (only those cells). */
function membersUpdate_(tab, rowNum, obj) {
  var id = membersId_(true);
  var head = (Sheets.Spreadsheets.Values.get(id, "'" + tab + "'!1:1").values || [[]])[0].map(String);
  var data = [];
  Object.keys(obj).forEach(function (k) {
    var j = head.indexOf(k);
    if (j < 0) return;
    var col = String.fromCharCode(65 + j);
    data.push({ range: "'" + tab + "'!" + col + rowNum, values: [[obj[k]]] });
  });
  if (data.length) Sheets.Spreadsheets.Values.batchUpdate({ valueInputOption: 'RAW', data: data }, id);
}

function nowText_() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss');
}

function normEmail_(e) {
  var s = String(e || '').trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? s : '';
}

/**
 * Makes sure each trip's organiser (Trips sheet column "Organiser email") is a People row and an
 * organiser Members row for that trip. Only adds rows; never changes or removes one. Returns how many it added.
 */
function seedOrganisers_() {
  var trips = getTrips_(true).filter(function (t) { return t.organiser; });
  if (!trips.length) return 0;
  var people = membersRows_('People'), members = membersRows_('Members'), added = 0;
  trips.forEach(function (t) {
    if (!people.some(function (p) { return normEmail_(p.Email) === t.organiser; })) {
      membersAppend_('People', { 'Email': t.organiser, 'Created': nowText_(), 'Status': 'Active' });
      people.push({ Email: t.organiser });
      added++;
    }
    if (!members.some(function (m) { return m.Trip === t.key && normEmail_(m.Email) === t.organiser; })) {
      membersAppend_('Members', { 'Trip': t.key, 'Email': t.organiser, 'Role': 'Organiser',
        'Added': nowText_(), 'Added by': 'Trips sheet', 'Status': 'Active' });
      members.push({ Trip: t.key, Email: t.organiser });
      added++;
    }
  });
  return added;
}

/* ---------- Sessions ----------
 * A session is a random token the page keeps; the sheet stores only its SHA-256 hash.
 * A checked session is cached for 10 minutes, so checking one on every call costs a cache read, not a sheet read.
 */
function tokenHash_(token) {
  return Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,
    'jf-session|' + String(token))).replace(/=+$/, '');
}

/** Starts a session for an email. Returns the token (shown to the page once, never stored). */
function newSession_(email, device) {
  email = normEmail_(email);
  if (!email) throw new Error('bademail');
  var token = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
  var expires = new Date(Date.now() + SESSION_DAYS * 86400000).toISOString();
  membersAppend_('Sessions', { 'Token hash': tokenHash_(token), 'Email': email, 'Created': nowText_(),
    'Expires': expires, 'Device': String(device || '').slice(0, 80) });
  CacheService.getScriptCache().put('sess-' + tokenHash_(token), JSON.stringify({ email: email, expires: expires }),
    SESSION_CACHE_SECONDS);
  return token;
}

/** The session's {email, expires}, or null if the token is unknown, ended or expired. */
function checkSession_(token) {
  if (!/^[a-f0-9]{64}$/.test(String(token || ''))) return null;
  var h = tokenHash_(token), cache = CacheService.getScriptCache();
  var hit = cache.get('sess-' + h);
  var s = null;
  if (hit === 'none') return null;
  if (hit) { try { s = JSON.parse(hit); } catch (err) { s = null; } }
  if (!s) {
    var row = membersRows_('Sessions').filter(function (r) { return r['Token hash'] === h; })[0];
    s = row ? { email: normEmail_(row.Email), expires: String(row.Expires) } : null;
    cache.put('sess-' + h, s ? JSON.stringify(s) : 'none', SESSION_CACHE_SECONDS);
  }
  if (!s || !s.email || !(new Date(s.expires).getTime() > Date.now())) return null;
  return s;
}

/** Ends a session now (sign out). */
function endSession_(token) {
  var h = tokenHash_(token);
  membersRows_('Sessions').forEach(function (r) {
    if (r['Token hash'] === h) membersUpdate_('Sessions', r._row, { 'Expires': new Date().toISOString() });
  });
  CacheService.getScriptCache().put('sess-' + h, 'none', SESSION_CACHE_SECONDS);
}

/* ---------- Error log ----------
 * Every unexpected server error is saved with a short reference code (e.g. JF-7KQ2MX) that the page
 * can show, so a traveller can quote it and we can find the row. Logging never throws.
 */
function errorRef_() {
  var abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789', s = '';
  for (var i = 0; i < 6; i++) s += abc.charAt(Math.floor(Math.random() * abc.length));
  return 'JF-' + s;
}

/** Saves an error and returns its reference code. ctx: {fn, trip, person, detail}. */
function logError_(err, ctx) {
  var ref = errorRef_();
  ctx = ctx || {};
  var msg = String(err && err.message || err).slice(0, 500);
  console.error(ref + ' ' + (ctx.fn || '') + ': ' + msg);
  try {
    membersAppend_('Error log', { 'Time': nowText_(), 'Ref': ref, 'Function': String(ctx.fn || '').slice(0, 40),
      'Trip': String(ctx.trip || '').slice(0, 64), 'Person': String(ctx.person || '').slice(0, 80), 'Message': msg,
      'Detail': String(ctx.detail || (err && err.stack) || '').slice(0, 1500) });
  } catch (e2) { console.error('Error log unavailable: ' + e2.message); }
  return ref;
}

/** Run from the editor: creates the Members sheet if needed, adds missing tabs, seeds organisers, logs the link. */
function setupMembers() {
  var id = membersId_(true);
  var added = ensureMembersTabs_(id);
  Logger.log('Members sheet: https://docs.google.com/spreadsheets/d/%s/edit%s', id,
    added.length ? ' (added tabs: ' + added.join(', ') + ')' : '');
  Logger.log('Organiser rows added: %s', seedOrganisers_());
}

/**
 * Run from the editor ON THE TEST BACKEND ONLY: checks the sheet, sessions and the error log end to end.
 * It writes a test session and an error row, so it refuses to run unless APP_ENV is test.
 */
function testMembers() {
  if (!isTest_()) throw new Error('testMembers writes test rows: run it on the test backend (APP_ENV = test) only');
  var ok = true;
  function check(cond, what) { Logger.log('%s %s', cond ? 'ok  ' : 'FAIL', what); if (!cond) ok = false; }
  var id = membersId_(true);
  check(!!id, 'Members sheet exists: https://docs.google.com/spreadsheets/d/' + id + '/edit');
  ensureMembersTabs_(id);
  var have = Sheets.Spreadsheets.get(id, { fields: 'sheets.properties.title' }).sheets.map(function (s) { return s.properties.title; });
  Object.keys(MEMBERS_TABS).forEach(function (t) { check(have.indexOf(t) > -1, 'tab ' + t); });
  check(seedOrganisers_() >= 0, 'organisers seeded');
  var token = newSession_('test-traveller@example.com', 'testMembers');
  CacheService.getScriptCache().remove('sess-' + tokenHash_(token));
  var s = checkSession_(token);
  check(s && s.email === 'test-traveller@example.com', 'new session checks out (from the sheet)');
  var t0 = Date.now(); checkSession_(token);
  check(Date.now() - t0 < 300, 'cached session check is fast (' + (Date.now() - t0) + ' ms)');
  check(checkSession_('0'.repeat(64)) === null, 'unknown token is refused');
  endSession_(token);
  check(checkSession_(token) === null, 'ended session is refused');
  var ref = logError_(new Error('testMembers check'), { fn: 'testMembers', trip: 'test' });
  check(/^JF-[A-Z2-9]{6}$/.test(ref), 'error logged with reference ' + ref);
  check(membersRows_('Error log').some(function (r) { return r.Ref === ref; }), 'error row is in the Error log tab');
  Logger.log(ok ? 'testMembers passed' : 'testMembers FAILED');
  if (!ok) throw new Error('testMembers failed');
}
