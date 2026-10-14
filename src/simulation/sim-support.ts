import { clamp, clamp01, ratingToFactor } from '@/core/math';
import type { PlayerId } from '@/core/ids';
import type { Rng } from '@/core/rng';
import { TICK_RATE } from '@/core/time';
import { POSITION_GROUP, shortName, type InjurySeverity } from '@/players/types';
import { applyFatigue, fatigueFromPlay, recoverOnField, type PlayEffort } from '@/players/fatigue';
import { rollInjury } from '@/players/injuries';
import { victoryFormationRunoffSec } from '@/ai/coaching';
import { fatigueRateMultiplier } from '@/physics/attributes';
import { athleteId } from '@/game/athlete';
import { makePenalty } from '@/game/outcome-factory';
import { HURRY_UP_RUNOFF_SEC, huddleSeconds, TEMPO_HUDDLE_SEC, TEMPO_QUARTER_SEC } from '@/game/rules/clock';
import type { PlayContext } from '@/game/play-types';
import type { AthleteId, PenaltyInfo, PlayEvent, ReviewKind, ReviewableCall } from '@/game/play-events';
import { FIELD_WIDTH, HASH_LEFT, HASH_RIGHT, MIDDLE_X } from '@/game/types';
import type { Matchups, RatedPlayer } from './matchups';
import type { PlayResolution } from './play-model';

/**
 * Shared plumbing for the outcome assemblers: athlete ids and names, the pre-snap clock, lateral spots,
 * fatigue and injury bookkeeping, penalty rolls and challengeable-call rolls.
 */
const f = ratingToFactor;

export const aid = (p: RatedPlayer): AthleteId => athleteId(p.side, p.role);
export const nameOf = (p: RatedPlayer): string => shortName(p.player);
export const tickAt = (seconds: number): number => Math.max(0, Math.round(seconds * TICK_RATE));

/** "3 yards" / "1 yard" / "no gain" / "a loss of 2". */
export const fmtYards = (n: number): string => (n > 0 ? `${n} yard${n === 1 ? '' : 's'}` : n === 0 ? 'no gain' : `a loss of ${-n}`);

/** The offense is hurrying: two-minute drill or trailing late in the game. */
export const isHurryUp = (ctx: PlayContext): boolean => {
  const lateHalf = ctx.clockRemaining <= 120 && (ctx.quarter === 2 || ctx.quarter >= 4);
  const trailingLate = ctx.quarter >= 4 && ctx.clockRemaining <= 300 && ctx.scoreDiff < 0;
  return (lateHalf && ctx.scoreDiff <= 0) || trailingLate;
};

/**
 * Typical seconds a simulated offense lets run between the whistle and the snap (capped by the ruleset's huddle
 * runoff). League quarters are compressed (8 minutes in the simulation ruleset), so simulated teams huddle at this
 * brisker tempo to reach an NFL-like ~63 offensive snaps a side, and with them NFL-like season totals.
 */
export const SIM_HUDDLE_SEC = TEMPO_HUDDLE_SEC;

/** Quarter length (seconds) SIM_HUDDLE_SEC is calibrated for. */
export const SIM_TEMPO_QUARTER_SEC = TEMPO_QUARTER_SEC;

/** Seconds a simulated offense huddles on a running clock: the shared tempo of both executors (rules/clock huddleSeconds). */
export const simHuddleSec = huddleSeconds;

/** Seconds the game clock ran between the previous whistle and this snap (0 when the clock was stopped). */
export const presnapSeconds = (ctx: PlayContext, rng: Rng): number => {
  if (ctx.clockRunning === false) return 0;
  const rs = ctx.ruleset;
  if (isHurryUp(ctx)) return clamp(Math.round(HURRY_UP_RUNOFF_SEC + rng.range(-1, 3)), 3, Math.max(3, rs.huddleRunoffSec));
  const huddle = clamp(Math.round(simHuddleSec(rs) + rng.range(-1, 2)), 1, rs.playClockSec);
  // A kneel is victory formation: the play clock is run down before the snap (the same charge as the live engine).
  return ctx.offensivePlay.type === 'kneel' && ctx.special === 'none' ? Math.max(huddle, victoryFormationRunoffSec(rs)) : huddle;
};

