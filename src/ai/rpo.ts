import { dist, dot, len, normalize, sub, type Vec2 } from '@/core/vec2';
import type { AthleteId } from '@/game/play-events';
import type { Athlete, PlayState } from '@/game/play-types';
import { gapLocalX, gapPoint } from './blocking';
import { blendQuality, canPlay, f, opponentsOf, toLocal } from './route-running';
import { difficultyFor } from '@/game/difficulty-sides';

/**
 * Run-pass-option and zone-read logic shared by qb.ts. The QB counts the box, finds the read key (the
 * unblocked backside end on a zone read, the conflict linebacker on an RPO) and decides at the mesh whether to
 * give, keep or throw. Awareness and the difficulty knob decide how often the key is misread; the decision is
 * made once per play and cached in the QB's scratch memory.
 */

export type RpoChoice = 'give' | 'keep' | 'throw';

export interface RpoRead {
  decision: RpoChoice;
  /** Athlete id of the defender being read (null when nobody fits). */
  readKey: AthleteId | null;
  boxCount: number;
  blockers: number;
  /** The key attacked the run (crashed / filled). */
  keyCrashing: boolean;
  /** The QB misread the key this play. */
  misread: boolean;
  reason: string;
}

/** Defenders in the box: within 5.5 yd of the ball laterally and no deeper than 6 yd. */
export const boxCount = (state: PlayState): number => {
  let n = 0;
  for (const d of state.athletes) {
    if (d.side !== 'defense' || !canPlay(d)) continue;
    const l = toLocal(d.pos, state);
    if (Math.abs(l.x) <= 5.5 && l.y > -2 && l.y <= 6) n++;
  }
  return n;
};

/** Offensive players assigned to block the run. */
export const runBlockerCount = (state: PlayState): number =>
  state.athletes.filter((a) => a.side === 'offense' && a.active && (a.assignment.type === 'runBlock' || a.assignment.type === 'leadBlock')).length;

/** True when `key` is moving toward `toward` faster than 1 yd/s (or is already within 1.5 yd of it). */
export const keyCrashes = (key: Athlete, toward: Vec2): boolean => {
  const rel = sub(toward, key.pos);
  const d = len(rel);
  if (d < 1.5) return true;
  return dot(normalize(rel), key.vel) > 1.0;
};

/**
 * The defender the QB reads: on a zone read the widest backside defender at the line (the unblocked end); on an
 * RPO the closest second-level defender on the pass side (the conflict linebacker / nickel).
 */
export const readKeyFor = (qb: Athlete, state: PlayState): Athlete | null => {
  const play = state.ctx.offensivePlay;
  const gx = play.runGap ? gapLocalX(play.runGap) : 0;
  const runSide = Math.sign(gx) || 1;
  const opps = opponentsOf(qb, state).filter(canPlay);
  if (play.type === 'qbRun') {
    let best: Athlete | null = null;
    let bx = 1.9;
    for (const d of opps) {
      const l = toLocal(d.pos, state);
      if (l.y > 3.5 || Math.sign(l.x) === runSide || Math.abs(l.x) > 8) continue;
      if (Math.abs(l.x) > bx) { bx = Math.abs(l.x); best = d; }
    }
    if (best) return best;
    return opps.filter((d) => { const l = toLocal(d.pos, state); return Math.sign(l.x) !== runSide && l.y <= 9; })
      .sort((a, b) => dist(a.pos, qb.pos) - dist(b.pos, qb.pos))[0] ?? null;
  }
  const primary = state.athletes.find((a) => a.side === 'offense' && a.role === play.primary) ?? null;
  const passSide = primary ? Math.sign(toLocal(primary.pos, state).x) || -runSide : -runSide;
  let best: Athlete | null = null;
  let bx = Infinity;
  for (const d of opps) {
    const l = toLocal(d.pos, state);
    if (l.y < 2 || l.y > 10 || Math.sign(l.x) !== passSide || Math.abs(l.x) < 1) continue;
    if (Math.abs(l.x) < bx) { bx = Math.abs(l.x); best = d; }
  }
  if (best) return best;
  return primary ? opps.sort((a, b) => dist(a.pos, primary.pos) - dist(b.pos, primary.pos))[0] ?? null : null;
};

