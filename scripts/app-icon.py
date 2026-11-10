#!/usr/bin/env python3
"""Nova's icon set, every file from ONE master: ui/icons/mark-master-1024.png.

The master is the owner's artwork (2026-11-10), cut from its white background to real transparency.
The rule (owner): the artwork is used exactly as given. This script never redraws, retraces,
recolours, retouches or crops it. It changes only the format, the size (LANCZOS, on premultiplied
alpha so edges don't pick up a dark fringe) and, where a platform demands one, the background.

It writes:
  ui/icons/mark.svg              the in-app mark: the master, pixel for pixel (lossless WebP, transparent
                                 pixels' colour dropped), in an SVG with a transparent background.
                                 1024 px intrinsic size, a power of two, so status-icon.js can mipmap it.
                                 For large renders only: the 112 px hero, the styleguide's 96 and 180 px.
  ui/icons/mark-128.webp         the in-app mark for small renders (rail 32, top bar 24, rows 16): a
                                 lossless 128 px downscale, at least 4x every small size (owner, 2026-11-10:
                                 small uses get a small source, not the master)
  ui/icons/mark-<HERO>.webp      only if HERO is a size: the hero's source, a lossless downscale
  ui/index.html                  its large <img data-nova-mark data-src>: the hero's source (HERO)
  ui/icon.svg                   the favicon: 256 px and, at 24 px and under, a 64 px downscale
  ui/icons/icon-32.png           32 px, transparent
  ui/icons/icon-192.png          192 px, transparent (web, purpose any)
  ui/icons/icon-512.png          512 px, transparent (Android, purpose any)
  ui/icons/maskable-512.png      Android maskable: the dark tile colour full bleed, the whole artwork
                                 scaled down to sit inside the 80% safe circle
  ui/icons/ios-1024.png          iOS / App Store: the master flattened onto the dark tile colour, fully
                                 opaque (no alpha channel), placement as the master has it, no corner mask
  ui/icons/apple-touch-icon-180.png   the iOS master downscaled, opaque: the home-screen icon Safari uses
  ui/pair.html                   its <img data-nova-mark>, as a 256 px lossless WebP data: URI (/pair is
                                 served before pairing, and its allowlist holds no image of the mark)

Run from the repo root:  python3 scripts/app-icon.py   (needs Pillow with WebP)
"""
import base64
import io
import math
import re
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
MASTER = ROOT / 'ui/icons/mark-master-1024.png'
# The dark tile colour of the previous mark (sampled from its field, ui/icons/mark-1024.webp): the
# background wherever a platform needs one.
TILE = (10, 10, 15)
# The hero's source, the one switch: 'master' draws the 112 px hero from mark.svg, as the owner
# ruled on 2026-11-10 ("hero and other large renders keep the full master"); a size such as 512
# draws it from a lossless downscale of that size instead, and the app then never loads mark.svg.
HERO = 'master'
# The in-app mark's downscales, beside the master in mark.svg. Powers of two, so they mipmap.
MARK_SIZES = (128,) + (() if HERO == 'master' else (HERO,))


def load():
    img = Image.open(MASTER)
    img.load()
    if img.size != (1024, 1024) or img.mode != 'RGBA':
        raise SystemExit(f'{MASTER} must be a 1024x1024 RGBA PNG, not {img.size} {img.mode}')
    return img


def scaled(img, size):
    """A LANCZOS downscale, done on premultiplied alpha."""
    if img.size == (size, size):
        return img.copy()
    return img.convert('RGBa').resize((size, size), Image.LANCZOS).convert('RGBA')


def flat(img):
    """The artwork on the dark tile colour: opaque RGB, no alpha channel."""
    field = Image.new('RGBA', img.size, TILE + (255,))
    return Image.alpha_composite(field, img).convert('RGB')


def png(img):
    b = io.BytesIO()
    img.save(b, 'PNG', optimize=True)
    return b.getvalue()


def webp_lossless(img):
    b = io.BytesIO()
    img.save(b, 'WEBP', lossless=True, quality=100, method=6)
    return b.getvalue()


