import type { PenaltyInfo } from '../play-events';
import type { PlayOutcome } from '../play-types';
import { otherSide, type GameState, type Side, type TeamSide } from '../types';
import { clampSpot, firstDownAt, halfDistanceYards, lineToGain, MAX_DOWN, remainingDistance } from './downs';
import { expectedPoints, outcomeValueFor, spotValue } from './possession';
import { isKickPlay, isPatPlay, type SpecialKind } from './scoring';

/**
 * Penalty accept/decline and enforcement. Producers never bake penalty yardage into FACT fields; this
 * module is the only place that moves the ball for a foul. Enforcement spots:
 *   previousSpot / spotOfFoul -> the play is NULLIFIED and the ball is spotted from the LOS / foul spot
 *   endOfPlay / succeedingSpot -> the result stands; yards are added to the resulting spot (dead-ball fouls)
 * Offsetting: accepted nullifying fouls on both sides replay the down at the previous spot.
 * Kick plays: a punt is a scrimmage down (fouls move down and distance); kickoffs and tries re-kick / replay; a foul
 * by the return team keeps the kick and cuts the return back (applyReturnFouls).
 */
export interface SpotState {
  possession: TeamSide;
  ballOn: number;
  down: number;
  distance: number;
}

export interface Enforcement {
  /** The live result is wiped (no yards, no score, no stats except the penalty count). */
  nullified: boolean;
  offsetting: boolean;
  replayDown: boolean;
  automaticFirstDown: boolean;
  lossOfDown: boolean;
  /** The enforcement produced a NEW series for the offense (automatic first down or the walk-off reached the line to gain). */
  firstDown: boolean;
  /** Loss of down on fourth down: the defense takes over at `ballOn` (converted with 100 - ballOn). */
  turnoverOnDowns: boolean;
  /** Fouls actually enforced (one nullifying foul per side at most, plus every dead-ball foul). */
  accepted: PenaltyInfo[];
  /** Next snap when nullified, in the play offense's perspective. */
  ballOn: number;
  down: number;
  distance: number;
  /** Dead-ball fouls still to be added on top of the play result (empty when nullified: already applied). */
  postPlay: PenaltyInfo[];
  /** Enforced yardage per fouling side, for team penalty stats. */
  yardsBySide: Record<Side, number>;
}

type St = Pick<GameState, 'possession' | 'ballOn' | 'down' | 'distance' | 'ruleset'>;

/** Free kicks (kickoff / onside): a nullifying foul re-kicks; there is no down and distance to keep. */
const isFreeKick = (special: SpecialKind): boolean => special === 'kickoff' || special === 'onside';

export const isNullifying = (p: Pick<PenaltyInfo, 'enforcement'>): boolean => p.enforcement === 'previousSpot' || p.enforcement === 'spotOfFoul';

/** TeamSide that committed the foul (PenaltyInfo.side is relative to the play offense). */
export const foulingTeam = (state: Pick<GameState, 'possession'>, p: Pick<PenaltyInfo, 'side'>): TeamSide =>
  p.side === 'offense' ? state.possession : otherSide(state.possession);

/** TeamSide entitled to accept or decline the foul. */
export const decidingTeam = (state: Pick<GameState, 'possession'>, p: Pick<PenaltyInfo, 'side'>): TeamSide => otherSide(foulingTeam(state, p));

/** Live-ball fouls by both sides offset each other (no choice for either side). */
export const hasOffsettingFouls = (penalties: readonly PenaltyInfo[]): boolean =>
  new Set(penalties.filter(isNullifying).map((p) => p.side)).size === 2;

export interface DeadBallWalk { spot: SpotState; yards: number; /** The walk-off gave the offense a new series. */ firstDown: boolean }

