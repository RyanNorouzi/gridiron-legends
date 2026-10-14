import { describe, expect, it } from 'vitest';
import type { PlayerId } from '@/core/ids';
import type { DraftPick } from '@/teams/types';
import { assignPlayer } from '@/franchise/roster';
import { teamNeeds, teamDirection, positionNeed, directionFor } from '@/franchise/gm/needs';
import {
  ageValueFactor, assetValue, currentDraftYear, isUntouchable, packageValue, pickChartValue, pickValue, playerTradeValue, projectedPickSlot,
  valueGap, validateTradeValueData,
} from '@/franchise/gm/valuation';
import { makePlayer } from '../../players/helpers';
import { atPhase, bestAt, buildLeague, makeSettings, rosterOf, teamsSorted, withPlayer, withTeam } from './helpers';

const settings = makeSettings();

describe('teamNeeds', () => {
  it('flags a team whose only quarterback is a 60 overall', () => {
    let league = buildLeague();
    const team = teamsSorted(league)[0]!;
    const qbs = rosterOf(league, team.id).filter((p) => p.position === 'QB');
    for (const qb of qbs.slice(1)) league = assignPlayer(league, qb.id, null);
    league = withPlayer(league, { ...qbs[0]!, overall: 60 });
    const needs = teamNeeds(league, league.teams[team.id]!);
    expect(needs.positions.QB.need).toBeGreaterThan(0.6);
    expect(needs.positions.QB.depthCount).toBe(1);
    expect(needs.positions.QB.startersQuality).toBe(60);
    expect(needs.ranked[0]).toBe('QB');
    const healthy = teamNeeds(league, league.teams[teamsSorted(league)[1]!.id]!);
    expect(healthy.positions.QB.need).toBeLessThan(needs.positions.QB.need / 2);
  });

  it('positionNeed counts empty starting slots, thin depth and aging starters', () => {
    const young = [makePlayer({ id: 'p_1' as PlayerId, position: 'CB', attrValue: 80, age: 25 })];
    const old = [makePlayer({ id: 'p_2' as PlayerId, position: 'CB', attrValue: 80, age: 33 }), makePlayer({ id: 'p_3' as PlayerId, position: 'CB', attrValue: 80, age: 33 })];
    const one = positionNeed('CB', young, 2026);
    expect(one.weakestStarter).toBe(40);
    expect(one.need).toBeGreaterThan(positionNeed('CB', old, 2026).need);
    expect(positionNeed('CB', old, 2026).aging).toBe(1);
  });

  it('direction: the strongest team contends, the weakest rebuilds', () => {
    const league = buildLeague();
    const byOverall = teamsSorted(league).sort((a, b) => b.overall - a.overall);
    expect(teamDirection(league, byOverall[0]!)).toBe('contend');
    expect(teamDirection(league, byOverall[byOverall.length - 1]!)).toBe('rebuild');
    expect(directionFor(0.45, 30)).toBe('rebuild');
    expect(directionFor(0.45, 26)).toBe('retool');
    const needs = teamNeeds(league, byOverall[0]!);
    expect(needs.ranked).toHaveLength(17);
  });
});

describe('player valuation', () => {
  const star = (age: number) => makePlayer({ id: `p_s${age}` as PlayerId, position: 'WR', attrValue: 88, age, potential: 90 });

  it('a young star is worth more than the same star at 33', () => {
    const young = playerTradeValue(star(24), 2026, settings);
    const old = playerTradeValue(star(33), 2026, settings);
    expect(young).toBeGreaterThan(old * 2);
    expect(ageValueFactor({ age: 24, position: 'WR' })).toBe(1);
  });

  it('value climbs steeply with overall and favours premium positions', () => {
    const at = (attrValue: number, position: 'QB' | 'OG' = 'OG') => playerTradeValue(makePlayer({ position, attrValue, age: 27 }), 2026, settings);
    expect(at(90)).toBeGreaterThan(at(80) * 1.8);
    expect(at(80)).toBeGreaterThan(at(70) * 1.8);
    expect(at(85, 'QB')).toBeGreaterThan(at(85, 'OG'));
  });

  it('contract surplus, injuries and control shape value', () => {
    const base = makePlayer({ position: 'CB', attrValue: 82, age: 26 });
    const cheap = { ...base, contract: { salary: 1_000_000, years: 4, yearsRemaining: 3, guaranteed: 0, signingBonus: 0, role: 'starter' as const, signedYear: 2025, restructured: false, tag: null } };
    const pricey = { ...cheap, contract: { ...cheap.contract, salary: 40_000_000 } };
    expect(playerTradeValue(cheap, 2026, settings)).toBeGreaterThan(playerTradeValue(pricey, 2026, settings));
    const hurt = { ...cheap, injury: { bodyArea: 'lowerBody' as const, severity: 'seasonEnding' as const, weeksRemaining: 12, permanentPenalty: null, occurredYear: 2026, occurredWeek: 3 } };
    expect(playerTradeValue(hurt, 2026, settings)).toBeLessThan(playerTradeValue(cheap, 2026, settings));
  });

  it('untouchables are young stars on fair deals', () => {
    expect(isUntouchable(makePlayer({ attrValue: 92, age: 26, position: 'QB' }), 2026, settings)).toBe(true);
    expect(isUntouchable(makePlayer({ attrValue: 92, age: 33, position: 'QB' }), 2026, settings)).toBe(false);
    expect(isUntouchable(makePlayer({ attrValue: 75, age: 26, position: 'QB' }), 2026, settings)).toBe(false);
  });
});

