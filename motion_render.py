#!/usr/bin/env python
"""Render motion graphics frames for the DeepSeek Harness Media Studio plugin.

Motion graphics are animated graphic elements: type, shapes, logos, charts
and lower thirds that move over time, usually cut to audio. This renderer
draws them the way a motion designer would choreograph them:

* every element is keyframed and tweened with an easing curve, never linear;
* elements enter in a stagger instead of all at once;
* the composition respects the broadcast title-safe area;
* the output is a numbered frame sequence that the Host encodes with ffmpeg.

Templates (the deliverable types a motion designer is asked for)
    title        kinetic typography card - the film/announcement title
    lower_third  broadcast name strap in the lower title-safe area
    ident        logo / station ident: a mark that assembles itself
    chart        infographic animation: a chart that draws itself
    shapes       abstract motion background for a video bed
    stinger      a short transition or bumper for editing

Usage
    motion_render.py --spec spec.json --out <frames directory>
"""

from __future__ import annotations

import argparse
import json
import math
import os
import random
import sys
import traceback
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from graphics_render import (  # noqa: E402
    hex_to_rgb,
    load_fonts,
    mix_hex,
    render_chart_image,
    text_size,
)

TEMPLATES = ["title", "lower_third", "ident", "chart", "shapes", "stinger"]

STYLES = {
    # name: (easing, intro share, stagger share, motion distance)
    "smooth": ("ease_out", 0.22, 0.10, 1.0),
    "snappy": ("back_out", 0.16, 0.06, 1.15),
    "dramatic": ("ease_in_out", 0.30, 0.14, 1.35),
}

# The broadcast title-safe area: graphics stay inside this margin.
TITLE_SAFE = 0.08

# How much the camera creeps in while a composition holds, per template.
# A title card that sits still for four seconds reads as a still image, so
# the type is held under a slow push-in instead.
CAMERA_MOVES = {
    "title": 1.0,
    "lower_third": 0.45,
    "ident": 1.0,
    "chart": 0.35,
}


# #region Easing and timing


def ease_out(t: float) -> float:
    """Decelerate: fast at first, settling into place."""
    return 1.0 - (1.0 - t) ** 3


def ease_in_out(t: float) -> float:
    """Accelerate then decelerate: the calm, cinematic curve."""
    t = max(0.0, min(1.0, t))
    return 3 * t * t - 2 * t * t * t


def back_out(t: float) -> float:
    """Overshoot slightly and settle: the lively curve."""
    t = max(0.0, min(1.0, t))
    overshoot = 1.70158
    return 1 + (overshoot + 1) * (t - 1) ** 3 + overshoot * (t - 1) ** 2


EASINGS: Dict[str, Callable[[float], float]] = {
    "linear": lambda t: t,
    "ease_out": ease_out,
    "ease_in_out": ease_in_out,
    "back_out": back_out,
}


def segment(t: float, start: float, end: float) -> float:
    """Progress of the timeline between two points, clamped to 0..1."""
    if end <= start:
        return 0.0
    return max(0.0, min(1.0, (t - start) / (end - start)))


# #endregion

# #region Drawing helpers


def gradient(size: Tuple[int, int], top: str, bottom: str) -> "Image.Image":
    """A vertical gradient, drawn row by row."""
    from PIL import Image, ImageDraw

    width, height = size
    image = Image.new("RGB", (width, height), hex_to_rgb(top))
    draw = ImageDraw.Draw(image)
    start = hex_to_rgb(top)
    end = hex_to_rgb(bottom)
    for y in range(height):
        ratio = y / max(1, height - 1)
        colour = tuple(int(round(start[i] + (end[i] - start[i]) * ratio)) for i in range(3))
        draw.line([(0, y), (width, y)], fill=colour)
    return image


def glow(size: Tuple[int, int], centre: Tuple[float, float], radius: float, colour: str, strength: float):
    """A soft radial light behind the subject."""
    from PIL import Image, ImageDraw, ImageFilter

    width, height = size
    layer = Image.new("RGBA", size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)
    red, green, blue = hex_to_rgb(colour)
    steps = 26
    for step in range(steps, 0, -1):
        ratio = step / steps
        current = radius * ratio
        alpha = int(255 * strength * (1 - ratio) ** 2 * 0.5)
        draw.ellipse(
            [centre[0] - current, centre[1] - current, centre[0] + current, centre[1] + current],
            fill=(red, green, blue, alpha),
        )
    return layer.filter(ImageFilter.GaussianBlur(radius / 6))


