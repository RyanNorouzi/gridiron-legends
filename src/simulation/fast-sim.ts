import { clamp } from '@/core/math';
import type { PlayerId } from '@/core/ids';
import type { PlayEffort } from '@/players/fatigue';
import { isExplosive, isSuccessfulPlay, playEpa } from '@/statistics/epa';
import type { PlayStatDelta } from '@/statistics/types';
import type { FastPlayExecutor } from '@/game/engine-api';
import { assertValidOutcome, emptyOutcome } from '@/game/outcome-factory';
import { TURNOVER_TOUCHBACK_YARD_LINE } from '@/game/rules/possession';
import type { PlayContext, PlayOutcome } from '@/game/play-types';
import type { BreakMove, DeadReason, PenaltyInfo, PlayEvent } from '@/game/play-events';
import { foulLabel } from '@/game/text-labels';
import { applyGameForm, buildMatchups, type Matchups, type RatedPlayer } from './matchups';
import { isScrimmageContext, knobsFor, resolveScrimmagePlay, type ModelKnobs, type PassResolution, type PlayResolution, type RunResolution } from './play-model';
import { pickTackler, roundYards } from './sim-random';
import { simulateSpecialTeams } from './special-teams-sim';
import {
  addEffort, aid, baseEffort, fatigueAfterPlay, fmtYards, nameOf, presnapSeconds, rollInjuries, rollLivePenalties, rollPresnapPenalty,
  rollReviewCall, sampleEndBallX, tickAt, type InjuryReport,
} from './sim-support';
import { kneelDeltas, participationDeltas, passDeltas, runDeltas, spikeDeltas, type PlayBits } from './sim-stats';

/**
 * Statistical play executor. One call, one complete PlayOutcome built from lineups, plays and ratings
 * without a tick loop: the play model resolves what happened, this file describes it (events, stats,
 * play-by-play, EPA, reviews, fatigue, injuries, penalties). Deterministic given ctx.rng.
 */

/** Per-play facts every alternate (review) outcome shares with the ruled one. */
interface Shared {
  presnap: number;
  penalties: PenaltyInfo[];
  injuries: InjuryReport;
  fatigueAfter: Record<PlayerId, number>;
  endBallX: number;
}


const spot = (v: number): number => clamp(v, 0.5, 99.5);

const bitsFor = (ctx: PlayContext, o: { result: PlayOutcome['result']; yards: number; endBallOn: number; turnover: boolean; touchdown: boolean; safety: boolean; firstDown: boolean }): PlayBits => {
  if (ctx.special === 'twoPoint') {
    const converted = !o.turnover && (o.touchdown || o.endBallOn >= 100);
    return { firstDown: false, bigPlay: false, success: converted, epa: (converted ? 2 : 0) - 0.95 };
  }
  // A turnover downed in the end zone comes out to the touchback line; EPA is measured from there.
  const epaEndBallOn = o.turnover && o.endBallOn >= 100 ? 100 - TURNOVER_TOUCHBACK_YARD_LINE : o.endBallOn;
  const epa = playEpa({ down: ctx.down, distance: ctx.distance, ballOn: ctx.ballOn, endBallOn: epaEndBallOn, turnover: o.turnover, touchdown: o.touchdown, safety: o.safety, points: 0, firstDown: o.firstDown });
  return { firstDown: o.firstDown, bigPlay: !o.turnover && isExplosive(o.result, o.yards), success: !o.turnover && !o.safety && isSuccessfulPlay(ctx.down, ctx.distance, o.yards), epa };
};

const breakMoveFor = (p: RatedPlayer): BreakMove => (p.attrs.strength > p.attrs.agility ? 'truck' : p.attrs.agility > 80 ? 'juke' : 'stiffArm');

const tailEvents = (sh: Shared, tick: number, firstDown: boolean, reason: DeadReason): PlayEvent[] => [
  ...(firstDown ? [{ type: 'firstDown', tick } as const] : []),
  ...sh.penalties.map((penalty) => ({ type: 'penalty', tick, penalty }) as const),
  ...sh.injuries.events,
  { type: 'whistle', tick, reason },
];

/* ------------------------------ Runs ------------------------------ */

