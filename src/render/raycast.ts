import type { Player } from '../player';
import { DoorAxis, type Door } from '../world/doors';
import type { GameMap } from '../world/map';
import type { Pushwall } from '../world/pushwalls';
import { Tile, isSolidTile } from '../world/tiles';

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

  /**
   * True when this face is the inside of a doorway — the wall the door is recessed into.
   *
   * Because a door sits half a unit inside its cell, the two wall faces beside it are
   * visible edge-on as a recess. Drawing them with the surrounding wall's texture makes a
   * doorway look like a hole punched in a wall; giving them their own frame texture is
   * what makes it read as a door frame.
   */
  jamb: boolean;
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
    jamb: false,
  };
}

/**
 * Where a ray crosses a door's slab, if it does.
 *
 * This is the piece that makes doors more than a toggleable wall. A wall face lies on a
 * cell boundary, so the DDA lands on it for free. A door's slab lies **half a unit inside
 * the cell**, so once the ray has entered the cell we have to solve for the crossing
 * ourselves:
 *
 *        cell
 *     ┌────────────┐
 *     │            │        the slab is the dashed line at the cell's midpoint;
 *     ├ ─ ─ ─ ─ ─ ─┤ ← slab the DDA only ever stops at the solid edges, so the
 *     │      ↗     │        crossing has to be computed directly
 *     └──────●─────┘
 *          ray in
 *
 * Three ways a ray can fail to hit:
 *
 * - It runs parallel to the slab and never reaches the plane.
 * - It crosses the plane outside this cell — it left through a side first.
 * - It crosses within the retracted part, which is the actual opening.
 *
 * The retracted part is what `openness` measures. The slab is rigid and slides into the
 * wall, so at openness `o` it occupies the span from `o` to 1, and the material coordinate
 * at position `u` is `u - o`. Getting that wrong — scaling the texture into the remaining
 * gap instead of sliding it — gives a door that appears to squash rather than open.
 */
function hitDoorSlab(
  door: Door,
  posX: number,
  posY: number,
  rayDirX: number,
  rayDirY: number,
  out: RayHit,
): boolean {
  const { cellX, cellY, openness } = door;

  let distance: number;
  let along: number;

  if (door.axis === DoorAxis.X) {
    if (rayDirY === 0) return false;
    distance = (cellY + 0.5 - posY) / rayDirY;
    if (distance < 0) return false;

    const crossX = posX + rayDirX * distance;
    if (crossX < cellX || crossX > cellX + 1) return false;
    along = crossX - cellX;
  } else {
    if (rayDirX === 0) return false;
    distance = (cellX + 0.5 - posX) / rayDirX;
    if (distance < 0) return false;

    const crossY = posY + rayDirY * distance;
    if (crossY < cellY || crossY > cellY + 1) return false;
    along = crossY - cellY;
  }

  // Through the opening.
  if (along < openness) return false;

  out.perpDist = distance;

  /**
   * The material coordinate, mirrored when seen from the other side.
   *
   * Same rule as wall faces, and for the same reason: which way the coordinate should run
   * depends on which way the camera plane points when you are looking at the slab. Without
   * it a door reads correctly from one side and backwards from the other — invisible on a
   * symmetric texture, obvious the moment the artwork has a handle or a sign on it.
   *
   * `1 - material` stays in range: material spans 0..1-openness, so the mirrored value
   * spans openness..1.
   */
  const material = along - openness;
  const mirrored = door.axis === DoorAxis.X ? rayDirY > 0 : rayDirX < 0;
  out.wallX = mirrored ? 1 - material : material;

  // The slab of an X-axis door faces along y, which is what the renderer calls a y-side.
  out.side = door.axis === DoorAxis.X ? 1 : 0;

  return true;
}

