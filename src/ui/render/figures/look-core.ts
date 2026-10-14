/**
 * Chain A's core look override (art bible §6.1): the non-contact cues the base selection (anim-select.ts) does not
 * pick, all derived deterministically from the scene, its events and ticks (so replays and seeks match):
 *  - diving catches (`catch` kind 'diving') play catchDive; drops play `drop` for the target; passes defended,
 *    batted or tipped play `swat` for the defender;
 *  - `reachOut` for the targeted receiver while the pass is in the air and within 4 yd;
 *  - returners (KR* / PR* roles) wait in `returnerReady`, as does the punter before the long snap;
 *  - kick formations (a kicker or punter lined up deep): the holder kneels (`holdPlace`: ready, catch, place, held
 *    until after the kick), the snapper bends over the ball and plays `longSnap` instead of `snap`;
 *  - the carrier's `fistPump` after a first down, the scoring side's `highFive` pairs and the other side's
 *    `dejected` after a touchdown;
 *  - a ball carrier standing still after the snap: `setFeet` (ball at the ear) for a quarterback in the pocket,
 *    `carryHigh` for anyone else, instead of an idle with the ball hanging at the hip (review fix).
 * It never touches an athlete whose current look is contact or ground (priority >= 3: chain B's pair solver and
 * tackle choreography, falls, piles), so its registration order against chain B's override does not matter.
 */
import type { PlayEvent } from '@/game/play-events';
import { clipSeconds, clipTiming, frameAt, type AnimId, type Look } from '../anim';
import { idHash, registerLookOverride, type LookContext, type PlacedAthlete } from '../anim-select';
import { facingFromScreenVector } from '../sprites';

const speedOf = (p: PlacedAthlete): number => Math.hypot(p.a.vx ?? 0, p.a.vy ?? 0);
const look = (clip: AnimId, frame: number, facing: Look['facing']): Look => ({ clip, frame, facing, dx: 0, dy: 0 });
/** A look may be replaced by a core cue: not contact, not on the ground, not already a higher action. */
const free = (l: Look | undefined, maxPriority = 2): boolean => !l || (clipTiming(l.clip).priority <= maxPriority && !l.lying);

/** The most recent event of a type (any athlete). */
const lastOf = <T extends PlayEvent['type']>(ctx: LookContext, type: T): Extract<PlayEvent, { type: T }> | null => {
  const ev = ctx.mem.events;
  for (let i = ev.length - 1; i >= 0; i--) {
    const e = ev[i] as PlayEvent;
    if (e.type === type && ctx.mem.timeSince(e) >= -1e-6) return e as Extract<PlayEvent, { type: T }>;
  }
  return null;
};

/** Seconds since an event (negative before it). */
const since = (ctx: LookContext, e: { tick: number }): number => ctx.mem.timeSince(e);

/** One-shot frame `t` seconds into a clip, or null when finished (holds keep their last frame for `hold` s). */
const oneShot = (clip: AnimId, t: number, hold = 0): number | null => {
  if (t < 0) return null;
  const end = clipSeconds(clip);
  if (t >= end + hold) return null;
  return frameAt(clip, Math.min(t, end - 1e-3));
};

interface KickSetup { snapper: PlacedAthlete | null; holder: PlacedAthlete | null; punter: PlacedAthlete | null }

/** Detects a kick formation from the alignment (a kicker / punter lined up 5+ yd behind the ball). */
const kickSetup = (ctx: LookContext): KickSetup | null => {
  if (ctx.losY === null) return null;
  const off = ctx.placed.filter((p) => p.a.side === 'offense');
  const deep = off.find((p) => (p.a.position === 'K' || p.a.position === 'P') && Math.abs(p.wy - ctx.losY!) >= 5);
  if (!deep) return null;
  const back = Math.sign(deep.wy - ctx.losY) || 1;
  const snapper = off.filter((p) => p !== deep && Math.abs(p.wy - ctx.losY!) < 1.6).sort((p, q) => Math.abs(p.wx - ctx.snapX) - Math.abs(q.wx - ctx.snapX))[0] ?? null;
  if (deep.a.position === 'P') return { snapper, holder: null, punter: deep };
  const holder = off.filter((p) => p !== deep && p !== snapper && (p.wy - ctx.losY!) * back >= 4 && Math.hypot(p.wx - deep.wx, p.wy - deep.wy) <= 4.5)
    .sort((p, q) => Math.hypot(p.wx - deep.wx, p.wy - deep.wy) - Math.hypot(q.wx - deep.wx, q.wy - deep.wy))[0] ?? null;
  return { snapper, holder, punter: null };
};

