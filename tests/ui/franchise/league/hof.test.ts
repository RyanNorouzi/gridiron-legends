import { describe, expect, it } from 'vitest';
import type { PlayerId } from '@/core/ids';
import { careerSummary } from '@/franchise/hall-of-fame';
import type { HallOfFamer, League } from '@/franchise/types';
import { CareerScreen } from '@/ui/franchise/league/career-screen';
import { breakdownParts, breakdownText, candidateRows, careerLines, inducteeRows, latestClass } from '@/ui/franchise/league/hof-model';
import { HallOfFameTab } from '@/ui/franchise/league/hof-tab';
import { leagueTabs } from '@/ui/franchise/tabs-league';
import { mount, nextYearLeague, press, render } from './helpers';

/**
 * The next-year league with a Hall of Fame class of three retirees who played in the league, built from their
 * career summaries exactly as inductHallOfFamers builds entries (one season is too short to reach a real threshold).
 */
let hall: League | null = null;
const withHall = (): League => {
  if (hall) return hall;
  const league = nextYearLeague();
  const ids = (Object.keys(league.retiredPlayers) as PlayerId[]).filter((id) => (league.careerStats[id]?.seasons.length ?? 0) > 0).sort().slice(0, 3);
  const hallOfFame: HallOfFamer[] = ids.map((id) => {
    const s = careerSummary(league, id);
    if (!s) throw new Error('summary');
    return {
      playerId: id, inductedYear: league.season.year, name: s.name, position: s.position, seasons: s.seasons, peakOverall: s.peakOverall,
      championships: s.championships, awards: s.awards, careerStats: s.totals, teams: s.teams,
    };
  });
  hall = { ...league, hallOfFame };
  return hall;
};

describe('Hall of Fame model', () => {
  it('lists inductees newest class first with their teams and honours', () => {
    const league = withHall();
    const rows = inducteeRows(league);
    expect(rows).toHaveLength(3);
    const h = league.hallOfFame[0];
    const row = rows.find((r) => r.id === h?.playerId);
    expect(row).toMatchObject({ name: h?.name, year: league.season.year, seasons: h?.seasons, peak: h?.peakOverall });
    expect(row?.teams).toBe((h?.teams ?? []).map((t) => league.teams[t]?.abbr).join('/'));
    expect(latestClass(league)).toEqual({ year: league.season.year, count: league.hallOfFame.length });
    expect(latestClass(nextYearLeague())).toBeNull();
  });

  it('ranks the watch list by score and explains each score', () => {
    const rows = candidateRows(nextYearLeague());
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThanOrEqual(25);
    rows.slice(1).forEach((r, i) => expect(r.score).toBeLessThanOrEqual(rows[i]?.score ?? 0));
    for (const r of rows) {
      expect(r.progress).toBeCloseTo(r.score / r.threshold, 6);
      expect(['Eligible', 'Retired', 'Active']).toContain(r.status.text);
      expect(r.status.text === 'Active').toBe(!r.retired);
    }
    const b = rows[0]?.breakdown;
    if (!b) throw new Error('breakdown');
    const parts = breakdownParts(b);
    // 'preLeague' (SIMHUNT-8): founding veterans' estimated honours from before the league began.
    expect(parts.map((p) => p.id)).toEqual(['production', 'awards', 'allPro', 'championships', 'peak', 'longevity', 'preLeague', 'total']);
    expect(parts.slice(0, 7).reduce((s, p) => s + p.points, 0)).toBeCloseTo(b.total, 0);
    expect(breakdownText(b)).toMatch(/^Prod [\d.]+ \+ Awards .* = [\d.]+ of [\d.]+$/);
  });

  it('builds a career page from careerSummary', () => {
    const league = withHall();
    const id = league.hallOfFame[0]?.playerId;
    if (!id) throw new Error('inductee');
    const c = careerLines(league, id);
    if (!c) throw new Error('career');
    expect(c.subtitle).toContain(`class of ${league.season.year}`);
    expect(c.overview[0]).toMatchObject({ id: 'card', playerId: id });
    expect(c.overview.some((l) => l.teamId)).toBe(true);
    expect(c.stats.filter((l) => l.heading).map((l) => l.id)).toEqual(['h:reg', 'h:po', 'h:years']);
    const total = c.hof.find((l) => l.id === 'hof:total');
    expect(total?.bar?.value).toBeGreaterThan(0);
    expect(c.hof[c.hof.length - 1]?.id).toBe('hof:threshold');
    expect(careerLines(league, 'nobody' as typeof id)).toBeNull();
  });
});

describe('HallOfFameTab and CareerScreen', () => {
  it('starts on the watch list while the Hall is empty and opens the HOF score of a candidate', () => {
    const { fc, screen } = mount(nextYearLeague(), (c) => new HallOfFameTab(c));
    expect(screen.view).toBe('watch');
    expect(screen.watchTable?.sortKey).toBe('score');
    expect(screen.inducteeTable).toBeNull();
    render(fc);
    press(fc, 'confirm');
    const top = fc.stack.top;
    expect(top).toBeInstanceOf(CareerScreen);
    expect((top as CareerScreen).view).toBe('hof');
    expect((top as CareerScreen).summary().text).toContain('Prod');
  });

  it('lists inductees and walks a career page: player card, team, views, back', () => {
    const league = withHall();
    const { fc, screen } = mount(league, (c) => new HallOfFameTab(c));
    expect(screen.view).toBe('inductees');
    expect(screen.summary().text).toContain(`class of ${league.season.year}`);
    press(fc, 'confirm');
    const career = fc.stack.top as CareerScreen;
    expect(career).toBeInstanceOf(CareerScreen);
    press(fc, 'confirm');
    expect(fc.openedPlayers).toEqual([career.playerId]);
    const teamRow = career.table?.rows.findIndex((l) => l.teamId) ?? -1;
    career.table?.select(teamRow);
    press(fc, 'confirm');
    expect(fc.openedTeams).toHaveLength(1);
    press(fc, 'menuTabRight');
    expect(career.view).toBe('stats');
    press(fc, 'audible');
    expect(career.view).toBe('hof');
    render(fc);
    press(fc, 'back');
    expect(fc.stack.top).toBe(screen);
  });

  it('badges the Hall of Fame tab with a fresh class', () => {
    const tab = leagueTabs.find((t) => t.id === 'league-hof');
    expect(tab?.badge?.(withHall())).toBe(String(withHall().hallOfFame.length));
    expect(tab?.badge?.(nextYearLeague())).toBeNull();
  });
});
