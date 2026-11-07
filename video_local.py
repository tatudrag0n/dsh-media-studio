#!/usr/bin/env python
"""Local video generation for the DeepSeek Harness Media Studio plugin.

The Host half spawns this script, waits for it, and then muxes the painted
frames into an MP4 with ffmpeg. This script only paints frames: it writes
``frame_%05d.jpg`` into the output directory and prints one JSON report on its
last stdout line.

Recipes
    svd        Stable Video Diffusion (image -> video)
    wan21      Wan 2.1 T2V 1.3B (text -> video)
    cogvideox  CogVideoX 2B (text -> video)
    ltx        LTX-Video 2B (text -> video)

Weights are fetched by huggingface_hub on first use and cached afterwards.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import traceback
from typing import Any, List


def log(message: str) -> None:
    """Write progress to stderr, so stdout stays a clean report channel."""
    print(message, file=sys.stderr, flush=True)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Paint video frames with diffusers.")
    parser.add_argument("--recipe", required=True, choices=["svd", "wan21", "cogvideox", "ltx"])
    parser.add_argument("--model", required=True)
    parser.add_argument("--out", required=True, help="Directory that receives the frames.")
    parser.add_argument("--prompt", default="")
    parser.add_argument("--negative", default="")
    parser.add_argument("--image", default="", help="First frame for image-to-video recipes.")
    parser.add_argument("--width", type=int, default=1024)
    parser.add_argument("--height", type=int, default=576)
    parser.add_argument("--frames", type=int, default=25)
    parser.add_argument("--fps", type=int, default=8)
    parser.add_argument("--steps", type=int, default=25)
    parser.add_argument("--seed", type=int, default=0)
    parser.add_argument("--device", default="cuda")
    parser.add_argument("--decode-chunk", type=int, default=4, help="Frames decoded per VAE chunk.")
    return parser.parse_args()


def torch_device(requested: str) -> str:
    """Resolve the torch device name, falling back to the CPU when needed."""
    import torch

    if requested.startswith("cuda") and not torch.cuda.is_available():
        log("CUDA is not available; falling back to the CPU.")
        return "cpu"
    return requested


def load_image(path: str):
    """Load one picture and resize it to the requested frame shape."""
    from PIL import Image

    image = Image.open(path).convert("RGB")
    return image


def as_pil_list(frames: Any) -> List[Any]:
    """Normalize a pipeline result into a list of PIL images."""
    import numpy as np
    from PIL import Image

    if frames is None:
        return []
    if isinstance(frames, list) and len(frames) > 0 and isinstance(frames[0], list):
        frames = frames[0]
    output = []
    for frame in frames:
        if isinstance(frame, Image.Image):
            output.append(frame)
        else:
            array = np.asarray(frame)
            if array.dtype != np.uint8:
                array = (array * 255).clip(0, 255).astype("uint8")
            output.append(Image.fromarray(array))
    return output


def save_frames(frames: List[Any], out_dir: str, width: int, height: int) -> int:
    """Write every frame as ``frame_%05d.jpg`` and return the frame count."""
    from PIL import Image

    os.makedirs(out_dir, exist_ok=True)
    for index, frame in enumerate(frames):
        if frame.size != (width, height):
            frame = frame.resize((width, height), Image.Resampling.LANCZOS)
        frame.save(os.path.join(out_dir, f"frame_{index:05d}.jpg"), quality=95)
    return len(frames)


def generate_svd(args: argparse.Namespace, device: str) -> List[Any]:
    """Stable Video Diffusion: animate one picture."""
    import torch
    from diffusers import StableVideoDiffusionPipeline

    if not args.image:
        raise SystemExit("The svd recipe needs a first frame (--image).")

    pipe = StableVideoDiffusionPipeline.from_pretrained(
        args.model,
        torch_dtype=torch.float16 if device.startswith("cuda") else torch.float32,
        variant="fp16",
        safety_checker=None,
        requires_safety_checker=False,
    )
    pipe = pipe.to(device)
    image = load_image(args.image).resize((args.width, args.height))
    generator = torch.Generator(device="cpu").manual_seed(args.seed)
    log(f"Painting {args.frames} frames at {args.width}x{args.height}.")
    result = pipe(
        image,
        height=args.height,
        width=args.width,
        num_frames=args.frames,
        decode_chunk_size=args.decode_chunk,
        generator=generator,
        num_inference_steps=args.steps,
    )
    return as_pil_list(result.frames)


def generate_wan21(args: argparse.Namespace, device: str) -> List[Any]:
    """Wan 2.1: native text to video."""
    import torch
    from diffusers import WanPipeline

    pipe = WanPipeline.from_pretrained(args.model, torch_dtype=torch.bfloat16)
    if device.startswith("cuda"):
        pipe.enable_model_cpu_offload()
    else:
        pipe = pipe.to(device)
    generator = torch.Generator(device="cpu").manual_seed(args.seed)
    result = pipe(
        prompt=args.prompt,
        negative_prompt=args.negative or None,
        height=args.height,
        width=args.width,
        num_frames=args.frames,
        guidance_scale=5.0,
        num_inference_steps=args.steps,
        generator=generator,
    )
    return as_pil_list(result.frames)


def generate_cogvideox(args: argparse.Namespace, device: str) -> List[Any]:
    """CogVideoX 2B: native text to video."""
    import torch
    from diffusers import CogVideoXPipeline

    pipe = CogVideoXPipeline.from_pretrained(args.model, torch_dtype=torch.float16)
    if device.startswith("cuda"):
        pipe.enable_model_cpu_offload()
    else:
        pipe = pipe.to(device)
    generator = torch.Generator(device="cpu").manual_seed(args.seed)
    result = pipe(
        prompt=args.prompt,
        num_frames=args.frames,
        height=args.height,
        width=args.width,
        guidance_scale=6.0,
        num_inference_steps=args.steps,
        generator=generator,
    )
    return as_pil_list(result.frames)


def generate_ltx(args: argparse.Namespace, device: str) -> List[Any]:
    """LTX-Video 2B: native text to video."""
    import torch
    from diffusers import LTXPipeline

    pipe = LTXPipeline.from_pretrained(args.model, torch_dtype=torch.bfloat16)
    if device.startswith("cuda"):
        pipe.enable_model_cpu_offload()
    else:
        pipe = pipe.to(device)
    generator = torch.Generator(device="cpu").manual_seed(args.seed)
    result = pipe(
        prompt=args.prompt,
        negative_prompt=args.negative or None,
        num_frames=args.frames,
        width=args.width,
        height=args.height,
        guidance_scale=3.0,
        num_inference_steps=args.steps,
        generator=generator,
    )
    return as_pil_list(result.frames)


RECIPES = {
    "svd": generate_svd,
    "wan21": generate_wan21,
    "cogvideox": generate_cogvideox,
    "ltx": generate_ltx,
}


def main() -> int:
    args = parse_args()
    device = torch_device(args.device)
    log(f"Recipe {args.recipe} on {device}, model {args.model}")
    try:
        frames = RECIPES[args.recipe](args, device)
    except SystemExit:
        raise
    except Exception:
        log(traceback.format_exc())
        return 1
    if not frames:
        log("The pipeline returned no frames.")
        return 1
    count = save_frames(frames, args.out, args.width, args.height)
    report = {
        "ok": True,
        "recipe": args.recipe,
        "model": args.model,
        "frames": count,
        "width": args.width,
        "height": args.height,
        "fps": args.fps,
        "steps": args.steps,
        "seed": args.seed,
    }
    print(json.dumps(report), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
