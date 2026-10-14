import { describe, expect, it } from 'vitest';
import { createRng } from '@/core/rng';
import type { PlayerId } from '@/core/ids';
import { POSITIONS } from '@/players/types';
import type { InjuryStatus, Player } from '@/players/types';
import type { DepthChart } from '@/teams/types';
import {
  DEPTH_SLOTS, RETURNER_DEPTH, RETURNER_POSITIONS, ROSTER_COMPOSITION, ROSTER_SIZE, STARTER_COUNTS,
  applySubstitution, autoDepthChart, depthRank, emptyDepthChart, isAvailable, isDepthChartValid,
  removeFromDepthChart, returnScore, rosterPositionCounts, starters, validateDepthChart,
} from '@/teams/depth-chart';
import { generateRoster } from '@/teams/generator';
import { COLLEGES, REGIONS, makePlayer, testNames } from '../players/helpers';

const roster = generateRoster(createRng(101), { quality: 0.6, names: testNames, regions: REGIONS, colleges: COLLEGES, year: 2030 });
const byId = new Map(roster.map((p) => [p.id, p]));
const chart = autoDepthChart(roster);
const player = (id: PlayerId): Player => {
  const p = byId.get(id);
  if (!p) throw new Error(`missing ${id}`);
  return p;
};
const injury = (severity: InjuryStatus['severity'], weeks: number): InjuryStatus => ({
  bodyArea: 'lowerBody', severity, weeksRemaining: weeks, permanentPenalty: null, occurredYear: 2030, occurredWeek: 3,
});
const errors = (issues: ReturnType<typeof validateDepthChart>): string[] => issues.filter((i) => i.severity === 'error').map((i) => i.kind);
const warnings = (issues: ReturnType<typeof validateDepthChart>): string[] => issues.filter((i) => i.severity === 'warning').map((i) => i.kind);

describe('roster composition', () => {
  it('sums to the 53-man roster and covers every position', () => {
    expect(Object.values(ROSTER_COMPOSITION).reduce((a, b) => a + b, 0)).toBe(ROSTER_SIZE);
    expect(ROSTER_SIZE).toBe(53);
    for (const pos of POSITIONS) expect(ROSTER_COMPOSITION[pos]).toBeGreaterThan(0);
  });
  it('lists every position plus KR and PR as slots, and starter counts never exceed the roster count', () => {
    expect(DEPTH_SLOTS).toEqual([...POSITIONS, 'KR', 'PR']);
    for (const pos of POSITIONS) expect(STARTER_COUNTS[pos]).toBeLessThanOrEqual(ROSTER_COMPOSITION[pos]);
    const empty = emptyDepthChart();
    for (const slot of DEPTH_SLOTS) expect(empty[slot]).toEqual([]);
  });
  it('counts roster players per position', () => {
    expect(rosterPositionCounts(roster)).toEqual(ROSTER_COMPOSITION);
    expect(rosterPositionCounts([]).QB).toBe(0);
  });
});

