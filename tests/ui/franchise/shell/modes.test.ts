import { describe, expect, it } from 'vitest';
import type { TeamId } from '@/core/ids';
import { fallbackSimulator } from '@/franchise/sim-fallback';
import { createHeadlessServices } from '@/ui/franchise/context';
import { ChoiceDialog } from '@/ui/franchise/kit/dialogs';
import { playoffField, PlayoffsModeScreen, withUserTeam } from '@/ui/franchise/playoffs-mode';
import { createSeasonHub, startSeasonMode } from '@/ui/franchise/season-mode';
import { bracketRounds } from '@/ui/franchise/shell/bracket-view';
import { SimProgressScreen } from '@/ui/franchise/shell/progress-screen';
import { WeekRecapScreen } from '@/ui/franchise/shell/recap-screen';
import { SeasonSummaryScreen, seasonSummary } from '@/ui/franchise/shell/season-summary';
import { NewFranchiseScreen } from '@/ui/franchise/new-franchise';
import { GameDayScreen } from '@/ui/franchise/game-day';
import { makeInput } from '../../render/fake-ctx';
import { leagueAt, rcFor, tickUntil, userOf } from './helpers';

describe('Season mode', () => {
  it('plays one season to a champion and ends with the summary', () => {
    const services = createHeadlessServices();
    const exits: number[] = [];
    const hub = createSeasonHub(leagueAt(91, 'regularSeason'), { onExit: () => exits.push(1), simulator: fallbackSimulator });
    services.stack.push(hub);
    expect(hub.mode).toBe('season');
    const toEnd = hub.advanceOptions().find((o) => o.id === 'simTo:awards');
    hub.runAdvance(toEnd?.action ?? { kind: 'summary' });
    tickUntil(services.stack, () => services.stack.top instanceof WeekRecapScreen, 20000);
    expect(hub.league.season.phase).toBe('awards');
    expect(hub.league.season.champion).not.toBeNull();
    (services.stack.top as WeekRecapScreen).close();
    const summary = services.stack.top as SeasonSummaryScreen;
    expect(summary).toBeInstanceOf(SeasonSummaryScreen);
    expect(summary.view.champion).toBe(hub.league.season.champion);
    expect(hub.league.season.awards.length).toBeGreaterThan(0);
    expect(summary.view.lines.some((l) => l.id.startsWith('award:'))).toBe(true);
    expect(summary.view.lines.find((l) => l.id === 'record')?.text).toMatch(/^Your record: \d+-\d+/);
    summary.render(rcFor(services));
    services.stack.update(1 / 60, makeInput({ pressed: ['back'] }));
    expect(exits).toEqual([1]);
    expect(hub.advanceOptions().map((o) => o.id)).toEqual(['summary']);
  }, 60000);

  it('starts from the season wizard and replaces it with the hub', () => {
    const services = createHeadlessServices();
    let created = false;
    const wizard = startSeasonMode(services, { onExit: () => undefined, seed: () => 5, onHub: () => { created = true; } });
    expect(services.stack.top).toBe(wizard);
    expect(wizard).toBeInstanceOf(NewFranchiseScreen);
    wizard.finish({ teamAbbr: 'PHI' }, null);
    expect(created).toBe(true);
    expect(services.stack.all.includes(wizard)).toBe(false);
    expect(services.stack.top?.id).toBe('franchise-hub');
  });
});

