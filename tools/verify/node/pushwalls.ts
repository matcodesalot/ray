import { check, near, section, done } from '../lib/harness';

import { PLAYER_RADIUS as R, PUSHWALL_TRAVEL_TIME } from '../../../src/config';
import { castRay, createRayHit } from '../../../src/render/raycast';
import { circleHitsSolid, slideMove } from '../../../src/world/collision';
import { parseMap } from '../../../src/world/map';
import { circleOverlapsBox } from '../../../src/world/occupancy';
import { PushwallSystem } from '../../../src/world/pushwalls';
import { Tile } from '../../../src/world/tiles';

/**
 * Pushwalls (Stage 15).
 *
 * The first solid surface in this engine that is not on a grid line, which is why it needs
 * its own suite: every distance the renderer produced before this one was landed on exactly
 * by the DDA, and this one is solved for. The checks below are all *displacement* checks —
 * the face is at this distance, the player stops here — rather than "nothing crashed".
 *
 * Each section parses its own map. A moving pushwall rewrites the tile grid, so sharing one
 * would let an earlier check change the world a later one is asserting about.
 */

/** A pushwall in the middle of a corridor, free to travel east. */
const corridor = () =>
  parseMap(`
#########
#.......#
#.>P....#
#.......#
#########
`);

/** A pushwall with a wall on all four sides. Nothing to push it into. */
const NOWHERE_TO_GO = `
#######
#.....#
#.###.#
#.#P#.#
#.###.#
#..>..#
#######
`;

/** A pushwall with one free cell east of it and a wall to the north. */
const cramped = () =>
  parseMap(`
#######
#.>P.##
#.....#
#######
`);

/** Nothing is standing anywhere. The callback doors and pushwalls both take. */
const clear = () => false;

/**
 * Drive a pushwall to a given travel through the real update path.
 *
 * Assigning `travel` directly would leave the tile grid describing where the box *was*,
 * which is exactly the state the renderer reads — so a test that did that would be checking
 * the box test against a world the game can never be in. The first version of this file did
 * assign it, and reported the renderer badly broken while collision, which reads the box
 * itself, quietly disagreed.
 */
function advanceTo(map: ReturnType<typeof parseMap>, travel: number): void {
  map.updatePushwalls(travel * PUSHWALL_TRAVEL_TIME, clear);
}

section('parsing and validation');
{
  const map = corridor();
  check('P is parsed as a pushwall tile', map.tileAt(3, 2), Tile.Pushwall);
  check('and registered with the system', map.pushwallAt(3, 2) !== undefined, true);
  check('at rest it is an ordinary solid wall', map.isSolid(3, 2), true);
  check('and it has not moved', [map.pushwallAt(3, 2)!.travel, map.pushwallAt(3, 2)!.moving], [0, false]);

  let rejected = '';
  try {
    parseMap(NOWHERE_TO_GO);
  } catch (error) {
    rejected = error instanceof Error ? error.message : String(error);
  }
  check('a pushwall walled in on all four sides is rejected at parse time', /walled in/.test(rejected), true);
}

section('pushing');
{
  const map = corridor();

  check('a cell with no pushwall reports nothing to push', map.push(4, 2, 1, 0), false);
  check('pushing east starts it', map.push(3, 2, 1, 0), true);
  check('and a second push is refused while it travels', map.push(3, 2, 1, 0), false);

  const wall = map.pushwallAt(3, 2)!;
  check('it knows how far it is going', [wall.distance, wall.dirX, wall.dirY], [2, 1, 0]);

  // Run it to the end at a fixed timestep, as the game does.
  for (let i = 0; i < 600 && wall.moving; i++) map.updatePushwalls(1 / 60, clear);

  check('it stops exactly on arrival', [wall.travel, wall.moving], [2, false]);
  check('the cell it came from is floor now', map.tileAt(3, 2), Tile.Floor);
  check('the cell it passed through is floor too', map.tileAt(4, 2), Tile.Floor);
  check('and where it ended up is wall', map.tileAt(5, 2), Tile.Pushwall);
  check('which is solid again', map.isSolid(5, 2), true);
  check('while the vacated cells are not', [map.isSolid(3, 2), map.isSolid(4, 2)], [false, false]);
}
{
  // Blocked after one cell: it goes as far as it can rather than refusing.
  const map = cramped();
  check('a push with one free cell is accepted', map.push(3, 1, 1, 0), true);
  check('and travels only that far', map.pushwallAt(3, 1)!.distance, 1);

  const wall = map.pushwallAt(3, 1)!;
  for (let i = 0; i < 600 && wall.moving; i++) map.updatePushwalls(1 / 60, clear);
  check('ending against the wall behind it', [wall.travel, map.tileAt(4, 1)], [1, Tile.Pushwall]);
}
{
  const map = cramped();
  check('a direction with a wall behind it is refused', map.push(3, 1, 0, -1), false);
  check('and leaves it untouched', map.pushwallAt(3, 1)!.moving, false);
}

