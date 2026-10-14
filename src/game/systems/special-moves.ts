import { cross, dist, fromAngle, len, normalize, scale, type Vec2 } from '@/core/vec2';
import { ballCarrier, findAthlete } from '../athlete';
import type { BreakMove } from '../play-events';
import type { Athlete, PlayState } from '../play-types';
import { canAct, carrierDown, emit, isHuman, setTimedState, type EngineEnv } from './env';

/**
 * Special moves and timed states. Carrier moves (juke / spin / stiff-arm / hurdle / truck) set a state the
 * contact model reads (physics/contact.ts carrierPower), with cooldowns so they cannot be spammed; dives lunge
 * and put the athlete on the ground; jumps/swats open a window for playing the ball. Arcade rulesets
 * (exaggeratedMoves) make bursts bigger, cooldowns shorter and spins invulnerable for longer.
 */
export const MOVE_TUNING = Object.freeze({
  jukeSeconds: 0.35,
  spinSeconds: 0.5,
  stiffArmSeconds: 0.6,
  hurdleSeconds: 0.6,
  truckSeconds: 0.5,
  diveSeconds: 0.5,
  jumpSeconds: 0.45,
  cooldown: 1.4,
  cooldownArcade: 0.9,
  spinInvulnerable: 0.3,
  spinInvulnerableArcade: 0.45,
  jukeBurst: 2.5,
  diveBoost: 2.5,
});

const BUSY: ReadonlySet<Athlete['state']> = new Set(['juking', 'spinning', 'stiffArming', 'hurdling', 'trucking', 'diving', 'jumping', 'throwing', 'kicking', 'catching']);

const carrierMove = (state: PlayState, env: EngineEnv, a: Athlete, move: Exclude<BreakMove, 'burst' | 'none'>): void => {
  if (!canAct(a) || a.specialMoveCooldown > 0 || BUSY.has(a.state)) return;
  const arcade = state.ctx.ruleset.exaggeratedMoves;
  const mult = arcade ? 1.5 : 1;
  const facing = fromAngle(a.facing);
  const intent = state.intents[a.id];
  switch (move) {
    case 'juke': {
      setTimedState(a, 'juking', MOVE_TUNING.jukeSeconds);
      const mv = intent?.move ?? { x: 0, y: 0 };
      const side = len(mv) > 0.05 ? Math.sign(cross(facing, mv)) || 1 : env.rng.chance(0.5) ? 1 : -1;
      const perp: Vec2 = { x: -facing.y * side, y: facing.x * side };
      a.vel.x += perp.x * MOVE_TUNING.jukeBurst * mult;
      a.vel.y += perp.y * MOVE_TUNING.jukeBurst * mult;
      break;
    }
    case 'spin':
      setTimedState(a, 'spinning', MOVE_TUNING.spinSeconds);
      env.invulnerableUntil[a.id] = state.time + (arcade ? MOVE_TUNING.spinInvulnerableArcade : MOVE_TUNING.spinInvulnerable);
      break;
    case 'stiffArm':
      setTimedState(a, 'stiffArming', MOVE_TUNING.stiffArmSeconds);
      break;
    case 'hurdle':
      setTimedState(a, 'hurdling', MOVE_TUNING.hurdleSeconds);
      a.vel.x += facing.x * 1.0 * mult;
      a.vel.y += facing.y * 1.0 * mult;
      break;
    case 'truck':
      setTimedState(a, 'trucking', MOVE_TUNING.truckSeconds);
      a.vel.x += facing.x * 1.2 * mult;
      a.vel.y += facing.y * 1.2 * mult;
      break;
  }
  a.specialMoveCooldown = arcade ? MOVE_TUNING.cooldownArcade : MOVE_TUNING.cooldown;
  emit(state, { type: 'specialMove', tick: state.tick, athlete: a.id, move });
};

/** Lunge toward `toward` (or along the facing) and hit the turf at the end of the dive. */
export const dive = (state: PlayState, a: Athlete, toward: Vec2 | null): void => {
  if (!canAct(a) || a.specialMoveCooldown > 0 || BUSY.has(a.state)) return;
  const intent = state.intents[a.id];
  const dir = toward ? normalize({ x: toward.x - a.pos.x, y: toward.y - a.pos.y }) : intent && len(intent.move) > 0.05 ? normalize(intent.move) : fromAngle(a.facing);
  const speed = Math.max(len(a.vel), 4) + MOVE_TUNING.diveBoost * (state.ctx.ruleset.exaggeratedMoves ? 1.3 : 1);
  a.vel = scale(dir, speed);
  setTimedState(a, 'diving', MOVE_TUNING.diveSeconds);
  a.specialMoveCooldown = 1.2;
};

