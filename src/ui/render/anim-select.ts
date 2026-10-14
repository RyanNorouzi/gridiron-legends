/**
 * Clip selection (art bible §6): picks each athlete's Look from the engine state, velocity, facing and recent
 * events, deterministically (scene ticks and id hashes only; no frame clock, no Math.random), so a replay of a play
 * looks exactly like the live play. Layers, highest priority wins (anim-ids.ts priorities):
 *  1. a registered CONTACT OVERRIDE (chain B's pair solver and tackle choreography) for the athletes it covers;
 *  2. the look from the athlete's state (stance, locomotion by speed share of his top speed with the phase from the
 *     odometer, moves, throws, catches, kicks, blocks, tackles, falls);
 *  3. event one-shots (throw, catch, handoff, kick, snap, spike, kneel, first-down fist pump, sack dance, scorer
 *     celebrations), timed from the event tick so they are rebuilt identically after a replay seek;
 *  4. a running one-shot from memory keeps playing to its end unless something of higher priority takes over;
 *  5. transitions: getUp after lying down, cut on a hard heading change at speed.
 */
import type { AthleteState, BallPhase } from '@/game/play-types';
import type { PlayEvent } from '@/game/play-events';
import type { AnimId } from './anim-ids';
import { clipSeconds, clipTiming, frameAt, strideFrame, type Look } from './anim';
import type { AnimMemory } from './anim-memory';
import { facingFromScreenVector } from './sprites';
import type { FigureTier } from './world-layer';

/** The athlete fields selection reads (a subset of the field view's SceneAthlete). */
export interface LookAthlete {
  id: string;
  side: 'offense' | 'defense';
  position: string;
  role: string;
  state: AthleteState;
  stateTimer: number;
  hasBall: boolean;
  /** Heading drawn (velocity heading while moving, else the body facing), world radians. */
  facing: number;
  /** Engine body facing, world radians (backpedal faces against the velocity). */
  bodyFacing?: number;
  engagedWith?: string | null;
  blockTargetId?: string | null;
  vx?: number;
  vy?: number;
  /** Top speed, yd/s (jog / run / sprint thresholds); default 8. */
  topSpeed?: number;
}

/** An athlete placed on the world layer: feet in art px, world spot (yards) and screen heading / body direction. */
export interface PlacedAthlete {
  a: LookAthlete;
  x: number;
  y: number;
  wx: number;
  wy: number;
  /** Screen direction of the drawn heading (unit). */
  dir: { x: number; y: number };
  /** Screen direction of the body facing (unit). */
  body: { x: number; y: number };
}

/** Scene facts selection reads. */
export interface LookContext {
  mem: AnimMemory;
  presnap: boolean;
  tier: FigureTier;
  /** False freezes loops on their first frame (Settings.animations off); one-shots still play. */
  animate: boolean;
  ball: { x: number; y: number; phase: BallPhase; carrierId: string | null };
  losY: number | null;
  snapX: number;
  placed: readonly PlacedAthlete[];
  byId: ReadonlyMap<string, PlacedAthlete>;
}

/** Chain B's hook: looks for the athletes it choreographs (others fall through to the core look). */
export type LookOverride = (ctx: LookContext, core: ReadonlyMap<string, Look>) => ReadonlyMap<string, Look> | null;

const overrides: LookOverride[] = [];

/** Registers a contact override (applied in registration order; later ones win). Returns an unregister function. */
export const registerLookOverride = (fn: LookOverride): (() => void) => {
  overrides.push(fn);
  return () => {
    const i = overrides.indexOf(fn);
    if (i >= 0) overrides.splice(i, 1);
  };
};

/** Small deterministic hash of an id (loop phases, variants). */
export const idHash = (s: string): number => {
  let h = 7;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
};

const speedOf = (a: LookAthlete): number => Math.hypot(a.vx ?? 0, a.vy ?? 0);
const face = (v: { x: number; y: number }): Look['facing'] => facingFromScreenVector(v.x, v.y);
const toward = (p: PlacedAthlete, q: PlacedAthlete): Look['facing'] => facingFromScreenVector(q.x - p.x, q.y - p.y);
const lookOf = (clip: AnimId, frame: number, facing: Look['facing']): Look => ({ clip, frame, facing, dx: 0, dy: 0, lying: clipTiming(clip).lying === true && frame >= clipTiming(clip).frames - 1 });

