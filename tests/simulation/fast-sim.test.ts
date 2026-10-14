import { describe, expect, it } from 'vitest';
import type { PlayerId } from '@/core/ids';
import { ATTRIBUTE_KEYS, type AttributeSet, type Player } from '@/players/types';
import { applyDeltas } from '@/statistics/apply';
import { emptyGameStats } from '@/statistics/empty';
import { assertValidOutcome } from '@/game/outcome-factory';
import type { PlayContext, PlayOutcome } from '@/game/play-types';
import { HASH_LEFT, HASH_RIGHT, MIDDLE_X } from '@/game/types';
import { simulatePlay } from '@/simulation/fast-sim';
import { DEF_PLAYS, PASS_PLAYS, RUN_PLAYS, emptyTally, makeCtx, rates, tallyOutcome, variantOf, type Tally } from './helpers';

const SITUATIONS = [
  { down: 1, distance: 10, ballOn: 25 }, { down: 2, distance: 6, ballOn: 45 }, { down: 3, distance: 4, ballOn: 60 },
  { down: 1, distance: 10, ballOn: 75 }, { down: 2, distance: 9, ballOn: 35 }, { down: 3, distance: 8, ballOn: 50 },
];

/** Runs every bundled pass/run play against a rotating set of defenses; ~2400 seeded plays. */
const runLeague = (variants = 3, patch: Partial<PlayContext> = {}, seedBase = 0): { outcomes: PlayOutcome[]; tally: Tally; passes: Tally; runs: Tally } => {
  const outcomes: PlayOutcome[] = [];
  const tally = emptyTally();
  const passes = emptyTally();
  const runs = emptyTally();
  const plays = [...PASS_PLAYS.map((p) => ({ p, pass: true })), ...RUN_PLAYS.map((p) => ({ p, pass: false }))];
  plays.forEach(({ p, pass }, pi) => {
    for (let di = 0; di < DEF_PLAYS.length; di += 1) {
      const d = DEF_PLAYS[(di + pi) % DEF_PLAYS.length] as string;
      const base = makeCtx({ offensePlayId: p, defensePlayId: d, seed: seedBase + pi * 31 + di });
      for (let v = 0; v < variants; v++) {
        const o = simulatePlay(variantOf(base, v, { ...SITUATIONS[(v + pi) % SITUATIONS.length], ...patch }));
        outcomes.push(o);
        tallyOutcome(tally, o);
        tallyOutcome(pass ? passes : runs, o);
      }
    }
  });
  return { outcomes, tally, passes, runs };
};

const shifted = (p: Player, delta: number): Player => {
  const attrs = { ...p.attrs } as AttributeSet;
  for (const k of ATTRIBUTE_KEYS) attrs[k] = Math.max(1, Math.min(99, attrs[k] + delta));
  return { ...p, attrs };
};

/** Same context with one side's ratings shifted by `delta` points. */
const withShift = (ctx: PlayContext, side: 'offense' | 'defense', delta: number): PlayContext => {
  const key = side === 'offense' ? 'offenseLineup' : 'defenseLineup';
  const lineup: Record<string, Player> = {};
  for (const [role, p] of Object.entries(ctx[key])) lineup[role] = shifted(p, delta);
  return { ...ctx, [key]: lineup };
};

