/**
 * Line-play looks (art bible §6.2), chain B's pair solver: turns the engine's engaged blocker / defender pairs into
 * readable, animated line play instead of a clump.
 *  - Pairs (and double teams: two blockers on one defender) face each other and are pulled to a hands-on-chest
 *    gap (ENGAGE_GAP, tuned for the new field scale; see below), then sway together along the block axis with a
 *    stalemate jitter, all within MAX_RENDER_OFFSET and eased in (no pops). The punch lands as a surge (the two
 *    bodies close PUNCH_SURGE px at the strike, then settle back), and each pair leans LEVERAGE_SHIFT px toward
 *    whoever is winning it (a stalemate by a per-pair hash), so a row of pairs staggers instead of stacking into
 *    one column of helmets.
 *  - What the pair does comes from how it moves (contact-track.ts): driven downfield -> driveBlock / driven; walked
 *    back toward the offense -> anchor / bullRush; otherwise a hand fight. A new engagement opens with the punch
 *    (both bodies). The second blocker of a double team puts his shoulder into the hip (doubleTeam) while the
 *    defender squeezes (splitDouble).
 *  - `blockShed` plays the defender's shed move (swim / rip / spin / long arm, a render-only choice by role and a
 *    hash) and the beaten blocker lunging after him; `pancake` drives the defender onto his back (knockdown, then he
 *    stays down on his back) with the blocker finishing on top.
 *  - Unengaged linemen after the snap kick-slide in a pass set, or fire out of their stance on a run.
 * Deterministic: scene ticks, events, id hashes and the tracker only. Render-only: nothing feeds the simulation.
 */
import type { AnimId } from '../anim-ids';
import { clipSeconds, clipTiming, frameAt, type Look } from '../anim';
import { idHash, partnerOf, type LookContext, type PlacedAthlete } from '../anim-select';
import { facingFromScreenVector } from '../sprites';
import { TIER_SCALE } from '../world-layer';
import { lastPlayEvent, liftOver, ramp, recentEvent, SHED_CLIP, shedChoice } from './contact-events';
import { pairKey, trackOf, type ContactTrack } from './contact-track';

/**
 * Feet-to-feet gap of an engaged pair, art px at tier 1. The bible's 17 px pulled bodies whose simulated centres
 * are >= 1.0 yd (22 art px) apart into one clump at the new scale; 22 keeps grass between the legs with the torsos
 * leaning in and the hands on the pads (tuned, recorded here per the bible's tuning rule).
 */
export const ENGAGE_GAP = 17; // the 1x grid's ~24-px figures
/** Gap while one man drives the other (the driver closes in). */
export const DRIVE_GAP = 15;
/** Largest gap correction per body, art px at tier 1. */
export const GAP_FIX_MAX = 5;
/** How far (art px at tier 1) the two bodies of a pair close at the punch's strike. */
export const PUNCH_SURGE = 3;
/** Shared shift (art px at tier 1) of a pair along its block axis toward the side winning it. */
export const LEVERAGE_SHIFT = 2;
/** Pair velocity along the block axis (yd/s) that reads as a drive block / a bull rush. */
export const DRIVE_SPEED = 0.6;
export const BULL_SPEED = 0.75;

const OL: ReadonlySet<string> = new Set(['C', 'OG', 'OT']);
const ENGAGED_STATES: ReadonlySet<string> = new Set(['engaged', 'blocking']);

const toward = (p: PlacedAthlete, q: PlacedAthlete): Look['facing'] => facingFromScreenVector(q.x - p.x, q.y - p.y);
const lookOf = (clip: AnimId, frame: number, facing: Look['facing'], dx = 0, dy = 0): Look =>
  ({ clip, frame, facing, dx, dy, lying: clipTiming(clip).lying === true && frame >= clipTiming(clip).frames - 1 });
const loopFrame = (clip: AnimId, secs: number, key: string, animate: boolean): number =>
  (animate ? frameAt(clip, secs, idHash(key) % clipTiming(clip).frames) : 0);
