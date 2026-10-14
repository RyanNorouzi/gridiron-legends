import { describe, expect, it } from 'vitest';
import { dist, dot, sub } from '@/core/vec2';
import { zoneDropPoint } from '@/playbook/zones';
import { depthOf } from '@/ai/defense-shared';
import type { IntentAction } from '@/game/engine-api';
import { dropbackScript, handoff, pathScript, routeScript, runFor, runUntil, setAttrs, settled, setup, snap, stillScript, throwTo, throwToPoint, type Scripts } from './harness';

const offenseStill = (f: ReturnType<typeof setup>): Scripts => {
  const s: Scripts = {};
  for (const a of f.state.athletes) if (a.side === 'offense') s[a.id] = stillScript;
  return s;
};

describe('zone coverage', () => {
  it('underneath defenders reach their landmark within 1.5 s and then pick up a receiver entering the zone', () => {
    const f = setup({ offensePlayId: 'shotgun-curls', defensePlayId: '43-cover3-zone', seed: 2 });
    const st = f.state;
    const scripts = offenseStill(f);
    scripts['off:QB'] = dropbackScript(f, 5);
    snap(f);
    const arrived: Record<string, number> = {};
    runFor(f, 1.5, scripts, {}, (s, t) => {
      for (const role of ['MLB', 'OLB2']) {
        const a = f.byRole('defense', role);
        const zone = a.assignment.type === 'zone' ? a.assignment.zone : undefined;
        if (!zone) continue;
        if (arrived[role] === undefined && dist(a.pos, zoneDropPoint(zone, s.losY, s.ctx.direction)) < 1.5) arrived[role] = t;
      }
    });
    expect(arrived['MLB']).toBeLessThanOrEqual(1.5);
    expect(arrived['OLB2']).toBeLessThanOrEqual(1.5);
    // TE1 now runs into the hook/curl zone on the right: OLB2 squats on him.
    const te = f.byRole('offense', 'TE1');
    const olb = f.byRole('defense', 'OLB2');
    const dir = st.ctx.direction;
    scripts[te.id] = pathScript([{ x: st.ctx.ballX + dir * 9, y: st.losY + dir * 10 }]);
    let picked = false;
    runFor(f, 1.2, scripts, {}, (s) => {
      const i = s.intents[olb.id];
      if (i && i.debug.includes('squat TE1') && dot(i.move, sub(te.pos, olb.pos)) > 0) picked = true;
    });
    expect(picked).toBe(true);
  });

  it('deep-third defender never lets a go route behind him', () => {
    for (const seed of [1, 2]) {
      const f = setup({ offensePlayId: 'shotgun-goRoutes', defensePlayId: '43-cover3-zone', seed });
      const wr = f.byRole('offense', 'WR1');
      const cb = f.byRole('defense', 'CB1');
      setAttrs(wr, 80, { speed: 92, acceleration: 90 });
      setAttrs(cb, 80, { speed: 86, acceleration: 86 });
      const scripts = offenseStill(f);
      scripts[wr.id] = routeScript(f, 'WR1');
      scripts['off:QB'] = dropbackScript(f, 7);
      snap(f);
      let minGap = Infinity;
      let bailed = false;
      runFor(f, 3.5, scripts, {}, (st) => {
        minGap = Math.min(minGap, depthOf(st, cb.pos) - depthOf(st, wr.pos));
        if (st.intents[cb.id]?.debug.includes('bail')) bailed = true;
      });
      expect(minGap).toBeGreaterThan(1);
      expect(bailed).toBe(true);
    }
  });

  it('carries a go route past the zone\'s nominal depth instead of stopping at 35 yd', () => {
    const f = setup({ offensePlayId: 'shotgun-goRoutes', defensePlayId: '43-cover3-zone', seed: 3, ballOn: 30 });
    const st = f.state;
    const dir = st.ctx.direction;
    const wr = f.byRole('offense', 'WR1');
    const cb = f.byRole('defense', 'CB1');
    setAttrs(wr, 80, { speed: 90, acceleration: 90 });
    setAttrs(cb, 80, { speed: 90, acceleration: 90 });
    const scripts = offenseStill(f);
    scripts[wr.id] = pathScript([{ x: wr.pos.x, y: st.losY + dir * 55 }]);
    scripts['off:QB'] = dropbackScript(f, 7);
    snap(f);
    let minGapDeep = Infinity;
    runFor(f, 6, scripts, {}, (s) => {
      if (depthOf(s, wr.pos) > 33) minGapDeep = Math.min(minGapDeep, depthOf(s, cb.pos) - depthOf(s, wr.pos));
    });
    expect(depthOf(st, wr.pos)).toBeGreaterThan(40);
    expect(minGapDeep).toBeGreaterThan(0.5);
  });

  it('breaks on a ball thrown into his zone and plays it at arrival', () => {
    const f = setup({ offensePlayId: 'shotgun-curls', defensePlayId: '43-cover3-zone', seed: 3 });
    const st = f.state;
    const ss = f.byRole('defense', 'SS');
    const zone = ss.assignment.type === 'zone' ? ss.assignment.zone : undefined;
    expect(zone).toBe('curlFlatRight');
    const scripts = offenseStill(f);
    scripts['off:QB'] = dropbackScript(f, 5);
    snap(f);
    runFor(f, 2.0, scripts);
    const drop = zoneDropPoint('curlFlatRight', st.losY, st.ctx.direction);
    expect(dist(ss.pos, drop)).toBeLessThan(2);
    throwToPoint(f, { x: drop.x + 1, y: drop.y + st.ctx.direction }, 'touch');
    const landingTick = st.ball.landingTick;
    let broke = false;
    const actions: IntentAction[] = [];
    while (st.tick < landingTick) {
      runFor(f, 1 / 60, scripts);
      const i = st.intents[ss.id];
      if (!i) continue;
      if (i.debug.includes('break on ball')) broke = true;
      if (i.action) actions.push(i.action);
    }
    expect(broke).toBe(true);
    expect(actions.some((a) => a === 'jump' || a === 'swat')).toBe(true);
  });

  it('rallies to the catch and tackles after a completion in front of him', () => {
    const f = setup({ offensePlayId: 'shotgun-curls', defensePlayId: '43-cover3-zone', seed: 4 });
    const wr = f.byRole('offense', 'WR2');
    const ss = f.byRole('defense', 'SS');
    const scripts = offenseStill(f);
    scripts[wr.id] = routeScript(f, 'WR2');
    scripts['off:QB'] = dropbackScript(f, 5);
    snap(f);
    runFor(f, 2.2, scripts);
    expect(runUntil(f, 2.5, scripts, () => settled(wr))).toBe(true);
    throwTo(f, 'WR2', 'touch');
    let tackled = false;
    runFor(f, 2.5, scripts, { autoCatch: true }, (st) => {
      const i = st.intents[ss.id];
      if (wr.hasBall && i && (i.action === 'tackle' || i.action === 'hitStick' || i.action === 'strip' || i.action === 'dive')) tackled = true;
    });
    expect(wr.hasBall).toBe(true);
    expect(tackled).toBe(true);
  });

  it('underneath zones fill on a recognised run while the deep safety holds an alley until the carrier crosses', () => {
    const f = setup({ offensePlayId: 'iform-iso-right', defensePlayId: '43-cover3-zone', seed: 5 });
    const st = f.state;
    const dir = st.ctx.direction;
    for (const a of st.athletes) if (a.side === 'offense' && ['LT', 'LG', 'C', 'RG', 'RT'].includes(a.role)) a.active = false;
    const rb = f.byRole('offense', 'RB');
    const mlb = f.byRole('defense', 'MLB');
    const fs = f.byRole('defense', 'FS');
    const scripts = offenseStill(f);
    scripts[rb.id] = pathScript([{ x: st.ctx.ballX + dir * 2, y: st.losY + dir * 1 }, { x: st.ctx.ballX + dir * 3, y: st.losY + dir * 20 }], 1, false);
    snap(f);
    handoff(f, 'RB');
    let mlbPursued = false;
    let fsAlley = false;
    let fsAttacked = false;
    runFor(f, 2.5, scripts, {}, (s) => {
      const im = s.intents[mlb.id];
      const ifs = s.intents[fs.id];
      if (im && (im.debug.startsWith('pursue') || im.debug.startsWith('cut off'))) mlbPursued = true;
      if (ifs?.debug === 'alley' && depthOf(s, rb.pos) < 1) fsAlley = true;
      if (ifs && depthOf(s, rb.pos) > 1 && (ifs.debug.startsWith('pursue') || ifs.debug.startsWith('cut off'))) fsAttacked = true;
    });
    expect(mlbPursued).toBe(true);
    expect(fsAlley).toBe(true);
    expect(fsAttacked).toBe(true);
  });
});

