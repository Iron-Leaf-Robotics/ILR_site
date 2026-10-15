#!/usr/bin/env python3
"""Cut a raw clip into web-ready loops for the ILR site and record it in assets/media/clips.json.

Needs ffmpeg and ffprobe on PATH. Run from the repo root.

  python3 tools/media/encode.py RAW.mp4 --id field-hero --start 4 --dur 10 --loop-fade 0.8 --portrait --grade
  python3 tools/media/encode.py gopher_run3_overlay.mp4 --id gophers-age-01 --start 12 --dur 8 --labels hand

Writes assets/media/<id>/:
  <id>-1080.mp4      H.264, max 1920 wide, no audio, fast start      (desktop)
  <id>-720.mp4       H.264, max 1280 wide                            (phones, Save-Data)
  <id>-portrait.mp4  9:16 centre crop, 720x1280      (--portrait; hero on tall phone screens)
  <id>-poster.webp   one frame, shown before the video loads

Then updates the clip's entry in clips.json (creating it if it's new): status=ready, sources,
fps, duration. It never sets "public": that only flips to true after the clip passes preflight.

--loop-fade F   crossfades the last F seconds into the first F, so the loop has no visible jump.
--grade         a light, consistent grade (slightly lower saturation, a touch more contrast)
                so phone, cart and screen footage sit together. Off by default; never on CV clips.
--x-offset P    portrait crop centre as a fraction of width (0..1, default 0.5) if the cart isn't centred.
"""
import argparse
import json
import os
import shutil
import subprocess
import sys

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
MANIFEST = os.path.join(REPO, 'assets', 'media', 'clips.json')
CATEGORIES = ['cart', 'gophers', 'stakes', 'canopy']
LABELS = ['none', 'hand', 'model-reviewed', 'model-unreviewed']
GRADE = 'eq=contrast=1.05:brightness=-0.008:saturation=0.9:gamma=0.98'
DENOISE = 'hqdn3d=1.2:1.2:5:5'  # phone footage compresses much smaller with a touch of temporal denoise


def run(cmd):
    print('  $', ' '.join(cmd[:6]), '…' if len(cmd) > 6 else '')
    subprocess.run(cmd, check=True)


def probe(path):
    out = subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries',
                          'stream=width,height,r_frame_rate:format=duration', '-of', 'json', path],
                         capture_output=True, text=True, check=True).stdout
    j = json.loads(out)
    s = j['streams'][0]
    num, den = s['r_frame_rate'].split('/')
    return int(s['width']), int(s['height']), float(num) / float(den or 1), float(j['format']['duration'])


