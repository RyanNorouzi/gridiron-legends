/**
 * Default Playcaller: situational play weights from playbook/playbooks.ts, sharpened by the difficulty's
 * playcallingIq (a legend AI concentrates on the best-weighted plays, a rookie AI spreads its calls), biased
 * by the coach's scheme and aggressiveness, with 4th-down, kickoff and PAT decisions from the game situation.
 * Also derives the coach hooks the controller uses for its own fallbacks.
 */
import type { Rng } from '@/core/rng';
import { teamDifficulty } from '@/game/difficulty-sides';
import { defaultCoach, type CoachHooks } from '@/game/game-controller';
import { fieldGoalDistance, fieldGoalPlay, kickoffPlay, puntPlay, extraPointPlay, fakePlays, isSpecialPlay } from '@/playbook/special-teams';
import { kneelRunoffSec } from '@/ai/coaching';
import { canKneelOut, defensivePlaysForSituation, pickWeighted, playsForSituation, twoPointPlays, type PlaySituation, type WeightedPlay } from '@/playbook/playbooks';
import { returnPlay } from '@/playbook/special-teams';
import type { DefensivePlay, OffensivePlay } from '@/playbook/types';
import type { GameSetup, GameState, TeamSide } from '@/game/types';
import { otherSide } from '@/game/types';
import type { Coach } from '@/teams/types';
import type { CallSituation, Playcaller, SpecialOption } from './session-types';

/** Offense-perspective yard line from which a field goal is trusted (~52 yd kick). */
export const FG_RANGE_BALL_ON = 65;
/** Aggressive coaches try from ~55 yards. */
export const FG_RANGE_AGGRESSIVE_BALL_ON = 62;
/** Longest field goal the SPECIAL tab offers (beyond any kicker's range it is only a turnover). */
export const MAX_FIELD_GOAL_OFFER_YARDS = 70;

const RUN_TYPES = new Set<OffensivePlay['type']>(['run', 'qbRun', 'rpo']);
const KNEEL_OR_SPIKE = new Set<OffensivePlay['type']>(['kneel', 'spike']);

/** Seconds left in the game (regulation) for a state. */
export const gameSecondsLeft = (state: GameState): number => {
  const c = state.clock;
  if (state.overtime) return c.secondsRemaining;
  const quartersLeft = Math.max(0, 4 - c.quarter);
  return c.secondsRemaining + quartersLeft * state.ruleset.quarterLengthSec;
};

/** Seconds left in the current half (what the situational tags key on). */
export const halfSecondsLeft = (state: GameState): number => {
  const c = state.clock;
  if (state.overtime) return c.secondsRemaining;
  return c.secondsRemaining + (c.quarter === 1 || c.quarter === 3 ? state.ruleset.quarterLengthSec : 0);
};

/** Builds the situation for the side in possession. */
export const situationFor = (state: GameState): CallSituation => {
  const offense = state.possession;
  return {
    down: state.down,
    distance: state.distance,
    ballOn: state.ballOn,
    clock: halfSecondsLeft(state),
    scoreDiff: state.score[offense] - state.score[otherSide(offense)],
    clockRunning: state.clock.running,
    timeouts: state.timeouts[offense],
    opponentTimeouts: state.timeouts[otherSide(offense)],
    runoffSec: kneelRunoffSec(state.ruleset),
    quarter: state.clock.quarter,
    kind: state.kickoffPending ? 'kickoff' : state.patPending ? 'pat' : 'scrimmage',
    gameClock: gameSecondsLeft(state),
  };
};

const isAggressive = (coach: Coach | null): boolean => coach?.traits.includes('aggressive') === true;
const isConservative = (coach: Coach | null): boolean => coach?.traits.includes('conservative') === true;

/** Weight multiplier from the coach's offensive scheme. */
export const schemeBias = (play: OffensivePlay, coach: Coach | null): number => {
  if (!coach) return 1;
  const run = RUN_TYPES.has(play.type);
  switch (coach.offensiveScheme) {
    case 'airRaid': return run ? 0.6 : 1.5;
    case 'spread': return run ? 0.8 : 1.25;
    case 'westCoast': return play.concept === 'slant' || play.concept === 'drag' || play.concept === 'screen' || play.concept === 'curl' ? 1.5 : 1;
    case 'groundAndPound': return run ? 1.6 : 0.7;
    default: return 1;
  }
};

