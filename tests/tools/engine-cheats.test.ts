import { describe, expect, it } from 'vitest';
import { vec2 } from '@/core/vec2';
import { registerAll } from '@/ai/register';
import { idleIntent, moveIntent, type AthleteIntent, type DevHooks } from '@/game/engine-api';
import { assertValidOutcome } from '@/game/outcome-factory';
import type { Athlete, PlayState } from '@/game/play-types';
import { ahead, build, chaseBall, clearDefense, hasEvent, pursue, scripted, ticksSinceSnap, toward, trackBall } from '../game/engine/helpers';

/** Every defender closes on the ball carrier and tries to finish him. */
const swarm = (a: Athlete, s: PlayState): AthleteIntent => (a.side === 'defense' && s.ball.carrierId !== null ? { ...pursue(a, s), action: 'tackle' } : idleIntent('wait'));
const rbRun = { 'off:RB': (a: Athlete, s: PlayState): AthleteIntent => (a.hasBall ? ahead(s, 'offense') : toward(a, s.ball.pos)) };
const runPlay = { offensePlayId: 'iform-dive-right', defensePlayId: '43-cover3-zone', ruleset: 'arcade' as const };

const throwAt = (target: string, after: number) => (a: Athlete, s: PlayState): AthleteIntent =>
  (!a.hasBall || ticksSinceSnap(s) < after ? idleIntent('wait') : { ...idleIntent('throw'), action: 'throw', targetId: target, throwType: 'touch' });
const goRoute = (a: Athlete, s: PlayState): AthleteIntent =>
  (s.phase !== 'live' ? idleIntent('set') : !a.hasBall && s.ball.phase === 'inAir' && s.ball.targetId === a.id ? trackBall(a, s) : ahead(s, 'offense'));
const shadowCorner = (a: Athlete, s: PlayState): AthleteIntent => {
  if (s.phase !== 'live') return idleIntent('set');
  if (s.ball.phase === 'inAir') return chaseBall(a, s);
  return moveIntent(vec2(0, 0.65 * s.ctx.direction), false, 'run the route');
};
const coveredThrow = { 'off:QB': throwAt('off:WR2', 100), 'off:WR2': goRoute, 'def:CB2': shadowCorner };
const passPlay = { offensePlayId: 'shotgun-mesh', defensePlayId: '43-cover3-zone', ruleset: 'arcade' as const };

describe('dev hooks: no behaviour change without cheats', () => {
  it('same seed with no hooks, empty hooks and all-off hooks gives identical plays (real AI)', () => {
    registerAll();
    for (const seed of [3, 11]) {
      const runs = [undefined, {}, { godMode: false, infiniteStamina: false, freezeAi: false, side: 'home', commands: [] } satisfies DevHooks].map((dev) => {
        const { engine } = build({ offensePlayId: 'shotgun-mesh', defensePlayId: '43-cover2-man', seed, ruleset: 'arcade' }, {}, dev ? { dev } : {});
        const o = engine.run();
        return JSON.stringify({ o, pos: engine.state.athletes.map((a) => [a.id, a.pos.x, a.pos.y, a.fatigue, a.burst]), tick: engine.state.tick });
      });
      expect(runs[1]).toBe(runs[0]);
      expect(runs[2]).toBe(runs[0]);
    }
  });
});

