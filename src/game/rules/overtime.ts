import { MIDDLE_X, type GameState, type TeamSide } from '../types';
import { directionFor } from '../game-state';
import { nextPlayClock } from './clock';
import type { ScoreResult } from './scoring';

/**
 * Overtime. `suddenDeath`: first score wins. `modified`: both teams possess unless the first
 * possession ends in a touchdown (or a safety); a first-possession field goal gives the other side one
 * possession to match (sudden death after that) or win with a touchdown. Regular-season games can end
 * tied after `maxOvertimePeriods`; playoffs continue until someone scores.
 */
export const OVERTIME_TIMEOUTS = 2;

export interface OvertimeVerdict {
  gameOver: boolean;
  reason: 'touchdown' | 'fieldGoal' | 'safety' | 'defensiveStop' | 'twoPoint' | null;
}

const NOT_OVER: OvertimeVerdict = { gameOver: false, reason: null };

export const isTied = (state: Pick<GameState, 'score'>): boolean => state.score.home === state.score.away;

/** True when another overtime period may be played after a tied period. */
export const canPlayAnotherPeriod = (state: Pick<GameState, 'isPlayoff' | 'ruleset' | 'overtimePeriods'>): boolean =>
  state.isPlayoff || state.ruleset.maxOvertimePeriods === 0 || state.overtimePeriods < state.ruleset.maxOvertimePeriods;

/** Whether the ruleset plays overtime at all for a tied regulation. */
export const overtimeAllowed = (state: Pick<GameState, 'ruleset'>): boolean => state.ruleset.overtime !== 'none';

const resetPeriodClock = (state: GameState): void => {
  state.clock.quarter = 4 + state.overtimePeriods;
  state.clock.secondsRemaining = state.ruleset.overtimeLengthSec;
  state.clock.running = false;
  state.clock.playClock = nextPlayClock(state.ruleset, true);
  state.clock.playClockRunning = false;
  state.twoMinuteWarningGiven.half2 = false;
};

/**
 * Enters the first overtime period: fresh timeouts, a new OvertimeState and a coin toss (the controller
 * rolls the winner and posts the PendingDecision). Possession/kickoff are set by that toss.
 */
export const startOvertime = (state: GameState): void => {
  state.overtimePeriods = 1;
  state.overtime = {
    period: 1,
    possessions: { home: 0, away: 0 },
    firstPossessionResult: null,
    suddenDeath: state.ruleset.overtime === 'suddenDeath',
  };
  const t = Math.min(OVERTIME_TIMEOUTS, state.ruleset.timeoutsPerHalf);
  state.timeouts = { home: t, away: t };
  state.patPending = null;
  state.kickoffPending = null;
  state.pendingDecision = null;
  state.ballX = MIDDLE_X;
  if (state.drive.result === null) state.drive.result = 'endOfHalf';
  resetPeriodClock(state);
  state.phase = 'coinToss';
};

/** Another period of the same overtime (playoffs / unlimited): the possession sequence carries over. */
export const nextOvertimePeriod = (state: GameState): void => {
  if (!state.overtime) throw new Error('nextOvertimePeriod: not in overtime');
  state.overtimePeriods += 1;
  state.overtime.period = state.overtimePeriods;
  resetPeriodClock(state);
  state.direction = directionFor(state.possession, state.clock.quarter);
};

/**
 * Updates the overtime bookkeeping after a play and says whether the game is decided.
 * `possessionEndedFor` is the side whose possession ended WITHOUT a score on this play (turnover, punt,
 * downs, missed field goal), or null.
 */
export const applyOvertimePlay = (state: GameState, scoring: ScoreResult, possessionEndedFor: TeamSide | null): OvertimeVerdict => {
  const ot = state.overtime;
  if (!ot) return NOT_OVER;
  if (scoring.scoringSide && scoring.points > 0) {
    const side = scoring.scoringSide;
    if (ot.suddenDeath) return { gameOver: true, reason: scoring.kind === 'touchdown' ? 'touchdown' : scoring.kind === 'safety' ? 'safety' : 'fieldGoal' };
    if (scoring.kind === 'touchdown') return { gameOver: true, reason: 'touchdown' };
    if (scoring.kind === 'safety') return { gameOver: true, reason: 'safety' };
    ot.possessions[side] += 1;
    if (ot.firstPossessionResult === null) {
      ot.firstPossessionResult = 'fieldGoal';
      return NOT_OVER;
    }
    if (ot.firstPossessionResult === 'fieldGoal') {
      ot.suddenDeath = true;
      return NOT_OVER;
    }
    return { gameOver: true, reason: 'fieldGoal' };
  }
  if (possessionEndedFor) {
    ot.possessions[possessionEndedFor] += 1;
    if (ot.suddenDeath) return NOT_OVER;
    if (ot.firstPossessionResult === null) {
      ot.firstPossessionResult = 'none';
      ot.suddenDeath = true;
      return NOT_OVER;
    }
    if (ot.firstPossessionResult === 'fieldGoal') return { gameOver: true, reason: 'defensiveStop' };
  }
  return NOT_OVER;
};

/** At the end of an overtime period: final (winner or regular-season tie) or another period. */
export const resolveOvertimePeriodEnd = (state: GameState): { final: boolean; nextPeriod: boolean } => {
  if (!isTied(state)) return { final: true, nextPeriod: false };
  if (canPlayAnotherPeriod(state)) return { final: false, nextPeriod: true };
  return { final: true, nextPeriod: false };
};

/** Winner of a finished game, or null for a tie. */
export const winnerOf = (state: Pick<GameState, 'score'>): TeamSide | null =>
  state.score.home === state.score.away ? null : state.score.home > state.score.away ? 'home' : 'away';
