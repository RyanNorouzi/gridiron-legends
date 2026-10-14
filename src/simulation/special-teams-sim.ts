import { clamp, ratingToFactor } from '@/core/math';
import type { PlayerId } from '@/core/ids';
import type { PlayEffort } from '@/players/fatigue';
import { aiKickMeter, fieldGoalResult, kickoffDistance, onsideDistance, puntDistance, SHANK_ACCURACY, WIND_RANGE_PER_MPH, windComponents } from '@/physics/kick';
import { fieldGoalDistance } from '@/playbook/special-teams';
import { delta } from '@/statistics/apply';
import { playEpa } from '@/statistics/epa';
import type { PlayStatDelta } from '@/statistics/types';
import { emptyOutcome } from '@/game/outcome-factory';
import type { PlayContext, PlayOutcome } from '@/game/play-types';
import type { DeadReason, KickKind, PenaltyInfo, PlayEvent } from '@/game/play-events';
import { PUNT_TOUCHBACK_YARD_LINE } from '@/game/rules/possession';
import { MIDDLE_X } from '@/game/types';
import { returnerScore, type Matchups, type RatedPlayer } from './matchups';
import { lognormal, pickBy, roundYards } from './sim-random';
import { addEffort, aid, baseEffort, fatigueAfterPlay, nameOf, presnapSeconds, rollInjuries, rollReturnPenalty, sampleEndBallX, tickAt, type InjuryReport } from './sim-support';

/**
 * Special-teams simulation: kickoffs (deep, squib, onside), punts (standard, pooch, shanks, blocks) and
 * placement kicks (field goals, extra points) via the shared physics helpers. On kick plays the KICKING
 * team is the offense; `turnover: true` means the kicking team kept or regained the ball.
 */
const f = ratingToFactor;

/** Gross punt yards relative to the physics carry (a full-effort still-air flight): fielded short of the landing arc. */
export const PUNT_GROSS_SCALE = 0.88;

interface KickBits {
  presnap: number;
  fatigueAfter: Record<PlayerId, number>;
  injuries: InjuryReport;
  penalties: PenaltyInfo[];
}

const kickerOf = (m: Matchups): RatedPlayer => {
  const k = m.kicker ?? m.offense[0];
  if (!k) throw new Error('special-teams-sim: the kicking team has no players on the field');
  return k;
};

const returnerOf = (m: Matchups): RatedPlayer => {
  const r = m.returner ?? m.defense[0];
  if (!r) throw new Error('special-teams-sim: the receiving team has no players on the field');
  return r;
};

const coverageUnit = (m: Matchups): RatedPlayer[] => {
  const unit = m.offense.filter((p) => p.assignment.type === 'kickCoverage' || p.assignment.type === 'gunner');
  return unit.length ? unit : m.offense.filter((p) => p.assignment.type !== 'kicker');
};

const pickCoverageTackler = (ctx: PlayContext, m: Matchups): RatedPlayer | null =>
  pickBy(ctx.rng, coverageUnit(m), (p) => 0.3 + f(p.attrs.speed) + f(p.attrs.pursuit) + f(p.attrs.tackling) + (p.assignment.type === 'gunner' ? 0.6 : 0));

const kickEvent = (k: RatedPlayer, kind: KickKind, meter: { power: number; accuracy: number }, tick: number): PlayEvent =>
  ({ type: 'kick', tick, kicker: aid(k), kind, power: meter.power, accuracy: meter.accuracy });

const snapsFor = (m: Matchups): PlayStatDelta[] => [...m.offense, ...m.defense].map((p) => delta(p.player.id, 'snaps'));

/** Kickoffs start with a stopped clock, so like the live engine they never report pre-snap seconds. */
const bitsFor = (ctx: PlayContext, m: Matchups, contacts: ReadonlyMap<RatedPlayer, number>, effortOf: (p: RatedPlayer) => PlayEffort, tick: number, returned: boolean): KickBits => ({
  presnap: ctx.special === 'kickoff' || ctx.special === 'onside' ? 0 : presnapSeconds(ctx, ctx.rng),
  fatigueAfter: fatigueAfterPlay(ctx, m, effortOf),
  injuries: rollInjuries(ctx, contacts, ctx.rng, tick),
  penalties: returned ? [rollReturnPenalty(ctx, m, ctx.rng)].filter((p): p is PenaltyInfo => p !== null) : [],
});