/** Weight multiplier from the coach's defensive scheme. */
export const defensiveSchemeBias = (play: DefensivePlay, coach: Coach | null): number => {
  if (!coach) return 1;
  switch (coach.defensiveScheme) {
    case 'blitzHeavy': return play.blitz !== 'none' ? 1.7 : 0.8;
    case 'coverageFirst': return play.blitz === 'none' && play.family !== 'man' ? 1.5 : play.blitz !== 'none' ? 0.5 : 1;
    case 'runStuff': return play.tags.includes('runStop') ? 1.8 : 1;
    default: return 1;
  }
};

/**
 * Sharpens a weight list by the AI's play-calling IQ: weights are raised to (1 + 3 * iq), so at iq 0 the
 * distribution is untouched and at iq 1 the best plays dominate. Pure; used for both units.
 */
export const sharpen = <T>(weighted: readonly WeightedPlay<T>[], iq: number): WeightedPlay<T>[] => {
  const k = 1 + 3 * Math.max(0, Math.min(1, iq));
  const max = weighted.reduce((m, w) => Math.max(m, w.weight), 0);
  if (max <= 0) return [...weighted];
  return weighted.map((w) => ({ play: w.play, weight: (w.weight / max) ** k }));
};

/** Fourth-down call for the AI: 'go' / 'punt' / 'fieldGoal'. Exported so the UI can show the coach's lean. */
export const fourthDownChoice = (state: GameState, coach: Coach | null): 'go' | 'punt' | 'fieldGoal' => {
  const s = situationFor(state);
  const margin = s.scoreDiff;
  const left = s.gameClock;
  const fgRange = isAggressive(coach) ? FG_RANGE_AGGRESSIVE_BALL_ON : FG_RANGE_BALL_ON;
  const late = state.clock.quarter >= 4 || state.overtime !== null;
  const desperate = late && margin < 0 && left <= 240;
  const inFgRange = s.ballOn >= fgRange;
  if (desperate) {
    // A field goal only helps when it ties or wins; otherwise keep the drive alive.
    if (inFgRange && margin >= -3 && !(s.distance <= 2 && s.ballOn >= 90)) return 'fieldGoal';
    return 'go';
  }
  if (inFgRange) {
    if (s.distance <= 1 && s.ballOn >= 96 && isAggressive(coach)) return 'go';
    return 'fieldGoal';
  }
  const shortAndClose = s.distance <= 1 && s.ballOn >= 45;
  const aggressiveGo = isAggressive(coach) && s.distance <= 3 && s.ballOn >= 55;
  if ((shortAndClose && !isConservative(coach)) || aggressiveGo) return 'go';
  if (late && margin < 0 && left <= 480 && s.ballOn >= 55 && s.distance <= 5) return 'go';
  return 'punt';
};

/** Kickoff choice: onside when trailing late, squib when protecting a lead at the end of a half. */
export const kickoffChoice = (state: GameState, coach: Coach | null): 'kickoff' | 'onside' | 'squib' => {
  const kicker = state.possession;
  const margin = state.score[kicker] - state.score[otherSide(kicker)];
  const left = gameSecondsLeft(state);
  const late = state.clock.quarter >= 4;
  if (late && margin < 0 && (left <= 180 || (left <= 360 && margin <= -9))) return 'onside';
  if (late && margin < 0 && left <= 600 && isAggressive(coach) && margin <= -14) return 'onside';
  if (margin > 0 && state.clock.secondsRemaining <= 25 && (state.clock.quarter === 2 || late)) return 'squib';
  return 'kickoff';
};

/** Two-point decision after a touchdown, from the margin the extra point would leave. */
export const goForTwo = (state: GameState, coach: Coach | null): boolean => {
  const side = state.possession;
  const margin = state.score[side] - state.score[otherSide(side)];
  const late = state.clock.quarter >= 4 || state.overtime !== null;
  if (state.overtime) return margin < 0;
  if (!late) return isAggressive(coach) && margin === -2;
  // Classic chart: trailing by 2 (tie), by 5 (to 3), by 10 (to 8), leading by 1 (to 3) or 5 (to 7).
  return margin === -2 || margin === -5 || margin === -10 || margin === 1 || margin === 5 || (isAggressive(coach) && margin === -8);
};

const scrimmagePlays = (plays: readonly OffensivePlay[]): OffensivePlay[] =>
  plays.filter((p) => isSpecialPlay(p) === 'none' && !p.tags.includes('twoPoint'));

const weightedOffense = (state: GameState, plays: readonly OffensivePlay[], coach: Coach | null): WeightedPlay<OffensivePlay>[] => {
  const s: PlaySituation = situationFor(state);
  const base = playsForSituation(scrimmagePlays(plays), s);
  return sharpen(base.map((w) => ({ play: w.play, weight: w.weight * schemeBias(w.play, coach) })), teamDifficulty(state, state.possession).playcallingIq);
};

