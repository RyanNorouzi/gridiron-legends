import { clamp, ratingToFactor } from '@/core/math';
import type { Rng } from '@/core/rng';
import { POSITION_GROUP } from '@/players/types';
import { chemistryFor } from '@/game/chemistry';
import type { PlayContext } from '@/game/play-types';
import type { CatchKind, IncompleteReason, ThrowType } from '@/game/play-events';
import { carrierPowerOf, openFieldOf, separationYards, tacklePowerOf, type Matchups, type RatedPlayer, type ReceiverOption } from './matchups';
import type { FumbleInfo, InterceptionInfo, ModelKnobs, PassResolution, RunResolution, SackInfo, TackleInfo } from './play-model';
import { resolveRun } from './run-model';
import { approachFactor, lognormalMean, pickBy, pickTackleKind, pickTackler, rollFumble, roundYards } from './sim-random';

/**
 * Passing model: protection vs rush decides pressure/sacks/scrambles, the QB reads the progression with
 * decision noise, the target's openness, the throw depth, the passer, pressure, weather, QB-receiver chemistry and the
 * concept-vs-coverage modifiers set the completion chance, and incompletions split into picks, drops,
 * break-ups and misses. Yards after the catch are log-normal so screens and slants can go the distance.
 */
export interface PassOptions {
  playAction: boolean;
  screen: boolean;
  rpo: boolean;
}

/** Completion-chance swing from QB-receiver chemistry (+/- half this between a cold pair and a perfect one). */
export const CHEMISTRY_COMPLETION = 0.08;

/** League-average fumble rate per reception (strips after the catch). */
export const FUMBLE_PER_RECEPTION = 0.006;

const f = ratingToFactor;

const pressureProbability = (m: Matchups, dropback: number, quick: boolean, o: PassOptions): number => {
  let p = 0.31 + 0.55 * (m.passRush - m.passProtection) + m.modifiers.pressure + 0.03 * m.blitzCount;
  if (dropback >= 7) p += 0.05;
  if (quick) p -= 0.1;
  if (o.playAction) p += 0.04;
  return clamp(p, 0.05, 0.75);
};

const sackProbability = (m: Matchups, dropback: number, quick: boolean): number => {
  let p = 0.245 + 0.25 * (m.passRush - m.passProtection) - 0.18 * (m.qbMobility - 0.5) - 0.12 * (m.qbDecision - 0.5) + m.modifiers.sack;
  if (dropback >= 7) p += 0.04;
  if (quick) p -= 0.1;
  return clamp(p, 0.03, 0.5);
};

/** Who beats his man: talent tilts it, but pressure (and sack credit) is shared across the rush like real sack totals. */
const rusherWeight = (r: RatedPlayer): number => 0.8 + 0.8 * f(r.attrs.passRush) + 0.3 * f(r.attrs.speed) + (r.assignment.type === 'blitz' ? 0.3 : 0);

/**
 * How open (after the QB's read noise) a receiver in the progression must look for the QB to pull the trigger on
 * him instead of moving to the next read. Reading the progression in order, rather than always finding the most open
 * man, is what spreads targets across the formation (a real WR1 sees ~25-30% of his team's targets, not half).
 */
export const PROGRESSION_BAR = 0.58;

/** Openness threshold shift per unit of the AI defense's interceptionAwareness over 0.5 (breaking on the ball). */
export const BREAK_ON_BALL = 0.12;

/** Base chance (scaled by QB decision-making) that a QB whose reads are all covered checks the ball down. */
export const CHECKDOWN_SHARE = 0.3;

/** Softmax temperature over the QB's looks when nobody cleared the bar (lower = always the most open man). */
export const LOOK_TEMPERATURE = 0.1;

/** Weighted pick from a pre-drawn uniform roll (0..1): the same one die whatever the weights. */
const pickWithRoll = <T>(roll: number, items: readonly T[], weight: (item: T) => number): T | null => {
  let total = 0;
  for (const it of items) total += Math.max(0, weight(it));
  if (items.length === 0 || total <= 0) return items[0] ?? null;
  let acc = roll * total;
  for (const it of items) {
    acc -= Math.max(0, weight(it));
    if (acc < 0) return it;
  }
  return items[items.length - 1] ?? null;
};

