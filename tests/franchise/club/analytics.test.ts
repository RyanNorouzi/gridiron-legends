import { describe, expect, it } from 'vitest';
import { coachIq, evaluateFourthDown, fourthDownDecision } from '@/ai/coaching';
import { getDifficulty } from '@/game/rulesets';
import { GAMEPLAN_RATING_SCALE, buildGameSetup, gameDayCoach } from '@/franchise/game-setup';
import { facilityEffects } from '@/franchise/facilities';
import type { League, ScheduledGame } from '@/franchise/types';
import type { Coach } from '@/teams/types';
import { clubLeague, patchTeam, userTeamOf } from './helpers';

const league = clubLeague();
const team = userTeamOf(league);
const hc = league.coaches[team.headCoachId!] as Coach;
const at = (level: number): League => patchTeam(league, team.id, (t) => ({ ...t, facilities: { ...t.facilities, analytics: level } }));
const other = Object.values(league.teams).find((t) => t.id !== team.id)!;
const game: ScheduledGame = { id: 'g_analytics' as ScheduledGame['id'], week: 1, home: team.id, away: other.id, isPlayoff: false, playoffRound: null, isPreseason: false, result: null };

describe('analytics game plan', () => {
  it('folds the department\'s game plan into the head coach he takes into games (a copy)', () => {
    expect(gameDayCoach(hc, at(1).teams[team.id]!)).toBe(hc);
    const top = at(5).teams[team.id]!;
    const bonus = Math.round(facilityEffects(top).gameplanBonus * GAMEPLAN_RATING_SCALE);
    expect(bonus).toBe(8);
    const planned = gameDayCoach(hc, top);
    expect(planned.ratings.gameManagement).toBe(Math.min(99, hc.ratings.gameManagement + bonus));
    expect(planned.ratings.offense).toBe(Math.min(99, hc.ratings.offense + bonus));
    expect(planned.ratings.defense).toBe(Math.min(99, hc.ratings.defense + bonus));
    expect(planned.ratings.motivation).toBe(hc.ratings.motivation);
    const setup = buildGameSetup(at(5), game);
    expect(setup.home.headCoach?.id).toBe(hc.id);
    expect(setup.home.headCoach?.ratings.gameManagement).toBe(planned.ratings.gameManagement);
    expect(at(5).coaches[hc.id]).toEqual(hc);
  });

  it('makes the AI coach sharper: higher play-calling IQ, and a borderline coach switches to expected-value fourth downs', () => {
    const difficulty = getDifficulty('pro');
    const low = at(1).teams[team.id]!;
    const high = at(5).teams[team.id]!;
    expect(coachIq(gameDayCoach(hc, high), difficulty, 'offense')).toBeGreaterThan(coachIq(gameDayCoach(hc, low), difficulty, 'offense'));
    // A coach just under the IQ bar decides 4th and 1 at the opponent 30 by rule of thumb (go); the same coach with
    // the top analytics department decides by expected value (ai/coaching.ts evaluateFourthDown) instead.
    const weak = { ...difficulty, playcallingIq: 0.4 };
    const borderline: Coach = { ...hc, traits: [], ratings: { ...hc.ratings, offense: 45, gameManagement: 50 } };
    const sit = { distance: 1, ballOn: 70, quarter: 1, secondsRemaining: 800, scoreDiff: 0, kickerRange: 52 };
    expect(coachIq(borderline, weak, 'offense')).toBeLessThan(0.45);
    expect(coachIq(gameDayCoach(borderline, high), weak, 'offense')).toBeGreaterThanOrEqual(0.45);
    const planned = gameDayCoach(borderline, high);
    const ev = evaluateFourthDown(planned, weak, sit);
    const best = (Object.keys(ev) as (keyof typeof ev)[]).reduce((a, b) => (ev[b] > ev[a] ? b : a));
    expect(fourthDownDecision(planned, weak, sit)).toBe(best);
    expect(fourthDownDecision(borderline, weak, sit)).toBe('go');
    expect(best).not.toBe('go');
  });
});
