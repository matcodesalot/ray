import {
  AUDIO_FADE_BAND,
  AUDIO_MAX_DISTANCE,
  AUDIO_PAN_SOFTENING,
  AUDIO_REFERENCE_DISTANCE,
} from '../config';

/**
 * Turning a position into a volume and a stereo balance.
 *
 * Both are pure functions of numbers, which is deliberate: the rest of the audio layer can
 * only be exercised in a browser, and these two are the part with actual maths in them.
 * Kept here they can be asserted directly, in node, with no WebAudio at all.
 */

/**
 * How loud a source at `distance` should be, from 1 down to 0.
 *
 * Two pieces multiplied together, because neither does the job alone:
 *
 * - **Inverse distance** past a reference radius. That is how sound actually behaves, and
 *   it is what gives a room a sense of size. On its own it never reaches zero, so every
 *   sound in the level would go on contributing something forever.
 * - **A linear fade** over the last few units before the cutoff. On its own this sounds
 *   wrong — a source at half the maximum range would still be at half volume — but it takes
 *   the tail to exactly zero, and it does it gradually. A hard cutoff clicks.
 *
 *      1 ┤─────╮
 *        │      ╰──╌╌╌╌╌╌╮
 *      0 ┤                ╰────
 *        └─────┬─────────┬┬─────
 *             ref     fade max
 *
 * Inside the reference radius it is flat at 1 rather than growing without bound, which is
 * what keeps a sound emitted at your own feet from being infinitely loud.
 */
export function attenuation(distance: number): number {
  // Negated so that NaN falls through to silence rather than to full volume — the same trap
  // the distance-shading table walked into in stage 5, where `Infinity * 8 | 0` came out 0.
  if (!(distance < AUDIO_MAX_DISTANCE)) return 0;

  const near = AUDIO_REFERENCE_DISTANCE / Math.max(distance, AUDIO_REFERENCE_DISTANCE);

  const remaining = AUDIO_MAX_DISTANCE - distance;
  const fade = remaining >= AUDIO_FADE_BAND ? 1 : remaining / AUDIO_FADE_BAND;

  return near * fade;
}

/**
 * Where a source sits between the ears: -1 hard left, 0 straight ahead, +1 hard right.
 *
 * The camera plane is already the player's **right** vector — it has been since stage 2,
 * because that is what makes screen-right correspond to increasing plane offset. So the
 * balance is a dot product with it, and no trigonometry is involved at all.
 *
 * ## The sign is the whole thing
 *
 * Getting it backwards swaps left and right: inaudible in a screenshot, completely wrong in
 * play, and the same shape of bug as the mirrored wall textures and the flipped sprite
 * rotations. So it is asserted from a known geometry rather than reasoned about — facing
 * east the plane points south, so a source to the south is on your right.
 *
 * ## Why divide by distance plus a constant
 *
 * Dividing by distance alone normalises the vector, so a source a centimetre to your right
 * pans hard right. Technically correct, horrible to listen to: a sound at your feet swings
 * between the speakers as you turn. The extra term softens the near field — at the softening
 * distance, a source directly beside you is panned halfway.
 */
export function panning(deltaX: number, deltaY: number, planeX: number, planeY: number): number {
  const planeLength = Math.hypot(planeX, planeY);
  if (planeLength < 1e-9) return 0;

  const distance = Math.hypot(deltaX, deltaY);
  const rightward = (deltaX * planeX + deltaY * planeY) / planeLength;

  const pan = rightward / (distance + AUDIO_PAN_SOFTENING);
  return pan < -1 ? -1 : pan > 1 ? 1 : pan;
}
