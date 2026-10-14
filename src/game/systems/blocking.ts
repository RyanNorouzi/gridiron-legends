import { clamp, clamp01, ratingToFactor } from '@/core/math';
import { dist } from '@/core/vec2';
import { maxSpeed } from '@/physics/speed';
import type { OffAssignment } from '@/playbook/types';
import { blockContest, type BlockOutcome } from '@/physics/contact';
import { separate } from '@/physics/collision';
import { ballCarrier, findAthlete } from '../athlete';
import type { Athlete, PlayState } from '../play-types';
import { canAct, emit, noteContact, pairKey, setTimedState, type EngineEnv, type Engagement } from './env';
import { onBlockShed } from './penalties-live';

/**
 * Blocking engagements. A blocker (blocking assignment, block route, or an explicit 'block' intent) who meets an
 * opponent locks both into an engagement resolved with blockContest on contact and every re-roll interval:
 * engaged pairs drift along the winner's push, pancakes put the defender down, sheds free him (and may draw a holding
 * flag), stalemates hold. Engaged defenders may disengage to chase a nearby ball carrier.
 *
 * Pass protection is a moving wall: the blocker mirrors his rusher (staying on the line between him and the passer)
 * and gives ground only at a rate set by who is winning the rep, anchoring as the pocket closes on the passer. In the
 * pocket a rep is never lost on a single roll: each roll sets who is winning (the score), and the rusher's chance to
 * beat the set grows with the rep's age after the set window (the wear-down hazard). Against an even four-man rush a
 * passer who holds the ball is sacked after about 5 s (median); a better front gets home sooner, a better line holds
 * longer, a blitz stretches the protection (about 3.5 s with five rushers, 2.5 s with six), and only an unblocked
 * rusher gets home fast.
 *
 * Run blocks can be doubled (a combo): a second run blocker who wants the same down lineman joins the engagement,
 * the better of the two rolls counts and both push; when one of them climbs to the second level he lets go.
 */
export const RE_ROLL_SECONDS = 0.5;
/** Chance a down lineman wins his gap at the first punch of a run block at an even matchup, and its rating slope. */
export const RUN_PENETRATION = 0.08;
export const RUN_PENETRATION_SLOPE = 4;
/** A designed run (a handoff, a toss, a designed QB run): where a lineman winning his gap blows up the play. */
const runPlay = (state: PlayState): boolean => {
  const t = state.ctx.offensivePlay.type;
  return t === 'run' || t === 'qbRun';
};
/** Share of the time a double team covers for a rep its first blocker lost outright (the rest, the lineman splits it). */
export const DOUBLE_HOLD_SHARE = 0.6;
/** Pass reps are rolled on this cadence (a rusher working a move does not get extra rolls). */
export const PASS_RE_ROLL_SECONDS = 0.45;
/** A pass set cannot be beaten in its first moments unless the rusher is clearly better (true score below this). */
export const PASS_SET_SECONDS = 0.9;
export const EARLY_BEAT_SCORE = -0.3;
/**
 * The wear-down hazard: after the set window a rusher's chance per second to beat the set grows linearly with the
 * rep's age (PASS_BEAT_RATE per second per second at an even rep), scaled by exp(-PASS_BEAT_SLOPE x score) so a
 * better rusher wins sooner and a better blocker holds longer. Tuned for MORE PRESSURE (the owner's request): with four
 * even rushers the first beat comes ~2.2 s into the play (median), so the passer feels heat around 2-2.5 s and one who
 * holds the ball is sacked ~3.5-4 s after the snap.
 */
export const PASS_BEAT_RATE = 0.5;
export const PASS_BEAT_SLOPE = 5;
/** Seconds of 'wear' a rep already carries when the set window closes (a quick win is possible, just rare). */
export const PASS_BEAT_ONSET = 0.15;
/**
 * Nobody holds a rush forever: from this rep age on, a second wear term grows at PASS_LATE_RATE per second per second
 * and depends on the matchup only weakly (exp(-PASS_LATE_SLOPE x score)). It leaves the ~5 s even pocket alone and
 * trims the tail of a far better line's (a 95-rated line against a 50-rated front stands 9 s+ a third less often).
 */
