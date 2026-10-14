import { clamp, ratingToFactor } from '@/core/math';
import type { Rng } from '@/core/rng';
import { clone, dist, type Vec2 } from '@/core/vec2';
import { holdBall } from '@/physics/ball';
import { circleHit } from '@/physics/collision';
import { CONTEST_RADIUS, reachHeight, standingReach } from '@/physics/contact';
import { ballCarrier, findAthlete } from '../athlete';
import type { DevCommand, DevHooks } from '../engine-api';
import type { TackleKind } from '../play-events';
import type { Athlete, PlayState } from '../play-types';
import { FIELD_LENGTH, FIELD_WIDTH, type TeamSide } from '../types';
import { ballHandlingSystem } from './ball-handling';
import { blockingSystem } from './blocking';
import {
  attackDir, ballOnAt, canAct, carrierDown, depthOf, emit, goalLineY, markDead, noteContact, progressSpot, setTimedState, takePossession,
  type EngineEnv, type FumbleRecord, type TackleRecord,
} from './env';
import { fumbleSystem, looseBallFrom } from './fumble';
import { kickFlightSystem } from './kick-flight';
import { kickingSystem } from './kicking';
import { descentDistance, SIDELINE_INSIDE } from './pass-arrival';
import { passingSystem } from './passing';
import { penaltiesLiveSystem } from './penalties-live';
import { specialMovesSystem } from './special-moves';
import { DIVE_REACH, TACKLE_REACH, tackleSystem } from './tackle';

export type { EngineEnv } from './env';
export { presnapSystem } from './presnap';
export { kickerApproach } from './kicking';
export { updateTimers } from './special-moves';

/**
 * Live interaction systems in pipeline order: exchanges (snap arrival, handoffs, pitches), special moves,
 * passing (throw / arrival), kicks and kick flight, blocking engagements, tackles, loose balls, live fouls.
 * Each system returns early once the play is dead. The developer god mode (LivePlayOptions.dev, see the section
 * below) pre-empts pass arrivals and tackle contests that involve the favoured team and wins its pitch / kick catch
 * rolls; without it the pipeline is untouched.
 */
export const runLiveSystems = (state: PlayState, env: EngineEnv, dt: number): void => {
  const god = env.opts.dev?.godMode ? devFavouredSide(state, env.opts.dev) : null;
  if (god === null) ballHandlingSystem(state, env);
  else withSureHands(env, devGodToss(state, god), () => ballHandlingSystem(state, env));
  if (state.phase !== 'live') return;
  specialMovesSystem(state, env);
  if (god === null || !devGodPassArrival(state, env, god)) passingSystem(state, env);
  if (state.phase !== 'live') return;
  kickingSystem(state, env, dt);
  if (god === null) kickFlightSystem(state, env, dt);
  else withSureHands(env, devGodKickCatch(state, env, god), () => kickFlightSystem(state, env, dt));
  if (state.phase !== 'live') return;
  blockingSystem(state, env, dt);
  if (god !== null) devGodContact(state, env, god);
  tackleSystem(state, env, dt);
  if (state.phase !== 'live') return;
  fumbleSystem(state, env, dt);
  if (state.phase !== 'live') return;
  penaltiesLiveSystem(state, env);
};

/* ================================== DEVELOPER HOOKS ==================================
 * Everything below runs only for LivePlayOptions.dev (src/tools developer mode). The rulings reuse the live
 * bookkeeping (takePossession, carrierDown, looseBallFrom, the completion / interception / fumble records) so the
 * outcome builder sees an ordinary play.
 */

/** Team the dev cheats favour: DevHooks.side, else ctx.userSide, else the only human-controlled side (null = none). */
export const devFavouredSide = (state: PlayState, dev: DevHooks | undefined): TeamSide | null => {
  if (!dev) return null;
  if (dev.side) return dev.side;
  const ctx = state.ctx;
  if (ctx.userSide) return ctx.userSide;
  const humans = (['home', 'away'] as const).filter((s) => ctx.controllers[s] === 'human');
  return humans.length === 1 ? (humans[0] as TeamSide) : null;
};

