/**
 * Group votes in the app (upgrade task 14).
 *
 * "Ask the group first" in the chat bar starts a yes / no vote on a request instead of sending it straight to
 * the inbox. The request still lands in the trip inbox, with Status "Voting", so the scheduled run leaves it
 * alone. When the vote closes, most votes wins:
 *   - Yes wins: the inbox row becomes "Waiting" (the next run applies it), Reply says how the vote went.
 *   - No wins: the inbox row becomes "Skipped" ("Not done" in the app), Reply says the group kept the plan.
 *   - A tie (or nobody voted): the inbox row becomes "Needs JY" and the organiser decides it from the inbox, by
 *     setting its Status to Waiting (do it) or Skipped (keep the plan). The app never lets a name decide a tie: the
 *     trip PIN is shared, so a name picked on a phone can't prove who is holding it (until email sign-in, task 7).
 * Votes close at their time when anyone opens the trip (getVotes) and from the closeVotes trigger
 * (Triggers > closeVotes, time-driven, every 5 or 10 minutes) for when nobody does.
 *
 * Storage: the app's own Members sheet, tabs Votes and Ballots (columns matched by name; the extra columns
 * "Inbox row" on Votes and "Name" on Ballots are added at the end the first time they are needed). Until email
 * sign-in (task 7) people are known by the name picked (once, then locked) in "Who are you?" on their phone,
 * as for the inbox. No inbox column changes.
 */
var VOTE_OPTIONS = ['Yes, do it', 'No, keep the plan'];
var VOTE_KEEP_MS = 2 * 864e5;  // closed votes stay on Group for 2 days

/** Adds missing columns at the end of a Members tab's header row. Never moves or renames a column. */
function membersEnsureCols_(tab, cols) {
  var cache = CacheService.getScriptCache(), ck = 'cols-' + tab + '-' + cols.join('|');
  if (cache.get(ck)) return;
  var id = membersId_(true);
  var head = ((Sheets.Spreadsheets.Values.get(id, "'" + tab + "'!1:1").values || [[]])[0] || []).map(String);
  var missing = cols.filter(function (c) { return head.indexOf(c) < 0; });
  if (missing.length) {
    var col = head.length;  // first empty header cell
    Sheets.Spreadsheets.Values.update({ values: [missing] }, id, "'" + tab + "'!" + String.fromCharCode(65 + col) + '1',
      { valueInputOption: 'RAW' });
  }
  cache.put(ck, '1', 21600);
}

function votesReady_() {
  membersEnsureCols_('Votes', ['Inbox row']);
  membersEnsureCols_('Ballots', ['Name']);
}

function cleanName_(s) { return String(s || '').replace(/\s+/g, ' ').trim().slice(0, 40); }

/** When a vote closes: 'hour' (in an hour), 'tonight' (22:00 trip time, or an hour from now if that is sooner
 * than an hour away), 'tomorrow' (9:00 tomorrow, before the first scheduled run). */
function voteCloses_(trip, choice, now) {
  now = now || new Date();
  var tz = trip.tz || 'Asia/Singapore';
  var hour = new Date(now.getTime() + 3600e3);
  if (choice === 'hour') return hour;
  var today = Utilities.formatDate(now, tz, 'yyyy-MM-dd');
  function at(dateStr, hm) {
    // the instant that is dateStr hm in the trip's time zone
    var guess = new Date(dateStr + 'T' + hm + ':00Z');
    var shown = Utilities.formatDate(guess, tz, "yyyy-MM-dd'T'HH:mm");
    var diff = new Date(shown + ':00Z').getTime() - guess.getTime();
    return new Date(guess.getTime() - diff);
  }
  if (choice === 'tomorrow') {
    var t = new Date(new Date(today + 'T12:00:00Z').getTime() + 864e5).toISOString().slice(0, 10);
    return at(t, '09:00');
  }
  var tonight = at(today, '22:00');
  return tonight.getTime() - now.getTime() < 3600e3 ? hour : tonight;
}

function voteRows_(tripKey) {
  return membersRows_('Votes').filter(function (v) { return !tripKey || v.Trip === tripKey; });
}

