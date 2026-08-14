/**
 * What can occupy one cell of the map grid.
 *
 * The grid is a flat Uint8Array of these values. Zero means "empty", and every non-zero
 * value is something a ray can hit — which makes the innermost test in the raycaster a
 * single truthiness check rather than a comparison against a list of solid kinds.
 *
 * We use a frozen object plus a union type rather than a TypeScript `enum` because the
 * project builds with `isolatedModules`, and because this compiles to plain numbers with
 * no runtime object lookup in the hot path.
 */
export const Tile = {
  /** Walkable empty space. */
  Floor: 0,

  /** Solid walls. The four variants exist so different faces can take different textures. */
  Wall1: 1,
  Wall2: 2,
  Wall3: 3,
  Wall4: 4,

  /**
   * A door.
   *
   * Stage 2 through 8 treat this as an ordinary solid wall with its own texture — it just
   * happens to be a wall that looks like a door. Stage 9 gives it a state machine, a
   * sliding animation and the half-cell recess that makes doors sit inside the wall line.
   */
  Door: 5,
} as const;

export type Tile = (typeof Tile)[keyof typeof Tile];

/**
 * Map from map-file characters to tiles.
 *
 * `#` is the everyday wall; the digits pick a specific variant when you want a visible
 * change of material. Spawn markers (`@ ^ v < >`) are handled separately by the parser
 * because they set the player's position rather than the cell's contents.
 */
export const TILE_CHARS: Readonly<Record<string, Tile>> = {
  '.': Tile.Floor,
  ' ': Tile.Floor,
  '#': Tile.Wall1,
  '1': Tile.Wall1,
  '2': Tile.Wall2,
  '3': Tile.Wall3,
  '4': Tile.Wall4,
  D: Tile.Door,
};

/** Spawn markers, and the direction each one faces. */
export const SPAWN_CHARS: Readonly<Record<string, { dirX: number; dirY: number }>> = {
  // Remember that y increases *downward*, as it does on the screen — so north is -y.
  '^': { dirX: 0, dirY: -1 },
  v: { dirX: 0, dirY: 1 },
  '<': { dirX: -1, dirY: 0 },
  '>': { dirX: 1, dirY: 0 },
  '@': { dirX: 1, dirY: 0 },
};

/** True for any tile a ray stops at and the player cannot walk through. */
export function isSolidTile(tile: number): boolean {
  return tile !== Tile.Floor;
}
