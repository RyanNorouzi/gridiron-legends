import type { Rng } from '@/core/rng';
import { formatClock } from '@/core/time';
import type { FastPlayExecutor } from '@/game/engine-api';
import type { GameController } from '@/game/game-controller';
import type { PlayContext, PlayOutcome } from '@/game/play-types';
import { formatDown } from '@/game/rules/downs';
import { otherSide, type GameState, type TeamSide } from '@/game/types';
import { simulatePlay } from './fast-sim';

/**
 * Watch mode: the user's team is played by the AI while they watch. This controls the sim speed, lets them
 * skip a play through the statistical executor, suggests moments to jump in and hands the controller the
 * jump-in / resume commands. The UI game loop consults it each play.
 */
export const SIM_SPEEDS: readonly number[] = [1, 2, 4, 8];

export interface PromptPolicy {
  /** Minimum plays between two prompts (default 6). */
  minPlaysBetween: number;
  /** Stop prompting when the game is out of reach by this many points in the fourth quarter (default 24). */
  blowoutMargin: number;
}

export interface WatchModeOptions {
  controller: GameController;
  rng: Rng;
  settings: { simSpeed: number };
  promptPolicy?: Partial<PromptPolicy>;
  /** The side being watched (default: the controller's userSide). */
  side?: TeamSide | null;
  /** Fast executor used for skipped plays (default simulatePlay). */
  executor?: FastPlayExecutor;
}

export interface WatchMode {
  readonly speed: number;
  readonly side: TeamSide | null;
  /** True after skipCurrentPlay() until the next play has been executed through the fast executor. */
  readonly skipPending: boolean;
  setSpeed(speed: number): number;
  speedUp(): number;
  speedDown(): number;
  /** Marks the next play to be resolved statistically instead of live. False when a play cannot be skipped now. */
  skipCurrentPlay(): boolean;
  /** Executes the play through the fast executor when a skip is pending; null means "play it live". */
  executeIfSkipped(ctx: PlayContext): PlayOutcome | null;
  /** True when this is a good moment to offer the user control (rate-limited). */
  shouldPromptJumpIn(state: Readonly<GameState>): boolean;
  /** "3rd & 7 at OPP 34, 2:10 left, down 3". */
  describeSituation(state: Readonly<GameState>): string;
  /** Hands control of `side` to the user; returns the formation role the UI should pass to beginPlay. */
  jumpIn(side: TeamSide): string;
  /** Back to watching. */
  resume(): void;
}

const SKIPPABLE = new Set<GameState['phase']>(['playcall', 'kickoff', 'pat', 'deadball', 'halftime', 'twoMinute', 'presnap', 'timeout', 'challenge']);

const snapSpeed = (v: number): number => {
  let best = SIM_SPEEDS[0] as number;
  for (const s of SIM_SPEEDS) if (Math.abs(s - v) < Math.abs(best - v)) best = s;
  return best;
};

/** Is `state` a moment worth handing the user the controller? (pure; the WatchMode adds rate limiting). */
export const isJumpInMoment = (state: Readonly<GameState>, side: TeamSide | null): boolean => {
  const c = state.clock;
  const me = side ?? state.userSide ?? otherSide(state.possession);
  const margin = state.score[me] - state.score[otherSide(me)];
  const oneScore = Math.abs(margin) <= 8;
  const lateHalf = (c.quarter === 2 || c.quarter >= 4) && c.secondsRemaining <= 120;
  const lateGame = c.quarter >= 4 && c.secondsRemaining <= 300;
  if (state.patPending || state.kickoffPending) return lateGame && oneScore && state.patPending !== null;
  const redZone = state.ballOn >= 80;
  const goalToGo = state.ballOn + state.distance >= 100;
  if (state.down >= 3 && (redZone || state.distance <= 3 || (state.down === 4 && state.ballOn >= 35))) return true;
  if (redZone && (goalToGo || state.down >= 2)) return true;
  if (lateHalf && oneScore) return true;
  if (lateGame && oneScore && state.down >= 2) return true;
  if (state.down === 4 && state.distance <= 2 && state.ballOn >= 45) return true;
  return false;
};

