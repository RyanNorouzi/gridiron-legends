import { describe, expect, it } from 'vitest';
import { registerAll } from '@/ai/register';
import { vec2 } from '@/core/vec2';
import { idleIntent, moveIntent } from '@/game/engine-api';
import { getDifficulty } from '@/game/rulesets';
import { STOOD_UP_SECONDS } from '@/game/systems/tackle-struggle';
import { driveBack, eventsOf, posePile, runPile, type PoseOptions, type Trace } from './struggle-harness';

registerAll();

/**
 * The tackle struggle in the live engine (systems/tackle-struggle.ts): a hand-posed hold on a real play (defense
 * cleared, scripted intents), then the engine's own pile physics, dice and rulings.
 */

interface Run { trace: Trace; dir: number; start: number; spot: number; events: string[]; reason: string | null; pbp: string[] }

const runSeeds = (seeds: number[], o: Omit<PoseOptions, 'seed'>): Run[] => {
  const out: Run[] = [];
  for (const seed of seeds) {
    const p = posePile({ seed, ...o });
    if (!p) continue;
    const trace = runPile(p);
    const s = p.built.engine.state;
    out.push({
      trace, dir: s.ctx.direction, start: p.start.y, spot: s.deadSpot!.y, events: s.events.map((e) => e.type), reason: s.deadReason,
      pbp: trace.outcome.playByPlay,
    });
  }
  return out;
};

const seeds = (n: number, from = 1): number[] => Array.from({ length: n }, (_, i) => from + i);
const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
/** Yards the carrier gained while held in the first struggle. */
const drag = (r: Run): number => r.dir * (r.trace.bestY - r.start);

const HEAVY_BACK = { massLb: 235, attrs: { strength: 92, balance: 88, acceleration: 85, carrying: 85 } };
const SMALL_CORNER = { massLb: 180, attrs: { strength: 50, balance: 60, tackling: 60 } };
const SMALL_BACK = { massLb: 185, attrs: { strength: 55, balance: 60 } };
const BIG_BACKER = { massLb: 250, attrs: { strength: 92, balance: 85, tackling: 90 } };

