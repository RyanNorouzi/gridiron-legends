/**
 * Tackle choreography (art bible §6.3), chain B: pairs tackler and ball carrier on the engine's contact events.
 *  - `wrapUp` / `pileJoin` (the struggle): the carrier churns for yards (struggle, faster while he drags the pile)
 *    while each tackler hangs on at his hip (hangOn), pulled in to the hip within MAX_RENDER_OFFSET;
 *  - `tackle` by kind: wrap / gang / strip -> wrap with the carrier falling backward when met head on and forward
 *    when hit from behind; openField -> both rolling down; arm -> one-arm grab and the carrier spun down; dive ->
 *    layout at the ankles and the carrier tripped; hitStick -> big hit with a 3-frame hitstop and the carrier blown
 *    up backward; gang assists dive onto the pile in arrival order (pileOn) and a carrier under two or more is buried;
 *  - `brokenTackle` (shrugged, knocked down by a truck), `missedTackle` (whiff, sometimes on the ground), `fumble`
 *    (the strip chop and the carrier reaching after the ball), `recovery` (scoop or fall on it).
 * Clip frames run on the event clock (time since the event, in scene ticks), so replays and seeks match live play.
 * The post-whistle get-up is added by the installer (contact-install.ts) over every lying body.
 */
import type { PlayEvent } from '@/game/play-events';
import type { AnimId } from '../anim-ids';
import { clipSeconds, clipTiming, frameAt, type Look } from '../anim';
import { idHash, type LookContext, type PlacedAthlete } from '../anim-select';
import { facingFromScreenVector } from '../sprites';
import { TIER_SCALE } from '../world-layer';
import { liftOver, ramp, recentEvent, TACKLE_CHOREO, withHitstop, type EventOf } from './contact-events';

const PLAY_WINDOW = 60;
const DOWNED: ReadonlySet<string> = new Set(['falling', 'down', 'tackled']);

const toward = (p: PlacedAthlete, q: PlacedAthlete): Look['facing'] => facingFromScreenVector(q.x - p.x, q.y - p.y);
const own = (p: PlacedAthlete): Look['facing'] => facingFromScreenVector(p.dir.x, p.dir.y);
const lying = (clip: AnimId, frame: number): boolean => clipTiming(clip).lying === true && frame >= clipTiming(clip).frames - 1;
const look = (clip: AnimId, frame: number, facing: Look['facing'], dx = 0, dy = 0): Look => ({ clip, frame, facing, dx, dy, lying: lying(clip, frame) });
const clamp = (v: number, m: number): number => Math.max(-m, Math.min(m, v));

/** Offset pulling `p` toward `q` until their feet are `gap` art px apart (at most `max`), eased in over `t`. */
const pull = (p: PlacedAthlete, q: PlacedAthlete, gap: number, max: number, t: number): { dx: number; dy: number } => {
  const ex = q.x - p.x; const ey = q.y - p.y; const d = Math.hypot(ex, ey) || 1;
  const k = clamp(d - gap, max) * ramp(t, 0.1);
  return { dx: (ex / d) * k, dy: (ey / d) * k };
};

/** Draws `p` after `q` (on top of him) when the render-offset clamp leaves room (see liftOver). */
const onTop = (l: Look, p: PlacedAthlete, q: PlacedAthlete, ts: number): Look => liftOver(l, p.y, q.y, ts);

/** The struggle: carrier churning, tacklers hanging on at the hip. */
const struggleLooks = (ctx: LookContext, c: PlacedAthlete, out: Map<string, Look>): void => {
  const ts = TIER_SCALE[ctx.tier];
  const mem = ctx.mem;
  const wrap = recentEvent(mem, c.a.id, ['wrapUp'], PLAY_WINDOW);
  if (!wrap || wrap.ev.carrier !== c.a.id) return;
  const drag = Math.hypot(c.a.vx ?? 0, c.a.vy ?? 0) > 0.4 ? 1.3 : 1;
  out.set(c.a.id, look('struggle', ctx.animate ? frameAt('struggle', mem.now * drag, idHash(c.a.id) % 4) : 0, own(c)));
  const joins = mem.eventsOf(c.a.id).filter((e): e is EventOf<'pileJoin'> => e.type === 'pileJoin' && e.carrier === c.a.id && e.tick >= wrap.ev.tick && e.tick <= mem.tick);
  const hangers: { id: string; tick: number }[] = [{ id: wrap.ev.tackler, tick: wrap.ev.tick }, ...joins.map((e) => ({ id: e.defender, tick: e.tick }))];
  hangers.forEach((h, i) => {
    const t = ctx.byId.get(h.id);
    if (!t || t.a.state !== 'wrapping') return;
    const age = (mem.tick - h.tick) / 60;
    const o = pull(t, c, 10 * ts, 6 * ts, age);
    const l = age < clipSeconds('wrap') * 2 / 6
      ? look('wrap', frameAt('wrap', age), toward(t, c), o.dx, o.dy)
      : look('hangOn', ctx.animate ? frameAt('hangOn', mem.now * drag, idHash(h.id) % 4) : 0, toward(t, c), o.dx, o.dy);
    l.layer = i + 1;
    out.set(h.id, l);
  });
};

