import { check, done, section, solidTexture, stubDocument, textureSet, unpack } from '../lib/harness';

stubDocument();

import { TEX_SIZE } from '../../../src/config';
import { sheetFromPixels, spriteCell, type SpriteSheet } from '../../../src/assets/decode';
import { rgb } from '../../../src/engine/color';
import { Framebuffer } from '../../../src/engine/framebuffer';
import { Player } from '../../../src/player';
import { DEFAULT_RENDER_OPTIONS } from '../../../src/render/options';
import { RayFan } from '../../../src/render/raycast';
import { SpriteRenderer, directionIndex } from '../../../src/render/sprites';
import {
  Animation,
  advanceAnimation,
  makeEntity,
  startAnimation,
  updateEntities,
  SpriteKind,
  type SpriteEntity,
} from '../../../src/world/entities';
import { parseMap } from '../../../src/world/map';

/**
 * Directional and animated sprites (Stage 14).
 *
 * The thing under test is a *convention*: which cell of a sheet means "seen from the
 * front", and which way the other seven go round. Conventions are exactly what eyeballing
 * cannot check — a mirrored monster looks like a monster — and this project has already
 * shipped six stages with every wall texture flipped, found only by measuring.
 *
 * So every check below has a negative control: a deliberately wrong version of the same
 * computation, asserted to give a *different* answer. A test that passes under both the
 * right and the wrong implementation is not testing anything.
 */

const DIRECTIONS = 8;
const ROWS = 3;

/** A distinguishable colour per cell, recoverable from a single pixel. */
const cellColour = (column: number, row: number): number => rgb(10 + column * 20, 10 + row * 60, 200);

/**
 * A synthetic sheet: DIRECTIONS columns by ROWS rows, every cell a flat identifying colour.
 *
 * Flat cells on purpose. The question here is *which cell got used*, and a texture that
 * answers that from any pixel keeps the sampling arithmetic out of the way — that is what
 * the ruler texture in `renderer.ts` already covers.
 */
function syntheticSheet(): Uint8ClampedArray {
  const width = TEX_SIZE * DIRECTIONS;
  const height = TEX_SIZE * ROWS;
  const pixels = new Uint8ClampedArray(width * height * 4);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = unpack(cellColour((x / TEX_SIZE) | 0, (y / TEX_SIZE) | 0));
      const at = (y * width + x) * 4;
      pixels[at] = r;
      pixels[at + 1] = g;
      pixels[at + 2] = b;
      pixels[at + 3] = 255;
    }
  }

  return pixels;
}

section('a sheet slices into cells, addressed row-major');
{
  const sliced = sheetFromPixels(syntheticSheet(), TEX_SIZE * DIRECTIONS, TEX_SIZE * ROWS, 'synthetic');

  check('columns are directions', sliced.columns, DIRECTIONS);
  check('rows are animation frames', sliced.rows, ROWS);
  check('one texture per cell', sliced.cells.length, DIRECTIONS * ROWS);

  let wrong = 0;
  let transposedMatches = 0;
  for (let row = 0; row < ROWS; row++) {
    for (let column = 0; column < DIRECTIONS; column++) {
      const cell = sliced.cells[row * DIRECTIONS + column]!;
      // Sample well inside the cell, and at two corners: a slice that is off by a row or a
      // column would still get the middle right whenever neighbours happen to agree.
      for (const [x, y] of [[1, 1], [TEX_SIZE - 2, 1], [TEX_SIZE - 2, TEX_SIZE - 2]] as const) {
        if (cell.data[x * TEX_SIZE + y] !== cellColour(column, row)) wrong++;
      }

      // Negative control: reading the grid transposed must be wrong except where the two
      // indexings coincide. If this ever reports every cell matching, the sheet is square
      // and symmetric and the check above proves nothing.
      const transposed = sliced.cells[column * ROWS + row];
      if (transposed && transposed.data[TEX_SIZE + 1] === cellColour(column, row)) transposedMatches++;
    }
  }

  check('every cell holds its own colour', wrong, 0);
  check('and reading it transposed does not', transposedMatches < DIRECTIONS * ROWS, true);
}