/** Adds a dead-ball foul's yards to a spot (half-distance capped) for the team that snaps next. */
export const applyDeadBallYards = (spot: SpotState, foulingTeamSide: TeamSide, p: PenaltyInfo): DeadBallWalk => {
  const foulingSide: Side = foulingTeamSide === spot.possession ? 'offense' : 'defense';
  const yards = halfDistanceYards(spot.ballOn, foulingSide, p.yards);
  if (foulingSide === 'offense') {
    return { spot: { ...spot, ballOn: clampSpot(spot.ballOn - yards), distance: spot.distance + yards }, yards, firstDown: false };
  }
  const ballOn = clampSpot(spot.ballOn + yards);
  if (p.automaticFirstDown || spot.distance - yards <= 1e-9) {
    const fd = firstDownAt(ballOn);
    return { spot: { possession: spot.possession, ballOn, down: fd.down, distance: fd.distance }, yards, firstDown: true };
  }
  return { spot: { ...spot, ballOn, distance: spot.distance - yards }, yards, firstDown: false };
};

/**
 * An accepted foul by the defense means the period cannot end on that down (an untimed down follows),
 * except for dead-ball fouls committed after the play (enforced from the end of the play / succeeding spot).
 */
export const extendsPeriodFoul = (p: PenaltyInfo): boolean => p.accepted && p.side === 'defense' && !(p.deadBall && !isNullifying(p));

/** Moves a kickoff / PAT spot for a succeeding-spot foul (kicking team fouled -> backed up). */
export const adjustKickSpot = (kickSpot: number, kickerFouled: boolean, yards: number): number =>
  clampSpot(kickerFouled ? kickSpot - yards : kickSpot + yards);

const pickPrimary = (fouls: PenaltyInfo[]): PenaltyInfo =>
  fouls.reduce((best, p) => (p.yards + (p.automaticFirstDown ? 10 : 0) > best.yards + (best.automaticFirstDown ? 10 : 0) ? p : best));

/** Enforces the ACCEPTED penalties of an outcome against the pre-play state. Pure. */
export const enforcePenalties = (state: St, outcome: Pick<PlayOutcome, 'penalties'>, special: SpecialKind = 'none'): Enforcement => {
  const accepted = outcome.penalties.filter((p) => p.accepted);
  const enf: Enforcement = {
    nullified: false, offsetting: false, replayDown: false, automaticFirstDown: false, lossOfDown: false, firstDown: false, turnoverOnDowns: false,
    accepted, ballOn: state.ballOn, down: state.down, distance: state.distance, postPlay: [], yardsBySide: { offense: 0, defense: 0 },
  };
  if (accepted.length === 0) return enf;
  // Return fouls are enforced on the play result by applyReturnFouls (the kick stands): neither nullifying nor post-play.
  const nullifying = accepted.filter((p) => isNullifying(p) && !isReturnFoul(p, special));
  const post = accepted.filter((p) => !isNullifying(p));
  enf.postPlay = post;
  if (nullifying.length === 0) return enf;

  enf.nullified = true;
  const sides = new Set(nullifying.map((p) => p.side));
  if (sides.size === 2) {
    enf.offsetting = true;
    enf.replayDown = true;
    enf.accepted = [...nullifying, ...post];
  } else {
    const p = pickPrimary(nullifying);
    enf.accepted = [p, ...post];
    const spot = p.enforcement === 'spotOfFoul' && p.spotBallOn !== null ? clampSpot(p.spotBallOn) : state.ballOn;
    const yards = halfDistanceYards(spot, p.side, p.yards);
    let ballOn = clampSpot(p.side === 'offense' ? spot - yards : spot + yards);
    if (p.side === 'defense' && p.enforcement === 'spotOfFoul' && p.spotBallOn !== null && p.spotBallOn >= 100) ballOn = 99;
    enf.ballOn = ballOn;
    enf.yardsBySide[p.side] += Math.abs(ballOn - state.ballOn);
    const ltg = lineToGain(state);
    // A punt is a scrimmage down: its fouls move the line to gain like any other snap (a false start on 4th & 1
    // makes it 4th & 6; a defensive foul that reaches the line to gain is a first down). Free kicks and tries replay.
    if (isFreeKick(special) || isPatPlay(special)) {
      enf.replayDown = true;
    } else if (p.side === 'defense' && (p.automaticFirstDown || ballOn >= ltg - 1e-9)) {
      const fd = firstDownAt(ballOn);
      enf.down = fd.down;
      enf.distance = fd.distance;
      enf.automaticFirstDown = p.automaticFirstDown;
      enf.firstDown = true;
    } else {
      const nextDown = p.lossOfDown || !p.replayDown ? state.down + 1 : state.down;
      enf.lossOfDown = p.lossOfDown;
      enf.replayDown = nextDown === state.down;
      if (nextDown > MAX_DOWN) {
        enf.turnoverOnDowns = true;
        enf.down = 1;
        enf.distance = firstDownAt(100 - ballOn).distance;
      } else {
        enf.down = nextDown;
        enf.distance = remainingDistance(ltg, ballOn);
      }
    }
  }
  if (!enf.turnoverOnDowns && !isFreeKick(special) && !isPatPlay(special)) {
    let spot: SpotState = { possession: state.possession, ballOn: enf.ballOn, down: enf.down, distance: enf.distance };
    for (const p of post) {
      const r = applyDeadBallYards(spot, foulingTeam(state, p), p);
      enf.yardsBySide[p.side] += r.yards;
      enf.firstDown = enf.firstDown || r.firstDown;
      spot = r.spot;
    }
    enf.ballOn = spot.ballOn;
    enf.down = spot.down;
    enf.distance = spot.distance;
    enf.postPlay = [];
  }
  return enf;
};