/** True when `key` is on top of the back or sliding inside toward his path faster than 1 yd/s. */
const squeezes = (key: Athlete, back: Athlete, state: PlayState): boolean => {
  if (dist(key.pos, back.pos) < 1.5) return true;
  const k = toLocal(key.pos, state);
  const lateralVel = toLocal({ x: key.pos.x + key.vel.x, y: key.pos.y + key.vel.y }, state).x - k.x;
  return Math.sign(toLocal(back.pos, state).x - k.x) * lateralVel > 1.0;
};

const CHOICES: readonly RpoChoice[] = ['give', 'keep', 'throw'];

/**
 * Decide give / keep / throw at the mesh. Numbers first (a box the blockers cannot cover favours the pass),
 * then the key's reaction; a mobile QB keeps when the run-side edge crashes inside. Cached per play.
 */
export const rpoDecision = (qb: Athlete, state: PlayState): RpoRead => {
  const sc = qb.ai.scratch;
  const play = state.ctx.offensivePlay;
  const box = boxCount(state);
  const blockers = runBlockerCount(state);
  const key = readKeyFor(qb, state);
  if (sc.rpoDecided === 1) {
    const idx = sc.rpoKeyIdx ?? -1;
    const cachedKey = idx >= 0 ? state.athletes[idx] : undefined;
    return {
      decision: CHOICES[sc.rpoChoice ?? 0] ?? 'give', readKey: cachedKey ? cachedKey.id : null, boxCount: box, blockers,
      keyCrashing: sc.rpoCrash === 1, misread: sc.rpoMisread === 1, reason: 'cached',
    };
  }
  const q = blendQuality(qb, difficultyFor(state, qb).qbDecisionQuality);
  const misread = state.ctx.rng.chance((1 - q) * 0.35);
  const rb = play.fakeTo ? state.athletes.find((a) => a.side === 'offense' && a.role === play.fakeTo) ?? null : null;
  const gapAim = play.runGap ? gapPoint(play.runGap, state, 0.5) : { x: state.ctx.ballX, y: state.losY };
  let decision: RpoChoice;
  let crashing = false;
  let reason: string;
  if (play.type === 'qbRun') {
    // The end crashes when he squeezes down the line on the back; an end coming straight upfield (a contain rush at
    // the quarterback) has taken the keep away, and the ball goes to the back.
    crashing = key !== null && (rb !== null ? squeezes(key, rb, state) : keyCrashes(key, gapAim));
    decision = crashing ? 'keep' : 'give';
    reason = crashing ? 'end crashed: keep' : 'end stayed home: give';
    if (misread) { decision = decision === 'keep' ? 'give' : 'keep'; reason = `misread (${reason})`; }
  } else {
    const numbers = box - blockers;
    crashing = key !== null && keyCrashes(key, gapAim);
    if (numbers >= 1) { decision = 'throw'; reason = `box +${numbers}: throw`; }
    else if (crashing) { decision = 'throw'; reason = 'key filled: throw'; }
    else { decision = 'give'; reason = 'light box, key dropped: give'; }
    if (decision === 'give' && f(qb.attrs.speed) >= 0.6) {
      const gx = play.runGap ? gapLocalX(play.runGap) : 0;
      const runSide = Math.sign(gx) || 1;
      const edge = opponentsOf(qb, state).filter((d) => { const l = toLocal(d.pos, state); return canPlay(d) && l.y <= 3.5 && Math.sign(l.x) === runSide && Math.abs(l.x) >= 2; })
        .sort((a, b) => Math.abs(toLocal(b.pos, state).x) - Math.abs(toLocal(a.pos, state).x))[0];
      if (edge && rb && keyCrashes(edge, rb.pos)) { decision = 'keep'; reason = 'edge crashed on the back: keep'; }
    }
    if (misread) { decision = decision === 'give' ? 'throw' : 'give'; reason = `misread (${reason})`; }
  }
  sc.rpoDecided = 1;
  sc.rpoChoice = CHOICES.indexOf(decision);
  sc.rpoKeyIdx = key ? state.athletes.indexOf(key) : -1;
  sc.rpoCrash = crashing ? 1 : 0;
  sc.rpoMisread = misread ? 1 : 0;
  return { decision, readKey: key ? key.id : null, boxCount: box, blockers, keyCrashing: crashing, misread, reason };
};
