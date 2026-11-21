/**
 * Kansai phone view: turns the itinerary Google Doc (Docs API JSON) and the
 * expense sheet's displayed values into the data the page renders.
 * Read-only. Same logic as build_data.py; runs in Apps Script and in Node.
 */
var TYPE_WORDS = {
  'activity': 'Activity', 'activity (confirmed)': 'Activity', 'activity / shopping': 'Shopping',
  'lunch': 'Meal', 'dinner': 'Meal', 'breakfast': 'Meal', 'snack': 'Snack', 'coffee': 'Snack'
};
var MEAL_LABEL = { lunch: 'Lunch', dinner: 'Dinner', breakfast: 'Breakfast', snack: 'Snack', coffee: 'Coffee' };
var WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
var MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
var MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };

function kv_clean(s) {
  return String(s).replace(/\u000b/g, ' ').replace(/\s+/g, ' ').trim();
}

function kv_paraInfo(p) {
  var segs = [], links = [];
  var boldChars = 0, italChars = 0, total = 0;
  var leadBold = '', leadOpen = true;
  (p.elements || []).forEach(function (e) {
    var tr = e.textRun;
    if (!tr) return;
    var txt = tr.content || '';
    var st = tr.textStyle || {};
    var url = (st.link || {}).url || null;
    var n = txt.trim().length;
    total += n;
    if (st.bold) boldChars += n;
    if (leadOpen) {
      if (st.bold) leadBold += txt;
      else if (txt.trim()) leadOpen = false;
    }
    if (st.italic) italChars += n;
    var t = txt.replace(/\n/g, '').replace(/\u000b/g, ' ');
    if (url) links.push({ text: kv_clean(t), url: url });
    var last = segs[segs.length - 1];
    if (last && (last.u || null) === url) last.t += t;
    else segs.push(url ? { t: t, u: url } : { t: t });
  });
  var text = kv_clean(segs.map(function (s) { return s.t; }).join(''));
  segs = segs.filter(function (s) { return s.t !== ''; });
  segs.forEach(function (s) { s.t = s.t.replace(/\s+/g, ' '); if (!s.u) delete s.u; });
  if (segs.length) {
    segs[0].t = segs[0].t.replace(/^\s+/, '');
    segs[segs.length - 1].t = segs[segs.length - 1].t.replace(/\s+$/, '');
  }
  return {
    text: text,
    bold: total > 0 && boldChars >= total * 0.9,
    lead_bold: kv_clean(leadBold),
    bold_ratio: total ? boldChars / total : 0,
    italic: total > 0 && italChars >= total * 0.9,
    links: links,
    segs: segs,
    lv: p.bullet ? (p.bullet.nestingLevel || 0) : -1
  };
}

// Copy list structure onto a line: bullet level (when bulleted) and a blank line before it (gap).
function kv_shape(line, p) {
  if (p.lv >= 0) line.lv = p.lv;
  if (p.gap) line.gap = true;
  return line;
}

function kv_cellParas(cell) {
  var out = [], gap = false;
  (cell.content || []).forEach(function (el) {
    if (el.paragraph) {
      var pi = kv_paraInfo(el.paragraph);
      if (pi.text) { if (gap && out.length) pi.gap = true; out.push(pi); gap = false; }
      else gap = true;
    }
  });
  return out;
}

