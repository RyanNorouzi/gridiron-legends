import { angle, angleDiff, dist, len, sub } from '@/core/vec2';
import { circleHit, pointSegmentDistance, separate } from '@/physics/collision';
import { clamp01 } from '@/core/math';
import { TICK_DT } from '@/core/time';
import { maxSpeed } from '@/physics/speed';
import { contactStart, type ContactOutcome, type TackleContext } from '@/physics/contact';
import { mergeVelocity } from '@/physics/struggle';
import { ballCarrier, findAthlete } from '../athlete';
import { userTackleAssist } from '../user-control';
import type { TackleKind } from '../play-events';
import type { Athlete, PlayState } from '../play-types';
import { canAct, emit, isHuman, noteContact, opponentsOf, pairKey, releasePile, setTimedState, type EngineEnv } from './env';
import { looseBallFrom } from './fumble';
import { contactIntensity, rollContactInjuries } from './injuries-live';
import { onTackleContact } from './penalties-live';
import { advanceStruggle, beginStruggle, joinPile, pileKind, takeDown } from './tackle-struggle';
import { difficultyFor } from '../difficulty-sides';

/**
 * Tackle contact. Each tick every free defender overlapping the carrier (reach 0.3 yd, 1.0 while diving) makes contact;
 * the kind of tackle comes from what he is doing: a hit stick pressed within HIT_STICK_WINDOW of contact, a strip, a
 * dive, a gang tackle when others are already on the runner, otherwise wrap (square) / arm (glancing) / open-field
 * (carrier at speed in space). physics/contact.ts contactStart decides what the contact does: a whiff, a broken
 * tackle, a big hit that puts him straight down, a fumble, or (most often) a hold, which starts a tackle STRUGGLE
 * (systems/tackle-struggle.ts): the runner keeps fighting for yards, more defenders join the pile, and the tackle
 * finishes, is broken, or is whistled for forward progress. Sacks are tackles of the QB behind the LOS on a pass
 * play before he throws. carrierDown (via tackle-struggle.ts takeDown) remains the only way a tackle ends the play.
 */
export const HIT_STICK_WINDOW = 0.25;
export const STRIP_WINDOW = 0.3;
export const GANG_WINDOW = 0.6;
/**
 * A pile is not a scrum: only defenders who get to the runner within JOIN_WINDOW seconds of the first hold get a hand
 * on him (a late arrival on a runner already going down is just there), and at most MAX_PILE defenders hold him at once.
 * Most tackles finish one-on-one or two-on-one, as in real football (roughly a third of tackles are assisted).
 */
export const JOIN_WINDOW = 0.3;
export const MAX_PILE = 3;
export const PAIR_COOLDOWN = 0.5;
/** Seconds before a tackler who knocked the runner off balance (a 'stumble') can try to finish him. */
export const STUMBLE_REGATHER = 0.2;
export const TACKLE_REACH = 0.3;
export const DIVE_REACH = 1.0;
/** A blocker this close to a diving tackler's line to the carrier (and nearer than the carrier) takes the dive. */
export const DIVE_SHIELD_WIDTH = 0.8;
/**
 * Contact geometry that turns a wrap attempt into an arm tackle: a runner faster than TRAIL_SPEED (yd/s) hit from
 * behind (cosine between his run and the tackler under TRAIL_COS), or one faster than SIDE_ON_SPEED crossing an
 * unsquare tackler's face (cosine under SIDE_ON_COS).
 */
export const TRAIL_SPEED = 3;
export const TRAIL_COS = -0.3;
export const SIDE_ON_SPEED = 5;
export const SIDE_ON_COS = 0.35;

/** Share of his burst-free top speed at or under which a tackler is under control (broken down) for a form tackle. */
export const FORM_TACKLE_SPEED = 0.9;
/** Largest angle (radians) between a human tackler's facing and the runner that still counts as square: 30 deg with no
 *  assist, 60 deg at full userTackleAssist. */
export const formTackleSquare = (assist: number): number => (Math.PI / 6) * (1 + clamp01(assist));