/* ------------------------------ Return fouls ------------------------------ */

/**
 * A foul by the receiving team (the play 'defense') during a kick return: a spot foul on a kickoff, onside kick or
 * punt. The kick is not replayed; the receivers keep the ball and are walked back from the basic spot.
 */
export const isReturnFoul = (p: Pick<PenaltyInfo, 'side' | 'enforcement' | 'deadBall'>, special: SpecialKind): boolean =>
  isKickPlay(special) && p.side === 'defense' && p.enforcement === 'spotOfFoul' && !p.deadBall;

/** Kick-return touchback line (punts come out to the 20, kickoffs to the ruleset line). */
const PUNT_TOUCHBACK_LINE = 20;

/**
 * Enforces ACCEPTED return fouls on the play result. Spots are in the kicking team's perspective (the play offense),
 * so the receivers' own goal is at 100. The basic spot is the end of the run (the touchback line on a touchback), or
 * the foul spot when the foul was behind it; the yards (half the distance at most) go toward the receivers' goal. A
 * return touchdown with a foul behind the goal line comes back. Pure; returns the outcome unchanged (yards 0) when
 * nothing applies, or when the kicking team ended up with the ball (such a foul is declined in practice).
 */
export const applyReturnFouls = (outcome: PlayOutcome, special: SpecialKind, touchbackYardLine: number): { outcome: PlayOutcome; yards: number } => {
  const fouls = outcome.penalties.filter((p) => p.accepted && isReturnFoul(p, special));
  const p = fouls[0];
  if (!p || outcome.turnover || outcome.safety) return { outcome, yards: 0 };
  const touchback = outcome.events.some((e) => e.type === 'touchback') || outcome.endBallOn >= 100;
  let base = touchback ? 100 - (special === 'punt' ? PUNT_TOUCHBACK_LINE : touchbackYardLine) : outcome.endBallOn;
  if (p.spotBallOn !== null) base = Math.max(base, Math.min(99.5, p.spotBallOn));
  base = clampSpot(base);
  const yards = Math.max(0, Math.min(p.yards, (100 - base) / 2));
  const endBallOn = clampSpot(base + yards);
  const wipedTd = outcome.touchdown;
  return {
    yards,
    outcome: {
      ...outcome,
      endBallOn,
      touchdown: false,
      events: outcome.events.filter((e) => e.type !== 'touchback' && !(wipedTd && e.type === 'touchdown')),
      stats: wipedTd ? outcome.stats.filter((d) => !/touchdowns?$/i.test(d.stat)) : outcome.stats,
    },
  };
};

/* ------------------------------ Accept / decline ------------------------------ */

export interface PenaltyDecisionContext {
  index: number;
  decidingSide: TeamSide;
  foulingSide: TeamSide;
  offsetting: boolean;
  special: SpecialKind;
  valueIfAccepted: number;
  valueIfDeclined: number;
}

/** Returns true to accept, false to decline, null when a human must decide (the controller suspends). */
export type PenaltyDecider = (p: PenaltyInfo, ctx: PenaltyDecisionContext) => boolean | null;

