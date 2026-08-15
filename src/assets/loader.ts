import { TEXTURE_MANIFEST, TILING } from './manifest';
import { textureFromPixels, warnAboutSeams, type Texture, type TextureSet } from './decode';

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
export { wallTexture, spriteTexture } from './decode';

/**
 * Fetch, decode and convert one image.
 *
 * Failures are reported as themselves — a 404 says it is a 404, naming the file — rather
 * than being allowed to surface later as an undefined texture or a black wall.
 */
async function loadTexture(url: string): Promise<Texture> {
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

  const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const texture = textureFromPixels(image.data, image.width, image.height, label);

  const tiling = TILING[url];
  if (tiling && import.meta.env?.DEV) warnAboutSeams(texture, label, tiling);

  return texture;
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
    ...Object.entries(TEXTURE_MANIFEST.sprites).map(
      ([kind, url]) => [`sprite:${kind}`, url] as [string, string],
    ),
    ['doorFrame', TEXTURE_MANIFEST.doorFrame],
    ['floor', TEXTURE_MANIFEST.floor],
    ['ceiling', TEXTURE_MANIFEST.ceiling],
    ['missing', TEXTURE_MANIFEST.missing],
  ];

  const loaded = await Promise.all(entries.map(([, url]) => loadTexture(url)));

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

  return { walls, sprites, doorFrame, floor, ceiling, missing };
}
