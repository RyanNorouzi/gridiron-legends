/**
 * Harness for the tackle-struggle engine tests: a real LivePlay whose defense is cleared off the field right after the
 * snap, then a hand-posed struggle (systems/tackle-struggle.ts beginStruggle / joinPile) between the ball carrier and
 * the chosen defenders, with scripted intents (never real AI). Everything after the pose is the engine's own physics
 * and dice.
 */
import { vec2, type Vec2 } from '@/core/vec2';
import { idleIntent, moveIntent, type AthleteIntent, type IntentAction } from '@/game/engine-api';
import { findAthlete } from '@/game/athlete';
import type { TackleKind } from '@/game/play-events';
import type { Athlete, PlayContext, PlayOutcome, PlayState, UserInputs } from '@/game/play-types';
import { beginStruggle, joinPile } from '@/game/systems/tackle-struggle';
import { setControlled } from '@/game/user-control';
import type { AttributeSet } from '@/players/types';
import type { FixtureOptions } from '../../fixtures/play-state';
import { build, scripted, toward, type Built, type Script } from './helpers';

export type Body = { massLb?: number; attrs?: Partial<AttributeSet> };

/** Sets an athlete's mass and ratings (baseAttrs too: the engine recomputes attrs from them every tick). */
export const shape = (a: Athlete, b: Body): void => {
  if (b.massLb !== undefined) a.massLb = b.massLb;
  if (b.attrs) {
    Object.assign(a.baseAttrs, b.attrs);
    Object.assign(a.attrs, b.attrs);
  }
};

/** Attack direction of the offense (absolute y). */
export const offDir = (s: PlayState): 1 | -1 => s.ctx.direction;

/** A pile tackler's intent: drive the runner back (or toward `to`), holding the tackle button. */
export const driveBack = (s: PlayState, to?: Vec2, action: IntentAction = 'tackle'): AthleteIntent => ({
  ...moveIntent(to ?? vec2(0, -offDir(s)), true, 'drive back'), action,
});

export const churn = (s: PlayState): AthleteIntent => moveIntent(vec2(0, offDir(s)), true, 'churn');

export interface PosedPile {
  built: Built;
  carrier: Athlete;
  tacklers: Athlete[];
  /** Carrier position when the struggle started. */
  start: Vec2;
}

export interface PoseOptions {
  seed: number;
  offensePlayId?: string;
  carrierId?: string;
  /** Pile defenders in join order (first = primary tackler). */
  tacklerIds: string[];
  kind?: TackleKind;
  hold?: number;
  carrierBody?: Body;
  tacklerBody?: Body;
  /** Carrier velocity at the hold (default: whatever he had). */
  carrierVel?: Vec2;
  /** Primary tackler's velocity at the hold (default: 4 yd/s straight at the runner). */
  tacklerVel?: Vec2;
  /** Where to put the carrier when the struggle starts, from where he is (default: leave him). */
  at?: (pos: Vec2, s: PlayState) => Vec2;
  /** Scripts after the pose (carrier / tacklers / others); defaults churn and drive back. */
  script?: Script;
  patch?: Partial<PlayContext>;
  /** Seconds the carrier must have had the ball (and run) before the pose. */
  after?: number;
  inputs?: (s: PlayState) => UserInputs;
  /** Runs right after the pose (e.g. hand an athlete to a human controller). */
  onPose?: (s: PlayState, p: PosedPile) => void;
  fixture?: Partial<FixtureOptions>;
}

/**
 * Builds the play, clears the defense after the snap, runs until the carrier has had the ball for `after` seconds,
 * then poses the struggle. Returns null when the play went dead before the pose.
 */
