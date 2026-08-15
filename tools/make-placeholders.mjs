/**
 * Generate the placeholder texture PNGs.
 *
 *     node tools/make-placeholders.mjs
 *
 * These exist so the project runs before real artwork is dropped in. They are deliberately
 * ugly — flat colours, hard borders, a wrapping diagonal, and the slot name spelled out —
 * so there is never any doubt about which images are still stand-ins.
 *
 * They are also correct *as examples*, which matters more than how they look:
 *
 *   - Wall placeholders tile horizontally. Every pattern is a function of `(x + y) % 16`
 *     or similar, so column 63 runs seamlessly into column 0 of the next cell.
 *   - Floor and ceiling placeholders tile in both axes, because floors repeat across the
 *     world grid in x and y.
 *   - Sprite placeholders have transparent margins, sit on the bottom edge of the image
 *     (sprites are anchored by their feet), and carry a soft anti-aliased edge so the
 *     renderer's alpha blending is actually exercised rather than just assumed.
 *
 * No dependencies: PNG encoding is a couple of chunks and a zlib deflate, both of which
 * Node has built in.
 */

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SIZE = 64;
const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'assets', 'images');

// ----------------------------------------------------------------------------------------
// PNG encoding
// ----------------------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (let i = 0; i < buffer.length; i++) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** A PNG chunk: length, type, payload, CRC of type+payload. */
function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);

  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);

  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));

  return Buffer.concat([length, body, crc]);
}

/**
 * Encode 8-bit RGBA pixels as a PNG.
 *
 * Every scanline is prefixed with filter byte 0 ("none"). The other filter types exist to
 * help compression on photographic data; on flat placeholder art they would buy nothing.
 */
