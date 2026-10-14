/** Shared helpers for the live-engine tests: scripted deciders (never real AI) and engine construction. */
import { normalize, sub, vec2, type Vec2 } from '@/core/vec2';
import { idleIntent, moveIntent, type AthleteIntent, type IntentDecider, type LivePlayOptions } from '@/game/engine-api';
import { createPlayEngine, PlayEngine } from '@/game/play-engine';
import type { Athlete, PlayContext, PlayState, UserPlayInput } from '@/game/play-types';
import { predictLanding } from '@/physics/ball';
import { buildPlayState, type Fixture, type FixtureOptions } from '../../fixtures/play-state';

export type Script = Record<string, (a: Athlete, s: PlayState) => AthleteIntent>;

/**
 * Decider that runs the scripted intent for an athlete id and idles everyone else. Scripts only act once the
 * ball is live (nobody wanders pre-snap) unless `presnap` is set.
 */
export const scripted = (script: Script, fallback: IntentDecider = () => idleIntent('idle'), presnap = false): IntentDecider =>
  (a, s, dt) => (s.phase === 'presnap' && !presnap ? idleIntent('set') : script[a.id]?.(a, s) ?? fallback(a, s, dt));

export const toward = (a: Athlete, p: Vec2, sprint = true): AthleteIntent => moveIntent(normalize(sub(p, a.pos)), sprint, 'toward');

/** Straight downfield for the offense (or upfield for the receiving/defending side). */
export const ahead = (s: PlayState, side: 'offense' | 'defense', sprint = true): AthleteIntent => {
  const d = side === 'offense' ? s.ctx.direction : -s.ctx.direction;
  return moveIntent(vec2(0, d), sprint, 'ahead');
};

export const chaseBall = (a: Athlete, s: PlayState): AthleteIntent => {
  const target = s.ball.phase === 'inAir' ? predictLanding(s.ball, s.ctx.weather, 1.2).pos : s.ball.pos;
  return toward(a, target);
};

/** Every defender drifts to the offense's left sideline: keeps the middle clear of idle bodies. */
export const clearDefense = (a: Athlete, s: PlayState): AthleteIntent => (a.side === 'defense' ? moveIntent(vec2(-s.ctx.direction, 0), true, 'clear') : idleIntent('idle'));

export const ticksSinceSnap = (s: PlayState): number => (s.snapTick < 0 ? -1 : s.tick - s.snapTick);

export interface Built {
  f: Fixture;
  ctx: PlayContext;
  engine: PlayEngine;
}

/**
 * Builds a fixture and an engine from it; `patch` overrides context fields (special, ballOn ...) and `mutate`
 * edits the lineups (ratings) BEFORE the engine copies them into the athletes.
 */
export const build = (fx: FixtureOptions, patch: Partial<PlayContext> = {}, opts: LivePlayOptions = {}, mutate?: (ctx: PlayContext) => void): Built => {
  const f = buildPlayState(fx);
  const ctx: PlayContext = { ...f.state.ctx, ...patch };
  mutate?.(ctx);
  const engine = createPlayEngine(ctx, { registries: f.registry, ...opts }) as PlayEngine;
  return { f, ctx, engine };
};

/** Move to a point and settle there (slows inside 1.5 yd) — a crude receiver / returner adjusting to the ball. */
export const arriveAt = (a: Athlete, p: Vec2): AthleteIntent => {
  const d = sub(p, a.pos);
  const l = Math.hypot(d.x, d.y);
  if (l < 0.2) return idleIntent('arrived');
  const k = Math.min(1, l / 1.5);
  return moveIntent({ x: (d.x / l) * k, y: (d.y / l) * k }, l > 4, 'arrive');
};

/** Track a ball in the air: arrive at its landing point (catch height). */
export const trackBall = (a: Athlete, s: PlayState): AthleteIntent => arriveAt(a, predictLanding(s.ball, s.ctx.weather, 1.2).pos);

/** Pursuit toward where the ball will be shortly (catches runners instead of trailing them). */
export const pursue = (a: Athlete, s: PlayState): AthleteIntent => toward(a, { x: s.ball.pos.x + s.ball.vel.x * 0.5, y: s.ball.pos.y + s.ball.vel.y * 0.5 });

export const emptyInput = (): UserPlayInput => ({
  move: vec2(0, 0), sprint: false, strafe: false, throwTo: null, throwType: null, juke: false, spin: false, stiffArm: false,
  hurdle: false, dive: false, slide: false, throwAway: false, snap: false, audible: null, defAudible: null, switchPlayer: false,
  switchToId: null, hitStick: false, strip: false, tackle: false, jumpSwat: false, kickPress: false, fairCatch: false, pitch: false,
});

export const hasEvent = (engine: PlayEngine, type: string): boolean => engine.state.events.some((e) => e.type === type);
