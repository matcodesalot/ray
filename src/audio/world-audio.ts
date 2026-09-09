import { WorldEvent, type EventBus } from '../core/events';
import { Sound } from './manifest';
import type { Listener, Mixer } from './mixer';

/**
 * What the world's announcements sound like.
 *
 * The entire coupling between the game world and the audio layer is this table plus one
 * subscription. `world/doors.ts` says "a door started opening, here"; deciding that this
 * should be a metal slide at that position is a decision made in exactly one place, and
 * changing it touches no other file.
 *
 * An event with no sound is a normal thing, not an omission — a pushwall arriving stops
 * being interesting once you can see it has stopped.
 */
const SOUND_FOR: Readonly<Partial<Record<number, Sound>>> = {
  [WorldEvent.DoorOpening]: Sound.DoorOpen,
  [WorldEvent.DoorClosing]: Sound.DoorClose,
  [WorldEvent.PushwallStart]: Sound.Pushwall,
  [WorldEvent.Footstep]: Sound.Footstep,
};

/**
 * Make the mixer listen to the world. Returns a function that disconnects it again.
 *
 * `listener` is read at the moment a sound starts rather than captured, so passing the live
 * `Player` is the intended use: a sound is placed relative to wherever the player is when it
 * begins.
 */
export function connectAudio(bus: EventBus, mixer: Mixer, listener: Listener): () => void {
  return bus.subscribe((event, x, y) => {
    const sound = SOUND_FOR[event];
    if (sound !== undefined) mixer.playAt(sound, x, y, listener);
  });
}
