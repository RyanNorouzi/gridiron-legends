import type {
  BlockingStats, DefensiveStats, GameStats, KickingStats, PassingStats, PlayerStatLine,
  ReceivingStats, ReturnStats, RushingStats, TeamStatLine,
} from './types';

/** All-zero passing bucket. */
export const emptyPassingStats = (): PassingStats => ({
  attempts: 0, completions: 0, yards: 0, touchdowns: 0, interceptions: 0,
  sacks: 0, sackYards: 0, longest: 0, airYards: 0, pressures: 0, throwaways: 0,
});

/** All-zero rushing bucket. */
export const emptyRushingStats = (): RushingStats => ({
  attempts: 0, yards: 0, touchdowns: 0, longest: 0, fumbles: 0,
  yardsAfterContact: 0, brokenTackles: 0, firstDowns: 0, explosivePlays: 0,
});

/** All-zero receiving bucket. */
export const emptyReceivingStats = (): ReceivingStats => ({
  targets: 0, receptions: 0, yards: 0, touchdowns: 0, longest: 0,
  drops: 0, yac: 0, contestedCatches: 0, firstDowns: 0,
  airYards: 0, separationTotal: 0, explosivePlays: 0,
});

/** All-zero defensive bucket. */
export const emptyDefensiveStats = (): DefensiveStats => ({
  tackles: 0, soloTackles: 0, assists: 0, sacks: 0, tfl: 0, interceptions: 0,
  interceptionYards: 0, passBreakups: 0, forcedFumbles: 0, fumbleRecoveries: 0,
  touchdowns: 0, missedTackles: 0, pressures: 0, hitSticks: 0, targetsAllowed: 0,
  receptionsAllowed: 0, yardsAllowed: 0, passRushSnaps: 0, coverageSnaps: 0,
});

/** All-zero kicking bucket. */
export const emptyKickingStats = (): KickingStats => ({
  fgAttempts: 0, fgMade: 0, fgLong: 0, xpAttempts: 0, xpMade: 0,
  punts: 0, puntYards: 0, puntsInside20: 0, puntLong: 0, touchbacks: 0, kickoffs: 0,
});

/** All-zero return bucket. */
export const emptyReturnStats = (): ReturnStats => ({
  kickReturns: 0, kickReturnYards: 0, puntReturns: 0, puntReturnYards: 0,
  returnTouchdowns: 0, longest: 0,
});

/** All-zero blocking bucket. */
export const emptyBlockingStats = (): BlockingStats => ({
  pancakes: 0, sacksAllowed: 0, pressuresAllowed: 0, snaps: 0,
});

/** A complete all-zero player stat line. Every consumer that needs a line "on demand" starts from this. */
export const emptyPlayerStatLine = (): PlayerStatLine => ({
  passing: emptyPassingStats(),
  rushing: emptyRushingStats(),
  receiving: emptyReceivingStats(),
  defense: emptyDefensiveStats(),
  kicking: emptyKickingStats(),
  returns: emptyReturnStats(),
  blocking: emptyBlockingStats(),
  snaps: 0,
  fumbles: 0,
  fumblesLost: 0,
  gamesPlayed: 0,
  gamesStarted: 0,
  offensivePlays: 0,
  successfulPlays: 0,
  epa: 0,
});

/** A complete all-zero team stat line. */
export const emptyTeamStatLine = (): TeamStatLine => ({
  points: 0, totalYards: 0, passYards: 0, rushYards: 0, plays: 0,
  turnovers: 0, takeaways: 0, firstDowns: 0,
  thirdDownAttempts: 0, thirdDownConversions: 0,
  fourthDownAttempts: 0, fourthDownConversions: 0,
  redZoneTrips: 0, redZoneTouchdowns: 0,
  timeOfPossessionSec: 0, penalties: 0, penaltyYards: 0,
  sacks: 0, explosivePlays: 0, successfulPlays: 0, epa: 0, drives: 0,
  pointsAgainst: 0, yardsAgainst: 0,
});

/** Empty game stats: no player lines yet, zeroed team lines for both sides. */
export const emptyGameStats = (): GameStats => ({
  players: {},
  teams: { home: emptyTeamStatLine(), away: emptyTeamStatLine() },
});
