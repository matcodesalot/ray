import { rgb } from '../engine/color';
import type { Framebuffer } from '../engine/framebuffer';
import type { Rect } from './minimap';
import type { RayHit } from './raycast';

/**
 * A graph of the distance each ray returned, one pixel per screen column.
 *
 * This strip is a preview of the depth buffer, and it is the reason the fisheye problem
 * can be demonstrated now rather than waiting for Stage 4. In Stage 4 this curve becomes
 * wall heights directly — the renderer draws a column of height proportional to 1/distance
 * — so the *shape* of this line is the shape of the wall you are about to see.
 *
 * Stand square-on to a flat wall and press F to switch between the two distance measures:
 *
 *   perpendicular   the line is FLAT. Every point on a flat wall is the same distance
 *                   from the camera plane, so every column gets the same height, so the
 *                   wall renders flat. Correct.
 *
 *   euclidean       the line SAGS AWAY at both edges. The corners of the wall are further
 *                   from your eye than its centre is — true, but not what a flat screen
 *                   shows. Those columns get shorter, and the wall bows away from you at
 *                   the edges. That is fisheye, and this is exactly its shape.
 *
 * The distinction is not a correction bolted on afterwards. It falls out of measuring
 * distance in units of the ray vector, which the DDA already does.
 */

const COLOR_BACKGROUND = rgb(8, 8, 12);
const COLOR_GRID = rgb(34, 36, 46);
const COLOR_FILL = rgb(28, 54, 74);
const COLOR_CURVE = rgb(120, 210, 255);
const COLOR_CURVE_EUCLID = rgb(255, 140, 90);
const COLOR_FRAME = rgb(60, 64, 78);

/**
 * Distances beyond this are clipped flat against the top of the strip.
 *
 * Set large enough that the far wall of the test level does not clip — a clipped plateau
 * looks exactly like a genuinely flat one, which would quietly ruin the comparison this
 * strip exists to make.
 */
const MAX_DIST = 24;

export function drawDepthProfile(
  fb: Framebuffer,
  hits: readonly RayHit[],
  bounds: Rect,
  useEuclidean: boolean,
): void {
  const top = bounds.y;
  const bottom = bounds.y + bounds.h;
  const plotHeight = bounds.h - 2;

  fb.fillRect(bounds.x, top, bounds.w, bounds.h, COLOR_BACKGROUND);
  fb.fillRect(bounds.x, top, bounds.w, 1, COLOR_FRAME);

  // Horizontal rules every 4 world units, so the vertical scale is readable.
  for (let d = 4; d < MAX_DIST; d += 4) {
    const y = Math.round(bottom - (d / MAX_DIST) * plotHeight);
    fb.fillRect(bounds.x, y, bounds.w, 1, COLOR_GRID);
  }

  const curveColor = useEuclidean ? COLOR_CURVE_EUCLID : COLOR_CURVE;
  const columns = Math.min(hits.length, bounds.w);

  for (let i = 0; i < columns; i++) {
    const hit = hits[i]!;
    const distance = useEuclidean ? hit.euclidDist : hit.perpDist;

    const clamped = Math.min(distance, MAX_DIST);
    const y = Math.round(bottom - (clamped / MAX_DIST) * plotHeight);
    const x = bounds.x + i;

    fb.verticalSpan(x, y, bottom, COLOR_FILL);
    fb.verticalSpan(x, y, y + 1, curveColor);
  }
}