const clamp = (v: number, m: number): number => Math.max(-m, Math.min(m, v));

/** How an engaged pair is moving. */
export type PairMotion = 'fight' | 'drive' | 'bull';

/** A pair's midpoint velocity (yd/s) projected on the blocker -> defender axis (+ = the blocker driving). */
export const pairAlong = (track: ContactTrack, b: PlacedAthlete, d: PlacedAthlete, now: number): number => {
  const ux = d.wx - b.wx; const uy = d.wy - b.wy;
  const n = Math.hypot(ux, uy) || 1;
  const v = track.velocity([b.a.id, d.a.id], now, 24);
  return (v.x * ux + v.y * uy) / n;
};

/** Classifies a pair from its midpoint velocity projected on the blocker -> defender axis (yards). */
export const pairMotion = (track: ContactTrack, b: PlacedAthlete, d: PlacedAthlete, now: number): PairMotion => {
  const along = pairAlong(track, b, d, now);
  return along > DRIVE_SPEED ? 'drive' : along < -BULL_SPEED ? 'bull' : 'fight';
};

/**
 * Shared shift of a pair along its blocker -> defender axis (art px at tier 1) from the pair's velocity along it
 * (`along`, yd/s): all the way toward the defender at DRIVE_SPEED (the blocker winning), toward the blocker at
 * -BULL_SPEED (the rusher winning), and in between blended with a per-pair side from a hash, so a stalemate leans one
 * way or the other and neighbouring pairs rarely line up in one column. Continuous in `along`: no pops.
 */
export const leverageShift = (along: number, key: string): number => {
  const c = along >= 0 ? Math.min(1, along / DRIVE_SPEED) : Math.max(-1, along / BULL_SPEED);
  const side = idHash(`lev|${key}`) % 2 === 0 ? 1 : -1;
  return (c + (1 - Math.abs(c)) * side) * LEVERAGE_SHIFT;
};

/** Engaged groups: each defender with the blockers locked on him (first = the one he is engaged with). */
const engagedGroups = (ctx: LookContext): Map<PlacedAthlete, PlacedAthlete[]> => {
  const out = new Map<PlacedAthlete, PlacedAthlete[]>();
  for (const p of ctx.placed) {
    if (p.a.side !== 'offense' || !ENGAGED_STATES.has(p.a.state)) continue;
    if (p.a.state === 'blocking' && !p.a.engagedWith) continue;
    const d = partnerOf(p, ctx);
    if (!d || d.a.side === p.a.side || !(d.a.state === 'engaged' || d.a.state === 'blocking')) continue;
    const list = out.get(d) ?? [];
    list.push(p);
    out.set(d, list);
  }
  for (const [d, list] of out) {
    const first = d.a.engagedWith ?? null;
    list.sort((x, y) => (x.a.id === first ? -1 : y.a.id === first ? 1 : Math.hypot(x.x - d.x, x.y - d.y) - Math.hypot(y.x - d.x, y.y - d.y)));
    if (list.length > 2) list.length = 2;
  }
  return out;
};

