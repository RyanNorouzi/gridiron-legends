import { describe, expect, it } from 'vitest';
import { idleIntent } from '@/game/engine-api';
import { buildPlayByPlay } from '@/game/play-by-play';
import { chainYards, deriveFacts } from '@/game/outcome';
import { ballOnAt } from '@/game/systems/env';
import { distanceLabel } from '@/game/text-labels';
import { ahead, build, chaseBall, clearDefense, scripted, toward } from './helpers';

/**
 * Every play-by-play line agrees with the outcome facts: the gain agrees with the chains (never 'gain of 10' short of
 * a first down), the spot agrees with the gain, a sack is told once with one loss, and a ball thrown to a spot is a
 * pass, not a throw-away.
 */
const tackledRun = () => {
  const { engine } = build({ offensePlayId: 'iform-dive-right', defensePlayId: '43-cover3-zone', seed: 6 }, {}, {
    decider: scripted({ 'off:RB': (a, s) => (a.hasBall ? ahead(s, 'offense') : toward(a, s.ball.pos)), 'def:MLB': chaseBall, 'def:FS': chaseBall }, clearDefense),
  });
  engine.run();
  return { s: engine.state, env: engine.debugEnv() };
};

describe('chain-consistent yardage', () => {
  it('short of the line to gain never reads as reaching it; a first down never reads as short', () => {
    // 2nd & 10 from the 30.4, down at the 40.0 (3rd & 1 next): a gain of 9, not 10.
    expect(chainYards(9.6, 10, false)).toBe(9);
    // 3rd & 3 (2.5 to go): 2.6 yards moves the chains and reads as 3.
    expect(chainYards(2.6, 2.5, true)).toBe(3);
    // Away from the sticks the gain is the plain rounded one (the stat sheet stays unbiased).
    expect(chainYards(3.6, 10, false)).toBe(4);
    expect(chainYards(-0.4, 10, false)).toBe(0);
    expect(chainYards(14.2, 10, true)).toBe(14);
    for (let raw = -5; raw <= 12; raw += 0.1) {
      for (const d of [1, 2.5, 7.3, 10, 10.6]) {
        const first = raw >= d;
        const g = chainYards(raw, d, first);
        const shown = Number(distanceLabel(d));
        if (first) expect(g).toBeGreaterThanOrEqual(shown);
        else expect(g).toBeLessThan(shown);
        expect(Math.abs(g - raw)).toBeLessThan(1.5);
      }
    }
  });

  it('a run stopped just short of the sticks reads as short of them, spotted where the gain says', () => {
    const { s, env } = tackledRun();
    expect(s.deadReason).toBe('tackle');
    const dir = s.ctx.direction;
    const b0 = ballOnAt(env, s.deadSpot!.y);
    s.ctx = { ...s.ctx, ballOn: 30.4, distance: 10, down: 2 };
    s.deadSpot = { x: s.deadSpot!.x, y: s.deadSpot!.y + dir * (40 - b0) };
    const facts = deriveFacts(s, env);
    expect(facts.endBallOn).toBeCloseTo(40, 5);
    expect(facts.firstDown).toBe(false);
    expect(facts.yards).toBe(9);
    const last = buildPlayByPlay(s, env, facts).at(-1)!;
    expect(last).toMatch(/tackled at the \S+ 39\b/);
    expect(last).toMatch(/gain of 9\./);
    // From the 5 down at the 2: a loss of 3, told at the 2.
    s.ctx = { ...s.ctx, ballOn: 5, distance: 10, down: 1 };
    s.deadSpot = { x: s.deadSpot!.x, y: s.deadSpot!.y + dir * (2.4 - facts.endBallOn) };
    const back = deriveFacts(s, env);
    expect(back.yards).toBe(-3);
    const line = buildPlayByPlay(s, env, back).at(-1)!;
    expect(line).toMatch(/at the \S+ 2\b/);
    expect(line).toMatch(/loss of 3\./);
  });
});

describe('pass and sack lines', () => {
  it('a ball thrown to a spot with nobody credited is a pass downfield; a real throw-away still reads as one', () => {
    const { s, env } = tackledRun();
    const qb = s.athletes.find((a) => a.role === 'QB')!;
    s.events.push({ type: 'throw', tick: s.tick, thrower: qb.id, target: null, throwType: 'bullet', airYards: 14.2, difficulty: 0.3 });
    s.events.push({ type: 'throw', tick: s.tick, thrower: qb.id, target: null, throwType: 'throwAway', airYards: 20, difficulty: 0 });
    const lines = buildPlayByPlay(s, env, deriveFacts(s, env));
    expect(lines).toContain(`${qb.name} throws a bullet, 14 yards downfield`);
    expect(lines).toContain(`${qb.name} throws it away`);
    expect(lines.filter((l) => /throws it away/.test(l))).toHaveLength(1);
  });

  it('a sack is told once: one SACKED line and a result line with the same loss, never a second tackle', () => {
    const { engine } = build({ offensePlayId: 'shotgun-mesh', defensePlayId: '43-cover3-zone', seed: 2, ruleset: 'arcade' }, {}, {
      decider: scripted({
        'off:QB': () => idleIntent('hold'),
        'def:CB1': (a, st) => (st.phase === 'live' ? toward(a, st.athletes.find((x) => x.id === 'off:QB')!.pos) : idleIntent('set')),
      }),
    });
    const o = engine.run(undefined, 60 * 20);
    expect(o.result).toBe('sack');
    const sacked = o.playByPlay.filter((l) => /^SACKED by /.test(l));
    expect(sacked).toHaveLength(1);
    const loss = Number(/loss of (\d+) yards?/.exec(sacked[0]!)?.[1]);
    expect(loss).toBe(-o.yards);
    const last = o.playByPlay.at(-1)!;
    expect(last).toMatch(new RegExp(`sacked at .*, ${o.yards < 0 ? `loss of ${-o.yards}` : 'no gain'}\\.`));
    expect(o.playByPlay.some((l) => / tackled at /.test(l))).toBe(false);
  });
});