const assembleRun = (ctx: PlayContext, m: Matchups, res: RunResolution, sh: Shared): PlayOutcome => {
  const b = ctx.ballOn;
  const c = res.carrier;
  const fu = res.fumble;
  const lost = fu?.lost === true;
  const turnover = lost;
  const touchdown = lost ? fu.touchdown : res.touchdown;
  const endBallOn = lost ? (fu.touchdown ? 0 : spot(fu.spotBallOn - fu.returnYards)) : res.touchdown ? 100 : res.safety ? 0 : spot(b + res.yards);
  const firstDown = !turnover && !res.safety && endBallOn >= Math.min(100, b + ctx.distance) - 1e-9;
  const result = res.scramble ? 'scramble' : 'run';
  const bits = bitsFor(ctx, { result, yards: res.yards, endBallOn, turnover, touchdown, safety: res.safety, firstDown });
  const end = tickAt(res.timeElapsed);
  const ev: PlayEvent[] = [{ type: 'snap', tick: 0 }];
  if (m.passer && c !== m.passer) ev.push({ type: 'handoff', tick: tickAt(0.8), from: aid(m.passer), to: aid(c) });
  else if (res.scramble) ev.push({ type: 'scramble', tick: tickAt(2.5), qb: aid(c) });
  if (res.tackle) for (const d of res.tackle.missed) ev.push({ type: 'brokenTackle', tick: tickAt(res.timeElapsed * 0.6), carrier: aid(c), defender: aid(d), move: breakMoveFor(c) });
  if (res.slide) ev.push({ type: 'slide', tick: end, athlete: aid(c) });
  let reason: DeadReason = res.slide ? 'slide' : 'tackle';
  if (fu) {
    ev.push({ type: 'fumble', tick: Math.max(0, end - 12), carrier: aid(c), forcedBy: fu.forcedBy ? aid(fu.forcedBy) : null, ballOn: fu.spotBallOn, forward: false });
    ev.push({ type: 'recovery', tick: end, by: aid(fu.recoveredBy), side: lost ? 'defense' : 'offense', ballOn: endBallOn, advanced: fu.returnYards > 0 });
    if (fu.touchdown) ev.push({ type: 'touchdown', tick: end, scorer: aid(fu.recoveredBy), side: 'defense' });
    reason = fu.touchdown ? 'touchdown' : 'fumbleRecovered';
  } else if (res.tackle) {
    ev.push({ type: 'tackle', tick: end, tackler: aid(res.tackle.tackler), carrier: aid(c), kind: res.tackle.kind, assists: res.tackle.assists.map(aid) });
  }
  if (res.outOfBounds) { ev.push({ type: 'outOfBounds', tick: end, athlete: aid(c), ballOn: endBallOn }); reason = 'outOfBounds'; }
  if (res.touchdown && !lost) { ev.push({ type: 'touchdown', tick: end, scorer: aid(c), side: 'offense' }); reason = 'touchdown'; }
  if (res.safety) { ev.push({ type: 'safety', tick: end }); reason = 'safety'; }
  ev.push(...tailEvents(sh, end, firstDown, reason));
  const stats: PlayStatDelta[] = [...participationDeltas(m, false), ...runDeltas(res, bits)];
  const who = res.scramble ? `${nameOf(c)} scrambles` : `${nameOf(c)} ${ctx.offensivePlay.concept === 'outsideRun' ? 'runs outside' : 'runs up the middle'}`;
  const pbp = [`${who} for ${fmtYards(res.yards)}${res.tackle && !fu ? ` (tackled by ${nameOf(res.tackle.tackler)})` : ''}${res.outOfBounds ? ', out of bounds' : ''}.`];
  if (res.brokenTackles > 0) pbp.push(`${nameOf(c)} broke ${res.brokenTackles} tackle${res.brokenTackles > 1 ? 's' : ''}.`);
  if (fu) pbp.push(`${nameOf(c)} fumbles${fu.forcedBy ? ` (forced by ${nameOf(fu.forcedBy)})` : ''}, recovered by ${nameOf(fu.recoveredBy)}${lost ? fu.touchdown ? ' and returned for a touchdown!' : ` and returned ${fu.returnYards} yards.` : '.'}`);
  if (res.touchdown && !lost) pbp.push('TOUCHDOWN!');
  if (res.safety) pbp.push('SAFETY!');
  return emptyOutcome({
    result, yards: res.yards, endBallOn, endBallX: sh.endBallX, turnover, turnoverType: turnover ? 'fumble' : null, touchdown, safety: res.safety,
    outOfBounds: res.outOfBounds, incomplete: false, firstDown, timeElapsed: res.timeElapsed, presnapElapsed: sh.presnap, penalties: sh.penalties,
    returnYards: lost ? fu.returnYards : 0, ballCarrierId: lost ? fu.recoveredBy.player.id : c.player.id, passerId: res.scramble ? c.player.id : null,
    receiverId: null, tacklerIds: res.tackle ? [res.tackle.tackler, ...res.tackle.assists].map((t) => t.player.id) : [], events: ev, stats, playByPlay: pbp,
    yardsAfterContact: res.yardsAfterContact, underPressure: false, bigPlay: bits.bigPlay, injuries: sh.injuries.injuries, fatigueAfter: sh.fatigueAfter, epa: bits.epa, success: bits.success,
  }, ctx.offense);
};

