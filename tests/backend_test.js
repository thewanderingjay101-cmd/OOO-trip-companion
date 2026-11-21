// Runs the Apps Script backend (app/appscript/*.js) in Node against in-memory fakes of Google's services.
// No network, no real files: checks the Trips sheet reading, the Members sheet, sessions, the error log
// and the test-inbox naming. Run: node tests/backend_test.js
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm'), crypto = require('crypto');
const dir = path.join(__dirname, '..', 'app', 'appscript');
let fails = 0;
function check(ok, msg) { console.log((ok ? 'ok   ' : 'FAIL ') + msg); if (!ok) fails++; }

function makeWorld(props) {
  const files = {};  // id -> {title, tabs: {name: rows[][]}}
  let n = 0;
  const cacheStore = {};
  function tabOf(range) {
    const m = /^'?(.+?)'?!(.*)$/.exec(range);
    return m ? { tab: m[1], a1: m[2] } : { tab: range, a1: '' };
  }
  function colIndex(letters) { let c = 0; for (const ch of letters) c = c * 26 + (ch.charCodeAt(0) - 64); return c - 1; }
  function setCells(id, range, values) {
    const { tab, a1 } = tabOf(range);
    const rows = files[id].tabs[tab];
    if (!rows) throw new Error('no tab ' + tab);
    const m = /^([A-Z]+)(\d+)/.exec(a1) || ['', 'A', '1'];
    const c0 = colIndex(m[1]), r0 = Number(m[2]) - 1;
    values.forEach((row, i) => { rows[r0 + i] = rows[r0 + i] || []; row.forEach((v, j) => { rows[r0 + i][c0 + j] = v; }); });
  }
  const Sheets = {
    Spreadsheets: {
      create(spec) {
        const id = 'sheet' + (++n);
        files[id] = { title: spec.properties.title, tabs: {} };
        (spec.sheets || [{ properties: { title: 'Sheet1' } }]).forEach(s => { files[id].tabs[s.properties.title] = []; });
        return { spreadsheetId: id };
      },
      get(id) { return { sheets: Object.keys(files[id].tabs).map(t => ({ properties: { title: t } })) }; },
      batchUpdate(req, id) { req.requests.forEach(r => { if (r.addSheet) files[id].tabs[r.addSheet.properties.title] = []; }); },
      Values: {
        get(id, range) {
          if (!files[id]) throw new Error('not found ' + id);
          const { tab, a1 } = tabOf(range);
          const rows = files[id].tabs[tab];
          if (!rows) throw new Error('Unable to parse range: ' + range);
          if (a1 === '1:1') return { values: rows.slice(0, 1) };
          return { values: rows.map(r => r.slice()) };
        },
        update(body, id, range) { setCells(id, range, body.values); },
        batchUpdate(body, id) { body.data.forEach(d => setCells(id, d.range, d.values)); },
        append(body, id, range) { const { tab } = tabOf(range); body.values.forEach(r => files[id].tabs[tab].push(r.slice())); },
        batchGet() { throw new Error('trip files are not read in this test'); }
      }
    }
  };
  const ctx = {
    console: { log() {}, error() {} },
    Sheets,
    Docs: { Documents: { get() { throw new Error('trip files are not read in this test'); } } },
    PropertiesService: { getScriptProperties: () => ({
      getProperty: k => (k in props ? props[k] : null), setProperty: (k, v) => { props[k] = v; },
      getProperties: () => Object.assign({}, props) }) },
    CacheService: { getScriptCache: () => ({
      get: k => (k in cacheStore ? cacheStore[k] : null), put: (k, v) => { cacheStore[k] = String(v); },
      remove: k => { delete cacheStore[k]; }, getAll: ks => { const o = {}; ks.forEach(k => { if (k in cacheStore) o[k] = cacheStore[k]; }); return o; } }) },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    Session: { getScriptTimeZone: () => 'Asia/Singapore' },
    Logger: { log() {} },
    Utilities: {
      formatDate: (d, tz, f) => d.toISOString().slice(0, f.length > 10 ? 19 : 10).replace('T', ' '),
      getUuid: () => crypto.randomUUID(),
      sleep() {},
      DigestAlgorithm: { SHA_256: 'sha256' },
      computeDigest: (alg, s) => Array.from(crypto.createHash('sha256').update(s).digest()),
      base64EncodeWebSafe: bytes => Buffer.from(bytes).toString('base64url') + '=',
      base64Encode: bytes => Buffer.from(bytes).toString('base64')
    },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: s => ({ text: s, setMimeType() { return this; } }) },
    HtmlService: {}, ScriptApp: {}
  };
  vm.createContext(ctx);
  fs.readdirSync(dir).filter(f => f.endsWith('.js')).sort().forEach(f => vm.runInContext(fs.readFileSync(path.join(dir, f), 'utf8'), ctx, { filename: f }));
  return { ctx, files, props, cacheStore };
}