/** Situation string for the jump-in prompt. */
export const describeGameSituation = (state: Readonly<GameState>, side: TeamSide | null): string => {
  const me = side ?? state.userSide ?? state.possession;
  // The spot reads from `me`'s side of the ball (the offense's own 14 is the defense's OPP 14); midfield is '50'.
  const y = Math.min(99, Math.max(1, Math.round(state.ballOn)));
  const offenseHalf = y < 50;
  const spot = y === 50 ? '50' : `${offenseHalf === (me === state.possession) ? 'OWN' : 'OPP'} ${offenseHalf ? y : 100 - y}`;
  const margin = state.score[me] - state.score[otherSide(me)];
  const score = margin === 0 ? 'tied' : margin > 0 ? `up ${margin}` : `down ${-margin}`;
  const dd = state.kickoffPending ? 'Kickoff' : state.patPending ? 'PAT' : formatDown(state.down, state.distance, state.ballOn);
  return `${dd} at ${spot}, ${formatClock(state.clock.secondsRemaining)} left, ${score}`;
};

/** Formation role the user should control after jumping in. */
export const jumpInRole = (state: Readonly<GameState>, side: TeamSide): string => (state.possession === side ? 'QB' : 'FS');

export const createWatchMode = (o: WatchModeOptions): WatchMode => {
  const controller = o.controller;
  const executor = o.executor ?? simulatePlay;
  const policy: PromptPolicy = { minPlaysBetween: 6, blowoutMargin: 24, ...o.promptPolicy };
  const side: TeamSide | null = o.side === undefined ? controller.state.userSide : o.side;
  let speed = snapSpeed(o.settings.simSpeed);
  let skipPending = false;
  let lastPromptPlay = -Infinity;
  const canCommand = (): boolean => side !== null && controller.state.userSide === side && !controller.isFinal;
  const watchCmd = (action: 'skip' | 'speedUp' | 'speedDown' | 'jumpIn' | 'resume'): void => {
    if (canCommand() && side) controller.dispatch({ type: 'watch', side, action });
  };
  /** Brings the controller's watch speed in line with the local one (it starts at 1). */
  const syncController = (): void => {
    if (!canCommand()) return;
    for (let i = 0; i < 4 && controller.watch.speed < speed; i++) watchCmd('speedUp');
    for (let i = 0; i < 4 && controller.watch.speed > speed; i++) watchCmd('speedDown');
  };
  const applySpeed = (next: number): number => {
    speed = snapSpeed(next);
    syncController();
    o.settings.simSpeed = speed;
    return speed;
  };
  syncController();
  return {
    get speed() { return speed; },
    get side() { return side; },
    get skipPending() { return skipPending; },
    setSpeed: (v) => applySpeed(v),
    speedUp: () => applySpeed(speed * 2),
    speedDown: () => applySpeed(speed / 2),
    skipCurrentPlay: () => {
      if (controller.isFinal || !SKIPPABLE.has(controller.state.phase) || controller.pendingDecision?.kind === 'penaltyDecision') return false;
      skipPending = true;
      watchCmd('skip');
      return true;
    },
    executeIfSkipped: (ctx) => {
      if (!skipPending) return null;
      skipPending = false;
      controller.acknowledgeSkip();
      return executor(ctx);
    },
    shouldPromptJumpIn: (state) => {
      if (side === null || state.phase === 'final' || state.controllers[side] === 'human') return false;
      const margin = Math.abs(state.score.home - state.score.away);
      if (state.clock.quarter >= 4 && margin >= policy.blowoutMargin) return false;
      const playIndex = state.playLog.length;
      if (playIndex - lastPromptPlay < policy.minPlaysBetween) return false;
      if (!isJumpInMoment(state, side)) return false;
      lastPromptPlay = playIndex;
      return true;
    },
    describeSituation: (state) => describeGameSituation(state, side),
    jumpIn: (s) => {
      controller.dispatch({ type: 'watch', side: s, action: 'jumpIn' });
      return jumpInRole(controller.state, s);
    },
    resume: () => { watchCmd('resume'); },
  };
};
