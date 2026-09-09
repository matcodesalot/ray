import ambience from '../assets/sounds/ambience.ogg?url';
import doorClose from '../assets/sounds/door-close.ogg?url';
import doorOpen from '../assets/sounds/door-open.ogg?url';
import footstep from '../assets/sounds/footstep.ogg?url';
import pushwall from '../assets/sounds/pushwall.ogg?url';

/**
 * Which file plays for what, deliberately shaped like `assets/manifest.ts`.
 *
 * Same `?url` imports and the same reason for them: a missing or misspelled file is a
 * **build failure**, named, rather than a 404 at run time or — worse — a sound that silently
 * never plays, which is the hardest kind of asset bug to notice.
 */

export const Sound = {
  DoorOpen: 'door-open',
  DoorClose: 'door-close',
  Pushwall: 'pushwall',
  Footstep: 'footstep',
  Ambience: 'ambience',
} as const;

export type Sound = (typeof Sound)[keyof typeof Sound];

export interface SoundSpec {
  url: string;

  /**
   * Level correction, applied at load time.
   *
   * Third-party audio is not mastered to a common loudness — the stone door in this set
   * peaks at 0.15 while the metal door peaks at 0.93, a difference of about 16 dB. Carrying
   * the correction here rather than editing the files keeps the originals exactly as
   * downloaded, which is a much easier provenance story to write in CREDITS.md.
   */
  gain: number;

  /**
   * Music and ambience rather than a positional effect.
   *
   * Two consequences: it goes to the music bus, and it stays **stereo**. Effects are
   * downmixed to mono because a stereo source fights the panner — the file already has its
   * own left/right image, and panning it produces a muddle rather than a position. Ambience
   * has no position to have, so its own image is exactly what you want.
   */
  music?: boolean;

  loop?: boolean;

  /**
   * Where a loop restarts, in seconds.
   *
   * The ambience has three and a bit seconds of near-silence at the front, which is fine
   * once and a hole in the atmosphere every time round. Seamless looping proper is the
   * artist's job; this only skips the lead-in.
   */
  loopStart?: number;
}

export const SOUND_MANIFEST: Readonly<Record<Sound, SoundSpec>> = {
  [Sound.DoorOpen]: { url: doorOpen, gain: 0.7 },
  [Sound.DoorClose]: { url: doorClose, gain: 0.7 },
  [Sound.Pushwall]: { url: pushwall, gain: 3 },
  [Sound.Footstep]: { url: footstep, gain: 1.6 },
  [Sound.Ambience]: { url: ambience, gain: 1, music: true, loop: true, loopStart: 3.4 },
};