/** Counts per option for a vote, and who voted what (latest ballot per name). */
function tally_(voteId, ballots) {
  var by = {};
  ballots.filter(function (b) { return b.Vote === voteId; }).forEach(function (b) { by[b.Name || b.Email] = b; });
  var counts = VOTE_OPTIONS.map(function () { return 0; }), voters = [];
  Object.keys(by).forEach(function (n) {
    var c = Number(by[n].Choice);
    if (c >= 0 && c < counts.length) { counts[c]++; voters.push({ name: n, choice: c }); }
  });
  return { counts: counts, voters: voters };
}

function setInboxRow_(trip, row, status, reply) {
  var id = inboxId_(trip, false);
  row = Number(row);
  if (!id || !(row >= 2)) return;
  // only Status and Reply of that one row; check it is still the vote's row first
  var cur = (Sheets.Spreadsheets.Values.get(id, 'Inbox!D' + row + ':D' + row).values || [[]])[0][0];
  if (String(cur || '').toLowerCase() !== 'voting') return;
  Sheets.Spreadsheets.Values.update({ values: [[status, reply]] }, id, 'Inbox!D' + row + ':E' + row, { valueInputOption: 'RAW' });
}

function countText_(counts) { return counts[0] + ' yes, ' + counts[1] + ' no'; }

/** Closes one vote with a winner (0 yes, 1 no) and passes the outcome to the inbox row. */
function finishVote_(trip, v, winner, counts) {
  membersUpdate_('Votes', v._row, { 'Status': 'Decided', 'Result': VOTE_OPTIONS[winner] });
  if (winner === 0) setInboxRow_(trip, v['Inbox row'], 'Waiting', 'Group vote: ' + countText_(counts) + '.');
  else setInboxRow_(trip, v['Inbox row'], 'Skipped', 'The group kept the plan (' + countText_(counts) + ').');
}

/** Closes every open vote whose time has passed (all trips, or one). Returns how many it closed. */
function closeDueVotes_(tripKey, now) {
  now = now || new Date();
  var due = voteRows_(tripKey).filter(function (v) { return v.Status === 'Open' && new Date(v.Closes).getTime() <= now.getTime(); });
  if (!due.length) return 0;
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var ballots = membersRows_('Ballots'), trips = getTrips_();
    due.forEach(function (v) {
      var trip = trips.filter(function (t) { return t.key === v.Trip; })[0];
      if (!trip) return;
      var t = tally_(v.Vote, ballots), c = t.counts;
      if (c[0] !== c[1]) finishVote_(trip, v, c[0] > c[1] ? 0 : 1, c);
      else {
        membersUpdate_('Votes', v._row, { 'Status': 'Tie', 'Result': '' });
        setInboxRow_(trip, v['Inbox row'], 'Needs JY', 'Group vote tied (' + countText_(c) + '). The organiser decides: Status Waiting does it, Skipped keeps the plan.');
      }
    });
  } finally { lock.releaseLock(); }
  return due.length;
}

/** A tie is decided in the inbox: once its row is no longer "Needs JY", the vote takes that outcome. */
function settleTies_(trip, votes) {
  var ties = votes.filter(function (v) { return v.Status === 'Tie' && Number(v['Inbox row']) >= 2; });
  var id = ties.length && inboxId_(trip, false);
  if (!id) return;
  var rows = (Sheets.Spreadsheets.Values.get(id, 'Inbox!D1:D').values || []);
  ties.forEach(function (v) {
    var st = String((rows[Number(v['Inbox row']) - 1] || [])[0] || '').trim().toLowerCase();
    var yes = st === 'waiting' || st === 'done';
    if (!yes && st !== 'skipped' && st !== 'not done') return;  // still Needs JY (or anything else): leave it
    v.Status = 'Decided'; v.Result = VOTE_OPTIONS[yes ? 0 : 1] + ' (organiser decided the tie)';
    membersUpdate_('Votes', v._row, { 'Status': v.Status, 'Result': v.Result });
  });
}

/** Trigger: Triggers > Add trigger > closeVotes, time-driven, every 5 or 10 minutes. */
function closeVotes() {
  try { closeDueVotes_(null); } catch (err) { logError_(err, { fn: 'closeVotes' }); }
}

