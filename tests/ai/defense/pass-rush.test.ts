import { describe, expect, it } from 'vitest';
import { dist, dot, sub } from '@/core/vec2';
import { chooseMove, twistFor } from '@/ai/pass-rush';
import { depthOf, localX } from '@/ai/defense-shared';
import { dropbackScript, handoff, pathScript, runFor, setAttrs, setup, snap, stillScript, throwTo, type Scripts } from './harness';

const offenseStill = (f: ReturnType<typeof setup>): Scripts => {
  const s: Scripts = {};
  for (const a of f.state.athletes) if (a.side === 'offense') s[a.id] = stillScript;
  return s;
};

const OL = ['LT', 'LG', 'C', 'RG', 'RT'];
const benchLine = (f: ReturnType<typeof setup>): void => {
  for (const a of f.state.athletes) if (a.side === 'offense' && OL.includes(a.role)) a.active = false;
};

describe('pass rush', () => {
  it('a gap rusher reaches the quarterback depth within 3 s against no blockers', () => {
    const f = setup({ offensePlayId: 'shotgun-goRoutes', defensePlayId: '43-cover3-zone', seed: 2 });
    benchLine(f);
    const qb = f.byRole('offense', 'QB');
    const gapRushers = [f.byRole('defense', 'DT1'), f.byRole('defense', 'DT2')];
    for (const dt of gapRushers) expect(dt.assignment.type).toBe('rushGap');
    const scripts = offenseStill(f);
    scripts['off:QB'] = dropbackScript(f, 5);
    snap(f);
    // This harness has no tackle system: the first rusher to arrive shoves the passer backwards instead of sacking
    // him, so "reaching" him is getting to his depth or into tackle contact reach (radii + 0.3), whichever is first.
    let reachedAt = Infinity;
    let first = gapRushers[0]!;
    runFor(f, 3, scripts, {}, (st, t) => {
      for (const dt of gapRushers) {
        const there = depthOf(st, dt.pos) <= depthOf(st, qb.pos) + 0.5 || dist(dt.pos, qb.pos) <= dt.radius + qb.radius + 0.3;
        if (reachedAt === Infinity && there) { reachedAt = t; first = dt; }
      }
    });
    expect(reachedAt).toBeLessThan(3);
    expect(f.state.intents[first.id]?.debug).toMatch(/pursue|cut off|contain|to qb/);
  });

  it('contain rushes outside the widest blocker while the interior rusher goes through the gap', () => {
    const f = setup({ offensePlayId: 'shotgun-goRoutes', defensePlayId: '43-cover3-zone', seed: 2 });
    benchLine(f);
    const de = f.byRole('defense', 'DE2');
    const dt = f.byRole('defense', 'DT2');
    expect(de.assignment.type).toBe('contain');
    const scripts = offenseStill(f);
    scripts['off:QB'] = dropbackScript(f, 5);
    snap(f);
    let deWidest = 0;
    let dtWidest = 0;
    let containedBeforeCollapse = false;
    runFor(f, 1.5, scripts, {}, (st) => {
      deWidest = Math.max(deWidest, Math.abs(localX(st, de.pos.x)));
      dtWidest = Math.max(dtWidest, Math.abs(localX(st, dt.pos.x)));
      if (st.intents[de.id]?.debug === 'contain') containedBeforeCollapse = true;
    });
    expect(deWidest).toBeGreaterThan(3.8);
    expect(dtWidest).toBeLessThan(2);
    expect(containedBeforeCollapse).toBe(true);
  });

  it('blitzers time the snap by reaction and cross the line quickly', () => {
    const f = setup({ offensePlayId: 'shotgun-goRoutes', defensePlayId: '43-cover0-lbBlitz', seed: 3 });
    benchLine(f);
    const olb = f.byRole('defense', 'OLB1');
    expect(olb.assignment.type).toBe('blitz');
    const scripts = offenseStill(f);
    scripts['off:QB'] = dropbackScript(f, 5);
    snap(f);
    let firstMove = Infinity;
    let crossedAt = Infinity;
    runFor(f, 2, scripts, {}, (st, t) => {
      const i = st.intents[olb.id];
      if (firstMove === Infinity && i && (i.move.x !== 0 || i.move.y !== 0)) firstMove = t;
      if (crossedAt === Infinity && depthOf(st, olb.pos) < 0) crossedAt = t;
    });
    expect(firstMove).toBeGreaterThan(0.05);
    expect(firstMove).toBeLessThan(0.5);
    expect(crossedAt).toBeLessThan(1.6);
  });

  it('gets hands up when the ball is released next to him, then rallies', () => {
    const f = setup({ offensePlayId: 'shotgun-curls', defensePlayId: '43-cover3-zone', seed: 4 });
    benchLine(f);
    const qb = f.byRole('offense', 'QB');
    const dt = f.byRole('defense', 'DT1');
    const scripts = offenseStill(f);
    scripts['off:QB'] = dropbackScript(f, 5);
    scripts['off:WR1'] = pathScript([{ x: f.byRole('offense', 'WR1').pos.x, y: f.state.losY + f.state.ctx.direction * 8 }]);
    snap(f);
    runFor(f, 1.2, scripts);
    dt.pos = { x: qb.pos.x + 1.2, y: qb.pos.y };
    throwTo(f, 'WR1', 'bullet');
    runFor(f, 1 / 60, scripts);
    expect(f.state.intents[dt.id]?.action).toBe('jump');
    expect(f.state.intents[dt.id]?.debug).toBe('hands up');
    let rallied = false;
    runFor(f, 0.6, scripts, {}, (st) => { if (st.intents[dt.id]?.debug === 'rally') rallied = true; });
    expect(rallied).toBe(true);
  });

  it('pursues a scrambling quarterback and fills on a recognised run', () => {
    const f = setup({ offensePlayId: 'shotgun-goRoutes', defensePlayId: '43-cover3-zone', seed: 5 });
    benchLine(f);
    const st = f.state;
    const dir = st.ctx.direction;
    const qb = f.byRole('offense', 'QB');
    const de = f.byRole('defense', 'DE1');
    const scripts = offenseStill(f);
    scripts['off:QB'] = pathScript([{ x: st.ctx.ballX + dir * 12, y: st.losY - dir * 4 }, { x: st.ctx.ballX + dir * 16, y: st.losY + dir * 10 }]);
    snap(f);
    let chased = false;
    runFor(f, 2, scripts, {}, (s) => {
      const i = s.intents[de.id];
      if (i && (i.debug.startsWith('pursue') || i.debug.startsWith('cut off')) && dot(i.move, sub(qb.pos, de.pos)) > 0) chased = true;
    });
    expect(chased).toBe(true);

    const g = setup({ offensePlayId: 'iform-iso-right', defensePlayId: '43-runStop-cover1', seed: 5 });
    benchLine(g);
    const gs = offenseStill(g);
    const rb = g.byRole('offense', 'RB');
    const gst = g.state;
    gs[rb.id] = pathScript([{ x: gst.ctx.ballX + gst.ctx.direction * 2, y: gst.losY + gst.ctx.direction * 12 }], 1, false);
    snap(g);
    handoff(g, 'RB');
    const dt = g.byRole('defense', 'DT2');
    let filled = false;
    runFor(g, 1.5, gs, {}, (s) => {
      const i = s.intents[dt.id];
      if (i && /fill|pursue|cut off/.test(i.debug)) filled = true;
    });
    expect(filled).toBe(true);
  });

  it('picks a pass-rush move from the matchup', () => {
    const f = setup({ seed: 1 });
    const de = f.byRole('defense', 'DE2');
    const ot = f.byRole('offense', 'RT');
    setAttrs(de, 60, { strength: 97, speed: 60, agility: 60, passRush: 60 });
    setAttrs(ot, 60, { strength: 50, agility: 80, blocking: 80 });
    expect(chooseMove(de, ot, f.state, 'gap')).toBe('bull');
    de.ai.scratch = {};
    setAttrs(de, 60, { strength: 45, speed: 97, agility: 60, passRush: 60 });
    setAttrs(ot, 60, { strength: 95, agility: 50, blocking: 90 });
    expect(chooseMove(de, ot, f.state, 'contain')).toBe('speed');
    de.ai.scratch = {};
    setAttrs(de, 60, { strength: 45, speed: 55, agility: 97, passRush: 95 });
    setAttrs(ot, 60, { strength: 95, agility: 90, blocking: 55 });
    expect(['swim', 'spin']).toContain(chooseMove(de, ot, f.state, 'gap'));
  });
});

