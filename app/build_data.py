#!/usr/bin/env python3
"""Turn the Kansai itinerary Google Doc + expense sheet snapshots into data.json
for the mobile view. Read-only: it never touches the live files.

Usage: python3 -I build_data.py <input_dir> <output_json>
<input_dir> holds:
  doc.json         the Google Docs read_doc result ({"content": {...}} or the document itself)
  summary.json     get_values of  Summary!A1:O60
  settlement.json  get_values of  Settlement!A1:N60
  expenses.json    get_values of  Expenses!A1:J500
"""
import json, re, sys, datetime, os

TYPE_WORDS = {
    'activity': 'Activity', 'activity (confirmed)': 'Activity', 'activity / shopping': 'Shopping',
    'lunch': 'Meal', 'dinner': 'Meal', 'breakfast': 'Meal', 'snack': 'Snack', 'coffee': 'Snack',
}
MEAL_LABEL = {'lunch': 'Lunch', 'dinner': 'Dinner', 'breakfast': 'Breakfast', 'snack': 'Snack', 'coffee': 'Coffee'}


def load(path):
    with open(path) as f:
        return json.load(f)


def clean(s):
    return re.sub(r'\s+', ' ', s.replace('\u000b', ' ')).strip()


def para_info(p):
    """Return {text, bold, italic, links:[{text,url}], segs:[{t,u}]} for a Docs paragraph."""
    segs, links = [], []
    bold_chars = ital_chars = total = 0
    lead_bold, lead_open = '', True
    for e in p.get('elements', []):
        tr = e.get('textRun')
        if not tr:
            continue
        txt = tr.get('content', '')
        st = tr.get('textStyle', {})
        url = (st.get('link') or {}).get('url')
        n = len(txt.strip())
        total += n
        if st.get('bold'):
            bold_chars += n
        if lead_open:
            if st.get('bold'):
                lead_bold += txt
            elif txt.strip():
                lead_open = False
        if st.get('italic'):
            ital_chars += n
        t = txt.replace('\n', '').replace('\u000b', ' ')
        if url:
            links.append({'text': clean(t), 'url': url})
        if segs and segs[-1].get('u') == url:
            segs[-1]['t'] += t
        else:
            segs.append({'t': t, 'u': url} if url else {'t': t})
    text = clean(''.join(s['t'] for s in segs))
    # drop empty segments, collapse spaces
    segs = [s for s in segs if s['t'] != '']
    for s in segs:
        s['t'] = re.sub(r'\s+', ' ', s['t'])
        if not s.get('u'):
            s.pop('u', None)
    if segs:
        segs[0]['t'] = segs[0]['t'].lstrip()
        segs[-1]['t'] = segs[-1]['t'].rstrip()
    return {
        'text': text,
        'bold': total > 0 and bold_chars >= total * 0.9,
        'lead_bold': clean(lead_bold),
        'bold_ratio': (bold_chars / total) if total else 0,
        'italic': total > 0 and ital_chars >= total * 0.9,
        'links': links,
        'segs': segs,
        'lv': (p['bullet'].get('nestingLevel') or 0) if p.get('bullet') else -1,
    }


def shape(line, p):
    """Copy list structure onto a line: bullet level (when bulleted) and a blank line before it (gap)."""
    if p.get('lv', -1) >= 0:
        line['lv'] = p['lv']
    if p.get('gap'):
        line['gap'] = True
    return line


def cell_paras(cell):
    out, gap = [], False
    for el in cell.get('content', []):
        if 'paragraph' in el:
            pi = para_info(el['paragraph'])
            if pi['text']:
                if gap and out:
                    pi['gap'] = True
                out.append(pi)
                gap = False
            else:
                gap = True
    return out


def split_label(text):
    m = re.match(r'^([A-Za-z][A-Za-z /&\']{1,40}?):\s*(.*)$', text)
    if m:
        return m.group(1).strip(), m.group(2).strip()
    return None, text


def booking_status(texts):
    blob = ' '.join(texts)
    up = blob.upper()
    if 'TO BOOK' in blob:
        return 'to_book'
    if re.search(r'\bBOOKED\b|\bCONFIRMED\b', up):
        return 'booked'
    if re.search(r'reservation required|reservations required', blob, re.I):
        return 'to_book'
    if re.search(r'reservations? (recommended|accepted)|reservable|bookable|online via|phone reservations', blob, re.I):
        return 'bookable'
    if re.search(r'walk-in', blob, re.I):
        return 'walk_in'
    return None