function kv_splitLabel(text) {
  var m = text.match(/^([A-Za-z][A-Za-z /&']{1,40}?):\s*(.*)$/);
  if (m) return [m[1].trim(), m[2].trim()];
  return [null, text];
}

function kv_bookingStatus(texts) {
  var blob = texts.join(' ');
  var up = blob.toUpperCase();
  if (blob.indexOf('TO BOOK') > -1) return 'to_book';
  if (/\bBOOKED\b|\bCONFIRMED\b/.test(up)) return 'booked';
  if (/reservation required|reservations required/i.test(blob)) return 'to_book';
  if (/reservations? (recommended|accepted)|reservable|bookable|online via|phone reservations/i.test(blob)) return 'bookable';
  if (/walk-in/i.test(blob)) return 'walk_in';
  return null;
}

function kv_inferKind(name, typeWord) {
  var n = name.toLowerCase();
  if (typeWord) return TYPE_WORDS[typeWord.toLowerCase()] || 'Activity';
  if (n.indexOf('drive') === 0 || n.indexOf('leave') === 0 || n.indexOf('depart kobe') === 0 || n.indexOf('return car') > -1 || n.indexOf('collect car') > -1) return 'Drive';
  if (n.indexOf('departure') > -1 || n.indexOf('arrival') > -1) return 'Flight';
  if (n.indexOf('check-in') > -1 || n.indexOf('check-out') > -1) return 'Hotel';
  if (n.indexOf('breakfast') > -1 || n.indexOf('lunch') > -1 || n.indexOf('dinner') > -1) return 'Meal';
  return 'Activity';
}

function kv_parseActivity(paras) {
  var item = { type_word: null, name: '', info: [], details: [], backups: [] };
  var cur = item, idx = 0;
  if (paras.length && paras[0].bold && TYPE_WORDS.hasOwnProperty(paras[0].text.toLowerCase().replace(/:+$/, ''))) {
    item.type_word = paras[0].text.replace(/:+$/, '');
    idx = 1;
  }
  paras.slice(idx).forEach(function (p) {
    var t = p.text;
    if (/^backup\b/i.test(p.lead_bold)) {
      var nm = p.lead_bold.replace(/^backup\s*\d*\s*:?\s*/i, '').trim();
      var rest = t.indexOf(p.lead_bold) === 0 ? kv_clean(t.slice(p.lead_bold.length)) : '';
      if (!nm) { nm = rest; rest = ''; }
      cur = { name: nm, info: [], details: [] };
      if (rest) cur.details.push(kv_shape({ segs: [{ t: rest.replace(/^[, ]+/, '') }] }, p));
      item.backups.push(cur);
      return;
    }
    if (!cur.name && (p.bold || (p.lead_bold && p.bold_ratio >= 0.4))) {
      cur.name = p.bold ? t : p.lead_bold;
      var extra = p.bold ? '' : kv_clean(t.slice(p.lead_bold.length));
      if (extra) cur.details.push(kv_shape({ segs: [{ t: extra }] }, p));
      return;
    }
    if (p.italic) {
      var lv = kv_splitLabel(t);
      cur.info.push({ label: lv[0], value: lv[1], segs: p.segs });
      return;
    }
    if (p.bold) { cur.details.push(kv_shape({ heading: true, segs: p.segs }, p)); return; }
    cur.details.push(kv_shape({ segs: p.segs }, p));
  });
  item.backups.forEach(function (b) {
    if (!b.name && b.details.length) b.name = b.details.shift().segs.map(function (s) { return s.t; }).join('');
  });
  return item;
}

// Travel line in the notes cell: "Drive: 25 mins" (own car) or "Grab: 10 mins" / "Taxi: 10 mins" (no car)
var TRAVEL_RE = /^(Drive|Grab|Taxi)( from [^:]+)?:/;

function kv_parseNotes(paras) {
  var drive = null, mode = null, lines = [];
  paras.forEach(function (p) {
    var t = p.text;
    if (drive === null && TRAVEL_RE.test(t)) {
      mode = t.match(TRAVEL_RE)[1];
      drive = t.split(':').slice(1).join(':').replace(/\(Google Maps\)/g, '').replace(/^[\s,]+|[\s,]+$/g, '');
      drive = drive.replace(/\s+/g, ' ').replace(/\s+([,.])/g, '$1').replace(/\.+$/, '');
    }
    lines.push(kv_shape({ segs: p.segs, bold: p.bold, italic: p.italic }, p));
  });
  return [drive, lines, mode];
}

// "For: 12 Nov lunch (backup to X); 14 Nov dinner" -> [{date: '12 Nov', meal: 'lunch'}, ...]; "For: general" -> []
function kv_forTags(value) {
  var out = [];
  String(value || '').split(';').forEach(function (part) {
    var m = part.trim().match(/^(\d{1,2})\s+([A-Za-z]{3})[A-Za-z]*\.?\s*(breakfast|lunch|dinner|snack|coffee)?/i);
    var note = (part.match(/\(([^)]*)\)/) || [])[1] || '';
    if (m) out.push({ date: m[1] + ' ' + m[2].charAt(0).toUpperCase() + m[2].slice(1, 3).toLowerCase(), meal: (m[3] || '').toLowerCase(), note: note.trim() });
  });
  return out;
}

// Back-up Food List entries tagged "For: <date> <meal>" join that meal's backups, so they show on its card.
function kv_attachBackups(days, backupFood) {
  backupFood.forEach(function (b) {
    (b['for'] || []).forEach(function (tag) {
      var day = days.filter(function (d) { return d.label === tag.date; })[0];
      if (!day) return;
      var meals = day.items.filter(function (it) { return it.kind === 'Meal' || it.kind === 'Snack'; });
      var it = meals.filter(function (x) { return tag.meal && (x.meal || '').toLowerCase() === tag.meal; })[0] || (tag.meal ? null : meals[0]);
      if (!it) return;
      var line = [];
      b.links.forEach(function (l, k) { if (k) line.push({ t: ' / ' }); line.push({ t: l.text, u: l.url }); });
      it.backups.push({ name: b.name, info: b.info, details: line.length ? [{ segs: line }] : [],
        status: kv_bookingStatus([b.name].concat(b.info.map(function (i) { return i.value; }))), listed: true,
        earlier: /earlier pick/i.test(tag.note || '') });
    });
  });
}

function kv_mapsLink(item) {
  for (var i = 0; i < item.details.length; i++) {
    var segs = item.details[i].segs;
    for (var j = 0; j < segs.length; j++) {
      var u = segs[j].u || '';
      if (u.indexOf('google.com/maps') > -1 && u.indexOf('/dir') === -1 && u.indexOf('reserve') === -1) return u;
    }
  }
  return null;
}

function kv_directionsLink(lines) {
  for (var i = 0; i < lines.length; i++) {
    for (var j = 0; j < lines[i].segs.length; j++) {
      var u = lines[i].segs[j].u || '';
      if (u.indexOf('google.com/maps/dir') > -1) return u;
    }
  }
  return null;
}

function kv_segsText(segs) { return segs.map(function (s) { return s.t; }).join(''); }

function parseDoc(doc) {
  if (doc.content && doc.content.tabs) doc = doc.content;
  var body = doc.tabs ? doc.tabs[0].documentTab.body.content : doc.body.content;
  var days = [], backupFood = [], intro = [];
  var currentDay = null, section = null, bfCur = null;
  body.forEach(function (el) {
    if (el.paragraph) {
      var p = el.paragraph;
      var sty = (p.paragraphStyle || {}).namedStyleType || '';
      var pi = kv_paraInfo(p);
      if (!pi.text) return;
      if (sty === 'HEADING_2') { section = pi.text.toLowerCase(); return; }
      if (sty === 'HEADING_3') {
        var m = pi.text.replace(/\*/g, '').match(/(\d{1,2})\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})/i);
        if (m) {
          var d = parseInt(m[1], 10), mon = MONTH_ABBR.indexOf(m[2].charAt(0).toUpperCase() + m[2].slice(1, 3).toLowerCase()), yr = parseInt(m[3], 10);
          var dt = new Date(Date.UTC(yr, mon, d));
          currentDay = {
            date: yr + '-' + (mon < 9 ? '0' : '') + (mon + 1) + '-' + (d < 10 ? '0' + d : d),
            label: d + ' ' + MONTH_ABBR[mon],
            weekday: WEEKDAYS[dt.getUTCDay()],
            items: []
          };
          days.push(currentDay);
        }
        return;
      }
      if (sty === 'HEADING_1' || sty === 'TITLE') return;
      if (section === null) intro.push(pi.text);
      else if (section.indexOf('back-up food') > -1 || section.indexOf('backup food') > -1) {
        if (pi.bold || (pi.lead_bold && pi.bold_ratio >= 0.6)) { bfCur = { name: pi.text, info: [], links: pi.links.slice() }; backupFood.push(bfCur); }
        else if (bfCur) {
          if (pi.italic) {
            var lv = kv_splitLabel(pi.text);
            if ((lv[0] || '').toLowerCase() === 'for') bfCur['for'] = kv_forTags(lv[1]);
            else bfCur.info.push({ label: lv[0], value: lv[1], segs: pi.segs });
          }
          else bfCur.links = bfCur.links.concat(pi.links);
        }
      }
    } else if (el.table && currentDay) {
      el.table.tableRows.forEach(function (r) {
        var cells = r.tableCells;
        if (cells.length < 2) return;
        var timeT = kv_cellParas(cells[0]).map(function (x) { return x.text; }).join(' ');
        if (timeT.toLowerCase().indexOf('time') === 0) return;
        var act = kv_cellParas(cells[1]);
        var notes = cells.length > 2 ? kv_cellParas(cells[2]) : [];
        if (!act.length) return;
        var item = kv_parseActivity(act);
        var dn = kv_parseNotes(notes), drive = dn[0], noteLines = dn[1], travel = dn[2];
        var tm = timeT.replace(/:/g, '').match(/(\d{2})(\d{2})/);
        var hhmm = tm ? tm[1] + ':' + tm[2] : '';
        var allText = act.map(function (x) { return x.text; });
        var mainTexts = [item.name].concat(item.info.filter(function (i) {
          var l = (i.label || '').toLowerCase();
          return l.indexOf('booking') === 0 || l.indexOf('online') === 0;
        }).map(function (i) { return i.value; }));
        var kind = kv_inferKind(item.name || item.type_word || '', item.type_word);
        var meal = MEAL_LABEL[(item.type_word || '').toLowerCase()] || null;
        if (!meal && kind === 'Meal') meal = item.name.split(' ')[0].split('&')[0].trim();
        var name = item.name || item.type_word || '';
        var nameClean = name.replace(/\s*-\s*(BOOKED|FIRST CHOICE|TO BOOK)\s*$/i, '');
        var confirmed = !!(item.type_word && item.type_word.toLowerCase().indexOf('confirmed') > -1);
        currentDay.items.push({
          time: hhmm,
          kind: kind,
          meal: meal,
          confirmed: confirmed,
          name: nameClean,
          tags: name.toUpperCase().indexOf('FIRST CHOICE') > -1 ? ['FIRST CHOICE'] : [],
          status: confirmed ? 'booked' : kv_bookingStatus(mainTexts),
          info: item.info,
          details: item.details,
          backups: item.backups.map(function (b) {
            return { name: b.name, info: b.info, details: b.details, status: kv_bookingStatus([b.name].concat(b.info.map(function (i) { return i.value; }))) };
          }),
          drive: drive,
          travel: travel,
          notes: noteLines,
          maps: kv_mapsLink(item),
          directions: kv_directionsLink(noteLines),
          optional: /\bOPTIONAL\b/.test(allText.join(' '))
        });
      });
    }
  });
  kv_attachBackups(days, backupFood);
  return { title: doc.title || '', intro: intro, days: days, backup_food: backupFood };
}

