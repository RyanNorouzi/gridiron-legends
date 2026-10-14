/**
 * Owner report: "the defense starts moving and moves to the QB and waits before the ball is even snapped". Man
 * defenders pressing a back walked into the backfield next to the quarterback. Before the snap no defender may cross
 * into the neutral zone, and a defender on a back aligns at linebacker depth, not on top of him.
 */
import { describe, expect, it } from 'vitest';
import { registerAll } from '@/ai/register';
import { BACK_COVER_DEPTH } from '@/ai/coverage-man';
import { AI_PRESNAP_NEUTRAL_ZONE } from '@/game/play-engine';
import { build, emptyInput } from '../../game/engine/helpers';

registerAll();

const CASES: readonly [string, string][] = [
  ['iform-dive-right', '43-cover0-lbBlitz'],
  ['iform-dive-right', '34-cover0-allOut'],
  ['shotgun-slants', 'nickel-cover0-cbBlitz'],
  ['iform-dive-right', '425-cover2-man'],
  ['shotgun-slants', '43-cover9-match'],
];

describe('pre-snap defensive alignment', () => {
  for (const [off, def] of CASES) {
    it(`${def} vs ${off}: nobody crosses the line while a human quarterback holds the snap`, () => {
      const { engine } = build({ offensePlayId: off, defensePlayId: def, seed: 5, ballOn: 40, userSide: 'home', controlRole: 'QB', ruleset: 'arcade' });
      const s = engine.state;
      const depth = (y: number): number => s.ctx.direction * (y - s.losY);
      const start = new Map(s.athletes.filter((a) => a.side === 'defense').map((a) => [a.id, depth(a.pos.y)]));
      for (let t = 0; t < 60 * 12 && s.phase === 'presnap'; t++) {
        engine.tick({ home: emptyInput() });
        for (const a of s.athletes) {
          if (a.side !== 'defense' || !a.active) continue;
          const floor = Math.min(start.get(a.id) ?? 0, AI_PRESNAP_NEUTRAL_ZONE);
          expect(depth(a.pos.y), `${a.role} at tick ${s.tick}`).toBeGreaterThanOrEqual(floor - 1e-6);
        }
      }
      expect(s.phase).toBe('presnap');
      // Defenders covering a back hold at linebacker depth (or the depth they lined up at, when closer).
      for (const a of s.athletes) {
        if (a.side !== 'defense' || a.assignment.type !== 'manCover') continue;
        const target = s.athletes.find((o) => o.id === a.ai.targetAthleteId);
        if (!target || depth(target.pos.y) >= -2) continue;
        expect(depth(a.pos.y), `${a.role} on ${target.role}`).toBeGreaterThanOrEqual(Math.min(start.get(a.id) ?? 0, BACK_COVER_DEPTH) - 0.75);
      }
    });
  }
});
