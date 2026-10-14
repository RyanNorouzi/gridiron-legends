import type { CoachId, PlayerId, StadiumId, TeamId } from '@/core/ids';
import type { Position } from '@/players/types';

export interface TeamColors {
  primary: string;
  secondary: string;
  accent: string;
  helmet: string;
}

export type DepthSlot = Position | 'KR' | 'PR';
export type DepthChart = Record<DepthSlot, PlayerId[]>;

export interface DraftPick {
  /** Deterministic `${year}-r${round}-${originalTeamId}`. Team.picks is the canonical ownership record;
   *  copies held in DraftState.order / TradeAsset are value snapshots — match by id, never by reference. */
  id: string;
  year: number;
  round: number;
  originalTeamId: TeamId;
  ownerTeamId: TeamId;
  /** Resolved once draft order is set. */
  overall: number | null;
}

export interface TeamFinances {
  cash: number;
  ticketPrice: number;
  /** `media` (additive, optional): the league-wide broadcast distribution booked by franchise/finances.ts. */
  seasonRevenue: { tickets: number; merchandise: number; sponsors: number; concessions: number; media?: number };
  seasonExpenses: { playerSalaries: number; staffSalaries: number; stadium: number; facilities: number };
  /** Cap charges from released/traded players, keyed by season year. */
  deadMoney: Record<number, number>;
  /** Unused cap rolled into next season. */
  capCarryover: number;
}

export type FacilityType = 'training' | 'medical' | 'scouting' | 'stadium' | 'development' | 'analytics';
/** Level 1..5 per facility. */
export type Facilities = Record<FacilityType, number>;

export interface FanBase {
  /** 0..100 */
  support: number;
  /** 0..100 hype for the current season. */
  excitement: number;
  attendancePct: number;
}

export interface TeamSeasonRecord {
  year: number;
  wins: number;
  losses: number;
  ties: number;
  madePlayoffs: boolean;
  playoffResult: string | null;
  champion: boolean;
}

/* ------------------------------ Coaching staff ------------------------------ */

export type StaffRole =
  | 'HC' | 'OC' | 'DC' | 'QBCoach' | 'RBCoach' | 'WRCoach' | 'OLCoach' | 'DBCoach' | 'LBCoach' | 'StrengthCoach' | 'Scout';

/** 1..99 each. */
export interface CoachRatings {
  offense: number;
  defense: number;
  playerDevelopment: number;
  motivation: number;
  gameManagement: number;
  scouting: number;
  conditioning: number;
}

export type CoachTrait = 'aggressive' | 'conservative' | 'playersCoach' | 'disciplinarian' | 'innovator' | 'developer' | 'motivator' | 'clockManager';
export type OffensiveScheme = 'balanced' | 'airRaid' | 'westCoast' | 'groundAndPound' | 'spread';
export type DefensiveScheme = 'balanced' | 'blitzHeavy' | 'coverageFirst' | 'runStuff';

export interface Coach {
  id: CoachId;
  firstName: string;
  lastName: string;
  role: StaffRole;
  age: number;
  ratings: CoachRatings;
  traits: CoachTrait[];
  teamId: TeamId | null;
  salary: number;
  contractYears: number;
  offensiveScheme: OffensiveScheme;
  defensiveScheme: DefensiveScheme;
  careerWins: number;
  careerLosses: number;
  championships: number;
}

/* ---------------------------------- Team ---------------------------------- */

export interface Team {
  id: TeamId;
  city: string;
  name: string;
  abbr: string;
  conference: string;
  division: string;
  colors: TeamColors;
  /** Procedural logo generation seed. */
  logoSeed: number;
  stadiumId: StadiumId;
  /** Authoritative roster. Player.teamId is a denormalised mirror; change both only via franchise/roster.ts. */
  rosterIds: PlayerId[];
  depthChart: DepthChart;
  headCoachId: CoachId | null;
  staffIds: CoachId[];
  playbookId: string;
  rivalIds: TeamId[];
  picks: DraftPick[];
  finances: TeamFinances;
  facilities: Facilities;
  fans: FanBase;
  history: TeamSeasonRecord[];
  championships: number;
  /** Team-wide chemistry 0..100 */
  chemistry: number;
  /** Cached ratings */
  overall: number;
  offenseRating: number;
  defenseRating: number;
  /** Region key shared with Player.homeRegion (drives FA 'location' preference). */
  region: string;
  marketSize: 'small' | 'medium' | 'large';
  isUserControlled: boolean;
}

export interface Stadium {
  id: StadiumId;
  name: string;
  city: string;
  capacity: number;
  fieldType: 'grass' | 'turf';
  roof: 'open' | 'dome' | 'retractable';
  climate: 'temperate' | 'cold' | 'warm' | 'desert' | 'coastal';
  /** 1..99 */
  atmosphere: number;
  /** 1..5; upgrades raise capacity/atmosphere. */
  level: number;
  yearBuilt: number;
}