export const PASS_LATE_AGE = 5.2;
export const PASS_LATE_RATE = 0.8;
export const PASS_LATE_SLOPE = 1.5;
/**
 * A rusher who has already beaten a set this play and is picked up again (by a spare lineman, a back, or the beaten
 * man recovering) has his momentum and the blocker is on his heels: no set window, and the rep scores this much in
 * the rusher's favour. A spare slows a free rusher; he does not stone him.
 */
export const PICKUP_EDGE = 0.3;
/** Seconds of wear a pickup rep starts with (the rusher is already through: the blocker is catching him). */
export const PICKUP_WEAR = 2;
const pickups = new WeakSet<Engagement>();
/** Seconds of wear a pass-protection rep against a blitzer (assignment 'blitz') starts with. */
export const BLITZ_PICKUP_WEAR = 0.8;
/**
 * A stretched protection: against more than four rushers there is no spare lineman to help or slide, every man is
 * on an island (a quicker, shallower set) and a back takes a charging linebacker, so per rusher past four (at most
 * STRETCH_MAX_EXTRA) each pocket rep starts with STRETCH_WEAR seconds of wear and scores STRETCH_EDGE in the
 * rushers' favour. A four-man rush (stunts included) is untouched.
 */
export const STRETCH_EDGE = 0.12;
export const STRETCH_WEAR = 0.35;
export const STRETCH_MAX_EXTRA = 2;
const stretched = new WeakMap<Engagement, number>();
const RUSH_TYPES = new Set(['rushGap', 'contain', 'blitz']);
/** Rushers past four the defense sends (0 for a four-man rush or fewer). */
export const extraRushers = (state: PlayState): number => {
  let n = 0;
  for (const a of state.athletes) if (a.side === 'defense' && a.active && RUSH_TYPES.has(a.assignment.type)) n += 1;
  return clamp(n - 4, 0, STRETCH_MAX_EXTRA);
};
/**
 * Most a clearly better rusher (true score below EARLY_BEAT_SCORE) turns a losing first punch into a quick win: the
 * chance grows with how clear the mismatch is (twice the margin), up to this.
 */
export const EARLY_WIN_SHARE = 0.35;
/** A beaten pass blocker cannot re-engage the man who beat him for this long. */
export const BEATEN_SET_COOLDOWN_SECONDS = 1.5;
/** Lateral shift (yd) and speed (yd/s) of a rusher slipping past the set he just beat. */
const SLIP_SHIFT = 0.35;
const SLIP_SPEED = 4;
/** Yards per second an engaged pass set gives up toward the passer at an even rep, and the extremes. */
export const GIVE_GROUND_EVEN = 0.8;
export const GIVE_GROUND_MIN = 0.1;
export const GIVE_GROUND_MAX = 1.3;
/**
 * The anchor: a pass set gives no more ground once he is this close (yd, centre to centre) to the passer, and gives it
 * at the full rate only from ANCHOR_YARDS + ANCHOR_RAMP out. The pocket is squeezed, not walked into the passer's lap.
 */
export const ANCHOR_YARDS = 1.0;
export const ANCHOR_RAMP = 1.2;
export const ENGAGE_REACH = 0.25;
export const BREAK_DISTANCE = 1.7;
/** A run block releases once the carrier is this far past both athletes. */
export const CARRIER_PAST_YARDS = 2;
/** A carrier passing this close (centre to centre) to an engaged defender doubles his chance to get off the block. */
export const ARMS_REACH = 1.6;
/** Longest an engagement lasts before the defender works free. */
export const MAX_ENGAGEMENT_SECONDS = { run: 3, pass: 4.5 };
/** Once a defender beats a block (shed, timeout, release) that blocker cannot re-engage him for this long. */
export const BLOCK_COOLDOWN_SECONDS = 0.9;
/** A pancaked defender who gets back up is not pancaked again by the same blocker straight away. */
export const PANCAKE_COOLDOWN_SECONDS = 2.2;

/**
 * Share of the chase-shed chance an engaged defender keeps when he has NOT decided to come off the block onto the
 * carrier (his intent is not a 'shed' aimed at the carrier: still playing the blocker, still reading, or working to
 * a zone). The decision (and so the difficulty: reaction delay and run-fit judgement) is the AI's; the roll is ratings.
 */
export const SHED_UNREAD_SHARE = 0.5;

const PASS_TYPES = new Set(['pass', 'playAction', 'screen', 'rpo']);