/** Seconds of tackle immunity the god-mode carrier gets each tick (it lapses on the next tick once the flag is off). */
const GOD_SHIELD_SECONDS = 1e-6;
/** Height under which a descending pass is playable (resolvePassArrival's gate). */
const PASS_PLAYABLE_Z = 1.2;
/** Yards past the goal line a forced touchdown puts the scorer. */
const FORCED_TD_DEPTH = 2;
const FIELD_INSET = 0.3;
const PASS_PLAY_TYPES: ReadonlySet<string> = new Set(['pass', 'playAction', 'screen', 'rpo']);

const devNote = (state: PlayState, text: string): void => {
  state.debug.dev = `t${state.tick} ${text}`;
};

const clampToField = (p: Vec2): Vec2 => ({ x: clamp(p.x, FIELD_INSET, FIELD_WIDTH - FIELD_INSET), y: clamp(p.y, FIELD_INSET, FIELD_LENGTH - FIELD_INSET) });

const nearestTo = (athletes: readonly Athlete[], p: Vec2): Athlete | null => {
  let best: Athlete | null = null;
  for (const a of athletes) if (!best || dist(a.pos, p) < dist(best.pos, p)) best = a;
  return best;
};

/** Active athletes matching `pred`, preferring those on their feet. */
const pickNearest = (state: PlayState, p: Vec2, pred: (a: Athlete) => boolean): Athlete | null => {
  const pool = state.athletes.filter((a) => a.active && pred(a));
  return nearestTo(pool.filter(canAct), p) ?? nearestTo(pool, p);
};

/** A guaranteed tackle (god mode): the same records, events, sack and spot rules as a won tackle contest. */
const devTackle = (state: PlayState, env: EngineEnv, carrier: Athlete, tackler: Athlete): void => {
  noteContact(env, carrier);
  noteContact(env, tackler);
  if (state.firstContactY === null && carrier.side === 'offense') state.firstContactY = carrier.pos.y;
  const kind: TackleKind = tackler.state === 'diving' ? 'dive' : 'wrap';
  const spot = progressSpot(state, env, carrier);
  carrier.state = 'tackled';
  carrier.stateTimer = 0;
  carrier.vel = { x: 0, y: 0 };
  setTimedState(tackler, 'tackling', 0.5);
  const rec: TackleRecord = { tackler: tackler.id, assists: [], kind, carrier: carrier.id, pos: clone(spot), tick: state.tick };
  env.lastTackle = rec;
  env.tackleRecords.push(rec);
  emit(state, { type: 'tackle', tick: state.tick, tackler: tackler.id, carrier: carrier.id, kind, assists: [] });
  const depth = depthOf(state, spot.y);
  if (carrier.side === 'offense' && carrier.id === env.qbId && !env.handoffDone && !env.pitched && state.pass === null
    && PASS_PLAY_TYPES.has(state.ctx.offensivePlay.type) && depth < 0) {
    env.sack = { by: tackler.id, assists: [], yardsLost: -depth };
    emit(state, { type: 'sack', tick: state.tick, by: tackler.id, assists: [], yardsLost: -depth });
  }
  carrierDown(state, env, carrier, spot, 'tackle');
};

/** God mode at contact: the favoured carrier cannot be tackled (so cannot fumble); a favoured defender always wins. */
const devGodContact = (state: PlayState, env: EngineEnv, side: TeamSide): void => {
  if (state.phase !== 'live' || state.ball.phase !== 'held') return;
  const carrier = ballCarrier(state);
  if (!carrier || !carrier.active || carrier.state === 'tackled' || carrier.state === 'down' || carrier.state === 'sliding') return;
  if (carrier.teamSide === side) {
    env.invulnerableUntil[carrier.id] = Math.max(env.invulnerableUntil[carrier.id] ?? 0, state.time + GOD_SHIELD_SECONDS);
    return;
  }
  const tackler = state.athletes
    .filter((d) => d.teamSide === side && canAct(d) && d.state !== 'jumping'
      && circleHit(d.pos, d.radius + (d.state === 'diving' ? DIVE_REACH : TACKLE_REACH), carrier.pos, carrier.radius))
    .sort((p, q) => dist(p.pos, carrier.pos) - dist(q.pos, carrier.pos))[0];
  if (tackler) devTackle(state, env, carrier, tackler);
};

