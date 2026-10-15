#!/usr/bin/env python3
"""Check assets/media/clips.json before pushing. Exit code 1 if anything would break the live site
or put an unchecked clip in front of growers.

  python3 tools/media/check_clips.py

Checks:
  - every clip has an id, a known category and a known label source
  - public clips: status ready, files exist, labels are none / hand / model-reviewed
  - file sizes stay inside the page-weight budget
  - every data-clip="..." slot in the HTML has an entry (warns if it's still pending)
"""
import glob
import json
import os
import re
import sys

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
CATEGORIES = {'cart', 'gophers', 'stakes', 'canopy'}
LABELS = {'none', 'hand', 'model-reviewed', 'model-unreviewed'}
PUBLIC_LABELS = {'none', 'hand', 'model-reviewed'}
BUDGET_MB = {'mp4': 8.0, 'mp4_720': 4.0, 'mp4_portrait': 4.0, 'poster': 0.4, 'image': 0.6}


def main():
    path = os.path.join(REPO, 'assets', 'media', 'clips.json')
    data = json.load(open(path, encoding='utf-8'))
    errors, warns = [], []
    ids = set()
    for c in data.get('clips', []):
        cid = c.get('id') or '<no id>'
        if cid in ids:
            errors.append(f'{cid}: duplicate id')
        ids.add(cid)
        if c.get('category') not in CATEGORIES:
            errors.append(f'{cid}: category must be one of {sorted(CATEGORIES)}')
        if c.get('labels') not in LABELS:
            errors.append(f'{cid}: labels must be one of {sorted(LABELS)}')
        if not isinstance(c.get('public'), bool):
            errors.append(f'{cid}: public must be true or false')
        if c.get('public'):
            if c.get('status') != 'ready':
                errors.append(f'{cid}: public but not ready')
            if c.get('labels') not in PUBLIC_LABELS:
                errors.append(f'{cid}: public with labels={c.get("labels")}; unchecked model output never goes live')
        if c.get('status') == 'ready':
            src = c.get('sources') or {}
            if not (src.get('mp4') or src.get('image')):
                errors.append(f'{cid}: ready but no mp4 or image source')
            for k, url in src.items():
                f = os.path.join(REPO, url.lstrip('/'))
                if not os.path.exists(f):
                    errors.append(f'{cid}: {k} missing on disk ({url})')
                    continue
                mb = os.path.getsize(f) / 1e6
                if k in BUDGET_MB and mb > BUDGET_MB[k]:
                    (errors if c.get('public') else warns).append(f'{cid}: {k} is {mb:.1f} MB (budget {BUDGET_MB[k]} MB)')
        elif c.get('status') != 'pending':
            errors.append(f'{cid}: status must be pending or ready')

    by_id = {c.get('id'): c for c in data.get('clips', [])}
    for html in glob.glob(os.path.join(REPO, '**', '*.html'), recursive=True):
        for slot in re.findall(r'data-clip="([^"]+)"', open(html, encoding='utf-8').read()):
            c = by_id.get(slot)
            rel = os.path.relpath(html, REPO)
            if not c:
                errors.append(f'{rel}: data-clip="{slot}" has no entry in clips.json')
            elif not (c.get('status') == 'ready' and c.get('public')):
                warns.append(f'{rel}: slot {slot} shows its fallback still on the live site ({c.get("status")}, public={c.get("public")})')

    for w in warns:
        print('warn ', w)
    for e in errors:
        print('ERROR', e)
    total = len(data.get('clips', []))
    live = sum(1 for c in data.get('clips', []) if c.get('public') and c.get('status') == 'ready')
    print(f'{total} clips, {live} live, {len(errors)} errors, {len(warns)} warnings')
    sys.exit(1 if errors else 0)


if __name__ == '__main__':
    main()
