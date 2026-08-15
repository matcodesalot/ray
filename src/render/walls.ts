import { DOOR_FRAME_TEXTURE, textureFor } from '../assets/textures';
import { TEX_MASK, TEX_SIZE } from '../config';
import { LIGHT_UNIT, blend, rgb, shade } from '../engine/color';
import type { Framebuffer } from '../engine/framebuffer';
import { Tile } from '../world/tiles';
import { lightFactor } from './lighting';
import type { RenderOptions } from './options';
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

/**
 * Where the wall ended up in each screen column, clamped to the framebuffer.
 *
 * Recorded so the floor and ceiling pass knows which pixels are already spoken for. The
 * alternative — painting the floor across the whole screen and letting walls overwrite it
 * — throws away a texture fetch and a shade for every pixel a wall covers, which in a
 * corridor is most of the screen.
 *
 * In Stage 10 this same idea returns as a proper per-column depth buffer, which sprites
 * test against to decide whether they are behind a wall.
 */
export interface WallSpans {
  /** First screen row the wall covers, per column. */
  top: Int32Array;
  /** One past the last row the wall covers, per column. */
  bottom: Int32Array;
}

export function createWallSpans(width: number): WallSpans {
  return { top: new Int32Array(width), bottom: new Int32Array(width) };
}

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
 * Soften the stair-stepped top and bottom edges of wall columns.
 *
 * Wall height is quantised to whole pixels — `Math.round(lineHeight)` — so a smoothly
 * changing silhouette comes out as runs of equal height with one-pixel steps between them.
 * Wolfenstein had exactly this, and at 320x200 upscaled to a modern window each step is
 * several screen pixels tall.
 *
 * The observation that makes this cheap: **vertical wall edges never stair-step.** A wall
 * column is exactly vertical, so the only jagged edges in the entire scene are where a
 * column meets the ceiling and the floor. That is two pixels per column — 640 a frame —
 * rather than any kind of full-screen filter.
 *
 * Each boundary pixel is blended by how much of it the wall actually covers. The wall
 * colour is sampled from the row safely inside the column and the background from the row
 * safely outside, rather than assuming what is already in the boundary pixel, which keeps
 * this independent of the rounding the wall pass happened to do.
 *
 * Runs after the floor pass, because it needs the ceiling and floor already painted.
 *
 * Off by default. The chunky look is deliberate, and this is here to be compared against.
 */
export function antialiasWallEdges(
  fb: Framebuffer,
  hits: readonly RayHit[],
  options: RenderOptions,
): void {
  const width = fb.width;
  const height = fb.height;
  const horizon = height >> 1;
  const pixels = fb.pixels;

  const columns = Math.min(hits.length, width);

  for (let x = 0; x < columns; x++) {
    const hit = hits[x]!;
    const distance = Math.max(1e-4, options.useEuclidean ? hit.euclidDist : hit.perpDist);
    const lineHeight = height / distance;

    // Below a few pixels there is no "inside" row to sample, and the column is mostly edge
    // anyway. Leave it alone rather than smearing it.
    if (lineHeight < 4) continue;

    const exactTop = horizon - lineHeight / 2;
    const exactBottom = exactTop + lineHeight;

    // Top edge: the wall covers the lower part of row floor(exactTop).
    const topRow = Math.floor(exactTop);
    if (topRow - 1 >= 0 && topRow + 1 < height) {
      const coverage = topRow + 1 - exactTop;
      const outside = pixels[(topRow - 1) * width + x]!;
      const inside = pixels[(topRow + 1) * width + x]!;
      pixels[topRow * width + x] = blend(outside, inside, (coverage * 256) | 0);
    }

    // Bottom edge: the wall covers the upper part of row floor(exactBottom).
    const bottomRow = Math.floor(exactBottom);
    if (bottomRow - 1 >= 0 && bottomRow + 1 < height) {
      const coverage = exactBottom - bottomRow;
      const outside = pixels[(bottomRow + 1) * width + x]!;
      const inside = pixels[(bottomRow - 1) * width + x]!;
      pixels[bottomRow * width + x] = blend(outside, inside, (coverage * 256) | 0);
    }
  }
}

/**
 * Draw one vertical span per column, recording what each covers.
 *
 * `useEuclidean` swaps in the straight-line distance to demonstrate fisheye. It is a
 * teaching switch, not an option — the renderer wants `perpDist`.
 */
export function drawWalls(
  fb: Framebuffer,
  hits: readonly RayHit[],
  spans: WallSpans,
  options: RenderOptions,
): void {
  const { useEuclidean, lighting, textured } = options;

  const height = fb.height;
  const width = fb.width;
  const horizon = height >> 1;
  const pixels = fb.pixels;

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

    const yStart = top < 0 ? 0 : top;
    const yEnd = top + drawn > height ? height : top + drawn;

    // Record the covered range before anything can `continue` past it, so the floor pass
    // never inherits a stale span from the previous frame.
    spans.top[x] = yStart;
    spans.bottom[x] = yEnd;

    if (yStart >= yEnd) continue;

    if (!textured) {
      const base = WALL_COLORS[hit.tile] ?? FALLBACK;
      fb.verticalSpan(x, yStart, yEnd, shade(base, brightness));
      continue;
    }

    // A face the ray reached by passing through a door cell is the inside of the doorway,
    // so it gets the frame texture rather than whatever the surrounding wall is made of.
    const texture = (hit.jamb ? DOOR_FRAME_TEXTURE : textureFor(hit.tile)).data;

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