def infer_kind(name, type_word):
    n = name.lower()
    if type_word:
        return TYPE_WORDS.get(type_word.lower(), 'Activity')
    if n.startswith('drive') or n.startswith('leave') or n.startswith('depart kobe') or 'return car' in n or 'collect car' in n:
        return 'Drive'
    if 'departure' in n or 'arrival' in n:
        return 'Flight'
    if 'check-in' in n or 'check-out' in n:
        return 'Hotel'
    if 'breakfast' in n or 'lunch' in n or 'dinner' in n:
        return 'Meal'
    return 'Activity'


def parse_activity(paras):
    """Split the activity cell into a main option + backups."""
    item = {'type_word': None, 'name': '', 'info': [], 'details': [], 'backups': []}
    cur = item
    idx = 0
    if paras and paras[0]['bold'] and paras[0]['text'].lower().rstrip(':') in TYPE_WORDS:
        item['type_word'] = paras[0]['text'].rstrip(':')
        idx = 1
    for p in paras[idx:]:
        t = p['text']
        if re.match(r'^backup\b', p['lead_bold'], re.I):
            nm = re.sub(r'^backup\s*\d*\s*:?\s*', '', p['lead_bold'], flags=re.I).strip()
            rest = clean(t[len(p['lead_bold']):]) if t.startswith(p['lead_bold']) else ''
            if not nm:
                nm, rest = rest, ''
            cur = {'name': nm, 'info': [], 'details': []}
            if rest:
                cur['details'].append(shape({'segs': [{'t': rest.lstrip(', ')}]}, p))
            item['backups'].append(cur)
            continue
        if not cur.get('name') and (p['bold'] or (p['lead_bold'] and p['bold_ratio'] >= 0.4)):
            cur['name'] = p['lead_bold'] if not p['bold'] else t
            extra = clean(t[len(p['lead_bold']):]) if not p['bold'] else ''
            if extra:
                cur['details'].append(shape({'segs': [{'t': extra}]}, p))
            continue
        if p['italic']:
            label, val = split_label(t)
            cur['info'].append({'label': label, 'value': val, 'segs': p['segs']})
            continue
        if p['bold']:
            cur['details'].append(shape({'heading': True, 'segs': p['segs']}, p))
            continue
        cur['details'].append(shape({'segs': p['segs']}, p))
    # A backup that starts with plain text (e.g. "Backup:" bold, then name in plain) -> use first detail as name
    for b in item['backups']:
        if not b['name'] and b['details']:
            b['name'] = ''.join(s['t'] for s in b['details'].pop(0)['segs'])
    return item


# Travel line in the notes cell: "Drive: 25 mins" (own car) or "Grab: 10 mins" / "Taxi: 10 mins" (no car)
TRAVEL_RE = r'^(Drive|Grab|Taxi)( from [^:]+)?:'


def parse_notes(paras):
    drive = None
    mode = None
    lines = []
    for p in paras:
        t = p['text']
        if drive is None and re.match(TRAVEL_RE, t):
            mode = re.match(TRAVEL_RE, t).group(1)
            drive = re.sub(r'\(Google Maps\)', '', t.split(':', 1)[1]).strip(' ,')
            drive = re.sub(r'\s+', ' ', drive)
            drive = re.sub(r'\s+([,.])', r'\1', drive).rstrip('.')
        lines.append(shape({'segs': p['segs'], 'bold': p['bold'], 'italic': p['italic']}, p))
    return drive, lines, mode


def maps_link(item, notes_lines):
    """First Google Maps place/search link in the activity cell (not a directions link)."""
    for d in item['details']:
        for s in d['segs']:
            u = s.get('u') or ''
            if 'google.com/maps' in u and '/dir' not in u and 'reserve' not in u:
                return u
    return None


def directions_link(notes_lines):
    for ln in notes_lines:
        for s in ln['segs']:
            u = s.get('u') or ''
            if 'google.com/maps/dir' in u:
                return u
    return None


DATE_RE = re.compile(r'(\d{1,2})\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})', re.I)
MON_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']


def for_tags(value):
    """'12 Nov lunch (backup to X); 14 Nov dinner' -> [{'date': '12 Nov', 'meal': 'lunch'}, ...]; 'general' -> []."""
    out = []
    for part in str(value or '').split(';'):
        m = re.match(r'^(\d{1,2})\s+([A-Za-z]{3})[A-Za-z]*\.?\s*(breakfast|lunch|dinner|snack|coffee)?', part.strip(), re.I)
        note = re.search(r'\(([^)]*)\)', part)
        if m:
            out.append({'date': m.group(1) + ' ' + m.group(2)[0].upper() + m.group(2)[1:3].lower(), 'meal': (m.group(3) or '').lower(),
                        'note': note.group(1).strip() if note else ''})
    return out