/** Share of snaps a QB starts his progression at the play's designed primary; the rest start at the 2nd or 3rd read. */
export const PRIMARY_READ_SHARE = 0.35;
export const SECOND_READ_SHARE = 0.33;

/**
 * Where this snap's progression starts, and a fresh 0..1 roll for the look pick, both from ONE uniform draw (split,
 * so the dice stay the same whatever the call): the designed primary most of the time, but the pre-snap read (the
 * leverage, a rotated safety, the defender over him) moves the first look to the second or third man on the rest, as
 * it does for a real QB. Without this the X receiver was the first read on nearly every dropback and drew a third or
 * more of his team's targets (a real WR1 sees ~25-30%).
 */
export const progressionStart = (u: number, receivers: number): { start: number; roll: number } => {
  const x = clamp(u, 0, 1 - 1e-9);
  if (receivers <= 1 || x < PRIMARY_READ_SHARE) return { start: 0, roll: x / PRIMARY_READ_SHARE };
  if (receivers === 2 || x < PRIMARY_READ_SHARE + SECOND_READ_SHARE) {
    const lo = PRIMARY_READ_SHARE;
    const hi = receivers === 2 ? 1 : PRIMARY_READ_SHARE + SECOND_READ_SHARE;
    return { start: 1, roll: (x - lo) / (hi - lo) };
  }
  const lo = PRIMARY_READ_SHARE + SECOND_READ_SHARE;
  return { start: 2, roll: (x - lo) / (1 - lo) };
};

/**
 * QB progression read with decision noise: first read open enough wins, else the best look; screens go to the screen
 * man. The dice are fixed whatever the QB's decision quality (difficulty): one standard-normal draw per receiver, the
 * checkdown roll and the look roll, always drawn in that order. Decision quality only scales the noise and moves
 * the thresholds, so a rookie and a legend QB read the same snap from the same numbers. The look roll also sets
 * where the progression starts (progressionStart).
 */
export const chooseTarget = (ctx: PlayContext, m: Matchups, rng: Rng, pressure: boolean, o: PassOptions): ReceiverOption | null => {
  if (m.receivers.length === 0) return null;
  const screenMan = o.screen ? m.receivers.find((r) => r.routeType === 'screen') : undefined;
  if (screenMan) return screenMan;
  const z = m.receivers.map(() => rng.gaussian(0, 1));
  const checkRoll = rng.next();
  const { start, roll: lookRoll } = progressionStart(rng.next(), m.receivers.length);
  const noise = 0.1 + 0.2 * (1 - m.qbDecision);
  const needs = ctx.down >= 3 ? ctx.distance : 0;
  let best: ReceiverOption | null = null;
  let bestScore = -Infinity;
  const looks: { r: ReceiverOption; s: number }[] = [];
  const n = m.receivers.length;
  for (let k = 0; k < n; k++) {
    // The k-th look of this snap's progression (it starts at the designed primary most of the time: see progressionStart).
    const i = (start + k) % n;
    const r = m.receivers[i] as ReceiverOption;
    let s = r.openness + 0.1 * (r.quality - 0.5) + noise * (z[i] ?? 0);
    if (pressure) s -= 0.012 * Math.max(0, r.depth);
    if (needs > 0 && r.depth + 2 < needs) s -= 0.08 * m.qbDecision;
    // Later reads come under pressure / the clock: the bar rises as the QB works through the progression. A deep
    // route needs less separation to be worth the throw.
    if (s >= PROGRESSION_BAR + 0.03 * k - (pressure ? 0.04 : 0) - 0.005 * clamp(r.depth, 0, 20)) return r;
    looks.push({ r, s: s - 0.05 * k });
    if (s - 0.05 * k > bestScore) { bestScore = s - 0.05 * k; best = r; }
  }
  // Nobody came open: a sound QB often checks it down to his shallowest man instead of forcing the best look.
  if (best && checkRoll < CHECKDOWN_SHARE * (0.6 + 0.8 * m.qbDecision)) {
    const check = m.receivers.reduce((a, b) => (b.depth < a.depth ? b : a));
    if (check.depth < best.depth) return check;
  }
  // Otherwise the best look, but not always the same man: nearly-as-good looks get the ball too.
  return pickWithRoll(lookRoll, looks, (l) => Math.exp((l.s - bestScore) / LOOK_TEMPERATURE))?.r ?? best;
};