/* ------------------------------ Passes ------------------------------ */

const assemblePass = (ctx: PlayContext, m: Matchups, res: PassResolution, sh: Shared): PlayOutcome => {
  const b = ctx.ballOn;
  const q = res.passer;
  const t = res.target;
  const end = tickAt(res.timeElapsed);
  const throwTick = tickAt(Math.min(res.timeElapsed - 0.5, 1.8 + (ctx.offensivePlay.dropback ?? 5) * 0.2));
  const ev: PlayEvent[] = [{ type: 'snap', tick: 0 }];
  if (res.fakeTo && (res.playAction || ctx.offensivePlay.type === 'rpo')) ev.push({ type: 'playActionFake', tick: tickAt(0.7), qb: aid(q), to: aid(res.fakeTo) });
  if (res.pressure && res.pressureBy) ev.push({ type: 'pressure', tick: tickAt(2), by: aid(res.pressureBy) });
  // Dropback and pressure narration, like the live engine's play-by-play.
  const pbp: string[] = [`${nameOf(q)} ${res.playAction ? 'fakes the handoff and ' : ''}drops back to pass.`];
  if (res.pressure && res.pressureBy) pbp.push(`Pressure coming from ${nameOf(res.pressureBy)}.`);
  const common = { presnapElapsed: sh.presnap, penalties: sh.penalties, endBallX: sh.endBallX, injuries: sh.injuries.injuries, fatigueAfter: sh.fatigueAfter, underPressure: res.pressure, passerId: q.player.id, timeElapsed: res.timeElapsed };

  if (res.sack) {
    const s = res.sack;
    const fu = res.fumble;
    const lost = fu?.lost === true;
    const endBallOn = lost ? (fu.touchdown ? 0 : spot(fu.spotBallOn - fu.returnYards)) : res.safety ? 0 : spot(b - s.yardsLost);
    const bits = bitsFor(ctx, { result: 'sack', yards: -s.yardsLost, endBallOn, turnover: lost, touchdown: lost && fu.touchdown, safety: res.safety, firstDown: false });
    ev.push({ type: 'sack', tick: end, by: aid(s.by), assists: s.assists.map(aid), yardsLost: s.yardsLost });
    let reason: DeadReason = 'sack';
    if (fu) {
      ev.push({ type: 'fumble', tick: end, carrier: aid(q), forcedBy: fu.forcedBy ? aid(fu.forcedBy) : null, ballOn: fu.spotBallOn, forward: false });
      ev.push({ type: 'recovery', tick: end + 30, by: aid(fu.recoveredBy), side: lost ? 'defense' : 'offense', ballOn: endBallOn, advanced: fu.returnYards > 0 });
      if (fu.touchdown) ev.push({ type: 'touchdown', tick: end + 30, scorer: aid(fu.recoveredBy), side: 'defense' });
      reason = fu.touchdown ? 'touchdown' : 'fumbleRecovered';
    }
    if (res.safety) { ev.push({ type: 'safety', tick: end }); reason = 'safety'; }
    ev.push(...tailEvents(sh, end + (fu ? 30 : 0), false, reason));
    pbp.push(`${nameOf(q)} sacked by ${nameOf(s.by)}${s.assists.length ? ` and ${nameOf(s.assists[0] as RatedPlayer)}` : ''} for ${fmtYards(-s.yardsLost)}.`);
    if (fu) pbp.push(`${nameOf(q)} fumbles, recovered by ${nameOf(fu.recoveredBy)}${lost ? (fu.touchdown ? ' and returned for a touchdown!' : ` and returned ${fu.returnYards} yards.`) : '.'}`);
    if (res.safety) pbp.push('SAFETY!');
    return emptyOutcome({
      ...common, result: 'sack', yards: -s.yardsLost, endBallOn, turnover: lost, turnoverType: lost ? 'fumble' : null, touchdown: lost && fu.touchdown, safety: res.safety,
      returnYards: lost ? fu.returnYards : 0, ballCarrierId: lost ? fu.recoveredBy.player.id : q.player.id, tacklerIds: [s.by, ...s.assists].map((p) => p.player.id),
      events: ev, stats: [...participationDeltas(m, true), ...passDeltas(res, bits)], playByPlay: pbp, bigPlay: false, epa: bits.epa, success: bits.success,
    }, ctx.offense);
  }

  const airYards = t ? res.airYards : 0;
  ev.push({ type: 'throw', tick: throwTick, thrower: aid(q), target: t ? aid(t.rated) : null, throwType: res.throwType, airYards, difficulty: t ? clamp(1 - t.openness, 0, 1) : 1 });

  if (res.interception && t) {
    const i = res.interception;
    const endBallOn = i.touchback ? 100 : i.touchdown ? 0 : spot(i.spotBallOn - i.returnYards);
    const bits = bitsFor(ctx, { result: 'interception', yards: 0, endBallOn, turnover: true, touchdown: i.touchdown, safety: false, firstDown: false });
    ev.push({ type: 'interception', tick: tickAt(res.timeElapsed * 0.55), defender: aid(i.by), ballOn: i.spotBallOn });
    let reason: DeadReason = 'interceptionDowned';
    if (i.touchback) { ev.push({ type: 'touchback', tick: end }); reason = 'touchback'; }
    else if (i.touchdown) { ev.push({ type: 'touchdown', tick: end, scorer: aid(i.by), side: 'defense' }); reason = 'touchdown'; }
    else if (i.tackledBy) ev.push({ type: 'tackle', tick: end, tackler: aid(i.tackledBy), carrier: aid(i.by), kind: 'wrap', assists: [] });
    ev.push(...tailEvents(sh, end, false, reason));
    pbp.push(`${nameOf(q)} pass intended for ${nameOf(t.rated)} INTERCEPTED by ${nameOf(i.by)}${i.touchback ? ' in the end zone, touchback.' : i.touchdown ? ' and returned for a touchdown!' : ` and returned ${i.returnYards} yards.`}`);
    return emptyOutcome({
      ...common, result: 'interception', yards: 0, endBallOn, turnover: true, turnoverType: 'interception', touchdown: i.touchdown, returnYards: i.returnYards,
      ballCarrierId: i.by.player.id, receiverId: t.rated.player.id, tacklerIds: i.tackledBy ? [i.tackledBy.player.id] : [], events: ev,
      stats: [...participationDeltas(m, true), ...passDeltas(res, bits)], playByPlay: pbp, airYards, separationAtThrow: res.separation, bigPlay: false, epa: bits.epa, success: false,
    }, ctx.offense);
  }

  if (!res.complete || !t) {
    const reason = res.incompleteReason ?? 'overthrown';
    const bits = bitsFor(ctx, { result: 'incomplete', yards: 0, endBallOn: b, turnover: false, touchdown: false, safety: false, firstDown: false });
    if (reason === 'batted' && res.defender) ev.push({ type: 'tipped', tick: throwTick + 5, by: aid(res.defender) });
    ev.push({ type: 'incomplete', tick: end, reason, target: t ? aid(t.rated) : null, defender: res.defender ? aid(res.defender) : null });
    ev.push(...tailEvents(sh, end, false, 'incomplete'));
    const why = reason === 'throwAway' ? 'throws it away' : reason === 'drop' ? `incomplete, dropped by ${t ? nameOf(t.rated) : 'the receiver'}` : reason === 'defended' ? `incomplete, broken up by ${res.defender ? nameOf(res.defender) : 'the defense'}` : reason === 'batted' ? 'batted down at the line' : `incomplete, ${reason} to ${t ? nameOf(t.rated) : 'the receiver'}`;
    pbp.push(`${nameOf(q)} ${why}.`);
    return emptyOutcome({
      ...common, result: 'incomplete', yards: 0, endBallOn: b, incomplete: true, receiverId: t?.rated.player.id ?? null, events: ev,
      stats: [...participationDeltas(m, true), ...passDeltas(res, bits)], playByPlay: pbp, airYards, separationAtThrow: t ? res.separation : null, epa: bits.epa, success: false,
    }, ctx.offense);
  }

  const fu = res.fumble;
  const lost = fu?.lost === true;
  const touchdown = lost ? fu.touchdown : res.touchdown;
  const endBallOn = lost ? (fu.touchdown ? 0 : spot(fu.spotBallOn - fu.returnYards)) : res.touchdown ? 100 : res.safety ? 0 : spot(b + res.yards);
  const firstDown = !lost && !res.safety && endBallOn >= Math.min(100, b + ctx.distance) - 1e-9;
  const bits = bitsFor(ctx, { result: 'pass', yards: res.yards, endBallOn, turnover: lost, touchdown, safety: res.safety, firstDown });
  const catchTick = tickAt(Math.min(res.timeElapsed - 0.2, (throwTick / 60) + Math.max(0.4, Math.abs(airYards) / 18)));
  ev.push({ type: 'catch', tick: catchTick, receiver: aid(t.rated), contested: res.contested, catchKind: res.catchKind, ballOn: spot(b + airYards) });
  if (res.tackle) for (const d of res.tackle.missed) ev.push({ type: 'brokenTackle', tick: catchTick + 20, carrier: aid(t.rated), defender: aid(d), move: breakMoveFor(t.rated) });
  let reason: DeadReason = 'tackle';
  if (fu) {
    ev.push({ type: 'fumble', tick: Math.max(catchTick, end - 12), carrier: aid(t.rated), forcedBy: fu.forcedBy ? aid(fu.forcedBy) : null, ballOn: fu.spotBallOn, forward: false });
    ev.push({ type: 'recovery', tick: end, by: aid(fu.recoveredBy), side: lost ? 'defense' : 'offense', ballOn: endBallOn, advanced: fu.returnYards > 0 });
    if (fu.touchdown) ev.push({ type: 'touchdown', tick: end, scorer: aid(fu.recoveredBy), side: 'defense' });
    reason = fu.touchdown ? 'touchdown' : 'fumbleRecovered';
  } else if (res.tackle) {
    ev.push({ type: 'tackle', tick: end, tackler: aid(res.tackle.tackler), carrier: aid(t.rated), kind: res.tackle.kind, assists: res.tackle.assists.map(aid) });
  }
  if (res.outOfBounds) { ev.push({ type: 'outOfBounds', tick: end, athlete: aid(t.rated), ballOn: endBallOn }); reason = 'outOfBounds'; }
  if (res.touchdown && !lost) { ev.push({ type: 'touchdown', tick: end, scorer: aid(t.rated), side: 'offense' }); reason = 'touchdown'; }
  if (res.safety) { ev.push({ type: 'safety', tick: end }); reason = 'safety'; }
  ev.push(...tailEvents(sh, end, firstDown, reason));
  pbp.push(`${nameOf(q)} pass complete to ${nameOf(t.rated)} for ${fmtYards(res.yards)}${res.tackle && !fu ? ` (tackled by ${nameOf(res.tackle.tackler)})` : ''}${res.outOfBounds ? ', out of bounds' : ''}.`);
  if (fu) pbp.push(`${nameOf(t.rated)} fumbles, recovered by ${nameOf(fu.recoveredBy)}${lost ? (fu.touchdown ? ' and returned for a touchdown!' : ` and returned ${fu.returnYards} yards.`) : '.'}`);
  if (res.touchdown && !lost) pbp.push('TOUCHDOWN!');
  if (res.safety) pbp.push('SAFETY!');
  return emptyOutcome({
    ...common, result: 'pass', yards: res.yards, endBallOn, turnover: lost, turnoverType: lost ? 'fumble' : null, touchdown, safety: res.safety, outOfBounds: res.outOfBounds, firstDown,
    returnYards: lost ? fu.returnYards : 0, ballCarrierId: lost ? fu.recoveredBy.player.id : t.rated.player.id, receiverId: t.rated.player.id,
    tacklerIds: res.tackle ? [res.tackle.tackler, ...res.tackle.assists].map((p) => p.player.id) : [], events: ev,
    stats: [...participationDeltas(m, true), ...passDeltas(res, bits)], playByPlay: pbp, airYards, yac: res.yac, yardsAfterContact: res.yardsAfterContact,
    separationAtThrow: res.separation, bigPlay: bits.bigPlay, epa: bits.epa, success: bits.success,
  }, ctx.offense);
};

