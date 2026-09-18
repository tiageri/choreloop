#!/usr/bin/env python3
"""Generate Choreloop's PNG icons. No image libraries needed."""
import zlib, struct, math, os

BG = (31, 111, 92)      # --accent
FG = (255, 255, 255)
SS = 4                  # supersample factor for smooth edges


def rounded_square(x, y, size, radius):
    """Signed coverage test for a rounded square occupying [0,size]."""
    cx = min(max(x, radius), size - radius)
    cy = min(max(y, radius), size - radius)
    return math.hypot(x - cx, y - cy) <= radius


def on_check(x, y, size):
    """Thick checkmark stroke through three points, scaled to `size`."""
    pts = [(0.26, 0.52), (0.43, 0.68), (0.75, 0.33)]
    w = size * 0.085
    for i in range(len(pts) - 1):
        ax, ay = pts[i][0] * size, pts[i][1] * size
        bx, by = pts[i + 1][0] * size, pts[i + 1][1] * size
        dx, dy = bx - ax, by - ay
        L2 = dx * dx + dy * dy
        t = max(0.0, min(1.0, ((x - ax) * dx + (y - ay) * dy) / L2))
        if math.hypot(x - (ax + t * dx), y - (ay + t * dy)) <= w:
            return True
    return False


def render(size, maskable=False):
    radius = size * (0.5 if maskable else 0.225)
    # Maskable icons must keep their art inside the safe zone, so inset the mark.
    inset = size * 0.1 if maskable else 0.0
    rows = []
    for py in range(size):
        row = bytearray([0])  # PNG filter type 0
        for px in range(size):
            r = g = b = a = 0
            for sy in range(SS):
                for sx in range(SS):
                    x = px + (sx + 0.5) / SS
                    y = py + (sy + 0.5) / SS
                    if not rounded_square(x, y, size, radius):
                        continue
                    a += 255
                    mx = (x - inset) * size / (size - 2 * inset)
                    my = (y - inset) * size / (size - 2 * inset)
                    c = FG if on_check(mx, my, size) else BG
                    r += c[0]; g += c[1]; b += c[2]
            n = SS * SS
            if a == 0:
                row += bytes([0, 0, 0, 0])
            else:
                cov = a // 255
                row += bytes([r // cov, g // cov, b // cov, a // n])
        rows.append(bytes(row))
    return b"".join(rows)


def write_png(path, size, maskable=False):
    raw = render(size, maskable)

    def chunk(tag, data):
        c = tag + data
        return struct.pack(">I", len(data)) + c + struct.pack(">I", zlib.crc32(c) & 0xFFFFFFFF)

    png = (b"\x89PNG\r\n\x1a\n"
           + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
           + chunk(b"IDAT", zlib.compress(raw, 9))
           + chunk(b"IEND", b""))
    with open(path, "wb") as f:
        f.write(png)
    print(f"  {path}  {len(png):,} bytes")


os.makedirs("icons", exist_ok=True)
for s in (180, 192, 512):
    write_png(f"icons/icon-{s}.png", s)
write_png("icons/icon-maskable-512.png", 512, maskable=True)
