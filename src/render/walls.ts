import { rgb } from '../engine/color';
import type { Framebuffer } from '../engine/framebuffer';
import { Tile } from '../world/tiles';
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
const SIDE_SHADE = 0.62;

interface WallPalette {
  /** x-side faces: those running north-south, struck while stepping in x. */
  light: number;
  /** y-side faces, drawn darker. */
  dark: number;
}

/**
 * Colours are darkened once here at startup rather than per column at run time.
 *
 * Walls are flat-shaded per column at this stage, so there are only ever a handful of
 * distinct colours on screen. Stage 5 introduces real per-distance shading and with it
 * the question of how to do colour arithmetic cheaply; there is no reason to answer that
 * question yet.
 */
function palette(r: number, g: number, b: number): WallPalette {
  return {
    light: rgb(r, g, b),
    dark: rgb(r * SIDE_SHADE, g * SIDE_SHADE, b * SIDE_SHADE),
  };
}

const WALL_PALETTES: Readonly<Record<number, WallPalette>> = {
  [Tile.Wall1]: palette(168, 72, 64),
  [Tile.Wall2]: palette(78, 122, 176),
  [Tile.Wall3]: palette(88, 154, 94),
  [Tile.Wall4]: palette(178, 142, 70),
  [Tile.Door]: palette(206, 176, 78),
};

const FALLBACK = palette(160, 160, 160);

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
): void {
  const height = fb.height;
  const horizon = height >> 1;

  fb.fillRect(0, 0, fb.width, horizon, COLOR_CEILING);
  fb.fillRect(0, horizon, fb.width, height - horizon, COLOR_FLOOR);

  const columns = Math.min(hits.length, fb.width);

  for (let x = 0; x < columns; x++) {
    const hit = hits[x]!;
    const distance = useEuclidean ? hit.euclidDist : hit.perpDist;

    const lineHeight = height / distance;

    // Deliberately *not* clamped here. verticalSpan clips for us, and Stage 6 needs the
    // true unclipped top of the column to keep texture coordinates aligned — a wall that
    // runs off the top of the screen must still sample the right part of its texture.
    const top = Math.round(horizon - lineHeight / 2);
    const bottom = top + Math.round(lineHeight);

    const colors = WALL_PALETTES[hit.tile] ?? FALLBACK;
    fb.verticalSpan(x, top, bottom, hit.side === 1 ? colors.dark : colors.light);
  }
}
