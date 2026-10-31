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
import functools
import io
import json
import logging
import os
import re
import sys
import threading
import time
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Dict, List, Optional, Sequence, Tuple
from urllib.parse import parse_qs, urlsplit

from PIL import Image, ImageDraw, ImageFont

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

# Typography sizes (pixels).
TITLE_SIZE = 20
SUBTITLE_SIZE = 13
HEADLINE_LABEL_SIZE = 15
HEADLINE_VALUE_SIZE = 64
STAT_SIZE = 14
STAT_VALUE_SIZE = 15
ROW_SIZE = 13
FOOTER_SIZE = 11

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
    title: str = ""
    subtitle: str = ""
    stats: List[Stat] = field(default_factory=list)
    rows: List[Row] = field(default_factory=list)
    footer: str = ""
    pigment_name: str = "yellow"
    theme: str = "dark"
    background: Optional[str] = None
    background_dim: float = 0.35

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
        title=_as_text(raw.get("title")),
        subtitle=_as_text(raw.get("subtitle")),
        stats=stats,
        rows=rows,
        footer=_as_text(raw.get("footer")),
        pigment_name=pigment,
        theme=theme,
        background=background_path,
        background_dim=_clamp(background_dim, 0.0, 1.0),
    )


# --------------------------------------------------------------------------- #
# Rendering
# --------------------------------------------------------------------------- #


def _cover_fit(path: str, size: Tuple[int, int]) -> Image.Image:
    """Open ``path``, cover-fit it to ``size`` (centre crop) and return greyscale RGB."""
    with Image.open(path) as handle:
        img = handle.convert("RGB")
    target_w, target_h = size
    src_w, src_h = img.size
    if src_w <= 0 or src_h <= 0:
        raise ValueError(f"background image has no pixels: {path}")
    scale = max(target_w / src_w, target_h / src_h)
    new_w = max(target_w, int(round(src_w * scale)))
    new_h = max(target_h, int(round(src_h * scale)))
    img = img.resize((new_w, new_h), Image.Resampling.LANCZOS)
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
        photo = _cover_fit(spec.background, (CANVAS_W, CANVAS_H))
    except (OSError, ValueError) as exc:
        LOGGER.warning("background %s unreadable: %s", spec.background, exc)
        return base
    return Image.blend(base, photo, spec.background_dim)


def _ink_colours(spec: SceneSpec) -> Tuple[Tuple[int, int, int], Tuple[int, int, int], Tuple[int, int, int]]:
    """Return (foreground, dim, base) colours for the configured theme."""
    if spec.theme == "dark":
        return COLOR_WHITE, mix(COLOR_WHITE, COLOR_BLACK, DIM_INK_RATIO), COLOR_BLACK
    return COLOR_BLACK, mix(COLOR_BLACK, COLOR_WHITE, DIM_INK_RATIO), COLOR_WHITE


def _draw_top(draw: Any, xy: Tuple[int, int], text: str, font: Any, fill: Tuple[int, int, int]) -> int:
    """Draw ``text`` so its first ink pixel starts at ``xy``; return the ink height.

    PIL anchors glyphs on the font's ascent box, and the CJK faces ship a large
    internal leading — drawing at a nominal ``y`` pushed the glyphs tens of pixels
    down and made the headline collide with the label above it. Measuring the
    real ink box keeps every block where the layout put it.
    """
    if not text:
        return 0
    bbox = draw.textbbox((0, 0), text, font=font)
    draw.text((xy[0] - bbox[0], xy[1] - bbox[1]), text, font=font, fill=fill)
    return bbox[3] - bbox[1]


def _ink_height(draw: Any, text: str, font: Any) -> int:
    if not text:
        return 0
    bbox = draw.textbbox((0, 0), text, font=font)
    return bbox[3] - bbox[1]