section('direction: column 0 is the entity looking at you');
{
  // The entity stands at the origin facing east — +x, and +y is south, the same y-down
  // frame the player uses.
  const from = (x: number, y: number, angle = 0): number =>
    directionIndex(angle, 0, 0, x, y, DIRECTIONS);

  check('viewer in front, facing east', from(1, 0), 0);
  check('viewer behind', from(-1, 0), 4);

  /**
   * The two flanks, and the only checks that can catch a mirrored sheet.
   *
   * Viewer to the south, entity facing east: the viewer looks north, so their screen-right
   * is east, and the entity is facing across the screen to the right. That is the view
   * stored in column 6 of the artwork — column 2 shows the creature facing screen-left.
   * Front and back are symmetric and agree under either sign, which is precisely why a
   * mirrored sheet survives casual inspection.
   */
  check('viewer to the south sees the entity facing screen-right', from(0, 1), 6);
  check('viewer to the north sees it facing screen-left', from(0, -1), 2);

  check('diagonals land on the odd cells', [from(1, 1), from(1, -1), from(-1, 1), from(-1, -1)], [7, 1, 5, 3]);

  // Rotating the entity and the viewer together must not change what you see.
  let drift = 0;
  for (let a = 0; a < Math.PI * 2; a += 0.11) {
    for (let k = 0; k < DIRECTIONS; k++) {
      const viewer = a + (k * Math.PI * 2) / DIRECTIONS;
      const expected = directionIndex(0, 0, 0, Math.cos(viewer - a), Math.sin(viewer - a), DIRECTIONS);
      if (directionIndex(a, 0, 0, Math.cos(viewer), Math.sin(viewer), DIRECTIONS) !== expected) drift++;
    }
  }
  check('the index depends only on the relative angle', drift, 0);

  // Negative control: the opposite sign convention. It must agree on the axis of symmetry
  // and disagree on the flanks — if it agreed everywhere, the checks above would be blind.
  const flipped = (x: number, y: number): number =>
    Math.round(Math.atan2(y - 0, x - 0) / (Math.PI / 4)) & (DIRECTIONS - 1);
  check('the wrong sign agrees on front and back', [flipped(1, 0), flipped(-1, 0)], [from(1, 0), from(-1, 0)]);
  check('and disagrees on both flanks', [flipped(0, 1) !== from(0, 1), flipped(0, -1) !== from(0, -1)], [true, true]);

  check('a single-cell sheet always uses cell 0', directionIndex(2.4, 0, 0, 3, -1, 1), 0);
}

section('the renderer draws the cell the direction picks');
{
  const sliced = sheetFromPixels(syntheticSheet(), TEX_SIZE * DIRECTIONS, TEX_SIZE * ROWS, 'synthetic');
  const sheet: SpriteSheet = {
    columns: sliced.columns,
    rows: sliced.rows,
    cells: sliced.cells,
    animations: {
      [Animation.Walk]: { firstRow: 0, frames: 2, frameSeconds: 0.1, loop: true },
      [Animation.Death]: { firstRow: 2, frames: 1, frameSeconds: 0.1, loop: false },
    },
  };
  const textures = textureSet(() => solidTexture(rgb(1, 1, 1)), { [SpriteKind.Monster]: sheet });

  check('a kind with no sheet resolves to no cell', spriteCell(textures, SpriteKind.Barrel, Animation.Walk, 0, 0), undefined);
  check(
    'an unknown animation falls back to the missing texture',
    spriteCell(textures, SpriteKind.Monster, 'nope', 0, 0) === textures.missing,
    true,
  );
  check(
    'a frame past the end of an animation clamps to its last',
    spriteCell(textures, SpriteKind.Monster, Animation.Walk, 9, 3) === sheet.cells[1 * DIRECTIONS + 3],
    true,
  );

  const W = 320;
  const H = 200;
  const fb = new Framebuffer(W, H);
  const fan = new RayFan(W);
  const options = { ...DEFAULT_RENDER_OPTIONS, lighting: false };
  const renderer = new SpriteRenderer(1);

  const room = parseMap(`
#########
#.......#
#.......#
#...>...#
#.......#
#.......#
#########
`);

  /**
   * Stand two units away *in the given compass direction from the entity*, look back at it,
   * and report the colour it was drawn in.
   *
   * `(vx, vy)` is where the viewer stands, so the look direction is its negation. Naming
   * that the other way round is how the first version of this check placed every viewer on
   * the opposite side of the monster and reported the renderer four cells out.
   */
  const seen = (vx: number, vy: number, entity: SpriteEntity): number => {
    const player = new Player(4.5 + vx * 2, 3.5 + vy * 2, -vx, -vy);
    fan.cast(room, player);
    fb.clear(0);
    entity.x = 4.5;
    entity.y = 3.5;
    renderer.draw(fb, player, [entity], fan.hits, textures, options);

    const counts = new Map<number, number>();
    for (const pixel of fb.pixels) if (pixel !== 0) counts.set(pixel, (counts.get(pixel) ?? 0) + 1);
    let best = 0;
    let most = 0;
    for (const [colour, n] of counts) if (n > most) { most = n; best = colour; }
    return best;
  };

  const monster = makeEntity(4.5, 3.5, SpriteKind.Monster, 0); // facing east
  check('looked at from the east, the front view is drawn', seen(1, 0, monster), cellColour(0, 0));
  check('from the west, the back view', seen(-1, 0, monster), cellColour(4, 0));
  check('from the south, column 6', seen(0, 1, monster), cellColour(6, 0));
  check('from the north, column 2', seen(0, -1, monster), cellColour(2, 0));

  monster.frame = 1;
  check('the second walk frame comes from the next row', seen(1, 0, monster), cellColour(0, 1));

  startAnimation(monster, Animation.Death);
  check('and the death animation from the row its spec names', seen(1, 0, monster), cellColour(0, 2));

  // Negative control for the whole path: if the renderer ignored direction entirely, every
  // viewpoint would give the same colour. They must not.
  startAnimation(monster, Animation.Walk);
  const around = new Set([seen(1, 0, monster), seen(-1, 0, monster), seen(0, 1, monster), seen(0, -1, monster)]);
  check('walking round it shows four different views', around.size, 4);
}