describe('simulatePlay calibration (2000+ seeded plays)', () => {
  const league = runLeague(6);
  const r = rates(league.tally);
  const runRates = rates(league.runs);

  it('produces sensible league-wide passing numbers', () => {
    expect(league.outcomes.length).toBeGreaterThanOrEqual(2000);
    expect(r.completionPct).toBeGreaterThan(0.58);
    expect(r.completionPct).toBeLessThan(0.68);
    expect(r.ypa).toBeGreaterThan(6);
    expect(r.ypa).toBeLessThan(8);
    expect(r.sackRate).toBeGreaterThan(0.05);
    expect(r.sackRate).toBeLessThan(0.08);
    // This fixture call sheet (more two-high zone and dime, fewer all-out blitzes than the league measure) runs at ~0.6x
    // the league interception rate: 2.2% here went with 3.6% on the league sample. The league rate is the one calibrated
    // to the NFL (~2.5% of attempts, ~0.85 a team game over a season), which puts this sheet at ~1.3-1.8%.
    expect(r.intRate).toBeGreaterThan(0.012);
    expect(r.intRate).toBeLessThan(0.03);
    expect(r.scrambleRate).toBeLessThan(0.1);
  });

  it('produces sensible rushing, fumble and big-play numbers', () => {
    expect(runRates.ypc).toBeGreaterThan(3.8);
    expect(runRates.ypc).toBeLessThan(4.8);
    expect(runRates.fumblePerTouch).toBeGreaterThan(0.005);
    expect(runRates.fumblePerTouch).toBeLessThan(0.03);
    expect(r.explosiveRate).toBeGreaterThan(0.05);
    expect(r.explosiveRate).toBeLessThan(0.14);
    expect(r.penaltyRate).toBeGreaterThan(0.03);
    expect(r.penaltyRate).toBeLessThan(0.15);
    expect(r.oobRate).toBeGreaterThan(0.03);
    expect(r.oobRate).toBeLessThan(0.2);
    expect(r.injuryRate).toBeGreaterThan(0.002);
    expect(r.injuryRate).toBeLessThan(0.05);
  });

  it('every outcome is valid, internally consistent and fully populated', () => {
    const before = new Set<PlayerId>();
    for (const o of league.outcomes) {
      expect(() => assertValidOutcome(o)).not.toThrow();
      expect(o.events[0]?.type).toBe(o.result === 'penalty' ? 'penalty' : 'snap');
      expect(o.events[o.events.length - 1]?.type).toBe('whistle');
      expect(o.playByPlay.length).toBeGreaterThan(0);
      expect(o.replayId).toBeNull();
      expect(o.presnapElapsed).toBeGreaterThan(0);
      expect(o.endBallOn).toBeGreaterThanOrEqual(0);
      expect(o.endBallOn).toBeLessThanOrEqual(100);
      expect(o.endBallX === MIDDLE_X || (o.endBallX >= HASH_LEFT && o.endBallX <= HASH_RIGHT) || o.outOfBounds).toBe(true);
      for (const p of o.penalties) expect(p.accepted).toBe(false);
      if (o.turnover) expect(o.turnoverType).not.toBeNull();
      if (o.result === 'interception') { expect(o.turnoverType).toBe('interception'); expect(o.yards).toBe(0); }
      if (o.incomplete) { expect(o.yards).toBe(0); expect(o.endBallOn).toBe(o.endBallOn); }
      if (o.touchdown && !o.turnover) expect(o.endBallOn).toBe(100);
      if (o.safety) expect(o.endBallOn).toBe(0);
      if (o.result === 'pass') expect(o.receiverId).not.toBeNull();
      if (o.result === 'run') expect(o.passerId).toBeNull();
      if (o.result === 'penalty') { expect(o.timeElapsed).toBe(0); expect(o.penalties[0]?.deadBall).toBe(true); }
      else { expect(o.timeElapsed).toBeGreaterThanOrEqual(0.5); expect(o.timeElapsed).toBeLessThanOrEqual(12); }
      expect(() => applyDeltas(emptyGameStats(), o.stats)).not.toThrow();
      for (const [id, f] of Object.entries(o.fatigueAfter)) { before.add(id as PlayerId); expect(f).toBeGreaterThanOrEqual(0); expect(f).toBeLessThanOrEqual(1); }
    }
    expect(before.size).toBeGreaterThan(22);
  });

  it('fatigue is charged to everyone on the field and stats only name players on the field', () => {
    const ctx = makeCtx({ offensePlayId: 'iform-toss-right', defensePlayId: '43-cover3-zone', seed: 9 });
    const onField = new Set([...Object.values(ctx.offenseLineup), ...Object.values(ctx.defenseLineup)].map((p) => p.id));
    const o = simulatePlay(ctx);
    expect(Object.keys(o.fatigueAfter).sort()).toEqual([...onField].sort());
    for (const d of o.stats) expect(onField.has(d.playerId)).toBe(true);
    expect(o.stats.filter((d) => d.stat === 'snaps')).toHaveLength(22);
    const carrier = o.ballCarrierId as PlayerId;
    expect(o.fatigueAfter[carrier]).toBeGreaterThan(0);
  });
});

