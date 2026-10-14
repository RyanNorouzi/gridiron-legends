import { clamp, clamp01 } from '@/core/math';
import { add, angle, clampLen, cross, dist, dot, len, lerp as lerpVec, normalize, perp, scale, sub, type Vec2 } from '@/core/vec2';
import { idleIntent, type AthleteIntent } from '@/game/engine-api';
import { END_ZONE_DEPTH, FIELD_LENGTH, FIELD_WIDTH, type Direction } from '@/game/types';
import type { Athlete, PlayState } from '@/game/play-types';
import { interceptPoint, type Mover } from '@/physics/collision';
import { maxSpeed } from '@/physics/speed';

/**
 * Steering primitives shared by every decider. Each returns a complete AthleteIntent (nothing here mutates
 * an athlete's pos/vel) carrying a debug label for the dev overlay. Positions are absolute field yards.
 */

/** Distance under which a target counts as reached. */
export const STOP_EPS = 0.15;
/** Default look-ahead for teammate avoidance (yards). */
export const AVOID_LOOKAHEAD = 2.5;

type Positioned = Pick<Athlete, 'pos'>;

/** Unit vector from `from` to `to` (zero when coincident). */
export const toward = (from: Vec2, to: Vec2): Vec2 => normalize(sub(to, from));

/** A point clamped inside the playing surface, `margin` yards from every boundary. */
export const clampToField = (p: Vec2, margin = 0.5): Vec2 => ({
  x: clamp(p.x, margin, FIELD_WIDTH - margin),
  y: clamp(p.y, margin, FIELD_LENGTH - margin),
});

/** Direction along y in which this athlete's team advances (the receiving team on kicks is 'defense'). */
export const attackDirection = (athlete: Pick<Athlete, 'side'>, state: Pick<PlayState, 'ctx'>): Direction =>
  athlete.side === 'offense' ? state.ctx.direction : ((-state.ctx.direction) as Direction);

/** Absolute y of the goal line this athlete's team is attacking. */
export const targetGoalY = (athlete: Pick<Athlete, 'side'>, state: Pick<PlayState, 'ctx'>): number =>
  attackDirection(athlete, state) === 1 ? FIELD_LENGTH - END_ZONE_DEPTH : END_ZONE_DEPTH;

/** Absolute y of the goal line this athlete's team defends. */
export const ownGoalY = (athlete: Pick<Athlete, 'side'>, state: Pick<PlayState, 'ctx'>): number =>
  attackDirection(athlete, state) === 1 ? END_ZONE_DEPTH : FIELD_LENGTH - END_ZONE_DEPTH;

/** Where a constant-velocity mover will be in `seconds`. */
export const predictedPos = (m: Mover, seconds: number): Vec2 => add(m.pos, scale(m.vel, Math.max(0, seconds)));

/** Full-effort movement straight at `target`. */
export const seek = (athlete: Positioned, target: Vec2, sprint = true, debug = 'seek'): AthleteIntent => {
  if (dist(athlete.pos, target) <= STOP_EPS) return idleIntent(debug);
  return { ...idleIntent(debug), move: toward(athlete.pos, target), sprint };
};

/** Movement toward `target` that eases off inside `slowRadius` so the athlete settles instead of overshooting. */
export const arrive = (athlete: Positioned, target: Vec2, slowRadius = 3, debug = 'arrive'): AthleteIntent => {
  const d = dist(athlete.pos, target);
  if (d <= STOP_EPS) return idleIntent(debug);
  const r = Math.max(0.1, slowRadius);
  const effort = clamp(d / r, 0.2, 1);
  return { ...idleIntent(debug), move: scale(toward(athlete.pos, target), effort), sprint: d > r * 1.5 };
};

export interface InterceptSolution {
  /** Point to run to (already blended by quality and clamped inside the field). */
  point: Vec2;
  /** Seconds until the meeting (or until the chaser reaches the target's current spot when unreachable). */
  time: number;
  /** False when the target is faster and pulling away: the point is a lead along its path instead. */
  reachable: boolean;
}

/**
 * Where to run to meet a moving target. Uses the physics intercept solution at this athlete's top speed and
 * blends it toward the target's CURRENT position by `quality` (DifficultyProfile.pursuitQuality mixed with
 * awareness): a 0-quality chaser runs at where the target is, a 1-quality chaser at where it will be.
 */
