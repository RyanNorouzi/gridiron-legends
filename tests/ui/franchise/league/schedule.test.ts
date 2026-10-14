import { describe, expect, it } from 'vitest';
import type { GameId } from '@/core/ids';
import { advanceLeagueWeek } from '@/franchise/season-loop';
import { fallbackSimulator } from '@/franchise/sim-fallback';
import type { League, ScheduledGame } from '@/franchise/types';
import { emptyOutcome } from '@/game/outcome-factory';
import type { PlayLogEntry } from '@/game/types';
import { PlayerCardScreen } from '@/ui/franchise/player-card';
import { buildBoxScore, playRows, situationText, teamStatRows } from '@/ui/franchise/league/boxscore-model';
import { BoxScoreScreen } from '@/ui/franchise/league/boxscore-screen';
import {
  defaultScoreWeek, focusScheduleRow, scheduleSummary, scoreboardRows, scoreboardSummary, scoreboardWeeks, userScheduleRows,
} from '@/ui/franchise/league/schedule-model';
import { ScheduleTab } from '@/ui/franchise/league/schedule-tab';
import { emptyTeamStatLine } from '@/statistics/empty';
import { centre, midSeasonLeague, mount, press, render, seasonLeague, tapAt, userOf } from './helpers';

const lastPlayedUserGame = (league: League): ScheduledGame => {
  const u = userOf(league);
  const games = league.season.schedule.filter((g) => g.result && !g.isPreseason && (g.home === u || g.away === u));
  const g = games[games.length - 1];
  if (!g) throw new Error('no played user game');
  return g;
};

describe('schedule model', () => {
  it('lists the user season in calendar order with results, the record after each game and one bye', () => {
    const league = midSeasonLeague();
    const u = userOf(league);
    const rows = userScheduleRows(league, u);
    const order = { pre: 0, reg: 1, po: 2 };
    rows.slice(1).forEach((r, i) => expect(order[r.kind]).toBeGreaterThanOrEqual(order[(rows[i] as typeof r).kind]));
    const reg = rows.filter((r) => r.kind === 'reg');
    expect(reg.filter((r) => r.bye)).toHaveLength(league.settings.byeWeeks ? 1 : 0);
    const played = reg.filter((r) => r.played);
    expect(played.length).toBeGreaterThan(0);
    for (const r of played) expect(r.result.text).toMatch(/^[WLT] \d+-\d+/);
    const s = league.season.standings[u];
    const last = played[played.length - 1];
    expect(last?.record).toBe(s && s.ties ? `${s.wins}-${s.losses}-${s.ties}` : `${s?.wins}-${s?.losses}`);
    const current = rows.find((r) => r.current);
    if (current) expect(current.played).toBe(false);
    expect(focusScheduleRow(rows)).toBe(current?.id ?? last?.id);
    expect(scheduleSummary(league, u)).toContain(`${league.season.year} ${league.teams[u]?.abbr}`);
  });

  it('builds scoreboard weeks across the season and defaults to the latest week with finals', () => {
    const league = seasonLeague();
    const weeks = scoreboardWeeks(league);
    expect(weeks[0]?.kind).toBe('pre');
    expect(weeks.some((w) => w.kind === 'po' && w.label === league.settings.playoff.roundNames[0])).toBe(true);
    expect(defaultScoreWeek(league)).toBe(weeks[weeks.length - 1]?.key);
    const mid = midSeasonLeague();
    expect(defaultScoreWeek(mid)).toBe(`reg:${mid.season.week - 1}`);
  });

  it('lists a week of games with the user game first and final / upcoming statuses', () => {
    const league = midSeasonLeague();
    const u = userOf(league);
    const played = scoreboardRows(league, 'reg:1', u);
    expect(played.length).toBeGreaterThan(0);
    expect(played.every((r) => r.played && r.status.text.startsWith('Final'))).toBe(true);
    if (played.some((r) => r.user)) expect(played[0]?.user).toBe(true);
    for (const r of played) expect(r.winner === null ? r.awayScore === r.homeScore : true).toBe(true);
    expect(scoreboardSummary(played)).toContain('all final');
    const upcoming = scoreboardRows(league, `reg:${league.season.week}`, u);
    expect(upcoming.every((r) => !r.played && r.status.text === 'Upcoming')).toBe(true);
    expect(scoreboardSummary(upcoming)).toBe(`0 of ${upcoming.length} final`);
  });
});

