"""Generate App Store marketing images from raw simulator screenshots.

The visual concept: each device class has ONE panorama background that spans
all of its screenshots end-to-end, so when the user swipes through the App
Store carousel the background reads as a single continuous scene. The theme
is a gradient mesh (navy → blue → teal → violet) with a subtle network of
nodes-and-edges drifting across — visually evokes a cluster without being
literal kubernetes-logo iconography.

Each panel gets:
  - The panorama slice for its index
  - A headline (and optional sub-line) at the top
  - A subtle accent rule
  - The raw simulator screenshot, with a slim iOS-style bezel + rounded
    corners + drop shadow, sitting in the lower portion

Run:
    python3 marketing/build_marketing.py

Outputs land in marketing/store/{iphone,ipad}/NN-name.png.
"""

from __future__ import annotations

import math
import random
from dataclasses import dataclass
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parent
RAW = ROOT / "screenshots"
OUT = ROOT / "store"

# Brand-anchored palette. NAVY_TOP matches the splash background in app.json.
NAVY_DEEP    = (4, 14, 38)
NAVY         = (10, 31, 77)
BLUE         = (28, 64, 158)
TEAL         = (28, 120, 158)
VIOLET       = (76, 38, 138)
ACCENT       = (130, 178, 254)
WHITE        = (255, 255, 255)

FONT_HEADLINE = "/System/Library/Fonts/SFNS.ttf"


# ── Device specs ──────────────────────────────────────────────────────────────

@dataclass
class Device:
    name: str
    canvas: tuple[int, int]            # final App Store image size (per panel)
    headline_size: int
    sub_size: int
    headline_top: int
    headline_line_gap: int
    screenshot_max_width_ratio: float  # frame width as fraction of canvas
    screenshot_top_ratio: float        # where the top of the frame sits
    frame_bezel: int                   # bezel thickness in px (post-scale)
    frame_radius: int                  # corner radius in px (post-scale)


IPHONE = Device(
    name="iphone",
    canvas=(1320, 2868),
    headline_size=120,
    sub_size=52,
    headline_top=180,
    headline_line_gap=140,
    screenshot_max_width_ratio=0.86,
    screenshot_top_ratio=0.36,
    frame_bezel=18,
    frame_radius=130,
)

IPAD = Device(
    name="ipad",
    canvas=(2064, 2752),
    headline_size=160,
    sub_size=64,
    headline_top=180,
    headline_line_gap=180,
    screenshot_max_width_ratio=0.78,
    screenshot_top_ratio=0.34,
    frame_bezel=22,
    frame_radius=80,
)


# ── Captions per shot ────────────────────────────────────────────────────────

IPHONE_SHOTS = [
    ("01-dashboard.png",   "Your cluster",        "at a glance"),
    ("02-pods-list.png",   "Every resource.",     "Every CRD."),
    ("03-pod-detail.png",  "Inspect anything",    "in detail"),
    ("04-logs.png",        "Stream logs",         "from anywhere"),
    ("05-helm-list.png",   "Helm releases",       "without kubectl"),
    ("06-helm-detail.png", "Values, manifests,",  "full history."),
    ("07-exec.png",        "Exec into",           "any container"),
    ("08-drawer.png",      "Multi-cluster.",      "Every namespace."),
]

IPAD_SHOTS = [
    ("01-dashboard.png",   "Built for iPad.",     "Permanent sidebar."),
    ("02-pods-table.png",  "Wide-mode",           "resource tables."),
    ("03-pod-detail.png",  "Sidebar and detail.", "One view."),
    ("04-helm-values.png", "Helm release",        "management."),
    ("05-logs.png",        "Live logs.",          "Native scrolling."),
]


# ── Panorama background ──────────────────────────────────────────────────────

def smoothstep(t: float) -> float:
    t = max(0.0, min(1.0, t))
    return t * t * (3 - 2 * t)


def panorama_mesh(width: int, height: int) -> Image.Image:
    """Wide gradient-mesh background. Builds at half resolution and upscales
    so we get the soft mesh look cheaply."""
    sx, sy = width // 4, height // 4
    img = Image.new("RGB", (sx, sy), NAVY_DEEP)
    px = img.load()

    # Pre-defined colour stops along the x-axis (relative 0..1 positions).
    stops = [
        (0.00, NAVY_DEEP),
        (0.18, NAVY),
        (0.34, BLUE),
        (0.52, TEAL),
        (0.68, BLUE),
        (0.84, VIOLET),
        (1.00, NAVY_DEEP),
    ]

    def x_colour(u: float) -> tuple[int, int, int]:
        # Piecewise lerp through the stops with smoothstep easing.
        for (u0, c0), (u1, c1) in zip(stops, stops[1:]):
            if u0 <= u <= u1:
                t = smoothstep((u - u0) / max(u1 - u0, 1e-6))
                return (
                    round(c0[0] + (c1[0] - c0[0]) * t),
                    round(c0[1] + (c1[1] - c0[1]) * t),
                    round(c0[2] + (c1[2] - c0[2]) * t),
                )
        return stops[-1][1]

    for y in range(sy):
        # Vignette toward the bottom — slightly darker.
        vy = y / max(sy - 1, 1)
        dark = 1.0 - 0.35 * (vy ** 1.7)
        for x in range(sx):
            u = x / max(sx - 1, 1)
            r, g, b = x_colour(u)
            px[x, y] = (round(r * dark), round(g * dark), round(b * dark))

    img = img.resize((width, height), Image.BICUBIC)
    img = img.filter(ImageFilter.GaussianBlur(28))
    return img