const weightedDefense = (state: GameState, plays: readonly DefensivePlay[], coach: Coach | null): WeightedPlay<DefensivePlay>[] => {
  const s: PlaySituation = situationFor(state);
  const base = defensivePlaysForSituation(plays, s);
  return sharpen(base.map((w) => ({ play: w.play, weight: w.weight * defensiveSchemeBias(w.play, coach) })), teamDifficulty(state, otherSide(state.possession)).playcallingIq);
};

const best = <T>(weighted: readonly WeightedPlay<T>[]): T | null => {
  let top: WeightedPlay<T> | null = null;
  for (const w of weighted) if (!top || w.weight > top.weight) top = w;
  return top?.play ?? null;
};

/** Regular defense for a two-point try / goal line: prefer goal-line & two-point tagged plays. */
const patDefense = (plays: readonly DefensivePlay[], rng: Rng): DefensivePlay | null => {
  const tagged = plays.filter((p) => p.tags.includes('twoPoint') || p.tags.includes('goalLine'));
  return tagged.length > 0 ? rng.pick(tagged) : null;
};

/** The shipped Playcaller. */
export const createDefaultPlaycaller = (): Playcaller => {
  const callOffense: Playcaller['callOffense'] = (state, plays, rng, coach) => {
    if (state.kickoffPending) {
      const choice = kickoffChoice(state, coach);
      const play = choice === 'onside' ? kickoffPlay(plays, { onside: true }) : kickoffPlay(plays, { squib: choice === 'squib' });
      const fallback = kickoffPlay(plays) ?? plays.find((p) => p.concept === 'kickoff') ?? null;
      const chosen = play ?? fallback;
      if (chosen) return chosen;
    }
    if (state.patPending) {
      if (goForTwo(state, coach)) {
        const two = twoPointPlays(plays);
        if (two.length > 0) return rng.pick(two);
      }
      const xp = extraPointPlay(plays);
      if (xp) return xp;
    }
    if (state.down === 4 && !state.kickoffPending && !state.patPending) {
      const choice = fourthDownChoice(state, coach);
      if (choice === 'fieldGoal') {
        const fg = fieldGoalPlay(plays);
        if (fg) return fg;
      }
      if (choice === 'punt') {
        const punt = puntPlay(plays, state.ballOn);
        if (punt) return punt;
      }
    }
    const weighted = weightedOffense(state, plays, coach);
    const pick = pickWeighted(weighted, rng);
    if (pick) return pick;
    const any = scrimmagePlays(plays).filter((p) => !KNEEL_OR_SPIKE.has(p.type));
    if (any.length > 0) return rng.pick(any);
    return defaultCoach.pickOffensivePlay(state, [...plays], rng);
  };

  const callDefense: Playcaller['callDefense'] = (state, plays, rng, coach, offensivePlay) => {
    const special = offensivePlay ? isSpecialPlay(offensivePlay) : state.kickoffPending ? 'kickoff' : state.patPending ? 'extraPoint' : 'none';
    if (special !== 'none' && special !== 'twoPoint') {
      const unit = returnPlay(plays, special, { block: special === 'punt' && teamDifficulty(state, otherSide(state.possession)).playcallingIq > 0.8 && rng.chance(0.1) });
      if (unit) return unit;
    }
    if (special === 'twoPoint' || (state.patPending && offensivePlay && isSpecialPlay(offensivePlay) === 'none')) {
      const goal = patDefense(plays, rng);
      if (goal) return goal;
    }
    const weighted = weightedDefense(state, plays, coach);
    const pick = pickWeighted(weighted, rng);
    if (pick) return pick;
    const regular = plays.filter((p) => !p.tags.includes('kickReturn') && !p.tags.includes('puntReturn') && !p.tags.includes('fgBlock'));
    return regular.length > 0 ? rng.pick(regular) : defaultCoach.pickDefensivePlay(state, [...plays], rng);
  };

  const suggestOffense: Playcaller['suggestOffense'] = (state, plays) => {
    if (state.kickoffPending || state.patPending) return null;
    return best(weightedOffense(state, plays, null));
  };

  const suggestDefense: Playcaller['suggestDefense'] = (state, plays) => best(weightedDefense(state, plays, null));

  const specialOptions: Playcaller['specialOptions'] = (state, plays) => {
    const out: SpecialOption[] = [];
    if (state.kickoffPending) {
      const deep = kickoffPlay(plays);
      const squib = kickoffPlay(plays, { squib: true });
      const onside = kickoffPlay(plays, { onside: true });
      if (deep) out.push({ id: 'kickoff', label: 'KICK DEEP', playId: deep.id, detail: 'Standard kickoff' });
      if (squib && squib !== deep) out.push({ id: 'squib', label: 'SQUIB', playId: squib.id, detail: 'Low bouncing kick, short return' });
      if (onside) out.push({ id: 'onside', label: 'ONSIDE', playId: onside.id, detail: 'Recover past 10 yards to keep the ball' });
      return out;
    }
    if (state.patPending) {
      const xp = extraPointPlay(plays);
      if (xp) out.push({ id: 'extraPoint', label: 'EXTRA POINT', playId: xp.id, detail: '+1 · kick' });
      if (twoPointPlays(plays).length > 0) out.push({ id: 'twoPoint', label: 'GO FOR TWO', playId: null, detail: '+2 · pick a play' });
      return out;
    }
    const s = situationFor(state);
    if (state.down === 4) {
      const punt = puntPlay(plays, state.ballOn);
      const fg = fieldGoalPlay(plays);
      if (punt) out.push({ id: 'punt', label: 'PUNT', playId: punt.id, detail: state.ballOn >= 55 ? 'Pin them deep' : 'Flip the field' });
      const fgYards = Math.round(fieldGoalDistance(state.ballOn));
      const fgOffered = fg !== null && fgYards <= MAX_FIELD_GOAL_OFFER_YARDS;
      if (fg && fgOffered) out.push({ id: 'fieldGoal', label: 'FIELD GOAL', playId: fg.id, detail: `${fgYards} yards` });
      out.push({ id: 'go', label: 'GO FOR IT', playId: null, detail: `4th & ${Math.ceil(s.distance)}` });
      const fakeP = fakePlays(plays, 'punt')[0];
      const fakeF = fakePlays(plays, 'fieldGoal')[0];
      if (fakeP && punt) out.push({ id: 'fakePunt', label: 'FAKE PUNT', playId: fakeP.id, detail: 'Trick play' });
      // A fake field goal only makes sense where the real kick is on the table.
      if (fakeF && fgOffered) out.push({ id: 'fakeFieldGoal', label: 'FAKE FG', playId: fakeF.id, detail: 'Trick play' });
    }
    const late = s.clock <= 120;
    const kneel = plays.find((p) => p.type === 'kneel');
    const spike = plays.find((p) => p.type === 'spike');
    // Offered whenever late and ahead; the detail says whether kneeling actually runs the clock out (the AI's model:
    // ruleset runoff, the opponent's timeouts) or only burns some before handing the ball back.
    if (kneel && late && s.scoreDiff > 0) out.push({ id: 'kneel', label: 'KNEEL', playId: kneel.id, detail: canKneelOut(s) ? 'Run out the clock' : 'Burns clock · they get it back' });
    if (spike && late && s.clockRunning === true && s.scoreDiff <= 0) out.push({ id: 'spike', label: 'SPIKE', playId: spike.id, detail: 'Stop the clock' });
    return out;
  };

  return { callOffense, callDefense, suggestOffense, suggestDefense, specialOptions };
};