/**
 * A human defender who meets the runner square and under control (the user-control breakdown) makes a form tackle: a
 * wrap even in space, where a defender arriving at full tilt only gets an open-field grab. The difficulty's
 * userTackleAssist widens what counts as square.
 */
export const formTackle = (state: PlayState, tackler: Athlete, carrier: Athlete): boolean => {
  if (!tackler.controlled || !isHuman(state.ctx, tackler)) return false;
  if (len(tackler.vel) > FORM_TACKLE_SPEED * maxSpeed(tackler.attrs.speed)) return false;
  const off = Math.abs(angleDiff(tackler.facing, angle(sub(carrier.pos, tackler.pos))));
  return off <= formTackleSquare(userTackleAssist(state, tackler));
};

const chooseKind = (state: PlayState, env: EngineEnv, carrier: Athlete, tackler: Athlete, assists: number): { kind: TackleKind; timing: number | undefined } => {
  const press = env.hitStickPress[tackler.id];
  if (press !== undefined && state.time - press <= HIT_STICK_WINDOW) return { kind: 'hitStick', timing: 1 - (state.time - press) / HIT_STICK_WINDOW };
  const strip = env.stripPress[tackler.id];
  if (strip !== undefined && state.time - strip <= STRIP_WINDOW) return { kind: 'strip', timing: undefined };
  // A man arriving on a carrier who is already held is a gang tackle, even if he left his feet to get there.
  if (assists >= 1) return { kind: 'gang', timing: undefined };
  if (tackler.state === 'diving') return { kind: 'dive', timing: undefined };
  if (formTackle(state, tackler, carrier)) return { kind: 'wrap', timing: undefined };
  const others = opponentsOf(state, carrier).filter((d) => d.id !== tackler.id && dist(d.pos, carrier.pos) < 4);
  if (len(carrier.vel) > 6 && others.length === 0) return { kind: 'openField', timing: undefined };
  const square = Math.abs(angleDiff(tackler.facing, angle(sub(carrier.pos, tackler.pos)))) < Math.PI / 4;
  // Geometry decides how good a grab he gets: a man chasing from behind, or one the runner crosses in front of at
  // speed, only gets an arm on him however much he wanted to wrap up.
  const speed = len(carrier.vel);
  const rel = sub(tackler.pos, carrier.pos);
  const ahead = speed > 1e-6 && len(rel) > 1e-6 ? (carrier.vel.x * rel.x + carrier.vel.y * rel.y) / (speed * len(rel)) : 1;
  const trailing = speed > TRAIL_SPEED && ahead < TRAIL_COS;
  const sideOn = speed > SIDE_ON_SPEED && ahead < SIDE_ON_COS && !square;
  const wants = state.intents[tackler.id]?.action === 'tackle';
  return { kind: (square || wants) && !trailing && !sideOn ? 'wrap' : 'arm', timing: undefined };
};

const pushApart = (carrier: Athlete, tackler: Athlete): void => {
  const d = dist(carrier.pos, tackler.pos);
  const r = carrier.radius + tackler.radius;
  if (d < r) separate(tackler, carrier, r - d);
};

/**
 * Resolves one defender's contact with the carrier (`assists` = teammates already on him, for the gang read). When a
 * struggle is already under way the defender is joining the pile: a hold adds him to it, a big hit or a fumble ends
 * it, and bouncing off the pile is no event at all (only a whiff is a missed tackle).
 */