/** Loop frame on the scene clock with a per-athlete phase (frozen when not animating). */
const loopAt = (clip: AnimId, ctx: LookContext, id: string): number => (ctx.animate ? frameAt(clip, ctx.mem.now, idHash(id) % clipTiming(clip).frames) : 0);

/** Pre-snap stance for a position / alignment. */
export const stanceFor = (p: PlacedAthlete, ctx: Pick<LookContext, 'snapX' | 'ball'>): AnimId => {
  const a = p.a;
  const inline = Math.abs(p.wx - ctx.snapX) < 5.5;
  switch (a.position) {
    case 'C': return 'snapStance';
    case 'OT': case 'OG': case 'DE': case 'DT': return 'stance3';
    case 'TE': case 'FB': return inline ? 'stance3' : 'stance2';
    case 'QB': return Math.hypot(p.wx - ctx.ball.x, p.wy - ctx.ball.y) <= 1.5 ? 'qbUnderCenter' : 'qbShotgun';
    case 'CB': case 'FS': case 'SS': return 'dbReady';
    case 'K': case 'P': return 'idle';
    default: return a.role === 'KR' || a.role === 'PR' || a.role.startsWith('ret') ? 'returnerReady' : 'stance2';
  }
};

/** The engaged partner (engagedWith, or the nearest engaged opponent within 1.6 yd when the scene lacks it: replays). */
export const partnerOf = (p: PlacedAthlete, ctx: LookContext): PlacedAthlete | null => {
  const id = p.a.engagedWith ?? null;
  if (id) return ctx.byId.get(id) ?? null;
  if (p.a.engagedWith === null) {
    for (const q of ctx.placed) if (q.a.engagedWith === p.a.id) return q;
    return null;
  }
  let best: PlacedAthlete | null = null;
  let bd = 1.6;
  for (const q of ctx.placed) {
    if (q.a.side === p.a.side || !(q.a.state === 'engaged' || q.a.state === 'blocking' || q.a.state === 'shedding')) continue;
    const d = Math.hypot(q.wx - p.wx, q.wy - p.wy);
    if (d < bd) { bd = d; best = q; }
  }
  return best;
};

const nearestOpponent = (p: PlacedAthlete, ctx: LookContext, pred: (q: PlacedAthlete) => boolean, within = 2): PlacedAthlete | null => {
  let best: PlacedAthlete | null = null;
  let bd = within;
  for (const q of ctx.placed) {
    if (q === p || q.a.side === p.a.side || !pred(q)) continue;
    const d = Math.hypot(q.wx - p.wx, q.wy - p.wy);
    if (d < bd) { bd = d; best = q; }
  }
  return best;
};

const LOCOMOTION_STATES: ReadonlySet<AthleteState> = new Set<AthleteState>(['idle', 'presnap', 'moving', 'blocking', 'scrambling', 'dropback']);

/** Locomotion (or idle) look from speed, heading vs body facing, and the odometer. */
const locomotion = (p: PlacedAthlete, ctx: LookContext): Look => {
  const a = p.a;
  const speed = speedOf(a);
  const own = face(p.dir);
  if (speed < 0.5) {
    if (a.state === 'dropback') return lookOf('setFeet', loopAt('setFeet', ctx, a.id), face(p.body));
    return lookOf('idle', loopAt('idle', ctx, a.id), face(p.body));
  }
  const bf = a.bodyFacing ?? a.facing;
  const along = (a.vx ?? 0) * Math.cos(bf) + (a.vy ?? 0) * Math.sin(bf);
  const lateral = Math.abs(-(a.vx ?? 0) * Math.sin(bf) + (a.vy ?? 0) * Math.cos(bf));
  const pos = a.position;
  let clip: AnimId;
  let facing = own;
  if (a.state === 'dropback' && a.hasBall) {
    clip = 'dropback';
    facing = face(p.body);
  } else if (along < -0.3 * speed && !a.hasBall && (pos === 'CB' || pos === 'FS' || pos === 'SS' || pos === 'OLB' || pos === 'MLB' || pos === 'QB')) {
    clip = 'backpedal';
    facing = face(p.body);
  } else if (lateral > 0.6 * speed && speed < 5 && !a.hasBall) {
    clip = 'shuffle';
    facing = face(p.body);
  } else {
    const share = speed / Math.max(1, a.topSpeed ?? 8);
    if (a.hasBall) clip = a.state === 'scrambling' || (pos === 'QB' && a.state === 'dropback') ? 'carryHigh' : share >= 0.85 ? 'carrySprint' : 'carry';
    else clip = share >= 0.85 ? 'sprint' : share >= 0.55 ? 'run' : 'jog';
  }
  const frame = ctx.animate ? strideFrame(clip, ctx.mem.distance(a.id), idHash(a.id) % clipTiming(clip).frames) : 0;
  return lookOf(clip, frame, facing);
};

