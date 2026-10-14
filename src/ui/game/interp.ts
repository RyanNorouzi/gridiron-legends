/**
 * Previous-tick position buffer so the field view can interpolate athletes and the ball between two
 * simulation ticks with the loop's alpha. Owned by the session, read by field-view / replay.
 */
import type { PlayState } from '@/game/play-types';

export interface SnapshotAthlete { x: number; y: number; facing: number }
export interface SnapshotBall { x: number; y: number; z: number }

export interface Snapshot {
  tick: number;
  athletes: Map<string, SnapshotAthlete>;
  ball: SnapshotBall;
}

const takeSnapshot = (play: Pick<PlayState, 'tick' | 'athletes' | 'ball'>): Snapshot => {
  const athletes = new Map<string, SnapshotAthlete>();
  for (const a of play.athletes) athletes.set(a.id, { x: a.pos.x, y: a.pos.y, facing: a.facing });
  return { tick: play.tick, athletes, ball: { x: play.ball.pos.x, y: play.ball.pos.y, z: play.ball.z } };
};

/** Keeps the last two captured ticks; `prev` is null until two ticks have been captured for the same play. */
export class SnapshotBuffer {
  private prevSnap: Snapshot | null = null;
  private currSnap: Snapshot | null = null;

  get prev(): Snapshot | null {
    return this.prevSnap;
  }

  get current(): Snapshot | null {
    return this.currSnap;
  }

  /** Records the state after a tick. A tick counter going backwards (new play) resets the history. */
  capture(play: Pick<PlayState, 'tick' | 'athletes' | 'ball'>): void {
    if (this.currSnap && play.tick < this.currSnap.tick) this.currSnap = null;
    this.prevSnap = this.currSnap;
    this.currSnap = takeSnapshot(play);
  }

  reset(): void {
    this.prevSnap = null;
    this.currSnap = null;
  }

  /** Position of an athlete blended between the previous and current tick (falls back to the live value). */
  athletePos(id: string, live: SnapshotAthlete, alpha: number): SnapshotAthlete {
    const p = this.prevSnap?.athletes.get(id);
    const c = this.currSnap?.athletes.get(id);
    if (!p || !c) return live;
    const t = Math.max(0, Math.min(1, alpha));
    // Interpolate from the previous tick toward the current one; the live value equals `c` once captured.
    return { x: p.x + (c.x - p.x) * t, y: p.y + (c.y - p.y) * t, facing: live.facing };
  }

  ballPos(live: SnapshotBall, alpha: number): SnapshotBall {
    const p = this.prevSnap?.ball;
    const c = this.currSnap?.ball;
    if (!p || !c) return live;
    const t = Math.max(0, Math.min(1, alpha));
    return { x: p.x + (c.x - p.x) * t, y: p.y + (c.y - p.y) * t, z: p.z + (c.z - p.z) * t };
  }
}
