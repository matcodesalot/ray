const BASE = process.env.RAY_URL ?? 'http://localhost:5173/';
import { createRequire } from 'node:module';

// Run against `npm run dev`. These exercise the parts that need a real browser:
// PNG decoding, fetch, and canvas readback.
// Resolve playwright from the project, since this script lives outside it.
const { chromium } = createRequire(import.meta.url)('playwright');

const NAMES = ['wall-1','wall-2','wall-3','wall-4','door','door-frame','floor','ceiling','barrel','plant','lamp','column','missing'];
const TILES_BOTH = new Set(['floor','ceiling']);
const TILES_X    = new Set(['wall-1','wall-2','wall-3','wall-4','door','door-frame']);
const SPRITES    = new Set(['barrel','plant','lamp','column']);

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(BASE, { waitUntil: 'domcontentloaded' });

const results = await page.evaluate(async (names) => {
  const out = {};
  for (const name of names) {
    const bmp = await createImageBitmap(await (await fetch(`/src/assets/images/${name}.png`)).blob());
    const c = document.createElement('canvas');
    c.width = bmp.width; c.height = bmp.height;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bmp, 0, 0);
    const d = ctx.getImageData(0, 0, bmp.width, bmp.height).data;
    const S = bmp.width;
    const at = (x, y) => [d[(y*S+x)*4], d[(y*S+x)*4+1], d[(y*S+x)*4+2], d[(y*S+x)*4+3]];

    let clear = 0, opaque = 0, partial = 0;
    for (let i = 3; i < d.length; i += 4) {
      if (d[i] === 0) clear++; else if (d[i] === 255) opaque++; else partial++;
    }

    // Seamlessness. Comparing the edge columns to each other is the wrong question: a
    // diagonal stripe makes them legitimately different and still tiles perfectly. The
    // property that actually matters is that the discontinuity at the wrap is no worse
    // than one the texture already contains internally -- if the join looks like any
    // other column boundary in the image, there is no visible seam.
    const meanDiff = (get) => {
      let sum = 0;
      for (let i = 0; i < S; i++) {
        const A = get(i).a, B = get(i).b;
        sum += Math.abs(A[0]-B[0]) + Math.abs(A[1]-B[1]) + Math.abs(A[2]-B[2]);
      }
      return sum / S;
    };
    const colPair = (i, j) => (k) => ({ a: at(i, k), b: at(j, k) });
    const rowPair = (i, j) => (k) => ({ a: at(k, i), b: at(k, j) });

    const seamX = meanDiff(colPair(S - 1, 0));
    const seamY = meanDiff(rowPair(S - 1, 0));
    let worstX = 0, worstY = 0;
    for (let i = 0; i < S - 1; i++) {
      worstX = Math.max(worstX, meanDiff(colPair(i, i + 1)));
      worstY = Math.max(worstY, meanDiff(rowPair(i, i + 1)));
    }

    // Lowest row that has any non-transparent pixel (sprites must reach the bottom).
    let lowest = -1;
    for (let y = S - 1; y >= 0 && lowest < 0; y--)
      for (let x = 0; x < S; x++) if (at(x, y)[3] > 0) { lowest = y; break; }

    out[name] = { w: bmp.width, h: bmp.height, clear, opaque, partial,
                  seamX: +seamX.toFixed(1), seamY: +seamY.toFixed(1),
                  worstX: +worstX.toFixed(1), worstY: +worstY.toFixed(1), lowest };
  }
  return out;
}, NAMES);

let bad = 0;
const say = (ok, msg) => { if (!ok) bad++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); };

console.log('--- all decode as 64x64 ---');
for (const n of NAMES) say(results[n].w === 64 && results[n].h === 64, `${n}: ${results[n].w}x${results[n].h}`);

console.log('\n--- tiling: wrap-around edges must match ---');
for (const n of NAMES) {
  const r = results[n];
  if (TILES_X.has(n) || TILES_BOTH.has(n))
    say(r.seamX <= r.worstX * 1.05 + 1, `${n}: wrap seam ${r.seamX} <= worst internal column step ${r.worstX}`);
  if (TILES_BOTH.has(n))
    say(r.seamY <= r.worstY * 1.05 + 1, `${n}: wrap seam ${r.seamY} <= worst internal row step ${r.worstY}`);
}

console.log('\n--- sprites: transparent margins, soft edges, feet on the bottom row ---');
for (const n of NAMES) {
  const r = results[n];
  if (!SPRITES.has(n)) continue;
  say(r.clear > 400, `${n}: has transparent margin (${r.clear} clear texels)`);
  say(r.partial > 20, `${n}: has soft edge (${r.partial} partial-alpha texels)`);
  say(r.lowest >= 62, `${n}: reaches the bottom row (lowest drawn row ${r.lowest})`);
}

console.log('\n--- surfaces: fully opaque ---');
for (const n of NAMES) {
  if (SPRITES.has(n)) continue;
  say(results[n].clear === 0 && results[n].partial === 0, `${n}: no transparency (${results[n].opaque} opaque)`);
}

console.log(`\n${bad === 0 ? 'all checks passed' : `${bad} FAILED`}`);
await browser.close();
process.exit(bad === 0 ? 0 : 1);