const returnContacts = (m: Matchups, returner: RatedPlayer, tackler: RatedPlayer | null): Map<RatedPlayer, number> => {
  const out = new Map<RatedPlayer, number>();
  for (const p of [...m.offense, ...m.defense]) out.set(p, p.assignment.type === 'kicker' || p.assignment.type === 'holder' ? 0.05 : 0.5);
  out.set(returner, 0.8);
  if (tackler) out.set(tackler, 0.7);
  return out;
};

const quietContacts = (m: Matchups): Map<RatedPlayer, number> => new Map([...m.offense, ...m.defense].map((p) => [p, 0.1] as const));

const tail = (bits: KickBits, tick: number, reason: DeadReason): PlayEvent[] => [
  ...bits.penalties.map((penalty) => ({ type: 'penalty', tick, penalty }) as const),
  ...bits.injuries.events,
  { type: 'whistle', tick, reason },
];

/** Kick-play EPA: the kicking team "turns the ball over" where the receiving team takes over (touchbacks come out to the 20). */
const kickEpa = (ctx: PlayContext, endBallOn: number, keptByKicker: boolean, touchdown: boolean): number =>
  ctx.special === 'kickoff' || ctx.special === 'onside'
    ? 0
    : playEpa({
      down: ctx.down, distance: ctx.distance, ballOn: ctx.ballOn, endBallOn: !keptByKicker && endBallOn >= 100 ? 100 - PUNT_TOUCHBACK_YARD_LINE : endBallOn,
      turnover: !keptByKicker, touchdown, safety: false, points: 0, firstDown: false,
    });

/* ------------------------------ Kickoffs ------------------------------ */

interface ReturnModel { median: number; sigma: number; breakaway: number; breakawayMedian: number }

const runReturn = (ctx: PlayContext, start: number, model: ReturnModel): { ret: number; end: number; touchdown: boolean } => {
  const rng = ctx.rng;
  let ret = Math.round(rng.chance(model.breakaway) ? lognormal(rng, model.breakawayMedian, 0.35) : lognormal(rng, Math.max(2, model.median), model.sigma));
  ret = Math.min(ret, Math.round(start));
  const end = start - ret;
  return { ret, end: Math.max(0, end), touchdown: end <= 0 };
};

