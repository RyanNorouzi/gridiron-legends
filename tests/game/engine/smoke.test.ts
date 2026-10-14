import { describe, expect, it } from 'vitest';
import { assertValidOutcome } from '@/game/outcome-factory';
import { loadPlaybookData } from '@/playbook/loader';
import { isSpecialPlay } from '@/playbook/special-teams';
import { applyDeltas } from '@/statistics/apply';
import { emptyGameStats } from '@/statistics/empty';
import { build, scripted } from './helpers';

const DEFENSE_FOR: Record<string, string> = { kickoff: 'kickReturn-middle', onside: 'kickReturn-hands', punt: 'puntReturn-middle', fieldGoal: 'fgBlock-middle', extraPoint: 'fgBlock-middle' };
const BALL_ON: Record<string, number> = { extraPoint: 85, fieldGoal: 70, kickoff: 35, onside: 35, twoPoint: 98 };

describe('smoke: every bundled offensive play', () => {
  const registry = loadPlaybookData();
  for (const play of Object.values(registry.offensePlays)) {
    it(`${play.id} runs to a valid outcome with the idle decider`, () => {
      const special = isSpecialPlay(play);
      const defensePlayId = DEFENSE_FOR[special] ?? '43-cover3-zone';
      const ballOn = BALL_ON[special] ?? 25;
      const { engine } = build({ offensePlayId: play.id, defensePlayId, ballOn, seed: 42, ruleset: 'simulation' }, { special }, { decider: scripted({}) });
      const o = engine.run(undefined, 60 * 40);
      assertValidOutcome(o);
      expect(engine.stepCount).toBeLessThanOrEqual(60 * 40);
      expect(o.events.length).toBeGreaterThan(0);
      expect(o.events[o.events.length - 1]?.type).toBe('whistle');
      applyDeltas(emptyGameStats(), o.stats);
      expect(o.playByPlay.length).toBeGreaterThan(0);
      expect(Object.keys(o.fatigueAfter).length).toBe(engine.state.athletes.length);
    });
  }
});
