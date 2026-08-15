import { stubDocument, check, section, done, unpack, solidTexture, textureSet } from '../lib/harness';

stubDocument();

import { Framebuffer } from '../../../src/engine/framebuffer';
import { rgb, rgba, shade, blend, alphaOf, TRANSPARENT } from '../../../src/engine/color';
import { SpriteRenderer } from '../../../src/render/sprites';
import { createRayHit, type RayHit } from '../../../src/render/raycast';
import { DEFAULT_RENDER_OPTIONS } from '../../../src/render/options';
import { lightFactor } from '../../../src/render/lighting';
import type { Texture } from '../../../src/assets/decode';
import { SpriteKind } from '../../../src/world/entities';
import { Player } from '../../../src/player';
import { TEX_SIZE } from '../../../src/config';

/**
 * Sprite alpha blending (Stage 12).
 *
 * Everything here uses synthetic textures. These checks are about the compositing maths,
 * and must not start failing because somebody replaced the artwork.
 */

const W = 320;
const H = 200;
const fb = new Framebuffer(W, H);
const renderer = new SpriteRenderer(4);
const opts = { ...DEFAULT_RENDER_OPTIONS };
const NO_WALLS: RayHit[] = Array.from({ length: W }, () => {
  const h = createRayHit();
  h.perpDist = 1e6;
  return h;
});

section('the 0..255 -> 0..256 alpha mapping');

const map = (a: number) => a + (a >> 7);
check('alpha 255 reaches full opacity (256)', map(255), 256);
check('alpha 0 stays 0', map(0), 0);
check('alpha 128 is about half', map(128), 129);
check('never decreases', Array.from({ length: 255 }, (_, i) => map(i + 1) >= map(i)).every(Boolean), true);
check('never exceeds 256', Array.from({ length: 256 }, (_, a) => map(a) <= 256).every(Boolean), true);

// The naive version — passing alpha straight through — stops one step short of opaque, so
// every "solid" sprite pixel would leak a 256th of the background forever.
check(
  'the naive mapping would leak background through opaque pixels',
  blend(rgb(0, 0, 0), rgb(255, 255, 255), 255) !== rgb(255, 255, 255),
  true,
);

section('the renderer composites partial alpha correctly');

/** A sprite texture in three vertical bands: clear, half-transparent, opaque. */
function bandedSprite(r: number, g: number, b: number): Texture {
  const data = new Uint32Array(TEX_SIZE * TEX_SIZE);
  for (let x = 0; x < TEX_SIZE; x++) {
    const alpha = x < TEX_SIZE / 3 ? 0 : x < (TEX_SIZE * 2) / 3 ? 128 : 255;
    for (let y = 0; y < TEX_SIZE; y++) {
      data[x * TEX_SIZE + y] = alpha === 0 ? TRANSPARENT : rgba(r, g, b, alpha);
    }
  }
  return { size: TEX_SIZE, data };
}

const SPRITE_RGB: [number, number, number] = [220, 60, 40];
const banded = bandedSprite(...SPRITE_RGB);
const textures = textureSet((label) => (label === 'barrel' ? banded : solidTexture(rgb(9, 9, 9))));

const BACKGROUND = rgb(20, 90, 160);
const player = new Player(5.5, 5.5, 1, 0);
const depth = 4;

fb.clear(BACKGROUND);
renderer.draw(fb, player, [{ x: 5.5 + depth, y: 5.5, kind: SpriteKind.Barrel }], NO_WALLS, textures, opts);

const brightness = lightFactor(depth);
const litOpaque = shade(rgba(...SPRITE_RGB, 255), brightness);
const litPartial = shade(rgba(...SPRITE_RGB, 128), brightness);
const expectedBlend = blend(BACKGROUND, litPartial, map(128));

const seen = new Set(fb.pixels);
check('exactly three colours: background, blended, opaque', seen.size, 3);
check('the background survives where alpha was 0', seen.has(BACKGROUND), true);
check('opaque texels are written straight through', seen.has(litOpaque), true);
check('partial texels equal blend(background, shaded, mapped alpha)', seen.has(expectedBlend), true);
check('every rendered pixel is opaque', [...seen].every((p) => alphaOf(p) === 255), true);

check(
  'the blend lies between background and sprite',
  (() => {
    const got = unpack(expectedBlend);
    const bg = unpack(BACKGROUND);
    const sp = unpack(litOpaque);
    const between = (v: number, a: number, c: number) =>
      v >= Math.min(a, c) - 1 && v <= Math.max(a, c) + 1;
    return [0, 1, 2].every((i) => between(got[i]!, bg[i]!, sp[i]!));
  })(),
  true,
);

section('alpha is read before shading');

// shade() forces its result opaque, so asking afterwards always answers 255 and every
// partial pixel would render solid. This is the ordering bug the code has to avoid.
const partial = rgba(200, 100, 50, 64);
check('the texel carries alpha 64', alphaOf(partial), 64);
check('but shading it reports 255', alphaOf(shade(partial, 200)), 255);
check(
  'so the two orderings genuinely differ',
  blend(BACKGROUND, shade(partial, 200), map(64)) !== shade(partial, 200),
  true,
);

section('fully opaque sprites are unchanged from Stage 10');

const opaqueOnly = textureSet((label) =>
  label === 'barrel'
    ? (() => {
        const data = new Uint32Array(TEX_SIZE * TEX_SIZE);
        for (let i = 0; i < data.length; i++) data[i] = i % 3 === 0 ? TRANSPARENT : rgb(180, 140, 90);
        return { size: TEX_SIZE, data };
      })()
    : solidTexture(rgb(9, 9, 9)),
);

fb.clear(BACKGROUND);
renderer.draw(fb, player, [{ x: 5.5 + depth, y: 5.5, kind: SpriteKind.Barrel }], NO_WALLS, opaqueOnly, opts);

const colours = new Set(fb.pixels);
check('only background and the shaded sprite colour appear', colours.size, 2);
check('and it is exactly shade(texel, brightness)', colours.has(shade(rgb(180, 140, 90), brightness)), true);

done();
