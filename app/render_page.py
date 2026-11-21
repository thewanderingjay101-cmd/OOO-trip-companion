#!/usr/bin/env python3
"""Inject data.json into template.html. Usage: python3 -I render_page.py <data.json> <template.html> <out.html>"""
import json, sys

data_path, tpl_path, out_path = sys.argv[1:4]
data = json.load(open(data_path))
blob = json.dumps(data, ensure_ascii=False).replace('</', '<\\/')
tpl = open(tpl_path).read()
assert '/*__DATA__*/' in tpl
open(out_path, 'w').write(tpl.replace('/*__DATA__*/', blob).replace('/*__BOOT__*/', 'null'))
print(f'wrote {out_path} ({len(blob)//1024} KB data)')
