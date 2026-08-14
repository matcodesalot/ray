import { TEX_SIZE } from '../config';
import { rgb } from '../engine/color';
import { Tile } from '../world/tiles';

/**
 * Procedurally generated wall textures.
 *
 * Every texture in this project is computed at startup rather than loaded from a file.
 * That keeps the repository free of binary assets and licensing questions, and it means
 * the textures are *readable* — a brick wall is a few lines of arithmetic you can edit and
 * see the result of immediately, rather than an opaque PNG.
 *
 * ## Column-major storage
 *
 * The one genuinely important decision here. Texels are stored **column-major**: the texel
 * at (x, y) lives at `data[x * size + y]`, not the usual `data[y * size + x]`.
 *
 * This is because of how walls are drawn. A wall slice is one screen column, sampled down
 * a single texture column: texX is fixed for the whole span while texY marches from top to
 * bottom. In row-major order those texels are 64 entries apart, so every pixel touches a
 * different cache line and the CPU stalls on memory it cannot prefetch. Column-major makes
 * them adjacent, and the whole 256-byte column arrives in a handful of cache lines.
 *
 * It costs one transposed index in the generators and pays for itself in the inner loop.
 */

export interface Texture {
  readonly size: number;
  /** Column-major texels: (x, y) is at `data[x * size + y]`. */
  readonly data: Uint32Array;
}

/**
 * Deterministic value hash in the range 0..1.
 *
 * Deliberately not `Math.random()`. Textures generated from a hash are identical on every
 * run and on every machine, so a rendering artefact you notice today is still there
 * tomorrow and is not chased down as a texture-generation fluke.
 */
