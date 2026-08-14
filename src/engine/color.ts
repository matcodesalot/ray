/**
 * Pixel packing.
 *
 * The framebuffer is a Uint32Array laid over the same bytes as an ImageData, which the
 * canvas reads as four bytes per pixel in R, G, B, A order. How a 32-bit integer maps
 * onto those four bytes therefore depends on the machine's byte order:
 *
 *   little-endian (x86, ARM — i.e. everywhere you will run this):  0xAABBGGRR
 *   big-endian:                                                    0xRRGGBBAA
 *
 * Writing whole pixels as one 32-bit store instead of four 8-bit stores is a large win
 * in the inner loops, so we pay for it with this one piece of awkwardness — confined to
 * this file. Everything else in the codebase just calls rgb().
 */

const probe = new ArrayBuffer(4);
new Uint32Array(probe)[0] = 0x11223344;

/** True on every platform this will realistically run on; the check costs nothing once. */
export const LITTLE_ENDIAN = new Uint8Array(probe)[0] === 0x44;

/**
 * Pack 8-bit r, g, b into one opaque framebuffer pixel.
 *
 * The `>>> 0` coerces the result back to unsigned: bit 31 is set by the 0xff alpha, and
 * without it JavaScript's bitwise operators would hand back a negative signed integer.
 */
export function rgb(r: number, g: number, b: number): number {
  return LITTLE_ENDIAN
    ? ((0xff << 24) | (b << 16) | (g << 8) | r) >>> 0
    : ((r << 24) | (g << 16) | (b << 8) | 0xff) >>> 0;
}

export const BLACK = rgb(0, 0, 0);
export const WHITE = rgb(255, 255, 255);

/** Where the alpha byte sits, so shade() can force it back to opaque. */
const ALPHA_MASK = LITTLE_ENDIAN ? 0xff000000 : 0x000000ff;

/** Passing this to shade() leaves a colour unchanged. Full brightness. */
export const LIGHT_UNIT = 256;

/**
 * Multiply a packed colour by `factor / 256`, all four channels at once.
 *
 * The obvious implementation unpacks three bytes, multiplies each, and repacks — about a
 * dozen operations per pixel. That is fine for walls, which are shaded once per column,
 * but Stage 7 shades every pixel of the floor and ceiling individually: 30,000+ calls a
 * frame, in the innermost loop of the renderer.
 *
 * So instead, the classic trick. The four bytes cannot be multiplied in place, because
 * each product needs 16 bits and would carry into its neighbour. But *alternate* bytes
 * can: mask out bytes 0 and 2, and each one sits in its own 16-bit lane with room to grow.
 *
 *   colour        AA BB GG RR
 *   & 0x00ff00ff  __ BB __ RR      two lanes, 8 bits of headroom each
 *   * factor      ?BB?BB ?RR?RR    each lane up to 255*256, still fits
 *   >>> 8         __ BB __ RR      back down, scaled
 *   & 0x00ff00ff                   drop what spilled between lanes
 *
 * Then repeat for the odd bytes and recombine: two multiplies for four channels.
 *
 * `factor` is an integer in 0..256, where 256 is unchanged — a power of two so the
 * division is a shift. Note the alpha channel gets scaled along with the rest and is
 * simply forced back to opaque at the end, which is cheaper than excluding it.
 */
export function shade(color: number, factor: number): number {
  const even = (((color & 0x00ff00ff) * factor) >>> 8) & 0x00ff00ff;
  const odd = ((((color >>> 8) & 0x00ff00ff) * factor) >>> 8) & 0x00ff00ff;
  return (even | (odd << 8) | ALPHA_MASK) >>> 0;
}
