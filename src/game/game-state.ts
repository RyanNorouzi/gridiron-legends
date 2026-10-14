import type { PlayerId } from '@/core/ids';
import { createRng } from '@/core/rng';
import { emptyGameStats, emptyPlayerStatLine } from '@/statistics/empty';
import type { GameStats } from '@/statistics/types';
import { MIDDLE_X, type Direction, type DriveState, type GameSetup, type GameState, type TeamSide } from './types';

/** Current save-format version written into every new GameState. */
export const GAME_STATE_VERSION = 1;

/**
 * Attack direction of a side in a given period. Home attacks +y in odd periods (Q1, Q3, OT1...) and the
 * ends switch every period, so the direction of the current offense is always a pure function of
 * (possession, quarter) — no flip bookkeeping needed.
 */
export const directionFor = (side: TeamSide, quarter: number): Direction => {
  const homeDir: Direction = quarter % 2 === 1 ? 1 : -1;
  return side === 'home' ? homeDir : ((-homeDir) as Direction);
};

/** A fresh drive record for `side` starting at `ballOn`. */
export const newDrive = (side: TeamSide, ballOn: number, quarter: number, clock: number): DriveState => ({
  possession: side,
  startBallOn: ballOn,
  startQuarter: quarter,
  startClock: clock,
  plays: 0,
  yards: 0,
  result: null,
});

/** Zeroed player lines for everyone in the setup so box scores list every dressed player. */
const initialStats = (setup: GameSetup): GameStats => {
  const stats = emptyGameStats();
  for (const side of ['home', 'away'] as const) {
    for (const id of Object.keys(setup[side].players)) stats.players[id as PlayerId] = emptyPlayerStatLine();
  }
  return stats;
};

const validateSetup = (setup: GameSetup): void => {
  if (!setup.id) throw new Error('GameSetup: missing game id');
  if (!Number.isFinite(setup.seed)) throw new Error('GameSetup: seed must be a finite number');
  for (const side of ['home', 'away'] as const) {
    const t = setup[side];
    if (!t.team?.id) throw new Error(`GameSetup: ${side} team is missing`);
    if (Object.keys(t.players).length === 0) throw new Error(`GameSetup: ${side} roster is empty`);
    for (const pid of t.team.rosterIds) {
      if (!t.players[pid]) throw new Error(`GameSetup: ${side} roster references unknown player ${pid}`);
    }
  }
  if (setup.home.team.id === setup.away.team.id) throw new Error('GameSetup: home and away must be different teams');
  if (setup.userSide !== null) {
    const kind = setup.controllers[setup.userSide];
    if (kind === 'ai') throw new Error(`GameSetup: userSide ${setup.userSide} cannot be controlled by 'ai'`);
  }
  if (setup.ruleset.extraPointYardLine >= 100 || setup.ruleset.twoPointYardLine >= 100) throw new Error('GameSetup: invalid PAT yard lines');
};

/**
 * Initial GameState for a setup: pregame, zero score, home nominally in possession, rng stream at the
 * seed's origin (the controller forks per-play generators from it and writes the state back after every play).
 */
export const createGameState = (setup: GameSetup): GameState => {
  validateSetup(setup);
  const ruleset = { ...setup.ruleset };
  const rng = createRng(setup.seed);
  const fatigue: Record<PlayerId, number> = {};
  for (const side of ['home', 'away'] as const) {
    for (const id of Object.keys(setup[side].players)) {
      const carried = ruleset.fatigue ? setup.fatigue?.[id as PlayerId] ?? 0 : 0;
      fatigue[id as PlayerId] = Number.isFinite(carried) ? Math.min(1, Math.max(0, carried)) : 0;
    }
  }
  return {
    id: setup.id,
    home: setup.home.team.id,
    away: setup.away.team.id,
    possession: 'home',
    direction: directionFor('home', 1),
    down: 1,
    distance: 10,
    ballOn: ruleset.kickoffYardLine,
    ballX: MIDDLE_X,
    score: { home: 0, away: 0 },
    clock: {
      quarter: 1,
      secondsRemaining: ruleset.quarterLengthSec,
      running: false,
      playClock: ruleset.playClockSec,
      playClockRunning: false,
    },
    timeouts: { home: ruleset.timeoutsPerHalf, away: ruleset.timeoutsPerHalf },
    challenges: { home: ruleset.challengesPerGame, away: ruleset.challengesPerGame },
    phase: 'pregame',
    pendingDecision: null,
    twoMinuteWarningGiven: { half1: false, half2: false },
    drive: newDrive('home', ruleset.kickoffYardLine, 1, ruleset.quarterLengthSec),
    playLog: [],
    stats: initialStats(setup),
    weather: { ...setup.weather },
    ruleset,
    difficulty: { ...setup.difficulty },
    overtimePeriods: 0,
    overtime: null,
    isPlayoff: setup.isPlayoff,
    receivedOpeningKickoff: null,
    kickoffPending: null,
    patPending: null,
    seed: setup.seed,
    rngState: rng.getState(),
    userSide: setup.userSide,
    controllers: { ...setup.controllers },
    lastOutcome: null,
    fatigue,
    injuries: [],
    ...(setup.humanTeam ? { humanTeam: setup.humanTeam } : {}),
    version: GAME_STATE_VERSION,
  };
};

/** The side that does NOT have the ball (or, on kick plays, the receiving team). */
export const defenseOf = (state: Pick<GameState, 'possession'>): TeamSide => (state.possession === 'home' ? 'away' : 'home');

/** True while the game clock still has time in the current period. */
export const hasTimeLeft = (state: Pick<GameState, 'clock'>): boolean => state.clock.secondsRemaining > 0;

/** Score margin from a side's point of view (positive = leading). */
export const marginFor = (state: Pick<GameState, 'score'>, side: TeamSide): number =>
  state.score[side] - state.score[side === 'home' ? 'away' : 'home'];

/** 1 for Q1/Q2, 2 for Q3/Q4 and overtime (two-minute-warning bookkeeping). */
export const halfOf = (quarter: number): 1 | 2 => (quarter <= 2 ? 1 : 2);
