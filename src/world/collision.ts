import { SPRITE_SIZES, type SpriteEntity } from './entities';
import type { GameMap } from './map';
import { PushwallSystem } from './pushwalls';

/**
 * Passed where an entity would be, to mean "no entity blocks this move" — only the grid.
 *
 * Used for two different things, which is why it is a value rather than a second parameter:
 * asking whether a position is inside a *wall* specifically, and moving a body that is
 * already overlapping an entity.
 */
export const NO_ENTITIES = 'none';

/** An entity a move does not collide with, or `NO_ENTITIES` for all of them. */
export type Exempt = SpriteEntity | typeof NO_ENTITIES | undefined;

/**
 * Collision against the tile grid.
 *
 * The player is a circle, not a point and not a box. A point would let you slip through the
 * diagonal seam where two walls meet at a corner; a box catches on corners as you turn,
 * because a rotating square sweeps a larger area than the square itself.
 *
 * A circle in a grid world is the easy case. Every solid thing is an axis-aligned unit
 * square, and circle-versus-rectangle has a two-line exact answer, so there is no need for
 * anything general-purpose here.
 *
 * ## Entities (Stage 13)
 *
 * Stage 8 said this file never learns that anything but the grid exists. That stopped being
 * true when sprites started blocking movement: both tests below now also sweep the entity
 * list. It is a small addition and it costs nothing structurally, because a circle-versus-
 * circle contact normal is *radial* — exactly the shape the corner case already produces,
 * so the resolver needed no changes at all.
 *
 * The sweep is linear over every sprite in the level. At the couple of dozen a level holds,
 * and only on the ticks that actually touch something, that is far cheaper than the spatial
 * index it would take to avoid. Bucketing entities by cell is the fix if that ever changes.
 */

/**
 * Does a circle at (x, y) overlap any solid tile?
 *
 * Only the cells the circle's bounding box touches are examined — at most four for any
 * sane radius. For each, the nearest point on that cell's square is clamped out of the
 * circle's centre, and the test is whether that point falls inside the circle:
 *
 *      ┌─────────┐
 *      │  cell   │        nearest point on the cell to the centre
 *      │        ●┼───     is (clamp(x, cx, cx+1), clamp(y, cy, cy+1))
 *      └─────────┘  ╲
 *                    ○ centre        overlap  ⟺  |centre - nearest| < radius
 *
 * The clamp handles all three cases at once — the centre being beside the cell, above it,
 * or diagonally off one of its corners — which is why this is the version worth knowing.
 */
export function circleHitsSolid(
  map: GameMap,
  x: number,
  y: number,
  radius: number,
  ignore?: Exempt,
): boolean {
  const minCellX = Math.floor(x - radius);
  const maxCellX = Math.floor(x + radius);
  const minCellY = Math.floor(y - radius);
  const maxCellY = Math.floor(y + radius);

  const radiusSquared = radius * radius;

  for (let cellY = minCellY; cellY <= maxCellY; cellY++) {
    for (let cellX = minCellX; cellX <= maxCellX; cellX++) {
      if (!map.isSolid(cellX, cellY)) continue;

      const nearestX = x < cellX ? cellX : x > cellX + 1 ? cellX + 1 : x;
      const nearestY = y < cellY ? cellY : y > cellY + 1 ? cellY + 1 : y;

      const dx = x - nearestX;
      const dy = y - nearestY;
      if (dx * dx + dy * dy < radiusSquared) return true;
    }
  }

  /**
   * Pushwalls in motion, tested as boxes rather than as cells.
   *
   * The cell loop above deliberately does not report them: a travelling pushwall straddles
   * two cells, and calling both solid would stop you a whole cell short of a wall you can
   * see. `GameMap.isSolid` explains the split. The clamp is the same one the cell loop
   * uses — a unit box is a unit box, wherever its corner happens to be.
   *
   * They are geometry, not entities, so `NO_ENTITIES` does not exempt them. Nothing ever
   * gets to walk through a wall.
   */
  const pushwalls = map.pushwalls;
  if (pushwalls.any) {
    for (const wall of pushwalls.walls) {
      if (!wall.moving) continue;

      const boxX = PushwallSystem.boxX(wall);
      const boxY = PushwallSystem.boxY(wall);

      const nearestX = x < boxX ? boxX : x > boxX + 1 ? boxX + 1 : x;
      const nearestY = y < boxY ? boxY : y > boxY + 1 ? boxY + 1 : y;

      const dx = x - nearestX;
      const dy = y - nearestY;
      if (dx * dx + dy * dy < radiusSquared) return true;
    }
  }

  // Blocking entities. Circle against circle: they overlap when the centres are closer
  // than the sum of the radii, which needs no square root to decide.
  if (ignore === NO_ENTITIES) return false;

  const sprites = map.sprites;
  for (let i = 0; i < sprites.length; i++) {
    const sprite = sprites[i]!;
    if (sprite === ignore) continue;
    const blocking = SPRITE_SIZES[sprite.kind].blocking;
    if (blocking <= 0) continue;

    const dx = x - sprite.x;
    const dy = y - sprite.y;
    const reach = radius + blocking;
    if (dx * dx + dy * dy < reach * reach) return true;
  }

  return false;
}