export interface PenaltyDecisionResult {
  outcome: PlayOutcome;
  /** First penalty still awaiting a human decision, or null when everything is decided. */
  pending: { index: number; side: TeamSide } | null;
  decisions: (boolean | null)[];
}

/** Value for `side` of the outcome with exactly `penalties` marked accepted. */
export const valueWithPenalties = (state: St, outcome: PlayOutcome, penalties: PenaltyInfo[], side: TeamSide, special: SpecialKind): number => {
  const enf = enforcePenalties(state, { penalties }, special);
  if (!enf.nullified) {
    const returned = applyReturnFouls({ ...outcome, penalties }, special, state.ruleset.touchbackYardLine).outcome;
    let v = outcomeValueFor(state, returned, side, special);
    for (const p of enf.postPlay) v += (foulingTeam(state, p) === side ? -1 : 1) * p.yards * 0.06;
    return v;
  }
  const offense = state.possession;
  if (isFreeKick(special)) {
    const receiverGain = state.ballOn - enf.ballOn;
    return (offense === side ? -1 : 1) * expectedPoints(state.ruleset.touchbackYardLine + receiverGain);
  }
  if (enf.turnoverOnDowns) return (offense === side ? -1 : 1) * spotValue(100 - enf.ballOn, 1, 10);
  return (offense === side ? 1 : -1) * spotValue(enf.ballOn, enf.down, enf.distance);
};

const withAccepted = (pens: PenaltyInfo[], index: number, accepted: boolean): PenaltyInfo[] =>
  pens.map((p, i) => ({ ...p, accepted: i === index ? accepted : p.accepted }));

/**
 * Walks every undecided penalty: offsetting live-ball fouls and dead-ball fouls are enforced automatically;
 * the rest ask `decider`. `predecided` carries answers already given (e.g. by a human via GameCommand).
 */
export const decidePenalty = (
  state: St, outcome: PlayOutcome, decider: PenaltyDecider, special: SpecialKind = 'none', predecided: readonly (boolean | null)[] = [],
): PenaltyDecisionResult => {
  const pens = outcome.penalties.map((p) => ({ ...p, accepted: false }));
  const decisions: (boolean | null)[] = pens.map((_, i) => predecided[i] ?? null);
  const offsetting = hasOffsettingFouls(pens);
  for (let i = 0; i < pens.length; i++) {
    const p = pens[i] as PenaltyInfo;
    const given = decisions[i];
    if (given !== null && given !== undefined) {
      p.accepted = given;
      continue;
    }
    if ((offsetting && isNullifying(p)) || p.deadBall) {
      p.accepted = true;
      decisions[i] = true;
      continue;
    }
    const decidingSide = decidingTeam(state, p);
    const ctx: PenaltyDecisionContext = {
      index: i, decidingSide, foulingSide: foulingTeam(state, p), offsetting, special,
      valueIfAccepted: valueWithPenalties(state, outcome, withAccepted(pens, i, true), decidingSide, special),
      valueIfDeclined: valueWithPenalties(state, outcome, withAccepted(pens, i, false), decidingSide, special),
    };
    const verdict = decider(p, ctx);
    if (verdict === null) return { outcome: { ...outcome, penalties: pens }, pending: { index: i, side: decidingSide }, decisions };
    p.accepted = verdict;
    decisions[i] = verdict;
  }
  return { outcome: { ...outcome, penalties: pens }, pending: null, decisions };
};

/** Default AI: accept when the enforced result is worth more to the deciding side than the live result. */
export const aiShouldAccept = (state: St, outcome: PlayOutcome, penalty: PenaltyInfo, special: SpecialKind = 'none'): boolean => {
  const index = outcome.penalties.indexOf(penalty);
  const pens = outcome.penalties.map((p) => ({ ...p }));
  const i = index >= 0 ? index : pens.push({ ...penalty }) - 1;
  const side = decidingTeam(state, penalty);
  const accept = valueWithPenalties(state, outcome, withAccepted(pens, i, true), side, special);
  const decline = valueWithPenalties(state, outcome, withAccepted(pens, i, false), side, special);
  return accept > decline + 1e-6;
};
