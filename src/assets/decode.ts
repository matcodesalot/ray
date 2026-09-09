import { TEX_SIZE } from '../config';
import { TRANSPARENT, rgba } from '../engine/color';

/**
 * Turning decoded image pixels into a texture.
 *
 * Deliberately separate from `loader.ts`: nothing here fetches, touches the DOM, or knows
 * which files exist. That keeps the two things most likely to be wrong -- the transpose and
 * the alpha handling -- testable against hand-built input, with no browser and no network.
 */

export interface Texture {
  readonly size: number;
  /** Column-major texels: (x, y) is at `data[x * size + y]`. */
  readonly data: Uint32Array;
}

/**
 * A sprite drawn from a sheet: cells addressed by direction and animation frame.
 *
 * `cells[row * columns + direction]`. Columns are the eight viewing directions, rows are
 * animation frames, and an animation is a contiguous run of rows.
 */
export interface SpriteSheet {
  readonly columns: number;
  readonly rows: number;
  readonly cells: readonly Texture[];
  readonly animations: Readonly<Record<string, { firstRow: number; frames: number; frameSeconds: number; loop: boolean }>>;
}

export interface TextureSet {
  readonly walls: Readonly<Record<number, Texture>>;
  readonly sprites: Readonly<Record<number, Texture>>;
  /** Sheets for kinds that animate or face; kinds drawn from a single image are absent. */
  readonly spriteSheets: Readonly<Record<number, SpriteSheet>>;
  readonly doorFrame: Texture;
  readonly floor: Texture;
  readonly ceiling: Texture;
  /** Used for any tile or sprite kind with no image of its own. */
  readonly missing: Texture;
}

/** The texture for a wall tile, falling back to the missing-texture pattern. */
export function wallTexture(set: TextureSet, tile: number): Texture {
  return set.walls[tile] ?? set.missing;
}

/** The texture for a sprite kind, falling back to the missing-texture pattern. */
export function spriteTexture(set: TextureSet, kind: number): Texture {
  return set.sprites[kind] ?? set.missing;
}

/** How long an animation runs, for whoever is advancing the clock. */
export function animationTiming(
  set: TextureSet,
  kind: number,
  animation: string,
): { frames: number; frameSeconds: number; loop: boolean } | undefined {
  return set.spriteSheets[kind]?.animations[animation];
}

/**
 * The cell to draw for an entity: the right animation frame, seen from the right side.
 *
 * `direction` is 0 for "facing the viewer" and counts round in eighths. Returns undefined
 * for kinds with no sheet, which is the signal to fall back to the single image.
 */
export function spriteCell(
  set: TextureSet,
  kind: number,
  animation: string,
  frame: number,
  direction: number,
): Texture | undefined {
  const sheet = set.spriteSheets[kind];
  if (!sheet) return undefined;

  const spec = sheet.animations[animation];
  if (!spec) return set.missing;

  const row = spec.firstRow + Math.min(frame, spec.frames - 1);
  return sheet.cells[row * sheet.columns + (direction & (sheet.columns - 1))] ?? set.missing;
}

/**
 * Convert decoded image pixels into a texture.
 *
 * Kept separate from the fetching and decoding so the part that is easy to get wrong can
 * be tested against hand-built input, with no browser and no network. `label` is only ever
 * used to name the file in error messages.
 *
 * ## The transpose
 *
 * Source pixel (x, y) is at `y * width + x`; destination is `x * size + y`. Getting this
 * backwards produces a texture that is *plausibly* wrong rather than obviously broken —
 * mirrored along the diagonal, which on a symmetric pattern like brick is nearly
 * invisible — so it is worth testing rather than eyeballing.
 *
 * ## Alpha
 *
 * | source alpha | stored |
 * | --- | --- |
 * | 0 | exactly `TRANSPARENT`, with RGB discarded |
 * | 255 | opaque texel |
 * | 1..254 | straight alpha preserved, for the renderer to blend |
 *
 * Discarding RGB under fully transparent pixels is what keeps Stage 10's fast path valid:
 * the sprite loop skips on `texel === TRANSPARENT`, a single integer comparison, and PNG
 * exporters routinely leave stale colour beneath transparent areas.
 *
 * `getImageData` returns *straight* (un-premultiplied) alpha, which is exactly what
 * `blend()` expects — there is no premultiplication to undo.
 */