def data_uri(mime, data):
    return f'data:{mime};base64,{base64.b64encode(data).decode()}'


def maskable(img, size=512):
    """The whole artwork inside the 80% safe circle, on the tile colour, full bleed."""
    alpha = img.getchannel('A')
    w, h = img.size
    cx, cy = w / 2, h / 2
    px = alpha.load()
    reach = max(math.hypot(x + 0.5 - cx, y + 0.5 - cy) for y in range(h) for x in range(w) if px[x, y] > 0)
    art = round(w * (0.4 * size) / reach)  # the artwork's square, scaled so its reach is the safe radius
    out = Image.new('RGBA', (size, size), TILE + (255,))
    piece = scaled(img, art)
    off = (size - art) // 2
    out.alpha_composite(piece, (off, off))
    return out.convert('RGB'), reach


def main():
    img = load()
    write = lambda rel, data: (ROOT / rel).write_bytes(data)

    lossless = webp_lossless(img)
    write('ui/icons/mark.svg', (
        '<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">'
        '<!-- Nova\'s mark: the owner\'s artwork, unchanged (ui/icons/mark-master-1024.png, written by scripts/app-icon.py) -->'
        f'<image width="1024" height="1024" href="{data_uri("image/webp", lossless)}"/></svg>\n'
    ).encode())

    # The in-app mark's size-switched sources (status-icon.js picks one by rendered size).
    for size in MARK_SIZES:
        write(f'ui/icons/mark-{size}.webp', webp_lossless(scaled(img, size)))

    for size in (32, 192, 512):
        write(f'ui/icons/icon-{size}.png', png(scaled(img, size)))

    mask, reach = maskable(img)
    write('ui/icons/maskable-512.png', png(mask))

    ios = flat(img)
    write('ui/icons/ios-1024.png', png(ios))
    write('ui/icons/apple-touch-icon-180.png', png(ios.resize((180, 180), Image.LANCZOS)))

    large, small = webp_lossless(scaled(img, 256)), png(scaled(img, 64))
    write('ui/icon.svg', (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">\n'
        '<!-- Generated by scripts/app-icon.py from the owner\'s artwork (ui/icons/mark-master-1024.png). At\n'
        '     favicon size a 64 px downscale stands in for the 256 px one. -->\n'
        '<style>.s{display:none}@media (max-width:24px){.l{display:none}.s{display:inline}}</style>\n'
        f'<image class="l" width="512" height="512" href="{data_uri("image/webp", large)}"/>\n'
        f'<image class="s" width="512" height="512" href="{data_uri("image/png", small)}"/>\n'
        '</svg>\n'
    ).encode())

    # The app's large source, which shell.js loads only when a hero is shown.
    hero_src = '/icons/mark.svg' if HERO == 'master' else f'/icons/mark-{HERO}.webp'
    index_path = ROOT / 'ui/index.html'
    index = index_path.read_text(encoding='utf-8')
    large = re.compile(r'<img data-nova-mark data-src="[^"]*"')
    if not large.search(index):
        raise SystemExit('ui/index.html has no <img data-nova-mark data-src="...">')
    index_path.write_text(large.sub(f'<img data-nova-mark data-src="{hero_src}"', index, count=1), encoding='utf-8')

    pair_path = ROOT / 'ui/pair.html'
    pair = pair_path.read_text(encoding='utf-8')
    tag = re.compile(r'<img data-nova-mark src="[^"]*"')
    if not tag.search(pair):
        raise SystemExit('ui/pair.html has no <img data-nova-mark src="...">')
    inline = data_uri('image/webp', webp_lossless(scaled(img, 256)))
    pair_path.write_text(tag.sub(lambda _: f'<img data-nova-mark src="{inline}"', pair, count=1), encoding='utf-8')

    print(f'icon set written from {MASTER.relative_to(ROOT)}; mark.svg {len(lossless) * 4 // 3 // 1024} KB, '
          f"/pair's inline mark {len(inline) // 1024} KB, maskable reach {reach:.1f} px of 512")


if __name__ == '__main__':
    main()
