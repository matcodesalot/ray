import { spriteCell, spriteTexture, type TextureSet } from '../assets/decode';
import { TEX_MASK, TEX_SIZE } from '../config';
import { LIGHT_UNIT, TRANSPARENT, alphaOf, blend, shade } from '../engine/color';
import type { Framebuffer } from '../engine/framebuffer';
import type { Player } from '../player';
import { SPRITE_SIZES, SpriteKind, type SpriteEntity } from '../world/entities';
import { lightFactor } from './lighting';
import type { RenderOptions } from './options';
import type { RayHit } from './raycast';

/**
 * Billboard sprites.
 *
 * Walls came to us in screen order — one ray per column, already sorted by construction,
 * each column independent. Sprites arrive in *world* order, at arbitrary positions, and
 * every one of them has to be placed on the screen, sized, sorted against the others, and
 * tested against the walls. It is the first thing in the renderer that has to think about
 * the scene as a whole.
 */

/** Kinds that light themselves and so ignore distance shading. */
const EMISSIVE: Readonly<Record<number, boolean>> = {
  [SpriteKind.Lamp]: true,
};

/**
 * Which of the stored views of an entity this viewer sees.
 *
 * Column 0 of a sheet is the entity looking straight at you, and the columns walk round it
 * from there. So the index is the angle between where the entity is *facing* and where the
 * viewer *is*, quantised to eighths:
 *
 *     facing the viewer      -> 0
 *     viewer 90 deg away     -> 2 or 6, one flank or the other
 *     viewer behind          -> 4
 *
 * The sign is the whole game here. Getting it backwards swaps the two flanks, which looks
 * plausible in a still frame and wrong the moment anything turns — the same failure mode
 * that mirrored every wall in this project for six stages. It is fixed by the artwork, not
 * by taste: in the sheet that ships, column 2 shows the creature facing screen-left, and
 * `verify sprites` asserts exactly that against a synthetic sheet.
 *
 * `& (columns - 1)` both wraps and handles the negative results `Math.round` produces,
 * since JavaScript's bitwise operators work on two's-complement 32-bit integers. It needs
 * `columns` to be a power of two, which the eight-direction convention guarantees.
 */
export function directionIndex(
  entityAngle: number,
  entityX: number,
  entityY: number,
  viewerX: number,
  viewerY: number,
  columns: number,
): number {
  if (columns <= 1) return 0;

  const toViewer = Math.atan2(viewerY - entityY, viewerX - entityX);
  const step = (2 * Math.PI) / columns;

  return Math.round((entityAngle - toViewer) / step) & (columns - 1);
}

export class SpriteRenderer {
  /** Indices into the sprite list, reordered far-to-near each frame. */
  private readonly order: Int32Array;

  /** Squared distance for each sprite, parallel to the sprite list. */
  private readonly distance: Float64Array;

  constructor(capacity: number) {
    this.order = new Int32Array(capacity);
    this.distance = new Float64Array(capacity);
  }

  /**
   * Draw every sprite, furthest first.
   *
   * `hits` doubles as the depth buffer. There is no need for a separate one: the ray fan
   * already holds the perpendicular distance to the nearest wall in every screen column,
   * which is exactly what a sprite column needs to compare itself against. Doors included —
   * a door slab's distance is its own, so a sprite behind a closed door is hidden and the
   * same sprite seen through the open half is not.
   */
  draw(
    fb: Framebuffer,
    player: Player,
    sprites: readonly SpriteEntity[],
    hits: readonly RayHit[],
    textures: TextureSet,
    options: RenderOptions,
  ): void {
    const count = Math.min(sprites.length, this.order.length);
    if (count === 0) return;

    this.sortFarToNear(player, sprites, count);

    for (let i = 0; i < count; i++) {
      this.drawOne(fb, player, sprites[this.order[i]!]!, hits, textures, options);
    }
  }