section('the ray hits the box where the box is');
{
  const hit = createRayHit();

  for (const travel of [0, 0.25, 0.5, 0.75, 1, 1.5, 2]) {
    const map = corridor();
    map.push(3, 2, 1, 0);
    advanceTo(map, travel);

    // Looking east along the middle of the corridor from x = 1.5.
    castRay(map, 1.5, 2.5, 1, 0, hit);

    near(`travel ${travel}: the west face is at ${(3 + travel - 1.5).toFixed(2)}`, hit.perpDist, 3 + travel - 1.5, 1e-9);
    check(`travel ${travel}: reported as a pushwall`, hit.tile, Tile.Pushwall);
    check(`travel ${travel}: hit on an x-side`, hit.side, 0);
  }
}
{
  // Rays that go past it: the vacated part of a cell really is empty.
  const map = corridor();
  map.push(3, 2, 1, 0);
  advanceTo(map, 0.5);

  const hit = createRayHit();
  castRay(map, 1.5, 2.5, 1, 0, hit);
  near('a ray down the corridor stops at the box', hit.perpDist, 2, 1e-9);

  // A ray aimed through the strip the box has vacated must reach the far wall instead.
  castRay(map, 3.2, 1.5, 0, 1, hit);
  check('a ray through the vacated strip passes the origin cell', hit.mapY > 2, true);
}

section('the texture travels with the wall');
{
  /**
   * `wallX` is measured from the box, not from the cell.
   *
   * If it were measured from the cell, the artwork would stay pinned to the world while the
   * wall slid across it — brickwork flowing through stone. The check samples the same
   * *material* point on the north face at two different travels and asserts the coordinate
   * is the same, with the cell-relative reading asserted to differ as the control.
   */
  const sample = (travel: number) => {
    const map = corridor();
    map.push(3, 2, 1, 0);
    advanceTo(map, travel);

    // Straight down onto the north face, aimed a quarter of the way along the box.
    const targetX = 3 + travel + 0.25;
    const hit = createRayHit();
    castRay(map, targetX, 1.5, 0, 1, hit);
    return { wallX: hit.wallX, fromCell: hit.hitX - Math.floor(hit.hitX), side: hit.side };
  };

  const a = sample(0.25);
  const b = sample(0.75);

  check('both rays land on the north face', [a.side, b.side], [1, 1]);
  near('the material coordinate is the same at both travels', a.wallX, b.wallX, 1e-9);
  check('and it really is a quarter along', Math.abs(a.wallX - 0.25) < 1e-9 || Math.abs(a.wallX - 0.75) < 1e-9, true);
  check('the control: measured from the cell it would have drifted', Math.abs(a.fromCell - b.fromCell) > 0.4, true);
}

section('collision agrees with what is drawn');
{
  for (const travel of [0.3, 0.9, 1.4]) {
    const map = corridor();
    map.push(3, 2, 1, 0);
    advanceTo(map, travel);

    // Where the renderer says the face is, from the player's eye.
    const hit = createRayHit();
    castRay(map, 1.5, 2.5, 1, 0, hit);
    const drawn = 1.5 + hit.perpDist;

    // Where collision stops you, walking into it from the same place.
    const pos = { x: 1.5, y: 2.5 };
    for (let i = 0; i < 400; i++) slideMove(map, pos, 0.02, 0, R);

    near(`travel ${travel}: you stop exactly one radius short of the drawn face`, pos.x + R, drawn, 2e-3);
  }
}
{
  // The box sweeps you along ahead of it rather than passing through you... or rather, it
  // refuses to: the occupancy rule stops it. What must never happen is ending up inside it.
  const map = corridor();
  map.push(3, 2, 1, 0);
  const wall = map.pushwallAt(3, 2)!;

  const pos = { x: 6.5, y: 2.5 };
  let inside = 0;
  for (let i = 0; i < 600 && wall.moving; i++) {
    map.updatePushwalls(1 / 60, (minX, minY, maxX, maxY) =>
      circleOverlapsBox(pos.x, pos.y, R, minX, minY, maxX, maxY),
    );
    slideMove(map, pos, -0.03, 0, R);
    if (circleHitsSolid(map, pos.x, pos.y, R)) inside++;
  }
  // Not vacuous: it really did travel before the approaching player made it hold.
  check(`the wall travelled before holding (${wall.travel.toFixed(2)} cells)`, wall.travel > 0.25, true);
  check('walking into a travelling pushwall never puts you inside it', inside, 0);
  check('and you end up in front of it', pos.x > PushwallSystem.boxX(wall) + 1, true);
}

