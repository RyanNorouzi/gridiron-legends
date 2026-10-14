/** Shared fixtures of chain B's contact tests: athletes placed on a horizontal field and a look context. */
import type { PlayEvent } from '@/game/play-events';
import type { Look } from '@/ui/render/anim';
import { AnimMemory } from '@/ui/render/anim-memory';
import { chooseLooks, type LookAthlete, type LookContext, type PlacedAthlete } from '@/ui/render/anim-select';
import '@/ui/render/figures/contact-install';

/** A test athlete (offense lineman by default); the drawn heading follows the velocity unless given. */
export const athlete = (over: Partial<LookAthlete> = {}): LookAthlete => ({
  id: 'off:LG', side: 'offense', position: 'OG', role: 'LG', state: 'engaged', stateTimer: 0, hasBall: false, vx: 0, vy: 0, topSpeed: 7,
  facing: over.vx || over.vy ? Math.atan2(over.vy ?? 0, over.vx ?? 0) : Math.PI / 2, ...over,
});

/** Placed on a horizontal field at CLOSE zoom: world +y is screen right, 22 art px per yard. */
export const place = (a: LookAthlete, wx: number, wy: number): PlacedAthlete => {
  const h = a.facing;
  const b = a.bodyFacing ?? a.facing;
  return { a, x: Math.round(wy * 22), y: Math.round(wx * 22), wx, wy, dir: { x: Math.sin(h), y: Math.cos(h) }, body: { x: Math.sin(b), y: Math.cos(b) } };
};

/** A look context over placed athletes. */
export const context = (placed: PlacedAthlete[], mem: AnimMemory, over: Partial<LookContext> = {}): LookContext => ({
  mem, presnap: false, tier: 1, animate: true, ball: { x: 26, y: 40, phase: 'held', carrierId: null }, losY: 40, snapX: 26, placed,
  byId: new Map(placed.map((p) => [p.a.id, p])), ...over,
});

/** One frame: syncs the memory to `tick` and chooses every look. */
export const frameAt = (mem: AnimMemory, tick: number, placed: PlacedAthlete[], events: PlayEvent[] = [], over: Partial<LookContext> = {}): Map<string, Look> => {
  mem.sync({ playKey: 'contact', tick, events, frames: null });
  return chooseLooks(context(placed, mem, over));
};

/** A fresh memory. */
export const memory = (): AnimMemory => new AnimMemory();
