import { describe, expect, it } from 'vitest';
import { dist } from '@/core/vec2';
import { afterTurnover, chaseLooseBall, convoyBlock, expectedPossession, turnoverPhase } from '@/ai/turnover';
import { buildPlayState } from '../../fixtures/play-state';
import { giveBall, goLive, looseBall, place } from './helpers';

describe('turnover fallback', () => {
  it('classifies possession from each side\'s point of view', () => {
    const f = buildPlayState({ seed: 8 });
    goLive(f.state);
    const qb = f.byRole('offense', 'QB');
    const cb = f.byRole('defense', 'CB1');
    expect(turnoverPhase(qb, f.state)).toBe('none');
    expect(turnoverPhase(cb, f.state)).toBe('none');
    giveBall(f.state, cb.id, 'pass');
    expect(turnoverPhase(qb, f.state)).toBe('lost');
    expect(turnoverPhase(cb, f.state)).toBe('gained');
    looseBall(f.state, { x: 26, y: 40 });
    expect(turnoverPhase(qb, f.state)).toBe('loose');
    expect(expectedPossession(f.state)).toBe('offense');
  });

  it('after an interception the offense pursues and the defense forms a convoy', () => {
    const f = buildPlayState({ seed: 9 });
    goLive(f.state);
    const cb = f.byRole('defense', 'CB1');
    const wr = f.byRole('offense', 'WR1');
    const fs = f.byRole('defense', 'FS');
    giveBall(f.state, cb.id, 'pass');
    place(f.state, cb, 20, 50, { x: 0, y: -8 });
    place(f.state, wr, 20, 46);
    place(f.state, fs, 24, 52);
    const chase = afterTurnover(wr, f.state);
    expect(chase.debug).toContain('chase');
    expect(chase.move.y).toBeGreaterThan(0.3);
    const convoy = afterTurnover(fs, f.state);
    expect(convoy.debug).toContain('convoy');
    expect(fs.ai.blockTargetId).toBe(wr.id);
    // Getting between the threat and the carrier: heading toward the receiver's side.
    expect(convoy.move.y).toBeLessThan(0);
    place(f.state, fs, 20.4, 46.8);
    expect(convoyBlock(fs, f.state).action).toBe('block');
  });

  it('a loose ball draws the nearest three per side, the closest diving; others block or converge', () => {
    const f = buildPlayState({ seed: 10 });
    goLive(f.state);
    looseBall(f.state, { x: 26, y: 40 }, { x: 0, y: 2 });
    const defenders = f.state.athletes.filter((a) => a.side === 'defense').sort((a, b) => dist(a.pos, f.state.ball.pos) - dist(b.pos, f.state.ball.pos));
    const closest = defenders[0]!;
    place(f.state, closest, 26, 39);
    const dive = chaseLooseBall(closest, f.state);
    expect(dive.action).toBe('dive');
    expect(dive.debug).toContain('#1');
    const third = defenders[2]!;
    expect(chaseLooseBall(third, f.state).debug).toContain('loose ball #3');
    const far = defenders[defenders.length - 1]!;
    const other = chaseLooseBall(far, f.state);
    expect(other.debug.startsWith('loose')).toBe(true);
    expect(other.debug).not.toContain('#');
    expect(afterTurnover(far, f.state).debug).toBe(other.debug);
  });

  it('convoy blockers spread over different threats', () => {
    const f = buildPlayState({ seed: 11 });
    goLive(f.state);
    const cb = f.byRole('defense', 'CB2');
    giveBall(f.state, cb.id, 'pass');
    place(f.state, cb, 30, 50, { x: 0, y: -8 });
    const wr1 = f.byRole('offense', 'WR1');
    const wr2 = f.byRole('offense', 'WR2');
    place(f.state, wr1, 27, 44);
    place(f.state, wr2, 33, 45);
    const fs = f.byRole('defense', 'FS');
    const ss = f.byRole('defense', 'SS');
    place(f.state, fs, 28, 49);
    place(f.state, ss, 32, 49);
    f.state.tick = 10;
    convoyBlock(fs, f.state);
    fs.ai.lastDecisionTick = 10;
    convoyBlock(ss, f.state);
    expect(fs.ai.blockTargetId).not.toBeNull();
    expect(ss.ai.blockTargetId).not.toBeNull();
    expect(fs.ai.blockTargetId).not.toBe(ss.ai.blockTargetId);
  });
});
