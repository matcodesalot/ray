import { check, done, near, readRuler, rulerTexture, section, solidTexture, stubDocument, textureSet } from '../lib/harness';

stubDocument();

import { PLAYER_RADIUS as R, TEX_SIZE, VIEW_H, VIEW_W } from '../../../src/config';
import { EventBus, GAME_EVENT_BASE, WorldEvent } from '../../../src/core/events';
import { rgb, TRANSPARENT } from '../../../src/engine/color';
import { Framebuffer } from '../../../src/engine/framebuffer';
import { Player } from '../../../src/player';
import { DEFAULT_RENDER_OPTIONS } from '../../../src/render/options';
import { OverlayStack, drawTexture } from '../../../src/render/overlay';
import { RayFan, castRay, createRayHit, lineOfSight } from '../../../src/render/raycast';
import { SpriteRenderer } from '../../../src/render/sprites';
import { circleHitsSolid } from '../../../src/world/collision';
import { SpriteKind, makeEntity } from '../../../src/world/entities';
import { parseMap } from '../../../src/world/map';

/**
 * The seams a game attaches to (Stage 17).
 *
 * Everything here exists because building a game on this engine ran into it. They are
 * checked like any other engine behaviour, because "the extension point works" is exactly
 * the claim nobody notices is false until somebody is halfway through relying on it.
 */

section('the world can gain and lose things');
{
  const room = parseMap(`
########
#......#
#..>...#
#......#
########
`);

  check('a level with no sprites starts empty', room.sprites.length, 0);

  const barrel = room.spawnEntity(makeEntity(4.5, 1.5, SpriteKind.Barrel));
  check('spawning adds it', room.sprites.length, 1);
  check('and it blocks straight away, with no rebuild', circleHitsSolid(room, 4.5, 1.5, R), true);

  check('despawning removes it', room.despawnEntity(barrel), true);
  check('and it stops blocking', circleHitsSolid(room, 4.5, 1.5, R), false);
  check('removing something twice reports the second time', room.despawnEntity(barrel), false);

  // Order is preserved, because a game may well be holding indices.
  const a = room.spawnEntity(makeEntity(2.5, 1.5, SpriteKind.Barrel));
  const b = room.spawnEntity(makeEntity(3.5, 1.5, SpriteKind.Lamp));
  const c = room.spawnEntity(makeEntity(4.5, 1.5, SpriteKind.Column));
  room.despawnEntity(b);
  check('the survivors keep their order', room.sprites.map((s) => s.kind), [a.kind, c.kind]);
}

section('the renderer grows rather than dropping what it cannot fit');
{
  /**
   * Until stage 17 `SpriteRenderer` clamped to the capacity it was built with, so a game
   * that spawned one entity more than the level file held would find that entity silently
   * never drawn. The check is that a renderer built for one sprite draws the same frame as
   * one built for all of them.
   */
  const room = parseMap(`
##########
#........#
#........#
#...>....#
#........#
#........#
##########
`);

  const textures = textureSet((label) => solidTexture(rgb(40 + label.length * 7, 90, 160)));
  const player = new Player(4.5, 3.5, 1, 0);
  const options = { ...DEFAULT_RENDER_OPTIONS, lighting: false };

  const fan = new RayFan(VIEW_W);
  fan.cast(room, player);

  for (let i = 0; i < 24; i++) {
    room.spawnEntity(makeEntity(5.5 + (i % 3) * 0.4, 1.6 + i * 0.1, SpriteKind.Barrel));
  }

  const render = (capacity: number): Uint32Array => {
    const fb = new Framebuffer(VIEW_W, VIEW_H);
    fb.clear(0);
    new SpriteRenderer(capacity).draw(fb, player, room.sprites, fan.hits, textures, options);
    return fb.pixels.slice();
  };

  const roomy = render(64);
  const cramped = render(1);

  let drawn = 0;
  for (const pixel of roomy) if (pixel !== 0) drawn++;
  check(`the sprites actually drew something (${drawn} pixels)`, drawn > 500, true);

  let differences = 0;
  for (let i = 0; i < roomy.length; i++) if (roomy[i] !== cramped[i]) differences++;
  check('a renderer built for one sprite draws all 24 identically', differences, 0);

  // Not vacuous: with fewer sprites the frame is genuinely different, so the comparison
  // above is capable of failing.
  const fb = new Framebuffer(VIEW_W, VIEW_H);
  fb.clear(0);
  new SpriteRenderer(64).draw(fb, player, room.sprites.slice(0, 3), fan.hits, textures, options);
  let fewerDifferences = 0;
  for (let i = 0; i < roomy.length; i++) if (roomy[i] !== fb.pixels[i]) fewerDifferences++;
  check('and drawing fewer sprites really does change the frame', fewerDifferences > 0, true);
}

