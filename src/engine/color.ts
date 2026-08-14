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
