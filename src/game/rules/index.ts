import { clamp } from '@/core/math';
import type { Rng } from '@/core/rng';
import type { DefensivePlay, OffensivePlay } from '@/playbook/types';
import { shouldHurryUp } from '@/ai/coaching';
import { applyDeltas } from '@/statistics/apply';
import { directionFor, halfOf, newDrive } from '../game-state';
import type { PenaltyInfo } from '../play-events';
import { isSpecialConcept, syntheticScrimmagePlay } from '../play-context';
import type { PlayOutcome } from '../play-types';
import { emptyOutcome } from '../outcome-factory';
import { MIDDLE_X, otherSide, spotBallX, type GameState, type PlayLogEntry, type TeamSide } from '../types';
import { applyClock, clockExpiresBeforeSnap, rolloverQuarter, startHalftime, type ClockResult } from './clock';
import { advanceDowns, clampSpot, firstDownAt } from './downs';
import { applyOvertimePlay, isTied, nextOvertimePeriod, overtimeAllowed, resolveOvertimePeriodEnd, startOvertime, type OvertimeVerdict } from './overtime';
import { adjustKickSpot, applyDeadBallYards, applyReturnFouls, enforcePenalties, extendsPeriodFoul, foulingTeam, type Enforcement, type PenaltyDecisionContext, type SpotState } from './penalties';
import { shouldChallengeDefault } from './challenges';
import { possessionAfter, type PossessionResult } from './possession';
import { effectiveSpecial, isKickPlay, isPatPlay, NO_SCORE, patRequired, scoreOutcome, type ScoreResult, type SpecialKind } from './scoring';

export * from './downs';
export * from './scoring';
export * from './possession';
export * from './penalties';
export * from './clock';
export * from './overtime';
export * from './challenges';

/** Offense-perspective yard line at or beyond which a snap is in the red zone (the opponent 20). */
export const RED_ZONE_BALL_ON = 80;

/** Fatigue recovered per play by players who sat out. */
export const REST_RECOVERY_PER_PLAY = 0.04;

export interface ApplyOptions {
  special: SpecialKind;
  offensivePlayId: string | null;
  defensivePlayId: string | null;
  hurryUp?: boolean;
}

export interface ApplyReport {
  outcome: PlayOutcome;
  /** The special-teams kind the rules used (fakes already resolved to 'none'). */
  special: SpecialKind;
  entry: PlayLogEntry;
  scoring: ScoreResult;
  possession: PossessionResult | null;
  enforcement: Enforcement;
  clock: ClockResult;
  firstDown: boolean;
  periodEnded: boolean;
  halftime: boolean;
  final: boolean;
  overtimeStarts: boolean;
  nextOvertimePeriod: boolean;
  overtime: OvertimeVerdict | null;
  twoMinuteWarning: 1 | 2 | null;
  quarterEnded: number | null;
}

const isPassResult = (o: PlayOutcome): boolean => o.result === 'pass' || o.result === 'incomplete' || o.result === 'sack' || o.result === 'interception';
const isRushResult = (o: PlayOutcome): boolean => o.result === 'run' || o.result === 'scramble' || o.result === 'kneel';

const mergeFatigue = (state: GameState, outcome: PlayOutcome): void => {
  if (!state.ruleset.fatigue) return;
  for (const id of Object.keys(state.fatigue)) {
    const pid = id as keyof typeof state.fatigue;
    const after = outcome.fatigueAfter[pid];
    state.fatigue[pid] = after !== undefined ? clamp(after, 0, 1) : Math.max(0, state.fatigue[pid] - REST_RECOVERY_PER_PLAY);
  }
  for (const [id, f] of Object.entries(outcome.fatigueAfter)) state.fatigue[id as keyof typeof state.fatigue] = clamp(f, 0, 1);
};