/**
 * A carrier is RUSHING (not a passer in the pocket, not a receiver after the catch): a designed run, a handoff or
 * pitch, or a QB past the line on a play with no pass thrown. Only then do linebackers and backs at the second level
 * come off blocks at the fast second-level rate.
 */
const rushingCarrier = (state: PlayState, env: EngineEnv, carrier: Athlete, attack: number): boolean =>
  !PASS_TYPES.has(state.ctx.offensivePlay.type) || env.handoffDone || env.pitched
  || (state.pass === null && carrier.position === 'QB' && attack * (carrier.pos.y - state.losY) > 0);

const BLOCK_TYPES = new Set(['runBlock', 'passBlock', 'leadBlock', 'chipRelease', 'returnBlock']);
const RANK: Record<BlockOutcome['result'], number> = { pancake: 3, engaged: 2, stalemate: 1, shed: 0 };

const isBlocker = (state: PlayState, a: Athlete): boolean => {
  const it = state.intents[a.id];
  if (it?.action === 'block') return true;
  if (BLOCK_TYPES.has(a.assignment.type)) return true;
  return a.assignment.type === 'route' && ((a.assignment as OffAssignment).route ?? '').toLowerCase().includes('block');
};

const release = (a: Athlete | null): void => {
  if (!a) return;
  a.engagedWith = null;
  if (a.state === 'engaged') a.state = 'moving';
};

/** Ends one engagement. The defender stays locked up while another blocker (a double team) still has him. */
const endEngagement = (state: PlayState, env: EngineEnv, e: Engagement, cooldown = BLOCK_COOLDOWN_SECONDS): void => {
  env.engagements = env.engagements.filter((x) => x !== e);
  env.blockCooldown[pairKey(e.blockerId, e.rusherId)] = state.time + cooldown;
  release(findAthlete(state, e.blockerId));
  const rusher = findAthlete(state, e.rusherId);
  const other = env.engagements.find((x) => x.rusherId === e.rusherId);
  if (rusher && other && rusher.state === 'engaged') rusher.engagedWith = other.blockerId;
  else release(rusher);
};

/** Ends every engagement on a defender (he split the double team or was put on the ground). */
const endAllOn = (state: PlayState, env: EngineEnv, rusherId: string, cooldown: number): void => {
  for (const x of env.engagements.filter((o) => o.rusherId === rusherId)) endEngagement(state, env, x, cooldown);
};

/** The defender beats the block: he is free (and briefly off balance), the blocker stumbles, holding may be called. */
const beatBlock = (state: PlayState, env: EngineEnv, blocker: Athlete, rusher: Athlete, score: number): void => {
  env.shedBy[rusher.id] = blocker.id;
  emit(state, { type: 'blockShed', tick: state.tick, defender: rusher.id, blocker: blocker.id });
  const passer = env.engagements.some((x) => x.rusherId === rusher.id && x.kind === 'pass') ? pocketPasser(state) : null;
  endAllOn(state, env, rusher.id, passer ? BEATEN_SET_COOLDOWN_SECONDS : BLOCK_COOLDOWN_SECONDS);
  if (passer) slipPast(blocker, rusher, passer, state.tick);
  setTimedState(rusher, 'shedding', 0.3);
  setTimedState(blocker, 'stumbling', 0.3);
  onBlockShed(state, env, blocker, rusher, score);
};

/**
 * A rusher who beats a pass set gets to the blocker's shoulder (the side he was already working) and accelerates
 * past it toward the passer, instead of still standing in front of the man he just beat.
 */
const slipPast = (blocker: Athlete, rusher: Athlete, passer: Athlete, tick: number): void => {
  const nx0 = passer.pos.x - blocker.pos.x;
  const ny0 = passer.pos.y - blocker.pos.y;
  const nl = Math.hypot(nx0, ny0) || 1;
  const nx = nx0 / nl;
  const ny = ny0 / nl;
  const cross = nx * (rusher.pos.y - blocker.pos.y) - ny * (rusher.pos.x - blocker.pos.x);
  const side = Math.abs(cross) > 0.05 ? Math.sign(cross) : tick % 2 === 0 ? 1 : -1;
  const px = -ny * side;
  const py = nx * side;
  rusher.pos.x += px * SLIP_SHIFT;
  rusher.pos.y += py * SLIP_SHIFT;
  rusher.vel = { x: (px * 0.8 + nx) * SLIP_SPEED * 0.78, y: (py * 0.8 + ny) * SLIP_SPEED * 0.78 };
};

