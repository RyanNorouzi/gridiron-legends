/**
 * When a franchise screen (hub, Playoffs mode) writes its League to the save slot. Commits mark the autosaver as
 * before, but a completed week, a finished user game or a phase change is flushed at once (one write per burst:
 * game day's 'gameEnd' + 'weekAdvance' pair coalesce into a single save on the next microtask), so a reload right
 * after the week recap cannot bring back the week before.
 *
 * During a multi-week SimJob the per-week checkpoints only HOLD the reason (no debounce timer, no write): the League
 * is serialized every `everyWeeks` weeks, after `everyMs`, and on every phase step, instead of after every week (the
 * whole, ever-growing League was re-serialized on the main thread each week, stalling the sim). A page hide still
 * flushes whatever is held; the end of the sim commits normally and is flushed at once.
 */
import type { Autosaver } from '@/save/autosave';
import type { CommitReason } from '../context';

/** Commit reasons that must reach storage right away. */
export const DURABLE_REASONS: ReadonlySet<CommitReason> = new Set<CommitReason>(['weekAdvance', 'gameEnd', 'phaseChange']);

/** Options of a LeagueSaveGate. */
export interface LeagueSaveGateOptions {
  /** Called when a flush fails (a toast). */
  onError?(): void;
  /** Mid-sim checkpoints: flush after this many weeks (default 4) ... */
  everyWeeks?: number;
  /** ... or once this many milliseconds passed since the last flush (default 5000). */
  everyMs?: number;
  /** Clock (default performance.now / Date.now). */
  now?: () => number;
  /** Microtask queue seam (default queueMicrotask). */
  defer?: (cb: () => void) => void;
}

const defaultNow = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** See the module header. */
export class LeagueSaveGate {
  private inCheckpoint = false;
  private flushQueued = false;
  private weeksSinceFlush = 0;
  private lastFlushAt: number;
  private readonly now: () => number;

  constructor(private readonly saver: () => Autosaver | null, private readonly opts: LeagueSaveGateOptions = {}) {
    this.now = opts.now ?? defaultNow;
    this.lastFlushAt = this.now();
  }

  /** After a League commit: 'edit' and the other reasons are debounced; durable ones are flushed at once. */
  committed(reason: CommitReason): void {
    const s = this.saver();
    if (!s) return;
    if (this.inCheckpoint) {
      s.hold(reason);
      return;
    }
    s.mark(reason);
    if (DURABLE_REASONS.has(reason)) this.flushSoon();
  }

  /**
   * A mid-sim checkpoint: `commit` commits the League (its commit reaches `committed`, which only holds it); the
   * slot is written every few weeks / seconds and on every phase step.
   */
  checkpoint(kind: 'week' | 'phase', commit: () => void): void {
    this.inCheckpoint = true;
    try {
      commit();
    } finally {
      this.inCheckpoint = false;
    }
    this.weeksSinceFlush += kind === 'week' ? 1 : 0;
    const due = kind === 'phase' || this.weeksSinceFlush >= (this.opts.everyWeeks ?? 4) || this.now() - this.lastFlushAt >= (this.opts.everyMs ?? 5000);
    if (due) this.flushNow();
  }

  /** Writes whatever is pending now. */
  flushNow(): void {
    const s = this.saver();
    this.weeksSinceFlush = 0;
    this.lastFlushAt = this.now();
    if (!s) return;
    s.flush().catch(() => this.opts.onError?.());
  }

  /** One flush for a burst of durable commits made in the same synchronous run. */
  private flushSoon(): void {
    if (this.flushQueued) return;
    this.flushQueued = true;
    (this.opts.defer ?? queueMicrotask)(() => {
      this.flushQueued = false;
      this.flushNow();
    });
  }
}
