import { describe, expect, it } from 'vitest';
import type { Rng } from '@/core/rng';
import { vec2 } from '@/core/vec2';
import { idleIntent, type AthleteIntent } from '@/game/engine-api';
import { assertValidOutcome } from '@/game/outcome-factory';
import type { Athlete, PlayState } from '@/game/play-types';
import { rollContactInjuries } from '@/game/systems/injuries-live';
import { loadPlaybookData } from '@/playbook/loader';
import { ahead, build, chaseBall, clearDefense, emptyInput, hasEvent, pursue, scripted, ticksSinceSnap, toward, trackBall } from './helpers';

const rush = (a: Athlete, s: PlayState): AthleteIntent => (s.phase === 'live' ? pursue(a, s) : idleIntent('set'));

describe('audibles', () => {
  it('a sharp QB changes the play from the registry and assignments follow', () => {
    const registry = loadPlaybookData();
    const { engine } = build({ offensePlayId: 'shotgun-mesh', defensePlayId: '43-cover3-zone', seed: 4, userSide: 'home', controlRole: 'QB', ruleset: 'arcade' }, {}, {
      plays: { offensePlays: registry.offensePlays, defensePlays: registry.defensePlays },
    }, (ctx) => { ctx.offenseLineup['QB']!.attrs.awareness = 99; });
    engine.tick({ home: { ...emptyInput(), audible: 'zoneBeater' } });
    const ev = engine.state.events.find((e) => e.type === 'audible');
    expect(ev && ev.type === 'audible' && ev.success && ev.newPlayId === 'shotgun-curls' && ev.side === 'offense').toBe(true);
    expect(engine.state.ctx.offensivePlay.id).toBe('shotgun-curls');
    const wr3 = engine.state.athletes.find((a) => a.id === 'off:WR3')!;
    expect(wr3.assignment).toEqual(registry.offensePlays['shotgun-curls']!.assignments['WR3']);
    expect(engine.state.phase).toBe('presnap');
    engine.tick({ home: { ...emptyInput(), audible: 'zoneBeater' } });
    expect(engine.state.events.filter((e) => e.type === 'audible')).toHaveLength(1);
  });

  it('an audible the play does not define, or without a registry, fails and keeps the play', () => {
    const { engine } = build({ offensePlayId: 'shotgun-mesh', defensePlayId: '43-cover3-zone', seed: 4, userSide: 'home', controlRole: 'QB', ruleset: 'arcade' });
    engine.tick({ home: { ...emptyInput(), audible: 'manBeater' } });
    const ev = engine.state.events.find((e) => e.type === 'audible');
    expect(ev && ev.type === 'audible' && !ev.success).toBe(true);
    expect(engine.state.ctx.offensivePlay.id).toBe('shotgun-mesh');
  });

  it('the defense can audible too', () => {
    const { engine } = build({ offensePlayId: 'shotgun-mesh', defensePlayId: '43-cover3-zone', seed: 4, userSide: 'away', controlRole: 'FS', ruleset: 'arcade' }, {}, {
      plays: { defensePlays: loadPlaybookData().defensePlays },
    }, (ctx) => { ctx.defenseLineup['FS']!.attrs.awareness = 99; });
    engine.tick({ away: { ...emptyInput(), defAudible: 'blitz' } });
    expect(engine.state.ctx.defensivePlay.id).toBe('43-cover3-edgeBlitz');
    expect(engine.state.events.some((e) => e.type === 'audible' && e.side === 'defense' && e.success)).toBe(true);
  });
});

describe('blocking and pass rush', () => {
  it('linemen engage rushers; sacks come only after the block is shed', () => {
    let sacks = 0;
    let engaged = 0;
    let sackTicks = 0;
    for (let seed = 1; seed <= 10; seed++) {
      const { engine } = build({ offensePlayId: 'shotgun-mesh', defensePlayId: '43-cover3-zone', seed, ruleset: 'arcade' }, {}, {
        decider: scripted({ 'def:DE1': rush, 'def:DT1': rush, 'def:DT2': rush, 'def:DE2': rush }),
      });
      let sawEngagement = false;
      while (!engine.isDead) {
        engine.tick();
        if (engine.state.athletes.some((a) => a.state === 'engaged' && a.side === 'defense')) sawEngagement = true;
      }
      const o = engine.outcome!;
      assertValidOutcome(o);
      if (sawEngagement) engaged += 1;
      if (o.result === 'sack') {
        sacks += 1;
        sackTicks += o.timeElapsed;
        expect(o.yards).toBeLessThan(0);
        expect(hasEvent(engine, 'sack')).toBe(true);
        expect(o.stats.some((d) => d.stat === 'passing.sacks')).toBe(true);
        expect(o.stats.some((d) => d.stat === 'defense.sacks')).toBe(true);
        expect(o.tacklerIds.length).toBeGreaterThan(0);
      } else if (hasEvent(engine, 'fumble')) {
        // A strip sack: the rusher who got to the passer knocked the ball out (then the defense may run it back).
        const f = engine.state.events.find((e) => e.type === 'fumble');
        expect(f && f.type === 'fumble' ? f.carrier : null).toBe('off:QB');
        expect(f && f.type === 'fumble' ? engine.state.athletes.find((a) => a.id === f.forcedBy)?.side : null).toBe('defense');
      } else {
        expect(engine.state.deadReason).toBe('forwardProgress');
      }
    }
    expect(engaged).toBe(10);
    expect(sacks).toBeGreaterThanOrEqual(1);
    expect(sackTicks / sacks).toBeGreaterThan(0.8);
  });
});

