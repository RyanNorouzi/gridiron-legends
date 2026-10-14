import { describe, expect, it } from 'vitest';
import type { PlayerId, TeamId } from '@/core/ids';
import { fatigueAttrMultiplier } from '@/players/fatigue';
import { injuryProbability } from '@/players/injuries';
import { buildGameSetup } from '@/franchise/game-setup';
import { gamesThisWeek } from '@/franchise/week';
import { advanceToPhase, advanceWeek } from '@/franchise';
import { WEAR_TUNING, applyWeekWear, nextWear, wearRetain, weekSnaps } from '@/franchise/wear';
import type { League } from '@/franchise/types';
import { makeLeague } from './helpers';

const STARTER_SNAPS = 65;

/** Wear after `weeks` full-workload weeks from rested. */
const steady = (weeks: number, snaps = STARTER_SNAPS, stamina = 70): number => {
  let w = 0;
  for (let i = 0; i < weeks; i++) w = nextWear(w, snaps, stamina);
  return w;
};

describe('season wear: the model', () => {
  it('builds up with the workload, settles, and recovers in byes and light weeks', () => {
    const w1 = steady(1);
    const w8 = steady(8);
    expect(w1).toBeGreaterThan(0.05);
    expect(w8).toBeGreaterThan(w1);
    expect(w8).toBeGreaterThan(0.14);
    expect(w8).toBeLessThan(0.24);
    expect(Math.abs(steady(12) - w8)).toBeLessThan(0.01);
    // Bye: most of it is shed; a light week sheds more than a full one.
    expect(nextWear(w8, 0, 70)).toBeCloseTo(w8 * wearRetain(0), 9);
    expect(nextWear(w8, 0, 70)).toBeLessThan(w8 * 0.3);
    expect(nextWear(w8, 12, 70)).toBeLessThan(nextWear(w8, STARTER_SNAPS, 70));
    // Backups barely wear; low stamina wears faster; conditioning helps a little; capped.
    expect(steady(8, 10)).toBeLessThan(0.05);
    expect(steady(8, STARTER_SNAPS, 30)).toBeGreaterThan(steady(8, STARTER_SNAPS, 95));
    expect(nextWear(0.2, STARTER_SNAPS, 70, 99)).toBeLessThan(nextWear(0.2, STARTER_SNAPS, 70, 1));
    expect(nextWear(0.3, 200, 1)).toBe(WEAR_TUNING.max);
  });

  it('keeps the effect mild: ~2% slower at kickoff and ~5% more injury risk for a settled starter', () => {
    const w = steady(10);
    const slow = 1 - fatigueAttrMultiplier(w);
    expect(slow).toBeGreaterThan(0.01);
    expect(slow).toBeLessThan(0.04);
    const player = { age: 27, attrs: { injuryResistance: 70 } as never, traits: [], injuryHistory: [], injury: null };
    const ctx = { contact: 0.6, playCount: 20, injuriesEnabled: true, weatherSlick: 0 };
    const ratio = injuryProbability(player, { ...ctx, fatigue: 0.3 + w }) / injuryProbability(player, { ...ctx, fatigue: 0.3 });
    expect(ratio).toBeGreaterThan(1.03);
    expect(ratio).toBeLessThan(1.25);
  });
});

describe('season wear: in the league', () => {
  let inRegular: League;
  const regular = (): League => (inRegular ??= advanceToPhase(makeLeague(9), 'regularSeason').league);

  it('carries snaps into next week\'s kickoff fatigue, starters more than backups, byes recover', () => {
    let league = regular();
    for (let i = 0; i < 4; i++) league = advanceWeek(league);
    const wear = league.fatigue ?? {};
    const last = league.season.schedule.filter((g) => g.result && g.week === league.season.week - 1 && !g.isPreseason);
    const snaps = weekSnaps(last.map((g) => g.result!.stats));
    const heavy = [...snaps.entries()].filter(([, n]) => n >= 55).map(([id]) => wear[id] ?? 0);
    const light = [...snaps.entries()].filter(([, n]) => n > 0 && n <= 10).map(([id]) => wear[id] ?? 0);
    const avg = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
    expect(heavy.length).toBeGreaterThan(50);
    expect(avg(heavy)).toBeGreaterThan(0.08);
    expect(avg(heavy)).toBeGreaterThan(avg(light) * 2);
    // Next week's game setups start the worn players tired.
    const g = gamesThisWeek(league)[0]!;
    const setup = buildGameSetup(league, g);
    const dressedWorn = Object.keys(setup.home.players).filter((id) => (wear[id as PlayerId] ?? 0) > 0);
    expect(dressedWorn.length).toBeGreaterThan(0);
    for (const id of dressedWorn) expect(setup.fatigue?.[id as PlayerId]).toBeCloseTo(wear[id as PlayerId]!, 9);
    // A bye (no snaps) sheds most of the wear.
    const worn = Object.keys(wear)[0] as PlayerId;
    const rested = applyWeekWear(league, league.players, wear, new Map());
    expect(rested[worn] ?? 0).toBeLessThan(wear[worn]! * 0.35);
    const byeTeamId = (Object.keys(league.teams) as TeamId[]).find((t) => !gamesThisWeek(league).some((x) => x.home === t || x.away === t));
    if (byeTeamId) {
      const after = advanceWeek(league);
      for (const id of league.teams[byeTeamId]!.rosterIds) {
        const before = wear[id] ?? 0;
        if (before > 0.02) expect(after.fatigue?.[id] ?? 0).toBeLessThan(before * 0.35);
      }
    }
  });
});