def fade_alpha(layer, factor: float):
    """Scale the alpha channel of an RGBA layer."""
    from PIL import Image

    if factor >= 0.999:
        return layer
    factor = max(0.0, min(1.0, factor))
    alpha = layer.getchannel("A").point(lambda value: int(value * factor))
    layer.putalpha(alpha)
    return layer


def apply_camera(frame, t: float, amount: float):
    """A slow push-in with a slight drift, so a held card never freezes.

    This is the move a motion designer leaves under a title: the camera
    creeps in while the type sits still.
    """
    from PIL import Image

    width, height = frame.size
    zoom = 1.0 + 0.05 * amount * t
    scaled = frame.resize((max(1, int(round(width * zoom))), max(1, int(round(height * zoom)))), Image.BILINEAR)
    drift_x = int(round(math.sin(t * math.pi) * width * 0.012 * amount))
    drift_y = int(round(-t * height * 0.018 * amount))
    left = max(0, min(scaled.width - width, (scaled.width - width) // 2 + drift_x))
    top = max(0, min(scaled.height - height, (scaled.height - height) // 2 + drift_y))
    return scaled.crop((left, top, left + width, top + height))


def text_layer(
    size: Tuple[int, int],
    text: str,
    font,
    colour: str,
    anchor: str = "center",
    position: Tuple[float, float] = (0, 0),
    alpha: float = 1.0,
    scale: float = 1.0,
):
    """Render one line of text onto its own transparent layer."""
    from PIL import Image, ImageDraw

    layer = Image.new("RGBA", size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)
    red, green, blue = hex_to_rgb(colour)
    text = text or ""
    if scale != 1.0:
        # Draw small, then enlarge: the classic scale-in.
        scratch = Image.new("RGBA", size, (0, 0, 0, 0))
        scratch_draw = ImageDraw.Draw(scratch)
        width, height = text_size(scratch_draw, text, font)
        target = max(1, int(width * scale)), max(1, int(height * scale))
        tile = Image.new("RGBA", (target[0] + 8, target[1] + 8), (0, 0, 0, 0))
        tile_draw = ImageDraw.Draw(tile)
        tile_draw.text((0, 0), text, font=font, fill=(red, green, blue, 255))
        tile = tile.resize((max(1, target[0]), max(1, target[1])), Image.LANCZOS)
        x = position[0] - tile.width / 2 if anchor == "center" else position[0]
        y = position[1] - tile.height / 2 if anchor == "center" else position[1]
        layer.alpha_composite(tile, (int(x), int(y)))
    else:
        width, height = text_size(draw, text, font)
        x = position[0] - width / 2 if anchor == "center" else position[0]
        y = position[1] - height / 2 if anchor == "center" else position[1]
        draw.text((x, y), text, font=font, fill=(red, green, blue, 255))
    return fade_alpha(layer, alpha)


# #endregion


# #region Templates


def template_title(frame, spec, t, fonts, style) -> None:
    """Kinetic typography: an accent rule, the title, then the subtitle."""
    from PIL import ImageDraw

    width, height = spec["width"], spec["height"]
    easing, intro, stagger, distance = style
    draw = ImageDraw.Draw(frame)
    colour = spec["foreground"]
    accent = spec["accent"]

    # The accent rule grows out of the centre.
    rule = segment(t, 0.0, intro)
    rule_width = int(width * 0.22 * EASINGS[easing](rule))
    rule_height = max(4, int(height * 0.012))
    rule_y = int(height * 0.36)
    if rule_width > 2:
        draw.rounded_rectangle(
            [width // 2 - rule_width // 2, rule_y, width // 2 + rule_width // 2, rule_y + rule_height],
            radius=rule_height // 2,
            fill=hex_to_rgb(accent),
        )

    # The title slides up into place.
    title_at = segment(t, intro * 0.4, intro * 0.4 + intro)
    amount = EASINGS[easing](title_at)
    title_font = fonts["title"]
    layer = text_layer(
        (width, height),
        spec["text"],
        title_font,
        colour,
        position=(width // 2, int(height * 0.47) + (1 - amount) * height * 0.06 * distance),
        alpha=min(1.0, title_at * 1.6),
    )
    frame.alpha_composite(layer)

    # The subtitle follows a beat later.
    sub_at = segment(t, intro * 0.4 + stagger, intro * 0.4 + stagger + intro)
    if sub_at > 0:
        amount = EASINGS[easing](sub_at)
        layer = text_layer(
            (width, height),
            spec["subtitle"],
            fonts["subtitle"],
            spec["muted"],
            position=(width // 2, int(height * 0.58) + (1 - amount) * height * 0.03 * distance),
            alpha=min(1.0, sub_at * 1.6),
        )
        frame.alpha_composite(layer)


def template_lower_third(frame, spec, t, fonts, style) -> None:
    """A broadcast name strap: a band that wipes in over the lower third."""
    from PIL import Image, ImageDraw

    width, height = spec["width"], spec["height"]
    easing, intro, stagger, distance = style
    draw = ImageDraw.Draw(frame)

    safe = int(height * TITLE_SAFE)
    band_height = int(height * 0.16)
    band_bottom = height - safe
    band_top = band_bottom - band_height
    band_left = int(width * 0.06)

    wipe = segment(t, 0.0, intro)
    amount = EASINGS[easing](wipe)
    band_width = int((width * 0.52) * amount)
    if band_width > 2:
        layer = Image.new("RGBA", (width, height), (0, 0, 0, 0))
        layer_draw = ImageDraw.Draw(layer)
        layer_draw.rounded_rectangle(
            [band_left, band_top, band_left + band_width, band_bottom],
            radius=int(height * 0.012),
            fill=(*hex_to_rgb(spec["surface"]), 232),
        )
        frame.alpha_composite(layer)

        # The accent block pops in at the head of the band.
        block = segment(t, intro * 0.5, intro * 0.5 + intro * 0.6)
        block_amount = EASINGS[easing](block)
        block_size = int(band_height * 0.5 * max(0.0, block_amount))
        if block_size > 2:
            layer = Image.new("RGBA", (width, height), (0, 0, 0, 0))
            layer_draw = ImageDraw.Draw(layer)
            layer_draw.rounded_rectangle(
                [
                    band_left + int(height * 0.022),
                    band_bottom - band_height // 2 - block_size // 2,
                    band_left + int(height * 0.022) + block_size,
                    band_bottom - band_height // 2 + block_size // 2,
                ],
                radius=int(block_size * 0.22),
                fill=(*hex_to_rgb(spec["accent"]), 255),
            )
            frame.alpha_composite(layer)

    # The name slides in, the role follows.
    name_at = segment(t, intro * 0.6, intro * 0.6 + intro)
    if name_at > 0:
        amount = EASINGS[easing](name_at)
        layer = text_layer(
            (width, height),
            spec["text"],
            fonts["title"],
            spec["foreground"],
            anchor="left",
            position=(band_left + int(height * 0.075), band_top + band_height * 0.36 - (1 - amount) * height * 0.02 * distance),
            alpha=min(1.0, name_at * 1.6),
        )
        frame.alpha_composite(layer)

    role_at = segment(t, intro * 0.6 + stagger, intro * 0.6 + stagger + intro)
    if role_at > 0:
        layer = text_layer(
            (width, height),
            spec["subtitle"],
            fonts["subtitle"],
            spec["muted"],
            anchor="left",
            position=(band_left + int(height * 0.075), band_top + band_height * 0.68),
            alpha=min(1.0, role_at * 1.6),
        )
        frame.alpha_composite(layer)


def template_ident(frame, spec, t, fonts, style) -> None:
    """A logo ident: a ring draws itself, then the wordmark settles under it."""
    from PIL import Image, ImageDraw

    width, height = spec["width"], spec["height"]
    easing, intro, stagger, distance = style
    draw = ImageDraw.Draw(frame)

    centre = (width // 2, int(height * 0.44))
    radius = int(height * 0.17)
    ring = segment(t, 0.0, intro * 1.6)
    amount = EASINGS[easing](ring)
    red, green, blue = hex_to_rgb(spec["accent"])
    start = -90.0
    sweep = 360.0 * amount
    if sweep > 0.5:
        draw.arc(
            [centre[0] - radius, centre[1] - radius, centre[0] + radius, centre[1] + radius],
            start=start,
            end=start + sweep,
            fill=(red, green, blue, 255),
            width=max(3, int(height * 0.016)),
        )
    # A dot rides the head of the ring while it draws.
    if 0 < amount < 0.999:
        angle = math.radians(start + sweep)
        dot_x = centre[0] + math.cos(angle) * radius
        dot_y = centre[1] + math.sin(angle) * radius
        dot = max(4, int(height * 0.018))
        draw.ellipse([dot_x - dot, dot_y - dot, dot_x + dot, dot_y + dot], fill=(red, green, blue, 255))

    word_at = segment(t, intro * 1.4 + stagger, intro * 1.4 + stagger + intro)
    if word_at > 0:
        layer = text_layer(
            (width, height),
            spec["text"],
            fonts["title"],
            spec["foreground"],
            position=(width // 2, int(height * 0.72)),
            alpha=min(1.0, word_at * 1.6),
            scale=0.9 + 0.1 * EASINGS[easing](word_at),
        )
        frame.alpha_composite(layer)


def template_chart(frame, spec, t, fonts, style) -> None:
    """An infographic: the chart draws itself while the heading settles in."""
    easing, intro, stagger, distance = style

    # The chart itself is drawn by the shared chart renderer, so both stay
    # identical: the only difference here is the progress value.
    progress = EASINGS[easing](segment(t, intro * 0.5, intro * 0.5 + 0.55))
    chart_spec = dict(spec.get("chart") or {})
    chart_spec["progress"] = progress
    chart_spec.setdefault("width", frame.width)
    chart_spec.setdefault("height", frame.height)
    chart_spec.setdefault("theme", chart_theme_for(spec.get("background", "#0b1220")))
    try:
        chart = render_chart_image(chart_spec)
    except Exception:
        chart = None
    if chart is not None:
        frame.paste(chart, (0, 0))

    # The heading sits on top of the chart.
    heading_at = segment(t, 0.0, intro)
    if heading_at > 0:
        layer = text_layer(
            (frame.width, frame.height),
            spec["text"],
            fonts["title"],
            spec["foreground"],
            anchor="left",
            position=(int(frame.width * 0.07), int(frame.height * 0.13)),
            alpha=min(1.0, heading_at * 1.6),
        )
        frame.alpha_composite(layer)


def chart_theme_for(background: str) -> str:
    """Pick the chart theme that sits on this background."""
    red, green, blue = hex_to_rgb(background)
    luminance = (0.299 * red + 0.587 * green + 0.114 * blue) / 255
    return "light" if luminance > 0.55 else "dark"


def cover_image(path: str, size):
    """Load a picture and fill the canvas with it, cropping the overflow."""
    from PIL import Image

    try:
        image = Image.open(path).convert("RGB")
    except Exception:
        return None
    width, height = size
    ratio = max(width / image.width, height / image.height)
    resized = image.resize(
        (max(1, int(image.width * ratio)), max(1, int(image.height * ratio))),
        Image.LANCZOS,
    )
    left = (resized.width - width) // 2
    top = (resized.height - height) // 2
    return resized.crop((left, top, left + width, top + height)).convert("RGBA")


def draw_logo(frame, path: str, max_width_ratio: float = 0.18, margin_ratio: float = 0.045) -> None:
    """Put a logo in the top right corner of the frame."""
    from PIL import Image

    try:
        logo = Image.open(path).convert("RGBA")
    except Exception:
        return
    width, height = frame.size
    target = int(width * max_width_ratio)
    if logo.width > target:
        scale = target / logo.width
        logo = logo.resize((max(1, int(logo.width * scale)), max(1, int(logo.height * scale))), Image.LANCZOS)
    margin = int(width * margin_ratio)
    frame.alpha_composite(logo, (width - logo.width - margin, margin))


def template_shapes(frame, spec, t, fonts, style) -> None:
    """An abstract motion bed: shapes drift up at different depths."""
    from PIL import Image, ImageDraw

    width, height = spec["width"], spec["height"]
    _, _, _, distance = style
    draw = ImageDraw.Draw(frame)
    rng = random.Random(int(spec.get("seed", 7)))
    shapes = spec.get("shapes")
    if not shapes:
        shapes = []
        for _ in range(14):
            shapes.append(
                {
                    "x": rng.uniform(0.05, 0.95),
                    "y": rng.uniform(0.0, 1.0),
                    "size": rng.uniform(0.03, 0.11),
                    "depth": rng.uniform(0.25, 1.0),
                    "colour": rng.choice(spec["palette"]),
                    "round": rng.random() < 0.5,
                }
            )

    for shape in shapes:
        depth = float(shape.get("depth", 0.5))
        size = int(height * float(shape.get("size", 0.06)) * (0.5 + depth * 0.8))
        # Shapes rise slowly and wrap around, so the loop never ends.
        travel = (float(shape.get("y", 0.5)) + t * depth * 0.55) % 1.25
        centre_x = int(width * float(shape.get("x", 0.5)))
        centre_y = int(height * (1.05 - travel))
        alpha = int(70 + 120 * depth)
        red, green, blue = hex_to_rgb(shape.get("colour", spec["accent"]))
        if shape.get("round"):
            draw.ellipse(
                [centre_x - size // 2, centre_y - size // 2, centre_x + size // 2, centre_y + size // 2],
                fill=(red, green, blue, alpha),
            )
        else:
            draw.rounded_rectangle(
                [centre_x - size // 2, centre_y - size // 2, centre_x + size // 2, centre_y + size // 2],
                radius=max(2, size // 6),
                fill=(red, green, blue, alpha),
            )


def template_stinger(frame, spec, t, fonts, style) -> None:
    """A short bumper: a diagonal swoosh sweeps through the frame."""
    from PIL import Image, ImageDraw

    width, height = spec["width"], spec["height"]
    easing, _, _, distance = style
    draw = ImageDraw.Draw(frame)

    # The swoosh crosses the frame once, then the frame clears again.
    sweep = segment(t, 0.05, 0.75)
    amount = EASINGS[easing](sweep)
    centre = -width * 0.4 + amount * width * 1.8
    band = width * 0.22
    skew = height * 0.22

    accent = hex_to_rgb(spec["accent"])
    draw.polygon(
        [
            (centre - band / 2, 0),
            (centre + band / 2, 0),
            (centre + band / 2 - skew, height),
            (centre - band / 2 - skew, height),
        ],
        fill=(*accent, 255),
    )
    foreground = hex_to_rgb(spec["foreground"])
    draw.polygon(
        [
            (centre - band * 1.35, 0),
            (centre - band * 0.85, 0),
            (centre - band * 0.85 - skew, height),
            (centre - band * 1.35 - skew, height),
        ],
        fill=(*foreground, 255),
    )

    # A flash of the background colour as the swoosh crosses the centre.
    flash = segment(t, 0.42, 0.60)
    if 0 < flash < 1:
        layer = Image.new("RGBA", (width, height), (0, 0, 0, 0))
        layer_draw = ImageDraw.Draw(layer)
        strength = 1 - abs(flash - 0.5) * 2
        layer_draw.rectangle([0, 0, width, height], fill=(*hex_to_rgb(spec["background"]), int(255 * strength)))
        frame.alpha_composite(layer)


TEMPLATE_FUNCTIONS: Dict[str, Callable] = {
    "title": template_title,
    "lower_third": template_lower_third,
    "ident": template_ident,
    "chart": template_chart,
    "shapes": template_shapes,
    "stinger": template_stinger,
}


# #endregion


def render_frames(spec: Dict[str, Any], out_dir: str) -> Dict[str, Any]:
    """Draw every frame of the animation into ``out_dir``."""
    from PIL import Image

    template = str(spec.get("template") or "title")
    if template not in TEMPLATE_FUNCTIONS:
        raise ValueError(f"Unknown motion template: {template}")

    width = int(spec.get("width") or 1280)
    height = int(spec.get("height") or 720)
    fps = max(1, int(spec.get("fps") or 30))
    duration = float(spec.get("duration") or 4)
    frames = max(1, int(round(duration * fps)))
    style_name = str(spec.get("style") or "smooth")
    easing, intro, stagger, distance = STYLES.get(style_name, STYLES["smooth"])

    background = str(spec.get("background") or "#0b1220")
    surface = str(spec.get("surface") or "#1e293b")
    foreground = str(spec.get("foreground") or "#f8fafc")
    muted = str(spec.get("muted") or "#94a3b8")
    accent = str(spec.get("accent") or "#38bdf8")
    palette = spec.get("palette") or [accent, "#f472b6", "#34d399", "#fbbf24", "#a78bfa", "#60a5fa"]

    spec.update(
        {
            "width": width,
            "height": height,
            "background": background,
            "surface": surface,
            "foreground": foreground,
            "muted": muted,
            "accent": accent,
            "palette": palette,
            "text": str(spec.get("text") or ""),
            "subtitle": str(spec.get("subtitle") or ""),
        }
    )

    fonts = load_fonts(1)
    # Scale the type to the canvas so every size looks composed.
    ratio = height / 720.0
    fonts["title"] = _resize_font(fonts["title"], ratio)
    fonts["subtitle"] = _resize_font(fonts["subtitle"], ratio)
    fonts["small"] = _resize_font(fonts["small"], ratio)

    # The background is static: render it once and copy it per frame.
    backdrop = gradient((width, height), background, mix_hex(background, accent, 0.10)).convert("RGBA")
    if template in ("title", "ident"):
        backdrop = Image.alpha_composite(
            backdrop, glow((width, height), (width // 2, int(height * 0.45)), height * 0.55, accent, 0.5)
        )
    # A material can replace the background: a photograph with type over it.
    background_image = str(spec.get("backgroundImage") or "")
    if background_image:
        picture = cover_image(background_image, (width, height))
        if picture is not None:
            backdrop = Image.alpha_composite(
                picture,
                Image.new("RGBA", (width, height), (*hex_to_rgb(background), 140)),
            )
    logo = str(spec.get("logo") or "")

    draw_function = TEMPLATE_FUNCTIONS[template]
    style = (easing, intro, stagger, distance)
    # How much the camera creeps in while the composition holds.
    camera = CAMERA_MOVES.get(template, 0.0)
    written = 0
    for index in range(frames):
        t = index / max(1, frames - 1)
        frame = backdrop.copy()
        draw_function(frame, spec, t, fonts, style)
        if logo:
            draw_logo(frame, logo)
        if camera > 0:
            frame = apply_camera(frame, t, camera)
        # The whole composition fades out at the very end.
        fade = 1.0 - segment(t, 0.92, 1.0)
        if fade < 0.999:
            frame = fade_alpha(frame, fade)
        frame.convert("RGB").save(os.path.join(out_dir, "frame_%05d.jpg" % index), format="JPEG", quality=92)
        written += 1

    return {
        "ok": True,
        "template": template,
        "frames": written,
        "fps": fps,
        "width": width,
        "height": height,
        "duration": round(written / fps, 2),
    }


def render_still(spec: Dict[str, Any], out_path: str) -> Dict[str, Any]:
    """Draw one composed frame, for a keyframe that is not animated."""
    from PIL import Image

    frames = max(1, int(round(float(spec.get("duration") or 4) * int(spec.get("fps") or 30))))
    report = render_frames(spec, os.path.dirname(out_path) or ".")
    source = os.path.join(os.path.dirname(out_path) or ".", "frame_%05d.jpg" % (frames - 1))
    if not os.path.exists(source):
        source = os.path.join(os.path.dirname(out_path) or ".", "frame_00000.jpg")
    image = Image.open(source).convert("RGB")
    image.save(out_path, format="JPEG", quality=95)
    for index in range(frames):
        stale = os.path.join(os.path.dirname(out_path) or ".", "frame_%05d.jpg" % index)
        if os.path.exists(stale):
            os.remove(stale)
    return {**report, "ok": True, "still": out_path}


def _resize_font(font, ratio: float):
    """Return the same font at another size."""
    from PIL import ImageFont

    try:
        return ImageFont.truetype(font.path, max(8, int(font.size * ratio)))
    except Exception:
        return font


def main() -> int:
    parser = argparse.ArgumentParser(description="Render motion graphics frames.")
    parser.add_argument("--out", required=True, help="Directory that receives the frames.")
    parser.add_argument("--spec", default="", help="Spec file; the default is stdin.")
    parser.add_argument("--still", default="", help="Write one composed still to this file instead of a frame sequence.")
    args = parser.parse_args()

    try:
        raw = open(args.spec, "r", encoding="utf-8").read() if args.spec else sys.stdin.read()
        spec = json.loads(raw)
    except Exception:
        print(traceback.format_exc(), file=sys.stderr, flush=True)
        return 1

    os.makedirs(args.out, exist_ok=True)
    try:
        if args.still:
            report = render_still(spec, args.still)
        else:
            report = render_frames(spec, args.out)
    except Exception:
        print(traceback.format_exc(), file=sys.stderr, flush=True)
        return 1
    print(json.dumps(report), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
