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

/**
 * Half-width of the camera plane, in world units, for a direction vector of length 1.
 *
 * This is how the field of view is expressed. The camera plane is a line segment held
 * perpendicular to the player's facing, one unit in front of them; rays are shot at
 * points spread across it. Longer plane, wider fan of rays, wider FOV:
 *
 *     FOV = 2 * atan(PLANE_LENGTH)
 *
 * 0.66 gives about 66 degrees, close to the original's. Push it past ~1.0 and you get
 * the fisheye stretching you would expect from a real wide-angle lens.
 */
export const PLANE_LENGTH = 0.66;

/** Walking speed, in tiles per second. */
export const MOVE_SPEED = 3.0;

/** Multiplier applied to movement while the run key is held. */
export const RUN_MULTIPLIER = 1.8;

/** Keyboard turning speed, in radians per second. */
export const TURN_SPEED = 2.4;

/** Mouse look, in radians per unit of pointer movement. */
export const MOUSE_SENSITIVITY = 0.0022;
