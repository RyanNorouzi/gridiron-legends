import { dist, dot, len, sub } from '@/core/vec2';
import { findAthlete } from '@/game/athlete';
import type { AthleteIntent, IntentDecider } from '@/game/engine-api';
import type { Athlete, PlayState } from '@/game/play-types';
import type { Gap } from '@/playbook/types';
import {
  clampPoint, commonIntent, defenderJitter, defenderNoise, depthOf, faceToward, gapX, holdIntent, judgement, localX, mem, perceive,
  presnapIntent, rf, seekIntent, engagedIntent, type Perception,
} from './defense-shared';
import { runFillIntent } from './run-defense';
import { tackleIntent } from './tackling';
import { difficultyFor } from '@/game/difficulty-sides';

/**
 * Pass rush: gap rushers, blitzers and contain players. Each rusher gets off on the snap after a reaction-scaled
 * delay (blitzers time it, linemen key the ball), attacks his lane (blitzers switch to a free neighbouring gap
 * when they read one), then works to the quarterback. Against a blocker he picks a move from the matchup: bull
 * rush on a strength edge, speed rush around the outside, swim/spin inside on agility; while engaged he sheds
 * toward the same side. Contain keeps outside leverage level with the quarterback and never runs past his depth
 * until the pocket collapses. A scrambling quarterback is pursued, a released pass gets hands up when the rusher
 * is on the passer, and a recognised run turns gap rushers into fillers and contain players into force players.
 * On some four-man rushes a tackle and end on the same side run a twist (the tackle crashes out into the offensive
 * tackle, the end loops inside behind him), which the protection has to pass off.
 */

/** Share of snaps on which a tackle-end pair on one side runs a twist (decided per play, the same for both men). */
export const TWIST_CHANCE = 0.14;
/** Seconds the looper waits for the crasher to occupy the blockers before he loops. */
export const TWIST_DELAY = 0.3;

export interface Twist {
  /** The inside man who crashes outside (the penetrator). */
  crasher: Athlete;
  /** The outside man who loops inside behind him. */
  looper: Athlete;
}

/**
 * The twist this rusher is part of, if any: a gap-rushing DT and the DE (gap or contain rusher) outside him on the
 * same side, on a four-man rush, picked per play by a deterministic roll keyed on the tackle and the snap situation.
 */
export const twistFor = (athlete: Athlete, state: PlayState): Twist | null => {
  if (athlete.position !== 'DT' && athlete.position !== 'DE') return null;
  const rushing = (a: Athlete): boolean => a.assignment.type === 'rushGap' || a.assignment.type === 'contain';
  if (!rushing(athlete)) return null;
  const side = rushSide(athlete, state);
  const mates = state.athletes.filter((a) => a.side === athlete.side && a.active && rushing(a) && rushSide(a, state) === side);
  const dt = mates.filter((a) => a.position === 'DT' && a.assignment.type === 'rushGap').sort((a, b) => Math.abs(localX(state, a.pos.x)) - Math.abs(localX(state, b.pos.x)))[0];
  const de = mates.filter((a) => a.position === 'DE').sort((a, b) => Math.abs(localX(state, b.pos.x)) - Math.abs(localX(state, a.pos.x)))[0];
  if (!dt || !de || (athlete !== dt && athlete !== de)) return null;
  const rushers = state.athletes.filter((a) => a.side === athlete.side && a.active && (a.assignment.type === 'rushGap' || a.assignment.type === 'blitz' || a.assignment.type === 'contain')).length;
  if (rushers > 4) return null;
  const key = `twist:${state.ctx.playIndex}:${state.ctx.ballOn}:${state.ctx.down}:${state.ctx.clockRemaining}`;
  return defenderNoise(dt, key) < TWIST_CHANCE ? { crasher: dt, looper: de } : null;
};

export type RushMode = 'gap' | 'blitz' | 'contain';
type RushMove = 'bull' | 'speed' | 'swim' | 'spin';

