"""ALPHA TERMINAL app icons: an orange lowercase alpha on a deep charcoal square.

Renders the same alpha path as the in-app Mark (src/components/icons.tsx), bolder and centred, supersampled 8x and
downsampled so edges stay sharp at 16-180 px. Writes into frontend/public:
  apple-touch-icon.png   180x180, opaque full-bleed square (iOS rounds the corners itself; no black corners)
  icon-192.png, icon-512.png   rounded square on transparent corners (manifest "any")
  icon-maskable-512.png  full-bleed square, glyph inside the 80% safe zone (manifest "maskable")
  favicon-32.png, favicon.ico (16/32/48), icon.svg
Run: python frontend/scripts/make-icons.py   (Pillow only; output is deterministic)
"""
from pathlib import Path
from PIL import Image, ImageDraw

BG = (21, 19, 15, 255)        # #15130F, the Mark's charcoal
ORANGE = (242, 102, 27, 255)  # #F2661B, ALPHA TERMINAL orange
# The Mark's alpha in its 32-unit box: M21.5 11.2 c-.9 3.9-2.6 9.6-6.4 9.6 -2.7 0-4.3-2.3-4.3-4.9 0-3 2.1-5.2 4.6-5.2 3.6 0 4.2 4.3 7 10.1
SEGMENTS = [
    ((21.5, 11.2), (20.6, 15.1), (18.9, 20.8), (15.1, 20.8)),
    ((15.1, 20.8), (12.4, 20.8), (10.8, 18.5), (10.8, 15.9)),
    ((10.8, 15.9), (10.8, 12.9), (12.9, 10.7), (15.4, 10.7)),
    ((15.4, 10.7), (19.0, 10.7), (19.6, 15.0), (22.4, 20.8)),
]
STROKE = 3.0  # in Mark units (the in-app Mark uses 2.6; the icon is a little bolder so it reads at small sizes)
OUT = Path(__file__).resolve().parent.parent / "public"


def bezier(p0, p1, p2, p3, n=200):
    for i in range(n + 1):
        t = i / n
        u = 1 - t
        yield (u**3 * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t**3 * p3[0],
               u**3 * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t**3 * p3[1])


def points():
    pts = [p for seg in SEGMENTS for p in bezier(*seg)]
    xs, ys = [p[0] for p in pts], [p[1] for p in pts]
    # Centre the glyph's visual box (path box widened by the stroke) on the 32-unit canvas.
    cx, cy = (min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2
    return [(x - cx + 16, y - cy + 16) for x, y in pts], (max(xs) - min(xs) + STROKE, max(ys) - min(ys) + STROKE)


def render(size, glyph_frac, rounded, transparent_corners):
    ss = 8
    S = size * ss
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0) if transparent_corners else BG)
    d = ImageDraw.Draw(img)
    if transparent_corners:
        d.rounded_rectangle([0, 0, S - 1, S - 1], radius=int(S * rounded), fill=BG)
    pts, (gw, gh) = points()
    scale = S * glyph_frac / max(gw, gh)
    r = STROKE * scale / 2
    off = S / 2 - 16 * scale
    for x, y in pts:
        X, Y = x * scale + off, y * scale + off
        d.ellipse([X - r, Y - r, X + r, Y + r], fill=ORANGE)
    return img.resize((size, size), Image.LANCZOS)


def svg():
    pts, (gw, gh) = points()
    scale = 512 * 0.56 / max(gw, gh)
    off = 256 - 16 * scale
    path = " ".join(("M" if i == 0 else "L") + f"{x * scale + off:.1f} {y * scale + off:.1f}" for i, (x, y) in enumerate(pts[::4]))
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" rx="112" fill="#15130F"/>'
            f'<path d="{path}" fill="none" stroke="#F2661B" stroke-width="{STROKE * scale:.1f}" stroke-linecap="round" stroke-linejoin="round"/></svg>\n')


if __name__ == "__main__":
    render(180, 0.56, 0, False).convert("RGB").save(OUT / "apple-touch-icon.png", optimize=True)
    render(192, 0.56, 0.22, True).save(OUT / "icon-192.png", optimize=True)
    render(512, 0.56, 0.22, True).save(OUT / "icon-512.png", optimize=True)
    render(512, 0.46, 0, False).convert("RGB").save(OUT / "icon-maskable-512.png", optimize=True)
    fav = render(256, 0.62, 0.22, True)
    fav.resize((32, 32), Image.LANCZOS).save(OUT / "favicon-32.png", optimize=True)
    fav.save(OUT / "favicon.ico", sizes=[(16, 16), (32, 32), (48, 48)])
    (OUT / "icon.svg").write_text(svg(), encoding="utf-8")
    print("icons written to", OUT)
