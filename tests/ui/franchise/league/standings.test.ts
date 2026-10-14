import { describe, expect, it } from 'vitest';
import { BoxScoreScreen } from '@/ui/franchise/league/boxscore-screen';
import {
  bracketRounds, conferenceRows, currentBracketRound, divisionRows, playoffPictureRows, standingsSummary, type PictureRow, type TeamStandingRow,
} from '@/ui/franchise/league/standings-model';
import { StandingsTab } from '@/ui/franchise/league/standings-tab';
import { midSeasonLeague, mount, press, render, seasonLeague, userOf } from './helpers';

const teams = <R extends { kind: string }>(rows: readonly R[]): Exclude<R, { kind: 'heading' }>[] =>
  rows.filter((r) => r.kind !== 'heading') as Exclude<R, { kind: 'heading' }>[];

describe('standings model', () => {
  it('groups division tables best-first with a heading per division', () => {
    const league = midSeasonLeague();
    const rows = divisionRows(league, userOf(league));
    const headings = rows.filter((r) => r.kind === 'heading');
    expect(headings).toHaveLength(league.settings.conferences.length * league.settings.divisionsPerConference);
    expect(teams(rows)).toHaveLength(Object.keys(league.teams).length);
    let group: TeamStandingRow[] = [];
    const check = (): void => group.slice(1).forEach((r, i) => expect(r.pctValue).toBeLessThanOrEqual((group[i] as TeamStandingRow).pctValue));
    for (const r of rows) {
      if (r.kind === 'heading') {
        check();
        group = [];
      } else group.push(r);
    }
    check();
    const mine = teams(rows).filter((r) => r.user);
    expect(mine).toHaveLength(1);
    expect(standingsSummary(rows)).toContain(`${mine[0]?.abbr} `);
  });

  it('ranks whole conferences', () => {
    const league = midSeasonLeague();
    const rows = conferenceRows(league, null);
    expect(rows.filter((r) => r.kind === 'heading').map((r) => (r.kind === 'heading' ? r.label : ''))).toEqual([...league.settings.conferences].sort());
    const first = teams(rows)[0];
    expect(first?.rank).toBe(1);
  });

  it('marks clinched divisions, berths and eliminations once the regular season is over', () => {
    const league = seasonLeague();
    const rows = teams(divisionRows(league, null));
    const divisions = league.settings.conferences.length * league.settings.divisionsPerConference;
    const field = league.settings.playoff.teamsPerConference * league.settings.conferences.length;
    expect(rows.filter((r) => r.mark === 'y')).toHaveLength(divisions);
    expect(rows.filter((r) => r.mark === 'x')).toHaveLength(field - divisions);
    expect(rows.filter((r) => r.mark === 'e')).toHaveLength(rows.length - field);
    expect(rows.find((r) => r.mark === 'e')?.markTone).toBe('danger');
  });

  it('shows the playoff picture with current seeds in season and the drawn field afterwards', () => {
    const mid = midSeasonLeague();
    const pic = teams(playoffPictureRows(mid, userOf(mid))) as PictureRow[];
    const seeded = pic.filter((r) => r.seed !== null);
    expect(seeded).toHaveLength(mid.settings.playoff.teamsPerConference * mid.settings.conferences.length);
    expect(seeded.filter((r) => r.seed === 1).every((r) => /Division|Clinched/.test(r.status.text))).toBe(true);
    expect(pic.filter((r) => r.seed === null).every((r) => ['In the hunt', 'Eliminated'].includes(r.status.text))).toBe(true);
    const done = seasonLeague();
    const final = teams(playoffPictureRows(done, null)) as PictureRow[];
    const bracket = done.season.bracket;
    if (!bracket) throw new Error('bracket');
    for (const [conf, ids] of Object.entries(bracket.seeds)) {
      ids.forEach((id, i) => expect(final.find((r) => r.id === `${conf}:${id}`)?.seed).toBe(i + 1));
    }
    expect(final.filter((r) => r.seed === null).every((r) => r.status.text === 'Eliminated')).toBe(true);
  });

  it('lays the bracket out by round with scores and winners, up to the champion', () => {
    const league = seasonLeague();
    const rounds = bracketRounds(league, userOf(league));
    expect(rounds.map((r) => r.name)).toEqual(league.settings.playoff.roundNames);
    const firstRound = rounds[0]?.rows ?? [];
    const byes = league.settings.playoff.byesPerConference * league.settings.conferences.length;
    expect(firstRound.filter((r) => r.bye)).toHaveLength(byes);
    expect(firstRound.filter((r) => !r.bye).every((r) => r.played && /^\d+-\d+/.test(r.score) && r.winner !== '')).toBe(true);
    const final = rounds[rounds.length - 1]?.rows ?? [];
    expect(final).toHaveLength(1);
    expect(final[0]?.winnerId).toBe(league.season.champion);
    expect(currentBracketRound(league)).toBe(rounds.length);
    expect(bracketRounds(midSeasonLeague(), null).every((r) => r.rows.length === 0)).toBe(true);
  });
});