describe('pick valuation', () => {
  const pick = (round: number, year: number, overall: number | null = null): DraftPick =>
    ({ id: `${year}-r${round}-t_x`, year, round, originalTeamId: 't_x' as DraftPick['originalTeamId'], ownerTeamId: 't_x' as DraftPick['ownerTeamId'], overall });
  const opts = { currentDraftYear: 2026, teamCount: 32 };

  it('follows the chart: #1 is 3000 points and value falls with the slot', () => {
    expect(pickChartValue(1)).toBe(3000);
    expect(pickChartValue(32)).toBeCloseTo(590, 5);
    for (let s = 2; s <= 256; s++) expect(pickChartValue(s)).toBeLessThanOrEqual(pickChartValue(s - 1));
    expect(pickChartValue(18)).toBeLessThan(1000);
    expect(pickChartValue(18)).toBeGreaterThan(850);
  });

  it('a first-round pick beats a fourth, and a future pick is discounted', () => {
    expect(pickValue(pick(1, 2026), null, opts)).toBeGreaterThan(pickValue(pick(4, 2026), null, opts) * 5);
    const now = pickValue(pick(1, 2026), 16, opts);
    const next = pickValue(pick(1, 2027), 16, opts);
    const later = pickValue(pick(1, 2028), 16, opts);
    expect(next).toBeLessThan(now);
    expect(later).toBeLessThan(next);
    expect(next / now).toBeCloseTo(0.8, 2);
    expect(pickValue(pick(2, 2026, 40), null, opts)).toBe(Math.round(pickChartValue(40)));
  });

  it('projects slots from team strength: bad teams pick early', () => {
    const league = buildLeague();
    const sorted = teamsSorted(league).sort((a, b) => a.overall - b.overall);
    const weak = sorted[0]!.picks.find((p) => p.round === 1 && p.year === 2026)!;
    const strong = sorted[sorted.length - 1]!.picks.find((p) => p.round === 1 && p.year === 2026)!;
    expect(projectedPickSlot(league, weak)).toBeLessThan(projectedPickSlot(league, strong));
    expect(assetValue(league, { kind: 'pick', pick: weak }, 2026)).toBeGreaterThan(assetValue(league, { kind: 'pick', pick: strong }, 2026));
    const futureWeak = sorted[0]!.picks.find((p) => p.round === 1 && p.year === 2028)!;
    expect(projectedPickSlot(league, futureWeak)).toBeGreaterThan(projectedPickSlot(league, weak));
    expect(currentDraftYear(league)).toBe(2026);
    expect(currentDraftYear(atPhase(league, 'postDraft'))).toBe(2027);
    const drafting = { ...league, draft: { year: 2026, order: [strong, weak], currentPickIndex: 0, prospects: [], selections: [], reports: {}, scouting: {}, userBoard: [], complete: false } };
    expect(projectedPickSlot(drafting, strong)).toBe(1);
  });
});

describe('packages', () => {
  it('rewards consolidation: one great asset beats two halves', () => {
    expect(packageValue([1000])).toBe(1000);
    expect(packageValue([500, 500])).toBe(950);
    expect(packageValue([])).toBe(0);
    const gap = valueGap([1000], [600, 600]);
    expect(gap.received).toBe(1140);
    expect(gap.gap).toBe(140);
    expect(gap.ratio).toBeCloseTo(1.14, 5);
  });

  it('validates the trade-value data', () => {
    expect(() => validateTradeValueData({ pickChart: [[1, 10], [2, 20]] })).toThrow(/pickChart/);
    expect(() => validateTradeValueData({})).toThrow(/pickChart/);
  });

  it('values rostered players through the league context', () => {
    const league = buildLeague();
    const team = teamsSorted(league)[0]!;
    const qb = bestAt(league, team.id, 'QB');
    expect(assetValue(league, { kind: 'player', playerId: qb.id }, 2026)).toBe(playerTradeValue(qb, 2026, league.settings));
    expect(assetValue(withTeam(league, team), { kind: 'player', playerId: 'p_none' as PlayerId }, 2026)).toBe(0);
  });
});
