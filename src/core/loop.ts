import { MAX_FRAME_TIME, TICK_HZ } from '../config';

export interface LoopHandlers {
  /**
   * Advance the simulation by exactly `dt` seconds. Called zero or more times per frame.
   *
   * `dt` is always the same value, which is the whole point: movement speed, door timers
   * and collision behave identically on a 60Hz laptop and a 240Hz monitor.
   */
  update(dt: number): void;

  /**
   * Draw one frame.
   *
   * `alpha` is how far we are between the last completed tick and the next one, in the
   * range [0, 1). Nothing uses it yet — it becomes useful if we ever want to interpolate
   * the camera between ticks to smooth motion on high-refresh displays.
   */
  render(alpha: number): void;
}

/**
 * Fixed-timestep game loop with an accumulator.
 *
 * Frames arrive at whatever rate the display runs at, and that rate is not something we
 * control or can rely on. So we bank the elapsed real time in an accumulator and spend it
 * in fixed-size chunks: the simulation only ever sees one step size, and any leftover
 * remains banked for next frame.
 *
 * Returns a function that stops the loop.
 */
export function startLoop(handlers: LoopHandlers): () => void {
  const step = 1 / TICK_HZ;

  let accumulator = 0;
  let previous = performance.now();
  let handle = 0;

  const frame = (now: number): void => {
    handle = requestAnimationFrame(frame);

    let elapsed = (now - previous) / 1000;
    previous = now;

    // Guard against the "spiral of death": a long stall (backgrounded tab, breakpoint)
    // would otherwise demand hundreds of catch-up ticks, which takes longer than the
    // stall did, which demands more catch-up ticks...
    if (elapsed > MAX_FRAME_TIME) elapsed = MAX_FRAME_TIME;

    accumulator += elapsed;
    while (accumulator >= step) {
      handlers.update(step);
      accumulator -= step;
    }

    handlers.render(accumulator / step);
  };

  handle = requestAnimationFrame(frame);
  return () => cancelAnimationFrame(handle);
}

/** Rolling frames-per-second measurement over a short window. */
export class FpsCounter {
  /** Frames per second, averaged over the last window. Zero until the first window closes. */
  value = 0;

  private frames = 0;
  private windowStart = performance.now();

  /** Call once per rendered frame. */
  tick(now: number = performance.now()): void {
    this.frames++;
    const elapsed = now - this.windowStart;
    if (elapsed >= 500) {
      this.value = (this.frames * 1000) / elapsed;
      this.frames = 0;
      this.windowStart = now;
    }
  }
}
