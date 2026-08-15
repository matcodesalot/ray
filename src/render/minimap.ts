import { rgb } from '../engine/color';
import type { Framebuffer } from '../engine/framebuffer';
import type { Player } from '../player';
import type { GameMap } from '../world/map';
import { DoorAxis } from '../world/doors';
import type { SpriteEntity } from '../world/entities';
import { Tile } from '../world/tiles';
import type { RayHit } from './raycast';

/**
 * Top-down view of the level.
 *
 * For Stages 2 and 3 this *is* the game view — the whole screen. It exists because the
 * hard part of a raycaster is not the drawing, it is believing that the rays are going
 * where you think they are. Watching them from above, in the same space the maths is
 * written in, turns "the wall looks wrong" into "that ray stopped one cell early".
 *
 * From Stage 11 the same code renders into a corner as an in-game minimap.
 */

const COLOR_BACKGROUND = rgb(12, 12, 16);
const COLOR_FLOOR = rgb(30, 32, 40);
const COLOR_GRID = rgb(44, 47, 58);
const COLOR_PLAYER = rgb(255, 214, 64);
const COLOR_DIR = rgb(255, 255, 255);
const COLOR_PLANE = rgb(96, 200, 255);
const COLOR_DOOR = rgb(214, 182, 84);
const COLOR_SPRITE = rgb(226, 138, 92);
const COLOR_RAY_X = rgb(120, 90, 40);
const COLOR_RAY_Y = rgb(150, 115, 55);

const TILE_COLORS: Readonly<Record<number, number>> = {
  [Tile.Wall1]: rgb(150, 60, 55),
  [Tile.Wall2]: rgb(70, 110, 160),
  [Tile.Wall3]: rgb(80, 140, 85),
  [Tile.Wall4]: rgb(150, 120, 60),
  [Tile.Door]: rgb(190, 160, 70),
};

/**
 * Where the map sits on screen: how many pixels one tile is, and the top-left corner.
 *
 * Kept as a value rather than recomputed inside the drawing functions so that anything
 * else wanting to plot in map space — the ray fan in Stage 3, entities in Stage 10 —
 * can share the exact same transform.
 */
export interface MinimapLayout {
  /** Pixels per world unit. */
  scale: number;
  originX: number;
  originY: number;
}

/** A rectangle of the framebuffer, in pixels. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Fit the whole map inside a rectangle, centred, keeping cells square. */
export function layoutMinimap(map: GameMap, bounds: Rect, padding = 4): MinimapLayout {
  const scale = Math.min(
    (bounds.w - padding * 2) / map.width,
    (bounds.h - padding * 2) / map.height,
  );

  return {
    scale,
    originX: bounds.x + (bounds.w - map.width * scale) / 2,
    originY: bounds.y + (bounds.h - map.height * scale) / 2,
  };
}

/** World coordinates to framebuffer coordinates. */
export function toScreenX(layout: MinimapLayout, worldX: number): number {
  return layout.originX + worldX * layout.scale;
}

export function toScreenY(layout: MinimapLayout, worldY: number): number {
  return layout.originY + worldY * layout.scale;
}

/**
 * Draw the level grid into `bounds`. Call before anything that should appear on top.
 *
 * Fills only its own rectangle rather than clearing the whole framebuffer, which is what
 * lets the same code serve both as the full-screen debug view and as a corner minimap
 * drawn over a finished first-person frame.
 */
export function drawMap(
  fb: Framebuffer,
  map: GameMap,
  layout: MinimapLayout,
  bounds: Rect,
): void {
  fb.fillRect(bounds.x, bounds.y, bounds.w, bounds.h, COLOR_BACKGROUND);

  const { scale } = layout;

  for (let y = 0; y < map.height; y++) {
    for (let x = 0; x < map.width; x++) {
      const tile = map.tileAt(x, y);

      // Doors are drawn as the slab itself rather than a filled cell, so the top-down view
      // shows how far each one has actually slid. Much the quickest way to tell a door
      // that is stuck from a door that is rendering wrong.
      if (tile === Tile.Door) {
        drawDoor(fb, map, x, y, layout);
        continue;
      }

      const color = tile === Tile.Floor ? COLOR_FLOOR : (TILE_COLORS[tile] ?? COLOR_FLOOR);

      // Round the far edge rather than the size, so cells tile seamlessly at fractional
      // scales instead of leaving gaps where two roundings disagree.
      const left = Math.round(toScreenX(layout, x));
      const top = Math.round(toScreenY(layout, y));
      const right = Math.round(toScreenX(layout, x + 1));
      const bottom = Math.round(toScreenY(layout, y + 1));

      fb.fillRect(left, top, right - left, bottom - top, color);
    }
  }

  // Grid lines, only when cells are big enough for them not to swamp the picture.
  if (scale >= 5) {
    for (let x = 0; x <= map.width; x++) {
      const sx = Math.round(toScreenX(layout, x));
      fb.drawLine(sx, Math.round(layout.originY), sx, Math.round(toScreenY(layout, map.height)), COLOR_GRID);
    }
    for (let y = 0; y <= map.height; y++) {
      const sy = Math.round(toScreenY(layout, y));
      fb.drawLine(Math.round(layout.originX), sy, Math.round(toScreenX(layout, map.width)), sy, COLOR_GRID);
    }
  }
}

