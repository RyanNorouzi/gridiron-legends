import { clamp01 } from '@/core/math';
import { TICK_DT } from '@/core/time';
import { dist } from '@/core/vec2';
import { ballCarrier, findAthlete } from '@/game/athlete';
import type { Athlete, BallKind, PlayState } from '@/game/play-types';
import type { DifficultyProfile, Side } from '@/game/types';
import { predictLanding, type LandingPrediction } from '@/physics/ball';
import { f, jitter, reactionDelay } from './variance';
import { difficultyFor } from '@/game/difficulty-sides';

/**
 * What an athlete KNOWS this tick. The play state is fully visible to the code, so perception deliberately
 * withholds it: defenders only learn run/pass from observable keys (a handoff, a throw, the QB crossing the
 * line, the OL firing out or setting back) and only after a reaction delay that difficulty, the reaction
 * rating and awareness shape. A play-action fake plants a false run key that only aware defenders (helped by
 * DifficultyProfile.coverageAnticipation) see through. Recognition is written to athlete.ai.recognizedRun /
 * recognizedPass and the timers live in ai.scratch, so repeated calls in one tick are cheap and idempotent.
 */
export interface Perception {
  ballCarrier: Athlete | null;
  /** Side holding the ball (or the side of whoever last touched a loose/airborne ball). */
  possession: Side | null;
  ballInAir: boolean;
  ballLoose: boolean;
  /** Where and when an airborne ball comes down (null when it is not airborne). */
  ballLanding: LandingPrediction | null;
  /** Recognised (not necessarily true) play type. Both false until a key has been read. */
  playIsRun: boolean;
  playIsPass: boolean;
  /** Seconds since the snap (0 before it). */
  timeSinceSnap: number;
  nearestOpponent: Athlete | null;
  nearestOpponentDist: number;
  nearestTeammate: Athlete | null;
  /** Active opponents within THREAT_RADIUS yards, nearest first. */
  threats: Athlete[];
  /** Seconds of anticipation this athlete gets on a receiver's break (see anticipation()). */
  anticipation: number;
}

/** Opponents inside this radius count as threats. */
export const THREAT_RADIUS = 6;
/** How long a play-action fake keeps showing a run key (seconds). */
export const PLAY_ACTION_WINDOW = 0.9;
/** Seconds of break anticipation a perfectly aware defender gets on the hardest difficulty. */
export const MAX_ANTICIPATION_SEC = 0.4;
/** Awareness factor below which the subtle keys (OL movement, drop depth) are not read at all. */
export const SUBTLE_KEY_AWARENESS = 0.25;

/** Key strength: 0 = none, 1 = subtle (needs awareness, read late), 2 = strong (handoff, throw, LOS crossed). */
type KeyStrength = 0 | 1 | 2;
interface Keys { run: KeyStrength; pass: KeyStrength }
interface TickCache { tick: number; ballKey: string; keys: Keys; landing: LandingPrediction | null; paFakeAt: number }

const RUN_BALL_KINDS: ReadonlySet<BallKind> = new Set<BallKind>(['handoff', 'pitch']);
const LAUNCHED_KINDS: ReadonlySet<BallKind> = new Set<BallKind>(['kickoff', 'punt', 'fieldGoal']);
const cache = new WeakMap<PlayState, TickCache>();

/** Seconds since the snap; 0 while pre-snap. */
export const timeSinceSnap = (state: Pick<PlayState, 'phase' | 'tick' | 'snapTick'>): number =>
  state.phase === 'presnap' || state.snapTick < 0 ? 0 : Math.max(0, state.tick - state.snapTick) * TICK_DT;

/** The offensive quarterback (the athlete with the 'qb' assignment), if any. */
export const quarterbackOf = (state: Pick<PlayState, 'athletes'>): Athlete | null =>
  state.athletes.find((a) => a.side === 'offense' && a.assignment.type === 'qb') ?? null;

/** Event lists of plays whose kick is already away (a play's list only grows, so one hit is final). */
const kickedPlays = new WeakMap<readonly PlayState['events'][number][], true>();
const kickIsAway = (events: PlayState['events']): boolean => {
  if (kickedPlays.has(events)) return true;
  if (!events.some((e) => e.type === 'kick')) return false;
  kickedPlays.set(events, true);
  return true;
};

/**
 * True once a kickoff / punt / field goal has left the kicker's foot (or the tee). The kick stays launched when the
 * ball changes kind on the return (a muff or fumble, the recovery, a lateral): the coverage keeps covering and the
 * return keeps going.
 */
export const kickLaunched = (state: Pick<PlayState, 'ball' | 'athletes' | 'events'>): boolean => {
  const b = state.ball;
  if (!LAUNCHED_KINDS.has(b.kind)) return b.kind !== 'snap' && b.kind !== 'none' && kickIsAway(state.events);
  if (b.phase === 'inAir' || b.phase === 'loose' || b.phase === 'dead') return true;
  if (b.phase !== 'held') return false;
  const carrier = ballCarrier(state);
  return carrier !== null && carrier.side === 'defense';
};