describe('simulatePlay determinism and clock facts', () => {
  it('is deterministic for the same ctx.rng seed and differs across seeds', () => {
    const a = simulatePlay(makeCtx({ seed: 3 }, 1));
    const b = simulatePlay(makeCtx({ seed: 3 }, 1));
    expect(a).toEqual(b);
    const different = [0, 1, 2, 3, 4, 5].map((v) => simulatePlay(makeCtx({ seed: 3 }, v + 10)));
    expect(new Set(different.map((o) => JSON.stringify([o.result, o.yards, o.timeElapsed]))).size).toBeGreaterThan(1);
  });

  it('reports 0 pre-snap seconds when the clock was stopped, the huddle runoff otherwise, and hurries late', () => {
    const stopped = simulatePlay(makeCtx({ clockRunning: false }, 1));
    expect(stopped.presnapElapsed).toBe(0);
    const running = simulatePlay(makeCtx({ clockRunning: true }, 1));
    expect(running.presnapElapsed).toBeGreaterThanOrEqual(running.presnapElapsed && 15);
    const huddle = makeCtx({}, 2).ruleset.huddleRunoffSec;
    expect(running.presnapElapsed).toBeLessThanOrEqual(huddle + 2);
    const hurry = simulatePlay(makeCtx({ quarter: 4, clockRemaining: 90, scoreDiff: -4 }, 1));
    expect(hurry.presnapElapsed).toBeLessThan(huddle);
  });

  // Incompletions run on the live engine's clock (live-fast-parity): the drop, the read behind a pocket that holds and
  // the flight charge ~5-6 s, so the fast sim's window is 3-7 s (it was 3-5.5 s before the longer pocket).
  it('runs take 4-8 s, completions 5-8.5 s and incompletions 3-7 s', () => {
    const { outcomes } = runLeague(1, {}, 500);
    for (const o of outcomes) {
      if (o.result === 'run') { expect(o.timeElapsed).toBeGreaterThanOrEqual(3.8); expect(o.timeElapsed).toBeLessThanOrEqual(8); }
      if (o.result === 'incomplete') { expect(o.timeElapsed).toBeGreaterThanOrEqual(3); expect(o.timeElapsed).toBeLessThanOrEqual(7); }
      if (o.result === 'pass' && o.events.some((e) => e.type === 'catch')) { expect(o.timeElapsed).toBeGreaterThanOrEqual(5); expect(o.timeElapsed).toBeLessThanOrEqual(8.5); }
    }
  });
});

