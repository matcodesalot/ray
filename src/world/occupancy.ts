/**
 * Who is standing where, for the things that move on their own.
 *
 * Doors and pushwalls both need to ask "would I close on somebody?", and until stage 17
 * they asked it about a **cell**. That is the right question for a door, whose slab fills
 * one cell and blocks all of it. It is the wrong question for a pushwall, whose box spans
 * two cells while it travels and occupies only part of each — asking about cells means a
 * player standing in the part the box has already left reads as being in the way.
 *
 * So the question is about a rectangle in world units, and a door simply passes its cell.
 */

/** Whether anything with a body is inside an axis-aligned world-space rectangle. */
export type OccupancyTest = (minX: number, minY: number, maxX: number, maxY: number) => boolean;

/** Nothing is anywhere. The default for systems updated without a listener for this. */
export const NOBODY: OccupancyTest = () => false;

/**
 * Circle against axis-aligned box: the clamp-to-nearest-point test, again.
 *
 * The same three lines `circleHitsSolid` uses on cells and on pushwall boxes. Clamping the
 * centre into the rectangle finds the nearest point on it, and the overlap test is whether
 * that point is within the radius — which handles beside, above and diagonally-off-a-corner
 * in one expression.
 */
export function circleOverlapsBox(
  x: number,
  y: number,
  radius: number,
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
): boolean {
  const nearestX = x < minX ? minX : x > maxX ? maxX : x;
  const nearestY = y < minY ? minY : y > maxY ? maxY : y;

  const dx = x - nearestX;
  const dy = y - nearestY;

  return dx * dx + dy * dy < radius * radius;
}
