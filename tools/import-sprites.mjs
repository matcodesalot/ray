/**
 * Normalise a third-party sprite sheet into the uniform grid this engine draws from.
 *
 *     node tools/import-sprites.mjs <source.png> <out.png> --rows=0:dir,1:dir,8:seq
 *
 * Sheets found in the wild are almost never a clean grid: frames are variable width, packed
 * against each other, colour-keyed rather than alpha, and sized to whatever the artist drew.
 * The renderer wants none of that. It wants `TEX_SIZE` cells, transparent backgrounds, and
 * a fixed number of columns.
 *
 * So this tool does the adapting once, at import time, rather than making the engine cope
 * with arbitrary layouts at run time:
 *
 *   - finds frames by scanning for fully-background rows and columns
 *   - keys the background colour out to real transparency *before* scaling, so the key
 *     colour cannot bleed into edges when the frame is resampled
 *   - scales every frame by **one** factor, chosen so the largest frame in the whole sheet
 *     fits a cell. Per-frame scaling would make the creature change size as it animates
 *   - centres each frame horizontally and sits it on the bottom of its cell, because
 *     sprites in this engine are anchored by their feet
 *   - mirrors the rotations the source omits, which is the convention Doom-era sheets use:
 *     five rotations are stored and the other three are the same art flipped
 *
 * A source row is one of two things, and the caller has to say which:
 *
 *   `dir`  the frames across it are **rotations** of a single animation frame. Becomes one
 *          output row of 8 columns, mirroring to fill any the source omits.
 *   `seq`  the frames across it are **animation frames** of a single view. Becomes N output
 *          rows, each repeating that frame across all 8 columns.
 *
 * Every selected row is imported in **one pass**, because the scale has to be shared. Import
 * a walk and a death separately and each gets fitted to its own largest frame — so the
 * creature visibly changes size the moment it dies.
 *
 * Decoding is done in a headless browser. PNG has a dozen colour formats — this source is
 * 8-bit palette with a transparency chunk — and the browser reads all of them correctly,
 * which is worth more here than avoiding the dependency.
 */

import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';

const { chromium } = createRequire(import.meta.url)('playwright');

const CELL = 64;
const DIRECTIONS = 8;
/** Frames narrower than this are stray pixels, not artwork. */
const MIN_FRAME = 8;

/**
 * Blank texels kept between the art and the edge of its cell.
 *
 * Without it the widest pose — always a pure side view — sits flush against both sides of
 * its cell. Nothing bleeds, since the renderer samples nearest-neighbour and clips to the
 * cell, but the anti-aliased edge the scaling produced gets cut off square on exactly the
 * frames where the silhouette matters most.
 */
const MARGIN = 1;

const [source, destination] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (!source || !destination) {
  console.error('usage: node tools/import-sprites.mjs <source.png> <out.png> [--rows 0,1,2] [--mirror] [--flat]');
  process.exit(2);
}

const rowsArg = process.argv.find((a) => a.startsWith('--rows='));
if (!rowsArg) {
  console.error('--rows is required, e.g. --rows=0:dir,1:dir,8:seq');
  process.exit(2);
}
/** [{ index, mode }] describing what each selected source row contains. */
const rowSpec = rowsArg
  .slice(7)
  .split(',')
  .map((part) => {
    const [index, mode = 'dir'] = part.split(':');
    if (mode !== 'dir' && mode !== 'seq') {
      console.error(`unknown row mode '${mode}' — expected dir or seq`);
      process.exit(2);
    }
    return { index: Number(index), mode };
  });

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto('about:blank');