const throwTypeFor = (rng: Rng, air: number, target: ReceiverOption): ThrowType => {
  if (air < 0) return 'touch';
  if (target.routeType === 'fade' && rng.chance(0.5)) return rng.chance(0.6) ? 'backShoulder' : 'highPoint';
  if (air >= 25) return rng.chance(0.6) ? 'lob' : 'bullet';
  if (air >= 12) return rng.chance(0.6) ? 'bullet' : 'touch';
  return rng.chance(0.7) ? 'bullet' : 'touch';
};

/** Receiver skill at the catch point (the live catchContest blend): catching, hands, jumping, awareness. */
export const catchSkillOf = (r: RatedPlayer): number =>
  0.45 * f(r.attrs.catching) + 0.3 * f(r.attrs.hands) + 0.1 * f(r.attrs.jumping) + 0.15 * f(r.attrs.awareness);

/** Defender skill at the catch point (the live catchContest blend): coverage, reaction, jumping, hands. */
export const contestSkillOf = (d: RatedPlayer | null): number =>
  d ? 0.45 * f(d.attrs.coverage) + 0.25 * f(d.attrs.reaction) + 0.15 * f(d.attrs.jumping) + 0.15 * f(d.attrs.hands) : 0.6;

/**
 * Completion multiplier on a contested ball per unit of catch skill over the defender's contest skill: sure hands
 * win the 50-50 balls (the live engine's catchContest has the same slope). 1 when skills are even.
 */
export const CONTESTED_CATCH_SLOPE = 1.1;

/** How a contested catch goes for this receiver against this defender (ratings only). */
export const contestedCatchFactor = (target: ReceiverOption): number =>
  clamp(1 + CONTESTED_CATCH_SLOPE * (catchSkillOf(target.rated) - contestSkillOf(target.defender)), 0.55, 1.3);

/** Yards from the goal line inside which the field compresses (fewer windows, the end line as an extra defender). */
export const RED_ZONE_YARDS = 20;

/**
 * Completion penalty of the compressed field near the goal line: up to 0.2 at the goal line, scaled down to 0 at the
 * 20, plus 0.06 for a catch in the end zone. A route cut short by the end line otherwise got the easy short-throw rate
 * and the open-field openness, so red-zone drives ended in touchdowns far more often than NFL drives do.
 */
export const compressedFieldPenalty = (ballOn: number, air: number): number => {
  const toGoal = 100 - ballOn;
  if (toGoal > RED_ZONE_YARDS) return 0;
  return 0.2 * (1 - toGoal / RED_ZONE_YARDS) + (ballOn + air >= 100 ? 0.06 : 0);
};

/** Openness scale at the goal line: defenders have less grass to cover, so windows close (1 at the 20). */
export const GOAL_LINE_OPENNESS = 0.75;

/** The target as the compressed field sees him: openness scaled from 1 at the 20 down to GOAL_LINE_OPENNESS. */
const compressedTarget = (ctx: PlayContext, target: ReceiverOption): ReceiverOption => {
  const toGoal = 100 - ctx.ballOn;
  if (toGoal > RED_ZONE_YARDS) return target;
  return { ...target, openness: target.openness * (1 - (1 - GOAL_LINE_OPENNESS) * (1 - toGoal / RED_ZONE_YARDS)) };
};

/**
 * Completion chance of an average throw to an average target before depth, openness, the passer, pressure, weather and
 * the concept modifiers. Calibrated on full franchise seasons (season-calibration: league completion ~62.5-63.5%
 * against the NFL's ~64-65%) with the scrimmage table kept within balance.test.ts's live-vs-fast tolerance. It was 0.55,
 * which left league seasons near 58% once game situations (pressure, long yardage, the red zone) were in play.
 */
