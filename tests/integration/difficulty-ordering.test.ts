/**
 * Difficulty ordering on the live engine, AI vs AI. Difficulty is the CPU opponent's decision quality, so each check
 * holds one side at 'pro' and moves the other:
 *  - the same offense gains at least a yard more per play against a rookie defense than against a legend one;
 *  - a legend offense (QB reads, timing, pocket feel) out-gains and out-completes a rookie one against the same defense.
 * This replaced an older single check that set BOTH sides to the difficulty and compared yards/play. That is not a
 * football claim (a smart offense against a smart defense can out-gain a poor offense against a poor defense), and it
 * failed after the balance pass (rookie 5.16 vs legend 6.28 yd/play with both sides moved) because offensive decision
 * quality now matters more than defensive. Every coverage and pressure call is in each sample.
 * Each side runs the call sheet VARIANTS times: at 3 the per-play noise alone (yards/play SD ~9 over ~430 plays a side)
 * moved the measured defensive gap by +/-0.6 yd from one seed tag to the next (0.96 to 2.41 for the same code), so
 * the sample was doubled rather than the threshold touched.
 * Wider spread (owner: "make the harder modes WAY harder"): Legend now decides at the top of every knob (reaction
 * 0.02 s, every read 1.0) and Rookie at the bottom, so the bands below were raised to the new spread. Measured on this
 * seed tag before -> after: defensive gap 2.21 -> 2.88 yd/play (bound 1.0 -> 2.0), ypa gap 3.02 -> 3.72 (1.75 -> 2.75),
 * offensive gap 0.67 -> 1.12 yd/play (> 0 -> >= 0.6), completion gap 11 -> 11 points (3 -> 6). Review retune (rookie
 * reaction 0.55 -> 0.7 s): defensive gap 3.99, ypa gap 5.31, offensive gap 1.24, completion gap 12 points. This file is AI vs
 * AI through the decisions alone: the CPU performance edge only exists against a human (difficulty-user.test.ts).
 */
import { describe, expect, it } from 'vitest';
import { createMeasureEnv, DEFENSES, measureScrimmage, PASS_CONCEPTS, RUN_CONCEPTS, scrimmageCalls, scrimmageRates } from './measure';

const env = createMeasureEnv(2026);
const OFFENSE = [...PASS_CONCEPTS.slice(0, 7), ...RUN_CONCEPTS.slice(0, 5)];
const pct = (x: number): string => `${(x * 100).toFixed(0)}%`;
const VARIANTS = 6;

describe('difficulty ordering: the same AI offense vs a rookie / legend AI defense', () => {
  const subset = { offense: OFFENSE, defenses: DEFENSES, offenseDifficulty: 'pro' as const };
  const rookie = scrimmageRates(measureScrimmage(env, scrimmageCalls(VARIANTS, { ...subset, difficulty: 'rookie', seedTag: 'diff' })));
  const legend = scrimmageRates(measureScrimmage(env, scrimmageCalls(VARIANTS, { ...subset, difficulty: 'legend', seedTag: 'diff' })));

  it('the same offense gains at least two yards more per play against a rookie defense than against legend', () => {
    console.log(`defense difficulty: rookie ${rookie.yardsPerPlay.toFixed(2)} yd/play (comp ${pct(rookie.completionPct)}, ypc ${rookie.ypc.toFixed(2)}) vs legend ${legend.yardsPerPlay.toFixed(2)} yd/play (comp ${pct(legend.completionPct)}, ypc ${legend.ypc.toFixed(2)})`);
    expect(rookie.plays).toBeGreaterThanOrEqual(800);
    expect(rookie.yardsPerPlay - legend.yardsPerPlay).toBeGreaterThanOrEqual(2.0);
  });

  it('pass defense is part of it: the same offense gains at least 2.75 more yards per attempt against rookie', () => {
    // Coverage decisions (ai/coverage-iq.ts: throw read, break angle, zone discipline, trail vs undercut, safety
    // help, disguise quality) carry the difficulty. They show up in yards per attempt, not in completion rate: the
    // pro quarterback only throws to a man he reads as open, so a tighter coverage turns into sacks and shorter
    // gains rather than incompletions. Pooled over four seed tags with this call sheet: yards per attempt rookie 9.44
    // vs legend 6.62 with the levers, 8.06 vs 6.85 without (per-tag gap 2.05-3.75 with, 1.02-1.53 without);
    // completions 65.9% vs 64.4% with, 65.8% vs 65.1% without. (An earlier 'completion gap >= 6 points' check held
    // only on this seed tag, 71% vs 62%; on the other three the gap was -3 to +1.5 points.)
    console.log(`pass defense: ypa rookie ${rookie.ypa.toFixed(2)} vs legend ${legend.ypa.toFixed(2)}`);
    expect(rookie.ypa - legend.ypa).toBeGreaterThanOrEqual(2.75);
  });
});

describe('difficulty ordering: a rookie / legend AI offense vs the same defense', () => {
  const subset = { offense: OFFENSE, defenses: DEFENSES, difficulty: 'pro' as const };
  const rookie = scrimmageRates(measureScrimmage(env, scrimmageCalls(VARIANTS, { ...subset, offenseDifficulty: 'rookie', seedTag: 'offdiff' })));
  const legend = scrimmageRates(measureScrimmage(env, scrimmageCalls(VARIANTS, { ...subset, offenseDifficulty: 'legend', seedTag: 'offdiff' })));

  it('a legend offense gains clearly more per play and completes clearly more of its throws than a rookie one', () => {
    console.log(`offense difficulty: rookie ${rookie.yardsPerPlay.toFixed(2)} yd/play (comp ${pct(rookie.completionPct)}, sack ${pct(rookie.sackPct)}) vs legend ${legend.yardsPerPlay.toFixed(2)} yd/play (comp ${pct(legend.completionPct)}, sack ${pct(legend.sackPct)})`);
    expect(legend.plays).toBeGreaterThanOrEqual(800);
    expect(legend.yardsPerPlay - rookie.yardsPerPlay).toBeGreaterThanOrEqual(0.6);
    expect(legend.completionPct - rookie.completionPct).toBeGreaterThanOrEqual(0.06);
  });
});