describe('match coverage', () => {
  it('converts a deep-third defender to man on the vertical receiver in his band', () => {
    const f = setup({ offensePlayId: 'shotgun-goRoutes', defensePlayId: '43-cover3-match', seed: 2 });
    expect(f.state.ctx.defensivePlay.family).toBe('match');
    const wr = f.byRole('offense', 'WR1');
    const cb = f.byRole('defense', 'CB1');
    const scripts = offenseStill(f);
    scripts[wr.id] = routeScript(f, 'WR1');
    scripts['off:QB'] = dropbackScript(f, 7);
    snap(f);
    let matched = false;
    let matchedAt = 0;
    runFor(f, 2.5, scripts, {}, (st, t) => {
      const i = st.intents[cb.id];
      if (!matched && i?.debug.startsWith('match WR1')) { matched = true; matchedAt = t; }
    });
    expect(matched).toBe(true);
    expect(matchedAt).toBeGreaterThan(0.2);
    expect(cb.ai.targetAthleteId).toBe('off:WR1');
    expect(dist(cb.pos, wr.pos)).toBeLessThan(4);
  });

  it('plain zone family never converts, and a receiver breaking off short releases the match defender', () => {
    const z = setup({ offensePlayId: 'shotgun-goRoutes', defensePlayId: '43-cover3-zone', seed: 2 });
    const zs = offenseStill(z);
    zs['off:WR1'] = routeScript(z, 'WR1');
    zs['off:QB'] = dropbackScript(z, 7);
    snap(z);
    let converted = false;
    runFor(z, 2.5, zs, {}, (st) => { if (st.intents['def:CB1']?.debug.startsWith('match')) converted = true; });
    expect(converted).toBe(false);

    const f = setup({ offensePlayId: 'shotgun-curls', defensePlayId: '43-cover3-match', seed: 2 });
    const cb = f.byRole('defense', 'CB1');
    const scripts = offenseStill(f);
    scripts['off:WR1'] = routeScript(f, 'WR1'); // curl: vertical stem, then settles at 10 yd
    scripts['off:QB'] = dropbackScript(f, 5);
    snap(f);
    const labels: string[] = [];
    runFor(f, 3.5, scripts, {}, (st) => { labels.push(st.intents[cb.id]?.debug ?? ''); });
    const firstMatch = labels.findIndex((l) => l.startsWith('match'));
    expect(firstMatch).toBeGreaterThan(0);
    const releasedLater = labels.slice(firstMatch).some((l) => l.startsWith('zone'));
    expect(releasedLater).toBe(true);
  });
});