describe('special moves and hits', () => {
  it('a juke sets the state, emits the event and starts a cooldown', () => {
    const { engine } = build({ offensePlayId: 'iform-dive-right', defensePlayId: '43-cover3-zone', seed: 5, ruleset: 'arcade' }, {}, {
      decider: scripted({ 'off:RB': (a, s) => (a.hasBall ? { ...ahead(s, 'offense'), action: 'juke' } : toward(a, s.ball.pos)) }, clearDefense),
    });
    while (!hasEvent(engine, 'specialMove') && !engine.isDead) engine.tick();
    const rb = engine.state.athletes.find((a) => a.id === 'off:RB')!;
    expect(engine.state.events.some((e) => e.type === 'specialMove' && e.move === 'juke' && e.athlete === 'off:RB')).toBe(true);
    expect(rb.state).toBe('juking');
    expect(rb.specialMoveCooldown).toBeGreaterThan(0);
    const o = engine.run();
    const jukes = engine.state.events.filter((e) => e.type === 'specialMove').length;
    expect(jukes).toBeLessThan(engine.stepCount / 30);
    assertValidOutcome(o);
  });

  it('a timed hit stick shows up as a hitStick event on contact', () => {
    let hits = 0;
    for (let seed = 1; seed <= 6; seed++) {
      const { engine } = build({ offensePlayId: 'iform-dive-right', defensePlayId: '43-cover3-zone', seed, ruleset: 'arcade' }, {}, {
        decider: scripted({
          'off:RB': (a, s) => (a.hasBall ? ahead(s, 'offense') : toward(a, s.ball.pos)),
          'def:MLB': (a, s) => (s.ball.carrierId === 'off:RB' ? { ...pursue(a, s), action: 'hitStick' } : idleIntent('wait')),
        }, clearDefense),
      });
      engine.run();
      if (hasEvent(engine, 'hitStick')) hits += 1;
    }
    expect(hits).toBeGreaterThanOrEqual(3);
  });

  it('a defender who dives at the runner from range lunges and goes to ground', () => {
    const { engine } = build({ offensePlayId: 'iform-dive-right', defensePlayId: '43-cover3-zone', seed: 6, ruleset: 'arcade' }, {}, {
      decider: scripted({
        'off:RB': (a, s) => (a.hasBall ? ahead(s, 'offense') : toward(a, s.ball.pos)),
        'def:MLB': (a, s) => (s.ball.carrierId === 'off:RB' ? { ...pursue(a, s), action: 'tackle' } : idleIntent('wait')),
      }, clearDefense),
    });
    let dived = false;
    while (!engine.isDead) {
      engine.tick();
      if (engine.state.athletes.find((a) => a.id === 'def:MLB')!.state === 'diving') dived = true;
    }
    expect(dived).toBe(true);
    assertValidOutcome(engine.outcome!);
  });
});

describe('injuries', () => {
  const alwaysRng: Rng = {
    next: () => 0.001, range: (lo) => lo, int: (lo) => lo, chance: () => true, pick: (items) => items[0]!, weighted: (items) => items[0]!,
    gaussian: (mean = 0) => mean, shuffle: (items) => items.slice(), fork: () => alwaysRng, getState: () => [1, 2, 3, 4], setState: () => undefined, seed: 1,
  };

  it('a contact injury is reported once, emitted, and sidelines the athlete after the play', () => {
    const { engine } = build({ offensePlayId: 'iform-dive-right', defensePlayId: '43-cover3-zone', seed: 5, ruleset: 'simulation' }, {}, {
      decider: scripted({ 'off:RB': (a, s) => (a.hasBall ? ahead(s, 'offense') : toward(a, s.ball.pos)) }, clearDefense),
    });
    const env = engine.debugEnv();
    const rb = engine.state.athletes.find((a) => a.id === 'off:RB')!;
    const real = env.rng;
    env.rng = alwaysRng;
    rollContactInjuries(engine.state, env, [rb], 0.9);
    rollContactInjuries(engine.state, env, [rb], 0.9);
    env.rng = real;
    expect(env.injuries).toHaveLength(1);
    expect(engine.state.events.filter((e) => e.type === 'injury')).toHaveLength(1);
    const o = engine.run();
    expect(o.injuries).toEqual([{ playerId: rb.playerId, severity: env.injuries[0]!.severity }]);
    expect(rb.active).toBe(false);
  });

  it('injuries never roll when the ruleset disables them', () => {
    const { engine } = build({ offensePlayId: 'iform-dive-right', defensePlayId: '43-cover3-zone', seed: 5, ruleset: 'arcade' });
    const env = engine.debugEnv();
    env.rng = alwaysRng;
    rollContactInjuries(engine.state, env, engine.state.athletes, 1);
    expect(env.injuries).toHaveLength(0);
  });
});

