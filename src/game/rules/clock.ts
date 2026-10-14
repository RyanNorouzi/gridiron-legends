import { FIELD_WIDTH, MIDDLE_X, type GameClock, type GameState, type Ruleset } from '../types';
import { directionFor, halfOf, newDrive } from '../game-state';
import type { PlayOutcome } from '../play-types';
import { isKickPlay, isPatPlay, type SpecialKind } from './scoring';

/**
 * Game-clock rules. The clock only moves through `applyClock` (no wall clock): a play charges the
 * pre-snap runoff (if the clock was running) plus the live `timeElapsed`, then the stop conditions decide
 * whether it keeps running into the next snap. Two-minute warnings and period ends are detected here;
 * period rollover helpers live at the bottom.
 */
export const TWO_MINUTE_SEC = 120;
/** Simulation mode: out of bounds stops the clock inside these windows (always in arcade). */
export const OOB_STOP_HALF_SEC = 120;
export const OOB_STOP_GAME_SEC = 300;
/** Default runoff between plays when the offense hurries (no huddle). */
export const HURRY_UP_RUNOFF_SEC = 6;

/** Huddle seconds between running-clock snaps at quarters up to this length (see huddleSeconds). */
export const TEMPO_HUDDLE_SEC = 18;
/** Quarter length (seconds) TEMPO_HUDDLE_SEC is calibrated for. */
export const TEMPO_QUARTER_SEC = 480;

/**
 * Seconds a huddling offense lets a running clock run between the whistle and the snap: the ONE tempo both executors
 * (the live engine and the fast sim) charge, so skipping or simming the rest of a game never changes its pace. Capped
 * by the ruleset's huddle runoff up to 8-minute quarters (NFL-like ~63 snaps a side at 8 minutes); longer quarters
 * huddle longer (~40 s at 15 minutes, capped by the play clock) because play durations are real seconds.
 */
export const huddleSeconds = (rs: Pick<Ruleset, 'quarterLengthSec' | 'huddleRunoffSec' | 'playClockSec'>): number =>
  rs.quarterLengthSec <= TEMPO_QUARTER_SEC
    ? Math.min(rs.huddleRunoffSec, TEMPO_HUDDLE_SEC)
    : Math.min(rs.playClockSec, TEMPO_HUDDLE_SEC + ((rs.quarterLengthSec - TEMPO_QUARTER_SEC) * 22) / 420);

/**
 * Game-clock seconds a live scrimmage down charges per second of engine time. Live athletes play at arcade pace (a
 * scrimmage down is ~3 s of engine time), while the fast sim and the league's calibration use NFL snap-to-whistle times
 * (~5 s); scaling keeps a skipped, simmed or watched game on the same clock. Kicks run on real hang time and are
 * not scaled.
 */
export const LIVE_CLOCK_SCALE = 1.7;

/** The live game-clock scale for a play of this kind (LIVE_CLOCK_SCALE for scrimmage downs, 1 for kicks). */
export const liveClockScale = (special: SpecialKind): number => (special === 'none' || special === 'twoPoint' ? LIVE_CLOCK_SCALE : 1);
/** Play clock after an administrative stoppage (penalty, timeout, change of possession, score). */
export const ADMIN_PLAY_CLOCK_SEC = 25;

export interface ClockInput {
  special: SpecialKind;
  hurryUp?: boolean;
  penaltyAccepted: boolean;
  /** An accepted foul on the defense: a period cannot end on it, so an untimed down follows. */
  extendsPeriod: boolean;
  firstDown: boolean;
  possessionChanged: boolean;
  scored: boolean;
  injury: boolean;
  nullified: boolean;
}

export interface ClockResult {
  clock: GameClock;
  stops: boolean;
  twoMinuteWarning: 1 | 2 | null;
  periodEnded: boolean;
  chargedSec: number;
  presnapSec: number;
}

export const isTwoMinuteHalf = (quarter: number): boolean => quarter === 2 || quarter >= 4;

/** Whether a running clock crossing from `before` to `after` triggers the (not yet given) warning. */
export const shouldTwoMinuteWarning = (ruleset: Pick<Ruleset, 'twoMinuteWarning'>, quarter: number, alreadyGiven: boolean, before: number, after: number): boolean =>
  ruleset.twoMinuteWarning && isTwoMinuteHalf(quarter) && !alreadyGiven && before > TWO_MINUTE_SEC && after <= TWO_MINUTE_SEC && after > 0;

