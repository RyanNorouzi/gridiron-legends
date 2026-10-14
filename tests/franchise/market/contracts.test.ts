import { describe, expect, it } from 'vitest';
import type { PlayerId, TeamId } from '@/core/ids';
import type { Contract } from '@/players/types';
import {
  capHit, capSpace, capStatus, capYearFor, contractApy, contractEndYear, createContract, deadMoney, expiring, extend, franchiseTag,
  isPostJuneCutoff, leagueCapYear, maxRestructureAmount, minimumSalaryFor, pickInRoundFromOverall, positionAverageSalary,
  projectedCapSpace, rebaseContract, release, releaseDeadMoneySplit, restructure, restructureSavings, rookieContract, rookieScaleApy, syncYearsRemaining,
  tagPositionAverage, teamCapHit, transitionTag, undraftedContract, validateRookieScale, yearsRemainingAt, ROOKIE_SCALE,
} from '@/franchise/contracts';
import { makePlayer } from '../../players/helpers';
import { CAP, atPhase, buildLeague, makeSettings, rosterOf, teamsSorted } from './helpers';

const deal = (over: Partial<Contract> = {}): Contract => ({
  salary: 10_000_000, years: 4, yearsRemaining: 4, guaranteed: 15_000_000, signingBonus: 8_000_000,
  role: 'starter', signedYear: 2026, restructured: false, tag: null, ...over,
});