const kickoffOutcome = (ctx: PlayContext, m: Matchups, onside: boolean): PlayOutcome => {
  const rng = ctx.rng;
  const k = kickerOf(m);
  const meter = aiKickMeter(k.attrs.kickPower, k.attrs.kickAccuracy, rng);
  const b = ctx.ballOn;
  const wind = windComponents(ctx.weather, { x: 0, y: ctx.direction });
  const kind: KickKind = onside ? 'onside' : 'kickoff';
  const ev: PlayEvent[] = [kickEvent(k, kind, meter, tickAt(1))];
  const base = { result: (onside ? 'onside' : 'kickoff') as PlayOutcome['result'], endBallX: MIDDLE_X, kickMade: null, passerId: null, receiverId: null, epa: 0 };
  const effortOf = (p: RatedPlayer): PlayEffort => baseEffort(p, 6, false);

  if (onside) {
    const dist = clamp(Math.round(onsideDistance(meter.power) + rng.gaussian(0, 1.5)), 6, 22);
    const spotBallOn = clamp(b + dist, 1, 99);
    const hands = m.defense.filter((d) => d.assignment.type === 'returner' || d.assignment.type === 'returnBlock');
    const handsQuality = hands.length ? hands.reduce((s, d) => s + f(d.attrs.hands), 0) / hands.length : 0.5;
    const pRecover = dist < 10 ? 0 : clamp(0.15 + 0.15 * (m.kickCoverage - 0.5) - 0.12 * (handsQuality - 0.5), 0.03, 0.4);
    const kickingRecovers = rng.chance(pRecover);
    const recoverer = kickingRecovers
      ? (pickBy(rng, coverageUnit(m), (p) => 0.3 + f(p.attrs.hands) + f(p.attrs.reaction)) ?? k)
      : (pickBy(rng, hands.length ? hands : m.defense, (d) => 0.3 + f(d.attrs.hands) + f(d.attrs.reaction)) ?? returnerOf(m));
    const endBallOn = kickingRecovers ? spotBallOn : clamp(spotBallOn - rng.int(0, 3), 1, 99);
    const tick = tickAt(3);
    ev.push({ type: 'onsideRecovery', tick, by: aid(recoverer), side: kickingRecovers ? 'offense' : 'defense' });
    const contacts = new Map<RatedPlayer, number>([...m.offense, ...m.defense].map((p) => [p, p.assignment.type === 'kicker' ? 0.05 : 0.5] as const));
    const bits = bitsFor(ctx, m, contacts, effortOf, tick, false);
    ev.push(...tail(bits, tick, 'onsideRecovered'));
    return emptyOutcome({
      ...base, yards: 0, endBallOn, turnover: kickingRecovers, turnoverType: kickingRecovers ? 'onside' : null, timeElapsed: 3, presnapElapsed: bits.presnap,
      kickDistance: dist, returnYards: 0, ballCarrierId: recoverer.player.id, events: ev, penalties: bits.penalties,
      stats: [...snapsFor(m), delta(k.player.id, 'kicking.kickoffs'), ...(kickingRecovers ? [delta(recoverer.player.id, 'defense.fumbleRecoveries')] : [])],
      playByPlay: [`${nameOf(k)} onside kick, ${dist} yards, recovered by ${nameOf(recoverer)} (${kickingRecovers ? 'kicking team' : 'receiving team'}).`],
      injuries: bits.injuries.injuries, fatigueAfter: bits.fatigueAfter, success: kickingRecovers,
    }, ctx.offense);
  }

  const squib = ctx.offensivePlay.tags.includes('squib');
  let dist = kickoffDistance(k.attrs.kickPower, meter.power) + wind.along * WIND_RANGE_PER_MPH + rng.gaussian(0, 2);
  if (squib) dist *= rng.range(0.55, 0.7);
  dist = Math.round(clamp(dist, 20, 80));
  const landing = b + dist;
  const returner = returnerOf(m);

  if (!squib && meter.accuracy < 0.25 && rng.chance(0.5)) {
    const tick = tickAt(4);
    const bits = bitsFor(ctx, m, quietContacts(m), effortOf, tick, false);
    ev.push({ type: 'outOfBounds', tick, athlete: null, ballOn: 60 }, ...tail(bits, tick, 'outOfBounds'));
    return emptyOutcome({
      ...base, yards: 0, endBallOn: 60, timeElapsed: 0, presnapElapsed: bits.presnap, kickDistance: dist, returnYards: 0, outOfBounds: true, events: ev,
      stats: [...snapsFor(m), delta(k.player.id, 'kicking.kickoffs')], playByPlay: [`${nameOf(k)} kicks off out of bounds; the receiving team takes over at the 40.`],
      injuries: bits.injuries.injuries, fatigueAfter: bits.fatigueAfter, penalties: bits.penalties,
    }, ctx.offense);
  }
  const touchback = (): PlayOutcome => {
    const tick = tickAt(4);
    const bits = bitsFor(ctx, m, quietContacts(m), effortOf, tick, false);
    ev.push({ type: 'touchback', tick }, ...tail(bits, tick, 'touchback'));
    return emptyOutcome({
      ...base, yards: 0, endBallOn: 100, timeElapsed: 0, presnapElapsed: bits.presnap, kickDistance: dist, returnYards: 0, events: ev,
      stats: [...snapsFor(m), delta(k.player.id, 'kicking.kickoffs'), delta(k.player.id, 'kicking.touchbacks')],
      playByPlay: [`${nameOf(k)} kicks off ${dist} yards into the end zone, touchback.`], injuries: bits.injuries.injuries, fatigueAfter: bits.fatigueAfter, penalties: bits.penalties,
    }, ctx.offense);
  };
  if (landing >= 100 && rng.chance(clamp(0.35 + 0.12 * (landing - 100), 0.35, 0.95))) return touchback();

  // Return (a returner who never gets out of his end zone kneels it: touchback).
  const median = 21 + 10 * (returnerScore(returner) - 0.5) - 8 * (m.kickCoverage - 0.5) + 6 * (m.returnBlocking - 0.5) + (landing >= 100 ? 2 : 0) + (squib ? -8 : 0);
  const r = runReturn(ctx, landing, { median, sigma: 0.4, breakaway: 0.03, breakawayMedian: 60 });
  if (landing >= 100 && r.end >= 100) return touchback();
  const tackler = r.touchdown ? null : pickCoverageTackler(ctx, m);
  const muffed = rng.chance(0.012 * (1.5 - f(returner.attrs.hands)));
  const kickingRecovers = muffed && rng.chance(0.45);
  const timeElapsed = clamp(4 + r.ret / 7 + rng.gaussian(0, 0.5), 4, 12);
  const tick = tickAt(timeElapsed);
  const bits = bitsFor(ctx, m, returnContacts(m, returner, tackler), (p) => (p === returner ? addEffort(effortOf(p), { distanceYards: r.ret }) : effortOf(p)), tick, !muffed);
  const stats: PlayStatDelta[] = [...snapsFor(m), delta(k.player.id, 'kicking.kickoffs')];
  const pbp: string[] = [];
  let endBallOn: number;
  let returnYards = 0;
  let touchdown = false;
  let reason: DeadReason = 'tackle';
  if (muffed) {
    const recoverer = kickingRecovers ? (pickCoverageTackler(ctx, m) ?? k) : returner;
    endBallOn = clamp(Math.round(landing), 1, 99);
    ev.push({ type: 'muff', tick: tickAt(3.5), by: aid(returner) }, { type: 'recovery', tick, by: aid(recoverer), side: kickingRecovers ? 'offense' : 'defense', ballOn: endBallOn, advanced: false });
    stats.push(delta(returner.player.id, 'fumbles'), delta(returner.player.id, 'returns.kickReturns'));
    if (kickingRecovers) stats.push(delta(returner.player.id, 'fumblesLost'), delta(recoverer.player.id, 'defense.fumbleRecoveries'));
    pbp.push(`${nameOf(returner)} muffs the kickoff, recovered by ${nameOf(recoverer)} (${kickingRecovers ? 'kicking team' : 'receiving team'}).`);
    reason = 'fumbleRecovered';
    ev.push(...tail(bits, tick, reason));
    return emptyOutcome({
      ...base, yards: 0, endBallOn, turnover: kickingRecovers, turnoverType: kickingRecovers ? 'fumble' : null, timeElapsed, presnapElapsed: bits.presnap, kickDistance: dist,
      returnYards: 0, ballCarrierId: recoverer.player.id, events: ev, stats, playByPlay: pbp, injuries: bits.injuries.injuries, fatigueAfter: bits.fatigueAfter, penalties: bits.penalties,
    }, ctx.offense);
  }
  returnYards = r.ret;
  endBallOn = r.touchdown ? 0 : clamp(r.end, 0.5, 99.5);
  touchdown = r.touchdown;
  stats.push(delta(returner.player.id, 'returns.kickReturns'), delta(returner.player.id, 'returns.kickReturnYards', r.ret), delta(returner.player.id, 'returns.longest', r.ret));
  if (touchdown) { stats.push(delta(returner.player.id, 'returns.returnTouchdowns')); ev.push({ type: 'touchdown', tick, scorer: aid(returner), side: 'defense' }); reason = 'touchdown'; }
  else if (tackler) { stats.push(delta(tackler.player.id, 'defense.tackles'), delta(tackler.player.id, 'defense.soloTackles')); ev.push({ type: 'tackle', tick, tackler: aid(tackler), carrier: aid(returner), kind: 'wrap', assists: [] }); }
  ev.push(...tail(bits, tick, reason));
  pbp.push(`${nameOf(k)} kicks off ${dist} yards${squib ? ' (squib)' : ''}. ${nameOf(returner)} returns it ${r.ret} yards${touchdown ? ' for a TOUCHDOWN!' : tackler ? ` (tackled by ${nameOf(tackler)}).` : '.'}`);
  return emptyOutcome({
    ...base, yards: 0, endBallOn, touchdown, timeElapsed, presnapElapsed: bits.presnap, kickDistance: dist, returnYards, ballCarrierId: returner.player.id,
    tacklerIds: tackler ? [tackler.player.id] : [], events: ev, stats, playByPlay: pbp, bigPlay: r.ret >= 40, injuries: bits.injuries.injuries, fatigueAfter: bits.fatigueAfter, penalties: bits.penalties,
  }, ctx.offense);
};