describe('box score model', () => {
  it('compares team lines and credits each player line to his side', () => {
    const league = midSeasonLeague();
    const g = lastPlayedUserGame(league);
    const box = buildBoxScore(league, g.id);
    if (!box || !g.result) throw new Error('box');
    expect(box.played).toBe(true);
    expect(box.home.score).toBe(g.result.homeScore);
    expect(box.away.abbr).toBe(league.teams[g.away]?.abbr);
    expect(box.teamRows.find((r) => r.id === 'yds')?.home).toBe(String(g.result.stats.teams.home.totalYards));
    expect(box.players.passing.length).toBeGreaterThanOrEqual(2);
    expect(new Set(box.players.passing.map((r) => r.side))).toEqual(new Set(['home', 'away']));
    for (const r of box.players.rushing) expect([box.home.abbr, box.away.abbr]).toContain(r.team);
    expect(box.plays).toBeNull();
    expect(buildBoxScore(league, 'nope' as GameId)).toBeNull();
  });

  it('marks the better side of each comparison (lower is better for turnovers)', () => {
    const a = { ...emptyTeamStatLine(), totalYards: 300, turnovers: 1, plays: 60 };
    const h = { ...emptyTeamStatLine(), totalYards: 250, turnovers: 3, plays: 50 };
    const rows = teamStatRows(a, h);
    expect(rows.find((r) => r.id === 'yds')?.better).toBe('away');
    expect(rows.find((r) => r.id === 'to')?.better).toBe('away');
    expect(rows.find((r) => r.id === 'plays')?.better).toBeNull();
    expect(rows.find((r) => r.id === 'ypp')?.away).toBe('5.0');
  });

  it('shows whole penalty yards (half-the-distance enforcement leaves fractions)', () => {
    const rows = teamStatRows({ ...emptyTeamStatLine(), penalties: 6, penaltyYards: 59.5 }, { ...emptyTeamStatLine(), penalties: 2, penaltyYards: 7.25 });
    expect(rows.find((r) => r.id === 'pen')).toMatchObject({ away: '6-60', home: '2-7' });
  });

  it('formats play-by-play from a stored log', () => {
    const league = midSeasonLeague();
    const g = lastPlayedUserGame(league);
    const entry = (index: number, over: Partial<PlayLogEntry>, outcome = emptyOutcome()): PlayLogEntry => ({
      index, quarter: 1, clock: 845, possession: 'home', down: 1, distance: 10, ballOn: 25, ballX: 26, offensivePlayId: null, defensivePlayId: null,
      outcome, scoreAfter: { home: 0, away: 0 }, review: null, ...over,
    });
    const log = [
      entry(0, {}, emptyOutcome({ result: 'run', yards: 4, playByPlay: ['Run up the middle for 4.'] })),
      entry(1, { down: 3, distance: 5, ballOn: 95, quarter: 5, scoreAfter: { home: 7, away: 3 } }, emptyOutcome({ result: 'touchdown', points: 6, touchdown: true })),
    ];
    const rows = playRows(league, g, log);
    expect(rows[0]?.text).toBe('Run up the middle for 4.');
    expect(rows[0]?.clock).toBe('14:05');
    expect(rows[0]?.situation).toBe(`1st & 10 at ${league.teams[g.home]?.abbr} 25`);
    expect(rows[1]).toMatchObject({ quarter: 'OT', score: '3-7', tone: 'success', situation: `3rd & Goal at ${league.teams[g.away]?.abbr} 5` });
    expect(situationText(league, g, { down: 0, distance: 0, ballOn: 50, possession: 'away' })).toBe('at 50');
    const withLog: League = {
      ...league, playLogs: { ...league.playLogs, [g.id]: log },
      season: { ...league.season, schedule: league.season.schedule.map((x) => (x.id === g.id && x.result ? { ...x, result: { ...x.result, playLogId: g.id } } : x)) },
    };
    expect(buildBoxScore(withLog, g.id)?.plays).toHaveLength(2);
  });
});

