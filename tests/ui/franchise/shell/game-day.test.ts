import { beforeAll, describe, expect, it } from 'vitest';
import { buildGameSetup } from '@/franchise/game-setup';
import { advanceLeagueWeek } from '@/franchise/season-loop';
import { fallbackSimulator } from '@/franchise/sim-fallback';
import { realGameSimulator, staffPlaycaller } from '@/franchise/sim-real';
import type { League, ScheduledGame } from '@/franchise/types';
import { recordUserGameResult, userGameThisWeek } from '@/franchise/week';
import { GameController } from '@/game/game-controller';
import { createGameState } from '@/game/game-state';
import type { GameSetup, GameState } from '@/game/types';
import { playbookRegistries, simulateGame, simulateToEnd } from '@/simulation/game-sim';
import { createTestFranchiseContext } from '@/ui/franchise/context';
import { FranchiseGameScreen, GameDayScreen, simulateRestOfGame, userResultFromState } from '@/ui/franchise/game-day';
import { ChoiceDialog } from '@/ui/franchise/kit/dialogs';
import { matchupCard, nextUserGame, weatherText } from '@/ui/franchise/shell/game-day-model';
import { resumableState } from '@/ui/franchise/shell/game-result';
import { SimProgressScreen } from '@/ui/franchise/shell/progress-screen';
import { WeekRecapScreen } from '@/ui/franchise/shell/recap-screen';
import { buildPostGame } from '@/ui/game/box-score';
import type { GameSession } from '@/ui/game/session-types';
import { PostGameScreen } from '@/ui/screens/post-game';
import { makeInput } from '../../render/fake-ctx';
import { leagueAt, rcFor, tickUntil, userOf } from './helpers';

let league: League;
let game: ScheduledGame;
let setup: GameSetup;
let final: GameState;

beforeAll(() => {
  league = leagueAt(71, 'regularSeason');
  game = userGameThisWeek(league) as ScheduledGame;
  const side = game.home === userOf(league) ? 'home' : 'away';
  setup = buildGameSetup(league, game, { userSide: side, controllers: { home: side === 'home' ? 'human' : 'ai', away: side === 'away' ? 'human' : 'ai' } });
  final = simulateGame(setup).state;
}, 60000);

describe('game result bridge', () => {
  it('converts a finished GameState into a UserGameResult consistent with its stats', () => {
    const r = userResultFromState(final);
    expect(r.homeScore).toBe(final.score.home);
    expect(r.awayScore).toBe(final.score.away);
    expect(r.stats.teams.home.points).toBe(r.homeScore);
    expect(r.stats.teams.away.points).toBe(r.awayScore);
    expect(r.overtime).toBe(final.overtimePeriods > 0);
    expect(r.playLog?.length).toBe(final.playLog.length);
    expect(Object.values(r.fatigue ?? {}).every((f) => f > 0 && Number.isFinite(f))).toBe(true);
    expect(r.stats).not.toBe(final.stats);
    const recorded = recordUserGameResult(league, game.id, r);
    expect(recorded.season.schedule.find((g) => g.id === game.id)?.result?.homeScore).toBe(r.homeScore);
    const week = advanceLeagueWeek(league, { userResults: { [game.id]: r }, simulator: fallbackSimulator });
    const stored = week.league.season.schedule.find((g) => g.id === game.id)?.result;
    expect(stored?.homeScore).toBe(r.homeScore);
    expect(stored?.awayScore).toBe(r.awayScore);
    expect(week.league.playLogs[game.id]?.length).toBe(final.playLog.length);
    expect(() => userResultFromState(createGameState(setup))).toThrow(/not final/);
  });

  it('simulates the rest of an abandoned game from mid-game, mid-play and pregame states', () => {
    const ai: GameSetup = { ...setup, userSide: null, controllers: { home: 'ai', away: 'ai' } };
    const controller = new GameController(ai, { registries: playbookRegistries() });
    expect(() => simulateToEnd(controller, { maxPlays: 30 })).toThrow();
    const partial = structuredClone(controller.state) as GameState;
    expect(partial.phase).not.toBe('final');
    const done = simulateRestOfGame(setup, partial);
    expect(done.phase).toBe('final');
    expect(done.playLog.length).toBeGreaterThan(partial.playLog.length);
    expect(done.score.home + done.score.away).toBeGreaterThanOrEqual(partial.score.home + partial.score.away);
    expect(partial.phase).not.toBe('final');
    controller.beginPlay();
    expect(controller.state.phase).toBe('presnap');
    expect(resumableState(controller.state).phase).not.toBe('presnap');
    expect(simulateRestOfGame(setup, controller.state).phase).toBe('final');
    expect(simulateRestOfGame(setup, createGameState(setup)).phase).toBe('final');
    expect(userResultFromState(done).homeScore).toBe(done.score.home);
  }, 30000);
});