const MOVES: RushMove[] = ['bull', 'speed', 'swim', 'spin'];
const GAP_ORDER: Gap[] = ['D-left', 'C-left', 'B-left', 'A-left', 'A-right', 'B-right', 'C-right', 'D-right'];

const assignedGap = (athlete: Athlete): Gap | undefined => ('gap' in athlete.assignment ? athlete.assignment.gap : undefined);

/** Play-local side of the ball this rusher lines up on (+1 = offense's right). */
export const rushSide = (athlete: Athlete, state: PlayState): number => (localX(state, athlete.pos.x) >= 0 ? 1 : -1);

/** Number of blockers standing in a lane at absolute x. */
const laneBlockers = (state: PlayState, p: Perception, x: number): number => {
  let n = 0;
  for (const l of p.view.linemen) {
    const depth = depthOf(state, l.pos);
    if (Math.abs(l.pos.x - x) <= 1.3 && depth >= -3.5 && depth <= 1) n++;
  }
  return n;
};

/** Absolute x of the lane this rusher attacks (memorised for half a second so he commits). */
export const chooseLane = (athlete: Athlete, state: PlayState, p: Perception, mode: RushMode): number => {
  const s = athlete.ai.scratch;
  const now = state.time;
  if (mem(s, 'laneAt', -1) >= 0 && now - mem(s, 'laneAt', -1) < 0.5) return mem(s, 'laneX', athlete.pos.x);
  const dir = state.ctx.direction;
  const gap = assignedGap(athlete);
  const twist = mode !== 'blitz' && p.t < 1.4 ? twistFor(athlete, state) : null;
  const crashGap = twist ? assignedGap(twist.crasher) : undefined;
  let x: number;
  if (twist && crashGap) {
    // The crasher slants out into the offensive tackle (the end's rush lane); the looper comes under, into the gap
    // the crasher vacated.
    const side = rushSide(athlete, state);
    x = twist.crasher === athlete ? state.ctx.ballX + dir * side * 3.3 : gapX(state, crashGap);
  } else if (mode === 'contain' || !gap) {
    const side = rushSide(athlete, state);
    let widest = 2.3;
    for (const l of p.view.linemen) {
      const lx = localX(state, l.pos.x);
      if (Math.sign(lx) === side && Math.abs(lx) > widest && depthOf(state, l.pos) > -3) widest = Math.abs(lx);
    }
    x = state.ctx.ballX + dir * side * (widest + 1.6);
  } else {
    x = gapX(state, gap);
    if (mode === 'blitz' && p.t < 1.2 && laneBlockers(state, p, x) > 0 && judgement(athlete, difficultyFor(state, athlete).pursuitQuality, 'lane') > 0.5) {
      const idx = GAP_ORDER.indexOf(gap);
      for (const n of [idx - 1, idx + 1]) {
        const g = GAP_ORDER[n];
        if (!g) continue;
        const nx = gapX(state, g);
        if (laneBlockers(state, p, nx) === 0) { x = nx; break; }
      }
    }
  }
  s.laneX = x;
  s.laneAt = now;
  return x;
};

/** Pick a move against a blocker from the matchup (memorised for 0.7 s). */
export const chooseMove = (athlete: Athlete, blocker: Athlete, state: PlayState, mode: RushMode): RushMove => {
  const s = athlete.ai.scratch;
  const now = state.time;
  if (mem(s, 'moveAt', -1) >= 0 && now - mem(s, 'moveAt', -1) < 0.7) return MOVES[mem(s, 'move', 0)] ?? 'bull';
  const a = athlete.attrs;
  const b = blocker.attrs;
  const scores: Record<RushMove, number> = {
    bull: rf(a.strength) - rf(b.strength) + 0.12 + defenderJitter(athlete, 'bull', 0.1),
    speed: rf(a.speed) - rf(b.agility) + (mode === 'contain' ? 0.15 : 0) + defenderJitter(athlete, 'speedRush', 0.1),
    swim: 0.5 * rf(a.agility) + 0.5 * rf(a.passRush) - rf(b.blocking) + defenderJitter(athlete, 'swim', 0.1),
    spin: 0.6 * rf(a.agility) + 0.4 * rf(a.passRush) - rf(b.blocking) - 0.05 + defenderJitter(athlete, 'spin', 0.1),
  };
  let best: RushMove = 'bull';
  for (const m of MOVES) if (scores[m] > scores[best]) best = m;
  s.move = MOVES.indexOf(best);
  s.moveAt = now;
  return best;
};