const devComplete = (state: PlayState, env: EngineEnv, r: Athlete): void => {
  state.ball = holdBall(state.ball, r.id, state.tick, 'pass');
  takePossession(state, env, r);
  state.firstContactY = null;
  env.completion = { receiverId: r.id, tick: state.tick, pos: clone(r.pos), airYards: depthOf(state, r.pos.y), contested: false, catchKind: 'possession' };
  setTimedState(r, 'catching', 0.35);
  emit(state, { type: 'catch', tick: state.tick, receiver: r.id, contested: false, catchKind: 'possession', ballOn: ballOnAt(env, r.pos.y) });
};

const devIntercept = (state: PlayState, env: EngineEnv, d: Athlete): void => {
  state.ball = holdBall(state.ball, d.id, state.tick, 'pass');
  takePossession(state, env, d);
  env.interception = { by: d.id, pos: clone(d.pos), tick: state.tick };
  if (d.state === 'idle' || d.state === 'jumping') d.state = 'moving';
  emit(state, { type: 'interception', tick: state.tick, defender: d.id, ballOn: ballOnAt(env, d.pos.y) });
};

/** Fumble recovery with fumble.ts's advance rules (restricted offensive recoveries, the kicking team on kicks). */
const devRecover = (state: PlayState, env: EngineEnv, a: Athlete, rec: FumbleRecord): void => {
  state.ball = holdBall(state.ball, a.id, state.tick, 'handoff');
  rec.recoveredBy = a.id;
  rec.recoverySide = a.side;
  takePossession(state, env, a);
  if (a.state === 'idle' || a.state === 'stumbling') a.state = 'moving';
  const ctx = state.ctx;
  const kickPlay = ctx.special === 'kickoff' || ctx.special === 'onside' || ctx.special === 'punt';
  const lateGame = (ctx.quarter === 2 || ctx.quarter >= 4) && ctx.clockRemaining <= 120;
  const restricted = a.side === rec.carrierSide && a.side === 'offense' && a.id !== rec.carrierId && (ctx.down === 4 || lateGame);
  const advanced = !restricted && !(kickPlay && a.side === 'offense');
  emit(state, { type: 'recovery', tick: state.tick, by: a.id, side: a.side, ballOn: ballOnAt(env, a.pos.y), advanced });
  if (!advanced) markDead(state, env, 'fumbleRecovered', restricted ? rec.pos : a.pos);
};

const godReach = (a: Athlete): number => (a.state === 'jumping' ? reachHeight(a) : standingReach(a) + 0.2);
/** Never smaller than pass-arrival's catch radius (even with the full user pass assist). */
const godCatchRadius = (a: Athlete, targeted: boolean): number =>
  1.6 + 0.35 * ratingToFactor(a.attrs.catching) + (a.state === 'diving' ? 0.5 : 0) + (targeted ? 0.15 : 0);

/**
 * God mode for a ball in the air: a favoured athlete who can reach its descent catches it (offense) or picks it off
 * (defense, anywhere within CONTEST_RADIUS of the path). A ball the favoured team threw is never resolved for the
 * opponents: no bats, contests or interceptions, it is caught by the favoured side or falls incomplete. Returns true
 * when the normal pass arrival must be skipped this tick.
 */