/** The look the athlete's state asks for (before events and memory). */
export const stateLook = (p: PlacedAthlete, ctx: LookContext): Look => {
  const a = p.a;
  const own = face(p.dir);
  const t = a.stateTimer;
  const mem = ctx.mem;
  const m = mem.of(a.id);
  const once = (clip: AnimId, facing = own): Look => lookOf(clip, frameAt(clip, t), facing);
  if (ctx.presnap && (a.state === 'idle' || a.state === 'presnap' || (a.state === 'moving' && speedOf(a) < 0.5))) {
    const clip = stanceFor(p, ctx);
    return lookOf(clip, loopAt(clip, ctx, a.id), face(p.body));
  }
  switch (a.state) {
    case 'engaged': case 'shedding': {
      const partner = partnerOf(p, ctx);
      const facing = partner ? toward(p, partner) : face(p.body);
      if (a.state === 'shedding') return lookOf('swim', frameAt('swim', t), facing);
      return lookOf('handFight', loopAt('handFight', ctx, a.id), facing);
    }
    case 'blocking': {
      const partner = a.engagedWith ? partnerOf(p, ctx) : null;
      if (partner) return lookOf('handFight', loopAt('handFight', ctx, a.id), toward(p, partner));
      return locomotion(p, ctx);
    }
    case 'tackling': {
      const target = nearestOpponent(p, ctx, (q) => q.a.hasBall || q.a.state === 'wrapped' || q.a.state === 'tackled');
      return lookOf('tackleLunge', frameAt('tackleLunge', t), target ? toward(p, target) : own);
    }
    case 'wrapping': return lookOf('hangOn', loopAt('hangOn', ctx, a.id), own);
    case 'wrapped': return lookOf('struggle', loopAt('struggle', ctx, a.id), own);
    case 'tackled': {
      const hitter = nearestOpponent(p, ctx, (q) => q.a.state === 'tackling' || q.a.state === 'wrapping' || q.a.state === 'diving' || q.a.state === 'falling');
      const behind = hitter ? (hitter.x - p.x) * p.dir.x + (hitter.y - p.y) * p.dir.y < 0 : false;
      m.fell = behind ? 'fwd' : 'back';
      return once(behind ? 'tackledFwd' : 'tackledBack');
    }
    case 'falling': {
      const tackler = m.last?.clip === 'tackleLunge' || m.last?.clip === 'hangOn' || m.last?.clip === 'wrap' || (a.side === 'defense' && !a.hasBall);
      if (tackler) return lookOf('wrap', Math.min(5, 3 + Math.floor(t * 9)), own);
      const fwd = (a.vx ?? 0) * Math.cos(a.facing) + (a.vy ?? 0) * Math.sin(a.facing) >= 0;
      m.fell = m.fell ?? (fwd ? 'fwd' : 'back');
      return once(m.fell === 'fwd' ? 'fallFwd' : 'fallBack');
    }
    case 'down': {
      const injured = mem.lastEvent(a.id, 'injury');
      if (injured) return lookOf('injuredDown', loopAt('injuredDown', ctx, a.id), own);
      if (m.last && (m.last.clip === 'wrap' || m.last.clip === 'hangOn' || m.last.clip === 'tackleLunge')) return lookOf('wrap', 5, m.last.facing);
      return lookOf(m.fell === 'back' ? 'downBack' : 'down', 0, m.last?.facing ?? own);
    }
    case 'diving': return once(a.side === 'defense' && !a.hasBall ? 'diveTackle' : 'catchDive');
    case 'sliding': return once('slide');
    case 'stumbling': return once(a.side === 'defense' && m.last?.clip === 'handFight' ? 'knockback' : 'stumble');
    case 'juking': return once('juke');
    case 'spinning': return once('spin');
    case 'hurdling': return once('hurdle');
    case 'stiffArming': return once('stiffArm');
    case 'trucking': return once('truck');
    case 'throwing': {
      const ev = mem.lastEvent(a.id, 'throw');
      const lob = ev && (ev.throwType === 'lob' || ev.throwType === 'touch');
      return once(lob ? 'throwLob' : speedOf(a) > 3 ? 'throwRun' : 'throw');
    }
    case 'catching': return once('catchChest');
    case 'jumping': return once(a.side === 'offense' ? 'catchHigh' : 'jumpContest');
    case 'kicking': return once('kickoff');
    case 'celebrating': return lookOf('celebrateFlex', loopAt('celebrateFlex', ctx, a.id), own);
    default:
      return LOCOMOTION_STATES.has(a.state) ? locomotion(p, ctx) : lookOf('idle', loopAt('idle', ctx, a.id), own);
  }
};

