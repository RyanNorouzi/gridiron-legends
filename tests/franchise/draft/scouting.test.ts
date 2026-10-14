import { describe, expect, it } from 'vitest';
import { createRng } from '@/core/rng';
import type { TeamId } from '@/core/ids';
import { createNamePool } from '@/players/names';
import { loadColleges, loadRegions } from '@/teams/data';
import type { Team } from '@/teams/types';
import type { DraftState, Prospect } from '@/franchise/types';
import { DRAFT_CONFIG, generateDraftClass } from '@/franchise/prospects';
import {
  RED_FLAG_TRAITS, allocateScouting, buildReport, generateReport, grantScoutingPoints, gradeForValue, interview,
  refreshReports, reportRng, reportSigma, scoutQualityFor, scoutingPointsPerWeek, teamBias,
} from '@/franchise/scouting';
import { makeLeague } from './helpers';

const T1 = 't_alpha' as TeamId;
const T2 = 't_bravo' as TeamId;
const SEED = 4242;
const prospects: Prospect[] = generateDraftClass(createRng(77), 2026, { teamCount: 32, draftRounds: 7 }, {
  colleges: loadColleges(), regions: loadRegions(), names: createNamePool(),
});
const report = (p: Prospect, invested: number, quality: number, opts: { team?: TeamId; interviewed?: boolean; bias?: number } = {}) =>
  generateReport(reportRng(SEED, opts.team ?? T1, p.player.id), p, invested, quality, opts.interviewed ?? false, { bias: opts.bias ?? 0 });
const width = (r: readonly [number, number]): number => r[1] - r[0];
const mean = (xs: readonly number[]): number => xs.reduce((s, v) => s + v, 0) / xs.length;

const draftState = (points = 200): DraftState => refreshReports({
  year: 2026, order: [], currentPickIndex: 0, prospects, selections: [], reports: {}, userBoard: [], complete: false, seed: SEED,
  scouting: { [T1]: { pointsAvailable: points, invested: {}, scoutQuality: 60 }, [T2]: { pointsAvailable: points, invested: {}, scoutQuality: 60 } },
});

describe('scouting departments', () => {
  const league = makeLeague(5);
  const team = Object.values(league.teams)[0] as Team;

  it('earns more points with a better scout and better scouting/analytics facilities', () => {
    const base = scoutingPointsPerWeek(team, league.coaches);
    expect(base).toBeGreaterThan(DRAFT_CONFIG.scouting.basePointsPerWeek);
    const upgraded = { ...team, facilities: { ...team.facilities, scouting: 5, analytics: 5 } };
    const downgraded = { ...team, facilities: { ...team.facilities, scouting: 1, analytics: 1 } };
    expect(scoutingPointsPerWeek(upgraded, league.coaches)).toBeGreaterThan(scoutingPointsPerWeek(downgraded, league.coaches));
    const scout = Object.values(league.coaches).find((c) => c.role === 'Scout' && team.staffIds.includes(c.id));
    expect(scout).toBeDefined();
    const better = { ...league.coaches, [scout!.id]: { ...scout!, ratings: { ...scout!.ratings, scouting: 99 } } };
    const worse = { ...league.coaches, [scout!.id]: { ...scout!, ratings: { ...scout!.ratings, scouting: 20 } } };
    expect(scoutingPointsPerWeek(team, better)).toBeGreaterThan(scoutingPointsPerWeek(team, worse));
    expect(scoutQualityFor(team, better)).toBeGreaterThan(scoutQualityFor(team, worse));
  });

  it('falls back to a weak baseline without any staff', () => {
    const bare = { ...team, id: 't_none' as TeamId, staffIds: [] };
    const s = DRAFT_CONFIG.scouting;
    expect(scoutingPointsPerWeek(bare, [])).toBe(Math.round(s.basePointsPerWeek + s.fallbackScoutRating / s.scoutRatingDivisor
      + bare.facilities.scouting * s.facilityScoutingPoints + bare.facilities.analytics * s.facilityAnalyticsPoints));
    expect(scoutQualityFor(bare, [])).toBeGreaterThanOrEqual(1);
  });
});

