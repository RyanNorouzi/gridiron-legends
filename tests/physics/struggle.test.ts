import { describe, expect, it } from 'vitest';
import { createRng, type Rng } from '@/core/rng';
import type { Athlete } from '@/game/play-types';
import type { BreakMove, TackleKind } from '@/game/play-events';
import { contactStart, holdStrength } from '@/physics/contact';
import {
  breakMoveBoost, CARRIER_DRIVE, legDrive, mergeVelocity, pileStep, PILE_MAX_SPEED, PUSHER_DRIVE, struggleRates, struggleTick, TACKLER_DRIVE,
  WRAP_MOMENTUM, type PileBody, type PileHold, type StruggleInput,
} from '@/physics/struggle';
import { makeAthlete } from './helpers';

const DT = 1 / 60;
/** The engine's cap on a struggle (systems/tackle-struggle.ts MAX_STRUGGLE_SECONDS). */
const CAP = 2.2;

const input = (carrier: Athlete, holds: PileHold[], over: Partial<StruggleInput> = {}): StruggleInput => ({
  carrier, holds, heldFor: 0, breakMove: null, failedBreaks: 0, pushers: 0, ballSecurityAssist: 0, dt: DT, ...over,
});

interface Tally { finish: number; break: number; strip: number; timeout: number; meanSeconds: number }

/**
 * Plays `n` struggles tick by tick with the pure dice (no bodies): the first holder grips with `hold`, every extra
 * defender with 0.9. `move` is tried from 0.2 s to 0.5 s into the hold.
 */
const simulate = (carrier: Athlete, tacklers: Athlete[], kind: TackleKind, hold: number, opts: { move?: BreakMove; seed?: number; n?: number } = {}): Tally => {
  const n = opts.n ?? 2000;
  const rng = createRng(opts.seed ?? 7);
  const out: Tally = { finish: 0, break: 0, strip: 0, timeout: 0, meanSeconds: 0 };
  let total = 0;
  for (let i = 0; i < n; i++) {
    let t = 0;
    let res: keyof Omit<Tally, 'meanSeconds'> = 'timeout';
    while (t < CAP) {
      const holds = tacklers.map((tk, j) => ({ tackler: tk, hold: j === 0 ? hold : 0.9, kind, stripping: false }));
      const move = opts.move && t > 0.2 && t < 0.5 ? opts.move : null;
      const r = struggleTick(input(carrier, holds, { heldFor: t, breakMove: move }), rng);
      t += DT;
      if (r.result !== 'hold') {
        res = r.result;
        break;
      }
    }
    out[res] += 1 / n;
    total += t;
  }
  out.meanSeconds = total / n;
  return out;
};

const even = (over: Parameters<typeof makeAthlete>[0] = {}): Athlete => makeAthlete({ base: 70, ...over });
const defender = (over: Parameters<typeof makeAthlete>[0] = {}): Athlete => makeAthlete({ base: 70, side: 'defense', ...over });
const starBack = (): Athlete => makeAthlete({ base: 70, massLb: 225, attrs: { balance: 92, strength: 88, carrying: 90, agility: 88 } });
const weakBack = (): Athlete => makeAthlete({ base: 55, massLb: 190, attrs: { balance: 50, strength: 50, carrying: 55 } });
const scrubTackler = (): Athlete => defender({ base: 55, massLb: 185, attrs: { tackling: 50, strength: 50 } });
const eliteTackler = (): Athlete => defender({ massLb: 245, attrs: { tackling: 95, strength: 90, balance: 85 } });

/** An Rng that counts every draw (whatever the method). */
const counting = (seed: number): { rng: Rng; draws: () => number } => {
  const inner = createRng(seed);
  let n = 0;
  const rng: Rng = {
    ...inner,
    next: () => { n += 1; return inner.next(); },
    chance: (p) => { n += 1; return inner.chance(p); },
    range: (lo, hi) => { n += 1; return inner.range(lo, hi); },
    int: (lo, hi) => { n += 1; return inner.int(lo, hi); },
    gaussian: (m, s) => { n += 1; return inner.gaussian(m, s); },
  };
  return { rng, draws: () => n };
};

