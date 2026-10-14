/**
 * Own-end-zone rulings on a change of possession are decided from the carrier's BODY, not the ball (which sits about
 * a yard in front of him at the catch): a returner who fields a kick just inside his end zone and is downed there
 * never left it (touchback, not a safety). The momentum exception: caught in the field inside the 5 and carried into
 * the end zone by the catch, he is spotted where he caught it; one who comes back out and is later downed in the end
 * zone concedes a safety.
 */
import { describe, expect, it } from 'vitest';
import { idleIntent } from '@/game/engine-api';
import { liveRules } from '@/game/live-rules';
import { holdBall } from '@/physics/ball';
import { carrierDown, ownGoalLineY, takePossession } from '@/game/systems/env';
import { kickFlightSystem } from '@/game/systems/kick-flight';
import { TICK_DT } from '@/core/time';
import { build } from './helpers';

const kickoffAt = () => {
  const { engine } = build({ offensePlayId: 'kickoff-deep', defensePlayId: 'kickReturn-middle', seed: 3, ballOn: 35 }, { special: 'kickoff' }, { decider: () => idleIntent('idle') });
  const state = engine.state;
  const env = engine.debugEnv();
  state.phase = 'live';
  const kr = state.athletes.find((a) => a.side === 'defense' && a.role === 'KR')!;
  const own = ownGoalLineY(env, 'defense');
  // The receiving team attacks away from its own goal line.
  const out = -env.dir;
  const field = (y: number): void => {
    kr.pos = { x: 26, y };
    kr.vel = { x: 0, y: 0 };
  };
  const catchIt = (): void => {
    state.ball = holdBall(state.ball, kr.id, state.tick, 'kickoff');
    state.ball.pos = { x: kr.pos.x, y: kr.pos.y + out * 1.1 };
    takePossession(state, env, kr);
  };
  const tick = (n = 1): void => {
    for (let i = 0; i < n; i++) {
      state.time += TICK_DT;
      state.tick += 1;
      liveRules(state, env, TICK_DT);
    }
  };
  return { state, env, kr, own, out, field, catchIt, tick };
};

describe('own end zone after a change of possession', () => {
  it('a returner fielding a kick 0.9 yd deep in his end zone and downed there is a touchback, not a safety', () => {
    const k = kickoffAt();
    // Body 0.9 yd deep; the ball in his hands is already past the goal line.
    k.field(k.own - k.out * 0.9);
    k.catchIt();
    k.tick(3);
    expect(k.state.phase).toBe('live');
    carrierDown(k.state, k.env, k.kr, { ...k.kr.pos }, 'tackle');
    expect(k.state.deadReason).toBe('touchback');
    expect(k.state.events.some((e) => e.type === 'safety')).toBe(false);
  });

  it('caught in the field at the 3 and carried into the end zone by the catch: spotted at the catch point', () => {
    const k = kickoffAt();
    k.field(k.own + k.out * 3);
    k.catchIt();
    k.tick();
    const catchY = k.kr.pos.y;
    k.field(k.own - k.out * 1);
    k.tick(20);
    carrierDown(k.state, k.env, k.kr, { ...k.kr.pos }, 'tackle');
    expect(k.state.deadReason).toBe('tackle');
    expect(k.state.deadSpot?.y).toBeCloseTo(catchY, 5);
  });

  it('a returner who left the end zone and is later downed back inside it concedes a safety', () => {
    const k = kickoffAt();
    k.field(k.own - k.out * 2);
    k.catchIt();
    k.tick();
    k.field(k.own + k.out * 4);
    k.tick(90);
    k.field(k.own - k.out * 1);
    k.tick();
    carrierDown(k.state, k.env, k.kr, { ...k.kr.pos }, 'tackle');
    expect(k.state.deadReason).toBe('safety');
  });

  it('a human returner who fields a kick just inside his end zone and stands there takes a knee (touchback)', () => {
    const k = kickoffAt();
    k.state.ctx.controllers = { home: 'human', away: 'human' };
    k.kr.controlled = true;
    k.env.kick = {
      kind: 'kickoff', kicker: k.kr.id, power: 1, accuracy: 1, kickTick: 0, kickSpot: { x: 26, y: 35 }, made: null, carry: 65,
      landing: null, fieldedBy: k.kr.id, returnStart: null, blocked: false, touchedByKickingTeam: false,
    };
    // Body 0.9 yd deep; the ball in his hands is already out in the field of play. He never leaves the end zone.
    k.field(k.own - k.out * 0.9);
    k.catchIt();
    for (let i = 0; i < 60 && k.state.phase === 'live'; i++) {
      kickFlightSystem(k.state, k.env, TICK_DT);
      k.tick();
    }
    expect(k.state.deadReason).toBe('touchback');
    expect(k.state.events.some((e) => e.type === 'kneel')).toBe(true);
  });
});