/* ------------------------------ Kneel / spike / dead ball ------------------------------ */

/** Describes a resolution as a PlayOutcome (shared by the ruled outcome and review alternates). */
const assemble = (ctx: PlayContext, m: Matchups, res: PlayResolution, sh: Shared): PlayOutcome => {
  if (res.kind === 'kneel') {
    const endBallOn = spot(ctx.ballOn + res.yards);
    const end = tickAt(res.timeElapsed);
    const epa = playEpa({ down: ctx.down, distance: ctx.distance, ballOn: ctx.ballOn, endBallOn, turnover: false, touchdown: false, safety: false, points: 0, firstDown: false });
    return emptyOutcome({
      result: 'kneel', yards: res.yards, endBallOn, endBallX: sh.endBallX, timeElapsed: res.timeElapsed, presnapElapsed: sh.presnap, penalties: sh.penalties,
      ballCarrierId: res.passer.player.id, passerId: res.passer.player.id,
      events: [{ type: 'snap', tick: 0 }, { type: 'kneel', tick: end, athlete: aid(res.passer) }, ...tailEvents(sh, end, false, 'kneel')],
      stats: [...participationDeltas(m, false), ...kneelDeltas(res.passer, res.yards)], playByPlay: [`${nameOf(res.passer)} kneels for ${fmtYards(res.yards)}.`],
      injuries: sh.injuries.injuries, fatigueAfter: sh.fatigueAfter, epa, success: false,
    }, ctx.offense);
  }
  if (res.kind === 'spike') {
    const end = tickAt(res.timeElapsed);
    return emptyOutcome({
      result: 'spike', yards: 0, endBallOn: ctx.ballOn, endBallX: sh.endBallX, incomplete: true, timeElapsed: res.timeElapsed, presnapElapsed: sh.presnap, penalties: sh.penalties,
      passerId: res.passer.player.id, events: [{ type: 'snap', tick: 0 }, { type: 'spike', tick: end, athlete: aid(res.passer) }, ...tailEvents(sh, end, false, 'spike')],
      stats: [...participationDeltas(m, true), ...spikeDeltas(res.passer)], playByPlay: [`${nameOf(res.passer)} spikes the ball to stop the clock.`],
      injuries: sh.injuries.injuries, fatigueAfter: sh.fatigueAfter, epa: 0, success: false,
    }, ctx.offense);
  }
  return res.kind === 'run' ? assembleRun(ctx, m, res, sh) : assemblePass(ctx, m, res, sh);
};