/** Raw lateral spot: centred for kicks, past the sideline when out of bounds, otherwise between the hashes. */
export const sampleEndBallX = (rng: Rng, o: { outOfBounds: boolean; centred: boolean }): number => {
  if (o.centred) return MIDDLE_X;
  if (o.outOfBounds) return rng.chance(0.5) ? -0.3 : FIELD_WIDTH + 0.3;
  return rng.range(HASH_LEFT, HASH_RIGHT);
};

/* ------------------------------ Fatigue ------------------------------ */

const groupOf = (p: RatedPlayer): string => POSITION_GROUP[p.position];

/** Nominal effort by assignment for a scrimmage play; the assembler tops up the players who touched the ball. */
export const baseEffort = (p: RatedPlayer, timeElapsed: number, passPlay: boolean): PlayEffort => {
  const t = Math.max(1, timeElapsed);
  switch (p.assignment.type) {
    case 'qb': return { distanceYards: 6, sprintSeconds: 0.3, contacts: 0 };
    case 'carry': return { distanceYards: 8, sprintSeconds: t * 0.5, contacts: 0 };
    case 'route': case 'chipRelease': return { distanceYards: 14 + t * 2, sprintSeconds: t * 0.6, contacts: 0 };
    case 'runBlock': case 'passBlock': case 'leadBlock': case 'longSnapper': return { distanceYards: passPlay ? 3 : 6, sprintSeconds: 0.3, contacts: 1 };
    case 'kicker': case 'holder': return { distanceYards: 3, sprintSeconds: 0, contacts: 0 };
    case 'gunner': case 'kickCoverage': return { distanceYards: 45, sprintSeconds: 4, contacts: 1 };
    case 'returner': return { distanceYards: 25, sprintSeconds: 3, contacts: 1 };
    case 'returnBlock': return { distanceYards: 20, sprintSeconds: 2, contacts: 1 };
    case 'rushGap': case 'blitz': case 'contain': return { distanceYards: 7 + t, sprintSeconds: t * 0.5, contacts: 1 };
    case 'manCover': return { distanceYards: 14 + t * 2, sprintSeconds: t * 0.6, contacts: 0 };
    case 'zone': case 'spy': case 'runFill': return { distanceYards: 10 + t * 1.5, sprintSeconds: t * 0.4, contacts: 0 };
    default: return { distanceYards: groupOf(p) === 'OL' || groupOf(p) === 'DL' ? 5 : 10, sprintSeconds: 0.5, contacts: 0 };
  }
};

/** Adds effort for players who ran with the ball / made the tackle. */
export const addEffort = (e: PlayEffort, extra: Partial<PlayEffort>): PlayEffort => ({
  distanceYards: e.distanceYards + (extra.distanceYards ?? 0),
  sprintSeconds: e.sprintSeconds + (extra.sprintSeconds ?? 0),
  contacts: e.contacts + (extra.contacts ?? 0),
});

/** Seconds of on-field recovery credited between snaps (jogging back, the huddle). */
export const ON_FIELD_REST_SEC = 10;

/**
 * Fatigue after the play for everyone on the field: the play's effort (scaled by stamina and weather) minus the
 * slow on-field recovery over the huddle. Players absent from the map get the rules' bench recovery.
 */
export const fatigueAfterPlay = (ctx: PlayContext, m: Matchups, effortOf: (p: RatedPlayer) => PlayEffort): Record<PlayerId, number> => {
  const out: Record<PlayerId, number> = {};
  const mult = fatigueRateMultiplier(ctx.weather);
  const rest = ON_FIELD_REST_SEC;
  for (const p of [...m.offense, ...m.defense]) {
    const before = ctx.fatigue[p.player.id] ?? 0;
    const after = applyFatigue(before, fatigueFromPlay(p.player.attrs, effortOf(p)) * mult);
    out[p.player.id] = recoverOnField(after, rest, p.player.attrs.stamina);
  }
  return out;
};

/* ------------------------------ Injuries ------------------------------ */