/** Clip a catch event plays. */
const catchClip = (e: Extract<PlayEvent, { type: 'catch' }>): AnimId => {
  const k = String(e.catchKind);
  if (k.includes('dive') || k.includes('Dive')) return 'catchDive';
  if (k.includes('high') || k.includes('High') || k.includes('jump')) return 'catchHigh';
  if (k.includes('sideline') || k.includes('toe')) return 'catchSideline';
  if (k.includes('rac') || k.includes('Rac') || k.includes('turn')) return 'catchTurn';
  return 'catchChest';
};

const CELEBRATIONS: readonly AnimId[] = ['celebrateSpike', 'celebrateLeap', 'celebratePoint'];

/**
 * The event one-shot running for an athlete right now (null when none): the clip and its start in scene seconds.
 * Pure function of the events and the tick, so a replay seek rebuilds it exactly.
 */
export const eventOneShot = (p: PlacedAthlete, ctx: LookContext): { clip: AnimId; start: number } | null => {
  const mem = ctx.mem;
  const list = mem.eventsOf(p.a.id);
  for (let i = list.length - 1; i >= 0; i--) {
    const e = list[i] as PlayEvent;
    const since = mem.timeSince(e);
    if (since < -1e-6) continue;
    if (since > 2.5) break;
    const at = e.tick / 60;
    let clip: AnimId | null = null;
    let lead = 0;
    switch (e.type) {
      case 'throw': if (e.thrower === p.a.id) { clip = e.throwType === 'lob' || e.throwType === 'touch' ? 'throwLob' : 'throw'; lead = 2 / clipTiming(clip).fps; } break;
      case 'catch': if (e.receiver === p.a.id) clip = catchClip(e); break;
      case 'handoff': clip = e.from === p.a.id ? 'handoff' : 'takeHandoff'; break;
      case 'playActionFake': if (e.qb === p.a.id) clip = 'handoff'; break;
      case 'pitch': case 'lateral': if (e.from === p.a.id) clip = 'pitch'; break;
      case 'spike': clip = 'spike'; break;
      case 'kneel': clip = 'kneel'; break;
      case 'kick': if (e.kicker === p.a.id) { clip = e.kind === 'punt' ? 'punt' : e.kind === 'fieldGoal' || e.kind === 'extraPoint' ? 'fieldGoal' : 'kickoff'; lead = 2 / clipTiming(clip).fps; } break;
      case 'firstDown': break;
      case 'sack': if (e.by === p.a.id && ctx.ball.phase === 'dead') clip = 'sackDance'; break;
      case 'touchdown': if (e.scorer === p.a.id) clip = CELEBRATIONS[idHash(p.a.id) % CELEBRATIONS.length] ?? 'celebratePoint'; break;
      case 'fairCatch': if (e.by === p.a.id) clip = 'fairCatch'; break;
      default: break;
    }
    if (!clip) continue;
    const start = at - lead;
    const timing = clipTiming(clip);
    const end = timing.kind === 'loop' ? start + 2.5 : start + clipSeconds(clip);
    if (mem.now - start <= end - start + (timing.kind === 'hold' ? 1 : 0)) return { clip, start };
  }
  return null;
};