def render_scene(spec: SceneSpec) -> Image.Image:
    """Draw ``spec`` onto a 400x300 RGB canvas (not yet palette-quantised).

    Text is drawn on a supersampled canvas and scaled back down: 12-15 px CJK
    glyphs are unreadable on a 400 px e-paper panel when drawn at 1x, and the
    downscale gives them the stroke weight the panel can actually reproduce.
    """
    scale = SUPERSAMPLE
    image = _base_image(spec)
    if scale > 1:
        image = image.resize((CANVAS_W * scale, CANVAS_H * scale), Image.LANCZOS)
    draw = ImageDraw.Draw(image)
    fg, dim, base = _ink_colours(spec)
    pigment = spec.pigment
    margin = MARGIN * scale
    content_w = (CANVAS_W - 2 * MARGIN) * scale

    footer_h = (FOOTER_SIZE + 6) * scale if spec.footer else 0
    bottom_limit = (CANVAS_H - MARGIN) * scale - footer_h
    cursor = margin

    if spec.title:
        font = load_font(TITLE_SIZE * scale, True)
        cursor += _draw_top(draw, (margin, cursor), truncate_text(spec.title, font, content_w), font, fg) + 2 * scale
    if spec.subtitle:
        font = load_font(SUBTITLE_SIZE * scale, True)
        cursor += _draw_top(draw, (margin, cursor), truncate_text(spec.subtitle, font, content_w), font, dim) + 8 * scale

    if spec.headline_label:
        font = load_font(HEADLINE_LABEL_SIZE * scale, True)
        cursor += _draw_top(draw, (margin, cursor), truncate_text(spec.headline_label, font, content_w), font, fg) + 2 * scale
    value_font, value_text = fit_font(
        spec.headline_value,
        content_w,
        HEADLINE_VALUE_SIZE * scale,
        (HEADLINE_VALUE_SIZE // 2) * scale,
        bold=True,
    )
    cursor += _draw_top(draw, (margin, cursor), value_text, value_font, pigment) + 8 * scale

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
                y += _draw_top(draw, (x, y), truncate_text(stat.label, label_font, inner), label_font, fg) + 4 * scale
            if stat.value:
                y += _draw_top(draw, (x, y), truncate_text(stat.value, value_font_stat, inner), value_font_stat, fg)
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
                _draw_top(draw, (margin, y), label_text, row_font, fg)
            bar_x = margin + int(label_w) + 8 * scale
            bar_max = max(0, int(CANVAS_W * scale - margin - value_w - 8 * scale - bar_x))
            bar_top = y + int((line_h - bar_h) / 2)
            if bar_max > 0:
                draw.rectangle([bar_x, bar_top, bar_x + bar_max, bar_top + bar_h], fill=track)
                filled = int(round(bar_max * max(0.0, min(1.0, row.ratio))))
                if filled > 0:
                    draw.rectangle([bar_x, bar_top, bar_x + filled, bar_top + bar_h], fill=pigment)
            if row.value:
                _draw_top(
                    draw,
                    (CANVAS_W * scale - margin - value_w - 2 * scale, y),
                    row.value,
                    value_font_row,
                    fg,
                )
            cursor += slot

    if spec.footer:
        font = load_font(FOOTER_SIZE * scale, True)
        text = truncate_text(spec.footer, font, content_w)
        height = _ink_height(draw, text, font)
        _draw_top(draw, (margin, CANVAS_H * scale - margin - height), text, font, dim)

    if scale > 1:
        image = image.resize((CANVAS_W, CANVAS_H), Image.LANCZOS)
    return image


_LINEAR = [(value / 255.0) ** 2.2 for value in range(256)]


def quantize_to_palette(image: Image.Image, pigment: Tuple[int, int, int]) -> Image.Image:
    """Map ``image`` onto black/white/pigment with Floyd-Steinberg error diffusion.

    The nearest palette entry is chosen by Euclidean distance in approximately
    linear RGB space, and the quantisation error is diffused in the same space.
    The returned image contains only the three palette colours.
    """
    palette: List[Tuple[int, int, int]] = [COLOR_BLACK, COLOR_WHITE, pigment]
    palette_linear = [(_LINEAR[c[0]], _LINEAR[c[1]], _LINEAR[c[2]]) for c in palette]

    src = image.convert("RGB")
    width, height = src.size
    px = src.load()
    out = Image.new("RGB", (width, height))
    opx = out.load()

    # Work buffer of linear-light values with room for diffused error.
    work: List[List[float]] = [[0.0] * (width * 3) for _ in range(height)]

    right_w, down_left_w, down_w, down_right_w = 7.0 / 16.0, 3.0 / 16.0, 5.0 / 16.0, 1.0 / 16.0

    for y in range(height):
        row_y = work[y]
        row_next = work[y + 1] if y + 1 < height else None
        for x in range(width):
            r, g, b = px[x, y]
            i = x * 3
            lr = _LINEAR[r] + row_y[i]
            lg = _LINEAR[g] + row_y[i + 1]
            lb = _LINEAR[b] + row_y[i + 2]

            best_idx = 0
            best_dist = None
            for idx, (pr, pg, pb) in enumerate(palette_linear):
                dist = (lr - pr) ** 2 + (lg - pg) ** 2 + (lb - pb) ** 2
                if best_dist is None or dist < best_dist:
                    best_dist = dist
                    best_idx = idx
            chosen = palette[best_idx]
            opx[x, y] = chosen

            pr, pg, pb = palette_linear[best_idx]
            er, eg, eb = lr - pr, lg - pg, lb - pb
            if er == 0.0 and eg == 0.0 and eb == 0.0:
                continue
            if x + 1 < width:
                j = i + 3
                row_y[j] += er * right_w
                row_y[j + 1] += eg * right_w
                row_y[j + 2] += eb * right_w
            if row_next is not None:
                if x > 0:
                    j = i - 3
                    row_next[j] += er * down_left_w
                    row_next[j + 1] += eg * down_left_w
                    row_next[j + 2] += eb * down_left_w
                j = i
                row_next[j] += er * down_w
                row_next[j + 1] += eg * down_w
                row_next[j + 2] += eb * down_w
                if x + 1 < width:
                    j = i + 3
                    row_next[j] += er * down_right_w
                    row_next[j + 1] += eg * down_right_w
                    row_next[j + 2] += eb * down_right_w
    return out


def render_scene_image(raw_scene: Any) -> Tuple[Image.Image, SceneSpec]:
    """Parse a raw scene object and return the palette-quantised 400x300 image."""
    spec = parse_scene(raw_scene)
    canvas = render_scene(spec)
    if canvas.size != (CANVAS_W, CANVAS_H):  # defensive: layout must never resize
        canvas = canvas.resize((CANVAS_W, CANVAS_H), Image.Resampling.LANCZOS)
    quantised = quantize_to_palette(canvas, spec.pigment)
    return quantised, spec


def render_png(raw_scene: Any) -> bytes:
    """Render ``raw_scene`` and return the quantised PNG bytes."""
    image, _spec = render_scene_image(raw_scene)
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


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
        result = asyncio.run(_push_planes_async(bw_plane, color_plane, address, name))
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


class BridgeHandler(BaseHTTPRequestHandler):
    """HTTP handler for /health, /devices, /render and /display."""

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

    def _send_png(self, data: bytes) -> None:
        """Write a PNG response."""
        self.send_response(200)
        self.send_header("Content-Type", "image/png")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
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
        """Handle GET /health and GET /devices."""
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
            data = render_png(scene)
        except ValueError as exc:
            self._send_json(400, {"ok": False, "error": str(exc)})
            return
        except Exception as exc:
            record_error(exc)
            LOGGER.exception("render failed")
            self._send_json(500, {"ok": False, "error": str(exc)})
            return
        self._send_png(data)

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
            bw_plane, color_plane = build_planes(image, spec.pigment)
            result = push_planes(bw_plane, color_plane, address, name)
        except Exception as exc:
            record_error(exc)
            LOGGER.warning("display failed: %s", exc)
            self._send_json(500, {"ok": False, "error": str(exc) or exc.__class__.__name__})
            return
        LOGGER.info(
            "display ok: %sms battery=%s chunks=%s",
            result.get("ms"),
            result.get("batteryMv"),
            result.get("chunks"),
        )
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