describe('struggle dice (physics/struggle.ts)', () => {
  it('between even athletes a square wrap usually holds and lasts a few tenths of a second', () => {
    const r = simulate(even(), [defender()], 'wrap', holdStrength('wrap', 0));
    expect(r.finish).toBeGreaterThan(0.85);
    expect(r.break).toBeGreaterThan(0.02);
    expect(r.break).toBeLessThan(0.12);
    expect(r.meanSeconds).toBeGreaterThan(0.3);
    expect(r.meanSeconds).toBeLessThan(1.5);
  });

  it('an arm tackle is a weaker hold: more breaks and a longer fight than a wrap', () => {
    const wrap = simulate(even(), [defender()], 'wrap', holdStrength('wrap', 0));
    const arm = simulate(even(), [defender()], 'arm', holdStrength('arm', 0));
    expect(arm.break).toBeGreaterThan(wrap.break * 2);
    expect(arm.meanSeconds).toBeGreaterThan(wrap.meanSeconds);
  });

  it('extra defenders finish quickly and make breaking free much harder', () => {
    const one = simulate(even(), [defender()], 'wrap', holdStrength('wrap', 0));
    const two = simulate(even(), [defender(), defender()], 'wrap', holdStrength('wrap', 0));
    const three = simulate(even(), [defender(), defender(), defender()], 'wrap', holdStrength('wrap', 0));
    expect(two.break).toBeLessThan(one.break / 3);
    expect(three.break).toBeLessThanOrEqual(two.break);
    expect(two.meanSeconds).toBeLessThan(one.meanSeconds);
    expect(three.meanSeconds).toBeLessThan(0.5);
    // Rates, not just outcomes: every extra man raises the finish rate and cuts the break rate.
    const holds = (k: number): PileHold[] => Array.from({ length: k }, () => ({ tackler: defender(), hold: 1, kind: 'wrap' as const, stripping: false }));
    const r1 = struggleRates(input(even(), holds(1)));
    const r2 = struggleRates(input(even(), holds(2)));
    expect(r2.finishRate).toBeGreaterThan(r1.finishRate);
    expect(r2.breakRate).toBeLessThan(r1.breakRate * 0.5);
  });

  it('break-free rates follow the ratings: a star back sheds a scrub, a weak back never escapes an elite tackler', () => {
    const starArm = simulate(starBack(), [scrubTackler()], 'arm', holdStrength('arm', -0.3), { move: 'truck' });
    expect(starArm.break).toBeGreaterThan(0.5);
    const starWrap = simulate(starBack(), [scrubTackler()], 'wrap', holdStrength('wrap', -0.3));
    expect(starWrap.break).toBeGreaterThan(0.25);
    expect(starWrap.break).toBeLessThan(0.7);
    const weak = simulate(weakBack(), [eliteTackler()], 'wrap', holdStrength('wrap', 0.3));
    expect(weak.finish).toBeGreaterThan(0.97);
    expect(weak.meanSeconds).toBeLessThan(0.5);
  });

  it('a dive trips him up or not at all, and a hit stick that held is a quick takedown', () => {
    const wrap = simulate(even(), [defender()], 'wrap', holdStrength('wrap', 0));
    const dive = simulate(even(), [defender()], 'dive', holdStrength('dive', 0));
    const hit = simulate(even(), [defender()], 'hitStick', holdStrength('hitStick', 0));
    expect(dive.meanSeconds).toBeLessThan(wrap.meanSeconds);
    expect(dive.break).toBeGreaterThan(wrap.break);
    expect(hit.meanSeconds).toBeLessThan(wrap.meanSeconds);
    expect(hit.finish).toBeGreaterThan(wrap.finish);
  });

  it('the longer he is held the likelier the tackle finishes; fatigue wears the runner down', () => {
    const holds: PileHold[] = [{ tackler: defender(), hold: 1, kind: 'wrap', stripping: false }];
    expect(struggleRates(input(even(), holds, { heldFor: 0.8 })).finishRate).toBeGreaterThan(struggleRates(input(even(), holds, { heldFor: 0 })).finishRate * 3);
    expect(struggleRates(input(even({ fatigue: 0.9 }), holds)).edge).toBeGreaterThan(struggleRates(input(even(), holds)).edge);
  });

  it('break moves: strength moves suit big backs, agility moves suit shifty ones, and each failure weakens the next', () => {
    const bruiser = makeAthlete({ base: 60, massLb: 240, attrs: { strength: 95, agility: 50 } });
    const scatback = makeAthlete({ base: 60, massLb: 180, attrs: { strength: 50, agility: 95 } });
    expect(breakMoveBoost(bruiser, 'truck', 0)).toBeGreaterThan(breakMoveBoost(bruiser, 'juke', 0));
    expect(breakMoveBoost(scatback, 'juke', 0)).toBeGreaterThan(breakMoveBoost(scatback, 'truck', 0));
    expect(breakMoveBoost(bruiser, null, 0)).toBe(1);
    const fresh = breakMoveBoost(bruiser, 'truck', 0);
    const third = breakMoveBoost(bruiser, 'truck', 2);
    expect(third).toBeGreaterThan(1);
    expect(third - 1).toBeLessThan((fresh - 1) * 0.5);
  });

  it('pushing teammates add resistance, two at most', () => {
    const holds: PileHold[] = [{ tackler: defender(), hold: 1, kind: 'wrap', stripping: false }];
    const e0 = struggleRates(input(even(), holds)).edge;
    const e2 = struggleRates(input(even(), holds, { pushers: 2 })).edge;
    const e5 = struggleRates(input(even(), holds, { pushers: 5 })).edge;
    expect(e2).toBeLessThan(e0);
    expect(e5).toBeCloseTo(e2, 10);
  });

  it('strips: only a defender punching at the ball can strip, loose carriers lose it more, the ball-security assist protects', () => {
    const quiet: PileHold[] = [{ tackler: defender(), hold: 1, kind: 'wrap', stripping: false }, { tackler: defender(), hold: 0.9, kind: 'wrap', stripping: false }];
    expect(struggleRates(input(even(), quiet)).stripRate).toBe(0);
    const punch: PileHold[] = [quiet[0]!, { ...quiet[1]!, stripping: true }];
    const secure = struggleRates(input(even({ attrs: { carrying: 95 } }), punch)).stripRate;
    const loose = struggleRates(input(even({ attrs: { carrying: 40 } }), punch)).stripRate;
    expect(loose).toBeGreaterThan(secure * 1.5);
    expect(struggleRates(input(even(), punch, { ballSecurityAssist: 1 })).stripRate).toBeLessThan(struggleRates(input(even(), punch)).stripRate * 0.5);
    // Over many struggles with a man punching the whole time, the ball comes out now and then (and is credited to him).
    const rng = createRng(3);
    let strips = 0;
    let credited = 0;
    for (let i = 0; i < 3000; i++) {
      for (let t = 0; t < CAP; t += DT) {
        const r = struggleTick(input(even(), punch, { heldFor: t }), rng);
        if (r.result === 'strip') {
          strips += 1;
          if (r.stripBy === punch[1]!.tackler) credited += 1;
        }
        if (r.result !== 'hold') break;
      }
    }
    expect(strips / 3000).toBeGreaterThan(0.002);
    expect(strips / 3000).toBeLessThan(0.05);
    expect(credited).toBe(strips);
  });

  it('draws exactly one number per tick and is deterministic per seed', () => {
    const holds: PileHold[] = [{ tackler: defender(), hold: 1, kind: 'wrap', stripping: true }];
    const c = counting(11);
    for (let i = 0; i < 50; i++) struggleTick(input(even(), holds, { heldFor: i * DT }), c.rng);
    expect(c.draws()).toBe(50);
    const seq = (seed: number): string[] => {
      const rng = createRng(seed);
      return Array.from({ length: 200 }, (_, i) => struggleTick(input(even(), holds, { heldFor: i * DT }), rng).result);
    };
    expect(seq(5)).toEqual(seq(5));
  });
});

