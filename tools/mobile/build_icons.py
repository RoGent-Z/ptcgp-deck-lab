#!/usr/bin/env python3
"""Generate crisp Android launcher, adaptive, splash, and PWA icons from public/assets/mark.svg geometry."""
from __future__ import annotations

import os
from pathlib import Path
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[2]
PUBLIC_DIR = ROOT / "public"
ANDROID_RES = ROOT / "android" / "app" / "src" / "main" / "res"

COLOR_RED = (0xD6, 0x28, 0x28, 255)
COLOR_BLACK = (0x14, 0x14, 0x14, 255)
COLOR_WHITE = (0xFF, 0xFF, 0xFF, 255)
COLOR_BG = (0xF6, 0xF6, 0xF4, 255)
COLOR_TRANSPARENT = (0, 0, 0, 0)

LEGACY_DENSITIES = {
    "mipmap-mdpi": 48,
    "mipmap-hdpi": 72,
    "mipmap-xhdpi": 96,
    "mipmap-xxhdpi": 144,
    "mipmap-xxxhdpi": 192,
}

ADAPTIVE_DENSITIES = {
    "mipmap-mdpi": 108,
    "mipmap-hdpi": 162,
    "mipmap-xhdpi": 216,
    "mipmap-xxhdpi": 324,
    "mipmap-xxxhdpi": 432,
}

SPLASH_DENSITIES = {
    "drawable": (480, 320),
    "drawable-port-mdpi": (320, 480),
    "drawable-port-hdpi": (480, 800),
    "drawable-port-xhdpi": (720, 1280),
    "drawable-port-xxhdpi": (960, 1600),
    "drawable-port-xxxhdpi": (1280, 1920),
    "drawable-land-mdpi": (480, 320),
    "drawable-land-hdpi": (800, 480),
    "drawable-land-xhdpi": (1280, 720),
    "drawable-land-xxhdpi": (1600, 960),
    "drawable-land-xxxhdpi": (1920, 1280),
}


def _rect_box(origin_x: float, origin_y: float, size: float, x0: float, y0: float, x1: float, y1: float) -> list[int]:
    scale = size / 64.0
    left = round(origin_x + x0 * scale)
    top = round(origin_y + y0 * scale)
    right = max(left, round(origin_x + x1 * scale) - 1)
    bottom = max(top, round(origin_y + y1 * scale) - 1)
    return [left, top, right, bottom]


def draw_swiss_mark(draw: ImageDraw.ImageDraw, origin_x: float, origin_y: float, size: float, monochrome: bool = False) -> None:
    """Draw public/assets/mark.svg exact geometry onto target box."""
    # Exact outer frame: viewBox 0..64 has rect x=2 y=2 w=60 h=60 stroke=4 -> outer [0..64], inner [4..60]
    draw.rectangle(_rect_box(origin_x, origin_y, size, 0, 0, 64, 64), fill=COLOR_BLACK)
    # Inner white field [4..60, 4..60]
    draw.rectangle(_rect_box(origin_x, origin_y, size, 4, 4, 60, 60), fill=COLOR_TRANSPARENT if monochrome else COLOR_WHITE)
    # Top red half [4..60, 4..30]
    draw.rectangle(_rect_box(origin_x, origin_y, size, 4, 4, 60, 30), fill=COLOR_BLACK if monochrome else COLOR_RED)
    # Center belt [0..64, 29..35]
    draw.rectangle(_rect_box(origin_x, origin_y, size, 0, 29, 64, 35), fill=COLOR_BLACK)
    # Center square button outer frame: rect 25..39 stroke=4 -> outer [23..41], inner [27..37]
    draw.rectangle(_rect_box(origin_x, origin_y, size, 23, 23, 41, 41), fill=COLOR_BLACK)
    draw.rectangle(_rect_box(origin_x, origin_y, size, 27, 27, 37, 37), fill=COLOR_WHITE)
    # Center red core [29..35, 29..35]
    draw.rectangle(_rect_box(origin_x, origin_y, size, 29, 29, 35, 35), fill=COLOR_BLACK if monochrome else COLOR_RED)


def render_square_icon(canvas_size: int, mark_ratio: float = 1.0, bg: tuple[int, int, int, int] = COLOR_TRANSPARENT) -> Image.Image:
    img = Image.new("RGBA", (canvas_size, canvas_size), bg)
    draw = ImageDraw.Draw(img)
    mark_size = round(canvas_size * mark_ratio)
    offset = (canvas_size - mark_size) / 2.0
    draw_swiss_mark(draw, offset, offset, float(mark_size))
    return img