/**
 * How many times to halve the interval when finding the contact point.
 *
 * Ten iterations narrow a step to a thousandth of its length. At walking speed that is
 * under a ten-thousandth of a cell — far below anything visible — and it costs ten circle
 * tests only on the ticks where you are actually touching a wall.
 */
const BISECTION_STEPS = 10;

/**
 * The largest fraction of a step that keeps the circle clear, by bisection.
 *
 * Rejecting a blocked step outright would be simpler, but then you stop up to a full step
 * short of the wall — about a tenth of a cell at running speed — and it feels spongy,
 * because how close you can get depends on how fast you were going.
 *
 * The exact contact point *is* solvable in closed form here, but it needs separate cases
 * for hitting a face and clipping a corner. Bisection needs no cases, works against
 * whatever `circleHitsSolid` considers solid, and at ten iterations a tick is free.
 */
function maxClearFraction(
  map: GameMap,
  x: number,
  y: number,
  dx: number,
  dy: number,
  radius: number,
  ignore: Exempt,
): number {
  let clear = 0;
  let blocked = 1;

  for (let i = 0; i < BISECTION_STEPS; i++) {
    const mid = (clear + blocked) / 2;
    if (circleHitsSolid(map, x + dx * mid, y + dy * mid, radius, ignore)) blocked = mid;
    else clear = mid;
  }

  return clear;
}

/** A mutable position. Passed in and updated so that moving allocates nothing. */
export interface Position {
  x: number;
  y: number;
}

/**
 * The direction that pushes the circle out of the surface **currently opposing a given
 * motion**, as a unit vector.
 *
 * Against a flat face this comes out axis-aligned, `(±1, 0)` or `(0, ±1)`. Against a cell
 * *corner* it is the radial direction from that corner.
 *
 * ## Why the motion is a parameter
 *
 * Standing in an inside corner puts the body in contact with two walls at once, at exactly
 * equal depth. Simply taking the deepest contact therefore picks whichever the cell scan
 * happens to reach first — and if that is the wall you are moving *away* from, the caller
 * concludes there is nothing to slide along and refuses to move you at all. The symptom is
 * being welded into a corner: some directions work, their mirror images do not, and which
 * is which depends on nothing more principled than loop order.
 *
 * Considering only surfaces the motion actually pushes into makes the choice meaningful.
 * The wall you are leaving is not opposing you and has no business affecting the result.
 */
