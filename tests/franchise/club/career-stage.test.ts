import { describe, expect, it } from 'vitest';
import { careerStage, mentorshipBoost, personalityTags, stageEvents, stageMoraleMultiplier, VETERAN_SEASONS } from '@/franchise/career-stage';
import { adjustMorale } from '@/players/personality';

const player = (experience: number, traits: string[] = []) => ({ experience, traits: traits as never[], morale: { morale: 60, confidence: 60, coachRelationship: 60 } });

describe('career-stage personality tags', () => {
  it('tags first-year players Rookie and long-serving players Veteran', () => {
    expect(careerStage(player(0))).toBe('rookie');
    expect(careerStage(player(3))).toBeNull();
    expect(careerStage(player(VETERAN_SEASONS))).toBe('veteran');
    expect(personalityTags(player(0, ['leader']))).toEqual(['leader', 'rookie']);
    expect(personalityTags(player(4, ['quiet']))).toEqual(['quiet']);
  });

  it('rookies swing harder on results and shrug off a benching; veterans are steadier but hate the bench', () => {
    expect(stageMoraleMultiplier('rookie', 'loss')).toBeGreaterThan(1);
    expect(stageMoraleMultiplier('veteran', 'loss')).toBeLessThan(1);
    expect(stageMoraleMultiplier('rookie', 'benched')).toBeLessThan(1);
    expect(stageMoraleMultiplier('veteran', 'benched')).toBeGreaterThan(1);
    expect(stageMoraleMultiplier(null, 'benched')).toBe(1);
    const loss = [{ type: 'loss' as const }];
    const rookieHit = adjustMorale(player(0), stageEvents(player(0), loss)[0]!).morale;
    const vetHit = adjustMorale(player(10), stageEvents(player(10), loss)[0]!).morale;
    const midHit = adjustMorale(player(4), stageEvents(player(4), loss)[0]!).morale;
    expect(rookieHit).toBeLessThan(midHit);
    expect(vetHit).toBeGreaterThan(midHit);
  });

  it('veterans and mentors in the lineup build rookie confidence (capped)', () => {
    expect(mentorshipBoost([player(9), player(2)])).toBe(0.5);
    expect(mentorshipBoost([player(3, ['mentor']), player(10), player(12)])).toBe(2);
    expect(mentorshipBoost(Array.from({ length: 10 }, () => player(3, ['mentor'])))).toBe(3);
  });
});
