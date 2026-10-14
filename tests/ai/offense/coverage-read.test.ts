import { describe, expect, it } from 'vitest';
import { getDifficulty } from '@/game/rulesets';
import type { Athlete } from '@/game/play-types';
import { MAN_READ_RANGE, MAN_SHADOW_SECONDS, SHADOW_OF_KEY, SHADOW_T_KEY, readCoverage } from '@/ai/route-running';
import { decideIntent } from '@/ai/index';
import { registerAll } from '@/ai/register';
import { place } from '../shared/helpers';
import { idleIntent } from '@/game/engine-api';
import { fixture, runSim, snapNow, type DefensePolicy } from './sim';

registerAll();

/**
 * Receivers read the coverage on them as the route ends: a defender in the hip pocket running with them is man (keep
 * working away from him), anything else is zone (sit in the window). Reading it is a decision (awareness blended with
 * the difficulty's receiverIntelligence), so a sharp receiver sees man nearly every time and a poor read almost never.
 */
const setupRead = (seed: number, sharp: boolean, trailing: boolean): 'man' | 'zone' => {
  const fx = fixture({ offensePlayId: 'shotgun-curls', defensePlayId: '43-cover1-man', seed });
  const s = fx.state;
  snapNow(s);
  s.ctx = { ...s.ctx, difficulty: { ...getDifficulty(sharp ? 'legend' : 'rookie'), receiverIntelligence: sharp ? 1 : 0 } };
  const wr = fx.byRole('offense', 'WR1');
  wr.attrs = { ...wr.attrs, awareness: sharp ? 99 : 1 };
  const dir = s.ctx.direction;
  const run = { x: 0, y: 7 * dir };
  place(s, wr, 12, s.losY + dir * 12, run);
  const cb: Athlete = fx.byRole('defense', 'CB1');
  place(s, cb, 12.8, s.losY + dir * 10.8, trailing ? run : { x: 0, y: 0 });
  const others = s.athletes.filter((a) => a.side === 'defense' && a.id !== cb.id);
  others.forEach((d, i) => place(s, d, 40 + (i % 5), s.losY + dir * (3 + i)));
  // The route runner keeps, tick by tick, how long the nearest defender has run with him: a trailing corner has been
  // with him through the route, a sitting one never built any of it.
  wr.ai.scratch[SHADOW_OF_KEY] = s.athletes.indexOf(cb);
  wr.ai.scratch[SHADOW_T_KEY] = trailing ? MAN_SHADOW_SECONDS + 0.2 : 0;
  return readCoverage(wr, s, s.athletes.filter((a) => a.side === 'defense')).read;
};

const share = (sharp: boolean, trailing: boolean): number => {
  let man = 0;
  for (let seed = 1; seed <= 30; seed++) if (setupRead(seed, sharp, trailing) === 'man') man++;
  return man / 30;
};

describe('receiver coverage read', () => {
  it('a sharp receiver reads a trailing defender as man; a sitting one is zone', () => {
    expect(MAN_READ_RANGE).toBeGreaterThan(2);
    expect(share(true, true)).toBeGreaterThan(0.85);
    expect(share(true, false)).toBe(0);
  });

  it('a poor read mistakes man for zone and sits down on his defender', () => {
    expect(share(false, true)).toBeLessThan(0.15);
  });
});

/** Decisions the receivers make in a live snap of curls/hitches (QB holding the ball) against a real AI defense. */
const liveDecisions = (defensePlayId: string, seed: number): string[] => {
  const fx = fixture({ offensePlayId: 'shotgun-curls', defensePlayId, seed, difficulty: 'legend' });
  const seen: string[] = [];
  const receivers = fx.state.athletes.filter((a) => a.side === 'offense' && a.assignment.type === 'route');
  // Coverage plays for real; the rush stays home so the held ball lets the routes finish.
  const coverage: DefensePolicy = (a, st, dt) => (a.assignment.type === 'manCover' || a.assignment.type === 'zone' ? decideIntent(a, st, dt) : idleIntent('stay home'));
  runSim(fx, { seconds: 3, idleRoles: ['QB'], defense: coverage, onTick: () => { for (const r of receivers) seen.push(r.ai.decision ?? ''); } });
  return seen;
};

describe('receivers after the route in a live snap', () => {
  it('break away from man coverage and sit in the windows of a zone', () => {
    let manBreaks = 0;
    let zoneBreaks = 0;
    let zoneSits = 0;
    // Eight snaps: a receiver only reads man when his defender is still running with him as the route ends, which
    // happens on roughly one legend snap in four (four seeds held exactly one before the coverage-decision levers).
    for (let seed = 1; seed <= 8; seed++) {
      manBreaks += liveDecisions('43-cover1-man', seed).filter((d) => d.includes('break away (man)')).length;
      const zone = liveDecisions('43-cover3-zone', seed);
      zoneBreaks += zone.filter((d) => d.includes('break away (man)')).length;
      zoneSits += zone.filter((d) => d.includes('zone window')).length;
    }
    expect(manBreaks).toBeGreaterThan(0);
    expect(zoneSits).toBeGreaterThan(0);
    expect(manBreaks).toBeGreaterThan(zoneBreaks);
  });
});