function opposingContactNormal(
  map: GameMap,
  x: number,
  y: number,
  radius: number,
  motionX: number,
  motionY: number,
  out: Position,
  ignore: Exempt,
): boolean {
  const minCellX = Math.floor(x - radius);
  const maxCellX = Math.floor(x + radius);
  const minCellY = Math.floor(y - radius);
  const maxCellY = Math.floor(y + radius);

  const radiusSquared = radius * radius;

  let bestSquared = Infinity;
  let bestX = 0;
  let bestY = 0;

  for (let cellY = minCellY; cellY <= maxCellY; cellY++) {
    for (let cellX = minCellX; cellX <= maxCellX; cellX++) {
      if (!map.isSolid(cellX, cellY)) continue;

      const nearestX = x < cellX ? cellX : x > cellX + 1 ? cellX + 1 : x;
      const nearestY = y < cellY ? cellY : y > cellY + 1 ? cellY + 1 : y;

      const dx = x - nearestX;
      const dy = y - nearestY;
      const squared = dx * dx + dy * dy;

      if (squared >= radiusSquared) continue;

      // Skip surfaces the motion is travelling away from or along. Testing the sign with
      // the un-normalised vector is fine: normalising only scales by a positive length.
      if (motionX * dx + motionY * dy >= 0) continue;

      if (squared < bestSquared) {
        bestSquared = squared;
        bestX = dx;
        bestY = dy;
      }
    }
  }

  // Moving pushwalls, in the same representation and with the same motion filter as cells.
  const pushwalls = map.pushwalls;
  if (pushwalls.any) {
    for (const wall of pushwalls.walls) {
      if (!wall.moving) continue;

      const boxX = PushwallSystem.boxX(wall);
      const boxY = PushwallSystem.boxY(wall);

      const nearestX = x < boxX ? boxX : x > boxX + 1 ? boxX + 1 : x;
      const nearestY = y < boxY ? boxY : y > boxY + 1 ? boxY + 1 : y;

      const dx = x - nearestX;
      const dy = y - nearestY;
      const squared = dx * dx + dy * dy;

      if (squared >= radiusSquared) continue;
      if (motionX * dx + motionY * dy >= 0) continue;

      if (squared < bestSquared) {
        bestSquared = squared;
        bestX = dx;
        bestY = dy;
      }
    }
  }

  /**
   * Blocking entities, in the same representation the cell loop uses: a vector pointing
   * from the surface out to the centre, whose *length* is the distance to that surface.
   * Keeping that form is what lets the normalisation below stay shared.
   *
   * `gap` is floored at a hair above zero so that a body which has somehow ended up inside
   * an entity still yields a direction to escape along. Left at zero the vector would
   * collapse and the caller would be told there is nothing to slide against — the
   * welded-into-a-corner failure from Stage 8, in a new costume.
   */
  const sprites = ignore === NO_ENTITIES ? EMPTY : map.sprites;
  for (let i = 0; i < sprites.length; i++) {
    const sprite = sprites[i]!;
    if (sprite === ignore) continue;
    const blocking = SPRITE_SIZES[sprite.kind].blocking;
    if (blocking <= 0) continue;

    const dx = x - sprite.x;
    const dy = y - sprite.y;

    const distance = Math.hypot(dx, dy);
    if (distance < 1e-9) continue; // exactly concentric: no direction to push along

    const gap = distance - blocking;
    if (gap >= radius) continue; // not touching

    // Travelling away from it, or along it: not what is stopping us.
    if (motionX * dx + motionY * dy >= 0) continue;

    const depth = gap > 1e-6 ? gap : 1e-6;
    const squared = depth * depth;
    if (squared < bestSquared) {
      bestSquared = squared;
      const scale = depth / distance;
      bestX = dx * scale;
      bestY = dy * scale;
    }
  }

  if (bestSquared === Infinity) return false;

  const length = Math.sqrt(bestSquared);

  // The centre sitting exactly on a cell's surface gives no direction to push along.
  // Rare — the caller only ever asks about positions reached from a clear one — and
  // reporting no normal just means the slide stops here, which is safe.
  if (length < 1e-9) return false;

  out.x = bestX / length;
  out.y = bestY / length;
  return true;
}

/**
 * How many times a single move may be redirected by a surface.
 *
 * One is enough for a flat wall. Two covers sliding along one surface into a second, which
 * is what an inside corner is. Three is slack for awkward geometry; beyond that the motion
 * left is negligible and stopping costs nothing visible.
 */
const MAX_SLIDES = 3;

/** Reused between calls so that moving allocates nothing. */
const normal: Position = { x: 0, y: 0 };

/** Stands in for the entity list when nothing is meant to block. */
const EMPTY: readonly SpriteEntity[] = [];

/**
 * How far past the radius to look when asking what we are resting against.
 *
 * Bisection deliberately stops a hair *clear* of the surface, so probing at exactly the
 * radius would report nothing in contact at all. This must comfortably exceed the
 * bisection residual (a step divided by 2^10, so under 1e-4 at any sane speed) while
 * staying far below anything visible.
 */
const CONTACT_PROBE = 1e-3;

/**
 * Advance as far as possible, then redirect the leftover motion along the surface hit.
 *
 * The textbook approach for a grid is to resolve one axis at a time: try the x move, then
 * try the y move from wherever x ended up. It is simple, it produces sliding along flat
 * walls, and it is what most tile-based games do.
 *
 * **It fails at corners**, and visibly. Axis separation can only ever move you along x or
 * y, but the tangent at a cell corner is diagonal. Press into a corner at 40° and both
 * axis moves are individually blocked, so you stop dead — even though 54% of your speed is
 * tangential and you should be sliding smoothly around it. Measured on the real level
 * before this was fixed: every approach between roughly 40° and 55° froze solid.
 *
 * Projecting onto the contact normal handles both cases with one rule. Remove the
 * component of motion going *into* the surface and keep the rest:
 *
 *     slide = motion − normal × (motion · normal)
 *
 *              motion
 *                ↘
 *          ────────●────────  surface, normal ↑
 *                  →  slide      the part heading into the surface is discarded,
 *                                the part along it survives at full speed
 *
 * On a flat face the normal is axis-aligned and this reduces to *exactly* axis separation —
 * the good behaviour is unchanged. At a corner the normal is radial and you slide around
 * it, which axis separation simply cannot express.
 *
 * `ignore` exists because entities move too. An entity's own blocking circle is in the same
 * list everything else tests against, so without excluding itself it would be permanently
 * jammed inside its own collision shape and never move at all.
 *
 * A push aimed *exactly* at a corner is the one case with genuinely nothing to slide
 * along: the motion is entirely radial and the tangential part really is zero. It is an
 * unstable equilibrium though, and rounding breaks the tie long before you would notice,
 * so in practice you always slide off one side rather than sticking.
 */