/** Coach hooks for the controller's fallbacks, routing play picks through the playcaller. */
export const coachHooksFor = (playcaller: Playcaller, setup: GameSetup, perSide?: (side: TeamSide) => Partial<CoachHooks>): CoachHooks => {
  const coachOf = (side: TeamSide): Coach | null => setup[side].headCoach;
  const hooks = (side: TeamSide): CoachHooks => ({ ...defaultCoach, ...perSide?.(side) });
  return {
    coinToss: (state, side) => hooks(side).coinToss(state, side),
    freeKick: (state, side) => hooks(side).freeKick(state, side),
    shouldAccept: (state, outcome, penalty, ctx) => hooks(ctx.decidingSide).shouldAccept(state, outcome, penalty, ctx),
    shouldChallenge: (state, outcome, side, special) => hooks(side).shouldChallenge(state, outcome, side, special),
    callTimeout: (state, side) => hooks(side).callTimeout(state, side),
    hurryUp: (state, side) => hooks(side).hurryUp?.(state, side) ?? false,
    pickOffensivePlay: (state, plays, rng) => playcaller.callOffense(state, plays, rng, coachOf(state.possession)),
    pickDefensivePlay: (state, plays, rng) => playcaller.callDefense(state, plays, rng, coachOf(otherSide(state.possession)), null),
  };
};