function hash(x: number, y: number, seed: number): number {
  let h = Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(seed, 83492791);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/**
 * Smooth, tileable value noise.
 *
 * `hash` on its own gives one independent value per texel, which reads as television
 * static. Value noise samples the hash on a coarser lattice and interpolates between the
 * corners, producing blobs of a controllable size instead.
 *
 * Two details earn their keep:
 *
 * - **Smoothstep, not linear.** Straight linear interpolation leaves a visible crease
 *   along every lattice line, because the gradient jumps there. `t²(3-2t)` has zero
 *   derivative at both ends, so neighbouring cells meet smoothly.
 *
 * - **Wrapped lattice coordinates.** The lattice index is taken modulo the period, so the
 *   right edge of the texture interpolates back toward the left. Every wall cell draws a
 *   full copy of the texture, so a texture that does not tile shows a hard vertical seam
 *   at every cell boundary along a continuous wall.
 */
function valueNoise(x: number, y: number, cell: number, seed: number): number {
  const period = TEX_SIZE / cell;
  const fx = x / cell;
  const fy = y / cell;

  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const tx = fx - x0;
  const ty = fy - y0;

  // Smoothstep the interpolation factors.
  const sx = tx * tx * (3 - 2 * tx);
  const sy = ty * ty * (3 - 2 * ty);

  const wrap = (v: number) => ((v % period) + period) % period;
  const xa = wrap(x0);
  const xb = wrap(x0 + 1);
  const ya = wrap(y0);
  const yb = wrap(y0 + 1);

  const top = hash(xa, ya, seed) * (1 - sx) + hash(xb, ya, seed) * sx;
  const bottom = hash(xa, yb, seed) * (1 - sx) + hash(xb, yb, seed) * sx;

  return top * (1 - sy) + bottom * sy;
}

/** Build a texture by evaluating `sample` at every texel. */
function generate(sample: (x: number, y: number) => number): Texture {
  const data = new Uint32Array(TEX_SIZE * TEX_SIZE);

  for (let x = 0; x < TEX_SIZE; x++) {
    const column = x * TEX_SIZE;
    for (let y = 0; y < TEX_SIZE; y++) {
      data[column + y] = sample(x, y);
    }
  }

  return { size: TEX_SIZE, data };
}

/** Clamp to a byte. Generators add and subtract freely and let this sort it out. */
function byte(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v | 0;
}

/** Tint a base colour by a multiplier and an additive offset, then pack it. */
function tint(r: number, g: number, b: number, mul: number, add = 0): number {
  return rgb(byte(r * mul + add), byte(g * mul + add), byte(b * mul + add));
}

/**
 * Brick: offset courses with mortar joints.
 *
 * The per-brick tint is keyed off the brick's grid position rather than the texel's, so a
 * whole brick shifts colour as a unit. Without that the wall looks like noise; with it, it
 * looks like masonry.
 */
function brickTexture(r: number, g: number, b: number, seed: number): Texture {
  const COURSE = 16;
  const LENGTH = 32;
  const MORTAR = 2;

  return generate((x, y) => {
    const course = (y / COURSE) | 0;
    // Alternate courses are offset by half a brick, as in a running bond.
    const shifted = x + (course % 2) * (LENGTH / 2);
    const brickX = shifted % LENGTH;
    const brickY = y % COURSE;

    if (brickY < MORTAR || brickX < MORTAR) {
      const grit = hash(x, y, seed + 9) * 22;
      return tint(r, g, b, 0.32, 26 + grit);
    }

    const index = ((shifted / LENGTH) | 0) * 31 + course * 17;
    const variation = 0.86 + hash(index, course, seed) * 0.26;

    // Slight vertical gradient within each brick, plus fine speckle.
    const relief = 1 - (brickY / COURSE) * 0.16;
    const speckle = hash(x, y, seed + 3) * 18 - 9;

    return tint(r, g, b, variation * relief, speckle);
  });
}

/**
 * Dressed stone blocks with a bevelled edge.
 *
 * The bevel is what sells it: a light edge along the top and left of each block and a dark
 * one along the bottom and right implies a light source and gives the flat surface depth.
 * It is the same trick as Stage 4's side shading, one level down.
 */
function blockTexture(r: number, g: number, b: number, seed: number): Texture {
  const BLOCK = 32;
  const JOINT = 2;
  const BEVEL = 3;

  return generate((x, y) => {
    const bx = x % BLOCK;
    const by = y % BLOCK;

    if (bx < JOINT || by < JOINT) {
      return tint(r, g, b, 0.3, hash(x, y, seed + 5) * 16);
    }

    let light = 1;
    if (bx < JOINT + BEVEL || by < JOINT + BEVEL) light = 1.22;
    else if (bx >= BLOCK - BEVEL || by >= BLOCK - BEVEL) light = 0.78;

    const block = ((x / BLOCK) | 0) * 13 + ((y / BLOCK) | 0) * 29;
    const variation = 0.92 + hash(block, block, seed) * 0.16;
    const grain = hash(x, y, seed + 1) * 20 - 10;

    return tint(r, g, b, light * variation, grain);
  });
}

/**
 * Rough, weathered stone: heavy noise plus horizontal strata and patches of growth.
 *
 * Two octaves of noise rather than one. A single octave at texel resolution reads as
 * television static; adding a coarser octave gives larger blotches for the fine grain to
 * sit on, which is what makes it look like a surface instead of interference.
 */
function roughTexture(r: number, g: number, b: number, seed: number): Texture {
  return generate((x, y) => {
    // Three octaves, each half the size and half the amplitude of the last. One octave
    // alone gives either featureless blobs or static; stacking them gives large shapes
    // with finer detail riding on top, which is what a natural surface looks like.
    const octaves =
      valueNoise(x, y, 16, seed) * 0.5 +
      valueNoise(x, y, 8, seed + 1) * 0.3 +
      valueNoise(x, y, 4, seed + 2) * 0.2;

    // Horizontal banding, so the surface reads as bedded rather than uniform.
    const strata = Math.sin(y * 0.38 + octaves * 3) * 0.05;

    const light = 0.82 + octaves * 0.34 + strata;

    // Patches of growth in the recesses, from a separate low-frequency field so they form
    // coherent areas rather than speckle.
    const patch = valueNoise(x, y, 16, seed + 5);
    const mossy = patch > 0.62 ? 0.8 : 1;

    // A little per-texel grain on top to break up the smooth interpolation.
    const grain = hash(x, y, seed + 3) * 10 - 5;

    return tint(r, g, b, light * mossy, grain);
  });
}

/**
 * Vertical planks with grain and dark gaps.
 *
 * Grain runs along the plank, so the sine varies with y and is perturbed per column —
 * getting that axis the wrong way round produces something that reads instantly as
 * corrugated metal instead of wood.
 */
function plankTexture(r: number, g: number, b: number, seed: number): Texture {
  const PLANK = 16;

  return generate((x, y) => {
    const px = x % PLANK;
    if (px === 0 || px === PLANK - 1) {
      return tint(r, g, b, 0.34, hash(x, y, seed + 4) * 10);
    }

    const plank = (x / PLANK) | 0;
    const variation = 0.88 + hash(plank, 0, seed) * 0.24;

    const grain = Math.sin(y * 0.55 + hash(x, plank, seed + 1) * 5.5) * 0.08;
    const knot = hash(x, (y / 3) | 0, seed + 6) * 0.12;

    // Subtle rounding across each plank so it does not read as flat card.
    const round = 1 - Math.abs(px / PLANK - 0.5) * 0.18;

    return tint(r, g, b, (variation + grain + knot) * round, 0);
  });
}

/**
 * A riveted metal door: a raised panel, a central seam and a viewing slot.
 *
 * Deliberately unlike any wall, because from Stage 9 a door is something you can interact
 * with and the player needs to recognise one instantly from across a room.
 */
function doorTexture(): Texture {
  const R = 176;
  const G = 150;
  const B = 92;

  return generate((x, y) => {
    const speckle = hash(x, y, 21) * 12 - 6;

    // Frame around the outside.
    const edge = Math.min(x, y, TEX_SIZE - 1 - x, TEX_SIZE - 1 - y);
    if (edge < 3) return tint(R, G, B, 0.55, speckle);
    if (edge < 5) return tint(R, G, B, 1.18, speckle);

    // Central seam where the two halves meet.
    if (x === 31 || x === 32) return tint(R, G, B, 0.42, speckle);

    // Viewing slot with bars.
    if (y >= 16 && y < 28 && x >= 12 && x < 52) {
      const bars = (x - 12) % 8 < 2;
      if (bars) return tint(R, G, B, 0.7, speckle);
      return rgb(byte(18 + speckle), byte(20 + speckle), byte(26 + speckle));
    }

    // Rivets down both sides.
    const rivetX = x < 32 ? 8 : 55;
    const dx = x - rivetX;
    const dy = ((y + 6) % 12) - 6;
    if (dx * dx + dy * dy <= 4) {
      return tint(R, G, B, dy < 0 ? 1.35 : 0.8, speckle);
    }

    // Raised lower panel.
    const panel = y > 34 && y < 58 && x > 8 && x < 55;
    const shade = panel ? 1.08 : 0.95;

    return tint(R, G, B, shade, speckle);
  });
}

/**
 * One texture per tile value.
 *
 * Colour families match the top-down view so the two representations stay recognisable as
 * the same level: wall 1 red, wall 2 blue, wall 3 green, wall 4 timber, doors brass.
 */
export const WALL_TEXTURES: Readonly<Record<number, Texture>> = {
  [Tile.Wall1]: brickTexture(168, 72, 64, 11),
  [Tile.Wall2]: blockTexture(96, 132, 178, 23),
  [Tile.Wall3]: roughTexture(88, 148, 96, 37),
  [Tile.Wall4]: plankTexture(158, 116, 62, 53),
  [Tile.Door]: doorTexture(),
};

/** Fallback for a tile with no texture registered — deliberately loud. */
export const MISSING_TEXTURE: Texture = generate((x, y) =>
  ((x >> 3) + (y >> 3)) % 2 === 0 ? rgb(255, 0, 220) : rgb(30, 30, 30),
);

export function textureFor(tile: number): Texture {
  return WALL_TEXTURES[tile] ?? MISSING_TEXTURE;
}
