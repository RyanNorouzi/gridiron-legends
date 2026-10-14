import { MAX_TICKS_PER_FRAME, TICK_DT } from './time';

/**
 * Fixed-timestep loop: simulation ticks at TICK_RATE regardless of frame rate;
 * rendering happens once per frame with an interpolation alpha.
 * Scheduler and clock are injectable so the loop is testable headlessly.
 */
export interface LoopHooks {
  tick: (dt: number) => void;
  render: (alpha: number, frameDt: number) => void;
}

export interface LoopOptions {
  /** Returns milliseconds. Defaults to performance.now(). */
  now?: () => number;
  /** Schedules the next frame. Defaults to requestAnimationFrame. */
  schedule?: (cb: () => void) => void;
  /** Simulation speed multiplier (1 = real time). */
  speed?: number;
}

export class GameLoop {
  private running = false;
  private accumulator = 0;
  private lastTime = 0;
  private readonly now: () => number;
  private readonly schedule: (cb: () => void) => void;
  speed: number;
  /** Total simulation ticks processed. */
  ticks = 0;
  paused = false;

  constructor(private readonly hooks: LoopHooks, opts: LoopOptions = {}) {
    this.now = opts.now ?? (() => performance.now());
    this.schedule = opts.schedule ?? ((cb) => requestAnimationFrame(cb));
    this.speed = opts.speed ?? 1;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastTime = this.now();
    this.accumulator = 0;
    this.schedule(this.frame);
  }

  stop(): void {
    this.running = false;
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** Advance exactly one simulation tick (used by step-through debugging and tests). */
  step(): void {
    this.hooks.tick(TICK_DT);
    this.ticks++;
  }

  /** Process one frame worth of time; public so tests can drive it without a scheduler. */
  frame = (): void => {
    if (!this.running) return;
    const t = this.now();
    let frameDt = (t - this.lastTime) / 1000;
    this.lastTime = t;
    if (frameDt > 0.25) frameDt = 0.25;
    if (!this.paused) {
      this.accumulator += frameDt * this.speed;
      let n = 0;
      while (this.accumulator >= TICK_DT && n < MAX_TICKS_PER_FRAME) {
        this.step();
        this.accumulator -= TICK_DT;
        n++;
      }
      if (n === MAX_TICKS_PER_FRAME) this.accumulator = 0;
    }
    const alpha = this.paused ? 0 : this.accumulator / TICK_DT;
    this.hooks.render(alpha, frameDt);
    this.schedule(this.frame);
  };
}
