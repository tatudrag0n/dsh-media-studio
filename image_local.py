"""Stable Diffusion で 1 枚描く (the plugin's local image backend).

`diffusers` の text-to-image パイプラインを 1 回だけ回して PNG を書き出す。
モデルは初回に Hugging Face のキャッシュへ落ちる。GPU があれば半精度で動く。

呼び出し側は `image.provider: local` のときにこのスクリプトを起動する。
`torch` か `diffusers` が無い場合は終了コード 3 と理由を返す。
"""

import argparse
import json
import sys

# モデルが学習した大きさで描いてから、要求された大きさへ拡大する。
# SD 1.5 系は 512 を超えるとタイル状に破綻し、SDXL 系は 1024 が本来の大きさ。
def max_side_for(model: str) -> int:
    name = model.lower()
    if any(token in name for token in ("xl", "qwen", "sd3", "flux")):
        return 1024
    return 512


def parse() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Render one image with diffusers.")
    parser.add_argument("--prompt", required=True)
    parser.add_argument("--negative", default="")
    parser.add_argument("--width", type=int, default=512)
    parser.add_argument("--height", type=int, default=512)
    parser.add_argument("--steps", type=int, default=4)
    parser.add_argument("--seed", type=int, default=0)
    parser.add_argument("--model", default="stabilityai/sd-turbo")
    parser.add_argument("--out", required=True)
    return parser.parse_args()


def load_pipeline(diffusers, model: str, dtype):
    """Load whichever text-to-image pipeline this checkpoint wants."""
    # Qwen-Image ships its own pipeline class; the auto mapping does not know it.
    qwen = getattr(diffusers, "QwenImagePipeline", None)
    if qwen is not None and "qwen" in model.lower():
        return qwen.from_pretrained(model, torch_dtype=dtype)
    return diffusers.AutoPipelineForText2Image.from_pretrained(model, torch_dtype=dtype)


def main() -> int:
    args = parse()
    try:
        import torch
        import diffusers
    except Exception as error:  # noqa: BLE001 - the message is the point
        print(
            "画像生成には torch と diffusers が必要です。"
            f"`pip install torch diffusers transformers accelerate` を実行してください ({error})",
            file=sys.stderr,
        )
        return 3

    device = "cuda" if torch.cuda.is_available() else "cpu"
    dtype = torch.float16 if device == "cuda" else torch.float32
    # A single file keeps the cache warm across runs; weights load from the HF
    # cache after the first download.
    pipe = load_pipeline(diffusers, args.model, dtype)
    pipe = pipe.to(device)
    if hasattr(pipe, "set_progress_bar_config"):
        pipe.set_progress_bar_config(disable=True)

    generator = torch.Generator(device=device).manual_seed(args.seed) if args.seed else None
    # Turbo/distilled checkpoints want no classifier-free guidance.
    guidance = 0.0 if "turbo" in args.model or "lcm" in args.model else 7.0
    width = max(256, min(1536, args.width))
    height = max(256, min(1536, args.height))
    # Most checkpoints want multiples of 8.
    width -= width % 8
    height -= height % 8

    native = max_side_for(args.model)
    scale = min(1.0, native / max(width, height))
    work_width = max(256, int(round(width * scale)) // 8 * 8)
    work_height = max(256, int(round(height * scale)) // 8 * 8)

    image = pipe(
        prompt=args.prompt,
        negative_prompt=args.negative or None,
        num_inference_steps=max(1, min(80, args.steps)),
        guidance_scale=guidance,
        width=work_width,
        height=work_height,
        generator=generator,
    ).images[0]
    if (work_width, work_height) != (width, height):
        from PIL import Image
        image = image.resize((width, height), Image.LANCZOS)
    image.save(args.out)
    print(json.dumps({"ok": True, "width": image.width, "height": image.height, "model": args.model}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
