import { TEX_SIZE } from '../config';
import { LIGHT_UNIT, TRANSPARENT, alphaOf, blend, shade } from '../engine/color';
import type { Texture } from '../assets/decode';
import type { Framebuffer } from '../engine/framebuffer';
import type { Player } from '../player';
import type { RenderOptions } from './options';

/**
 * Screen-space drawing, and where a game's own passes go.
 *
 * Everything else in `render/` draws the *world*: things with positions, seen through a
 * camera. A HUD is not that. A weapon held in front of you, a health readout, a full-screen
 * flash when you take damage — these live in screen coordinates and have no depth, and
 * every one of them is drawn after the world is finished and before the frame is presented.
 *
 * That is one specific place in the frame, and this file is what marks it.
 */

/**
 * A pass that draws over the finished world.
 *
 * Given the framebuffer, so it can do anything the engine can; given the player and the
 * render options, because almost every HUD wants at least one of them. Deliberately not
 * given the map — an overlay that needs the world is describing a world-space effect, and
 * belongs before this point in the frame.
 */
export type OverlayPass = (fb: Framebuffer, player: Player, options: RenderOptions) => void;

/**
 * The passes to run, in order.
 *
 * A list rather than a single hook because a game accumulates these — a weapon, a HUD, a
 * damage flash, a debug readout — and each wants to be added and removed independently. The
 * engine ships with none: an empty stack costs one loop that does not run.
 */
export class OverlayStack {
  private readonly passes: OverlayPass[] = [];

  /** Add a pass. Returns a function that removes it again. */
  add(pass: OverlayPass): () => void {
    this.passes.push(pass);

    return () => {
      const at = this.passes.indexOf(pass);
      if (at >= 0) this.passes.splice(at, 1);
    };
  }

  draw(fb: Framebuffer, player: Player, options: RenderOptions): void {
    for (let i = 0; i < this.passes.length; i++) {
      this.passes[i]!(fb, player, options);
    }
  }

  get count(): number {
    return this.passes.length;
  }
}

/**
 * Draw a texture into the frame at a screen rectangle, scaled, honouring transparency.
 *
 * The primitive a weapon overlay or a HUD icon is made of, and the one thing the engine
 * could not do before: `Framebuffer` can fill rectangles and spans, and `SpriteRenderer` can
 * place a billboard in the *world*, but nothing could put a picture at a place on the
 * screen.
 *
 * Nearest-neighbour, like everything else here — a smoothed weapon sprite over a 320x200
 * world would look like it had been pasted in from a different game. The sampling is the
 * same fixed-point stepping walls use, for the same reason: no division per pixel.
 *
 * `brightness` runs through the same `shade` the world uses, so a HUD element can be dimmed
 * consistently with everything else.
 */
export function drawTexture(
  fb: Framebuffer,
  texture: Texture,
  destX: number,
  destY: number,
  destWidth: number,
  destHeight: number,
  brightness = LIGHT_UNIT,
): void {
  if (destWidth <= 0 || destHeight <= 0) return;

  const { width, height, pixels } = fb;

  // Clip to the frame, keeping the unclipped origin so the texture coordinates do not shift
  // when part of the image goes off the edge.
  const x0 = destX < 0 ? 0 : destX;
  const y0 = destY < 0 ? 0 : destY;
  const x1 = destX + destWidth > width ? width : destX + destWidth;
  const y1 = destY + destHeight > height ? height : destY + destHeight;
  if (x0 >= x1 || y0 >= y1) return;

  const stepX = ((TEX_SIZE * 65536) / destWidth) | 0;
  const stepY = ((TEX_SIZE * 65536) / destHeight) | 0;

  const data = texture.data;
  const size = texture.size;
  const mask = size - 1;

  for (let y = y0; y < y1; y++) {
    // Pixel centres, as everywhere else: sampling from the top-left corner of a destination
    // pixel biases the whole image half a texel up and left.
    const texY = (((y - destY) * stepY + (stepY >> 1)) >> 16) & mask;
    const row = y * width;

    for (let x = x0; x < x1; x++) {
      const texX = (((x - destX) * stepX + (stepX >> 1)) >> 16) & mask;

      // Column-major, like every other texture read in this project.
      const texel = data[texX * size + texY]!;
      if (texel === TRANSPARENT) continue;

      const lit = brightness === LIGHT_UNIT ? texel : shade(texel, brightness);
      const alpha = alphaOf(texel);

      pixels[row + x] = alpha === 255 ? lit : blend(pixels[row + x]!, lit, alpha);
    }
  }
}
