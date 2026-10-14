import type { GameId, PlayerId, TeamId } from '@/core/ids';
import type { RngState } from '@/core/rng';
import type { InjurySeverity, Player } from '@/players/types';
import type { DefAssignment, DefensivePlay, OffensivePlay } from '@/playbook/types';
import type { GameStats } from '@/statistics/types';
import type { Coach, Stadium, Team } from '@/teams/types';
import type { PlayOutcome } from './play-types';
import type { ReviewableCall } from './play-events';

export type * from './play-types';
export type * from './play-events';

/**
 * FIELD COORDINATE CONVENTION (absolute, yards):
 *   x: 0 .. FIELD_WIDTH (53.33) across the field; x=0 is the LEFT sideline when looking toward +y.
 *   y: 0 .. FIELD_LENGTH (120). y in [0,10] south end zone, [10,110] field of play, [110,120] north end zone.
 * The offense attacks in `direction` (+1 = toward y=120, -1 = toward y=0).
 * `ballOn` is ALWAYS the offense's perspective: yards from the offense's own goal line (1..99).
 *   fieldY(ballOn, dir) = dir === 1 ? 10 + ballOn : 110 - ballOn
 * Lateral spot: `ballX` (absolute). Spotting rule — ball dead outside the hashes (incl. out of bounds) →
 * nearest hash (spotBallX); between the hashes → stays. Kickoffs, FG and XP snap from MIDDLE_X. The
 * controller applies spotBallX to outcome.endBallX; FastSim may return MIDDLE_X or a sample between the hashes.
 * Held ball pos == carrier.pos (no offset). Goal line / first-down / safety checks use ball.pos.y. Out of bounds
 * uses the carrier's centre x outside [0, FIELD_WIDTH] (ball.pos for a loose/in-air ball); a sideline catch
 * requires the receiver centre inside by >= 0.25 yd at the catch tick.
 */
export const FIELD_WIDTH = 160 / 3;
export const FIELD_LENGTH = 120;
export const END_ZONE_DEPTH = 10;
export const MIDDLE_X = FIELD_WIDTH / 2;
export const HASH_LEFT = MIDDLE_X - 3.08;
export const HASH_RIGHT = MIDDLE_X + 3.08;

export type TeamSide = 'home' | 'away';
export type Side = 'offense' | 'defense';
export type Direction = 1 | -1;

export const otherSide = (s: TeamSide): TeamSide => (s === 'home' ? 'away' : 'home');
export const fieldY = (ballOn: number, dir: Direction): number => (dir === 1 ? END_ZONE_DEPTH + ballOn : FIELD_LENGTH - END_ZONE_DEPTH - ballOn);
export const ballOnFromY = (y: number, dir: Direction): number => (dir === 1 ? y - END_ZONE_DEPTH : FIELD_LENGTH - END_ZONE_DEPTH - y);
export const spotBallX = (x: number): number => (x < HASH_LEFT ? HASH_LEFT : x > HASH_RIGHT ? HASH_RIGHT : x);
export const hashMark = (x: number): 'left' | 'middle' | 'right' => (x < HASH_LEFT ? 'left' : x > HASH_RIGHT ? 'right' : 'middle');

export type GameMode = 'arcade' | 'simulation';

/** Data-driven rules; presets live in src/data/rulesets.json. */
export interface Ruleset {
  id: string;
  mode: GameMode;
  quarterLengthSec: number;
  playClockSec: number;
  /** Seconds burned off a running clock between plays (huddle). */
  huddleRunoffSec: number;
  penalties: boolean;
  /** 0..1 scalar on penalty frequency. */
  penaltyFrequency: number;
  fatigue: boolean;
  injuries: boolean;
  twoMinuteWarning: boolean;
  timeoutsPerHalf: number;
  overtime: 'none' | 'suddenDeath' | 'modified';
  overtimeLengthSec: number;
  /** Regular-season cap on OT periods; 0 = unlimited. Playoffs (GameState.isPlayoff) are always unlimited. */
  maxOvertimePeriods: number;
  challenges: boolean;
  challengesPerGame: number;
  kickoffs: boolean;
  extraPointYardLine: number;
  twoPointYardLine: number;
  kickoffYardLine: number;
  touchbackYardLine: number;
  /** Arcade: fewer stoppages, exaggerated moves. */
  exaggeratedMoves: boolean;
  firstDownClockStop: boolean;
}

export type DifficultyId = 'rookie' | 'pro' | 'allPro' | 'legend';

/**
 * Difficulty tunes AI DECISION QUALITY and reaction. 0..1 unless noted. Presets in src/data/difficulty.json.
 * In a human-vs-CPU game only the CPU team plays under the selected profile (the human's AI teammates use the neutral
 * 'pro' decisions, game/difficulty-sides.ts); All-Pro and Legend also give the CPU team a clearly labelled
 * PERFORMANCE EDGE (the cpu*Edge fields), the one place difficulty touches effective ratings.
 */
