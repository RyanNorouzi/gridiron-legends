import { describe, expect, it } from 'vitest';
import { createRng } from '@/core/rng';
import { buildMatchups } from '@/simulation/matchups';
import { knobsFor, resolveKneel, resolveScrimmagePlay, resolveSpike, rpoThrows, type PassResolution, type RunResolution } from '@/simulation/play-model';
import { resolvePass } from '@/simulation/pass-model';
import { resolveRun } from '@/simulation/run-model';
import { makeCtx } from './helpers';

const knobs = { qbIq: null, coverageIq: null, interceptionIq: null, tackleIq: null };

describe('knobsFor', () => {
  it('applies difficulty only to AI-controlled sides', () => {
    const ai = knobsFor(makeCtx({}));
    expect(ai.qbIq).toBe(0.6);
    expect(ai.coverageIq).toBe(0.5);
    const humanOffense = knobsFor(makeCtx({ controllers: { home: 'human', away: 'ai' } }));
    expect(humanOffense.qbIq).toBeNull();
    expect(humanOffense.coverageIq).toBe(0.5);
    const watched = knobsFor(makeCtx({ controllers: { home: 'ai', away: 'watch' } }));
    expect(watched.interceptionIq).toBe(0.5);
    expect(watched.tackleIq).toBe(0.6);
    expect(watched.pursuitIq).toBe(0.6);
    expect(humanOffense.pursuitIq).toBe(0.6);
  });
});

describe('resolveScrimmagePlay dispatch', () => {
  it('routes each play type to the right resolution', () => {
    const kinds = (id: string, n = 30): Set<string> => {
      const out = new Set<string>();
      for (let v = 0; v < n; v++) { const ctx = makeCtx({ offensePlayId: id, seed: 2 }, v); const r = resolveScrimmagePlay(ctx, buildMatchups(ctx, knobs), knobs, ctx.rng); out.add(r.kind + (r.kind === 'run' && r.scramble ? ':scramble' : r.kind === 'run' && r.designedQb ? ':qb' : '')); }
      return out;
    };
    expect(kinds('iform-kneel')).toEqual(new Set(['kneel']));
    expect(kinds('singleback-spike')).toEqual(new Set(['spike']));
    expect(kinds('iform-dive-right')).toEqual(new Set(['run']));
    expect(kinds('pistol-zoneRead')).toEqual(new Set(['run:qb']));
    const passes = kinds('shotgun-fourVerts', 80);
    expect(passes.has('pass')).toBe(true);
    expect([...passes].every((k) => k === 'pass' || k === 'run:scramble')).toBe(true);
    const rpo = kinds('shotgun-rpoSlant', 80);
    expect(rpo.has('pass')).toBe(true);
    expect(rpo.has('run')).toBe(true);
  });

  it('kneels and spikes are cheap', () => {
    const ctx = makeCtx({});
    const m = buildMatchups(ctx, knobs);
    const k = resolveKneel(m, createRng(1));
    expect(k.yards).toBeGreaterThanOrEqual(-2);
    expect(k.yards).toBeLessThanOrEqual(0);
    expect(k.timeElapsed).toBeLessThanOrEqual(3);
    expect(resolveSpike(m, createRng(1)).timeElapsed).toBeLessThanOrEqual(2);
  });

  it('RPOs throw more often against a loaded box', () => {
    const light = makeCtx({ offensePlayId: 'shotgun-rpoSlant', defensePlayId: 'dime-cover2-zone' });
    const heavy = makeCtx({ offensePlayId: 'shotgun-rpoSlant', defensePlayId: '43-cover0-lbBlitz' });
    const count = (ctx: typeof light): number => { let n = 0; const rng = createRng(4); const m = buildMatchups(ctx, knobs); for (let i = 0; i < 400; i++) if (rpoThrows(m, rng)) n += 1; return n; };
    expect(count(heavy)).toBeGreaterThan(count(light) + 40);
  });
});