/**
 * How far outside a cell a box hit may land and still be claimed by that cell.
 *
 * The test below runs in every cell the box touches, and a hit exactly on the shared
 * boundary belongs to both. Being generous is safe because the cells are visited in ray
 * order and the first claim wins, which is the nearer one; being strict is not, because a
 * hit that neither cell claims is a hole in a solid wall.
 */
const CLAIM_EPSILON = 1e-9;

/**
 * Where a ray crosses a moving pushwall's box, if it does.
 *
 * A door's slab is a plane at a known coordinate, so one division finds the crossing. A
 * pushwall is a **box** at a fractional offset, and a ray can enter it through any of four
 * faces, so this is the standard slab intersection: clip the ray against the x band and the
 * y band, and if what is left is a non-empty interval, the ray is inside the box over it.
 *
 *      x band          the ray is inside the box between max(nearX, nearY)
 *    ├────────┤        and min(farX, farY). An empty interval means it passed
 *    ┌────────┐        the box by, going through one band and out of the other.
 *  ──┼────────┼──  y band
 *    └────────┘
 *
 * The face struck is whichever band was entered *last* — the one whose near plane the ray
 * was still outside of. That is what makes this a two-line answer to a question that looks
 * like it needs four cases.
 *
 * `cellX, cellY` is the cell the DDA is currently in. The box straddles two cells while it
 * travels, so without checking that the crossing lies in this cell it would be drawn twice,
 * once from each of them — the nearer answer being the one the ray reaches first.
 */
function hitPushwallBox(
  wall: Pushwall,
  cellX: number,
  cellY: number,
  posX: number,
  posY: number,
  rayDirX: number,
  rayDirY: number,
  out: RayHit,
): boolean {
  const boxX = wall.cellX + wall.dirX * wall.travel;
  const boxY = wall.cellY + wall.dirY * wall.travel;

  /**
   * A ray parallel to a band is either inside it forever or outside it forever.
   *
   * Worth the branch rather than leaning on Infinity as the DDA does: here the numerator
   * can be zero at the same time as the denominator, and `0 / 0` is NaN, which loses every
   * comparison below and would silently report a miss.
   */
  let nearX = -Infinity;
  let farX = Infinity;
  if (rayDirX !== 0) {
    const a = (boxX - posX) / rayDirX;
    const b = (boxX + 1 - posX) / rayDirX;
    nearX = a < b ? a : b;
    farX = a < b ? b : a;
  } else if (posX < boxX || posX > boxX + 1) {
    return false;
  }

  let nearY = -Infinity;
  let farY = Infinity;
  if (rayDirY !== 0) {
    const a = (boxY - posY) / rayDirY;
    const b = (boxY + 1 - posY) / rayDirY;
    nearY = a < b ? a : b;
    farY = a < b ? b : a;
  } else if (posY < boxY || posY > boxY + 1) {
    return false;
  }

  const enter = nearX > nearY ? nearX : nearY;
  const exit = farX < farY ? farX : farY;

  // Missed it, it is behind us, or we are standing inside it — which has no face to draw.
  if (enter > exit || enter < 0) return false;

  const hitX = posX + rayDirX * enter;
  const hitY = posY + rayDirY * enter;

  if (
    hitX < cellX - CLAIM_EPSILON ||
    hitX > cellX + 1 + CLAIM_EPSILON ||
    hitY < cellY - CLAIM_EPSILON ||
    hitY > cellY + 1 + CLAIM_EPSILON
  ) {
    return false;
  }

  const side: 0 | 1 = nearX > nearY ? 0 : 1;
  out.perpDist = enter;
  out.side = side;

  /**
   * The texture coordinate, measured from the **box**, not from the cell.
   *
   * This is the same distinction a door makes when it slides: the material moves with the
   * wall. Measuring from the cell instead would leave the texture pinned to the world while
   * the wall slid across it, so a brick pattern would appear to flow through the stone.
   *
   * The flip is the wall rule unchanged — it has to agree with which way the camera plane
   * points when you are looking at that face, or the artwork reads mirrored.
   */
  let wallX = side === 0 ? hitY - boxY : hitX - boxX;
  if ((side === 0 && rayDirX < 0) || (side === 1 && rayDirY > 0)) wallX = 1 - wallX;
  out.wallX = wallX < 0 ? 0 : wallX > 1 ? 1 : wallX;

  return true;
}

