import {
  DISPLAY_ASPECT,
  MOVE_SPEED,
  RUN_MULTIPLIER,
  TURN_SPEED,
  VIEW_H,
  VIEW_W,
} from './config';
import { FpsCounter, startLoop } from './core/loop';
import { Framebuffer } from './engine/framebuffer';
import { Keyboard } from './input/keys';
import { Mouse } from './input/mouse';
import { SCHEMES, otherScheme, type SchemeName } from './input/scheme';
import { Player } from './player';
import { drawMap, drawPlayer, layoutMinimap } from './render/minimap';
import { LEVEL_1 } from './world/levels/level1';

/** Look up a required element, failing loudly rather than propagating a null. */
function requireElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`index.html is missing ${selector}`);
  return element;
}

const canvas = requireElement<HTMLCanvasElement>('#screen');
const overlay = requireElement<HTMLPreElement>('#overlay');

const ctx = canvas.getContext('2d', { alpha: false });
if (!ctx) throw new Error('Could not acquire a 2D context for the screen');

const framebuffer = new Framebuffer(VIEW_W, VIEW_H);
const fps = new FpsCounter();

const map = LEVEL_1;
const player = Player.atSpawn(map);

const keys = new Keyboard();
const mouse = new Mouse(canvas);

let schemeName: SchemeName = 'modern';
mouse.enabled = SCHEMES[schemeName].usesMouseLook;

function setScheme(name: SchemeName): void {
  schemeName = name;
  mouse.enabled = SCHEMES[name].usesMouseLook;
  if (!SCHEMES[name].usesMouseLook) mouse.release();
}

/** Where the upscaled image sits inside the canvas, in device pixels. */
let viewport = { x: 0, y: 0, w: VIEW_W, h: VIEW_H };

/** Set on resize so the letterbox bars get repainted once rather than every frame. */
let needsClear = true;

/**
 * Size the canvas's pixel grid to match its on-screen size in real device pixels, then
 * work out the largest DISPLAY_ASPECT rectangle that fits inside it, centred.
 *
 * Two different "sizes" are in play, and conflating them is the usual cause of blurry
 * canvas output: the CSS size (how big the element looks) and the backing-store size
 * (how many pixels it actually has). Setting the latter from the former times the device
 * pixel ratio makes one backing-store pixel equal one physical pixel.
 */
function resize(): void {
  const dpr = window.devicePixelRatio || 1;
  const pixelW = Math.max(1, Math.round(canvas.clientWidth * dpr));
  const pixelH = Math.max(1, Math.round(canvas.clientHeight * dpr));

  if (canvas.width !== pixelW || canvas.height !== pixelH) {
    canvas.width = pixelW;
    canvas.height = pixelH;
  }

  // Fit to width, and if that overflows vertically, fit to height instead.
  let w = pixelW;
  let h = pixelW / DISPLAY_ASPECT;
  if (h > pixelH) {
    h = pixelH;
    w = pixelH * DISPLAY_ASPECT;
  }

  viewport = {
    x: Math.round((pixelW - w) / 2),
    y: Math.round((pixelH - h) / 2),
    w: Math.round(w),
    h: Math.round(h),
  };

  needsClear = true;
}

window.addEventListener('resize', resize);
resize();

startLoop({
  update(dt) {
    if (keys.wasPressed('Backquote')) setScheme(otherScheme(schemeName));

    const intent = SCHEMES[schemeName].poll(keys, mouse);

    // Turning has two sources with different units. `turn` is an axis, so it becomes a
    // rate — multiplied by dt, it turns at a steady speed for as long as the key is held.
    // `turnDelta` is already an angle: the mouse has *moved* that far, and scaling it by
    // dt would make sensitivity depend on frame rate.
    player.rotate(intent.turn * TURN_SPEED * dt + intent.turnDelta);

    // Normalise diagonals. Holding forward and strafe together gives a vector of length
    // sqrt(2), so without this you would move 41% faster diagonally than straight ahead —
    // a bug old enough to have a name.
    let { forward, strafe } = intent;
    const length = Math.hypot(forward, strafe);
    if (length > 1) {
      forward /= length;
      strafe /= length;
    }

    const speed = MOVE_SPEED * (intent.run ? RUN_MULTIPLIER : 1) * dt;
    player.move(forward * speed, strafe * speed);

    keys.endTick();
  },

  render() {
    const layout = layoutMinimap(framebuffer, map);
    drawMap(framebuffer, map, layout);
    drawPlayer(framebuffer, player, layout);

    if (needsClear) {
      // Paint the letterbox bars. Only after a resize: the image covers the viewport
      // rectangle completely every frame, so there is nothing else to erase.
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      needsClear = false;
    }

    framebuffer.present(ctx, viewport.x, viewport.y, viewport.w, viewport.h);

    fps.tick();

    const scheme = SCHEMES[schemeName];
    const heading = ((Math.atan2(player.dirY, player.dirX) * 180) / Math.PI + 360) % 360;

    overlay.textContent =
      `${fps.value.toFixed(0)} fps\n` +
      `pos ${player.x.toFixed(2)}, ${player.y.toFixed(2)}   heading ${heading.toFixed(0)}°\n` +
      `\n` +
      `scheme: ${scheme.name}  (\` to switch)\n` +
      `${scheme.help}` +
      (scheme.usesMouseLook && !mouse.isLocked ? '\nclick to capture the mouse' : '');
  },
});