describe('autoDepthChart', () => {
  it('lists every player at his position ordered by overall, best first', () => {
    for (const pos of POSITIONS) {
      const ids = chart[pos];
      expect(ids).toHaveLength(ROSTER_COMPOSITION[pos]);
      expect(new Set(ids).size).toBe(ids.length);
      for (const id of ids) expect(player(id).position).toBe(pos);
      for (let i = 1; i < ids.length; i++) expect(player(ids[i - 1]!).overall).toBeGreaterThanOrEqual(player(ids[i]!).overall);
    }
  });
  it('picks returners from RB/WR/CB/FS by return score, nudging backups ahead of starters', () => {
    const starterIds = new Set<PlayerId>();
    for (const pos of POSITIONS) for (const id of chart[pos].slice(0, STARTER_COUNTS[pos])) starterIds.add(id);
    for (const role of ['KR', 'PR'] as const) {
      const ids = chart[role];
      expect(ids).toHaveLength(RETURNER_DEPTH);
      for (const id of ids) expect(RETURNER_POSITIONS).toContain(player(id).position);
      const adjusted = (p: Player): number => returnScore(p, role) - (starterIds.has(p.id) ? 6 : 0);
      const best = roster.filter((p) => RETURNER_POSITIONS.includes(p.position)).sort((a, b) => adjusted(b) - adjusted(a))[0]!;
      expect(ids[0]).toBe(best.id);
      for (let i = 1; i < ids.length; i++) expect(adjusted(player(ids[i - 1]!))).toBeGreaterThanOrEqual(adjusted(player(ids[i]!)));
    }
  });
  it('drops injured and retired players to the bottom / off the chart', () => {
    const qb1 = player(chart.QB[0]!);
    const hurtRoster = roster.map((p) => (p.id === qb1.id ? { ...p, injury: injury('moderate', 6) } : p));
    const hurt = autoDepthChart(hurtRoster);
    expect(hurt.QB[0]).not.toBe(qb1.id);
    expect(hurt.QB[hurt.QB.length - 1]).toBe(qb1.id);
    expect(isAvailable({ injury: injury('moderate', 6), retired: false })).toBe(false);
    expect(isAvailable({ injury: injury('minor', 1), retired: false })).toBe(true);
    const retiredRoster = roster.map((p) => (p.id === qb1.id ? { ...p, retired: true } : p));
    expect(autoDepthChart(retiredRoster).QB).not.toContain(qb1.id);
    // A lightly injured starter still starts.
    const lightRoster = roster.map((p) => (p.id === qb1.id ? { ...p, injury: injury('minor', 1) } : p));
    expect(autoDepthChart(lightRoster).QB[0]).toBe(qb1.id);
  });
  it('breaks exact ties by potential, then age, then id so the order is deterministic', () => {
    const a = makePlayer({ id: 'p_bbb' as PlayerId, position: 'K', attrValue: 70, potential: 75, age: 30 });
    const b = makePlayer({ id: 'p_aaa' as PlayerId, position: 'K', attrValue: 70, potential: 75, age: 30 });
    const c = makePlayer({ id: 'p_ccc' as PlayerId, position: 'K', attrValue: 70, potential: 80, age: 30 });
    const d = makePlayer({ id: 'p_ddd' as PlayerId, position: 'K', attrValue: 70, potential: 75, age: 24 });
    expect(autoDepthChart([a, b, c, d]).K).toEqual(['p_ccc', 'p_ddd', 'p_aaa', 'p_bbb']);
  });
  it('return score favours speed and, for punts, hands', () => {
    const fast = makePlayer({ attrs: { ...makePlayer({ attrValue: 60 }).attrs, speed: 95, acceleration: 90 } });
    const slow = makePlayer({ attrValue: 60 });
    expect(returnScore(fast, 'KR')).toBeGreaterThan(returnScore(slow, 'KR'));
    const hands = makePlayer({ attrs: { ...slow.attrs, hands: 95 } });
    expect(returnScore(hands, 'PR') - returnScore(slow, 'PR')).toBeGreaterThan(returnScore(hands, 'KR') - returnScore(slow, 'KR'));
  });
});

