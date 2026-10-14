import type { PlayerId, TeamId } from '@/core/ids';

export interface PassingStats {
  attempts: number; completions: number; yards: number; touchdowns: number; interceptions: number;
  sacks: number; sackYards: number; longest: number; airYards: number; pressures: number; throwaways: number;
}
export interface RushingStats {
  attempts: number; yards: number; touchdowns: number; longest: number; fumbles: number;
  yardsAfterContact: number; brokenTackles: number; firstDowns: number; explosivePlays: number;
}
export interface ReceivingStats {
  targets: number; receptions: number; yards: number; touchdowns: number; longest: number;
  drops: number; yac: number; contestedCatches: number; firstDowns: number;
  airYards: number;
  /** Sum of separation (yards) at each target; average = separationTotal / targets. */
  separationTotal: number;
  explosivePlays: number;
}
export interface DefensiveStats {
  tackles: number; soloTackles: number; assists: number; sacks: number; tfl: number; interceptions: number;
  interceptionYards: number; passBreakups: number; forcedFumbles: number; fumbleRecoveries: number;
  touchdowns: number; missedTackles: number; pressures: number; hitSticks: number; targetsAllowed: number;
  receptionsAllowed: number; yardsAllowed: number; passRushSnaps: number; coverageSnaps: number;
}
export interface KickingStats {
  fgAttempts: number; fgMade: number; fgLong: number; xpAttempts: number; xpMade: number;
  punts: number; puntYards: number; puntsInside20: number; puntLong: number; touchbacks: number; kickoffs: number;
}
export interface ReturnStats {
  kickReturns: number; kickReturnYards: number; puntReturns: number; puntReturnYards: number;
  returnTouchdowns: number; longest: number;
}
export interface BlockingStats {
  pancakes: number; sacksAllowed: number; pressuresAllowed: number; snaps: number;
}
export interface PlayerStatLine {
  passing: PassingStats;
  rushing: RushingStats;
  receiving: ReceivingStats;
  defense: DefensiveStats;
  kicking: KickingStats;
  returns: ReturnStats;
  blocking: BlockingStats;
  snaps: number;
  fumbles: number;
  fumblesLost: number;
  gamesPlayed: number;
  gamesStarted: number;
  /** Touches + targets; denominator for epaPerPlay / successRate. */
  offensivePlays: number;
  successfulPlays: number;
  epa: number;
}
export type StatCategory = 'passing' | 'rushing' | 'receiving' | 'defense' | 'kicking' | 'returns' | 'blocking';

/** Every valid PlayStatDelta key, derived from PlayerStatLine so typos fail at compile time. */
export type StatPath =
  | 'snaps' | 'fumbles' | 'fumblesLost' | 'gamesPlayed' | 'gamesStarted' | 'offensivePlays' | 'successfulPlays' | 'epa'
  | { [C in StatCategory]: `${C}.${Extract<keyof PlayerStatLine[C], string>}` }[StatCategory];

export interface TeamStatLine {
  points: number; totalYards: number; passYards: number; rushYards: number; plays: number;
  turnovers: number; takeaways: number; firstDowns: number;
  thirdDownAttempts: number; thirdDownConversions: number;
  fourthDownAttempts: number; fourthDownConversions: number;
  redZoneTrips: number; redZoneTouchdowns: number;
  timeOfPossessionSec: number; penalties: number; penaltyYards: number;
  sacks: number; explosivePlays: number; successfulPlays: number; epa: number; drives: number;
  pointsAgainst: number; yardsAgainst: number;
}

export interface GameStats {
  players: Record<PlayerId, PlayerStatLine>;
  teams: Record<'home' | 'away', TeamStatLine>;
  /** Additive: the team each player's line was recorded for (the side he dressed for in that game). Filled by the
   *  franchise simulator adapters and the user-game converter; absent on box scores stored before it (readers fall
   *  back to the player's current team, see statistics/game-teams.ts). */
  playerTeams?: Record<PlayerId, TeamId>;
}

/** One increment produced by a play; applied via statistics/apply. */
export interface PlayStatDelta {
  playerId: PlayerId;
  stat: StatPath;
  value: number;
}

export interface AdvancedPlayerStats {
  passerRating: number; completionPct: number; yardsPerAttempt: number; yardsPerCarry: number;
  catchRate: number; yacPerReception: number; avgSeparation: number; missedTackleRate: number; tackleSuccessRate: number;
  pressureRate: number; coverageSuccessRate: number; explosivePlayRate: number; epaPerPlay: number; successRate: number;
}

export interface SeasonStatEntry {
  playerId: PlayerId;
  teamId: TeamId | null;
  year: number;
  line: PlayerStatLine;
  playoffLine: PlayerStatLine | null;
}

export interface CareerStats {
  playerId: PlayerId;
  seasons: SeasonStatEntry[];
  totals: PlayerStatLine;
}
