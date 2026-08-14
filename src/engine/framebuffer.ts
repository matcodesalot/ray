import { BLACK } from './color';

/**
 * A software framebuffer: a fixed-size grid of 32-bit pixels we write to directly.
 *
 * Nothing here touches the GPU. We own every pixel, which is what makes textured floor
 * casting, per-pixel distance shading and colour-keyed sprites straightforward later on
 * — all of them are awkward or impossible if you are limited to drawImage calls.
 *
 * Presenting is two steps:
 *   1. putImageData onto a small offscreen canvas the same size as the buffer.
 *   2. drawImage that canvas, scaled, onto the visible one.
 *
 * Step 2 exists because putImageData deliberately ignores the context transform and any
 * scaling arguments — it is a raw byte blit. drawImage is what can scale, so the small
 * canvas is the bridge between the two.
 */
export class Framebuffer {
  readonly width: number;
  readonly height: number;

  /**
   * The pixels, row-major: the pixel at (x, y) is `pixels[y * width + x]`.
   *
   * This is a Uint32Array *view over the ImageData's bytes*, not a copy — writing here
   * writes straight into what putImageData will upload.
   */
  readonly pixels: Uint32Array;

  private readonly image: ImageData;
  private readonly source: HTMLCanvasElement;
  private readonly sourceCtx: CanvasRenderingContext2D;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;

    this.source = document.createElement('canvas');
    this.source.width = width;
    this.source.height = height;

    // alpha: false lets the browser skip compositing work; we always write opaque pixels.
    const ctx = this.source.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('Could not acquire a 2D context for the framebuffer');
    this.sourceCtx = ctx;

    this.image = ctx.createImageData(width, height);
    this.pixels = new Uint32Array(this.image.data.buffer);
    this.pixels.fill(BLACK);
  }

  /** Overwrite every pixel with one colour. */
  clear(color: number): void {
    this.pixels.fill(color);
  }

  /**
   * Fill column `x` from `y0` (inclusive) to `y1` (exclusive) with a solid colour.
   *
   * Vertical spans are the raycaster's fundamental drawing primitive: one wall slice is
   * exactly one of these. Out-of-range coordinates are clipped rather than rejected,
   * because projected walls routinely run off the top and bottom of the screen.
   */
  verticalSpan(x: number, y0: number, y1: number, color: number): void {
    if (x < 0 || x >= this.width) return;

    const top = y0 < 0 ? 0 : y0;
    const bottom = y1 > this.height ? this.height : y1;

    // Walking the index by `width` avoids a multiply per pixel.
    let index = top * this.width + x;
    for (let y = top; y < bottom; y++) {
      this.pixels[index] = color;
      index += this.width;
    }
  }

  /** Fill a rectangle, clipped to the buffer. Debug drawing only — not used in the hot path. */
  fillRect(x0: number, y0: number, w: number, h: number, color: number): void {
    const left = Math.max(0, x0);
    const top = Math.max(0, y0);
    const right = Math.min(this.width, x0 + w);
    const bottom = Math.min(this.height, y0 + h);

    for (let y = top; y < bottom; y++) {
      const row = y * this.width;
      this.pixels.fill(color, row + left, row + right);
    }
  }

  /** Blit the buffer to a visible context, scaled into the given destination rectangle. */
  present(
    dest: CanvasRenderingContext2D,
    dx: number,
    dy: number,
    dw: number,
    dh: number,
  ): void {
    this.sourceCtx.putImageData(this.image, 0, 0);

    // Set every present: the destination context may have been resized or replaced,
    // and smoothing is what separates crisp chunky pixels from a blurry mess.
    dest.imageSmoothingEnabled = false;
    dest.drawImage(this.source, dx, dy, dw, dh);
  }
}
