/**
 * The season-level calibration levers of the whole-game simulator, one at a time: per-game team form, rating leverage,
 * the progression read that spreads targets and the simulated huddle tempo.
 */
import { describe, expect, it } from 'vitest';
import type { Player } from '@/players/types';
import { createFastSim, simulatePlay } from '@/simulation/fast-sim';
import { GAME_FORM_MAX_SDS, GAME_FORM_SD, gameForm, quickSetup, simulateGame } from '@/simulation/game-sim';
import { applyGameForm, buildMatchups, leveragedAttrs, RATING_LEVERAGE, REFERENCE_OVERALL } from '@/simulation/matchups';
import { knobsFor } from '@/simulation/play-model';
import { SIM_HUDDLE_SEC, simHuddleSec } from '@/simulation/sim-support';
import { makeCtx, variantOf } from './helpers';

const withOverall = (p: Player, overall: number, position: Player['position'] = p.position): Player => ({ ...p, overall, position });

describe('game form', () => {
  it('is deterministic per game seed, differs between games and is off at sd 0', () => {
    expect(gameForm(42)).toEqual(gameForm(42));
    expect(gameForm(42)).not.toEqual(gameForm(43));
    expect(gameForm(42, 0)).toEqual({ home: 0, away: 0 });
    const draws = Array.from({ length: 400 }, (_, i) => gameForm(i + 1).home);
    const sd = Math.sqrt(draws.reduce((s, x) => s + x * x, 0) / draws.length);
    expect(sd).toBeGreaterThan(GAME_FORM_SD * 0.8);
    expect(sd).toBeLessThan(GAME_FORM_SD * 1.2);
    for (const x of draws) expect(Math.abs(x)).toBeLessThanOrEqual(GAME_FORM_MAX_SDS * GAME_FORM_SD + 1e-12);
  });

  it('tilts the offense\'s matchup factors by its edge and is a no-op at 0', () => {
    const ctx = makeCtx({ offensePlayId: 'shotgun-slants', defensePlayId: '43-cover3-zone', seed: 4 });
    const m = buildMatchups(ctx, knobsFor(ctx));
    expect(applyGameForm(m, 0)).toBe(m);
    const up = applyGameForm(m, 0.1);
    expect(up.passProtection).toBeGreaterThan(m.passProtection);
    expect(up.passRush).toBeLessThan(m.passRush);
    expect(up.runBlocking).toBeGreaterThan(m.runBlocking);
    expect(up.runDefense).toBeLessThan(m.runDefense);
    expect(up.qbQuality).toBeGreaterThan(m.qbQuality);
    up.receivers.forEach((r, i) => expect(r.openness).toBeGreaterThanOrEqual(m.receivers[i]?.openness ?? 1));
  });

  it('a team on a good day gains more per play than on a bad day; no form reproduces simulatePlay exactly', () => {
    const base = makeCtx({ offensePlayId: 'singleback-curlFlat', defensePlayId: '43-cover3-zone', seed: 8 });
    const good = createFastSim({ home: 0.12, away: -0.12 });
    const bad = createFastSim({ home: -0.12, away: 0.12 });
    const plain = createFastSim(null);
    let gy = 0;
    let by = 0;
    for (let v = 0; v < 400; v++) {
      const ctx = variantOf(base, v);
      gy += good(variantOf(base, v)).yards;
      by += bad(variantOf(base, v)).yards;
      if (v < 20) expect(plain(ctx)).toEqual(simulatePlay(variantOf(base, v)));
    }
    expect(base.offense).toBe('home');
    expect(gy / 400).toBeGreaterThan(by / 400 + 0.5);
  });

  it('whole games replay identically with the default form, and form can be switched off', { timeout: 30_000 }, () => {
    const setup = quickSetup(11, 'DAL', 'PHI', { seed: 99 });
    const a = simulateGame(setup).result;
    const b = simulateGame(setup).result;
    expect([a.homeScore, a.awayScore, a.plays]).toEqual([b.homeScore, b.awayScore, b.plays]);
    const off = simulateGame(setup, { formSd: 0 }).result;
    expect(off.plays).toBeGreaterThan(100);
  });
});

