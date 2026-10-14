import { describe, expect, it } from 'vitest';
import type { OffensivePlay, DefensivePlay } from '@/playbook/types';
import { buildMatchups, conceptModifiers, routeInfo, separationYards } from '@/simulation/matchups';
import { makeCtx } from './helpers';

const knobs = { qbIq: null, coverageIq: null };

describe('buildMatchups', () => {
  it('summarises a pass play: passer, blockers, rushers, receivers with openness and coverage defenders', () => {
    const m = buildMatchups(makeCtx({ offensePlayId: 'shotgun-mesh', defensePlayId: '43-cover1-man' }), knobs);
    expect(m.passer?.role).toBe('QB');
    expect(m.blockers.length).toBe(5);
    expect(m.rushers.length).toBeGreaterThanOrEqual(4);
    expect(m.receivers.map((r) => r.rated.role)).toEqual(['WR3', 'TE1', 'RB', 'WR1', 'WR2']);
    expect(m.receivers[0]?.readIndex).toBe(0);
    for (const r of m.receivers) { expect(r.openness).toBeGreaterThan(0); expect(r.openness).toBeLessThan(1); expect(r.quality).toBeGreaterThan(0); }
    const man = m.receivers.find((r) => r.rated.role === 'WR1');
    expect(man?.defender?.assignment.type).toBe('manCover');
    expect(m.coverageDefenders.length).toBeGreaterThanOrEqual(6);
    expect(m.passProtection).toBeGreaterThan(0.2);
    expect(m.passRush).toBeGreaterThan(0.2);
  });

  it('excludes stalk-blocking receivers from the progression and finds the carrier on runs', () => {
    const m = buildMatchups(makeCtx({ offensePlayId: 'iform-dive-right', defensePlayId: '43-runStop-cover1' }), knobs);
    expect(m.carrier?.role).toBe('RB');
    expect(m.receivers.length).toBe(0);
    expect(m.blockers.some((b) => b.role === 'FB')).toBe(true);
    expect(m.boxCount).toBeGreaterThanOrEqual(7);
  });

  it('box count grows with DB run fills / blitzers and the blitz count follows the play', () => {
    const base = buildMatchups(makeCtx({ offensePlayId: 'iform-dive-right', defensePlayId: '43-cover3-zone' }), knobs);
    const blitz = buildMatchups(makeCtx({ offensePlayId: 'iform-dive-right', defensePlayId: '43-cover1-safetyBlitz' }), knobs);
    expect(blitz.blitzCount).toBeGreaterThan(base.blitzCount);
    expect(blitz.boxCount).toBeGreaterThan(base.boxCount);
    expect(blitz.passRush).toBeGreaterThanOrEqual(base.passRush);
  });

  it('effective attributes matter: fatigue and injuries weaken a unit', () => {
    const ctx = makeCtx({ offensePlayId: 'shotgun-mesh', defensePlayId: '43-cover3-zone' });
    const fresh = buildMatchups(ctx, knobs);
    const fatigue = { ...ctx.fatigue };
    for (const p of Object.values(ctx.offenseLineup)) fatigue[p.id] = 0.9;
    const tired = buildMatchups({ ...ctx, fatigue }, knobs);
    expect(tired.passProtection).toBeLessThan(fresh.passProtection);
    expect(tired.qbQuality).toBeLessThan(fresh.qbQuality);
    expect(tired.receivers[0]!.openness).toBeLessThan(fresh.receivers[0]!.openness);
  });

  it('difficulty knobs tilt AI decisions: a higher coverage IQ closes receivers, a higher QB IQ sharpens reads', () => {
    const ctx = makeCtx({ offensePlayId: 'shotgun-mesh', defensePlayId: '43-cover1-man' });
    const low = buildMatchups(ctx, { qbIq: 0.3, coverageIq: 0.3 });
    const high = buildMatchups(ctx, { qbIq: 0.95, coverageIq: 0.95 });
    expect(high.qbDecision).toBeGreaterThan(low.qbDecision);
    expect(high.receivers[0]!.openness).toBeLessThan(low.receivers[0]!.openness);
    expect(high.coverageQuality).toBeGreaterThan(low.coverageQuality);
  });

  it('special teams: kicker, returner, coverage and return-blocking units', () => {
    const m = buildMatchups(makeCtx({ offensePlayId: 'kickoff-deep', defensePlayId: 'kickReturn-middle', ballOn: 35, special: 'kickoff' }), knobs);
    expect(m.kicker?.role).toBe('K');
    expect(m.returner?.assignment.type).toBe('returner');
    expect(m.kickCoverage).toBeGreaterThan(0.2);
    expect(m.returnBlocking).toBeGreaterThan(0.2);
    const fg = buildMatchups(makeCtx({ offensePlayId: 'fieldGoal-standard', defensePlayId: 'fgBlock-middle', ballOn: 80, special: 'fieldGoal' }), knobs);
    expect(fg.holder?.role).toBe('H');
  });
});