const devGodPassArrival = (state: PlayState, env: EngineEnv, side: TeamSide): boolean => {
  const ball = state.ball;
  if (state.phase !== 'live' || ball.phase !== 'inAir' || (ball.kind !== 'pass' && ball.kind !== 'tip')) return false;
  const userThrew = findAthlete(state, ball.throwerId)?.teamSide === side;
  if (ball.vz < 0 || ball.z <= PASS_PLAYABLE_Z) {
    const radius = (a: Athlete): number => (userThrew ? godCatchRadius(a, a.id === ball.targetId) : CONTEST_RADIUS);
    const cands = state.athletes.filter((a) => a.teamSide === side && a.active && a.state !== 'tackled' && a.state !== 'down' && a.state !== 'engaged'
      && (a.id !== ball.throwerId || ball.isTipped) && ball.z <= godReach(a) && dist(a.pos, ball.pos) <= radius(a) + 4
      && Math.min(a.pos.x, FIELD_WIDTH - a.pos.x) >= SIDELINE_INSIDE && descentDistance(state, a) <= radius(a));
    const who = cands.find((a) => a.id === ball.targetId) ?? cands.sort((p, q) => descentDistance(state, p) - descentDistance(state, q))[0];
    if (who) {
      if (who.side === 'offense') devComplete(state, env, who);
      else devIntercept(state, env, who);
      return true;
    }
  }
  return userThrew;
};

/** An Rng whose chance() always succeeds (god mode's sure hands); every other draw uses the real stream. */
const sureHandsRng = (rng: Rng): Rng => ({
  get seed() {
    return rng.seed;
  },
  next: () => rng.next(),
  range: (lo, hi) => rng.range(lo, hi),
  int: (lo, hi) => rng.int(lo, hi),
  chance: () => true,
  pick: <T>(items: readonly T[]): T => rng.pick(items),
  weighted: <T>(items: readonly T[], weights: readonly number[]): T => rng.weighted(items, weights),
  gaussian: (mean, stdDev) => rng.gaussian(mean, stdDev),
  shuffle: <T>(items: readonly T[]): T[] => rng.shuffle(items),
  fork: (label) => rng.fork(label),
  getState: () => rng.getState(),
  setState: (st) => rng.setState(st),
});

/** Runs `system` with every chance() roll won when `on` (the only roll on those paths is the muff / clean catch). */
const withSureHands = (env: EngineEnv, on: boolean, system: () => void): void => {
  if (!on) {
    system();
    return;
  }
  const real = env.rng;
  env.rng = sureHandsRng(real);
  try {
    system();
  } finally {
    env.rng = real;
  }
};

/** A pitch / lateral in the air to a favoured athlete: he cannot muff it (ball-handling's only roll there). */
const devGodToss = (state: PlayState, side: TeamSide): boolean => {
  const ball = state.ball;
  return ball.phase === 'inAir' && (ball.kind === 'pitch' || ball.kind === 'lateral') && findAthlete(state, ball.targetId)?.teamSide === side;
};

/** A punt / kickoff in the air while the favoured team receives: its fielder cannot muff it (kick-flight's only roll). */
const devGodKickCatch = (state: PlayState, env: EngineEnv, side: TeamSide): boolean =>
  env.kick !== null && state.ball.phase === 'inAir' && state.ctx.offense !== side;

/* ------------------------------------- commands ------------------------------------- */

const releaseEngagements = (state: PlayState, env: EngineEnv, a: Athlete): void => {
  env.engagements = env.engagements.filter((e) => {
    if (e.blockerId !== a.id && e.rusherId !== a.id) return true;
    const other = findAthlete(state, e.blockerId === a.id ? e.rusherId : e.blockerId);
    if (other) {
      other.engagedWith = null;
      if (other.state === 'engaged') other.state = 'moving';
    }
    return false;
  });
  a.engagedWith = null;
  if (a.state === 'engaged') a.state = 'moving';
};

/** Teleport: no velocity, no phantom distance for fatigue, the ball comes along and forward progress restarts. */
const placeAthlete = (state: PlayState, env: EngineEnv, a: Athlete, pos: Vec2): void => {
  const p = clampToField(pos);
  a.pos = { x: p.x, y: p.y };
  a.vel = { x: 0, y: 0 };
  const track = env.tracks[a.id];
  if (track) track.prev = clone(p);
  releaseEngagements(state, env, a);
  if (state.ball.phase === 'held' && state.ball.carrierId === a.id) {
    state.ball.pos = clone(p);
    state.forwardProgressY = null;
  }
};