/** Which way the carrier falls, decided once per tackle (kept in the memory so it never flips mid-fall). */
const fallSide = (ctx: LookContext, c: PlacedAthlete, t: PlacedAthlete | undefined): 'fwd' | 'back' => {
  const m = ctx.mem.of(c.a.id);
  const key = `tk:${c.a.id}`;
  const store = fellMemo.get(ctx.mem) ?? new Map<string, 'fwd' | 'back'>();
  fellMemo.set(ctx.mem, store);
  let side = store.get(key);
  if (!side) {
    side = t ? ((t.x - c.x) * c.dir.x + (t.y - c.y) * c.dir.y < 0 ? 'fwd' : 'back') : (m.fell ?? 'fwd');
    store.set(key, side);
  }
  m.fell = side;
  return side;
};
const fellMemo = new WeakMap<object, Map<string, 'fwd' | 'back'>>();

/** A carrier already going to the ground when the tackle landed (his dive / slide / fall), kept per tackle. */
interface GoingDown { clip: AnimId; frame: number; at: number; facing: Look['facing'] }
const downMemo = new WeakMap<object, Map<string, GoingDown | null>>();

/**
 * The carrier's own going-down clip when the tackle caught him mid-dive, mid-slide or already lying (his look on
 * the frame before the tackle was a clip that ends on the ground): that clip plays on to its lying end, so a diving
 * runner never pops back up to start the tackle fall from standing. Decided on the first frame that sees the tackle
 * and kept (a seek past it rebuilds the memory and plays the regular tackle choreography).
 */
const alreadyDown = (ctx: LookContext, c: PlacedAthlete, tick: number, age: number): GoingDown | null => {
  const store = downMemo.get(ctx.mem) ?? new Map<string, GoingDown | null>();
  downMemo.set(ctx.mem, store);
  const key = `${c.a.id}|${tick}`;
  let got = store.get(key);
  if (got === undefined) {
    const last = ctx.mem.of(c.a.id).last;
    const tackleClip = last !== null && Object.values(TACKLE_CHOREO).some((ch) => ch.carrierHeadOn === last.clip || ch.carrierBehind === last.clip);
    got = last && !tackleClip && last.clip !== 'buried' && clipTiming(last.clip).lying === true ? { clip: last.clip, frame: last.frame, at: age, facing: last.facing } : null;
    store.set(key, got);
  }
  return got;
};

