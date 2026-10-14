/**
 * Shared fixtures for the franchise shell tests: generated leagues advanced with the fast fallback simulator,
 * an in-memory save system whose autosave timer fires at once, a render context over the recording fake ctx and
 * a tick-until helper for screens driven through a ScreenStack.
 */
import type { TeamId } from '@/core/ids';
import { createLeague } from '@/franchise/league';
import { simulateToPhase } from '@/franchise/season-loop';
import { fallbackSimulator } from '@/franchise/sim-fallback';
import type { League, SeasonPhase } from '@/franchise/types';
import { createMemoryStorage, createSaveSystem, type SaveSystem, type StorageAdapter } from '@/save/index';
import type { InputState } from '@/ui/input/types';
import type { RenderContext, ScreenServices } from '@/ui/screens/screen';
import type { ScreenStack } from '@/ui/screens/stack';
import { createFakeCtx, type FakeCtx } from '../../render/fake-ctx';

const cache = new Map<string, League>();

/** A league created with `abbr` as the user team and advanced to `phase` with the fallback simulator (cached). */
export const leagueAt = (seed: number, phase: SeasonPhase = 'preseason', abbr = 'BOS'): League => {
  const key = `${seed}:${phase}:${abbr}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const base = createLeague({ seed, userTeamAbbr: abbr });
  const league = phase === 'preseason' ? base : simulateToPhase(base, phase, { simulator: fallbackSimulator }).league;
  cache.set(key, league);
  return league;
};

/** The league's user team id. */
export const userOf = (league: League): TeamId => league.userTeamId as TeamId;

/** In-memory save system; autosave timers fire synchronously and the clock advances 1 s per call. */
export const memorySaves = (storage: StorageAdapter = createMemoryStorage()): SaveSystem => {
  let t = 1_700_000_000_000;
  return createSaveSystem(storage, { now: () => (t += 1000), schedule: (cb) => { cb(); return () => undefined; }, compress: false });
};

/** Render context over a fresh recording ctx. */
export const rcFor = (services: ScreenServices): RenderContext & { ctx: FakeCtx } => ({
  ctx: createFakeCtx(), width: services.width, height: services.height, alpha: 1, theme: services.theme, settings: services.settings,
  camera: services.camera, sprites: services.sprites, time: 0,
});

/** Ticks the stack until `done()` holds (throws after `max` ticks). */
export const tickUntil = (stack: ScreenStack, done: () => boolean, max = 4000, input?: () => InputState): number => {
  for (let i = 0; i < max; i++) {
    if (done()) return i;
    stack.update(1 / 60, input ? input() : idle());
  }
  if (done()) return max;
  throw new Error(`tickUntil: condition not met after ${max} ticks (top: ${stack.top?.id ?? 'none'})`);
};

const idle = (): InputState => ({ axis: { x: 0, y: 0 }, down: new Set(), justPressed: new Set(), justReleased: new Set(), pointer: null, lastDevice: 'keyboard' });

/** Lets pending promise callbacks run. */
export const flushPromises = async (rounds = 5): Promise<void> => {
  for (let i = 0; i < rounds; i++) await new Promise<void>((r) => setTimeout(r, 0));
};
