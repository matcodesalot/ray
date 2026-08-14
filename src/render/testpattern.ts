import type { Framebuffer } from '../engine/framebuffer';
import { rgb } from '../engine/color';

/**
 * Stage 1 scaffolding: proves the whole pixel pipeline works before there is anything
 * real to draw. It is deliberately designed to fail *visibly* rather than subtly.
 *
 *   - The XOR field animates, so a frozen loop is obvious.
 *   - The three swatches are pure red, green and blue, left to right. If the byte order
 *     in color.ts were wrong they would come out blue, green, red.
 *   - The one-pixel border and corner brackets touch the outermost pixels, so cropping,
 *     off-by-one sizing or a blurry upscale all show up at the edges.
 *
 * Stage 2 deletes this file.
 */
export function drawTestPattern(fb: Framebuffer, time: number): void {
  const { width, height, pixels } = fb;

  // Classic XOR field. Scrolling it by time turns a static image into a liveness check.
  const offset = Math.floor(time * 40);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      const v = ((x + offset) ^ y) & 0xff;
      pixels[row + x] = rgb(v, (v * 2) & 0xff, 255 - v);
    }
  }

  // Left to right: red, green, blue.
  const swatch = 24;
  const swatchY = height - swatch - 12;
  fb.fillRect(12, swatchY, swatch, swatch, rgb(255, 0, 0));
  fb.fillRect(12 + swatch + 6, swatchY, swatch, swatch, rgb(0, 255, 0));
  fb.fillRect(12 + (swatch + 6) * 2, swatchY, swatch, swatch, rgb(0, 0, 255));

  // One-pixel border on the outermost pixels of the buffer.
  const border = rgb(255, 255, 255);
  fb.fillRect(0, 0, width, 1, border);
  fb.fillRect(0, height - 1, width, 1, border);
  fb.fillRect(0, 0, 1, height, border);
  fb.fillRect(width - 1, 0, 1, height, border);

  // Corner brackets, so a missing row or column at any edge is unmistakable.
  const mark = rgb(255, 0, 255);
  const len = 10;
  for (const [cx, cy, dx, dy] of [
    [0, 0, 1, 1],
    [width - 1, 0, -1, 1],
    [0, height - 1, 1, -1],
    [width - 1, height - 1, -1, -1],
  ] as const) {
    for (let i = 0; i < len; i++) {
      pixels[cy * width + (cx + dx * i)] = mark;
      pixels[(cy + dy * i) * width + cx] = mark;
    }
  }
}