  /**
   * Order sprites back to front.
   *
   * Necessary because sprites are drawn with a transparency test rather than a depth test:
   * a nearer sprite must overwrite a further one, and the only thing enforcing that is
   * paint order. Walls do not need this — each column is drawn once.
   *
   * Squared distance is enough, since we only ever compare. Insertion sort because the
   * counts are tiny and it allocates nothing; `Array.prototype.sort` on a fresh array of
   * objects would allocate every frame, which is the sort of thing that quietly turns into
   * a stutter later.
   */
  private sortFarToNear(player: Player, sprites: readonly SpriteEntity[], count: number): void {
    const { order, distance } = this;

    for (let i = 0; i < count; i++) {
      const dx = sprites[i]!.x - player.x;
      const dy = sprites[i]!.y - player.y;
      distance[i] = dx * dx + dy * dy;
      order[i] = i;
    }

    for (let i = 1; i < count; i++) {
      const index = order[i]!;
      const key = distance[index]!;
      let j = i - 1;
      while (j >= 0 && distance[order[j]!]! < key) {
        order[j + 1] = order[j]!;
        j--;
      }
      order[j + 1] = index;
    }
  }

  private drawOne(
    fb: Framebuffer,
    player: Player,
    sprite: SpriteEntity,
    hits: readonly RayHit[],
    textures: TextureSet,
    options: RenderOptions,
  ): void {
    const width = fb.width;
    const height = fb.height;
    const horizon = height >> 1;
    const pixels = fb.pixels;

    const relX = sprite.x - player.x;
    const relY = sprite.y - player.y;

    /**
     * Into camera space, by inverting the camera matrix.
     *
     * The camera's basis vectors are `plane` (across the screen) and `dir` (into it), so
     * the matrix taking camera coordinates to world coordinates is `[plane dir]`. We want
     * the other direction, and for a 2x2 the inverse is one determinant and a shuffle:
     *
     *     depth  = how far along `dir`   -- exactly the perpDist walls are measured in
     *     lateral = how far along `plane` -- in units where +-1 is the screen edge
     *
     * `depth` coming out in the same units as `perpDist` is what makes the depth test
     * against the wall buffer a plain comparison, with nothing to convert.
     */
    const invDet = 1 / (player.planeX * player.dirY - player.dirX * player.planeY);
    const lateral = invDet * (player.dirY * relX - player.dirX * relY);
    const depth = invDet * (-player.planeY * relX + player.planeX * relY);

    // Behind the camera, or exactly level with it. Sprites at or behind the eye have no
    // sensible projection — the division would flip them and smear them across the screen.
    if (depth <= 0.01) return;

    const size = SPRITE_SIZES[sprite.kind];

    /**
     * Screen size, and why the two axes use different scales.
     *
     * Vertically, a one-unit-tall wall at distance d covers `VIEW_H / d` pixels — Stage 4.
     * Horizontally, the camera plane spans `2 * planeLength * d` world units at distance d
     * and maps to `VIEW_W` pixels, so one world unit is `VIEW_W / (2 * planeLength * d)`.
     *
     * Those differ by about 1.21, and using one for both — as plenty of implementations do
     * — leaves every sprite subtly the wrong shape. The factor is not arbitrary: it is the
     * same non-square-pixel ratio that Stage 1 letterboxes 320x200 to 4:3 for, so getting
     * it right here is what makes a round barrel look round on the actual display.
     */
    const pixelsPerUnitY = height / depth;
    const pixelsPerUnitX = width / (2 * player.planeLength * depth);

    const spriteH = size.height * pixelsPerUnitY;
    const spriteW = size.width * pixelsPerUnitX;

    /**
     * Where the sprite's centre line falls.
     *
     * `lateral / depth` is the perspective divide, and it is not optional: the transform
     * gives `lateral = depth * cameraX`, so without dividing, everything off-centre is
     * thrown away from the middle in proportion to how far away it is. A sprite dead ahead
     * still lands dead centre, which is exactly why this is easy to miss by eye — the two
     * versions agree along the view axis and diverge everywhere else.
     *
     * The -0.5 matches the pixel-centre convention the rays are cast with.
     */
    const centreX = (width / 2) * (1 + lateral / depth) - 0.5;

    /**
     * Anchored by the feet, not centred on the horizon.
     *
     * The floor at distance d appears at `horizon + 0.5 * VIEW_H / d` — Stage 7's row
     * formula, and the same line a wall's base sits on. Standing the sprite on it means a
     * barrel rests on the floor instead of hovering at eye level, and it lines up exactly
     * with the wall bases around it.
     */
    const feet = horizon + 0.5 * pixelsPerUnitY;
    const top = feet - spriteH;

    const startX = Math.round(centreX - spriteW / 2);
    const startY = Math.round(top);
    const drawnW = Math.max(1, Math.round(spriteW));
    const drawnH = Math.max(1, Math.round(spriteH));

    // Clip to the screen, keeping the unclipped origin so texture coordinates stay put.
    const clipX0 = startX < 0 ? 0 : startX;
    const clipX1 = startX + drawnW > width ? width : startX + drawnW;
    const clipY0 = startY < 0 ? 0 : startY;
    const clipY1 = startY + drawnH > height ? height : startY + drawnH;
    if (clipX0 >= clipX1 || clipY0 >= clipY1) return;

    /**
     * Which cell of the artwork to draw.
     *
     * Kinds with a sheet resolve to an animation frame seen from a direction; kinds with a
     * single image ignore both and return undefined, which is the fallback path. A barrel
     * has no front, and asking it which way it is facing would be meaningless rather than
     * merely wasteful.
     */
    const sheet = textures.spriteSheets[sprite.kind];
    const cell = sheet
      ? spriteCell(
          textures,
          sprite.kind,
          sprite.animation,
          sprite.frame,
          directionIndex(sprite.angle, sprite.x, sprite.y, player.x, player.y, sheet.columns),
        )
      : undefined;

    const texture = (cell ?? spriteTexture(textures, sprite.kind)).data;

    const brightness =
      options.lighting && !EMISSIVE[sprite.kind] ? lightFactor(depth) : LIGHT_UNIT;

    // 16.16 fixed point down the column, as for walls.
    const stepY = ((TEX_SIZE * 65536) / drawnH) | 0;
    const baseTexY = (clipY0 - startY) * stepY + (stepY >> 1);

    for (let x = clipX0; x < clipX1; x++) {
      /**
       * The depth test, one comparison per column.
       *
       * This is the whole of sprite occlusion. `hits[x].perpDist` is the nearest wall in
       * this column and `depth` is the sprite's own, both perpendicular distances in the
       * same units, so a sprite behind a wall simply loses the comparison and the column
       * is skipped.
       *
       * Per *column* rather than per pixel because walls are flat-on-screen vertical spans
       * at a single depth — the entire column is either in front of the sprite or behind
       * it. That is a property of this engine, not a shortcut: give walls varying height
       * and this becomes a real per-pixel depth buffer.
       */
      if (depth >= hits[x]!.perpDist) continue;

      const texX = (((x + 0.5 - startX) * TEX_SIZE) / drawnW) | 0;
      if (texX < 0 || texX >= TEX_SIZE) continue;
      const column = texX * TEX_SIZE;

      let texY = baseTexY;
      let index = clipY0 * width + x;

      for (let y = clipY0; y < clipY1; y++) {
        const texel = texture[column + ((texY >> 16) & TEX_MASK)]!;
        texY += stepY;

        /**
         * Three cases, cheapest first.
         *
         * Fully transparent is one integer comparison, and it is the common case — the
         * loader guarantees such texels are exactly zero, RGB and all, precisely so this
         * stays a single compare. Fully opaque is the Stage 10 path, untouched.
         *
         * Only genuinely partial pixels — the anti-aliased rim of real artwork, typically
         * a few percent of a sprite — pay for a read of the destination and a blend.
         *
         * The alpha has to be read *before* shading: `shade()` forces the result opaque,
         * so asking afterwards always answers 255.
         */
        if (texel !== TRANSPARENT) {
          const alpha = alphaOf(texel);
          const lit = shade(texel, brightness);

          pixels[index] =
            alpha === 255
              ? lit
              : // `alpha + (alpha >> 7)` stretches 0..255 onto blend's 0..256, so that 255
                // reaches full opacity instead of stopping one 256th short.
                blend(pixels[index]!, lit, alpha + (alpha >> 7));
        }

        index += width;
      }
    }
  }
}