/** Snap one-shot for the center (the scene's snap event concerns no athlete). */
const snapOneShot = (p: PlacedAthlete, ctx: LookContext): { clip: AnimId; start: number } | null => {
  if (p.a.position !== 'C') return null;
  const ev = ctx.mem.events.find((e) => e.type === 'snap');
  if (!ev) return null;
  const start = ev.tick / 60;
  return ctx.mem.now - start <= clipSeconds('snap') && ctx.mem.now >= start ? { clip: 'snap', start } : null;
};

const HEADING_BUCKET_TICKS = 9;
const CUT_ANGLE = (50 * Math.PI) / 180;

/** Core look for one athlete: state look vs event one-shot vs running one-shot, plus transitions. */
export const coreLook = (p: PlacedAthlete, ctx: LookContext): Look => {
  const a = p.a;
  const mem = ctx.mem;
  const m = mem.of(a.id);
  let look = stateLook(p, ctx);
  let prio = clipTiming(look.clip).priority;
  const ev = eventOneShot(p, ctx) ?? snapOneShot(p, ctx);
  if (ev && clipTiming(ev.clip).priority >= prio) {
    look = lookOf(ev.clip, frameAt(ev.clip, mem.now - ev.start, idHash(a.id)), look.facing);
    prio = clipTiming(ev.clip).priority;
    m.oneShot = ev;
  } else if (clipTiming(look.clip).kind !== 'loop') {
    // A state-driven one-shot: remember when it started so it can finish after the state ends.
    if (!m.oneShot || m.oneShot.clip !== look.clip) m.oneShot = { clip: look.clip, start: mem.now - a.stateTimer };
  } else if (m.oneShot) {
    const os = m.oneShot;
    const timing = clipTiming(os.clip);
    const elapsed = mem.now - os.start;
    if (elapsed < 0 || elapsed >= clipSeconds(os.clip) || timing.kind === 'hold') m.oneShot = null;
    else if (timing.priority > prio) look = lookOf(os.clip, frameAt(os.clip, elapsed), m.last?.facing ?? look.facing);
    else m.oneShot = null;
  }
  // getUp: was lying, now upright and not in contact.
  const nowLying = look.lying === true || clipTiming(look.clip).priority === 4;
  if (m.last?.lying && !nowLying && clipTiming(look.clip).priority <= 2) m.lyingUntil = mem.now;
  if (m.lyingUntil !== null) {
    const since = mem.now - m.lyingUntil;
    if (since >= 0 && since < clipSeconds('getUp') && clipTiming(look.clip).priority <= 2 && !nowLying) look = lookOf('getUp', frameAt('getUp', since), look.facing);
    else if (since >= clipSeconds('getUp') || nowLying) m.lyingUntil = null;
  }
  // cut: a hard change of heading at speed, sampled on scene-tick buckets (deterministic).
  const speed = speedOf(a);
  const bucket = Math.floor(mem.tick / HEADING_BUCKET_TICKS);
  const heading = Math.atan2(a.vy ?? 0, a.vx ?? 0);
  if (speed > 4 && clipTiming(look.clip).priority === 1) {
    if (m.heading !== null && bucket !== m.headingAt) {
      let d = Math.abs(heading - m.heading);
      if (d > Math.PI) d = Math.PI * 2 - d;
      if (d > CUT_ANGLE && !m.oneShot) m.oneShot = { clip: 'cut', start: mem.now };
    }
  }
  if (bucket !== m.headingAt || m.heading === null) {
    m.heading = speed > 1 ? heading : null;
    m.headingAt = bucket;
  }
  if (m.oneShot?.clip === 'cut' && clipTiming(look.clip).priority === 1) {
    const e = mem.now - m.oneShot.start;
    if (e >= 0 && e < clipSeconds('cut')) look = lookOf('cut', frameAt('cut', e), look.facing);
  }
  return look;
};

/**
 * Chooses the look of every placed athlete: core looks, then every registered contact override on top. Updates
 * the memory's last look per athlete.
 */
export const chooseLooks = (ctx: LookContext): Map<string, Look> => {
  const out = new Map<string, Look>();
  for (const p of ctx.placed) {
    ctx.mem.observe(p.a.id, p.wx, p.wy);
    out.set(p.a.id, coreLook(p, ctx));
  }
  for (const fn of overrides) {
    const o = fn(ctx, out);
    if (o) for (const [id, look] of o) out.set(id, look);
  }
  for (const [id, look] of out) ctx.mem.of(id).last = look;
  return out;
};
