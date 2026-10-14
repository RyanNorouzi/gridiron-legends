import { describe, expect, it } from 'vitest';
import { decideIntent } from '@/ai/index';
import { registerAll } from '@/ai/register';
import type { IntentDecider } from '@/game/engine-api';
import type { PlayOutcome } from '@/game/play-types';
import { getDifficulty } from '@/game/rulesets';
import type { DifficultyId } from '@/game/types';
import { build } from './helpers';

registerAll();

/**
 * Spec rule: difficulty changes AI DECISIONS, never the dice. Hold every AI decision at 'pro' and move only the
 * difficulty the ENGINE sees (interception odds, block sheds, tackle whiffs, fumbles...): with AI-only sides every play
 * must come out identical, snap for snap. (The only difficulty terms left in the engine are the human-only assists.)
 */
const proDecisions: IntentDecider = (a, s, dt) => {
  const engineSees = s.ctx.difficulty;
  s.ctx.difficulty = getDifficulty('pro');
  try {
    return decideIntent(a, s, dt);
  } finally {
    s.ctx.difficulty = engineSees;
  }
};

const PLAYS: readonly [string, string][] = [
  ['shotgun-mesh', '43-cover1-man'], ['shotgun-fourVerts', '43-cover3-zone'], ['shotgun-deepCross', '43-cover2-zone'],
  ['trips-smash', 'nickel-cover3-match'], ['iform-dive-right', '43-runStop-cover1'], ['pistol-outsideZone-right', '43-cover2-zoneBlitz'],
  ['singleback-counter-left', '34-cover1-edge'], ['shotgun-slants', '34-cover0-allOut'],
];

const fingerprint = (o: PlayOutcome): string =>
  JSON.stringify([o.result, o.yards, o.turnover, o.touchdown, o.timeElapsed, o.events.map((e) => `${e.type}@${e.tick}`)]);

const run = (difficulty: DifficultyId, off: string, def: string, seed: number): string =>
  fingerprint(build({ offensePlayId: off, defensePlayId: def, seed, ballOn: 35 }, { difficulty: getDifficulty(difficulty) }, { decider: proDecisions }).engine.run());

describe('difficulty never touches the engine dice', () => {
  it('identical AI decisions give identical plays on rookie and legend', () => {
    let compared = 0;
    let struggles = 0;
    for (const [off, def] of PLAYS) {
      for (const seed of [1, 2, 3, 4]) {
        const legend = run('legend', off, def, seed);
        expect(legend, `${off} vs ${def} seed ${seed}`).toBe(run('rookie', off, def, seed));
        // The tackle struggle (wrap-ups, piles, breaks, strips) is part of what must not move with the difficulty.
        struggles += legend.split('wrapUp@').length - 1;
        compared += 1;
      }
    }
    expect(compared).toBe(32);
    expect(struggles).toBeGreaterThan(8);
  }, 60_000); // 64 full AI plays: a few seconds alone, past the 5 s default on a loaded host
});