/** The core override: cues for athletes whose current look is free (see the module doc). */
export const coreCues = (ctx: LookContext, cur: ReadonlyMap<string, Look>): Map<string, Look> => {
  const out = new Map<string, Look>();
  const set = (p: PlacedAthlete, l: Look): void => { out.set(p.a.id, l); };
  const mem = ctx.mem;
  const snap = lastOf(ctx, 'snap');
  const kick = lastOf(ctx, 'kick');
  const throwEv = lastOf(ctx, 'throw');
  const td = lastOf(ctx, 'touchdown');
  const first = lastOf(ctx, 'firstDown');
  // kick formations
  const ks = kickSetup(ctx);
  if (ks && (!kick || since(ctx, kick) < 1.2)) {
    if (ks.holder && free(cur.get(ks.holder.a.id)) && speedOf(ks.holder) < 1.5) {
      const h = ks.holder;
      const frame = !snap ? 0 : !kick ? (h.a.hasBall || ctx.ball.phase === 'held' ? 2 : 1) : 2;
      set(h, look('holdPlace', frame, cur.get(h.a.id)?.facing ?? facingFromScreenVector(h.body.x, h.body.y)));
    }
    if (ks.snapper && free(cur.get(ks.snapper.a.id))) {
      const s = ks.snapper;
      const f = snap ? oneShot('longSnap', since(ctx, snap)) : 0;
      if (f !== null && (!snap || since(ctx, snap) >= 0)) set(s, look('longSnap', f, cur.get(s.a.id)?.facing ?? facingFromScreenVector(s.body.x, s.body.y)));
    }
    if (ks.punter && !kick && !ks.punter.a.hasBall && free(cur.get(ks.punter.a.id), 1) && speedOf(ks.punter) < 1) {
      set(ks.punter, look('returnerReady', 0, cur.get(ks.punter.a.id)?.facing ?? 'e'));
    }
  }
  for (const p of ctx.placed) {
    const id = p.a.id;
    if (out.has(id)) continue;
    const c = cur.get(id);
    const facing = c?.facing ?? facingFromScreenVector(p.dir.x, p.dir.y);
    // catch kinds and incompletions
    const catchEv = mem.lastEvent(id, 'catch');
    if (catchEv && catchEv.catchKind === 'diving' && c && (c.clip === 'catchChest' || c.clip === 'catchHigh')) {
      const f = oneShot('catchDive', since(ctx, catchEv), 2);
      if (f !== null) { set(p, { ...look('catchDive', f, c.facing), lying: f >= clipTiming('catchDive').frames - 1 }); continue; }
    }
    const inc = mem.lastEvent(id, 'incomplete');
    if (inc && free(c)) {
      const clip: AnimId | null = inc.reason === 'drop' && inc.target === id ? 'drop' : (inc.reason === 'defended' || inc.reason === 'batted') && inc.defender === id ? 'swat' : null;
      const f = clip ? oneShot(clip, since(ctx, inc)) : null;
      if (clip && f !== null) { set(p, look(clip, f, facing)); continue; }
    }
    const tip = mem.lastEvent(id, 'tipped');
    if (tip && free(c)) {
      const f = oneShot('swat', since(ctx, tip));
      if (f !== null) { set(p, look('swat', f, facing)); continue; }
    }
    // hands up for an arriving pass
    if (throwEv && throwEv.target === id && ctx.ball.phase === 'inAir' && !p.a.hasBall && free(c, 1)) {
      const d = Math.hypot(ctx.ball.x - p.wx, ctx.ball.y - p.wy);
      if (d < 4) { set(p, look('reachOut', d < 2 ? 1 : 0, facing)); continue; }
    }
    // returners waiting
    if (/^(KR|PR)/.test(p.a.role) && !p.a.hasBall && speedOf(p) < 1.2 && free(c, 1) && (ctx.presnap || (kick && ctx.ball.phase === 'inAir'))) {
      set(p, look('returnerReady', 0, facing));
      continue;
    }
    // first-down fist pump by the carrier
    if (first && id === ctx.ball.carrierId && free(c, 1)) {
      const f = oneShot('fistPump', since(ctx, first), 0.4);
      if (f !== null) { set(p, look('fistPump', f, facing)); continue; }
    }
    // after a touchdown: high fives on the scoring side, dejection on the other
    if (td && ctx.ball.phase === 'dead' && since(ctx, td) > 0.6 && free(c, 2) && speedOf(p) < 1.5) {
      if (p.a.side !== td.side) {
        if (free(c, 1)) set(p, look('dejected', Math.floor(mem.now * 2 + (idHash(id) % 2)) % 2, facing));
        continue;
      }
      if (id === td.scorer) continue;
      const mate = ctx.placed.find((q) => q !== p && q.a.side === p.a.side && q.a.id !== td.scorer && Math.hypot(q.wx - p.wx, q.wy - p.wy) < 1.3 && speedOf(q) < 1.5);
      if (mate) {
        const key = idHash([id, mate.a.id].sort().join('|'));
        const t = (since(ctx, td) - 0.8 - (key % 8) * 0.1) % 2.4;
        const f = oneShot('highFive', t, 0.3);
        if (f !== null) set(p, look('highFive', f, facingFromScreenVector(mate.x - p.x, mate.y - p.y)));
      }
    }
    // a ball carrier standing still after the snap never lets the ball hang at his hip: a quarterback sets his feet
    // with the ball at the ear (the engine drops him to 'idle' once he reaches his set point), anyone else holds it
    // high at the chest
    if (!out.has(id) && p.a.hasBall && snap && !ctx.presnap && c?.clip === 'idle') {
      if (p.a.position === 'QB') set(p, look('setFeet', ctx.animate ? frameAt('setFeet', mem.now, idHash(id) % clipTiming('setFeet').frames) : 0, facing));
      else set(p, look('carryHigh', 0, facing));
    }
  }
  return out;
};

let installed: (() => void) | null = null;

/** Registers the core override (once). */
export const installCoreCues = (): void => {
  if (!installed) installed = registerLookOverride(coreCues);
};

/** Removes it (tests). */
export const uninstallCoreCues = (): void => {
  installed?.();
  installed = null;
};
