"""Render the PWA PNG icons (no third-party deps). Usage: python scripts/make_icons.py"""
import math
import struct
import zlib
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "frontend" / "public"
DARK, ORANGE, CREAM = (0x1C, 0x18, 0x14), (0xF2, 0x6B, 0x1D), (0xF4, 0xEF, 0xE6)


def seg_dist(px, py, ax, ay, bx, by):
    dx, dy = bx - ax, by - ay
    t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
    return math.hypot(px - (ax + t * dx), py - (ay + t * dy))


def render(size, rounded=True):
    s = size / 512
    rows = []
    for y in range(size):
        row = bytearray([0])
        for x in range(size):
            u, v = (x + 0.5) / s, (y + 0.5) / s
            inside = True
            if rounded:
                r = 112
                cx, cy = min(max(u, r), 512 - r), min(max(v, r), 512 - r)
                inside = math.hypot(u - cx, v - cy) <= r
            color, alpha = DARK, 255 if inside else 0
            if inside:
                if min(seg_dist(u, v, 146, 372, 256, 140), seg_dist(u, v, 256, 140, 366, 372)) <= 22:
                    color = ORANGE
                elif seg_dist(u, v, 190, 300, 322, 300) <= 18:
                    color = CREAM
            row += bytes(color) + bytes([alpha])
        rows.append(bytes(row))
    raw = zlib.compress(b"".join(rows), 9)

    def chunk(tag, data):
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)) + chunk(b"IDAT", raw) + chunk(b"IEND", b"")


for name, size, rounded in (("icon-192.png", 192, True), ("icon-512.png", 512, True), ("apple-touch-icon.png", 180, False)):
    (OUT / name).write_bytes(render(size, rounded))
    print("wrote", name)