/* ------------------------------ Contact, effort, reviews ------------------------------ */

const contactsFor = (m: Matchups, res: PlayResolution): Map<RatedPlayer, number> => {
  const out = new Map<RatedPlayer, number>();
  const set = (p: RatedPlayer | null | undefined, c: number): void => { if (p) out.set(p, Math.max(out.get(p) ?? 0, c)); };
  const passPlay = res.kind === 'pass';
  for (const p of [...m.offense, ...m.defense]) set(p, res.kind === 'kneel' || res.kind === 'spike' ? 0.05 : 0.12);
  if (res.kind === 'kneel' || res.kind === 'spike') return out;
  for (const b of m.blockers) set(b, passPlay ? 0.45 : 0.5);
  for (const r of passPlay ? m.rushers : m.runDefenders) set(r, 0.45);
  if (res.kind === 'run') {
    set(res.carrier, res.fumble ? 1 : res.slide ? 0.3 : 0.9);
    if (res.tackle) { set(res.tackle.tackler, 0.7); for (const a of res.tackle.assists) set(a, 0.6); for (const d of res.tackle.missed) set(d, 0.4); }
  } else {
    if (res.sack) { set(res.passer, 0.8); set(res.sack.by, 0.6); }
    if (res.target) set(res.target.rated, res.complete ? 0.6 : 0.3);
    if (res.tackle) { set(res.tackle.tackler, 0.6); for (const a of res.tackle.assists) set(a, 0.5); }
    if (res.interception) { set(res.interception.by, 0.5); set(res.interception.tackledBy, 0.5); }
  }
  return out;
};

