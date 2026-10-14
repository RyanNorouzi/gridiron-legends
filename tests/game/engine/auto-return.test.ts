/**
 * The automatic return: a user who receives a kickoff and touches nothing is not left standing where he caught it to
 * be tackled at his own 1-5 (every kickoff): his returner plays the AI's return (and takes a knee deep in the end
 * zone) until he gives any input, after which the return is his for the rest of the play.
 */
import { describe, expect, it } from 'vitest';
import { vec2 } from '@/core/vec2';
import { autoReturning, touchedReturn, USER_RETURN_KEY } from '@/game/auto-return';
import { createPlayEngine } from '@/game/play-engine';
import type { PlayOutcome, PlayState, UserPlayInput } from '@/game/play-types';
import { buildCtx, createMeasureEnv } from '../../integration/measure';
import { emptyInput } from './helpers';

const env = createMeasureEnv(2026);

const idleReturn = (i: number, input: (s: PlayState) => UserPlayInput = () => emptyInput()): { o: PlayOutcome; s: PlayState } => {
  const ctx = buildCtx(env, { off: 'kickoff-deep', def: 'kickReturn-middle', special: 'kickoff', ballOn: 35, teamIndex: i % 8, seed: `auto-kr:${i}` });
  ctx.controllers = { home: 'ai', away: 'human' };
  ctx.userSide = 'away';
  ctx.userControl = 'defense';
  const play = createPlayEngine(ctx, { registries: env.registries });
  const o = play.run((s) => ({ away: input(s) }), 5000);
  return { o, s: play.state };
};

const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;

describe('automatic kick return for a user who does nothing', () => {
  it('returns it like the AI (no more tackles at the 1-5), takes a knee deep in the end zone, and never concedes a safety', () => {
    const starts: number[] = [];
    let safeties = 0;
    for (let i = 0; i < 24; i++) {
      const { o, s } = idleReturn(i);
      if (o.safety) safeties += 1;
      if (s.deadReason === 'touchback' || o.turnover) continue;
      // Where the receiving team takes over, in its own yards (endBallOn is the kicking team's perspective).
      starts.push(100 - o.endBallOn);
    }
    expect(safeties).toBe(0);
    expect(starts.length).toBeGreaterThanOrEqual(6);
    expect(starts.filter((y) => y <= 5).length).toBeLessThanOrEqual(1);
    expect(median(starts)).toBeGreaterThanOrEqual(15);
  }, 120_000);

  it('any input hands the return to the user for the rest of the play', () => {
    let took = false;
    const { s } = idleReturn(3, (st) => {
      const u = emptyInput();
      if (st.phase === 'live' && st.tick - st.snapTick === 30) u.move = vec2(0.6, 0);
      return u;
    });
    const me = s.athletes.find((a) => a.teamSide === 'away' && a.ai.scratch[USER_RETURN_KEY] === 1);
    took = me !== undefined;
    expect(took).toBe(true);
    for (const a of s.athletes) if (a.teamSide === 'away') expect(autoReturning(a, s)).toBe(false);
  }, 60_000);

  it('a stray tackle / sprint press (the confirm key) does not take the return over', () => {
    const { s } = idleReturn(3, (st) => {
      const u = emptyInput();
      if (st.phase === 'live' && st.tick - st.snapTick < 40) {
        u.tackle = true;
        u.sprint = true;
      }
      return u;
    });
    expect(s.athletes.some((a) => a.teamSide === 'away' && a.ai.scratch[USER_RETURN_KEY] === 1)).toBe(false);
  }, 60_000);

  it('touchedReturn: steering and returner moves take over; defensive buttons and sprint alone do not', () => {
    const base = emptyInput();
    expect(touchedReturn({ ...base, move: vec2(0.6, 0) })).toBe(true);
    expect(touchedReturn({ ...base, juke: true })).toBe(true);
    expect(touchedReturn({ ...base, fairCatch: true })).toBe(true);
    expect(touchedReturn({ ...base, tackle: true })).toBe(false);
    expect(touchedReturn({ ...base, sprint: true })).toBe(false);
    expect(touchedReturn({ ...base, hitStick: true, strip: true, jumpSwat: true })).toBe(false);
  });
});