export function slideMove(
  map: GameMap,
  position: Position,
  dx: number,
  dy: number,
  radius: number,
  ignore?: Exempt,
): void {
  /**
   * If we are somehow already inside a **wall**, let the move happen unchecked.
   *
   * Otherwise every direction is blocked and the body is stuck forever with no way out.
   * Reachable if a level places a spawn too close to a wall, or if someone raises
   * PLAYER_RADIUS at run time — and being able to walk out beats being trapped.
   */
  if (circleHitsSolid(map, position.x, position.y, radius, NO_ENTITIES)) {
    position.x += dx;
    position.y += dy;
    return;
  }

  /**
   * Being inside an *entity* is a different matter, and the distinction is load-bearing.
   *
   * Until Stage 14 nothing could get inside you: entities stood still, so an overlap meant
   * a badly authored level and the escape above covered it. Now a monster walks over to
   * where you are standing, and the overlap is routine — every couple of seconds, not once
   * a level. Escaping by disabling collision entirely meant that standing next to a monster
   * and a wall let you walk straight **through the wall** and out of the world.
   *
   * So entities stop blocking until you are clear of them, and the grid never stops. You
   * can always walk out of something that walked into you, and you can never leave the
   * level to do it.
   */
  const blockers = circleHitsSolid(map, position.x, position.y, radius, ignore)
    ? NO_ENTITIES
    : ignore;

  /**
   * Split long steps so the circle cannot jump clean over a wall.
   *
   * Not currently reachable: the fastest tick moves 5.4/60 = 0.09 units against a radius of
   * 0.28 and a minimum wall thickness of 1. But tunnelling is exactly the bug that appears
   * later, when someone adds a sprint power-up or a lower tick rate, and by then the cause
   * is not obvious. Two lines now.
   */
  const distance = Math.hypot(dx, dy);
  const steps = distance > radius ? Math.ceil(distance / radius) : 1;
  const stepX = dx / steps;
  const stepY = dy / steps;

  for (let i = 0; i < steps; i++) {
    resolveStep(map, position, stepX, stepY, radius, blockers);
  }
}

/** One substep: move, and redirect along any surface met, up to MAX_SLIDES times. */
function resolveStep(
  map: GameMap,
  position: Position,
  dx: number,
  dy: number,
  radius: number,
  ignore: Exempt,
): void {
  for (let slide = 0; slide < MAX_SLIDES; slide++) {
    if (dx === 0 && dy === 0) return;

    // Nothing in the way: take the whole move.
    if (!circleHitsSolid(map, position.x + dx, position.y + dy, radius, ignore)) {
      position.x += dx;
      position.y += dy;
      return;
    }

    // Blocked somewhere along the way. Advance to the contact point.
    const clear = maxClearFraction(map, position.x, position.y, dx, dy, radius, ignore);
    position.x += dx * clear;
    position.y += dy * clear;

    // Whatever motion is left over, measured from the contact point.
    const remainingX = dx * (1 - clear);
    const remainingY = dy * (1 - clear);

    /**
     * Ask what we are resting against **here**, at the contact point — not at the target
     * we could not reach.
     *
     * This distinction is the entire fix. A corner's normal turns as you move around it,
     * so the normal sampled at the (deeper, unreachable) target points differently from
     * the one at the contact. Project against that and the "tangential" direction still
     * curves very slightly into the corner: it collides, bisection returns ~0, and the
     * player sits there apparently stuck while the maths insists it is sliding.
     */
    const blocked = opposingContactNormal(
      map,
      position.x,
      position.y,
      radius + CONTACT_PROBE,
      remainingX,
      remainingY,
      normal,
      ignore,
    );

    // Nothing here opposes the remaining motion, so there is nothing to slide along.
    if (!blocked) return;

    // By construction this is negative, so the projection always removes speed.
    const into = remainingX * normal.x + remainingY * normal.y;

    dx = remainingX - normal.x * into;
    dy = remainingY - normal.y * into;

    // In a corner the projected motion may now press into the *other* wall. That is what
    // the surrounding loop is for: it re-tests, finds the second surface, and projects
    // again, which is why MAX_SLIDES needs to be more than one.
  }
}
