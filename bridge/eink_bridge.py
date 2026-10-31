#!/usr/bin/env python3
"""sparkDash e-ink bridge.

A self-contained local service that (a) renders a 400x300 three-colour e-paper
scene with Pillow and (b) pushes the result to a Bluetooth e-paper tag over BLE
with ``bleak``.

The HTTP surface uses only the Python standard library
(``http.server.ThreadingHTTPServer``). ``bleak`` is imported lazily so that
``--selftest`` and ``POST /render`` work on machines without Bluetooth.

Usage:
    python eink_bridge.py --selftest [out.png]
    python eink_bridge.py --host 127.0.0.1 --port 8790 --log INFO
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import functools
import io
import json
import logging
import math
import os
import random
import subprocess
import re
import sys
import threading
import time
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Dict, List, Optional, Sequence, Tuple
from urllib.parse import parse_qs, urlsplit

from PIL import Image, ImageDraw, ImageFilter, ImageFont

LOGGER = logging.getLogger("eink-bridge")

VERSION = "1.0.0"

# --------------------------------------------------------------------------- #
# Panel geometry and palette
# --------------------------------------------------------------------------- #

CANVAS_W = 400
CANVAS_H = 300
MARGIN = 12

COLOR_BLACK: Tuple[int, int, int] = (20, 20, 20)  # #141414
COLOR_WHITE: Tuple[int, int, int] = (242, 240, 230)  # #F2F0E6
COLOR_YELLOW: Tuple[int, int, int] = (232, 190, 40)  # #E8BE28
COLOR_RED: Tuple[int, int, int] = (178, 48, 42)  # #B2302A

PIGMENTS: Dict[str, Tuple[int, int, int]] = {
    "yellow": COLOR_YELLOW,
    "red": COLOR_RED,
}
# Bar track: 35% of the way from the theme background to the ink. On the default
# dark theme this is (89, 89, 89), i.e. the requested 35% grey.
BAR_TRACK_RATIO = 0.35
ROW_GAP = 2
# Secondary text stays near-white: the tag only has three inks, so "dim" grey is
# dithered and small CJK glyphs dissolve if the ratio drops much below 0.85.
DIM_INK_RATIO = 0.93
# Draw the scene at N x and scale down; keeps small CJK text legible.
SUPERSAMPLE = 2
# Below this luminance gap the photo would swallow the glyphs; add a backing strip.
TEXT_CONTRAST_FLOOR = 96

# Typography sizes (pixels).
TITLE_SIZE = 22
SUBTITLE_SIZE = 15
HEADLINE_LABEL_SIZE = 17
HEADLINE_VALUE_SIZE = 64
STAT_SIZE = 16
STAT_VALUE_SIZE = 18
ROW_SIZE = 15
FOOTER_SIZE = 12

# Noto Sans CJK first (production Linux), then macOS CJK fonts and DejaVu so the
# renderer still produces readable output on a developer machine.
FONT_BOLD_CANDIDATES: Tuple[str, ...] = (
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc",
    "/usr/share/fonts/truetype/noto/NotoSansCJK-Bold.ttc",
    "/usr/share/fonts/noto-cjk/NotoSansCJK-Bold.ttc",
    "/usr/share/fonts/opentype/noto/NotoSansCJKsc-Bold.otf",
    "/System/Library/Fonts/Hiragino Sans GB.ttc",
    "/System/Library/Fonts/STHeiti Medium.ttc",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf",
    "/Library/Fonts/Arial Bold.ttf",
)
FONT_REGULAR_CANDIDATES: Tuple[str, ...] = (
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/noto-cjk/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/opentype/noto/NotoSansCJKsc-Regular.otf",
    "/System/Library/Fonts/Hiragino Sans GB.ttc",
    "/System/Library/Fonts/STHeiti Light.ttc",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/dejavu/DejaVuSans.ttf",
    "/Library/Fonts/Arial.ttf",
)

DEFAULT_PREVIEW_PATH = "/tmp/eink-preview.png"

# --------------------------------------------------------------------------- #
# BLE protocol constants (verified against real hardware; do not change)
# --------------------------------------------------------------------------- #

EPD_SERVICE_UUID = "62750001-d828-918d-fb46-b6c11c675aec"
EPD_CHAR_UUID = "62750002-d828-918d-fb46-b6c11c675aec"

CMD_INIT = b"\x01"
CMD_REFRESH = b"\x05"

ROW_STRIDE = CANVAS_W // 8  # 50 bytes per row
PLANE_SIZE = ROW_STRIDE * CANVAS_H  # 15000 bytes per plane
MAX_WRITE_BYTES = 244  # hardware limit per GATT write
DEFAULT_MTU = 244
CONNECT_TIMEOUT = 20.0
INIT_MTU_WAIT = 2.0
REFRESH_WAIT = 20.0
WRITE_GAP_SECONDS = 0.003
SCAN_SECONDS = 8.0
DEVICE_NAME_HINT = "NRF_EPD"

# One BLE connection at a time, across every request thread.
BLE_LOCK = threading.Lock()


# --------------------------------------------------------------------------- #
# Font handling and text fitting
# --------------------------------------------------------------------------- #


_FONT_BOLD: Dict[int, bool] = {}


@functools.lru_cache(maxsize=128)
def load_font(size: int, bold: bool = False) -> Any:
    """Load a TrueType font of ``size`` pixels, preferring Noto Sans CJK.

    Falls back to any DejaVuSans / Arial / Pillow's default bitmap font when the
    Noto CJK collection is unavailable.
    """
    candidates = FONT_BOLD_CANDIDATES if bold else FONT_REGULAR_CANDIDATES
    for path in candidates:
        try:
            if not os.path.exists(path):
                continue
            return ImageFont.truetype(path, size, index=0)
        except OSError:
            continue
    try:
        return ImageFont.load_default(size=size)  # Pillow >= 10.1
    except TypeError:  # pragma: no cover - very old Pillow
        return ImageFont.load_default()


def text_width(font: Any, text: str) -> float:
    """Return the rendered width of ``text`` in pixels."""
    try:
        return float(font.getlength(text))
    except Exception:  # pragma: no cover - bitmap fallback fonts
        return float(len(text)) * 0.6 * float(getattr(font, "size", 12))


def truncate_text(text: str, font: Any, max_width: float) -> str:
    """Truncate ``text`` with a trailing ellipsis so it fits in ``max_width``."""
    if max_width <= 1:
        return ""
    if text_width(font, text) <= max_width:
        return text
    ellipsis = "…"
    ellipsis_w = text_width(font, ellipsis)
    lo, hi = 0, len(text)
    while lo < hi:
        mid = (lo + hi + 1) // 2
        if text_width(font, text[:mid]) + ellipsis_w <= max_width:
            lo = mid
        else:
            hi = mid - 1
    return text[:lo].rstrip() + ellipsis


def fit_font(text: str, max_width: float, start_size: int, min_size: int, bold: bool) -> Tuple[Any, str]:
    """Return the largest font (down to ``min_size``) plus text that fits ``max_width``."""
    size = start_size
    while size > min_size:
        font = load_font(size, bold)
        if text_width(font, text) <= max_width:
            return font, text
        size -= 4
    font = load_font(min_size, bold)
    return font, truncate_text(text, font, max_width)


def mix(a: Tuple[int, int, int], b: Tuple[int, int, int], t: float) -> Tuple[int, int, int]:
    """Linear blend of two RGB tuples, ``t`` = weight of ``a``."""
    t = max(0.0, min(1.0, t))
    return (
        int(round(a[0] * t + b[0] * (1.0 - t))),
        int(round(a[1] * t + b[1] * (1.0 - t))),
        int(round(a[2] * t + b[2] * (1.0 - t))),
    )


# --------------------------------------------------------------------------- #
# Scene parsing
# --------------------------------------------------------------------------- #


@dataclass
class Stat:
    """One statistic tile from the scene schema."""

    label: str
    value: str


@dataclass
class Row:
    """One progress row from the scene schema."""

    label: str
    value: str
    ratio: float = 0.0


@dataclass
class SceneSpec:
    """Validated, render-ready scene description."""

    headline_value: str
    headline_label: str = ""
    cost_label: str = ""
    cost_value: str = ""
    title: str = ""
    subtitle: str = ""
    stats: List[Stat] = field(default_factory=list)
    rows: List[Row] = field(default_factory=list)
    footer: str = ""
    pigment_name: str = "yellow"
    theme: str = "dark"
    background: Optional[str] = None
    background_dim: float = 0.35
    # Background photo transform: "zoom" multiplies the cover-fit scale, the
    # offsets pan the crop window by a fraction of the canvas, "brightness" is
    # added per channel and "contrast" is applied around mid-grey.
    background_zoom: float = 1.0
    background_offset_x: float = 0.0
    background_offset_y: float = 0.0
    background_brightness: int = 0
    background_contrast: int = 0
    # "halo" outlines each glyph (the photo keeps its detail), "plate" replaces
    # the content area with the base colour, "off" draws straight on the photo.
    text_protection: str = "auto"
    halo_width: int = 2
    # Dither engine for the photo. The UI layer is painted afterwards with exact
    # palette colours, so no dither can eat a glyph stroke.
    dither_algorithm: str = "floyd-steinberg"
    dither_strength: float = 1.0

    @property
    def pigment(self) -> Tuple[int, int, int]:
        """RGB tuple of the configured pigment colour."""
        return PIGMENTS[self.pigment_name]


def _as_text(value: Any) -> str:
    """Coerce a JSON scalar to a short display string."""
    if value is None:
        return ""
    if isinstance(value, bool):
        return "yes" if value else "no"
    if isinstance(value, (int, float)):
        text = f"{value:g}" if isinstance(value, float) else str(value)
        return text
    if isinstance(value, str):
        return value.strip()
    return json.dumps(value, ensure_ascii=False)


def _clamp(value: float, low: float, high: float) -> float:
    """Clamp ``value`` into ``[low, high]``."""
    return max(low, min(high, value))


def _as_float(value: Any, default: float) -> float:
    """Coerce a JSON scalar to ``float``, falling back to ``default``.

    ``None``, booleans, non-numeric strings and non-finite numbers all fall
    back, so a scene built by hand (``1e9``, ``"wide"``, ``null``) still renders
    instead of taking the request down.
    """
    if value is None or isinstance(value, bool):
        return default
    try:
        number = float(value)
    except (TypeError, ValueError):
        return default
    if math.isnan(number) or math.isinf(number):
        return default
    return number


def parse_scene(raw: Any) -> SceneSpec:
    """Validate and normalise a scene object from the HTTP API.

    Raises:
        ValueError: when the scene is not an object or the headline value is missing.
    """
    if not isinstance(raw, dict):
        raise ValueError("scene must be a JSON object")

    headline = raw.get("headline")
    if not isinstance(headline, dict):
        raise ValueError("scene.headline is required")
    headline_value = _as_text(headline.get("value"))
    if not headline_value:
        raise ValueError("scene.headline.value is required")

    pigment = _as_text(raw.get("pigment")).lower()
    if pigment not in PIGMENTS:
        pigment = "yellow"

    theme = _as_text(raw.get("theme")).lower()
    if theme not in ("dark", "light"):
        theme = "dark"

    try:
        background_dim = float(raw.get("backgroundDim", 0.35))
    except (TypeError, ValueError):
        background_dim = 0.35

    protection = _as_text(raw.get("textProtection")).lower()
    if protection == "band":  # older configs used a rectangular band
        protection = "halo"
    if protection == "scrim":  # removed: the wash made the photo unrecognisable
        protection = "auto"
    if protection not in ("auto", "halo", "plate", "off"):
        protection = "auto"
    try:
        halo_width = int(round(float(raw.get("haloWidth", 2))))
    except (TypeError, ValueError):
        halo_width = 2
    halo_width = max(1, min(4, halo_width))

    background_zoom = _clamp(_as_float(raw.get("backgroundZoom"), 1.0), 1.0, 4.0)
    background_offset_x = _clamp(_as_float(raw.get("backgroundOffsetX"), 0.0), -1.0, 1.0)
    background_offset_y = _clamp(_as_float(raw.get("backgroundOffsetY"), 0.0), -1.0, 1.0)
    background_brightness = int(
        round(_clamp(_as_float(raw.get("backgroundBrightness"), 0.0), -100.0, 100.0))
    )
    background_contrast = int(
        round(_clamp(_as_float(raw.get("backgroundContrast"), 0.0), -100.0, 100.0))
    )
    dither_algorithm = normalise_dither_algorithm(raw.get("ditherAlgorithm"))
    dither_strength = _clamp(_as_float(raw.get("ditherStrength"), 1.0), 0.0, 1.0)

    background = raw.get("background")
    background_path: Optional[str] = None
    if isinstance(background, str) and background.strip():
        background_path = background.strip()

    stats: List[Stat] = []
    raw_stats = raw.get("stats")
    if isinstance(raw_stats, list):
        for item in raw_stats[:3]:
            if not isinstance(item, dict):
                continue
            label = _as_text(item.get("label"))
            value = _as_text(item.get("value"))
            if label or value:
                stats.append(Stat(label=label, value=value))

    rows: List[Row] = []
    raw_rows = raw.get("rows")
    if isinstance(raw_rows, list):
        for item in raw_rows[:5]:
            if not isinstance(item, dict):
                continue
            try:
                ratio = _clamp(float(item.get("ratio", 0.0)), 0.0, 1.0)
            except (TypeError, ValueError):
                ratio = 0.0
            label = _as_text(item.get("label"))
            value = _as_text(item.get("value"))
            if label or value:
                rows.append(Row(label=label, value=value, ratio=ratio))

    return SceneSpec(
        headline_value=headline_value,
        headline_label=_as_text(headline.get("label")),
        cost_label=_as_text((raw.get("cost") or {}).get("label")) if isinstance(raw.get("cost"), dict) else "",
        cost_value=_as_text((raw.get("cost") or {}).get("value")) if isinstance(raw.get("cost"), dict) else "",
        title=_as_text(raw.get("title")),
        subtitle=_as_text(raw.get("subtitle")),
        stats=stats,
        rows=rows,
        footer=_as_text(raw.get("footer")),
        pigment_name=pigment,
        theme=theme,
        background=background_path,
        background_dim=_clamp(background_dim, 0.0, 1.0),
        background_zoom=background_zoom,
        background_offset_x=background_offset_x,
        background_offset_y=background_offset_y,
        background_brightness=background_brightness,
        background_contrast=background_contrast,
        text_protection=protection,
        halo_width=halo_width,
        dither_algorithm=dither_algorithm,
        dither_strength=dither_strength,
    )


# --------------------------------------------------------------------------- #
# Rendering
# --------------------------------------------------------------------------- #


def _load_photo(path: str) -> Image.Image:
    """Open ``path`` and return it as RGB (the file handle is released here)."""
    with Image.open(path) as handle:
        img = handle.convert("RGB")
    return img


def _apply_levels(photo: Image.Image, brightness: int, contrast: int) -> Image.Image:
    """Apply additive brightness and a mid-grey centred contrast curve.

    Both values arrive pre-clamped from ``parse_scene``; the contrast factor is
    clamped again here so a hand-built ``SceneSpec`` cannot collapse the photo
    to flat grey.
    """
    if brightness == 0 and contrast == 0:
        return photo
    factor = _clamp(1.0 + contrast / 100.0, 0.2, 3.0)
    lut = [
        int(round(_clamp((value - 128) * factor + 128 + brightness, 0.0, 255.0)))
        for value in range(256)
    ]
    return photo.point(lut * 3)


def _transform_photo(
    photo: Image.Image,
    zoom: float,
    offset_x: float,
    offset_y: float,
    size: Tuple[int, int],
) -> Image.Image:
    """Zoom around the drawn centre and pan the crop window over the photo.

    ``zoom`` multiplies the cover-fit scale and ``offset_*`` shifts the window by
    a fraction of the canvas width/height. The window is clamped inside the
    photo, so panning never shows an empty border and never needs a fill colour.
    """
    if zoom <= 1.0 and offset_x == 0.0 and offset_y == 0.0:
        return photo
    target_w, target_h = size
    src_w, src_h = photo.size
    if src_w <= 0 or src_h <= 0:
        return photo
    scale = max(target_w / src_w, target_h / src_h) * max(1.0, zoom)
    window_w = min(float(src_w), target_w / scale)
    window_h = min(float(src_h), target_h / scale)
    centre_x = src_w / 2.0 + offset_x * (target_w / scale)
    centre_y = src_h / 2.0 + offset_y * (target_h / scale)
    left = _clamp(centre_x - window_w / 2.0, 0.0, max(0.0, src_w - window_w))
    top = _clamp(centre_y - window_h / 2.0, 0.0, max(0.0, src_h - window_h))
    box = (
        int(round(left)),
        int(round(top)),
        int(round(min(float(src_w), left + window_w))),
        int(round(min(float(src_h), top + window_h))),
    )
    if box[2] - box[0] < 1 or box[3] - box[1] < 1:
        return photo
    return photo.crop(box)


def _cover_fit(photo: Image.Image, size: Tuple[int, int]) -> Image.Image:
    """Cover-fit ``photo`` to ``size`` (centre crop) and return greyscale RGB."""
    target_w, target_h = size
    src_w, src_h = photo.size
    if src_w <= 0 or src_h <= 0:
        raise ValueError("background image has no pixels")
    scale = max(target_w / src_w, target_h / src_h)
    new_w = max(target_w, int(round(src_w * scale)))
    new_h = max(target_h, int(round(src_h * scale)))
    img = photo.resize((new_w, new_h), Image.Resampling.LANCZOS)
    left = max(0, (new_w - target_w) // 2)
    top = max(0, (new_h - target_h) // 2)
    img = img.crop((left, top, left + target_w, top + target_h))
    grey = img.convert("L").convert("RGB")
    return grey


def _base_image(spec: SceneSpec) -> Image.Image:
    """Build the background layer for the scene (solid theme colour plus optional photo)."""
    if spec.theme == "dark":
        base = Image.new("RGB", (CANVAS_W, CANVAS_H), COLOR_BLACK)
    else:
        base = Image.new("RGB", (CANVAS_W, CANVAS_H), COLOR_WHITE)
    if not spec.background:
        return base
    try:
        photo = _load_photo(spec.background)
        # Levels first, then the crop window, then the cover fit: the transform
        # has to see the tone curve the user asked for, and the blend with the
        # theme colour stays the very last step.
        photo = _apply_levels(photo, spec.background_brightness, spec.background_contrast)
        photo = _transform_photo(
            photo,
            spec.background_zoom,
            spec.background_offset_x,
            spec.background_offset_y,
            (CANVAS_W, CANVAS_H),
        )
        photo = _cover_fit(photo, (CANVAS_W, CANVAS_H))
    except (OSError, ValueError) as exc:
        LOGGER.warning("background %s unreadable: %s", spec.background, exc)
        return base
    return Image.blend(base, photo, spec.background_dim)


def _ink_colours(spec: SceneSpec) -> Tuple[Tuple[int, int, int], Tuple[int, int, int], Tuple[int, int, int]]:
    """Return (foreground, dim, base) colours for the configured theme."""
    if spec.theme == "dark":
        return COLOR_WHITE, mix(COLOR_WHITE, COLOR_BLACK, DIM_INK_RATIO), COLOR_BLACK
    return COLOR_BLACK, mix(COLOR_BLACK, COLOR_WHITE, DIM_INK_RATIO), COLOR_WHITE


def _draw_top(
    draw: Any,
    xy: Tuple[int, int],
    text: str,
    font: Any,
    fill: Tuple[int, int, int],
    halo: Optional[Tuple[int, int, int]] = None,
    halo_width: int = 0,
) -> int:
    """Draw ``text`` so its first ink pixel starts at ``xy``; return the ink height.

    PIL anchors glyphs on the font's ascent box, and the CJK faces ship a large
    internal leading — drawing at a nominal ``y`` pushed the glyphs tens of pixels
    down and made the headline collide with the label above it. Measuring the
    real ink box keeps every block where the layout put it.
    """
    if not text:
        return 0
    bbox = draw.textbbox((0, 0), text, font=font)
    pos = (xy[0] - bbox[0], xy[1] - bbox[1])
    if halo is not None and halo_width > 0:
        # Thin theme-coloured ring under the glyphs: the photo keeps its detail
        # everywhere else, the type keeps a clean edge.
        draw.text(pos, text, font=font, fill=fill, stroke_width=halo_width, stroke_fill=halo)
    else:
        draw.text(pos, text, font=font, fill=fill)
    return bbox[3] - bbox[1]


def _ink_height(draw: Any, text: str, font: Any) -> int:
    if not text:
        return 0
    bbox = draw.textbbox((0, 0), text, font=font)
    return bbox[3] - bbox[1]


def _protect_text_area(image: Image.Image, spec: SceneSpec) -> Image.Image:
    """Keep type readable on top of a photo by replacing the content area.

    A three-ink panel cannot show a photo and fine text at the same time — the
    dither that renders the photo also eats the thin glyph strokes, so "plate"
    paints the content area in the theme's base colour and the photo stays
    visible only around it.
    """
    inset = max(2, MARGIN // 3)
    box = (inset, inset, CANVAS_W - inset, CANVAS_H - inset)
    flat = Image.new("RGB", (box[2] - box[0], box[3] - box[1]), _ink_colours(spec)[2])
    image.paste(flat, box)
    return image


def _checker_rect(
    image: Image.Image,
    box: Tuple[int, int, int, int],
    ink: Tuple[int, int, int],
    ground: Tuple[int, int, int],
) -> None:
    """Fill a rectangle with a 1 px checker of two palette colours (grey track)."""
    x0, y0, x1, y1 = box
    for y in range(max(0, y0), min(CANVAS_H, y1)):
        for x in range(max(0, x0), min(CANVAS_W, x1)):
            image.putpixel((x, y), ink if (x + y) & 1 else ground)


def _paste_text(
    image: Image.Image,
    xy: Tuple[float, float],
    value: str,
    size: int,
    bold: bool,
    fill: Tuple[int, int, int],
    ring: Optional[Tuple[int, int, int]],
    ring_w: int,
) -> None:
    """Rasterise one text run at panel resolution from a 1-bit glyph mask."""
    size = max(6, int(size))
    font = load_font(size, bold)
    bbox = font.getbbox(value)
    pad = max(0, ring_w) + 1
    width = max(1, bbox[2] - bbox[0] + 2 * pad)
    height = max(1, bbox[3] - bbox[1] + 2 * pad)
    layer = Image.new("L", (width, height), 0)
    ImageDraw.Draw(layer).text((pad - bbox[0], pad - bbox[1]), value, font=font, fill=255)
    mask = layer.point(lambda value: 255 if value >= 128 else 0)
    x = int(round(xy[0])) - pad
    y = int(round(xy[1])) - pad
    if ring is not None and ring_w > 0:
        ring_mask = mask.filter(ImageFilter.MaxFilter(2 * ring_w + 1))
        image.paste(ring, (x, y), ring_mask)
    image.paste(fill, (x, y), mask)


def render_scene(spec: SceneSpec) -> Image.Image:
    """Draw ``spec`` onto a 400x300 RGB canvas (not yet palette-quantised).

    Text is drawn on a supersampled canvas and scaled back down: 12-15 px CJK
    glyphs are unreadable on a 400 px e-paper panel when drawn at 1x, and the
    downscale gives them the stroke weight the panel can actually reproduce.
    """
    scale = SUPERSAMPLE
    image = _base_image(spec)
    if spec.background and spec.text_protection == "plate":
        image = _protect_text_area(image, spec)
    if scale > 1:
        image = image.resize((CANVAS_W * scale, CANVAS_H * scale), Image.LANCZOS)
    draw = ImageDraw.Draw(image)
    fg, dim, base = _ink_colours(spec)
    pigment = spec.pigment
    margin = MARGIN * scale
    halo = base if (spec.background and spec.text_protection == "halo") else None

    text_items: List[Dict[str, Any]] = []
    bar_items: List[Dict[str, Any]] = []

    def tdraw(xy, value, font, fill, width=1, band=True):
        """Queue one text run; it is rasterised at panel resolution at the end.

        Text is drawn last, at 1x, from a hard-thresholded glyph mask: on a
        three-ink panel an antialiased edge either dissolves into the dither or
        closes the counters of a 16 px CJK glyph, and neither reads as text.
        """
        if not value:
            return 0
        bbox = draw.textbbox((0, 0), value, font=font)
        size2x = getattr(font, "size", ROW_SIZE * scale)
        ring_color = None
        ring_w = 0
        if spec.background and spec.text_protection in ("auto", "halo"):
            ring_color = base
            ring_w = max(1, min(spec.halo_width, int(round(size2x / scale * 0.06)))) * scale
        text_items.append(
            {
                "xy": xy,
                "value": value,
                "size": size2x,
                "bold": _FONT_BOLD.get(id(font), False),
                "fill": fill,
                "ring": ring_color,
                "ring_w": ring_w,
            }
        )
        return bbox[3] - bbox[1]
    content_w = (CANVAS_W - 2 * MARGIN) * scale

    footer_h = (FOOTER_SIZE + 6) * scale if spec.footer else 0
    bottom_limit = (CANVAS_H - MARGIN) * scale - footer_h
    cursor = margin

    if spec.title:
        font = load_font(TITLE_SIZE * scale, True)
        cursor += tdraw((margin, cursor), truncate_text(spec.title, font, content_w), font, fg) + 2 * scale
    if spec.subtitle:
        font = load_font(SUBTITLE_SIZE * scale, True)
        cursor += tdraw((margin, cursor), truncate_text(spec.subtitle, font, content_w), font, dim) + 8 * scale

    if spec.headline_label or spec.cost_value:
        font = load_font(HEADLINE_LABEL_SIZE * scale, True)
        if spec.cost_value:
            cost_text = f"{spec.cost_label} {spec.cost_value}".strip()
            cost_w = text_width(font, cost_text)
            tdraw((CANVAS_W * scale - margin - cost_w, cursor), cost_text, font, pigment, width=2)
        if spec.headline_label:
            cursor += tdraw(
                (margin, cursor),
                truncate_text(spec.headline_label, font, content_w),
                font,
                fg,
            ) + 2 * scale
    value_font, value_text = fit_font(
        spec.headline_value,
        content_w,
        HEADLINE_VALUE_SIZE * scale,
        (HEADLINE_VALUE_SIZE // 2) * scale,
        bold=True,
    )
    cursor += tdraw((margin, cursor), value_text, value_font, pigment) + 8 * scale

    if spec.stats:
        cell_w = content_w / 3.0
        inner = cell_w - 10 * scale
        label_font = load_font(STAT_SIZE * scale, True)
        value_font_stat = load_font(STAT_VALUE_SIZE * scale, True)
        stats_top = cursor
        cell_h = 0
        for index, stat in enumerate(spec.stats):
            x = margin + int(round(cell_w * index))
            y = stats_top
            if stat.label:
                y += tdraw((x, y), truncate_text(stat.label, label_font, inner), label_font, fg) + 4 * scale
            if stat.value:
                y += tdraw((x, y), truncate_text(stat.value, value_font_stat, inner), value_font_stat, fg)
            cell_h = max(cell_h, y - stats_top)
        cursor = stats_top + cell_h + 16 * scale

    if spec.rows:
        row_font = load_font(ROW_SIZE * scale, True)
        value_font_row = load_font(ROW_SIZE * scale, True)
        track = mix(fg, base, BAR_TRACK_RATIO)
        bar_h = 8 * scale
        line_h = max(_ink_height(draw, "spark001", row_font), ROW_SIZE * scale)
        slot = line_h + 10 * scale
        rows_bottom = bottom_limit - ROW_GAP * scale
        count = min(len(spec.rows), max(0, int((rows_bottom - cursor) // slot)))
        for row in spec.rows[:count]:
            y = cursor
            value_w = text_width(value_font_row, row.value)
            label_w = 0.0
            if row.label:
                label_text = truncate_text(row.label, row_font, content_w * 0.45)
                label_w = text_width(row_font, label_text)
                tdraw((margin, y), label_text, row_font, fg)
            bar_x = margin + int(label_w) + 8 * scale
            bar_max = max(0, int(CANVAS_W * scale - margin - value_w - 8 * scale - bar_x))
            bar_top = y + int((line_h - bar_h) / 2)
            if bar_max > 0:
                bar_items.append({"box": (bar_x, bar_top, bar_x + bar_max, bar_top + bar_h), "filled": 0})
                filled = int(round(bar_max * max(0.0, min(1.0, row.ratio))))
                if filled > 0:
                    bar_items[-1]["filled"] = filled
            if row.value:
                tdraw((CANVAS_W * scale - margin - value_w - 2 * scale, y),
                    row.value,
                    value_font_row,
                    fg,
                )
            cursor += slot

    if spec.footer:
        font = load_font(FOOTER_SIZE * scale, True)
        text = truncate_text(spec.footer, font, content_w)
        height = _ink_height(draw, text, font)
        tdraw((margin, CANVAS_H * scale - margin - height), text, font, dim)

    if scale > 1:
        base_1x = image.resize((CANVAS_W, CANVAS_H), Image.LANCZOS)
    else:
        base_1x = image.copy()

    # Only the background is dithered. The UI is then painted on top with exact
    # palette colours, so no dither can eat a glyph stroke.
    image = dither_to_palette(base_1x, spec.pigment, spec.dither_algorithm, spec.dither_strength)

    for bar in bar_items:
        x0, y0, x1, y1 = (int(round(value / scale)) for value in bar["box"])
        _checker_rect(image, (x0, y0, x1, y1), fg, base)
        filled = int(round(bar["filled"] / scale))
        if filled > 0:
            image.paste(pigment, (x0, y0, min(x1, x0 + filled), y1))

    for item in text_items:
        _paste_text(
            image,
            (item["xy"][0] / scale, item["xy"][1] / scale),
            item["value"],
            int(round(item["size"] / scale)),
            item["bold"],
            item["fill"],
            item["ring"],
            int(round(item["ring_w"] / scale)),
        )
    return image


# --------------------------------------------------------------------------- #
# Dither engine
# --------------------------------------------------------------------------- #

# Wire order of GET /algorithms: the settings UI shows this list verbatim.
DITHER_ALGORITHMS: Tuple[str, ...] = (
    "none",
    "floyd-steinberg",
    "jarvis",
    "stucki",
    "burkes",
    "sierra",
    "sierra-lite",
    "atkinson",
    "bayer8",
    "blue-noise",
)
DEFAULT_DITHER_ALGORITHM = "floyd-steinberg"

# Published diffusion kernels as (dx, dy, weight) plus the divisor that
# normalises them. Atkinson is the odd one out: 6/8 of the error is diffused and
# the remaining 2/8 is deliberately discarded, so it keeps a divisor of 8 while
# carrying only six unit weights.
_DITHER_KERNELS: Dict[str, Tuple[float, Tuple[Tuple[int, int, float], ...]]] = {
    "floyd-steinberg": (16.0, ((1, 0, 7.0), (-1, 1, 3.0), (0, 1, 5.0), (1, 1, 1.0))),
    "jarvis": (
        48.0,
        (
            (1, 0, 7.0), (2, 0, 5.0),
            (-2, 1, 3.0), (-1, 1, 5.0), (0, 1, 7.0), (1, 1, 5.0), (2, 1, 3.0),
            (-2, 2, 1.0), (-1, 2, 3.0), (0, 2, 5.0), (1, 2, 3.0), (2, 2, 1.0),
        ),
    ),
    "stucki": (
        42.0,
        (
            (1, 0, 8.0), (2, 0, 4.0),
            (-2, 1, 2.0), (-1, 1, 4.0), (0, 1, 8.0), (1, 1, 4.0), (2, 1, 2.0),
            (-2, 2, 1.0), (-1, 2, 2.0), (0, 2, 4.0), (1, 2, 2.0), (2, 2, 1.0),
        ),
    ),
    "burkes": (
        32.0,
        (
            (1, 0, 8.0), (2, 0, 4.0),
            (-2, 1, 2.0), (-1, 1, 4.0), (0, 1, 8.0), (1, 1, 4.0), (2, 1, 2.0),
        ),
    ),
    "sierra": (
        32.0,
        (
            (1, 0, 5.0), (2, 0, 3.0),
            (-2, 1, 2.0), (-1, 1, 4.0), (0, 1, 5.0), (1, 1, 4.0), (2, 1, 2.0),
            (-1, 2, 2.0), (0, 2, 3.0), (1, 2, 2.0),
        ),
    ),
    "sierra-lite": (4.0, ((1, 0, 2.0), (-1, 1, 1.0), (0, 1, 1.0))),
    "atkinson": (
        8.0,
        ((1, 0, 1.0), (2, 0, 1.0), (-1, 1, 1.0), (0, 1, 1.0), (1, 1, 1.0), (0, 2, 1.0)),
    ),
}

# Spelling variants a config or a hand-written request may arrive with.
_DITHER_ALIASES: Dict[str, str] = {
    "fs": "floyd-steinberg",
    "floyd_steinberg": "floyd-steinberg",
    "floydsteinberg": "floyd-steinberg",
    "jjn": "jarvis",
    "jarvis-judice-ninke": "jarvis",
    "sierra3": "sierra",
    "sierra-3": "sierra",
    "two-row-sierra": "sierra-lite",
    "bayer": "bayer8",
    "bayer-8": "bayer8",
    "blue_noise": "blue-noise",
    "bluenoise": "blue-noise",
    "off": "none",
}

# Diffused error is clamped to this many linear-light units per channel. The
# published kernels bound the error on their own, but a clipped highlight can
# still push a neighbour far enough to paint a stripe of the wrong ink.
_ERROR_CLAMP = 0.5

# Full-strength amplitude of an ordered mask, in linear-light units. It stops
# just short of the half-distance between black and white (0.4436), so a solid
# ink area stays solid while a grey ramp keeps its local average.
_ORDERED_BIAS = 0.44


def normalise_dither_algorithm(value: Any) -> str:
    """Return a canonical dither algorithm name; unknown input falls back."""
    if not isinstance(value, str):
        return DEFAULT_DITHER_ALGORITHM
    name = _DITHER_ALIASES.get(value.strip().lower(), value.strip().lower())
    if name in DITHER_ALGORITHMS:
        return name
    return DEFAULT_DITHER_ALGORITHM


def _bayer_matrix(order: int) -> List[List[float]]:
    """Return the classic 2**order Bayer threshold matrix, normalised to [0, 1)."""
    matrix = [[0]]
    for _ in range(order):
        size = len(matrix)
        grown = [[0] * (size * 2) for _ in range(size * 2)]
        for y in range(size):
            for x in range(size):
                base = matrix[y][x] * 4
                grown[y][x] = base
                grown[y][x + size] = base + 2
                grown[y + size][x] = base + 3
                grown[y + size][x + size] = base + 1
        matrix = grown
    cells = float(len(matrix) * len(matrix))
    return [[value / cells for value in row] for row in matrix]


def _void_and_cluster_mask(size: int, sigma: float, seed: int) -> List[List[float]]:
    """Rank every cell of a ``size`` x ``size`` torus with void-and-cluster.

    The ranking is what an ordered dither needs as a threshold mask: filling
    cells in ascending order reproduces a prototype whose gaps are as even as a
    blue-noise spectrum allows. The torus, the Gaussian cluster energy and the
    prototype-then-strip/fill schedule follow "The void-and-cluster method for
    dither array generation" (Ulichney, 1993); a shuffled mask would keep its
    low-frequency grain and read as blotches on the panel.

    Generation is a one-off at import and runs in a fraction of a second, so the
    mask is not shipped as a literal.
    """
    total = size * size
    half = total // 2
    rng = random.Random(seed)

    # Gaussian clustering energy over the torus, centre cell excluded: a pixel
    # must not count itself when the cluster energy is measured.
    radius = max(1, int(round(3.0 * sigma)))
    offsets = [
        (dy, dx, math.exp(-(dx * dx + dy * dy) / (2.0 * sigma * sigma)))
        for dy in range(-radius, radius + 1)
        for dx in range(-radius, radius + 1)
        if dx or dy
    ]
    neighbours = [
        [(((y + dy) % size) * size + ((x + dx) % size), weight) for dy, dx, weight in offsets]
        for y in range(size)
        for x in range(size)
    ]

    energy = [0.0] * total
    filled = bytearray(total)
    # The argmax/argmin scans are the hot path: keep two masked views of the
    # energy so each scan is one builtin pass instead of a Python loop.
    cluster_energy = [-math.inf] * total
    void_energy = [math.inf] * total

    def set_cell(index: int, on: bool) -> None:
        """Place or clear one pixel and update the surrounding energy."""
        filled[index] = 1 if on else 0
        sign = 1.0 if on else -1.0
        if on:
            cluster_energy[index] = energy[index]
            void_energy[index] = math.inf
        else:
            cluster_energy[index] = -math.inf
            void_energy[index] = energy[index]
        for other, weight in neighbours[index]:
            value = energy[other] + sign * weight
            energy[other] = value
            if filled[other]:
                cluster_energy[other] = value
            else:
                void_energy[other] = value

    cells = list(range(total))
    rng.shuffle(cells)
    for index in cells[:half]:
        set_cell(index, True)

    # Relax the random half-density seed into a homogeneous prototype.
    for _ in range(total * 8):
        cluster = cluster_energy.index(max(cluster_energy))
        set_cell(cluster, False)
        void = void_energy.index(min(void_energy))
        if void == cluster:
            set_cell(cluster, True)
            break
        set_cell(void, True)
    prototype = [index for index in range(total) if filled[index]]

    rank = [0] * total
    # Phase one: strip the prototype, so the pixels that survive longest rank
    # lowest and turn into the first ink dots of a threshold sweep.
    for value in range(half - 1, -1, -1):
        cluster = cluster_energy.index(max(cluster_energy))
        set_cell(cluster, False)
        rank[cluster] = value
    # Phase two: restore the prototype and fill its voids in order.
    for index in range(total):
        if filled[index]:
            set_cell(index, False)
    for index in prototype:
        set_cell(index, True)
    for value in range(half, total):
        void = void_energy.index(min(void_energy))
        set_cell(void, True)
        rank[void] = value
    divisor = float(total)
    return [[rank[y * size + x] / divisor for x in range(size)] for y in range(size)]


_BAYER8 = _bayer_matrix(3)
# 64x64 travels with the module so every render is reproducible; if the import
# budget ever has to shrink, _BLUE_NOISE_SIZE = 32 costs a tenth of the time.
_BLUE_NOISE_SIZE = 64
_BLUE_NOISE = _void_and_cluster_mask(_BLUE_NOISE_SIZE, 1.5, 0x5EED)

_LINEAR = [(value / 255.0) ** 2.2 for value in range(256)]


def _palette_linear(
    pigment: Tuple[int, int, int],
) -> Tuple[List[Tuple[int, int, int]], List[Tuple[float, float, float]]]:
    """Return the three scene inks plus their linear-light coordinates."""
    palette: List[Tuple[int, int, int]] = [COLOR_BLACK, COLOR_WHITE, pigment]
    return palette, [(_LINEAR[c[0]], _LINEAR[c[1]], _LINEAR[c[2]]) for c in palette]


def _quantise_diffusion(
    image: Image.Image,
    pigment: Tuple[int, int, int],
    weights: Sequence[Tuple[int, int, float]],
) -> Image.Image:
    """Nearest-colour quantisation with an optional error-diffusion kernel.

    ``weights`` holds already-normalised ``(dx, dy, weight)`` offsets; an empty
    sequence gives plain nearest-colour thresholding. The error buffer rolls one
    row per scanline, so even the two-row kernels stay O(width) in memory.
    """
    palette, palette_linear = _palette_linear(pigment)
    src = image.convert("RGB")
    width, height = src.size
    px = src.load()
    out = Image.new("RGB", (width, height))
    opx = out.load()

    rows = 1 + max((dy for _dx, dy, _weight in weights), default=0)
    buffer: List[List[float]] = [[0.0] * (width * 3) for _ in range(rows)]
    linear = _LINEAR
    clamp = _ERROR_CLAMP

    for y in range(height):
        current = buffer[0]
        for x in range(width):
            r, g, b = px[x, y]
            i = x * 3
            lr = linear[r] + current[i]
            lg = linear[g] + current[i + 1]
            lb = linear[b] + current[i + 2]

            best_idx = 0
            best_dist = -1.0
            for idx, (pr, pg, pb) in enumerate(palette_linear):
                dist = (lr - pr) ** 2 + (lg - pg) ** 2 + (lb - pb) ** 2
                if best_dist < 0.0 or dist < best_dist:
                    best_dist = dist
                    best_idx = idx
            opx[x, y] = palette[best_idx]

            if not weights:
                continue
            pr, pg, pb = palette_linear[best_idx]
            er, eg, eb = lr - pr, lg - pg, lb - pb
            if er == 0.0 and eg == 0.0 and eb == 0.0:
                continue
            for dx, dy, weight in weights:
                tx = x + dx
                if tx < 0 or tx >= width:
                    continue
                target = buffer[dy]
                j = tx * 3
                nr = target[j] + er * weight
                ng = target[j + 1] + eg * weight
                nb = target[j + 2] + eb * weight
                target[j] = clamp if nr > clamp else (-clamp if nr < -clamp else nr)
                target[j + 1] = clamp if ng > clamp else (-clamp if ng < -clamp else ng)
                target[j + 2] = clamp if nb > clamp else (-clamp if nb < -clamp else nb)
        buffer.pop(0)
        buffer.append([0.0] * (width * 3))
    return out


def _quantise_ordered(
    image: Image.Image,
    pigment: Tuple[int, int, int],
    mask: Sequence[Sequence[float]],
    bias: float,
) -> Image.Image:
    """Nearest-colour quantisation through an ordered threshold mask."""
    palette, palette_linear = _palette_linear(pigment)
    src = image.convert("RGB")
    width, height = src.size
    px = src.load()
    out = Image.new("RGB", (width, height))
    opx = out.load()
    linear = _LINEAR
    size = len(mask)

    for y in range(height):
        mask_row = mask[y % size]
        for x in range(width):
            r, g, b = px[x, y]
            delta = (mask_row[x % size] * 2.0 - 1.0) * bias
            lr = linear[r] + delta
            lg = linear[g] + delta
            lb = linear[b] + delta

            best_idx = 0
            best_dist = -1.0
            for idx, (pr, pg, pb) in enumerate(palette_linear):
                dist = (lr - pr) ** 2 + (lg - pg) ** 2 + (lb - pb) ** 2
                if best_dist < 0.0 or dist < best_dist:
                    best_dist = dist
                    best_idx = idx
            opx[x, y] = palette[best_idx]
    return out


def dither_to_palette(
    image: Image.Image,
    pigment: Tuple[int, int, int],
    algorithm: str = DEFAULT_DITHER_ALGORITHM,
    strength: float = 1.0,
) -> Image.Image:
    """Map ``image`` onto black/white/pigment with the selected dither engine.

    The nearest palette entry is chosen by Euclidean distance in approximately
    linear RGB space. ``strength`` scales the diffused error or, for the ordered
    masks, the intensity bias; at 0.0 the result is a plain nearest-colour
    threshold. Every returned pixel is exactly one of the three palette colours:
    the panel has no greys, and the plane packer treats anything else as black.
    """
    name = normalise_dither_algorithm(algorithm)
    level = _clamp(_as_float(strength, 1.0), 0.0, 1.0)
    if name in ("bayer8", "blue-noise") and level > 0.0:
        mask = _BAYER8 if name == "bayer8" else _BLUE_NOISE
        return _quantise_ordered(image, pigment, mask, level * _ORDERED_BIAS)
    if name == "none" or level <= 0.0:
        return _quantise_diffusion(image, pigment, ())
    divider, offsets = _DITHER_KERNELS[name]
    weights = tuple((dx, dy, weight / divider * level) for dx, dy, weight in offsets)
    return _quantise_diffusion(image, pigment, weights)


def quantize_to_palette(image: Image.Image, pigment: Tuple[int, int, int]) -> Image.Image:
    """Map ``image`` onto black/white/pigment with Floyd-Steinberg error diffusion.

    Kept as the stable entry point for callers that do not care about the
    engine: full-strength Floyd-Steinberg, the scene default.
    """
    return dither_to_palette(image, pigment, DEFAULT_DITHER_ALGORITHM, 1.0)


def render_scene_image(raw_scene: Any) -> Tuple[Image.Image, SceneSpec]:
    """Parse a raw scene object and return the palette-quantised 400x300 image."""
    spec = parse_scene(raw_scene)
    canvas = render_scene(spec)
    if canvas.size != (CANVAS_W, CANVAS_H):  # defensive: layout must never resize
        canvas = canvas.resize((CANVAS_W, CANVAS_H), Image.Resampling.LANCZOS)
    # The canvas is already palette-exact (render_scene dithered the photo and
    # painted the UI in exact inks), so this pass only repairs a stray colour.
    # It must not dither again: an ordered mask would flip exact pixels.
    quantised = dither_to_palette(canvas, spec.pigment, "none", 0.0)
    return quantised, spec


def _png_bytes(image: Image.Image) -> bytes:
    """Serialise a rendered scene to PNG bytes."""
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


def render_png(raw_scene: Any) -> bytes:
    """Render ``raw_scene`` and return the quantised PNG bytes."""
    image, _spec = render_scene_image(raw_scene)
    return _png_bytes(image)


# --------------------------------------------------------------------------- #
# Bit-plane packing
# --------------------------------------------------------------------------- #


def build_planes(image: Image.Image, pigment: Tuple[int, int, int]) -> Tuple[bytes, bytes]:
    """Pack a quantised image into the (bw, colour) wire planes.

    ``bw`` plane: bit 1 = white, bit 0 = black.
    ``color`` plane: bit 1 = no pigment, bit 0 = pigment.
    Bits are packed MSB-first per byte row, 50-byte stride for a 400px row.
    """
    px = image.convert("RGB").load()
    bw = bytearray(PLANE_SIZE)
    color = bytearray(PLANE_SIZE)
    for y in range(CANVAS_H):
        row_base = y * ROW_STRIDE
        for x in range(CANVAS_W):
            value = px[x, y]
            bit = 0x80 >> (x & 7)
            offset = row_base + (x >> 3)
            if value == COLOR_WHITE:
                bw[offset] |= bit
                color[offset] |= bit
            elif value == pigment:
                # Pigment: bw bit stays 0 (dark), colour bit stays 0 (pigment).
                continue
            else:
                # Black: bw bit stays 0, colour bit 1 (no pigment).
                color[offset] |= bit
    return bytes(bw), bytes(color)


# --------------------------------------------------------------------------- #
# BLE transport
# --------------------------------------------------------------------------- #


def bleak_version() -> str:
    """Return the installed bleak version, or ``"missing"`` when unavailable."""
    try:
        import bleak  # noqa: F401  (lazy import: BLE is optional)

        version = getattr(bleak, "__version__", None)
        if version:
            return str(version)
        try:
            from importlib.metadata import version as dist_version

            return str(dist_version("bleak"))
        except Exception:
            return "unknown"
    except Exception:
        return "missing"


class _StatusCollector:
    """Collect ASCII status notifications emitted by the tag during INIT."""

    def __init__(self) -> None:
        self.mtu: Optional[int] = None
        self.battery_mv: Optional[int] = None
        self.lines: List[str] = []
        self._mtu_event: Optional[asyncio.Event] = None

    def bind_loop(self) -> None:
        """Create the asyncio primitive on the current event loop."""
        self._mtu_event = asyncio.Event()

    def handle_notification(self, _sender: Any, data: bytearray) -> None:
        """Parse one notification payload (``mtu=``, ``bat=``, ...)."""
        text = bytes(data).decode("ascii", "replace").strip()
        if not text:
            return
        self.lines.append(text)
        LOGGER.debug("notify: %s", text)
        for token in re.split(r"[\s;]+", text):
            if "=" not in token:
                continue
            key, _, value = token.partition("=")
            if key == "mtu":
                try:
                    self.mtu = int(value)
                except ValueError:
                    LOGGER.debug("bad mtu token: %s", token)
                else:
                    if self._mtu_event is not None:
                        self._mtu_event.set()
            elif key == "bat":
                try:
                    self.battery_mv = int(value)
                except ValueError:
                    LOGGER.debug("bad bat token: %s", token)

    async def wait_for_mtu(self) -> None:
        """Await the ``mtu=`` notification."""
        if self._mtu_event is None:
            return
        await self._mtu_event.wait()


async def _scan_entries() -> List[Dict[str, Any]]:
    """Scan nearby BLE devices and return address/name/rssi entries, strongest first."""
    from bleak import BleakScanner

    raw_entries: List[Tuple[str, Any, Any]] = []
    discovered: Any = None
    try:
        discovered = await BleakScanner.discover(timeout=SCAN_SECONDS, return_adv=True)
    except TypeError:  # pragma: no cover - bleak build without return_adv support
        discovered = None
    if isinstance(discovered, dict):
        for address, payload in discovered.items():
            device, adv = payload
            raw_entries.append((address, device, adv))
    else:
        found = discovered
        if found is None:
            found = await BleakScanner.discover(timeout=SCAN_SECONDS)
        for device in found:
            raw_entries.append((getattr(device, "address", ""), device, None))

    entries: List[Dict[str, Any]] = []
    for address, device, adv in raw_entries:
        name = ""
        rssi: Any = None
        if adv is not None:
            name = (getattr(adv, "local_name", None) or "").strip()
            rssi = getattr(adv, "rssi", None)
        if not name:
            name = (getattr(device, "name", None) or "").strip()
        if rssi is None:
            rssi = getattr(device, "rssi", None)
        entries.append(
            {
                "address": address,
                "name": name,
                "rssi": int(rssi) if isinstance(rssi, (int, float)) else -127,
            }
        )
    entries.sort(key=lambda entry: entry["rssi"], reverse=True)
    return entries


async def _discover_address(name: str) -> str:
    """Resolve a BLE address by advertised device name."""
    target = (name or "").strip().lower()
    if not target:
        raise RuntimeError("device address and name are both empty")
    entries = await _scan_entries()
    for entry in entries:
        if entry["name"].lower() == target:
            return entry["address"]
    for entry in entries:
        if target and target in entry["name"].lower():
            return entry["address"]
    raise RuntimeError("device not found by name: %s" % name)


async def _push_planes_async(
    bw_plane: bytes,
    color_plane: bytes,
    address: str,
    name: str,
) -> Dict[str, Any]:
    """Connect to the tag, stream both planes and trigger a panel refresh."""
    from bleak import BleakClient

    target = (address or "").strip()
    if not target:
        target = await _discover_address(name)
        LOGGER.info("resolved %s to %s", name, target)

    collector = _StatusCollector()
    collector.bind_loop()
    chunks = 0
    client = BleakClient(target, timeout=CONNECT_TIMEOUT)
    await client.connect()
    LOGGER.info("connected to %s", target)
    try:
        await client.start_notify(EPD_CHAR_UUID, collector.handle_notification)
        await client.write_gatt_char(EPD_CHAR_UUID, CMD_INIT, response=True)
        try:
            await asyncio.wait_for(collector.wait_for_mtu(), INIT_MTU_WAIT)
        except asyncio.TimeoutError:
            LOGGER.warning("no mtu notification within %.0fs, assuming %d", INIT_MTU_WAIT, DEFAULT_MTU)

        mtu = collector.mtu or DEFAULT_MTU
        chunk = max(1, min(mtu, MAX_WRITE_BYTES) - 2)
        LOGGER.info("mtu=%d chunk=%d", mtu, chunk)

        streams: Sequence[Tuple[bytes, bytes, bytes]] = (
            (b"\x30\x0f", b"\x30\xff", bw_plane),
            (b"\x30\x00", b"\x30\xf0", color_plane),
        )
        for first_prefix, later_prefix, plane in streams:
            prefix = first_prefix
            for offset in range(0, len(plane), chunk):
                frame = prefix + plane[offset : offset + chunk]
                await client.write_gatt_char(EPD_CHAR_UUID, frame, response=False)
                prefix = later_prefix
                chunks += 1
                await asyncio.sleep(WRITE_GAP_SECONDS)
        LOGGER.info("streamed %d chunks", chunks)

        await client.write_gatt_char(EPD_CHAR_UUID, CMD_REFRESH, response=True)
        LOGGER.info("refresh triggered, waiting %.0fs for the panel", REFRESH_WAIT)
        await asyncio.sleep(REFRESH_WAIT)
    finally:
        try:
            await client.stop_notify(EPD_CHAR_UUID)
        except Exception:
            pass
        try:
            await client.disconnect()
        except Exception:
            LOGGER.debug("disconnect raised", exc_info=True)

    if collector.battery_mv is None:
        LOGGER.warning("tag did not report a battery level")
    return {"batteryMv": collector.battery_mv, "chunks": chunks}


def push_planes(bw_plane: bytes, color_plane: bytes, address: str, name: str) -> Dict[str, Any]:
    """Push both planes to the tag; serialised behind the global BLE lock."""
    if len(bw_plane) != PLANE_SIZE or len(color_plane) != PLANE_SIZE:
        raise ValueError("bit planes must be exactly %d bytes" % PLANE_SIZE)
    started = time.monotonic()
    with BLE_LOCK:
        # A tag that is mid-connection or just woke up can miss the first attempt;
        # one retry keeps a scheduled refresh from being dropped for that.
        try:
            result = asyncio.run(_push_planes_async(bw_plane, color_plane, address, name))
        except Exception as first:  # noqa: BLE001 - re-raised if the retry fails too
            LOGGER.warning("display attempt 1 failed (%s); retrying", first)
            time.sleep(2.0)
            # A stored address can go stale when the tag re-advertises after sleep,
            # so rebuild it from the advertised name before the last attempt.
            # BlueZ keeps a half-open link when a transfer is cut short, and a
            # connected tag stops advertising — clear it before looking again.
            if address:
                try:
                    subprocess.run(
                        ["bluetoothctl", "disconnect", address],
                        capture_output=True,
                        timeout=10,
                        check=False,
                    )
                    LOGGER.info("cleared stale link to %s", address)
                except (OSError, subprocess.SubprocessError):
                    pass
            retry_address = address
            if name:
                try:
                    retry_address = asyncio.run(_discover_address(name))
                    LOGGER.info("re-resolved %s to %s", name, retry_address)
                except Exception:
                    retry_address = address
            try:
                result = asyncio.run(_push_planes_async(bw_plane, color_plane, retry_address, name))
            except Exception:
                raise first from None
    elapsed_ms = int(round((time.monotonic() - started) * 1000))
    return {
        "ok": True,
        "ms": elapsed_ms,
        "batteryMv": result.get("batteryMv"),
        "chunks": int(result.get("chunks", 0)),
    }


async def _scan_async(only_nrf: bool) -> List[Dict[str, Any]]:
    """Scan for tags, keeping only NRF_EPD names unless every device was requested."""
    entries = await _scan_entries()
    if only_nrf:
        entries = [entry for entry in entries if DEVICE_NAME_HINT in entry["name"].upper()]
    return [
        {"address": entry["address"], "name": entry["name"] or "unknown", "rssi": entry["rssi"]}
        for entry in entries
    ]


def scan_devices(only_nrf: bool = True) -> Dict[str, Any]:
    """Scan for tags (serialised behind the global BLE lock)."""
    with BLE_LOCK:
        devices = asyncio.run(_scan_async(only_nrf))
    return {"ok": True, "devices": devices}


# --------------------------------------------------------------------------- #
# HTTP service
# --------------------------------------------------------------------------- #

MAX_BODY_BYTES = 8 * 1024 * 1024


def _json_bytes(payload: Any) -> bytes:
    """Serialise ``payload`` to compact UTF-8 JSON."""
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def applied_settings(spec: SceneSpec) -> Dict[str, Any]:
    """Return the render settings that were actually applied to a scene.

    The values come back from ``parse_scene`` clamped, not from the request, so
    a caller that sent an absurd number still learns what the tag received.
    """
    return {
        "ditherAlgorithm": spec.dither_algorithm,
        "ditherStrength": round(spec.dither_strength, 3),
        "backgroundZoom": round(spec.background_zoom, 3),
        "backgroundOffsetX": round(spec.background_offset_x, 3),
        "backgroundOffsetY": round(spec.background_offset_y, 3),
        "backgroundBrightness": spec.background_brightness,
        "backgroundContrast": spec.background_contrast,
    }


def _settings_headers(spec: SceneSpec) -> Dict[str, str]:
    """Return the applied settings as ``X-Eink-*`` response headers.

    ``POST /render`` answers with a PNG, so a header block is the only additive
    way to echo the settings on that route.
    """
    headers: Dict[str, str] = {}
    for key, value in applied_settings(spec).items():
        name = re.sub(r"(?<!^)(?=[A-Z])", "-", key).lower()
        headers["X-Eink-" + name] = str(value)
    return headers


class BridgeHandler(BaseHTTPRequestHandler):
    """HTTP handler for /health, /devices, /algorithms, /render and /display."""

    server_version = "sparkDash-eink-bridge/" + VERSION
    sys_version = ""
    protocol_version = "HTTP/1.1"

    # -- plumbing ---------------------------------------------------------

    def log_message(self, fmt: str, *args: Any) -> None:
        """Route access logs through logging instead of stderr."""
        LOGGER.info("%s - %s", self.address_string(), fmt % args)

    def _send_json(self, status: int, payload: Any) -> None:
        """Write a JSON response with the required content type."""
        body = _json_bytes(payload)
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _send_png(self, data: bytes, extra_headers: Optional[Dict[str, str]] = None) -> None:
        """Write a PNG response, optionally with extra headers."""
        self.send_response(200)
        self.send_header("Content-Type", "image/png")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        for name, value in (extra_headers or {}).items():
            self.send_header(name, value)
        self.end_headers()
        self.wfile.write(data)

    def _read_body(self) -> bytes:
        """Read the request body, enforcing a size limit."""
        try:
            length = int(self.headers.get("Content-Length") or "0")
        except ValueError:
            raise ValueError("invalid Content-Length")
        if length < 0 or length > MAX_BODY_BYTES:
            raise ValueError("request body too large")
        if length == 0:
            return b""
        return self.rfile.read(length)

    def _read_json(self) -> Any:
        """Parse the request body as JSON."""
        body = self._read_body()
        if not body:
            raise ValueError("request body must be JSON")
        try:
            return json.loads(body.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ValueError("invalid JSON body: %s" % exc)

    # -- routes -----------------------------------------------------------

    def do_GET(self) -> None:
        """Handle GET /health, GET /devices and GET /algorithms."""
        parsed = urlsplit(self.path)
        path = parsed.path.rstrip("/") or "/"
        if path == "/health":
            self._send_json(
                200,
                {
                    "ok": True,
                    "version": VERSION,
                    "bleak": bleak_version(),
                    "lastError": LAST_ERROR[0],
                },
            )
            return
        if path == "/algorithms":
            self._send_json(200, {"ok": True, "algorithms": list(DITHER_ALGORITHMS)})
            return
        if path == "/devices":
            query = parse_qs(parsed.query)
            raw_all = (query.get("all") or ["0"])[0].lower()
            only_nrf = raw_all not in ("1", "true", "yes")
            try:
                self._send_json(200, scan_devices(only_nrf=only_nrf))
            except Exception as exc:  # BLE must never take the server down
                record_error(exc)
                self._send_json(500, {"ok": False, "error": str(exc)})
            return
        self._send_json(404, {"ok": False, "error": "not found: %s" % parsed.path})

    def do_POST(self) -> None:
        """Handle POST /render and POST /display."""
        parsed = urlsplit(self.path)
        path = parsed.path.rstrip("/") or "/"
        if path == "/render":
            self._post_render()
            return
        if path == "/display":
            self._post_display()
            return
        self._read_body()  # keep the connection consistent
        self._send_json(404, {"ok": False, "error": "not found: %s" % parsed.path})

    def _post_render(self) -> None:
        """Render the scene to a quantised PNG preview (no BLE)."""
        try:
            payload = self._read_json()
            scene = payload.get("scene") if isinstance(payload, dict) else None
            # "meta": true swaps the PNG body for JSON so a caller can show the
            # settings next to the preview; the default stays a bare PNG.
            want_meta = isinstance(payload, dict) and payload.get("meta") is True
            image, spec = render_scene_image(scene)
        except ValueError as exc:
            self._send_json(400, {"ok": False, "error": str(exc)})
            return
        except Exception as exc:
            record_error(exc)
            LOGGER.exception("render failed")
            self._send_json(500, {"ok": False, "error": str(exc)})
            return
        data = _png_bytes(image)
        if want_meta:
            self._send_json(
                200,
                {
                    "ok": True,
                    "settings": applied_settings(spec),
                    "pngBase64": base64.b64encode(data).decode("ascii"),
                },
            )
            return
        self._send_png(data, _settings_headers(spec))

    def _post_display(self) -> None:
        """Render the scene and push it to the tag; always 500 on failure."""
        try:
            payload = self._read_json()
            if not isinstance(payload, dict):
                raise ValueError("body must be a JSON object")
            scene = payload.get("scene")
            device = payload.get("device") or {}
            if not isinstance(device, dict):
                raise ValueError("device must be a JSON object")
            address = str(device.get("address") or "").strip()
            name = str(device.get("name") or "").strip()
            if not address and not name:
                raise ValueError("device.address or device.name is required")

            image, spec = render_scene_image(scene)
            settings = applied_settings(spec)
            bw_plane, color_plane = build_planes(image, spec.pigment)
            result = push_planes(bw_plane, color_plane, address, name)
        except Exception as exc:
            record_error(exc)
            LOGGER.warning("display failed: %s", exc)
            self._send_json(500, {"ok": False, "error": str(exc) or exc.__class__.__name__})
            return
        LOGGER.info(
            "display ok: %sms battery=%s chunks=%s dither=%s strength=%s zoom=%s offsetX=%s "
            "offsetY=%s brightness=%s contrast=%s",
            result.get("ms"),
            result.get("batteryMv"),
            result.get("chunks"),
            settings["ditherAlgorithm"],
            settings["ditherStrength"],
            settings["backgroundZoom"],
            settings["backgroundOffsetX"],
            settings["backgroundOffsetY"],
            settings["backgroundBrightness"],
            settings["backgroundContrast"],
        )
        result.update(settings)
        self._send_json(200, result)


LAST_ERROR: List[Optional[str]] = [None]
"""Last error message surfaced through /health (``null`` when healthy)."""


def record_error(exc: BaseException) -> None:
    """Remember the most recent error for the /health endpoint."""
    LAST_ERROR[0] = "%s: %s" % (exc.__class__.__name__, exc)


class BridgeServer(ThreadingHTTPServer):
    """Threading HTTP server with daemon worker threads."""

    daemon_threads = True
    allow_reuse_address = True


# --------------------------------------------------------------------------- #
# Self test
# --------------------------------------------------------------------------- #


def sample_scene() -> Dict[str, Any]:
    """Return the example scene used by ``--selftest``."""
    return {
        "title": "sparkDash",
        "subtitle": time.strftime("%Y-%m-%d %H:%M"),
        "headline": {"label": "今日 Token", "value": "12.4M"},
        "stats": [
            {"label": "输入", "value": "9.1M"},
            {"label": "输出", "value": "3.3M"},
            {"label": "缓存命中", "value": "41%"},
        ],
        "rows": [
            {"label": "spark001", "value": "4.2M", "ratio": 0.62},
            {"label": "spark002", "value": "3.1M", "ratio": 0.45},
            {"label": "spark003", "value": "1.7M", "ratio": 0.24},
        ],
        "footer": "每 30 分钟刷新",
        "pigment": "yellow",
        "theme": "dark",
        "background": None,
        "backgroundDim": 0.35,
    }


def run_selftest(out_path: str = DEFAULT_PREVIEW_PATH) -> int:
    """Render the sample scene to ``out_path`` and print the path (no BLE)."""
    try:
        image, spec = render_scene_image(sample_scene())
    except Exception as exc:
        print("selftest failed: %s" % exc, file=sys.stderr)
        return 1
    directory = os.path.dirname(os.path.abspath(out_path))
    if directory:
        os.makedirs(directory, exist_ok=True)
    image.save(out_path, format="PNG")
    colours = {colour for _count, colour in image.convert("RGB").getcolors(maxcolors=1 << 24) or []}
    print(out_path)
    LOGGER.info(
        "selftest wrote %s (%dx%d, palette=%s, pigment=%s)",
        out_path,
        image.size[0],
        image.size[1],
        sorted(colours),
        spec.pigment_name,
    )
    return 0


# --------------------------------------------------------------------------- #
# CLI
# --------------------------------------------------------------------------- #


def configure_logging(level: str) -> None:
    """Configure stdout logging with timestamps."""
    resolved = getattr(logging, str(level).upper(), None)
    if not isinstance(resolved, int):
        resolved = logging.INFO
    handler = logging.StreamHandler(stream=sys.stdout)
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s"))
    root = logging.getLogger()
    root.handlers.clear()
    root.addHandler(handler)
    root.setLevel(resolved)
    LOGGER.setLevel(resolved)


def build_parser() -> argparse.ArgumentParser:
    """Build the command line parser."""
    parser = argparse.ArgumentParser(
        prog="eink_bridge.py",
        description="sparkDash e-ink bridge: render 400x300 scenes and push them over BLE.",
    )
    parser.add_argument("--host", default="127.0.0.1", help="bind address (default 127.0.0.1)")
    parser.add_argument("--port", type=int, default=8790, help="bind port (default 8790)")
    parser.add_argument(
        "--log",
        default="INFO",
        help="log level: DEBUG, INFO, WARNING, ERROR (default INFO)",
    )
    parser.add_argument(
        "--selftest",
        nargs="?",
        const=DEFAULT_PREVIEW_PATH,
        metavar="OUT_PNG",
        help="render a sample scene to OUT_PNG (default %s) and exit" % DEFAULT_PREVIEW_PATH,
    )
    return parser


def main(argv: Optional[Sequence[str]] = None) -> int:
    """Entry point: either run the selftest or serve HTTP."""
    args = build_parser().parse_args(argv)
    configure_logging(args.log)

    if args.selftest:
        return run_selftest(args.selftest)

    try:
        server = BridgeServer((args.host, args.port), BridgeHandler)
    except OSError as exc:
        LOGGER.error("cannot bind %s:%s: %s", args.host, args.port, exc)
        return 1
    LOGGER.info(
        "sparkDash e-ink bridge %s listening on http://%s:%d (bleak=%s)",
        VERSION,
        args.host,
        args.port,
        bleak_version(),
    )
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        LOGGER.info("interrupted, shutting down")
    finally:
        server.shutdown()
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())