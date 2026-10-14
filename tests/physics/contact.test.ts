import { describe, expect, it } from 'vitest';
import { createRng } from '@/core/rng';
import type { Athlete } from '@/game/play-types';
import type { TackleKind, ThrowType } from '@/game/play-events';
import {
  blockContest, breakMoveFor, carrierPower, catchContest, momentum, momentumAdvantage, reachHeight, standingReach, tackleContest, tacklePower,
  type CatchResult, type TackleResult,
} from '@/physics/contact';
import { makeAthlete } from './helpers';

const tally = <T extends string>(n: number, roll: (i: number) => T): Record<T, number> => {
  const out = {} as Record<T, number>;
  for (let i = 0; i < n; i++) {
    const r = roll(i);
    out[r] = (out[r] ?? 0) + 1;
  }
  return out;
};

const N = 2000;

describe('tackleContest', () => {
  const runTackles = (carrier: Athlete, tackler: Athlete, kind: TackleKind, seed: number): Record<TackleResult, number> => {
    const rng = createRng(seed);
    return tally(N, () => tackleContest(carrier, tackler, kind, { rng }).result);
  };
  const share = (r: Record<TackleResult, number>, ...keys: TackleResult[]): number => keys.reduce((s, k) => s + (r[k] ?? 0), 0) / N;

  it('99 tackling brings down a 40 carrying runner most of the time, and vice versa', () => {
    const weakCarrier = makeAthlete({ attrs: { carrying: 40 }, vel: { x: 0, y: 7 }, state: 'moving' });
    const eliteTackler = makeAthlete({ attrs: { tackling: 99 }, vel: { x: 0, y: -5 }, state: 'tackling' });
    const strong = runTackles(weakCarrier, eliteTackler, 'wrap', 1);
    expect(share(strong, 'tackled', 'fumble')).toBeGreaterThan(0.65);

    const eliteCarrier = makeAthlete({ attrs: { carrying: 99 }, vel: { x: 0, y: 7 }, state: 'moving' });
    const weakTackler = makeAthlete({ attrs: { tackling: 40 }, vel: { x: 0, y: -5 }, state: 'tackling' });
    const weak = runTackles(eliteCarrier, weakTackler, 'wrap', 2);
    expect(share(weak, 'broken', 'stumble', 'missed')).toBeGreaterThan(0.65);
    expect(share(weak, 'tackled', 'fumble')).toBeLessThan(0.35);
  });

  it('evenly matched: a square wrap brings the runner down most of the time, an arm tackle is near a coin flip', () => {
    const carrier = makeAthlete({ vel: { x: 0, y: 6 } });
    const tackler = makeAthlete({ vel: { x: 0, y: -6 } });
    const r = runTackles(carrier, tackler, 'wrap', 3);
    const down = share(r, 'tackled', 'fumble');
    expect(down).toBeGreaterThan(0.6);
    expect(down).toBeLessThan(0.85);
    const arm = share(runTackles(carrier, tackler, 'arm', 3), 'tackled', 'fumble');
    expect(arm).toBeGreaterThan(0.3);
    expect(arm).toBeLessThan(down);
  });

  it('momentum matters: a heavier, faster tackler hits harder', () => {
    const carrier = makeAthlete({ vel: { x: 0, y: 5 }, massLb: 190 });
    const light = makeAthlete({ vel: { x: 0, y: -2 }, massLb: 180 });
    const freight = makeAthlete({ vel: { x: 0, y: -8 }, massLb: 250 });
    const ctx = { rng: createRng(1) };
    expect(tacklePower(freight, carrier, 'wrap', ctx)).toBeGreaterThan(tacklePower(light, carrier, 'wrap', ctx));
    expect(momentum(freight)).toBeCloseTo(250 * 8);
    expect(momentumAdvantage(freight, light)).toBeGreaterThan(0);
    expect(momentumAdvantage(light, freight)).toBeLessThan(0);
  });

  it('strips fumble far more often than wraps; ball security assist dampens it', () => {
    const carrier = makeAthlete({ attrs: { carrying: 50 }, vel: { x: 0, y: 6 } });
    const tackler = makeAthlete({ attrs: { tackling: 80 }, vel: { x: 0, y: -6 } });
    const wrap = tackleContest(carrier, tackler, 'wrap', { rng: createRng(1) });
    const strip = tackleContest(carrier, tackler, 'strip', { rng: createRng(1) });
    expect(strip.fumbleChance).toBeGreaterThan(wrap.fumbleChance * 4);
    const assisted = tackleContest(carrier, tackler, 'strip', { rng: createRng(1), ballSecurityAssist: 1 });
    expect(assisted.fumbleChance).toBeLessThan(strip.fumbleChance);
    const secure = makeAthlete({ attrs: { carrying: 99 }, vel: { x: 0, y: 6 } });
    expect(tackleContest(secure, tackler, 'strip', { rng: createRng(1) }).fumbleChance).toBeLessThan(strip.fumbleChance);
    const fumbles = share(runTackles(carrier, tackler, 'strip', 9), 'fumble');
    expect(fumbles).toBeGreaterThan(0.05);
    expect(fumbles).toBeLessThan(0.2);
    expect(share(runTackles(carrier, tackler, 'wrap', 9), 'fumble')).toBeLessThan(fumbles / 2);
  });

  it('hit-stick timing swings power, fumbles and whiffs', () => {
    const carrier = makeAthlete({ vel: { x: 0, y: 6 } });
    const tackler = makeAthlete({ vel: { x: 0, y: -6 } });
    const mk = (timing: number): ReturnType<typeof tackleContest> =>
      tackleContest(carrier, tackler, 'hitStick', { rng: createRng(2), hitStickTiming: timing });
    expect(mk(1).tacklePower).toBeGreaterThan(mk(0.5).tacklePower);
    expect(mk(1).fumbleChance).toBeGreaterThan(mk(0.5).fumbleChance);
    expect(mk(0.1).missChance).toBeCloseTo(0.55);
    expect(mk(0.9).missChance).toBeLessThan(0.2);
  });

  // Difficulty used to trim AI whiffs here; the spec keeps difficulty out of the dice (it lives in the AI's approach and
  // tackle choice), so the same roll now answers to the tackler's own technique instead.
  it('gang tackles add power; dives whiff more; a sure tackler whiffs less', () => {
    const carrier = makeAthlete({ vel: { x: 0, y: 6 } });
    const tackler = makeAthlete({ vel: { x: 0, y: -6 } });
    const solo = tackleContest(carrier, tackler, 'gang', { rng: createRng(1), assistCount: 0 });
    const gang = tackleContest(carrier, tackler, 'gang', { rng: createRng(1), assistCount: 2 });
    expect(gang.tacklePower).toBeGreaterThan(solo.tacklePower + 0.2);
    const dive = tackleContest(carrier, tackler, 'dive', { rng: createRng(1) });
    const wrap = tackleContest(carrier, tackler, 'wrap', { rng: createRng(1) });
    expect(dive.missChance).toBeGreaterThan(wrap.missChance);
    const sure = makeAthlete({ vel: { x: 0, y: -6 }, attrs: { tackling: 99, awareness: 95 } });
    const shaky = makeAthlete({ vel: { x: 0, y: -6 }, attrs: { tackling: 35, awareness: 40 } });
    expect(tackleContest(carrier, sure, 'dive', { rng: createRng(1) }).missChance).toBeLessThan(tackleContest(carrier, shaky, 'dive', { rng: createRng(1) }).missChance);
  });

  it('credits the active special move on a broken tackle and wears the carrier down', () => {
    expect(breakMoveFor(makeAthlete({ state: 'juking' }))).toBe('juke');
    expect(breakMoveFor(makeAthlete({ state: 'spinning' }))).toBe('spin');
    expect(breakMoveFor(makeAthlete({ state: 'trucking' }))).toBe('truck');
    expect(breakMoveFor(makeAthlete({ state: 'moving', vel: { x: 0, y: 9 } }))).toBe('burst');
    expect(breakMoveFor(makeAthlete({ state: 'moving', vel: { x: 0, y: 3 } }))).toBe('none');
    const fresh = makeAthlete();
    const worn = makeAthlete({ brokenTacklesThisPlay: 3 });
    expect(carrierPower(worn)).toBeLessThan(carrierPower(fresh));
    expect(carrierPower(makeAthlete({ state: 'trucking' }))).toBeGreaterThan(carrierPower(fresh));
    expect(carrierPower(makeAthlete({ state: 'stumbling' }))).toBeLessThan(carrierPower(fresh));
  });
});