def build_filter(base, dur, fade, extra):
    """Return a filter_complex string ending in [v]."""
    chain = ','.join([f for f in extra if f])
    pre = f'[0:v]{chain},' if chain else '[0:v]'
    if fade and fade > 0:
        body = dur - fade
        return (f'{pre}split[a][b];'
                f'[a]trim=start={fade}:end={dur},setpts=PTS-STARTPTS[main];'
                f'[b]trim=start=0:end={fade},setpts=PTS-STARTPTS[head];'
                f'[main][head]xfade=transition=fade:duration={fade}:offset={body - fade}{base}[v]')
    return f'{pre}null{base}[v]'


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('src')
    ap.add_argument('--id', required=True, help='clip id, e.g. field-hero (no grower names: the repo is public)')
    ap.add_argument('--start', type=float, default=0.0, help='seconds into the source')
    ap.add_argument('--dur', type=float, default=10.0, help='seconds to keep (before loop-fade)')
    ap.add_argument('--loop-fade', type=float, default=0.0)
    ap.add_argument('--fps', type=int, default=30)
    ap.add_argument('--portrait', action='store_true')
    ap.add_argument('--x-offset', type=float, default=0.5)
    ap.add_argument('--grade', action='store_true')
    ap.add_argument('--crf', type=int, default=24, help='1080p quality (lower = bigger, better)')
    ap.add_argument('--poster-at', type=float, default=None, help='seconds into the cut clip for the poster frame')
    # metadata (only written if given, or when the entry is new)
    ap.add_argument('--category', choices=CATEGORIES)
    ap.add_argument('--labels', choices=LABELS)
    ap.add_argument('--title'); ap.add_argument('--caption'); ap.add_argument('--site')
    ap.add_argument('--date', help='YYYY-MM'); ap.add_argument('--crop'); ap.add_argument('--camera')
    a = ap.parse_args()

    for tool in ('ffmpeg', 'ffprobe'):
        if not shutil.which(tool):
            sys.exit(f'{tool} not found on PATH')
    if not os.path.exists(a.src):
        sys.exit(f'no such file: {a.src}')

    manifest = json.load(open(MANIFEST, encoding='utf-8'))
    entry = next((c for c in manifest['clips'] if c['id'] == a.id), None)
    if entry is None:
        if not (a.category and a.labels):
            sys.exit('new clip: pass --category and --labels (where did any boxes or labels come from?)')
        entry = {'id': a.id, 'public': False}
        manifest['clips'].insert(0, entry)
    if a.grade and (a.category or entry.get('category')) != 'cart':
        sys.exit('--grade is for cart/B-roll footage only; leave CV clips as recorded')

    w, h, src_fps, src_dur = probe(a.src)
    dur = min(a.dur, src_dur - a.start)
    if dur <= 0:
        sys.exit('start is past the end of the source')
    fade = min(a.loop_fade, dur / 3) if a.loop_fade else 0
    out_dir = os.path.join(REPO, 'assets', 'media', a.id)
    os.makedirs(out_dir, exist_ok=True)
    rel = lambda name: f'/assets/media/{a.id}/{name}'
    common_in = ['ffmpeg', '-y', '-v', 'error', '-ss', str(a.start), '-t', str(dur), '-i', a.src]
    pre = [f'fps={a.fps}', DENOISE, GRADE if a.grade else '']
    x264 = ['-c:v', 'libx264', '-preset', 'slow', '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an']

    print(f'{a.id}: {w}x{h} @ {src_fps:.2f} fps, cutting {dur:.1f}s from {a.start}s' + (f', loop fade {fade}s' if fade else ''))
    landscape_scale = lambda maxw: f',scale=w=min({maxw}\\,iw):h=-2:flags=lanczos'
    run(common_in + ['-filter_complex', build_filter(landscape_scale(1920), dur, fade, pre), '-map', '[v]', *x264, '-crf', str(a.crf), os.path.join(out_dir, f'{a.id}-1080.mp4')])
    run(common_in + ['-filter_complex', build_filter(landscape_scale(1280), dur, fade, pre), '-map', '[v]', *x264, '-crf', str(a.crf + 3), os.path.join(out_dir, f'{a.id}-720.mp4')])
    sources = {'mp4': rel(f'{a.id}-1080.mp4'), 'mp4_720': rel(f'{a.id}-720.mp4')}
    if a.portrait:
        cw = f'ih*9/16'
        cx = f'max(0\\,min(iw-{cw}\\,iw*{a.x_offset}-{cw}/2))'
        port = f',crop={cw}:ih:{cx}:0,scale=720:1280:flags=lanczos'
        run(common_in + ['-filter_complex', build_filter(port, dur, fade, pre), '-map', '[v]', *x264, '-crf', str(a.crf + 2), os.path.join(out_dir, f'{a.id}-portrait.mp4')])
        sources['mp4_portrait'] = rel(f'{a.id}-portrait.mp4')
    poster_t = a.poster_at if a.poster_at is not None else 0
    run(['ffmpeg', '-y', '-v', 'error', '-ss', str(poster_t), '-i', os.path.join(out_dir, f'{a.id}-1080.mp4'), '-frames:v', '1',
         '-vf', 'scale=w=min(1600\\,iw):h=-2', '-c:v', 'libwebp', '-quality', '78', os.path.join(out_dir, f'{a.id}-poster.webp')])
    sources['poster'] = rel(f'{a.id}-poster.webp')

    _, _, _, out_dur = probe(os.path.join(out_dir, f'{a.id}-1080.mp4'))
    entry.update({'status': 'ready', 'sources': sources, 'fps': a.fps, 'duration': round(out_dur, 2)})
    for k in ('category', 'labels', 'title', 'caption', 'site', 'date', 'crop', 'camera'):
        v = getattr(a, k)
        if v is not None:
            entry[k] = v
    entry.pop('shot', None)
    with open(MANIFEST, 'w', encoding='utf-8') as f:
        json.dump(manifest, f, indent=2, ensure_ascii=False)
        f.write('\n')

    for name in sorted(os.listdir(out_dir)):
        print(f'  {name:32s} {os.path.getsize(os.path.join(out_dir, name)) / 1e6:6.2f} MB')
    print(f'clips.json updated ({a.id}: status=ready, public={entry.get("public")}). Run tools/media/check_clips.py next.')


if __name__ == '__main__':
    main()
