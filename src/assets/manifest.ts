import { Animation, SpriteKind } from '../world/entities';
import { Tile } from '../world/tiles';

import barrel from './images/barrel.png?url';
import ceiling from './images/ceiling.png?url';
import column from './images/column.png?url';
import door from './images/door.png?url';
import doorFrame from './images/door-frame.png?url';
import floor from './images/floor.png?url';
import lamp from './images/lamp.png?url';
import missing from './images/missing.png?url';
import monster from './images/monster.png?url';
import plant from './images/plant.png?url';
import wall1 from './images/wall-1.png?url';
import wall2 from './images/wall-2.png?url';
import wall3 from './images/wall-3.png?url';
import wall4 from './images/wall-4.png?url';

/**
 * Which image fills each texture slot.
 *
 * The files are brought in with Vite's `?url` suffix rather than written as path strings.
 * That is the whole point of having a manifest module at all: a missing or misspelled file
 * becomes a **build failure**, named, instead of a 404 at run time or — worse — a texture
 * that silently falls back to the missing-texture checkerboard and gets shipped that way.
 * It is the same stance `parseMap` takes on malformed levels.
 *
 * To swap in your own artwork, replace the PNG in `images/` and leave this file alone. To
 * add a new wall variant, add the tile to `world/tiles.ts` and a line here.
 *
 * Every image must be exactly `TEX_SIZE` square (64x64 by default) — the loader checks and
 * refuses anything else. See `docs/stage-12-image-textures.md` for the tiling requirements,
 * which are the thing most likely to trip up real art.
 */
/** How one animation maps onto a run of sheet rows. */
export interface AnimationSpec {
  /** Sheet row the first frame sits on. */
  firstRow: number;
  frames: number;
  frameSeconds: number;
  loop: boolean;
}

/** A sprite drawn from a multi-frame, multi-direction sheet. */
export interface SpriteSheetSpec {
  url: string;
  animations: Record<string, AnimationSpec>;
}

export const TEXTURE_MANIFEST = {
  walls: {
    [Tile.Wall1]: wall1,
    [Tile.Wall2]: wall2,
    [Tile.Wall3]: wall3,
    [Tile.Wall4]: wall4,
    [Tile.Door]: door,
  },

  /**
   * Sprite artwork.
   *
   * A plain URL is a single 64x64 image, drawn the same from every angle — which is all a
   * barrel needs. A `sheet` entry is a grid: **columns are viewing directions, rows are
   * animation frames**, and the animations name contiguous runs of rows.
   *
   * Frame timings live here rather than with the entity because they describe the artwork:
   * how many frames the walk was drawn with, and how fast it reads. What the entity decides
   * is *which* animation is playing.
   */
  sprites: {
    [SpriteKind.Barrel]: barrel,
    [SpriteKind.Plant]: plant,
    [SpriteKind.Lamp]: lamp,
    [SpriteKind.Column]: column,
    [SpriteKind.Monster]: {
      url: monster,
      animations: {
        [Animation.Walk]: { firstRow: 0, frames: 4, frameSeconds: 0.16, loop: true },
        [Animation.Death]: { firstRow: 4, frames: 6, frameSeconds: 0.11, loop: false },
      },
    },
  },

  /** The inside of a doorway — the recess a door slab sits within. */
  doorFrame,

  floor,
  ceiling,

  /** Drawn for any slot with no image. Deliberately loud. */
  missing,
} as const;

/**
 * Which slots tile, and along which axes.
 *
 * Used only by the loader's development-mode seam check. Walls repeat once per cell
 * horizontally; floors and ceilings repeat across the world grid in both directions;
 * sprites and door slabs are drawn once and never tile.
 */
export const TILING: Readonly<Record<string, 'x' | 'both'>> = {
  [wall1]: 'x',
  [wall2]: 'x',
  [wall3]: 'x',
  [wall4]: 'x',
  [doorFrame]: 'x',
  [floor]: 'both',
  [ceiling]: 'both',
};
