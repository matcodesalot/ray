import { DISPLAY_ASPECT, VIEW_H, VIEW_W } from './config';
import { FpsCounter, startLoop } from './core/loop';
import { Framebuffer } from './engine/framebuffer';
import { drawTestPattern } from './render/testpattern';

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

/** Seconds of simulated time since start. Stage 1 only uses it to animate the pattern. */
let elapsed = 0;

startLoop({
  update(dt) {
    elapsed += dt;
  },

  render() {
    drawTestPattern(framebuffer, elapsed);

    if (needsClear) {
      // Paint the letterbox bars. Only after a resize: the image covers the viewport
      // rectangle completely every frame, so there is nothing else to erase.
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      needsClear = false;
    }

    framebuffer.present(ctx, viewport.x, viewport.y, viewport.w, viewport.h);

    fps.tick();
    overlay.textContent =
      `${fps.value.toFixed(0)} fps\n` +
      `buffer  ${VIEW_W}x${VIEW_H}\n` +
      `display ${viewport.w}x${viewport.h} (${(viewport.w / VIEW_W).toFixed(2)}x)`;
  },
});