describe('Playoffs mode', () => {
  it('simulates the regular season, shows the bracket and advances it to a champion', () => {
    const services = createHeadlessServices();
    const exits: number[] = [];
    const league = leagueAt(92, 'preseason');
    const mode = new PlayoffsModeScreen({ league, onExit: () => exits.push(1), seasonSimulator: fallbackSimulator, simulator: fallbackSimulator });
    services.stack.push(mode);
    expect(services.stack.top).toBeInstanceOf(SimProgressScreen);
    tickUntil(services.stack, () => !(services.stack.top instanceof SimProgressScreen), 20000);
    expect(mode.league.season.phase).toBe('playoffs');
    if (services.stack.top instanceof ChoiceDialog) {
      const field = playoffField(mode.league);
      expect(field).toHaveLength(14);
      (services.stack.top as ChoiceDialog).choose(field[3] as string);
      expect(userOf(mode.league)).toBe(field[3]);
    }
    expect(services.stack.top).toBe(mode);
    const rounds = bracketRounds(mode.league, userOf(mode.league));
    expect(rounds.map((r) => r.name)).toEqual(mode.league.settings.playoff.roundNames);
    expect(rounds[0]?.rows.filter((r) => r.bye)).toHaveLength(2);
    expect(rounds[0]?.rows.some((r) => r.user)).toBe(true);
    mode.render(rcFor(services));
    const options = mode.options();
    const play = options.find((o) => o.id === 'play');
    if (play) {
      mode.run(play.action);
      expect(services.stack.top).toBeInstanceOf(GameDayScreen);
      services.stack.update(1 / 60, makeInput({ pressed: ['back'] }));
    }
    let guard = 0;
    while (mode.league.season.phase === 'playoffs' && guard++ < 6) {
      const round = mode.league.season.week;
      mode.sim({ kind: 'week' });
      tickUntil(services.stack, () => services.stack.top instanceof WeekRecapScreen, 5000);
      const after = mode.league.season;
      expect(after.week === round + 1 || (after.phase as string) === 'awards').toBe(true);
      (services.stack.top as WeekRecapScreen).close();
      expect(mode.view?.round).toBeGreaterThanOrEqual(Math.min(round + 1, rounds.length));
    }
    expect(mode.league.season.champion).not.toBeNull();
    const summary = services.stack.top as SeasonSummaryScreen;
    expect(summary).toBeInstanceOf(SeasonSummaryScreen);
    expect(seasonSummary(mode.league, userOf(mode.league)).lines[0]?.text).toMatch(/^Champion: /);
    summary.close();
    expect(exits).toEqual([1]);
  }, 60000);

  it('offers a playoff team when the chosen team missed the playoffs', () => {
    const inPlayoffs = leagueAt(92, 'playoffs');
    const field = playoffField(inPlayoffs);
    const missed = Object.keys(inPlayoffs.teams).find((id) => !field.includes(id as TeamId)) as TeamId;
    const services = createHeadlessServices();
    const exits: number[] = [];
    const mode = new PlayoffsModeScreen({ league: withUserTeam(inPlayoffs, missed), onExit: () => exits.push(1), simulator: fallbackSimulator });
    services.stack.push(mode);
    const dialog = services.stack.top as ChoiceDialog;
    expect(dialog).toBeInstanceOf(ChoiceDialog);
    expect(dialog.title).toBe('Missed the playoffs');
    expect(dialog.list.items).toHaveLength(field.length);
    dialog.choose(field[0] as string);
    expect(userOf(mode.league)).toBe(field[0]);
    expect(mode.fc.userTeamId).toBe(field[0]);
    expect(mode.options()[0]?.id).toBe('simWeek');
    const again = new PlayoffsModeScreen({ league: withUserTeam(inPlayoffs, missed), onExit: () => exits.push(2), simulator: fallbackSimulator });
    services.stack.push(again);
    (services.stack.top as ChoiceDialog).choose(null);
    expect(exits).toEqual([2]);
  }, 60000);

  it('switches the user team consistently', () => {
    const league = leagueAt(92, 'preseason');
    const other = Object.keys(league.teams).find((id) => id !== league.userTeamId) as TeamId;
    const next = withUserTeam(league, other);
    expect(next.userTeamId).toBe(other);
    expect(Object.values(next.teams).filter((t) => t.isUserControlled).map((t) => t.id)).toEqual([other]);
    expect(league.userTeamId).not.toBe(other);
    expect(() => withUserTeam(league, 'nope' as TeamId)).toThrow();
  });
});