describe('god mode', () => {
  it('the favoured carrier survives a swarm that tackles him without it, across seeds', () => {
    let tackledWithout = 0;
    for (let seed = 1; seed <= 6; seed++) {
      const decider = scripted(rbRun, swarm);
      const plain = build({ ...runPlay, seed }, {}, { decider }).engine;
      plain.run();
      if (plain.state.events.some((e) => e.type === 'tackle' && e.carrier === 'off:RB')) tackledWithout += 1;
      const god = build({ ...runPlay, seed }, {}, { decider, dev: { godMode: true, side: 'home' } }).engine;
      const o = assertValidOutcome(god.run());
      expect(god.state.events.some((e) => e.type === 'tackle')).toBe(false);
      expect(hasEvent(god, 'fumble')).toBe(false);
      expect(o.turnover).toBe(false);
      expect(god.state.deadReason).not.toBe('tackle');
      expect(o.tacklerIds).toEqual([]);
    }
    expect(tackledWithout).toBeGreaterThanOrEqual(5);
  });

  it('a favoured defender always wins the tackle: no broken or missed tackles, no fumbles', () => {
    for (let seed = 1; seed <= 6; seed++) {
      const { engine } = build({ ...runPlay, seed }, {}, { decider: scripted(rbRun, swarm), dev: { godMode: true, side: 'away' } });
      const o = assertValidOutcome(engine.run());
      expect(engine.state.deadReason).toBe('tackle');
      expect(hasEvent(engine, 'brokenTackle')).toBe(false);
      expect(hasEvent(engine, 'missedTackle')).toBe(false);
      expect(hasEvent(engine, 'fumble')).toBe(false);
      expect(o.tacklerIds.length).toBe(1);
      expect(o.turnover).toBe(false);
    }
  });

  it('the favoured passer is never intercepted or broken up; the favoured defense picks off contested balls', () => {
    let catches = 0;
    let picks = 0;
    for (let seed = 1; seed <= 12; seed++) {
      const off = build({ ...passPlay, seed }, {}, { decider: scripted(coveredThrow, clearDefense), dev: { godMode: true, side: 'home' } }).engine;
      assertValidOutcome(off.run());
      expect(hasEvent(off, 'interception')).toBe(false);
      expect(off.state.events.some((e) => e.type === 'incomplete' && (e.reason === 'defended' || e.reason === 'batted'))).toBe(false);
      if (hasEvent(off, 'catch')) catches += 1;
      const def = build({ ...passPlay, seed }, {}, { decider: scripted(coveredThrow, clearDefense), dev: { godMode: true, side: 'away' } }).engine;
      const o = assertValidOutcome(def.run());
      if (hasEvent(def, 'interception')) {
        picks += 1;
        expect(o.turnover).toBe(true);
        expect(o.turnoverType).toBe('interception');
      }
    }
    expect(catches).toBeGreaterThanOrEqual(10);
    expect(picks).toBeGreaterThanOrEqual(8);
  });
});

describe('god mode: sure hands', () => {
  /** Every chance() roll fails: without god mode each pitch and kick catch is muffed. */
  const butterFingers = (engine: { debugEnv: () => { rng: { chance: (p: number) => boolean } } }): void => {
    engine.debugEnv().rng.chance = () => false;
  };

  it('the favoured back cannot muff a pitch', () => {
    const run = (dev: DevHooks) => {
      const { engine } = build({ offensePlayId: 'iform-toss-right', defensePlayId: '43-cover3-zone', seed: 3, ruleset: 'arcade' }, {}, { decider: scripted(rbRun, () => idleIntent('idle')), dev });
      butterFingers(engine);
      return { engine, o: assertValidOutcome(engine.run()) };
    };
    const plain = run({});
    expect(hasEvent(plain.engine, 'pitch')).toBe(true);
    expect(hasEvent(plain.engine, 'fumble')).toBe(true);
    const god = run({ godMode: true, side: 'home' });
    expect(hasEvent(god.engine, 'pitch')).toBe(true);
    expect(hasEvent(god.engine, 'fumble')).toBe(false);
    expect(god.o.turnover).toBe(false);
    // Favouring the other team does not help the back.
    expect(hasEvent(run({ godMode: true, side: 'away' }).engine, 'fumble')).toBe(true);
  });

  it('the favoured returner cannot muff a kick', () => {
    const run = (dev: DevHooks) => {
      const { engine } = build({ offensePlayId: 'kickoff-deep', defensePlayId: 'kickReturn-middle', seed: 9, ballOn: 35, ruleset: 'arcade' }, { special: 'kickoff' }, {
        decider: scripted({ 'def:KR': (a, s) => (a.hasBall ? ahead(s, 'defense') : s.ball.phase === 'inAir' ? chaseBall(a, s) : idleIntent('wait')) }), dev,
      });
      butterFingers(engine);
      return { engine, o: assertValidOutcome(engine.run()) };
    };
    expect(hasEvent(run({}).engine, 'muff')).toBe(true);
    const god = run({ godMode: true, side: 'away' });
    expect(hasEvent(god.engine, 'muff')).toBe(false);
    expect(hasEvent(god.engine, 'fumble')).toBe(false);
    expect(god.o.turnover).toBe(false);
    // The kicking team's god mode never hands the returner sure hands.
    expect(hasEvent(run({ godMode: true, side: 'home' }).engine, 'muff')).toBe(true);
  });
});