export const posePile = (o: PoseOptions): PosedPile | null => {
  const carrierId = o.carrierId ?? 'off:RB';
  let posed = false;
  const script: Script = {
    [carrierId]: (a, s) => (posed ? (o.script?.[carrierId]?.(a, s) ?? churn(s)) : a.hasBall ? churn(s) : toward(a, s.ball.pos)),
  };
  for (const id of o.tacklerIds) script[id] = (a, s) => (posed ? (o.script?.[id]?.(a, s) ?? driveBack(s)) : idleIntent('wait'));
  for (const [id, fn] of Object.entries(o.script ?? {})) if (!(id in script)) script[id] = (a, s) => (posed ? fn(a, s) : idleIntent('wait'));
  // The QB just holds the ball on a pass play (no scripted carrier run for him before the pose).
  if (carrierId === 'off:QB') script[carrierId] = (a, s) => (posed ? (o.script?.[carrierId]?.(a, s) ?? churn(s)) : idleIntent('hold'));
  const built = build({ offensePlayId: o.offensePlayId ?? 'iform-dive-right', defensePlayId: '43-cover3-zone', seed: o.seed, ballOn: 40, ...o.fixture }, o.patch ?? {}, {
    decider: scripted(script),
  });
  const { engine } = built;
  const s = engine.state;
  const dir = offDir(s);
  let cleared = false;
  let heldSince = -1;
  while (!engine.isDead && engine.stepCount < 2000) {
    engine.tick(o.inputs ? o.inputs(s) : {});
    if (s.phase !== 'live') continue;
    if (!cleared) {
      // Every defender (the pile men too) waits far downfield, spread along the far sideline.
      s.athletes.filter((a) => a.side === 'defense').forEach((a, i) => {
        a.pos = vec2(3 + i * 2.2, s.losY + dir * 45);
        a.vel = vec2(0, 0);
      });
      cleared = true;
    }
    const c = findAthlete(s, carrierId);
    if (!c || !c.hasBall || s.ball.phase !== 'held') continue;
    if (heldSince < 0) heldSince = s.time;
    if (s.time - heldSince < (o.after ?? 0.6)) continue;
    const env = engine.debugEnv();
    if (o.at) c.pos = o.at({ ...c.pos }, s);
    if (o.carrierVel) c.vel = { ...o.carrierVel };
    if (o.carrierBody) shape(c, o.carrierBody);
    const tacklers = o.tacklerIds.map((id) => findAthlete(s, id)!);
    tacklers.forEach((t, i) => {
      if (o.tacklerBody) shape(t, o.tacklerBody);
      const ang = i === 0 ? 0 : (i % 2 === 1 ? 1 : -1) * (0.9 + 0.3 * i);
      const r = (c.radius + t.radius) * 0.9;
      t.pos = vec2(c.pos.x + Math.sin(ang) * r, c.pos.y + dir * Math.cos(ang) * r);
      t.vel = i === 0 ? o.tacklerVel ?? vec2(0, -dir * 4) : vec2(0, -dir * 2);
      t.state = 'moving';
    });
    const start = { ...c.pos };
    beginStruggle(s, env, c, tacklers[0]!, o.kind ?? 'wrap', o.hold ?? 1);
    for (const t of tacklers.slice(1)) joinPile(s, env, c, t, 'wrap', 0.9);
    posed = true;
    const out = { built, carrier: c, tacklers, start };
    o.onPose?.(s, out);
    return out;
  }
  return null;
};

export interface Trace {
  outcome: PlayOutcome;
  /** Furthest forward y the carrier reached while wrapped in the FIRST struggle (incl. the start). */
  bestY: number;
  /** Carrier y on the last tick of the first struggle (still held). */
  lastY: number;
  /** Seconds the first struggle lasted, and from the pose to the whistle. */
  held: number;
  seconds: number;
}

/** Runs a posed pile to the whistle, tracking the carrier's furthest forward point while the first struggle lasts. */
export const runPile = (p: PosedPile, inputs?: (s: PlayState) => UserInputs): Trace => {
  const { engine } = p.built;
  const s = engine.state;
  const dir = offDir(s);
  const t0 = s.time;
  let best = p.start.y;
  let last = p.start.y;
  let held = -1;
  while (!engine.isDead && engine.stepCount < 4000) {
    engine.tick(inputs ? inputs(s) : {});
    if (held >= 0) continue;
    if (p.carrier.state !== 'wrapped') {
      held = s.time - t0;
      continue;
    }
    last = p.carrier.pos.y;
    if (dir * (last - best) > 0) best = last;
  }
  return { outcome: engine.outcome!, bestY: best, lastY: last, held: held < 0 ? s.time - t0 : held, seconds: s.time - t0 };
};

/** Hands `id` to a human controller from now on (the rest of his team stays scripted). */
export const humanTakes = (s: PlayState, id: string): void => {
  const a = findAthlete(s, id)!;
  s.ctx.controllers[a.teamSide] = 'human';
  setControlled(s, a.teamSide, a.id);
};

export const eventsOf = (p: PosedPile, type: string): PlayState['events'] => p.built.engine.state.events.filter((e) => e.type === type);
