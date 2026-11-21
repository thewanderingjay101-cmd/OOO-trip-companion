#!/usr/bin/env python3
"""Parser parity: Parser.js (the backend) and app/build_data.py (the offline copy) must turn the same itinerary doc
into the same plan and trip data. Uses a small made-up doc built here (no real trip data, no network).
Run: python3 -I tests/parser_parity_test.py   (needs Node)"""
import json, os, subprocess, sys, tempfile

root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(root, 'app'))
import build_data  # noqa: E402

fails = []


def check(ok, msg):
    print(('ok   ' if ok else 'FAIL ') + msg)
    if not ok:
        fails.append(msg)


def para(text, bold=False, italic=False, style='NORMAL_TEXT', url=None):
    ts = {}
    if bold:
        ts['bold'] = True
    if italic:
        ts['italic'] = True
    if url:
        ts['link'] = {'url': url}
    return {'paragraph': {'elements': [{'textRun': {'content': text + '\n', 'textStyle': ts}}],
                          'paragraphStyle': {'namedStyleType': style}}}


def row(time, activity, notes=()):
    return {'tableCells': [{'content': [para(time)]}, {'content': list(activity)},
                           {'content': list(notes) or [para('')]}]}


def table(*rows):
    return {'table': {'tableRows': [row('Time', [para('Activity / Details')], [para('Notes & Logistics')])] + list(rows)}}


def sample_doc(with_booking_lines):
    extra = (lambda *ls: [para(x, italic=True) for x in ls]) if with_booking_lines else (lambda *ls: [])
    body = [
        para('Sample Trip Itinerary', style='HEADING_1'),
        para('A short made-up trip for the parser test.'),
        para('Daily Schedule', style='HEADING_2'),
        para('3 March 2027 Wednesday', style='HEADING_3'),
        table(
            row('0900hr', [para('Departure from Changi Airport', bold=True), para('XX101')]
                + extra('Booking code: ABC123', 'Online check-in: Tue 2 Mar 09:00')),
            row('1500hr', [para('Arrival at Sample Airport', bold=True)]),
            row('1600hr', [para('Collect car', bold=True), para('Sample Car Rental', bold=True),
                           para('Location: Terminal 1', italic=True), para('Pick-up Time: 4pm', italic=True),
                           para('Compact car - $200')] + extra('Booking code: CAR-77', 'Phone: +81 3 1234 5678')),
            row('1800hr', [para('Check-in to hotel', bold=True), para('Sample Harbour Hotel', bold=True),
                           para('Check-in: 3pm', italic=True)]
                + extra('Booking code: HTL-9', 'Phone: +81 3 0000 1111', 'Address (local): 東京都サンプル1-2-3')),
            row('1930hr', [para('Dinner', bold=True), para('Sample Noodle Bar', bold=True), para('To book', italic=True)]),
        ),
        para('4 March 2027 Thursday', style='HEADING_3'),
        table(
            row('0800hr', [para('Return car', bold=True)]),
            row('1100hr', [para('Departure from Sample Airport', bold=True)] + extra('Booking code: ABC123')),
            row('1700hr', [para('Arrival at Changi Airport', bold=True)]),
        ),
    ]
    return {'title': 'Sample', 'tabs': [{'documentTab': {'body': {'content': body}}}]}


JS = r"""
const fs = require('fs'), vm = require('vm');
const ctx = { console }; vm.createContext(ctx);
vm.runInContext(fs.readFileSync(process.argv[2], 'utf8'), ctx);
ctx.__doc = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
const plan = vm.runInContext('parseDoc(__doc)', ctx); ctx.__plan = plan;
const trip = vm.runInContext('buildTrip(__plan)', ctx);
process.stdout.write(JSON.stringify({ plan, trip }));
"""

with tempfile.TemporaryDirectory() as tmp:
    js = os.path.join(tmp, 'run.js')
    open(js, 'w').write(JS)
    for withb in (False, True):
        label = 'with booking lines' if withb else 'without booking lines'
        doc = sample_doc(withb)
        dp = os.path.join(tmp, 'doc.json')
        json.dump(doc, open(dp, 'w'), ensure_ascii=False)
        r = subprocess.run(['node', js, os.path.join(root, 'app', 'appscript', 'Parser.js'), dp], capture_output=True, text=True)
        check(r.returncode == 0, 'Parser.js runs (%s)%s' % (label, '' if r.returncode == 0 else ': ' + r.stderr[:300]))
        if r.returncode:
            continue
        a = json.loads(r.stdout)
        plan = build_data.parse_doc(json.loads(json.dumps(doc)))
        b = {'plan': plan, 'trip': build_data.build_trip(plan)}
        check(a['plan'] == b['plan'], 'same plan from both parsers (%s)' % label)
        check(a['trip'] == b['trip'], 'same trip from both parsers (%s)' % label)
        t = b['trip']
        if withb:
            check(t['hotels'][0].get('book') == {'code': 'HTL-9', 'phone': '+81 3 0000 1111', 'address': '東京都サンプル1-2-3'}, 'hotel booking code, phone and local address')
            check(t['flights'][0].get('book') == {'code': 'ABC123', 'checkin': 'Tue 2 Mar 09:00'}, 'flight booking code and online check-in')
            check(t['flights'][0]['detail'] == 'XX101', 'booking lines stay out of the flight number')
            check(t['car'].get('book') == {'code': 'CAR-77', 'phone': '+81 3 1234 5678'}, 'car booking code and phone')
        else:
            check(all('book' not in x for x in t['flights'] + t['hotels']) and 'book' not in t['car'], 'no "book" key when the doc has no booking lines')
        check(len(t['flights']) == 4 and len(t['hotels']) == 1 and t['car'] and t['car'].get('return') == '4 Mar 08:00', 'flights, hotel and car found (%s)' % label)

print('\n%d failed' % len(fails) if fails else '\nall passed')
sys.exit(1 if fails else 0)