/** Lateral offset (absolute x) a move adds relative to the blocker. */
const moveOffset = (athlete: Athlete, state: PlayState, move: RushMove): number => {
  const dir = state.ctx.direction;
  const side = rushSide(athlete, state);
  switch (move) {
    case 'bull': return 0;
    case 'speed': return dir * side * 1.6;
    case 'swim': return -dir * side * 1.4;
    case 'spin': {
      const phase = Math.floor((state.time - mem(athlete.ai.scratch, 'moveAt', state.time)) / 0.35) % 2;
      return (phase === 0 ? -1 : 1) * dir * side * 1.4;
    }
  }
};

/** Seconds a rusher who has just beaten a blocker runs past him instead of setting up another move on him. */
export const PAST_BLOCKER_SECONDS = 1.2;

/**
 * Remembers the blocker a rusher just beat (he comes off the block 'shedding'), so he finishes to the passer instead
 * of arcing around the man he already beat.
 */
const noteBeaten = (athlete: Athlete, p: Perception, now: number): void => {
  if (athlete.state !== 'shedding') return;
  let best: Athlete | null = null;
  let bd = 2;
  for (const b of p.view.linemen) {
    const d = dist(b.pos, athlete.pos);
    if (d < bd) { bd = d; best = b; }
  }
  if (best) athlete.ai.scratch[`beat:${best.id}`] = now;
};

/** Nearest blocker standing between the rusher and his aim (never the man he just beat). */
const blockerInPath = (athlete: Athlete, p: Perception, aim: { x: number; y: number }, now: number): Athlete | null => {
  const toAim = sub(aim, athlete.pos);
  const la = len(toAim) || 1;
  let best: Athlete | null = null;
  let bd = 2.2;
  for (const b of p.view.linemen) {
    if (b.engagedWith && b.engagedWith !== athlete.id) continue;
    if (now - (athlete.ai.scratch[`beat:${b.id}`] ?? -Infinity) < PAST_BLOCKER_SECONDS) continue;
    const to = sub(b.pos, athlete.pos);
    const d = len(to);
    if (d >= bd || d < 1e-6 || dot(to, toAim) / (d * la) < 0.3) continue;
    best = b;
    bd = d;
  }
  return best;
};

/** Seconds after the snap before this rusher moves: linemen key the ball, blitzers time the snap. */
export const getOffDelay = (p: Perception, mode: RushMode): number => p.reaction * (mode === 'blitz' ? 0.6 : 0.35);

const scrambling = (qb: Athlete, state: PlayState, p: Perception): boolean =>
  p.view.qbDepth > -0.5 || qb.state === 'scrambling' || (Math.abs(qb.vel.x) > 4 && Math.abs(localX(state, qb.pos.x)) > 4);