describe('infinite stamina', () => {
  it('keeps the favoured team fresh during the play and in fatigueAfter; the other team still tires', () => {
    const fatigueIn = (ctx: { offenseLineup: Record<string, { id: string }>; defenseLineup: Record<string, { id: string }>; fatigue: Record<string, number> }): void => {
      for (const p of [...Object.values(ctx.offenseLineup), ...Object.values(ctx.defenseLineup)]) ctx.fatigue[p.id] = 0.4;
    };
    const decider = scripted(rbRun, (a, s) => (a.side === 'defense' ? pursue(a, s) : idleIntent('idle')));
    const plain = build({ ...runPlay, seed: 4 }, {}, { decider }, (ctx) => fatigueIn(ctx)).engine;
    const po = plain.run();
    const { engine } = build({ ...runPlay, seed: 4 }, {}, { decider, dev: { infiniteStamina: true, side: 'home' } }, (ctx) => fatigueIn(ctx));
    let minBurst = 1;
    while (!engine.isDead) {
      engine.tick();
      for (const a of engine.state.athletes) {
        if (a.teamSide !== 'home') continue;
        expect(a.fatigue).toBe(0);
        minBurst = Math.min(minBurst, a.burst);
        if (engine.state.phase === 'live') expect(a.attrs.speed).toBe(a.baseAttrs.speed);
      }
    }
    expect(minBurst).toBe(1);
    const o = assertValidOutcome(engine.outcome!);
    const rb = engine.state.athletes.find((a) => a.id === 'off:RB')!;
    expect(o.fatigueAfter[rb.playerId]).toBe(0);
    expect(po.fatigueAfter[rb.playerId]).toBeGreaterThan(0.4);
    for (const a of engine.state.athletes) {
      if (a.teamSide === 'home') expect(o.fatigueAfter[a.playerId]).toBe(0);
      else expect(o.fatigueAfter[a.playerId]).toBeGreaterThanOrEqual(0.4);
    }
    const sprinter = plain.state.athletes.find((a) => a.id === 'off:RB')!;
    expect(sprinter.burst).toBeLessThan(1);
  });
});

describe('freeze AI', () => {
  it('idles every athlete not under human control once the ball is live (the snap still happens)', () => {
    const decider = scripted({}, (a, s) => (a.side === 'defense' ? toward(a, s.ball.pos) : ahead(s, 'offense')));
    /** Mean defender displacement from the snap over the first 40 live ticks; checks the frozen intents on the way. */
    const drift = (dev: DevHooks | undefined): number => {
      const { engine } = build({ ...runPlay, seed: 2 }, {}, dev ? { decider, dev } : { decider });
      let snapPos: Map<string, { x: number; y: number }> | null = null;
      while (!engine.isDead && ticksSinceSnap(engine.state) < 40) {
        engine.tick();
        const s = engine.state;
        // The snap tick's intents were chosen pre-snap; from the next tick on everyone is frozen.
        if (s.phase !== 'live' || s.tick <= s.snapTick) continue;
        if (!snapPos) snapPos = new Map(s.athletes.map((a) => [a.id, { ...a.pos }]));
        if (dev?.freezeAi) for (const a of s.athletes) expect(s.intents[a.id]?.debug).toBe('dev: frozen');
      }
      expect(snapPos).not.toBeNull();
      const defenders = engine.state.athletes.filter((a) => a.side === 'defense');
      return defenders.reduce((sum, a) => sum + Math.hypot(a.pos.x - snapPos!.get(a.id)!.x, a.pos.y - snapPos!.get(a.id)!.y), 0) / defenders.length;
    };
    expect(drift({ freezeAi: true })).toBeLessThan(0.3);
    expect(drift(undefined)).toBeGreaterThan(1);
  });
});
