import { CEILING_TEXTURE, FLOOR_TEXTURE } from '../assets/textures';
import { TEX_MASK, TEX_SIZE } from '../config';
import { LIGHT_UNIT, rgb, shade } from '../engine/color';
import type { Framebuffer } from '../engine/framebuffer';
import type { Player } from '../player';
import { lightFactor } from './lighting';
import type { RenderOptions } from './options';
import type { WallSpans } from './walls';

/**
 * Floor and ceiling casting.
 *
 * Walls are drawn per *column*, because a wall is a vertical surface and everything about
 * one screen column of it is constant. Floors are the opposite: a floor is horizontal, so
 * the thing that stays constant is a screen *row*.
 *
 * ## Why a row is the right unit
 *
 * The camera sits at wall mid-height, half a unit above the floor, and cannot tilt. So
 * every pixel on a given screen row looks at a floor point exactly the same perpendicular
 * distance away:
 *
 *            eye
 *             ●─────────────────  horizon
 *             │╲
 *         0.5 │  ╲  row y
 *             │    ╲
 *      ───────┴──────●──────────  floor
 *             │← d  →│
 *
 *     (y - horizon) / VIEW_H  =  0.5 / d        →        d = 0.5 * VIEW_H / (y - horizon)
 *
 * Same similar-triangles argument as Stage 4's wall projection, turned on its side and
 * solved for distance instead of height. One division per row, not per pixel.
 *
 * ## And why the texture coordinate is exact
 *
 * With the depth fixed for the whole row, the floor position at column x is
 *
 *     floor(x) = pos + rowDistance * rayDir(x)
 *
 * and `rayDir(x) = dir + plane * cameraX` is linear in x. So the floor position is **linear
 * in x too** — which means stepping it with a plain addition per pixel is not an
 * approximation, it is exact.
 *
 * This is perspective-correct texture mapping, and it comes free from working along a line
 * of constant depth. Interpolating texture coordinates linearly across a screen row that
 * spans varying depths is exactly the mistake that gave the PlayStation 1 its famously
 * wobbling textures.
 *
 * ## This is what the software framebuffer was for
 *
 * There is no `drawImage` call that does any of this. Every pixel has its own texture
 * coordinate and its own brightness. Stage 1 chose per-pixel rendering over the canvas
 * drawing API on the promise that this stage would need it; this is the stage.
 */

/** Used when floor casting is switched off, so the difference is visible. */
const FLAT_CEILING = rgb(56, 56, 64);
const FLAT_FLOOR = rgb(84, 76, 68);

export function drawFloorAndCeiling(
  fb: Framebuffer,
  player: Player,
  spans: WallSpans,
  options: RenderOptions,
): void {
  const width = fb.width;
  const height = fb.height;
  const horizon = height >> 1;
  const pixels = fb.pixels;

  const { top, bottom } = spans;

  if (!options.castFloors) {
    fillFlat(pixels, width, height, horizon, top, bottom);
    return;
  }

  const floorTex = FLOOR_TEXTURE.data;
  const ceilTex = CEILING_TEXTURE.data;

  // The rays at the extreme left and right edges of the screen. Everything between is a
  // linear interpolation of these two, which is what makes the per-pixel step a plain add.
  const rayDirX0 = player.dirX - player.planeX;
  const rayDirY0 = player.dirY - player.planeY;
  const rayDirX1 = player.dirX + player.planeX;
  const rayDirY1 = player.dirY + player.planeY;

  /** Eye height above the floor, in world units. Half of a one-unit-tall wall. */
  const eyeHeight = 0.5;

  for (let y = horizon; y < height; y++) {
    /**
     * Distance from the horizon to this row's centre, in pixels.
     *
     * The `+ 0.5` samples the centre of the row, consistent with cameraX in Stage 3 and
     * the texture stepping in Stage 6 — and here it also removes a division by zero. The
     * row exactly on the horizon looks at a floor point infinitely far away; sampling its
     * centre instead asks about a point half a pixel below, which is merely very distant.
     */
    const p = y + 0.5 - horizon;

    const rowDistance = (eyeHeight * height) / p;

    // How far the floor point moves for one pixel step to the right.
    const stepX = (rowDistance * (rayDirX1 - rayDirX0)) / width;
    const stepY = (rowDistance * (rayDirY1 - rayDirY0)) / width;

    // Start at the centre of the leftmost pixel, again to avoid a half-pixel bias.
    let floorX = player.x + rowDistance * rayDirX0 + stepX * 0.5;
    let floorY = player.y + rowDistance * rayDirY0 + stepY * 0.5;

    // Constant for the whole row: one lookup instead of 320.
    const brightness = options.lighting ? lightFactor(rowDistance) : LIGHT_UNIT;

    const ceilY = height - y - 1;
    let floorIndex = y * width;
    let ceilIndex = ceilY * width;

    for (let x = 0; x < width; x++) {
      /**
       * Multiply into texel space first, *then* mask.
       *
       * The tempting `(floorX - Math.floor(floorX)) * TEX_SIZE` costs a floor() per pixel
       * for the same answer. Masking works because TEX_SIZE is a power of two, and it
       * behaves correctly for the negative coordinates that distant rows produce once the
       * floor plane extends past the edge of the map — `|0` truncates toward zero, but the
       * mask brings the result back into range either way.
       */
      const tx = ((floorX * TEX_SIZE) | 0) & TEX_MASK;
      const ty = ((floorY * TEX_SIZE) | 0) & TEX_MASK;

      floorX += stepX;
      floorY += stepY;

      // Skip whatever the wall pass already covered. Below the horizon a wall always
      // reaches down from it, so "covered" is simply "above the wall's bottom edge".
      if (y >= bottom[x]!) {
        pixels[floorIndex] = shade(floorTex[tx * TEX_SIZE + ty]!, brightness);
      }
      if (ceilY < top[x]!) {
        pixels[ceilIndex] = shade(ceilTex[tx * TEX_SIZE + ty]!, brightness);
      }

      floorIndex++;
      ceilIndex++;
    }
  }
}

/** Flat bands of colour, for comparison with the cast version. */
function fillFlat(
  pixels: Uint32Array,
  width: number,
  height: number,
  horizon: number,
  top: Int32Array,
  bottom: Int32Array,
): void {
  for (let x = 0; x < width; x++) {
    for (let y = top[x]! - 1; y >= 0; y--) pixels[y * width + x] = FLAT_CEILING;
    for (let y = Math.max(horizon, bottom[x]!); y < height; y++) {
      pixels[y * width + x] = FLAT_FLOOR;
    }
  }
}