describe('contract math (canonical derivations)', () => {
  it('capHit is salary + prorated bonus inside the contract years only', () => {
    const c = deal();
    expect(capHit(c, 2025)).toBe(0);
    expect(capHit(c, 2026)).toBe(12_000_000);
    expect(capHit(c, 2029)).toBe(12_000_000);
    expect(capHit(c, 2030)).toBe(0);
    expect(capHit(null, 2026)).toBe(0);
    expect(contractEndYear(c)).toBe(2029);
    expect(yearsRemainingAt(c, 2027)).toBe(3);
    expect(yearsRemainingAt(c, 2031)).toBe(0);
    expect(contractApy(c)).toBe(12_000_000);
  });

  it('deadMoney = unamortised bonus + unpaid guarantees', () => {
    const c = deal();
    expect(deadMoney(c, 2026)).toBe(8_000_000 + 15_000_000);
    expect(deadMoney(c, 2027)).toBe(6_000_000 + 5_000_000);
    expect(deadMoney(c, 2028)).toBe(4_000_000);
    expect(deadMoney(c, 2029)).toBe(2_000_000);
    expect(deadMoney(c, 2030)).toBe(0);
  });

  it('release accelerates dead money pre-cutoff and splits it June-1 style after it', () => {
    const c = deal();
    expect(releaseDeadMoneySplit(c, 2027, false)).toEqual({ thisYear: 11_000_000, nextYear: 0 });
    expect(releaseDeadMoneySplit(c, 2027, true)).toEqual({ thisYear: 7_000_000, nextYear: 4_000_000 });
    expect(releaseDeadMoneySplit(c, 2029, true)).toEqual({ thisYear: 2_000_000, nextYear: 0 });
    const league = buildLeague();
    const team = teamsSorted(league)[0]!;
    const player = { ...rosterOf(league, team.id)[0]!, contract: c };
    const r = release(team, player, 2027, { postDeadline: true });
    expect(r.player.contract).toBeNull();
    expect(r.team.finances.deadMoney[2027]).toBe((team.finances.deadMoney[2027] ?? 0) + 7_000_000);
    expect(r.team.finances.deadMoney[2028]).toBe((team.finances.deadMoney[2028] ?? 0) + 4_000_000);
    expect(r.capSavings).toBe(12_000_000 - 7_000_000);
    expect(team.finances.deadMoney[2027]).toBeUndefined();
    expect(() => release(team, { ...player, teamId: 't_other' as TeamId }, 2027)).toThrow(/not on team/);
  });

  it('restructure converts salary to prorated bonus and saves amount x (1 - 1/years) per season', () => {
    const c = deal();
    const r = restructure(c, 4_000_000);
    expect(r.salary).toBe(6_000_000);
    expect(r.signingBonus).toBe(12_000_000);
    expect(r.restructured).toBe(true);
    expect(capHit(r, 2026)).toBe(9_000_000);
    expect(restructureSavings(c, 4_000_000)).toBe(3_000_000);
    expect(capHit(c, 2026) - capHit(r, 2026)).toBe(3_000_000);
    expect(deadMoney(r, 2027)).toBeGreaterThan(deadMoney(c, 2027) - 5_000_000);
    expect(maxRestructureAmount(c, 1_000_000)).toBe(9_000_000);
    expect(() => restructure(c, 9_500_000, { minimumSalary: 1_000_000 })).toThrow(/exceeds/);
    expect(() => restructure(deal({ years: 1, yearsRemaining: 1 }), 1_000_000)).toThrow(/exceeds/);
    expect(() => restructure(c, 0)).toThrow(/positive/);
  });

  it('a mid-deal restructure prorates over the seasons left, so no money escapes the cap', () => {
    const c = deal({ years: 5, signedYear: 2024, salary: 10_000_000, signingBonus: 5_000_000, guaranteed: 0 });
    const rebased = rebaseContract(c, 2026);
    expect(rebased).toMatchObject({ signedYear: 2026, years: 3, signingBonus: 3_000_000 });
    for (const y of [2026, 2027, 2028, 2029]) {
      expect(capHit(rebased, y)).toBe(capHit(c, y));
      expect(deadMoney(rebased, y)).toBe(deadMoney(c, y));
    }
    expect(rebaseContract(c, 2024)).toBe(c);
    const r = restructure(c, 6_000_000, { year: 2026 });
    const charged = (k: Contract): number => [2026, 2027, 2028].reduce((s, y) => s + capHit(k, y), 0);
    // salary drops by X in each season left (canonical formula); the whole converted X is charged as bonus
    expect(charged(r)).toBe(charged(c) - 6_000_000 * 3 + 6_000_000);
    // without the cap year the new bonus would be spread over seasons already played (only 3/5 of X charged)
    expect(charged(restructure(c, 6_000_000))).toBeLessThan(charged(r));
    expect(restructureSavings(c, 6_000_000, 2026)).toBe(4_000_000);
    expect(capHit(c, 2026) - capHit(r, 2026)).toBe(4_000_000);
    expect(deadMoney(r, 2026)).toBe(3_000_000 + 6_000_000);
    const twoLeft = deal({ years: 4, signedYear: 2024 });
    expect(maxRestructureAmount(twoLeft, 0, 2027)).toBe(0);
    expect(() => restructure(twoLeft, 1_000_000, { year: 2027 })).toThrow(/exceeds/);
  });

  it('extend replaces the deal and rolls the unamortised bonus into the new proration', () => {
    const old = deal({ salary: 5_000_000, signingBonus: 4_000_000, guaranteed: 0, signedYear: 2024 });
    const player = makePlayer({ id: 'p_ext' as PlayerId, contract: old, morale: { morale: 50, confidence: 50, coachRelationship: 50 } });
    const ext = extend(player, { salary: 12_000_000, years: 5, guaranteed: 20_000_000, signingBonus: 8_000_000, role: 'starter' }, 2026);
    const c = ext.contract!;
    expect(c.signedYear).toBe(2026);
    expect(c.years).toBe(5);
    expect(c.signingBonus).toBe(8_000_000 + 2_000_000);
    expect(capHit(c, 2026)).toBe(14_000_000);
    expect(capHit(c, 2030)).toBe(14_000_000);
    expect(ext.morale.morale).toBeGreaterThan(player.morale.morale);
    expect(player.contract).toBe(old);
  });

  it('createContract validates and caps guarantees at the total salary', () => {
    const c = createContract({ salary: 1_000_000, years: 2, guaranteed: 9_000_000, signingBonus: 0, role: 'backup', year: 2026 });
    expect(c.guaranteed).toBe(2_000_000);
    expect(c.yearsRemaining).toBe(2);
    expect(() => createContract({ salary: 1, years: 0, guaranteed: 0, signingBonus: 0, role: 'backup', year: 2026 })).toThrow(/years/);
    expect(() => createContract({ salary: -1, years: 1, guaranteed: 0, signingBonus: 0, role: 'backup', year: 2026 })).toThrow(/salary/);
    expect(syncYearsRemaining(deal(), 2028).yearsRemaining).toBe(2);
  });
});

