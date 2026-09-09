import { stubDocument, check, section, done, defaultTextures, rulerTexture, readRuler, solidTexture, textureSet } from '../lib/harness';

stubDocument();


import { Framebuffer } from '../../../src/engine/framebuffer';
import { rgb } from '../../../src/engine/color';
import { drawWalls, createWallSpans, antialiasWallEdges } from '../../../src/render/walls';
import { drawFloorAndCeiling } from '../../../src/render/floors';
import { SpriteRenderer } from '../../../src/render/sprites';
import { castRay, createRayHit, RayFan } from '../../../src/render/raycast';
import { DEFAULT_RENDER_OPTIONS } from '../../../src/render/options';
import type { Texture, TextureSet } from '../../../src/assets/decode';
import { parseMap } from '../../../src/world/map';
import { DoorState } from '../../../src/world/doors';
import { Player } from '../../../src/player';
import { Tile } from '../../../src/world/tiles';
import { makeEntity, SpriteKind } from '../../../src/world/entities';
import { LEVEL_1 } from '../../../src/world/levels/level1';
import { TEX_SIZE } from '../../../src/config';


const W = 320, H = 200;
const fb = new Framebuffer(W, H);
const spans = createWallSpans(W);
const fan = new RayFan(W);
const opts = { ...DEFAULT_RENDER_OPTIONS };
const T = defaultTextures();

section('wallX invariants survive the flip change (Stage 6)');
{
  const room = parseMap(`
#########
#.......#
#.......#
#.......#
#...>...#
#.......#
#.......#
#.......#
#########
`);
  const hit = createRayHit();
  let outOfRange = 0, mismatched = 0, swept = 0;
  for (let py = 1.2; py < 8; py += 0.37) {
    for (let px = 1.2; px < 8; px += 0.37) {
      for (let a = 0; a < Math.PI * 2; a += 0.02) {
        castRay(room, px, py, Math.cos(a), Math.sin(a), hit);
        swept++;
        if (!(hit.wallX >= 0 && hit.wallX <= 1)) outOfRange++;
        const along = hit.side === 0 ? hit.hitY : hit.hitX;
        const frac = along - Math.floor(along);
        if (Math.abs(hit.wallX - frac) > 1e-9 && Math.abs(hit.wallX - (1 - frac)) > 1e-9) mismatched++;
      }
    }
  }
  check(`wallX within [0,1] across ${swept} rays`, outOfRange, 0);
  check('wallX still matches the fractional hit position', mismatched, 0);
}
{
  // Along one continuous face the coordinate must run one way in every cell, or adjacent
  // cells mirror each other at their seam.
  const wall = parseMap(`
##########
#........#
#........#
#...>....#
##########
`);
  const hit = createRayHit();
  const samples: { x: number; w: number }[] = [];
  for (let a = -2.5; a < -0.65; a += 0.002) {
    castRay(wall, 4.5, 3.5, Math.cos(a), Math.sin(a), hit);
    if (hit.side === 1 && hit.mapY === 0) samples.push({ x: hit.hitX, w: hit.wallX });
  }
  samples.sort((p, q) => p.x - q.x);
  let direction = 0, inconsistent = 0;
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1]!, b = samples[i]!;
    if (Math.floor(a.x) !== Math.floor(b.x)) continue;
    const d = Math.sign(b.w - a.w);
    if (d === 0) continue;
    if (direction === 0) direction = d; else if (d !== direction) inconsistent++;
  }
  check(`wallX runs one way along a ${samples.length}-sample face`, inconsistent, 0);
}

section('doors still work (Stage 9)');
{
  const m = parseMap(`
#######
#.....#
###D###
#..>..#
#######
`);
  const d = m.doorAt(3, 2)!;
  const hit = createRayHit();

  castRay(m, 3.5, 3.5, 0, -1, hit);
  check('the slab is still half a unit inside the cell', Math.abs(hit.perpDist - 1) < 1e-9, true);
  check('and reports the door tile', hit.tile, Tile.Door);
  check('closed door blocks movement', m.isSolid(3, 2), true);

  m.doors.activate(3, 2);
  while (d.state === DoorState.Opening) m.doors.update(1 / 60, () => false);
  check('opens fully', [d.state, d.openness], [DoorState.Open, 1]);
  check('and stops blocking', m.isSolid(3, 2), false);

  let stillHit = 0;
  for (let a = 0; a < Math.PI * 2; a += 0.01) {
    castRay(m, 3.5, 3.5, Math.cos(a), Math.sin(a), hit);
    if (hit.tile === Tile.Door) stillHit++;
  }
  check('a fully open door is never hit by a ray', stillHit, 0);

  // The slab still slides rather than squashing, now with the mirroring applied.
  d.openness = 0;
  castRay(m, 3.5, 3.5, 0, -1, hit);
  const closedAtCentre = hit.wallX;
  d.openness = 0.2;
  castRay(m, 3.7, 3.5, 0, -1, hit);
  check('material rides with the slab as it opens', Math.abs(hit.wallX - closedAtCentre) < 0.02, true);
  d.openness = 0;
}

