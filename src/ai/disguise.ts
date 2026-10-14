import { clamp01 } from '@/core/math';
import { dist, type Vec2 } from '@/core/vec2';
import type { AthleteIntent } from '@/game/engine-api';
import type { Athlete, PlayState } from '@/game/play-types';
import { FIELD_WIDTH, otherSide } from '@/game/types';
import type { CoverageShell, DefensivePlay } from '@/playbook/types';
import { coverageEdge, disguiseHoldScale, disguiseReadShift } from './coverage-iq';
import { faceToward, holdIntent, seekIntent } from './defense-shared';
import { noiseFor } from './variance';
import { difficultyFor } from '@/game/difficulty-sides';

/**
 * Pre-snap disguise. An AI defense may show the offense the opposite safety shell from the one it called: a two-high
 * coverage walks a safety down into the box to look single-high, a single-high coverage (or a safety blitz / run
 * fill) splits both safeties to look two-high. At the snap every defender plays his real assignment, so the
 * disguised safeties rotate to their landmarks. How often a defense disguises is a decision (difficulty
 * playcallingIq: rarely at rookie, more than half the snaps at legend); the choice is a deterministic hash of the
 * play's rng seed, so it never consumes a die. A quarterback reads through the look with his decision quality: a
 * fooled one audibles on the shown shell and is a beat late on his first read while the coverage rotates.
 * Only AI-controlled defenses disguise (a human's own call is lined up as called), only on scrimmage snaps, and
 * only safeties who do not carry a man assignment (a man defender has to align on his man).
 */

export type ShellLook = 'twoHigh' | 'singleHigh';

export interface DisguisePlan {
  /** The defensive call the plan was made for (a defensive audible re-plans). */
  playId: string;
  disguised: boolean;
  /** The shell the defense shows before the snap. */
  shown: ShellLook;
  /** The shell it really plays. */
  real: ShellLook | 'zero';
  /** Pre-snap spots (absolute field) for the disguising safeties, by athlete id. */
  spots: Record<string, Vec2>;
  /** Seconds a fooled quarterback loses on his first read (ROTATION_READ_DELAY scaled by how late the defense
   *  rotates: disguise quality, a decision of the defense's difficulty). 0 for an honest look. Optional; additive. */
  rotationDelay?: number;
  /** Shift of the quarterback's chance to read through the look (negative = harder to read). Optional; additive. */
  readShift?: number;
}

/** Yards a disguising safety will stray from his alignment (the rotation at the snap has to be makeable). */
export const MAX_DISGUISE_SHIFT = 6;
/** Seconds a fooled quarterback loses on his first read while the shell rotates. */
export const ROTATION_READ_DELAY = 0.2;

const plans = new WeakMap<PlayState, DisguisePlan>();

/** Shell class of a coverage. */
export const shellOf = (coverage: CoverageShell): ShellLook | 'zero' =>
  coverage === 'cover2' || coverage === 'cover4' || coverage === 'cover6' ? 'twoHigh' : coverage === 'cover0' ? 'zero' : 'singleHigh';

/** Share of snaps an AI defense disguises its shell: about 0.1 rookie, 0.27 pro, 0.44 all-pro, 0.57 legend. */
export const disguiseRate = (playcallingIq: number): number => clamp01(0.85 * playcallingIq - 0.2);

const isSafety = (a: Athlete): boolean => a.side === 'defense' && a.active && (a.position === 'FS' || a.position === 'SS');

const toField = (state: PlayState, local: Vec2): Vec2 => ({
  x: Math.min(FIELD_WIDTH - 1, Math.max(1, state.ctx.ballX + state.ctx.direction * local.x)),
  y: state.losY + state.ctx.direction * local.y,
});

const localOf = (state: PlayState, p: Vec2): Vec2 => ({ x: state.ctx.direction * (p.x - state.ctx.ballX), y: state.ctx.direction * (p.y - state.losY) });

/** Moves `from` toward `to` by at most MAX_DISGUISE_SHIFT yards. */
const capShift = (from: Vec2, to: Vec2): Vec2 => {
  const d = dist(from, to);
  if (d <= MAX_DISGUISE_SHIFT) return to;
  const k = MAX_DISGUISE_SHIFT / d;
  return { x: from.x + (to.x - from.x) * k, y: from.y + (to.y - from.y) * k };
};

const eligibleCall = (state: PlayState, play: DefensivePlay): boolean => {
  const special = state.ctx.special;
  if (special !== 'none' && special !== 'twoPoint') return false;
  if (state.ctx.controllers[otherSide(state.ctx.offense)] !== 'ai') return false;
  return !play.tags.includes('prevent') && !play.tags.includes('goalLine') && play.formation !== 'goalLine';
};