function buildTrip(plan) {
  var flights = [], hotels = [], car = null, todo = [];
  plan.days.forEach(function (day) {
    var wd = day.weekday.slice(0, 3);
    day.items.forEach(function (it) {
      var n = it.name, nl = n.toLowerCase();
      if (it.kind === 'Flight') {
        flights.push({ date: day.label, weekday: wd, time: it.time, name: n,
          detail: it.details.map(function (d) { return kv_segsText(d.segs); }).join(' ') });
      }
      if (nl.indexOf('check-in to hotel') === 0) {
        var head = it.details.filter(function (d) { return d.heading; })[0];
        hotels.push({ date: day.label, weekday: wd, name: head ? kv_segsText(head.segs) : n,
          notes: it.info.map(function (i) { return i.label ? i.label + ': ' + i.value : i.value; }) });
      }
      if (nl.indexOf('collect car') === 0) {
        car = { date: day.label, weekday: wd, time: it.time,
          lines: it.info.map(function (i) { return (i.label ? i.label + ': ' : '') + i.value; })
            .concat(it.details.map(function (d) { return kv_segsText(d.segs); })),
          notes: it.notes.map(function (l) { return kv_segsText(l.segs); }) };
      }
      if (nl.indexOf('return car') === 0 && car) car['return'] = day.label + ' ' + it.time;
      var hits = [];
      if (it.status === 'to_book') hits.push('To book');
      it.info.forEach(function (i) {
        var v = i.value, lab = (i.label || '').toLowerCase();
        if (/TO CHECK/.test(v)) hits.push(v.replace(/.*TO CHECK:?\s*/, 'Check: '));
        else if (lab.indexOf('opening') === 0 && /TBC|confirm|not listed|not confirmed/i.test(v)) hits.push('Hours: ' + v);
        else if (lab.indexOf('booking') === 0 && /check when|confirm/i.test(v) && it.status !== 'to_book') hits.push(v);
      });
      it.backups.forEach(function (b) {
        b.info.forEach(function (i) {
          if (i.value.indexOf('TO CHECK') > -1) hits.push('Backup ' + b.name.split(' (')[0] + ': ' + i.value.replace(/.*TO CHECK:?\s*/, 'check '));
        });
      });
      it.notes.forEach(function (l) {
        var t = kv_segsText(l.segs);
        if (/\bTo confirm\b|\bnot confirmed\b|\bTBC\b|check (the|on the day|before)/i.test(t) && !/Google Rating/.test(t)) hits.push(t.replace(/\s*\(Google Maps\)/g, ''));
      });
      if (hits.length) todo.push({ date: day.label, weekday: wd, time: it.time, name: n, items: hits });
    });
  });
  return { flights: flights, hotels: hotels, car: car, todo: todo };
}

