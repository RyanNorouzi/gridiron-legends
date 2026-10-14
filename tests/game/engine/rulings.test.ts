import { describe, expect, it } from 'vitest';
import { vec2 } from '@/core/vec2';
import { idleIntent, moveIntent } from '@/game/engine-api';
import { assertValidOutcome } from '@/game/outcome-factory';
import { NO_CONTACT_SECONDS } from '@/game/setup';
import { GANG_WINDOW } from '@/game/systems/tackle';
import { build, clearDefense, emptyInput, hasEvent, scripted, toward } from './helpers';

describe('rulings at the end of a dive', () => {
  it('a carrier who dives backward into his own end zone concedes a safety, not a plain dead ball', () => {
    const { engine } = build({ offensePlayId: 'iform-dive-right', defensePlayId: '43-cover3-zone', seed: 14, ballOn: 1, ruleset: 'arcade' }, {}, {
      decider: scripted({
        'off:RB': (a, s) => (a.hasBall ? { ...moveIntent(vec2(0, -s.ctx.direction), true), action: 'dive' } : toward(a, s.ball.pos)),
      }, clearDefense),
    });
    const o = engine.run();
    assertValidOutcome(o);
    expect(hasEvent(engine, 'tackle')).toBe(false);
    expect(o.safety).toBe(true);
    expect(engine.state.deadReason).toBe('safety');
    expect(o.endBallOn).toBe(0);
  });
});

describe('fresh contact timers', () => {
  it('nobody counts as freshly hit at the snap (no phantom gang-tackle assists)', () => {
    const { engine } = build({ offensePlayId: 'iform-dive-right', defensePlayId: '43-cover3-zone', seed: 1 });
    for (const a of engine.state.athletes) {
      expect(a.contactTimer).toBe(NO_CONTACT_SECONDS);
      expect(a.contactTimer).toBeGreaterThanOrEqual(GANG_WINDOW);
    }
  });
});

describe('kickoff play clock', () => {
  it('a human kicker who never presses draws delay of game when penalties are on', () => {
    const { engine } = build({ offensePlayId: 'kickoff-deep', defensePlayId: 'kickReturn-middle', seed: 2, ballOn: 35, userSide: 'home', ruleset: 'simulation' }, { special: 'kickoff' }, {
      decider: () => idleIntent('idle'),
    });
    expect(engine.state.controlledIds.home).toBe('off:K');
    const o = engine.run(() => ({ home: emptyInput() }), 60 * 45);
    expect(o.result).toBe('penalty');
    expect(o.penalties[0]?.foul).toBe('delayOfGame');
    expect(o.penalties[0]?.deadBall).toBe(true);
    expect(hasEvent(engine, 'kick')).toBe(false);
  });

  it('with penalties off the kick simply goes off the tee when the play clock expires', () => {
    const { engine, ctx } = build({ offensePlayId: 'kickoff-deep', defensePlayId: 'kickReturn-middle', seed: 2, ballOn: 35, userSide: 'home', ruleset: 'arcade' }, { special: 'kickoff' }, {
      decider: () => idleIntent('idle'),
    });
    const o = engine.run(() => ({ home: emptyInput() }), 60 * 45);
    assertValidOutcome(o);
    expect(o.result).toBe('kickoff');
    expect(o.penalties).toHaveLength(0);
    const kick = engine.state.events.find((e) => e.type === 'kick');
    expect(kick).toBeDefined();
    expect((kick!.tick) / 60).toBeGreaterThanOrEqual(ctx.ruleset.playClockSec);
  });
});

describe('called kneel with a human QB', () => {
  it('executes the kneel without a dedicated input', () => {
    const { engine } = build({ offensePlayId: 'iform-kneel', defensePlayId: '43-cover3-zone', seed: 2, userSide: 'home', controlRole: 'QB', ruleset: 'arcade' }, {}, { decider: scripted({}) });
    const o = engine.run(() => ({ home: { ...emptyInput(), snap: true } }));
    assertValidOutcome(o);
    expect(o.result).toBe('kneel');
    expect(hasEvent(engine, 'kneel')).toBe(true);
    expect(o.yards).toBeLessThanOrEqual(0);
  });
});
