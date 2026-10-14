/**
 * Shared fixtures for the league-info tab tests: generated leagues advanced with the fast fallback simulator
 * (cached per test file) - mid regular season, a finished season (playoffs done, awards phase) and the next
 * preseason (history, awards, All-Pro, records and retirements recorded) - plus input and mounting helpers.
 */
import type { TeamId } from '@/core/ids';
import { createLeague } from '@/franchise/league';
import { advanceLeagueWeek, simulateToPhase } from '@/franchise/season-loop';
import { fallbackSimulator } from '@/franchise/sim-fallback';
import type { League } from '@/franchise/types';
import { createTestFranchiseContext, type TestFranchiseContext, type TestFranchiseContextOptions } from '@/ui/franchise/context';
import type { Action, InputState, PointerState } from '@/ui/input/types';
import type { RenderContext, Screen } from '@/ui/screens/screen';
import { createFakeCtx, makeInput, type FakeCtx } from '../../render/fake-ctx';

const SEED = 7;
let base: League | null = null;
let mid: League | null = null;
let done: League | null = null;
let next: League | null = null;

const baseLeague = (): League => (base ??= createLeague({ seed: SEED, userTeamAbbr: 'BOS' }));

/** Regular season with `weeks` (default 6) weeks played. */
export const midSeasonLeague = (): League => {
  if (mid) return mid;
  let l = simulateToPhase(baseLeague(), 'regularSeason', { simulator: fallbackSimulator, autoFix: true }).league;
  for (let i = 0; i < 6; i++) l = advanceLeagueWeek(l, { simulator: fallbackSimulator }).league;
  mid = l;
  return l;
};

/** The first season finished: regular season and playoffs played, champion crowned (awards phase). */
export const seasonLeague = (): League =>
  (done ??= simulateToPhase(baseLeague(), 'awards', { simulator: fallbackSimulator, autoFix: true }).league);

/** The next preseason: the first season archived (history, awards, All-Pro, records, retirements). */
export const nextYearLeague = (): League =>
  (next ??= simulateToPhase(seasonLeague(), 'preseason', { simulator: fallbackSimulator, autoFix: true }).league);

/** The user team of a league. */
export const userOf = (league: League): TeamId => {
  if (!league.userTeamId) throw new Error('no user team');
  return league.userTeamId;
};

/** A test context plus a hub-hosted tab screen mounted on its stack. */
export const mount = <S extends Screen>(league: League, make: (fc: TestFranchiseContext) => S, opts: TestFranchiseContextOptions = {}): { fc: TestFranchiseContext; screen: S } => {
  const fc = createTestFranchiseContext(league, opts);
  const screen = make(fc);
  fc.stack.push(screen);
  return { fc, screen };
};

/** Presses actions for one tick. */
export const press = (fc: TestFranchiseContext, ...actions: Action[]): void => fc.tick(makeInput({ pressed: actions }));

/** A pointer edge at (x, y). */
export const tap = (x: number, y: number, phase: 'down' | 'up'): PointerState =>
  ({ x, y, down: phase === 'down', justDown: phase === 'down', justUp: phase === 'up', drag: null });

/** A full tap (down then up) at a point, from touch or mouse (mouse also raises Confirm, like the real input map). */
export const tapAt = (fc: TestFranchiseContext, x: number, y: number, device: 'touch' | 'mouse' = 'touch'): void => {
  const extra = device === 'mouse' ? ['confirm' as const] : [];
  fc.tick(makeInput({ pointer: tap(x, y, 'down'), device, pressed: extra }));
  fc.tick(makeInput({ pointer: tap(x, y, 'up'), device }));
};

/** Centre of a rectangle. */
export const centre = (r: { x: number; y: number; w: number; h: number }): { x: number; y: number } => ({ x: r.x + Math.floor(r.w / 2), y: r.y + Math.floor(r.h / 2) });

/** A render context over a recording fake ctx. */
export const rcFor = (fc: TestFranchiseContext): RenderContext & { ctx: FakeCtx } => ({
  ctx: createFakeCtx(), width: 480, height: 270, alpha: 1, theme: fc.services.theme, settings: fc.services.settings, camera: fc.services.camera,
  sprites: fc.services.sprites, time: 0,
});

/** Renders the top screen of the context's stack. */
export const render = (fc: TestFranchiseContext): FakeCtx => {
  const rc = rcFor(fc);
  fc.stack.top?.render(rc);
  return rc.ctx;
};

export { makeInput, type InputState };