describe('sim the rest uses the league staffs', () => {
  it('calls every remaining play through the clubs\' staff playcaller, exactly as a simulated league game does', () => {
    const ai: GameSetup = { ...setup, userSide: null, controllers: { home: 'ai', away: 'ai' } };
    const controller = new GameController(ai, { registries: playbookRegistries() });
    expect(() => simulateToEnd(controller, { maxPlays: 40 })).toThrow();
    const partial = structuredClone(controller.state) as GameState;
    const staff = staffPlaycaller(setup);
    let offenseCalls = 0;
    let defenseCalls = 0;
    const done = simulateRestOfGame(setup, partial, {
      playcaller: {
        offense: (...a) => { offenseCalls++; return staff.offense(...a); },
        defense: (...a) => { defenseCalls++; return staff.defense(...a); },
      },
    });
    expect(done.phase).toBe('final');
    expect(offenseCalls).toBeGreaterThanOrEqual(done.playLog.length - partial.playLog.length);
    expect(defenseCalls).toBe(offenseCalls);
    // From kickoff, sim-the-rest and the league simulator play the very same game.
    const fromKickoff = simulateRestOfGame(setup, createGameState(setup));
    const league = realGameSimulator(setup);
    expect([fromKickoff.score.home, fromKickoff.score.away]).toEqual([league.homeScore, league.awayScore]);
    expect(fromKickoff.playLog.length).toBe(simulateGame(setup, { playcaller: staffPlaycaller(setup) }).state.playLog.length);
  }, 60000);
});

describe('GameDayScreen', () => {
  it('builds the matchup card', () => {
    const card = matchupCard(league, game, userOf(league));
    expect(card.userSide).toBe(game.home === userOf(league) ? 'home' : 'away');
    expect(card.title).toBe(`${league.season.year} Week 1`);
    expect(card.weather).toBe(weatherText(buildGameSetup(league, game).weather));
    expect(card.final).toBeNull();
    expect(nextUserGame(league, userOf(league))?.id).toBe(game.id);
  });

  it('sims the week, commits it and shows the recap', () => {
    const fc = createTestFranchiseContext(league);
    const day = new GameDayScreen(fc, game.id, { simulator: fallbackSimulator });
    fc.push(day);
    day.render(rcFor(fc.services));
    fc.stack.update(1 / 60, makeInput({ pressed: ['menuDown'] }));
    fc.stack.update(1 / 60, makeInput({ pressed: ['menuDown'] }));
    fc.stack.update(1 / 60, makeInput({ pressed: ['confirm'] }));
    expect(fc.stack.top).toBeInstanceOf(SimProgressScreen);
    tickUntil(fc.stack, () => fc.stack.top instanceof WeekRecapScreen);
    expect(fc.commits.map((c) => c.reason)).toEqual(['weekAdvance']);
    expect(fc.league().season.week).toBe(2);
    expect(fc.stack.all.includes(day)).toBe(false);
    expect((fc.stack.top as WeekRecapScreen).view.results[0]?.text).toMatch(/^Wk 1: [WLT] \d+-\d+ (vs|at) /);
  });

  it('applies a played game (gameEnd + weekAdvance) with its box score', () => {
    const fc = createTestFranchiseContext(league);
    const day = new GameDayScreen(fc, game.id, { simulator: fallbackSimulator });
    fc.push(day);
    day.finishPlayed(final);
    tickUntil(fc.stack, () => fc.stack.top instanceof WeekRecapScreen);
    expect(fc.commits.map((c) => c.reason)).toEqual(['gameEnd', 'weekAdvance']);
    const stored = fc.league().season.schedule.find((g) => g.id === game.id)?.result;
    expect(stored?.homeScore).toBe(final.score.home);
    const recap = fc.stack.top as WeekRecapScreen;
    expect(recap.view.box?.rows[0]).toMatchObject({ label: 'POINTS', home: String(final.score.home), away: String(final.score.away) });
    expect(recap.section).toBe('box');
    recap.render(rcFor(fc.services));
  });

  it('reports the final whistle from the game screen and offers sim-the-rest on quit', () => {
    const fc = createTestFranchiseContext(league);
    const finals: GameState[] = [];
    const session = {
      setup, state: final, stage: { kind: 'final', result: buildPostGame(setup, final) }, userSide: setup.userSide, watching: false, speed: 1,
      live: null, liveMeta: null, displayPlay: null, displayMeta: null, lastSummary: null, registry: null, snapshot: null,
      start: () => undefined, update: () => undefined, subscribe: () => () => undefined, cameraContext: () => 'watch', lastReplay: () => null,
    } as unknown as GameSession;
    const day = new GameDayScreen(fc, game.id, { simulator: fallbackSimulator, createSession: () => session });
    fc.push(day);
    const screen = new FranchiseGameScreen(session, (s) => finals.push(s as GameState), { onQuit: () => undefined, onPlayAgain: () => undefined });
    fc.push(screen);
    fc.tick();
    expect(finals).toEqual([final]);
    expect(fc.stack.top).toBe(day);
    expect(fc.stack.all.some((s) => s instanceof PostGameScreen)).toBe(false);

    const live = { ...session, state: createGameState(setup), stage: { kind: 'pregame' } } as unknown as GameSession;
    const day2 = new GameDayScreen(fc, game.id, { simulator: fallbackSimulator, createSession: () => live });
    fc.push(day2);
    (day2 as unknown as { session: GameSession }).session = live;
    day2.confirmLeave();
    const dialog = fc.stack.top as ChoiceDialog;
    expect(dialog.list.items.map((i) => i.id)).toEqual(['sim', 'stay']);
    dialog.choose('sim');
    expect(fc.stack.top).toBeInstanceOf(SimProgressScreen);
    tickUntil(fc.stack, () => fc.stack.top instanceof WeekRecapScreen);
    expect(fc.commits.slice(-2).map((c) => c.reason)).toEqual(['gameEnd', 'weekAdvance']);
    expect(fc.league().season.schedule.find((g) => g.id === game.id)?.result).not.toBeNull();
  });
});