describe('team cap', () => {
  it('capSpace = cap + carryover - hits - dead money for that year', () => {
    const league = buildLeague();
    const team0 = teamsSorted(league)[3]!;
    const team = { ...team0, finances: { ...team0.finances, capCarryover: 5_000_000, deadMoney: { 2026: 7_000_000, 2027: 1_000_000 } } };
    const hits = team.rosterIds.reduce((s, id) => s + capHit(league.players[id]!.contract, 2026), 0);
    expect(teamCapHit(team, league.players, 2026)).toBe(hits);
    expect(capSpace(team, league.players, league.settings, 2026)).toBe(CAP + 5_000_000 - hits - 7_000_000);
    const proj = projectedCapSpace(team, league.players, league.settings, 2026, 3);
    expect(proj.map((p) => p.year)).toEqual([2026, 2027, 2028]);
    expect(proj[0]!.space).toBe(capSpace(team, league.players, league.settings, 2026));
    expect(proj[1]!.cap).toBe(Math.round(CAP * 1.05));
    expect(proj[1]!.deadMoney).toBe(1_000_000);
    expect(proj[1]!.committed).toBeLessThan(proj[0]!.committed);
    const over = { ...team, finances: { ...team.finances, deadMoney: { 2026: CAP } } };
    const status = capStatus(over, league.players, league.settings, 2026);
    expect(status.compliant).toBe(false);
    expect(status.overBy).toBeGreaterThan(0);
    expect(capStatus(team, league.players, league.settings, 2026).compliant).toBe(true);
  });

  it('cap year moves to next season in the offseason phases; June-1 cutoff after the draft', () => {
    expect(capYearFor(2026, 'regularSeason')).toBe(2026);
    expect(capYearFor(2026, 'awards')).toBe(2026);
    expect(capYearFor(2026, 'resigning')).toBe(2027);
    expect(capYearFor(2026, 'trainingCamp')).toBe(2027);
    expect(leagueCapYear(atPhase(buildLeague(), 'freeAgency'))).toBe(2027);
    expect(isPostJuneCutoff('freeAgency')).toBe(false);
    expect(isPostJuneCutoff('draft')).toBe(false);
    expect(isPostJuneCutoff('postDraft')).toBe(true);
    expect(isPostJuneCutoff('regularSeason')).toBe(true);
  });

  it('expiring lists deals whose last season is the given year or earlier', () => {
    const a = makePlayer({ id: 'p_a' as PlayerId, contract: deal({ signedYear: 2023 }) });
    const b = makePlayer({ id: 'p_b' as PlayerId, contract: deal({ signedYear: 2025 }) });
    const c = makePlayer({ id: 'p_c' as PlayerId, contract: null });
    expect(expiring([a, b, c], 2026).map((p) => p.id)).toEqual(['p_a']);
    expect(expiring([a, b, c], 2028).map((p) => p.id)).toEqual(['p_a', 'p_b']);
  });
});

