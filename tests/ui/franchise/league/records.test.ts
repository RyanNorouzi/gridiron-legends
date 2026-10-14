import { describe, expect, it } from 'vitest';
import { LEAGUE_RECORD_DEFINITIONS } from '@/franchise/records';
import {
  allProProjected, allProRows, allProYears, awardRows, awardYears, franchiseRecordRows, leagueRecordRows, seasonFinish, seasonHistoryRows,
  seasonSummaries, type RecordRow,
} from '@/ui/franchise/league/records-model';
import { RecordsTab } from '@/ui/franchise/league/records-tab';
import { SeasonDetailScreen, finalStandings } from '@/ui/franchise/league/season-screen';
import { midSeasonLeague, mount, press, render, seasonLeague, nextYearLeague, userOf } from './helpers';

describe('records model', () => {
  it('lists every tracked record of a scope, held or not', () => {
    const league = nextYearLeague();
    for (const scope of ['game', 'season', 'career', 'team'] as const) {
      const rows = leagueRecordRows(league, scope, userOf(league));
      expect(rows).toHaveLength(LEAGUE_RECORD_DEFINITIONS.filter((d) => d.scope === scope).length);
      expect(rows.every((r) => !/\((Game|Season|Career)\)$/.test(r.label))).toBe(true);
    }
    const season = leagueRecordRows(league, 'season', null);
    const yards = season.find((r) => r.id === 'passingYards.season');
    const held = league.records.find((r) => r.key === 'passingYards.season');
    expect(yards?.held).toBe(!!held);
    if (held) expect(yards).toMatchObject({ value: String(held.value), holder: held.holderName, year: String(held.year), playerId: held.holderPlayerId });
  }, 30_000); // the first test pays for simulating the shared next-year league fixture

  it('builds a franchise record book from its players seasons and its team history', () => {
    const league = nextYearLeague();
    const u = userOf(league);
    const rows = franchiseRecordRows(league, u);
    const recs = rows.filter((r): r is RecordRow => r.kind === 'record');
    expect(rows.filter((r) => r.kind === 'heading')).toHaveLength(3);
    const pass = recs.find((r) => r.id === 'fr:passingYards.season');
    const mine = Object.entries(league.careerStats).flatMap(([id, c]) => c.seasons.filter((s) => s.teamId === u).map((s) => ({ id, y: s.line.passing.yards })));
    const best = mine.reduce((m, x) => (x.y > m.y ? x : m), { id: '', y: 0 });
    expect(pass?.value).toBe(best.y > 0 ? String(best.y) : '-');
    if (best.y > 0) expect(pass?.playerId).toBe(best.id);
    const wins = recs.find((r) => r.id === 'ft:wins');
    expect(wins?.value).toBe(String(league.teams[u]?.history[0]?.wins));
    expect(recs.find((r) => r.id === 'ft:titles')?.value).toBe(String(league.teams[u]?.championships));
  });

  it('keeps season history newest first, including a crowned season not yet archived', () => {
    const done = seasonLeague();
    expect(done.history).toHaveLength(0);
    const live = seasonSummaries(done);
    expect(live).toHaveLength(1);
    expect(live[0]?.champion).toBe(done.season.champion);
    const rows = seasonHistoryRows(nextYearLeague(), userOf(done));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ year: done.season.year, championId: done.season.champion, inProgress: false });
    expect(rows[0]?.user).toMatch(/^\d+-\d+/);
    expect(seasonFinish(nextYearLeague(), done.season.champion as NonNullable<typeof done.season.champion>, done.season.year).text).toBe('Champion');
  });

  it('lists awards by year in award order and All-Pro teams (projected during the season)', () => {
    const league = nextYearLeague();
    const year = league.season.year - 1;
    expect(awardYears(league)).toEqual([year]);
    const awards = awardRows(league, year);
    expect(awards[0]?.award).toBe('Most Valuable Player');
    const coy = awards.find((a) => a.award === 'Coach of the Year');
    expect(coy?.playerId).toBeNull();
    expect(coy?.position).toBe('HC');
    expect(allProYears(league)).toEqual([year]);
    const team = allProRows(league, year);
    expect(team.length).toBeGreaterThan(20);
    expect(team[0]?.position).toBe('QB');
    const mid = midSeasonLeague();
    expect(allProProjected(mid)).toBe(true);
    expect(allProYears(mid)).toEqual([mid.season.year]);
    expect(allProRows(mid, mid.season.year).length).toBeGreaterThan(0);
  });
});