/** Puts the (live) ball in `a`'s hands through the path that matches where it is now. */
const giveBall = (state: PlayState, env: EngineEnv, a: Athlete): void => {
  const ball = state.ball;
  if (ball.phase === 'held') {
    const c = ballCarrier(state);
    if (c && c.id === a.id) return;
    if (!c || c.side === a.side) {
      state.ball = { ...holdBall(ball, a.id, state.tick, 'handoff'), pos: clone(a.pos), throwerId: c?.id ?? ball.throwerId };
      takePossession(state, env, a);
      return;
    }
    looseBallFrom(state, env, c, a, { popSpeed: 0 });
    setTimedState(c, 'down', 0.8);
    c.vel = { x: 0, y: 0 };
  }
  const now = state.ball;
  if (now.phase === 'inAir' && (now.kind === 'pass' || now.kind === 'tip')) {
    if (a.side === 'offense') devComplete(state, env, a);
    else devIntercept(state, env, a);
    return;
  }
  const rec = env.fumbles[env.fumbles.length - 1];
  if (now.phase === 'loose' && now.kind === 'fumble' && rec && rec.recoveredBy === null) {
    devRecover(state, env, a, rec);
    return;
  }
  state.ball = { ...holdBall(now, a.id, state.tick, 'handoff'), pos: clone(a.pos) };
  takePossession(state, env, a);
};

/** Drops the ball loose at `pos`: a fumble charged to the carrier, or to whoever last touched it. */
const dropBall = (state: PlayState, env: EngineEnv, pos: Vec2): void => {
  const carrier = state.ball.phase === 'held' ? ballCarrier(state) : null;
  if (carrier) looseBallFrom(state, env, carrier, null, { popSpeed: 0 });
  else {
    const who = findAthlete(state, state.ball.lastTouchedId) ?? state.athletes.find((a) => a.side === env.possession) ?? null;
    if (who) {
      env.fumbles.push({ carrierId: who.id, carrierSide: who.side, forcedBy: null, pos: clone(pos), tick: state.tick, recoveredBy: null, recoverySide: null });
      emit(state, { type: 'fumble', tick: state.tick, carrier: who.id, forcedBy: null, ballOn: ballOnAt(env, pos.y), forward: false });
    }
    for (const a of state.athletes) a.hasBall = false;
  }
  const p = clampToField(pos);
  state.ball = {
    ...state.ball, pos: p, z: 0, vel: { x: 0, y: 0 }, vz: 0, phase: 'loose', kind: 'fumble', carrierId: null,
    targetId: null, targetPos: null, throwType: null, isTipped: false,
  };
  env.stallTime = 0;
};

const forceTouchdown = (state: PlayState, env: EngineEnv, side: TeamSide): void => {
  const carrier = state.ball.phase === 'held' ? ballCarrier(state) : null;
  const scorer = carrier && carrier.teamSide === side ? carrier : pickNearest(state, state.ball.pos, (a) => a.teamSide === side);
  if (!scorer) {
    devNote(state, `forceTouchdown: no ${side} athlete`);
    return;
  }
  if (scorer !== carrier) giveBall(state, env, scorer);
  if (state.phase !== 'live' || ballCarrier(state)?.id !== scorer.id) {
    devNote(state, `forceTouchdown: ${scorer.id} could not keep the ball`);
    return;
  }
  const goal = goalLineY(env, scorer.side);
  placeAthlete(state, env, scorer, { x: clamp(scorer.pos.x, 2, FIELD_WIDTH - 2), y: goal + attackDir(env, scorer.side) * FORCED_TD_DEPTH });
  if (scorer.state !== 'moving' && scorer.state !== 'idle') scorer.state = 'moving';
  env.invulnerableUntil[scorer.id] = state.time + 0.5;
  devNote(state, `forceTouchdown ${scorer.id}`);
};

