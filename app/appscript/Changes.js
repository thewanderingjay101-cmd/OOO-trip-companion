/**
 * Changes since this morning (upgrade task 13).
 *
 * The first time a trip is read on a new day (in the trip's time zone), its parsed plan and expense rows are
 * kept as that morning's snapshot. Every later fresh read compares against it and lists what changed:
 * a stop moved to another time, added, removed, replaced at the same time, or edited, and expenses logged.
 * Each change carries the time it was first seen, so the page can tag the card "Changed 10:12".
 * The next day starts clean with a new snapshot.
 *
 * Storage: one script property per trip, SNAP_<key> = {date, days, exp, seen}. Only short fingerprints are
 * kept (a few KB for a 10-day trip), never the doc's text. It is written only when the day rolls over or a
 * new change is first seen, never on an ordinary read. Runs inside getTripData_ after a fresh read, so it
 * never slows down opening from the cache, and any error here is swallowed (the trip still opens).
 */
var SNAP_MAX = 8500;  // script property values are capped at 9 KB

/** FNV-1a, 32 bit, as 6 base-36 characters: enough to notice an edit, small enough to store. */
function snapHash_(s) {
  var h = 0x811c9dc5;
  s = String(s);
  for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0; }
  return ('00000' + h.toString(36)).slice(-6);
}

/** What a stop looks like, without its time (a time change is reported as a move, not an edit). */
function snapItemHash_(it) {
  var c = {};
  Object.keys(it).forEach(function (k) { if (k !== 'time') c[k] = it[k]; });
  return snapHash_(JSON.stringify(c));
}

function snapExpHash_(x) {
  return snapHash_([x.date, x.desc, x.amount, x.currency, x.paid_by].join('|'));
}

/** The compact fingerprint of a trip's data: per day, each stop's name, time and content hash; each expense row's hash. */
function snapOf_(data) {
  var days = {};
  ((data.plan && data.plan.days) || []).forEach(function (d) {
    days[d.date] = (d.items || []).map(function (it) { return [String(it.name || '').slice(0, 60), it.time || '', snapItemHash_(it)]; });
  });
  var exp = ((data.expenses && data.expenses.recent) || []).map(snapExpHash_);
  return { days: days, exp: exp };
}

/**
 * Compares the current data with the morning snapshot. Returns a list of
 * {date, name, kind: moved|added|removed|replaced|edited|expense, text, from?, to?}.
 */
function diffSnap_(base, data) {
  var out = [];
  ((data.plan && data.plan.days) || []).forEach(function (d) {
    var before = (base.days[d.date] || []).map(function (b) { return { n: b[0], t: b[1], h: b[2], used: false }; });
    var free = [];
    (d.items || []).forEach(function (it) {
      var n = String(it.name || '').slice(0, 60), h = snapItemHash_(it);
      var m = before.filter(function (b) { return !b.used && b.n === n && b.t === (it.time || ''); })[0] ||
        before.filter(function (b) { return !b.used && b.n === n; })[0];
      if (!m) { free.push(it); return; }
      m.used = true;
      if (m.t !== (it.time || '')) out.push({ date: d.date, name: it.name, kind: 'moved', from: m.t, to: it.time || '',
        text: it.name + ' moved ' + (m.t || 'no time') + ' → ' + (it.time || 'no time') });
      else if (m.h !== h) out.push({ date: d.date, name: it.name, kind: 'edited', text: it.name + ' updated' });
    });
    var gone = before.filter(function (b) { return !b.used; });
    free.forEach(function (it) {
      // a new stop at the time an old one had: the old one was swapped for it
      var old = gone.filter(function (b) { return !b.used && b.t && b.t === (it.time || ''); })[0];
      if (old) { old.used = true; out.push({ date: d.date, name: it.name, kind: 'replaced', from: old.n, text: it.name + ' instead of ' + old.n }); }
      else out.push({ date: d.date, name: it.name, kind: 'added', text: it.name + ' added' + (it.time ? ' at ' + it.time : '') });
    });
    gone.filter(function (b) { return !b.used; }).forEach(function (b) {
      out.push({ date: d.date, name: b.n, kind: 'removed', text: b.n + ' removed' });
    });
  });
  if (base.exp) {
    var had = {};
    base.exp.forEach(function (h) { had[h] = (had[h] || 0) + 1; });
    ((data.expenses && data.expenses.recent) || []).forEach(function (x) {
      var h = snapExpHash_(x);
      if (had[h]) { had[h]--; return; }
      var amt = x.amount ? String(x.currency || '') + ' ' + Number(x.amount).toLocaleString('en-US', { maximumFractionDigits: 2 }) : '';
      out.push({ date: null, name: x.desc, kind: 'expense',
        text: (amt ? amt.trim() + ' ' : '') + (x.desc || 'Expense') + ' logged' + (x.paid_by ? ', paid by ' + x.paid_by : '') });
    });
  }
  return out;
}

function snapKey_(c) { return [c.kind, c.date || '', c.name, c.to || c.from || ''].join('|'); }

/**
 * Adds data.changes = {since, list} for the page. today: 'yyyy-MM-dd', now: 'HH:mm', both in the trip's time zone
 * (passed in so the test can fix them). Keeps or replaces the morning snapshot in script property SNAP_<key>.
 */
function applyChanges_(trip, data, today, now) {
  var props = PropertiesService.getScriptProperties(), pk = 'SNAP_' + trip.key;
  var snap = null;
  try { snap = JSON.parse(props.getProperty(pk) || 'null'); } catch (e) { snap = null; }
  if (!snap || snap.date !== today || !snap.days) {
    snap = snapOf_(data);
    snap.date = today; snap.seen = {};
    var js = JSON.stringify(snap);
    if (js.length > SNAP_MAX) { snap.exp = null; js = JSON.stringify(snap); }  // very long expense list: plan changes only
    if (js.length <= SNAP_MAX) props.setProperty(pk, js);
    data.changes = { since: today, list: [] };
    return data.changes;
  }
  var list = diffSnap_(snap, data), seen = {}, dirty = false;
  list.forEach(function (c) {
    var k = snapKey_(c);
    c.at = (snap.seen || {})[k] || now;
    seen[k] = c.at;
    if (!(snap.seen || {})[k]) dirty = true;
  });
  // a change that was undone drops out of the list (and out of seen)
  if (Object.keys(snap.seen || {}).some(function (k) { return !(k in seen); })) dirty = true;
  if (dirty) {
    snap.seen = seen;
    var s = JSON.stringify(snap);
    if (s.length <= SNAP_MAX) props.setProperty(pk, s);
  }
  data.changes = { since: today, list: list };
  return data.changes;
}

/** Wrapper used by getTripData_: the trip's own time zone, and never fails the read. */
function addChanges_(trip, data) {
  try {
    var tz = trip.tz || 'Asia/Singapore', d = new Date();
    applyChanges_(trip, data, Utilities.formatDate(d, tz, 'yyyy-MM-dd'), Utilities.formatDate(d, tz, 'HH:mm'));
  } catch (err) {
    console.error('Changes for ' + trip.key + ': ' + (err && err.message));
  }
}