describe('live fouls', () => {
  it('a defender crashing through the receiver while the ball is in the air draws interference', () => {
    // Deterministic: once the lob is up, the corner is placed 0.9 yd beside the receiver and driving into him, and the
    // foul roll is forced (penalties switched on after the snap with a frequency far above 1, so no pre-snap flag
    // ends the play first). Every seed must flag defensive interference; the same seeds with penalties off stay clean.
    const play = (seed: number, penalties: boolean) => {
      const { engine } = build({ offensePlayId: 'shotgun-mesh', defensePlayId: '43-cover3-zone', seed, ruleset: 'simulation' }, {}, {
        decider: scripted({
          'off:QB': (a, s) => (a.hasBall && ticksSinceSnap(s) >= 80 ? { ...idleIntent('throw'), action: 'throw', targetId: 'off:WR2', throwType: 'lob' } : idleIntent('wait')),
          'off:WR2': (a, s) => (s.phase !== 'live' ? idleIntent('set') : s.ball.phase === 'inAir' ? trackBall(a, s) : ahead(s, 'offense')),
          'def:CB2': (a, s) => {
            if (s.phase !== 'live' || s.ball.phase !== 'inAir' || s.ball.kind !== 'pass') return idleIntent('wait');
            return toward(a, s.athletes.find((x) => x.id === 'off:WR2')!.pos);
          },
        }, clearDefense),
      }, (ctx) => { ctx.ruleset = { ...ctx.ruleset, penalties: false, penaltyFrequency: 0 }; });
      let placed = false;
      while (!engine.isDead && engine.state.tick < 3000) {
        const st = engine.state;
        if (st.phase === 'live' && !st.ctx.ruleset.penalties && penalties) st.ctx.ruleset = { ...st.ctx.ruleset, penalties: true, penaltyFrequency: 1000 };
        if (!placed && st.ball.phase === 'inAir' && st.ball.kind === 'pass' && st.tick < st.ball.landingTick - 12) {
          const wr = st.athletes.find((x) => x.id === 'off:WR2')!;
          const cb = st.athletes.find((x) => x.id === 'def:CB2')!;
          cb.pos = vec2(wr.pos.x + 0.9, wr.pos.y);
          cb.vel = vec2(-7, wr.vel.y);
          placed = true;
        }
        engine.tick();
      }
      expect(placed, `seed ${seed}: the lob went up`).toBe(true);
      return engine.outcome!;
    };
    for (let seed = 1; seed <= 10; seed++) {
      const o = play(seed, true);
      assertValidOutcome(o);
      const dpi = o.penalties.find((p) => p.foul === 'passInterferenceDefense');
      expect(dpi, `seed ${seed}: a corner crashing into the receiver is defensive interference`).toBeDefined();
      expect(o.penalties.some((p) => p.foul === 'passInterferenceOffense')).toBe(false);
      expect(dpi!.side).toBe('defense');
      expect(dpi!.enforcement).toBe('spotOfFoul');
      expect(dpi!.spotBallOn).not.toBeNull();
      expect(dpi!.accepted).toBe(false);
      expect(dpi!.deadBall).toBe(false);
      expect(play(seed, false).penalties).toHaveLength(0);
    }
  });

  it('the arcade ruleset never produces flags', () => {
    for (let seed = 1; seed <= 5; seed++) {
      const { engine } = build({ offensePlayId: 'iform-dive-right', defensePlayId: '43-cover3-zone', seed, ruleset: 'arcade' }, {}, {
        decider: scripted({ 'off:RB': (a, s) => (a.hasBall ? ahead(s, 'offense') : toward(a, s.ball.pos)), 'def:MLB': chaseBall, 'def:SS': chaseBall }),
      });
      expect(engine.run().penalties).toHaveLength(0);
    }
  });
});