def attach_backups(days, backup_food):
    """Back-up Food List entries tagged 'For: <date> <meal>' join that meal's backups, so they show on its card."""
    for b in backup_food:
        for tag in b.get('for', []):
            day = next((d for d in days if d['label'] == tag['date']), None)
            if not day:
                continue
            meals = [it for it in day['items'] if it['kind'] in ('Meal', 'Snack')]
            it = next((x for x in meals if tag['meal'] and (x.get('meal') or '').lower() == tag['meal']), None)
            if it is None and not tag['meal'] and meals:
                it = meals[0]
            if it is None:
                continue
            line = []
            for k, l in enumerate(b['links']):
                if k:
                    line.append({'t': ' / '})
                line.append({'t': l['text'], 'u': l['url']})
            it['backups'].append({'name': b['name'], 'info': b['info'], 'details': [{'segs': line}] if line else [],
                                  'status': booking_status([b['name']] + [i['value'] for i in b['info']]), 'listed': True,
                                  'earlier': bool(re.search(r'earlier pick', tag.get('note', ''), re.I))})


def parse_doc(doc):
    if 'content' in doc and 'tabs' in doc['content']:
        doc = doc['content']
    tab = doc['tabs'][0]['documentTab']['body']['content']
    days, backup_food = [], []
    current_day = None
    section = None
    bf_cur = None
    intro = []
    for el in tab:
        if 'paragraph' in el:
            p = el['paragraph']
            sty = p.get('paragraphStyle', {}).get('namedStyleType', '')
            pi = para_info(p)
            if not pi['text']:
                continue
            if sty == 'HEADING_2':
                section = pi['text'].lower()
                continue
            if sty == 'HEADING_3':
                m = DATE_RE.search(pi['text'].replace('*', ''))
                if m:
                    d = int(m.group(1)); mon = MON_ABBR.index(m.group(2)[:3].capitalize()); yr = int(m.group(3))
                    current_day = {
                        'date': f'{yr}-{mon+1:02d}-{d:02d}',
                        'label': f'{d} {MON_ABBR[mon]}',
                        'weekday': datetime.date(yr, mon + 1, d).strftime('%A'),
                        'items': [],
                    }
                    days.append(current_day)
                continue
            if sty in ('HEADING_1', 'TITLE'):
                continue
            if section is None:
                intro.append(pi['text'])
            elif 'back-up food' in section or 'backup food' in section:
                if pi['bold'] or (pi['lead_bold'] and pi['bold_ratio'] >= 0.6):
                    bf_cur = {'name': pi['text'], 'info': [], 'links': list(pi['links'])}
                    backup_food.append(bf_cur)
                elif bf_cur is not None:
                    if pi['italic']:
                        label, val = split_label(pi['text'])
                        if (label or '').lower() == 'for':
                            bf_cur['for'] = for_tags(val)
                        else:
                            bf_cur['info'].append({'label': label, 'value': val, 'segs': pi['segs']})
                    else:
                        bf_cur['links'].extend(pi['links'])
        elif 'table' in el and current_day is not None:
            rows = el['table']['tableRows']
            for r in rows:
                cells = r['tableCells']
                if len(cells) < 2:
                    continue
                time_t = ' '.join(x['text'] for x in cell_paras(cells[0]))
                if time_t.lower().startswith('time'):
                    continue
                act = cell_paras(cells[1])
                notes = cell_paras(cells[2]) if len(cells) > 2 else []
                if not act:
                    continue
                item = parse_activity(act)
                drive, note_lines, travel = parse_notes(notes)
                tm = re.match(r'(\d{2})(\d{2})', time_t.replace(':', ''))
                hhmm = f'{tm.group(1)}:{tm.group(2)}' if tm else ''
                all_text = [x['text'] for x in act]
                main_texts = [item['name']] + [i['value'] for i in item['info'] if (i['label'] or '').lower().startswith('booking') or (i['label'] or '').lower().startswith('online')]
                kind = infer_kind(item['name'] or (item['type_word'] or ''), item['type_word'])
                meal = MEAL_LABEL.get((item['type_word'] or '').lower())
                if not meal and kind == 'Meal':
                    meal = item['name'].split(' ')[0].split('&')[0].strip()
                name = item['name'] or (item['type_word'] or '')
                name_clean = re.sub(r'\s*-\s*(BOOKED|FIRST CHOICE|TO BOOK)\s*$', '', name, flags=re.I)
                current_day['items'].append({
                    'time': hhmm,
                    'kind': kind,
                    'meal': meal,
                    'confirmed': bool(item['type_word'] and 'confirmed' in item['type_word'].lower()),
                    'name': name_clean,
                    'tags': [t for t in ('FIRST CHOICE',) if t in name.upper()],
                    'status': 'booked' if (item['type_word'] and 'confirmed' in item['type_word'].lower()) else booking_status(main_texts),
                    'info': item['info'],
                    'details': item['details'],
                    'backups': [dict(b, status=booking_status([b['name']] + [i['value'] for i in b['info']])) for b in item['backups']],
                    'drive': drive,
                    'travel': travel,
                    'notes': note_lines,
                    'maps': maps_link(item, note_lines),
                    'directions': directions_link(note_lines),
                    'optional': bool(re.search(r'\bOPTIONAL\b', ' '.join(all_text))),
                })
    attach_backups(days, backup_food)
    return {'title': doc.get('title', ''), 'intro': intro, 'days': days, 'backup_food': backup_food}