section('it will not close on you');
{
  const map = corridor();
  const wall = map.pushwallAt(3, 2)!;
  map.push(3, 2, 1, 0);

  // Somebody standing directly in its path, a cell and a half ahead.
  const blocker = { x: 5, y: 2.5 };
  const occupied = (minX: number, minY: number, maxX: number, maxY: number) =>
    circleOverlapsBox(blocker.x, blocker.y, R, minX, minY, maxX, maxY);

  for (let i = 0; i < 300; i++) map.updatePushwalls(1 / 60, occupied);

  check('it stops before it would touch them', wall.travel > 0 && wall.travel < 1, true);
  near('one radius short, and no further', wall.cellX + wall.travel + 1, blocker.x - R, 1e-2);
  check('and is still on its way', wall.moving, true);

  // Step out of the way and it carries on.
  for (let i = 0; i < 600 && wall.moving; i++) map.updatePushwalls(1 / 60, clear);
  check('once you move, it arrives', [wall.travel, wall.moving], [2, false]);
}

section('you can follow it in (the bug that was reported)');
{
  /**
   * Pushing a secret and walking after it must not stop it.
   *
   * The occupancy question used to be asked about **cells**, which is right for a door — its
   * slab fills one — and wrong for a pushwall, whose box spans two cells while it travels and
   * covers only part of each. The moment the wall started moving, the player pressed against
   * it (the only place you can be when you push it) overlapped a cell the box still partly
   * covered, and it stopped dead. Worse than a stutter: the hold never released, because the
   * wall had to move for the player to stop overlapping it and could not.
   *
   * The box always travels away from whoever pushed it, so asked geometrically the question
   * can never be true for the pusher.
   */
  const corridorLevel = () =>
    parseMap(`
#########
#.>P....#
#########
`);

  const run = (walking: boolean): { travel: number; playerX: number; moving: boolean } => {
    const map = corridorLevel();
    const wall = map.pushwallAt(3, 1)!;

    // Pressed right up against the secret, exactly as you are when you use it.
    const pos = { x: 3 - R, y: 1.5 };
    map.push(3, 1, 1, 0);

    for (let i = 0; i < 60 * 5; i++) {
      if (walking) slideMove(map, pos, 0.05, 0, R);
      map.updatePushwalls(1 / 60, (minX, minY, maxX, maxY) =>
        circleOverlapsBox(pos.x, pos.y, R, minX, minY, maxX, maxY),
      );
    }

    return { travel: wall.travel, playerX: pos.x, moving: wall.moving };
  };

  const still = run(false);
  const walking = run(true);

  check('standing still, it travels the full two cells', [still.travel, still.moving], [2, false]);
  check('and walking after it, it still does', [walking.travel, walking.moving], [2, false]);
  check('so you end up inside what it opened', walking.playerX > 4, true);

  // The control: with the old cell-shaped question this deadlocked at travel ~0.01, so a
  // check that only looked at the standing case would have passed throughout.
  check('the two agree, which is the whole point', still.travel, walking.travel);
}

section('travel is frame-rate independent');
{
  const run = (tick: number) => {
    const map = corridor();
    map.push(3, 2, 1, 0);
    const wall = map.pushwallAt(3, 2)!;
    let elapsed = 0;
    while (wall.moving && elapsed < 60) {
      map.updatePushwalls(tick, clear);
      elapsed += tick;
    }
    return elapsed;
  };

  const fast = run(1 / 240);
  const slow = run(1 / 30);
  check(`the same journey takes the same time at 240 Hz and 30 Hz (${fast.toFixed(2)}s vs ${slow.toFixed(2)}s)`,
        Math.abs(fast - slow) < 0.05, true);
}

done();
