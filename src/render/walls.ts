import { textureFor } from '../assets/textures';
import { TEX_MASK, TEX_SIZE } from '../config';
import { LIGHT_UNIT, rgb, shade } from '../engine/color';
import type { Framebuffer } from '../engine/framebuffer';
import { Tile } from '../world/tiles';
import { lightFactor } from './lighting';
import type { RayHit } from './raycast';

/**
 * The projection: turning distances into wall columns.
 *
 * Everything a raycaster draws for a wall comes out of one division. Walls are one world
 * unit tall, and the camera plane sits exactly one unit in front of the eye (Stage 3:
 * `rayDir · dir == 1`), so by similar triangles a wall at perpendicular distance `d`
 * covers `1/d` of the projection plane:
 *
 *        wall (1 unit tall)
 *          │╲
 *          │  ╲                 h / 1  =  1 / d
 *        1 │    ╲               so the projected height is 1/d,
 *          │   h ╲              scaled into pixels by VIEW_H
 *          │      ╲
 *        ──┴───────●  eye
 *          │←  d  →│
 *          └─ plane at distance 1
 *
 * Multiplying by VIEW_H chooses the pixel scale: it makes a wall exactly fill the screen
 * height when it is one unit away. So:
 *
 *     lineHeight = VIEW_H / perpDist
 *
 * That is the entire 3D projection. No matrices, no perspective divide beyond this one
 * division, no vertical component to the maths at all — which is precisely why the engine
 * was fast enough in 1992 and why it cannot do sloped floors or look up and down.
 *
 * The column is centred on the horizon because the eye sits at wall mid-height. Stage 7
 * makes that assumption explicit when it casts floors.
 */

const COLOR_CEILING = rgb(56, 56, 64);
const COLOR_FLOOR = rgb(84, 76, 68);

/**
 * How much darker a y-side face is drawn than an x-side one.
 *
 * With flat colours this single factor is doing all the work of making the image readable
 * as three dimensions. Every cube has two visible faces meeting at a corner, and without
 * a value difference between them the whole scene collapses into flat silhouettes — you
 * genuinely cannot tell where one wall ends and the next begins. Try setting it to 1.
 *
 * It is a cheap stand-in for directional light, and the original used exactly this trick.
 */
const SIDE_SHADE = Math.round(0.62 * LIGHT_UNIT);

const WALL_COLORS: Readonly<Record<number, number>> = {
  [Tile.Wall1]: rgb(168, 72, 64),
  [Tile.Wall2]: rgb(78, 122, 176),
  [Tile.Wall3]: rgb(88, 154, 94),
  [Tile.Wall4]: rgb(178, 142, 70),
  [Tile.Door]: rgb(206, 176, 78),
};

const FALLBACK = rgb(160, 160, 160);

/**
 * Draw the world: flat ceiling, flat floor, one vertical span per column.
 *
 * `useEuclidean` swaps in the straight-line distance to demonstrate fisheye. It is a
 * teaching switch, not an option — the renderer wants `perpDist`.
 */
export function drawWalls(
  fb: Framebuffer,
  hits: readonly RayHit[],
  useEuclidean = false,
  lighting = true,
  textured = true,
): void {
  const height = fb.height;
  const width = fb.width;
  const horizon = height >> 1;
  const pixels = fb.pixels;

  fb.fillRect(0, 0, width, horizon, COLOR_CEILING);
  fb.fillRect(0, horizon, width, height - horizon, COLOR_FLOOR);

  const columns = Math.min(hits.length, width);

  for (let x = 0; x < columns; x++) {
    const hit = hits[x]!;

    // Floor at a tiny positive value. Standing exactly on a wall boundary — reachable,
    // since there is no collision yet — otherwise gives a distance of 0, an infinite
    // lineHeight, and a NaN texture coordinate from Infinity * 0.
    const distance = Math.max(1e-4, useEuclidean ? hit.euclidDist : hit.perpDist);

    const lineHeight = height / distance;

    // Deliberately *not* clamped to the screen. A wall that runs off the top must still
    // sample the right part of its texture, and the only way to know which part is to
    // know where the column would have started.
    const top = Math.round(horizon - lineHeight / 2);
    const drawn = Math.max(1, Math.round(lineHeight));

    // Two independent brightness factors, combined by an integer multiply: which face of
    // the cube we are looking at, and how far away it is. Both are 0..256, so multiplying
    // and shifting back down by 8 keeps everything in integers.
    const side = hit.side === 1 ? SIDE_SHADE : LIGHT_UNIT;
    const depth = lighting ? lightFactor(hit.perpDist) : LIGHT_UNIT;
    const brightness = (side * depth) >> 8;

    if (!textured) {
      const base = WALL_COLORS[hit.tile] ?? FALLBACK;
      fb.verticalSpan(x, top, top + drawn, shade(base, brightness));
      continue;
    }

    const yStart = top < 0 ? 0 : top;
    const yEnd = top + drawn > height ? height : top + drawn;
    if (yStart >= yEnd) continue;

    const texture = textureFor(hit.tile).data;

    // Column-major storage means the whole texture column is contiguous from here.
    const texX = ((hit.wallX * TEX_SIZE) | 0) & TEX_MASK;
    const column = texX * TEX_SIZE;

    /**
     * Fixed point, 16.16: the top 16 bits are the texel row, the bottom 16 a fraction.
     *
     * Stepping a float and calling Math.floor per pixel would work, but this is the loop
     * that runs most often in the whole renderer and integer add plus shift is meaningfully
     * cheaper than float add plus truncate. It is also how the original did it, out of
     * necessity — there was no floating-point unit to rely on.
     *
     * The step is derived from `drawn`, the rounded on-screen height, rather than the exact
     * lineHeight, so the texture spans precisely the pixels actually drawn and cannot drift
     * by a texel at the bottom of tall columns.
     */
    const step = ((TEX_SIZE * 65536) / drawn) | 0;

    /**
     * Start half a step in, so each screen pixel samples the *centre* of the texture range
     * it covers rather than its leading edge — the same reasoning as the `+ 0.5` on
     * cameraX in Stage 3.
     *
     * Without it the whole texture carries a systematic half-texel bias upward, and the
     * bottom row goes unsampled on any wall under 64 pixels tall — a 40-pixel column steps
     * 0, 1, 3, … 62 and stops. Centring shifts that threshold to 32 pixels and, more to
     * the point, makes the sampling symmetric: the texel skipped at the top and the one
     * skipped at the bottom are now the same size.
     *
     * A column shorter than 32 pixels still cannot show every row — 17 screen pixels
     * cannot display 64 texels. That is ordinary point sampling, and it is where the
     * shimmer on distant walls comes from; mipmaps are the real answer and are well
     * outside what this engine does.
     */
    let texPos = (yStart - top) * step + (step >> 1);

    let index = yStart * width + x;
    for (let y = yStart; y < yEnd; y++) {
      // The mask is why TEX_SIZE must be a power of two: it wraps for free, so rounding
      // at the very bottom of a column cannot read past the end of the array.
      const texel = texture[column + ((texPos >> 16) & TEX_MASK)]!;
      texPos += step;

      pixels[index] = shade(texel, brightness);
      index += width;
    }
  }
}