/** Draw one door cell: an empty recess with the slab drawn at its current offset. */
function drawDoor(
  fb: Framebuffer,
  map: GameMap,
  cellX: number,
  cellY: number,
  layout: MinimapLayout,
): void {
  const left = Math.round(toScreenX(layout, cellX));
  const top = Math.round(toScreenY(layout, cellY));
  const right = Math.round(toScreenX(layout, cellX + 1));
  const bottom = Math.round(toScreenY(layout, cellY + 1));

  fb.fillRect(left, top, right - left, bottom - top, COLOR_FLOOR);

  const door = map.doorAt(cellX, cellY);
  if (!door) return;

  const thickness = Math.max(1, Math.round(layout.scale * 0.25));

  if (door.axis === DoorAxis.X) {
    const slabLeft = Math.round(toScreenX(layout, cellX + door.openness));
    const centre = Math.round(toScreenY(layout, cellY + 0.5) - thickness / 2);
    fb.fillRect(slabLeft, centre, right - slabLeft, thickness, COLOR_DOOR);
  } else {
    const slabTop = Math.round(toScreenY(layout, cellY + door.openness));
    const centre = Math.round(toScreenX(layout, cellX + 0.5) - thickness / 2);
    fb.fillRect(centre, slabTop, thickness, bottom - slabTop, COLOR_DOOR);
  }
}

/**
 * Draw the ray fan.
 *
 * `stride` skips columns: all 320 rays drawn at once merge into a solid wedge that tells
 * you nothing, whereas every 8th ray reads clearly as a fan of separate lines. Press R to
 * cycle it and watch the fan fill in.
 *
 * This is the picture worth staring at. Each line ends exactly on a wall face — never
 * short of one, never inside a wall. Walk up to a pillar and watch the rays that pass to
 * either side of it shoot away into the distance while the ones that strike it stop dead.
 */
export function drawRays(
  fb: Framebuffer,
  player: Player,
  hits: readonly RayHit[],
  layout: MinimapLayout,
  stride = 8,
): void {
  const px = toScreenX(layout, player.x);
  const py = toScreenY(layout, player.y);

  for (let i = 0; i < hits.length; i += stride) {
    const hit = hits[i]!;
    // Colour by which face was struck, so the alternation along a wall is visible.
    const color = hit.side === 0 ? COLOR_RAY_X : COLOR_RAY_Y;
    fb.drawLine(px, py, toScreenX(layout, hit.hitX), toScreenY(layout, hit.hitY), color);
  }
}

/**
 * Draw sprite entities as small markers.
 *
 * Worth having: a sprite's position is a pair of floats rather than a cell, so "is it
 * where I think it is" is a question the first-person view answers badly and this answers
 * instantly.
 */
export function drawSprites(
  fb: Framebuffer,
  sprites: readonly SpriteEntity[],
  layout: MinimapLayout,
): void {
  const size = Math.max(2, Math.round(layout.scale * 0.3));

  for (const sprite of sprites) {
    const sx = Math.round(toScreenX(layout, sprite.x) - size / 2);
    const sy = Math.round(toScreenY(layout, sprite.y) - size / 2);
    fb.fillRect(sx, sy, size, size, COLOR_SPRITE);
  }
}

/**
 * Draw the player, their facing, and the camera plane.
 *
 * The blue segment is the camera plane — the thing `PLANE_LENGTH` sets the size of. The
 * two faint lines from the player to its ends are the leftmost and rightmost rays, so the
 * wedge between them is precisely the field of view. Seeing that the far edge is a
 * straight *line* and not an arc is the whole intuition behind why this projection does
 * not produce fisheye.
 */
export function drawPlayer(fb: Framebuffer, player: Player, layout: MinimapLayout): void {
  const px = toScreenX(layout, player.x);
  const py = toScreenY(layout, player.y);

  const tipX = toScreenX(layout, player.x + player.dirX);
  const tipY = toScreenY(layout, player.y + player.dirY);

  const leftX = toScreenX(layout, player.x + player.dirX - player.planeX);
  const leftY = toScreenY(layout, player.y + player.dirY - player.planeY);
  const rightX = toScreenX(layout, player.x + player.dirX + player.planeX);
  const rightY = toScreenY(layout, player.y + player.dirY + player.planeY);

  // Field-of-view wedge.
  fb.drawLine(px, py, leftX, leftY, COLOR_PLANE);
  fb.drawLine(px, py, rightX, rightY, COLOR_PLANE);

  // The camera plane itself.
  fb.drawLine(leftX, leftY, rightX, rightY, COLOR_PLANE);

  // Facing.
  fb.drawLine(px, py, tipX, tipY, COLOR_DIR);

  // The player, as a small square centred on their position.
  const size = Math.max(2, Math.round(layout.scale * 0.35));
  fb.fillRect(Math.round(px - size / 2), Math.round(py - size / 2), size, size, COLOR_PLAYER);
}
