/**
 * DEMO CODE — not part of the engine.
 *
 * A deliberately stupid patrol driver, here to prove the behaviour hook works and to give
 * the directional sprite code something that actually turns. It is the smallest thing that
 * exercises every part of Stage 14: it moves, so the view of it changes; it turns, so the
 * direction index sweeps through all eight cells; and it walks, so the animation runs.
 *
 * **Deleting this file must leave a working engine.** Nothing in `src/` imports it except
 * `main.ts`, in one line that the compiler will point at. That is the test of whether a
 * seam is real: if removing the example breaks the thing it was an example of, the logic
 * had leaked back into the engine.
 *
 * What it is not: enemy AI. There is no sight, no pursuit, no state machine, no reaction to
 * the player at all. Real behaviour is a game's business — see `docs/extending.md`.
 */

import { PLAYER_RADIUS } from '../config';
import { slideMove } from './collision';
import { SPRITE_SIZES, Animation, startAnimation, type Behaviour, type SpriteEntity } from './entities';
import type { GameMap } from './map';
import type { Player } from '../player';

/** World units per second. Comfortably below the player's walk so you can escape a demo. */
const PATROL_SPEED = 1.1;

/** Radians per second while turning. */
const TURN_SPEED = 2.4;

/** How far ahead to look for an obstruction, in world units. */
const LOOK_AHEAD = 0.55;

/** Per-entity scratch state, kept out of `SpriteEntity` because it is this demo's business. */
interface PatrolState {
  /** Radians still to turn through, signed. Zero means walking. */
  turning: number;
}

/**
 * Kept in a side table rather than on the entity, and populated lazily.
 *
 * A `WeakMap` because the engine owns the entities: when a game drops one, the demo's
 * bookkeeping should go with it rather than pinning it in memory. The lookup is not free,
 * but it is once per entity per tick against a handful of entities.
 */
const state = new WeakMap<SpriteEntity, PatrolState>();

/**
 * A behaviour that walks forward and turns away from whatever it bumps into.
 *
 * Turning is spread over several ticks rather than snapping, purely so the eight stored
 * views are visible in sequence — a snap turn would jump three cells at once and you would
 * never see whether the middle ones are in the right order.
 */
export const patrol: Behaviour = (entity, ctx) => {
  const own = state.get(entity) ?? { turning: 0 };
  state.set(entity, own);

  if (own.turning !== 0) {
    const step = Math.sign(own.turning) * Math.min(Math.abs(own.turning), TURN_SPEED * ctx.seconds);
    entity.angle += step;
    own.turning -= step;
    return;
  }

  const dirX = Math.cos(entity.angle);
  const dirY = Math.sin(entity.angle);
  const step = PATROL_SPEED * ctx.seconds;

  const beforeX = entity.x;
  const beforeY = entity.y;
  slideMove(ctx.map, entity, dirX * step, dirY * step, PLAYER_RADIUS, entity);

  // Barely moved, so something is in the way: turn a quarter circle, direction alternating
  // with position so a room full of them does not end up marching in lockstep.
  const travelled = Math.hypot(entity.x - beforeX, entity.y - beforeY);
  if (
    travelled < step * 0.5 ||
    blockedAhead(ctx.map, entity, dirX, dirY) ||
    playerAhead(ctx.player, entity, dirX, dirY)
  ) {
    own.turning = (Math.floor(entity.x + entity.y) & 1 ? 1 : -1) * (Math.PI / 2);
  }

  startAnimation(entity, Animation.Walk);
};

/** Whether the cell a short way ahead is solid. Cheaper than waiting to be stopped by it. */
function blockedAhead(map: GameMap, entity: SpriteEntity, dirX: number, dirY: number): boolean {
  const aheadX = entity.x + dirX * LOOK_AHEAD;
  const aheadY = entity.y + dirY * LOOK_AHEAD;
  return map.isSolid(Math.floor(aheadX), Math.floor(aheadY));
}

/**
 * Whether the player is close enough, and far enough in front, to be worth turning away from.
 *
 * The player is not in `map.sprites`, so nothing in the collision code knows they are there
 * and a patrolling monster will happily walk onto them. That overlap is survivable — since
 * stage 14 the grid keeps blocking whatever else is going on — but a creature standing
 * inside you looks wrong, so the demo avoids it. A real game with real enemies will want
 * something considerably less crude.
 */
function playerAhead(player: Player, entity: SpriteEntity, dirX: number, dirY: number): boolean {
  const dx = player.x - entity.x;
  const dy = player.y - entity.y;

  const reach = PLAYER_RADIUS + SPRITE_SIZES[entity.kind].blocking + LOOK_AHEAD;
  if (dx * dx + dy * dy > reach * reach) return false;

  // In front of it rather than behind: something you have already walked past is not in the way.
  return dx * dirX + dy * dirY > 0;
}

/**
 * Give every monster in a level the patrol behaviour.
 *
 * Called once at start-up. A real game would assign behaviours per spawn rather than by
 * kind, which is why this lives here and not in the map parser.
 */
export function attachDemoBehaviours(map: GameMap, kind: number): void {
  for (const sprite of map.sprites) {
    if (sprite.kind === kind) sprite.behaviour = patrol;
  }
}
