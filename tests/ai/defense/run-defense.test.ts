import { describe, expect, it } from 'vitest';
import { dot, sub } from '@/core/vec2';
import { idleIntent, moveIntent } from '@/game/engine-api';
import { depthOf, reactionSeconds } from '@/ai/defense-shared';
import { spyDepth } from '@/ai/spy';
import { dropbackScript, handoff, pathScript, runFor, setAttrs, setup, snap, stillScript, type Scripts } from './harness';

const offenseStill = (f: ReturnType<typeof setup>): Scripts => {
  const s: Scripts = {};
  for (const a of f.state.athletes) if (a.side === 'offense') s[a.id] = stillScript;
  return s;
};

describe('run defense', () => {
  it('linebackers move toward the carrier gap within their reaction delay after a handoff', () => {
    for (const seed of [1, 2, 3]) {
      const f = setup({ offensePlayId: 'iform-iso-right', defensePlayId: '43-runStop-cover1', seed });
      const st = f.state;
      const dir = st.ctx.direction;
      const rb = f.byRole('offense', 'RB');
      const mlb = f.byRole('defense', 'MLB');
      const scripts = offenseStill(f);
      // The back attacks the B gap to the offense's right.
      scripts[rb.id] = pathScript([{ x: st.ctx.ballX + dir * 1.9, y: st.losY + dir * 1 }, { x: st.ctx.ballX + dir * 3, y: st.losY + dir * 15 }]);
      snap(f);
      handoff(f, 'RB');
      const reaction = reactionSeconds(mlb, st.ctx.difficulty);
      let fillAt = Infinity;
      runFor(f, 1.2, scripts, {}, (s, t) => {
        const i = s.intents[mlb.id];
        if (fillAt === Infinity && i && i.debug.includes('on RB') && dir * i.move.y < 0 && dot(i.move, sub(rb.pos, mlb.pos)) > 0) fillAt = t;
      });
      expect(fillAt, `seed ${seed}`).toBeGreaterThanOrEqual(reaction - 0.02);
      expect(fillAt, `seed ${seed}`).toBeLessThanOrEqual(reaction + 0.05);
    }
  });

  it('reads keys before the run shows and drops to a hook zone on a pass read', () => {
    const f = setup({ offensePlayId: 'shotgun-curls', defensePlayId: '43-runStop-cover1', seed: 2 });
    const st = f.state;
    const dir = st.ctx.direction;
    const mlb = f.byRole('defense', 'MLB');
    const scripts = offenseStill(f);
    scripts['off:QB'] = dropbackScript(f, 5);
    for (const role of ['LT', 'LG', 'C', 'RG', 'RT']) {
      scripts[`off:${role}`] = (a) => (depthOf(st, a.pos) > -2 ? moveIntent({ x: 0, y: -dir }, false, 'pass set') : idleIntent('set'));
    }
    snap(f);
    runFor(f, 1 / 60, scripts);
    expect(st.intents[mlb.id]?.debug).toBe('read keys');
    let dropped = false;
    runFor(f, 1.5, scripts, {}, (s) => { if (s.intents[mlb.id]?.debug.startsWith('zone middleHook')) dropped = true; });
    expect(dropped).toBe(true);
    expect(mlb.ai.recognizedPass).toBe(true);
    expect(mlb.ai.recognizedRun).toBe(false);
  });

  it('takes on a lead blocker with a strength edge and avoids him without one', () => {
    const run = (strength: number): string[] => {
      const f = setup({ offensePlayId: 'iform-iso-right', defensePlayId: '43-runStop-cover1', seed: 4 });
      const st = f.state;
      const dir = st.ctx.direction;
      for (const a of st.athletes) if (a.side === 'offense' && ['LT', 'LG', 'C', 'RG', 'RT'].includes(a.role)) a.active = false;
      const mlb = f.byRole('defense', 'MLB');
      const fb = f.byRole('offense', 'FB');
      const rb = f.byRole('offense', 'RB');
      setAttrs(mlb, 75, { strength });
      setAttrs(fb, 75, { strength: 75 });
      const scripts = offenseStill(f);
      // The fullback leads through the A gap, straight at the filling linebacker.
      scripts[fb.id] = pathScript([{ x: st.ctx.ballX + dir * 1.5, y: st.losY + dir * 1.5 }, { x: st.ctx.ballX + dir * 1.5, y: st.losY + dir * 12 }], 1, false);
      scripts[rb.id] = pathScript([{ x: st.ctx.ballX + dir * 1.9, y: st.losY + dir * 1 }, { x: st.ctx.ballX + dir * 2.5, y: st.losY + dir * 15 }], 1, false);
      snap(f);
      handoff(f, 'RB');
      const labels: string[] = [];
      runFor(f, 1.6, scripts, {}, (s) => { labels.push(s.intents[mlb.id]?.debug ?? ''); });
      return labels;
    };
    expect(run(97).some((l) => l.includes('take on FB'))).toBe(true);
    expect(run(30).some((l) => l.includes('avoid FB'))).toBe(true);
  });
});

describe('spy', () => {
  it('mirrors the quarterback laterally at 4-6 yd and attacks when he crosses the line', () => {
    const f = setup({ offensePlayId: 'shotgun-goRoutes', defensePlayId: '43-cover1-spy', seed: 3 });
    const st = f.state;
    const dir = st.ctx.direction;
    const qb = f.byRole('offense', 'QB');
    const mlb = f.byRole('defense', 'MLB');
    expect(mlb.assignment.type).toBe('spy');
    expect(spyDepth(mlb)).toBeGreaterThanOrEqual(4);
    expect(spyDepth(mlb)).toBeLessThanOrEqual(6);
    const scripts = offenseStill(f);
    scripts['off:QB'] = pathScript([{ x: qb.pos.x + dir * 4.5, y: qb.pos.y }], 0.5, false);
    snap(f);
    runFor(f, 2.2, scripts);
    expect(Math.abs(mlb.pos.x - qb.pos.x)).toBeLessThan(2.5);
    const depth = depthOf(st, mlb.pos);
    expect(depth).toBeGreaterThan(3);
    expect(depth).toBeLessThan(7);
    expect(st.intents[mlb.id]?.locomotion).toBe('strafe');
    // The QB takes off across the line: the spy attacks.
    scripts['off:QB'] = pathScript([{ x: qb.pos.x, y: st.losY + dir * 6 }]);
    let attacked = false;
    runFor(f, 1.2, scripts, {}, (s) => {
      const i = s.intents[mlb.id];
      if (i && depthOf(s, qb.pos) > 0 && (i.debug.startsWith('pursue') || i.debug.startsWith('cut off'))) attacked = true;
    });
    expect(attacked).toBe(true);
  });
});
