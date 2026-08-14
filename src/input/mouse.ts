/**
 * Mouse look, via the Pointer Lock API.
 *
 * Ordinary mouse events report a position inside the window, which is useless for looking
 * around: the pointer hits the edge of the screen and stops. Pointer lock hides the cursor
 * and switches the events to reporting *relative* movement instead, with no limit — which
 * is exactly what a first-person camera wants.
 *
 * Two constraints come from the browser, not from us:
 *
 * - Lock can only be requested from a user gesture, so it is wired to a click.
 * - Escape always exits, and the page cannot prevent that or immediately re-request. This
 *   is a deliberate anti-hijacking measure. Plan for the lock to be lost at any moment.
 *
 * Movement is accumulated between reads rather than sampled, because several mousemove
 * events can arrive within a single frame and taking only the latest would throw away
 * real motion — the camera would feel like it was dropping input at high polling rates.
 */
export class Mouse {
  private accumulatedX = 0;
  private locked = false;

  /** Whether mouse look should engage on click. Set false by keyboard-only schemes. */
  enabled = true;

  constructor(element: HTMLElement) {
    element.addEventListener('click', () => {
      if (this.enabled && !this.locked) {
        void element.requestPointerLock();
      }
    });

    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === element;
      // Drop anything banked while unlocked so the view does not jump on re-entry.
      this.accumulatedX = 0;
    });

    document.addEventListener('mousemove', (event) => {
      if (this.locked) this.accumulatedX += event.movementX;
    });
  }

  get isLocked(): boolean {
    return this.locked;
  }

  /** Read and reset the horizontal movement banked since the last call. */
  takeDeltaX(): number {
    const delta = this.accumulatedX;
    this.accumulatedX = 0;
    return delta;
  }

  /** Release the pointer, e.g. when switching to a keyboard-only control scheme. */
  release(): void {
    if (this.locked) document.exitPointerLock();
  }
}
