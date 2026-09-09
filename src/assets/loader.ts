import { TEXTURE_MANIFEST, TILING } from './manifest';
import {
  sheetFromPixels,
  textureFromPixels,
  warnAboutSeams,
  type SpriteSheet,
  type Texture,
  type TextureSet,
} from './decode';

/**
 * Loading textures from image files.
 *
 * Up to Stage 11 every texture was arithmetic evaluated at module load, which meant the
 * engine had no asynchronous code anywhere. Images cannot work that way -- decoding is
 * inherently async -- so this is the project's first and only await, and it all happens
 * once, before the first frame. The render path stays exactly as synchronous as it was.
 *
 * The pixel conversion itself lives in `decode.ts`; this module is the part that talks to
 * the network and the DOM.
 */

export type { Texture, TextureSet } from './decode';
export { wallTexture, spriteTexture, spriteCell } from './decode';
export type { SpriteSheet } from './decode';

/**
 * Fetch, decode and convert one image.
 *
 * Failures are reported as themselves — a 404 says it is a 404, naming the file — rather
 * than being allowed to surface later as an undefined texture or a black wall.
 */
async function decodeImage(url: string): Promise<{ label: string; image: ImageData }> {
  const label = url.split('/').pop() ?? url;

  let bitmap: ImageBitmap;
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    bitmap = await createImageBitmap(await response.blob());
  } catch (cause) {
    throw new Error(`${label}: could not load (${(cause as Error).message})`, { cause });
  }

  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;

  // willReadFrequently is a hint that this canvas exists to be read back rather than
  // composited, which keeps the browser from putting it on the GPU only to copy it back.
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error(`${label}: could not acquire a 2D context to decode into`);

  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();

  return { label, image: ctx.getImageData(0, 0, canvas.width, canvas.height) };
}

/** Fetch, decode and convert one single-image texture. */
async function loadTexture(url: string): Promise<Texture> {
  const { label, image } = await decodeImage(url);
  const texture = textureFromPixels(image.data, image.width, image.height, label);

  const tiling = TILING[url];
  if (tiling && import.meta.env?.DEV) warnAboutSeams(texture, label, tiling);

  return texture;
}

/** Fetch, decode and slice one sprite sheet. */
async function loadSheet(spec: { url: string; animations: SpriteSheet['animations'] }): Promise<SpriteSheet> {
  const { label, image } = await decodeImage(spec.url);
  const { columns, rows, cells } = sheetFromPixels(image.data, image.width, image.height, label);

  for (const [name, animation] of Object.entries(spec.animations)) {
    const last = animation.firstRow + animation.frames - 1;
    if (last >= rows) {
      throw new Error(
        `${label}: animation '${name}' runs to row ${last}, but the sheet has only ${rows}. ` +
          `Rows are animation frames and columns are directions.`,
      );
    }
  }

  return { columns, rows, cells, animations: spec.animations };
}

/**
 * Load every texture named by the manifest.
 *
 * All of them at once: they are independent, and doing them in sequence would turn a dozen
 * round trips into a dozen sequential ones for no reason.
 */
export async function loadTextures(): Promise<TextureSet> {
  const entries: [string, string][] = [
    ...Object.entries(TEXTURE_MANIFEST.walls).map(
      ([tile, url]) => [`wall:${tile}`, url] as [string, string],
    ),
    ...Object.entries(TEXTURE_MANIFEST.sprites)
      .filter(([, art]) => typeof art === 'string')
      .map(([kind, art]) => [`sprite:${kind}`, art as string] as [string, string]),
    ['doorFrame', TEXTURE_MANIFEST.doorFrame],
    ['floor', TEXTURE_MANIFEST.floor],
    ['ceiling', TEXTURE_MANIFEST.ceiling],
    ['missing', TEXTURE_MANIFEST.missing],
  ];

  const sheetEntries = Object.entries(TEXTURE_MANIFEST.sprites).filter(
    ([, art]) => typeof art !== 'string',
  ) as [string, { url: string; animations: SpriteSheet['animations'] }][];

  const [loaded, loadedSheets] = await Promise.all([
    Promise.all(entries.map(([, url]) => loadTexture(url))),
    Promise.all(sheetEntries.map(([, spec]) => loadSheet(spec))),
  ]);

  const walls: Record<number, Texture> = {};
  const sprites: Record<number, Texture> = {};
  let doorFrame!: Texture;
  let floor!: Texture;
  let ceiling!: Texture;
  let missing!: Texture;

  entries.forEach(([key], index) => {
    const texture = loaded[index]!;
    if (key.startsWith('wall:')) walls[Number(key.slice(5))] = texture;
    else if (key.startsWith('sprite:')) sprites[Number(key.slice(7))] = texture;
    else if (key === 'doorFrame') doorFrame = texture;
    else if (key === 'floor') floor = texture;
    else if (key === 'ceiling') ceiling = texture;
    else missing = texture;
  });

  const spriteSheets: Record<number, SpriteSheet> = {};
  sheetEntries.forEach(([kind], index) => {
    spriteSheets[Number(kind)] = loadedSheets[index]!;
  });

  return { walls, sprites, spriteSheets, doorFrame, floor, ceiling, missing };
}
