/**
 * Contact effect cues of chain B (art bible §9): B never draws effects itself; each frame its look override lists
 * the effects its choreography calls for, and chain C's effects pass reads them for its view (`contactCuesOf(
 * viewMemory(camera))`) and spawns / draws them (dust, turf chunks, divots, drag marks, the impact flash).
 * A cue carries a stable `key` (spawn it once: the key repeats every frame while the cue lives), its `age` in
 * seconds since the moment it marks (stateless drawing and replay seeks both work), the art-px spot on the world
 * layer (feet or torso), and a seed from the id hash. Render-only; nothing feeds the simulation.
 */
import type { Look } from '../anim';
import type { AnimMemory } from '../anim-memory';
import { idHash, type LookContext, type PlacedAthlete } from '../anim-select';
import { TIER_SCALE } from '../world-layer';
import { recentEvent } from './contact-events';

/** Effect kinds B asks for (C's `effects.emit` vocabulary). */
export type ContactCueKind = 'impactFlash' | 'dust' | 'turfChunk' | 'divot' | 'dragMarks';

/** One effect cue. */
export interface ContactCue {
  kind: ContactCueKind;
  key: string;
  /** Seconds since the cue's moment (0 = this frame). */
  age: number;
  /** Art px on the world layer. */
  x: number;
  y: number;
  /** Screen direction of travel for drag marks / sprays (unit), when it matters. */
  dir?: { x: number; y: number };
  /** Size scale (tier; bigger for big hits). */
  scale: number;
  seed: number;
}

const cues = new WeakMap<AnimMemory, ContactCue[]>();

/** The cues of a view's last frame (empty before the first frame). */
export const contactCuesOf = (mem: AnimMemory): readonly ContactCue[] => cues.get(mem) ?? [];

/** Seconds a cue stays listed after its moment. */
export const CUE_LIFE = 0.45;
/** Drive blocks and drags kick up dust / leave drag marks every this many seconds. */
export const DUST_EVERY = 0.4;

const torso = (p: PlacedAthlete, ts: number): { x: number; y: number } => ({ x: p.x, y: p.y - Math.round(16 * ts) });

/** Builds and stores this frame's cues from the events and the final contact looks. */
export const collectCues = (ctx: LookContext, looks: ReadonlyMap<string, Look>): readonly ContactCue[] => {
  const out: ContactCue[] = [];
  const ts = TIER_SCALE[ctx.tier];
  const mem = ctx.mem;
  const add = (kind: ContactCueKind, key: string, age: number, at: { x: number; y: number }, scale = ts, dir?: { x: number; y: number }): void => {
    if (age < 0 || age > CUE_LIFE) return;
    out.push({ kind, key, age, x: Math.round(at.x), y: Math.round(at.y), scale, seed: idHash(key), ...(dir ? { dir } : {}) });
  };
  for (const p of ctx.placed) {
    const id = p.a.id;
    const tk = recentEvent(mem, id, ['tackle'], CUE_LIFE + 0.8);
    if (tk && tk.ev.carrier === id) {
      const big = tk.ev.kind === 'hitStick';
      if (big) add('impactFlash', `flash:${id}:${tk.ev.tick}`, tk.age, torso(p, ts), ts * 1.3);
      add('turfChunk', `turf:${id}:${tk.ev.tick}`, tk.age, p, big ? ts * 1.5 : ts);
      // the landing, once the fall reaches the ground
      const land = tk.age - (big ? 0.35 : 0.4);
      add('dust', `land:${id}:${tk.ev.tick}`, land, p, ts * (big ? 1.4 : 1));
      add('divot', `divot:${id}:${tk.ev.tick}`, land, p, ts);
    }
    const sack = recentEvent(mem, id, ['sack'], CUE_LIFE);
    if (sack && p.a.id === ctx.ball.carrierId) add('impactFlash', `sackflash:${id}:${sack.ev.tick}`, sack.age, torso(p, ts), ts);
    const pan = recentEvent(mem, id, ['pancake'], CUE_LIFE + 0.5);
    if (pan && pan.ev.defender === id) {
      add('impactFlash', `panflash:${id}:${pan.ev.tick}`, pan.age, torso(p, ts), ts);
      add('dust', `pandust:${id}:${pan.ev.tick}`, pan.age - 0.35, p, ts * 1.3);
    }
    const l = looks.get(id);
    if (!l) continue;
    const bucket = Math.floor(mem.now / DUST_EVERY);
    const bAge = mem.now - bucket * DUST_EVERY;
    if (l.clip === 'punch' && l.frame === 2) add('dust', `punch:${id}`, 0, p, ts * 0.8);
    if (l.clip === 'driveBlock' || l.clip === 'bullRush') add('dust', `drive:${id}:${bucket}`, bAge, p, ts * 0.8);
    if (l.clip === 'driven' || l.clip === 'hangOn') add('dragMarks', `drag:${id}:${bucket}`, bAge, p, ts, { x: p.dir.x, y: p.dir.y });
    if ((l.clip === 'diveTackle' || l.clip === 'tripped' || l.clip === 'knockdown') && l.frame === 3) add('dust', `fall:${id}:${l.clip}`, 0, p, ts);
  }
  cues.set(mem, out);
  return out;
};