section('sprites still work (Stage 10)');
{
  const room = parseMap(`
##########
#........#
#........#
#...>....#
#........#
##########
`);
  const player = new Player(4.5, 3.5, 1, 0);
  fan.cast(room, player);
  const wallDist = fan.hits[W >> 1]!.perpDist;
  const renderer = new SpriteRenderer(4);

  const draw = (x: number, y: number) => {
    fb.clear(7);
    renderer.draw(fb, player, [makeEntity(x, y, SpriteKind.Column)], fan.hits, T, opts);
    let n = 0;
    for (const p of fb.pixels) if (p !== 7) n++;
    return n;
  };

  check('a sprite in front of the wall draws', draw(player.x + wallDist * 0.5, 3.5) > 100, true);
  check('a sprite behind the wall is hidden', draw(player.x + wallDist * 1.5, 3.5), 0);
  check('a sprite behind the camera draws nothing', draw(player.x - 2, 3.5), 0);
}

section('full scene renders cleanly across the level');
{
  const player = Player.atSpawn(LEVEL_1);
  const sprites = new SpriteRenderer(LEVEL_1.sprites.length);
  let bad = 0, frames = 0;
  for (const aa of [false, true]) {
    const o = { ...opts, edgeAntialiasing: aa };
    for (let a = 0; a < Math.PI * 2; a += 0.06) {
      for (const [px, py] of [[5.5, 7.5], [12.5, 6.5], [3.5, 12.5]] as const) {
        player.x = px; player.y = py;
        player.setDirection(Math.cos(a), Math.sin(a));
        fan.cast(LEVEL_1, player);
        fb.clear(0);
        drawWalls(fb, fan.hits, spans, T, o);
        drawFloorAndCeiling(fb, player, spans, T, o);
        sprites.draw(fb, player, LEVEL_1.sprites, fan.hits, T, o);
        if (aa) antialiasWallEdges(fb, fan.hits, o);
        frames++;
        for (let i = 0; i < fb.pixels.length; i++) {
          const p = fb.pixels[i]!;
          if (Number.isNaN(p) || p === 0 || (p >>> 24) !== 0xff) { bad++; break; }
        }
      }
    }
  }
  check(`${frames} frames: every pixel written, opaque, no NaN`, bad, 0);
}


section('texture orientation — the mirroring bug real artwork exposed');
{
  // Every wall face was mirrored from Stage 6 until Stage 12. Symmetric brick and noise
  // look identical mirrored, so nothing caught it until a texture carried lettering.
  // A ruler texture makes it measurable: each column is a distinct colour, so the texture
  // x that a screen column sampled can be read back out of the framebuffer.
  const ruler = rulerTexture();
  const rulerSet = textureSet(() => ruler);

  const room = parseMap(`
#######
#.....#
#.....#
#..>..#
#.....#
#.....#
#######
`);

  for (const [name, dx, dy] of [
    ['facing east  (a west-facing face)', 1, 0],
    ['facing west  (an east-facing face)', -1, 0],
    ['facing north (a south-facing face)', 0, -1],
    ['facing south (a north-facing face)', 0, 1],
  ] as const) {
    const p = new Player(3.5, 3.5, dx, dy);
    fan.cast(room, p);
    fb.clear(0);
    drawWalls(fb, fan.hits, spans, rulerSet, { ...opts, lighting: false });

    // Take the longest run of columns that stay within one wall cell: the texture
    // legitimately restarts at every cell boundary.
    let best: number[] = [];
    let run: number[] = [];
    let lastCell = -1;
    for (let x = 0; x < W; x++) {
      const hit = fan.hits[x]!;
      const cell = hit.mapX * 1000 + hit.mapY;
      if (cell !== lastCell) {
        if (run.length > best.length) best = run;
        run = [];
        lastCell = cell;
      }
      run.push(readRuler(fb.pixels[100 * W + x]!).tx);
    }
    if (run.length > best.length) best = run;

    check(`${name}: texture reads left-to-right`, best[best.length - 1]! > best[0]!, true);
  }
}
{
  // Door slabs have their own coordinate and had no flip at all, so they read correctly
  // from one side and backwards from the other.
  const hit = createRayHit();
  const eastWest = parseMap(`
#######
#.....#
###D###
#..>..#
#######
`);
  const northSouth = parseMap(`
#####
#.#.#
#.D>#
#.#.#
#####
`);

  const sweep = (map: ReturnType<typeof parseMap>, fromX: number, fromY: number, dirX: number, dirY: number) => {
    const samples: { across: number; w: number }[] = [];
    for (let t = -0.42; t <= 0.42; t += 0.02) {
      const px = fromX + (dirY !== 0 ? t : 0);
      const py = fromY + (dirX !== 0 ? -t : 0);
      castRay(map, px, py, dirX, dirY, hit);
      if (hit.tile !== Tile.Door) continue;
      // Screen-right is the camera plane, which is (-dirY, dirX).
      samples.push({ across: (px - fromX) * -dirY + (py - fromY) * dirX, w: hit.wallX });
    }
    samples.sort((a, b) => a.across - b.across);
    return samples[samples.length - 1]!.w > samples[0]!.w;
  };

  check('X-axis door from the south reads left-to-right', sweep(eastWest, 3.5, 3.5, 0, -1), true);
  check('X-axis door from the north reads left-to-right', sweep(eastWest, 3.5, 1.5, 0, 1), true);
  check('Y-axis door from the east reads left-to-right', sweep(northSouth, 3.5, 2.5, -1, 0), true);
  check('Y-axis door from the west reads left-to-right', sweep(northSouth, 1.5, 2.5, 1, 0), true);
}

done();