export const COMPLETION_BASE = 0.6;

const completionProbability = (ctx: PlayContext, m: Matchups, target: ReceiverOption, air: number, pressure: boolean, throwType: ThrowType, contested: boolean): number => {
  const depthPen = air <= 0 ? 0.16 : air <= 5 ? 0.13 : air <= 10 ? -0.02 : air <= 15 ? -0.12 : air <= 20 ? -0.21 : air <= 30 ? -0.31 : -0.39;
  let p = COMPLETION_BASE + 0.32 * (target.openness - 0.5) + 0.26 * (m.qbQuality - 0.5) + 0.16 * (target.quality - 0.5) + depthPen + m.modifiers.completion;
  if (pressure) p -= 0.13;
  // QB-receiver chemistry: a long-tenured pair completes a few more, a brand-new one a few fewer.
  p += CHEMISTRY_COMPLETION * (chemistryFor(ctx.passChemistry, target.rated.player.id) - 0.5);
  if (throwType === 'lob') p -= 0.02;
  if (throwType === 'backShoulder') p -= 0.03;
  const w = ctx.weather;
  if (air > 12) p -= 0.004 * Math.max(0, w.windMph - 8);
  if (w.type === 'rain') p -= 0.02;
  else if (w.type === 'heavyRain') p -= 0.05;
  else if (w.type === 'snow') p -= 0.04;
  p -= compressedFieldPenalty(ctx.ballOn, air);
  if (contested) p *= contestedCatchFactor(target);
  return clamp(p, 0.1, 0.94);
};

/** Base interception share of an incompletion before depth, openness, QB decision and the contest scale it. */
export const INT_BASE = 0.062;

const interceptionProbability = (m: Matchups, target: ReceiverOption, air: number, throwType: ThrowType, contested: boolean): number => {
  let p = INT_BASE;
  p *= 1 + 0.5 * clamp((air - 5) / 15, -0.3, 1);
  p *= 1 + 0.8 * (0.5 - target.openness);
  p *= 1.3 - 0.6 * m.qbDecision;
  p *= 1 + m.modifiers.interception * 4;
  if (throwType === 'lob') p *= 1.3;
  if (contested) p *= 1.25;
  return clamp(p, 0.01, 0.35);
};

/**
 * Scale on the mean yards after the catch. Targets come from a progression read (not always the most open man), so the
 * table below is scaled to keep yards per completion on the live engine's ~12 (live-vs-fast ypa in balance.test.ts).
 */
export const YAC_SCALE = 1.2;

const yacMean = (m: Matchups, target: ReceiverOption, air: number): number => {
  const base = YAC_SCALE * (air <= 0 ? 8 : air <= 5 ? 4.6 : air <= 12 ? 3.1 : air <= 20 ? 2.6 : 3.6);
  return base * (0.7 + 0.6 * openFieldOf(target.rated)) * (1 + m.modifiers.yac) * (0.85 + 0.3 * target.openness);
};

/** Who brings down an interceptor: usually a receiver, sometimes the QB himself. */
const offensiveTackler = (rng: Rng, m: Matchups): RatedPlayer | null =>
  pickBy(rng, m.offense, (p) => (POSITION_GROUP[p.position] === 'WR' || POSITION_GROUP[p.position] === 'RB' ? 1 : p.position === 'QB' ? 0.35 : 0.15) * (0.5 + f(p.attrs.pursuit)));

const resolveInterception = (ctx: PlayContext, m: Matchups, rng: Rng, target: ReceiverOption, air: number): InterceptionInfo => {
  const by = (target.defender && rng.chance(0.7) ? target.defender : pickBy(rng, m.coverageDefenders.length ? m.coverageDefenders : m.defense, (d) => 0.3 + f(d.attrs.coverage) + f(d.attrs.reaction))) ?? (m.defense[0] as RatedPlayer);
  let spot = ctx.ballOn + air;
  let touchback = false;
  if (spot >= 100) {
    if (rng.chance(0.6)) touchback = true;
    spot = 100;
  }
  const returnYards = touchback ? 0 : Math.min(Math.round(lognormalMean(rng, 7 + 10 * (openFieldOf(by) - 0.5), 0.95)), Math.round(spot));
  const touchdown = !touchback && spot - returnYards <= 0;
  return { by, spotBallOn: clamp(spot, 0.5, 100), returnYards, touchdown, touchback, tackledBy: touchdown || touchback ? null : offensiveTackler(rng, m) };
};