def render_round_icon(canvas_size: int) -> Image.Image:
    # Supersample 4x for clean circular silhouette, keep internal square razor-sharp
    ss = 4
    big = canvas_size * ss
    img = Image.new("RGBA", (big, big), COLOR_TRANSPARENT)
    draw = ImageDraw.Draw(img)
    margin = round(big * 0.04)
    draw.ellipse([margin, margin, big - margin - 1, big - margin - 1], fill=COLOR_BG, outline=COLOR_BLACK, width=max(1, round(big * 0.03)))
    # Inscribed safe square ratio 0.58 * sqrt(2) = 0.82 <= 0.92 circle diameter
    mark_size = round(big * 0.56)
    offset = (big - mark_size) / 2.0
    draw_swiss_mark(draw, offset, offset, float(mark_size))
    return img.resize((canvas_size, canvas_size), Image.Resampling.LANCZOS)


def render_splash(width: int, height: int) -> Image.Image:
    img = Image.new("RGBA", (width, height), COLOR_BG)
    draw = ImageDraw.Draw(img)
    mark_size = round(min(width, height) * 0.28)
    ox = (width - mark_size) / 2.0
    oy = (height - mark_size) / 2.0
    draw_swiss_mark(draw, ox, oy, float(mark_size))
    return img


def main() -> int:
    pwa_dir = PUBLIC_DIR / "assets" / "icons"
    pwa_dir.mkdir(parents=True, exist_ok=True)
    render_square_icon(192, mark_ratio=1.0).save(pwa_dir / "icon-192.png")
    render_square_icon(512, mark_ratio=1.0).save(pwa_dir / "icon-512.png")
    render_square_icon(512, mark_ratio=0.68, bg=COLOR_BG).save(pwa_dir / "icon-512-maskable.png")

    if not ANDROID_RES.exists():
        print(f"[warn] {ANDROID_RES} not found; generated PWA icons only.")
        return 0

    for folder, px in LEGACY_DENSITIES.items():
        target = ANDROID_RES / folder
        target.mkdir(parents=True, exist_ok=True)
        render_square_icon(px, mark_ratio=0.86, bg=COLOR_TRANSPARENT).save(target / "ic_launcher.png")
        render_round_icon(px).save(target / "ic_launcher_round.png")

    for folder, px in ADAPTIVE_DENSITIES.items():
        target = ANDROID_RES / folder
        target.mkdir(parents=True, exist_ok=True)
        # 45% of 108dp keeps all 4 sharp corners strictly inside circular launcher mask (72dp safe circle / sqrt(2) = 50.9dp = 47.1%)
        render_square_icon(px, mark_ratio=0.45, bg=COLOR_TRANSPARENT).save(target / "ic_launcher_foreground.png")
        mono = Image.new("RGBA", (px, px), COLOR_TRANSPARENT)
        mono_draw = ImageDraw.Draw(mono)
        mark_sz = round(px * 0.45)
        offset = (px - mark_sz) / 2.0
        draw_swiss_mark(mono_draw, offset, offset, float(mark_sz), monochrome=True)
        mono.save(target / "ic_launcher_monochrome.png")
        Image.new("RGBA", (px, px), COLOR_BG).save(target / "ic_launcher_background.png")

    for folder, (w, h) in SPLASH_DENSITIES.items():
        target = ANDROID_RES / folder
        target.mkdir(parents=True, exist_ok=True)
        render_splash(w, h).save(target / "splash.png")

    # Remove default Capacitor template vector launcher icons if still present
    for stale_rel in (
        "drawable/ic_launcher_background.xml",
        "drawable-v24/ic_launcher_foreground.xml",
        "values/ic_launcher_background.xml",
    ):
        stale = ANDROID_RES / stale_rel
        if stale.exists():
            stale.unlink()

    anydpi = ANDROID_RES / "mipmap-anydpi-v26"
    anydpi.mkdir(parents=True, exist_ok=True)
    adaptive_xml = """<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@mipmap/ic_launcher_background"/>
    <foreground android:drawable="@mipmap/ic_launcher_foreground"/>
    <monochrome android:drawable="@mipmap/ic_launcher_monochrome"/>
</adaptive-icon>
"""
    (anydpi / "ic_launcher.xml").write_text(adaptive_xml, encoding="utf-8")
    (anydpi / "ic_launcher_round.xml").write_text(adaptive_xml, encoding="utf-8")
    print("Generated PWA and Android launcher/adaptive/splash icons from mark.svg.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
