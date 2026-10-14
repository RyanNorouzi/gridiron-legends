/**
 * Pocket measurement harness (tests only): runs real AI-vs-AI snaps through the live PlayEngine with a passer who
 * takes the called drop and then holds the ball (no throw, no scramble), and records, per snap, when the first
 * rusher gets close (visible pressure), when the first defender gets his hands on the passer, and when the sack is
 * recorded. Shared by the pocket tests.
 */
import { decideIntent } from '@/ai/index';
import { dropbackDepth } from '@/ai/qb';
import { routeAlignment, steerTo, timeSinceSnap, toField, toLocal } from '@/ai/route-running';
import { dist } from '@/core/vec2';
import type { IntentDecider } from '@/game/engine-api';
import { createPlayEngine } from '@/game/play-engine';
import type { Athlete, UserPlayInput } from '@/game/play-types';
import { vec2 } from '@/core/vec2';
import type { AttributeSet } from '@/players/types';
import { buildCtx, type MeasureEnv } from '../../integration/measure';

/** Seconds a snap is watched; a pocket still standing then is recorded as CAP. */
export const POCKET_CAP = 9;

/** The real AI everywhere; the passer takes the called drop (at the snap depth for quick game) and holds the ball. */
export const holdingQb: IntentDecider = (a, s, dt) => {
  if (a.position === 'QB' && a.assignment.type === 'qb') {
    const align = routeAlignment(a, s);
    if (a.hasBall && s.phase === 'live') {
      const depth = dropbackDepth(s.ctx.offensivePlay, -align.y, s.ctx.ballOn);
      const set = toField({ x: align.x, y: -depth }, s);
      if (-toLocal(a.pos, s).y < depth - 0.3) {
        const intent = steerTo(a.pos, set, 1, false, 'drop');
        intent.locomotion = 'backpedal';
        intent.face = s.ctx.direction === 1 ? Math.PI / 2 : -Math.PI / 2;
        return intent;
      }
      // Keep the feet alive (a passer standing dead still for 5 s is whistled down by the stall safety net).
      const T = timeSinceSnap(s);
      const sway = Math.floor(T / 0.4) % 2 === 0 ? 1 : -1;
      const intent = steerTo(a.pos, toField({ x: align.x + sway * 0.6, y: -depth }, s), 0.15, false, 'hold');
      intent.locomotion = 'strafe';
      intent.face = s.ctx.direction === 1 ? Math.PI / 2 : -Math.PI / 2;
      return intent;
    }
  }
  return decideIntent(a, s, dt);
};

/** The trench skills a rating test moves (blocking and rushing technique, power, balance, feet, recognition). */
export const LINE_KEYS: (keyof AttributeSet)[] = ['blocking', 'strength', 'balance', 'passRush', 'agility', 'awareness'];
/** Straight-line athleticism, equalised separately (`athletic`) so a rating test is not a foot race. */
export const ATHLETIC_KEYS: (keyof AttributeSet)[] = ['speed', 'acceleration'];

export interface PocketSnap {
  /** First rusher (blocked or not) within PRESSURE_YARDS of the passer: the pocket is closing on him. */
  pressure: number;
  /** First defender with hands on the passer (wrapping him, or the passer wrapped / tackled). */
  contact: number;
  /** The sack event (POCKET_CAP when none). */
  sack: number;
  /** The first man to get his hands on the passer was never blocked. */
  unblocked: boolean;
  rushers: number;
  /** First time a rusher beat a block (a 'blockShed'). */
  beat: number;
}

export const PRESSURE_YARDS = 2;

export interface PocketSpec {
  off: string;
  def: string;
  seed: string;
  teamIndex?: number;
  /** Equalise (or skew) line ratings: offense athletes get `ol`, defense `dl`, on LINE_KEYS. */
  ol?: number;
  dl?: number;
  /** Speed and acceleration for every athlete on both sides. */
  athletic?: number;
  decider?: IntentDecider;
  /** A human plays the quarterback and does nothing but snap it (the automatic drop is all he gets). */
  humanQb?: boolean;
}

/** A neutral controller input (nothing pressed), with overrides. */
export const neutralInput = (o: Partial<UserPlayInput> = {}): UserPlayInput => ({
  move: vec2(0, 0), sprint: false, strafe: false, throwTo: null, throwType: null, juke: false, spin: false, stiffArm: false,
  hurdle: false, dive: false, slide: false, throwAway: false, snap: false, audible: null, defAudible: null, switchPlayer: false,
  switchToId: null, hitStick: false, strip: false, tackle: false, jumpSwat: false, kickPress: false, fairCatch: false, pitch: false, ...o,
});

