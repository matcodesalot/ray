const BASE = process.env.RAY_URL ?? 'http://localhost:5173/';
import { createRequire } from 'node:module';

// Run against `npm run dev`. Fetching, decoding and the WebAudio graph itself need a real
// browser; the maths that decides how loud and how far left lives in pure functions and is
// checked in node/audio.ts instead.
const { chromium } = createRequire(import.meta.url)('playwright');

const browser = await chromium.launch();
const page = await browser.newPage();
const warnings = [];
page.on('console', (m) => { if (m.type() === 'warning' || m.type() === 'error') warnings.push(`${m.type()}: ${m.text()}`); });
await page.goto(BASE, { waitUntil: 'domcontentloaded' });

const result = await page.evaluate(async () => {
  const { loadSounds } = await import('/src/audio/loader.ts');
  const { Sound, SOUND_MANIFEST } = await import('/src/audio/manifest.ts');
  const { Mixer } = await import('/src/audio/mixer.ts');
  const { AUDIO_MAX_DISTANCE } = await import('/src/config.ts');
  const { Player } = await import('/src/player.ts');

  const RATE = 44100;
  const context = new OfflineAudioContext(2, RATE * 2, RATE);

  const t0 = performance.now();
  const sounds = await loadSounds(context);
  const ms = Math.round(performance.now() - t0);

  const describe = (sound) => {
    const b = sound.buffer;
    let peak = 0;
    const d = b.getChannelData(0);
    for (let i = 0; i < d.length; i++) { const a = Math.abs(d[i]); if (a > peak) peak = a; }
    return { channels: b.numberOfChannels, seconds: +b.duration.toFixed(2), peak: +peak.toFixed(3),
             rate: b.sampleRate, gain: sound.spec.gain, music: !!sound.spec.music,
             loopStart: sound.spec.loopStart ?? null };
  };

  const described = {};
  for (const name of Object.values(Sound)) described[name] = describe(sounds[name]);

  /**
   * Render one shot through the whole graph and measure each ear.
   *
   * This is the end-to-end version of the pan check: node/audio.ts asserts the pure
   * function, and this asserts that the number it returns actually reaches a
   * StereoPannerNode the right way round.
   */
  const render = async (place) => {
    const ctx = new OfflineAudioContext(2, RATE * 2, RATE);
    const set = await loadSounds(ctx);
    const mixer = new Mixer(ctx, set);
    place(mixer);
    const out = await ctx.startRendering();
    const energy = (ch) => {
      const d = out.getChannelData(ch);
      let sum = 0;
      for (let i = 0; i < d.length; i++) sum += d[i] * d[i];
      return sum;
    };
    return { left: energy(0), right: energy(1) };
  };

  // Listener at (5,5) facing east: the camera plane points south, so south is on the right.
  const listener = new Player(5, 5, 1, 0);

  const south = await render((m) => m.playAt(Sound.Footstep, 5, 9, listener));
  const north = await render((m) => m.playAt(Sound.Footstep, 5, 1, listener));
  const ahead = await render((m) => m.playAt(Sound.Footstep, 9, 5, listener));
  const near = await render((m) => m.playAt(Sound.Footstep, 6, 5, listener));
  const far = await render((m) => m.playAt(Sound.Footstep, 5 + AUDIO_MAX_DISTANCE + 1, 5, listener));
  const muted = await render((m) => { m.setMuted(true); m.playAt(Sound.Footstep, 6, 5, listener); });
  const music = await render((m) => m.playMusic(Sound.Ambience));

  return {
    ms,
    names: Object.keys(described).sort(),
    described,
    manifestCount: Object.keys(SOUND_MANIFEST).length,
    south, north, ahead, near, far, muted, music,
  };
});

let bad = 0;
const say = (ok, msg) => { if (!ok) bad++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); };
const total = (e) => e.left + e.right;

console.log('--- every sound the manifest names fetches and decodes ---');
say(result.names.length === result.manifestCount, `${result.names.length} sounds loaded: ${result.names}`);
for (const [name, d] of Object.entries(result.described)) {
  say(d.seconds > 0 && d.peak > 0, `${name}: ${d.seconds}s, ${d.channels}ch, peak ${d.peak}`);
}

console.log('\n--- effects are mono, music keeps its stereo image ---');
for (const [name, d] of Object.entries(result.described)) {
  if (d.music) say(d.channels === 2, `${name}: stereo (${d.channels}ch), and not panned`);
  else say(d.channels === 1, `${name}: folded to mono (${d.channels}ch) so the panner has something to place`);
}
say(result.described.ambience.loopStart > 0, `ambience skips its ${result.described.ambience.loopStart}s of lead-in silence when looping`);

console.log('\n--- the manifest gain is baked in at load ---');
{
  // The stone door is quiet in the source file and is corrected by a gain well above 1; the
  // corrected peak has to have moved with it.
  const p = result.described.pushwall;
  say(p.gain > 1 && p.peak > 0.3, `pushwall: source peaked at 0.15, gain ${p.gain} brings it to ${p.peak}`);
  say(p.peak <= 1.001, `and does not clip (${p.peak})`);
}

console.log('\n--- which ear, all the way through the graph ---');
say(result.south.right > result.south.left * 3, `a source to the south is heard on the right (R/L ${(result.south.right / result.south.left).toFixed(1)})`);
say(result.north.left > result.north.right * 3, `a source to the north is heard on the left (L/R ${(result.north.left / result.north.right).toFixed(1)})`);
say(Math.abs(result.ahead.left - result.ahead.right) / total(result.ahead) < 0.05, 'a source straight ahead is centred');
say(total(result.near) > total(result.south), 'a close source is louder than a distant one');
say(total(result.far) === 0, 'a source past the maximum distance is not played at all');
say(total(result.muted) === 0, 'muting silences the master bus');
say(total(result.music) > 0, 'the ambience plays on the music bus');

console.log('\n--- no complaints ---');
say(warnings.length === 0, `no console warnings or errors${warnings.length ? `: ${warnings.join(' | ')}` : ''}`);

console.log(`\ndecoded ${result.names.length} sounds in ${result.ms}ms`);
console.log(bad === 0 ? 'all checks passed' : `${bad} FAILED`);
await browser.close();
process.exit(bad === 0 ? 0 : 1);
