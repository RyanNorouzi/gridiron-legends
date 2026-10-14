/**
 * Difficulty as the user feels it: the CPU team at difficulty D (its decision profile plus, at All-Pro / Legend, its
 * clearly labelled performance edge) against a "user team" = the AI at the neutral 'pro' profile, a stand-in for a
 * solid human player. Whole games are played live (tick engine, real AI coaches on both sides) through the production
 * path of a simulated user game (GameSetup.humanTeam, both controllers AI), in mirrored pairs so both clubs play both
 * roles. Both directions come out of each game.
 *
 * Owner requests this file encodes: (2026-10-02) "extremely buff the defense when you're playing as it" — on every
 * scrimmage down the user DEFENDS, his unit plays under game/difficulty-sides.ts userDefenseProfile (Legend-like
 * decisions and a big performance edge) — and "more pressure on the QB on both sides" (systems/blocking.ts);
 * (2026-10-08) "make the offense of the opposing team even stronger" — the CPU offense plays with CPU_OFFENSE_EDGE on
 * top of its difficulty's edge on those same downs. 12-game check:
 *  - CPU offense vs the boosted user defense: Rookie 3.06 yd/play / 17% of drives scored; Pro 5.20 / 27%;
 *    All-Pro 5.89 / 43%; Legend 6.23 / 56% (50% on third down). Each level is harder than the one below.
 *  - user offense vs CPU defense (no boost on offense, more pressure): Rookie 8.02 yd/play; Pro 6.29; All-Pro 4.00;
 *    Legend 2.97 with sacks on 15% of dropbacks.
 * Pro is therefore no longer an even game for the user; AI vs AI (balance tests, league sims) never gets the boost —
 * see tests/game/difficulty-sides.test.ts and tests/integration/balance.test.ts.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { DifficultyId } from '@/game/types';
import { createUserGameEnv, formatRates, measureUserGames, ratesOf, type OffenseRates } from './user-games';

const env = createUserGameEnv(2026);
/** Games per level (6 mirrored pairs). */
const GAMES = 12;
const LEVELS: readonly DifficultyId[] = ['rookie', 'pro', 'allPro', 'legend'];

const results: Partial<Record<DifficultyId, { cpu: OffenseRates; user: OffenseRates }>> = {};
const at = (d: DifficultyId): { cpu: OffenseRates; user: OffenseRates } => {
  const r = results[d];
  if (!r) throw new Error(`difficulty-user: ${d} was not measured`);
  return r;
};

beforeAll(async () => {
  for (const d of LEVELS) {
    const m = await measureUserGames(env, d, GAMES);
    results[d] = { cpu: ratesOf(m.cpuOffense), user: ratesOf(m.userOffense) };
    console.log(`${d} (${(m.ms / 1000).toFixed(0)} s)\n  ${formatRates('CPU offense vs user defense', ratesOf(m.cpuOffense))}\n  ${formatRates('user offense vs CPU defense', ratesOf(m.userOffense))}`);
  }
}, 900_000);

describe('difficulty vs a solid user: CPU offense against the boosted user defense', () => {
  it('Rookie struggles against the boosted defense; Pro moves the ball (about 4-6.5 yd/play)', () => {
    const rookie = at('rookie').cpu;
    const pro = at('pro').cpu;
    expect(rookie.drives).toBeGreaterThanOrEqual(80);
    expect(rookie.ypp).toBeLessThanOrEqual(4);
    expect(pro.ypp).toBeGreaterThanOrEqual(4);
    expect(pro.ypp).toBeLessThanOrEqual(6.5);
    expect(pro.scoreRate).toBeLessThanOrEqual(0.4);
  });

  it('All-Pro moves it steadily (about 4.5-7 yd/play, a third or more of its drives score)', () => {
    const r = at('allPro').cpu;
    expect(r.ypp).toBeGreaterThanOrEqual(4.5);
    expect(r.ypp).toBeLessThanOrEqual(7);
    expect(r.scoreRate).toBeGreaterThanOrEqual(0.25);
    expect(r.scoreRate).toBeLessThanOrEqual(0.6);
  });

  it('Legend scores on about half its drives even against the boosted defense', () => {
    const r = at('legend').cpu;
    expect(r.ypp).toBeGreaterThanOrEqual(5);
    expect(r.ypp).toBeLessThanOrEqual(8);
    expect(r.scoreRate).toBeGreaterThanOrEqual(0.4);
  });

  it('every step up is harder than the one below', () => {
    const ypp = LEVELS.map((d) => at(d).cpu.ypp);
    const score = LEVELS.map((d) => at(d).cpu.scoreRate);
    for (let i = 1; i < LEVELS.length; i++) {
      expect(ypp[i] as number).toBeGreaterThan(ypp[i - 1] as number);
      expect(score[i] as number).toBeGreaterThan(score[i - 1] as number);
    }
  });
});

describe('difficulty vs a solid user: CPU defense', () => {
  it('All-Pro holds the user to about 4.2-4.8 yd/play', () => {
    const r = at('allPro').user;
    expect(r.ypp).toBeGreaterThanOrEqual(3.9);
    expect(r.ypp).toBeLessThanOrEqual(5.1);
    expect(r.ypp).toBeLessThan(at('pro').user.ypp - 0.5);
  });

  it('Pro is the baseline the user offense always had (about 5-6.5 yd/play)', () => {
    const r = at('pro').user;
    expect(r.ypp).toBeGreaterThanOrEqual(5);
    expect(r.ypp).toBeLessThanOrEqual(6.5);
  });

  it('Legend holds the user to about 1.6-3.6 yd/play with clearly more sacks and takeaways, but not to nothing', () => {
    const legend = at('legend').user;
    const pro = at('pro').user;
    expect(legend.ypp).toBeGreaterThanOrEqual(1.6);
    expect(legend.ypp).toBeLessThanOrEqual(3.6);
    expect(legend.sackRate).toBeGreaterThan(pro.sackRate * 1.5);
    expect(legend.sackRate + legend.intRate).toBeGreaterThan((pro.sackRate + pro.intRate) * 1.4);
    // ... and more takeaways through the air (the CPU skill edge also finishes more of the picks it gets to).
    expect(legend.intRate).toBeGreaterThan(pro.intRate);
    // A great human still gets his chances: the user side scores on some drives.
    expect(legend.scoreRate).toBeGreaterThan(0.03);
  });

  it('the user gains less against each harder level', () => {
    const ypp = LEVELS.map((d) => at(d).user.ypp);
    for (let i = 1; i < LEVELS.length; i++) expect(ypp[i] as number).toBeLessThan(ypp[i - 1] as number);
  });
});