describe('contact starts a struggle, not a whistle', () => {
  it('a heavy back churning upfield drags a small corner for yards after contact', () => {
    const heavy = runSeeds(seeds(16), { tacklerIds: ['def:CB1'], kind: 'arm', hold: 0.6, carrierBody: HEAVY_BACK, tacklerBody: SMALL_CORNER });
    // The same grab the other way round: a small back caught by a big linebacker (same speeds, same dice).
    const small = runSeeds(seeds(16), { tacklerIds: ['def:CB1'], kind: 'arm', hold: 0.6, carrierBody: SMALL_BACK, tacklerBody: BIG_BACKER });
    expect(heavy.length).toBeGreaterThan(12);
    expect(mean(heavy.map(drag))).toBeGreaterThan(1.5);
    expect(mean(heavy.map(drag))).toBeGreaterThan(mean(small.map(drag)) * 1.5);
    // Yards per second held: the pile moves faster the more the runner out-weighs and out-drives the tackler.
    const rate = (rs: Run[]): number => mean(rs.filter((r) => r.trace.held > 0.3).map((r) => drag(r) / r.trace.held));
    expect(rate(heavy)).toBeGreaterThan(rate(small));
    // He is held, not whistled: every run starts with a wrap-up and the tackle comes only after the fight.
    for (const r of heavy) expect(r.events).toContain('wrapUp');
    expect(heavy.some((r) => r.pbp.some((l) => / drags .* for \d+ more yards?/.test(l)))).toBe(true);
  });

  it('a big linebacker squaring up a slowed back stops him or drives him back, and the spot is his furthest point', () => {
    const runs = runSeeds(seeds(16), {
      tacklerIds: ['def:MLB'], kind: 'hitStick', hold: 1.3, carrierBody: SMALL_BACK, tacklerBody: BIG_BACKER,
      carrierVel: vec2(0, 0), tacklerVel: vec2(0, 0), after: 0.6,
    }).map((r) => r);
    expect(runs.length).toBeGreaterThan(12);
    for (const r of runs) expect(drag(r)).toBeLessThan(0.3);
    const drivenBack = runs.filter((r) => r.dir * (r.trace.lastY - r.trace.bestY) < -0.1);
    expect(drivenBack.length).toBeGreaterThan(runs.length / 3);
    // Forward progress: the ball goes where he got to, never where he was driven back to.
    for (const r of runs.filter((x) => x.reason === 'tackle' && x.events.filter((e) => e === 'brokenTackle').length === 0)) {
      expect(Math.abs(r.dir * (r.spot - r.trace.bestY))).toBeLessThan(0.07);
      expect(r.dir * (r.spot - r.trace.lastY)).toBeGreaterThanOrEqual(0);
    }
  });

  it('two and three defenders finish the tackle quickly and the runner almost never escapes', () => {
    const one = runSeeds(seeds(16), { tacklerIds: ['def:MLB'] });
    const gang = runSeeds(seeds(16), { tacklerIds: ['def:MLB', 'def:SS', 'def:CB1'] });
    expect(mean(gang.map((r) => r.trace.held))).toBeLessThan(mean(one.map((r) => r.trace.held)));
    expect(mean(gang.map((r) => r.trace.held))).toBeLessThan(0.5);
    expect(gang.filter((r) => r.events.includes('brokenTackle')).length).toBeLessThanOrEqual(1);
    const tackles = gang.filter((r) => r.reason === 'tackle');
    expect(tackles.length).toBeGreaterThan(12);
    expect(tackles.every((r) => r.trace.outcome.tacklerIds.length === 3)).toBe(true);
    expect(tackles.some((r) => r.pbp.some((l) => /gang tackle by .+, .+ and .+/.test(l)))).toBe(true);
  });

  it('a runner stood up with no forward progress is whistled down at his furthest point after about a second', () => {
    const still = { 'off:RB': () => idleIntent('stood up'), 'def:MLB': () => ({ ...idleIntent('hold'), action: 'tackle' as const }) };
    const runs = runSeeds(seeds(30), { tacklerIds: ['def:MLB'], hold: 0.7, carrierVel: vec2(0, 0), tacklerVel: vec2(0, 0), script: still });
    const stood = runs.filter((r) => r.events.includes('forwardProgressStopped'));
    expect(stood.length).toBeGreaterThanOrEqual(3);
    for (const r of stood) {
      expect(r.reason).toBe('forwardProgress');
      expect(r.trace.held).toBeGreaterThan(STOOD_UP_SECONDS * 0.8);
      expect(r.trace.held).toBeLessThan(1.25);
      expect(Math.abs(r.dir * (r.spot - r.trace.bestY))).toBeLessThan(0.07);
      expect(r.pbp.some((l) => / is stood up at /.test(l))).toBe(true);
    }
    // Nobody is held forever: every struggle ends within the cap.
    for (const r of runs) expect(r.trace.held).toBeLessThan(2.3);
  });

  it('a runner dragged out of bounds is out where he crossed the sideline', () => {
    const runs = runSeeds(seeds(12), {
      tacklerIds: ['def:CB1'], hold: 0.8, at: (p) => vec2(1.0, p.y), carrierVel: vec2(-3, 0), tacklerVel: vec2(-2, 0),
      script: { 'off:RB': (_a, s) => moveIntent(vec2(-1, 0.3 * s.ctx.direction), true), 'def:CB1': (_a, s) => driveBack(s, vec2(-1, 0)) },
    });
    const out = runs.filter((r) => r.reason === 'outOfBounds');
    expect(out.length).toBeGreaterThan(runs.length * 0.7);
    for (const r of out) {
      expect(r.trace.outcome.endBallX).toBeCloseTo(0, 5);
      expect(r.trace.outcome.outOfBounds).toBe(true);
      // The crossing spot, a step or so from where he was held.
      expect(Math.abs(r.spot - r.start)).toBeLessThan(1);
    }
  });

  it('a second defender punching at the ball can strip it in the pile; nobody else jars it loose', () => {
    const loose = { attrs: { carrying: 1 } };
    const punch = { 'def:SS': (_a: unknown, s: Parameters<typeof driveBack>[0]) => driveBack(s, undefined, 'strip') };
    const found: string[] = [];
    for (let seed = 1; seed <= 150 && found.length < 2; seed++) {
      const p = posePile({ seed, tacklerIds: ['def:MLB', 'def:SS'], carrierBody: loose, script: punch });
      if (!p) continue;
      runPile(p);
      const f = eventsOf(p, 'fumble')[0];
      if (f && f.type === 'fumble') found.push(f.forcedBy ?? 'none');
    }
    expect(found).toEqual(['def:SS', 'def:SS']);
    const quiet = runSeeds(seeds(40), { tacklerIds: ['def:MLB', 'def:SS'], carrierBody: loose });
    expect(quiet.filter((r) => r.events.includes('fumble'))).toHaveLength(0);
  });

  it('is deterministic per seed', () => {
    const o: Omit<PoseOptions, 'seed'> = { tacklerIds: ['def:MLB', 'def:SS'], kind: 'arm', hold: 0.6, carrierBody: HEAVY_BACK };
    const fp = (r: Run[]): string => JSON.stringify(r.map((x) => [x.spot, x.reason, x.events, x.trace.held]));
    expect(fp(runSeeds([3, 4, 5], o))).toBe(fp(runSeeds([3, 4, 5], o)));
  });

  it('difficulty never touches the struggle dice or the pile physics', () => {
    const o = (id: 'rookie' | 'legend'): Omit<PoseOptions, 'seed'> => ({
      tacklerIds: ['def:MLB', 'def:SS'], kind: 'arm', hold: 0.6, carrierBody: HEAVY_BACK, patch: { difficulty: getDifficulty(id) },
    });
    const fp = (r: Run[]): string => JSON.stringify(r.map((x) => [x.spot, x.reason, x.events, x.trace.held, x.trace.bestY]));
    expect(fp(runSeeds(seeds(8), o('legend')))).toBe(fp(runSeeds(seeds(8), o('rookie'))));
  });
});