export interface DifficultyProfile {
  id: DifficultyId;
  name: string;
  /** Seconds of delay before AI defenders react to a new stimulus (ball thrown, cut, handoff). */
  aiReactionDelay: number;
  coverageAnticipation: number;
  /** 1 = optimal intercept angle, 0 = chase current position. */
  pursuitQuality: number;
  tackleDecisionQuality: number;
  qbDecisionQuality: number;
  receiverIntelligence: number;
  blockingIq: number;
  playcallingIq: number;
  /** Assist for user ball-security (higher = fewer user fumbles). */
  userBallSecurityAssist: number;
  /** Assist for user throws (catch radius forgiveness). */
  userPassAssist: number;
  interceptionAwareness: number;
  /**
   * Assist for the user's open-field tackling (0..1): how well the user's defender breaks down and reads the
   * carrier's cut when closing on him. Only the human is affected; optional so older literals keep compiling
   * (the preset loader always fills it; consumers default to the pro value).
   */
  userTackleAssist?: number;
  /**
   * CPU PERFORMANCE EDGE, speed: fractional boost (0.1 = +10%) to the CPU team's effective speed, acceleration and
   * agility. 0 at Rookie/Pro. Applied only to the CPU side of a human-vs-CPU game (never AI-vs-AI). Optional: absent = 0.
   */
  cpuSpeedEdge?: number;
  /** CPU PERFORMANCE EDGE, strength: fractional boost to the CPU team's strength and balance (see cpuSpeedEdge). */
  cpuStrengthEdge?: number;
  /**
   * CPU PERFORMANCE EDGE, skill: fractional boost to the CPU team's ball and technique ratings (catching, hands,
   * throw accuracy, tackling, carrying = ball security, blocking and pass rush = block win rate, route running,
   * release, coverage), plus the same share on a CPU defender's chance to finish an interception. See cpuSpeedEdge.
   */
  cpuSkillEdge?: number;
}

export type WeatherType = 'clear' | 'rain' | 'heavyRain' | 'snow' | 'wind' | 'extremeCold' | 'heat';

export interface WeatherState {
  type: WeatherType;
  /** Wind direction in radians (absolute field frame) and mph. */
  windDir: number;
  windMph: number;
  temperatureF: number;
  precipitation: number;
  /** 0..1, 1 = perfect. */
  visibility: number;
  /** 0..1 slipperiness applied to traction. */
  fieldSlick: number;
}

export interface GameClock {
  quarter: number;
  secondsRemaining: number;
  running: boolean;
  playClock: number;
  playClockRunning: boolean;
}

export type DriveResult =
  | 'touchdown' | 'fieldGoal' | 'missedFieldGoal' | 'punt' | 'interception' | 'fumble'
  | 'downs' | 'safety' | 'endOfHalf' | 'endOfGame' | 'kneel';

export interface DriveState {
  possession: TeamSide;
  startBallOn: number;
  startQuarter: number;
  startClock: number;
  plays: number;
  yards: number;
  result: DriveResult | null;
  /** True once this drive has snapped at or inside the opponent 20 (counted as one red-zone trip). */
  redZone?: boolean;
}

export type GamePhase =
  | 'pregame' | 'coinToss' | 'kickoff' | 'playcall' | 'presnap' | 'live' | 'deadball'
  | 'pat' | 'twoMinute' | 'halftime' | 'timeout' | 'challenge' | 'final';

export type ControllerKind = 'human' | 'ai' | 'watch';

export interface OvertimeState {
  period: number;
  possessions: Record<TeamSide, number>;
  firstPossessionResult: 'touchdown' | 'fieldGoal' | 'none' | null;
  /** True once both sides have possessed (modified) or always (suddenDeath). */
  suddenDeath: boolean;
}

/* ------------------------- Between-play command seam ------------------------- */

export type PendingDecisionKind = 'coinToss' | 'playCall' | 'penaltyDecision' | 'challengeWindow' | 'freeKick';

export interface PendingDecision {
  side: TeamSide;
  kind: PendingDecisionKind;
  /** Real seconds left to decide (challengeWindow) or null. */
  deadlineSec: number | null;
}

/**
 * The ONLY way anything outside GameController changes game flow between plays. Issued by ui screens,
 * ai/coaching.ts, simulation/game-sim.ts, watch-mode and scenario tests. XP vs 2-pt, punt vs go, onside vs
 * normal kickoff and fakes are all just `callPlay` with the matching PlayConcept.
 */
