import type { PlayContext } from '@/game/play-types';
import type { DefensivePlay, OffensivePlay, PlayConcept } from './types';

/** Helpers that pick kick plays and return units. On kick plays the KICKING team is the offense. */
export type SpecialKind = PlayContext['special'];

const CONCEPT_SPECIAL: Partial<Record<PlayConcept, SpecialKind>> = {
  kickoff: 'kickoff',
  onside: 'onside',
  punt: 'punt',
  fakePunt: 'punt',
  fieldGoal: 'fieldGoal',
  fakeFieldGoal: 'fieldGoal',
  extraPoint: 'extraPoint',
};

const FAKE_CONCEPTS = new Set<PlayConcept>(['fakePunt', 'fakeFieldGoal']);

/**
 * PlayContext.special for a play: kick concepts map by concept (fakes count as the kick they imitate, a fake
 * field goal tagged 'twoPoint' runs during the PAT), any other play tagged 'twoPoint' is a two-point try.
 */
export const isSpecialPlay = (play: OffensivePlay): SpecialKind => {
  const byConcept = CONCEPT_SPECIAL[play.concept];
  if (byConcept) return byConcept === 'fieldGoal' && play.concept === 'fakeFieldGoal' && play.tags.includes('twoPoint') ? 'extraPoint' : byConcept;
  return play.tags.includes('twoPoint') ? 'twoPoint' : 'none';
};

export const isKickConcept = (concept: PlayConcept): boolean => CONCEPT_SPECIAL[concept] !== undefined;
export const isFakePlay = (play: OffensivePlay): boolean => FAKE_CONCEPTS.has(play.concept);

/** Offensive formation id used for a special kind. */
export const specialFormationId = (kind: Exclude<SpecialKind, 'none' | 'twoPoint'>): string =>
  kind === 'kickoff' ? 'kickoff' : kind === 'onside' ? 'kickoffOnside' : kind === 'punt' ? 'punt' : 'fieldGoal';

/** Yards from the LOS to the uprights (7 yd hold + 10 yd end zone). */
export const fieldGoalDistance = (ballOn: number): number => 100 - ballOn + 17;

const firstWithTag = (plays: readonly OffensivePlay[], concept: PlayConcept, tag?: string): OffensivePlay | null =>
  plays.find((p) => p.concept === concept && (tag === undefined || p.tags.includes(tag))) ?? null;

/** Non-fake plays of a kick concept. */
export const specialPlays = (plays: readonly OffensivePlay[], concept: PlayConcept): OffensivePlay[] =>
  plays.filter((p) => p.concept === concept && !FAKE_CONCEPTS.has(p.concept));

/** Kickoff play: onside when requested, squib when requested and available, else the deep kick. */
export const kickoffPlay = (plays: readonly OffensivePlay[], opts: { onside?: boolean; squib?: boolean } = {}): OffensivePlay | null => {
  if (opts.onside) return firstWithTag(plays, 'onside');
  if (opts.squib) {
    const squib = firstWithTag(plays, 'kickoff', 'squib');
    if (squib) return squib;
  }
  return plays.find((p) => p.concept === 'kickoff' && !p.tags.includes('squib')) ?? firstWithTag(plays, 'kickoff');
};

/** Punt play: a pooch (pin) punt inside the opponent's 45, else the standard punt. */
export const puntPlay = (plays: readonly OffensivePlay[], ballOn: number): OffensivePlay | null => {
  if (ballOn >= 55) {
    const pooch = firstWithTag(plays, 'punt', 'pooch');
    if (pooch) return pooch;
  }
  return plays.find((p) => p.concept === 'punt' && !p.tags.includes('pooch')) ?? firstWithTag(plays, 'punt');
};

export const fieldGoalPlay = (plays: readonly OffensivePlay[]): OffensivePlay | null => firstWithTag(plays, 'fieldGoal');
export const extraPointPlay = (plays: readonly OffensivePlay[]): OffensivePlay | null => firstWithTag(plays, 'extraPoint');

/** Fake plays for a kick kind; `type` narrows to run or pass fakes. */
export const fakePlays = (plays: readonly OffensivePlay[], kind: 'punt' | 'fieldGoal', type?: 'run' | 'pass'): OffensivePlay[] =>
  plays.filter((p) => p.concept === (kind === 'punt' ? 'fakePunt' : 'fakeFieldGoal') && (type === undefined || p.type === type));

/**
 * Receiving/defending unit for a kick. kickoff -> kick return, onside -> hands team (falls back to kick return),
 * punt -> punt return, fieldGoal/extraPoint -> FG block. `block` prefers the all-out variant (punt 'block' /
 * FG 'edge' tag). null for 'none'/'twoPoint' (regular defense).
 */
export const returnPlay = (plays: readonly DefensivePlay[], kind: SpecialKind, opts: { block?: boolean } = {}): DefensivePlay | null => {
  const withTag = (tag: string, prefer?: string): DefensivePlay | null => {
    const tagged = plays.filter((p) => p.tags.includes(tag));
    if (prefer) {
      const preferred = tagged.find((p) => p.tags.includes(prefer));
      if (preferred) return preferred;
    }
    return tagged.find((p) => !p.tags.includes('onside') && !p.tags.includes('block')) ?? tagged[0] ?? null;
  };
  switch (kind) {
    case 'kickoff': return withTag('kickReturn');
    case 'onside': return withTag('kickReturn', 'onside');
    case 'punt': return withTag('puntReturn', opts.block ? 'block' : undefined);
    case 'fieldGoal':
    case 'extraPoint': return withTag('fgBlock', opts.block ? 'edge' : undefined);
    default: return null;
  }
};

/** Convenience: which kick kinds a play list can cover with a real (non-fake) kick play. */
export const coveredSpecialKinds = (plays: readonly OffensivePlay[]): SpecialKind[] => {
  const kinds = new Set<SpecialKind>();
  for (const p of plays) {
    const k = isSpecialPlay(p);
    if (k !== 'none' && k !== 'twoPoint' && !FAKE_CONCEPTS.has(p.concept)) kinds.add(k);
  }
  return [...kinds];
};