describe('scouting reports', () => {
  it('uncertainty shrinks with investment and with scout quality, never to zero', () => {
    expect(reportSigma(0, 60)).toBeGreaterThan(reportSigma(30, 60));
    expect(reportSigma(30, 60)).toBeGreaterThan(reportSigma(100, 60));
    expect(reportSigma(30, 20)).toBeGreaterThan(reportSigma(30, 95));
    expect(reportSigma(1000, 99)).toBeGreaterThan(0);
    const w = (inv: number, q: number): number => mean(prospects.map((p) => width(report(p, inv, q).overallRange)));
    const wp = (inv: number, q: number): number => mean(prospects.map((p) => width(report(p, inv, q).potentialRange)));
    expect(w(0, 60)).toBeGreaterThan(w(30, 60));
    expect(w(30, 60)).toBeGreaterThan(w(100, 60));
    expect(wp(0, 60)).toBeGreaterThan(wp(100, 60));
    expect(w(0, 20)).toBeGreaterThan(w(0, 95));
    expect(w(30, 20)).toBeGreaterThan(w(30, 95));
    for (const p of prospects) {
      const r = report(p, 100, 99);
      expect(width(r.overallRange)).toBeGreaterThanOrEqual(2);
      expect(width(r.potentialRange)).toBeGreaterThanOrEqual(2);
      expect(r.potentialRange[0]).toBeGreaterThanOrEqual(r.overallRange[0]);
    }
  });

  it('confidence rises with investment', () => {
    const p = prospects[0]!;
    expect(report(p, 100, 60).confidence).toBeGreaterThan(report(p, 10, 60).confidence);
    expect(report(p, 0, 1).confidence).toBeGreaterThanOrEqual(0);
    expect(report(p, 100, 99).confidence).toBeLessThanOrEqual(1);
  });

  it('contains the truth at least 85% of the time, but not always (imperfect information)', () => {
    const rng = createRng(9);
    let inOverall = 0;
    let inPotential = 0;
    let n = 0;
    for (let t = 0; t < 8; t++) {
      const team = `t_scout${t}` as TeamId;
      for (const p of prospects) {
        const bias = teamBias(SEED, team, p.player.position);
        const r = report(p, rng.int(0, 100), rng.int(20, 95), { team, bias });
        n += 1;
        if (p.player.overall >= r.overallRange[0] && p.player.overall <= r.overallRange[1]) inOverall += 1;
        if (p.player.potential >= r.potentialRange[0] && p.player.potential <= r.potentialRange[1]) inPotential += 1;
      }
    }
    expect(inOverall / n).toBeGreaterThanOrEqual(0.85);
    expect(inOverall / n).toBeLessThan(1);
    expect(inPotential / n).toBeGreaterThanOrEqual(0.85);
    expect(inPotential / n).toBeLessThan(1);
  });

  it('converges toward the truth as investment grows (same underlying noise)', () => {
    const err = (inv: number): number => mean(prospects.map((p) => {
      const r = report(p, inv, 60);
      return Math.abs((r.overallRange[0] + r.overallRange[1]) / 2 - p.player.overall);
    }));
    expect(err(100)).toBeLessThan(err(0) * 0.6);
    const speedErr = (inv: number): number => mean(prospects.map((p) => Math.abs((report(p, inv, 60).attributeEstimates.speed ?? 0) - p.player.attrs.speed)));
    expect(speedErr(100)).toBeLessThan(speedErr(0));
  });

  it('carries a small persistent per-team bias that investment does not remove', () => {
    expect(teamBias(SEED, T1, 'CB')).toBe(teamBias(SEED, T1, 'CB'));
    expect(teamBias(SEED, T1, 'CB')).toBe(teamBias(SEED, T1, 'SS'));
    const biases = Array.from({ length: 20 }, (_, i) => teamBias(SEED, `t_${i}` as TeamId, 'QB'));
    expect(new Set(biases.map((b) => b.toFixed(6))).size).toBe(20);
    expect(Math.max(...biases.map(Math.abs))).toBeLessThan(DRAFT_CONFIG.scouting.biasSd * 4);
    const offset = mean(prospects.map((p) => {
      const r = report(p, 100, 95, { bias: 3 });
      return (r.overallRange[0] + r.overallRange[1]) / 2 - p.player.overall;
    }));
    expect(offset).toBeGreaterThan(2);
    expect(offset).toBeLessThan(4);
  });

  it('estimates the measurable and position-relevant attributes', () => {
    const qb = prospects.find((p) => p.player.position === 'QB')!;
    const r = report(qb, 40, 60);
    for (const key of ['speed', 'acceleration', 'strength', 'agility', 'jumping', 'throwPower', 'throwAccuracy'] as const) {
      expect(r.attributeEstimates[key]).toBeGreaterThanOrEqual(1);
    }
    expect(r.attributeEstimates.kickPower).toBeUndefined();
  });

  it('reveals a dev-trait read only after heavy investment, and it is sometimes wrong', () => {
    const order = ['bust', 'normal', 'quick', 'star', 'superstar'];
    let right = 0;
    for (const p of prospects) {
      expect(report(p, 10, 60).devTraitEstimate).toBeNull();
      const est = report(p, 100, 60).devTraitEstimate;
      expect(est).not.toBeNull();
      if (est === p.player.devTrait) right += 1;
      else expect(Math.abs(order.indexOf(est!) - order.indexOf(p.player.devTrait))).toBe(1);
    }
    expect(right / prospects.length).toBeGreaterThan(0.6);
    expect(right).toBeLessThan(prospects.length);
  });

  it('reveals personality traits (red flags first) only through interviews', () => {
    const withTraits = prospects.filter((p) => p.player.traits.length > 0);
    const flagged = withTraits.filter((p) => p.player.traits.some((t) => RED_FLAG_TRAITS.includes(t)));
    expect(flagged.length).toBeGreaterThan(10);
    let flagCaught = 0;
    for (const p of prospects) {
      const plain = report(p, 50, 60);
      expect(plain.traitsRevealed).toEqual([]);
      expect(plain.redFlags).toEqual([]);
      expect(plain.interviewed).toBe(false);
      const met = report(p, 50, 60, { interviewed: true });
      expect(met.interviewed).toBe(true);
      if (p.player.traits.length === 0) {
        expect(met.traitsRevealed).toEqual([]);
        expect(met.notes.join(' ')).toMatch(/no character concerns/);
        continue;
      }
      expect(met.traitsRevealed.length).toBeGreaterThanOrEqual(1);
      expect(met.traitsRevealed.length).toBeLessThanOrEqual(2);
      for (const t of met.traitsRevealed) expect(p.player.traits).toContain(t);
      expect(met.redFlags).toEqual(met.traitsRevealed.filter((t) => RED_FLAG_TRAITS.includes(t)));
      if (flagged.includes(p) && met.redFlags.length > 0) flagCaught += 1;
    }
    expect(flagCaught / flagged.length).toBeGreaterThan(0.7);
  });

  it('grades from the scouted value and is deterministic', () => {
    expect(gradeForValue(90)).toBe('A+');
    expect(gradeForValue(58)).toBe('C');
    expect(gradeForValue(10)).toBe('F');
    const p = prospects[3]!;
    expect(report(p, 20, 70)).toEqual(report(p, 20, 70));
    const r = report(p, 20, 70);
    expect(r.grade).toBe(gradeForValue(0.45 * (r.overallRange[0] + r.overallRange[1]) / 2 + 0.55 * (r.potentialRange[0] + r.potentialRange[1]) / 2));
    expect(r.notes[0]).toMatch(/Preliminary/);
  });
});