const effortFor = (p: RatedPlayer, res: PlayResolution): PlayEffort => {
  const t = res.timeElapsed;
  let e = baseEffort(p, t, res.kind === 'pass' || res.kind === 'spike');
  if (res.kind === 'run') {
    if (p === res.carrier) e = addEffort(e, { distanceYards: Math.abs(res.yards) + 5, sprintSeconds: t * 0.3, contacts: (res.contact ? 1 : 0) + res.brokenTackles });
    if (res.tackle && (p === res.tackle.tackler || res.tackle.assists.includes(p))) e = addEffort(e, { distanceYards: Math.abs(res.yards), contacts: 1 });
  } else if (res.kind === 'pass') {
    if (p === res.passer && res.sack) e = addEffort(e, { contacts: 1 });
    if (res.target && p === res.target.rated) e = addEffort(e, { distanceYards: res.yac + 4, sprintSeconds: 1, contacts: res.complete && res.tackle ? 1 : 0 });
    if (res.tackle && (p === res.tackle.tackler || res.tackle.assists.includes(p))) e = addEffort(e, { distanceYards: res.yac, contacts: 1 });
    if (res.interception && p === res.interception.by) e = addEffort(e, { distanceYards: res.interception.returnYards, sprintSeconds: 2 });
  }
  return e;
};

/**
 * Rare close calls: sideline catches, goal-line scores, fumbles, first-down spots and safeties get a challengeable
 * ruling with an alternate outcome.
 */