/** The play-ending tackle (and sacks). */
const tackleLooksFor = (ctx: LookContext, c: PlacedAthlete, out: Map<string, Look>): void => {
  const ts = TIER_SCALE[ctx.tier];
  const mem = ctx.mem;
  const got = recentEvent(mem, c.a.id, ['tackle'], PLAY_WINDOW);
  if (!got || got.ev.carrier !== c.a.id) return;
  const ev = got.ev;
  const tk = ctx.byId.get(ev.tackler);
  const ch = TACKLE_CHOREO[ev.kind];
  const hit = ev.kind === 'hitStick';
  const tc = hit ? withHitstop(got.age, 0.001) : got.age;
  const side = fallSide(ctx, c, tk);
  const cClip: AnimId = side === 'fwd' ? ch.carrierBehind : ch.carrierHeadOn;
  const buried = ev.assists.length >= 2 && tc > clipSeconds(cClip);
  const down = alreadyDown(ctx, c, ev.tick, got.age);
  let cl = buried ? look('buried', 0, own(c))
    : down ? look(down.clip, Math.min(clipTiming(down.clip).frames - 1, down.frame + Math.floor((got.age - down.at) * clipTiming(down.clip).fps)), down.facing)
      : look(cClip, frameAt(cClip, tc), own(c));
  if (hit && tk) {
    // blown back up to ~0.3 yd while airborne
    const away = pull(c, tk, 1e9, 6 * ts, tc);
    const k = Math.min(1, tc / 0.35);
    cl = { ...cl, dx: away.dx * k, dy: away.dy * k };
  }
  out.set(c.a.id, cl);
  if (tk) {
    const struggled = recentEvent(mem, tk.a.id, ['wrapUp', 'pileJoin'], PLAY_WINDOW) !== null;
    const start = (struggled && ch.tackler === 'wrap' ? 2 : ch.impactFrame) / clipTiming(ch.tackler).fps;
    const frame = frameAt(ch.tackler, tc + start);
    const gap = (hit ? 12 : ch.tackler === 'diveTackle' ? 14 : 10) * ts;
    const o = pull(tk, c, gap, 8 * ts, got.age);
    let tl = look(ch.tackler, frame, toward(tk, c), o.dx, o.dy);
    if (frame >= 3) tl = onTop(tl, tk, c, ts);
    out.set(tk.a.id, tl);
  }
  ev.assists.forEach((id, i) => {
    const a = ctx.byId.get(id);
    if (!a || !DOWNED.has(a.a.state)) return;
    const join = recentEvent(mem, id, ['pileJoin'], PLAY_WINDOW);
    const t0 = join && join.ev.carrier === c.a.id ? join.age : got.age;
    const o = pull(a, c, 8 * ts, 8 * ts, t0);
    const l = onTop(look('pileOn', frameAt('pileOn', Math.min(t0, got.age + 0.1)), toward(a, c), o.dx, o.dy), a, c, ts);
    l.layer = i + 2;
    out.set(id, l);
  });
};

/** Broken and missed tackles, strips and recoveries (one-shots of the defender / carrier involved). */
const oneShots = (ctx: LookContext, p: PlacedAthlete, out: Map<string, Look>): void => {
  const mem = ctx.mem;
  const id = p.a.id;
  const got = recentEvent(mem, id, ['brokenTackle', 'missedTackle', 'fumble', 'recovery'], 2);
  if (!got) return;
  const e = got.ev as PlayEvent;
  const t = got.age;
  const q = (x: string | null): PlacedAthlete | undefined => (x ? ctx.byId.get(x) : undefined);
  const face = (other: PlacedAthlete | undefined): Look['facing'] => (other ? toward(p, other) : own(p));
  switch (e.type) {
    case 'brokenTackle':
      if (e.defender !== id) return;
      if (t < clipSeconds('shrugged')) out.set(id, look('shrugged', frameAt('shrugged', t), face(q(e.carrier))));
      else if (e.move === 'truck' && p.a.state === 'stumbling') out.set(id, look('fallBack', frameAt('fallBack', t - clipSeconds('shrugged')), face(q(e.carrier))));
      return;
    case 'missedTackle':
      if (e.defender !== id) return;
      if (t < clipSeconds('whiff')) out.set(id, look('whiff', frameAt('whiff', t), own(p)));
      else if (idHash(`${id}|${e.tick}`) % 2 === 1 && p.a.state === 'stumbling') out.set(id, look('fallFwd', frameAt('fallFwd', t - clipSeconds('whiff')), own(p)));
      return;
    case 'fumble':
      if (e.forcedBy === id && t < clipSeconds('stripChop')) out.set(id, look('stripChop', frameAt('stripChop', t), face(q(e.carrier))));
      else if (e.carrier === id && t < clipSeconds('fumbleReach') + 0.1 && !DOWNED.has(p.a.state)) out.set(id, look('fumbleReach', frameAt('fumbleReach', t), own(p)));
      return;
    case 'recovery':
      if (e.by !== id) return;
      if (e.advanced && t < clipSeconds('scoopUp')) out.set(id, look('scoopUp', frameAt('scoopUp', t), own(p)));
      else if (!e.advanced && (DOWNED.has(p.a.state) || t < clipSeconds('fallOnBall'))) out.set(id, look('fallOnBall', frameAt('fallOnBall', t), own(p)));
      return;
    default:
  }
};

/** Tackle / contact looks for the athletes chain B choreographs this frame (see the module doc). */
export const tackleLooks = (ctx: LookContext): Map<string, Look> => {
  const out = new Map<string, Look>();
  if (ctx.presnap) return out;
  for (const p of ctx.placed) oneShots(ctx, p, out);
  for (const c of ctx.placed) {
    if (c.a.state === 'wrapped') struggleLooks(ctx, c, out);
    else if (DOWNED.has(c.a.state) || c.a.state === 'sliding') tackleLooksFor(ctx, c, out);
  }
  return out;
};