const resolveContest = (state: PlayState, env: EngineEnv, e: Engagement, blocker: Athlete, rusher: Athlete): void => {
  const double = env.engagements.some((o) => o !== e && o.rusherId === e.rusherId);
  let out = blockContest(blocker, rusher, e.kind, env.rng);
  if (double) {
    // A double team usually wins the rep (the better of two rolls), but a quick lineman can still split it.
    const alt = blockContest(blocker, rusher, e.kind, env.rng);
    if (RANK[alt.result] > RANK[out.result] && (out.result !== 'shed' || env.rng.chance(DOUBLE_HOLD_SHARE))) out = alt;
  }
  // In the pocket a single roll does not beat the set (the wear-down hazard does): it says who is winning the rep.
  // Only a clear mismatch can win at the first punch (a quick win off the snap), and then only sometimes.
  const gap = EARLY_BEAT_SCORE - (out.blockerPower - out.rusherPower);
  if (e.kind === 'pass' && out.result === 'shed' && pocketPasser(state)
    && !(e.age === 0 && !pickups.has(e) && gap > 0 && env.rng.chance(Math.min(EARLY_WIN_SHARE, gap * 2)))) {
    out = { ...out, result: 'stalemate', pushVec: { x: 0, y: 0 } };
  }
  // Off the snap a down lineman sometimes simply wins the gap (quicker hands, the blocker's poor first step): a
  // penetration that blows up the run, likelier the more the defender is the better player. Not through a double.
  if (e.kind === 'run' && e.age === 0 && !double && out.result !== 'shed' && (rusher.position === 'DT' || rusher.position === 'DE')
    && runPlay(state) && env.rng.chance(clamp01(RUN_PENETRATION * Math.exp(-RUN_PENETRATION_SLOPE * (out.blockerPower - out.rusherPower))))) {
    out = { ...out, result: 'shed', pushVec: { x: 0, y: 0 } };
  }
  noteContact(env, blocker);
  noteContact(env, rusher);
  const score = out.blockerPower - out.rusherPower;
  e.score = score;
  switch (out.result) {
    case 'pancake':
      setTimedState(rusher, 'down', 1.5);
      rusher.vel = { x: 0, y: 0 };
      emit(state, { type: 'pancake', tick: state.tick, blocker: blocker.id, defender: rusher.id });
      endAllOn(state, env, rusher.id, PANCAKE_COOLDOWN_SECONDS);
      break;
    case 'shed':
      beatBlock(state, env, blocker, rusher, score);
      break;
    case 'engaged':
      // A winning pass set stalls the rusher (a slight give back), it does not drive him upfield like a run block.
      e.push = { x: out.pushVec.x * (e.kind === 'pass' ? 0.2 : 1), y: out.pushVec.y * (e.kind === 'pass' ? 0.2 : 1) };
      break;
    case 'stalemate':
      e.push = { x: 0, y: 0 };
      break;
  }
};

/**
 * A block is a pass set when the blocker is in pass protection, or (while the passer is in the pocket) is a back or
 * receiver who stayed in to pick up a rusher, or a lineman protecting after a play-action fake.
 */
const passSet = (state: PlayState, blocker: Athlete): boolean => {
  const t = blocker.assignment.type;
  if (t === 'passBlock') return true;
  if (blocker.side !== 'offense' || pocketPasser(state) === null) return false;
  return t === 'route' || t === 'chipRelease' || (t === 'runBlock' && state.ctx.offensivePlay.type === 'playAction');
};

