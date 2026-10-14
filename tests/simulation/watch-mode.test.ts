import { describe, expect, it } from 'vitest';
import { createRng } from '@/core/rng';
import { GameController } from '@/game/game-controller';
import { createGameState } from '@/game/game-state';
import type { PlayOutcome } from '@/game/play-types';
import type { GameState } from '@/game/types';
import { generateLeagueEntities } from '@/teams/league-generator';
import { playbookRegistries, quickSetup } from '@/simulation/game-sim';
import { simulatePlay } from '@/simulation/fast-sim';
import { createWatchMode, describeGameSituation, isJumpInMoment, jumpInRole, SIM_SPEEDS } from '@/simulation/watch-mode';

const ENTITIES = generateLeagueEntities(9, { year: 2026, salaryCap: 250_000_000 });
const ABBRS = Object.values(ENTITIES.teams).map((t) => t.abbr);
const setup = quickSetup(ENTITIES, ABBRS[0] as string, ABBRS[1] as string, { seed: 77, userSide: 'home', controllers: { home: 'watch', away: 'ai' } });

const stateAt = (patch: Partial<GameState>): GameState => {
  const s = createGameState(setup);
  const { clock, ...rest } = patch;
  Object.assign(s, { phase: 'playcall', possession: 'away', ...rest });
  if (clock) s.clock = { ...s.clock, ...clock };
  return s;
};

const makeWatch = (opts: { simSpeed?: number; minPlaysBetween?: number } = {}) => {
  const controller = new GameController(setup, { registries: playbookRegistries() });
  const settings = { simSpeed: opts.simSpeed ?? 4 };
  const watch = createWatchMode({ controller, rng: createRng(1), settings, promptPolicy: { minPlaysBetween: opts.minPlaysBetween ?? 6 } });
  return { controller, settings, watch };
};

describe('jump-in prompts', () => {
  it('prompts on third down in the red zone but not on first and ten at midfield', () => {
    const { watch } = makeWatch();
    expect(watch.shouldPromptJumpIn(stateAt({ down: 1, distance: 10, ballOn: 50 }))).toBe(false);
    expect(watch.shouldPromptJumpIn(stateAt({ down: 3, distance: 7, ballOn: 85 }))).toBe(true);
  });

  it('recognises two-minute, one-score-late and fourth-and-short moments, and stays quiet in blowouts', () => {
    expect(isJumpInMoment(stateAt({ down: 2, distance: 8, ballOn: 40, clock: { quarter: 4, secondsRemaining: 100, running: true, playClock: 40, playClockRunning: false }, score: { home: 20, away: 17 } }), 'home')).toBe(true);
    expect(isJumpInMoment(stateAt({ down: 4, distance: 1, ballOn: 55 }), 'home')).toBe(true);
    expect(isJumpInMoment(stateAt({ down: 1, distance: 10, ballOn: 30, clock: { quarter: 3, secondsRemaining: 400, running: true, playClock: 40, playClockRunning: false } }), 'home')).toBe(false);
    const { watch } = makeWatch();
    expect(watch.shouldPromptJumpIn(stateAt({ down: 3, distance: 2, ballOn: 90, clock: { quarter: 4, secondsRemaining: 200, running: true, playClock: 40, playClockRunning: false }, score: { home: 3, away: 38 } }))).toBe(false);
  });

  it('is rate-limited by plays between prompts', () => {
    const { watch } = makeWatch({ minPlaysBetween: 5 });
    const hot = (plays: number): GameState => { const s = stateAt({ down: 3, distance: 3, ballOn: 88 }); s.playLog = new Array(plays).fill(null).map(() => ({} as never)); return s; };
    expect(watch.shouldPromptJumpIn(hot(0))).toBe(true);
    expect(watch.shouldPromptJumpIn(hot(2))).toBe(false);
    expect(watch.shouldPromptJumpIn(hot(4))).toBe(false);
    expect(watch.shouldPromptJumpIn(hot(5))).toBe(true);
    expect(watch.shouldPromptJumpIn(hot(6))).toBe(false);
  });

  it('describes the situation for the prompt', () => {
    // The user (home) has the ball in the first three; the spot is read from the user's side.
    const s = stateAt({ possession: 'home', down: 3, distance: 7, ballOn: 66, clock: { quarter: 4, secondsRemaining: 130, running: true, playClock: 40, playClockRunning: false }, score: { home: 14, away: 17 } });
    expect(describeGameSituation(s, 'home')).toBe('3rd & 7 at OPP 34, 2:10 left, down 3');
    expect(describeGameSituation(stateAt({ possession: 'home', down: 1, distance: 10, ballOn: 20, score: { home: 7, away: 7 } }), 'home')).toBe('1st & 10 at OWN 20, 8:00 left, tied');
    expect(describeGameSituation(stateAt({ possession: 'home', down: 2, distance: 3, ballOn: 97, score: { home: 10, away: 3 } }), 'home')).toBe('2nd & Goal at OPP 3, 8:00 left, up 7');
    expect(describeGameSituation(stateAt({ down: 1, distance: 10, ballOn: 50 }), 'home')).toMatch(/^1st & 10 at 50,/);
    // Home defends while away has the ball at its own 14: that is home's OPP 14.
    expect(describeGameSituation(stateAt({ down: 1, distance: 10, ballOn: 14 }), 'home')).toMatch(/^1st & 10 at OPP 14,/);
    expect(describeGameSituation(stateAt({ down: 1, distance: 10, ballOn: 14 }), 'away')).toMatch(/^1st & 10 at OWN 14,/);
  });
});