describe('ScheduleTab', () => {
  it('opens the box score of a played game and the opponent of an upcoming one (keyboard)', () => {
    const league = midSeasonLeague();
    const { fc, screen } = mount(league, (c) => new ScheduleTab(c));
    const table = screen.mineTable;
    if (!table) throw new Error('table');
    const upcoming = table.rows.findIndex((r) => !r.played && !r.bye);
    table.select(upcoming);
    press(fc, 'confirm');
    expect(fc.openedTeams).toEqual([table.rows[upcoming]?.opponentId]);
    const played = table.rows.findIndex((r) => r.played);
    table.select(played);
    press(fc, 'confirm');
    expect(fc.stack.top).toBeInstanceOf(BoxScoreScreen);
    expect((fc.stack.top as BoxScoreScreen).gameId).toBe(table.rows[played]?.gameId);
    const bye = table.rows.findIndex((r) => r.bye);
    if (bye >= 0) {
      fc.pop();
      // resume() rebuilt the table from the League, keeping the selected game.
      const again = screen.mineTable;
      expect(again).not.toBe(table);
      expect(again?.selected?.gameId).toBe(table.rows[played]?.gameId);
      again?.select(bye);
      press(fc, 'confirm');
      expect(fc.toasts).toContain('Bye week');
    }
  });

  it('browses scoreboard weeks with Left/Right, the pager arrows (touch) and Y to switch views', () => {
    const league = midSeasonLeague();
    const { fc, screen } = mount(league, (c) => new ScheduleTab(c));
    press(fc, 'audible');
    expect(screen.view).toBe('scores');
    const start = screen.scoreWeek;
    press(fc, 'menuLeft');
    expect(screen.scoreWeek).not.toBe(start);
    press(fc, 'menuRight');
    expect(screen.scoreWeek).toBe(start);
    render(fc);
    const status = screen.lastLayout?.status;
    if (!status) throw new Error('layout');
    tapAt(fc, status.x + 3, status.y + 3);
    expect(screen.scoreWeek).not.toBe(start);
    expect(screen.pager()?.label).toMatch(/Week|Preseason/);
  });

  it('follows the newest week after the league advances unless the user browsed away', () => {
    const league = midSeasonLeague();
    const next = advanceLeagueWeek(league, { simulator: fallbackSimulator }).league;
    const follow = mount(league, (c) => new ScheduleTab(c, { view: 'scores' }));
    expect(follow.screen.scoreWeek).toBe(`reg:${league.season.week - 1}`);
    follow.fc.commit(next, 'weekAdvance');
    follow.screen.resume();
    expect(follow.screen.scoreWeek).toBe(`reg:${league.season.week}`);
    const stay = mount(league, (c) => new ScheduleTab(c, { view: 'scores' }));
    press(stay.fc, 'menuLeft');
    const browsed = stay.screen.scoreWeek;
    stay.fc.commit(next, 'weekAdvance');
    stay.screen.resume();
    expect(stay.screen.scoreWeek).toBe(browsed);
  });

  it('opens a final with a mouse click exactly once', () => {
    const league = midSeasonLeague();
    const { fc, screen } = mount(league, (c) => new ScheduleTab(c, { view: 'scores' }));
    render(fc);
    const hit = screen.scoresTable?.hitMap?.rows[0];
    if (!hit) throw new Error('row');
    const p = centre(hit.rect);
    tapAt(fc, p.x, p.y, 'mouse');
    expect(fc.pushed.filter((s) => s instanceof BoxScoreScreen)).toHaveLength(1);
  });
});

describe('BoxScoreScreen', () => {
  it('switches views with U/O, opens player cards and closes with Back', () => {
    const league = midSeasonLeague();
    const g = lastPlayedUserGame(league);
    const { fc, screen } = mount(league, (c) => new BoxScoreScreen(c, g.id));
    expect(screen.view).toBe('team');
    render(fc);
    press(fc, 'menuTabRight');
    expect(screen.view).toBe('passing');
    const table = screen.tableFor('passing');
    expect(table?.sortKey).toBe('pyds');
    press(fc, 'confirm');
    expect(fc.openedPlayers).toHaveLength(1);
    press(fc, 'menuTabLeft');
    expect(screen.view).toBe('team');
    press(fc, 'back');
    expect(fc.pops()).toBe(1);
    const ctx = render(fc);
    expect(ctx.calls.length).toBeGreaterThanOrEqual(0);
  });

  it('opens a real player card when the context pushes one', () => {
    const league = midSeasonLeague();
    const g = lastPlayedUserGame(league);
    const { fc } = mount(league, (c) => new BoxScoreScreen(c, g.id, { view: 'rushing' }), { openPlayerScreens: true });
    press(fc, 'confirm');
    expect(fc.stack.top).toBeInstanceOf(PlayerCardScreen);
  });
});
