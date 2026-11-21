// Runs the Apps Script backend (app/appscript/*.js) in Node against in-memory fakes of Google's services.
// No network, no real files: checks the Trips sheet reading, the Members sheet, sessions, the error log
// the test-inbox naming, changes since this morning and group votes. Run: node tests/backend_test.js
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
          const box = /^([A-Z]+)(\d+):([A-Z]+)(\d+)$/.exec(a1);
          if (box) return { values: rows.slice(Number(box[2]) - 1, Number(box[4])).map(r => r.slice(colIndex(box[1]), colIndex(box[3]) + 1)) };
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

// 4. Changes since this morning (Changes.js): snapshot per trip per day in script property SNAP_<key>
{
  const w = makeWorld({});
  const trip = { key: 't-one', tz: 'Asia/Tokyo' };
  const item = (time, name, extra) => Object.assign({ time, name, kind: 'Activity', info: [], details: [], notes: [], backups: [] }, extra || {});
  const mk = (items, exp) => ({ plan: { days: [{ date: '2026-11-16', items }] }, expenses: { recent: exp || [] } });
  const morning = mk([item('12:30', 'Lunch at Seaside Cafe'), item('14:00', 'Hello Kitty Show Box'), item('18:00', 'Kobe Gyu Ramen'), item('20:00', 'Night walk')],
    [{ date: '16 Nov 2026', desc: 'Petrol', amount: 6130, currency: 'JPY', paid_by: 'TMN' }]);
  let c = w.ctx.applyChanges_(trip, JSON.parse(JSON.stringify(morning)), '2026-11-16', '07:05');
  check(c.list.length === 0 && !!w.props['SNAP_t-one'], 'first read of the day keeps a snapshot and shows no changes');
  check(w.props['SNAP_t-one'].length < 2000, 'snapshot is small (' + w.props['SNAP_t-one'].length + ' bytes)');
  const later = mk([item('12:30', 'Lunch at Seaside Cafe', { notes: [{ segs: [{ t: 'Window seats' }] }] }), item('14:00', 'Strawberry farm'), item('19:00', 'Kobe Gyu Ramen'), item('21:00', 'Onsen')],
    [{ date: '16 Nov 2026', desc: 'Petrol', amount: 6130, currency: 'JPY', paid_by: 'TMN' }, { date: '16 Nov 2026', desc: 'Lunch', amount: 3200, currency: 'JPY', paid_by: 'KA' }]);
  c = w.ctx.applyChanges_(trip, JSON.parse(JSON.stringify(later)), '2026-11-16', '10:12');
  const kinds = c.list.map(x => x.kind).sort().join(',');
  check(kinds === 'added,edited,expense,moved,removed,replaced', 'moved, edited, replaced, added, removed and expense are found (' + kinds + ')');
  const mv = c.list.find(x => x.kind === 'moved');
  check(mv && mv.text === 'Kobe Gyu Ramen moved 18:00 → 19:00' && mv.at === '10:12', 'a move reads "moved 18:00 → 19:00" and is stamped 10:12');
  check(c.list.find(x => x.kind === 'expense').text === 'JPY 3,200 Lunch logged, paid by KA', 'a new expense is listed');
  c = w.ctx.applyChanges_(trip, JSON.parse(JSON.stringify(later)), '2026-11-16', '11:30');
  check(c.list.every(x => x.at === '10:12'), 'a change keeps the time it was first seen');
  c = w.ctx.applyChanges_(trip, JSON.parse(JSON.stringify(morning)), '2026-11-16', '12:00');
  check(c.list.length === 0, 'undoing the edits clears the list');
  c = w.ctx.applyChanges_(trip, JSON.parse(JSON.stringify(later)), '2026-11-17', '07:00');
  check(c.list.length === 0, 'the next morning starts clean');
  // a broken property never stops the trip from opening
  w.props['SNAP_t-one'] = '{not json';
  const d = JSON.parse(JSON.stringify(later));
  w.ctx.addChanges_(trip, d);
  check(d.changes && d.changes.list.length === 0, 'a damaged snapshot is replaced, the read still works');
}