/**
 * True when a kick play has turned into a scrimmage play: the ball is thrown, an offensive carrier has
 * crossed the line, or the snap is long gone without a kick (fake punt / fake field goal, botched snap).
 */
export const fakeInProgress = (state: PlayState): boolean => {
  if (state.phase !== 'live' || kickLaunched(state)) return false;
  const b = state.ball;
  if (b.kind === 'pass' || b.kind === 'handoff' || b.kind === 'pitch' || b.kind === 'lateral') return true;
  const carrier = ballCarrier(state);
  if (carrier && carrier.side === 'offense' && state.ctx.direction * (carrier.pos.y - state.losY) > 0) return true;
  return timeSinceSnap(state) > 2.5;
};

const isLineman = (a: Athlete): boolean =>
  a.side === 'offense' && (a.position === 'OT' || a.position === 'OG' || a.position === 'C' || a.assignment.type === 'runBlock' || a.assignment.type === 'passBlock' || a.assignment.type === 'leadBlock');

/** Observable keys this tick (shared by every defender; personal delays are applied per athlete). */
const readKeys = (state: PlayState, carrier: Athlete | null, qb: Athlete | null): Keys => {
  const dir = state.ctx.direction;
  const ball = state.ball;
  let run: KeyStrength = 0;
  let pass: KeyStrength = 0;
  if (state.phase !== 'live') return { run, pass };
  if (ball.phase === 'inAir' && ball.kind === 'pass') pass = 2;
  else if (ball.phase === 'inAir' && RUN_BALL_KINDS.has(ball.kind)) run = 2;
  else if (carrier && carrier.side === 'offense') {
    if (!qb || carrier.id !== qb.id) {
      if (ball.kind === 'pass') pass = 2;
      else run = 2;
    } else {
      const depth = dir * (qb.pos.y - state.losY);
      if (depth > 0.5 || qb.state === 'scrambling') run = 2;
      else if (qb.state === 'throwing') pass = 2;
      else if (qb.state === 'dropback' || dir * qb.vel.y < -1.5) pass = 1;
    }
  }
  // Line keys: the OL firing downfield says run, setting backward says pass.
  let n = 0;
  let along = 0;
  for (const a of state.athletes) {
    if (!a.active || !isLineman(a)) continue;
    n++;
    along += dir * a.vel.y;
  }
  if (n > 0) {
    const mean = along / n;
    if (mean > 0.8 && run === 0) run = 1;
    else if (mean < -0.6 && pass === 0) pass = 1;
  }
  return { run, pass };
};

const ballKeyOf = (state: PlayState): string => `${state.ball.phase}|${state.ball.kind}|${state.ball.carrierId ?? ''}|${state.phase}`;

const tickCache = (state: PlayState): TickCache => {
  const hit = cache.get(state);
  const ballKey = ballKeyOf(state);
  if (hit && hit.tick === state.tick && hit.ballKey === ballKey) return hit;
  const carrier = ballCarrier(state);
  const b = state.ball;
  const airborne = b.phase === 'inAir' || (b.phase === 'loose' && (b.z > 0.2 || b.vz > 0));
  const landing = airborne ? predictLanding(b, state.ctx.weather) : null;
  let paFakeAt = -1;
  for (let i = state.events.length - 1; i >= 0; i--) {
    const e = state.events[i] as PlayState['events'][number];
    if (e.type === 'playActionFake') { paFakeAt = e.tick; break; }
  }
  const entry: TickCache = { tick: state.tick, ballKey, keys: readKeys(state, carrier, quarterbackOf(state)), landing, paFakeAt };
  cache.set(state, entry);
  return entry;
};

/** 0..1 how much of a receiver's break this athlete anticipates: difficulty knob blended with awareness. */
export const anticipationFactor = (athlete: Pick<Athlete, 'attrs' | 'playerId'>, difficulty: Pick<DifficultyProfile, 'coverageAnticipation'>): number =>
  clamp01(0.5 * clamp01(difficulty.coverageAnticipation) + 0.5 * f(athlete.attrs.awareness) + jitter(athlete, 'anticipate', 0.05));

/** Seconds of lead this athlete gets on a route break / cut (drives coverage AI's early reactions). */
export const anticipation = (athlete: Pick<Athlete, 'attrs' | 'playerId'>, difficulty: Pick<DifficultyProfile, 'coverageAnticipation'>): number =>
  MAX_ANTICIPATION_SEC * anticipationFactor(athlete, difficulty);

