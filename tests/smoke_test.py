#!/usr/bin/env python3
"""Smoke test: the committed generated files match a fresh build, the scripts parse, and the
beta page keeps its device storage apart from the live page. Run: python3 -I tests/smoke_test.py
Needs Python 3 and Node (for `node --check`). Reads no trip data and calls no backend."""
import os, re, subprocess, sys, tempfile

root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
build = os.path.join(root, 'app', 'build_appscript.py')
fails = []


def check(ok, msg):
    print(('ok   ' if ok else 'FAIL ') + msg)
    if not ok:
        fails.append(msg)


def read(*p):
    with open(os.path.join(*p)) as f:
        return f.read()


def node_check(code, label):
    with tempfile.NamedTemporaryFile('w', suffix='.js', delete=False) as f:
        f.write(code)
    r = subprocess.run(['node', '--check', f.name], capture_output=True, text=True)
    os.unlink(f.name)
    check(r.returncode == 0, label + ('' if r.returncode == 0 else ': ' + r.stderr.strip()[:300]))


with tempfile.TemporaryDirectory() as tmp:
    subprocess.run([sys.executable, '-I', build, '--out', tmp], check=True, capture_output=True)
    for rel in ['index.html', 'app/appscript/Index.html', 'beta/index.html', 'manifest.webmanifest', 'beta/manifest.webmanifest']:
        check(read(tmp, rel) == read(root, rel), rel + ' is up to date with the template (run app/build_appscript.py)')

    live = read(root, 'index.html')
    check('"api": "https://script.google.com/macros/s/' in live, 'index.html calls the live /exec link')
    check('/*__BOOT__*/' not in live and '/*__DATA__*/' not in live, 'index.html has no unfilled placeholders')
    scripts = re.findall(r'<script(?![^>]*type="application/json")[^>]*>(.*?)</script>', live, re.S)
    check(len(scripts) >= 2, 'index.html has its scripts (%d)' % len(scripts))
    for i, s in enumerate(scripts):
        node_check(s, 'index.html script %d parses' % (i + 1))

    for f in ['Code.js', 'Members.js', 'Parser.js', 'Changes.js', 'Votes.js']:
        src = read(root, 'app', 'appscript', f)
        node_check(src, f + ' parses')
    code = read(root, 'app', 'appscript', 'Code.js')
    check(re.search(r"TRIPS_SHEET_ID = '';", code) is not None, 'Code.js keeps the Trips sheet id out of the public repo')
    for fn in ['openTrip', 'refreshTrip', 'getInbox', 'postInbox', 'doGet', 'doPost']:
        check(re.search(r'\nfunction ' + fn + r'\(', code) is not None, 'Code.js defines ' + fn)

    # beta page built against a stand-in link: storage must go through the prefixed shim
    beta_dir = os.path.join(tmp, 'b')
    subprocess.run([sys.executable, '-I', build, '--out', beta_dir, '--beta-api', 'https://example.invalid/exec'],
                   check=True, capture_output=True)
    beta = read(beta_dir, 'beta/index.html')
    shim_end = beta.index('</script>')
    check('"api": "https://example.invalid/exec"' in beta, 'beta page calls the test /exec link')
    check('localStorage' not in beta[shim_end:], 'beta page never touches the live page\'s storage directly')
    check("var P = 'jfbeta:'" in beta, 'beta page prefixes its storage keys')
    check('BETA' in beta and '../just-follow-180.png' in beta, 'beta page is labelled and finds the icons')
    for i, s in enumerate(re.findall(r'<script(?![^>]*type="application/json")[^>]*>(.*?)</script>', beta, re.S)):
        node_check(s, 'beta page script %d parses' % (i + 1))

print('\n%d failed' % len(fails) if fails else '\nall passed')
sys.exit(1 if fails else 0)
