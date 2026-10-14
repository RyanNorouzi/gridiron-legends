import { describe, expect, it } from 'vitest';
import { dist, dot, sub } from '@/core/vec2';
import { cushionFor, PRESS_MIN_DEPTH, pressWindow, resolveManTarget } from '@/ai/coverage-man';
import { teamView } from '@/ai/defense-shared';
import type { IntentAction } from '@/game/engine-api';
import {
  dropbackScript, handoff, pathScript, routeScript, runFor, runUntil, setAttrs, settled, setup, snap, stillScript, throwTo, type Scripts,
} from './harness';

const offenseStill = (f: ReturnType<typeof setup>): Scripts => {
  const s: Scripts = {};
  for (const a of f.state.athletes) if (a.side === 'offense') s[a.id] = stillScript;
  return s;
};

/** Press-man fixture: CB1 (press, help) on WR1 with matched athletic ratings unless overridden. */
const pressFixture = (offensePlayId: string, difficulty: 'rookie' | 'pro' | 'legend', seed: number, cbSpeed = 88) => {
  const f = setup({ offensePlayId, defensePlayId: '43-cover1-man', difficulty, seed });
  const wr = f.byRole('offense', 'WR1');
  const cb = f.byRole('defense', 'CB1');
  setAttrs(wr, 80, { speed: 88, acceleration: 88, agility: 85, release: 80 });
  setAttrs(cb, 80, { speed: cbSpeed, acceleration: cbSpeed, agility: 85, coverage: 82, reaction: 80, awareness: 75 });
  runFor(f, 1.5, offenseStill(f)); // presnap: the press corner walks up on his man
  const scripts = offenseStill(f);
  scripts[wr.id] = routeScript(f, 'WR1');
  scripts['off:QB'] = dropbackScript(f, 3);
  return { f, wr, cb, scripts };
};

