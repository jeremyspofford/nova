"""Avatar viseme generation — local SD inpainting on the concept plate.

Phase 0 tooling for docs/plans/avatar-view.md. Generates mouth/blink
variants of the upscaled Midjourney concept still with a locally-run
inpainting model (no cloud, no keys — RTX-class GPU expected). Each
variant is composited back through a feathered mask, so every pixel
outside the mask stays byte-identical to the base — avatar_kit.py then
verifies that gate and cuts the shipped crops.

The shipped 2026-07-19 kit used Lykon/dreamshaper-8-inpainting
(stabilityai/stable-diffusion-2-inpainting is gated on HF now) with the
prompts below; picked seeds are pinned in avatar_kit.PICKS.

Setup:  uv venv env && uv pip install --python env/bin/python \
            pillow numpy torch diffusers transformers accelerate safetensors
Usage:  python avatar_gen.py --work <dir>   # expects <dir>/base-plate-work.png
Resumable: existing candidate files are skipped; delete to regenerate.
"""
import argparse
import os

import torch
from diffusers import StableDiffusionInpaintPipeline
from PIL import Image, ImageDraw, ImageFilter

MODEL = "Lykon/dreamshaper-8-inpainting"
WIN = (164, 20, 676, 532)          # 512x512 face window (model-native res)

# mask geometry — MUST match avatar_kit.py (plate coords, 848x842)
MOUTH_ELLIPSE = (374, 264, 506, 352)   # reaches below the lips so "ah" can drop the jaw
EYE_ELLIPSES = [(340, 165, 416, 209), (444, 168, 520, 212)]
FEATHER = 10

STYLE = ("translucent blue hologram face made of glowing circuit wireframe "
         "lines, digital avatar, dark blue background, soft cyan glow, "
         "smooth luminous filaments")
NEG = ("teeth, tongue, photorealistic skin, flesh tones, red, orange, "
       "grin, smile, horror, distorted, extra features, text")

# name -> (region, prompt, guidance). Prompt lessons (2026-07-19):
# round needs the pucker phrasing + wide-mouth negative or it renders
# parted lips; open must NOT say "glowing mouth interior" and needs the
# neon negatives or it renders a bright outline ring (Jeremy veto); eyes
# need the iris/glint negatives or the eyeball shows through the lids.
VARIANTS = {
    "mouth-closed": ("mouth", "lips gently closed, calm serene neutral expression, " + STYLE, 7.5),
    "mouth-small":  ("mouth", "lips slightly parted, narrow gap between lips, " + STYLE, 7.5),
    "mouth-open":   ("mouth", "mouth gently open mid-speech, soft dark shadowed opening, natural relaxed lip contours, subtle engraved lips, " + STYLE, 7.5),
    "mouth-round":  ("mouth", "lips puckered into a small tight circle, whistling, kissing shape, small round dark opening between pursed lips, " + STYLE, 8.5),
    "eyes-closed":  ("eyes",  "both eyes fully closed, smooth opaque matte eyelids, soft skin-like lids, serene sleeping expression, " + STYLE, 7.5),
}
ROUND_NEG = NEG + ", wide mouth, open jaw"
OPEN_NEG = NEG + (", neon outline, glowing rim, outlined lips, bright edges, "
                  "light streaks, lens flare, glowing mouth")
EYES_NEG = NEG + (", visible iris, visible pupil, eyeball, half-open eyes, "
                  "eye glint, glossy reflection, bright eyelashes")


def build_mask(size, region):
    m = Image.new("L", size, 0)
    d = ImageDraw.Draw(m)
    boxes = [MOUTH_ELLIPSE] if region == "mouth" else EYE_ELLIPSES
    for b in boxes:
        d.ellipse(b, fill=255)
    return m.filter(ImageFilter.GaussianBlur(FEATHER))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--work", required=True)
    ap.add_argument("--seeds", default="7,21,77,99,123")
    args = ap.parse_args()
    seeds = [int(s) for s in args.seeds.split(",")]

    base = Image.open(f"{args.work}/base-plate-work.png").convert("RGB")
    os.makedirs(f"{args.work}/candidates", exist_ok=True)

    pipe = StableDiffusionInpaintPipeline.from_pretrained(
        MODEL, torch_dtype=torch.float16).to("cuda")
    pipe.set_progress_bar_config(disable=True)
    crop_img = base.crop(WIN)

    for name, (region, prompt, guidance) in VARIANTS.items():
        mask = build_mask(base.size, region)
        crop_mask = mask.crop(WIN)
        neg = {"mouth-round": ROUND_NEG, "mouth-open": OPEN_NEG,
               "eyes-closed": EYES_NEG}.get(name, NEG)
        for seed in seeds:
            out_path = f"{args.work}/candidates/{name}-s{seed}.png"
            if os.path.exists(out_path):
                continue
            g = torch.Generator("cuda").manual_seed(seed)
            out = pipe(prompt=prompt, negative_prompt=neg,
                       image=crop_img, mask_image=crop_mask,
                       width=512, height=512, num_inference_steps=40,
                       guidance_scale=guidance, generator=g).images[0]
            # composite through the feathered mask: outside stays byte-identical
            full = base.copy()
            patch = base.crop(WIN).copy()
            patch.paste(out, (0, 0), crop_mask)
            full.paste(patch, WIN[:2])
            full.save(out_path)
            print("done", name, seed, flush=True)
    print("ALL DONE")


if __name__ == "__main__":
    main()