/** Writes the looks of every engaged pair / double team. */
const pairLooks = (ctx: LookContext, track: ContactTrack, out: Map<string, Look>): void => {
  const ts = TIER_SCALE[ctx.tier];
  const now = ctx.mem.tick;
  const secs = ctx.mem.now;
  for (const [d, blockers] of engagedGroups(ctx)) {
    const b = blockers[0] as PlacedAthlete;
    const key = pairKey(b.a.id, d.a.id);
    const age = (now - track.startOf(key, now)) / 60;
    const ex = d.x - b.x; const ey = d.y - b.y;
    const dist = Math.hypot(ex, ey) || 1;
    const ux = ex / dist; const uy = ey / dist;
    const along = pairAlong(track, b, d, now);
    const motion: PairMotion = along > DRIVE_SPEED ? 'drive' : along < -BULL_SPEED ? 'bull' : 'fight';
    const r = ramp(age, 0.15);
    const punching = age < clipSeconds('punch');
    const surge = punching ? PUNCH_SURGE * Math.sin(Math.PI * Math.min(1, age / clipSeconds('punch'))) : 0;
    const gap = ((motion === 'fight' ? ENGAGE_GAP : DRIVE_GAP) - surge) * ts;
    const fix = clamp((dist - gap) / 2, GAP_FIX_MAX * ts);
    // shared sway along the block axis (both bodies rock the same way), plus a stalemate shove jitter
    let sway = Math.sin(secs * 4.2 + (idHash(key) % 10)) * 1.5 * ts;
    if (motion === 'fight') sway += (((idHash(`${key}|${Math.floor(now / 7)}`) % 3) - 1) * 0.8) * ts;
    sway += leverageShift(along, key) * ts;
    const off = (k: number): { dx: number; dy: number } => ({ dx: ux * k * r, dy: uy * k * r });
    const bo = off(fix + sway);
    const dO = off(-fix + sway);
    let bClip: AnimId; let dClip: AnimId;
    if (punching) { bClip = 'punch'; dClip = 'punch'; }
    else if (blockers.length > 1) { bClip = motion === 'bull' ? 'anchor' : motion === 'drive' ? 'driveBlock' : 'handFight'; dClip = 'splitDouble'; }
    else if (motion === 'drive') { bClip = 'driveBlock'; dClip = 'driven'; }
    else if (motion === 'bull') { bClip = 'anchor'; dClip = 'bullRush'; }
    else { bClip = 'handFight'; dClip = 'handFight'; }
    const frameOf = (clip: AnimId): number => (clip === 'punch' ? frameAt('punch', age) : loopFrame(clip, secs, key, ctx.animate));
    out.set(b.a.id, lookOf(bClip, frameOf(bClip), toward(b, d), bo.dx, bo.dy));
    out.set(d.a.id, lookOf(dClip, frameOf(dClip), toward(d, b), dO.dx, dO.dy));
    const b2 = blockers[1];
    if (b2) {
      const k2 = pairKey(b2.a.id, d.a.id);
      const age2 = (now - track.startOf(k2, now)) / 60;
      const e2x = d.x - b2.x; const e2y = d.y - b2.y;
      const d2 = Math.hypot(e2x, e2y) || 1;
      const f2 = clamp((d2 - 17 * ts) / 2, 6 * ts) * ramp(age2, 0.15);
      const clip: AnimId = age2 < clipSeconds('punch') ? 'punch' : 'doubleTeam';
      out.set(b2.a.id, lookOf(clip, clip === 'punch' ? frameAt('punch', age2) : loopFrame(clip, secs, key, ctx.animate), toward(b2, d), (e2x / d2) * f2 + ux * sway * r, (e2y / d2) * f2 + uy * sway * r));
    }
  }
};

/** Shed moves and beaten blockers, from `blockShed` events. */
const shedLooks = (ctx: LookContext, out: Map<string, Look>): void => {
  for (const d of ctx.placed) {
    if (d.a.side !== 'defense' || d.a.state === 'engaged' || d.a.state === 'down' || d.a.state === 'tackling' || d.a.state === 'wrapping') continue;
    const got = recentEvent(ctx.mem, d.a.id, ['blockShed'], 0.6);
    if (!got || got.ev.defender !== d.a.id) continue;
    const clip = SHED_CLIP[shedChoice(d.a.id, d.a.position, got.ev.tick)];
    if (got.age >= clipSeconds(clip)) continue;
    const b = ctx.byId.get(got.ev.blocker);
    const frame = frameAt(clip, got.age);
    const facing = b && frame < 3 ? toward(d, b) : facingFromScreenVector(d.dir.x, d.dir.y);
    out.set(d.a.id, lookOf(clip, frame, facing));
    if (b && b.a.state !== 'engaged' && got.age < clipSeconds('beaten') + 0.1) out.set(b.a.id, lookOf('beaten', frameAt('beaten', got.age), toward(b, d)));
  }
};

