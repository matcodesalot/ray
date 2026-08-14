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

  constructor(width: number, height: number, tiles: Uint8Array, spawn: Spawn) {
    this.width = width;
    this.height = height;
    this.tiles = tiles;
    this.spawn = spawn;
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

  /** Whether a grid cell blocks movement and stops rays. */
  isSolid(x: number, y: number): boolean {
    return isSolidTile(this.tileAt(x, y));
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
 *   ^ v < >      player spawn, facing north / south / west / east
 *   @            player spawn, facing east
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

      const tile = TILE_CHARS[char];
      if (tile === undefined) {
        throw new Error(`Unknown map character '${char}' at ${x},${y}`);
      }
      tiles[y * width + x] = tile;
    }
  }

  if (!spawn) throw new Error('Map has no spawn marker (one of @ ^ v < >)');

  const map = new GameMap(width, height, tiles, spawn);
  assertEnclosed(map);
  return map;
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
