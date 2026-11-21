#!/usr/bin/env python3
"""Build every generated file from app/template.html.

Writes:
  index.html                        the live front end (GitHub Pages), calls the live Apps Script /exec link
  beta/index.html                   the beta front end, calls the TEST Apps Script /exec link in app/beta.json
  app/appscript/Index.html          the Apps Script page (paste into the editor as "Index")
  app/appscript/project-import.json all four Apps Script files in one JSON (not committed)

Usage: python3 -I app/build_appscript.py          (from anywhere)
       python3 -I app/build_appscript.py --out DIR (write into DIR instead, used by the smoke test)
"""
import json, os, sys

here = os.path.dirname(os.path.abspath(__file__))
root = os.path.dirname(here)
out = root
if '--out' in sys.argv:
    out = os.path.abspath(sys.argv[sys.argv.index('--out') + 1])

# The live web app's /exec link: the Pages front end sends its API calls here. Update it if the deployment link changes.
APP_URL = 'https://script.google.com/macros/s/AKfycbwpoGwMWlE_InveJ3rCfw1H_9yewjGpVEWfT-dUrU4Cd0sDZ38SUswcaOFjjyUA1y16/exec'
# The test web app's /exec link (a separate Apps Script project that reads only the test copies). Blank until set up.
BETA_URL = json.load(open(os.path.join(here, 'beta.json'))).get('api', '').strip()
if '--beta-api' in sys.argv:  # smoke test only: build the beta page against a stand-in link
    BETA_URL = sys.argv[sys.argv.index('--beta-api') + 1]


def write(rel, text):
    p = os.path.join(out, rel)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, 'w') as f:
        f.write(text)


src = os.path.join(here, 'appscript')
tpl = open(os.path.join(here, 'template.html')).read()
index = tpl.replace('/*__DATA__*/', 'null').replace('/*__BOOT__*/', '<?!= boot ?>')
write('app/appscript/Index.html', index)
files = [
    {'name': 'appsscript', 'type': 'json', 'source': open(os.path.join(src, 'appsscript.json')).read()},
] + [
    # every .js file in app/appscript is a server file (Code, Members, Parser, ...)
    {'name': f[:-3], 'type': 'server_js', 'source': open(os.path.join(src, f)).read()}
    for f in sorted(os.listdir(src)) if f.endswith('.js')
] + [
    {'name': 'Index', 'type': 'html', 'source': index},
]
write('app/appscript/project-import.json', json.dumps({'files': files}, ensure_ascii=False))

# GitHub Pages copy: a full HTML document (Apps Script adds <html>/<head> itself; Pages doesn't)
HEAD = '''<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="Just Follow">
<meta name="apple-mobile-web-app-status-bar-style" content="default">
<meta name="theme-color" content="#FCFAF6" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#3A4470" media="(prefers-color-scheme: dark)">
<meta name="robots" content="noindex">
<link rel="apple-touch-icon" href="just-follow-180.png">
<link rel="icon" type="image/png" href="just-follow-512.png">
<link rel="manifest" href="manifest.webmanifest">
<link rel="preconnect" href="https://script.google.com">
<link rel="preconnect" href="https://script.googleusercontent.com">
'''


def manifest(name, icons):
    # Android (Chrome, Samsung Internet) names and draws the Home screen icon from this file; without it Chrome
    # showed the site address as the name. No start_url on purpose: the icon then opens the page it was added
    # from, so the ?ks= / ?trip=&k= keys stay in the link (iPhone needs them; see README "Home Screen").
    return json.dumps({
        'name': name, 'short_name': name, 'display': 'standalone',
        'background_color': '#FCFAF6', 'theme_color': '#FCFAF6',
        'icons': [{'src': icons + 'just-follow-512.png', 'sizes': '512x512', 'type': 'image/png', 'purpose': 'any'},
                  {'src': icons + 'just-follow-180.png', 'sizes': '180x180', 'type': 'image/png', 'purpose': 'any'}],
    }, indent=2) + '\n'


def pages(api):
    body = tpl.replace('/*__DATA__*/', 'null').replace('/*__BOOT__*/', json.dumps({'api': api}))
    # template.html starts with head content and has no <body>; browsers put the markup in place either way
    return HEAD + body + '\n</html>\n'


live = pages(APP_URL)
write('index.html', live)
write('manifest.webmanifest', manifest('Just Follow', ''))

# Beta page: same app, test backend. It lives on the same origin as the live page, so its device storage
# is kept apart with a "jfbeta:" prefix (otherwise testing would overwrite saved trips and keys of the live app).
BETA_SHIM = '''<script>
(function () {
  var P = 'jfbeta:', S = null;
  try { S = window.localStorage; } catch (e) {}
  function keys() { var a = []; if (!S) return a; for (var i = 0; i < S.length; i++) { var k = S.key(i) || ''; if (k.indexOf(P) === 0) a.push(k.slice(P.length)); } return a; }
  window.__jfls = {
    getItem: function (k) { return S ? S.getItem(P + k) : null; },
    setItem: function (k, v) { if (S) S.setItem(P + k, v); },
    removeItem: function (k) { if (S) S.removeItem(P + k); },
    key: function (i) { var a = keys(); return i < a.length ? a[i] : null; },
    get length() { return keys().length; }
  };
})();
</script>
<style>#jf-beta{position:fixed;left:50%;transform:translateX(-50%);bottom:calc(env(safe-area-inset-bottom) + 76px);z-index:9999;background:#B23E1C;color:#fff;font:700 11px/1 Inter,system-ui,sans-serif;letter-spacing:.08em;padding:5px 10px;border-radius:999px;pointer-events:none;opacity:.9}</style>
'''
if BETA_URL:
    beta = pages(BETA_URL)
    beta = beta.replace('localStorage', '__jfls')  # every storage call goes through the prefixed shim below
    beta = beta.replace('<meta name="apple-mobile-web-app-title" content="Just Follow">',
                        '<meta name="apple-mobile-web-app-title" content="JF Beta">')
    beta = beta.replace('href="just-follow-180.png"', 'href="../just-follow-180.png"')
    beta = beta.replace('href="just-follow-512.png"', 'href="../just-follow-512.png"')
    beta = beta.replace('<title>Just Follow</title>', '<title>Just Follow Beta</title>', 1)
    beta = beta.replace('<link rel="preconnect" href="https://script.google.com">', BETA_SHIM + '<link rel="preconnect" href="https://script.google.com">', 1)
    beta = beta.replace('\n</html>\n', '\n<div id="jf-beta">BETA · TEST DATA</div>\n</html>\n')
    write('beta/manifest.webmanifest', manifest('JF Beta', '../'))
else:
    beta = '''<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>Just Follow Beta</title>
<style>body{margin:0;font:16px/1.5 system-ui,sans-serif;background:#FCFAF6;color:#1B2340;display:grid;place-items:center;min-height:100vh;padding:16px;box-sizing:border-box;text-align:center}</style>
</head><body><p>The Just Follow beta isn't connected to its test backend yet.</p></body></html>
'''
write('beta/index.html', beta)
print('ok', [(f['name'], len(f['source'])) for f in files], ('index.html', len(live)),
      ('beta/index.html', len(beta), 'test backend' if BETA_URL else 'placeholder'))