export type GameCommand = { side: TeamSide } & (
  | { type: 'coinToss'; choice: 'kick' | 'receive' | 'defer' }
  | { type: 'callPlay'; offensivePlayId?: string; defensivePlayId?: string; hurryUp?: boolean; assignmentOverrides?: Record<string, DefAssignment> }
  | { type: 'timeout' }
  | { type: 'challenge' }
  | { type: 'penaltyDecision'; accept: boolean }
  | { type: 'freeKick'; choice: 'kick' | 'punt' }
  /** playerId null returns the role to AUTO (the override is removed; depth chart + fatigue rotation pick again). */
  | { type: 'substitute'; role: string; playerId: PlayerId | null }
  | { type: 'watch'; action: 'skip' | 'speedUp' | 'speedDown' | 'jumpIn' | 'resume' }
);

/* ------------------------------ Game setup seam ------------------------------ */

/** Everything the controller needs for one side, resolved by the caller (franchise/ from League, ui QuickGame from data JSON). */
export interface GameTeamSetup {
  team: Team;
  players: Record<PlayerId, Player>;
  headCoach: Coach | null;
  /** Additive: the offensive coordinator (his scheme pulls the run/pass lean halfway toward his own). */
  offensiveCoordinator?: Coach | null;
  /** Additive: the defensive coordinator (his scheme and temperament pull the pressure lean toward his own). */
  defensiveCoordinator?: Coach | null;
  offensePlays: OffensivePlay[];
  defensePlays: DefensivePlay[];
}

export interface GameSetup {
  id: GameId;
  home: GameTeamSetup;
  away: GameTeamSetup;
  stadium: Stadium;
  ruleset: Ruleset;
  difficulty: DifficultyProfile;
  weather: WeatherState;
  seed: number;
  userSide: TeamSide | null;
  controllers: Record<TeamSide, ControllerKind>;
  isPlayoff: boolean;
  /** Additive: fatigue 0..1 carried into the game per player (franchise League.fatigue). Missing = fully rested;
   *  only used when the ruleset has fatigue on. */
  fatigue?: Record<PlayerId, number>;
  /** Additive: the side the human manages (franchise user team) even when the game is simulated with both sides
   *  AI, so a simmed user game still faces the CPU at the selected difficulty. Absent/null = no human team. */
  humanTeam?: TeamSide | null;
}

/* --------------------------------- GameState --------------------------------- */

export interface GameInjury {
  playerId: PlayerId;
  severity: InjurySeverity;
  quarter: number;
  playIndex: number;
}

export interface PlayLogEntry {
  index: number;
  quarter: number;
  clock: number;
  possession: TeamSide;
  down: number;
  distance: number;
  ballOn: number;
  ballX: number;
  offensivePlayId: string | null;
  defensivePlayId: string | null;
  /** The outcome that was finally applied (after penalty decisions and any overturn). */
  outcome: PlayOutcome;
  scoreAfter: Record<TeamSide, number>;
  review: { call: ReviewableCall; challengedBy: TeamSide; result: 'upheld' | 'overturned' } | null;
}

export interface GameState {
  id: GameId;
  home: TeamId;
  away: TeamId;
  possession: TeamSide;
  direction: Direction;
  down: number;
  distance: number;
  ballOn: number;
  /** Absolute x of the ball for the NEXT snap. Reset to MIDDLE_X for kickoffs/PATs. */
  ballX: number;
  score: Record<TeamSide, number>;
  clock: GameClock;
  timeouts: Record<TeamSide, number>;
  challenges: Record<TeamSide, number>;
  phase: GamePhase;
  pendingDecision: PendingDecision | null;
  twoMinuteWarningGiven: { half1: boolean; half2: boolean };
  drive: DriveState;
  playLog: PlayLogEntry[];
  stats: GameStats;
  weather: WeatherState;
  ruleset: Ruleset;
  difficulty: DifficultyProfile;
  overtimePeriods: number;
  overtime: OvertimeState | null;
  isPlayoff: boolean;
  receivedOpeningKickoff: TeamSide | null;
  /** When non-null, the next play is a kickoff by this side. */
  kickoffPending: TeamSide | null;
  /** Set after a TD: the scoring team must attempt a PAT/2pt. */
  patPending: TeamSide | null;
  seed: number;
  /** Rng stream position after the last completed play; restoreRng(seed, rngState) reproduces the next play. */
  rngState: RngState;
  /** Local viewer's side (camera/HUD). `controllers` is authoritative for who decides. */
  userSide: TeamSide | null;
  controllers: Record<TeamSide, ControllerKind>;
  lastOutcome: PlayOutcome | null;
  fatigue: Record<PlayerId, number>;
  injuries: GameInjury[];
  /** Additive (GameSetup.humanTeam): the side the human manages even while both sides are AI-simulated. */
  humanTeam?: TeamSide | null;
  /** Save-format version for migrations. */
  version: number;
}
