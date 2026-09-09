/**
 * The world event bus.
 *
 * Stage 16 adds sound, and the obvious way to do it is to have the door system call the
 * mixer when a door opens. That is also the way that ends with `world/doors.ts` importing
 * an audio module, which is a dependency pointing exactly the wrong way: the world does not
 * care whether anyone is listening.
 *
 * So the world **announces** and interested parties subscribe. Audio is the first
 * subscriber. A game will want others — score, a HUD that flashes when something happens,
 * an enemy that hears you — and none of them require touching the code that emits.
 *
 * ## Why the payload is three numbers
 *
 * `emit(kind, x, y)` rather than `emit({ kind, x, y })`, because a footstep is emitted twice
 * a second from inside the fixed timestep, and this project's claim is that a steady tick
 * allocates nothing at all. An object literal per event would be a few dozen bytes of
 * garbage a second — harmless, and it would quietly make the claim false.
 *
 * Every engine event is "something happened, over there", so a position is the whole
 * payload. If a game needs a richer one, this is the interface to widen — see
 * `docs/extending.md`.
 */

export const WorldEvent = {
  /** A door has started opening. Position: the centre of its cell. */
  DoorOpening: 0,

  /** A door has started closing. */
  DoorClosing: 1,

  /** A pushwall has started moving. Position: the centre of the cell it starts in. */
  PushwallStart: 2,

  /** A pushwall has arrived. */
  PushwallStop: 3,

  /** The player has walked one stride. Position: the player. */
  Footstep: 4,
} as const;

export type WorldEvent = (typeof WorldEvent)[keyof typeof WorldEvent];

export type WorldEventListener = (event: WorldEvent, x: number, y: number) => void;

export class EventBus {
  private readonly listeners: WorldEventListener[] = [];

  /** Subscribe. Returns a function that removes the listener again. */
  subscribe(listener: WorldEventListener): () => void {
    this.listeners.push(listener);

    return () => {
      const at = this.listeners.indexOf(listener);
      if (at >= 0) this.listeners.splice(at, 1);
    };
  }

  /**
   * Announce something.
   *
   * A plain indexed loop, and listeners are called in subscription order. No try/catch: a
   * listener that throws is a bug in the listener, and swallowing it here would turn a
   * stack trace pointing at the culprit into sound that silently stops working.
   */
  emit(event: WorldEvent, x: number, y: number): void {
    for (let i = 0; i < this.listeners.length; i++) {
      this.listeners[i]!(event, x, y);
    }
  }

  get listenerCount(): number {
    return this.listeners.length;
  }
}

/** A bus that goes nowhere, so systems can emit unconditionally without a null check. */
export const SILENT_BUS = new EventBus();