describe('run model', () => {
  const carries = (offId: string, defId: string, n: number, seed = 1): RunResolution[] => {
    const ctx = makeCtx({ offensePlayId: offId, defensePlayId: defId, seed });
    const m = buildMatchups(ctx, knobs);
    const out: RunResolution[] = [];
    for (let v = 0; v < n; v++) out.push(resolveRun(ctx, m, knobs, createRng(`run:${v}`), { carrier: m.carrier!, scramble: false, designedQb: false, draw: false }));
    return out;
  };

  it('has a stuffed share, a long tail, integer yards and consistent contact bookkeeping', () => {
    const rs = carries('singleback-stretch-right', '43-cover3-zone', 600);
    const stuffed = rs.filter((r) => r.stuffed).length / rs.length;
    expect(stuffed).toBeGreaterThan(0.08);
    expect(stuffed).toBeLessThan(0.35);
    expect(rs.some((r) => r.yards >= 15)).toBe(true);
    for (const r of rs) {
      expect(Number.isInteger(r.yards)).toBe(true);
      if (r.stuffed) expect(r.yards).toBeLessThanOrEqual(0);
      expect(r.yardsAfterContact).toBeLessThanOrEqual(Math.max(0, r.yards));
      if (r.tackle) expect(r.tackle.missed.length).toBe(r.brokenTackles);
      if (r.touchdown) expect(r.tackle).toBeNull();
      if (r.fumble?.lost) expect(r.fumble.returnYards).toBeLessThanOrEqual(r.fumble.spotBallOn);
    }
  });

  it('a light box gives up more than a goal-line front', () => {
    const light = carries('iform-dive-right', 'dime-cover2-zone', 500);
    const heavy = carries('iform-dive-right', 'goalLine-cover0-runStop', 500);
    const ypc = (rs: RunResolution[]): number => rs.reduce((s, r) => s + r.yards, 0) / rs.length;
    expect(ypc(light)).toBeGreaterThan(ypc(heavy) + 0.8);
  });

  it('scrambles never lose yards when stuffed and can slide', () => {
    const ctx = makeCtx({ offensePlayId: 'shotgun-mesh', seed: 3 });
    const m = buildMatchups(ctx, knobs);
    let slides = 0;
    for (let v = 0; v < 300; v++) {
      const r = resolveRun(ctx, m, knobs, createRng(`scr:${v}`), { carrier: m.passer!, scramble: true, designedQb: false, draw: false });
      expect(r.yards).toBeGreaterThanOrEqual(0);
      if (r.slide) { slides += 1; expect(r.tackle).toBeNull(); expect(r.fumble).toBeNull(); }
    }
    expect(slides).toBeGreaterThan(20);
  });
});