describe('pass rush twists', () => {
  it('on some four-man rushes a tackle and end on one side twist: the tackle crashes out, the end waits then loops inside', () => {
    let found: ReturnType<typeof twistFor> = null;
    let f = setup({ offensePlayId: 'shotgun-goRoutes', defensePlayId: '43-cover3-zone', seed: 2 });
    let hits = 0;
    for (let i = 0; i < 60; i++) {
      const g = setup({ offensePlayId: 'shotgun-goRoutes', defensePlayId: '43-cover3-zone', seed: 2 });
      g.state.ctx.playIndex = i;
      const t = g.state.athletes.map((a) => twistFor(a, g.state)).find((x) => x !== null) ?? null;
      if (t) { hits++; if (!found) { found = t; f = g; } }
    }
    // A change-up, not the base rush.
    expect(hits).toBeGreaterThan(0);
    expect(hits).toBeLessThan(30);
    expect(found!.crasher.position).toBe('DT');
    expect(found!.looper.position).toBe('DE');
    expect(twistFor(found!.looper, f.state)?.crasher.id).toBe(found!.crasher.id);
    benchLine(f);
    snap(f);
    const looper = f.athlete(found!.looper.id);
    const crasher = f.athlete(found!.crasher.id);
    const side = Math.sign(localX(f.state, looper.pos.x));
    const crasherX0 = localX(f.state, crasher.pos.x);
    let waited = false;
    runFor(f, 0.6, offenseStill(f), {}, (st, t) => {
      if (t > 0.1 && t < 0.25 && st.intents[looper.id]?.debug === 'twist: wait') waited = true;
    });
    expect(waited).toBe(true);
    // The crasher has gone outward (toward the end's lane) while the looper held.
    expect(side * (localX(f.state, crasher.pos.x) - crasherX0)).toBeGreaterThan(0.4);
    // Rushing four: a blitz call never twists.
    const blitz = setup({ offensePlayId: 'shotgun-goRoutes', defensePlayId: '34-cover0-allOut', seed: 2 });
    for (let i = 0; i < 30; i++) {
      blitz.state.ctx.playIndex = i;
      for (const a of blitz.state.athletes) expect(twistFor(a, blitz.state)).toBeNull();
    }
  });
});