/* ------------------------------ Punts ------------------------------ */

const puntOutcome = (ctx: PlayContext, m: Matchups): PlayOutcome => {
  const rng = ctx.rng;
  const p = kickerOf(m);
  const meter = aiKickMeter(p.attrs.kickPower, p.attrs.kickAccuracy, rng);
  const b = ctx.ballOn;
  const wind = windComponents(ctx.weather, { x: 0, y: ctx.direction });
  const pooch = ctx.offensivePlay.tags.includes('pooch') || b >= 55;
  const returner = returnerOf(m);
  const ev: PlayEvent[] = [{ type: 'snap', tick: 0 }];
  const base = { result: 'punt' as const, yards: 0, kickMade: null, passerId: null, receiverId: null };
  const effortOf = (p2: RatedPlayer): PlayEffort => baseEffort(p2, 6, false);
  const stats: PlayStatDelta[] = [...snapsFor(m), delta(p.player.id, 'kicking.punts')];
  const finish = (o: { endBallOn: number; returnYards: number; timeElapsed: number; kickDistance: number; bits: KickBits; extra: Partial<PlayOutcome>; keptByKicker: boolean; touchdown: boolean; pbp: string[] }): PlayOutcome => {
    const inside20 = !o.keptByKicker && o.endBallOn < 100 && 100 - o.endBallOn <= 20;
    if (inside20) stats.push(delta(p.player.id, 'kicking.puntsInside20'));
    stats.push(delta(p.player.id, 'kicking.puntYards', o.kickDistance), delta(p.player.id, 'kicking.puntLong', o.kickDistance));
    return emptyOutcome({
      ...base, endBallOn: o.endBallOn, endBallX: sampleEndBallX(rng, { outOfBounds: o.extra.outOfBounds === true, centred: false }), timeElapsed: o.timeElapsed, presnapElapsed: o.bits.presnap,
      kickDistance: o.kickDistance, returnYards: o.returnYards, events: ev, stats, playByPlay: o.pbp, injuries: o.bits.injuries.injuries, fatigueAfter: o.bits.fatigueAfter,
      penalties: o.bits.penalties, touchdown: o.touchdown, epa: kickEpa(ctx, o.endBallOn, o.keptByKicker, o.touchdown), ...o.extra,
    }, ctx.offense);
  };

  // Block.
  const blockUnit = ctx.defensivePlay.blitz === 'allOut' || ctx.defensivePlay.tags.includes('block');
  if (rng.chance(0.006 * (blockUnit ? 3 : 1) * (1.4 - m.passProtection))) {
    const blocker = pickBy(rng, m.defense.filter((d) => d.assignment.type !== 'returner'), (d) => 0.3 + f(d.attrs.speed) + f(d.attrs.passRush)) ?? returner;
    const recoverer = pickBy(rng, m.defense, (d) => 0.3 + f(d.attrs.reaction)) ?? blocker;
    const endBallOn = clamp(Math.round(b - 8 + rng.gaussian(0, 4)), 1, 99);
    const tick = tickAt(3.5);
    const bits = bitsFor(ctx, m, returnContacts(m, blocker, null), effortOf, tick, false);
    ev.push({ type: 'kickBlocked', tick: tickAt(1.6), by: aid(blocker) }, { type: 'recovery', tick, by: aid(recoverer), side: 'defense', ballOn: endBallOn, advanced: false }, ...tail(bits, tick, 'blockedKick'));
    return finish({ endBallOn, returnYards: 0, timeElapsed: 3.5, kickDistance: 0, bits, keptByKicker: false, touchdown: false, extra: { ballCarrierId: recoverer.player.id }, pbp: [`${nameOf(p)}'s punt is BLOCKED by ${nameOf(blocker)}, recovered by ${nameOf(recoverer)}.`] });
  }

  const shank = meter.accuracy < SHANK_ACCURACY;
  let dist = pooch ? 100 - b - 8 + rng.gaussian(0, 5) : puntDistance(p.attrs.kickPower, meter.power) * PUNT_GROSS_SCALE + wind.along * 0.25 + rng.gaussian(0, 2.5);
  if (shank) dist *= 0.55;
  dist = Math.round(clamp(dist, 10, 75));
  const landing = b + dist;
  ev.push(kickEvent(p, 'punt', meter, tickAt(1.3)));

  if (landing >= 100) {
    const tick = tickAt(5);
    const bits = bitsFor(ctx, m, quietContacts(m), effortOf, tick, false);
    if (rng.chance(0.75)) {
      ev.push({ type: 'touchback', tick }, ...tail(bits, tick, 'touchback'));
      stats.push(delta(p.player.id, 'kicking.touchbacks'));
      return finish({ endBallOn: 100, returnYards: 0, timeElapsed: 5, kickDistance: roundYards(100 - b), bits, keptByKicker: false, touchdown: false, extra: {}, pbp: [`${nameOf(p)} punts ${roundYards(100 - b)} yards into the end zone, touchback.`] });
    }
    const downer = pickCoverageTackler(ctx, m) ?? p;
    const endBallOn = 100 - rng.int(1, 4);
    ev.push({ type: 'downed', tick, by: aid(downer), ballOn: endBallOn }, ...tail(bits, tick, 'kickDowned'));
    return finish({ endBallOn, returnYards: 0, timeElapsed: 5, kickDistance: roundYards(endBallOn - b), bits, keptByKicker: false, touchdown: false, extra: {}, pbp: [`${nameOf(p)} punts ${roundYards(endBallOn - b)} yards, downed at the ${roundYards(100 - endBallOn)} by ${nameOf(downer)}.`] });
  }
  if (rng.chance(shank ? 0.6 : 0.09)) {
    const tick = tickAt(4.5);
    const bits = bitsFor(ctx, m, quietContacts(m), effortOf, tick, false);
    const endBallOn = clamp(landing, 1, 99);
    ev.push({ type: 'outOfBounds', tick, athlete: null, ballOn: endBallOn }, ...tail(bits, tick, 'outOfBounds'));
    return finish({ endBallOn, returnYards: 0, timeElapsed: 4.5, kickDistance: dist, bits, keptByKicker: false, touchdown: false, extra: { outOfBounds: true }, pbp: [`${nameOf(p)} punts ${dist} yards${shank ? ' (shanked)' : ''}, out of bounds at the ${roundYards(100 - endBallOn)}.`] });
  }
  const pFairCatch = clamp(0.32 + 0.35 * (m.kickCoverage - 0.5) + (landing >= 85 ? 0.15 : 0) + (pooch ? 0.2 : 0), 0.05, 0.85);
  if (rng.chance(pFairCatch)) {
    const tick = tickAt(5);
    const bits = bitsFor(ctx, m, quietContacts(m), effortOf, tick, false);
    ev.push({ type: 'fairCatch', tick, by: aid(returner) }, ...tail(bits, tick, 'fairCatch'));
    stats.push(delta(returner.player.id, 'returns.puntReturns'));
    return finish({ endBallOn: landing, returnYards: 0, timeElapsed: 5, kickDistance: dist, bits, keptByKicker: false, touchdown: false, extra: {}, pbp: [`${nameOf(p)} punts ${dist} yards, fair catch by ${nameOf(returner)} at the ${roundYards(100 - landing)}.`] });
  }
  if (rng.chance(landing >= 85 ? 0.35 : 0.06)) {
    const tick = tickAt(5.5);
    const bits = bitsFor(ctx, m, quietContacts(m), effortOf, tick, false);
    const downer = pickCoverageTackler(ctx, m) ?? p;
    const endBallOn = clamp(landing + rng.int(0, 6), 1, 99);
    ev.push({ type: 'downed', tick, by: aid(downer), ballOn: endBallOn }, ...tail(bits, tick, 'kickDowned'));
    return finish({ endBallOn, returnYards: 0, timeElapsed: 5.5, kickDistance: roundYards(endBallOn - b), bits, keptByKicker: false, touchdown: false, extra: {}, pbp: [`${nameOf(p)} punts ${roundYards(endBallOn - b)} yards, downed by ${nameOf(downer)} at the ${roundYards(100 - endBallOn)}.`] });
  }
  // Muff or return.
  const muffed = rng.chance(0.02 * (1.5 - f(returner.attrs.hands)));
  if (muffed) {
    const kickingRecovers = rng.chance(0.5);
    const recoverer = kickingRecovers ? (pickCoverageTackler(ctx, m) ?? p) : returner;
    const endBallOn = clamp(landing, 1, 99);
    const tick = tickAt(5.5);
    const bits = bitsFor(ctx, m, returnContacts(m, returner, null), effortOf, tick, false);
    ev.push({ type: 'muff', tick: tickAt(4.5), by: aid(returner) }, { type: 'recovery', tick, by: aid(recoverer), side: kickingRecovers ? 'offense' : 'defense', ballOn: endBallOn, advanced: false }, ...tail(bits, tick, 'fumbleRecovered'));
    stats.push(delta(returner.player.id, 'fumbles'), delta(returner.player.id, 'returns.puntReturns'));
    if (kickingRecovers) stats.push(delta(returner.player.id, 'fumblesLost'), delta(recoverer.player.id, 'defense.fumbleRecoveries'));
    return finish({ endBallOn, returnYards: 0, timeElapsed: 5.5, kickDistance: dist, bits, keptByKicker: kickingRecovers, touchdown: false, extra: { turnover: kickingRecovers, turnoverType: kickingRecovers ? 'fumble' : null, ballCarrierId: recoverer.player.id }, pbp: [`${nameOf(returner)} muffs the punt, recovered by ${nameOf(recoverer)} (${kickingRecovers ? 'kicking team' : 'receiving team'}).`] });
  }
  const median = 8 + 8 * (returnerScore(returner) - 0.5) - 6 * (m.kickCoverage - 0.5) + 4 * (m.returnBlocking - 0.5);
  const r = runReturn(ctx, landing, { median, sigma: 0.75, breakaway: 0.02, breakawayMedian: 48 });
  const tackler = r.touchdown ? null : pickCoverageTackler(ctx, m);
  const timeElapsed = clamp(5 + r.ret / 7 + rng.gaussian(0, 0.5), 5, 12);
  const tick = tickAt(timeElapsed);
  const bits = bitsFor(ctx, m, returnContacts(m, returner, tackler), (q) => (q === returner ? addEffort(effortOf(q), { distanceYards: r.ret }) : effortOf(q)), tick, true);
  stats.push(delta(returner.player.id, 'returns.puntReturns'), delta(returner.player.id, 'returns.puntReturnYards', r.ret), delta(returner.player.id, 'returns.longest', r.ret));
  let reason: DeadReason = 'tackle';
  if (r.touchdown) { stats.push(delta(returner.player.id, 'returns.returnTouchdowns')); ev.push({ type: 'touchdown', tick, scorer: aid(returner), side: 'defense' }); reason = 'touchdown'; }
  else if (tackler) { stats.push(delta(tackler.player.id, 'defense.tackles'), delta(tackler.player.id, 'defense.soloTackles')); ev.push({ type: 'tackle', tick, tackler: aid(tackler), carrier: aid(returner), kind: 'wrap', assists: [] }); }
  ev.push(...tail(bits, tick, reason));
  const endBallOn = r.touchdown ? 0 : clamp(r.end, 0.5, 99.5);
  return finish({
    endBallOn, returnYards: r.ret, timeElapsed, kickDistance: dist, bits, keptByKicker: false, touchdown: r.touchdown,
    extra: { ballCarrierId: returner.player.id, tacklerIds: tackler ? [tackler.player.id] : [], bigPlay: r.ret >= 30 },
    pbp: [`${nameOf(p)} punts ${dist} yards. ${nameOf(returner)} returns it ${r.ret} yards${r.touchdown ? ' for a TOUCHDOWN!' : tackler ? ` (tackled by ${nameOf(tackler)}).` : '.'}`],
  });
};

