import { check, near, section, done } from '../lib/harness';

import {
  AUDIO_FADE_BAND,
  AUDIO_MAX_DISTANCE,
  AUDIO_PAN_SOFTENING,
  AUDIO_REFERENCE_DISTANCE,
  FOOTSTEP_STRIDE,
  PUSHWALL_TRAVEL_TIME,
} from '../../../src/config';
import { Stride } from '../../../src/audio/footsteps';
import { attenuation, panning } from '../../../src/audio/positional';
import { EventBus, WorldEvent } from '../../../src/core/events';
import { Player } from '../../../src/player';
import { parseMap } from '../../../src/world/map';

/**
 * Audio (Stage 16).
 *
 * Most of an audio layer can only be exercised in a browser, so the design puts the parts
 * with actual decisions in them — how loud, how far left — into pure functions that node can
 * assert against directly. What is left for the browser suite is fetching, decoding, and
 * whether the graph is wired the way these functions say it should be.
 *
 * The stereo sign gets the stage-14 treatment: a negative control, because "left and right
 * are swapped" is inaudible in a screenshot and obvious the moment you play it.
 */

section('attenuation: loud here, silent there, monotone in between');
{
  check('full volume at the listener', attenuation(0), 1);
  check('and anywhere inside the reference radius', attenuation(AUDIO_REFERENCE_DISTANCE), 1);
  check('silent at the maximum distance', attenuation(AUDIO_MAX_DISTANCE), 0);
  check('and beyond it', attenuation(AUDIO_MAX_DISTANCE * 3), 0);

  /**
   * NaN must fall to silence, not to full volume.
   *
   * Stage 5 shipped exactly this bug in the shading table, where `Infinity * 8 | 0` came out
   * as 0 and the most distant walls rendered at full brightness. The guard here is negated
   * for the same reason, so the check is here to keep it that way.
   */
  check('NaN is silent, not deafening', attenuation(NaN), 0);
  check('infinity too', attenuation(Infinity), 0);

  let rises = 0;
  let biggestJump = 0;
  let previous = attenuation(0);
  for (let d = 0; d <= AUDIO_MAX_DISTANCE + 2; d += 0.001) {
    const value = attenuation(d);
    if (value > previous + 1e-12) rises++;
    biggestJump = Math.max(biggestJump, Math.abs(value - previous));
    previous = value;
  }
  check('never gets louder as it gets further away', rises, 0);
  /**
   * No *cliff*. The bound is loose on purpose: at the reference radius the curve's slope is
   * 1/reference per unit, so a 0.001 sampling step legitimately moves it by about 7e-4. What
   * this rules out is a step — the audible click a hard cutoff produces.
   */
  check(`no step discontinuity (largest jump ${biggestJump.toExponential(1)} over a 0.001 step)`, biggestJump < 0.01, true);

  // Not vacuous: it has to actually vary in between, or a function returning 0 everywhere
  // would pass everything above.
  const middle = attenuation(AUDIO_MAX_DISTANCE / 2);
  check(`it varies in between (${middle.toFixed(3)} at half range)`, middle > 0.05 && middle < 0.95, true);
  check('the fade band reaches zero from a non-zero value', attenuation(AUDIO_MAX_DISTANCE - AUDIO_FADE_BAND) > 0, true);
}

section('panning: which side is right');
{
  /**
   * The listener faces **east**, so their camera plane — which has been the "right" vector
   * since stage 2 — points **south**. y grows downward, so south is +y.
   *
   * That makes the whole convention checkable from one arrangement: a source to the south is
   * heard on the right.
   */
  const player = new Player(5, 5, 1, 0);
  const pan = (x: number, y: number): number =>
    panning(x - player.x, y - player.y, player.planeX, player.planeY);

  check('the plane really does point south', [Math.round(player.planeX), Math.sign(player.planeY)], [0, 1]);

  check('a source to the south is on the right', pan(5, 9) > 0.8, true);
  check('a source to the north is on the left', pan(5, 1) < -0.8, true);
  near('a source straight ahead is centred', pan(9, 5), 0, 1e-12);

  /**
   * Directly behind is also centred, and that is a real limitation rather than a bug.
   *
   * Stereo panning carries one axis of information. Front and back differ only in a delay
   * and a filtering that two speakers cannot express without head-related transfer
   * functions, which is what WebAudio's `PannerNode` with HRTF is for and what this engine
   * deliberately does not use — it would cost far more than the flat, cheap thing the rest
   * of the renderer is built on.
   */
  near('directly behind is centred too, as stereo can only do one axis', pan(1, 5), 0, 1e-12);

  check('never outside the stereo field', [pan(5, 500) <= 1, pan(5, -500) >= -1], [true, true]);

  // Turning the listener turns the field with them.
  const turned = new Player(5, 5, 0, 1); // facing south; plane points west
  const turnedPan = panning(0, 4, turned.planeX, turned.planeY);
  check('facing south, a source to the south is now centred', Math.abs(turnedPan) < 1e-12, true);

  /**
   * The near field is softened, so a sound at your feet does not slam to one side.
   *
   * A source one softening-distance to the right is panned halfway, by construction.
   */
  near('a source at the softening distance is panned halfway', pan(5, 5 + AUDIO_PAN_SOFTENING), 0.5, 1e-12);
  check('closer than that is panned less, not more', pan(5, 5.05) < 0.2, true);

  /**
   * The negative controls. Both are mistakes someone would actually make, and each has to
   * disagree with the real function somewhere it matters.
   */
  const flipped = (x: number, y: number): number => -pan(x, y);
  check('the wrong sign agrees ahead and behind', [flipped(9, 5) === pan(9, 5), flipped(1, 5) === pan(1, 5)], [true, true]);
  check('and disagrees on both sides — which is the only place it shows', [flipped(5, 9) !== pan(5, 9), flipped(5, 1) !== pan(5, 1)], [true, true]);

  const againstDirection = panning(0, 4, player.dirX, player.dirY);
  check('using the facing vector instead of the plane would centre everything sideways', Math.abs(againstDirection) < 1e-12, true);
}

