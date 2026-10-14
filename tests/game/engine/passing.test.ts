import { describe, expect, it } from 'vitest';
import { vec2 } from '@/core/vec2';
import { idleIntent, moveIntent, type AthleteIntent } from '@/game/engine-api';
import { assertValidOutcome } from '@/game/outcome-factory';
import type { Athlete, PlayState } from '@/game/play-types';
import { THROW_WINDUP, throwDifficulty, throwWindup, USER_THROW_WINDUP } from '@/game/systems/passing';
import { ahead, build, chaseBall, clearDefense, hasEvent, scripted, ticksSinceSnap, trackBall } from './helpers';

const throwAt = (target: string, after: number, throwType: AthleteIntent['throwType'] = 'touch') => (a: Athlete, s: PlayState): AthleteIntent => {
  if (!a.hasBall || ticksSinceSnap(s) < after) return idleIntent('wait');
  return { ...idleIntent('throw'), action: 'throw', targetId: target, throwType };
};

const goRoute = (a: Athlete, s: PlayState): AthleteIntent => {
  if (s.phase !== 'live') return idleIntent('set');
  return !a.hasBall && s.ball.phase === 'inAir' && s.ball.targetId === a.id ? trackBall(a, s) : ahead(s, 'offense');
};

describe('passing', () => {
  it('completes most throws to an open receiver and credits passing / receiving stats', () => {
    let catches = 0;
    let plays = 0;
    for (let seed = 1; seed <= 12; seed++) {
      const { engine } = build({ offensePlayId: 'shotgun-mesh', defensePlayId: '43-cover3-zone', seed, ruleset: 'arcade' }, {}, {
        decider: scripted({ 'off:QB': throwAt('off:WR2', 40), 'off:WR2': goRoute }, clearDefense),
      });
      const o = engine.run();
      assertValidOutcome(o);
      plays += 1;
      expect(hasEvent(engine, 'throw')).toBe(true);
      expect(o.stats.some((d) => d.stat === 'passing.attempts')).toBe(true);
      expect(o.stats.some((d) => d.stat === 'receiving.targets')).toBe(true);
      if (hasEvent(engine, 'catch')) {
        catches += 1;
        expect(['pass']).toContain(o.result);
        expect(o.yards).toBeGreaterThan(3);
        expect(o.airYards).toBeGreaterThan(0);
        expect(o.receiverId).toBe(engine.state.athletes.find((x) => x.id === 'off:WR2')!.playerId);
        expect(o.stats.some((d) => d.stat === 'passing.completions')).toBe(true);
        expect(o.stats.some((d) => d.stat === 'receiving.receptions')).toBe(true);
      } else {
        expect(o.incomplete || o.turnover).toBe(true);
      }
    }
    expect(plays).toBe(12);
    expect(catches).toBeGreaterThanOrEqual(7);
  });

  it('a defender sitting on the route breaks up or picks off a plausible share of throws', () => {
    let catches = 0;
    let defended = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const { engine } = build({ offensePlayId: 'shotgun-mesh', defensePlayId: '43-cover3-zone', seed, ruleset: 'arcade' }, {}, {
        decider: scripted({
          'off:QB': throwAt('off:WR2', 100),
          'off:WR2': goRoute,
          'def:CB2': (a, s) => {
            if (s.phase !== 'live') return idleIntent('set');
            if (s.ball.phase === 'inAir') return chaseBall(a, s);
            return moveIntent(vec2(0, 0.65 * s.ctx.direction), false, 'run the route');
          },
        }, clearDefense),
      });
      const o = engine.run();
      assertValidOutcome(o);
      if (hasEvent(engine, 'catch')) catches += 1;
      if (hasEvent(engine, 'interception') || engine.state.events.some((e) => e.type === 'incomplete' && e.reason === 'defended')) defended += 1;
      if (hasEvent(engine, 'interception')) {
        expect(o.turnover).toBe(true);
        expect(o.turnoverType).toBe('interception');
        expect(o.result).toBe('interception');
        expect(o.yards).toBe(0);
        expect(o.stats.some((d) => d.stat === 'defense.interceptions')).toBe(true);
      }
    }
    expect(defended).toBeGreaterThanOrEqual(4);
    expect(catches).toBeLessThan(36);
    expect(catches).toBeGreaterThan(10);
  });

  it('a throw-away from outside the tackle box is incomplete with no grounding flag', () => {
    const { engine, ctx } = build({ offensePlayId: 'shotgun-mesh', defensePlayId: '43-cover3-zone', seed: 5, ruleset: 'arcade' }, {}, {
      decider: scripted({
        'off:QB': (a, s) => {
          if (!a.hasBall) return idleIntent('wait');
          if (Math.abs(a.pos.x - s.snapX) < 6) return moveIntent(vec2(s.ctx.direction, 0), true, 'roll');
          return { ...idleIntent('away'), action: 'throwAway', throwType: 'throwAway' };
        },
      }),
    });
    const o = engine.run();
    assertValidOutcome(o);
    expect(o.incomplete).toBe(true);
    expect(o.result).toBe('incomplete');
    expect(o.yards).toBe(0);
    expect(o.endBallOn).toBe(ctx.ballOn);
    expect(engine.state.events.some((e) => e.type === 'throw' && e.target === null)).toBe(true);
    expect(o.penalties.some((p) => p.foul === 'intentionalGrounding')).toBe(false);
    expect(o.stats.some((d) => d.stat === 'passing.throwaways')).toBe(true);
  });

  it('a throw-away from inside the box under pressure with nobody near is grounding', () => {
    let checked = 0;
    for (let seed = 6; seed <= 12 && checked === 0; seed++) {
      const { engine } = build({ offensePlayId: 'shotgun-mesh', defensePlayId: '43-cover3-zone', seed, ruleset: 'simulation' }, {}, {
        decider: scripted({
          'off:QB': (a, s) => {
            if (!a.hasBall) return idleIntent('wait');
            const rusher = s.athletes.find((x) => x.id === 'def:CB2')!;
            // Released as the (now faster) rusher closes inside the pressure radius, not after he has wrapped the QB up.
            if (Math.hypot(rusher.pos.x - a.pos.x, rusher.pos.y - a.pos.y) > 3.2) return idleIntent('wait');
            return { ...idleIntent('away'), action: 'throwAway', throwType: 'throwAway' };
          },
          'def:CB2': (a, s) => (s.phase === 'live' ? chaseBall(a, s) : idleIntent('set')),
        }),
      });
      const o = engine.run();
      assertValidOutcome(o);
      if (!hasEvent(engine, 'throw')) continue;
      checked += 1;
      expect(o.incomplete).toBe(true);
      expect(o.underPressure).toBe(true);
      expect(o.penalties.some((p) => p.foul === 'intentionalGrounding' && p.accepted === false && p.lossOfDown)).toBe(true);
    }
    expect(checked).toBe(1);
  });

  it('a pass thrown from beyond the line of scrimmage draws an illegal forward pass flag', () => {
    const { engine } = build({ offensePlayId: 'shotgun-mesh', defensePlayId: '43-cover3-zone', seed: 21, ruleset: 'arcade' }, {}, {
      decider: scripted({
        'off:QB': (a, s) => {
          if (!a.hasBall) return idleIntent('wait');
          if (s.ctx.direction * (a.pos.y - s.losY) < 1.5) return moveIntent(vec2(0.3, s.ctx.direction), true, 'scramble');
          return { ...idleIntent('throw'), action: 'throw', targetId: 'off:WR2', throwType: 'bullet' };
        },
        'off:WR2': goRoute,
      }, clearDefense),
    });
    const o = engine.run();
    assertValidOutcome(o);
    expect(hasEvent(engine, 'throw')).toBe(true);
    expect(o.penalties.some((p) => p.foul === 'illegalForwardPass')).toBe(false);
    let flagged = 0;
    for (let seed = 21; seed <= 26 && flagged === 0; seed++) {
      const sim = build({ offensePlayId: 'shotgun-mesh', defensePlayId: '43-cover3-zone', seed, ruleset: 'simulation' }, {}, {
        decider: scripted({
          'off:QB': (a, s) => {
            if (!a.hasBall) return idleIntent('wait');
            if (s.ctx.direction * (a.pos.y - s.losY) < 1.5) return moveIntent(vec2(0.3, s.ctx.direction), true, 'scramble');
            return { ...idleIntent('throw'), action: 'throw', targetId: 'off:WR2', throwType: 'bullet' };
          },
          'off:WR2': goRoute,
        }, clearDefense),
      });
      const so = sim.engine.run();
      if (!hasEvent(sim.engine, 'throw')) continue;
      flagged += 1;
      expect(so.penalties.some((p) => p.foul === 'illegalForwardPass' && p.lossOfDown && p.enforcement === 'spotOfFoul')).toBe(true);
    }
    expect(flagged).toBe(1);
  });

  it('an AI throw leaves after THROW_WINDUP, a human one on the press, and planting never erases the on-the-run cost', () => {
    let decided = -1;
    const { engine } = build({ offensePlayId: 'shotgun-mesh', defensePlayId: '43-cover3-zone', seed: 3, ruleset: 'arcade' }, {}, {
      decider: scripted({
        'off:QB': (a, s) => {
          if (!a.hasBall || ticksSinceSnap(s) < 0) return idleIntent('wait');
          if (ticksSinceSnap(s) < 40) return moveIntent(vec2(s.ctx.direction, 0), true, 'roll');
          if (decided < 0) decided = s.tick;
          return { ...idleIntent('throw'), action: 'throw', targetId: 'off:WR2', throwType: 'bullet' };
        },
        'off:WR2': goRoute,
      }, clearDefense),
    });
    for (let i = 0; i < 400 && !hasEvent(engine, 'throw') && !engine.isDead; i++) engine.tick();
    const thrown = engine.state.events.find((e) => e.type === 'throw');
    expect(thrown).toBeDefined();
    expect(thrown!.tick - decided).toBeGreaterThanOrEqual(Math.round(THROW_WINDUP * 60) - 1);
    const qb = engine.state.athletes.find((a) => a.id === 'off:QB')!;
    const wr = engine.state.athletes.find((a) => a.id === 'off:WR2')!;
    expect(throwWindup(engine.state, qb)).toBe(THROW_WINDUP);
    expect(USER_THROW_WINDUP).toBe(0);
    // The cost of throwing on the run comes from the speed the motion started at, not the planted speed at release.
    const aim = { x: wr.pos.x, y: wr.pos.y };
    const planted = throwDifficulty(engine.state, qb, wr, aim, 'bullet', vec2(0, 0)).difficulty;
    const onTheRun = throwDifficulty(engine.state, qb, wr, aim, 'bullet', vec2(6, 0)).difficulty;
    expect(planted).toBeLessThan(0.85);
    expect(onTheRun - planted).toBeCloseTo(0.15, 5);
  });

  it('is deterministic: the same context and inputs produce identical events and outcomes', () => {
    const make = () => build({ offensePlayId: 'shotgun-mesh', defensePlayId: '43-cover3-zone', seed: 77 }, {}, {
      decider: scripted({ 'off:QB': throwAt('off:WR2', 50, 'lob'), 'off:WR2': goRoute, 'def:CB2': chaseBall, 'def:FS': chaseBall }),
    });
    const a = make();
    const b = make();
    const oa = a.engine.run();
    const ob = b.engine.run();
    expect(JSON.stringify(a.engine.state.events)).toBe(JSON.stringify(b.engine.state.events));
    expect(oa).toEqual(ob);
    expect(a.engine.stepCount).toBe(b.engine.stepCount);
  });
});
