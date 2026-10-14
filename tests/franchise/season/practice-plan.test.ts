import { describe, expect, it } from 'vitest';
import type { PlayerId, TeamId } from '@/core/ids';
import { createLeague } from '@/franchise/league';
import { aiPracticePlan, applyPracticeChemistry, practicePlanOf, setPracticePlan, weekPracticePlans } from '@/franchise/practice-plan';
import { advanceLeagueWeek } from '@/franchise/season-loop';
import { fallbackSimulator } from '@/franchise/sim-fallback';
import { applyWeekWear, nextWear } from '@/franchise/wear';

describe('weekly practice plan', () => {
  it('rest sheds carried wear faster, full pads slower and adds its own', () => {
    const normal = nextWear(0.2, 0, 60, 50, 'normal');
    expect(nextWear(0.2, 0, 60, 50, 'rest')).toBeLessThan(normal);
    expect(nextWear(0.2, 0, 60, 50, 'intense')).toBeGreaterThan(normal);
    expect(nextWear(0, 0, 60, 50, 'intense')).toBeGreaterThan(0);
    expect(nextWear(0.2, 0, 60)).toBe(normal);
  });

  it('the user plan is stored, AI staffs rest a worn roster, and chemistry follows the plan', () => {
    const league = createLeague({ seed: 4, userTeamAbbr: 'BOS' });
    const user = league.userTeamId as TeamId;
    expect(practicePlanOf(league, user)).toBe('normal');
    const resting = setPracticePlan(league, user, 'intense');
    expect(practicePlanOf(resting, user)).toBe('intense');
    const other = Object.keys(league.teams).find((id) => id !== user) as TeamId;
    const worn = Object.fromEntries(league.teams[other]!.rosterIds.map((id) => [id, 0.25])) as Record<PlayerId, number>;
    expect(aiPracticePlan({ ...league, fatigue: worn }, other)).toBe('rest');
    expect(aiPracticePlan(league, other)).toBe('normal');
    const plans = weekPracticePlans(resting);
    expect(plans[user]).toBe('intense');
    const chem = applyPracticeChemistry(resting, plans);
    expect(chem.club?.chemistryBonus?.[user]).toBe(1);
    // Intense practice wears every rostered player, even without snaps.
    const wear = applyWeekWear(resting, resting.players, {}, new Map(), { [user]: 'intense' });
    expect(Object.keys(wear).length).toBe(resting.teams[user]!.rosterIds.length);
  });

  it('a completed week applies the user plan to recovery', () => {
    const base = createLeague({ seed: 4, userTeamAbbr: 'BOS' });
    const user = base.userTeamId as TeamId;
    const starter = base.teams[user]!.rosterIds[0] as PlayerId;
    const tired = { ...base, fatigue: { [starter]: 0.25 } };
    const run = (plan: 'rest' | 'normal') => advanceLeagueWeek(setPracticePlan(tired, user, plan), { simulator: fallbackSimulator }).league.fatigue?.[starter] ?? 0;
    expect(run('rest')).toBeLessThan(run('normal'));
  });
});