describe('concept-vs-coverage table', () => {
  const play = (concept: OffensivePlay['concept']): OffensivePlay => ({ id: 'x', name: 'x', formation: 'shotgun', type: 'pass', concept, assignments: {}, primary: 'WR1', progression: [], tags: [] });
  const def = (coverage: DefensivePlay['coverage'], family: DefensivePlay['family'], blitz: DefensivePlay['blitz'] = 'none', tags: string[] = []): DefensivePlay =>
    ({ id: 'd', name: 'd', formation: '43', coverage, family, blitz, assignments: {}, tags });
  const flags = { contain: false, spy: false, press: false };

  it('four verts beats cover 2, mesh beats man, screens beat the blitz', () => {
    expect(conceptModifiers(play('fourVerts'), def('cover2', 'zone'), 7, flags).completion).toBeGreaterThan(0);
    expect(conceptModifiers(play('fourVerts'), def('cover4', 'zone'), 7, flags).completion).toBeLessThan(0);
    expect(conceptModifiers(play('mesh'), def('cover1', 'man'), 7, flags).completion).toBeGreaterThan(0);
    expect(conceptModifiers(play('mesh'), def('cover3', 'zone'), 7, flags).yac).toBeLessThan(0);
    const screenBlitz = conceptModifiers(play('screen'), def('cover0', 'man', 'allOut'), 7, flags);
    expect(screenBlitz.yac).toBeGreaterThan(0.3);
    expect(screenBlitz.pressure).toBeLessThan(0);
  });

  it('outside runs suffer against contain, inside runs against a goal-line box and play action punishes run-stop fronts', () => {
    expect(conceptModifiers(play('outsideRun'), def('cover3', 'zone'), 7, { ...flags, contain: true }).runYards).toBeLessThan(0);
    expect(conceptModifiers(play('insideRun'), def('cover0', 'man'), 9, flags).stuff).toBeGreaterThan(0);
    expect(conceptModifiers(play('insideRun'), def('cover2', 'zone'), 6, flags).runYards).toBeGreaterThan(0);
    const pa = conceptModifiers(play('playAction'), def('cover1', 'man', 'none', ['runStop']), 8, flags);
    expect(pa.completion).toBeGreaterThan(0);
    expect(pa.airYards).toBeGreaterThan(0);
    expect(conceptModifiers(play('qbRun'), def('cover1', 'man'), 7, { ...flags, spy: true }).runYards).toBeLessThan(0);
    expect(conceptModifiers(play('draw'), def('cover0', 'man', 'lb'), 7, flags).runYards).toBeGreaterThan(0);
  });
});

describe('route info and separation', () => {
  it('reads bundled routes (including mirrored twins) and infers unknown ids from their name', () => {
    expect(routeInfo('slant')).toEqual({ type: 'slant', depth: 3 });
    expect(routeInfo('quickOut~m')).toEqual({ type: 'out', depth: 5 });
    expect(routeInfo('myDeepCorner')).toMatchObject({ type: 'corner' });
    expect(routeInfo('zzz').depth).toBe(5);
  });

  it('separation yards scale with openness', () => {
    expect(separationYards(0)).toBeCloseTo(0.5);
    expect(separationYards(1)).toBeCloseTo(5);
    expect(separationYards(0.5)).toBeGreaterThan(separationYards(0.2));
  });
});
