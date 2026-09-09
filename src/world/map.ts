import { EventBus } from '../core/events';
import { DoorAxis, DoorSystem, type Door, type DoorSpec } from './doors';
import { PushwallSystem, type Pushwall, type PushwallSpec } from './pushwalls';
import { SPRITE_CHARS, makeEntity, type SpriteEntity } from './entities';
import { SPAWN_CHARS, TILE_CHARS, Tile, isSolidTile } from './tiles';

export interface Spawn {
  /** Position in world units, at the centre of the marked cell. */
  x: number;
  y: number;
  /** Unit facing vector. */
  dirX: number;
  dirY: number;
}

/**
 * A parsed level: a grid of tiles plus where the player starts.
 *
 * The world is one unit per cell, so a world coordinate and a grid coordinate are the
 * same number — `Math.floor(x)` is the column you are standing in, and the fractional
 * part is where you are inside it. That identity is what makes the DDA in Stage 3 as
 * short as it is, and it is the reason to keep the grid unit-sized rather than, say,
 * 64 units per cell as the original engine did.
 */
export class GameMap {
  readonly width: number;
  readonly height: number;

  /** Row-major: the tile at (x, y) is `tiles[y * width + x]`. */
  readonly tiles: Uint8Array;

  readonly spawn: Spawn;

  /** Live door state. Empty for a level with no doors. */
  readonly doors: DoorSystem;

  /** Live pushwall state. Empty for a level with no secrets. */
  readonly pushwalls: PushwallSystem;

  /**
   * What the world announces as it changes: doors, secrets, footsteps.
   *
   * Owned by the map because the map owns the things that emit, and handed to the systems
   * when they are built rather than reached for later. Audio subscribes to it in `main.ts`;
   * so could a HUD, a score, or an enemy that hears you.
   */
  readonly events: EventBus;

  /**
   * Objects standing in the world. Not part of the grid, and deliberately so: a sprite has
   * a position rather than a cell, so two can share a cell and one can stand anywhere.
   */
  readonly sprites: readonly SpriteEntity[];

  constructor(
    width: number,
    height: number,
    tiles: Uint8Array,
    spawn: Spawn,
    doors: DoorSystem = new DoorSystem([], width, height),
    sprites: readonly SpriteEntity[] = [],
    pushwalls: PushwallSystem = new PushwallSystem([], width, height),
    events: EventBus = new EventBus(),
  ) {
    this.width = width;
    this.height = height;
    this.tiles = tiles;
    this.spawn = spawn;
    this.doors = doors;
    this.sprites = sprites;
    this.pushwalls = pushwalls;
    this.events = events;
  }

  /** The door in a cell, or undefined. */
  doorAt(cellX: number, cellY: number): Door | undefined {
    return this.doors.at(cellX, cellY);
  }

  /** The pushwall currently covering a cell, or undefined. */
  pushwallAt(cellX: number, cellY: number): Pushwall | undefined {
    return this.pushwalls.at(cellX, cellY);
  }

  /**
   * Push the secret wall in a cell, if there is one and it has anywhere to go.
   *
   * The direction is the caller's — it is where the *player* is pushing from, and only
   * they know that. What the map contributes is which cells are free, since that depends
   * on walls, doors and other pushwalls all at once.
   *
   * Returns false for a cell with no pushwall, so the caller can keep probing further out
   * exactly as it does for doors.
   */
  push(cellX: number, cellY: number, dirX: number, dirY: number): boolean {
    const wall = this.pushwalls.at(cellX, cellY);
    if (!wall) return false;

    return this.pushwalls.push(wall, dirX, dirY, (x, y) => !this.isSolid(x, y));
  }

  /**
   * Advance secret walls.
   *
   * Wrapped here rather than called directly because a moving pushwall rewrites the tile
   * grid as it goes, and the grid belongs to the map. `isOccupied` is the same callback
   * doors use, and does the same job: nothing slides into a cell you are standing in.
   */
  updatePushwalls(dt: number, isOccupied: (cellX: number, cellY: number) => boolean): void {
    this.pushwalls.update(dt, this.tiles, isOccupied);
  }

