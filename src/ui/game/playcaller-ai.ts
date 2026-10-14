/**
 * The shipped Playcaller: the real AI play callers (src/ai/playcalling-offense.ts / playcalling-defense.ts, with the
 * in-game scouting report and the defense's check at the line against the formation it sees) behind the session's
 * Playcaller seam, and per-side CoachHooks from src/ai/coaching.ts. The UI-only parts
 * (suggestions for a human caller, the special-option shortcuts) come from the default UI playcaller.
 */
import { createCoachHooks, defenseTendenciesFrom, offenseTendenciesFrom, offensiveCallState, playSituationFrom, recentDefensiveIds, recentOffensiveIds } from '@/ai/coaching';
import { callDefensivePlay, defensiveCheck, type DefensiveCallArgs } from '@/ai/playcalling-defense';
import { callOffensivePlay } from '@/ai/playcalling-offense';
import type { CoachHooks } from '@/game/game-controller';
import { teamDifficulty } from '@/game/difficulty-sides';
import { isReturnPlay } from '@/game/play-context';
import { otherSide, type GameSetup, type TeamSide } from '@/game/types';
import { isSpecialPlay, returnPlay } from '@/playbook/special-teams';
import type { DefensivePlay } from '@/playbook/types';
import { createDefaultPlaycaller } from './playcaller';
import type { Playcaller } from './session-types';

/** Regular (non-return-unit) defensive plays; the return units are chosen from the kick being faced. */
const regularDefense = (plays: readonly DefensivePlay[]): DefensivePlay[] =>
  plays.filter((p) => !isReturnPlay(p) && !p.tags.includes('fgBlock'));

/**
 * Playcaller whose calls come from the AI modules; suggestions and shortcuts from the UI defaults. With `setup`,
 * each side's coordinators shape its calls as they do in league sims (the offense's OC, the defense's DC).
 */
export const createAiPlaycaller = (setup?: Pick<GameSetup, 'home' | 'away'>): Playcaller => {
  const ui = createDefaultPlaycaller();
  return {
    callOffense: (state, plays, rng, coach) => callOffensivePlay({
      plays, state: offensiveCallState(state), coach, offensiveCoordinator: setup?.[state.possession].offensiveCoordinator ?? null, difficulty: teamDifficulty(state, state.possession), rng,
      recentPlayIds: recentOffensiveIds(state, state.possession), defenseTendencies: defenseTendenciesFrom(state),
    }),
    callDefense: (state, plays, rng, coach, offensivePlay) => {
      const special = offensivePlay ? isSpecialPlay(offensivePlay) : state.kickoffPending ? 'kickoff' : state.patPending ? 'extraPoint' : 'none';
      if (special !== 'none' && special !== 'twoPoint') {
        const block = special === 'punt' && teamDifficulty(state, otherSide(state.possession)).playcallingIq > 0.8 && rng.chance(0.1);
        const unit = returnPlay(plays, special, { block });
        if (unit) return unit;
      }
      const regular = regularDefense(plays);
      const pool = regular.length > 0 ? regular : plays;
      const situation = playSituationFrom(state);
      // A two-point try is a goal-line snap from the 2 whatever the pre-try spot says.
      const sit = state.patPending ? { ...situation, ballOn: 98, down: 1, distance: 2 } : situation;
      const args: DefensiveCallArgs = {
        plays: pool, situation: sit, coach, defensiveCoordinator: setup?.[otherSide(state.possession)].defensiveCoordinator ?? null, difficulty: teamDifficulty(state, otherSide(state.possession)), rng, quarter: state.clock.quarter, overtime: state.overtime !== null,
        offenseTendencies: offenseTendenciesFrom(state),
        recentPlayIds: recentDefensiveIds(state, state.possession),
      };
      // The huddle call is made blind; at the line the defense sees the formation and may check out of a mismatch.
      const huddle = callDefensivePlay(args);
      return offensivePlay ? defensiveCheck(huddle, { ...args, offenseFormation: offensivePlay.formation }).play : huddle;
    },
    suggestOffense: ui.suggestOffense,
    suggestDefense: ui.suggestDefense,
    specialOptions: ui.specialOptions,
  };
};

/** Per-side coach hooks from the AI coaching module (head coach personality and coordinators + that side's difficulty:
 *  the CPU's selected profile, the human's club the neutral one; game/difficulty-sides.ts teamDifficulty). */
export const aiCoachFor = (setup: GameSetup): ((side: TeamSide) => CoachHooks) => {
  const staff = (side: TeamSide) => ({ offensiveCoordinator: setup[side].offensiveCoordinator ?? null, defensiveCoordinator: setup[side].defensiveCoordinator ?? null });
  const hooks: Record<TeamSide, CoachHooks> = {
    home: createCoachHooks(setup.home.headCoach, (state) => teamDifficulty(state, 'home'), staff('home')),
    away: createCoachHooks(setup.away.headCoach, (state) => teamDifficulty(state, 'away'), staff('away')),
  };
  return (side) => hooks[side];
};

/** Both sides' hooks merged into one CoachHooks (for callers that drive GameController directly). */
export const aiCoachHooks = (setup: GameSetup): CoachHooks => {
  const of = aiCoachFor(setup);
  return {
    coinToss: (state, side) => of(side).coinToss(state, side),
    freeKick: (state, side) => of(side).freeKick(state, side),
    shouldAccept: (state, outcome, penalty, ctx) => of(ctx.decidingSide).shouldAccept(state, outcome, penalty, ctx),
    shouldChallenge: (state, outcome, side, special) => of(side).shouldChallenge(state, outcome, side, special),
    callTimeout: (state, side) => of(side).callTimeout(state, side),
    hurryUp: (state, side) => of(side).hurryUp?.(state, side) ?? false,
    pickOffensivePlay: (state, plays, rng) => of(state.possession).pickOffensivePlay(state, plays, rng),
    pickDefensivePlay: (state, plays, rng) => of(otherSide(state.possession)).pickDefensivePlay(state, plays, rng),
  };
};