export function textureFromPixels(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  label: string,
): Texture {
  if (width !== TEX_SIZE || height !== TEX_SIZE) {
    throw new Error(
      `${label}: expected a ${TEX_SIZE}x${TEX_SIZE} image, got ${width}x${height}. ` +
        `All textures share one size, set by TEX_SIZE in src/config.ts.`,
    );
  }

  return extractCell(pixels, width, 0, 0);
}

/**
 * Slice a sprite sheet into one texture per cell, row-major.
 *
 * A sheet is a grid of `TEX_SIZE` cells: columns are viewing directions, rows are animation
 * frames. Cell (column, row) ends up at `cells[row * columns + column]`, which is the order
 * the renderer indexes with.
 *
 * The sheet must divide evenly. A sheet that is a few pixels off would otherwise slice with
 * a creeping offset — every cell slightly more wrong than the last — which looks like an
 * animation that drifts rather than like a loading error, and is miserable to trace back.
 */
export function sheetFromPixels(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  label: string,
): { columns: number; rows: number; cells: Texture[] } {
  if (width % TEX_SIZE !== 0 || height % TEX_SIZE !== 0) {
    throw new Error(
      `${label}: a sprite sheet must divide evenly into ${TEX_SIZE}x${TEX_SIZE} cells, ` +
        `but it is ${width}x${height}.`,
    );
  }

  const columns = width / TEX_SIZE;
  const rows = height / TEX_SIZE;
  const cells: Texture[] = [];

  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      cells.push(extractCell(pixels, width, column * TEX_SIZE, row * TEX_SIZE));
    }
  }

  return { columns, rows, cells };
}

/**
 * Copy one `TEX_SIZE` cell out of a decoded image, transposing and normalising alpha.
 *
 * `sourceWidth` is the *image's* width, not the cell's — the row stride of the source is
 * what makes a sub-rectangle copy differ from a whole-image one, and getting that wrong is
 * how you end up slicing diagonally across a sheet.
 */
function extractCell(
  pixels: Uint8ClampedArray,
  sourceWidth: number,
  originX: number,
  originY: number,
): Texture {
  const data = new Uint32Array(TEX_SIZE * TEX_SIZE);

  for (let y = 0; y < TEX_SIZE; y++) {
    for (let x = 0; x < TEX_SIZE; x++) {
      const source = ((originY + y) * sourceWidth + (originX + x)) * 4;
      const alpha = pixels[source + 3]!;

      data[x * TEX_SIZE + y] =
        alpha === 0
          ? TRANSPARENT
          : rgba(pixels[source]!, pixels[source + 1]!, pixels[source + 2]!, alpha);
    }
  }

  return { size: TEX_SIZE, data };
}

/**
 * Warn about textures that will show a seam where they repeat.
 *
 * Comparing the two edges to each other is the wrong test — a diagonal pattern makes them
 * legitimately different and still tiles perfectly. What matters is whether the join is
 * *worse than the texture's own internal detail*: if the step across the wrap is no larger
 * than a step that already occurs between two adjacent columns, nobody will read it as a
 * seam.
 *
 * A warning rather than an error, because seamlessness is a judgement call and someone may
 * genuinely want a bordered tile. Development builds only.
 */
export function warnAboutSeams(texture: Texture, label: string, axes: 'x' | 'both'): void {
  const { size, data } = texture;

  const columnStep = (a: number, b: number): number => {
    let sum = 0;
    for (let y = 0; y < size; y++) sum += channelDistance(data[a * size + y]!, data[b * size + y]!);
    return sum / size;
  };

  const rowStep = (a: number, b: number): number => {
    let sum = 0;
    for (let x = 0; x < size; x++) sum += channelDistance(data[x * size + a]!, data[x * size + b]!);
    return sum / size;
  };

  const check = (name: string, seam: number, step: (a: number, b: number) => number): void => {
    let worst = 0;
    for (let i = 0; i < size - 1; i++) worst = Math.max(worst, step(i, i + 1));
    if (seam > worst * 1.5 + 8) {
      console.warn(
        `${label}: ${name} edges may show a seam where the texture repeats ` +
          `(step across the join ${seam.toFixed(0)}, worst step inside the texture ${worst.toFixed(0)}).`,
      );
    }
  };

  check('left/right', columnStep(size - 1, 0), columnStep);
  if (axes === 'both') check('top/bottom', rowStep(size - 1, 0), rowStep);
}

function channelDistance(a: number, b: number): number {
  return (
    Math.abs((a & 0xff) - (b & 0xff)) +
    Math.abs(((a >>> 8) & 0xff) - ((b >>> 8) & 0xff)) +
    Math.abs(((a >>> 16) & 0xff) - ((b >>> 16) & 0xff))
  );
}