describe('speed, skip, jump in and resume', () => {
  it('speed snaps to 1/2/4/8, syncs the settings and the controller', () => {
    const { controller, settings, watch } = makeWatch({ simSpeed: 4 });
    expect(watch.speed).toBe(4);
    expect(watch.speedUp()).toBe(8);
    expect(watch.speedUp()).toBe(8);
    expect(settings.simSpeed).toBe(8);
    expect(controller.watch.speed).toBe(8);
    expect(watch.speedDown()).toBe(4);
    expect(watch.setSpeed(5)).toBe(4);
    expect(watch.setSpeed(3)).toBe(2);
    expect(watch.setSpeed(1)).toBe(1);
    expect(watch.speedDown()).toBe(1);
    expect(controller.watch.speed).toBe(1);
    expect(SIM_SPEEDS).toEqual([1, 2, 4, 8]);
  });

  it('skipCurrentPlay routes exactly one play through the fast executor', () => {
    const controller = new GameController(setup, { registries: playbookRegistries() });
    let calls = 0;
    const executor = (ctx: Parameters<typeof simulatePlay>[0]): PlayOutcome => { calls += 1; return simulatePlay(ctx); };
    const watch = createWatchMode({ controller, rng: createRng(2), settings: { simSpeed: 1 }, executor });
    controller.start();
    expect(watch.skipCurrentPlay()).toBe(true);
    expect(watch.skipPending).toBe(true);
    expect(controller.watch.skipRequested).toBe(true);
    const ctx = controller.beginPlay();
    const o = watch.executeIfSkipped(ctx);
    expect(o).not.toBeNull();
    expect(calls).toBe(1);
    expect(watch.skipPending).toBe(false);
    expect(controller.watch.skipRequested).toBe(false);
    controller.completePlay(o as PlayOutcome);
    const ctx2 = controller.beginPlay();
    expect(watch.executeIfSkipped(ctx2)).toBeNull();
    expect(calls).toBe(1);
    expect(watch.skipCurrentPlay()).toBe(true);
    controller.completePlay(watch.executeIfSkipped(ctx2) as PlayOutcome);
    expect(calls).toBe(2);
  });

  it('jumpIn hands the side to the human with the right control role, resume goes back to watching', () => {
    const { controller, watch } = makeWatch();
    controller.start();
    const role = watch.jumpIn('home');
    expect(controller.state.controllers.home).toBe('human');
    expect(role).toBe(controller.state.possession === 'home' ? 'QB' : 'FS');
    expect(jumpInRole(stateAt({ possession: 'home' }), 'home')).toBe('QB');
    expect(jumpInRole(stateAt({ possession: 'away' }), 'home')).toBe('FS');
    watch.resume();
    expect(controller.state.controllers.home).toBe('watch');
    expect(() => watch.jumpIn('away')).toThrow(/watch/);
  });
});