describe('StandingsTab', () => {
  it('opens teams from division rows and ignores headings; Y cycles views; no bracket before the playoffs', () => {
    const league = midSeasonLeague();
    const { fc, screen } = mount(league, (c) => new StandingsTab(c));
    expect(screen.view).toBe('division');
    expect(screen.chips.tabs.map((t) => t.id)).not.toContain('bracket');
    const table = screen.standingsTable;
    if (!table) throw new Error('table');
    expect(table.selected?.id).toBe(userOf(league));
    press(fc, 'confirm');
    expect(fc.openedTeams).toEqual([userOf(league)]);
    table.select(0);
    press(fc, 'confirm');
    expect(fc.openedTeams).toHaveLength(1);
    press(fc, 'audible');
    expect(screen.view).toBe('conference');
    press(fc, 'audible');
    expect(screen.view).toBe('picture');
    expect(screen.pictureTable?.rows.length).toBeGreaterThan(0);
    render(fc);
  });

  it('starts on the bracket after the playoffs, pages rounds and opens a played game', () => {
    const league = seasonLeague();
    const { fc, screen } = mount(league, (c) => new StandingsTab(c));
    expect(screen.view).toBe('bracket');
    const rounds = league.settings.playoff.roundNames.length;
    expect(screen.bracketRound).toBe(rounds);
    expect(screen.summary().text).toContain('Champion');
    press(fc, 'menuLeft');
    expect(screen.bracketRound).toBe(rounds - 1);
    press(fc, 'menuRight');
    press(fc, 'menuRight');
    expect(screen.bracketRound).toBe(rounds);
    press(fc, 'confirm');
    expect(fc.stack.top).toBeInstanceOf(BoxScoreScreen);
  });

  it('follows the round being played as the season advances until the user browses to another round', () => {
    const done = seasonLeague();
    const bracket = done.season.bracket;
    if (!bracket) throw new Error('bracket');
    const atRound = (week: number): typeof done => ({ ...done, season: { ...done.season, phase: 'playoffs', week, champion: null, bracket: { ...bracket, champion: null } } });
    const { fc, screen } = mount(atRound(1), (c) => new StandingsTab(c));
    expect(screen.view).toBe('bracket');
    expect(screen.bracketRound).toBe(1);
    fc.commit(atRound(2), 'edit');
    screen.resume();
    expect(screen.bracketRound).toBe(2);
    press(fc, 'menuLeft');
    expect(screen.bracketRound).toBe(1);
    fc.commit(atRound(3), 'edit');
    screen.resume();
    expect(screen.bracketRound).toBe(1);
  });

  it('uses the compact column set in large text and keeps every row reachable', () => {
    const league = midSeasonLeague();
    const { fc, screen } = mount(league, (c) => new StandingsTab(c), { settings: { textSize: 'large' }, contentRect: { x: 16, y: 92, w: 448, h: 132 } });
    const keys = screen.standingsTable?.columns.map((c) => c.key);
    expect(keys).toEqual(['mark', 'team', 'rec', 'pct', 'diff']);
    render(fc);
    const layout = screen.lastLayout;
    if (!layout) throw new Error('layout');
    expect(layout.body.y + layout.body.h).toBeLessThanOrEqual(92 + 132);
    expect(Math.floor(layout.body.h / fc.services.theme.lineHeight)).toBeGreaterThanOrEqual(3);
    const total = screen.standingsTable?.rows.length ?? 0;
    for (let i = 0; i < total; i++) press(fc, 'menuDown');
    expect(screen.standingsTable?.selectedIndex).toBe(total - 1);
    expect(screen.standingsTable?.scroll).toBeGreaterThan(0);
  });
});
