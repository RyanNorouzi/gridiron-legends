/**
 * Thin local watch-mode policy: decides when a user who is spectating (or watching their own defense) is
 * asked to jump in. Key downs and situations raise a prompt; everything else simulates through. Pure.
 */
import { otherSide, type GameState, type TeamSide } from '@/game/types';
import { situationSummary } from './session-flow';
import type { WatchPolicy, WatchPrompt } from './session-types';

export interface WatchPolicyOptions {
  /** Prompt on every third down (default true). */
  thirdDown?: boolean;
  /** Prompt on fourth-down tries (default true). */
  fourthDown?: boolean;
  /** Prompt inside the opponent's 20 (default true). */
  redZone?: boolean;
  /** Prompt inside the final two minutes of a half when the game is within one score (default true). */
  twoMinute?: boolean;
}

/** Short situation title, e.g. "3RD & 7 · OPP 34", with the spot read from `side` (default: the offense). */
export const situationTitle = (state: GameState, side: TeamSide | null = null): string => situationSummary(state, side);

/** Seconds before the end of a half that count as the two-minute drill: 2:00, shorter for short quarters. */
export const twoMinuteWindow = (quarterLengthSec: number): number => Math.min(120, Math.max(20, Math.round(quarterLengthSec / 4)));

/** Identity of the drive in progress (the same for every snap of one possession). */
const driveKey = (state: GameState): string => `${state.drive.possession}:${state.drive.startQuarter}:${state.drive.startClock}:${state.drive.startBallOn}`;

/**
 * Prompts only while the opponent has the ball (the user's defense) or, for a pure spectator, whenever the
 * situation is one of the key ones. Kickoffs and PATs never prompt. So the watcher is not nagged on every snap,
 * it asks at most once per drive, and the two-minute drill (scaled to the quarter length) once per half.
 */
export const createWatchPolicy = (opts: WatchPolicyOptions = {}): WatchPolicy => {
  const wantThird = opts.thirdDown ?? true;
  const wantFourth = opts.fourthDown ?? true;
  const wantRedZone = opts.redZone ?? true;
  const wantTwoMinute = opts.twoMinute ?? true;
  const asked = new Set<string>();
  let lastPlays = 0;
  return {
    shouldPrompt: (state: GameState, side: TeamSide): WatchPrompt | null => {
      if (state.kickoffPending || state.patPending || state.phase === 'final') return null;
      // A new game (the log started over) forgets what was asked.
      if (state.playLog.length < lastPlays) asked.clear();
      lastPlays = state.playLog.length;
      const title = situationTitle(state, side);
      const prompt = (reason: WatchPrompt['reason'], text: string): WatchPrompt => ({ side, title, text, reason });
      const margin = state.score[side] - state.score[otherSide(side)];
      const half = state.clock.quarter === 2 || state.clock.quarter >= 4;
      const halfKey = `2min:${side}:${state.clock.quarter >= 4 ? 2 : 1}`;
      if (wantTwoMinute && half && !asked.has(halfKey) && state.clock.secondsRemaining <= twoMinuteWindow(state.ruleset.quarterLengthSec) && Math.abs(margin) <= 8) {
        asked.add(halfKey);
        return prompt('twoMinute', 'Two-minute drill. Take over?');
      }
      const drive = `drive:${side}:${driveKey(state)}`;
      if (asked.has(drive)) return null;
      const reason: [WatchPrompt['reason'], string] | null = state.ballOn >= 95 ? ['goalLine', 'Goal line stand. Jump in?']
        : wantFourth && state.down === 4 ? ['fourthDown', 'They are going for it. Jump in?']
          : wantThird && state.down === 3 ? ['thirdDown', 'Jump in?']
            : wantRedZone && state.ballOn >= 80 && state.down >= 2 ? ['redZone', 'Red zone. Jump in?'] : null;
      if (!reason) return null;
      asked.add(drive);
      return prompt(reason[0], reason[1]);
    },
  };
};

/** Policy that never prompts (auto-sim everything). */
export const silentWatchPolicy: WatchPolicy = { shouldPrompt: () => null };