  /** Advance doors. Here rather than reached for through `map.doors` so both are symmetric. */
  updateDoors(dt: number, isOccupied: (cellX: number, cellY: number) => boolean): void {
    this.doors.update(dt, isOccupied);
  }

  /**
   * The tile at a grid cell. **Out of bounds counts as solid.**
   *
   * This is a load-bearing detail, not defensiveness. The ray-stepping loop in Stage 3
   * runs until it hits something solid; if the edge of the array read as empty floor, a
   * ray aimed at a gap in the wall would step forever. Making the outside of the map
   * infinitely solid means the loop always terminates, so it needs no iteration cap.
   */
  tileAt(x: number, y: number): number {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return Tile.Wall1;
    return this.tiles[y * this.width + x]!;
  }

  /**
   * Whether a grid cell blocks movement.
   *
   * A door cell stops blocking once its door is fully open, which is what lets collision,
   * unchanged since Stage 8, handle doors without knowing they exist.
   *
   * Note this is *movement* solidity, not "does a ray stop here" — a partly open door
   * blocks movement while letting rays through the gap beside it. The raycaster therefore
   * asks about tiles directly rather than going through this.
   */
  isSolid(x: number, y: number): boolean {
    const tile = this.tileAt(x, y);
    if (!isSolidTile(tile)) return false;
    if (tile === Tile.Door) return this.doors.blocksMovement(x, y);

    /**
     * A pushwall in motion is deliberately *not* solid at cell granularity.
     *
     * Its box straddles two cells, so calling both of them solid would block the player
     * from up to a whole cell of floor that is plainly empty on screen — you would stop
     * short of a wall you can see through the gap beside. Collision tests the box itself
     * instead (see `circleHitsSolid`), which is exact and agrees with what is drawn.
     *
     * At rest the box fills exactly one cell, so the cell answer and the box answer are
     * the same and this is an ordinary wall again.
     */
    if (tile === Tile.Pushwall) {
      const wall = this.pushwalls.at(x, y);
      return wall === undefined || !wall.moving;
    }

    return true;
  }
}

/**
 * Parse an ASCII level.
 *
 * The format is deliberately something you can edit in any text editor and read in a
 * diff: one character per cell, one line per row.
 *
 *   . or space   floor
 *   #            wall
 *   1 2 3 4      wall variants (different textures later)
 *   D            door (solid for now; opens in Stage 9)
 *   P            secret pushwall — looks like a wall, slides away when used
 *   ^ v < >      player spawn, facing north / south / west / east
 *   @            player spawn, facing east
 *   b g l c m    sprites: barrel, plant, lamp, column, monster (the cell stays floor)
 *
 * Parsing is strict and throws on anything malformed. A level that is subtly wrong —
 * a ragged row, a stray character, a hole in the outer wall — produces confusing
 * rendering bugs much later, and they are far harder to diagnose there than here.
 */
export function parseMap(source: string): GameMap {
  // Tolerate a leading newline so map literals can start on the line after the backtick,
  // and drop trailing blank lines.
  const rows = source.replace(/^\n/, '').replace(/\s+$/, '').split('\n');

  if (rows.length === 0 || rows[0]!.length === 0) {
    throw new Error('Map is empty');
  }

  const height = rows.length;
  const width = rows[0]!.length;
  const tiles = new Uint8Array(width * height);

  let spawn: Spawn | null = null;
  const sprites: SpriteEntity[] = [];
  const pushwalls: PushwallSpec[] = [];

  for (let y = 0; y < height; y++) {
    const row = rows[y]!;

    if (row.length !== width) {
      throw new Error(
        `Map row ${y} is ${row.length} characters, expected ${width} — rows must all be the same length`,
      );
    }

    for (let x = 0; x < width; x++) {
      const char = row[x]!;

      const facing = SPAWN_CHARS[char];
      if (facing) {
        if (spawn) throw new Error(`Map has more than one spawn marker (second at ${x},${y})`);
        // Stand in the middle of the cell, not on its corner.
        spawn = { x: x + 0.5, y: y + 0.5, dirX: facing.dirX, dirY: facing.dirY };
        tiles[y * width + x] = Tile.Floor;
        continue;
      }

      const spriteKind = SPRITE_CHARS[char];
      if (spriteKind !== undefined) {
        // The sprite stands at the centre of an ordinary floor cell. Whether it blocks
        // movement is a property of its kind, not of the grid — see SPRITE_SIZES.
        sprites.push(makeEntity(x + 0.5, y + 0.5, spriteKind));
        tiles[y * width + x] = Tile.Floor;
        continue;
      }

      const tile = TILE_CHARS[char];
      if (tile === undefined) {
        throw new Error(`Unknown map character '${char}' at ${x},${y}`);
      }
      if (tile === Tile.Pushwall) pushwalls.push({ cellX: x, cellY: y });
      tiles[y * width + x] = tile;
    }
  }

  if (!spawn) throw new Error('Map has no spawn marker (one of @ ^ v < >)');

  const doors = collectDoors(tiles, width, height);

  // One bus, handed to everything that emits on it.
  const events = new EventBus();

  const map = new GameMap(
    width,
    height,
    tiles,
    spawn,
    new DoorSystem(doors, width, height, events),
    sprites,
    new PushwallSystem(pushwalls, width, height, events),
    events,
  );
  assertEnclosed(map);
  assertPushwallsCanMove(map, pushwalls);
  return map;
}