describe('rating leverage', () => {
  const ctx = makeCtx({ seed: 2 });
  const sample = Object.values(ctx.offenseLineup).find((p) => p.position === 'WR') as Player;
  const kicker = { ...sample, position: 'K' as const };

  it('leaves a reference-level player unchanged and pulls others toward the reference, keeping their order', () => {
    const ref = withOverall(sample, REFERENCE_OVERALL);
    expect(leveragedAttrs(ref)).toEqual(ref.attrs);
    const star = leveragedAttrs(withOverall(sample, 90));
    const scrub = leveragedAttrs(withOverall(sample, 50));
    const drop = (1 - RATING_LEVERAGE) * (90 - REFERENCE_OVERALL);
    expect(star.speed).toBeCloseTo(Math.max(1, sample.attrs.speed - drop), 5);
    expect(scrub.speed).toBeGreaterThan(sample.attrs.speed - 1e-9);
    expect(star.speed).toBeLessThanOrEqual(sample.attrs.speed);
    expect(leveragedAttrs(withOverall(sample, 90), 1)).toEqual(sample.attrs);
  });

  it('never touches kickers, punters, kicking or durability attributes', () => {
    expect(leveragedAttrs(withOverall(kicker, 95, 'K'))).toEqual(kicker.attrs);
    const star = leveragedAttrs(withOverall(sample, 95));
    expect(star.kickPower).toBe(sample.attrs.kickPower);
    expect(star.stamina).toBe(sample.attrs.stamina);
    expect(star.injuryResistance).toBe(sample.attrs.injuryResistance);
  });
});

describe('target distribution', () => {
  it('spreads a pass play\'s targets across the progression instead of feeding one man', () => {
    const counts = new Map<string, number>();
    let targets = 0;
    for (const off of ['singleback-curlFlat', 'shotgun-mesh', 'trips-smash', 'shotgun-dragDig']) {
      for (const def of ['43-cover3-zone', '43-cover1-man']) {
        const base = makeCtx({ offensePlayId: off, defensePlayId: def, seed: 6 });
        for (let v = 0; v < 120; v++) {
          const o = simulatePlay(variantOf(base, v));
          if (!o.receiverId) continue;
          targets += 1;
          counts.set(o.receiverId, (counts.get(o.receiverId) ?? 0) + 1);
        }
      }
    }
    const shares = [...counts.values()].map((c) => c / targets).sort((a, b) => b - a);
    expect(shares.length).toBeGreaterThanOrEqual(4);
    expect(shares[0]).toBeLessThan(0.4);
  });
});

describe('tempo', () => {
  it('a simulated huddle burns about SIM_HUDDLE_SEC on a running clock', () => {
    const secs = Array.from({ length: 60 }, (_, i) => simulatePlay(makeCtx({ clockRunning: true, seed: 1 + (i % 3) }, i)).presnapElapsed).filter((s) => s > 0);
    const mean = secs.reduce((a, b) => a + b, 0) / secs.length;
    expect(mean).toBeGreaterThan(SIM_HUDDLE_SEC - 1);
    expect(mean).toBeLessThan(SIM_HUDDLE_SEC + 2);
  });

  it('the simulated huddle lengthens with the quarter so snap counts stay NFL-like at 15 minutes', () => {
    const rs = { huddleRunoffSec: 25, playClockSec: 40 };
    expect(simHuddleSec({ ...rs, quarterLengthSec: 300 })).toBe(SIM_HUDDLE_SEC);
    expect(simHuddleSec({ ...rs, quarterLengthSec: 480 })).toBe(SIM_HUDDLE_SEC);
    expect(simHuddleSec({ ...rs, quarterLengthSec: 900 })).toBeCloseTo(40, 6);
    expect(simHuddleSec({ ...rs, quarterLengthSec: 900, playClockSec: 25 })).toBe(25);
    expect(simHuddleSec({ ...rs, quarterLengthSec: 480, huddleRunoffSec: 10 })).toBe(10);
  });
});