describe('the passer in the grasp', () => {
  const throwIt = { 'off:QB': () => ({ ...idleIntent('throw'), action: 'throw' as const, targetId: 'off:WR1', throwType: 'bullet' as const }) };
  const qb = (hold: number): Omit<PoseOptions, 'seed'> => ({
    offensePlayId: 'shotgun-mesh', carrierId: 'off:QB', after: 0.8, tacklerIds: ['def:MLB'], kind: hold < 0.9 ? 'arm' : 'wrap', hold, script: throwIt,
  });

  it('a flimsy grab lets him get a hurried throw off; a square wrap is a sack', () => {
    const grabbed = runSeeds(seeds(12), qb(0.55));
    const thrown = grabbed.filter((r) => r.events.includes('throw'));
    expect(thrown.length).toBeGreaterThan(grabbed.length * 0.6);
    for (const r of thrown) {
      expect(r.events).not.toContain('sack');
      const ev = r.trace.outcome.events.find((e) => e.type === 'throw');
      expect(ev && ev.type === 'throw' ? ev.difficulty : 0).toBeGreaterThan(0.4);
    }
    const wrapped = runSeeds(seeds(12), qb(1));
    // Only a runner who breaks free first gets a throw away.
    for (const r of wrapped.filter((x) => !x.events.includes('brokenTackle'))) {
      expect(r.events).not.toContain('throw');
      expect(r.events).toContain('sack');
      expect(r.trace.outcome.result).toBe('sack');
    }
    expect(wrapped.filter((r) => r.events.includes('sack')).length).toBeGreaterThan(wrapped.length * 0.7);
  });

  it('a passer held up behind the line is narrated as a sack, never as stood up', () => {
    const still = { 'off:QB': () => idleIntent('frozen'), 'def:MLB': () => ({ ...idleIntent('hold'), action: 'tackle' as const }) };
    const runs = runSeeds(seeds(60), { ...qb(0.7), script: still, carrierVel: vec2(0, 0), tacklerVel: vec2(0, 0) });
    const stood = runs.filter((r) => r.events.includes('forwardProgressStopped') && r.events.includes('sack'));
    expect(stood.length).toBeGreaterThanOrEqual(2);
    for (const r of stood) {
      expect(r.pbp.some((l) => /SACKED by /.test(l))).toBe(true);
      expect(r.pbp.some((l) => / is stood up at /.test(l))).toBe(false);
      // The result line says where he went down, not a second tackle by the same men.
      expect(r.pbp.some((l) => / sacked at .*, loss of /.test(l))).toBe(true);
      expect(r.pbp.some((l) => / tackled at /.test(l))).toBe(false);
    }
  });
});