def panorama_nodes(width: int, height: int, panel_w: int,
                    seed: int = 1337) -> Image.Image:
    """Soft glowing nodes + connecting lines, drifting across the panorama.
    Nodes are placed independently of panel boundaries so the network reads
    as continuous when you swipe between panels."""
    rng = random.Random(seed)
    layer = Image.new("RGBA", (width, height), (0, 0, 0, 0))

    # Place roughly 5 nodes per panel-width, jittered into a band that sits
    # below the headline rule and above the framed screenshot.
    band_top = int(height * 0.19)
    band_bottom = int(height * 0.34)
    n_nodes = max(8, (width // panel_w) * 5)
    nodes = []
    for i in range(n_nodes):
        x = int((i + rng.random()) * (width / n_nodes))
        y = rng.randint(band_top, band_bottom)
        r = rng.choice([5, 6, 7, 9, 11, 14])
        nodes.append((x, y, r))

    # Edges: connect each node to its 1–2 nearest neighbours.
    edges = []
    for i, (x0, y0, _) in enumerate(nodes):
        nearest = sorted(
            ((j, math.hypot(x0 - x1, y0 - y1))
             for j, (x1, y1, _) in enumerate(nodes) if j != i),
            key=lambda p: p[1],
        )
        for j, d in nearest[: rng.choice([1, 1, 2])]:
            edge = tuple(sorted((i, j)))
            if edge not in edges and d < width * 0.10:
                edges.append(edge)

    # Draw edges first (so nodes sit on top).
    ed = ImageDraw.Draw(layer)
    for i, j in edges:
        x0, y0, _ = nodes[i]
        x1, y1, _ = nodes[j]
        ed.line((x0, y0, x1, y1), fill=(180, 210, 255, 38), width=2)

    # Soft glow halos under each node.
    halo = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    hd = ImageDraw.Draw(halo)
    for x, y, r in nodes:
        gr = r * 10
        hd.ellipse((x - gr, y - gr, x + gr, y + gr),
                   fill=(150, 200, 255, 28))
    halo = halo.filter(ImageFilter.GaussianBlur(28))
    layer.alpha_composite(halo)

    # Crisp dots.
    for x, y, r in nodes:
        ed.ellipse((x - r, y - r, x + r, y + r),
                   fill=(220, 232, 255, 230))

    return layer


# ── Drawing primitives ───────────────────────────────────────────────────────

def rounded_corner_mask(size: tuple[int, int], radius: int) -> Image.Image:
    mask = Image.new("L", size, 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        (0, 0, size[0], size[1]), radius=radius, fill=255)
    return mask


def drop_shadow(silhouette_alpha: Image.Image, blur: int = 70,
                offset: tuple[int, int] = (0, 36),
                opacity: int = 200) -> Image.Image:
    w, h = silhouette_alpha.size
    pad = blur * 2
    canvas = Image.new("RGBA", (w + pad * 2, h + pad * 2), (0, 0, 0, 0))
    silhouette = Image.new("RGBA", (w, h), (0, 0, 0, opacity))
    silhouette.putalpha(silhouette_alpha)
    canvas.paste(silhouette, (pad + offset[0], pad + offset[1]), silhouette)
    return canvas.filter(ImageFilter.GaussianBlur(blur))


def device_frame(screenshot: Image.Image, dev: Device) -> Image.Image:
    """Wrap the screenshot in an iOS-style bezel: a slim dark border with
    the same corner radius as iOS itself."""
    w, h = screenshot.size
    bezel = dev.frame_bezel
    radius = dev.frame_radius
    frame_size = (w + bezel * 2, h + bezel * 2)
    frame = Image.new("RGBA", frame_size, (0, 0, 0, 0))

    # Bezel body — slight vertical gradient so it doesn't look painted-on.
    body = Image.new("RGB", frame_size, (18, 20, 28))
    px = body.load()
    for y in range(frame_size[1]):
        t = y / max(frame_size[1] - 1, 1)
        shade = int(14 + 18 * (1 - t))
        for x in range(frame_size[0]):
            px[x, y] = (shade, shade + 1, shade + 4)
    body.putalpha(rounded_corner_mask(frame_size, radius + bezel))
    frame.alpha_composite(body)

    # Screenshot inset.
    inset = screenshot.convert("RGBA")
    mask = rounded_corner_mask(inset.size, radius)
    rounded = Image.new("RGBA", inset.size, (0, 0, 0, 0))
    rounded.paste(inset, (0, 0), mask)
    frame.alpha_composite(rounded, (bezel, bezel))

    return frame


def load_font(path: str, size: int) -> ImageFont.FreeTypeFont:
    try:
        return ImageFont.truetype(path, size)
    except OSError:
        return ImageFont.truetype("/System/Library/Fonts/HelveticaNeue.ttc", size)


def draw_headline(canvas: Image.Image, dev: Device,
                  line_a: str, line_b: str | None) -> None:
    draw = ImageDraw.Draw(canvas)
    font = load_font(FONT_HEADLINE, dev.headline_size)
    cx = canvas.size[0] // 2
    y = dev.headline_top

    for line in (line_a, line_b):
        if not line:
            continue
        bbox = draw.textbbox((0, 0), line, font=font)
        w = bbox[2] - bbox[0]
        # Subtle text shadow for legibility on the bright mesh patches.
        shadow_offset = max(2, dev.headline_size // 60)
        draw.text((cx - w // 2 + shadow_offset, y + shadow_offset),
                  line, font=font, fill=(0, 0, 0, 110))
        draw.text((cx - w // 2, y), line, font=font, fill=WHITE)
        y += dev.headline_line_gap

    rule_y = y + 24
    rule_half = canvas.size[0] // 14
    draw.rounded_rectangle(
        (cx - rule_half, rule_y, cx + rule_half, rule_y + 8),
        radius=4, fill=ACCENT,
    )


def composite_screenshot(canvas: Image.Image, dev: Device,
                          screenshot_path: Path) -> None:
    ss = Image.open(screenshot_path).convert("RGBA")
    cw, ch = canvas.size
    target_w = int(cw * dev.screenshot_max_width_ratio) - dev.frame_bezel * 2
    scale = target_w / ss.size[0]
    target_h = int(ss.size[1] * scale)
    ss = ss.resize((target_w, target_h), Image.LANCZOS)

    framed = device_frame(ss, dev)
    fw, fh = framed.size

    x = (cw - fw) // 2
    y = int(ch * dev.screenshot_top_ratio)

    shadow = drop_shadow(framed.split()[-1])
    sx = x - (shadow.size[0] - fw) // 2
    sy = y - (shadow.size[1] - fh) // 2
    canvas.alpha_composite(shadow, dest=(sx, sy))
    canvas.alpha_composite(framed, dest=(x, y))


def build_panorama(dev: Device, n_panels: int) -> Image.Image:
    """The wide background that all panels for this device share."""
    pw, ph = dev.canvas
    total_w = pw * n_panels
    mesh = panorama_mesh(total_w, ph).convert("RGBA")
    nodes = panorama_nodes(total_w, ph, panel_w=pw)
    mesh.alpha_composite(nodes)
    return mesh


def render_panel(dev: Device, panorama: Image.Image, panel_index: int,
                  screenshot_path: Path, line_a: str, line_b: str | None,
                  out_path: Path) -> None:
    pw, ph = dev.canvas
    crop = panorama.crop((panel_index * pw, 0, (panel_index + 1) * pw, ph))
    bg = crop.copy()
    draw_headline(bg, dev, line_a, line_b)
    composite_screenshot(bg, dev, screenshot_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    bg.convert("RGB").save(out_path, format="PNG", optimize=True)


def main() -> None:
    for dev, shots, subdir in (
        (IPHONE, IPHONE_SHOTS, "iphone"),
        (IPAD,   IPAD_SHOTS,   "ipad"),
    ):
        panorama = build_panorama(dev, n_panels=len(shots))
        # Save the joined panorama too, for posterity / website hero use.
        pan_path = OUT / subdir / "_panorama.png"
        pan_path.parent.mkdir(parents=True, exist_ok=True)
        panorama.convert("RGB").save(pan_path, format="PNG", optimize=True)

        for i, (filename, line_a, line_b) in enumerate(shots):
            src = RAW / subdir / filename
            if not src.exists():
                print(f"missing: {src} — skip")
                continue
            dst = OUT / subdir / filename
            render_panel(dev, panorama, i, src, line_a, line_b, dst)
            print(f"wrote {dst}")


if __name__ == "__main__":
    main()
