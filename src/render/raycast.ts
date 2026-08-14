import type { Player } from '../player';
import type { GameMap } from '../world/map';
import { isSolidTile } from '../world/tiles';

/**
 * Everything one ray found. Reused between frames rather than reallocated — see RayFan.
 */
export interface RayHit {
  /**
   * Distance to the wall measured **perpendicular to the camera plane**, not along the
   * ray. This is the number that becomes a wall height in Stage 4, and using the other
   * one is what produces fisheye distortion.
   */
  perpDist: number;

  /**
   * Straight-line distance from the player to the hit point.
   *
   * The renderer does not want this — it exists so the fisheye toggle can demonstrate what
   * goes wrong when you use it. It costs one hypot per ray and comes out in a later stage.
   */
  euclidDist: number;

  /** Grid cell that was hit. */
  mapX: number;
  mapY: number;

  /** Tile value of that cell. */
  tile: number;

  /**
   * Which face was struck: 0 for an x-side (a north/south-running face, hit while
   * stepping in x), 1 for a y-side. Stage 4 shades the two differently, which is most of
   * what makes untextured walls readable as 3D.
   */
  side: 0 | 1;

  /** World coordinates of the hit point, for drawing rays on the top-down view. */
  hitX: number;
  hitY: number;

  /**
   * Where along the wall face the ray struck, from 0 at one edge to 1 at the other.
   *
   * This is the texture coordinate. It is exact — a consequence of the DDA landing
   * precisely on the face rather than somewhere near it — and it is why a sampling
   * approach could never have produced a stable texture.
   *
   * Already oriented so that it always increases the same way around a cell, so opposite
   * faces do not come out mirrored. See the flip in `castRay`.
   */
  wallX: number;
}

export function createRayHit(): RayHit {
  return {
    perpDist: 0,
    euclidDist: 0,
    mapX: 0,
    mapY: 0,
    tile: 0,
    side: 0,
    hitX: 0,
    hitY: 0,
    wallX: 0,
  };
}

/**
 * Cast one ray through the grid using a DDA (digital differential analyser).
 *
 * The naive approach is to march the ray forward in small fixed steps and check the cell
 * at each one. That is both slow and wrong: too large a step and the ray tunnels through
 * thin walls or overshoots the face by an unpredictable amount; too small and you burn
 * hundreds of samples per ray. Either way the distance is only ever approximate, and you
 * cannot get an exact texture coordinate out of it.
 *
 * A DDA instead jumps straight from one grid line to the next. Because the grid is
 * regular, the distance between successive vertical crossings is a constant for a given
 * ray — so after some setup, each step is one add and one compare. The ray visits exactly
 * the cells it actually passes through, in order, and lands precisely on the wall face.
 *
 *     ┌────┬────┬────┬────┐      × = a grid crossing the DDA lands on
 *     │    │    │    │    │      each step takes whichever crossing
 *     ├────┼────×════╗────┤      is nearer: the next vertical line
 *     │    │   ╱│    ║    │      or the next horizontal one
 *     ├────┼──×─┼────╫────┤
 *     │    │ ╱  │    ║    │
 *     ├────┼×───┼────╫────┤
 *     │   ╱│    │    ║    │
 *     └──●─┴────┴────╨────┘
 *      player                    ═╗ the wall face it stops on
 *
 * `out` is written in place and returned. Ray casting happens 320 times a frame, and
 * allocating a result object each time would hand the garbage collector 19,200 objects a
 * second for no reason.
 */
