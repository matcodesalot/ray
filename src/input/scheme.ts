import { MOUSE_SENSITIVITY } from '../config';
import type { Keyboard } from './keys';
import type { Mouse } from './mouse';

/**
 * What the player is asking for this tick, with the specific keys already resolved away.
 *
 * This indirection is the point of the file. `Player` should not know that W means forward
 * or that the classic scheme repurposes the arrow keys when Alt is held — it should be
 * handed axes. Keeping intent separate from bindings is what lets two quite different
 * control schemes coexist without a single conditional leaking into the movement code.
 */
export interface MoveIntent {
  /** -1 backward .. +1 forward. */
  forward: number;
  /** -1 left .. +1 right. */
  strafe: number;
  /** -1 left .. +1 right, applied as a *rate* (radians per second). */
  turn: number;
  /** Radians to apply directly this tick, already scaled. Mouse look; not a rate. */
  turnDelta: number;
  /** Whether the run modifier is held. */
  run: boolean;
}

export type SchemeName = 'modern' | 'classic';

export interface InputScheme {
  readonly name: SchemeName;
  /** Whether this scheme wants pointer lock. */
  readonly usesMouseLook: boolean;
  /** One line of help text for the overlay. */
  readonly help: string;
  poll(keys: Keyboard, mouse: Mouse): MoveIntent;
}

/** Collapse a pair of opposing keys into a single -1 / 0 / +1 axis. */
function axis(negative: boolean, positive: boolean): number {
  return (positive ? 1 : 0) - (negative ? 1 : 0);
}

/**
 * Modern first-person controls: WASD to move and strafe, mouse to look.
 *
 * Note that A and D *strafe* rather than turn. That is the convention mouse look created —
 * with turning on the mouse, the keyboard is freed up for lateral movement. It is also
 * precisely what the original game could not do, and the main reason this scheme feels
 * so different to play.
 */
const MODERN: InputScheme = {
  name: 'modern',
  usesMouseLook: true,
  help: 'WASD move/strafe · mouse look (click to capture) · Q/E turn · Shift run',

  poll(keys, mouse) {
    return {
      forward: axis(keys.isDown('KeyS'), keys.isDown('KeyW')),
      strafe: axis(keys.isDown('KeyA'), keys.isDown('KeyD')),
      // Q/E as a keyboard fallback, so the scheme is still usable without pointer lock.
      turn: axis(keys.isDown('KeyQ'), keys.isDown('KeyE')),
      turnDelta: mouse.takeDeltaX() * MOUSE_SENSITIVITY,
      run: keys.anyDown('ShiftLeft', 'ShiftRight'),
    };
  },
};

/**
 * The original's controls: arrows turn, and Alt makes them strafe instead.
 *
 * Worth playing for a few minutes to feel what the design had to work around. Turning is
 * a key you hold, so it happens at a fixed rate — you cannot snap round to face something.
 * Strafing needs a modifier because there were not enough convenient keys. Both of these
 * shaped how the original's levels and enemy encounters were built.
 */
const CLASSIC: InputScheme = {
  name: 'classic',
  usesMouseLook: false,
  help: 'Arrows move/turn · Alt+arrows strafe · Shift run · no mouse look',

  poll(keys) {
    const strafing = keys.anyDown('AltLeft', 'AltRight');
    const left = keys.isDown('ArrowLeft');
    const right = keys.isDown('ArrowRight');

    return {
      forward: axis(keys.isDown('ArrowDown'), keys.isDown('ArrowUp')),
      strafe: strafing ? axis(left, right) : 0,
      turn: strafing ? 0 : axis(left, right),
      turnDelta: 0,
      run: keys.anyDown('ShiftLeft', 'ShiftRight'),
    };
  },
};

export const SCHEMES: Readonly<Record<SchemeName, InputScheme>> = {
  modern: MODERN,
  classic: CLASSIC,
};

export function otherScheme(name: SchemeName): SchemeName {
  return name === 'modern' ? 'classic' : 'modern';
}
