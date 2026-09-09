import { AUDIO_MAX_DISTANCE } from '../config';
import { attenuation, panning } from './positional';
import type { Sound } from './manifest';
import type { LoadedSound, SoundSet } from './loader';

/**
 * The WebAudio graph, and the only file in the project that knows WebAudio exists.
 *
 *     one-shot ──► gain (distance) ──► panner ──► sfx bus ──┐
 *                                                            ├──► master ──► speakers
 *     ambience ─────────────────────────────────► music bus ─┘
 *
 * Two buses because the two kinds of sound want independent control: a player who turns the
 * music off has not asked to stop hearing doors. The per-shot gain and panner are created
 * fresh each time, because an `AudioBufferSourceNode` is single-use by specification — you
 * cannot restart one, and the browser collects the little chain once it has finished.
 */

/** Where the sound is being heard from: a position and the direction "right". */
export interface Listener {
  x: number;
  y: number;
  planeX: number;
  planeY: number;
}

export class Mixer {
  private readonly context: AudioContext;
  private readonly sounds: SoundSet;

  private readonly master: GainNode;
  private readonly sfx: GainNode;
  private readonly music: GainNode;

  /** The ambience loop, once started. Kept so it can be stopped and restarted. */
  private ambience: AudioBufferSourceNode | undefined;
  private ambienceSound: Sound | undefined;

  private muted = false;

  constructor(context: AudioContext, sounds: SoundSet) {
    this.context = context;
    this.sounds = sounds;

    this.master = context.createGain();
    this.master.connect(context.destination);

    this.sfx = context.createGain();
    this.sfx.connect(this.master);

    this.music = context.createGain();
    this.music.gain.value = 0.55;
    this.music.connect(this.master);
  }

  /**
   * Start or resume the audio context.
   *
   * Browsers create it suspended and refuse to start it except from a user gesture, so this
   * has to be called from a click or a key press. It is safe to call repeatedly — which is
   * the point, because the *first* gesture is not something the engine can predict.
   */
  resume(): void {
    if (this.context.state !== 'running') void this.context.resume();
  }

  get running(): boolean {
    return this.context.state === 'running';
  }

  /**
   * Play a sound at a place in the world, heard from where the listener is.
   *
   * Sounds beyond the maximum distance are dropped rather than played at zero volume. That
   * is not only cheaper: a silent source still occupies a voice, and a game with a hundred
   * distant emitters would spend its whole budget on things nobody can hear.
   */
  playAt(name: Sound, x: number, y: number, listener: Listener): void {
    if (this.muted) return;

    const deltaX = x - listener.x;
    const deltaY = y - listener.y;

    const distance = Math.hypot(deltaX, deltaY);
    if (distance >= AUDIO_MAX_DISTANCE) return;

    const volume = attenuation(distance);
    if (volume <= 0) return;

    const sound = this.sounds[name];
    if (!sound) return;

    const source = this.context.createBufferSource();
    source.buffer = sound.buffer;

    const gain = this.context.createGain();
    gain.gain.value = volume;

    const panner = this.context.createStereoPanner();
    panner.pan.value = panning(deltaX, deltaY, listener.planeX, listener.planeY);

    source.connect(gain).connect(panner).connect(this.sfx);
    source.start();
  }

  /** Start a looping bed on the music bus, replacing whatever was playing. */
  playMusic(name: Sound): void {
    const sound: LoadedSound | undefined = this.sounds[name];
    if (!sound) return;

    this.stopMusic();

    const source = this.context.createBufferSource();
    source.buffer = sound.buffer;
    source.loop = sound.spec.loop ?? true;

    if (sound.spec.loopStart !== undefined) {
      source.loopStart = sound.spec.loopStart;
      source.loopEnd = sound.buffer.duration;
    }

    source.connect(this.music);
    source.start(0, sound.spec.loopStart ?? 0);

    this.ambience = source;
    this.ambienceSound = name;
  }

  stopMusic(): void {
    if (!this.ambience) return;
    this.ambience.stop();
    this.ambience.disconnect();
    this.ambience = undefined;
  }

  /**
   * Silence everything, or bring it back.
   *
   * The master gain goes to zero rather than suspending the context, so the ambience keeps
   * its place in the loop and unmuting does not restart the bed from the beginning.
   */
  setMuted(muted: boolean): void {
    this.muted = muted;
    this.master.gain.value = muted ? 0 : 1;
  }

  get isMuted(): boolean {
    return this.muted;
  }

  /** Restart the ambience after unmuting if it was never started. */
  get musicPlaying(): boolean {
    return this.ambience !== undefined;
  }

  get currentMusic(): Sound | undefined {
    return this.ambienceSound;
  }
}