const engage = (state: PlayState, env: EngineEnv, blocker: Athlete, rusher: Athlete): void => {
  const kind: Engagement['kind'] = passSet(state, blocker) ? 'pass' : 'run';
  const e: Engagement = { blockerId: blocker.id, rusherId: rusher.id, kind, timer: kind === 'pass' ? PASS_RE_ROLL_SECONDS : RE_ROLL_SECONDS, age: 0, push: { x: 0, y: 0 }, score: 0 };
  const joining = rusher.state === 'engaged';
  if (kind === 'pass' && env.shedBy[rusher.id] !== undefined && pocketPasser(state)) {
    pickups.add(e);
    e.age = PASS_SET_SECONDS + PICKUP_WEAR;
  } else if (kind === 'pass' && rusher.assignment.type === 'blitz' && pocketPasser(state)) {
    // A blitzer is not a down lineman taking on a set: he arrives from depth at speed (often on a back or a sliding
    // lineman), so that rep is won far sooner. The blitz is what gets home early, not the four-man rush.
    e.age = PASS_SET_SECONDS + BLITZ_PICKUP_WEAR;
  }
  if (kind === 'pass' && pocketPasser(state)) {
    const extra = extraRushers(state);
    if (extra > 0) {
      stretched.set(e, STRETCH_EDGE * extra);
      e.age += STRETCH_WEAR * extra;
    }
  }
  env.engagements.push(e);
  blocker.state = 'engaged';
  rusher.state = 'engaged';
  blocker.engagedWith = rusher.id;
  if (!joining) rusher.engagedWith = blocker.id;
  blocker.vel = { x: 0, y: 0 };
  rusher.vel = { x: 0, y: 0 };
  emit(state, { type: 'blockEngage', tick: state.tick, blocker: blocker.id, defender: rusher.id, kind });
  resolveContest(state, env, e, blocker, rusher);
};

const updateEngagement = (state: PlayState, env: EngineEnv, e: Engagement, dt: number, carrier: Athlete | null): void => {
  const blocker = findAthlete(state, e.blockerId);
  const rusher = findAthlete(state, e.rusherId);
  if (!blocker || !rusher || !blocker.active || !rusher.active || blocker.state !== 'engaged' || rusher.state !== 'engaged' || blocker.hasBall || rusher.hasBall || dist(blocker.pos, rusher.pos) > BREAK_DISTANCE) {
    // Broken by circumstance (someone went down, drifted apart): no cooldown, they may lock up again at once.
    endEngagement(state, env, e, 0);
    return;
  }
  e.age += dt;
  e.timer -= dt;
  const passer = e.kind === 'pass' ? pocketPasser(state) : null;
  const pass = passer !== null;
  // In the pocket the rep ends on the wear-down hazard, not on a clock.
  if (!pass && e.age >= MAX_ENGAGEMENT_SECONDS[e.kind]) {
    emit(state, { type: 'blockShed', tick: state.tick, defender: rusher.id, blocker: blocker.id });
    endEngagement(state, env, e);
    return;
  }
  if (carrier && carrier.side !== rusher.side) {
    const attack = carrier.side === 'offense' ? state.ctx.direction : -state.ctx.direction;
    const past = attack * (carrier.pos.y - Math.max(attack * blocker.pos.y, attack * rusher.pos.y) * attack);
    // Once the carrier is past both men the block has done its job (a pass set too: the ball is downfield).
    if (past > CARRIER_PAST_YARDS) {
      endEngagement(state, env, e);
      return;
    }
    if (dist(carrier.pos, rusher.pos) <= 2.5) {
      // Getting off a block to chase a carrier going by: a defender who is winning the block (or holding his own)
      // works free quickly, one who is being driven stays locked up - the blocked man does not simply let go and
      // wrap the back at the line.
      const leverage = clamp01(0.25 - e.score);
      // Return-unit blocks are shields on the run, not a locked-up line: coverage men slip them quickly.
      const returnBlock = blocker.assignment.type === 'returnBlock';
      // A lineman locked up at the line stays locked up; a linebacker or defensive back (or anyone at the second
      // level) on a climbing blocker gets off it, and a runner cutting right past him within arm's reach is the
      // moment he does.
      const lineman = rusher.position === 'DE' || rusher.position === 'DT';
      const secondLevel = rushingCarrier(state, env, carrier, attack) && (!lineman || attack * (rusher.pos.y - state.losY) > 1.5);
      const armsReach = dist(carrier.pos, rusher.pos) <= ARMS_REACH ? 2 : 1;
      const intent = state.intents[rusher.id];
      // Kick coverage slips return blocks on sight (no read involved); a scrimmage defender must decide to come off.
      const decided = returnBlock || rusher.controlled || (intent?.action === 'shed' && intent.targetId === carrier.id) ? 1 : SHED_UNREAD_SHARE;
      // Ratings roll it (awareness to feel the runner, strength to rip free); the decision to go sets the share.
      const p = dt * ((returnBlock ? 1.5 : secondLevel ? 0.9 : 0.15) + 1.5 * leverage) * armsReach * decided
        * (0.4 + 0.6 * (0.2 + 0.4 * ratingToFactor(rusher.attrs.awareness) + 0.2 * ratingToFactor(rusher.attrs.strength)));
      if (env.rng.chance(p)) {
        endEngagement(state, env, e);
        return;
      }
    }
  }
  // A combo blocker who has moved on (climbing to the second level) lets go of the down lineman his partner holds.
  const it = state.intents[blocker.id];
  if (e.kind === 'run' && (it?.action !== 'block' || it.targetId !== rusher.id) && env.engagements.some((o) => o !== e && o.rusherId === rusher.id)) {
    endEngagement(state, env, e, 0);
    return;
  }
  // The pocket model (set window, steady rep cadence, wear-down, moving wall) is for a passer in the pocket; a kick
  // protection or a broken play keeps the plain contest.
  if (pass && e.age > PASS_SET_SECONDS) {
    const late = Math.max(0, e.age - PASS_LATE_AGE);
    const hazard = PASS_BEAT_RATE * (e.age - PASS_SET_SECONDS + PASS_BEAT_ONSET) * Math.exp(-PASS_BEAT_SLOPE * repScore(e))
      + PASS_LATE_RATE * late * Math.exp(-PASS_LATE_SLOPE * repScore(e));
    if (env.rng.chance(clamp01(hazard * dt))) {
      beatBlock(state, env, blocker, rusher, e.score);
      return;
    }
  }
  const shedIntent = !pass && state.intents[rusher.id]?.action === 'shed' && e.timer < RE_ROLL_SECONDS - 0.15;
  if (e.timer <= 0 || shedIntent) {
    e.timer = pass ? PASS_RE_ROLL_SECONDS : RE_ROLL_SECONDS;
    resolveContest(state, env, e, blocker, rusher);
    if (!env.engagements.includes(e)) return;
  }
  const k = dt;
  blocker.pos.x += e.push.x * k;
  blocker.pos.y += e.push.y * k;
  rusher.pos.x += e.push.x * k;
  rusher.pos.y += e.push.y * k;
  if (passer) holdTheWall(repScore(e), blocker, rusher, passer, dt);
  const d = dist(blocker.pos, rusher.pos);
  const r = blocker.radius + rusher.radius;
  if (d < r) separate(blocker, rusher, r - d);
};

