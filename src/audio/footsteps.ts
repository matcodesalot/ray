import { FOOTSTEP_STRIDE } from '../config';

/**
 * When to play a footstep.
 *
 * Driven by **distance actually covered**, not by time and not by whether a key is down.
 * Both of the easier options are wrong in the same visible way: walking into a wall holds
 * the key and moves you nowhere, and a timer would keep tapping out steps while you stand
 * there pressed against it. Distance also makes running produce faster steps for free,
 * rather than needing a second cadence to keep in sync with the first.
 *
 * The remainder carries across strides, so a long move does not lose the fraction it
 * overshot by — the same reason `advanceAnimation` subtracts a frame at a time.
 */
export class Stride {
  private travelled = 0;

  /** Report a movement. Returns true when a footstep should be heard. */
  moved(deltaX: number, deltaY: number): boolean {
    this.travelled += Math.hypot(deltaX, deltaY);
    if (this.travelled < FOOTSTEP_STRIDE) return false;

    this.travelled -= FOOTSTEP_STRIDE;
    return true;
  }

  /** Forget the accumulated distance — after a teleport, say, or on respawn. */
  reset(): void {
    this.travelled = 0;
  }
}