describe('pile motion (momentum balance)', () => {
  const body = (a: Athlete, dir: { x: number; y: number }, drive: number, carried = true): PileBody => ({ massLb: a.massLb, dir, drive, carried });

  /** Moves a two-man pile for `seconds`; returns the runner's forward displacement and final velocity. */
  const drive = (rb: Athlete, tk: Athlete, hold: number, wrapShare: number, seconds: number): { dy: number; vy: number } => {
    let vel = mergeVelocity([rb, { massLb: tk.massLb, vel: { x: tk.vel.x * wrapShare, y: tk.vel.y * wrapShare } }]);
    let dy = 0;
    for (let t = 0; t < seconds; t += DT) {
      vel = pileStep(vel, [body(rb, { x: 0, y: 1 }, legDrive(rb) * CARRIER_DRIVE), body(tk, { x: 0, y: -1 }, legDrive(tk) * TACKLER_DRIVE * Math.min(1, hold))], DT);
      dy += vel.y * DT;
    }
    return { dy, vy: vel.y };
  };

  it('a heavy, strong back running downhill drags a small corner forward', () => {
    const rb = makeAthlete({ base: 75, massLb: 235, attrs: { strength: 92, balance: 88, acceleration: 85 }, vel: { x: 0, y: 6 } });
    const cb = defender({ base: 65, massLb: 180, attrs: { strength: 50, balance: 60 }, vel: { x: 0, y: -4 } });
    const r = drive(rb, cb, holdStrength('arm', -0.3), WRAP_MOMENTUM, 1);
    expect(r.dy).toBeGreaterThan(1.5);
    expect(r.vy).toBeGreaterThan(0.5);
  });

  it('a big linebacker hitting square stops a small back and drives him back', () => {
    const rb = makeAthlete({ base: 65, massLb: 185, attrs: { strength: 55, balance: 60 }, vel: { x: 0, y: 3 } });
    const lb = defender({ base: 80, massLb: 250, attrs: { strength: 92, balance: 85, acceleration: 80 }, vel: { x: 0, y: -7 } });
    const r = drive(rb, lb, holdStrength('hitStick', 0.3), 1, 1);
    expect(r.dy).toBeLessThan(0);
    expect(r.vy).toBeLessThan(0);
  });

  it('merging bodies keeps momentum, pushers add drive without mass, and the pile never outruns its cap', () => {
    const a = makeAthlete({ massLb: 200, vel: { x: 0, y: 6 } });
    const b = defender({ massLb: 200, vel: { x: 0, y: -2 } });
    expect(mergeVelocity([a, b]).y).toBeCloseTo(2, 10);
    const rb = even();
    const tk = defender();
    const stalemate = [body(rb, { x: 0, y: 1 }, 1), body(tk, { x: 0, y: -1 }, 1)];
    const alone = pileStep({ x: 0, y: 0 }, stalemate, DT);
    expect(alone.y).toBeCloseTo(0, 10);
    const pushed = pileStep({ x: 0, y: 0 }, [...stalemate, body(even(), { x: 0, y: 1 }, PUSHER_DRIVE, false)], DT);
    expect(pushed.y).toBeGreaterThan(0);
    let v = { x: 0, y: 3 };
    for (let i = 0; i < 600; i++) v = pileStep(v, [body(rb, { x: 0, y: 1 }, 5)], DT);
    expect(Math.hypot(v.x, v.y)).toBeLessThanOrEqual(PILE_MAX_SPEED + 1e-9);
  });
});

