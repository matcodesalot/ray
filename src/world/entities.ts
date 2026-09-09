/**
 * Things in the world that are not walls.
 *
 * A sprite has no geometry — it is a flat picture that always faces the camera, drawn at a
 * position. That is the entire model, and it is why the original could afford hundreds of
 * them: no polygons, no rotation, just a scaled blit at a depth.
 *
 * The illusion holds because you cannot look up or down and cannot roll the camera, so a
 * billboard and a real cylinder are indistinguishable from any viewpoint the engine allows.
 * The moment a game let you look up, sprites had to start rotating or become models.
 */

export const SpriteKind = {
  Barrel: 0,
  Plant: 1,
  Lamp: 2,
  Column: 3,
} as const;

export type SpriteKind = (typeof SpriteKind)[keyof typeof SpriteKind];

/**
 * How big each kind stands in the world, in cell units.
 *
 * Kept here rather than with the artwork because it is a property of the *object*, not of
 * its picture: a barrel is 0.6 units across whatever texture you give it. Every sprite is
 * anchored with its feet on the floor, so `height` measures upward from there.
 *
 * `blocking` is the radius the object occupies for collision, or 0 for something you walk
 * straight through. It is deliberately *not* half the visual width: a barrel reads as solid
 * slightly inside its own silhouette, and matching the two exactly makes objects feel larger
 * than they look, because you stop before you appear to touch them.
 */
export interface SpriteSize {
  width: number;
  height: number;
  /** Collision radius in world units. Zero means the object does not block movement. */
  blocking: number;
}

export const SPRITE_SIZES: Readonly<Record<SpriteKind, SpriteSize>> = {
  [SpriteKind.Barrel]: { width: 0.62, height: 0.68, blocking: 0.26 },
  [SpriteKind.Plant]: { width: 0.72, height: 0.8, blocking: 0 },
  [SpriteKind.Lamp]: { width: 0.44, height: 0.95, blocking: 0.13 },
  [SpriteKind.Column]: { width: 0.58, height: 1, blocking: 0.25 },
};

/** Map characters that place a sprite. The cell underneath is ordinary floor. */
export const SPRITE_CHARS: Readonly<Record<string, SpriteKind>> = {
  b: SpriteKind.Barrel,
  g: SpriteKind.Plant,
  l: SpriteKind.Lamp,
  c: SpriteKind.Column,
};

export interface SpriteEntity {
  /** World position. Sprites sit at the centre of the cell that placed them. */
  x: number;
  y: number;
  kind: SpriteKind;
}