export const attemptTackle = (state: PlayState, env: EngineEnv, carrier: Athlete, tackler: Athlete, assists: Athlete[]): ContactOutcome => {
  const joining = env.struggle?.carrierId === carrier.id;
  const pileSize = joining ? env.struggle?.tacklers.length ?? 0 : assists.length;
  noteContact(env, tackler);
  if (joining) {
    const t = env.tracks[carrier.id];
    if (t) t.contacts += 1;
  } else noteContact(env, carrier);
  if (state.firstContactY === null && carrier.side === 'offense') state.firstContactY = carrier.pos.y;
  const { kind, timing } = chooseKind(state, env, carrier, tackler, pileSize);
  const diff = difficultyFor(state, carrier);
  const tctx: TackleContext = {
    rng: env.rng,
    assistCount: pileSize,
    ballSecurityAssist: carrier.controlled && isHuman(state.ctx, carrier) ? diff.userBallSecurityAssist : 0,
  };
  if (timing !== undefined) tctx.hitStickTiming = timing;
  // The user's form tackle reads the runner's move: userTackleAssist decides how much of its bonus he takes away.
  if (kind === 'wrap' && formTackle(state, tackler, carrier)) tctx.moveRead = userTackleAssist(state, tackler);
  let out = contactStart(carrier, tackler, kind, tctx);
  if (carrier.state === 'hurdling') {
    if (tackler.state === 'diving') out = { ...out, result: 'broken', breakMove: 'hurdle' };
    // Caught by the legs going over: a weak hold.
    else if (out.result === 'broken' && env.rng.chance(0.4)) out = { ...out, result: 'wrap', hold: 0.6 };
  }
  // A joiner's ordinary grab does not jar the ball loose on its own: only a hit stick or a strip into the pile does.
  if (joining && out.result === 'fumble' && kind !== 'hitStick' && kind !== 'strip') out = { ...out, result: 'wrap', hold: 0.85 };
  if (kind === 'hitStick') emit(state, { type: 'hitStick', tick: state.tick, by: tackler.id, on: carrier.id });
  onTackleContact(state, env, carrier, tackler, kind);
  const key = pairKey(tackler.id, carrier.id);
  const hit = kind === 'hitStick';
  switch (out.result) {
    case 'wrap':
      // The runner took his contact roll when he was first wrapped: a man joining the pile rolls only for himself.
      rollContactInjuries(state, env, joining ? [tackler] : [carrier, tackler], contactIntensity(carrier, tackler, false));
      if (joining) joinPile(state, env, carrier, tackler, kind, out.hold);
      // A runner already laid out (a dive for the marker) has nothing left to fight with: he is down where he is held.
      else if (carrier.state === 'diving') takeDown(state, env, carrier, tackler, [], pileKind(1, kind), { ...carrier.pos }, 'tackle', mergeVelocity([carrier, tackler]));
      else beginStruggle(state, env, carrier, tackler, kind, out.hold);
      break;
    case 'bigHit': {
      rollContactInjuries(state, env, [carrier, tackler], contactIntensity(carrier, tackler, true));
      // Knocked straight down (backwards when the hit carried the momentum): spotted where he was hit, or at the
      // furthest point the pile had reached.
      const s = joining ? env.struggle : null;
      const pile = s ? s.tacklers.map((m) => findAthlete(state, m.id)).filter((a): a is Athlete => !!a) : [];
      const spot = { x: carrier.pos.x, y: s ? s.bestY : carrier.pos.y };
      takeDown(state, env, carrier, tackler, pile, 'hitStick', spot, 'tackle', mergeVelocity([carrier, tackler]));
      break;
    }
    case 'fumble':
      rollContactInjuries(state, env, [carrier, tackler], contactIntensity(carrier, tackler, hit));
      releasePile(state, env);
      looseBallFrom(state, env, carrier, tackler, { popSpeed: kind === 'strip' ? 3 : 2 });
      if (kind === 'strip') setTimedState(carrier, 'stumbling', 0.5);
      else setTimedState(carrier, 'falling', 0.6);
      setTimedState(tackler, 'tackling', 0.4);
      env.pairCooldown[key] = state.time + PAIR_COOLDOWN;
      break;
    case 'broken':
    case 'stumble':
      if (joining) {
        // Bounced off the pile: he regathers and may come again.
        setTimedState(tackler, 'stumbling', 0.3);
        env.pairCooldown[key] = state.time + 0.4;
        break;
      }
      if (out.result === 'stumble') {
        setTimedState(carrier, 'stumbling', 0.45);
        setTimedState(tackler, 'tackling', 0.3);
        // He knocked the runner off balance and is still on him: he may finish it once he has regathered.
        env.pairCooldown[key] = state.time + STUMBLE_REGATHER;
        pushApart(carrier, tackler);
        break;
      }
      emit(state, { type: 'brokenTackle', tick: state.tick, carrier: carrier.id, defender: tackler.id, move: out.breakMove });
      carrier.brokenTacklesThisPlay += 1;
      setTimedState(tackler, 'stumbling', 0.6);
      env.pairCooldown[key] = state.time + PAIR_COOLDOWN;
      pushApart(carrier, tackler);
      break;
    case 'missed':
      emit(state, { type: 'missedTackle', tick: state.tick, defender: tackler.id, carrier: carrier.id });
      setTimedState(tackler, 'stumbling', 0.6);
      env.pairCooldown[key] = state.time + PAIR_COOLDOWN + 0.1;
      if (!joining) pushApart(carrier, tackler);
      break;
  }
  return out;
};