const incompleteReasonFor = (ctx: PlayContext, m: Matchups, rng: Rng, target: ReceiverOption, air: number, contested: boolean): { reason: IncompleteReason; defender: RatedPlayer | null } => {
  const hands = f(target.rated.attrs.hands);
  const wet = ctx.weather.type === 'rain' || ctx.weather.type === 'heavyRain' || ctx.weather.type === 'snow' ? 1.35 : 1;
  const pDrop = clamp(0.24 * (1.45 - hands) * wet * (contested ? 0.7 : 1), 0.02, 0.3);
  if (air >= -2 && rng.chance(pDrop)) return { reason: 'drop', defender: null };
  const pDefended = clamp(0.3 + 0.5 * (0.5 - target.openness) + (contested ? 0.2 : 0), 0.1, 0.75);
  if (rng.chance(pDefended)) return { reason: 'defended', defender: target.defender ?? pickBy(rng, m.coverageDefenders.length ? m.coverageDefenders : m.defense, (d) => 0.3 + f(d.attrs.coverage)) };
  const over = air >= 12 ? 0.6 : 0.5;
  return { reason: rng.chance(over) ? 'overthrown' : 'underthrown', defender: null };
};

const throwAwayResolution = (base: PassResolution, rng: Rng): PassResolution => ({ ...base, throwAway: true, incompleteReason: 'throwAway', throwType: 'throwAway', timeElapsed: clamp(4 + rng.range(0, 1.2), 3.5, 5.5) });

