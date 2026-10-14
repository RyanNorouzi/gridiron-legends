/**
 * Per-play animation memory, owned by the UI (never the engine). It holds what a single frame cannot know:
 *  - the ODOMETER: yards each athlete has travelled this play, so run cycles advance with distance (no foot
 *    sliding). When the play's recorded frames are available (live plays with replays on, and every replay) it
 *    is computed from those frames, so live play and its replay (and any replay seek) give identical phases;
 *    otherwise it accumulates the positions it is shown (as it also does past the last recorded frame: a live
 *    play's post-whistle settle, whose frames are only attached to the replay);
 *  - the running ONE-SHOT per athlete (a throw, catch or hit plays to its end even after the state that started
 *    it changes, until something of higher priority takes over);
 *  - the last look (transitions such as getUp after lying down, cuts from heading changes) and which way a body
 *    fell.
 * `sync` resets everything when the play changes (new `playKey`) or the clock jumps backward / far forward (a
 * replay seek); event-driven looks are then rebuilt from `scene.events`, so a seek looks the same as playback.
 * Events are indexed per athlete for the selection layer and chain B (`eventsOf`, `lastEvent`, `timeSince`).
 */
import type { PlayEvent } from '@/game/play-events';
import type { ReplayFrame } from '@/game/play-types';
import type { AnimId } from './anim-ids';
import type { Look } from './anim';

/** Simulation ticks per second (the engine's fixed rate). */
export const SCENE_TICK_RATE = 60;

/** A forward clock jump beyond this many ticks is treated as a seek. */
export const SEEK_TICKS = 45;

/** The running one-shot of an athlete. */
export interface OneShot {
  clip: AnimId;
  /** Scene seconds when it started. */
  start: number;
}

/** Memory for one athlete. */
export interface AthleteAnimMemory {
  /** Yards travelled (fallback odometer when no frames are recorded). */
  odo: number;
  lastX: number;
  lastY: number;
  seen: boolean;
  oneShot: OneShot | null;
  last: Look | null;
  /** Screen heading (radians) and when it was sampled, for cut detection. */
  heading: number | null;
  headingAt: number;
  fell: 'fwd' | 'back' | null;
  /** Scene seconds when the body was last lying down (getUp trigger). */
  lyingUntil: number | null;
  /** Fallback odometer reading when the clock passed the last recorded frame (null before that). */
  pastOdo: number | null;
}

/** Per-athlete odometer from recorded frames (prefix sums per frame index, extended as frames arrive). */
class FrameOdometer {
  private frames: readonly ReplayFrame[] | null = null;
  private readonly sums = new Map<string, number[]>();
  private readonly lastPos = new Map<string, { x: number; y: number }>();
  private done = 0;

  /** Binds to a frames array (a new array or a shorter one restarts the sums). */
  bind(frames: readonly ReplayFrame[]): void {
    if (frames !== this.frames || frames.length < this.done) {
      this.frames = frames;
      this.sums.clear();
      this.lastPos.clear();
      this.done = 0;
    }
    for (; this.done < frames.length; this.done++) {
      const f = frames[this.done] as ReplayFrame;
      for (const a of f.athletes) {
        let arr = this.sums.get(a.id);
        const prev = this.lastPos.get(a.id);
        if (!arr) {
          arr = [];
          this.sums.set(a.id, arr);
        }
        const d = prev ? Math.hypot(a.x - prev.x, a.y - prev.y) : 0;
        // Frames where the athlete was missing repeat the previous total.
        while (arr.length < this.done) arr.push(arr[arr.length - 1] ?? 0);
        arr.push((arr[arr.length - 1] ?? 0) + d);
        this.lastPos.set(a.id, { x: a.x, y: a.y });
      }
    }
  }

  /** Yards travelled up to fractional frame index `fi` (null when this athlete has no frames). */
  distance(id: string, fi: number): number | null {
    const arr = this.sums.get(id);
    if (!arr || arr.length === 0) return null;
    const i0 = Math.max(0, Math.min(arr.length - 1, Math.floor(fi)));
    const i1 = Math.min(arr.length - 1, i0 + 1);
    const t = Math.max(0, Math.min(1, fi - i0));
    const a = arr[i0] ?? 0;
    return a + ((arr[i1] ?? a) - a) * t;
  }

  /** Fractional frame index of a (fractional) scene tick. Frames hold consecutive ticks. */
  indexOf(tick: number): number {
    const f = this.frames;
    if (!f || f.length === 0) return 0;
    return Math.max(0, Math.min(f.length - 1, tick - (f[0] as ReplayFrame).tick));
  }

  /** True when `tick` lies after the last recorded frame. */
  isPast(tick: number): boolean {
    const f = this.frames;
    return !!f && f.length > 0 && tick > (f[f.length - 1] as ReplayFrame).tick + 1e-6;
  }
}

/** Per-athlete event lists (built incrementally; events are append-only within a play). */
class EventIndex {
  private events: readonly PlayEvent[] | null = null;
  private done = 0;
  private readonly byId = new Map<string, PlayEvent[]>();

