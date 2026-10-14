/**
 * After-the-whistle presentation for the game screen. `DeadBallMotion` keeps a dead play's bodies moving (the
 * engine's presentation-only settle, see game/systems/post-whistle.ts) on the render clock, so they keep easing to a
 * stop while the post-play card, a penalty prompt, the challenge window or the play-call overlay is up (overlays stop
 * the game screen's update, never its render). `ImpactFeedback` turns big hits into a short camera shake; it never
 * pauses the simulation (no hit-stop) and the screen skips it under reduced motion or with screen shake off.
 * `attachSettleFrames` extends a finished play's replay recording with its settle, so replays and highlights end with
 * the bodies easing to a stop too.
 */
import { TICK_DT } from '@/core/time';
import type { LivePlay } from '@/game/engine-api';
import type { ReplayRecording } from '@/game/play-types';
import { canSettle } from '@/game/systems/post-whistle';
import type { SnapshotBuffer } from './interp';

/** Settle ticks run at most this many times per rendered frame (a long hitch never fast-forwards the scene). */
export const MAX_SETTLE_STEPS_PER_FRAME = 8;
/** Longest frame gap (seconds) the settle catches up on. */
export const MAX_SETTLE_FRAME_GAP = 0.25;

/** Drives a dead play's settle from wall-clock time and keeps the interpolation buffer in step. */
export class DeadBallMotion {
  private play: LivePlay | null = null;
  private last = 0;
  private acc = 0;
  private running = false;

  /** Whether the current dead play is still settling. */
  get settling(): boolean {
    return this.running;
  }

  /**
   * Advances the settle of `play` (when dead and settleable) to `time` seconds. Returns the interpolation alpha to
   * draw it with, or null when nothing is settling (draw with the loop's alpha). `paused` holds the scene still.
   */
  advance(play: LivePlay | null, time: number, snapshot: SnapshotBuffer | null, paused = false): number | null {
    if (!play || !play.isDead || !canSettle(play)) {
      this.play = null;
      this.running = false;
      return null;
    }
    if (play !== this.play) {
      this.play = play;
      this.last = time;
      this.acc = 0;
      this.running = true;
      return 1;
    }
    const dt = Math.min(MAX_SETTLE_FRAME_GAP, Math.max(0, time - this.last));
    this.last = time;
    if (!this.running) return null;
    if (!paused) this.acc += dt;
    let steps = 0;
    while (this.acc >= TICK_DT && steps < MAX_SETTLE_STEPS_PER_FRAME) {
      this.acc -= TICK_DT;
      steps += 1;
      const more = play.settle();
      snapshot?.capture(play.state);
      if (!more) {
        // At rest: capture twice so previous == current and nothing interpolates any more.
        snapshot?.capture(play.state);
        this.running = false;
        this.acc = 0;
        return null;
      }
    }
    if (steps >= MAX_SETTLE_STEPS_PER_FRAME) this.acc = Math.min(this.acc, TICK_DT);
    return Math.min(1, this.acc / TICK_DT);
  }
}

/** Camera shake (pixels, seconds) for a big hit. */
export const HIT_SHAKE: Readonly<{ amplitude: number; seconds: number }> = Object.freeze({ amplitude: 1, seconds: 0.12 });

/**
 * Watches a play's events for big hits (hit sticks) exactly once each. The session drops its live play on the very
 * tick the whistle blows, so a `null` play first drains whatever the previous play logged on its final tick (a hit
 * stick that ends the play still shakes the camera).
 */
export class ImpactFeedback {
  private play: LivePlay | null = null;
  private cursor = 0;

  /** True when `play` (or, when it is null, the play watched before) produced a new big hit since the last call. */
  scan(play: LivePlay | null): boolean {
    if (!play) {
      const prev = this.play;
      this.play = null;
      return prev ? this.drain(prev) : false;
    }
    if (play !== this.play) {
      this.play = play;
      this.cursor = 0;
    }
    return this.drain(play);
  }

  private drain(play: LivePlay): boolean {
    const events = play.state.events;
    let hit = false;
    for (; this.cursor < events.length; this.cursor++) {
      const e = events[this.cursor];
      if (e && (e.type === 'hitStick' || (e.type === 'tackle' && e.kind === 'hitStick'))) hit = true;
    }
    return hit;
  }
}

const extended = new WeakSet<ReplayRecording>();

/**
 * Appends the post-whistle settle of `play` to its replay recording (once; only when `rec` is that play's recording).
 * Returns the number of frames added.
 */
export const attachSettleFrames = (rec: ReplayRecording | null, play: LivePlay | null): number => {
  if (!rec || !play || !play.isDead || !canSettle(play) || extended.has(rec) || play.outcome?.replayId !== rec.id) return 0;
  extended.add(rec);
  const last = rec.frames[rec.frames.length - 1];
  const frames = play.settleFrames().filter((f) => !last || f.tick > last.tick);
  rec.frames.push(...frames);
  return frames.length;
};