/** True while one more defender can still get a hand on the held runner (see JOIN_WINDOW / MAX_PILE). */
export const pileOpen = (state: PlayState, env: EngineEnv): boolean => {
  const s = env.struggle;
  return !!s && s.tacklers.length < MAX_PILE && state.time - s.startedAt <= JOIN_WINDOW;
};

const DOWN_STATES: ReadonlySet<Athlete['state']> = new Set(['tackled', 'sliding', 'down', 'falling']);

/**
 * One tick of tackling: contact by free defenders (first contact, or joining the pile), then the struggle in progress.
 */
export const tackleSystem = (state: PlayState, env: EngineEnv, dt = TICK_DT): void => {
  if (state.phase !== 'live') return;
  if (state.ball.phase !== 'held') {
    releasePile(state, env);
    return;
  }
  const carrier = ballCarrier(state);
  if (!carrier || !carrier.active || DOWN_STATES.has(carrier.state)) {
    releasePile(state, env);
    return;
  }
  if (env.struggle && env.struggle.carrierId !== carrier.id) releasePile(state, env);
  if ((env.invulnerableUntil[carrier.id] ?? 0) > state.time) {
    releasePile(state, env);
    return;
  }
  const pile = new Set(env.struggle?.tacklers.map((m) => m.id) ?? []);
  const free = opponentsOf(state, carrier).filter((d) => canAct(d) && d.state !== 'jumping' && !pile.has(d.id)
    && (env.pairCooldown[pairKey(d.id, carrier.id)] ?? 0) <= state.time);
  // A laid-out tackler reaches further, but not through a blocker standing between him and the carrier (no diving
  // over the centre at the snap).
  const shielded = (d: Athlete): boolean => {
    const dd = dist(d.pos, carrier.pos);
    return state.athletes.some((b) => b.side === carrier.side && b.id !== carrier.id && b.active && !b.hasBall
      && dist(b.pos, carrier.pos) < dd && pointSegmentDistance(b.pos, d.pos, carrier.pos) <= DIVE_SHIELD_WIDTH);
  };
  const inContact = free
    .filter((d) => circleHit(d.pos, d.radius + (d.state === 'diving' ? DIVE_REACH : TACKLE_REACH), carrier.pos, carrier.radius))
    .filter((d) => d.state !== 'diving' || !shielded(d))
    .sort((p, q) => dist(p.pos, carrier.pos) - dist(q.pos, carrier.pos));
  if (env.struggle) {
    // Pursuers arriving at the pile join it (each adds stopping power), then the struggle ticks.
    for (const d of inContact) {
      if (state.phase !== 'live' || !env.struggle || state.ball.phase !== 'held') return;
      // Too late (or no room) to get a hand on him: he is just there. No cooldown, so if the runner breaks free he
      // can take him on at once.
      if (!pileOpen(state, env)) continue;
      attemptTackle(state, env, carrier, d, []);
    }
    if (state.phase === 'live' && env.struggle) advanceStruggle(state, env, dt);
    return;
  }
  const tackler = inContact[0];
  if (!tackler) return;
  const assists = opponentsOf(state, carrier).filter((d) => d.id !== tackler.id && d.contactTimer < GANG_WINDOW && dist(d.pos, carrier.pos) < 1.4);
  attemptTackle(state, env, carrier, tackler, assists);
  // Everyone else who got to him on the same tick is in on it from the start.
  for (const d of inContact.slice(1)) {
    if (state.phase !== 'live' || !env.struggle || state.ball.phase !== 'held') return;
    if (!pileOpen(state, env)) break;
    attemptTackle(state, env, carrier, d, []);
  }
};
