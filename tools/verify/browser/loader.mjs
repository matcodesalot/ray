const BASE = process.env.RAY_URL ?? 'http://localhost:5173/';
import { createRequire } from 'node:module';

// Run against `npm run dev`. These exercise the parts that need a real browser:
// PNG decoding, fetch, and canvas readback.
const { chromium } = createRequire(import.meta.url)('playwright');

const browser = await chromium.launch();
const page = await browser.newPage();
const warnings = [];
page.on('console', (m) => { if (m.type() === 'warning' || m.type() === 'error') warnings.push(`${m.type()}: ${m.text()}`); });
await page.goto(BASE, { waitUntil: 'networkidle' });

const result = await page.evaluate(async () => {
  const t0 = performance.now();
  const { loadTextures, wallTexture, spriteTexture, spriteCell } = await import('/src/assets/loader.ts');
  const set = await loadTextures();
  const ms = performance.now() - t0;

  const summarise = (tex) => {
    let clear = 0, partial = 0, opaque = 0;
    for (const t of tex.data) {
      const a = t >>> 24;
      if (t === 0) clear++; else if (a === 255) opaque++; else partial++;
    }
    return { size: tex.size, len: tex.data.length, clear, partial, opaque };
  };

  return {
    ms: +ms.toFixed(0),
    wallKeys: Object.keys(set.walls).map(Number).sort((a, b) => a - b),
    spriteKeys: Object.keys(set.sprites).map(Number).sort((a, b) => a - b),
    floor: summarise(set.floor),
    ceiling: summarise(set.ceiling),
    doorFrame: summarise(set.doorFrame),
    missing: summarise(set.missing),
    barrel: summarise(set.sprites[0]),
    wall1: summarise(set.walls[1]),
    // Fallbacks for unknown ids must return the missing texture, not undefined.
    unknownWallIsMissing: wallTexture(set, 999) === set.missing,
    unknownSpriteIsMissing: spriteTexture(set, 999) === set.missing,
    knownWallIsItself: wallTexture(set, 1) === set.walls[1],
    /**
     * The sprite sheet, sliced by the loader rather than by the test (Stage 14).
     *
     * Slicing is checked exhaustively against a synthetic sheet in `node/sprites.ts`; what
     * only a browser can answer is whether the real PNG survives fetch, decode and slice —
     * and whether the animations the manifest declares actually fit inside it.
     */
    sheet: (() => {
      const sheet = set.spriteSheets[4]; // SpriteKind.Monster
      if (!sheet) return null;

      const cellsDiffer = (a, b) => {
        const x = spriteCell(set, 4, 'walk', 0, a);
        const y = spriteCell(set, 4, 'walk', 0, b);
        if (!x || !y || x === y) return false;
        for (let i = 0; i < x.data.length; i++) if (x.data[i] !== y.data[i]) return true;
        return false;
      };

      let distinct = 0;
      for (let d = 1; d < sheet.columns; d++) if (cellsDiffer(0, d)) distinct++;

      return {
        columns: sheet.columns,
        rows: sheet.rows,
        cells: sheet.cells.length,
        cellSize: sheet.cells[0].size,
        animations: Object.keys(sheet.animations).sort(),
        lastRowUsed: Math.max(...Object.values(sheet.animations).map((a) => a.firstRow + a.frames)),
        distinct,
        // Mirrored pairs must not be identical to their originals, and the flanks must
        // differ from each other — a sheet where they matched would mean the import
        // collapsed the mirroring.
        flanksDiffer: cellsDiffer(2, 6),
        emptyCells: sheet.cells.filter((c) => c.data.every((t) => t === 0)).length,
      };
    })(),

    // Column-major spot check against the raw image, decoded independently here.
    spot: await (async () => {
      const bmp = await createImageBitmap(await (await fetch('/src/assets/images/wall-1.png')).blob());
      const c = document.createElement('canvas'); c.width = 64; c.height = 64;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(bmp, 0, 0);
      const d = ctx.getImageData(0, 0, 64, 64).data;
      let mismatches = 0;
      for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) {
        const i = (y * 64 + x) * 4;
        const want = (d[i + 3] << 24 | d[i + 2] << 16 | d[i + 1] << 8 | d[i]) >>> 0;
        if (set.walls[1].data[x * 64 + y] !== want) mismatches++;
      }
      return mismatches;
    })(),
  };
});

let bad = 0;
const say = (ok, msg) => { if (!ok) bad++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); };

say(result.wallKeys.length === 5, `all 5 wall slots loaded: ${result.wallKeys}`);
say(result.spriteKeys.length === 4, `all 4 sprite slots loaded: ${result.spriteKeys}`);
for (const [name, t] of Object.entries(result).filter(([, v]) => v && v.size)) {
  say(t.size === 64 && t.len === 4096, `${name}: 64x64, ${t.len} texels`);
}
say(result.floor.clear === 0 && result.floor.partial === 0, `floor is fully opaque`);
say(result.barrel.clear > 0 && result.barrel.partial > 0, `barrel has ${result.barrel.clear} clear and ${result.barrel.partial} partial-alpha texels`);
say(result.unknownWallIsMissing, 'an unknown tile falls back to the missing texture');
say(result.unknownSpriteIsMissing, 'an unknown sprite kind falls back to the missing texture');
say(result.knownWallIsItself, 'a known tile returns its own texture');
say(result.spot === 0, `column-major layout matches an independent decode (${result.spot} mismatches of 4096)`);
const sheet = result.sheet;
say(!!sheet, 'the monster sheet loaded');
if (sheet) {
  say(sheet.columns === 8 && sheet.rows === 10, `sliced into ${sheet.columns} directions x ${sheet.rows} rows`);
  say(sheet.cells === 80 && sheet.cellSize === 64, `${sheet.cells} cells, each 64x64`);
  say(sheet.emptyCells === 0, `no empty cells (${sheet.emptyCells})`);
  say(sheet.animations.join(',') === 'death,walk', `animations declared: ${sheet.animations}`);
  say(sheet.lastRowUsed <= sheet.rows, `every declared animation fits (last row used ${sheet.lastRowUsed} of ${sheet.rows})`);
  say(sheet.distinct === 7, `all eight directions are different pictures (${sheet.distinct} of 7 differ from the front view)`);
  say(sheet.flanksDiffer, 'the two flanks are not the same cell');
}

say(warnings.length === 0, `no console warnings or errors${warnings.length ? `: ${warnings.join(' | ')}` : ' (seam check silent — placeholders tile)'}`);
console.log(`\nloaded 13 textures in ${result.ms}ms`);
console.log(bad === 0 ? 'all checks passed' : `${bad} FAILED`);
await browser.close();
process.exit(bad === 0 ? 0 : 1);