const forceTurnover = (state: PlayState, env: EngineEnv): void => {
  const ball = state.ball;
  if (ball.phase === 'inAir' && (ball.kind === 'pass' || ball.kind === 'tip')) {
    const d = pickNearest(state, ball.pos, (a) => a.side === 'defense');
    if (d) devIntercept(state, env, d);
    devNote(state, d ? `forceTurnover: ${d.id} intercepts` : 'forceTurnover: no defender');
    return;
  }
  const carrier = ball.phase === 'held' ? ballCarrier(state) : null;
  const rec0 = env.fumbles[env.fumbles.length - 1];
  const loseSide = carrier?.side ?? (ball.phase === 'loose' && ball.kind === 'fumble' && rec0 ? rec0.carrierSide : null);
  if (!loseSide) {
    devNote(state, 'forceTurnover: nobody has the ball');
    return;
  }
  const opp = pickNearest(state, ball.pos, (a) => a.side !== loseSide);
  if (!opp) {
    devNote(state, 'forceTurnover: no opponent');
    return;
  }
  if (carrier) {
    looseBallFrom(state, env, carrier, opp, { popSpeed: 0 });
    setTimedState(carrier, 'down', 0.8);
    carrier.vel = { x: 0, y: 0 };
  }
  const rec = env.fumbles[env.fumbles.length - 1];
  if (!rec) return;
  // The recoverer falls on it where it came out, a step to his side of the fumbler.
  const off = dist(opp.pos, state.ball.pos) > 1e-6 ? 0.6 / dist(opp.pos, state.ball.pos) : 0;
  placeAthlete(state, env, opp, { x: state.ball.pos.x + (opp.pos.x - state.ball.pos.x) * off, y: state.ball.pos.y + (opp.pos.y - state.ball.pos.y) * off });
  devRecover(state, env, opp, rec);
  devNote(state, `forceTurnover: ${opp.id} recovers`);
};

/** Applies one command; false = it must wait (the ball is not live yet). Commands on a dead play are dropped. */
export const applyDevCommand = (state: PlayState, env: EngineEnv, cmd: DevCommand): boolean => {
  if (state.phase === 'dead') return true;
  if (cmd.type === 'teleport') {
    const a = findAthlete(state, cmd.athleteId);
    if (a) placeAthlete(state, env, a, cmd.pos);
    devNote(state, a ? `teleport ${a.id}` : `teleport: unknown ${cmd.athleteId}`);
    return true;
  }
  if (state.phase !== 'live') return false;
  switch (cmd.type) {
    case 'spawnBall':
      if (cmd.mode === 'loose') {
        dropBall(state, env, cmd.pos);
        devNote(state, 'spawnBall loose');
      } else {
        const a = findAthlete(state, cmd.athleteId);
        if (a && a.active) {
          if (cmd.pos) placeAthlete(state, env, a, cmd.pos);
          giveBall(state, env, a);
        }
        devNote(state, a && a.active ? `spawnBall to ${a.id}` : `spawnBall: no active ${cmd.athleteId}`);
      }
      break;
    case 'forceTouchdown':
      forceTouchdown(state, env, cmd.side);
      break;
    case 'forceTurnover':
      forceTurnover(state, env);
      break;
  }
  return true;
};

/**
 * Drains the DevHooks inbox into the engine queue (discarding commands issued for another play) and applies every
 * command that can run now, in order.
 */
export const runDevCommands = (state: PlayState, env: EngineEnv, queue: DevCommand[]): void => {
  const dev = env.opts.dev;
  const inbox = dev?.commands;
  if (dev && inbox && inbox.length > 0) {
    const issuedFor = dev.commandPlayIndex;
    const incoming = inbox.splice(0, inbox.length);
    if (issuedFor === undefined || issuedFor === null || issuedFor === state.ctx.playIndex) queue.push(...incoming);
    else devNote(state, `dropped ${incoming.length} stale command(s)`);
  }
  if (queue.length === 0) return;
  const waiting = queue.filter((cmd) => !applyDevCommand(state, env, cmd));
  queue.length = 0;
  queue.push(...waiting);
};