const buildPlan = (state: PlayState): DisguisePlan => {
  const play = state.ctx.defensivePlay;
  const real = shellOf(play.coverage);
  const honest: DisguisePlan = { playId: play.id, disguised: false, shown: real === 'twoHigh' ? 'twoHigh' : 'singleHigh', real, spots: {} };
  if (!eligibleCall(state, play)) return honest;
  const safeties = state.athletes.filter(isSafety);
  if (safeties.length !== 2 || safeties.some((s) => s.assignment.type === 'manCover')) return honest;
  if (noiseFor(`${state.ctx.rng.seed}`, `disguise:${play.id}`) >= disguiseRate(difficultyFor(state, otherSide(state.ctx.offense)).playcallingIq)) return honest;
  const [a, b] = safeties as [Athlete, Athlete];
  const la = localOf(state, a.pos);
  const lb = localOf(state, b.pos);
  const spots: Record<string, Vec2> = {};
  if (real === 'twoHigh') {
    // Show single-high: the safety nearer the strong (right-hand, by alignment) side rolls down, the other goes to the middle.
    const [down, deep] = lb.x >= la.x ? [b, a] : [a, b];
    const side = Math.sign(localOf(state, down.pos).x) || 1;
    spots[down.id] = capShift(down.pos, toField(state, { x: side * 5.5, y: 8 }));
    spots[deep.id] = capShift(deep.pos, toField(state, { x: 0, y: 13 }));
  } else {
    // Show two-high: split the safeties over the hashes.
    const [left, right] = la.x <= lb.x ? [a, b] : [b, a];
    spots[left.id] = capShift(left.pos, toField(state, { x: -6.5, y: 12.5 }));
    spots[right.id] = capShift(right.pos, toField(state, { x: 6.5, y: 12.5 }));
  }
  // Disguise quality (coverage-iq) is the defense's decision, fixed when a defender makes the plan.
  const e = coverageEdge(difficultyFor(state, otherSide(state.ctx.offense)));
  return {
    playId: play.id, disguised: true, shown: real === 'twoHigh' ? 'singleHigh' : 'twoHigh', real, spots,
    rotationDelay: ROTATION_READ_DELAY * disguiseHoldScale(e), readShift: disguiseReadShift(e),
  };
};

/** The disguise plan for this snap (made on first use by a defender, re-made after a defensive audible). */
export const disguisePlan = (state: PlayState): DisguisePlan => {
  const cached = plans.get(state);
  if (cached && cached.playId === state.ctx.defensivePlay.id) return cached;
  const plan = buildPlan(state);
  plans.set(state, plan);
  return plan;
};

/** The plan if a defender has made one this snap (the offense never makes it for the defense). */
export const peekDisguise = (state: PlayState): DisguisePlan | null => {
  const cached = plans.get(state);
  return cached && cached.playId === state.ctx.defensivePlay.id ? cached : null;
};

/** Pre-snap intent for a disguising safety (walk to the shown spot, eyes on the ball); null for everyone else. */
export const disguiseIntent = (athlete: Athlete, state: PlayState): AthleteIntent | null => {
  if (state.phase !== 'presnap' || athlete.side !== 'defense' || athlete.controlled) return null;
  const spot = disguisePlan(state).spots[athlete.id];
  if (!spot) return null;
  const face = faceToward(athlete.pos, state.ball.pos);
  if (dist(athlete.pos, spot) < 0.4) return holdIntent(face, 'disguise: show');
  return seekIntent(athlete, spot, { effort: 0.6, slowRadius: 1.5, stopRadius: 0.3, locomotion: 'strafe', face, debug: 'disguise: walk' });
};

/** The defensive call as a quarterback who took the shown shell at face value sees it. */
export const shownCall = (play: DefensivePlay, plan: DisguisePlan): DefensivePlay => {
  if (!plan.disguised) return play;
  return plan.shown === 'twoHigh'
    ? { ...play, coverage: 'cover2', family: 'zone', blitz: 'none' }
    : { ...play, coverage: 'cover3', family: 'zone', blitz: 'none' };
};

/**
 * True when this quarterback is fooled by the disguise on this snap: with probability 1 - quality (his read of the
 * rotation, shifted by the disguise's quality), hashed from the play seed so the read costs no die.
 */
export const fooledByDisguise = (state: PlayState, qbId: string, quality: number): boolean => {
  const plan = peekDisguise(state);
  if (!plan || !plan.disguised) return false;
  return noiseFor(`${state.ctx.rng.seed}`, `read:${qbId}`) >= clamp01(quality + (plan.readShift ?? 0));
};

/** Seconds a fooled quarterback loses on his first read against this snap's disguise (0 when honest). */
export const rotationReadDelay = (state: PlayState): number => {
  const plan = peekDisguise(state);
  return plan && plan.disguised ? plan.rotationDelay ?? ROTATION_READ_DELAY : 0;
};