describe('contactStart (first contact)', () => {
  const tally = (carrier: Athlete, tackler: Athlete, kind: TackleKind, timing?: number, n = 3000): Record<string, number> => {
    const rng = createRng(21);
    const out: Record<string, number> = {};
    for (let i = 0; i < n; i++) {
      const r = contactStart(carrier, tackler, kind, timing === undefined ? { rng } : { rng, hitStickTiming: timing }).result;
      out[r] = (out[r] ?? 0) + 1 / n;
    }
    return out;
  };

  it('a square wrap gets hold far more often than an arm tackle, and contact alone never ends the play', () => {
    const c = even({ vel: { x: 0, y: 6 } });
    const t = defender({ vel: { x: 0, y: -5 } });
    const wrap = tally(c, t, 'wrap');
    const arm = tally(c, t, 'arm');
    expect(wrap.wrap ?? 0).toBeGreaterThan(0.75);
    expect(arm.wrap ?? 0).toBeLessThan(wrap.wrap ?? 0);
    expect(wrap.bigHit ?? 0).toBe(0);
    expect(Object.keys(wrap)).not.toContain('tackled');
  });

  it('a well-timed hit stick is mostly a big hit; a mistimed one whiffs half the time', () => {
    const c = even({ vel: { x: 0, y: 6 } });
    const t = defender({ massLb: 240, vel: { x: 0, y: -7 } });
    const good = tally(c, t, 'hitStick', 1);
    expect((good.bigHit ?? 0) + (good.fumble ?? 0)).toBeGreaterThan(0.5);
    const early = tally(c, t, 'hitStick', 0.2);
    expect(early.missed ?? 0).toBeGreaterThan(0.45);
    expect(holdStrength('hitStick', 0)).toBeGreaterThan(holdStrength('wrap', 0));
    expect(holdStrength('arm', 0)).toBeLessThan(holdStrength('wrap', 0));
  });
});
