import { check, near, section, done } from '../lib/harness';

import { circleHitsSolid, slideMove, NO_ENTITIES } from '../../../src/world/collision';
import { parseMap } from '../../../src/world/map';
import { Player } from '../../../src/player';
import { LEVEL_1 } from '../../../src/world/levels/level1';
import { SPRITE_SIZES, SpriteKind } from '../../../src/world/entities';
import { PLAYER_RADIUS as R } from '../../../src/config';

/**
 * Collision, grid and entities (Stages 8 and 13).
 *
 * The Stage 8 properties are here as well as the new ones: making sprites solid touches the
 * same two functions the corner bugs lived in, so the old guarantees need re-checking every
 * time, not just the new behaviour.
 */

const BARREL = SPRITE_SIZES[SpriteKind.Barrel].blocking;
const CONTACT = R + BARREL;

/** One blocking barrel in an open room, well clear of the walls. */
const room = parseMap(`
##########
#........#
#........#
#...b....#
#........#
#...>....#
#........#
##########
`);
const BARREL_X = 4.5;
const BARREL_Y = 3.5;

section('entities block, or do not, according to their radius');

check('the barrel was parsed as a sprite', room.sprites.length, 1);
check('and its cell is ordinary floor', room.isSolid(4, 3), false);
check('standing on the barrel overlaps', circleHitsSolid(room, BARREL_X, BARREL_Y, R), true);
check('just inside contact overlaps', circleHitsSolid(room, BARREL_X, BARREL_Y + CONTACT - 1e-6, R), true);
check('just outside contact is clear', circleHitsSolid(room, BARREL_X, BARREL_Y + CONTACT + 1e-6, R), false);
check('exactly touching is not overlapping', circleHitsSolid(room, BARREL_X, BARREL_Y + CONTACT, R), false);

{
  // A plant has blocking 0, so it must be walk-through.
  const leafy = parseMap(`
#######
#.....#
#..g..#
#..>..#
#######
`);
  check('the plant has a zero blocking radius', SPRITE_SIZES[SpriteKind.Plant].blocking, 0);
  check('and does not obstruct', circleHitsSolid(leafy, 3.5, 2.5, R), false);

  const pos = { x: 3.5, y: 3.5 };
  for (let i = 0; i < 120; i++) slideMove(leafy, pos, 0, -0.02, R);
  check('you walk straight through it', pos.y < 2.4, true);
}

section('resting against an entity');
{
  const pos = { x: BARREL_X, y: 5.5 };
  for (let i = 0; i < 400; i++) slideMove(room, pos, 0, -0.02, R);
  near('rests at exactly the summed radii', pos.y, BARREL_Y + CONTACT, 1e-3);
  check('with no sideways drift', pos.x, BARREL_X);
}
{
  // As with walls, where you stop must not depend on how fast you arrived.
  const resting: number[] = [];
  for (const speed of [0.005, 0.02, 0.05, 0.09]) {
    const pos = { x: BARREL_X, y: 5.5 };
    for (let i = 0; i < 500; i++) slideMove(room, pos, 0, -speed, R);
    resting.push(pos.y);
  }
  const spread = Math.max(...resting) - Math.min(...resting);
  check(`resting distance is independent of approach speed (spread ${spread.toExponential(1)})`, spread < 1e-3, true);
}

section('sliding around an entity');
{
  // Aiming dead at the centre is a purely radial push and *should* stop, exactly as
  // pushing straight into a corner does. What must not happen is freezing when there is a
  // tangential component to slide on, so the sweep is over impact parameters: how far off
  // centre the approach is aimed.
  let frozen = 0;
  let inside = 0;
  let tested = 0;

  for (let deg = 0; deg < 360; deg += 6) {
    const rad = (deg * Math.PI) / 180;
    const dirX = Math.cos(rad);
    const dirY = Math.sin(rad);
    // Perpendicular to the approach, to offset the aim sideways.
    const perpX = -dirY;
    const perpY = dirX;

    for (const offset of [-0.9, -0.55, -0.25, 0.25, 0.55, 0.9]) {
      const b = offset * CONTACT;
      const pos = {
        x: BARREL_X - dirX * 2 + perpX * b,
        y: BARREL_Y - dirY * 2 + perpY * b,
      };
      if (circleHitsSolid(room, pos.x, pos.y, R)) continue;

      const start = { ...pos };
      for (let i = 0; i < 300; i++) slideMove(room, pos, dirX * 0.03, dirY * 0.03, R);

      tested++;
      if (circleHitsSolid(room, pos.x, pos.y, R)) inside++;

      // Having slid past, the body should be well beyond where it started. Anything still
      // pinned to the barrel having barely moved has frozen on it.
      const travelled = Math.hypot(pos.x - start.x, pos.y - start.y);
      const onBarrel = Math.abs(Math.hypot(pos.x - BARREL_X, pos.y - BARREL_Y) - CONTACT) < 0.02;
      if (onBarrel && travelled < 2.2) frozen++;
    }
  }
  check(`${tested} off-centre approaches, none end inside the barrel`, inside, 0);
  check('and none freeze against it', frozen, 0);
}
{
  // The control: aimed exactly at the centre there is nothing to slide along, so stopping
  // is the correct answer and this test would be meaningless if it never happened.
  const pos = { x: BARREL_X, y: BARREL_Y + 2 };
  for (let i = 0; i < 300; i++) slideMove(room, pos, 0, -0.03, R);
  near('a dead-centre push stops at contact, as it should', pos.y, BARREL_Y + CONTACT, 1e-3);
}

section('escaping from inside an entity');
{
  const pos = { x: BARREL_X + 0.05, y: BARREL_Y + 0.05 };
  check('starts overlapping', circleHitsSolid(room, pos.x, pos.y, R), true);
  for (let i = 0; i < 300; i++) slideMove(room, pos, 0.02, 0.02, R);
  check('can walk out rather than being trapped', circleHitsSolid(room, pos.x, pos.y, R), false);
}

