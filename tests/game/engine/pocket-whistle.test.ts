/**
 * A passer in the pocket is never whistled dead as a stalled runner: behind a line that holds he may stand and read
 * (or aim a pull-back throw) as long as he likes, and when he IS held there until forward progress is called, it is a
 * sack credited to the defender on him (not a 'scramble' loss with nobody credited).
 */
import { describe, expect, it } from 'vitest';
import { idleIntent } from '@/game/engine-api';
import { assertValidOutcome } from '@/game/outcome-factory';
import { STALL_SECONDS } from '@/game/live-rules';
import { build, clearDefense, emptyInput, scripted } from './helpers';

const pocket = (seed: number) =>
  build({ offensePlayId: 'shotgun-mesh', defensePlayId: '43-cover3-zone', seed, ballOn: 30 }, {}, {
    decider: scripted({}, (a, s) => (a.side === 'defense' ? clearDefense(a, s) : idleIntent('hold'))),
  });

const liveFor = (engine: ReturnType<typeof pocket>['engine'], seconds: number): void => {
  for (let t = 0; engine.state.phase === 'presnap' && t < 600; t++) engine.tick({});
  const snap = engine.state.tick;
  while (engine.state.phase === 'live' && engine.state.tick - snap < seconds * 60) engine.tick({});
};

describe('the pocket and the stall safety net', () => {
  it('a passer standing untouched in a clean pocket stays live well past the stall net (8 s)', () => {
    for (const seed of [1, 2, 3]) {
      const { engine } = pocket(seed);
      liveFor(engine, 8);
      expect(STALL_SECONDS).toBeLessThan(8);
      expect(engine.state.phase, `seed ${seed}`).toBe('live');
      const qb = engine.state.athletes.find((a) => a.assignment.type === 'qb')!;
      expect(qb.hasBall).toBe(true);
    }
  });

  it('a human passer holding a pull-back aim (stick at rest) is not whistled down either', () => {
    const { engine } = build({ offensePlayId: 'shotgun-mesh', defensePlayId: '43-cover3-zone', seed: 5, ballOn: 30, ruleset: 'arcade', userSide: 'home', controlRole: 'QB' }, {}, {
      decider: scripted({}, (a, s) => (a.side === 'defense' ? clearDefense(a, s) : idleIntent('hold'))),
    });
    for (let t = 0; engine.state.phase === 'presnap' && t < 600; t++) engine.tick({ home: { ...emptyInput(), snap: true } });
    const snap = engine.state.tick;
    while (engine.state.phase === 'live' && engine.state.tick - snap < 8 * 60) engine.tick({ home: emptyInput() });
    expect(engine.state.phase).toBe('live');
  });

  it('a passer held in the pocket until forward progress is whistled is sacked by the man on him', () => {
    const { engine } = pocket(4);
    liveFor(engine, 1);
    const s = engine.state;
    const qb = s.athletes.find((a) => a.assignment.type === 'qb')!;
    const de = s.athletes.find((a) => a.side === 'defense' && a.role.startsWith('DE'))!;
    let guard = 0;
    while (s.phase === 'live' && guard++ < 120) {
      // A rusher hanging on him (in contact every tick) while he cannot move: his forward progress is stopped.
      de.pos = { x: qb.pos.x + 1.1, y: qb.pos.y };
      de.vel = { x: 0, y: 0 };
      qb.contactTimer = 0;
      engine.tick({});
    }
    const o = engine.run();
    assertValidOutcome(o);
    expect(o.result).toBe('sack');
    expect(o.events.some((e) => e.type === 'sack')).toBe(true);
    // Told as a sack: no "drags two defenders" line for a passer who never moved, no "loss of 0 yards".
    expect(o.playByPlay.some((l) => /drags/.test(l))).toBe(false);
    expect(o.playByPlay.some((l) => /SACKED by .* (for a loss of \d+ yards?|for no gain)$/.test(l))).toBe(true);
    expect(o.playByPlay.some((l) => /loss of 0/.test(l))).toBe(false);
  });

  it('a passer stopped in the pocket by forward progress with no pile on him is sacked by the rusher in his face', () => {
    const { engine } = pocket(6);
    liveFor(engine, 1);
    const s = engine.state;
    const qb = s.athletes.find((a) => a.assignment.type === 'qb')!;
    const de = s.athletes.find((a) => a.side === 'defense' && a.role.startsWith('DE'))!;
    let guard = 0;
    while (s.phase === 'live' && guard++ < 120) {
      // Just out of tackle reach (no tackle attempt, no struggle) but in his face, and the passer was just hit: only
      // the forward-progress rule can end this play, and it must be the rusher's sack, not an uncredited loss.
      de.pos = { x: qb.pos.x, y: qb.pos.y + s.ctx.direction * 1.45 };
      de.vel = { x: 0, y: 0 };
      qb.contactTimer = 0;
      engine.tick({});
    }
    expect(s.deadReason).toBe('forwardProgress');
    const o = engine.run();
    assertValidOutcome(o);
    expect(o.result).toBe('sack');
    const sack = o.events.find((e) => e.type === 'sack');
    expect(sack?.type === 'sack' ? sack.by : null).toBe(de.id);
    expect(o.events.some((e) => e.type === 'tackle' && e.tackler === de.id)).toBe(true);
  });
});