/** Whether a defender sees through a play-action fake (awareness + difficulty, personality-tilted). */
export const seesThroughFake = (athlete: Pick<Athlete, 'attrs' | 'playerId'>, difficulty: Pick<DifficultyProfile, 'coverageAnticipation'>): boolean =>
  f(athlete.attrs.awareness) * 0.55 + clamp01(difficulty.coverageAnticipation) * 0.45 + jitter(athlete, 'paRead', 0.1) > 0.62;

/** Updates a key timer in scratch; returns true once the key has been visible long enough to be read. */
const trackKey = (athlete: Athlete, kind: 'run' | 'pass', strength: KeyStrength, now: number, delay: number, subtleDelay: number, canReadSubtle: boolean): boolean => {
  const s = athlete.ai.scratch;
  const tKey = `${kind}KeyT`;
  const sKey = `${kind}KeyS`;
  if (strength === 0) {
    s[tKey] = -1;
    s[sKey] = 0;
    return false;
  }
  const started = s[tKey];
  if (started === undefined || started < 0) {
    s[tKey] = now;
    s[sKey] = strength;
  } else if (strength > (s[sKey] ?? 0)) {
    s[sKey] = strength;
  }
  const strong = (s[sKey] ?? 0) >= 2;
  if (!strong && !canReadSubtle) return false;
  return now - (s[tKey] ?? now) >= (strong ? delay : subtleDelay);
};

/**
 * Advances this athlete's run/pass recognition from the observable keys. Offensive athletes know their own
 * play immediately; defenders need the keys to persist for their reaction delay (subtle keys take
 * (1.9 - awareness) times longer and need SUBTLE_KEY_AWARENESS). Idempotent within a tick.
 */
export const recognisePlay = (athlete: Athlete, state: PlayState): void => {
  const ai = athlete.ai;
  if (athlete.side === 'offense') {
    const t = state.ctx.offensivePlay.type;
    ai.recognizedRun = t === 'run' || t === 'qbRun';
    ai.recognizedPass = t === 'pass' || t === 'playAction' || t === 'screen';
    return;
  }
  if (state.phase !== 'live') return;
  const now = state.time;
  const tc = tickCache(state);
  const difficulty = difficultyFor(state, athlete);
  const delay = reactionDelay(athlete, difficulty);
  const aw = f(athlete.attrs.awareness);
  const subtleDelay = delay * (1.9 - aw);
  let { run, pass } = tc.keys;
  const fakeActive = tc.paFakeAt >= 0 && (state.tick - tc.paFakeAt) * TICK_DT <= PLAY_ACTION_WINDOW;
  if (fakeActive && !seesThroughFake(athlete, difficulty)) {
    run = 2;
    pass = 0;
  }
  const runReady = trackKey(athlete, 'run', run, now, delay, subtleDelay, aw >= SUBTLE_KEY_AWARENESS);
  const passReady = trackKey(athlete, 'pass', pass, now, delay, subtleDelay, aw >= SUBTLE_KEY_AWARENESS);
  const runT = ai.scratch['runKeyT'] ?? -1;
  const passT = ai.scratch['passKeyT'] ?? -1;
  if (runReady && (!passReady || runT >= passT)) {
    ai.recognizedRun = true;
    ai.recognizedPass = false;
  } else if (passReady) {
    ai.recognizedPass = true;
    ai.recognizedRun = false;
  }
};

/** Everything an athlete knows this tick (see the module comment). */
export const perceive = (athlete: Athlete, state: PlayState): Perception => {
  recognisePlay(athlete, state);
  const tc = tickCache(state);
  const carrier = ballCarrier(state);
  const b = state.ball;
  const toucher = carrier ?? findAthlete(state, b.lastTouchedId);
  let nearestOpponent: Athlete | null = null;
  let nearestOpponentDist = Infinity;
  let nearestTeammate: Athlete | null = null;
  let teammateDist = Infinity;
  const threats: Athlete[] = [];
  for (const a of state.athletes) {
    if (!a.active || a.id === athlete.id) continue;
    const d = dist(a.pos, athlete.pos);
    if (a.side === athlete.side) {
      if (d < teammateDist) { teammateDist = d; nearestTeammate = a; }
    } else {
      if (d < nearestOpponentDist) { nearestOpponentDist = d; nearestOpponent = a; }
      if (d <= THREAT_RADIUS) threats.push(a);
    }
  }
  threats.sort((p, q) => dist(p.pos, athlete.pos) - dist(q.pos, athlete.pos));
  return {
    ballCarrier: carrier,
    possession: toucher ? toucher.side : null,
    ballInAir: b.phase === 'inAir',
    ballLoose: b.phase === 'loose',
    ballLanding: tc.landing,
    playIsRun: athlete.ai.recognizedRun,
    playIsPass: athlete.ai.recognizedPass,
    timeSinceSnap: timeSinceSnap(state),
    nearestOpponent,
    nearestOpponentDist,
    nearestTeammate,
    threats,
    anticipation: anticipation(athlete, difficultyFor(state, athlete)),
  };
};