describe('scouting ledger', () => {
  const target = prospects[5]!.player.id;

  it('initialises film-only reports for every team', () => {
    const d = draftState();
    expect(Object.keys(d.reports[T1]!)).toHaveLength(prospects.length);
    expect(d.reports[T1]![target]!.notes[0]).toMatch(/Film only/);
    expect(d.reports[T1]![target]).not.toEqual(d.reports[T2]![target]);
  });

  it('allocateScouting charges points, caps per prospect and tightens only that report', () => {
    const d0 = draftState(200);
    const d1 = allocateScouting(d0, T1, target, 40);
    expect(d1.scouting[T1]!.pointsAvailable).toBe(160);
    expect(d1.scouting[T1]!.invested[target]).toBe(40);
    expect(d1.reports[T1]![target]!.confidence).toBeGreaterThan(d0.reports[T1]![target]!.confidence);
    expect(d1.reports[T2]).toBe(d0.reports[T2]);
    const d2 = allocateScouting(d1, T1, target, 100);
    expect(d2.scouting[T1]!.invested[target]).toBe(DRAFT_CONFIG.scouting.maxInvestedPerProspect);
    expect(d2.scouting[T1]!.pointsAvailable).toBe(100);
    expect(d0.scouting[T1]!.pointsAvailable).toBe(200);
  });

  it('refuses to overspend or to scout unknown prospects', () => {
    const d = draftState(10);
    expect(() => allocateScouting(d, T1, target, 11)).toThrow(/costs 11 points/);
    expect(() => allocateScouting(d, T1, 'p_missing' as never, 5)).toThrow(/not in the draft pool/);
    expect(() => allocateScouting(d, T1, target, 0)).toThrow(/positive/);
  });

  it('interviews cost points, happen once and survive refreshes', () => {
    const d0 = draftState(100);
    const d1 = interview(d0, T1, target);
    expect(d1.scouting[T1]!.pointsAvailable).toBe(100 - DRAFT_CONFIG.scouting.interviewCost);
    expect(d1.reports[T1]![target]!.interviewed).toBe(true);
    expect(() => interview(d1, T1, target)).toThrow(/already interviewed/);
    const d2 = refreshReports(d1);
    expect(d2.reports[T1]![target]!.interviewed).toBe(true);
    expect(d2.reports[T1]![target]).toEqual(buildReport(d1, T1, prospects[5]!));
    expect(() => interview(draftState(5), T1, target)).toThrow(/costs/);
  });

  it('grantScoutingPoints banks points and re-evaluates when the department changes', () => {
    const d0 = draftState(0);
    const d1 = grantScoutingPoints(d0, T1, 30, 60);
    expect(d1.scouting[T1]!.pointsAvailable).toBe(30);
    expect(d1.reports[T1]).toBe(d0.reports[T1]);
    const d2 = grantScoutingPoints(d1, T1, 30, 95);
    expect(d2.scouting[T1]!.pointsAvailable).toBe(60);
    expect(d2.scouting[T1]!.scoutQuality).toBe(95);
    expect(width(d2.reports[T1]![target]!.overallRange)).toBeLessThanOrEqual(width(d1.reports[T1]![target]!.overallRange));
    expect(() => grantScoutingPoints(d0, T1, -1, 60)).toThrow(/>= 0/);
  });
});