const rollReview = (ctx: PlayContext, m: Matchups, res: PlayResolution, sh: Shared): PlayOutcome['review'] => {
  if (!ctx.ruleset.challenges || res.kind === 'kneel' || res.kind === 'spike') return null;
  const rng = ctx.rng;
  const tick = tickAt(res.timeElapsed);
  if (res.kind === 'pass' && res.complete && res.target && res.outOfBounds && res.target.sideline && !res.fumble) {
    const call = rollReviewCall(rng, 0.03, 'catch', aid(res.target.rated), tick);
    if (call) {
      const alt: PassResolution = { ...res, complete: false, incompleteReason: 'outOfBounds', yac: 0, yardsAfterContact: 0, brokenTackles: 0, yards: 0, tackle: null, outOfBounds: false, touchdown: false, safety: false, fumble: null, catchKind: 'possession' };
      return { call, ifOverturned: assemble(ctx, m, alt, sh) };
    }
  }
  if (res.fumble?.lost) {
    const call = rollReviewCall(rng, 0.05, 'fumble', aid(res.kind === 'run' ? res.carrier : res.passer), tick);
    if (call) return { call, ifOverturned: assemble(ctx, m, { ...res, fumble: null }, sh) };
  }
  if (res.touchdown && !res.fumble && !(res.kind === 'pass' && res.interception)) {
    const scorer = res.kind === 'run' ? res.carrier : res.target?.rated ?? null;
    const call = rollReviewCall(rng, 0.03, 'touchdown', scorer ? aid(scorer) : null, tick);
    if (call) {
      const short = Math.max(0, roundYards(99 - ctx.ballOn));
      const tackler = pickTackler(rng, m.defense, short) ?? (m.defense[0] as RatedPlayer);
      const tackle = { tackler, assists: [], kind: 'wrap' as const, missed: [] };
      const alt: PlayResolution = res.kind === 'run'
        ? { ...res, touchdown: false, yards: short, tackle, contact: true }
        : { ...res, touchdown: false, yards: short, airYards: Math.min(res.airYards, short), yac: Math.max(0, short - Math.min(res.airYards, short)), tackle };
      return { call, ifOverturned: assemble(ctx, m, alt, sh) };
    }
  }
  return closeSpotReview(ctx, m, res, sh, tick);
};

/** Chance a spot within a yard of the line to gain (or a runner down at his own goal line) is a genuinely close call. */
export const CLOSE_SPOT_REVIEW_CHANCE = 0.1;

/**
 * Spot-of-ball reviews: a runner or receiver stopped within a yard of the line to gain (first down or not) and a
 * carrier or sacked passer down at his own goal line (safety or not). The alternate moves the spot one yard.
 */
const closeSpotReview = (ctx: PlayContext, m: Matchups, res: PlayResolution, sh: Shared, tick: number): PlayOutcome['review'] => {
  const rng = ctx.rng;
  // A marginal spot is more often right than wrong: the same 0.55-0.95 confidence band as the live engine's spots.
  const rollSpotCall = (kind: 'firstDown' | 'spot', athlete: ReturnType<typeof aid> | null): ReturnType<typeof rollReviewCall> => {
    const call = rollReviewCall(rng, CLOSE_SPOT_REVIEW_CHANCE, kind, athlete, tick);
    if (call) call.confidence = clamp(0.55 + 0.4 * (call.confidence - 0.45) / 0.47, 0.55, 0.95);
    return call;
  };
  if (ctx.special !== 'none' || (res.kind !== 'run' && res.kind !== 'pass') || res.fumble || res.touchdown) return null;
  if (res.kind === 'pass' && res.interception) return null;
  const b = ctx.ballOn;
  if (res.safety) {
    const carrier = res.kind === 'run' ? res.carrier : res.passer;
    const call = rollSpotCall('spot', aid(carrier));
    if (!call) return null;
    // Overturned: down just outside the goal line.
    const lost = Math.max(0, Math.ceil(b) - 1);
    const alt: PlayResolution = res.kind === 'run'
      ? { ...res, safety: false, yards: -lost }
      : { ...res, safety: false, sack: res.sack ? { ...res.sack, yardsLost: lost } : null };
    return { call, ifOverturned: assemble(ctx, m, alt, sh) };
  }
  if (res.kind === 'pass' && !res.complete) return null;
  const ltg = b + ctx.distance;
  if (ltg >= 100) return null;
  const gap = spot(b + res.yards) - ltg;
  if (Math.abs(gap) >= 1) return null;
  const carrier = res.kind === 'run' ? res.carrier : res.target?.rated ?? null;
  const call = rollSpotCall('firstDown', carrier ? aid(carrier) : null);
  if (!call) return null;
  const delta = gap >= 0 ? -1 : 1;
  const alt: PlayResolution = res.kind === 'run'
    ? { ...res, yards: res.yards + delta }
    : { ...res, yards: res.yards + delta, yac: Math.max(0, res.yac + delta) };
  return { call, ifOverturned: assemble(ctx, m, alt, sh) };
};