describe('starters, depthRank and substitutions', () => {
  it('starters returns the base starter count by default and honours n', () => {
    expect(starters(chart, 'WR')).toEqual(chart.WR.slice(0, 3));
    expect(starters(chart, 'QB', 2)).toEqual(chart.QB.slice(0, 2));
    expect(starters(chart, 'QB', -1)).toEqual([]);
    expect(starters(chart, 'QB', 99)).toEqual(chart.QB);
  });
  it('depthRank finds a player or returns -1', () => {
    expect(depthRank(chart, 'RB', chart.RB[1]!)).toBe(1);
    expect(depthRank(chart, 'RB', chart.QB[0]!)).toBe(-1);
  });
  it('applySubstitution promotes within a slot without touching other slots or the input', () => {
    const before = JSON.stringify(chart);
    const wr3 = chart.WR[2]!;
    const next = applySubstitution(chart, 'WR', wr3, 0);
    expect(next.WR[0]).toBe(wr3);
    expect(next.WR).toHaveLength(chart.WR.length);
    expect(next.WR.slice(1, 3)).toEqual(chart.WR.slice(0, 2));
    expect(next.QB).toEqual(chart.QB);
    expect(JSON.stringify(chart)).toBe(before);
  });
  it('inserts a player who was not listed, clamps the rank and rejects unknown slots', () => {
    const wr1 = chart.WR[0]!;
    const asKr = applySubstitution(chart, 'KR', wr1, 0);
    expect(asKr.KR[0]).toBe(wr1);
    expect(asKr.KR).toHaveLength(chart.KR.includes(wr1) ? chart.KR.length : chart.KR.length + 1);
    expect(asKr.WR).toEqual(chart.WR);
    const appended = applySubstitution(chart, 'QB', chart.QB[0]!, 50);
    expect(appended.QB[appended.QB.length - 1]).toBe(chart.QB[0]);
    expect(() => applySubstitution(chart, 'LS' as unknown as 'KR', wr1)).toThrow(/unknown slot/);
  });
  it('removeFromDepthChart clears a player from every slot', () => {
    const wr1 = chart.WR[0]!;
    const withKr = applySubstitution(chart, 'KR', wr1, 0);
    const removed = removeFromDepthChart(withKr, wr1);
    for (const slot of DEPTH_SLOTS) expect(removed[slot]).not.toContain(wr1);
    expect(removed.WR).toHaveLength(chart.WR.length - 1);
    expect(withKr.KR[0]).toBe(wr1);
  });
});

describe('validateDepthChart', () => {
  it('accepts an automatic chart for a full roster with no issues at all', () => {
    expect(validateDepthChart(chart, roster)).toEqual([]);
    expect(isDepthChartValid(chart, roster)).toBe(true);
  });
  it('flags unknown, duplicate, retired and out-of-position players', () => {
    const bad: DepthChart = { ...chart, QB: [...chart.QB, 'p_ghost' as PlayerId], RB: [chart.RB[0]!, chart.RB[0]!, ...chart.RB.slice(1)] };
    const issues = validateDepthChart(bad, roster);
    expect(errors(issues)).toContain('unknownPlayer');
    expect(errors(issues)).toContain('duplicate');
    expect(isDepthChartValid(bad, roster)).toBe(false);

    const fs = chart.FS[0]!;
    const shifted: DepthChart = { ...chart, CB: [fs, ...chart.CB] };
    const w = validateDepthChart(shifted, roster);
    expect(warnings(w)).toContain('wrongPosition');
    expect(errors(w)).toEqual([]);
    expect(isDepthChartValid(shifted, roster)).toBe(true);

    const retiredRoster = roster.map((p) => (p.id === fs ? { ...p, retired: true } : p));
    expect(errors(validateDepthChart(chart, retiredRoster))).toContain('retired');
  });
  it('flags understaffed slots, ineligible returners and missing slots', () => {
    const noQb: DepthChart = { ...chart, QB: [] };
    const issues = validateDepthChart(noQb, roster);
    expect(issues.filter((i) => i.kind === 'understaffed').map((i) => i.slot)).toEqual(['QB']);
    expect(warnings(issues).filter((k) => k === 'unlisted')).toHaveLength(ROSTER_COMPOSITION.QB);

    const otReturner: DepthChart = { ...chart, KR: [chart.OT[0]!, ...chart.KR] };
    expect(errors(validateDepthChart(otReturner, roster))).toContain('ineligibleReturner');

    const { PR: _pr, ...partial } = chart;
    const missing = validateDepthChart(partial as DepthChart, roster);
    expect(missing.some((i) => i.kind === 'missingSlot' && i.slot === 'PR')).toBe(true);
  });
  it('warns about injured starters but not injured backups', () => {
    const qb1 = chart.QB[0]!;
    const qb3 = chart.QB[2]!;
    const hurtStarter = roster.map((p) => (p.id === qb1 ? { ...p, injury: injury('seasonEnding', 12) } : p));
    const issues = validateDepthChart(chart, hurtStarter);
    expect(issues.map((i) => i.kind)).toEqual(['injuredStarter']);
    expect(issues[0]?.playerId).toBe(qb1);
    const hurtBackup = roster.map((p) => (p.id === qb3 ? { ...p, injury: injury('seasonEnding', 12) } : p));
    expect(validateDepthChart(chart, hurtBackup)).toEqual([]);
  });
});