const recordTeamStats = (
  state: GameState, outcome: PlayOutcome, offense: TeamSide, special: SpecialKind, enf: Enforcement,
  scoring: ScoreResult, pre: { down: number; ballOn: number }, chargedSec: number, firstDown: boolean,
  redZone: { newTrip: boolean; tripDrive: boolean },
): void => {
  const defense = otherSide(offense);
  const teams = state.stats.teams;
  for (const p of enf.accepted) {
    teams[foulingTeam({ possession: offense }, p)].penalties += 1;
  }
  // The stat sheet counts whole yards; half-the-distance spots can be fractional (the spot itself stays exact).
  teams[offense].penaltyYards += Math.round(enf.yardsBySide.offense);
  teams[defense].penaltyYards += Math.round(enf.yardsBySide.defense);
  if (scoring.scoringSide) {
    teams[scoring.scoringSide].points += scoring.points;
    teams[otherSide(scoring.scoringSide)].pointsAgainst += scoring.points;
  }
  const scrimmage = !isKickPlay(special) && !isPatPlay(special);
  // First downs by penalty count even when the live result is wiped.
  if (scrimmage && firstDown) teams[offense].firstDowns += 1;
  // A red-zone trip is one per drive, counted at its first snap at or inside the opponent 20 (a snap is a snap even
  // when a foul wipes the play), so touchdowns can never outnumber trips.
  if (redZone.newTrip) teams[offense].redZoneTrips += 1;
  if (enf.nullified) return;
  // A two-point try is not a scrimmage play for the stat sheet: snaps count, yards and attempts do not (so the
  // player lines keep adding up to the team totals).
  applyDeltas(state.stats, special === 'twoPoint' ? outcome.stats.filter((d) => /snaps$/i.test(d.stat)) : outcome.stats);
  if (scrimmage) {
    teams[offense].plays += 1;
    // An intercepted pass gains the offense nothing, even when it gets the ball back on the return (a fumble
    // recovered after the pick): those yards are change-of-possession yardage, and the passer is credited none.
    const offenseYards = outcome.result === 'interception' ? 0 : outcome.yards;
    teams[offense].totalYards += offenseYards;
    teams[defense].yardsAgainst += offenseYards;
    if (isPassResult(outcome)) teams[offense].passYards += offenseYards;
    else if (isRushResult(outcome)) teams[offense].rushYards += offenseYards;
    if (outcome.result === 'sack') teams[defense].sacks += 1;
    if (outcome.bigPlay) teams[offense].explosivePlays += 1;
    if (outcome.success) teams[offense].successfulPlays += 1;
    teams[offense].epa += outcome.epa;
    const converted = firstDown || (scoring.kind === 'touchdown' && scoring.scoringSide === offense);
    if (pre.down === 3) {
      teams[offense].thirdDownAttempts += 1;
      if (converted) teams[offense].thirdDownConversions += 1;
    } else if (pre.down === 4 && special !== 'punt' && special !== 'fieldGoal') {
      teams[offense].fourthDownAttempts += 1;
      if (converted) teams[offense].fourthDownConversions += 1;
    }
    if (redZone.tripDrive && scoring.kind === 'touchdown' && scoring.scoringSide === offense) teams[offense].redZoneTouchdowns += 1;
  }
  if (outcome.turnover && outcome.turnoverType !== 'onside') {
    const loser = isKickPlay(special) ? defense : offense;
    teams[loser].turnovers += 1;
    teams[otherSide(loser)].takeaways += 1;
  }
  // A failed fourth down changes possession but is not a giveaway: TURNOVERS / TAKEAWAYS count interceptions and
  // lost fumbles only (the drive still ends 'downs').
  teams[isKickPlay(special) ? defense : offense].timeOfPossessionSec += chargedSec;
};

/**
 * The offense let the clock run out instead of snapping (a kneel whose huddle covers every second left): nothing
 * happened on the field, so the play log gets a no-snap entry that keeps the spot, the down and every stat untouched.
 */
export const clockRunsOutOutcome = (ruled: PlayOutcome, state: Pick<GameState, 'possession' | 'ballOn' | 'ballX' | 'clock'>): PlayOutcome => emptyOutcome({
  result: 'kneel', yards: 0, endBallOn: state.ballOn, endBallX: state.ballX, timeElapsed: 0,
  presnapElapsed: Math.max(ruled.presnapElapsed, state.clock.secondsRemaining), passerId: ruled.passerId, ballCarrierId: ruled.ballCarrierId,
  playByPlay: ['The offense lets the clock run out.'], epa: 0, success: false,
}, state.possession);

/**
 * Applies one play to the GameState IN PLACE, in the documented order: enforce (already decided)
 * penalties -> scoring -> possession/downs -> dead-ball fouls -> clock -> spots -> overtime bookkeeping
 * -> stats/fatigue/injuries -> play log -> period end / halftime / overtime / final -> phase.
 * The DERIVED outcome fields are filled in on the logged copy. The rng state is the controller's job.
 */