const RUSH_TYPES = new Set(['rushGap', 'contain', 'blitz']);

/** One snap measured. */
export const measurePocket = (env: MeasureEnv, spec: PocketSpec): PocketSnap => {
  const ctx = buildCtx(env, { off: spec.off, def: spec.def, teamIndex: spec.teamIndex ?? 0, seed: spec.seed });
  if (spec.humanQb) {
    ctx.controllers = { home: 'human', away: 'ai' };
    ctx.userSide = 'home';
  }
  const play = createPlayEngine(ctx, { registries: env.registries, decider: spec.decider ?? holdingQb });
  const setR = (a: Athlete, v: number | undefined): void => { if (v !== undefined) for (const k of LINE_KEYS) a.baseAttrs[k] = v; };
  for (const a of play.state.athletes) {
    setR(a, a.side === 'offense' ? spec.ol : spec.dl);
    if (spec.athletic !== undefined) for (const k of ATHLETIC_KEYS) a.baseAttrs[k] = spec.athletic;
  }
  if (spec.humanQb) {
    const qb = play.state.athletes.find((a) => a.side === 'offense' && a.assignment.type === 'qb');
    if (qb) {
      for (const a of play.state.athletes) if (a.teamSide === 'home') a.controlled = a.id === qb.id;
      play.state.controlledIds.home = qb.id;
      play.state.controlledId = qb.id;
    }
  }
  const out: PocketSnap = { pressure: POCKET_CAP, contact: POCKET_CAP, sack: POCKET_CAP, unblocked: false, rushers: 0, beat: POCKET_CAP };
  out.rushers = play.state.athletes.filter((a) => a.side === 'defense' && RUSH_TYPES.has(a.assignment.type)).length;
  const touched = new Set<string>();
  try {
    const outcome = play.run((s) => {
      const T = timeSinceSnap(s);
      if (s.phase === 'live' && T <= POCKET_CAP) {
        for (const d of s.athletes) if (d.side === 'defense' && d.engagedWith) touched.add(d.id);
        for (const e of s.events) if (e.type === 'blockShed' || e.type === 'pancake') touched.add(e.defender);
        const qb = s.athletes.find((a) => a.position === 'QB');
        if (out.beat === POCKET_CAP && s.events.some((e) => e.type === 'blockShed')) out.beat = T;
        if (qb && T > 0.2) {
          if (out.pressure === POCKET_CAP && s.athletes.some((d) => d.side === 'defense' && d.active && d.state !== 'down' && dist(d.pos, qb.pos) < PRESSURE_YARDS)) out.pressure = T;
          if (out.contact === POCKET_CAP) {
            const on = s.athletes.find((d) => d.side === 'defense' && d.active && dist(d.pos, qb.pos) < 1.3
              && (d.state === 'wrapping' || qb.state === 'wrapped' || qb.state === 'tackled' || qb.state === 'falling'));
            if (on) { out.contact = T; out.unblocked = !touched.has(on.id); }
          }
        }
      }
      return spec.humanQb ? { home: neutralInput({ snap: s.phase === 'presnap' }) } : {};
    }, 60 * (POCKET_CAP + 3));
    const snap = outcome.events.find((e) => e.type === 'snap');
    const sack = outcome.events.find((e) => e.type === 'sack');
    if (snap && sack && outcome.result === 'sack') out.sack = Math.min(POCKET_CAP, (sack.tick - snap.tick) / 60);
  } catch {
    // Tick cap: the pocket never broke.
  }
  if (out.sack < out.contact) out.contact = out.sack;
  return out;
};

export const quantile = (xs: readonly number[], q: number): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.floor(q * (s.length - 1) + 0.5)))] ?? 0;
};

export interface PocketSummary { n: number; median: number; q25: number; q75: number; under2: number; capped: number }

export const summarize = (xs: readonly number[]): PocketSummary => ({
  n: xs.length, median: quantile(xs, 0.5), q25: quantile(xs, 0.25), q75: quantile(xs, 0.75),
  under2: xs.filter((x) => x < 2).length / Math.max(1, xs.length), capped: xs.filter((x) => x >= POCKET_CAP).length / Math.max(1, xs.length),
});

export const fmt = (s: PocketSummary): string =>
  `n=${s.n} med=${s.median.toFixed(2)} iqr=${s.q25.toFixed(2)}-${s.q75.toFixed(2)} <2s=${(100 * s.under2).toFixed(0)}% capped=${(100 * s.capped).toFixed(0)}%`;
