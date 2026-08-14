/**
 * Keyboard state.
 *
 * Games need to know which keys are *held right now*, but the DOM only tells you when a
 * key changes. So we keep a set and maintain it from the events.
 *
 * Two details that matter:
 *
 * - We key off `event.code`, the physical key position, not `event.key`, the character it
 *   produces. On an AZERTY keyboard `event.key` for the W position is 'z'; `event.code` is
 *   'KeyW' on every layout. WASD is a *shape*, not a set of letters.
 *
 * - We clear everything on blur. Hold a movement key, alt-tab away, release it — the
 *   keyup lands in another window and never reaches us, so on return the game thinks the
 *   key is still down and the player walks off on their own. Clearing on blur is the fix,
 *   and it is the sort of bug that is baffling if you have not met it before.
 */
export class Keyboard {
  private readonly down = new Set<string>();
  private readonly pressedThisTick = new Set<string>();

  constructor(target: EventTarget = window) {
    target.addEventListener('keydown', (event) => {
      const e = event as KeyboardEvent;
      // Ignore auto-repeat: held keys are already in the set, and repeats would
      // otherwise register as a stream of fresh presses.
      if (e.repeat) return;
      this.down.add(e.code);
      this.pressedThisTick.add(e.code);
    });

    target.addEventListener('keyup', (event) => {
      this.down.delete((event as KeyboardEvent).code);
    });

    window.addEventListener('blur', () => {
      this.down.clear();
      this.pressedThisTick.clear();
    });
  }

  /** Whether a physical key is currently held. */
  isDown(code: string): boolean {
    return this.down.has(code);
  }

  /** Whether any of these keys is currently held. */
  anyDown(...codes: string[]): boolean {
    return codes.some((code) => this.down.has(code));
  }

  /**
   * Whether a key went down since the last `endTick()`.
   *
   * Edge-triggered, for one-shot actions like toggling a setting — as opposed to
   * `isDown`, which is level-triggered and right for continuous things like movement.
   */
  wasPressed(code: string): boolean {
    return this.pressedThisTick.has(code);
  }

  /** Call once at the end of each update tick to clear the one-shot press set. */
  endTick(): void {
    this.pressedThisTick.clear();
  }
}