export const applyOutcome = (state: GameState, ruled: PlayOutcome, opts: ApplyOptions): ApplyReport => {
  const offense = state.possession;
  const defense = otherSide(offense);
  const special = effectiveSpecial(opts.special, ruled);
  const scrimmage = !isKickPlay(special) && !isPatPlay(special);
  const pre = { down: state.down, distance: state.distance, ballOn: state.ballOn, ballX: state.ballX, quarter: state.clock.quarter, clock: state.clock.secondsRemaining };
  const playIndex = state.playLog.length;
  const expired = clockExpiresBeforeSnap(state, ruled, special, opts.hurryUp === true);
  // A return-team foul on a kick cuts the return back; the kick itself stands (rules/penalties.ts applyReturnFouls).
  const returned = applyReturnFouls(expired ? clockRunsOutOutcome(ruled, state) : ruled, special, state.ruleset.touchbackYardLine);
  const incoming = returned.outcome;

  const enf = enforcePenalties(state, incoming, special);
  if (!enf.nullified) enf.yardsBySide.defense += returned.yards;
  // No snap: handled like a wiped play (same spot and down, no stats) and the clock runs to 0:00.
  if (expired) enf.nullified = true;
  const nullified = enf.nullified;
  const scoring: ScoreResult = nullified ? { ...NO_SCORE } : scoreOutcome(state, incoming, special);
  const poss = nullified ? null : possessionAfter(state, incoming, scoring, special);
  const downs = scrimmage && !nullified ? advanceDowns(state, incoming) : null;

  let next: SpotState;
  let kickoffBy: TeamSide | null;
  let patBy: TeamSide | null;
  let freeKickBy: TeamSide | null = null;
  if (nullified) {
    next = enf.turnoverOnDowns
      ? { possession: defense, ballOn: clampSpot(100 - enf.ballOn), ...firstDownAt(clampSpot(100 - enf.ballOn)) }
      : { possession: offense, ballOn: enf.ballOn, down: enf.down, distance: enf.distance };
    kickoffBy = state.kickoffPending;
    patBy = state.patPending;
  } else if (poss) {
    next = { possession: poss.possession, ballOn: poss.ballOn, down: poss.down, distance: poss.distance };
    kickoffBy = poss.kickoffBy;
    patBy = poss.patBy;
    freeKickBy = poss.freeKickBy;
  } else {
    throw new Error('applyOutcome: unreachable');
  }
  const penaltyYards = { ...enf.yardsBySide };
  // A first down for the play offense: reached the line to gain, or granted by an enforced defensive foul.
  let firstDown = (downs?.firstDown === true && !incoming.turnover) || (enf.firstDown && !enf.turnoverOnDowns);
  for (const p of enf.postPlay) {
    const fouler = foulingTeam({ possession: offense }, p);
    const kicker = kickoffBy ?? freeKickBy ?? patBy;
    if (kicker) {
      const before = next.ballOn;
      next = { ...next, ballOn: adjustKickSpot(next.ballOn, fouler === kicker, p.yards) };
      penaltyYards[p.side] += Math.abs(next.ballOn - before);
    } else {
      const r = applyDeadBallYards(next, fouler, p);
      next = r.spot;
      penaltyYards[p.side] += r.yards;
      if (r.firstDown && scrimmage && next.possession === offense) firstDown = true;
    }
  }
  enf.yardsBySide = penaltyYards;

  const clock = applyClock(state, incoming, {
    special,
    hurryUp: opts.hurryUp === true,
    penaltyAccepted: enf.accepted.length > 0,
    extendsPeriod: enf.accepted.some(extendsPeriodFoul) && !isPatPlay(special),
    firstDown: firstDown && !nullified,
    possessionChanged: poss?.changed === true,
    scored: scoring.points > 0,
    injury: incoming.injuries.length > 0,
    nullified,
  });
  state.clock = clock.clock;
  if (clock.twoMinuteWarning === 1) state.twoMinuteWarningGiven.half1 = true;
  if (clock.twoMinuteWarning === 2) state.twoMinuteWarningGiven.half2 = true;
  if (scoring.scoringSide) state.score[scoring.scoringSide] += scoring.points;

  let overtime: OvertimeVerdict | null = null;
  if (state.overtime && !nullified && poss) {
    const keepsBall = poss.possession === offense && poss.newDrive;
    const ended = poss.driveResult !== null && scoring.kind === null && !keepsBall ? offense : null;
    overtime = applyOvertimePlay(state, scoring, ended);
  }
  if (patBy && (overtime?.gameOver || !patRequired(state, patBy))) {
    patBy = null;
    kickoffBy = scoring.scoringSide;
  }

  // Spots for the next snap.
  state.possession = next.possession;
  state.ballOn = next.ballOn;
  state.down = next.down;
  state.distance = next.distance;
  const kickNext = kickoffBy !== null || freeKickBy !== null || patBy !== null;
  if (!nullified) state.ballX = kickNext || poss?.touchback ? MIDDLE_X : spotBallX(incoming.endBallX);
  state.kickoffPending = kickoffBy ?? freeKickBy;
  state.patPending = patBy;
  state.pendingDecision = freeKickBy ? { side: freeKickBy, kind: 'freeKick', deadlineSec: null } : null;
  if (!state.ruleset.kickoffs && (kickoffBy || freeKickBy)) {
    const kicker = (kickoffBy ?? freeKickBy) as TeamSide;
    const receiver = otherSide(kicker);
    state.kickoffPending = null;
    state.pendingDecision = null;
    state.possession = receiver;
    state.ballOn = state.ruleset.touchbackYardLine;
    const fd = firstDownAt(state.ballOn);
    state.down = fd.down;
    state.distance = fd.distance;
    state.ballX = MIDDLE_X;
  }

  // Red-zone trip: the drive's first scrimmage snap at or inside the opponent 20 (flagged before the drive can roll over).
  const driveIsOffense = state.drive.possession === offense;
  const newTrip = scrimmage && !expired && driveIsOffense && pre.ballOn >= RED_ZONE_BALL_ON && state.drive.redZone !== true;
  if (newTrip) state.drive.redZone = true;
  const redZone = { newTrip, tripDrive: driveIsOffense && state.drive.redZone === true };

  // Drive bookkeeping.
  if (!nullified && poss) {
    if (scrimmage) {
      state.drive.plays += 1;
      state.drive.yards += incoming.yards;
    }
    // A drive's result is written once: a free-kick punt after a safety must not relabel the 'safety' drive.
    if (poss.driveResult && state.drive.result === null) state.drive.result = poss.driveResult;
    const newScrimmageDrive = poss.newDrive || (!state.ruleset.kickoffs && (kickoffBy || freeKickBy));
    if (newScrimmageDrive) {
      state.drive = newDrive(state.possession, state.ballOn, state.clock.quarter, state.clock.secondsRemaining);
      state.stats.teams[state.possession].drives += 1;
    }
  }

  recordTeamStats(state, incoming, offense, special, enf, scoring, pre, clock.chargedSec, firstDown, redZone);
  mergeFatigue(state, incoming);
  for (const inj of incoming.injuries) state.injuries.push({ playerId: inj.playerId, severity: inj.severity, quarter: pre.quarter, playIndex });

  const outcome: PlayOutcome = {
    ...incoming,
    clockStops: clock.stops,
    possessionAfter: state.possession,
    points: scoring.points,
    scoringSide: scoring.scoringSide,
  };
  const entry: PlayLogEntry = {
    index: playIndex, quarter: pre.quarter, clock: pre.clock, possession: offense, down: pre.down, distance: pre.distance,
    ballOn: pre.ballOn, ballX: pre.ballX, offensivePlayId: opts.offensivePlayId, defensivePlayId: opts.defensivePlayId,
    outcome, scoreAfter: { ...state.score }, review: null,
  };
  state.playLog.push(entry);
  state.lastOutcome = outcome;

  // Period end / game end.
  let final = overtime?.gameOver === true;
  let halftime = false;
  let overtimeStarts = false;
  let nextPeriod = false;
  let quarterEnded: number | null = null;
  const periodEnded = clock.periodEnded && !final;
  if (periodEnded && state.patPending === null) {
    const q = state.clock.quarter;
    quarterEnded = q;
    if (state.overtime) {
      const r = resolveOvertimePeriodEnd(state);
      final = r.final;
      nextPeriod = r.nextPeriod;
    } else if (q === 1 || q === 3) {
      rolloverQuarter(state);
    } else if (q === 2) {
      halftime = true;
    } else if (isTied(state) && overtimeAllowed(state)) {
      overtimeStarts = true;
    } else {
      final = true;
    }
  }
  if (final) {
    state.phase = 'final';
    state.pendingDecision = null;
    state.kickoffPending = null;
    state.patPending = null;
    state.clock.running = false;
    if (state.drive.result === null) state.drive.result = 'endOfGame';
  } else if (halftime) {
    startHalftime(state);
  } else if (overtimeStarts) {
    startOvertime(state);
  } else {
    if (nextPeriod) nextOvertimePeriod(state);
    state.direction = directionFor(state.possession, state.clock.quarter);
    state.phase = state.patPending ? 'pat' : state.pendingDecision ? 'deadball' : state.kickoffPending ? 'kickoff' : clock.twoMinuteWarning ? 'twoMinute' : 'playcall';
  }
  return {
    outcome, special, entry, scoring, possession: poss, enforcement: enf, clock, firstDown, periodEnded, halftime, final,
    overtimeStarts, nextOvertimePeriod: nextPeriod, overtime, twoMinuteWarning: clock.twoMinuteWarning, quarterEnded,
  };
};