describe('RecordsTab', () => {
  it('pages record scopes, franchises and award years; opens holders', () => {
    const league = nextYearLeague();
    const { fc, screen } = mount(league, (c) => new RecordsTab(c));
    expect(screen.view).toBe('league');
    expect(screen.recordScope).toBe('game');
    press(fc, 'menuRight');
    expect(screen.recordScope).toBe('season');
    const table = screen.recordTable;
    const held = table?.rows.findIndex((r) => r.kind === 'record' && r.held && r.playerId) ?? -1;
    expect(held).toBeGreaterThanOrEqual(0);
    table?.select(held);
    press(fc, 'confirm');
    expect(fc.openedPlayers).toHaveLength(1);
    press(fc, 'audible');
    expect(screen.view).toBe('franchise');
    expect(screen.franchiseTeam).toBe(userOf(league));
    press(fc, 'menuRight');
    expect(screen.franchiseTeam).not.toBe(userOf(league));
    press(fc, 'menuLeft');
    expect(screen.franchiseTeam).toBe(userOf(league));
    render(fc);
  });

  it('opens a season detail with its standings, awards and All-Pro team', () => {
    const league = nextYearLeague();
    const { fc, screen } = mount(league, (c) => new RecordsTab(c, { view: 'seasons' }));
    expect(screen.seasonsTable?.rows).toHaveLength(1);
    press(fc, 'confirm');
    const detail = fc.stack.top;
    expect(detail).toBeInstanceOf(SeasonDetailScreen);
    const d = detail as SeasonDetailScreen;
    expect(d.chips.tabs.map((t) => t.id)).toEqual(['standings', 'awards', 'allpro']);
    const rows = finalStandings(fc, d.year) ?? [];
    expect(rows).toHaveLength(Object.keys(league.teams).length);
    expect(rows[0]?.pctValue).toBeGreaterThanOrEqual(rows[rows.length - 1]?.pctValue ?? 1);
    expect(rows.find((r) => r.finish.text === 'Champion')).toBeDefined();
    press(fc, 'menuTabRight');
    expect(d.view).toBe('awards');
    press(fc, 'confirm');
    expect(fc.openedPlayers).toHaveLength(1);
    press(fc, 'menuTabRight');
    expect(d.view).toBe('allpro');
    render(fc);
    press(fc, 'back');
    expect(fc.stack.top).toBe(screen);
  });

  it('shows the awards and All-Pro of the latest year and reports empty years', () => {
    const league = nextYearLeague();
    const { screen } = mount(league, (c) => new RecordsTab(c, { view: 'awards' }));
    expect(screen.awardsYear).toBe(league.season.year - 1);
    expect(screen.awardsTable?.rows.length).toBeGreaterThan(5);
    expect(screen.pager()).toMatchObject({ canPrev: false, canNext: false });
    screen.showView('allpro');
    expect(screen.allProSeason).toBe(league.season.year - 1);
    expect(screen.summary().text).toBe('First team');
    const early = mount(midSeasonLeague(), (c) => new RecordsTab(c, { view: 'awards' }));
    expect(early.screen.awardsTable?.rows).toHaveLength(0);
    expect(early.screen.awardsTable?.emptyText).toContain('No awards');
    early.screen.showView('allpro');
    expect(early.screen.summary().text).toContain('Projected');
  });
});
