#!/usr/bin/env python3
"""Write Cheap Rides brand SVGs and rasterize PNG and ICO files.

Uses CairoSVG for the PNG render and Pillow for the multi-size favicon.ico.
Run from anywhere: python3 cheaprides/scripts/render-brand.py
"""

from pathlib import Path

import cairosvg
from PIL import Image

ROOT = Path(__file__).resolve().parents[1] / "public"

MARK = """
  <text x="32" y="27" text-anchor="middle" font-family="Inter, sans-serif" font-weight="700" font-size="15" fill="#FF6A1A" letter-spacing="0.5">406</text>
  <path fill="#FF6A1A" d="M14 40h28l6-8h6c2.2 0 4 1.8 4 4v6H14v-2z"/>
  <path fill="#E7E5E4" d="M22 32h10l4 6H20z"/>
  <circle cx="22" cy="46" r="3.4" fill="#0A0A0A"/>
  <circle cx="46" cy="46" r="3.4" fill="#0A0A0A"/>
  <circle cx="22" cy="46" r="1.5" fill="#FF6A1A"/>
  <circle cx="46" cy="46" r="1.5" fill="#FF6A1A"/>
"""

FAVICON = f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect width="64" height="64" rx="14" fill="#0A0A0A"/>
  {MARK}
</svg>
"""

SQUARE = f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect width="64" height="64" fill="#0A0A0A"/>
  {MARK}
</svg>
"""

MASKABLE = f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" fill="#0A0A0A"/>
  <g transform="translate(96 96) scale(5)">
    {MARK}
  </g>
</svg>
"""

LOGO_DARK = f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 520 72">
  <rect x="4" y="4" width="64" height="64" rx="14" fill="#0A0A0A"/>
  <g transform="translate(4 4)">{MARK}</g>
  <text x="84" y="48" font-family="Inter, sans-serif" font-weight="700" font-size="32" fill="#E7E5E4">406 CHEAP </text>
  <text x="292" y="48" font-family="Inter, sans-serif" font-weight="700" font-size="32" fill="#FF6A1A">RIDES</text>
</svg>
"""

LOGO_LIGHT = f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 520 72">
  <rect x="4" y="4" width="64" height="64" rx="14" fill="#0A0A0A"/>
  <g transform="translate(4 4)">{MARK}</g>
  <text x="84" y="48" font-family="Inter, sans-serif" font-weight="700" font-size="32" fill="#0A0A0A">406 CHEAP </text>
  <text x="292" y="48" font-family="Inter, sans-serif" font-weight="700" font-size="32" fill="#FF6A1A">RIDES</text>
</svg>
"""

OG = f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 630">
  <rect width="1200" height="630" fill="#0A0A0A"/>
  <radialGradient id="glow" cx="85%" cy="0%" r="55%">
    <stop offset="0%" stop-color="#FF6A1A" stop-opacity="0.22"/>
    <stop offset="70%" stop-color="#FF6A1A" stop-opacity="0"/>
  </radialGradient>
  <rect width="1200" height="630" fill="url(#glow)"/>
  <g transform="translate(96 210) scale(3.2)">
    <rect width="64" height="64" rx="14" fill="#121212"/>
    {MARK}
  </g>
  <text x="340" y="250" font-family="Inter, sans-serif" font-weight="700" font-size="72" fill="#E7E5E4">406 CHEAP</text>
  <text x="340" y="330" font-family="Inter, sans-serif" font-weight="700" font-size="72" fill="#FF6A1A">RIDES</text>
  <text x="340" y="400" font-family="Inter, sans-serif" font-weight="500" font-size="32" fill="#E7E5E4">Cheap cars around Billings, scored in plain English.</text>
  <text x="340" y="460" font-family="Inter, sans-serif" font-weight="500" font-size="26" fill="#57534E">$7 a month or $49 a year. 7-day free trial.</text>
</svg>
"""


def write(name, text):
    path = ROOT / name
    path.write_text(text.strip() + "\n", encoding="utf-8")
    return path


def png_from_svg(svg_path, dest, width, height):
    cairosvg.svg2png(
        url=str(svg_path),
        write_to=str(dest),
        output_width=width,
        output_height=height,
    )


def main():
    favicon = write("favicon.svg", FAVICON)
    write("logo-dark.svg", LOGO_DARK)
    write("logo-light.svg", LOGO_LIGHT)
    square = write("icon-square.svg", SQUARE)
    maskable = write("maskable-icon.svg", MASKABLE)
    og = write("og-image.svg", OG)

    png_from_svg(square, ROOT / "apple-touch-icon.png", 180, 180)
    png_from_svg(square, ROOT / "icon-192.png", 192, 192)
    png_from_svg(square, ROOT / "icon-512.png", 512, 512)
    png_from_svg(maskable, ROOT / "maskable-icon.png", 512, 512)
    png_from_svg(og, ROOT / "og-image.png", 1200, 630)

    frames = []
    for size in (16, 32, 48):
        tmp = ROOT / f".favicon-{size}.png"
        png_from_svg(favicon, tmp, size, size)
        frames.append(Image.open(tmp).convert("RGBA"))
        tmp.unlink()
    frames[-1].save(
        ROOT / "favicon.ico",
        format="ICO",
        sizes=[(16, 16), (32, 32), (48, 48)],
        append_images=frames[:-1],
    )
    print("wrote brand files in", ROOT)


if __name__ == "__main__":
    main()
