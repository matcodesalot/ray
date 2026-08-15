import { DOOR_HOLD_TIME, DOOR_TRAVEL_TIME } from '../config';

/**
 * Sliding doors.
 *
 * Two things make doors more than "a wall that sometimes is not there", and both are
 * geometric rather than logical:
 *
 * 1. **A door sits half a unit inside its cell**, not on the cell boundary like a wall.
 *    That recess is what makes a doorway read as a doorway — you can see the thickness of
 *    the wall around it — and it means the ray has to step *into* the cell and then work
 *    out where it crosses the door plane. See `hitDoorSlab` in raycast.ts.
 *
 * 2. **A door slides sideways into the adjacent wall**, so it is a rigid slab that
 *    translates rather than a surface that shrinks. The distinction matters for the
 *    texture: as the door opens you should see less *of the same picture*, not a squashed
 *    copy of all of it.
 */

/**
 * Which way a door's slab lies, and therefore which way it slides.
 *
 * Determined from its neighbours at parse time: a door in an east-west wall has solid
 * cells to its east and west holding the frame, so its slab spans x.
 */
export const DoorAxis = {
  /** Slab spans x, sitting at y = cellY + 0.5. You walk through it moving along y. */
  X: 0,
  /** Slab spans y, sitting at x = cellX + 0.5. You walk through it moving along x. */
  Y: 1,
} as const;

export type DoorAxis = (typeof DoorAxis)[keyof typeof DoorAxis];

export const DoorState = {
  Closed: 0,
  Opening: 1,
  Open: 2,
  Closing: 3,
} as const;

export type DoorState = (typeof DoorState)[keyof typeof DoorState];

export interface Door {
  readonly cellX: number;
  readonly cellY: number;
  readonly axis: DoorAxis;

  state: DoorState;

  /**
   * How far the slab has slid, from 0 (closed) to 1 (fully retracted).
   *
   * Also the texture offset: at openness `o` the slab occupies the part of the cell from
   * `o` to 1, and the material coordinate at position `u` along the cell is `u - o`.
   */
  openness: number;

  /** Seconds left before an open door starts closing itself. */
  hold: number;
}

/** What `parseMap` hands over: which cells are doors and which way each one lies. */
export interface DoorSpec {
  cellX: number;
  cellY: number;
  axis: DoorAxis;
}

/**
 * All the doors in a level, with O(1) lookup by cell.
 *
 * Doors are sparse — a handful in a 24x24 level — but they are queried in the innermost
 * ray loop, once per cell entered per ray. So the lookup is a flat Int32Array indexed by
 * cell holding an index into the door list, rather than a Map: no hashing, no boxing, and
 * -1 for the overwhelmingly common "not a door" answer.
 */
export class DoorSystem {
  readonly doors: readonly Door[];

  private readonly width: number;
  private readonly height: number;
  private readonly byCell: Int32Array;

  constructor(specs: readonly DoorSpec[], width: number, height: number) {
    this.width = width;
    this.height = height;
    this.byCell = new Int32Array(width * height).fill(-1);

    const doors: Door[] = [];
    for (const spec of specs) {
      this.byCell[spec.cellY * width + spec.cellX] = doors.length;
      doors.push({
        cellX: spec.cellX,
        cellY: spec.cellY,
        axis: spec.axis,
        state: DoorState.Closed,
        openness: 0,
        hold: 0,
      });
    }

    this.doors = doors;
  }

  /** The door in a cell, or undefined. Out-of-bounds is safe. */
  at(cellX: number, cellY: number): Door | undefined {
    if (cellX < 0 || cellY < 0 || cellX >= this.width || cellY >= this.height) return undefined;
    const index = this.byCell[cellY * this.width + cellX]!;
    return index < 0 ? undefined : this.doors[index];
  }

  /**
   * Whether a door cell still blocks movement.
   *
   * Only a *fully* open door lets you through. Allowing passage part-way would mean
   * squeezing past a slab that visibly overlaps you, and it makes the closing case nasty:
   * a door shutting on a player who is halfway through has no good resolution.
   */
  blocksMovement(cellX: number, cellY: number): boolean {
    const door = this.at(cellX, cellY);
    if (door === undefined) return true;

    // Keyed off the state rather than `openness < 1`. The two agree everywhere except for
    // the single tick where a door has decided to close but has not yet moved: openness is
    // still exactly 1 there, so the numeric test would report the doorway passable while
    // the door is already shutting. One frame, but it is a real inconsistency and the
    // state is the thing that actually means "you may walk through this".
    return door.state !== DoorState.Open;
  }

  /**
   * Start a door opening, or reverse one that is closing.
   *
   * Returns false for a cell with no door, so the caller can keep probing further out.
   */
  activate(cellX: number, cellY: number): boolean {
    const door = this.at(cellX, cellY);
    if (!door) return false;

    if (door.state === DoorState.Open) {
      // Already open: refresh the timer rather than doing nothing, so leaning on the key
      // keeps a door you are standing in from closing.
      door.hold = DOOR_HOLD_TIME;
      return true;
    }

    door.state = DoorState.Opening;
    return true;
  }

  /**
   * Advance every door.
   *
   * `isOccupied` reports whether something is standing in a cell. A door that has finished
   * waiting will not start closing while the player is in the way, and one that is already
   * closing reverses — otherwise `blocksMovement` flips to true underneath a player who is
   * mid-doorway and traps them inside a wall.
   */
  update(dt: number, isOccupied: (cellX: number, cellY: number) => boolean): void {
    const rate = dt / DOOR_TRAVEL_TIME;

    for (const door of this.doors) {
      switch (door.state) {
        case DoorState.Opening:
          door.openness += rate;
          if (door.openness >= 1) {
            door.openness = 1;
            door.state = DoorState.Open;
            door.hold = DOOR_HOLD_TIME;
          }
          break;

        case DoorState.Open:
          door.hold -= dt;
          if (door.hold <= 0 && !isOccupied(door.cellX, door.cellY)) {
            door.state = DoorState.Closing;
          }
          break;

        case DoorState.Closing:
          if (isOccupied(door.cellX, door.cellY)) {
            // Somebody stepped into the doorway. Back off.
            door.state = DoorState.Opening;
            break;
          }
          door.openness -= rate;
          if (door.openness <= 0) {
            door.openness = 0;
            door.state = DoorState.Closed;
          }
          break;

        case DoorState.Closed:
          break;
      }
    }
  }
}