  bind(events: readonly PlayEvent[]): void {
    if (events !== this.events || events.length < this.done) {
      this.events = events;
      this.byId.clear();
      this.done = 0;
    }
    for (; this.done < events.length; this.done++) {
      const e = events[this.done] as PlayEvent;
      for (const id of eventActors(e)) {
        let list = this.byId.get(id);
        if (!list) this.byId.set(id, (list = []));
        list.push(e);
      }
    }
  }

  of(id: string): readonly PlayEvent[] {
    return this.byId.get(id) ?? [];
  }
}

/** Athlete ids an event concerns (every AthleteId-valued field, plus assists). */
export const eventActors = (e: PlayEvent): string[] => {
  const out: string[] = [];
  for (const [k, v] of Object.entries(e)) {
    if (k === 'type' || k === 'tick' || k === 'side') continue;
    if (typeof v === 'string' && v.includes(':')) out.push(v);
    else if (Array.isArray(v)) for (const x of v) if (typeof x === 'string' && x.includes(':')) out.push(x);
  }
  return out;
};

/** What `sync` needs from the scene. */
export interface MemorySyncInput {
  playKey: string | null;
  /** Fractional scene tick. */
  tick: number;
  events: readonly PlayEvent[];
  frames: readonly ReplayFrame[] | null;
}

/** Animation memory of one view (a camera): odometer, one-shots, last looks, event index; reset per play / seek. */
export class AnimMemory {
  private playKey: string | null = null;
  private lastTick = Number.NaN;
  private readonly athletes = new Map<string, AthleteAnimMemory>();
  private readonly odometer = new FrameOdometer();
  private readonly index = new EventIndex();
  private hasFrames = false;
  private past = false;
  /** Scene seconds of the current sync. */
  now = 0;
  tick = 0;
  events: readonly PlayEvent[] = [];
  /** Times the memory was reset (new play or seek); tests and the dev overlay read it. */
  resets = 0;

  /** Aligns the memory with the scene; returns true when it was reset (new play or seek). */
  sync(input: MemorySyncInput): boolean {
    const jumped = Number.isFinite(this.lastTick) && (input.tick < this.lastTick - 1e-6 || input.tick > this.lastTick + SEEK_TICKS);
    const reset = input.playKey !== this.playKey || jumped || !Number.isFinite(this.lastTick);
    if (reset) {
      this.athletes.clear();
      this.playKey = input.playKey;
      this.resets++;
    }
    this.lastTick = input.tick;
    this.tick = input.tick;
    this.now = input.tick / SCENE_TICK_RATE;
    this.events = input.events;
    this.index.bind(input.events);
    this.hasFrames = input.frames !== null && input.frames.length > 0;
    if (input.frames) this.odometer.bind(input.frames);
    // Crossing past the last recorded frame: the positions observed from here on continue each odometer.
    const past = this.hasFrames && this.odometer.isPast(input.tick);
    if (past && !this.past) for (const m of this.athletes.values()) m.pastOdo = m.odo;
    this.past = past;
    return reset;
  }

  /** The memory of athlete `id` (created on first use). */
  of(id: string): AthleteAnimMemory {
    let m = this.athletes.get(id);
    if (!m) {
      m = { odo: 0, lastX: 0, lastY: 0, seen: false, oneShot: null, last: null, heading: null, headingAt: 0, fell: null, lyingUntil: null, pastOdo: null };
      this.athletes.set(id, m);
    }
    return m;
  }

  /**
   * Yards athlete `id` has travelled this play at the current tick: from the recorded frames when present, else
   * the accumulated positions shown so far (call `observe` once per frame first). Past the last recorded frame (a
   * live play's post-whistle settle) it continues from the last frame's total with the positions shown since, so a
   * body easing to a stop keeps striding instead of sliding.
   */
  distance(id: string): number {
    const m = this.of(id);
    if (this.hasFrames) {
      const d = this.odometer.distance(id, this.odometer.indexOf(this.tick));
      if (d !== null) {
        if (!this.past) return d;
        if (m.pastOdo === null) m.pastOdo = m.odo;
        return d + (m.odo - m.pastOdo);
      }
    }
    return m.odo;
  }

  /** Feeds the fallback odometer with the athlete's shown position. */
  observe(id: string, x: number, y: number): void {
    const m = this.of(id);
    if (m.seen) m.odo += Math.hypot(x - m.lastX, y - m.lastY);
    m.lastX = x;
    m.lastY = y;
    m.seen = true;
  }

  /** Events concerning athlete `id`, in order. */
  eventsOf(id: string): readonly PlayEvent[] {
    return this.index.of(id);
  }

  /** The athlete's latest event of `type` at or before the current tick, or null. */
  lastEvent<T extends PlayEvent['type']>(id: string, type: T): Extract<PlayEvent, { type: T }> | null {
    const list = this.index.of(id);
    for (let i = list.length - 1; i >= 0; i--) {
      const e = list[i] as PlayEvent;
      if (e.type === type && e.tick <= this.tick + 1e-6) return e as Extract<PlayEvent, { type: T }>;
    }
    return null;
  }

  /** Seconds since an event (negative before it). */
  timeSince(e: { tick: number }): number {
    return (this.tick - e.tick) / SCENE_TICK_RATE;
  }
}