/* ------------------------------ Field goals / extra points ------------------------------ */

const placeKickOutcome = (ctx: PlayContext, m: Matchups): PlayOutcome => {
  const rng = ctx.rng;
  const k = kickerOf(m);
  const xp = ctx.special === 'extraPoint';
  const kind: KickKind = xp ? 'extraPoint' : 'fieldGoal';
  const distance = Math.round(fieldGoalDistance(ctx.ballOn));
  const meter = aiKickMeter(k.attrs.kickPower, k.attrs.kickAccuracy, rng);
  const wind = windComponents(ctx.weather, { x: 0, y: ctx.direction });
  const ev: PlayEvent[] = [{ type: 'snap', tick: 0 }];
  const stats: PlayStatDelta[] = [...snapsFor(m), delta(k.player.id, xp ? 'kicking.xpAttempts' : 'kicking.fgAttempts')];
  const timeElapsed = clamp(3.5 + rng.gaussian(0, 0.4), 3, 5);
  const tick = tickAt(timeElapsed);
  const bits = bitsFor(ctx, m, quietContacts(m), (p) => baseEffort(p, 3, true), tick, false);
  const edge = ctx.defensivePlay.tags.includes('edge');
  const blocked = rng.chance((xp ? 0.006 : 0.012) * (edge ? 2 : 1) * (1.4 - m.passProtection));
  let made = false;
  let label: string;
  if (blocked) {
    const blocker = pickBy(rng, m.defense, (d) => 0.3 + f(d.attrs.jumping) + f(d.attrs.passRush)) ?? (m.defense[0] as RatedPlayer);
    ev.push({ type: 'kickBlocked', tick: tickAt(1.5), by: aid(blocker) }, { type: 'kickResult', tick, kind, made: false, distance });
    label = `BLOCKED by ${nameOf(blocker)}`;
  } else {
    const res = fieldGoalResult(distance, meter.power, meter.accuracy, k.attrs.kickPower, k.attrs.kickAccuracy, wind, { hookSign: rng.chance(0.5) ? 1 : -1 });
    made = res.made;
    ev.push(kickEvent(k, kind, meter, tickAt(1.3)), { type: 'kickResult', tick, kind, made, distance });
    label = made ? 'GOOD' : `NO GOOD (${res.missReason === 'short' ? 'short' : res.missReason === 'wideLeft' ? 'wide left' : 'wide right'})`;
  }
  ev.push(...tail(bits, tick, blocked ? 'blockedKick' : made ? 'kickMade' : 'kickMissed'));
  if (made) stats.push(delta(k.player.id, xp ? 'kicking.xpMade' : 'kicking.fgMade'));
  if (made && !xp) stats.push(delta(k.player.id, 'kicking.fgLong', distance));
  const epa = xp ? 0 : made
    ? playEpa({ down: ctx.down, distance: ctx.distance, ballOn: ctx.ballOn, endBallOn: ctx.ballOn, turnover: false, touchdown: false, safety: false, points: 3, firstDown: false })
    : playEpa({ down: ctx.down, distance: ctx.distance, ballOn: ctx.ballOn, endBallOn: Math.max(1, ctx.ballOn - 7), turnover: true, touchdown: false, safety: false, points: 0, firstDown: false });
  return emptyOutcome({
    result: kind, yards: 0, endBallOn: ctx.ballOn, endBallX: MIDDLE_X, kickMade: made, kickDistance: distance, timeElapsed, presnapElapsed: bits.presnap,
    ballCarrierId: m.holder?.player.id ?? null, passerId: null, receiverId: null, events: ev, stats, penalties: bits.penalties,
    playByPlay: [`${nameOf(k)} ${distance}-yard ${xp ? 'extra point' : 'field goal'} is ${label}.`], injuries: bits.injuries.injuries, fatigueAfter: bits.fatigueAfter, epa, success: made,
  }, ctx.offense);
};

/** Resolves a live kick play (kickoff / onside / punt / field goal / extra point). Fakes never reach here. */
export const simulateSpecialTeams = (ctx: PlayContext, m: Matchups): PlayOutcome => {
  switch (ctx.special) {
    case 'kickoff': return kickoffOutcome(ctx, m, false);
    case 'onside': return kickoffOutcome(ctx, m, true);
    case 'punt': return puntOutcome(ctx, m);
    case 'fieldGoal':
    case 'extraPoint': return placeKickOutcome(ctx, m);
    default: throw new Error(`special-teams-sim: '${ctx.special}' is not a kick play`);
  }
};