// A Trips sheet with the optional Organiser email column at the end
function tripsSheet(world, withOrganiser) {
  const id = world.ctx.Sheets.Spreadsheets.create({ properties: { title: 'Trips' }, sheets: [{ properties: { title: 'Trips' } }] }).spreadsheetId;
  const head = ['Key', 'Name', 'Start', 'End', 'Doc', 'Sheet', 'PIN', 'Time zone', 'Place', 'Notes'];
  const row = ['t-one', 'Trip One', '2026-11-11', '2026-11-20', 'docid000000000000000000', 'sheetid00000000000000000', '1111', 'Asia/Tokyo', 'Japan', ''];
  if (withOrganiser) { head.push('Organiser email'); row.push(' Organiser@Example.com '); }
  world.files[id].tabs.Trips = [head, row, ['t-two', 'Trip Two', '2026-12-01', '2026-12-05', 'docid111111111111111111', 'sheetid11111111111111111', '2222', '', '', '']];
  world.props.TRIPS_SHEET = id;
  return id;
}

// 1. Trips sheet without the new column reads exactly as before
{
  const w = makeWorld({});
  tripsSheet(w, false);
  const trips = w.ctx.getTrips_(true);
  check(trips.length === 2 && trips[0].key === 't-one' && trips[0].pin === '1111', 'Trips sheet without Organiser email still reads');
  check(trips.every(t => t.organiser === ''), 'no organiser when the column is missing');
  check(!w.props.MEMBERS_SHEET, 'reading trips never creates the Members sheet');
}

// 2. Organiser column, Members sheet, sessions and error log on a test backend
{
  const w = makeWorld({ APP_ENV: 'test' });
  tripsSheet(w, true);
  const trips = w.ctx.getTrips_(true);
  check(trips[0].organiser === 'organiser@example.com', 'Organiser email is read and normalised');
  w.ctx.setupMembers();
  const mid = w.props.MEMBERS_SHEET;
  check(!!mid && w.files[mid].title === 'TEST Just Follow Members', 'test backend creates "TEST Just Follow Members"');
  const tabs = Object.keys(w.files[mid].tabs);
  check(Object.keys(w.ctx.MEMBERS_TABS).every(t => tabs.includes(t)), 'every tab is created (' + tabs.length + ')');
  check(w.files[mid].tabs.Members.some(r => r[0] === 't-one' && r[2] === 'Organiser'), 'organiser seeded as a Members row');
  const before = w.files[mid].tabs.Members.length;
  w.ctx.seedOrganisers_();
  check(w.files[mid].tabs.Members.length === before, 'seeding again adds nothing');
  // a tab JY deleted by mistake comes back, the others stay untouched
  w.files[mid].tabs.People.push(['keep@example.com']);
  delete w.files[mid].tabs.Profiles;
  check(w.ctx.ensureMembersTabs_(mid).join() === 'Profiles' && w.files[mid].tabs.People.some(r => r[0] === 'keep@example.com'),
    'missing tab is added back, existing rows kept');
  let threw = null;
  try { w.ctx.testMembers(); } catch (e) { threw = e; }
  check(!threw, 'testMembers passes' + (threw ? ': ' + threw.message : ''));
  check(w.ctx.inboxTitle_({ name: 'TEST Kansai' }) === 'TEST Kansai Inbox (beta)', 'test inbox title never ends in "Trip Inbox"');
  // unexpected API error -> reference code + Error log row; expected errors are not logged
  w.ctx.openTrip = function () { throw new Error('boom'); };
  w.ctx.API_FNS.openTrip = a => w.ctx.openTrip();
  const r = JSON.parse(w.ctx.doPost({ postData: { contents: JSON.stringify({ fn: 'openTrip', args: ['t-one', '', {}] }) } }).text);
  check(r.ok === false && r.error === 'error' && /^JF-[A-Z2-9]{6}$/.test(r.ref || ''), 'API error returns a reference code (' + r.ref + ')');
  check(w.files[mid].tabs['Error log'].some(x => x[1] === r.ref && x[2] === 'openTrip' && x[3] === 't-one'), 'the error is in the Error log with fn and trip');
  const logged = w.files[mid].tabs['Error log'].length;
  const r2 = JSON.parse(w.ctx.doPost({ postData: { contents: JSON.stringify({ fn: 'getInbox', args: ['t-one', '9999'] }) } }).text);
  check(r2.error === 'wrong' && !r2.ref && w.files[mid].tabs['Error log'].length === logged, 'a wrong PIN is not logged as an error');
}

// 3. Live backend: inbox title unchanged, testMembers refuses to run
{
  const w = makeWorld({});
  tripsSheet(w, false);
  check(w.ctx.inboxTitle_({ name: 'Kansai' }) === 'Kansai Trip Inbox', 'live inbox title unchanged');
  let threw = null;
  try { w.ctx.testMembers(); } catch (e) { threw = e; }
  check(!!threw && !w.props.MEMBERS_SHEET, 'testMembers refuses to run on the live backend');
  w.ctx.warmUp();
  check(!w.props.MEMBERS_SHEET, 'warmUp never creates the Members sheet');
}

console.log(fails ? '\n' + fails + ' failed' : '\nall passed');
process.exit(fails ? 1 : 0);
