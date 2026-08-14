import { PLANE_LENGTH } from './config';
import type { GameMap } from './world/map';

/**
 * The camera.
 *
 * The player's orientation is stored as two vectors rather than an angle:
 *
 *   dir    unit vector, where they are facing
 *   plane  perpendicular to dir, length PLANE_LENGTH — the camera plane
 *
 * You could store a single angle and call sin/cos when needed, and plenty of raycasters
 * do. Keeping vectors is better here because the ray loop wants them directly: the ray
 * for screen column x is simply
 *
 *     rayDir = dir + plane * cameraX          where cameraX runs -1 .. +1 across the screen
 *
 * That one line is the entire projection. There is no angle arithmetic per ray, no
 * trigonometry inside the loop, and — the part that matters most — no fisheye distortion
 * to correct afterwards, because the rays land on a flat plane rather than on an arc.
 * Stage 3 works through why that is.
 *
 *          plane
 *      ◀─────┼─────▶
 *       ╲    │    ╱
 *        ╲   │dir╱          rays spread evenly along a straight plane,
 *         ╲  │  ╱           not evenly in angle
 *          ╲ │ ╱
 *           ╲│╱
 *            ●  player
 *
 * A note on the coordinate system: y increases *downward*, matching the screen and the
 * order of rows in the map file. So "north" is -y, and a positive rotation turns right.
 */
export class Player {
  x: number;
  y: number;

  dirX: number;
  dirY: number;

  planeX: number;
  planeY: number;

  constructor(x: number, y: number, dirX: number, dirY: number) {
    this.x = x;
    this.y = y;
    this.dirX = dirX;
    this.dirY = dirY;
    this.planeX = 0;
    this.planeY = 0;
    this.setDirection(dirX, dirY);
  }

  static atSpawn(map: GameMap): Player {
    const { x, y, dirX, dirY } = map.spawn;
    return new Player(x, y, dirX, dirY);
  }

  /**
   * Point the camera along a vector, normalising it and rebuilding the camera plane.
   *
   * The plane is always the right-hand perpendicular of dir. With y pointing down, that
   * perpendicular is (-dirY, dirX): facing east (1, 0) gives a plane along (0, 1), which
   * is south — and south is indeed on your right when you face east. Get this backwards
   * and the world renders mirrored, which is a surprisingly easy bug to stare past.
   */
  setDirection(dirX: number, dirY: number): void {
    const length = Math.hypot(dirX, dirY) || 1;
    this.dirX = dirX / length;
    this.dirY = dirY / length;
    this.planeX = -this.dirY * PLANE_LENGTH;
    this.planeY = this.dirX * PLANE_LENGTH;
  }

  /**
   * Turn by `radians`. Positive turns right.
   *
   * Rotating dir and then rebuilding plane from it — rather than rotating both vectors —
   * costs nothing and keeps the two exactly perpendicular forever. Rotating both would
   * accumulate floating-point error over a long session, and the symptom (a field of view
   * that very slowly drifts, or a view that develops a slight shear) is deeply confusing
   * to track down.
   */
  rotate(radians: number): void {
    const cos = Math.cos(radians);
    const sin = Math.sin(radians);
    this.setDirection(this.dirX * cos - this.dirY * sin, this.dirX * sin + this.dirY * cos);
  }

  /**
   * Move by an offset in world units.
   *
   * There is no collision here yet — you can walk through walls, and through the outer
   * wall into the void. That is deliberate: Stage 8 adds collision, and being able to fly
   * around freely first is genuinely useful for inspecting the geometry from angles the
   * level would not otherwise let you reach.
   */
  moveBy(dx: number, dy: number): void {
    this.x += dx;
    this.y += dy;
  }

  /** Move along the facing and strafe axes at once. `forward`/`strafe` are in world units. */
  move(forward: number, strafe: number): void {
    this.moveBy(
      this.dirX * forward + -this.dirY * strafe,
      this.dirY * forward + this.dirX * strafe,
    );
  }
}
