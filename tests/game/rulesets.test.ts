import { describe, expect, it } from 'vitest';
import { DIFFICULTY_IDS, getDifficulty, getRuleset, isDifficultyId, loadDifficulties, loadRulesets } from '@/game/rulesets';

describe('rulesets loader', () => {
  it('loads arcade and simulation presets with the documented values', () => {
    const ids = loadRulesets().map((r) => r.id);
    expect(ids).toEqual(['arcade', 'simulation']);
    const arcade = getRuleset('arcade');
    expect(arcade.mode).toBe('arcade');
    expect(arcade.quarterLengthSec).toBe(300);
    expect(arcade.playClockSec).toBe(25);
    expect(arcade.huddleRunoffSec).toBe(15);
    expect(arcade.penalties).toBe(false);
    expect(arcade.challenges).toBe(false);
    const sim = getRuleset('simulation');
    expect(sim.mode).toBe('simulation');
    expect(sim.quarterLengthSec).toBe(480);
    expect(sim.playClockSec).toBe(40);
    expect(sim.huddleRunoffSec).toBe(25);
    expect(sim.penalties).toBe(true);
    expect(sim.overtime).toBe('modified');
    expect(sim.challengesPerGame).toBe(2);
    expect(sim.timeoutsPerHalf).toBe(3);
  });

  it('hands out copies so callers cannot corrupt the cache', () => {
    const a = getRuleset('arcade');
    a.quarterLengthSec = 1;
    expect(getRuleset('arcade').quarterLengthSec).toBe(300);
  });

  it('throws a descriptive error for unknown ids', () => {
    expect(() => getRuleset('nope')).toThrow(/Unknown ruleset "nope"/);
    expect(() => getDifficulty('impossible')).toThrow(/Unknown difficulty/);
  });
});

describe('difficulty loader', () => {
  it('loads all four profiles', () => {
    expect(loadDifficulties().map((d) => d.id)).toEqual([...DIFFICULTY_IDS]);
    expect(getDifficulty('legend').name).toBe('Legend');
    expect(isDifficultyId('allPro')).toBe(true);
    expect(isDifficultyId('hard')).toBe(false);
  });

  it('is monotone: AI quality rises and user assists fall from rookie to legend', () => {
    const [rookie, pro, allPro, legend] = DIFFICULTY_IDS.map(getDifficulty);
    const ordered = [rookie!, pro!, allPro!, legend!];
    for (let i = 1; i < ordered.length; i++) {
      const lo = ordered[i - 1]!;
      const hi = ordered[i]!;
      expect(hi.qbDecisionQuality).toBeGreaterThanOrEqual(lo.qbDecisionQuality);
      expect(hi.pursuitQuality).toBeGreaterThanOrEqual(lo.pursuitQuality);
      expect(hi.coverageAnticipation).toBeGreaterThanOrEqual(lo.coverageAnticipation);
      expect(hi.aiReactionDelay).toBeLessThanOrEqual(lo.aiReactionDelay);
      expect(hi.userPassAssist).toBeLessThanOrEqual(lo.userPassAssist);
      expect(hi.userBallSecurityAssist).toBeLessThanOrEqual(lo.userBallSecurityAssist);
      expect(hi.userTackleAssist).toBeLessThanOrEqual(lo.userTackleAssist!);
    }
    expect(legend!.aiReactionDelay).toBeLessThan(rookie!.aiReactionDelay / 2);
  });
});