/** Out of bounds stops the clock always in arcade; in simulation only late in a half / the game. */
export const oobStopsClock = (ruleset: Pick<Ruleset, 'mode'>, quarter: number, secondsRemaining: number): boolean => {
  if (ruleset.mode === 'arcade') return true;
  if (quarter === 2) return secondsRemaining <= OOB_STOP_HALF_SEC;
  if (quarter === 4) return secondsRemaining <= OOB_STOP_GAME_SEC;
  if (quarter > 4) return secondsRemaining <= OOB_STOP_HALF_SEC;
  return false;
};

/** 40 (or the ruleset's) after normal plays, 25 after administrative stoppages. */
export const nextPlayClock = (ruleset: Pick<Ruleset, 'playClockSec'>, administrative: boolean): number =>
  administrative ? Math.min(ADMIN_PLAY_CLOCK_SEC, ruleset.playClockSec) : ruleset.playClockSec;

/** Pre-snap runoff to charge when the clock was running at the previous whistle. */
export const presnapRunoff = (ruleset: Pick<Ruleset, 'huddleRunoffSec'>, outcome: Pick<PlayOutcome, 'presnapElapsed'>, hurryUp: boolean): number => {
  if (outcome.presnapElapsed > 0) return outcome.presnapElapsed;
  return hurryUp ? Math.min(HURRY_UP_RUNOFF_SEC, ruleset.huddleRunoffSec) : ruleset.huddleRunoffSec;
};

/** A kneel-down is the offense burning the clock: it would sooner let the clock run out than snap. */
export const burnsClock = (outcome: Pick<PlayOutcome, 'result'>): boolean => outcome.result === 'kneel';

/**
 * Whether time runs out before the snap: a running clock whose pre-snap runoff covers every second left, on a play the
 * offense is happy to let die (a kneel, i.e. victory formation). Every other play is snapped with a second to spare.
 */
export const clockExpiresBeforeSnap = (
  state: Pick<GameState, 'ruleset' | 'clock'>, outcome: Pick<PlayOutcome, 'result' | 'presnapElapsed'>, special: SpecialKind, hurryUp: boolean,
): boolean =>
  !isPatPlay(special) && !isKickPlay(special) && state.clock.running && state.clock.secondsRemaining > 0 && burnsClock(outcome) &&
  presnapRunoff(state.ruleset, outcome, hurryUp) >= state.clock.secondsRemaining;

/** Whether the clock stops after this play (i.e. does NOT run into the next snap). */
export const stopsClock = (state: Pick<GameState, 'ruleset' | 'clock'>, outcome: PlayOutcome, input: ClockInput, afterSec: number): boolean => {
  if (afterSec <= 0) return true;
  if (isPatPlay(input.special) || isKickPlay(input.special) || input.special === 'fieldGoal') return true;
  if (outcome.incomplete || outcome.result === 'incomplete' || outcome.result === 'spike' || outcome.result === 'penalty') return true;
  if (input.scored || input.possessionChanged || outcome.turnover || outcome.touchdown || outcome.safety) return true;
  if (input.penaltyAccepted || input.nullified || input.injury) return true;
  if (input.firstDown && state.ruleset.firstDownClockStop) return true;
  if (outcome.outOfBounds && oobStopsClock(state.ruleset, state.clock.quarter, afterSec)) return true;
  return false;
};

/**
 * Charges `presnapElapsed + timeElapsed` to the clock and derives the running flag for the next snap.
 * PATs are untimed. A running clock reaching 2:00 before the snap stops there (warning before the play).
 * An offense running a real play gets the snap off with at least one second left (the runoff is capped); a kneel
 * does not bother, so its runoff can take the period to 0:00 (see clockExpiresBeforeSnap).
 */
