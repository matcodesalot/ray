/**
 * Tunable constants for the whole engine.
 *
 * Everything the renderer does is sized off VIEW_W/VIEW_H, so the cost of a frame is
 * fixed no matter how large the browser window is. That is the single most important
 * property of the original engine's design and it is worth preserving.
 */

/** Internal render width, in pixels. One ray is cast per column, so this is also the ray count. */
export const VIEW_W = 320;

/** Internal render height, in pixels. */
export const VIEW_H = 200;

/**
 * Aspect ratio the 320x200 image is *displayed* at.
 *
 * VGA mode 13h was 320x200 shown on a 4:3 monitor, so its pixels were not square —
 * each one was about 1.2x taller than it was wide. Presenting the buffer at 4:3
 * reproduces the original proportions; set this to VIEW_W / VIEW_H (1.6) instead if
 * you would rather have square pixels.
 */
export const DISPLAY_ASPECT = 4 / 3;

/** Logic updates per second. Fixed, so behaviour does not change with frame rate. */
export const TICK_HZ = 60;

/**
 * Largest frame delta the loop will accept, in seconds.
 *
 * If the tab is backgrounded for ten seconds we do not want to run 600 catch-up ticks
 * on the frame it returns — clamping trades a little lost time for a loop that cannot
 * spiral into unresponsiveness.
 */
export const MAX_FRAME_TIME = 0.25;
