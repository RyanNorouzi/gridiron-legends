/**
 * Shared helpers for the team-tab tests: a cached generated league, a render context over the recording fake
 * ctx, mounting a hub-hosted tab on the test stack, and typed access to the top screen.
 */
import type { PlayerId, TeamId } from '@/core/ids';
import { createLeague } from '@/franchise/league';
import type { League, SeasonPhase } from '@/franchise/types';
import type { Player, Position } from '@/players/types';
import { createTestFranchiseContext, type TestFranchiseContext, type TestFranchiseContextOptions } from '@/ui/franchise/context';
import type { RenderContext, Screen } from '@/ui/screens/screen';
import { createFakeCtx, makeInput, type FakeCtx } from '../../render/fake-ctx';
import type { Action } from '@/ui/input/types';

let cached: League | null = null;

/** A generated league (seed 11, user team BOS), created once per test file. */
export const baseLeague = (): League => {
  cached ??= createLeague({ seed: 11, userTeamAbbr: 'BOS' });
  return cached;
};

/** The user team id of a league. */
export const userId = (league: League): TeamId => {
  if (!league.userTeamId) throw new Error('no user team');
  return league.userTeamId;
};

/** A user-roster player at `position` (the first one listed), or any rostered player. */
export const userPlayer = (league: League, position?: Position, pick: (p: Player) => boolean = () => true): Player => {
  const team = league.teams[userId(league)];
  const found = team?.rosterIds.map((id) => league.players[id]).find((p): p is Player => !!p && (!position || p.position === position) && pick(p));
  if (!found) throw new Error(`no user player ${position ?? ''}`);
  return found;
};

/** The league moved to another phase (same year). */
export const inPhase = (league: League, phase: SeasonPhase): League => ({ ...league, season: { ...league.season, phase, week: 0 } });

/** Replaces one player. */
export const withPlayer = (league: League, p: Player): League => ({ ...league, players: { ...league.players, [p.id]: p } });

/** A render context over a recording fake ctx. */
export const rcFor = (fc: TestFranchiseContext): RenderContext & { ctx: FakeCtx } => ({
  ctx: createFakeCtx(), width: 480, height: 270, alpha: 1, theme: fc.services.theme, settings: fc.services.settings, camera: fc.services.camera, sprites: fc.services.sprites, time: 0,
});

/** A test context plus a tab screen mounted on its stack (as the hub would host it). */
export const mount = <S extends Screen>(league: League, make: (fc: TestFranchiseContext) => S, opts: TestFranchiseContextOptions = {}): { fc: TestFranchiseContext; screen: S } => {
  const fc = createTestFranchiseContext(league, opts);
  const screen = make(fc);
  fc.stack.push(screen);
  return { fc, screen };
};

/** Presses actions for one tick. */
export const press = (fc: TestFranchiseContext, ...actions: Action[]): void => fc.tick(makeInput({ pressed: actions }));

/** The top screen cast to T (throws when it is not an instance of `ctor`). */
export const topAs = <T>(fc: TestFranchiseContext, ctor: abstract new (...args: never[]) => T): T => {
  const top = fc.stack.top;
  if (!(top instanceof ctor)) throw new Error(`top screen is ${top?.id ?? 'none'}`);
  return top;
};

/** The id of a player cast for tests. */
export const pid = (s: string): PlayerId => s as PlayerId;

export { makeInput };