function kv_num(s) {
  if (s === null || s === undefined || s === '') return 0;
  var v = parseFloat(String(s).replace(/,/g, '').replace(/%/g, ''));
  return isNaN(v) ? 0 : v;
}

function kv_rows(values) {
  return (values || []).map(function (r) {
    var out = r.map(function (c) { return c === null || c === undefined ? '' : String(c); });
    while (out.length < 16) out.push('');
    return out;
  });
}

function parseExpenses(summaryValues, settlementValues, expenseValues) {
  var out = { by_person: [], by_group: [], by_category: [], total_spend: 0, currency: 'SGD',
    settle_groups: [], settle_people: [], recent: [], count: 0 };
  var sec = null;
  kv_rows(summaryValues).forEach(function (r) {
    var b = r[1];
    var cm = b.match(/^Trip summary \(([A-Z]{3})\)/);
    if (cm) { out.currency = cm[1]; return; }
    if (b === 'By person' || b === 'By group' || b === 'By category') { sec = b; return; }
    if (b === 'Traveller' || b === 'Group' || b === 'Category' || b === '') {
      if (b === '' && sec === 'By category') sec = null;
      return;
    }
    if (b.indexOf('Total trip spend') === 0) { out.total_spend = kv_num(r[2]); sec = null; return; }
    if (b === 'Total') { sec = null; return; }
    if (sec === 'By person') out.by_person.push({ name: b, group: r[2], paid: kv_num(r[3]), owed: kv_num(r[4]), net: kv_num(r[5]) });
    else if (sec === 'By group') out.by_group.push({ name: b, members: r[2], paid: kv_num(r[3]), owed: kv_num(r[4]), net: kv_num(r[5]) });
    else if (sec === 'By category') {
      if (b === 'Settlement payment' || b === 'No category') return;
      out.by_category.push({ name: b, total: kv_num(r[2]), share: kv_num(r[3]) });
    }
  });
  sec = null;
  kv_rows(settlementValues).forEach(function (r) {
    var b = r[1];
    if (b === 'Between groups') { sec = 'settle_groups'; return; }
    if (b === 'Between individuals') { sec = 'settle_people'; return; }
    if (b === 'From' || b === '' || sec === null) return;
    if (r[2] && kv_num(r[3]) > 0) out[sec].push({ from: b, to: r[2], amount: kv_num(r[3]) });
  });
  var hdr = null, items = [];
  kv_rows(expenseValues).forEach(function (r) {
    if (r[1] === 'Date') { hdr = r; return; }
    if (!hdr || !r[2]) return;
    items.push({ date: r[1], desc: r[2], category: r[3], amount: kv_num(r[4]), currency: r[5], paid_by: r[6], sgd: kv_num(r[9]) });
  });
  function dkey(e) {
    var m = String(e.date).match(/^(\d{1,2}) (\w{3}) (\d{4})$/);
    return m && MONTHS.hasOwnProperty(m[2]) ? Date.UTC(+m[3], MONTHS[m[2]], +m[1]) : -Infinity;
  }
  out.count = items.length;
  out.recent = items.map(function (e, i) { return [e, i]; })
    .sort(function (a, b) { return (dkey(b[0]) - dkey(a[0])) || (a[1] - b[1]); })
    .map(function (x) { return x[0]; });
  return out;
}

function buildTripData(doc, summaryValues, settlementValues, expenseValues) {
  var plan = parseDoc(doc);
  return {
    generated_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    plan: plan,
    trip: buildTrip(plan),
    expenses: parseExpenses(summaryValues, settlementValues, expenseValues)
  };
}

if (typeof module !== 'undefined') module.exports = { buildTripData: buildTripData };
