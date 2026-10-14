/**
 * UI-side engagement tracker of chain B (never the engine): per view (one per AnimMemory, reset with it on a new
 * play or a seek) it keeps a short position history of every athlete on screen, keyed by scene tick, and when each
 * blocking pair was first seen locked up. From that it answers how an engaged pair is MOVING (the midpoint's
 * velocity over the last ~0.3 s: a drive block moves the pair downfield, a bull rush walks the blocker back, a
 * stalemate barely moves), which the engine only applies as a positional drift (no velocity on engaged bodies).
 * History is sampled at the scene ticks shown and read back by interpolation at whole-tick offsets, so a second
 * viewing at another frame rate (slow motion) reads the same velocities on every whole frame; pair start ticks are
 * rounded up to whole ticks for the same reason.
 */
import type { AnimMemory } from '../anim-memory';

interface Sample { t: number; x: number; y: number }

/** Ticks of history kept per athlete. */
const KEEP_TICKS = 90;
/** Age (ticks) given to a pair found already engaged on a tracker's first frame. */
const ESTABLISHED_TICKS = 60;

/** Tracker state of one view. */
export class ContactTrack {
  readonly hist = new Map<string, Sample[]>();
  readonly pairStart = new Map<string, number>();
  /** Last tick each pair was seen engaged (easing the render offset back out). */
  readonly pairSeen = new Map<string, { tick: number; offsets: ReadonlyMap<string, { dx: number; dy: number }> }>();
  /** Scene tick of the first frame this tracker saw (after a seek: the seek target). */
  born: number | null = null;
  constructor(readonly resets: number) {}

  /** Records an athlete's position (yards) at scene tick `t`. */
  record(id: string, t: number, x: number, y: number): void {
    if (this.born === null) this.born = t;
    let h = this.hist.get(id);
    if (!h) this.hist.set(id, (h = []));
    const last = h[h.length - 1];
    if (last && t <= last.t + 1e-9) {
      if (Math.abs(t - last.t) < 1e-9) { last.x = x; last.y = y; }
      return;
    }
    h.push({ t, x, y });
    while (h.length > 2 && (h[0] as Sample).t < t - KEEP_TICKS) h.shift();
  }

  /** Interpolated position at tick `t` (clamped to the history), or null when never seen. */
  posAt(id: string, t: number): { x: number; y: number } | null {
    const h = this.hist.get(id);
    if (!h || h.length === 0) return null;
    const first = h[0] as Sample;
    if (t <= first.t) return { x: first.x, y: first.y };
    for (let i = h.length - 1; i >= 0; i--) {
      const a = h[i] as Sample;
      if (a.t <= t) {
        const b = h[i + 1];
        if (!b) return { x: a.x, y: a.y };
        const k = (t - a.t) / (b.t - a.t);
        return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k };
      }
    }
    return { x: first.x, y: first.y };
  }

  /**
   * Velocity (yd/s) of the midpoint of `ids` over the last `window` ticks ending at `now` (a shorter span when the
   * history is shorter; zero under 4 ticks of history).
   */
  velocity(ids: readonly string[], now: number, window = 18): { x: number; y: number } {
    let t0 = now - window;
    for (const id of ids) {
      const h = this.hist.get(id);
      if (!h || h.length === 0) return { x: 0, y: 0 };
      t0 = Math.max(t0, Math.ceil((h[0] as Sample).t - 1e-9));
    }
    const span = now - t0;
    if (span < 4) return { x: 0, y: 0 };
    let vx = 0; let vy = 0;
    for (const id of ids) {
      const a = this.posAt(id, t0) as { x: number; y: number };
      const b = this.posAt(id, now) as { x: number; y: number };
      vx += b.x - a.x; vy += b.y - a.y;
    }
    const k = 60 / span / ids.length;
    return { x: vx * k, y: vy * k };
  }

  /**
   * Whole tick at which a pair was first seen engaged (registered now when new). A pair already locked up on the
   * tracker's first frame (a replay seek into the middle of a play) counts as long engaged: no punch replays.
   */
  startOf(key: string, now: number): number {
    let s = this.pairStart.get(key);
    if (s === undefined) {
      const midPlay = this.born !== null && now - this.born < 1;
      this.pairStart.set(key, (s = midPlay ? now - ESTABLISHED_TICKS : Math.ceil(now - 1e-9)));
    }
    return s;
  }
}

const tracks = new WeakMap<AnimMemory, ContactTrack>();

/** The tracker of a view's memory (fresh after the memory resets: a new play or a seek). */
export const trackOf = (mem: AnimMemory): ContactTrack => {
  let t = tracks.get(mem);
  if (!t || t.resets !== mem.resets) tracks.set(mem, (t = new ContactTrack(mem.resets)));
  return t;
};

/** Stable key of a pair of ids. */
export const pairKey = (a: string, b: string): string => (a < b ? `${a}|${b}` : `${b}|${a}`);