describe('man coverage', () => {
  it('press corner aligns on his man presnap and jams him for the first half second', () => {
    const { f, wr, cb, scripts } = pressFixture('shotgun-goRoutes', 'pro', 5);
    expect(dist(wr.pos, cb.pos)).toBeLessThan(2);
    expect(cb.ai.targetAthleteId).toBe('off:WR1');
    // Pressed from the defense's side of the ball: never walked across the line into the receiver before the snap.
    expect(f.state.ctx.direction * (cb.pos.y - f.state.losY)).toBeGreaterThanOrEqual(PRESS_MIN_DEPTH - 0.05);
    snap(f);
    let maxEarly = 0;
    let jammed = false;
    runFor(f, 0.5, scripts, {}, (st) => {
      maxEarly = Math.max(maxEarly, dist(wr.pos, cb.pos));
      if (st.intents[cb.id]?.debug.includes('jam')) jammed = true;
    });
    expect(jammed).toBe(true);
    // A legal press stance (outside the neutral zone, shaded half a yard) starts ~1.1-1.2 yd from a receiver set on
    // the line; the old 1.05 bound held only because the corner used to walk across the line into the receiver.
    expect(maxEarly).toBeLessThanOrEqual(1.25);
    expect(pressWindow(cb, wr)).toBeGreaterThanOrEqual(0.45);
  });

  it('stays within 2.5 yd of a receiver running a bundled route for 3 s at pro', () => {
    for (const play of ['shotgun-goRoutes', 'shotgun-mesh']) {
      const { f, wr, cb, scripts } = pressFixture(play, 'pro', 3);
      snap(f);
      let max = 0;
      runFor(f, 3, scripts, {}, () => { max = Math.max(max, dist(wr.pos, cb.pos)); });
      expect(max, play).toBeLessThanOrEqual(2.5);
    }
  });

  it('a slow corner on rookie is beaten by more than a fast one on pro', () => {
    const run = (difficulty: 'rookie' | 'pro', cbSpeed: number): number => {
      const { f, wr, cb, scripts } = pressFixture('shotgun-goRoutes', difficulty, 3, cbSpeed);
      snap(f);
      let max = 0;
      runFor(f, 3, scripts, {}, (_st, t) => { if (t > 1.5) max = Math.max(max, dist(wr.pos, cb.pos)); });
      return max;
    };
    const fast = run('pro', 88);
    const slow = run('rookie', 55);
    expect(slow).toBeGreaterThan(fast + 1);
    expect(slow).toBeGreaterThan(2.5);
  });

  it('off corner backpedals with a cushion, flips his hips and recovers to the hip', () => {
    const f = setup({ offensePlayId: 'shotgun-curls', defensePlayId: '43-runStop-cover1', seed: 2 });
    const wr = f.byRole('offense', 'WR1');
    const cb = f.byRole('defense', 'CB1');
    setAttrs(wr, 80, { speed: 85, acceleration: 85 });
    setAttrs(cb, 80, { speed: 85, acceleration: 85, coverage: 80 });
    expect(cb.assignment.type === 'manCover' && cb.assignment.technique).toBe('off');
    const scripts = offenseStill(f);
    scripts[wr.id] = routeScript(f, 'WR1');
    scripts['off:QB'] = dropbackScript(f, 5);
    snap(f);
    let backpedalled = false;
    let maxLate = 0;
    let minLate = Infinity;
    runFor(f, 3, scripts, {}, (st, t) => {
      const i = st.intents[cb.id];
      if (t < 0.6 && i?.locomotion === 'backpedal' && i.debug.includes('cushion')) backpedalled = true;
      if (t > 1.2) {
        maxLate = Math.max(maxLate, dist(wr.pos, cb.pos));
        minLate = Math.min(minLate, dist(wr.pos, cb.pos));
      }
    });
    expect(backpedalled).toBe(true);
    // A vertical stem against off coverage buys a few yards while the corner flips and accelerates...
    expect(maxLate).toBeLessThan(4.5);
    // ...but he recovers to the hip once the receiver settles on the curl.
    expect(minLate).toBeLessThan(2);
  });

  it('cushion grows against faster receivers and for weaker cover men', () => {
    const f = setup({ seed: 1 });
    const wr = f.byRole('offense', 'WR1');
    const cb = f.byRole('defense', 'CB1');
    setAttrs(wr, 80, { speed: 95 });
    setAttrs(cb, 80, { speed: 95, coverage: 90 });
    const even = cushionFor(cb, wr);
    setAttrs(cb, 80, { speed: 65, coverage: 90 });
    const slow = cushionFor(cb, wr);
    setAttrs(cb, 80, { speed: 95, coverage: 40 });
    const weak = cushionFor(cb, wr);
    expect(slow).toBeGreaterThan(even + 0.8);
    expect(weak).toBeGreaterThan(even + 0.5);
  });

  it('breaks on a ball thrown to his man and plays it at arrival', () => {
    const { f, wr, cb, scripts } = pressFixture('shotgun-curls', 'pro', 4);
    snap(f);
    runFor(f, 2.2, scripts);
    expect(runUntil(f, 2.5, scripts, () => settled(wr))).toBe(true);
    throwTo(f, 'WR1', 'touch');
    const landingTick = f.state.ball.landingTick;
    let headedToLanding = false;
    const actions: IntentAction[] = [];
    while (f.state.tick < landingTick) {
      runFor(f, 1 / 60, scripts);
      const i = f.state.intents[cb.id];
      if (!i) continue;
      const landing = teamView(f.state).landing;
      if (landing && i.debug.includes('break on ball') && dot(i.move, sub(landing, cb.pos)) > 0) headedToLanding = true;
      if (i.action) actions.push(i.action);
    }
    expect(headedToLanding).toBe(true);
    expect(actions.some((a) => a === 'jump' || a === 'swat')).toBe(true);
    expect(dist(cb.pos, wr.pos)).toBeLessThan(2.5);
  });

  it('rallies when the ball goes elsewhere and tackles his man right after a catch', () => {
    const { f, wr, cb, scripts } = pressFixture('shotgun-curls', 'pro', 6);
    scripts['off:WR2'] = routeScript(f, 'WR2');
    snap(f);
    runFor(f, 2.2, scripts);
    expect(runUntil(f, 2.5, scripts, () => settled(wr))).toBe(true);
    throwTo(f, 'WR2', 'touch');
    let rallied = false;
    runFor(f, 0.5, scripts, {}, (st) => { if (st.intents[cb.id]?.debug === 'rally') rallied = true; });
    expect(rallied).toBe(true);
    // Now a completion to his own man: he should wrap him up at once.
    const g = pressFixture('shotgun-curls', 'pro', 6);
    snap(g.f);
    runFor(g.f, 2.2, g.scripts);
    expect(runUntil(g.f, 2.5, g.scripts, () => settled(g.wr))).toBe(true);
    throwTo(g.f, 'WR1', 'touch');
    let tackled = false;
    runFor(g.f, 2.5, g.scripts, { autoCatch: true }, (st) => {
      const i = st.intents[g.cb.id];
      if (g.wr.hasBall && i && (i.action === 'tackle' || i.action === 'hitStick' || i.action === 'strip')) tackled = true;
    });
    expect(g.wr.hasBall).toBe(true);
    expect(tackled).toBe(true);
    expect(wr.id).toBe('off:WR1');
  });

  it('comes down as a force player once a run is recognised', () => {
    const f = setup({ offensePlayId: 'iform-toss-right', defensePlayId: '43-runStop-cover1', seed: 3 });
    const st = f.state;
    const dir = st.ctx.direction;
    const cb = f.byRole('defense', 'CB2');
    const rb = f.byRole('offense', 'RB');
    const scripts = offenseStill(f);
    scripts[rb.id] = pathScript([{ x: st.ctx.ballX + dir * 8, y: st.losY - dir * 2 }, { x: st.ctx.ballX + dir * 14, y: st.losY + dir * 12 }]);
    snap(f);
    handoff(f, 'RB');
    let pursued = false;
    runFor(f, 1.5, scripts, {}, (s) => {
      const i = s.intents[cb.id];
      if (i && (i.debug.startsWith('pursue') || i.debug.startsWith('cut off')) && dot(i.move, sub(rb.pos, cb.pos)) > 0) pursued = true;
    });
    expect(pursued).toBe(true);
  });

  it('falls back to the nearest uncovered eligible receiver when the man target is absent', () => {
    // 43-cover1-man asks the SS for WR3; the I-formation has no WR3.
    const f = setup({ offensePlayId: 'iform-paBoot-right', defensePlayId: '43-cover1-man', seed: 1 });
    const ss = f.byRole('defense', 'SS');
    expect(ss.assignment.type === 'manCover' && ss.assignment.manTarget).toBe('WR3');
    const target = resolveManTarget(ss, f.state, teamView(f.state));
    expect(target).not.toBeNull();
    expect(target?.eligible).toBe(true);
    expect(target?.role).toBe('FB');
    expect(ss.ai.targetAthleteId).toBe(target?.id);
  });
});