/** Fill in the derived fields shared by wall hits and door hits. */
function finishHit(
  out: RayHit,
  posX: number,
  posY: number,
  rayDirX: number,
  rayDirY: number,
): void {
  out.hitX = posX + rayDirX * out.perpDist;
  out.hitY = posY + rayDirY * out.perpDist;
  out.euclidDist = Math.hypot(out.hitX - posX, out.hitY - posY);
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

  /** The cell we stepped out of, so a wall face can tell it is the side of a doorway. */
  let previousTile = map.tileAt(mapX, mapY);

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

    if (tile === Tile.Door) {
      const door = map.doorAt(mapX, mapY);

      if (door && hitDoorSlab(door, posX, posY, rayDirX, rayDirY, out)) {
        out.tile = tile;
        out.mapX = mapX;
        out.mapY = mapY;
        out.jamb = false;
        finishHit(out, posX, posY, rayDirX, rayDirY);
        return out;
      }

      // Missed the slab: the ray goes through the opening beside it and carries on. Until
      // Stage 15 this was the only place the DDA passed *through* a cell it entered; a
      // travelling pushwall is the other, and for the same reason — the solid part of the
      // cell is no longer the whole cell.
      previousTile = tile;
      continue;
    }

    if (tile === Tile.Pushwall) {
      const wall = map.pushwallAt(mapX, mapY);

      if (wall !== undefined && wall.moving) {
        if (hitPushwallBox(wall, mapX, mapY, posX, posY, rayDirX, rayDirY, out)) {
          out.tile = tile;
          out.mapX = mapX;
          out.mapY = mapY;
          out.jamb = false;
          finishHit(out, posX, posY, rayDirX, rayDirY);
          return out;
        }

        // The box is elsewhere in this cell: the ray goes past it through the part of the
        // cell it has vacated, exactly as it does through the opening beside a door.
        previousTile = tile;
        continue;
      }

      // At rest the box fills its cell exactly, which is an ordinary wall face and the DDA
      // has already landed on it.
      out.tile = tile;
      out.jamb = previousTile === Tile.Door;
      break;
    }

    if (isSolidTile(tile)) {
      out.tile = tile;
      out.jamb = previousTile === Tile.Door;
      break;
    }

    previousTile = tile;
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
  finishHit(out, posX, posY, rayDirX, rayDirY);

  out.mapX = mapX;
  out.mapY = mapY;
  out.side = side;

  /**
   * Where along the face we landed.
   *
   * An x-side face runs along y, so its texture coordinate is the fractional part of the
   * hit's y — and vice versa. No extra work: the DDA already computed the exact hit point.
   *
   * The flip decides which way round the texture reads on each face, and it has to agree
   * with which way the camera plane points when you are looking at that face.
   *
   * Facing east, the plane points south, so screen-right corresponds to increasing y — and
   * `frac(hitY)` therefore already rises left-to-right across the face. That one needs no
   * flip. Facing west the plane points north, screen-right is *decreasing* y, and the
   * coordinate has to be reversed. The two y-side cases work out the same way.
   *
   * Getting this backwards mirrors every wall in the level. It went unnoticed until Stage
   * 12, because procedural brick and noise are symmetric enough that a mirrored copy looks
   * identical — the moment a texture carried lettering it was unmistakable.
   */
  let wallX = side === 0 ? out.hitY : out.hitX;
  wallX -= Math.floor(wallX);
  if ((side === 0 && rayDirX < 0) || (side === 1 && rayDirY > 0)) wallX = 1 - wallX;
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
