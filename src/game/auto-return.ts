import type { Athlete, PlayState, UserPlayInput } from './play-types';

/**
 * The automatic return: on a kickoff or punt the local user RECEIVES, the player he controls plays the AI's part
 * (the returner fields the kick and follows his wall, takes a knee deep in the end zone; an up-man blocks) until the
 * user steers or makes a returner's move, as the automatic drop does for a quarterback. A stick push past
 * RETURN_TAKEOVER, a ball-carrier move (juke, spin, stiff-arm, hurdle, dive, slide), a fair catch or a player switch hands
 * the whole unit back to him for the rest of the play (the flag is kept on every man of his side, so it survives the
 * control switch to whoever catches the ball). Buttons that mean nothing to a returner (sprint alone, the defensive
 * tackle / hit-stick / strip / jump buttons, which share keys with menu confirm) do NOT take over: a stray press would
 * otherwise leave the returner standing still.
 */
export const USER_RETURN_KEY = 'userReturnTook';
/** Stick deflection that takes the return over. */
export const RETURN_TAKEOVER = 0.3;

const KICK_SPECIALS: ReadonlySet<string> = new Set(['kickoff', 'onside', 'punt']);

/** True while `athlete` (a human-controlled man on the receiving side of a kick) is still on the automatic return. */
export const autoReturning = (athlete: Athlete, state: PlayState): boolean =>
  state.phase === 'live' && KICK_SPECIALS.has(state.ctx.special) && athlete.side === 'defense' && athlete.ai.scratch[USER_RETURN_KEY] !== 1;

/** The user steered or made a returner's move this tick (stick past RETURN_TAKEOVER, a carrier move, fair catch, switch). */
export const touchedReturn = (input: UserPlayInput): boolean =>
  Math.hypot(input.move.x, input.move.y) >= RETURN_TAKEOVER || input.juke || input.spin || input.stiffArm || input.hurdle
  || input.dive || input.slide || input.fairCatch || input.switchPlayer || input.switchToId !== null;

/** Hands the return to the user for the rest of the play (every man on his side). */
export const takeOverReturn = (state: PlayState, athlete: Athlete): void => {
  for (const a of state.athletes) if (a.teamSide === athlete.teamSide) a.ai.scratch[USER_RETURN_KEY] = 1;
};