/** The trip's votes for the page: open ones, ties and those closed in the last 2 days. */
function getVotes(key, cred) {
  var trip = checkAccess_(key, cred);
  if (!membersId_(false)) return JSON.stringify({ votes: [] });
  votesReady_();
  closeDueVotes_(trip.key);
  var ballots = membersRows_('Ballots'), now = Date.now(), rows = voteRows_(trip.key);
  try { settleTies_(trip, rows); } catch (err) { console.error('settleTies: ' + err.message); }
  var votes = rows.filter(function (v) {
    return v.Status === 'Open' || v.Status === 'Tie' || now - new Date(v.Closes).getTime() < VOTE_KEEP_MS;
  }).map(function (v) {
    var t = tally_(v.Vote, ballots);
    return { id: v.Vote, question: v.Question, by: v['Created by'], created: v.Created, closes: v.Closes,
      status: v.Status, result: v.Result, row: Number(v['Inbox row']) || 0, options: VOTE_OPTIONS, counts: t.counts, voters: t.voters };
  });
  return JSON.stringify({ votes: votes });
}

/** "Ask the group first": the request goes to the inbox as Voting, and a vote opens. closes: hour | tonight | tomorrow. */
function startVote(key, cred, from, text, closes) {
  var trip = checkAccess_(key, cred);
  from = cleanName_(from);
  text = String(text || '').trim().slice(0, 1500);
  if (!from || !text) throw new Error('empty');
  var cache = CacheService.getScriptCache(), rk = 'inbox-rate-' + trip.key;
  var n = Number(cache.get(rk) || 0);
  if (n >= 60) throw new Error('busy');
  cache.put(rk, String(n + 1), 600);
  var when = voteCloses_(trip, ['hour', 'tonight', 'tomorrow'].indexOf(closes) > -1 ? closes : 'tonight');
  var id = inboxId_(trip, true);
  var now = Utilities.formatDate(new Date(), trip.tz, 'yyyy-MM-dd HH:mm');
  var res = Sheets.Spreadsheets.Values.append({ values: [[now, from, text, 'Voting', 'The group is voting until ' +
    Utilities.formatDate(when, trip.tz, 'EEE d MMM HH:mm') + '.', '', '']] }, id, 'Inbox!A:G',
    { valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS' });
  var m = /![A-Z]+(\d+)/.exec((res && res.updates && res.updates.updatedRange) || '');
  var row = m ? Number(m[1]) : inboxRows_(id).filter(function (r) { return r.text === text && r.from === from; }).pop().row;
  membersId_(true);
  votesReady_();
  var vid = 'V' + Utilities.getUuid().replace(/-/g, '').slice(0, 10).toUpperCase();
  membersAppend_('Votes', { 'Vote': vid, 'Trip': trip.key, 'Question': text, 'Options': JSON.stringify(VOTE_OPTIONS),
    'Created by': from, 'Created': new Date().toISOString(), 'Closes': when.toISOString(), 'Status': 'Open', 'Result': '', 'Inbox row': row });
  return JSON.stringify({ inbox: inboxRows_(id).slice(-150), vote: vid });
}

/** One person's vote (changing it replaces the earlier one) while the vote is open. */
function castVote(key, cred, voteId, name, choice) {
  var trip = checkAccess_(key, cred);
  name = cleanName_(name);
  choice = Number(choice);
  if (!name || !(choice === 0 || choice === 1)) throw new Error('empty');
  votesReady_();
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var v = voteRows_(trip.key).filter(function (x) { return x.Vote === String(voteId); })[0];
    if (!v || v.Status !== 'Open' || new Date(v.Closes).getTime() <= Date.now()) throw new Error('closed');
    var mine = membersRows_('Ballots').filter(function (b) { return b.Vote === v.Vote && b.Name === name; })[0];
    if (mine) membersUpdate_('Ballots', mine._row, { 'Choice': choice, 'Time': new Date().toISOString() });
    else membersAppend_('Ballots', { 'Vote': v.Vote, 'Name': name, 'Choice': choice, 'Time': new Date().toISOString() });
  } finally { lock.releaseLock(); }
  return getVotes(key, cred);
}