export const applyClock = (state: Pick<GameState, 'ruleset' | 'clock' | 'twoMinuteWarningGiven'>, outcome: PlayOutcome, input: ClockInput): ClockResult => {
  const rs = state.ruleset;
  const clock: GameClock = { ...state.clock };
  const half = halfOf(clock.quarter);
  const given = half === 1 ? state.twoMinuteWarningGiven.half1 : state.twoMinuteWarningGiven.half2;
  let twoMinuteWarning: 1 | 2 | null = null;
  let presnapSec = 0;
  let liveSec = 0;
  const untimed = isPatPlay(input.special);
  if (!untimed) {
    if (clock.running && clock.secondsRemaining > 0) {
      const cap = burnsClock(outcome) ? clock.secondsRemaining : Math.max(0, clock.secondsRemaining - 1);
      presnapSec = Math.min(presnapRunoff(rs, outcome, input.hurryUp === true), cap);
      if (shouldTwoMinuteWarning(rs, clock.quarter, given, clock.secondsRemaining, clock.secondsRemaining - presnapSec)) {
        presnapSec = clock.secondsRemaining - TWO_MINUTE_SEC;
        twoMinuteWarning = half;
      }
      clock.secondsRemaining -= presnapSec;
    }
    const before = clock.secondsRemaining;
    liveSec = Math.min(Math.max(0, outcome.timeElapsed), before);
    clock.secondsRemaining = Math.max(0, before - liveSec);
    if (twoMinuteWarning === null && shouldTwoMinuteWarning(rs, clock.quarter, given, before, clock.secondsRemaining)) twoMinuteWarning = half;
  }
  const periodEnded = clock.secondsRemaining <= 0 && !input.extendsPeriod;
  const stops = periodEnded || twoMinuteWarning !== null || stopsClock(state, outcome, input, clock.secondsRemaining);
  const administrative = periodEnded || twoMinuteWarning !== null || input.penaltyAccepted || input.possessionChanged || input.scored || input.injury || untimed;
  clock.running = !stops && clock.secondsRemaining > 0;
  clock.playClock = nextPlayClock(rs, administrative);
  clock.playClockRunning = false;
  return { clock, stops, twoMinuteWarning, periodEnded, chargedSec: presnapSec + liveSec, presnapSec };
};

/* ------------------------------ Period rollover ------------------------------ */

/** Q1 -> Q2 / Q3 -> Q4 (and OT period -> next): teams switch ends; the same offense keeps the ball. */
export const rolloverQuarter = (state: GameState, secondsRemaining = state.ruleset.quarterLengthSec): void => {
  state.clock.quarter += 1;
  state.clock.secondsRemaining = secondsRemaining;
  state.clock.running = false;
  state.clock.playClock = nextPlayClock(state.ruleset, true);
  state.clock.playClockRunning = false;
  state.direction = directionFor(state.possession, state.clock.quarter);
  state.ballX = FIELD_WIDTH - state.ballX;
};

/**
 * Halftime: timeouts reset, the team that received the opening kickoff now kicks off, the ball goes to
 * the kickoff spot and the phase becomes 'halftime' (the next beginPlay is the kickoff).
 */
export const startHalftime = (state: GameState): void => {
  const rs = state.ruleset;
  const kicker = state.receivedOpeningKickoff ?? 'home';
  const receiver = kicker === 'home' ? 'away' : 'home';
  state.clock.quarter = 3;
  state.clock.secondsRemaining = rs.quarterLengthSec;
  state.clock.running = false;
  state.clock.playClock = nextPlayClock(rs, true);
  state.clock.playClockRunning = false;
  state.timeouts = { home: rs.timeoutsPerHalf, away: rs.timeoutsPerHalf };
  state.twoMinuteWarningGiven.half2 = false;
  state.patPending = null;
  state.pendingDecision = null;
  state.ballX = MIDDLE_X;
  state.down = 1;
  if (state.drive.result === null) state.drive.result = 'endOfHalf';
  if (rs.kickoffs) {
    state.kickoffPending = kicker;
    state.possession = kicker;
    state.ballOn = rs.kickoffYardLine;
    state.distance = 10;
  } else {
    state.kickoffPending = null;
    state.possession = receiver;
    state.ballOn = rs.touchbackYardLine;
    state.distance = 10;
    state.drive = newDrive(receiver, rs.touchbackYardLine, 3, rs.quarterLengthSec);
    state.stats.teams[receiver].drives += 1;
  }
  state.direction = directionFor(state.possession, 3);
  state.phase = 'halftime';
};

/** Stops the clock for a charged timeout. */
export const applyTimeout = (state: GameState): void => {
  state.clock.running = false;
  state.clock.playClock = nextPlayClock(state.ruleset, true);
  state.clock.playClockRunning = false;
};
