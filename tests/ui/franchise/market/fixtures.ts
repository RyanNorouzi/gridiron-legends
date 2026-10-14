/**
 * Shared fixtures for the market UI tests: real leagues from createLeague moved through the season loop
 * (advanceLeaguePhase / advanceLeagueWeek / simulateToPhase with the fallback simulator for speed), cached per test
 * file, plus render / input helpers over the recording canvas double.
 */
import type { PlayerId } from '@/core/ids';
import { createLeague } from '@/franchise/league';
import { advanceLeaguePhase, advanceLeagueWeek, simulateToPhase } from '@/franchise/season-loop';
import { fallbackSimulator } from '@/franchise/sim-fallback';
import type { League, Prospect } from '@/franchise/types';
import type { Player } from '@/players/types';
import { createTestFranchiseContext, type TestFranchiseContext } from '@/ui/franchise/context';
import { PUBLIC_PLAYER_FIELDS } from '@/ui/franchise/market/scouting-model';
import type { Action, InputState, PointerState } from '@/ui/input/types';
import type { RenderContext, Screen } from '@/ui/screens/screen';
import { createFakeCtx, makeInput, type FakeCtx } from '../../render/fake-ctx';

const SEED = 5;
let regular: League | null = null;
let freeAgency: League | null = null;
let draft: League | null = null;

/** Regular season week 2: the draft class is open and one week of scouting points has been granted. */
export const regularSeasonLeague = (): League => {
  if (!regular) {
    let l = createLeague({ seed: SEED, userTeamAbbr: 'BOS' });
    l = advanceLeaguePhase(l).league;
    regular = advanceLeagueWeek(l, { simulator: fallbackSimulator }).league;
  }
  return regular;
};

/** The start of the free-agency phase (market not opened yet). */
export const freeAgencyLeague = (): League => {
  freeAgency ??= simulateToPhase(regularSeasonLeague(), 'freeAgency', { simulator: fallbackSimulator }).league;
  return freeAgency;
};

/** The start of the draft phase (draft not started yet). */
export const draftLeague = (): League => {
  draft ??= simulateToPhase(freeAgencyLeague(), 'draft', { simulator: fallbackSimulator }).league;
  return draft;
};

/** A test context over `league` (normal or large text). */
export const contextFor = (league: League, large = false): TestFranchiseContext =>
  createTestFranchiseContext(league, large ? { settings: { textSize: 'large' } } : {});

/** RenderContext over a recording fake canvas. */
export const rcFor = (fc: TestFranchiseContext): RenderContext & { ctx: FakeCtx } => ({
  ctx: createFakeCtx(), width: 480, height: 270, alpha: 1, theme: fc.services.theme, settings: fc.services.settings, camera: fc.services.camera, sprites: fc.services.sprites, time: 0,
});

/** Enters and renders a hosted screen once (so pointer geometry exists). */
export const mount = <S extends Screen>(fc: TestFranchiseContext, screen: S): S => {
  screen.enter(fc.services);
  screen.render(rcFor(fc));
  return screen;
};

/** One tick with these actions pressed. */
export const press = (...actions: Action[]): InputState => makeInput({ pressed: actions });

/** Pointer edge at (x, y). */
const pointer = (x: number, y: number, edge: 'down' | 'up'): PointerState => ({ x, y, down: edge === 'down', justDown: edge === 'down', justUp: edge === 'up', drag: null });

/** A touch tap (press then release) delivered to `update`. */
export const tap = (update: (input: InputState) => void, x: number, y: number, device: InputState['lastDevice'] = 'touch'): void => {
  update(makeInput({ pointer: pointer(x, y, 'down'), device, ...(device === 'mouse' ? { pressed: ['confirm'] } : {}) }));
  update(makeInput({ pointer: pointer(x, y, 'up'), device }));
};

/** Centre of a rect. */
export const centre = (r: { x: number; y: number; w: number; h: number }): [number, number] => [r.x + r.w / 2, r.y + r.h / 2];

/**
 * The league with every prospect's Player wrapped in a Proxy that THROWS when anything but the public facts
 * (PUBLIC_PLAYER_FIELDS) is read, so view-model builders prove they never touch the ground truth.
 */
export const guardedLeague = (league: League): League => {
  if (!league.draft) throw new Error('guardedLeague: no draft');
  const allowed = new Set<string | symbol>(PUBLIC_PLAYER_FIELDS);
  const guard = (p: Player): Player => new Proxy(p, {
    get: (target, key, receiver) => {
      if (typeof key === 'string' && !allowed.has(key)) throw new Error(`ground truth read: Prospect.player.${key}`);
      return Reflect.get(target, key, receiver) as unknown;
    },
  });
  const prospects: Prospect[] = league.draft.prospects.map((p) => ({ ...p, player: guard(p.player) }));
  return { ...league, draft: { ...league.draft, prospects } };
};

/** The league with every prospect's ground truth scrambled (ratings, potential, dev trait, traits). */
export const scrambledTruth = (league: League): League => {
  if (!league.draft) throw new Error('scrambledTruth: no draft');
  const prospects = league.draft.prospects.map((p, i) => ({
    ...p,
    player: { ...p.player, overall: 1 + (i % 7), potential: 99, devTrait: 'bust' as const, traits: [], attrs: { ...p.player.attrs, speed: 1, strength: 1 } },
  }));
  return { ...league, draft: { ...league.draft, prospects } };
};

/** Id of a free agent in the pool matching `pred` (throws when none). */
export const freeAgentWhere = (league: League, pred: (p: Player) => boolean): PlayerId => {
  const id = league.freeAgentIds.find((pid) => { const p = league.players[pid]; return !!p && pred(p); });
  if (!id) throw new Error('no matching free agent');
  return id;
};
