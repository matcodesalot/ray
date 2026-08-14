import { LIGHT_UNIT } from '../engine/color';

/**
 * Distance shading — things get darker as they get further away.
 *
 * Worth being straight about the history: **Wolfenstein 3D did not do this.** Its walls
 * were flat colours with only the light/dark side distinction from Stage 4. Light
 * diminishing arrived with Doom, which precomputed 32 brightness levels of its entire
 * 256-colour palette into "colormap" tables and picked a row per distance.
 *
 * It is included here because the improvement is dramatic and because it is the natural
 * place to meet the cost problem that shapes the rest of the renderer. Turn it off with L
 * and the depth cue collapses: without it, a corridor twenty units long and a wall two
 * units away are the same brightness, and the only thing telling you which is which is
 * the size of things you may not recognise.
 */

/** Distance, in world units, at which shading bottoms out at MIN_LIGHT. */
const LIGHT_RANGE = 16;

/**
 * How dark the furthest wall gets, as a fraction of full brightness.
 *
 * Not zero. Ceilings and floors are still flat unshaded colours until Stage 7, so walls
 * fading to pure black would vanish into a lit floor and look like holes in the world.
 * Once floors are cast and shaded by the same curve, this can go much lower.
 */
const MIN_LIGHT = 0.2;

/**
 * How many distinct brightness levels exist between full and MIN_LIGHT.
 *
 * Doom banded because it had to: with a 256-colour palette, each level cost a 256-byte
 * table, so 32 levels was a real memory decision. We are in true colour and could shade
 * continuously for free — the banding here is an aesthetic choice, not a constraint.
 *
 * Raise it to 256 and the gradient goes smooth and modern; drop it to 8 and you get harsh
 * visible steps marching toward you as you walk. 32 is close to the period look.
 */
const SHADE_LEVELS = 32;

/** Distance quantisation of the lookup table: entries per world unit. */
const ENTRIES_PER_UNIT = 8;
const TABLE_SIZE = LIGHT_RANGE * ENTRIES_PER_UNIT + 1;

/**
 * distance -> brightness, precomputed.
 *
 * Stage 7 calls this per *pixel* rather than per column, so the curve is evaluated once
 * here at startup and looked up thereafter. The table is 129 entries — small enough to
 * live in cache, which matters more than the arithmetic it saves.
 */
const TABLE = buildTable();

function buildTable(): Uint16Array {
  const table = new Uint16Array(TABLE_SIZE);

  for (let i = 0; i < TABLE_SIZE; i++) {
    const distance = i / ENTRIES_PER_UNIT;

    // How far through the lit range we are: 0 at the eye, 1 at LIGHT_RANGE and beyond.
    const t = Math.min(1, distance / LIGHT_RANGE);

    // Quantise the *distance*, not the brightness. Banding the brightness instead would
    // waste levels: the curve only spans MIN_LIGHT..1, so rounding across the full 0..1
    // range silently collapses 32 levels into 26.
    const band = Math.round(t * (SHADE_LEVELS - 1)) / (SHADE_LEVELS - 1);

    // Linear falloff from full brightness down to MIN_LIGHT.
    table[i] = Math.round((1 - band * (1 - MIN_LIGHT)) * LIGHT_UNIT);
  }

  return table;
}

/**
 * Brightness for a given distance, as a 0..256 factor for `shade()`.
 *
 * Takes perpendicular distance, the same value that sizes a wall column. Using euclidean
 * distance here would darken the edges of the screen more than the centre — a vignette
 * that moves when you turn.
 */
export function lightFactor(distance: number): number {
  const scaled = distance * ENTRIES_PER_UNIT;

  // Written as a negated `<` so that NaN — which fails every comparison — lands here too.
  // Beware the obvious version: `(Infinity * 8) | 0` is 0, so an out-of-range distance
  // would come back *fully lit* rather than dark.
  if (!(scaled < TABLE_SIZE - 1)) return TABLE[TABLE_SIZE - 1]!;

  return TABLE[scaled > 0 ? scaled | 0 : 0]!;
}
