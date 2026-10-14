import { describe, expect, it } from 'vitest';
import { registerAll } from '@/ai/register';
import { assertValidOutcome } from '@/game/outcome-factory';
import { createPlayEngine } from '@/game/play-engine';
import type { PlayContext, PlayOutcome, PlayState } from '@/game/play-types';
import { buildPlayState } from '../../fixtures/play-state';

/**
 * The special-teams deciders driving the real PlayEngine (every AI module registered). These are the
 * emergent checks: the units snap, kick, cover, field and return on their own, producing valid outcomes.
 */
const play = (off: string, def: string, special: PlayContext['special'], ballOn: number, seed: number, kicker?: { role: string; power: number; accuracy: number }): { outcome: PlayOutcome; state: PlayState } => {
  registerAll();
  const f = buildPlayState({ offensePlayId: off, defensePlayId: def, ballOn, seed });
  if (kicker) {
    const p = f.state.ctx.offenseLineup[kicker.role];
    if (p) { p.attrs.kickPower = kicker.power; p.attrs.kickAccuracy = kicker.accuracy; }
  }
  // Pre-snap fouls belong to the rules tests; here the units themselves are under test.
  const ctx: PlayContext = { ...f.state.ctx, special, ruleset: { ...f.state.ctx.ruleset, penalties: false } };
  const engine = createPlayEngine(ctx, { registries: f.registry });
  const outcome = engine.run();
  assertValidOutcome(outcome);
  return { outcome, state: engine.state };
};

const kicked = (state: PlayState, kind: string): boolean => state.events.some((e) => e.type === 'kick' && e.kind === kind);

describe('special teams through the engine', () => {
  it('punts: the unit snaps, the punter kicks, the returner fields or fair-catches', () => {
    for (const seed of [1, 2, 3, 4]) {
      const { outcome, state } = play('punt-standard', 'puntReturn-middle', 'punt', 30, seed, { role: 'P', power: 85, accuracy: 80 });
      expect(outcome.result).toBe('punt');
      expect(kicked(state, 'punt')).toBe(true);
      expect(outcome.penalties).toHaveLength(0);
      expect(outcome.kickDistance).toBeGreaterThanOrEqual(30);
      expect(outcome.turnover).toBe(false);
      expect(['fairCatch', 'tackle', 'outOfBounds', 'kickDowned', 'touchback', 'touchdown', 'fumbleRecovered']).toContain(state.deadReason);
    }
    // A pooch from the opponent's 38 pins the return team deep instead of kicking through the end zone.
    const pooch = play('punt-pooch', 'puntReturn-middle', 'punt', 62, 5, { role: 'P', power: 85, accuracy: 85 });
    expect(pooch.outcome.result).toBe('punt');
    expect(pooch.outcome.endBallOn).toBeGreaterThan(80);
    expect(pooch.outcome.endBallOn).toBeLessThanOrEqual(100);
  });

  it('kickoffs: the kicker strikes the ball, the returner kneels deep kicks or returns them', () => {
    let touchbacks = 0;
    let returns = 0;
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const { outcome, state } = play('kickoff-deep', 'kickReturn-middle', 'kickoff', 35, seed, { role: 'K', power: 80, accuracy: 80 });
      expect(outcome.result).toBe('kickoff');
      expect(kicked(state, 'kickoff')).toBe(true);
      expect(outcome.presnapElapsed).toBe(0);
      if (state.deadReason === 'touchback') touchbacks++;
      else if (outcome.returnYards > 0) returns++;
    }
    expect(touchbacks + returns).toBeGreaterThanOrEqual(5);
  });

  it('field goals and extra points: snap, hold, kick and a result', () => {
    let made = 0;
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const { outcome, state } = play('fieldGoal-standard', 'fgBlock-middle', 'fieldGoal', 87, seed, { role: 'K', power: 90, accuracy: 90 });
      expect(outcome.result).toBe('fieldGoal');
      expect(outcome.kickDistance).toBe(30);
      expect(state.events.some((e) => e.type === 'kickResult')).toBe(true);
      if (outcome.kickMade) made++;
    }
    expect(made).toBeGreaterThanOrEqual(6);
    const xp = play('extraPoint-standard', 'fgBlock-middle', 'extraPoint', 85, 9, { role: 'K', power: 85, accuracy: 85 });
    expect(xp.outcome.result).toBe('extraPoint');
    expect(xp.outcome.kickMade).not.toBeNull();
  });

  it('onside kicks: a short kick that both units go after', () => {
    for (const seed of [1, 2, 3]) {
      const { outcome, state } = play('kickoff-onside', 'kickReturn-hands', 'onside', 35, seed, { role: 'K', power: 80, accuracy: 80 });
      expect(outcome.result).toBe('onside');
      expect(kicked(state, 'onside')).toBe(true);
      expect(outcome.kickDistance).toBeLessThan(25);
    }
  });
});
