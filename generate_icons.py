"""Generate INN-Reach chevron icons for the browser extension."""

import struct, zlib, os, math


def dist_to_segment(px, py, ax, ay, bx, by):
    dx, dy = bx - ax, by - ay
    if dx == 0 and dy == 0:
        return math.hypot(px - ax, py - ay)
    t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
    return math.hypot(px - (ax + t * dx), py - (ay + t * dy))


def superellipse(nx, ny, cx, cy, rx, ry, n):
    sx = abs((nx - cx) / rx)
    sy = abs((ny - cy) / ry)
    if sx >= 1.0 or sy >= 1.0:
        if sx >= 1.0 and sy >= 1.0:
            return False
    return sx**n + sy**n <= 1.0


def create_png(size, path):
    ORANGE = (232, 105, 27)
    WHITE = (255, 255, 255)
    SS = 3

    vtx = (0.773, 0.500)
    top = (0.234, 0.219)
    bot = (0.234, 0.781)
    lw = 0.039
    cr = 0.0875
    cs = 0.031

    pixels = []
    for y in range(size):
        row = []
        for x in range(size):
            ra, ga, ba, aa = 0.0, 0.0, 0.0, 0.0
            for sy in range(SS):
                for sx in range(SS):
                    nx = (x + (sx + 0.5) / SS) / size
                    ny = (y + (sy + 0.5) / SS) / size

                    if not superellipse(nx, ny, 0.5, 0.5, 0.47, 0.47, 5):
                        continue

                    inside_circle = False
                    on_circle = False
                    for ccx, ccy in (top, vtx, bot):
                        d = math.hypot(nx - ccx, ny - ccy)
                        if d < cr:
                            inside_circle = True
                        if abs(d - cr) < cs / 2:
                            on_circle = True

                    on_line = False
                    if not inside_circle:
                        d1 = dist_to_segment(nx, ny, top[0], top[1], vtx[0], vtx[1])
                        d2 = dist_to_segment(nx, ny, bot[0], bot[1], vtx[0], vtx[1])
                        on_line = d1 < lw / 2 or d2 < lw / 2

                    if on_line or on_circle:
                        ra += WHITE[0]
                        ga += WHITE[1]
                        ba += WHITE[2]
                        aa += 255
                    else:
                        ra += ORANGE[0]
                        ga += ORANGE[1]
                        ba += ORANGE[2]
                        aa += 255

            n = SS * SS
            row.append(
                (
                    int(ra / n + 0.5),
                    int(ga / n + 0.5),
                    int(ba / n + 0.5),
                    int(aa / n + 0.5),
                )
            )
        pixels.append(row)

    def make_chunk(chunk_type, data):
        c = chunk_type + data
        return (
            struct.pack(">I", len(data))
            + c
            + struct.pack(">I", zlib.crc32(c) & 0xFFFFFFFF)
        )

    header = b"\x89PNG\r\n\x1a\n"
    ihdr = make_chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
    raw = b""
    for row in pixels:
        raw += b"\x00"
        for r, g, b, a in row:
            raw += struct.pack("BBBB", r, g, b, a)
    idat = make_chunk(b"IDAT", zlib.compress(raw, 9))
    iend = make_chunk(b"IEND", b"")
    with open(path, "wb") as f:
        f.write(header + ihdr + idat + iend)


base = os.path.join(os.path.dirname(__file__), "icons")
create_png(16, os.path.join(base, "icon16.png"))
create_png(48, os.path.join(base, "icon48.png"))
create_png(128, os.path.join(base, "icon128.png"))
print("Icons created.")
