import { describe, expect, it } from 'vitest';
import { buildGameSetup } from '@/franchise/game-setup';
import { fallbackSimulator } from '@/franchise/sim-fallback';
import type { ScheduledGame } from '@/franchise/types';
import { userGameThisWeek } from '@/franchise/week';
import { GameController } from '@/game/game-controller';
import { outcomeAt } from '@/game/outcome-factory';
import type { GameState } from '@/game/types';
import { playbookRegistries } from '@/simulation/game-sim';
import { createHeadlessServices } from '@/ui/franchise/context';
import { GameDayScreen } from '@/ui/franchise/game-day';
import { FranchiseHubScreen } from '@/ui/franchise/hub';
import { ChoiceDialog } from '@/ui/franchise/kit/dialogs';
import { PlayoffsModeScreen } from '@/ui/franchise/playoffs-mode';
import { startSeasonMode } from '@/ui/franchise/season-mode';
import { liveGameSummary, resumableGameFor } from '@/ui/franchise/shell/live-game-save';
import { SimProgressScreen } from '@/ui/franchise/shell/progress-screen';
import { WeekRecapScreen } from '@/ui/franchise/shell/recap-screen';
import { slotRows } from '@/ui/franchise/shell/save-model';
import { flushPromises, leagueAt, memorySaves, tickUntil, userOf } from './helpers';

/** A mid-game state of the user's first game: a dozen plays with a trivial scripted outcome (fast, deterministic). */
const midGame = (seed: number): { state: GameState; game: ScheduledGame } => {
  const league = leagueAt(seed, 'regularSeason');
  const game = userGameThisWeek(league) as ScheduledGame;
  const setup = buildGameSetup(league, game, { userSide: null, controllers: { home: 'ai', away: 'ai' } });
  const c = new GameController(setup, { registries: playbookRegistries() });
  c.start();
  for (let i = 0; i < 12 && c.state.phase !== 'final'; i++) {
    const ctx = c.beginPlay();
    c.completePlay(outcomeAt(ctx.ballOn, { result: 'run', yards: 4, timeElapsed: 30 }, ctx.offense));
  }
  return { state: structuredClone(c.state) as GameState, game };
};

describe('Season mode saves', () => {
  it('gets its own slot (mode season) that is autosaved', async () => {
    const services = createHeadlessServices();
    const saves = memorySaves();
    const wizard = startSeasonMode(services, { saves, onExit: () => undefined, seed: () => 5, simulator: fallbackSimulator });
    wizard.finish({ teamAbbr: 'PHI' }, null);
    await flushPromises();
    const hub = services.stack.top;
    if (!(hub instanceof FranchiseHubScreen)) throw new Error('expected the season hub');
    expect(hub.mode).toBe('season');
    expect(hub.slot).toMatch(/^season-/);
    const metas = await saves.slots.list();
    expect(metas[0]?.mode).toBe('season');
    expect(slotRows(metas)[0]?.when).toMatch(/^SEASON · /);
    hub.fc.commit({ ...hub.league, name: 'Renamed' }, 'phaseChange');
    await flushPromises();
    expect((await saves.slots.load(hub.slot as string)).league.name).toBe('Renamed');
  });
});

describe('Playoffs mode saves', () => {
  it('saves the run after the simulated regular season', async () => {
    const services = createHeadlessServices();
    const saves = memorySaves();
    const league = leagueAt(92, 'preseason');
    await saves.slots.save('playoffs-1', league, null, { mode: 'playoffs' });
    const mode = new PlayoffsModeScreen({ league, slot: 'playoffs-1', saveSystem: saves, onExit: () => undefined, seasonSimulator: fallbackSimulator, simulator: fallbackSimulator });
    services.stack.push(mode);
    tickUntil(services.stack, () => !(services.stack.top instanceof SimProgressScreen), 20000);
    await flushPromises();
    const loaded = await saves.slots.load('playoffs-1');
    expect(loaded.meta.mode).toBe('playoffs');
    expect(loaded.league.season.phase).toBe('playoffs');
  }, 60000);
});

