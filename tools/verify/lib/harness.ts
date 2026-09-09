/**
 * Shared scaffolding for the verification scripts.
 *
 * These are not a test framework — the project deliberately has none. They are plain
 * scripts that import the real engine modules, assert things about them, and exit non-zero
 * if anything is wrong. Everything here exists to keep the individual checks readable.
 */

import { rgb } from '../../../src/engine/color';
import { TEX_SIZE } from '../../../src/config';
import type { Texture, TextureSet } from '../../../src/assets/decode';
import { Tile } from '../../../src/world/tiles';
import { SpriteKind } from '../../../src/world/entities';

/**
 * A minimal stand-in for the browser APIs the engine touches.
 *
 * `Framebuffer` wants a canvas to lay an ImageData over. It only calls this in its
 * constructor, and nothing in the render path goes near the DOM, so a handful of stubs is
 * enough to exercise the entire renderer headlessly.
 */
export function stubDocument(): void {
  class ImageDataStub {
    width: number;
    height: number;
    data: Uint8ClampedArray;
    constructor(w: number, h: number) {
      this.width = w;
      this.height = h;
      this.data = new Uint8ClampedArray(w * h * 4);
    }
  }

  (globalThis as unknown as { document: unknown }).document = {
    createElement: () => ({
      width: 0,
      height: 0,
      getContext: () => ({
        createImageData: (w: number, h: number) => new ImageDataStub(w, h),
        putImageData: () => {},
        drawImage: () => {},
      }),
    }),
  };
}

let failures = 0;

export function check(name: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${name}` +
      (ok ? '' : `\n        got  ${JSON.stringify(actual)}\n        want ${JSON.stringify(expected)}`),
  );
}

export function near(name: string, actual: number, expected: number, epsilon = 1e-9): void {
  const ok = Math.abs(actual - expected) < epsilon;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  got ${actual} want ${expected} (+-${epsilon})`}`);
}

export function section(title: string): void {
  console.log(`\n--- ${title} ---`);
}

/** Print the tally and exit with a status the runner can act on. */
export function done(): never {
  console.log(`\n${failures === 0 ? 'all checks passed' : `${failures} FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

/** Split a packed pixel into r, g, b, a regardless of host byte order. */
export function unpack(color: number): [number, number, number, number] {
  const probe = new ArrayBuffer(4);
  new Uint32Array(probe)[0] = 0x11223344;
  const little = new Uint8Array(probe)[0] === 0x44;
  return little
    ? [color & 0xff, (color >>> 8) & 0xff, (color >>> 16) & 0xff, (color >>> 24) & 0xff]
    : [(color >>> 24) & 0xff, (color >>> 16) & 0xff, (color >>> 8) & 0xff, color & 0xff];
}

/** A texture of one flat colour. */
export function solidTexture(color: number): Texture {
  return { size: TEX_SIZE, data: new Uint32Array(TEX_SIZE * TEX_SIZE).fill(color) };
}

/**
 * A texture where every column is a distinct colour, so the texture x a pixel came from
 * can be recovered from the rendered image. The key to checking orientation.
 */
export function rulerTexture(): Texture {
  const data = new Uint32Array(TEX_SIZE * TEX_SIZE);
  for (let x = 0; x < TEX_SIZE; x++) {
    for (let y = 0; y < TEX_SIZE; y++) data[x * TEX_SIZE + y] = rgb(x * 4 + 1, y * 4 + 1, 0);
  }
  return { size: TEX_SIZE, data };
}

/** Recover the texture coordinates encoded by `rulerTexture` from a rendered pixel. */
export function readRuler(pixel: number): { tx: number; ty: number } {
  const [r, g] = unpack(pixel);
  return { tx: (r - 1) / 4, ty: (g - 1) / 4 };
}

/**
 * A complete texture set built from whatever textures you pass.
 *
 * Synthetic on purpose: these checks are about the renderer, and should not start failing
 * because somebody replaced the artwork.
 */
export function textureSet(
  fill: (label: string) => Texture,
  spriteSheets: TextureSet['spriteSheets'] = {},
): TextureSet {
  return {
    walls: {
      [Tile.Wall1]: fill('wall1'),
      [Tile.Wall2]: fill('wall2'),
      [Tile.Wall3]: fill('wall3'),
      [Tile.Wall4]: fill('wall4'),
      [Tile.Door]: fill('door'),
    },
    sprites: {
      [SpriteKind.Barrel]: fill('barrel'),
      [SpriteKind.Plant]: fill('plant'),
      [SpriteKind.Lamp]: fill('lamp'),
      [SpriteKind.Column]: fill('column'),
    },
    spriteSheets,
    doorFrame: fill('doorFrame'),
    floor: fill('floor'),
    ceiling: fill('ceiling'),
    missing: fill('missing'),
  };
}

/** The usual set: every slot a different flat colour. */
export function defaultTextures(): TextureSet {
  let hue = 0;
  return textureSet(() => {
    hue += 47;
    return solidTexture(rgb((hue * 3) % 200 + 40, (hue * 7) % 200 + 40, (hue * 11) % 200 + 40));
  });
}