export const interceptSolution = (athlete: Pick<Athlete, 'pos' | 'attrs'>, target: Mover, quality: number, horizon = 4): InterceptSolution => {
  const speed = Math.max(1, maxSpeed(athlete.attrs.speed));
  const sol = interceptPoint({ pos: athlete.pos, speed }, target);
  let point: Vec2;
  let time: number;
  let reachable: boolean;
  if (sol && sol.time <= horizon) {
    point = sol.pos;
    time = sol.time;
    reachable = true;
  } else {
    time = Math.min(horizon, dist(athlete.pos, target.pos) / speed);
    point = predictedPos(target, time);
    reachable = false;
  }
  return { point: clampToField(lerpVec(target.pos, point, clamp01(quality))), time, reachable };
};

/** Sprint to the intercept point of a moving target ('~' in the label marks an unreachable target). */
export const intercept = (athlete: Pick<Athlete, 'pos' | 'attrs'>, target: Mover, quality: number, debug = 'intercept'): AthleteIntent => {
  const sol = interceptSolution(athlete, target, quality);
  return seek(athlete, sol.point, true, `${debug}${sol.reachable ? '' : '~'}`);
};

/** Stand still, optionally holding a facing. */
export const holdPosition = (athlete: Pick<Athlete, 'facing'>, face: number | null = null, debug = 'hold'): AthleteIntent => ({
  ...idleIntent(debug),
  face: face ?? athlete.facing,
});

/**
 * Keep the eyes on `target` while moving along `moveDir`: backpedal when the movement is away from the
 * target, strafe otherwise (both keep the facing). A zero `moveDir` just turns to face the target.
 */
export const faceAndBackpedal = (athlete: Positioned, target: Vec2, moveDir: Vec2, debug = 'backpedal'): AthleteIntent => {
  const face = angle(sub(target, athlete.pos));
  const m = len(moveDir);
  if (m < 0.05) return { ...idleIntent(debug), face, locomotion: 'strafe' };
  const along = dot(scale(moveDir, 1 / m), { x: Math.cos(face), y: Math.sin(face) });
  return { ...idleIntent(debug), move: clampLen(moveDir, 1), face, locomotion: along < -0.3 ? 'backpedal' : 'strafe' };
};

/**
 * Steer `intent` around obstacles (normally teammates) that sit ahead within `lookahead` yards: each one
 * pushes the heading sideways, more when closer and more directly in the path. The effort (move magnitude)
 * is preserved; the label gains '+avoid' when anything changed.
 */
export const avoid = (
  athlete: Pick<Athlete, 'id' | 'pos'>,
  obstacles: readonly Pick<Athlete, 'id' | 'pos' | 'active'>[],
  intent: AthleteIntent,
  lookahead = AVOID_LOOKAHEAD,
): AthleteIntent => {
  const m = len(intent.move);
  if (m < 0.05) return intent;
  const dir = scale(intent.move, 1 / m);
  let steer: Vec2 = { x: 0, y: 0 };
  for (const o of obstacles) {
    if (o.id === athlete.id || !o.active) continue;
    const rel = sub(o.pos, athlete.pos);
    const d = len(rel);
    if (d < 1e-6 || d > lookahead) continue;
    const ahead = dot(rel, dir) / d;
    if (ahead < 0.3) continue;
    // Obstacle on the left (positive cross) -> push right (-perp), and vice versa.
    const side = cross(dir, rel) >= 0 ? 1 : -1;
    const w = (1 - d / lookahead) * ahead;
    steer = add(steer, scale(perp(dir), -side * w));
  }
  if (len(steer) < 1e-6) return intent;
  const combined = normalize(add(dir, clampLen(steer, 0.9)));
  return { ...intent, move: scale(combined, m), debug: `${intent.debug}+avoid` };
};

/** Records the decision on the athlete's AI memory (overlay label + tick) and returns the intent unchanged. */
export const decided = (athlete: Pick<Athlete, 'ai'>, state: Pick<PlayState, 'tick'>, intent: AthleteIntent): AthleteIntent => {
  athlete.ai.decision = intent.debug;
  athlete.ai.lastDecisionTick = state.tick;
  return intent;
};

/** Active athletes of `side`, nearest to `pos` first. */
export const nearestOf = (state: Pick<PlayState, 'athletes'>, side: Athlete['side'], pos: Vec2, exceptId: string | null = null): Athlete[] =>
  state.athletes
    .filter((a) => a.active && a.side === side && a.id !== exceptId)
    .sort((a, b) => dist(a.pos, pos) - dist(b.pos, pos));
