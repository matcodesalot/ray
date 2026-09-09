import { PUSHWALL_CELLS, PUSHWALL_TRAVEL_TIME } from '../config';
import { SILENT_BUS, WorldEvent, type EventBus } from '../core/events';
import { Tile } from './tiles';

/**
 * Secret pushwalls.
 *
 * A door is a thin slab at a fixed plane inside a fixed cell. A pushwall is a **whole cell
 * that moves**, and that difference is what makes this the last genuine gap in the
 * renderer: for the first time the world contains a solid surface that is not on a grid
 * line. Everything before it — walls, doorways, even a door slab — sits at a coordinate the
 * DDA lands on for free.
 *
 * While it travels it is an axis-aligned unit box at a fractional offset, straddling two
 * cells:
 *
 *        cell A          cell B
 *     ┌───────────┬───────────┐
 *     │     ╔═════╪═════╗     │     the box has left A and not yet filled B;
 *     │     ║     │     ║     │     rays entering either cell have to be tested
 *     │     ╚═════╪═════╝     │     against the box rather than the cell
 *     └───────────┴───────────┘
 *            travel = 0.5 →
 *
 * ## The tile grid stays authoritative
 *
 * As the box moves, the cells it covers are written into the tile grid as `Tile.Pushwall`
 * and the cells it has left are written back to `Tile.Floor`. The continuous state lives
 * here; the grid records *which cells to ask about*.
 *
 * That is worth doing rather than consulting a side table, because the DDA reads the tile
 * of every cell it enters anyway. A separate occupancy lookup would add an array read to
 * the innermost loop of the renderer to answer "no" several hundred thousand times a second
 * — for a feature that is idle in almost every frame of almost every level. Marking the
 * grid means the cost of pushwalls is zero until a ray actually enters one. It is also what
 * the original engine did.
 */
export interface Pushwall {
  /** Where it started. Its texture and identity stay with this cell. */
  readonly cellX: number;
  readonly cellY: number;

  /** Direction of travel: exactly one of these is ±1. Both zero until it is first pushed. */
  dirX: number;
  dirY: number;

  /** How far it has travelled from the origin, in cells. */
  travel: number;

  /** How far this push will carry it. Zero before it is pushed. */
  distance: number;

  /** True while it is actually sliding. False at rest, whether it has moved or not. */
  moving: boolean;
}

/** What `parseMap` hands over: which cells hold a pushwall. */
export interface PushwallSpec {
  cellX: number;
  cellY: number;
}

/** The west/east/north/south unit vectors, in the order a level is probed for somewhere to go. */
const DIRECTIONS: readonly (readonly [number, number])[] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

/**
 * Every pushwall in a level.
 *
 * Sparse — one or two in a level, and often none — but queried from the ray loop, so the
 * lookup is a flat `Int32Array` of indices exactly like `DoorSystem`.
 */
export class PushwallSystem {
  readonly walls: readonly Pushwall[];

  private readonly width: number;
  private readonly height: number;
  private readonly byCell: Int32Array;

  /**
   * The cells each pushwall currently claims, two slots apiece, -1 for unused.
   *
   * Two is the most a unit box travelling along one axis can ever cover, and remembering
   * them is what keeps releasing the old cells O(1) instead of a scan of the whole grid
   * every tick a secret is opening.
   */
  private readonly claimed: Int32Array;

  /** Where to announce a secret opening. See `DoorSystem` for why it defaults to silence. */
  private readonly events: EventBus;

  constructor(
    specs: readonly PushwallSpec[],
    width: number,
    height: number,
    events: EventBus = SILENT_BUS,
  ) {
    this.width = width;
    this.height = height;
    this.events = events;
    this.byCell = new Int32Array(width * height).fill(-1);
    this.claimed = new Int32Array(specs.length * 2).fill(-1);

    const walls: Pushwall[] = [];
    for (const spec of specs) {
      this.byCell[spec.cellY * width + spec.cellX] = walls.length;
      this.claimed[walls.length * 2] = spec.cellY * width + spec.cellX;
      walls.push({
        cellX: spec.cellX,
        cellY: spec.cellY,
        dirX: 0,
        dirY: 0,
        travel: 0,
        distance: 0,
        moving: false,
      });
    }

    this.walls = walls;
  }

  /** Whether this level has any pushwalls at all, so callers can skip the work entirely. */
  get any(): boolean {
    return this.walls.length > 0;
  }

  /** The pushwall currently covering a cell, or undefined. Out-of-bounds is safe. */
  at(cellX: number, cellY: number): Pushwall | undefined {
    if (cellX < 0 || cellY < 0 || cellX >= this.width || cellY >= this.height) return undefined;
    const index = this.byCell[cellY * this.width + cellX]!;
    return index < 0 ? undefined : this.walls[index];
  }

  /** The west edge of a pushwall's box, in world units. */
  static boxX(wall: Pushwall): number {
    return wall.cellX + wall.dirX * wall.travel;
  }

  /** The north edge of a pushwall's box, in world units. */
  static boxY(wall: Pushwall): number {
    return wall.cellY + wall.dirY * wall.travel;
  }