// 5. Group votes (Votes.js): the request waits in the inbox as Voting; most votes wins; a tie waits for the organiser
{
  const w = makeWorld({ APP_ENV: 'test' });
  tripsSheet(w, false);
  w.ctx.setupMembers();
  const mid = w.props.MEMBERS_SHEET, M = w.files[mid].tabs;
  M['Trip settings'].push(['t-one', 'Organiser name', 'TMN', '', '']);
  w.ctx.postInbox('t-one', '1111', 'MW', 'Lunch 2000 yen paid by MW', 0);
  let r = JSON.parse(w.ctx.startVote('t-one', '1111', 'KA', 'Swap dinner for sushi', 'hour'));
  const inbox = w.files[w.props['INBOX_t-one']].tabs.Inbox;
  const row = r.inbox.find(m => m.text === 'Swap dinner for sushi');
  check(row && row.status === 'Voting' && /voting until/.test(row.reply), 'the request lands in the inbox as Voting');
  check(M.Votes[0].includes('Inbox row') && M.Ballots[0].includes('Name') && M.Votes[0].indexOf('Inbox row') === 9, '"Inbox row" and "Name" columns are added at the end');
  const vid = r.vote;
  const col = h => M.Votes[0].indexOf(h), vrow = id => M.Votes.find(x => x[0] === id);
  check(Number(vrow(vid)[col('Inbox row')]) === row.row, 'the vote points at its inbox row');
  w.ctx.castVote('t-one', '1111', vid, 'KA', 1);
  w.ctx.castVote('t-one', '1111', vid, 'KA', 0);  // changed their mind: replaces the first ballot
  w.ctx.castVote('t-one', '1111', vid, 'TMN', 0);
  let g = JSON.parse(w.ctx.castVote('t-one', '1111', vid, 'MW', 1));
  const gv = g.votes.find(v => v.id === vid);
  check(gv.counts.join() === '2,1' && gv.voters.length === 3 && g.organiser === 'TMN', 'votes are counted, one per name (' + gv.counts.join() + ')');
  w.ctx.closeVotes();
  check(vrow(vid)[col('Status')] === 'Open' && inbox[row.row - 1][3] === 'Voting', 'a vote stays open until its closing time');
  vrow(vid)[col('Closes')] = new Date(Date.now() - 60e3).toISOString();
  w.ctx.closeVotes();
  check(vrow(vid)[col('Status')] === 'Decided', 'the trigger closes a vote on time');
  check(inbox[row.row - 1][3] === 'Waiting' && inbox[row.row - 1][4] === 'Group vote: 2 yes, 1 no.', 'yes wins: the inbox row becomes Waiting for the next run');
  check(inbox[1][3] === 'Waiting' && inbox[1][4] === '' && inbox[1][2] === 'Lunch 2000 yen paid by MW', 'other inbox rows are untouched');
  const late = JSON.parse(w.ctx.doPost({ postData: { contents: JSON.stringify({ fn: 'castVote', args: ['t-one', '1111', vid, 'KA', 1] }) } }).text);
  check(late.ok === false && late.error === 'closed', 'voting after the close is refused ("closed")');
  // a tie
  r = JSON.parse(w.ctx.startVote('t-one', '1111', 'MW', 'Skip the aquarium', 'tonight'));
  const tid = r.vote, trow = r.inbox.find(m => m.text === 'Skip the aquarium').row;
  w.ctx.castVote('t-one', '1111', tid, 'KA', 0);
  w.ctx.castVote('t-one', '1111', tid, 'MW', 1);
  vrow(tid)[col('Closes')] = new Date(Date.now() - 60e3).toISOString();
  g = JSON.parse(w.ctx.getVotes('t-one', '1111'));
  check(g.votes.find(v => v.id === tid).status === 'Tie' && inbox[trow - 1][3] === 'Voting' && /organiser decides/.test(inbox[trow - 1][4]),
    'a tie waits for the organiser (inbox row stays Voting)');
  let threw = null;
  try { w.ctx.decideVote('t-one', '1111', tid, 'KA', 0); } catch (e) { threw = e; }
  check(threw && /wrong/.test(threw.message) && vrow(tid)[col('Status')] === 'Tie', 'only the organiser can decide a tie');
  w.ctx.decideVote('t-one', '1111', tid, 'TMN', 1);
  check(vrow(tid)[col('Status')] === 'Decided' && inbox[trow - 1][3] === 'Skipped' && /TMN decided the tie/.test(inbox[trow - 1][4]),
    'the organiser\'s pick closes it: no wins, the row becomes Skipped');
  threw = null;
  try { w.ctx.startVote('t-one', '9999', 'KA', 'x', 'hour'); } catch (e) { threw = e; }
  check(threw && /wrong/.test(threw.message), 'votes need the trip PIN');
}

console.log(fails ? '\n' + fails + ' failed' : '\nall passed');
process.exit(fails ? 1 : 0);