describe('pass model', () => {
  const dropbacks = (offId: string, defId: string, n: number, seed = 1) => {
    const ctx = makeCtx({ offensePlayId: offId, defensePlayId: defId, seed });
    const m = buildMatchups(ctx, knobs);
    const out: (PassResolution | RunResolution)[] = [];
    for (let v = 0; v < n; v++) out.push(resolvePass(ctx, m, knobs, createRng(`pass:${v}`), { playAction: false, screen: offId.includes('Screen'), rpo: false }));
    return out;
  };

  it('pressure and sacks rise against an all-out blitz and fall for screens', () => {
    const rate = (rs: (PassResolution | RunResolution)[], f: (p: PassResolution) => boolean): number => rs.filter((r) => r.kind === 'pass' && f(r)).length / rs.length;
    const base = dropbacks('shotgun-fourVerts', '43-cover3-zone', 600);
    const blitz = dropbacks('shotgun-fourVerts', '34-cover0-allOut', 600);
    const screen = dropbacks('shotgun-rbScreen-right', '34-cover0-allOut', 600);
    expect(rate(blitz, (p) => p.pressure)).toBeGreaterThan(rate(base, (p) => p.pressure) + 0.08);
    expect(rate(blitz, (p) => p.sack !== null)).toBeGreaterThan(rate(base, (p) => p.sack !== null));
    expect(rate(screen, (p) => p.sack !== null)).toBeLessThan(rate(blitz, (p) => p.sack !== null));
    expect(rate(screen, (p) => p.complete)).toBeGreaterThan(0.6);
  });

  it('targets follow the progression with a bias to the primary and open receivers; deep throws complete less', () => {
    const mesh = dropbacks('shotgun-mesh', '43-cover1-man', 800).filter((r): r is PassResolution => r.kind === 'pass' && r.target !== null);
    const counts = new Map<number, number>();
    for (const r of mesh) counts.set(r.target!.readIndex, (counts.get(r.target!.readIndex) ?? 0) + 1);
    expect((counts.get(0) ?? 0) + (counts.get(1) ?? 0)).toBeGreaterThan(mesh.length * 0.35);
    const rs = [...mesh, ...dropbacks('shotgun-fourVerts', '43-cover3-zone', 400, 2), ...dropbacks('shotgun-postWheel', '43-cover2-zone', 400, 3)].filter((r): r is PassResolution => r.kind === 'pass' && r.target !== null);
    const shallow = rs.filter((r) => r.airYards <= 6);
    const deep = rs.filter((r) => r.airYards >= 14);
    const comp = (xs: PassResolution[]): number => xs.filter((r) => r.complete).length / xs.length;
    expect(shallow.length).toBeGreaterThan(30);
    expect(deep.length).toBeGreaterThan(30);
    expect(comp(shallow)).toBeGreaterThan(comp(deep) + 0.1);
    for (const r of rs) {
      if (r.complete) { expect(r.yards).toBe(r.airYards + r.yac); expect(r.yac).toBeGreaterThanOrEqual(0); }
      else { expect(r.yards).toBe(0); expect(r.incompleteReason !== null || r.interception !== null).toBe(true); }
      if (r.interception) { expect(r.interception.spotBallOn).toBeLessThanOrEqual(100); expect(r.interception.returnYards).toBeLessThanOrEqual(r.interception.spotBallOn); }
    }
  });

  it('sure hands win the contested balls: the catch-rating slope shows on contested throws, not just overall', () => {
    const ctx = makeCtx({ offensePlayId: 'shotgun-curls', defensePlayId: '43-cover1-man', seed: 6 });
    const withHands = (v: number) => ({
      ...ctx,
      offenseLineup: Object.fromEntries(Object.entries(ctx.offenseLineup).map(([role, pl]) => [role, role === 'QB' ? pl : { ...pl, attrs: { ...pl.attrs, catching: v, hands: v } }])),
    });
    const tallyOf = (c: ReturnType<typeof withHands>) => {
      const m = buildMatchups(c, knobs);
      const t = { contested: 0, contestedDone: 0, open: 0, openDone: 0 };
      for (let v = 0; v < 3000; v++) {
        const r = resolvePass(c, m, knobs, createRng(`hands:${v}`), { playAction: false, screen: false, rpo: false });
        if (r.kind !== 'pass' || !r.target || r.sack || r.throwAway) continue;
        if (r.contested) { t.contested += 1; if (r.complete) t.contestedDone += 1; } else { t.open += 1; if (r.complete) t.openDone += 1; }
      }
      return { contested: t.contestedDone / t.contested, open: t.openDone / t.open, n: t.contested };
    };
    const sure = tallyOf(withHands(95));
    const stone = tallyOf(withHands(45));
    expect(stone.n).toBeGreaterThan(150);
    expect(sure.contested).toBeGreaterThan(stone.contested + 0.1);
    expect(sure.contested - stone.contested).toBeGreaterThan(sure.open - stone.open);
  });

  it('a stronger arm and better accuracy complete more deep balls', () => {
    const ctx = makeCtx({ offensePlayId: 'shotgun-goRoutes', defensePlayId: '43-cover3-zone', seed: 5 });
    const qb = ctx.offenseLineup['QB']!;
    const withQb = (delta: number) => ({ ...ctx, offenseLineup: { ...ctx.offenseLineup, QB: { ...qb, attrs: { ...qb.attrs, throwAccuracy: Math.min(99, Math.max(1, qb.attrs.throwAccuracy + delta)), awareness: Math.min(99, Math.max(1, qb.attrs.awareness + delta)), throwPower: Math.min(99, Math.max(1, qb.attrs.throwPower + delta)) } } } });
    const comp = (c: ReturnType<typeof withQb>): number => {
      const m = buildMatchups(c, knobs);
      let att = 0; let done = 0;
      for (let v = 0; v < 600; v++) { const r = resolvePass(c, m, knobs, createRng(`qb:${v}`), { playAction: false, screen: false, rpo: false }); if (r.kind === 'pass' && r.target && !r.sack) { att += 1; if (r.complete) done += 1; } }
      return done / att;
    };
    expect(comp(withQb(25))).toBeGreaterThan(comp(withQb(-25)) + 0.08);
  });
});