section('an entity that walks into you (Stage 14)');
{
  /**
   * The reported bug: standing next to a monster and a wall, you walked through the wall.
   *
   * Until entities could move, an overlap meant a badly authored level, and `slideMove`
   * escaped it by letting the move happen unchecked — which disabled collision against
   * *everything*, the grid included. Once monsters walk into you that state arrives every
   * few seconds, and the escape hatch became a hole in the world.
   */
  const corridor = parseMap(`
#######
#.....#
#..m..#
#..>..#
#######
`);
  const monster = corridor.sprites[0]!;
  const MONSTER = SPRITE_SIZES[SpriteKind.Monster].blocking;

  // The monster has walked onto a player standing against the north wall.
  monster.x = 3.5;
  monster.y = 1.6;
  const pos = { x: 3.5, y: 1.5 };

  check('the body is inside the entity', circleHitsSolid(corridor, pos.x, pos.y, R), true);
  check('and not inside a wall', circleHitsSolid(corridor, pos.x, pos.y, R, NO_ENTITIES), false);

  for (let i = 0; i < 60; i++) slideMove(corridor, pos, 0, -0.09, R);
  near('pushing into the wall stops at its face', pos.y, 1 + R, 1e-3);
  check('rather than leaving the level', pos.y > 0, true);

  // The escape itself must survive: you can still walk out of what walked into you.
  monster.x = 3.5;
  monster.y = 1.6;
  const out = { x: 3.5, y: 1.6 };
  for (let i = 0; i < 60; i++) slideMove(corridor, out, 0.06, 0, R);
  check('and you can still walk out of it', circleHitsSolid(corridor, out.x, out.y, R), false);
  near('stopping at the east wall like anything else', out.x, 6 - R, 1e-3);

  /**
   * The wall escape it replaced still works. A body genuinely inside the grid — a spawn
   * placed badly, or a radius raised at run time — must be able to walk out, or it is
   * trapped forever.
   */
  const inWall = { x: 1.1, y: 1.1 };
  check('a body inside a wall is detected as such', circleHitsSolid(corridor, inWall.x, inWall.y, R, NO_ENTITIES), true);
  slideMove(corridor, inWall, 0.09, 0.09, R);
  check('and is still allowed to move out unchecked', inWall.x > 1.1, true);

  // A monster parked on top of a randomly moving body must never let it through a wall.
  let seed = 9001;
  const rand = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  const body = { x: 3.5, y: 2.5 };
  let escaped = 0;
  for (let i = 0; i < 200_000; i++) {
    monster.x = body.x + (rand() - 0.5) * MONSTER;
    monster.y = body.y + (rand() - 0.5) * MONSTER;
    slideMove(corridor, body, (rand() * 2 - 1) * 0.09, (rand() * 2 - 1) * 0.09, R);
    if (circleHitsSolid(corridor, body.x, body.y, R, NO_ENTITIES)) escaped++;
  }
  check('200000 random moves with a monster sitting on you, never inside a wall', escaped, 0);
  check('and still in the room', body.x > 1 && body.x < 6 && body.y > 1 && body.y < 4, true);
}

section('Stage 8 guarantees still hold');
{
  const corridor = parseMap(`
########
#......#
#..>...#
########
`);
  const pos = { x: 3.5, y: 1.5 };
  const startX = pos.x;
  for (let i = 0; i < 30; i++) slideMove(corridor, pos, 0.05, -0.05, R);
  near('the blocked axis stops at the wall face', pos.y, 1 + R, 1e-3);
  check('the free axis keeps going', pos.x > startX + 1, true);
}
{
  // Escaping an inside corner: the bug that had to be fixed twice.
  const room2 = parseMap(`
######
#....#
#....#
#..>.#
#....#
######
`);
  const SPEED = 0.05;
  const settled = { x: 2.5, y: 2.5 };
  for (let i = 0; i < 400; i++) slideMove(room2, settled, -SPEED, -SPEED, R);

  let wrong = 0;
  for (let deg = 0; deg < 360; deg += 1) {
    const rad = (deg * Math.PI) / 180;
    const dx = Math.cos(rad) * SPEED;
    const dy = Math.sin(rad) * SPEED;
    const pos = { x: settled.x, y: settled.y };
    slideMove(room2, pos, dx, dy, R);
    // Pressed into a corner the permitted motion is each component clamped at zero.
    const wantX = Math.max(dx, 0);
    const wantY = Math.max(dy, 0);
    if (Math.hypot(pos.x - settled.x - wantX, pos.y - settled.y - wantY) > SPEED * 0.05) wrong++;
  }
  check('all 360 directions still slide correctly out of a corner', wrong, 0);
}

section('random walk through the real level');
{
  let seed = 12345;
  const rand = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };

  const player = Player.atSpawn(LEVEL_1);
  let bad = 0;
  let moved = 0;
  const steps = 400_000;
  for (let i = 0; i < steps; i++) {
    player.rotate((rand() - 0.5) * 0.4);
    const before = { x: player.x, y: player.y };
    player.move((rand() * 2 - 1) * 0.09, (rand() * 2 - 1) * 0.09, LEVEL_1);
    if (circleHitsSolid(LEVEL_1, player.x, player.y, R)) bad++;
    if (player.x !== before.x || player.y !== before.y) moved++;
  }
  check(`never inside a wall or an entity after ${steps} random moves`, bad, 0);
  check('and the walk actually moved', moved > steps * 0.9, true);
  check('and never escaped the level', player.x > 0 && player.x < 24 && player.y > 0 && player.y < 24, true);
}

done();