/** Rush intent for one mode. */
export const rushIntent = (athlete: Athlete, state: PlayState, p: Perception, mode: RushMode): AthleteIntent => {
  const dir = state.ctx.direction;
  const view = p.view;
  const qb = view.qb;
  if (state.phase !== 'live') return presnapIntent(athlete, state, mode);
  const c = p.carrier;
  const outside = mode === 'contain' ? 'outside' : 'inside';
  if (c && c.position !== 'QB') {
    if (p.recognizedRun && mode !== 'contain' && state.ball.kind !== 'pass') return runFillIntent(athlete, state, p, assignedGap(athlete));
    return tackleIntent(athlete, c, state, { leverage: outside });
  }
  if (c && c.position === 'QB' && scrambling(c, state, p)) return tackleIntent(athlete, c, state, { leverage: mode === 'contain' ? 'outside' : 'none' });
  const ball = state.ball;
  if (view.ballInAir) {
    const thrower = findAthlete(state, ball.throwerId);
    if (thrower && state.tick - ball.launchTick <= 5 && dist(athlete.pos, thrower.pos) <= 2) {
      const i = seekIntent(athlete, thrower.pos, { effort: 0.3, debug: 'hands up' });
      i.action = 'jump';
      return i;
    }
    if (p.passSeen) return seekIntent(athlete, clampPoint(p.landing ?? ball.pos, 0.3), { sprint: true, effort: 0.85, debug: 'rally' });
  }
  const faceQb = qb ? faceToward(athlete.pos, qb.pos) : faceToward(athlete.pos, ball.pos);
  const looping = mode !== 'blitz' && twistFor(athlete, state)?.looper === athlete;
  if (p.t < getOffDelay(p, mode) + (looping ? TWIST_DELAY : 0)) return holdIntent(faceQb, looping ? 'twist: wait' : `${mode} get-off`);
  const laneX = chooseLane(athlete, state, p, mode);
  const inBackfield = depthOf(state, athlete.pos) < -0.8;
  let aim: { x: number; y: number };
  let label: string;
  if (!inBackfield) {
    aim = { x: laneX, y: state.losY - dir * 1.2 };
    label = `${mode} attack lane`;
  } else if (qb) {
    // Contain means keeping the QB inside, not hovering wide of him: the edge man rushes his outside shoulder (so he
    // either meets the tackle or gets home) and turns straight at him once the pocket starts to close.
    const pocketCollapsing = p.t > 1.6 || dist(athlete.pos, qb.pos) < 3;
    if (mode === 'contain' && !pocketCollapsing && !looping) {
      aim = { x: qb.pos.x + dir * rushSide(athlete, state) * 0.8, y: qb.pos.y + dir * 0.3 };
      label = 'contain';
    } else {
      aim = { x: qb.pos.x + qb.vel.x * 0.25, y: qb.pos.y + qb.vel.y * 0.25 };
      label = `${mode} to qb`;
    }
  } else {
    aim = { x: laneX, y: state.losY - dir * 6 };
    label = `${mode} backfield`;
  }
  noteBeaten(athlete, p, state.time);
  const blocker = blockerInPath(athlete, p, aim, state.time);
  if (blocker) {
    const move = chooseMove(athlete, blocker, state, mode);
    const offset = moveOffset(athlete, state, move);
    if (offset !== 0) aim = { x: blocker.pos.x + offset, y: inBackfield ? aim.y : blocker.pos.y - dir * 0.8 };
    label = `${label} / ${move} vs ${blocker.role}`;
  }
  aim = clampPoint(aim, 0.3);
  if (athlete.state === 'engaged') return engagedIntent(athlete, state, p, aim, label);
  if (qb && dist(athlete.pos, qb.pos) <= 2.4 && c === qb) return tackleIntent(athlete, qb, state, { leverage: mode === 'contain' ? 'outside' : 'none' });
  return seekIntent(athlete, aim, { sprint: true, stopRadius: 0.2, debug: label });
};

const decider = (mode: RushMode): IntentDecider => (athlete, state) => {
  const p = perceive(athlete, state);
  const common = commonIntent(athlete, state, p.view);
  if (common) return common;
  return rushIntent(athlete, state, p, mode);
};

/** 'defense:rushGap' decider. */
export const decideRushGap: IntentDecider = decider('gap');
/** 'defense:blitz' decider. */
export const decideBlitz: IntentDecider = decider('blitz');
/** 'defense:contain' decider. */
export const decideContain: IntentDecider = decider('contain');