/** Two-point tries are untimed conversion attempts: snaps and defensive plays count, offensive yardage does not. */
const TRY_EXCLUDED = /^(passing|rushing|receiving)\.|^(offensivePlays|successfulPlays|epa)$/;
const stripTryStats = (stats: PlayStatDelta[]): PlayStatDelta[] => stats.filter((d) => !TRY_EXCLUDED.test(d.stat));

const presnapPenaltyOutcome = (ctx: PlayContext, m: Matchups, pen: PenaltyInfo, presnap: number): PlayOutcome => {
  const who = pen.playerId ? [...m.offense, ...m.defense].find((p) => p.player.id === pen.playerId) : null;
  return emptyOutcome({
    result: 'penalty', yards: 0, endBallOn: ctx.ballOn, endBallX: ctx.ballX, timeElapsed: 0, presnapElapsed: presnap, penalties: [pen],
    events: [{ type: 'penalty', tick: 0, penalty: pen }, { type: 'whistle', tick: 0, reason: 'penaltyDeadBall' }],
    playByPlay: [`${foulLabel(pen.foul)} on the ${pen.side}${who ? ` (${nameOf(who)})` : ''}, ${pen.yards} yards.`],
    fatigueAfter: fatigueAfterPlay(ctx, m, () => ({ distanceYards: 0, sprintSeconds: 0, contacts: 0 })), epa: 0, success: false,
  }, ctx.offense);
};

/** Per-game form of each side (matchup-factor units, 0 = an ordinary day); see game-sim.ts gameForm. */
export interface GameForm {
  home: number;
  away: number;
}

/**
 * Builds the statistical executor. Kick plays go to the special-teams module; everything else (scrimmage plays,
 * two-point tries, fakes) is resolved by the play model and described here. With a GameForm the scrimmage
 * matchups tilt by the offense's form minus the defense's (game-to-game variance for whole-game simulation).
 * `knobsOf` is where difficulty enters (the AI decision knobs, knobsFor by default); nothing else reads it, which
 * the dice tests check by holding the knobs while the difficulty moves. Every outcome passes assertValidOutcome.
 */
export const createFastSim = (form: GameForm | null = null, knobsOf: (ctx: PlayContext) => ModelKnobs = knobsFor): FastPlayExecutor => (ctx) => {
  const knobs = knobsOf(ctx);
  const raw = buildMatchups(ctx, knobs);
  if (!isScrimmageContext(ctx)) return assertValidOutcome(simulateSpecialTeams(ctx, raw));
  const m = form ? applyGameForm(raw, form[ctx.offense] - form[ctx.offense === 'home' ? 'away' : 'home']) : raw;
  const rng = ctx.rng;
  const presnap = presnapSeconds(ctx, rng);
  const pre = rollPresnapPenalty(ctx, m, rng);
  if (pre) return assertValidOutcome(presnapPenaltyOutcome(ctx, m, pre, presnap));
  const res = resolveScrimmagePlay(ctx, m, knobs, rng);
  const oob = (res.kind === 'run' || res.kind === 'pass') && res.outOfBounds;
  const sh: Shared = {
    presnap,
    penalties: rollLivePenalties(ctx, m, res, rng),
    injuries: rollInjuries(ctx, contactsFor(m, res), rng, tickAt(res.timeElapsed)),
    fatigueAfter: fatigueAfterPlay(ctx, m, (p) => effortFor(p, res)),
    endBallX: sampleEndBallX(rng, { outOfBounds: oob, centred: false }),
  };
  const outcome = assemble(ctx, m, res, sh);
  outcome.review = rollReview(ctx, m, res, sh);
  if (ctx.special === 'twoPoint') {
    outcome.stats = stripTryStats(outcome.stats);
    if (outcome.review) outcome.review.ifOverturned.stats = stripTryStats(outcome.review.ifOverturned.stats);
  }
  return assertValidOutcome(outcome);
};

/** The statistical executor with no game-level form (single plays, tests, calibration against the live engine). */
export const simulatePlay: FastPlayExecutor = createFastSim(null);