export function castRay(
  map: GameMap,
  posX: number,
  posY: number,
  rayDirX: number,
  rayDirY: number,
  out: RayHit,
): RayHit {
  // Which cell we start in. Because one cell is one world unit, this is just a floor.
  let mapX = Math.floor(posX);
  let mapY = Math.floor(posY);

  /**
   * How far the ray travels, in ray lengths, to cross one full cell horizontally
   * (deltaDistX) or vertically (deltaDistY).
   *
   * A ray aimed nearly straight up crosses vertical grid lines very rarely, so deltaDistX
   * is huge; aimed exactly up, never, and the value is Infinity. That is not a bug to
   * guard against — Infinity compares and adds correctly, so an axis-aligned ray simply
   * never wins the "which crossing is nearer" test and the loop only ever steps the other
   * way. Dividing by zero being *useful* is a rare pleasure.
   */
  const deltaDistX = Math.abs(1 / rayDirX);
  const deltaDistY = Math.abs(1 / rayDirY);

  // Which way we step, and the distance to the *first* crossing in each axis. That first
  // one is a partial cell — however far we happen to stand from the cell boundary.
  let stepX: number;
  let stepY: number;
  let sideDistX: number;
  let sideDistY: number;

  if (rayDirX < 0) {
    stepX = -1;
    sideDistX = (posX - mapX) * deltaDistX;
  } else {
    stepX = 1;
    sideDistX = (mapX + 1 - posX) * deltaDistX;
  }

  if (rayDirY < 0) {
    stepY = -1;
    sideDistY = (posY - mapY) * deltaDistY;
  } else {
    stepY = 1;
    sideDistY = (mapY + 1 - posY) * deltaDistY;
  }

  // 0 * Infinity is NaN, which happens if the ray is exactly axis-aligned *and* we are
  // standing exactly on a grid line. NaN loses every comparison, so that axis would win
  // the step test forever. Infinity is the answer that was meant.
  if (Number.isNaN(sideDistX)) sideDistX = Infinity;
  if (Number.isNaN(sideDistY)) sideDistY = Infinity;

  let side: 0 | 1 = 0;

  // Step to the nearer grid crossing until we enter a solid cell. This needs no iteration
  // cap: GameMap.tileAt reports everything outside the map as solid, so a ray that escapes
  // through a gap still terminates at the edge of the array.
  for (;;) {
    if (sideDistX < sideDistY) {
      sideDistX += deltaDistX;
      mapX += stepX;
      side = 0;
    } else {
      sideDistY += deltaDistY;
      mapY += stepY;
      side = 1;
    }

    const tile = map.tileAt(mapX, mapY);
    if (isSolidTile(tile)) {
      out.tile = tile;
      break;
    }
  }

  /**
   * The loop adds delta *before* testing, so on exit sideDist holds the distance to the
   * crossing *after* the wall. Subtracting one delta backs up to the face we actually hit.
   *
   * And this value is already perpendicular. That is not an accident or a correction: the
   * distances are all measured in units of `rayDir`, and rayDir is `dir + plane * cameraX`
   * — a vector whose component along `dir` is exactly 1 for every column. So "distance in
   * ray lengths" and "distance along the viewing axis" are the same number. The fisheye
   * correction other approaches need is built into the choice of units.
   */
  out.perpDist = side === 0 ? sideDistX - deltaDistX : sideDistY - deltaDistY;

  // Since distances are in ray lengths, stepping the ray by perpDist lands on the wall.
  out.hitX = posX + rayDirX * out.perpDist;
  out.hitY = posY + rayDirY * out.perpDist;

  out.euclidDist = Math.hypot(out.hitX - posX, out.hitY - posY);
  out.mapX = mapX;
  out.mapY = mapY;
  out.side = side;

  /**
   * Where along the face we landed.
   *
   * An x-side face runs along y, so its texture coordinate is the fractional part of the
   * hit's y — and vice versa. No extra work: the DDA already computed the exact hit point.
   *
   * The flip matters. Left to itself the coordinate runs in whichever direction the world
   * axis happens to point, so the two faces on opposite sides of a block come out mirrored
   * from each other. Harmless on a symmetric brick pattern, glaring on anything with
   * writing or a recognisable motif — and it makes adjacent cells disagree at their seam.
   * Reversing the coordinate on the two faces the ray meets from behind lines them all up.
   */
  let wallX = side === 0 ? out.hitY : out.hitX;
  wallX -= Math.floor(wallX);
  if ((side === 0 && rayDirX > 0) || (side === 1 && rayDirY < 0)) wallX = 1 - wallX;
  out.wallX = wallX;

  return out;
}

/**
 * One ray per screen column, cast as a batch.
 *
 * Owns its results so nothing allocates per frame. `hits[x]` is the wall in front of
 * screen column x, which from Stage 4 is all the renderer needs to draw that column.
 */
export class RayFan {
  readonly hits: RayHit[];

  constructor(count: number) {
    this.hits = Array.from({ length: count }, createRayHit);
  }

  get count(): number {
    return this.hits.length;
  }

  cast(map: GameMap, player: Player): void {
    const count = this.hits.length;

    for (let x = 0; x < count; x++) {
      /**
       * Where this column sits on the camera plane: -1 at the left edge, +1 at the right.
       *
       * The +0.5 samples the *centre* of the pixel rather than its left edge. It removes a
       * half-pixel bias in the image, and it has a pleasant side effect: cameraX is never
       * exactly 0, so a ray can never be exactly parallel to an axis while the player
       * faces along one — sidestepping the whole degenerate case.
       */
      const cameraX = (2 * (x + 0.5)) / count - 1;

      castRay(
        map,
        player.x,
        player.y,
        player.dirX + player.planeX * cameraX,
        player.dirY + player.planeY * cameraX,
        this.hits[x]!,
      );
    }
  }
}