const result = await page.evaluate(
  async ({ b64, CELL, DIRECTIONS, MIN_FRAME, MARGIN, rowSpec }) => {
    const img = new Image();
    img.src = 'data:image/png;base64,' + b64;
    await img.decode();

    // --- decode, and key the background out to transparency -----------------------------
    const src = document.createElement('canvas');
    src.width = img.width;
    src.height = img.height;
    const sctx = src.getContext('2d', { willReadFrequently: true });
    sctx.drawImage(img, 0, 0);

    const image = sctx.getImageData(0, 0, src.width, src.height);
    const d = image.data;
    const bg = [d[0], d[1], d[2]];

    const nearBackground = (i) =>
      d[i + 3] < 8 ||
      Math.abs(d[i] - bg[0]) + Math.abs(d[i + 1] - bg[1]) + Math.abs(d[i + 2] - bg[2]) < 40;

    for (let i = 0; i < d.length; i += 4) {
      if (nearBackground(i)) { d[i] = d[i + 1] = d[i + 2] = d[i + 3] = 0; }
    }
    sctx.putImageData(image, 0, 0);

    // --- find frames --------------------------------------------------------------------
    const W = src.width, H = src.height;
    const opaque = (x, y) => d[(y * W + x) * 4 + 3] > 8;
    const runs = (empty) => {
      const spans = [];
      let start = -1;
      for (let i = 0; i < empty.length; i++) {
        if (!empty[i] && start < 0) start = i;
        if ((empty[i] || i === empty.length - 1) && start >= 0) {
          spans.push([start, empty[i] ? i - 1 : i]);
          start = -1;
        }
      }
      return spans;
    };

    const rowEmpty = [];
    for (let y = 0; y < H; y++) { let e = true; for (let x = 0; x < W; x++) if (opaque(x, y)) { e = false; break; } rowEmpty.push(e); }

    let bands = runs(rowEmpty).map(([y0, y1]) => {
      const colEmpty = [];
      for (let x = 0; x < W; x++) { let e = true; for (let y = y0; y <= y1; y++) if (opaque(x, y)) { e = false; break; } colEmpty.push(e); }
      const frames = runs(colEmpty)
        .map(([x0, x1]) => ({ x0, y0, w: x1 - x0 + 1, h: y1 - y0 + 1 }))
        .filter((f) => f.w >= MIN_FRAME);
      // Trim each frame vertically to its own content, so the feet really are at the bottom.
      for (const f of frames) {
        let top = f.y0, bottom = y1;
        while (top < bottom) { let e = true; for (let x = f.x0; x < f.x0 + f.w; x++) if (opaque(x, top)) { e = false; break; } if (!e) break; top++; }
        while (bottom > top) { let e = true; for (let x = f.x0; x < f.x0 + f.w; x++) if (opaque(x, bottom)) { e = false; break; } if (!e) break; bottom--; }
        f.y0 = top; f.h = bottom - top + 1;
      }
      return frames;
    });

    const selected = rowSpec.map(({ index, mode }) => ({ mode, frames: bands[index] ?? [] }));

    // --- one scale for the whole sheet ---------------------------------------------------
    const all = selected.flatMap((s) => s.frames);
    const maxW = Math.max(...all.map((f) => f.w));
    const maxH = Math.max(...all.map((f) => f.h));
    const scale = Math.min((CELL - MARGIN * 2) / maxW, (CELL - MARGIN) / maxH);

    // --- compose the uniform sheet -------------------------------------------------------
    // Work out how many output rows each source row produces before allocating.
    const plan = [];
    for (const { mode, frames } of selected) {
      if (mode === 'dir') plan.push({ frames, pick: () => frames });
      else for (const frame of frames) plan.push({ frames: [frame], single: frame });
    }

    const out = document.createElement('canvas');
    out.width = CELL * DIRECTIONS;
    out.height = CELL * plan.length;
    const octx = out.getContext('2d');
    octx.imageSmoothingEnabled = true;
    octx.imageSmoothingQuality = 'high';

    plan.forEach((entry, row) => {
      for (let dir = 0; dir < DIRECTIONS; dir++) {
        let frame;
        let flip = false;

        if (entry.single) {
          // A single view repeated across every direction: a death throe looks the same
          // from wherever you are standing, which is exactly what Doom did too.
          frame = entry.single;
        } else {
          const frames = entry.frames;
          let index = dir;
          if (frames.length < DIRECTIONS && dir >= frames.length) {
            // Five stored rotations cover eight: 0..4 as given, 5..7 are 3..1 flipped.
            index = DIRECTIONS - dir;
            flip = true;
          }
          frame = frames[Math.min(index, frames.length - 1)];
        }
        if (!frame) continue;

        const w = frame.w * scale;
        const h = frame.h * scale;
        const dx = dir * CELL + (CELL - w) / 2;
        const dy = row * CELL + (CELL - h);

        octx.save();
        if (flip) {
          octx.translate(dx + w, dy);
          octx.scale(-1, 1);
          octx.drawImage(src, frame.x0, frame.y0, frame.w, frame.h, 0, 0, w, h);
        } else {
          octx.drawImage(src, frame.x0, frame.y0, frame.w, frame.h, dx, dy, w, h);
        }
        octx.restore();
      }
    });

    const report = selected.map(({ mode, frames }) => ({ mode, frames: frames.length }));

    return {
      dataUrl: out.toDataURL('image/png'),
      width: out.width,
      height: out.height,
      rows: out.height / CELL,
      scale,
      maxW,
      maxH,
      background: bg,
      report,
    };
  },
  {
    b64: readFileSync(source).toString('base64'),
    CELL, DIRECTIONS, MIN_FRAME, MARGIN, rowSpec,
  },
);

writeFileSync(destination, Buffer.from(result.dataUrl.split(',')[1], 'base64'));
await browser.close();

console.log(`${source} -> ${destination}`);
console.log(`  background keyed out: rgb(${result.background.join(',')})`);
console.log(`  largest source frame: ${result.maxW}x${result.maxH}  scaled by ${result.scale.toFixed(3)}`);
console.log(`  source rows used:     ${result.report.map((r) => `${r.frames} ${r.mode}`).join(', ')}`);
console.log(`  output: ${result.width}x${result.height}  (${DIRECTIONS} directions x ${result.rows} rows of ${CELL}px)`);
