import type { PlayerId, TeamId } from '@/core/ids';

/** All roster positions. KR/PR are depth-chart roles, not positions. */
export const POSITIONS = [
  'QB', 'RB', 'FB', 'WR', 'TE', 'OT', 'OG', 'C',
  'DE', 'DT', 'OLB', 'MLB', 'CB', 'FS', 'SS', 'K', 'P',
] as const;
export type Position = (typeof POSITIONS)[number];

export type PositionGroup = 'QB' | 'RB' | 'WR' | 'TE' | 'OL' | 'DL' | 'LB' | 'DB' | 'ST';

export const POSITION_GROUP: Record<Position, PositionGroup> = {
  QB: 'QB', RB: 'RB', FB: 'RB', WR: 'WR', TE: 'TE', OT: 'OL', OG: 'OL', C: 'OL',
  DE: 'DL', DT: 'DL', OLB: 'LB', MLB: 'LB', CB: 'DB', FS: 'DB', SS: 'DB', K: 'ST', P: 'ST',
};

export const OFFENSIVE_POSITIONS: readonly Position[] = ['QB', 'RB', 'FB', 'WR', 'TE', 'OT', 'OG', 'C'];
export const DEFENSIVE_POSITIONS: readonly Position[] = ['DE', 'DT', 'OLB', 'MLB', 'CB', 'FS', 'SS'];
export const SPECIAL_POSITIONS: readonly Position[] = ['K', 'P'];

/**
 * Ratings are integers 1..99. Every attribute exists on every player; position
 * weights (src/data/position-weights.json) decide which ones matter for overall.
 */
export const ATTRIBUTE_KEYS = [
  'speed', 'acceleration', 'strength', 'agility', 'balance', 'awareness', 'reaction',
  'stamina', 'injuryResistance', 'jumping',
  'hands', 'catching', 'routeRunning', 'release',
  'throwPower', 'throwAccuracy', 'vision', 'carrying',
  'tackling', 'coverage', 'pursuit', 'passRush', 'blocking',
  'kickPower', 'kickAccuracy',
] as const;
export type AttributeKey = (typeof ATTRIBUTE_KEYS)[number];
export type AttributeSet = Record<AttributeKey, number>;

/** How fast a player tends to develop; affects progression curves. */
export type DevTrait = 'bust' | 'normal' | 'quick' | 'star' | 'superstar';

export const PERSONALITY_TRAITS = [
  'leader', 'teamPlayer', 'competitive', 'quiet', 'hotHeaded',
  'injuryProne', 'workhorse', 'lazy', 'mentor',
] as const;
export type PersonalityTrait = (typeof PERSONALITY_TRAITS)[number];

/** Each 0..100. */
export interface Morale {
  morale: number;
  confidence: number;
  coachRelationship: number;
}

export type InjurySeverity = 'minor' | 'short' | 'moderate' | 'seasonEnding' | 'careerThreatening';

export interface InjuryStatus {
  /** Non-graphic label. */
  bodyArea: 'upperBody' | 'lowerBody' | 'head' | 'core';
  severity: InjurySeverity;
  weeksRemaining: number;
  /** Permanent attribute loss applied when injury is careerThreatening. */
  permanentPenalty: Partial<AttributeSet> | null;
  occurredYear: number;
  occurredWeek: number;
}

export type ContractRole = 'franchise' | 'starter' | 'rotation' | 'backup' | 'developmental';

/**
 * All money values are whole dollars. Canonical derivations (single owner: src/franchise/contracts.ts —
 * ui/ and save/ import those helpers rather than re-deriving):
 *   annual bonus proration  = signingBonus / years
 *   capHit(year)            = salary + signingBonus / years   for signedYear .. signedYear + years - 1
 *   deadMoneyIfReleased     = signingBonus * yearsRemaining / years + max(0, guaranteed - salary * (years - yearsRemaining))
 *   extension               = replace the Contract with a new one (new salary/years/signedYear)
 *   restructure             = salary -= X, signingBonus += X, restructured = true
 */
export interface Contract {
  salary: number;
  years: number;
  yearsRemaining: number;
  guaranteed: number;
  signingBonus: number;
  role: ContractRole;
  signedYear: number;
  /** True once the deal has been restructured (salary converted to prorated bonus). */
  restructured: boolean;
  /** Franchise/transition tag applied to this deal (spec: tag mechanics). */
  tag: 'franchise' | 'transition' | null;
}

export interface DraftInfo {
  year: number;
  round: number;
  pick: number;
  overall: number;
  teamId: TeamId;
}

/** Relative negotiation/free-agency weights, each 0..1 (consumers normalise). Hidden from the user except via agent talk. */
export interface PlayerPreferences {
  money: number;
  playingTime: number;
  winning: number;
  location: number;
  coach: number;
  role: number;
  chemistry: number;
}

export type ProgressionKind = 'normal' | 'breakout' | 'slump' | 'jump' | 'decline' | 'injury';

/** One entry per offseason progression pass; drives player-card history, breakout/decline events, HOF peak. */
export interface ProgressionEntry {
  year: number;
  overallBefore: number;
  overallAfter: number;
  deltas: Partial<AttributeSet>;
  kind: ProgressionKind;
}

export interface Player {
  id: PlayerId;
  firstName: string;
  lastName: string;
  position: Position;
  age: number;
  jerseyNumber: number;
  heightIn: number;
  weightLb: number;
  attrs: AttributeSet;
  /** Cached overall (1..99) derived from attrs via position weights. */
  overall: number;
  /** Ceiling overall this player can reach (1..99). Hidden from the user except via scouting. */
  potential: number;
  devTrait: DevTrait;
  /** Seasons of professional experience. 0 = rookie. */
  experience: number;
  traits: PersonalityTrait[];
  morale: Morale;
  contract: Contract | null;
  /** Mirror of Team.rosterIds membership; null = free agent / retired / prospect. Mutate only via franchise/roster.ts. */
  teamId: TeamId | null;
  /** The single open injury; closed injuries move to injuryHistory. */
  injury: InjuryStatus | null;
  /** Closed injuries, oldest first. Drives durability decline and injury-prone behaviour. */
  injuryHistory: InjuryStatus[];
  draft: DraftInfo | null;
  retired: boolean;
  /** Year the player entered the league. */
  rookieYear: number;
  /** Contract demand snapshot used in negotiations (per-year salary). */
  askingSalary: number;
  preferences: PlayerPreferences;
  /** Region key matching Team.region; drives the 'location' preference. */
  homeRegion: string;
  college: string | null;
  /** User/AI-chosen offseason + camp emphasis. null = balanced (position-weight default). */
  trainingFocus: AttributeKey | null;
  progressionLog: ProgressionEntry[];
}

export const isOffensive = (p: Position): boolean => OFFENSIVE_POSITIONS.includes(p);
export const isDefensive = (p: Position): boolean => DEFENSIVE_POSITIONS.includes(p);
export const isSpecialist = (p: Position): boolean => SPECIAL_POSITIONS.includes(p);
export const fullName = (p: Pick<Player, 'firstName' | 'lastName'>): string => `${p.firstName} ${p.lastName}`;
export const shortName = (p: Pick<Player, 'firstName' | 'lastName'>): string => `${p.firstName[0]}. ${p.lastName}`;