/** AI coach hooks (ai/coaching.ts plugs in richer versions; these defaults are simple heuristics). */
export interface CoachHooks {
  coinToss(state: GameState, side: TeamSide): 'kick' | 'receive' | 'defer';
  freeKick(state: GameState, side: TeamSide): 'kick' | 'punt';
  shouldAccept(state: GameState, outcome: PlayOutcome, penalty: PenaltyInfo, ctx: PenaltyDecisionContext): boolean;
  shouldChallenge(state: GameState, outcome: PlayOutcome, side: TeamSide, special: SpecialKind): boolean;
  callTimeout(state: GameState, side: TeamSide): boolean;
  pickOffensivePlay(state: GameState, plays: OffensivePlay[], rng: Rng): OffensivePlay;
  pickDefensivePlay(state: GameState, plays: DefensivePlay[], rng: Rng): DefensivePlay;
  /** No-huddle for an AI offense (two-minute drill, chasing points late). Optional: absent = always huddle. */
  hurryUp?(state: GameState, side: TeamSide): boolean;
}

/** Offense-perspective yard line from which the default coach trusts a field goal (~54 yards). */
export const FIELD_GOAL_RANGE_BALL_ON = 63;

export const defaultCoach: CoachHooks = {
  coinToss: (state) => (state.overtime ? 'receive' : 'defer'),
  freeKick: () => 'kick',
  shouldAccept: (_s, _o, _p, ctx) => ctx.valueIfAccepted > ctx.valueIfDeclined + 1e-6,
  shouldChallenge: (state, outcome, side, special) => shouldChallengeDefault(state, outcome, side, special),
  callTimeout: (state, side) => {
    const c = state.clock;
    if (!c.running || state.timeouts[side] <= 0) return false;
    const margin = state.score[side] - state.score[otherSide(side)];
    const onDefense = state.possession !== side;
    if (c.quarter >= 4) {
      if (onDefense && margin <= 0 && c.secondsRemaining <= 120) return true;
      if (!onDefense && margin < 0 && c.secondsRemaining <= 60) return true;
    } else if (c.quarter === 2 && !onDefense && c.secondsRemaining <= 30 && state.ballOn >= 60) {
      return true;
    }
    return false;
  },
  pickOffensivePlay: (state, plays, rng) => {
    const scrimmage = plays.filter((p) => !isSpecialConcept(p.concept) && p.concept !== 'kneel' && p.concept !== 'spike');
    const margin = state.score[state.possession] - state.score[otherSide(state.possession)];
    if (state.down === 4) {
      const fg = plays.find((p) => p.concept === 'fieldGoal');
      const punt = plays.find((p) => p.concept === 'punt');
      const desperate = state.clock.quarter >= 4 && state.clock.secondsRemaining < 240 && margin < 0;
      if (fg && state.ballOn >= FIELD_GOAL_RANGE_BALL_ON && !(desperate && margin < -3)) return fg;
      const goForIt = (state.distance <= 1 && state.ballOn >= 40) || desperate || scrimmage.length === 0;
      if (!goForIt && punt && state.ballOn < FIELD_GOAL_RANGE_BALL_ON) return punt;
    }
    return scrimmage.length > 0 ? rng.pick(scrimmage) : syntheticScrimmagePlay();
  },
  pickDefensivePlay: (_state, plays, rng) => rng.pick(plays),
  hurryUp: (state, side) => shouldHurryUp({
    quarter: state.clock.quarter, secondsRemaining: state.clock.secondsRemaining, scoreDiff: state.score[side] - state.score[otherSide(side)], overtime: state.overtime !== null,
  }),
};

/** Between-play phase for the current pending kick/PAT state. */
export const betweenPlayPhase = (state: Pick<GameState, 'patPending' | 'kickoffPending' | 'pendingDecision' | 'phase'>): GameState['phase'] => {
  if (state.phase === 'final') return 'final';
  if (state.patPending) return 'pat';
  if (state.pendingDecision?.kind === 'freeKick') return 'deadball';
  if (state.kickoffPending) return 'kickoff';
  return 'playcall';
};

/** Half (1|2) the game is currently in, for two-minute bookkeeping. */
export const currentHalf = (state: Pick<GameState, 'clock'>): 1 | 2 => halfOf(state.clock.quarter);
