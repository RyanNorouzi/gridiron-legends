/**
 * Balance harness: ≥ 600 live AI-vs-AI scrimmage plays (every pass/run concept vs every coverage/blitz at 'pro')
 * plus ≥ 300 special-teams plays through the real PlayEngine, printed as tables and asserted against loose
 * league-realistic bands. Also checks that the concept-vs-coverage matrix has real rock-paper-scissors and that the
 * fast sim tracks the live engine on completion / ypa / ypc. Difficulty ordering lives in difficulty-ordering.test.ts
 * (its own file so the two long live samples run in parallel with this one).
 */
import { describe, expect, it } from 'vitest';
import {
  bestConceptPerDefense, createMeasureEnv, DEFENSES, formatTable, measureFastSim, measureScrimmage, measureSpecial, PASS_CONCEPTS, RUN_CONCEPTS,
  scrimmageCalls, scrimmageRates, scrimmageRows, specialRates, specialRows,
} from './measure';

const env = createMeasureEnv(2026);
const calls = scrimmageCalls(3);
const live = measureScrimmage(env, calls);
const liveRates = scrimmageRates(live);
const special = measureSpecial(env, 100);
const specialR = specialRates(special);

const within = (a: number, b: number, tol: number): boolean => Math.abs(a - b) <= tol * Math.max(Math.abs(a), Math.abs(b), 1e-9);

describe('balance: live engine scrimmage plays (AI vs AI, pro)', () => {
  it('prints the scrimmage table', () => {
    console.log(formatTable(`LIVE SCRIMMAGE (${live.plays} plays)`, scrimmageRows(liveRates)));
    if (live.errors.length) console.log('errors:', live.errors.slice(0, 10));
    expect(live.plays).toBeGreaterThanOrEqual(600);
  });

  it('never hits maxTicks and keeps plays short', () => {
    expect(live.errors).toEqual([]);
    expect(liveRates.maxTicksPct).toBe(0);
    expect(liveRates.meanPlaySec).toBeLessThan(9);
  });

  it('passing sits in league-realistic bands', () => {
    expect(liveRates.completionPct).toBeGreaterThanOrEqual(0.52);
    expect(liveRates.completionPct).toBeLessThanOrEqual(0.70);
    expect(liveRates.ypa).toBeGreaterThanOrEqual(5.5);
    expect(liveRates.ypa).toBeLessThanOrEqual(8.5);
    expect(liveRates.sackPct).toBeGreaterThanOrEqual(0.04);
    expect(liveRates.sackPct).toBeLessThanOrEqual(0.10);
    expect(liveRates.intPct).toBeGreaterThanOrEqual(0.015);
    expect(liveRates.intPct).toBeLessThanOrEqual(0.045);
  });

  it('rushing sits in league-realistic bands', () => {
    expect(liveRates.ypc).toBeGreaterThanOrEqual(3.3);
    expect(liveRates.ypc).toBeLessThanOrEqual(5.2);
    expect(liveRates.stuffPct).toBeGreaterThanOrEqual(0.12);
    expect(liveRates.stuffPct).toBeLessThanOrEqual(0.25);
    expect(liveRates.fumblePct).toBeGreaterThanOrEqual(0.005);
    expect(liveRates.fumblePct).toBeLessThanOrEqual(0.03);
  });

  it('has rock-paper-scissors: at least 3 concepts are the best answer to some coverage', () => {
    const best = bestConceptPerDefense(live, [...PASS_CONCEPTS, ...RUN_CONCEPTS]);
    console.log('best concept per defense:', JSON.stringify(best));
    expect(Object.keys(best).length).toBe(DEFENSES.length);
    expect(new Set(Object.values(best)).size).toBeGreaterThanOrEqual(3);
  });
});

describe('balance: special teams', () => {
  it('prints the special-teams table and stays in band', () => {
    console.log(formatTable(`LIVE SPECIAL TEAMS (${special.plays} plays)`, specialRows(specialR)));
    if (special.errors.length) console.log('errors:', special.errors.slice(0, 10));
    expect(special.plays).toBeGreaterThanOrEqual(300);
    expect(special.errors).toEqual([]);
    expect(specialR.maxTicksPct).toBe(0);
    expect(specialR.fgPct[30] ?? 0).toBeGreaterThan(0.85);
    expect(specialR.fgPct[55] ?? 1).toBeLessThan(0.55);
    expect(specialR.puntAvg).toBeGreaterThanOrEqual(36);
    expect(specialR.puntAvg).toBeLessThanOrEqual(50);
  });
});

describe('balance: fast sim tracks the live engine', () => {
  const fast = scrimmageRates(measureFastSim(env, calls));

  it('completion %, yards/attempt and yards/carry are within ~15% of the live numbers', () => {
    console.log(formatTable(`FAST SIM (${fast.plays} plays)`, scrimmageRows(fast)));
    console.log(`live vs fast: comp ${(liveRates.completionPct * 100).toFixed(1)}/${(fast.completionPct * 100).toFixed(1)}  ypa ${liveRates.ypa.toFixed(2)}/${fast.ypa.toFixed(2)}  ypc ${liveRates.ypc.toFixed(2)}/${fast.ypc.toFixed(2)}`);
    expect(within(fast.completionPct, liveRates.completionPct, 0.15)).toBe(true);
    expect(within(fast.ypa, liveRates.ypa, 0.15)).toBe(true);
    expect(within(fast.ypc, liveRates.ypc, 0.15)).toBe(true);
  });
});