describe('blockContest', () => {
  const runBlocks = (blocker: Athlete, rusher: Athlete, kind: 'run' | 'pass', seed: number): Record<'engaged' | 'pancake' | 'shed' | 'stalemate', number> => {
    const rng = createRng(seed);
    return tally(N, () => blockContest(blocker, rusher, kind, rng).result);
  };

  it('a dominant blocker holds or pancakes; a dominant rusher sheds', () => {
    const wall = makeAthlete({ attrs: { blocking: 99, strength: 90 }, pos: { x: 26, y: 30 }, massLb: 320 });
    const scrub = makeAthlete({ attrs: { passRush: 30, strength: 40 }, pos: { x: 26, y: 31 }, massLb: 250 });
    const r = runBlocks(wall, scrub, 'pass', 1);
    expect(((r.engaged ?? 0) + (r.pancake ?? 0)) / N).toBeGreaterThan(0.8);
    expect((r.pancake ?? 0)).toBeGreaterThan(0);
    const turnstile = makeAthlete({ attrs: { blocking: 30, strength: 40 }, pos: { x: 26, y: 30 } });
    const star = makeAthlete({ attrs: { passRush: 99, strength: 90 }, pos: { x: 26, y: 31 } });
    const s = runBlocks(turnstile, star, 'pass', 2);
    expect((s.shed ?? 0) / N).toBeGreaterThan(0.8);
  });

  it('push runs blocker -> rusher when the blocker wins and rusher -> blocker when the rusher drives through', () => {
    // Blocker always at y=30 facing a rusher at y=31, so blocker -> rusher is +y.
    const wall = makeAthlete({ attrs: { blocking: 99, strength: 99, balance: 99 }, pos: { x: 26, y: 30 } });
    const scrub = makeAthlete({ attrs: { passRush: 1, strength: 1, agility: 1 }, pos: { x: 26, y: 31 } });
    const r = blockContest(wall, scrub, 'pass', createRng(3));
    expect(r.result).toBe('pancake');
    expect(r.pushVec.y).toBeGreaterThan(0);
    expect(r.pushVec.x).toBeCloseTo(0);
    const turnstile = makeAthlete({ attrs: { blocking: 1, strength: 1, balance: 1 }, pos: { x: 26, y: 30 } });
    const star = makeAthlete({ attrs: { passRush: 99, strength: 99, agility: 99 }, pos: { x: 26, y: 31 } });
    const shed = blockContest(turnstile, star, 'pass', createRng(3));
    expect(shed.result).toBe('shed');
    expect(shed.pushVec.y).toBeLessThan(0);
    const rng = createRng(4);
    const even = tally(N, () => blockContest(makeAthlete({ pos: { x: 26, y: 30 } }), makeAthlete({ pos: { x: 26, y: 31 } }), 'run', rng).result);
    expect((even.stalemate ?? 0) / N).toBeGreaterThan(0.3);
  });
});

