import { describe, expect, it } from 'vitest';
import { createRng } from '@/core/rng';
import type { PlayerId } from '@/core/ids';
import { POSITIONS } from '@/players/types';
import type { Player } from '@/players/types';
import { computeOverall } from '@/players/attributes';
import { autoDepthChart, emptyDepthChart, returnScore } from '@/teams/depth-chart';
import { generateRoster } from '@/teams/generator';
import {
  CHEMISTRY_SCALE, NEUTRAL_CHEMISTRY_CONTRIBUTION, REPLACEMENT_OVERALL, SLOT_WEIGHTS, UNIT_MIX,
  positionStrengths, slotValue, teamChemistry, teamRatings, toPlayerMap, unitRating,
} from '@/teams/ratings';
import { COLLEGES, REGIONS, makePlayer, testNames } from '../players/helpers';

const build = (seed: number, quality: number): { players: Player[]; chart: ReturnType<typeof autoDepthChart> } => {
  const players = generateRoster(createRng(seed), { quality, names: testNames, regions: REGIONS, colleges: COLLEGES, year: 2030 });
  return { players, chart: autoDepthChart(players) };
};

describe('teamRatings', () => {
  it('rates strong rosters above weak ones and keeps every unit in 1..99', () => {
    const strong = build(1, 0.95);
    const weak = build(2, 0.05);
    const s = teamRatings(strong.players, strong.chart);
    const w = teamRatings(weak.players, weak.chart);
    for (const r of [s, w]) {
      for (const v of Object.values(r)) {
        expect(Number.isInteger(v)).toBe(true);
        expect(v).toBeGreaterThanOrEqual(1);
        expect(v).toBeLessThanOrEqual(99);
      }
      expect(r.overall).toBe(Math.round(r.offense * UNIT_MIX.offense + r.defense * UNIT_MIX.defense + r.specialTeams * UNIT_MIX.specialTeams));
    }
    expect(s.overall).toBeGreaterThan(w.overall + 12);
    expect(s.offense).toBeGreaterThan(w.offense);
    expect(s.defense).toBeGreaterThan(w.defense);
  });
  it('accepts an id-keyed record as well as an array', () => {
    const { players, chart } = build(3, 0.5);
    const record = Object.fromEntries(players.map((p) => [p.id, p])) as Record<PlayerId, Player>;
    expect(teamRatings(record, chart)).toEqual(teamRatings(players, chart));
    expect(toPlayerMap(record).size).toBe(players.length);
  });
  it('credits empty slots at replacement level', () => {
    const { players } = build(4, 0.5);
    const r = teamRatings(players, emptyDepthChart());
    expect(r).toEqual({ overall: REPLACEMENT_OVERALL, offense: REPLACEMENT_OVERALL, defense: REPLACEMENT_OVERALL, specialTeams: REPLACEMENT_OVERALL });
  });
  it('a missing starter lowers the unit rating', () => {
    const { players, chart } = build(5, 0.7);
    const full = teamRatings(players, chart);
    const noQb = { ...chart, QB: [] };
    const without = teamRatings(players, noQb);
    expect(without.offense).toBeLessThan(full.offense - 5);
    expect(without.defense).toBe(full.defense);
  });
  it('unitRating follows the slot weights exactly', () => {
    const qb = makePlayer({ id: 'p_qb' as PlayerId, position: 'QB', attrValue: 90 });
    const chart = { ...emptyDepthChart(), QB: [qb.id] };
    const weights = SLOT_WEIGHTS.QB;
    const expected = (weights[0]! * qb.overall + weights[1]! * REPLACEMENT_OVERALL) / (weights[0]! + weights[1]!);
    expect(unitRating(['QB'], chart, toPlayerMap([qb]))).toBe(Math.round(expected));
  });
});

describe('slotValue', () => {
  const wr = makePlayer({ position: 'WR', attrValue: 80 });
  it('uses the overall at the player\'s own position and re-weights out of position', () => {
    expect(slotValue(wr, 'WR')).toBe(wr.overall);
    expect(slotValue(wr, 'OT')).toBe(computeOverall(wr.attrs, 'OT'));
  });
  it('uses return aptitude for KR/PR', () => {
    expect(slotValue(wr, 'KR')).toBe(returnScore(wr, 'KR'));
    expect(slotValue(wr, 'PR')).toBe(returnScore(wr, 'PR'));
  });
  it('drops to replacement level when the player cannot dress', () => {
    const hurt = { ...wr, injury: { bodyArea: 'core' as const, severity: 'moderate' as const, weeksRemaining: 5, permanentPenalty: null, occurredYear: 2030, occurredWeek: 1 } };
    expect(slotValue(hurt, 'WR')).toBe(REPLACEMENT_OVERALL);
    const light = { ...hurt, injury: { ...hurt.injury, severity: 'minor' as const, weeksRemaining: 1 } };
    expect(slotValue(light, 'WR')).toBe(wr.overall);
    expect(slotValue({ ...wr, retired: true }, 'WR')).toBe(REPLACEMENT_OVERALL);
  });
});

describe('teamChemistry', () => {
  it('is neutral for an empty roster and near neutral for an ordinary room', () => {
    expect(teamChemistry([])).toBe(50);
    const ordinary = Array.from({ length: 10 }, () => makePlayer({ traits: [], morale: { morale: 70, confidence: 70, coachRelationship: 60 }, experience: 4 }));
    // contribution = 0.8 (morale) + 1.0 (experience) + 0.2 (coach) = 2.0
    expect(teamChemistry(ordinary)).toBe(Math.round(50 + (2.0 - NEUTRAL_CHEMISTRY_CONTRIBUTION) * CHEMISTRY_SCALE));
  });
  it('rises with leaders and team players and falls with hot heads and misery', () => {
    const glue = Array.from({ length: 10 }, () => makePlayer({ traits: ['leader', 'teamPlayer'], morale: { morale: 85, confidence: 80, coachRelationship: 80 }, experience: 8 }));
    const toxic = Array.from({ length: 10 }, () => makePlayer({ traits: ['hotHeaded', 'lazy'], morale: { morale: 20, confidence: 30, coachRelationship: 20 }, experience: 1 }));
    expect(teamChemistry(glue)).toBeGreaterThan(80);
    expect(teamChemistry(toxic)).toBeLessThan(20);
    expect(teamChemistry(toxic)).toBeGreaterThanOrEqual(0);
    expect(teamChemistry(glue)).toBeLessThanOrEqual(100);
  });
});

describe('positionStrengths', () => {
  it('reports a 1..99 strength for every position', () => {
    const { players, chart } = build(6, 0.6);
    const strengths = positionStrengths(players, chart);
    for (const pos of POSITIONS) {
      expect(strengths[pos]).toBeGreaterThanOrEqual(1);
      expect(strengths[pos]).toBeLessThanOrEqual(99);
    }
    expect(strengths.QB).toBeGreaterThan(REPLACEMENT_OVERALL);
  });
});