/** Pancakes: the blocker drives through and finishes on top, the defender goes onto his back. */
const pancakeLooks = (ctx: LookContext, out: Map<string, Look>): void => {
  const ts = TIER_SCALE[ctx.tier];
  for (const b of ctx.placed) {
    if (b.a.side !== 'offense') continue;
    const got = recentEvent(ctx.mem, b.a.id, ['pancake'], 1.6);
    if (!got || got.ev.blocker !== b.a.id) continue;
    const d = ctx.byId.get(got.ev.defender);
    if (!d) continue;
    const t = got.age;
    if (t < clipSeconds('knockdown')) {
      out.set(d.a.id, lookOf('knockdown', frameAt('knockdown', t), toward(d, b)));
      ctx.mem.of(d.a.id).fell = 'back';
    }
    const speed = Math.hypot(b.a.vx ?? 0, b.a.vy ?? 0);
    if (b.a.state === 'engaged' || (t > 0.45 && speed > 1.2)) continue;
    const frame = frameAt('pancake', t);
    const ex = d.x - b.x; const ey = d.y - b.y; const dist = Math.hypot(ex, ey) || 1;
    const reach = frame >= 2 ? Math.min(7 * ts, dist * 0.35) * ramp(t - 0.15, 0.12) : 0;
    // drawn after the defender (on top of him) when the render-offset clamp leaves room (see liftOver)
    out.set(b.a.id, liftOver(lookOf('pancake', frame, toward(b, d), (ex / dist) * reach, (ey / dist) * reach), b.y, d.y, ts, 8 * ts));
  }
};

/** Pass sets (kick-slide) and fire-outs of unengaged linemen after the snap. */
const setLooks = (ctx: LookContext, out: Map<string, Look>): void => {
  if (ctx.presnap) return;
  const mem = ctx.mem;
  const snap = lastPlayEvent(mem, 'snap');
  if (!snap) return;
  const since = mem.timeSince(snap);
  const carrier = ctx.ball.carrierId ? ctx.byId.get(ctx.ball.carrierId) ?? null : null;
  const handed = lastPlayEvent(mem, 'handoff') ?? lastPlayEvent(mem, 'pitch') ?? lastPlayEvent(mem, 'throw');
  const passPocket = !!carrier && carrier.a.position === 'QB' && !handed && (ctx.ball.phase === 'held' || ctx.ball.phase === 'snap');
  for (const p of ctx.placed) {
    if (out.has(p.a.id) || !OL.has(p.a.position) || !(p.a.state === 'blocking' || p.a.state === 'moving' || p.a.state === 'idle')) continue;
    const speed = Math.hypot(p.a.vx ?? 0, p.a.vy ?? 0);
    const fwd = ((p.a.vx ?? 0) * Math.cos(p.a.bodyFacing ?? p.a.facing) + (p.a.vy ?? 0) * Math.sin(p.a.bodyFacing ?? p.a.facing));
    if (since < 0.3 && fwd > 1) {
      out.set(p.a.id, lookOf('fireOut', frameAt('fireOut', since * (clipSeconds('fireOut') / 0.3)), facingFromScreenVector(p.dir.x, p.dir.y)));
      continue;
    }
    if (passPocket && speed < 3.5 && fwd < 0.4 && since < 6) out.set(p.a.id, lookOf('passSet', loopFrame('passSet', mem.now, p.a.id, ctx.animate), facingFromScreenVector(p.body.x, p.body.y)));
  }
};

/** Line-play looks for the athletes chain B choreographs this frame (see the module doc). */
export const lineLooks = (ctx: LookContext): Map<string, Look> => {
  const track = trackOf(ctx.mem);
  for (const p of ctx.placed) track.record(p.a.id, ctx.mem.tick, p.wx, p.wy);
  const out = new Map<string, Look>();
  if (ctx.presnap) return out;
  pairLooks(ctx, track, out);
  shedLooks(ctx, out);
  pancakeLooks(ctx, out);
  setLooks(ctx, out);
  return out;
};