/** Applies this tick's action intents that change athlete states. */
export const specialMovesSystem = (state: PlayState, env: EngineEnv): void => {
  const carrier = ballCarrier(state);
  for (const a of state.athletes) {
    if (!a.active) continue;
    const it = state.intents[a.id];
    if (!it || it.action === null) continue;
    switch (it.action) {
      case 'juke': case 'spin': case 'stiffArm': case 'hurdle': case 'truck':
        // A held runner's move is a break attempt, read by the tackle struggle (systems/tackle-struggle.ts).
        if (a.hasBall && a.state !== 'wrapped') carrierMove(state, env, a, it.action);
        break;
      case 'dive':
        // A held runner cannot lay out of the tackle; he is going down with it.
        if (a.state !== 'wrapped') dive(state, a, a.hasBall ? null : carrier && carrier.side !== a.side ? carrier.pos : null);
        break;
      case 'tackle':
        // A human's tackle button already chose between the wrap and the lunge (game/user-control.ts): never lunge it here.
        if (a.controlled && isHuman(state.ctx, a)) break;
        if (carrier && carrier.side !== a.side && dist(carrier.pos, a.pos) <= 2.4 && dist(carrier.pos, a.pos) > a.radius + carrier.radius + 0.3) dive(state, a, carrier.pos);
        break;
      case 'jump': case 'swat':
        if (canAct(a) && a.state !== 'jumping' && a.specialMoveCooldown <= 0) {
          setTimedState(a, 'jumping', MOVE_TUNING.jumpSeconds);
          a.specialMoveCooldown = 0.8;
        }
        break;
      case 'hitStick':
        env.hitStickPress[a.id] = state.time;
        break;
      case 'strip':
        env.stripPress[a.id] = state.time;
        break;
      case 'fairCatch':
        env.fairCatchSignal[a.id] = true;
        break;
      default:
        break;
    }
  }
};

const TIMED: ReadonlySet<Athlete['state']> = new Set([
  'juking', 'spinning', 'stiffArming', 'hurdling', 'trucking', 'diving', 'jumping', 'throwing', 'kicking', 'catching',
  'tackling', 'stumbling', 'down', 'sliding', 'shedding', 'blocking', 'celebrating', 'falling',
]);

/**
 * Counts down state timers and cooldowns. Expiring dives put the athlete on the turf (a diving carrier has
 * given himself up: the ball is dead where he lands); a fall ends on the ground; 'down' athletes get back up to idle.
 */
export const updateTimers = (state: PlayState, env: EngineEnv, dt: number): void => {
  for (const a of state.athletes) {
    a.contactTimer += dt;
    if (a.specialMoveCooldown > 0) a.specialMoveCooldown = Math.max(0, a.specialMoveCooldown - dt);
    if (!TIMED.has(a.state)) continue;
    a.stateTimer -= dt;
    if (a.stateTimer > 0) continue;
    a.stateTimer = 0;
    switch (a.state) {
      case 'diving':
        if (a.hasBall && a.active && state.phase === 'live') {
          const near = state.athletes.filter((d) => d.active && d.side !== a.side && dist(d.pos, a.pos) <= 1.6).sort((p, q) => dist(p.pos, a.pos) - dist(q.pos, a.pos))[0];
          setTimedState(a, 'down', 1.0);
          a.vel = { x: 0, y: 0 };
          if (near) {
            env.lastTackle = { tackler: near.id, assists: [], kind: 'dive', carrier: a.id, pos: { ...a.pos }, tick: state.tick };
            env.tackleRecords.push(env.lastTackle);
            emit(state, { type: 'tackle', tick: state.tick, tackler: near.id, carrier: a.id, kind: 'dive', assists: [] });
          }
          // carrierDown rules the spot: touchdown / safety / touchback are still possible where he lands.
          // A man who fell on a loose ball is down with the recovery, not sliding.
          const fellOnIt = env.fumbles.some((r) => r.recoveredBy === a.id);
          carrierDown(state, env, a, a.pos, near ? 'tackle' : fellOnIt ? 'fumbleRecovered' : 'slide');
        } else {
          setTimedState(a, 'stumbling', 0.35);
        }
        break;
      case 'sliding':
      case 'falling':
        setTimedState(a, 'down', 0.6);
        break;
      case 'down':
        a.state = 'idle';
        break;
      default:
        a.state = len(a.vel) > 0.3 ? 'moving' : 'idle';
        break;
    }
  }
  const c = findAthlete(state, state.ball.carrierId);
  if (c && c.state === 'tackled') c.vel = { x: 0, y: 0 };
};