export interface InjuryReport { injuries: { playerId: PlayerId; severity: InjurySeverity }[]; events: PlayEvent[] }

/** Rolls injuries for the players who took contact (map of contact level 0..1). */
export const rollInjuries = (ctx: PlayContext, contacts: ReadonlyMap<RatedPlayer, number>, rng: Rng, tick: number): InjuryReport => {
  const report: InjuryReport = { injuries: [], events: [] };
  if (!ctx.ruleset.injuries) return report;
  for (const [p, contact] of contacts) {
    const inj = rollInjury(rng, p.player, {
      contact: clamp01(contact), fatigue: ctx.fatigue[p.player.id] ?? 0, playCount: Math.floor(ctx.playIndex / 2),
      injuriesEnabled: true, weatherSlick: ctx.weather.fieldSlick,
    });
    if (!inj) continue;
    report.injuries.push({ playerId: p.player.id, severity: inj.severity });
    report.events.push({ type: 'injury', tick, athlete: aid(p), severity: inj.severity });
  }
  return report;
};

/* ------------------------------ Penalties ------------------------------ */

const pickFouler = (rng: Rng, pool: readonly RatedPlayer[], weight: (p: RatedPlayer) => number): RatedPlayer | null =>
  pool.length ? rng.weighted(pool, pool.map((p) => Math.max(0.01, weight(p)))) : null;

/** Dead-ball foul before the snap (false start, delay of game, encroachment), or null. */
export const rollPresnapPenalty = (ctx: PlayContext, m: Matchups, rng: Rng): PenaltyInfo | null => {
  if (!ctx.ruleset.penalties) return null;
  const freq = ctx.ruleset.penaltyFrequency;
  const crowd = ctx.offense === 'away' ? ctx.crowdFactor : 0;
  const discipline = m.offense.length ? m.offense.reduce((s, p) => s + f(p.attrs.awareness), 0) / m.offense.length : 0.5;
  if (rng.chance(0.02 * freq * (1 + 0.6 * crowd) * (1.3 - discipline))) {
    const fouler = pickFouler(rng, m.offense.filter((p) => p.assignment.type !== 'qb'), (p) => 1.2 - f(p.attrs.awareness));
    return makePenalty('falseStart', { playerId: fouler?.player.id ?? null });
  }
  if (rng.chance(0.003 * freq)) return makePenalty('delayOfGame', { playerId: m.passer?.player.id ?? null });
  if (rng.chance(0.005 * freq)) {
    const fouler = pickFouler(rng, m.rushers.length ? m.rushers : m.defense, (p) => 1.2 - f(p.attrs.awareness));
    return makePenalty('encroachment', { playerId: fouler?.player.id ?? null });
  }
  return null;
};