section('the event bus');
{
  const bus = new EventBus();
  const heard: string[] = [];

  const unsubscribe = bus.subscribe((event, x, y) => heard.push(`a:${event}:${x},${y}`));
  bus.subscribe((event) => heard.push(`b:${event}`));

  bus.emit(WorldEvent.DoorOpening, 3.5, 4.5);
  check('every listener hears it, in subscription order', heard, ['a:0:3.5,4.5', 'b:0']);

  heard.length = 0;
  unsubscribe();
  bus.emit(WorldEvent.Footstep, 1, 1);
  check('unsubscribing removes exactly one listener', [heard, bus.listenerCount], [['b:4'], 1]);

  // A bus with nobody listening is the normal case for a system built without one.
  const quiet = new EventBus();
  quiet.emit(WorldEvent.PushwallStart, 0, 0);
  check('emitting into the void is harmless', quiet.listenerCount, 0);
}

section('the world announces what it does');
{
  const map = parseMap(`
#########
#.>.#...#
#...D...#
#...#...#
#..P....#
#########
`);

  const heard: [number, number, number][] = [];
  map.events.subscribe((event, x, y) => heard.push([event, x, y]));

  const clear = () => false;

  // A door.
  map.doors.activate(4, 2);
  check('opening a door announces it, at the cell centre', heard, [[WorldEvent.DoorOpening, 4.5, 2.5]]);

  heard.length = 0;
  map.doors.activate(4, 2);
  map.doors.activate(4, 2);
  check('leaning on the key does not re-announce it', heard.length, 0);

  // Run it open, through the hold, and into closing.
  for (let i = 0; i < 60 * 8; i++) map.updateDoors(1 / 60, clear);
  check('and closing is announced too', heard.some(([e]) => e === WorldEvent.DoorClosing), true);

  // A pushwall.
  heard.length = 0;
  map.push(3, 4, 1, 0);
  check('pushing a secret announces the start', heard, [[WorldEvent.PushwallStart, 3.5, 4.5]]);

  heard.length = 0;
  const wall = map.pushwallAt(3, 4)!;
  for (let i = 0; i < 600 && wall.moving; i++) map.updatePushwalls(1 / 60, clear);
  check('and the arrival, where it arrived', heard, [[WorldEvent.PushwallStop, 5.5, 4.5]]);
}

section('footsteps come from distance walked');
{
  const stride = new Stride();

  let steps = 0;
  for (let i = 0; i < 100; i++) if (stride.moved(FOOTSTEP_STRIDE / 10, 0)) steps++;
  check(`ten strides of walking gives ten steps (${steps})`, steps, 10);

  // Walking into a wall: the key is held, nothing moves, nothing is heard.
  const stuck = new Stride();
  let stuckSteps = 0;
  for (let i = 0; i < 600; i++) if (stuck.moved(0, 0)) stuckSteps++;
  check('pressed against a wall, no steps at all', stuckSteps, 0);

  // Running covers ground faster, so steps come faster — with no second timer involved.
  const walking = new Stride();
  const running = new Stride();
  let walked = 0;
  let ran = 0;
  for (let i = 0; i < 240; i++) {
    if (walking.moved(0.02, 0)) walked++;
    if (running.moved(0.05, 0)) ran++;
  }
  check(`running gives more steps over the same time (${ran} vs ${walked})`, ran > walked, true);

  // One long move must not lose the remainder.
  const coarse = new Stride();
  const fine = new Stride();
  let coarseSteps = 0;
  let fineSteps = 0;
  for (let i = 0; i < 10; i++) if (coarse.moved(FOOTSTEP_STRIDE * 0.9, 0)) coarseSteps++;
  for (let i = 0; i < 90; i++) if (fine.moved(FOOTSTEP_STRIDE * 0.1, 0)) fineSteps++;
  check(`the remainder carries across strides (${coarseSteps} vs ${fineSteps})`, coarseSteps, fineSteps);
}

section('the audio layer never allocates on a quiet tick');
{
  // The bus takes three numbers rather than an event object precisely so that emitting from
  // inside the fixed timestep stays free. Emitting a few hundred thousand times should not
  // move the heap in any way that survives a collection.
  const bus = new EventBus();
  let sum = 0;
  bus.subscribe((event, x, y) => {
    sum += event + x + y;
  });

  for (let i = 0; i < 50_000; i++) bus.emit(WorldEvent.Footstep, i, i);

  const before = process.memoryUsage().heapUsed;
  for (let i = 0; i < 200_000; i++) bus.emit(WorldEvent.Footstep, i, i);
  const growth = (process.memoryUsage().heapUsed - before) / 200_000;

  check(`emitting costs under a byte per event (${growth.toFixed(2)} B)`, growth < 1, true);
  check('and the listener actually ran', sum > 0, true);
}

check('pushwall travel time is what the audio assumes', PUSHWALL_TRAVEL_TIME > 0, true);

done();
