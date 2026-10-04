# Draws the app icon (a glowing orb in a ring on the dark HUD background) as PNGs, no libraries needed.
# Run: python3 scripts/make-icons.py
import math, struct, zlib, os

def png(path, size, inset):
    bg = (5, 8, 13)
    cx = cy = (size - 1) / 2
    R = size * (0.5 - inset)           # usable radius (maskable icons keep a safe zone)
    rows = []
    for y in range(size):
        row = bytearray([0])
        for x in range(size):
            d = math.hypot(x - cx, y - cy) / R
            r, g, b = bg
            # soft background glow
            glow = max(0.0, 1 - d / 1.25) ** 2 * 0.35
            r, g, b = r + 62 * glow, g + 224 * glow, b + 255 * glow
            # orb: white core -> cyan -> fade
            if d < 0.62:
                t = d / 0.62
                core = max(0.0, 1 - t / 0.35)
                cr, cg, cb = 62 + (220 - 62) * core, 224 + (250 - 224) * core, 255
                a = 1 if t < 0.75 else max(0.0, 1 - (t - 0.75) / 0.25)
                a *= 0.95
                r, g, b = r * (1 - a) + cr * a, g * (1 - a) + cg * a, b * (1 - a) + cb * a
            # thin ring with a gap, like the spinning ring in the app
            ang = math.atan2(y - cy, x - cx)
            ring = math.exp(-((d - 0.84) / 0.025) ** 2)
            if not (-2.4 < ang < -1.3):
                r, g, b = r + (62 - r) * ring, g + (224 - g) * ring, b + (255 - b) * ring
            row += bytes(int(min(255, max(0, c))) for c in (r, g, b))
        rows.append(bytes(row))
    raw = b''.join(rows)
    def chunk(tag, data):
        return struct.pack('>I', len(data)) + tag + data + struct.pack('>I', zlib.crc32(tag + data) & 0xffffffff)
    out = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 2, 0, 0, 0)) \
        + chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b'')
    with open(path, 'wb') as f:
        f.write(out)

here = os.path.join(os.path.dirname(__file__), '..', 'public', 'icons')
png(os.path.join(here, 'icon-192.png'), 192, 0.08)
png(os.path.join(here, 'icon-512.png'), 512, 0.08)
png(os.path.join(here, 'maskable-512.png'), 512, 0.2)
png(os.path.join(here, 'apple-touch-icon.png'), 180, 0.1)
png(os.path.join(here, 'favicon-32.png'), 32, 0.02)