/**
 * Work out which way each door lies, from what is holding its frame.
 *
 * A door in an east-west wall has solid cells to its east and west, so its slab spans x.
 * A door with solid cells north and south spans y. Requiring one pair or the other to be
 * solid is not fussiness: a door in open ground has no wall to slide into and no frame to
 * be recessed within, and would render as a slab floating in mid-air.
 */
function collectDoors(tiles: Uint8Array, width: number, height: number): DoorSpec[] {
  const solidAt = (x: number, y: number): boolean =>
    x < 0 || y < 0 || x >= width || y >= height || isSolidTile(tiles[y * width + x]!);

  const specs: DoorSpec[] = [];

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (tiles[y * width + x] !== Tile.Door) continue;

      const heldEastWest = solidAt(x - 1, y) && solidAt(x + 1, y);
      const heldNorthSouth = solidAt(x, y - 1) && solidAt(x, y + 1);

      if (heldEastWest === heldNorthSouth) {
        throw new Error(
          `Door at ${x},${y} needs solid cells on exactly one pair of opposite sides ` +
            `(east+west or north+south) to form its frame`,
        );
      }

      specs.push({ cellX: x, cellY: y, axis: heldEastWest ? DoorAxis.X : DoorAxis.Y });
    }
  }

  return specs;
}

/**
 * Check every pushwall has somewhere to go.
 *
 * A pushwall boxed in on all four sides is not a secret, it is a wall — and an invisible
 * mistake, because it looks exactly right until a player stands in front of it pressing
 * the use key and nothing happens. Rejected here for the same reason a door with no frame
 * is: the failure is silent, and much cheaper to catch at parse time than in play.
 */
function assertPushwallsCanMove(map: GameMap, specs: readonly PushwallSpec[]): void {
  for (const { cellX, cellY } of specs) {
    const free = PushwallSystem.hasSomewhereToGo(cellX, cellY, (x, y) => !map.isSolid(x, y));
    if (!free) {
      throw new Error(
        `Pushwall at ${cellX},${cellY} is walled in on all four sides and could never move`,
      );
    }
  }
}

/**
 * Check the level is sealed by solid tiles all the way round.
 *
 * `tileAt` already treats out-of-bounds as solid, so an unsealed map will not crash the
 * raycaster — but the player can walk out into the void and see the world from outside,
 * which looks like a rendering bug and is not one. Catching it at parse time is cheaper
 * than debugging it later.
 */
function assertEnclosed(map: GameMap): void {
  for (let x = 0; x < map.width; x++) {
    if (!map.isSolid(x, 0)) throw new Error(`Map is open at the top edge (x=${x})`);
    if (!map.isSolid(x, map.height - 1)) throw new Error(`Map is open at the bottom edge (x=${x})`);
  }
  for (let y = 0; y < map.height; y++) {
    if (!map.isSolid(0, y)) throw new Error(`Map is open at the left edge (y=${y})`);
    if (!map.isSolid(map.width - 1, y)) throw new Error(`Map is open at the right edge (y=${y})`);
  }
}