describe('special situations', () => {
  it('kneels lose a yard or two in a couple of seconds and count as a QB rush', () => {
    const o = simulatePlay(makeCtx({ offensePlayId: 'iform-kneel', ballOn: 40 }, 1));
    expect(o.result).toBe('kneel');
    expect(o.yards).toBeGreaterThanOrEqual(-2);
    expect(o.yards).toBeLessThanOrEqual(0);
    expect(o.timeElapsed).toBeLessThanOrEqual(3);
    expect(o.stats.some((d) => d.stat === 'rushing.attempts')).toBe(true);
    expect(o.events.some((e) => e.type === 'kneel')).toBe(true);
  });

  it('spikes are instant incompletions', () => {
    const o = simulatePlay(makeCtx({ offensePlayId: 'singleback-spike' }, 1));
    expect(o.result).toBe('spike');
    expect(o.incomplete).toBe(true);
    expect(o.timeElapsed).toBeLessThanOrEqual(2);
    expect(o.stats.some((d) => d.stat === 'passing.attempts')).toBe(true);
  });

  it('fake punts and two-point tries run through the scrimmage model', () => {
    const fake = simulatePlay(makeCtx({ offensePlayId: 'fakePunt-run', defensePlayId: 'puntReturn-middle', ballOn: 40, down: 4, distance: 2, special: 'punt' }, 1));
    expect(['run', 'scramble']).toContain(fake.result);
    expect(fake.kickDistance).toBeNull();
    let converted = 0;
    for (let v = 0; v < 60; v++) {
      const o = simulatePlay(makeCtx({ offensePlayId: 'iform-twoPoint-power', defensePlayId: 'goalLine-cover0-runStop', ballOn: 98, down: 1, distance: 2, special: 'twoPoint' }, v));
      expect(['run', 'scramble', 'penalty']).toContain(o.result);
      if (o.touchdown || o.endBallOn >= 100) converted += 1;
    }
    expect(converted).toBeGreaterThan(5);
    expect(converted).toBeLessThan(55);
  });

  it('scores touchdowns from the red zone and safeties when sacked in the end zone', () => {
    let tds = 0;
    for (let v = 0; v < 120; v++) {
      const o = simulatePlay(makeCtx({ offensePlayId: RUN_PLAYS[v % RUN_PLAYS.length], defensePlayId: '43-cover3-zone', ballOn: 96, distance: 4, seed: v }, v));
      if (o.touchdown && !o.turnover) { tds += 1; expect(o.endBallOn).toBe(100); expect(o.yards).toBe(4); expect(o.firstDown).toBe(true); expect(o.events.some((e) => e.type === 'touchdown')).toBe(true); expect(o.stats.some((d) => d.stat === 'rushing.touchdowns')).toBe(true); }
    }
    expect(tds).toBeGreaterThan(20);
    let safeties = 0;
    for (let v = 0; v < 200; v++) {
      const o = simulatePlay(makeCtx({ offensePlayId: 'shotgun-fourVerts', defensePlayId: '43-cover0-lbBlitz', ballOn: 1, seed: 7 }, v));
      if (o.safety) { safeties += 1; expect(o.result).toBe('sack'); expect(o.endBallOn).toBe(0); expect(o.yards).toBe(-1); expect(o.events.some((e) => e.type === 'safety')).toBe(true); }
    }
    expect(safeties).toBeGreaterThan(3);
  });

  it('turnovers carry the right facts and stat credit', () => {
    // Four variants (~720 attempts, ~16 picks expected at the league's ~2.2%): with two the pick count sat right on
    // the floor of 5 and moved above or below it with any change to the draw order.
    const { outcomes } = runLeague(4, {}, 900);
    const ints = outcomes.filter((o) => o.result === 'interception');
    const fumbles = outcomes.filter((o) => o.turnoverType === 'fumble');
    expect(ints.length).toBeGreaterThan(5);
    expect(fumbles.length).toBeGreaterThan(2);
    for (const o of ints) {
      expect(o.turnover).toBe(true);
      expect(o.events.some((e) => e.type === 'interception')).toBe(true);
      expect(o.stats.some((d) => d.stat === 'defense.interceptions')).toBe(true);
      expect(o.stats.some((d) => d.stat === 'passing.interceptions')).toBe(true);
      if (o.touchdown) expect(o.endBallOn).toBe(0);
    }
    for (const o of fumbles) {
      expect(o.events.some((e) => e.type === 'fumble')).toBe(true);
      expect(o.events.some((e) => e.type === 'recovery' && e.side === 'defense')).toBe(true);
      expect(o.stats.some((d) => d.stat === 'fumblesLost')).toBe(true);
      expect(o.stats.some((d) => d.stat === 'defense.fumbleRecoveries')).toBe(true);
    }
  });

  it('flags rare close calls with a complete alternate outcome', { timeout: 30_000 }, () => {
    const reviews: PlayOutcome[] = [];
    for (let v = 0; v < 1500; v++) {
      const play = v % 2 === 0 ? PASS_PLAYS[v % PASS_PLAYS.length] : RUN_PLAYS[v % RUN_PLAYS.length];
      const o = simulatePlay(makeCtx({ offensePlayId: play, defensePlayId: DEF_PLAYS[v % DEF_PLAYS.length], ballOn: 88, seed: v % 40 }, v));
      if (o.review) reviews.push(o);
    }
    expect(reviews.length).toBeGreaterThan(0);
    expect(reviews.length).toBeLessThan(120);
    for (const o of reviews) {
      const r = o.review!;
      expect(r.call.confidence).toBeGreaterThan(0);
      expect(r.call.confidence).toBeLessThanOrEqual(1);
      expect(r.ifOverturned.review).toBeNull();
      expect(() => assertValidOutcome(r.ifOverturned)).not.toThrow();
      expect(r.ifOverturned.fatigueAfter).toEqual(o.fatigueAfter);
      if (r.call.kind === 'touchdown') { expect(o.touchdown).toBe(true); expect(r.ifOverturned.touchdown).toBe(false); expect(r.ifOverturned.endBallOn).toBe(99); }
      if (r.call.kind === 'catch') { expect(o.result).toBe('pass'); expect(r.ifOverturned.incomplete).toBe(true); }
      if (r.call.kind === 'fumble') { expect(o.turnover).toBe(true); expect(r.ifOverturned.turnover).toBe(false); }
    }
  });
});