describe('catchContest', () => {
  const rates = (receiver: Athlete, defenders: Athlete[], height: number, type: ThrowType, seed: number, assist = 0): Record<CatchResult, number> => {
    const rng = createRng(seed);
    return tally(N, () => catchContest(receiver, defenders, height, type, rng, assist).result);
  };

  it('uncontested balls are mostly caught, better hands catch more, drops are the only failure', () => {
    const wr = makeAthlete({ attrs: { catching: 80, hands: 80 }, pos: { x: 26, y: 50 } });
    const r = rates(wr, [], 1.5, 'bullet', 1);
    expect((r.catch ?? 0) / N).toBeGreaterThan(0.85);
    expect(r.interception ?? 0).toBe(0);
    expect(r.defended ?? 0).toBe(0);
    const stone = makeAthlete({ attrs: { catching: 30, hands: 30 }, pos: { x: 26, y: 50 } });
    expect((rates(stone, [], 1.5, 'bullet', 2).catch ?? 0)).toBeLessThan(r.catch ?? 0);
    expect((rates(stone, [], 1.5, 'bullet', 2, 1).catch ?? 0)).toBeGreaterThan(rates(stone, [], 1.5, 'bullet', 2).catch ?? 0);
  });

  it('a tight, elite defender makes it contested and produces breakups and picks', () => {
    const wr = makeAthlete({ attrs: { catching: 75, hands: 75 }, pos: { x: 26, y: 50 } });
    const cb = makeAthlete({ attrs: { coverage: 95, reaction: 90, hands: 80, jumping: 85 }, pos: { x: 26.3, y: 50 }, side: 'defense', id: 'def:CB1' });
    const r = rates(wr, [cb], 1.5, 'lob', 3);
    expect((r.catch ?? 0) / N).toBeLessThan(0.7);
    expect(r.interception ?? 0).toBeGreaterThan(0);
    expect(r.defended ?? 0).toBeGreaterThan(0);
    expect(r.tip ?? 0).toBeGreaterThan(0);
    const one = catchContest(wr, [cb], 1.5, 'lob', createRng(1), 0);
    expect(one.contested).toBe(true);
    expect(one.defenderId).toBe('def:CB1');
    const farCb = makeAthlete({ ...cb, pos: { x: 30, y: 50 } });
    expect(catchContest(wr, [farCb], 1.5, 'lob', createRng(1), 0).contested).toBe(false);
    const inactive = makeAthlete({ ...cb, active: false });
    expect(catchContest(wr, [inactive], 1.5, 'lob', createRng(1), 0).contested).toBe(false);
  });

  it('contested balls: sure hands win more of them (the catch-rating slope)', () => {
    const cb = makeAthlete({ attrs: { coverage: 80, reaction: 80, hands: 60, jumping: 75 }, pos: { x: 26.4, y: 50 }, side: 'defense' });
    const hands = (v: number): Athlete => makeAthlete({ attrs: { catching: v, hands: v }, pos: { x: 26, y: 50 } });
    const catches = (v: number): number => rates(hands(v), [cb], 1.5, 'touch', 6).catch ?? 0;
    expect(catchContest(hands(50), [cb], 1.5, 'touch', createRng(1), 0).contested).toBe(true);
    expect(catches(95)).toBeGreaterThan(catches(70) + 0.05 * N);
    expect(catches(70)).toBeGreaterThan(catches(45) + 0.05 * N);
  });

  it('a defender who only swats at it (or never turned to it) picks off fewer than one who goes for the ball', () => {
    const wr = makeAthlete({ attrs: { catching: 70, hands: 70 }, pos: { x: 26, y: 50 } });
    const cb = makeAthlete({ attrs: { coverage: 95, reaction: 90, hands: 85, jumping: 85 }, pos: { x: 26.3, y: 50 }, side: 'defense' });
    const picks = (share: number): number => {
      const rng = createRng(7);
      return tally(N, () => catchContest(wr, [cb], 1.5, 'lob', rng, 0, () => share).result).interception ?? 0;
    };
    expect(picks(1)).toBeGreaterThan(picks(0.4) * 1.5);
  });

  it('back-shoulder throws are harder to defend than lobs', () => {
    const wr = makeAthlete({ attrs: { catching: 75, hands: 75 }, pos: { x: 26, y: 50 } });
    const cb = makeAthlete({ attrs: { coverage: 85, reaction: 80 }, pos: { x: 26.4, y: 50 }, side: 'defense' });
    const lob = rates(wr, [cb], 1.5, 'lob', 4);
    const back = rates(wr, [cb], 1.5, 'backShoulder', 4);
    expect(back.catch ?? 0).toBeGreaterThan(lob.catch ?? 0);
  });

  it('reach: balls above the receiver are unreachable and never caught; jumping extends reach', () => {
    const wr = makeAthlete({ heightIn: 72, attrs: { jumping: 50 }, pos: { x: 26, y: 50 } });
    expect(standingReach(wr)).toBeCloseTo(2.85);
    expect(reachHeight(wr)).toBeGreaterThan(standingReach(wr));
    expect(reachHeight(makeAthlete({ heightIn: 72, attrs: { jumping: 99 } }))).toBeGreaterThan(reachHeight(wr));
    const out = catchContest(wr, [], reachHeight(wr) + 0.5, 'highPoint', createRng(1), 0);
    expect(out.reachable).toBe(false);
    expect(out.result).toBe('drop');
    expect(out.catchChance).toBe(0);
    const high = rates(wr, [], 3.0, 'highPoint', 5);
    const chest = rates(wr, [], 1.5, 'bullet', 5);
    expect(high.catch ?? 0).toBeLessThan(chest.catch ?? 0);
  });

  it('classifies the catch kind from height, position, motion and contest', () => {
    const rng = createRng(1);
    const mk = (over: Parameters<typeof makeAthlete>[0]): Athlete => makeAthlete({ attrs: { catching: 99, hands: 99 }, pos: { x: 26, y: 50 }, ...over });
    expect(catchContest(mk({}), [], 3, 'highPoint', rng, 0).catchKind).toBe('highPoint');
    expect(catchContest(mk({ pos: { x: 0.8, y: 50 } }), [], 1.5, 'bullet', rng, 0).catchKind).toBe('sideline');
    expect(catchContest(mk({ vel: { x: 0, y: 7 } }), [], 1.5, 'bullet', rng, 0).catchKind).toBe('rac');
    expect(catchContest(mk({}), [], 0.3, 'touch', rng, 0).catchKind).toBe('diving');
    expect(catchContest(mk({ state: 'diving' }), [], 1.5, 'touch', rng, 0).catchKind).toBe('diving');
    expect(catchContest(mk({}), [], 1.5, 'bullet', rng, 0).catchKind).toBe('possession');
    const cb = makeAthlete({ pos: { x: 26.2, y: 50 }, side: 'defense' });
    expect(catchContest(mk({ vel: { x: 0, y: 7 } }), [cb], 1.5, 'bullet', rng, 0).catchKind).toBe('possession');
  });

  it('throwaways are essentially never caught', () => {
    const wr = makeAthlete({ attrs: { catching: 99, hands: 99 }, pos: { x: 26, y: 50 } });
    const r = rates(wr, [], 1.0, 'throwAway', 6);
    expect((r.catch ?? 0) / N).toBeLessThan(0.25);
    expect((r.catch ?? 0)).toBeGreaterThan(0);
  });
});
