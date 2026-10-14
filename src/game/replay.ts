import type { PlayState, ReplayFrame, ReplayRecording, ReplayRetention, ReplayStore } from './play-types';

/**
 * Replay recordings. The engine records one ReplayFrame per live tick when `recordFrames` is on and pushes a
 * ReplayRecording into the store when the play ends. Retention: 'off' keeps nothing, 'lastPlay' one recording,
 * 'drive' everything until `clear()` (the controller clears on a change of possession), 'game' everything.
 */
const KEEP: Record<ReplayRetention, number> = { off: 0, lastPlay: 1, drive: Infinity, game: Infinity };

export const createReplayStore = (retention: ReplayRetention): ReplayStore => {
  const recs: ReplayRecording[] = [];
  return {
    retention,
    push(rec) {
      const keep = KEEP[retention];
      if (keep === 0) return;
      recs.push(rec);
      while (recs.length > keep) recs.shift();
    },
    get(id) {
      return recs.find((r) => r.id === id) ?? null;
    },
    last() {
      return recs.length > 0 ? (recs[recs.length - 1] as ReplayRecording) : null;
    },
    clear() {
      recs.length = 0;
    },
  };
};

/** Snapshot of the athletes and ball for one tick. */
export const captureFrame = (state: PlayState): ReplayFrame => ({
  tick: state.tick,
  athletes: state.athletes.map((a) => ({ id: a.id, x: a.pos.x, y: a.pos.y, facing: a.facing, state: a.state, hasBall: a.hasBall })),
  ball: { x: state.ball.pos.x, y: state.ball.pos.y, z: state.ball.z, phase: state.ball.phase },
});

/** Appends the current tick's frame to state.frames (when recording is enabled). */
export const recordFrame = (state: PlayState): void => {
  if (!state.recordFrames) return;
  state.frames.push(captureFrame(state));
};

/** Builds the recording for a finished play. */
export const buildRecording = (state: PlayState, id: string): ReplayRecording => ({
  id,
  playIndex: state.ctx.playIndex,
  tickRate: 60,
  snapTick: state.snapTick,
  direction: state.ctx.direction,
  losY: state.losY,
  firstDownY: state.firstDownY,
  athletes: state.athletes.map((a) => ({ id: a.id, playerId: a.playerId, teamSide: a.teamSide, position: a.position, number: a.number, name: a.name })),
  frames: state.frames.slice(),
  events: state.events.slice(),
});
