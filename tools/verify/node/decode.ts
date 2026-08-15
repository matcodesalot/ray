import { stubDocument, check, near, section, done, unpack } from '../lib/harness';

stubDocument();

import { textureFromPixels, warnAboutSeams } from '../../../src/assets/decode';
import { TRANSPARENT, alphaOf, rgba, rgb, LITTLE_ENDIAN } from '../../../src/engine/color';
import { TEX_SIZE } from '../../../src/config';


/** Build row-major RGBA pixels from a per-(x,y) function, as getImageData would. */
function makePixels(fn: (x: number, y: number) => [number, number, number, number]) {
  const px = new Uint8ClampedArray(TEX_SIZE * TEX_SIZE * 4);
  for (let y = 0; y < TEX_SIZE; y++) {
    for (let x = 0; x < TEX_SIZE; x++) {
      const [r, g, b, a] = fn(x, y);
      const i = (y * TEX_SIZE + x) * 4;
      px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = a;
    }
  }
  return px;
}

section('rgba / alphaOf');
check('rgba with full alpha equals rgb', rgba(11, 22, 33, 255), rgb(11, 22, 33));
check('rgba round-trips channels', unpack(rgba(11, 22, 33, 44)), [11, 22, 33, 44]);
check('alphaOf reads it back', alphaOf(rgba(1, 2, 3, 137)), 137);
check('alphaOf of an opaque colour', alphaOf(rgb(9, 9, 9)), 255);
check('alphaOf of TRANSPARENT', alphaOf(TRANSPARENT), 0);

section('the transpose');
{
  // A deliberately asymmetric pattern: every texel encodes its own (x, y), so a
  // row/column mix-up cannot hide. R carries x, G carries y, B is a diagonal marker.
  const pixels = makePixels((x, y) => [x * 4, y * 4, x === y ? 255 : 0, 255]);
  const tex = textureFromPixels(pixels, TEX_SIZE, TEX_SIZE, 'probe.png');

  let wrong = 0;
  for (let y = 0; y < TEX_SIZE; y++) {
    for (let x = 0; x < TEX_SIZE; x++) {
      const [r, g] = unpack(tex.data[x * TEX_SIZE + y]!);
      if (r !== x * 4 || g !== y * 4) wrong++;
    }
  }
  check(`data[x * size + y] holds the pixel that was at (x, y) — all ${TEX_SIZE * TEX_SIZE} texels`, wrong, 0);

  // And the specific failure mode: a transposed read must NOT also work, or the test
  // would pass on a broken implementation of a symmetric image.
  let transposedMatches = 0;
  for (let y = 0; y < TEX_SIZE; y++) {
    for (let x = 0; x < TEX_SIZE; x++) {
      const [r, g] = unpack(tex.data[y * TEX_SIZE + x]!);
      if (r === x * 4 && g === y * 4) transposedMatches++;
    }
  }
  check('a row-major read only matches on the diagonal (the test can actually fail)', transposedMatches, TEX_SIZE);
}

section('alpha normalisation');
{
  // Transparent pixels carrying stale colour underneath, which PNG exporters emit freely.
  const pixels = makePixels((x) => {
    if (x < 10) return [200, 100, 50, 0];      // fully clear, with junk RGB
    if (x < 20) return [200, 100, 50, 255];    // fully opaque
    return [200, 100, 50, 128];                // half transparent
  });
  const tex = textureFromPixels(pixels, TEX_SIZE, TEX_SIZE, 'alpha.png');

  check('fully transparent becomes exactly TRANSPARENT, RGB discarded', tex.data[3 * TEX_SIZE + 5], TRANSPARENT);
  check('  (so the Stage 10 fast path still works)', tex.data[3 * TEX_SIZE + 5] === TRANSPARENT, true);
  check('opaque keeps its colour', unpack(tex.data[15 * TEX_SIZE + 5]!), [200, 100, 50, 255]);
  check('partial keeps straight alpha', unpack(tex.data[40 * TEX_SIZE + 5]!), [200, 100, 50, 128]);

  let clear = 0, opaque = 0, partial = 0;
  for (const t of tex.data) {
    const a = alphaOf(t);
    if (t === TRANSPARENT) clear++; else if (a === 255) opaque++; else partial++;
  }
  check('counts match the input', [clear, opaque, partial], [10 * TEX_SIZE, 10 * TEX_SIZE, 44 * TEX_SIZE]);
}
{
  // A black opaque pixel must NOT be mistaken for transparent -- the reason TRANSPARENT
  // is zero-including-alpha rather than a magic visible colour.
  const pixels = makePixels(() => [0, 0, 0, 255]);
  const tex = textureFromPixels(pixels, TEX_SIZE, TEX_SIZE, 'black.png');
  check('opaque black is not TRANSPARENT', tex.data[0] !== TRANSPARENT, true);
  check('and reads back as black', unpack(tex.data[0]!), [0, 0, 0, 255]);
}

section('size validation');
function throwsWith(fn: () => unknown): string {
  try { fn(); return ''; } catch (e) { return (e as Error).message; }
}
{
  const small = new Uint8ClampedArray(32 * 32 * 4);
  const msg = throwsWith(() => textureFromPixels(small, 32, 32, 'small.png'));
  check('a wrong-size image throws', msg.length > 0, true);
  check('and names the file', msg.includes('small.png'), true);
  check('and states what it wanted', msg.includes(`${TEX_SIZE}x${TEX_SIZE}`) && msg.includes('32x32'), true);
  check('and points at the constant to change', msg.includes('TEX_SIZE'), true);

  const oblong = new Uint8ClampedArray(64 * 32 * 4);
  check('non-square also throws', throwsWith(() => textureFromPixels(oblong, 64, 32, 'oblong.png')).length > 0, true);
}

section('seam warning');
{
  // The warning has to be able to fire, or "no warnings from the real textures" proves
  // nothing. A horizontal gradient tiles terribly: the join is a hard step from 252 to 0
  // while every internal column step is 4.
  const captured: string[] = [];
  const realWarn = console.warn;
  console.warn = (m: string) => captured.push(m);

  const gradient = textureFromPixels(makePixels((x) => [x * 4, x * 4, x * 4, 255]), TEX_SIZE, TEX_SIZE, 'gradient.png');
  warnAboutSeams(gradient, 'gradient.png', 'x');
  const gradientWarnings = captured.length;

  captured.length = 0;
  // Period-16 stripes tile perfectly: the join is an ordinary internal step.
  const striped = textureFromPixels(
    makePixels((x, y) => ((x + y) % 16 < 3 ? [200, 200, 200, 255] : [40, 40, 40, 255])),
    TEX_SIZE, TEX_SIZE, 'striped.png',
  );
  warnAboutSeams(striped, 'striped.png', 'both');
  const stripedWarnings = captured.length;

  console.warn = realWarn;
  check('a non-tiling gradient is flagged', gradientWarnings > 0, true);
  check('a seamless pattern is not flagged', stripedWarnings, 0);
}

done();