# Optional booking lines on a flight, hotel or car row (upgrade task 5); same rules as KV_BOOK in Parser.js
BOOK_RE = [
    ('code', re.compile(r'^(?:booking\s+(?:code|ref(?:erence)?|no\.?|number)|confirmation\s+(?:code|no\.?|number)|ref(?:erence)?\s*(?:code|no\.?)?)\s*:\s*(.+)$', re.I)),
    ('phone', re.compile(r'^(?:phone|tel(?:ephone)?)\s*:\s*(.+)$', re.I)),
    ('address', re.compile(r'^(?:address\s*\(local\)|local\s+address)\s*:\s*(.+)$', re.I)),
    ('checkin', re.compile(r'^online\s+check[\s-]?in\s*:\s*(.+)$', re.I)),
]


def is_book_line(t):
    return any(rx.match(clean(t)) for _, rx in BOOK_RE)


def book_lines(it):
    out = {}
    texts = [(i['label'] + ': ' if i['label'] else '') + i['value'] for i in it['info']] \
        + [''.join(s['t'] for s in d['segs']) for d in it['details']]
    for t in texts:
        t = clean(t)
        for k, rx in BOOK_RE:
            m = rx.match(t)
            if m and k not in out:
                out[k] = m.group(1).strip()
    return out or None


def build_trip(plan):
    flights, hotels, car, todo = [], [], None, []
    for day in plan['days']:
        for it in day['items']:
            n = it['name']
            if it['kind'] == 'Flight':
                fl = {'date': day['label'], 'weekday': day['weekday'][:3], 'time': it['time'], 'name': n,
                      'detail': ' '.join(t for t in (''.join(s['t'] for s in d['segs']) for d in it['details']) if not is_book_line(t))}
                fb = book_lines(it)
                if fb:
                    fl['book'] = fb
                flights.append(fl)
            if n.lower().startswith('check-in to hotel'):
                hn = next((''.join(s['t'] for s in d['segs']) for d in it['details'] if d.get('heading')), n)
                extra = [i['value'] if not i['label'] else f"{i['label']}: {i['value']}" for i in it['info']]
                ho = {'date': day['label'], 'weekday': day['weekday'][:3], 'name': hn, 'notes': extra}
                hb = book_lines(it)
                if hb:
                    ho['book'] = hb
                if it.get('maps'):
                    ho['maps'] = it['maps']
                hotels.append(ho)
            if n.lower().startswith('collect car'):
                car = {'date': day['label'], 'weekday': day['weekday'][:3], 'time': it['time'],
                       'lines': [(i['label'] + ': ' if i['label'] else '') + i['value'] for i in it['info']]
                       + [''.join(s['t'] for s in d['segs']) for d in it['details']],
                       'notes': [''.join(s['t'] for s in ln['segs']) for ln in it['notes']]}
                cb = book_lines(it)
                if cb:
                    car['book'] = cb
            if n.lower().startswith('return car'):
                if car is not None:
                    car['return'] = f"{day['label']} {it['time']}"
            # to-book / to-check list
            def scan(owner, info, details, status):
                hits = []
                if status == 'to_book':
                    hits.append('To book')
                for i in info:
                    v = i['value']
                    lab = (i['label'] or '').lower()
                    if re.search(r'TO CHECK', v):
                        hits.append(re.sub(r'.*TO CHECK:?\s*', 'Check: ', v))
                    elif lab.startswith('opening') and re.search(r'TBC|confirm|not listed|not confirmed', v, re.I):
                        hits.append('Hours: ' + v)
                    elif lab.startswith('booking') and re.search(r'check when|confirm', v, re.I) and status != 'to_book':
                        hits.append(v)
                return hits
            hits = scan(n, it['info'], it['details'], it['status'])
            for b in it['backups']:
                for i in b['info']:
                    if 'TO CHECK' in i['value']:
                        hits.append('Backup ' + b['name'].split(' (')[0] + ': ' + re.sub(r'.*TO CHECK:?\s*', 'check ', i['value']))
            for ln in it['notes']:
                t = ''.join(s['t'] for s in ln['segs'])
                if re.search(r'\bTo confirm\b|\bnot confirmed\b|\bTBC\b|check (the|on the day|before)', t, re.I) and not re.search(r'Google Rating', t):
                    hits.append(re.sub(r'\s*\(Google Maps\)', '', t))
            if hits:
                todo.append({'date': day['label'], 'weekday': day['weekday'][:3], 'time': it['time'], 'name': n, 'items': hits})
    return {'flights': flights, 'hotels': hotels, 'car': car, 'todo': todo}


