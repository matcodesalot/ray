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

/**
 * Texture edge length, in texels. Must be a power of two.
 *
 * 64 is what the original used, and the power of two is not nostalgia: it lets the
 * innermost loop wrap a texture coordinate with `& (TEX_SIZE - 1)` instead of a modulo or
 * a clamp, which matters when that line runs tens of thousands of times a frame.
 */
export const TEX_SIZE = 64;

/** Mask for wrapping a texture coordinate. Valid only because TEX_SIZE is a power of two. */
export const TEX_MASK = TEX_SIZE - 1;

/**
 * Collision radius of the player, in world units.
 *
 * Comfortably under half a cell, which is what lets you through a one-unit doorway without
 * having to line up on it — anything at or above 0.5 makes doorways feel like threading a
 * needle. Large enough, though, that you cannot press your face into a corner and see
 * through the seam where two walls meet.
 */
export const PLAYER_RADIUS = 0.28;

/** Seconds for a door to travel from fully closed to fully open, or back. */
export const DOOR_TRAVEL_TIME = 0.9;

/** Seconds a door stays fully open before it starts closing itself. */
export const DOOR_HOLD_TIME = 4;

/** How far in front of the player to look for a door to open, in world units. */
export const DOOR_REACH = 1.1;

/**
 * Seconds a pushwall takes to travel one cell.
 *
 * Deliberately slower than a door. A door is something you pass through and stop thinking
 * about; a pushwall grinding two cells into the dark is the payoff for having found it, and
 * it wants to be watched.
 */
export const PUSHWALL_TRAVEL_TIME = 1.4;

/** How many cells a pushwall travels, if it has the room. Two, as in the original. */
export const PUSHWALL_CELLS = 2;
