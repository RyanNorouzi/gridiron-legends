/**
 * Punting from deep in your own end: the punter's usual 14-yard depth would put him behind the end line (out of
 * bounds before the snap, an instant safety). Alignments are pulled up to just inside the end line, and a punt that
 * is never kicked is ruled as a scrimmage down, so a safety scores for the RECEIVING team.
 */
import { describe, expect, it } from 'vitest';
import { registerAll } from '@/ai/register';
import { vec2 } from '@/core/vec2';
import { effectiveSpecial, scoreOutcome } from '@/game/rules/scoring';
import { END_LINE_CLEARANCE } from '@/game/setup';
import { fieldY, otherSide } from '@/game/types';
import type { UserPlayInput } from '@/game/play-types';
import { build } from './helpers';

registerAll();

const input = (o: Partial<UserPlayInput> = {}): UserPlayInput => ({
  move: vec2(0, 0), sprint: false, strafe: false, throwTo: null, throwType: null, juke: false, spin: false, stiffArm: false,
  hurdle: false, dive: false, slide: false, throwAway: false, snap: false, audible: null, defAudible: null, switchPlayer: false,
  switchToId: null, hitStick: false, strip: false, tackle: false, jumpSwat: false, kickPress: false, fairCatch: false, pitch: false, ...o,
});

const puntAt = (ballOn: number, seed = 1) =>
  build({ offensePlayId: 'punt-standard', defensePlayId: 'puntReturn-middle', seed, ballOn, ruleset: 'arcade', userSide: 'home', controlRole: 'P' }, { special: 'punt' });

describe('punting from your own end zone', () => {
  it('lines every player up in front of the end line', () => {
    for (const ballOn of [1, 2, 3.4, 6]) {
      const { engine, ctx } = puntAt(ballOn);
      const endLine = fieldY(-10, ctx.direction);
      for (const a of engine.state.athletes.filter((x) => x.side === 'offense')) {
        expect((a.pos.y - endLine) * ctx.direction, `${a.role} at the ${ballOn}`).toBeGreaterThanOrEqual(END_LINE_CLEARANCE - 1e-9);
      }
    }
  });

  it('keeps the usual punter depth when there is room', () => {
    const { engine, ctx } = puntAt(30);
    const p = engine.state.athletes.find((a) => a.role === 'P' && a.side === 'offense')!;
    expect(Math.round((fieldY(30, ctx.direction) - p.pos.y) * ctx.direction)).toBe(14);
  });

  it('a punter who never kicks and runs out of his own end zone gives the safety to the receiving team', () => {
    const { engine, ctx } = puntAt(2);
    while (engine.state.phase === 'presnap') engine.tick({ home: input({ snap: true }) });
    for (let t = 0; t < 900 && !engine.isDead; t++) engine.tick({ home: input({ move: vec2(0, -ctx.direction), sprint: true }) });
    const o = engine.outcome!;
    expect(engine.state.events.some((e) => e.type === 'kick')).toBe(false);
    expect(o.safety).toBe(true);
    expect(o.result).toBe('run');
    const special = effectiveSpecial('punt', o);
    expect(special).toBe('none');
    expect(scoreOutcome({ possession: ctx.offense }, o, special)).toMatchObject({ kind: 'safety', scoringSide: otherSide(ctx.offense) });
  });
});