def num(s):
    if s is None or s == '':
        return 0.0
    try:
        return float(str(s).replace(',', '').replace('%', ''))
    except ValueError:
        return 0.0


def rows_of(v):
    return [r + [''] * (16 - len(r)) for r in v.get('values', [])]


def parse_expenses(summary, settlement, expenses):
    S = rows_of(summary)
    out = {'by_person': [], 'by_group': [], 'by_category': [], 'total_spend': 0.0, 'currency': 'SGD',
           'settle_groups': [], 'settle_people': [], 'recent': [], 'count': 0}
    sec = None
    for r in S:
        b = r[1]
        cm = re.match(r'^Trip summary \(([A-Z]{3})\)', b)
        if cm:
            out['currency'] = cm.group(1)
            continue
        if b in ('By person', 'By group', 'By category'):
            sec = b
            continue
        if b in ('Traveller', 'Group', 'Category') or b == '':
            if b == '' and sec == 'By category':
                sec = None
            continue
        if b.startswith('Total trip spend'):
            out['total_spend'] = num(r[2])
            sec = None
            continue
        if b == 'Total':
            sec = None if sec != 'By category' else None
            continue
        if sec == 'By person':
            out['by_person'].append({'name': b, 'group': r[2], 'paid': num(r[3]), 'owed': num(r[4]), 'net': num(r[5])})
        elif sec == 'By group':
            out['by_group'].append({'name': b, 'members': r[2], 'paid': num(r[3]), 'owed': num(r[4]), 'net': num(r[5])})
        elif sec == 'By category':
            if b in ('Settlement payment', 'No category'):
                continue
            out['by_category'].append({'name': b, 'total': num(r[2]), 'share': num(r[3])})
    T = rows_of(settlement)
    sec = None
    for r in T:
        b = r[1]
        if b == 'Between groups':
            sec = 'settle_groups'; continue
        if b == 'Between individuals':
            sec = 'settle_people'; continue
        if b in ('From', '') or sec is None:
            continue
        if r[2] and num(r[3]) > 0:
            out[sec].append({'from': b, 'to': r[2], 'amount': num(r[3])})
    E = rows_of(expenses)
    hdr = None
    items = []
    for r in E:
        if r[1] == 'Date':
            hdr = r; continue
        if hdr is None or not r[2]:
            continue
        items.append({'date': r[1], 'desc': r[2], 'category': r[3], 'amount': num(r[4]), 'currency': r[5],
                      'paid_by': r[6], 'sgd': num(r[9])})
    def dkey(e):
        try:
            return datetime.datetime.strptime(e['date'], '%d %b %Y')
        except ValueError:
            return datetime.datetime.min
    out['count'] = len(items)
    out['recent'] = sorted(items, key=dkey, reverse=True)
    return out


def main():
    src, dst = sys.argv[1], sys.argv[2]
    plan = parse_doc(load(os.path.join(src, 'doc.json')))
    data = {
        'generated_at': datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
        'plan': plan,
        'trip': build_trip(plan),
        'expenses': parse_expenses(load(os.path.join(src, 'summary.json')),
                                   load(os.path.join(src, 'settlement.json')),
                                   load(os.path.join(src, 'expenses.json'))),
    }
    with open(dst, 'w') as f:
        json.dump(data, f, ensure_ascii=False)
    n_items = sum(len(d['items']) for d in plan['days'])
    print(f"days={len(plan['days'])} items={n_items} backup_food={len(plan['backup_food'])} "
          f"todo={len(data['trip']['todo'])} expenses={data['expenses']['count']}")
    if len(plan['days']) != 10 or n_items < 40:
        print('WARNING: unexpected doc structure, check before publishing', file=sys.stderr)
        sys.exit(2)


if __name__ == '__main__':
    main()