  /**
   * Start a push, if there is anywhere to go.
   *
   * `dirX, dirY` is the direction to push in, and `isFree` reports whether a cell is empty
   * — which is the caller's business, because it is the map that knows about walls, doors
   * and the other pushwalls.
   *
   * It travels up to `PUSHWALL_CELLS` and stops early against anything solid, rather than
   * refusing a push with only one cell behind it. A secret that silently does nothing is
   * indistinguishable from a wall, which is a miserable thing to debug in a level.
   */
  push(
    wall: Pushwall,
    dirX: number,
    dirY: number,
    isFree: (cellX: number, cellY: number) => boolean,
  ): boolean {
    if (wall.moving || wall.distance > 0) return false; // already pushed, or in flight

    let free = 0;
    while (free < PUSHWALL_CELLS) {
      const nextX = wall.cellX + dirX * (free + 1);
      const nextY = wall.cellY + dirY * (free + 1);
      if (!isFree(nextX, nextY)) break;
      free++;
    }

    if (free === 0) return false;

    wall.dirX = dirX;
    wall.dirY = dirY;
    wall.distance = free;
    wall.moving = true;

    this.events.emit(WorldEvent.PushwallStart, wall.cellX + 0.5, wall.cellY + 0.5);
    return true;
  }

  /** Whether any direction has room, used by the parser to reject a pushwall that is walled in. */
  static hasSomewhereToGo(
    cellX: number,
    cellY: number,
    isFree: (x: number, y: number) => boolean,
  ): boolean {
    return DIRECTIONS.some(([dx, dy]) => isFree(cellX + dx, cellY + dy));
  }

  /**
   * Advance every moving pushwall, and keep the tile grid in step.
   *
   * `isOccupied` reports whether something is standing in a cell — the same callback doors
   * use to avoid closing on the player, and used here for the same reason. A pushwall that
   * is about to cover a cell you are standing in **holds** instead.
   *
   * Holding rather than reversing is a deliberate difference from doors. Reversing returns
   * a door to the state you asked for, which is helpful; reversing a pushwall would undo a
   * secret you deliberately triggered, and leaning against it would shuffle it back and
   * forth. Waiting preserves the intent and cannot loop.
   */
  update(
    dt: number,
    tiles: Uint8Array,
    isOccupied: (cellX: number, cellY: number) => boolean,
  ): void {
    if (!this.any) return;

    const rate = dt / PUSHWALL_TRAVEL_TIME;

    for (let index = 0; index < this.walls.length; index++) {
      const wall = this.walls[index]!;
      if (!wall.moving) continue;

      const next = Math.min(wall.travel + rate, wall.distance);
      if (this.wouldCoverSomething(wall, next, isOccupied)) continue;

      wall.travel = next;

      if (wall.travel >= wall.distance) {
        wall.moving = false;
        this.events.emit(
          WorldEvent.PushwallStop,
          PushwallSystem.boxX(wall) + 0.5,
          PushwallSystem.boxY(wall) + 0.5,
        );
      }

      this.remark(index, wall, tiles);
    }
  }

  /** Whether the box at a given travel would overlap a cell something is standing in. */
  private wouldCoverSomething(
    wall: Pushwall,
    travel: number,
    isOccupied: (cellX: number, cellY: number) => boolean,
  ): boolean {
    const x = wall.cellX + wall.dirX * travel;
    const y = wall.cellY + wall.dirY * travel;

    const firstX = Math.floor(x);
    const firstY = Math.floor(y);
    const lastX = Math.ceil(x + 1) - 1;
    const lastY = Math.ceil(y + 1) - 1;

    for (let cellY = firstY; cellY <= lastY; cellY++) {
      for (let cellX = firstX; cellX <= lastX; cellX++) {
        if (isOccupied(cellX, cellY)) return true;
      }
    }

    return false;
  }

  /**
   * Rewrite the tile grid for the cells this pushwall covers now.
   *
   * Release first, then claim: a box that has moved a fraction of a cell still covers the
   * cell it is leaving, and claiming before releasing would clear a mark it had just made.
   *
   * The tile written back is always `Tile.Floor`, which is a real assumption worth naming:
   * a pushwall only ever travels over cells that were empty when the push started, because
   * `push` counted them that way. Nothing else can have moved into them meanwhile — there
   * is nothing else in this engine that writes to the grid.
   */
  private remark(index: number, wall: Pushwall, tiles: Uint8Array): void {
    const slot = index * 2;

    for (let i = 0; i < 2; i++) {
      const cell = this.claimed[slot + i]!;
      if (cell < 0) continue;
      this.byCell[cell] = -1;
      tiles[cell] = Tile.Floor;
      this.claimed[slot + i] = -1;
    }

    const x = PushwallSystem.boxX(wall);
    const y = PushwallSystem.boxY(wall);

    const firstX = Math.floor(x);
    const firstY = Math.floor(y);
    const lastX = Math.ceil(x + 1) - 1;
    const lastY = Math.ceil(y + 1) - 1;

    let next = slot;
    for (let cellY = firstY; cellY <= lastY; cellY++) {
      for (let cellX = firstX; cellX <= lastX; cellX++) {
        if (cellX < 0 || cellY < 0 || cellX >= this.width || cellY >= this.height) continue;

        const cell = cellY * this.width + cellX;
        this.byCell[cell] = index;
        tiles[cell] = Tile.Pushwall;
        if (next < slot + 2) this.claimed[next++] = cell;
      }
    }
  }
}