describe('Playoffs mode season checkpoints', () => {
  it('a reload in the middle of the regular-season sim resumes from the last flushed week, not from preseason', async () => {
    const services = createHeadlessServices();
    const saves = memorySaves();
    const league = leagueAt(93, 'preseason');
    await saves.slots.save('playoffs-2', league, null, { mode: 'playoffs' });
    const mode = new PlayoffsModeScreen({ league, slot: 'playoffs-2', saveSystem: saves, onExit: () => undefined, seasonSimulator: fallbackSimulator, simulator: fallbackSimulator });
    services.stack.push(mode);
    const regular = (): SimProgressScreen | null => {
      const top = services.stack.top;
      return top instanceof SimProgressScreen && top.job.target.kind === 'phase' && top.job.target.phase === 'playoffs' ? top : null;
    };
    tickUntil(services.stack, () => (regular()?.job.league.season.week ?? 0) >= 7, 20000);
    expect(regular()).not.toBeNull();
    await flushPromises();
    // The page is "reloaded" here: whatever reached the slot is what Continue would load.
    const loaded = await saves.slots.load('playoffs-2');
    expect(loaded.league.season.phase).toBe('regularSeason');
    expect(loaded.league.season.week).toBeGreaterThanOrEqual(5);
    expect(loaded.league.season.schedule.filter((g) => !g.isPreseason && g.result).length).toBeGreaterThan(0);
  }, 60000);
});

describe('franchise game in progress', () => {
  it('is saved with the league after each play and resumes at its score instead of replaying', async () => {
    const { state, game } = midGame(71);
    const league = leagueAt(71, 'regularSeason');
    expect(resumableGameFor(league, state, userOf(league))?.id).toBe(game.id);
    expect(resumableGameFor(league, { ...state, phase: 'final' }, userOf(league))).toBeNull();
    const services = createHeadlessServices();
    const saves = memorySaves();
    await saves.slots.save('franchise-1', league);
    const hub = new FranchiseHubScreen({ league, slot: 'franchise-1', saveSystem: saves, onExit: () => undefined, simulator: fallbackSimulator });
    services.stack.push(hub);
    hub.fc.saveLiveGame?.(state);
    await flushPromises();
    const loaded = await saves.slots.load('franchise-1');
    expect(loaded.meta.hasGameInProgress).toBe(true);
    expect(loaded.game?.playLog.length).toBe(state.playLog.length);

    // Reload: a new hub over the loaded slot offers RESUME / SIM THE REST for that game.
    const services2 = createHeadlessServices();
    const hub2 = new FranchiseHubScreen({ league: loaded.league, slot: 'franchise-1', saveSystem: saves, resumeGame: loaded.game, onExit: () => undefined, simulator: fallbackSimulator });
    services2.stack.push(hub2);
    const dialog = services2.stack.top;
    if (!(dialog instanceof ChoiceDialog)) throw new Error('expected the resume prompt');
    expect(dialog.message).toContain(liveGameSummary(league, state));
    expect(dialog.list.items.map((i) => i.id)).toEqual(['resume', 'sim']);
    expect(services2.stack.all.some((s) => s instanceof GameDayScreen)).toBe(true);
    dialog.choose('sim');
    tickUntil(services2.stack, () => services2.stack.top instanceof WeekRecapScreen, 20000);
    const result = hub2.league.season.schedule.find((g) => g.id === game.id)?.result;
    expect(result).not.toBeNull();
    // Simulated on from the saved score: neither side can end below where it stood.
    expect(result!.homeScore).toBeGreaterThanOrEqual(state.score.home);
    expect(result!.awayScore).toBeGreaterThanOrEqual(state.score.away);
    await flushPromises();
    expect((await saves.slots.load('franchise-1')).game).toBeNull();
  }, 60000);
});