/** Resolves a dropback; may return a RunResolution when the QB escapes pressure and scrambles. */
export const resolvePass = (ctx: PlayContext, m: Matchups, knobs: ModelKnobs, rng: Rng, o: PassOptions): PassResolution | RunResolution => {
  const passer = m.passer ?? (m.offense[0] as RatedPlayer);
  const play = ctx.offensivePlay;
  const dropback = play.dropback ?? 5;
  const quick = o.screen || o.rpo || dropback <= 3 || play.concept === 'slant';
  const fakeTo = o.playAction || o.rpo ? m.offense.find((p) => p.role === (play.fakeTo ?? play.assignments['QB']?.fakeTo)) ?? m.carrier : null;
  const base: PassResolution = {
    kind: 'pass', passer, playAction: o.playAction, screen: o.screen, fakeTo: fakeTo ?? null, pressure: false, pressureBy: null, sack: null, throwAway: false,
    target: null, throwType: 'bullet', airYards: 0, separation: 0, complete: false, incompleteReason: null, defender: null, contested: false, catchKind: 'possession',
    yac: 0, yardsAfterContact: 0, brokenTackles: 0, yards: 0, interception: null, tackle: null, outOfBounds: false, touchdown: false, safety: false, fumble: null, timeElapsed: 4,
  };
  const pressure = rng.chance(pressureProbability(m, dropback, quick, o));
  const pressureBy = pressure ? pickBy(rng, m.rushers.length ? m.rushers : m.defense, rusherWeight) : null;
  base.pressure = pressure;
  base.pressureBy = pressureBy;
  if (pressure && pressureBy) {
    if (rng.chance(sackProbability(m, dropback, quick))) {
      const yardsLost = clamp(Math.round(rng.gaussian(6.5, 2.5)), 1, 14);
      const assists = rng.chance(0.25) ? [pickBy(rng, m.rushers.filter((r) => r !== pressureBy), rusherWeight)].filter((r): r is RatedPlayer => r !== null) : [];
      const beaten = pickBy(rng, m.blockers, (b) => 1.2 - f(b.attrs.blocking));
      const safety = ctx.ballOn - yardsLost <= 0;
      const sack: SackInfo = { by: pressureBy, assists, yardsLost: safety ? roundYards(ctx.ballOn) : yardsLost, beatenBlocker: beaten };
      let fumble: FumbleInfo | null = null;
      if (!safety) {
        const roll = rollFumble(rng, ctx.weather, passer, pressureBy, m.offense, m.defense, 0.03, 'strip');
        if (roll) {
          const spotBallOn = clamp(ctx.ballOn - yardsLost, 0.5, 99.5);
          const returnYards = roll.lost ? Math.min(roll.returnYards, Math.round(spotBallOn)) : 0;
          fumble = { forcedBy: roll.forcedBy, recoveredBy: roll.recoveredBy, lost: roll.lost, spotBallOn, returnYards, touchdown: roll.lost && spotBallOn - returnYards <= 0 };
        }
      }
      return { ...base, sack, safety, fumble, timeElapsed: clamp(3.5 + dropback * 0.2 + rng.gaussian(0, 0.5), 3.5, 6.5) };
    }
    const pScramble = quick ? 0.03 : 0.04 + 0.2 * m.qbMobility;
    if (rng.chance(pScramble)) return resolveRun(ctx, m, knobs, rng, { carrier: passer, scramble: true, designedQb: false, draw: false });
    if (rng.chance(0.18)) return throwAwayResolution(base, rng);
  }
  const read = chooseTarget(ctx, m, rng, pressure, o);
  if (!read) return throwAwayResolution(base, rng);

  let air = read.depth + rng.gaussian(0, 1.2 + 0.12 * Math.abs(read.depth)) + m.modifiers.airYards * (read.depth >= 8 ? 1 : 0.3);
  if (pressure && !quick) air *= 0.85;
  air = clamp(air, -8, 60);
  if (ctx.ballOn + air > 100) air = Math.min(air, 100 - ctx.ballOn + rng.range(0.5, 7));
  air = roundYards(air);
  const target = compressedTarget(ctx, read);
  const throwType = throwTypeFor(rng, air, target);
  const separation = separationYards(target.openness + rng.gaussian(0, 0.08));
  // Whether the nearest defender breaks on the ball in time to contest it is his DECISION (ball-hawk read:
  // interceptionAwareness for an AI defense); what happens at the catch point is then ratings only.
  const breakOnBall = knobs.interceptionIq === null ? 0 : BREAK_ON_BALL * (knobs.interceptionIq - 0.5);
  const contested = target.openness + rng.gaussian(0, 0.1) < 0.4 + breakOnBall;
  const complete = rng.chance(completionProbability(ctx, m, target, air, pressure, throwType, contested));
  const res: PassResolution = { ...base, target, throwType, airYards: air, separation, contested, timeElapsed: 4 };

  if (!complete) {
    const rushersPool = m.rushers.length ? m.rushers : m.defense;
    if (air >= 3 && rng.chance(0.03)) {
      return { ...res, incompleteReason: 'batted', defender: pickBy(rng, rushersPool, (r) => 0.5 + f(r.attrs.reaction)), timeElapsed: clamp(3 + dropback * 0.15, 3, 4) };
    }
    if (air >= -3 && rng.chance(interceptionProbability(m, target, air, throwType, contested))) {
      const interception = resolveInterception(ctx, m, rng, target, air);
      return { ...res, interception, defender: interception.by, touchdown: interception.touchdown, timeElapsed: clamp(4 + Math.max(0, air) / 10 + interception.returnYards / 7 + rng.gaussian(0, 0.4), 4, 9) };
    }
    const { reason, defender } = incompleteReasonFor(ctx, m, rng, target, air, contested);
    // Snap to the ball hitting the turf on the live engine's clock (the drop, the read, the flight: ~5-6 s charged).
    return { ...res, incompleteReason: reason, defender, timeElapsed: clamp(3.8 + dropback * 0.2 + Math.max(0, air) / 8 + rng.gaussian(0, 0.4), 3.5, 7) };
  }

  // Completion: yards after the catch, contact, tackle, sideline, touchdown.
  const catchSpot = ctx.ballOn + air;
  let yac = catchSpot >= 100 ? 0 : Math.round(lognormalMean(rng, yacMean(m, target, air), 0.95));
  const defenders = m.coverageDefenders.length ? m.coverageDefenders : m.defense;
  let tackler = pickTackler(rng, defenders, air + yac, { pass: true, prefer: target.defender });
  const missed: RatedPlayer[] = [];
  let brokenTackles = 0;
  if (tackler && yac > 0) {
    let fade = 1;
    for (let i = 0; i < 2 && tackler; i++) {
      const pBreak = clamp((0.08 + 0.4 * (carrierPowerOf(target.rated) - tacklePowerOf(tackler)) + (ctx.ruleset.exaggeratedMoves ? 0.05 : 0)) * fade * approachFactor(rng, tackler, knobs.tackleIq), 0.02, 0.4);
      if (!rng.chance(pBreak)) break;
      brokenTackles += 1;
      missed.push(tackler);
      yac += Math.round(lognormalMean(rng, 5, 0.8));
      tackler = pickTackler(rng, defenders, air + yac, { pass: true, exclude: missed });
      fade *= 0.6;
    }
  }
  // Yardage is credited to the goal line only: a ball caught deep in the end zone counts to the goal line,
  // and a catch in the offense's own end zone that never gets out is a safety.
  let touchdown = false;
  let safety = false;
  let yards = roundYards(air + yac);
  // The stat sheet counts whole yards even when the spot is fractional (half-distance, live spots), matching the
  // live engine: a score from the 1.5 is a 2-yard play.
  if (catchSpot + yac >= 100) {
    touchdown = true;
    yards = roundYards(100 - ctx.ballOn);
    air = Math.min(air, yards);
    yac = yards - air;
  } else if (ctx.ballOn + yards <= 0) {
    safety = true;
    yards = roundYards(-ctx.ballOn);
    yac = yards - air;
  }
  const catchKind: CatchKind = air > 18 && (throwType === 'lob' || throwType === 'highPoint') ? 'highPoint'
    : target.sideline && rng.chance(0.35) ? 'sideline'
      : target.openness < 0.35 && rng.chance(0.25) ? 'diving'
        : yac > 3 ? 'rac' : 'possession';
  const outOfBounds = !touchdown && !safety && rng.chance(target.sideline ? 0.22 : 0.05);
  const contactPoint = clamp(Math.round(rng.gaussian(1.5, 1.5)), 0, Math.max(0, yac));
  const yardsAfterContact = touchdown && yac === 0 ? 0 : Math.max(0, yac - contactPoint);
  let tackle: TackleInfo | null = null;
  let fumble: FumbleInfo | null = null;
  if (!touchdown && tackler) {
    const assists: RatedPlayer[] = [];
    if (rng.chance(0.25)) {
      const helper = pickTackler(rng, defenders, air + yac, { pass: true, exclude: [tackler, ...missed] });
      if (helper) assists.push(helper);
    }
    const kind = pickTackleKind(rng, yac, assists.length);
    tackle = { tackler, assists, kind, missed };
    if (!outOfBounds && !safety) {
      const roll = rollFumble(rng, ctx.weather, target.rated, tackler, m.offense, m.defense, FUMBLE_PER_RECEPTION, kind);
      if (roll) {
        const spotBallOn = clamp(ctx.ballOn + yards, 0.5, 99.5);
        const returnYards = roll.lost ? Math.min(roll.returnYards, Math.round(spotBallOn)) : 0;
        fumble = { forcedBy: roll.forcedBy, recoveredBy: roll.recoveredBy, lost: roll.lost, spotBallOn, returnYards, touchdown: roll.lost && spotBallOn - returnYards <= 0 };
      }
    }
  }
  const timeElapsed = clamp(4.6 + dropback * 0.15 + Math.max(0, air) / 9 + yac / 7 + rng.gaussian(0, 0.5), 5, 8.5);
  return {
    ...res, complete: true, airYards: air, catchKind, defender: target.defender, yac, yardsAfterContact, brokenTackles, yards, tackle, outOfBounds, touchdown, safety, fumble, timeElapsed,
  };
};
