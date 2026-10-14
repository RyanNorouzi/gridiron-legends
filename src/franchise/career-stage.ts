/**
 * Career-stage personality tags: every first-year player is a Rookie and every player with VETERAN_SEASONS or more
 * seasons is a Veteran. They are derived from experience (they come and go as careers advance, unlike the drawn
 * personality traits) and shape weekly morale: rookies ride the highs and lows of results, prize playing time and
 * shrug off a benching, and gain confidence from veterans and mentors in the lineup; veterans are steadier about
 * results but take a benching and a contract year harder. Pure.
 */
import type { MoraleEvent, MoraleEventType } from '@/players/personality';
import type { Player } from '@/players/types';

export type CareerStage = 'rookie' | 'veteran';

/** Seasons of experience that make a Veteran. */
export const VETERAN_SEASONS = 8;

/** Display names of the tags. */
export const CAREER_STAGE_LABELS: Readonly<Record<CareerStage, string>> = Object.freeze({ rookie: 'Rookie', veteran: 'Veteran' });

/** The player's career-stage tag, or null in between. */
export const careerStage = (p: Pick<Player, 'experience'>): CareerStage | null =>
  p.experience <= 0 ? 'rookie' : p.experience >= VETERAN_SEASONS ? 'veteran' : null;

const MULTIPLIERS: Readonly<Record<CareerStage, Partial<Record<MoraleEventType, number>>>> = Object.freeze({
  rookie: { win: 1.3, loss: 1.3, teamSuccess: 1.2, playingTime: 1.5, benched: 0.6, praise: 1.3 },
  veteran: { win: 0.7, loss: 0.7, teamSuccess: 0.8, playingTime: 0.8, benched: 1.4, contract: 1.3, traded: 1.2 },
});

/** How strongly a player of `stage` reacts to an event type (1 = like everyone else). */
export const stageMoraleMultiplier = (stage: CareerStage | null, type: MoraleEventType): number =>
  stage ? MULTIPLIERS[stage][type] ?? 1 : 1;

/** The week's morale events scaled for the player's career stage. */
export const stageEvents = (p: Pick<Player, 'experience'>, events: readonly MoraleEvent[]): MoraleEvent[] => {
  const stage = careerStage(p);
  if (!stage) return [...events];
  return events.map((e) => ({ ...e, magnitude: Math.min(3, (e.magnitude ?? 1) * stageMoraleMultiplier(stage, e.type)) }));
};

/** Confidence points a rookie gains per week from the veterans (0.5 each) and mentors (1 each) among `starters`, capped at 3. */
export const mentorshipBoost = (starters: readonly Pick<Player, 'experience' | 'traits'>[]): number => {
  let boost = 0;
  for (const s of starters) {
    if (s.traits.includes('mentor')) boost += 1;
    else if (careerStage(s) === 'veteran') boost += 0.5;
  }
  return Math.min(3, boost);
};

/** Personality tags for display: the drawn traits plus the career-stage tag. */
export const personalityTags = (p: Pick<Player, 'experience' | 'traits'>): string[] => {
  const stage = careerStage(p);
  return [...p.traits, ...(stage ? [stage] : [])];
};