section('animation advances on the clock, not the frame rate');
{
  const walk = { frames: 4, frameSeconds: 0.16, loop: true };
  const death = { frames: 3, frameSeconds: 0.1, loop: false };
  const tick = 1 / 60;

  const entity = makeEntity(0, 0, SpriteKind.Monster);
  advanceAnimation(entity, 0.15, walk);
  check('under one frame time, nothing changes', entity.frame, 0);
  advanceAnimation(entity, 0.02, walk);
  check('crossing it advances one frame', entity.frame, 1);

  // Sixty ticks is one second: a 0.16 s frame time means 6.25 frames, so a 4-frame loop
  // ends on frame 2 with a quarter frame banked. The banked remainder is the point — drop
  // it and the animation quietly runs slow.
  const looper = makeEntity(0, 0, SpriteKind.Monster);
  for (let i = 0; i < 60; i++) advanceAnimation(looper, tick, walk);
  check('a looping animation wraps', looper.frame, Math.floor((1 / 0.16) % 4));
  check('and keeps the remainder', looper.frameClock > 0 && looper.frameClock < 0.16, true);

  const dying = makeEntity(0, 0, SpriteKind.Monster);
  startAnimation(dying, Animation.Death);
  for (let i = 0; i < 600; i++) advanceAnimation(dying, tick, death);
  check('a one-shot animation stops on its last frame', dying.frame, death.frames - 1);

  // One big step must land where many small ones do: this is what makes it independent of
  // how often it is called.
  const coarse = makeEntity(0, 0, SpriteKind.Monster);
  const fine = makeEntity(0, 0, SpriteKind.Monster);
  advanceAnimation(coarse, 1, walk);
  for (let i = 0; i < 100; i++) advanceAnimation(fine, 0.01, walk);
  check('one long step matches a hundred short ones', coarse.frame, fine.frame);

  check('switching animation restarts it', (() => {
    const e = makeEntity(0, 0, SpriteKind.Monster);
    e.frame = 3;
    e.frameClock = 0.09;
    startAnimation(e, Animation.Death);
    return [e.animation, e.frame, e.frameClock];
  })(), [Animation.Death, 0, 0]);

  check('switching to the animation already playing keeps its progress', (() => {
    const e = makeEntity(0, 0, SpriteKind.Monster);
    e.frame = 3;
    startAnimation(e, Animation.Walk);
    return e.frame;
  })(), 3);
}

section('the behaviour hook');
{
  const room = parseMap(`
#######
#.....#
#..m..#
#..>..#
#######
`);
  const player = Player.atSpawn(room);
  const monster = room.sprites[0]!;

  let calls = 0;
  monster.behaviour = (entity, ctx) => {
    calls++;
    entity.angle += ctx.seconds;
  };

  const timing = () => ({ frames: 4, frameSeconds: 0.16, loop: true });
  for (let i = 0; i < 30; i++) updateEntities(room.sprites, { map: room, player, seconds: 1 / 60 }, timing);

  check('it runs once per entity per tick', calls, 30);
  check('and what it does to the entity sticks', Math.abs(monster.angle - 0.5) < 1e-9, true);
  check('animation advanced alongside it', monster.frame > 0, true);

  // Scenery has no behaviour and must survive the same call.
  const scenery = parseMap(`
#####
#.b.#
#.>.#
#####
`);
  updateEntities(scenery.sprites, { map: scenery, player: Player.atSpawn(scenery), seconds: 1 / 60 }, () => undefined);
  check('an entity with no behaviour and no sheet is untouched', [scenery.sprites[0]!.frame, scenery.sprites[0]!.frameClock], [0, 0]);
}

done();
