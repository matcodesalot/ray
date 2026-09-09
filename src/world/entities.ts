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

import type { Player } from '../player';
import type { GameMap } from './map';

export const SpriteKind = {
  Barrel: 0,
  Plant: 1,
  Lamp: 2,
  Column: 3,
  Monster: 4,
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
  [SpriteKind.Monster]: { width: 0.85, height: 0.92, blocking: 0.3 },
};

/** Map characters that place a sprite. The cell underneath is ordinary floor. */
export const SPRITE_CHARS: Readonly<Record<string, SpriteKind>> = {
  b: SpriteKind.Barrel,
  g: SpriteKind.Plant,
  l: SpriteKind.Lamp,
  c: SpriteKind.Column,
  m: SpriteKind.Monster,
};

/**
 * Animation names. Referenced by world code, mapped to sheet rows by the manifest.
 *
 * Kept as constants rather than bare strings so a typo is a compile error rather than an
 * entity that silently stops animating.
 */
export const Animation = {
  Walk: 'walk',
  Death: 'death',
} as const;

export type Animation = (typeof Animation)[keyof typeof Animation];

export interface SpriteEntity {
  /** World position. Sprites sit at the centre of the cell that placed them. */
  x: number;
  y: number;
  kind: SpriteKind;

  /**
   * Which way the entity faces, in radians, in the same y-down frame as the player.
   *
   * Meaningless for a barrel, which looks the same from everywhere, and simply ignored for
   * kinds whose artwork is a single image. For anything drawn from a directional sheet it is
   * what decides which of the eight stored views you see.
   */
  angle: number;

  /** Which animation is playing, and where in it. */
  animation: Animation;
  frame: number;

  /**
   * Seconds accumulated toward the next frame.
   *
   * Advanced in `update()` and never in `render()`. Animation timed off the render loop
   * would run at whatever rate the display happens to refresh at — the same reason door
   * travel is driven from the fixed timestep.
   */
  frameClock: number;

  /**
   * Optional per-tick logic. Undefined for scenery, which is most things.
   *
   * The engine never sets this: it is the hook a game hangs enemy AI on. See `Behaviour`.
   */
  behaviour?: Behaviour;
}

/** A sprite entity with its animation state initialised. */
export function makeEntity(x: number, y: number, kind: SpriteKind, angle = 0): SpriteEntity {
  return { x, y, kind, angle, animation: Animation.Walk, frame: 0, frameClock: 0 };
}

/**
 * How an animation is timed. The renderer's business is which cell to draw; this is how
 * long it stays there, and it comes from the artwork — see `assets/manifest.ts`.
 */
export interface AnimationTiming {
  frames: number;
  frameSeconds: number;
  loop: boolean;
}

/** Where an entity's animation timings come from. Supplied by the caller so `world/` need not know about assets. */
export type TimingLookup = (kind: SpriteKind, animation: Animation) => AnimationTiming | undefined;

/**
 * What a behaviour is given to decide with.
 *
 * Deliberately the whole world and the player, not a curated subset. Guessing now at what a
 * game's enemies will need to see is how you end up widening this interface once per feature;
 * the engine has nothing to hide from them.
 */
export interface BehaviourContext {
  map: GameMap;
  player: Player;
  /** Seconds since the last tick. Always the fixed timestep, never a render delta. */
  seconds: number;
}

/**
 * The seam a game attaches enemy logic to.
 *
 * The engine calls it once per entity per tick and does nothing else with it. Everything a
 * behaviour needs to affect — position, facing, which animation is playing — is a plain
 * mutable field on the entity, so there is no command queue to learn and nothing to register.
 * `world/demo-patrol.ts` is a worked example and is safe to delete.
 */
export type Behaviour = (entity: SpriteEntity, ctx: BehaviourContext) => void;

/**
 * Run behaviours and advance animation, once per fixed tick.
 *
 * The order matters: a behaviour that switches animation this tick should have its first
 * frame shown this tick, not next, so behaviours run first. `startAnimation` resets the
 * clock, which is why switching mid-frame does not inherit a part-elapsed one.
 */
export function updateEntities(
  entities: readonly SpriteEntity[],
  ctx: BehaviourContext,
  timing: TimingLookup,
): void {
  for (const entity of entities) {
    entity.behaviour?.(entity, ctx);
    advanceAnimation(entity, ctx.seconds, timing(entity.kind, entity.animation));
  }
}

/** Switch animation, restarting it. A no-op if it is already the one playing. */
export function startAnimation(entity: SpriteEntity, animation: Animation): void {
  if (entity.animation === animation) return;
  entity.animation = animation;
  entity.frame = 0;
  entity.frameClock = 0;
}

/**
 * Move an entity's animation on by `seconds`.
 *
 * A `while` rather than an `if`: at a 60 Hz tick and a 0.11 s frame time one tick never
 * crosses two frames, but a slower animation on a coarser timestep would, and dropping the
 * surplus would make animations quietly run slow in exactly the case they are most visible.
 *
 * Non-looping animations stop on the last frame rather than wrapping or vanishing — a death
 * animation ends as a corpse, which is the behaviour a game wants and the reason `loop` is
 * a property of the artwork rather than something the caller has to remember.
 */
export function advanceAnimation(
  entity: SpriteEntity,
  seconds: number,
  timing: AnimationTiming | undefined,
): void {
  if (!timing || timing.frames <= 1 || timing.frameSeconds <= 0) return;

  entity.frameClock += seconds;

  while (entity.frameClock >= timing.frameSeconds) {
    entity.frameClock -= timing.frameSeconds;

    if (entity.frame + 1 < timing.frames) {
      entity.frame++;
    } else if (timing.loop) {
      entity.frame = 0;
    } else {
      entity.frame = timing.frames - 1;
      entity.frameClock = 0;
      return;
    }
  }
}