function encodePng(width, height, rgba) {
  const stride = 1 + width * 4;
  const raw = Buffer.alloc(height * stride);

  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0;
    for (let i = 0; i < width * 4; i++) {
      raw[y * stride + 1 + i] = rgba[y * width * 4 + i];
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ----------------------------------------------------------------------------------------
// Drawing
// ----------------------------------------------------------------------------------------

class Image {
  constructor(size) {
    this.size = size;
    this.data = new Uint8Array(size * size * 4);
  }

  /** Write a pixel, blending onto whatever is there when `a` is partial. */
  set(x, y, r, g, b, a = 255) {
    if (x < 0 || y < 0 || x >= this.size || y >= this.size) return;
    if (a <= 0) return;

    const i = (y * this.size + x) * 4;

    if (a >= 255) {
      this.data[i] = r;
      this.data[i + 1] = g;
      this.data[i + 2] = b;
      this.data[i + 3] = 255;
      return;
    }

    // Straight-alpha "over" composite, which is what the renderer will do at run time.
    const dstA = this.data[i + 3] / 255;
    const srcA = a / 255;
    const outA = srcA + dstA * (1 - srcA);
    if (outA <= 0) return;

    for (let c = 0; c < 3; c++) {
      const src = [r, g, b][c];
      this.data[i + c] = Math.round((src * srcA + this.data[i + c] * dstA * (1 - srcA)) / outA);
    }
    this.data[i + 3] = Math.round(outA * 255);
  }

  fill(r, g, b, a = 255) {
    for (let y = 0; y < this.size; y++) {
      for (let x = 0; x < this.size; x++) this.set(x, y, r, g, b, a);
    }
  }

  /** Fill everywhere a distance function is negative, with a soft one-pixel edge. */
  fillShape(sdf, colour) {
    const [r, g, b] = colour;
    for (let y = 0; y < this.size; y++) {
      for (let x = 0; x < this.size; x++) {
        const d = sdf(x + 0.5, y + 0.5);
        const coverage = Math.min(1, Math.max(0, 0.5 - d));
        if (coverage > 0) this.set(x, y, r, g, b, Math.round(coverage * 255));
      }
    }
  }
}

/** Distance to an axis-aligned box, negative inside. */
const sdBox = (cx, cy, hw, hh) => (x, y) => {
  const dx = Math.abs(x - cx) - hw;
  const dy = Math.abs(y - cy) - hh;
  return Math.min(Math.max(dx, dy), 0) + Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
};

/** Distance to an ellipse, negative inside. Approximate, which is ample here. */
const sdEllipse = (cx, cy, rx, ry) => (x, y) => {
  const nx = (x - cx) / rx;
  const ny = (y - cy) / ry;
  return (Math.hypot(nx, ny) - 1) * Math.min(rx, ry);
};

const union =
  (...shapes) =>
  (x, y) =>
    Math.min(...shapes.map((s) => s(x, y)));

// ----------------------------------------------------------------------------------------
// A 3x5 pixel font, enough to label each slot
// ----------------------------------------------------------------------------------------

const FONT = {
  A: ['###', '#.#', '###', '#.#', '#.#'],
  B: ['##.', '#.#', '##.', '#.#', '##.'],
  C: ['###', '#..', '#..', '#..', '###'],
  D: ['##.', '#.#', '#.#', '#.#', '##.'],
  E: ['###', '#..', '###', '#..', '###'],
  F: ['###', '#..', '###', '#..', '#..'],
  I: ['###', '.#.', '.#.', '.#.', '###'],
  L: ['#..', '#..', '#..', '#..', '###'],
  M: ['#.#', '###', '###', '#.#', '#.#'],
  N: ['#.#', '###', '###', '###', '#.#'],
  O: ['###', '#.#', '#.#', '#.#', '###'],
  P: ['###', '#.#', '###', '#..', '#..'],
  R: ['###', '#.#', '##.', '#.#', '#.#'],
  S: ['###', '#..', '###', '..#', '###'],
  T: ['###', '.#.', '.#.', '.#.', '.#.'],
  W: ['#.#', '#.#', '###', '###', '#.#'],
  1: ['.#.', '##.', '.#.', '.#.', '###'],
  2: ['###', '..#', '###', '#..', '###'],
  3: ['###', '..#', '###', '..#', '###'],
  4: ['#.#', '#.#', '###', '..#', '..#'],
  '?': ['###', '..#', '.##', '...', '.#.'],
};

function drawText(image, text, x, y, colour, scale = 1) {
  const [r, g, b] = colour;
  let cursor = x;

  for (const character of text.toUpperCase()) {
    const glyph = FONT[character] ?? FONT['?'];
    for (let row = 0; row < 5; row++) {
      for (let column = 0; column < 3; column++) {
        if (glyph[row][column] !== '#') continue;
        for (let sy = 0; sy < scale; sy++) {
          for (let sx = 0; sx < scale; sx++) {
            image.set(cursor + column * scale + sx, y + row * scale + sy, r, g, b);
          }
        }
      }
    }
    cursor += 4 * scale;
  }
}

/** Centre a label horizontally. */
function drawLabel(image, text, y, colour, scale = 1) {
  const width = text.length * 4 * scale - scale;
  drawText(image, text, Math.round((image.size - width) / 2), y, colour, scale);
}

// ----------------------------------------------------------------------------------------
// Painters
// ----------------------------------------------------------------------------------------

const shift = (colour, amount) => colour.map((c) => Math.min(255, Math.max(0, c + amount)));

/**
 * A surface that tiles.
 *
 * Every feature is periodic with a factor of 64, so opposite edges match exactly. Get this
 * wrong and every cell boundary in the level shows a seam — the single most common problem
 * with hand-made wall art.
 */
function tilingTexture(image, base, label, { bothAxes }) {
  image.fill(...base);

  // Wrapping diagonal stripes: period 16 divides 64, so this is seamless in both axes.
  for (let y = 0; y < image.size; y++) {
    for (let x = 0; x < image.size; x++) {
      if ((x + y) % 16 < 3) image.set(x, y, ...shift(base, 22));
    }
  }

  /**
   * Grid lines every 16 texels, *including* the one at 0.
   *
   * The period matters. A single line drawn only at x = 0 still tiles — you get one line
   * per cell — but it makes the left and right edge columns different from each other,
   * which is precisely the thing wall art must not do. Repeating the line at a period that
   * divides 64 makes the boundary line the same feature as the interior ones, so the edges
   * match and the placeholder demonstrates the rule instead of breaking it.
   */
  for (let y = 0; y < image.size; y++) {
    for (let x = 0; x < image.size; x++) {
      if (x % 16 === 0 || (bothAxes && y % 16 === 0)) image.set(x, y, ...shift(base, -55));
    }
  }

  // Walls do not tile vertically — they span exactly one wall height — so a bottom edge
  // band is free to be asymmetric and helps show which way up the texture is.
  if (!bothAxes) {
    for (let i = 0; i < image.size; i++) image.set(i, image.size - 1, ...shift(base, -75));
  }

  drawLabel(image, label, 14, shift(base, 105), 2);
  drawLabel(image, 'TODO', 40, shift(base, 60), 1);
}

/**
 * A sprite: transparent margins, standing on the bottom edge.
 *
 * The soft edge is deliberate. Colour-keyed cutouts have hard jagged silhouettes; the
 * renderer blends partial alpha, and a placeholder with a one-pixel feathered edge proves
 * that path works rather than leaving it untested until real art arrives.
 */
function spriteTexture(image, sdf, base, tag) {
  image.fillShape(sdf, base);

  // A lighter core, so the shape reads as having some form rather than being a silhouette.
  image.fillShape((x, y) => sdf(x, y) + 3, shift(base, 26));

  drawLabel(image, tag, 46, shift(base, -70), 1);
}

const TEXTURES = {
  'wall-1.png': (i) => tilingTexture(i, [150, 66, 60], 'WALL1', { bothAxes: false }),
  'wall-2.png': (i) => tilingTexture(i, [70, 108, 158], 'WALL2', { bothAxes: false }),
  'wall-3.png': (i) => tilingTexture(i, [78, 138, 84], 'WALL3', { bothAxes: false }),
  'wall-4.png': (i) => tilingTexture(i, [158, 124, 62], 'WALL4', { bothAxes: false }),

  'door.png': (i) => {
    tilingTexture(i, [186, 156, 74], 'DOOR', { bothAxes: false });
    // Central seam, so the sliding direction is obvious as it opens.
    for (let y = 0; y < i.size; y++) {
      i.set(31, y, ...shift([186, 156, 74], -80));
      i.set(32, y, ...shift([186, 156, 74], -80));
    }
  },

  'door-frame.png': (i) => tilingTexture(i, [116, 112, 106], 'FRAME', { bothAxes: false }),

  'floor.png': (i) => tilingTexture(i, [104, 100, 96], 'FLOOR', { bothAxes: true }),
  'ceiling.png': (i) => tilingTexture(i, [58, 58, 68], 'CEIL', { bothAxes: true }),

  'barrel.png': (i) =>
    spriteTexture(i, sdEllipse(32, 40, 19, 23), [146, 96, 52], 'BARL'),

  'plant.png': (i) =>
    spriteTexture(
      i,
      union(sdEllipse(32, 26, 20, 20), sdBox(32, 54, 12, 10)),
      [74, 132, 66],
      'PLNT',
    ),

  'lamp.png': (i) =>
    spriteTexture(
      i,
      union(sdEllipse(32, 18, 13, 14), sdBox(32, 42, 2.5, 22), sdBox(32, 61, 11, 3)),
      [214, 190, 120],
      'LAMP',
    ),

  /**
   * Deliberately non-integer extents.
   *
   * With half-widths like 18 centred on 32, every edge lands exactly on a pixel boundary,
   * coverage comes out as precisely 0 or 1, and the sprite gets no soft edge at all — so
   * the renderer's alpha blending would go untested by this placeholder. Offsetting by a
   * fraction of a texel puts the edges mid-pixel where they belong.
   */
  'column.png': (i) =>
    spriteTexture(
      i,
      union(sdBox(32, 32, 18.3, 31.7), sdBox(32, 4.4, 23.6, 5.3), sdBox(32, 59.6, 23.6, 4.3)),
      [150, 146, 136],
      'COLM',
    ),

  /**
   * Shown when a texture slot has no image. Loud on purpose: magenta and black is the
   * convention precisely because nothing in real artwork looks like it.
   */
  'missing.png': (i) => {
    for (let y = 0; y < i.size; y++) {
      for (let x = 0; x < i.size; x++) {
        const check = ((x >> 3) + (y >> 3)) % 2 === 0;
        i.set(x, y, ...(check ? [255, 0, 220] : [26, 26, 26]));
      }
    }
    drawLabel(i, 'MISSIN', 30, [255, 255, 255], 1);
  },
};

// ----------------------------------------------------------------------------------------

mkdirSync(OUT_DIR, { recursive: true });

for (const [name, paint] of Object.entries(TEXTURES)) {
  const image = new Image(SIZE);
  paint(image);
  const png = encodePng(SIZE, SIZE, image.data);
  writeFileSync(join(OUT_DIR, name), png);
  console.log(`${name.padEnd(16)} ${String(png.length).padStart(5)} bytes`);
}

console.log(`\n${Object.keys(TEXTURES).length} placeholders written to src/assets/images/`);
