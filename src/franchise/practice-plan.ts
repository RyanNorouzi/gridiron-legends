/**
 * In-season weekly practice: every team runs a practice plan between game weeks. REST (walkthroughs, rest days)
 * lets players shed carried wear faster at a small cost in team chemistry; NORMAL is the default week; INTENSE
 * (full pads) builds chemistry but adds wear to the whole roster and sheds less of it. The plan feeds season wear
 * (wear.ts applyWeekWear) and ClubState.chemistryBonus when the week is completed. AI teams rest a worn-down roster
 * and otherwise practise normally; the user's team uses the plan chosen in the hub. Pure.
 */
import type { PlayerId, TeamId } from '@/core/ids';
import { ensureClub, withClub } from './rivalries';
import type { League, PracticePlan } from './types';

export const PRACTICE_PLANS: readonly PracticePlan[] = ['rest', 'normal', 'intense'];

/** Tuning of the plans. */
export const PRACTICE_TUNING = Object.freeze({
  /** Multiplier on the share of carried wear a player keeps through the week. */
  retain: { rest: 0.7, normal: 1, intense: 1.2 } as Readonly<Record<PracticePlan, number>>,
  /** Wear every rostered player adds from practice itself. */
  practiceWear: { rest: 0, normal: 0, intense: 0.02 } as Readonly<Record<PracticePlan, number>>,
  /** Chemistry bonus added for the week (decays weekly like other chemistry adjustments). */
  chemistry: { rest: -0.5, normal: 0, intense: 1 } as Readonly<Record<PracticePlan, number>>,
  /** Average starter wear at which an AI staff calls a rest week. */
  aiRestWear: 0.15,
});

/** Display text of the plans. */
export const PRACTICE_LABELS: Readonly<Record<PracticePlan, { label: string; detail: string }>> = Object.freeze({
  rest: { label: 'Rest & recover', detail: 'Faster recovery; chemistry dips' },
  normal: { label: 'Normal week', detail: 'Balanced practice' },
  intense: { label: 'Full-pads practice', detail: 'More chemistry; more fatigue' },
});

/** The plan a team runs this week (stored choice, else normal). */
export const practicePlanOf = (league: Pick<League, 'club'>, teamId: TeamId): PracticePlan => league.club?.practicePlan?.[teamId] ?? 'normal';

/** League with the team's plan set (the user's choice from the hub). */
export const setPracticePlan = (league: League, teamId: TeamId, plan: PracticePlan): League =>
  withClub(league, { practicePlan: { ...ensureClub(league).practicePlan, [teamId]: plan } });

/** What an AI staff calls: rest when the roster carries heavy wear, else normal. */
export const aiPracticePlan = (league: Pick<League, 'teams' | 'fatigue'>, teamId: TeamId): PracticePlan => {
  const team = league.teams[teamId];
  if (!team || team.rosterIds.length === 0) return 'normal';
  const worn = team.rosterIds.map((id) => league.fatigue?.[id as PlayerId] ?? 0);
  const avg = worn.reduce((a, b) => a + b, 0) / worn.length;
  return avg >= PRACTICE_TUNING.aiRestWear ? 'rest' : 'normal';
};

/** Every team's plan for the week: the user's stored choice, AI teams by aiPracticePlan. */
export const weekPracticePlans = (league: League): Record<TeamId, PracticePlan> => {
  const out: Record<TeamId, PracticePlan> = {};
  for (const id of Object.keys(league.teams) as TeamId[]) out[id] = id === league.userTeamId ? practicePlanOf(league, id) : aiPracticePlan(league, id);
  return out;
};

/** The week's chemistry adjustments of the plans, added to ClubState.chemistryBonus. */
export const applyPracticeChemistry = (league: League, plans: Readonly<Record<TeamId, PracticePlan>>): League => {
  const club = ensureClub(league);
  const bonus = { ...club.chemistryBonus };
  let changed = false;
  for (const [id, plan] of Object.entries(plans) as [TeamId, PracticePlan][]) {
    const delta = PRACTICE_TUNING.chemistry[plan];
    if (delta === 0) continue;
    bonus[id] = Math.round(((bonus[id] ?? 0) + delta) * 100) / 100;
    changed = true;
  }
  return changed ? withClub(league, { chemistryBonus: bonus }) : league;
};
