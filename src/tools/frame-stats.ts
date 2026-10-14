/**
 * Frame timing for developer mode: the main-thread milliseconds each animation frame spends in input sampling,
 * fixed ticks and rendering, kept in a ring buffer with average / 95th percentile / max. The app records every
 * frame while developer mode is on, draws the summary in a corner and exposes the live stats as
 * `globalThis.__glFrameStats` for browser measurements. Named timings (e.g. a franchise week simulation) go
 * through `markDuration`, which logs `[perf] <label>: <ms> ms` and keeps the last value per label.
 */

/** Frames between two recomputations of the corner readout. */
const LABEL_EVERY = 30;

/** Milliseconds from a monotonic clock. */
export const perfNow = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** Summary of the recorded frames. */
export interface FrameSummary {
  frames: number;
  avgMs: number;
  p95Ms: number;
  maxMs: number;
}

export class FrameStats {
  private readonly samples: Float64Array;
  private count = 0;
  private next = 0;
  private recorded = 0;
  private labelAt = 0;
  private labelText: string | null = null;
  /** Last duration per label (markDuration). */
  readonly marks = new Map<string, number>();

  constructor(readonly capacity = 600) {
    this.samples = new Float64Array(Math.max(1, capacity));
  }

  record(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) return;
    this.samples[this.next] = ms;
    this.next = (this.next + 1) % this.samples.length;
    this.count = Math.min(this.count + 1, this.samples.length);
    this.recorded++;
  }

  reset(): void {
    this.count = 0;
    this.next = 0;
    this.labelText = null;
  }

  summary(): FrameSummary {
    const n = this.count;
    if (n === 0) return { frames: 0, avgMs: 0, p95Ms: 0, maxMs: 0 };
    const sorted = Array.from(this.samples.subarray(0, n)).sort((a, b) => a - b);
    const sum = sorted.reduce((s, v) => s + v, 0);
    return { frames: n, avgMs: sum / n, p95Ms: sorted[Math.min(n - 1, Math.floor(n * 0.95))] ?? 0, maxMs: sorted[n - 1] ?? 0 };
  }

  /**
   * "FRAME 2.1ms P95 3.4 MAX 7.9" for the corner readout; recomputed every LABEL_EVERY recordings (sorting the
   * ring every frame would itself show up in the measurement).
   */
  label(): string {
    if (this.labelText === null || this.recorded - this.labelAt >= LABEL_EVERY) {
      const s = this.summary();
      this.labelText = `FRAME ${s.avgMs.toFixed(1)}ms P95 ${s.p95Ms.toFixed(1)} MAX ${s.maxMs.toFixed(1)}`;
      this.labelAt = this.recorded;
    }
    return this.labelText;
  }
}

/** The stats of the running app (null unless developer mode created them). */
let active: FrameStats | null = null;

/** Installs (or clears) the app's stats and mirrors them on globalThis for browser tooling. */
export const setActiveFrameStats = (stats: FrameStats | null): void => {
  active = stats;
  (globalThis as { __glFrameStats?: FrameStats | null }).__glFrameStats = stats;
};

/** Records a named duration (developer mode only; a no-op otherwise). Returns the milliseconds. */
export const markDuration = (label: string, startMs: number): number => {
  const ms = perfNow() - startMs;
  if (active) {
    active.marks.set(label, ms);
    console.info(`[perf] ${label}: ${ms.toFixed(1)} ms`);
  }
  return ms;
};