/**
 * Who is winning a pocket rep (blocker minus rusher), a pickup of a rusher already through, and a protection
 * stretched by a blitz, counting against the set.
 */
const repScore = (e: Engagement): number => e.score - (pickups.has(e) ? PICKUP_EDGE : 0) - (stretched.get(e) ?? 0);

/** The passer a pass set is protecting: the offense's quarterback, ball in hand, behind the line. */
const pocketPasser = (state: PlayState): Athlete | null => {
  const c = ballCarrier(state);
  if (!c || c.side !== 'offense' || c.assignment.type !== 'qb') return null;
  return state.ctx.direction * (c.pos.y - state.losY) <= 0 ? c : null;
};

/** Yards per second the set gives up toward the passer: slow at an even rep, faster the more the rusher is winning. */
export const giveGroundRate = (score: number): number => clamp(GIVE_GROUND_EVEN - 1.5 * score, GIVE_GROUND_MIN, GIVE_GROUND_MAX);

/**
 * The moving wall: the rusher's own drive toward the passer beyond the give-ground rate is absorbed, and the blocker
 * slides (at his shuffle speed) to stay on the line between the rusher and the passer.
 */
const holdTheWall = (score: number, blocker: Athlete, rusher: Athlete, passer: Athlete, dt: number): void => {
  const bx = passer.pos.x - blocker.pos.x;
  const by = passer.pos.y - blocker.pos.y;
  const bl = Math.hypot(bx, by);
  if (bl > 1e-6) {
    const nx = bx / bl;
    const ny = by / bl;
    const toward = rusher.vel.x * nx + rusher.vel.y * ny;
    const anchor = clamp01((bl - ANCHOR_YARDS) / ANCHOR_RAMP);
    const excess = toward - giveGroundRate(score) * anchor;
    if (excess > 0) {
      rusher.pos.x -= nx * excess * dt;
      rusher.pos.y -= ny * excess * dt;
      rusher.vel.x -= nx * excess;
      rusher.vel.y -= ny * excess;
    }
  }
  const rx = passer.pos.x - rusher.pos.x;
  const ry = passer.pos.y - rusher.pos.y;
  const rl = Math.hypot(rx, ry);
  if (rl < 1e-6) return;
  const gap = blocker.radius + rusher.radius + 0.02;
  const wantX = rusher.pos.x + (rx / rl) * gap;
  const wantY = rusher.pos.y + (ry / rl) * gap;
  const dx = wantX - blocker.pos.x;
  const dy = wantY - blocker.pos.y;
  const dl = Math.hypot(dx, dy);
  const mirror = maxSpeed(blocker.attrs.speed) * (0.55 + 0.25 * ratingToFactor(blocker.attrs.agility)) * dt;
  const step = Math.min(dl, mirror);
  if (dl > 1e-6) {
    blocker.pos.x += (dx / dl) * step;
    blocker.pos.y += (dy / dl) * step;
  }
};