/** Live-ball fouls for a scrimmage resolution (at most one per play; offsetting fouls are the rules' business). */
export const rollLivePenalties = (ctx: PlayContext, m: Matchups, res: PlayResolution, rng: Rng): PenaltyInfo[] => {
  if (!ctx.ruleset.penalties) return [];
  const freq = ctx.ruleset.penaltyFrequency;
  const blocker = (): PlayerId | null => pickFouler(rng, m.blockers, (p) => 1.3 - f(p.attrs.blocking))?.player.id ?? null;
  const cover = (): PlayerId | null => pickFouler(rng, m.coverageDefenders.length ? m.coverageDefenders : m.defense, (p) => 1.3 - f(p.attrs.coverage))?.player.id ?? null;
  if (rng.chance(0.008 * freq)) return [makePenalty('offsides', { playerId: pickFouler(rng, m.rushers.length ? m.rushers : m.defense, () => 1)?.player.id ?? null })];
  if (res.kind === 'run') {
    if (rng.chance(0.035 * freq * (1.3 - m.runBlocking))) return [makePenalty('holdingOffense', { playerId: blocker() })];
    if (res.tackle) {
      if (rng.chance(0.004 * freq)) return [makePenalty('facemask', { playerId: res.tackle.tackler.player.id })];
      if (rng.chance(0.003 * freq)) return [makePenalty('unnecessaryRoughness', { playerId: res.tackle.tackler.player.id })];
      if (rng.chance(0.001 * freq)) return [makePenalty('horseCollar', { playerId: res.tackle.tackler.player.id })];
    }
    return [];
  }
  if (res.kind === 'pass') {
    if (rng.chance(0.028 * freq * (1.3 - m.passProtection) + (res.pressure ? 0.02 * freq : 0))) return [makePenalty('holdingOffense', { playerId: blocker() })];
    if (res.sack && rng.chance(0.02 * freq)) return [makePenalty('roughingPasser', { playerId: res.sack.by.player.id })];
    // Roughing on a completion adds 15 to the end of the play; on an incompletion or a pick it wipes the play out.
    if (!res.sack && res.pressure && res.pressureBy && rng.chance(0.008 * freq)) return [makePenalty('roughingPasser', { playerId: res.pressureBy.player.id, enforcement: res.complete && !res.interception ? 'endOfPlay' : 'previousSpot' })];
    if (res.throwAway && res.pressure && rng.chance(0.12 * freq)) return [makePenalty('intentionalGrounding', { playerId: res.passer.player.id, spotBallOn: clamp(Math.round(ctx.ballOn - 8), 1, 99) })];
    if (res.target && !res.complete && !res.interception && res.airYards >= 8 && rng.chance(0.07 * freq * (1 + (0.5 - res.target.openness)))) {
      const defender = res.defender ?? res.target.defender;
      return [makePenalty('passInterferenceDefense', { playerId: defender?.player.id ?? cover(), spotBallOn: clamp(Math.round(ctx.ballOn + res.airYards), 1, 99) })];
    }
    if (res.target && res.airYards >= 10 && rng.chance(0.006 * freq)) return [makePenalty('passInterferenceOffense', { playerId: res.target.rated.player.id })];
    if (res.target && rng.chance(0.012 * freq)) return [makePenalty('holdingDefense', { playerId: cover() })];
    if (res.target && res.airYards >= 5 && rng.chance(0.005 * freq)) return [makePenalty('illegalContact', { playerId: cover() })];
    if (res.tackle && rng.chance(0.004 * freq)) return [makePenalty('facemask', { playerId: res.tackle.tackler.player.id })];
    if (res.tackle && rng.chance(0.003 * freq)) return [makePenalty('unnecessaryRoughness', { playerId: res.tackle.tackler.player.id })];
  }
  return [];
};

/**
 * Block in the back / holding on a kick return, or null. The return team is the ctx 'defense', so the 10-yard
 * holding foul is reported as `holdingOffense` on side 'defense'. Both are return fouls (rules/penalties.ts applyReturnFouls):
 * the kick stands and the receivers are walked back 10 yards; with no foul spot (null) from the end of the run.
 */
export const rollReturnPenalty = (ctx: PlayContext, m: Matchups, rng: Rng): PenaltyInfo | null => {
  if (!ctx.ruleset.penalties) return null;
  const freq = ctx.ruleset.penaltyFrequency;
  const blockers = m.defense.filter((d) => d.assignment.type === 'returnBlock');
  if (rng.chance(0.035 * freq)) {
    const fouler = pickFouler(rng, blockers.length ? blockers : m.defense, (p) => 1.3 - f(p.attrs.awareness));
    return makePenalty('illegalBlockInBack', { side: 'defense', playerId: fouler?.player.id ?? null, enforcement: 'spotOfFoul', spotBallOn: null });
  }
  if (rng.chance(0.012 * freq)) {
    const fouler = pickFouler(rng, blockers.length ? blockers : m.defense, (p) => 1.3 - f(p.attrs.blocking));
    return makePenalty('holdingOffense', { side: 'defense', playerId: fouler?.player.id ?? null, enforcement: 'spotOfFoul', spotBallOn: null });
  }
  return null;
};

/* ------------------------------ Reviews ------------------------------ */

/** Rolls a challengeable ruling with the given chance. */
export const rollReviewCall = (rng: Rng, p: number, kind: ReviewKind, athlete: AthleteId | null, tick: number): ReviewableCall | null =>
  rng.chance(p) ? { kind, tick, athleteId: athlete, confidence: clamp(rng.range(0.45, 0.92), 0, 1) } : null;
