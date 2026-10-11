#!/usr/bin/env python3
"""Derive a headroom canonical from a reviewed green-screen RAW source.

The figure is scaled down about the centre of its floor line so it fills
--target-height of the frame, and the canvas keeps the source size and its own
chroma green. Output is deterministic for a given Pillow version; the printed
transform JSON is what canonical_headroom_derivatives.transform_json records.

  python3 scripts/derive_canonical_headroom.py IN.png OUT.png --target-height 0.78
"""
import argparse
import hashlib
import json
import sys

import PIL
from PIL import Image


def chroma_mask(rgb):
    width, height = rgb.size
    pixels = rgb.load()
    mask = Image.new('1', (width, height))
    out = mask.load()
    for y in range(height):
        for x in range(width):
            r, g, b = pixels[x, y]
            out[x, y] = not (g > 150 and r < 120 and b < 120)
    return mask


def border_fill(rgb):
    width, height = rgb.size
    samples = [rgb.getpixel((x, y)) for x in range(0, width, 8) for y in (0, height - 1)]
    samples += [rgb.getpixel((x, y)) for y in range(0, height, 8) for x in (0, width - 1)]
    return tuple(sorted(channel)[len(channel) // 2] for channel in zip(*samples))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('source')
    parser.add_argument('output')
    parser.add_argument('--target-height', type=float, default=0.78)
    args = parser.parse_args()

    source_bytes = open(args.source, 'rb').read()
    source = Image.open(args.source)
    rgb = source.convert('RGB')
    width, height = rgb.size
    box = chroma_mask(rgb).getbbox()
    if not box:
        sys.exit('no figure found')
    left, top, right, bottom = box
    scale = round(args.target_height * height / (bottom - top), 4)
    if not 0.5 <= scale < 1:
        sys.exit(f'scale {scale} out of range; the source already has headroom')
    pivot_x, pivot_y = width / 2, bottom
    fill = border_fill(rgb)

    scaled = rgb.resize((round(width * scale), round(height * scale)), Image.Resampling.LANCZOS)
    offset = (round(pivot_x - pivot_x * scale), round(pivot_y - pivot_y * scale))
    canvas = Image.new('RGB', (width, height), fill)
    canvas.paste(scaled, offset)
    if source.mode == 'RGBA':
        canvas = canvas.convert('RGBA')
    canvas.save(args.output, format='PNG', optimize=False)

    output_bytes = open(args.output, 'rb').read()
    print(json.dumps({
        'kind': 'headroom-pad-v1',
        'tool': f'Pillow {PIL.__version__}',
        'resampler': 'lanczos',
        'targetFigureHeightRatio': args.target_height,
        'scale': scale,
        'pivot': [pivot_x, pivot_y],
        'offset': list(offset),
        'fill': list(fill),
        'size': [width, height],
        'sourceFigureBox': list(box),
        'sourceSha256': hashlib.sha256(source_bytes).hexdigest(),
        'derivedSha256': hashlib.sha256(output_bytes).hexdigest(),
    }, separators=(',', ':')))


if __name__ == '__main__':
    main()