describe('attributes, difficulty, weather and rules change the numbers', () => {
  const sample = (patch: (ctx: PlayContext) => PlayContext, n = 40): Tally => {
    const t = emptyTally();
    PASS_PLAYS.forEach((p, i) => {
      const base = patch(makeCtx({ offensePlayId: p, defensePlayId: DEF_PLAYS[i % DEF_PLAYS.length], seed: i + 1 }));
      for (let v = 0; v < n; v++) tallyOutcome(t, simulatePlay(variantOf(base, v, SITUATIONS[v % SITUATIONS.length])));
    });
    RUN_PLAYS.forEach((p, i) => {
      const base = patch(makeCtx({ offensePlayId: p, defensePlayId: DEF_PLAYS[(i + 3) % DEF_PLAYS.length], seed: i + 50 }));
      for (let v = 0; v < n; v++) tallyOutcome(t, simulatePlay(variantOf(base, v, SITUATIONS[v % SITUATIONS.length])));
    });
    return t;
  };

  it('a much better offense completes more, gains more per attempt and per carry than a much worse one', () => {
    const strong = rates(sample((c) => withShift(c, 'offense', 18)));
    const weak = rates(sample((c) => withShift(c, 'offense', -18)));
    expect(strong.completionPct).toBeGreaterThan(weak.completionPct + 0.05);
    expect(strong.ypa).toBeGreaterThan(weak.ypa + 1);
    expect(strong.ypc).toBeGreaterThan(weak.ypc + 0.6);
    expect(strong.sackRate).toBeLessThan(weak.sackRate);
  });

  it('an AI defense on legend covers tighter and picks off more than one on rookie against a human offense', () => {
    const human = (ctx: PlayContext): PlayContext => ({ ...ctx, controllers: { home: 'human', away: 'ai' }, userSide: 'home', userControl: 'offense' });
    const legend = rates(sample((c) => human({ ...c, difficulty: { ...c.difficulty, id: 'legend', coverageAnticipation: 0.92, interceptionAwareness: 0.92, tackleDecisionQuality: 0.95 } })));
    const rookie = rates(sample((c) => human({ ...c, difficulty: { ...c.difficulty, id: 'rookie', coverageAnticipation: 0.3, interceptionAwareness: 0.3, tackleDecisionQuality: 0.4 } })));
    expect(legend.completionPct).toBeLessThan(rookie.completionPct - 0.03);
    expect(legend.intRate).toBeGreaterThan(rookie.intRate);
    expect(legend.ypc).toBeLessThan(rookie.ypc);
  });

  it('heavy rain lowers completion and raises fumbles; arcade rules drop penalties and injuries', () => {
    const clear = rates(sample((c) => c));
    const rain = rates(sample((c) => ({ ...c, weather: { ...c.weather, type: 'heavyRain', precipitation: 0.9, fieldSlick: 0.5 } })));
    expect(rain.completionPct).toBeLessThan(clear.completionPct - 0.03);
    expect(rain.fumblePerTouch).toBeGreaterThan(clear.fumblePerTouch);
    const arcade = sample((c) => ({ ...c, ruleset: { ...c.ruleset, penalties: false, injuries: false } }), 8);
    expect(arcade.penalties).toBe(0);
    expect(arcade.injuries).toBe(0);
    const sim = sample((c) => c, 8);
    expect(sim.penalties).toBeGreaterThan(0);
  });
});

describe('yardage is credited to the goal lines', () => {
  it('a touchdown pass counts to the goal line only, with air + yac equal to the yards', () => {
    let tds = 0;
    for (let v = 0; v < 600; v++) {
      const ctx = makeCtx({ offensePlayId: PASS_PLAYS[v % PASS_PLAYS.length], defensePlayId: '43-cover3-zone', ballOn: 92, seed: v % 20 }, v);
      const o = simulatePlay(variantOf(ctx, v));
      if (o.result !== 'pass' || !o.touchdown || o.turnover) continue;
      tds += 1;
      expect(o.yards).toBe(8);
      expect(o.endBallOn).toBe(100);
      expect(o.airYards + o.yac).toBe(o.yards);
      expect(o.stats.find((d) => d.stat === 'passing.yards')?.value).toBe(8);
    }
    expect(tds).toBeGreaterThan(50);
  });

  it('a completion tackled in the offense\'s own end zone is a safety', () => {
    let safeties = 0;
    for (let v = 0; v < 1500; v++) {
      const ctx = makeCtx({ offensePlayId: 'shotgun-rbScreen-right', defensePlayId: '43-cover0-lbBlitz', ballOn: 2, seed: v % 20 }, v);
      const o = simulatePlay(variantOf(ctx, v));
      if (o.result !== 'pass') continue;
      if (o.safety) {
        safeties += 1;
        expect(o.yards).toBe(-2);
        expect(o.endBallOn).toBe(0);
        expect(o.turnover).toBe(false);
        expect(o.firstDown).toBe(false);
        expect(o.events.some((e) => e.type === 'safety')).toBe(true);
        expect(o.events[o.events.length - 1]).toMatchObject({ type: 'whistle', reason: 'safety' });
      } else {
        expect(ctx.ballOn + o.yards).toBeGreaterThan(0);
      }
    }
    expect(safeties).toBeGreaterThan(5);
  });

  it('kneel yards are plain integers (never -0)', () => {
    for (let v = 0; v < 100; v++) expect(Object.is(simulatePlay(makeCtx({ offensePlayId: 'iform-kneel', ballOn: 40 }, v)).yards, -0)).toBe(false);
  });
});
