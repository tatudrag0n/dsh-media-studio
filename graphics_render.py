#!/usr/bin/env python
"""Render charts to PNG for the DeepSeek Harness Media Studio plugin.

The Host half writes one JSON spec and either runs this file as a script
(``--spec spec.json --out chart.png``) or imports :func:`render_chart_image`
from it. Drawing happens with Pillow only: no model, no network, no GPU.

Everything is drawn at twice the final size and scaled down, so the result has
clean anti-aliased edges.

Spec
    {
      "type": "bar" | "hbar" | "line" | "area" | "pie" | "donut" |
              "scatter" | "stacked",
      "title": "string",
      "subtitle": "string",
      "unit": "string",
      "theme": "light" | "dark",
      "width": 1280,
      "height": 720,
      "progress": 1.0,
      "labels": ["Jan", "Feb"],
      "series": [{"name": "Revenue", "values": [10, 12]}]
    }

``progress`` runs from 0 to 1 and animates the chart: bars grow out of the
baseline, lines reveal themselves, and pie slices sweep around. It is what the
motion-graphics renderer uses to animate a chart.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sys
import traceback
from typing import Any, Dict, List, Optional, Tuple

# The drawing happens at this multiple of the final size, then gets scaled
# down. Every coordinate below is written in final pixels and multiplied by it.
SUPERSAMPLE = 2

# C:\Windows\Fonts candidates, most preferred first. Meiryo and Yu Gothic cover
# Japanese text; the Latin fonts are the fallback when they are missing.
FONT_CANDIDATES = [
    r"C:\Windows\Fonts\meiryo.ttc",
    r"C:\Windows\Fonts\YuGothM.ttc",
    r"C:\Windows\Fonts\msgothic.ttc",
    r"C:\Windows\Fonts\msyh.ttc",
    r"C:\Windows\Fonts\segoeui.ttf",
    r"C:\Windows\Fonts\arial.ttf",
]

THEMES = {
    "light": {
        "background": "#ffffff",
        "surface": "#f8fafc",
        "text": "#0f172a",
        "muted": "#64748b",
        "grid": "#e2e8f0",
        "axis": "#cbd5e1",
        "value": "#334155",
    },
    "dark": {
        "background": "#0f172a",
        "surface": "#1e293b",
        "text": "#f8fafc",
        "muted": "#94a3b8",
        "grid": "#1e293b",
        "axis": "#334155",
        "value": "#cbd5e1",
    },
}

PALETTE = [
    "#2563eb",
    "#f97316",
    "#10b981",
    "#a855f7",
    "#ef4444",
    "#0891b2",
    "#ca8a04",
    "#db2777",
    "#4f46e5",
    "#059669",
]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Render a chart to PNG.")
    parser.add_argument("--out", required=True, help="Path of the PNG to write.")
    parser.add_argument("--spec", default="", help="Spec file; the default is stdin.")
    return parser.parse_args()


# #region Fonts


def load_fonts(scale: int = 1) -> Dict[str, Any]:
    """Pick the first installed font family and return the sizes we need."""
    from PIL import ImageFont

    family: Optional[str] = None
    for candidate in FONT_CANDIDATES:
        if os.path.exists(candidate):
            family = candidate
            break
    if family is None:
        raise SystemExit("No usable font was found in C:\\Windows\\Fonts.")

    def make(size: int, index: int = 0):
        try:
            return ImageFont.truetype(family, size * scale, index=index)
        except Exception:
            return ImageFont.truetype(family, size * scale)

    return {
        "family": family,
        "title": make(46),
        "subtitle": make(26),
        "axis": make(24),
        "label": make(26),
        "value": make(24),
        "legend": make(26),
        "small": make(21),
    }


# #endregion

# #region Helpers


def hex_to_rgb(value: str) -> Tuple[int, int, int]:
    text = value.strip().lstrip("#")
    if len(text) == 3:
        text = "".join(part * 2 for part in text)
    return (int(text[0:2], 16), int(text[2:4], 16), int(text[4:6], 16))


def mix(first: str, second: str, ratio: float) -> Tuple[int, int, int]:
    """Blend two colors; ratio 0 keeps the first, 1 keeps the second."""
    a = hex_to_rgb(first)
    b = hex_to_rgb(second)
    return tuple(int(round(a[index] + (b[index] - a[index]) * ratio)) for index in range(3))


def mix_hex(first: str, second: str, ratio: float) -> str:
    """Blend two colors and return the result as a hex string."""
    red, green, blue = mix(first, second, ratio)
    return "#%02x%02x%02x" % (red, green, blue)


def format_number(value: float) -> str:
    if abs(value) < 1e-12:
        return "0"
    if abs(value - round(value)) < 1e-9:
        return f"{int(round(value)):,}"
    if abs(value) >= 100:
        return f"{value:,.1f}"
    return f"{value:,.2f}".rstrip("0").rstrip(".")


def nice_scale(low: float, high: float, count: int = 5) -> Tuple[float, float, List[float]]:
    """Return an axis range and its tick values, rounded to a readable step."""
    if high <= low:
        high = low + 1
    span = high - low
    raw = span / max(1, count)
    magnitude = 10 ** math.floor(math.log10(raw)) if raw > 0 else 1
    step = magnitude
    for multiplier in (1, 2, 2.5, 5, 10):
        step = multiplier * magnitude
        if step >= raw:
            break
    bottom = math.floor(low / step) * step
    top = math.ceil(high / step) * step
    ticks: List[float] = []
    value = bottom
    while value <= top + step / 2:
        ticks.append(round(value, 10))
        value += step
    return bottom, top, ticks


def text_size(draw, text: str, font) -> Tuple[int, int]:
    box = draw.textbbox((0, 0), text, font=font)
    return (box[2] - box[0], box[3] - box[1])


def draw_centered(draw, x: float, y: float, text: str, font, fill) -> None:
    width, height = text_size(draw, text, font)
    draw.text((x - width / 2, y - height / 2), text, font=font, fill=fill)


def draw_right(draw, x: float, y: float, text: str, font, fill) -> None:
    width, height = text_size(draw, text, font)
    draw.text((x - width, y - height / 2), text, font=font, fill=fill)


# #endregion

# #region Chart kinds


def draw_cartesian(draw, spec, theme, fonts, series, labels, progress) -> None:
    """Bar, line, area, stacked, and scatter charts share one axis frame."""
    scale = spec["scale"]
    width = spec["width"] * scale
    height = spec["height"] * scale
    chart_type = spec["type"]

    left = 96 * scale
    right = 36 * scale
    top = 150 * scale
    bottom = 92 * scale
    x0 = left
    y0 = top
    x1 = width - right
    y1 = height - bottom

    values = [value for entry in series for value in entry["values"]]
    if not values:
        return
    low = min(values)
    high = max(values)
    if chart_type in ("bar", "stacked", "scatter"):
        low = min(0.0, low)
    bottom_value, top_value, ticks = nice_scale(low, high, 5)

    def to_y(value: float) -> float:
        span = top_value - bottom_value or 1
        return y1 - (value - bottom_value) / span * (y1 - y0)

    # Grid and y-axis labels.
    for tick in ticks:
        y = to_y(tick)
        draw.line([(x0, y), (x1, y)], fill=hex_to_rgb(theme["grid"]), width=2 * scale)
        draw_right(draw, x0 - 16 * scale, y, format_number(tick), fonts["small"], hex_to_rgb(theme["muted"]))
    draw.line([(x0, y0), (x0, y1)], fill=hex_to_rgb(theme["axis"]), width=3 * scale)
    draw.line([(x0, y1), (x1, y1)], fill=hex_to_rgb(theme["axis"]), width=3 * scale)

    count = max(1, len(labels))
    slot = (x1 - x0) / count
    label_font = fonts["label"]

    if chart_type in ("bar", "stacked"):
        group_count = max(1, len(series))
        gap = slot * 0.22
        bar_width = max(4.0 * scale, (slot - gap) / group_count)
        baseline = to_y(max(bottom_value, 0.0))
        for group in range(count):
            offset = x0 + group * slot + gap / 2
            if chart_type == "stacked":
                running = 0.0
                for index, entry in enumerate(series):
                    value = entry["values"][group] if group < len(entry["values"]) else 0.0
                    grown = value * progress
                    top_y = to_y(running + grown)
                    lower_y = to_y(running)
                    running += grown
                    left_x = offset + index * bar_width
                    draw.rounded_rectangle(
                        [left_x, top_y, left_x + bar_width - 4 * scale, lower_y],
                        radius=8 * scale,
                        fill=hex_to_rgb(PALETTE[index % len(PALETTE)]),
                    )
                total = sum(
                    entry["values"][group] if group < len(entry["values"]) else 0.0
                    for entry in series
                )
                if group_count == 1 and total != 0 and progress > 0.9:
                    draw_centered(
                        draw,
                        offset + bar_width / 2,
                        to_y(total * progress) - 20 * scale,
                        format_number(total),
                        fonts["value"],
                        hex_to_rgb(theme["value"]),
                    )
            else:
                for index, entry in enumerate(series):
                    value = entry["values"][group] if group < len(entry["values"]) else 0.0
                    grown = value * progress
                    top_y = to_y(grown)
                    left_x = offset + index * bar_width
                    radius = min(10 * scale, bar_width / 4)
                    draw.rounded_rectangle(
                        [left_x, top_y, left_x + bar_width - 6 * scale, baseline],
                        radius=radius,
                        fill=hex_to_rgb(PALETTE[index % len(PALETTE)]),
                    )
                    if group_count == 1 and progress > 0.9:
                        draw_centered(
                            draw,
                            left_x + (bar_width - 6 * scale) / 2,
                            top_y - 20 * scale,
                            format_number(value),
                            fonts["value"],
                            hex_to_rgb(theme["value"]),
                        )
    elif chart_type in ("line", "area"):
        for index, entry in enumerate(series):
            color = hex_to_rgb(PALETTE[index % len(PALETTE)])
            points = []
            for group in range(count):
                value = entry["values"][group] if group < len(entry["values"]) else 0.0
                points.append((x0 + slot * (group + 0.5), to_y(value)))
            revealed = reveal_points(points, progress)
            if len(revealed) >= 2:
                if chart_type == "area":
                    polygon = revealed + [
                        (revealed[-1][0], to_y(bottom_value)),
                        (revealed[0][0], to_y(bottom_value)),
                    ]
                    draw.polygon(
                        polygon,
                        fill=mix(theme["background"], PALETTE[index % len(PALETTE)], 0.22),
                    )
                draw.line(revealed, fill=color, width=6 * scale, joint="curve")
            for point in revealed:
                draw.ellipse(
                    [point[0] - 9 * scale, point[1] - 9 * scale, point[0] + 9 * scale, point[1] + 9 * scale],
                    fill=color,
                )
    elif chart_type == "scatter":
        for index, entry in enumerate(series):
            color = hex_to_rgb(PALETTE[index % len(PALETTE)])
            for group in range(count):
                value = entry["values"][group] if group < len(entry["values"]) else 0.0
                if group / max(1, count - 1) > progress:
                    continue
                cx = x0 + slot * (group + 0.5)
                cy = to_y(value)
                draw.ellipse(
                    [cx - 12 * scale, cy - 12 * scale, cx + 12 * scale, cy + 12 * scale],
                    fill=color,
                )

    # X-axis labels.
    for group in range(count):
        draw_centered(
            draw,
            x0 + slot * (group + 0.5),
            y1 + 34 * scale,
            str(labels[group]),
            label_font,
            hex_to_rgb(theme["muted"]),
        )


def reveal_points(points, progress):
    """Return the part of a polyline that the animation has drawn so far."""
    if len(points) < 2:
        return list(points)
    limit = progress * (len(points) - 1)
    shown = [point for index, point in enumerate(points) if index <= limit]
    if not shown:
        return []
    whole = int(limit)
    if whole < len(points) - 1:
        start = points[whole]
        end = points[whole + 1]
        fraction = limit - whole
        middle = (start[0] + (end[0] - start[0]) * fraction, start[1] + (end[1] - start[1]) * fraction)
        shown = shown + [middle]
    return shown


def draw_horizontal_bars(draw, spec, theme, fonts, series, labels, progress) -> None:
    scale = spec["scale"]
    width = spec["width"] * scale
    height = spec["height"] * scale
    left = 220 * scale
    right = 120 * scale
    top = 150 * scale
    bottom = 60 * scale
    x0 = left
    x1 = width - right
    count = max(1, len(labels))
    row = (height - top - bottom) / count
    values = [value for entry in series for value in entry["values"]]
    high = max(values) if values else 1
    scale_value = high if high > 0 else 1

    for group in range(count):
        center = top + row * (group + 0.5)
        bar_height = min(46 * scale, row * 0.55)
        draw_right(
            draw, x0 - 20 * scale, center, str(labels[group]), fonts["label"], hex_to_rgb(theme["muted"])
        )
        for index, entry in enumerate(series):
            value = entry["values"][group] if group < len(entry["values"]) else 0.0
            length = max(0.0, value * progress / scale_value) * (x1 - x0)
            offset = index * (bar_height + 6 * scale)
            draw.rounded_rectangle(
                [
                    x0,
                    center - bar_height / 2 + offset,
                    x0 + max(2.0 * scale, length),
                    center + bar_height / 2 + offset,
                ],
                radius=8 * scale,
                fill=hex_to_rgb(PALETTE[index % len(PALETTE)]),
            )
            if progress > 0.9:
                draw.text(
                    (x0 + max(2.0 * scale, length) + 12 * scale, center - bar_height / 2 + offset - 4 * scale),
                    format_number(value),
                    font=fonts["value"],
                    fill=hex_to_rgb(theme["value"]),
                )


def draw_pie(draw, spec, theme, fonts, series, labels, progress) -> None:
    scale = spec["scale"]
    width = spec["width"] * scale
    height = spec["height"] * scale
    values = series[0]["values"] if series else []
    total = sum(value for value in values if value > 0) or 1
    diameter = min(width * 0.42, height - 240 * scale)
    cx = width * 0.30
    cy = height / 2 + 20 * scale
    box = [cx - diameter / 2, cy - diameter / 2, cx + diameter / 2, cy + diameter / 2]
    start = -90.0
    for index, value in enumerate(values):
        if value <= 0:
            continue
        sweep = 360.0 * value / total * progress
        if sweep <= 0:
            continue
        draw.pieslice(
            box,
            start=start,
            end=start + sweep,
            fill=hex_to_rgb(PALETTE[index % len(PALETTE)]),
        )
        start += sweep
    if spec["type"] == "donut":
        inner = diameter * 0.58
        draw.ellipse(
            [cx - inner / 2, cy - inner / 2, cx + inner / 2, cy + inner / 2],
            fill=hex_to_rgb(theme["background"]),
        )

    legend_x = width * 0.60
    legend_y = height / 2 - len(values) * 22 * scale + 20 * scale
    for index, value in enumerate(values):
        y = legend_y + index * 52 * scale
        share = value / total * 100
        draw.rounded_rectangle(
            [legend_x, y, legend_x + 28 * scale, y + 28 * scale],
            radius=7 * scale,
            fill=hex_to_rgb(PALETTE[index % len(PALETTE)]),
        )
        draw.text(
            (legend_x + 44 * scale, y - 4 * scale),
            f"{labels[index]}  {format_number(value)} ({share:.1f}%)",
            font=fonts["legend"],
            fill=hex_to_rgb(theme["text"]),
        )


# #endregion


def render_chart_image(spec: Dict[str, Any]):
    """Draw one chart and return the finished image at its final size."""
    from PIL import Image, ImageDraw

    width = int(spec.get("width") or 1280)
    height = int(spec.get("height") or 720)
    theme = THEMES.get(str(spec.get("theme") or "light"), THEMES["light"])
    series = spec.get("series") or []
    labels = [str(label) for label in (spec.get("labels") or [])]
    progress = float(spec.get("progress", 1.0))
    progress = max(0.0, min(1.0, progress))
    if not series or not labels:
        raise ValueError("The chart spec needs at least one label and one series.")

    scale = SUPERSAMPLE
    # The drawing helpers read the canvas size and the scale from the spec.
    spec["width"] = width
    spec["height"] = height
    spec["scale"] = scale

    fonts = load_fonts(scale)
    image = Image.new("RGB", (width * scale, height * scale), hex_to_rgb(theme["background"]))
    draw = ImageDraw.Draw(image)

    title = str(spec.get("title") or "").strip()
    subtitle = str(spec.get("subtitle") or "").strip()
    if title:
        draw.text((56 * scale, 48 * scale), title, font=fonts["title"], fill=hex_to_rgb(theme["text"]))
    if subtitle:
        draw.text((58 * scale, 108 * scale), subtitle, font=fonts["subtitle"], fill=hex_to_rgb(theme["muted"]))

    chart_type = str(spec.get("type") or "bar")
    if chart_type in ("bar", "line", "area", "stacked", "scatter"):
        draw_cartesian(draw, spec, theme, fonts, series, labels, progress)
    elif chart_type == "hbar":
        draw_horizontal_bars(draw, spec, theme, fonts, series, labels, progress)
    elif chart_type in ("pie", "donut"):
        draw_pie(draw, spec, theme, fonts, series, labels, progress)
    else:
        raise ValueError(f"Unknown chart type: {chart_type}")

    # Legend for multi-series charts.
    if len(series) > 1 and chart_type not in ("pie", "donut"):
        x = 58 * scale
        y = (120 if title else 60) * scale
        for index, entry in enumerate(series):
            name = str(entry.get("name") or f"Series {index + 1}")
            draw.rounded_rectangle(
                [x, y, x + 22 * scale, y + 22 * scale],
                radius=6 * scale,
                fill=hex_to_rgb(PALETTE[index % len(PALETTE)]),
            )
            draw.text(
                (x + 32 * scale, y - 4 * scale),
                name,
                font=fonts["small"],
                fill=hex_to_rgb(theme["muted"]),
            )
            x += 32 * scale + text_size(draw, name, fonts["small"])[0] + 40 * scale

    return image.resize((width, height), Image.LANCZOS)


def main() -> int:
    args = parse_args()
    try:
        raw = open(args.spec, "r", encoding="utf-8").read() if args.spec else sys.stdin.read()
        spec = json.loads(raw)
    except Exception:
        print(traceback.format_exc(), file=sys.stderr, flush=True)
        return 1

    try:
        image = render_chart_image(spec)
    except Exception:
        print(traceback.format_exc(), file=sys.stderr, flush=True)
        return 1

    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    image.save(args.out, format="PNG", optimize=True)
    print(
        json.dumps(
            {
                "ok": True,
                "type": str(spec.get("type") or "bar"),
                "width": image.width,
                "height": image.height,
                "labels": len(spec.get("labels") or []),
                "series": len(spec.get("series") or []),
            }
        ),
        flush=True,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