describe('rookie scale, minimums and tags', () => {
  it('rookie APY is non-increasing across the whole draft and scales with the cap', () => {
    let prev = Infinity;
    for (let overall = 1; overall <= 7 * 32; overall++) {
      const { round, pickInRound } = pickInRoundFromOverall(overall, 32);
      const apy = rookieScaleApy(round, pickInRound, CAP);
      expect(apy).toBeLessThanOrEqual(prev);
      prev = apy;
    }
    expect(rookieScaleApy(1, 1, CAP)).toBeGreaterThan(rookieScaleApy(1, 32, CAP) * 2);
    expect(rookieScaleApy(1, 1, CAP * 2)).toBeCloseTo(rookieScaleApy(1, 1, CAP) * 2, -5);
    expect(pickInRoundFromOverall(33, 32)).toEqual({ round: 2, pickInRound: 1 });
  });

  it('rookie contracts are slotted, fully guaranteed in round 1 and cost their APY', () => {
    const settings = makeSettings();
    const top = rookieContract(1, 1, 2027, settings);
    expect(top.years).toBe(ROOKIE_SCALE.rounds[0]!.years);
    expect(top.signedYear).toBe(2027);
    expect(top.role).toBe('developmental');
    expect(Math.abs(capHit(top, 2027) - rookieScaleApy(1, 1, CAP))).toBeLessThanOrEqual(10_000);
    expect(top.guaranteed).toBe(top.salary * top.years);
    const late = rookieContract(7, 32, 2027, settings);
    expect(capHit(late, 2027)).toBeGreaterThanOrEqual(minimumSalaryFor(0, settings));
    expect(late.guaranteed).toBeLessThan(late.salary * late.years);
    const udfa = undraftedContract(2027, settings);
    expect(udfa.salary).toBe(minimumSalaryFor(0, settings));
    expect(udfa.guaranteed).toBe(0);
  });

  it('validateRookieScale rejects rounds that pay more than the previous round', () => {
    const bad = {
      referenceCap: 1, picksPerRound: 32, undraftedYears: 3,
      rounds: [
        { round: 1, years: 4, topSalary: 10, bottomSalary: 5, guaranteedFraction: 1, bonusFraction: 0.5, curve: 1 },
        { round: 2, years: 4, topSalary: 6, bottomSalary: 4, guaranteedFraction: 1, bonusFraction: 0.5, curve: 1 },
      ],
    };
    expect(() => validateRookieScale(bad)).toThrow(/round 2/);
    expect(() => validateRookieScale({ ...bad, rounds: [] })).toThrow(/rounds/);
  });

  it('minimum salary rises with experience', () => {
    const s = makeSettings();
    expect(minimumSalaryFor(0, s)).toBe(800_000);
    expect(minimumSalaryFor(1, s)).toBeGreaterThan(minimumSalaryFor(0, s));
    expect(minimumSalaryFor(10, s)).toBeGreaterThan(minimumSalaryFor(4, s));
  });

  it('franchise tag pays the top-5 average (or a raise), transition the top-10 average', () => {
    const league = buildLeague();
    const qbs = Object.values(league.players).filter((p) => p.position === 'QB' && p.contract);
    const apys = qbs.map((p) => contractApy(p.contract!)).sort((a, b) => b - a);
    const top5 = Math.round(apys.slice(0, 5).reduce((s, v) => s + v, 0) / 5);
    expect(positionAverageSalary(league.players, 'QB', 5)).toBe(top5);
    expect(tagPositionAverage(league, 'QB', 'franchise')).toBe(top5);
    const cheapQb = qbs.sort((a, b) => contractApy(a.contract!) - contractApy(b.contract!))[0]!;
    const tag = franchiseTag(cheapQb, top5, 2027);
    expect(tag.years).toBe(1);
    expect(tag.tag).toBe('franchise');
    expect(tag.guaranteed).toBe(tag.salary);
    expect(Math.abs(tag.salary - top5)).toBeLessThanOrEqual(10_000);
    const top10 = tagPositionAverage(league, 'QB', 'transition');
    expect(top10).toBeLessThan(top5);
    expect(transitionTag(cheapQb, top10, 2027).tag).toBe('transition');
    const richest = qbs.sort((a, b) => contractApy(b.contract!) - contractApy(a.contract!))[0]!;
    expect(franchiseTag(richest, top5, 2027).salary).toBeGreaterThanOrEqual(Math.round(contractApy(richest.contract!) * 1.2) - 10_000);
  });
});