/**
 * A run blocker who wants a defender already locked up in a run block joins it (a double team / combo) when he gets
 * to him. Never more than two on one man, never on a pass set.
 */
const joinDouble = (state: PlayState, env: EngineEnv, blocker: Athlete, rusher: Athlete): boolean => {
  if (blocker.assignment.type !== 'runBlock' && blocker.assignment.type !== 'leadBlock') return false;
  const on = env.engagements.filter((x) => x.rusherId === rusher.id);
  if (on.length !== 1 || on[0]?.kind !== 'run' || rusher.hasBall) return false;
  if (dist(blocker.pos, rusher.pos) >= blocker.radius + rusher.radius + 0.6) return false;
  if ((env.blockCooldown[pairKey(blocker.id, rusher.id)] ?? 0) > state.time) return false;
  engage(state, env, blocker, rusher);
  return true;
};

/**
 * In the pocket a pass blocker whose own man is right there does not lock up with a rusher a teammate has (a blitzer
 * crossing his face on a linebacker twist runs on into the back picking him up, instead of 'picking' the guard off
 * his man and leaving the crosser free).
 */
const leaveToMate = (state: PlayState, env: EngineEnv, blocker: Athlete, rusher: Athlete): boolean => {
  const mine = blocker.ai.blockTargetId;
  if (!mine || mine === rusher.id || blocker.side !== 'offense' || !passSet(state, blocker) || !pocketPasser(state)) return false;
  const m = findAthlete(state, mine);
  if (!m || !canAct(m) || dist(m.pos, blocker.pos) > 3) return false;
  // ...only a mate who is there to take him (not one he has just beaten: a spare still picks up a rusher who got by).
  return state.athletes.some((t) => t.side === blocker.side && t.id !== blocker.id && canAct(t) && t.ai.blockTargetId === rusher.id
    && dist(t.pos, rusher.pos) < 4 && (env.blockCooldown[pairKey(t.id, rusher.id)] ?? 0) <= state.time);
};

/** One tick of blocking. */
export const blockingSystem = (state: PlayState, env: EngineEnv, dt: number): void => {
  if (state.phase !== 'live') return;
  const carrier = ballCarrier(state);
  for (const e of env.engagements.slice()) updateEngagement(state, env, e, dt, carrier);
  for (const blocker of state.athletes) {
    if (!canAct(blocker) || blocker.hasBall || blocker.state === 'diving' || !isBlocker(state, blocker)) continue;
    const it = state.intents[blocker.id];
    const wanted = it?.action === 'block' ? findAthlete(state, it.targetId) : null;
    if (wanted && wanted.state === 'engaged' && joinDouble(state, env, blocker, wanted)) continue;
    for (const rusher of state.athletes) {
      if (rusher.side === blocker.side || !canAct(rusher) || rusher.hasBall || rusher.state === 'diving' || rusher.state === 'jumping') continue;
      const reach = blocker.radius + rusher.radius + (wanted?.id === rusher.id ? 0.6 : ENGAGE_REACH);
      if (dist(blocker.pos, rusher.pos) >= reach) continue;
      if ((env.blockCooldown[pairKey(blocker.id, rusher.id)] ?? 0) > state.time || leaveToMate(state, env, blocker, rusher)) continue;
      engage(state, env, blocker, rusher);
      break;
    }
  }
};
