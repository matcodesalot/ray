import { SOUND_MANIFEST, Sound, type SoundSpec } from './manifest';

/**
 * One decoded sound, ready to play.
 *
 * The gain from the manifest is baked into the samples rather than applied per playback.
 * It is a constant per sound, so multiplying it in once at load costs nothing at run time
 * and keeps the per-shot gain node free for what actually varies: distance.
 */
export interface LoadedSound {
  readonly name: Sound;
  readonly buffer: AudioBuffer;
  readonly spec: SoundSpec;
}

export type SoundSet = Readonly<Record<Sound, LoadedSound>>;

/**
 * Fetch and decode every sound the manifest names.
 *
 * Deliberately the same shape as `assets/loader.ts`: all of them at once, each failure
 * naming its file, and one async phase rather than lazy loading. A sound that arrives late
 * is a sound that does not play the first time it is needed, which reads as a bug.
 */
export async function loadSounds(context: BaseAudioContext): Promise<SoundSet> {
  const entries = Object.entries(SOUND_MANIFEST) as [Sound, SoundSpec][];

  const loaded = await Promise.all(entries.map(([name, spec]) => loadSound(context, name, spec)));

  const set = {} as Record<Sound, LoadedSound>;
  loaded.forEach((sound) => {
    set[sound.name] = sound;
  });

  return set;
}

async function loadSound(
  context: BaseAudioContext,
  name: Sound,
  spec: SoundSpec,
): Promise<LoadedSound> {
  const label = spec.url.split('/').pop() ?? spec.url;

  let encoded: ArrayBuffer;
  try {
    const response = await fetch(spec.url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    encoded = await response.arrayBuffer();
  } catch (error) {
    throw new Error(`Could not fetch sound ${label}: ${(error as Error).message}`);
  }

  let decoded: AudioBuffer;
  try {
    decoded = await context.decodeAudioData(encoded);
  } catch {
    // decodeAudioData rejects with a bare DOMException that names nothing useful, so the
    // format hint is the whole value of catching it here.
    throw new Error(
      `Could not decode ${label}. Sounds must be in a format this browser supports — ` +
        `Ogg Vorbis for everything except Safari, which wants MP3 or AAC.`,
    );
  }

  if (decoded.length === 0) {
    throw new Error(`${label} decoded to zero samples`);
  }

  const buffer = prepare(context, decoded, spec);
  return { name, buffer, spec };
}

/**
 * Apply the manifest's gain, and fold effects down to mono.
 *
 * The mono fold is a plain average rather than a sum, so a file whose two channels are
 * identical keeps its level instead of clipping — which is the common case, since most of
 * these were mastered from a mono recording.
 */
function prepare(context: BaseAudioContext, decoded: AudioBuffer, spec: SoundSpec): AudioBuffer {
  const channels = spec.music ? decoded.numberOfChannels : 1;

  if (channels === decoded.numberOfChannels && spec.gain === 1) return decoded;

  const output = context.createBuffer(channels, decoded.length, decoded.sampleRate);

  for (let channel = 0; channel < channels; channel++) {
    const target = output.getChannelData(channel);

    if (channels === decoded.numberOfChannels) {
      const source = decoded.getChannelData(channel);
      for (let i = 0; i < source.length; i++) target[i] = source[i]! * spec.gain;
      continue;
    }

    const scale = spec.gain / decoded.numberOfChannels;
    for (let c = 0; c < decoded.numberOfChannels; c++) {
      const source = decoded.getChannelData(c);
      for (let i = 0; i < source.length; i++) target[i] += source[i]! * scale;
    }
  }

  return output;
}