section('line of sight');
{
  const level = parseMap(`
##########
#....#...#
#....#...#
#.>..D...#
#....#...#
#........#
##########
`);

  check('a clear line is visible', lineOfSight(level, 1.5, 1.5, 3.5, 4.5), true);
  check('a wall blocks it', lineOfSight(level, 1.5, 1.5, 8.5, 1.5), false);
  check('symmetric, as geometry should be', lineOfSight(level, 8.5, 1.5, 1.5, 1.5), false);
  check('a point sees itself', lineOfSight(level, 2.5, 2.5, 2.5, 2.5), true);

  // Round the corner: the gap in the wall at the bottom is the only way through.
  check('through the gap at the bottom', lineOfSight(level, 2.5, 5.5, 8.5, 5.5), true);

  // Doors work for free, because the DDA already knows about them.
  check('a closed door blocks sight', lineOfSight(level, 3.5, 3.5, 7.5, 3.5), false);
  level.doors.activate(5, 3);
  for (let i = 0; i < 120; i++) level.updateDoors(1 / 60, () => false);
  check('an open one does not', lineOfSight(level, 3.5, 3.5, 7.5, 3.5), true);

  /**
   * The negative control, and the trap this function exists to hide.
   *
   * `perpDist` is in ray lengths. Cast with an unnormalised direction — the natural thing to
   * write, since that is exactly what the renderer passes — and the comparison is wrong by
   * whatever the vector's length happened to be. Here it reports a wall you can plainly see
   * through as blocking.
   */
  const naive = (fromX: number, fromY: number, toX: number, toY: number): boolean => {
    const hit = createRayHit();
    castRay(level, fromX, fromY, toX - fromX, toY - fromY, hit);
    return hit.perpDist >= Math.hypot(toX - fromX, toY - fromY);
  };

  check(
    'forgetting to normalise gets a clear line wrong',
    naive(1.5, 1.5, 3.5, 4.5) !== lineOfSight(level, 1.5, 1.5, 3.5, 4.5),
    true,
  );
}

section('screen-space drawing');
{
  const fb = new Framebuffer(64, 48);
  const ruler = rulerTexture();

  // A quarter-size copy in the middle of the frame.
  fb.clear(0);
  drawTexture(fb, ruler, 16, 8, 32, 32);

  let painted = 0;
  for (const pixel of fb.pixels) if (pixel !== 0) painted++;
  check('it covers exactly the rectangle it was given', painted, 32 * 32);

  check('nothing outside it is touched', [fb.pixels[7 * 64 + 16], fb.pixels[8 * 64 + 15]], [0, 0]);

  // The ruler texture encodes its own coordinates, so where each texel landed is readable.
  const topLeft = readRuler(fb.pixels[8 * 64 + 16]!);
  const bottomRight = readRuler(fb.pixels[39 * 64 + 47]!);
  check('the first destination pixel samples near the texture origin', topLeft.tx <= 1 && topLeft.ty <= 1, true);
  check('the last samples near the far corner', bottomRight.tx >= TEX_SIZE - 2 && bottomRight.ty >= TEX_SIZE - 2, true);

  // Halfway across the destination is halfway across the texture, within half a texel.
  const middle = readRuler(fb.pixels[(8 + 16) * 64 + (16 + 16)]!);
  near('and halfway is halfway', middle.tx, TEX_SIZE / 2, 1.5);

  /**
   * The control for column-major storage: reading the same texture row-major would put a
   * *different* texel here, except on the diagonal. Sampling at an off-diagonal point is
   * what makes the check able to fail.
   */
  const offDiagonal = readRuler(fb.pixels[(8 + 4) * 64 + (16 + 24)]!);
  check('x and y are not interchangeable', offDiagonal.tx !== offDiagonal.ty, true);

  // Transparency: a texture that is entirely clear leaves the frame alone.
  fb.clear(0x1234);
  drawTexture(fb, { size: TEX_SIZE, data: new Uint32Array(TEX_SIZE * TEX_SIZE).fill(TRANSPARENT) }, 0, 0, 64, 48);
  let changed = 0;
  for (const pixel of fb.pixels) if (pixel !== 0x1234) changed++;
  check('fully transparent art paints nothing', changed, 0);

  // Clipping: a rectangle mostly off the edge draws only the part that is on screen.
  fb.clear(0);
  drawTexture(fb, ruler, -16, -8, 32, 32);
  let clipped = 0;
  for (const pixel of fb.pixels) if (pixel !== 0) clipped++;
  check('clipping at the top-left corner keeps only what fits', clipped, 16 * 24);

  fb.clear(0);
  drawTexture(fb, ruler, 0, 0, 0, 32);
  check('a zero-width rectangle draws nothing', fb.pixels.every((p) => p === 0), true);
}

section('overlay passes');
{
  const stack = new OverlayStack();
  const fb = new Framebuffer(8, 8);
  const player = new Player(1.5, 1.5, 1, 0);

  const ran: string[] = [];
  stack.add(() => ran.push('first'));
  const removeSecond = stack.add(() => ran.push('second'));

  stack.draw(fb, player, DEFAULT_RENDER_OPTIONS);
  check('passes run in the order they were added', ran, ['first', 'second']);

  ran.length = 0;
  removeSecond();
  stack.draw(fb, player, DEFAULT_RENDER_OPTIONS);
  check('and removing one leaves the rest', [ran, stack.count], [['first'], 1]);

  const empty = new OverlayStack();
  empty.draw(fb, player, DEFAULT_RENDER_OPTIONS);
  check('an empty stack is a no-op', empty.count, 0);
}

section('a game can put its own events on the bus');
{
  const bus = new EventBus();
  const GameEvent = { EnemyDied: GAME_EVENT_BASE, KeyPicked: GAME_EVENT_BASE + 1 } as const;

  const heard: number[] = [];
  bus.subscribe((event) => heard.push(event));

  bus.emit(WorldEvent.Footstep, 0, 0);
  bus.emit(GameEvent.EnemyDied, 3, 4);
  bus.emit(GameEvent.KeyPicked, 5, 6);

  check('engine and game events share one bus', heard, [WorldEvent.Footstep, GameEvent.EnemyDied, GameEvent.KeyPicked]);
  check('game codes start above every engine code', GAME_EVENT_BASE > Math.max(...Object.values(WorldEvent)), true);
}

done();
