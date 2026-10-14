import { delta } from '@/statistics/apply';
import type { PlayStatDelta, StatPath } from '@/statistics/types';
import { findAthlete } from '../athlete';
import type { Athlete, PlayState } from '../play-types';
import type { EngineEnv } from './env';
import type { OutcomeFacts } from './outcome-facts';

/**
 * Stat deltas for one play (every relevant PlayerStatLine path). Paths are the typed StatPath union, so a typo
 * fails to compile. Dead-ball pre-snap fouls produce no deltas: the play never happened.
 */
const RUSH_TYPES = new Set(['rushGap', 'blitz', 'contain']);
const COVER_TYPES = new Set(['manCover', 'zone', 'spy']);
const BLOCK_TYPES = new Set(['runBlock', 'passBlock', 'leadBlock']);

export const buildStatDeltas = (state: PlayState, env: EngineEnv, facts: OutcomeFacts): PlayStatDelta[] => {
  const out: PlayStatDelta[] = [];
  if (facts.result === 'penalty') return out;
  const d = (a: Athlete | null, stat: StatPath, value = 1): void => {
    if (a && value !== 0) out.push(delta(a.playerId, stat, value));
  };
  const tdForOffense = facts.touchdown && !facts.turnover;
  for (const a of state.athletes) {
    d(a, 'snaps');
    if (a.side === 'offense' && BLOCK_TYPES.has(a.assignment.type)) d(a, 'blocking.snaps');
    if (a.side === 'defense' && facts.isPassPlay) {
      if (RUSH_TYPES.has(a.assignment.type)) d(a, 'defense.passRushSnaps');
      if (COVER_TYPES.has(a.assignment.type)) d(a, 'defense.coverageSnaps');
    }
  }
  // Passing.
  const pass = state.pass;
  if (facts.passer && pass) {
    d(facts.passer, 'passing.attempts');
    d(facts.passer, 'passing.airYards', Math.round(pass.airYards));
    if (pass.throwType === 'throwAway') d(facts.passer, 'passing.throwaways');
    if (pass.underPressure) d(facts.passer, 'passing.pressures');
    if (facts.completion) {
      d(facts.passer, 'passing.completions');
      d(facts.passer, 'passing.yards', facts.yards);
      d(facts.passer, 'passing.longest', facts.yards);
      if (tdForOffense) d(facts.passer, 'passing.touchdowns');
    }
    if (env.interception) d(facts.passer, 'passing.interceptions');
  }
  if (facts.passer && env.sack) {
    d(facts.passer, 'passing.sacks');
    d(facts.passer, 'passing.sackYards', Math.round(env.sack.yardsLost));
  }
  // Rushing. A kneel-down is a rushing attempt for the quarterback (minus a yard, as on the stat sheet), which is
  // also what the team rushing total (rules/index.ts) and the fast sim count.
  const rusher = facts.rusher ?? (facts.result === 'kneel' ? facts.carrier : null);
  if (rusher && (facts.result === 'run' || facts.result === 'scramble' || facts.result === 'kneel')) {
    d(rusher, 'rushing.attempts');
    d(rusher, 'rushing.yards', facts.yards);
    d(rusher, 'rushing.longest', facts.yards);
    if (tdForOffense) d(rusher, 'rushing.touchdowns');
    d(rusher, 'rushing.yardsAfterContact', facts.yardsAfterContact);
    d(rusher, 'rushing.brokenTackles', rusher.brokenTacklesThisPlay);
    if (facts.firstDown) d(rusher, 'rushing.firstDowns');
    if (facts.explosive) d(rusher, 'rushing.explosivePlays');
  }
  // Receiving.
  if (facts.receiver && pass) {
    d(facts.receiver, 'receiving.targets');
    d(facts.receiver, 'receiving.airYards', Math.round(pass.airYards));
    d(facts.receiver, 'receiving.separationTotal', Math.round(pass.separationAtThrow * 10) / 10);
    if (facts.completion) {
      d(facts.receiver, 'receiving.receptions');
      d(facts.receiver, 'receiving.yards', facts.yards);
      d(facts.receiver, 'receiving.longest', facts.yards);
      d(facts.receiver, 'receiving.yac', facts.yac);
      if (facts.completion.contested) d(facts.receiver, 'receiving.contestedCatches');
      if (tdForOffense) d(facts.receiver, 'receiving.touchdowns');
      if (facts.firstDown) d(facts.receiver, 'receiving.firstDowns');
      if (facts.explosive) d(facts.receiver, 'receiving.explosivePlays');
      d(facts.receiver, 'rushing.brokenTackles', facts.receiver.brokenTacklesThisPlay);
    }
    if (state.events.some((e) => e.type === 'incomplete' && e.reason === 'drop')) d(facts.receiver, 'receiving.drops');
    const cover = findAthlete(state, env.coverDefenderId);
    if (cover) {
      d(cover, 'defense.targetsAllowed');
      if (facts.completion) {
        d(cover, 'defense.receptionsAllowed');
        d(cover, 'defense.yardsAllowed', facts.yards);
      }
    }
  }
  // Defense.
  const t = facts.tackle;
  if (t) {
    const tackler = findAthlete(state, t.tackler);
    d(tackler, 'defense.tackles');
    if (t.assists.length === 0) d(tackler, 'defense.soloTackles');
    for (const id of t.assists) {
      const a = findAthlete(state, id);
      d(a, 'defense.tackles');
      d(a, 'defense.assists');
    }
    if ((facts.result === 'run' || facts.result === 'scramble') && facts.yards < 0) d(tackler, 'defense.tfl');
    if (t.kind === 'hitStick') d(tackler, 'defense.hitSticks');
  }
  if (env.sack) {
    d(findAthlete(state, env.sack.by), 'defense.sacks', env.sack.assists.length > 0 ? 0.5 : 1);
    d(findAthlete(state, env.sack.by), 'defense.tfl');
    for (const id of env.sack.assists) d(findAthlete(state, id), 'defense.sacks', 0.5);
    d(findAthlete(state, env.shedBy[env.sack.by] ?? null), 'blocking.sacksAllowed');
  }
  if (env.interception) {
    const by = findAthlete(state, env.interception.by);
    d(by, 'defense.interceptions');
    d(by, 'defense.interceptionYards', facts.returnYards);
  }
  for (const e of state.events) {
    if (e.type === 'incomplete' && e.reason === 'defended') d(findAthlete(state, e.defender), 'defense.passBreakups');
    else if (e.type === 'missedTackle') d(findAthlete(state, e.defender), 'defense.missedTackles');
    else if (e.type === 'pressure') {
      d(findAthlete(state, e.by), 'defense.pressures');
      d(findAthlete(state, env.shedBy[e.by] ?? null), 'blocking.pressuresAllowed');
    } else if (e.type === 'pancake') d(findAthlete(state, e.blocker), 'blocking.pancakes');
    else if (e.type === 'touchdown' && e.side === 'defense') d(findAthlete(state, e.scorer), 'defense.touchdowns');
  }
  for (const fu of env.fumbles) {
    const carrier = findAthlete(state, fu.carrierId);
    d(carrier, 'fumbles');
    if (carrier && carrier.side === 'offense' && fu.recoverySide === 'defense') d(carrier, 'fumblesLost');
    if (carrier && carrier.side === 'offense' && facts.rusher?.id === carrier.id) d(carrier, 'rushing.fumbles');
    d(findAthlete(state, fu.forcedBy), 'defense.forcedFumbles');
    const rec = findAthlete(state, fu.recoveredBy);
    if (rec && rec.side !== fu.carrierSide) d(rec, 'defense.fumbleRecoveries');
  }
  // Kicking and returns.
  const k = env.kick;
  if (k) {
    const kicker = findAthlete(state, k.kicker);
    if (k.kind === 'kickoff' || k.kind === 'onside') d(kicker, 'kicking.kickoffs');
    if (k.kind === 'punt') {
      d(kicker, 'kicking.punts');
      d(kicker, 'kicking.puntYards', facts.kickDistance ?? 0);
      d(kicker, 'kicking.puntLong', facts.kickDistance ?? 0);
      if (facts.endBallOn >= 80 && state.deadReason !== 'touchback') d(kicker, 'kicking.puntsInside20');
    }
    if (state.deadReason === 'touchback') d(kicker, 'kicking.touchbacks');
    if (k.kind === 'fieldGoal') {
      d(kicker, 'kicking.fgAttempts');
      if (k.made) {
        d(kicker, 'kicking.fgMade');
        d(kicker, 'kicking.fgLong', facts.kickDistance ?? 0);
      }
    }
    if (k.kind === 'extraPoint') {
      d(kicker, 'kicking.xpAttempts');
      if (k.made) d(kicker, 'kicking.xpMade');
    }
    const returner = findAthlete(state, k.fieldedBy);
    const returned = state.deadReason !== 'touchback' && state.deadReason !== 'fairCatch';
    if (returner && k.returnStart && returner.side === 'defense' && returned) {
      const punt = k.kind === 'punt';
      d(returner, punt ? 'returns.puntReturns' : 'returns.kickReturns');
      d(returner, punt ? 'returns.puntReturnYards' : 'returns.kickReturnYards', facts.returnYards);
      d(returner, 'returns.longest', facts.returnYards);
      if (facts.touchdown && facts.scorer?.id === returner.id) d(returner, 'returns.returnTouchdowns');
    }
  }
  // Offensive involvement.
  const involved = new Set<Athlete>();
  if (facts.rusher && (facts.result === 'run' || facts.result === 'scramble')) involved.add(facts.rusher);
  if (facts.passer && pass) involved.add(facts.passer);
  if (facts.receiver && pass) involved.add(facts.receiver);
  for (const a of involved) {
    d(a, 'offensivePlays');
    if (facts.success) d(a, 'successfulPlays');
    d(a, 'epa', Math.round(facts.epa * 1000) / 1000);
  }
  return out;
};
