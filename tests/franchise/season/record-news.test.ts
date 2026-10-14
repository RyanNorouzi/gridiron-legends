import { describe, expect, it } from 'vitest';
import type { PlayerId, TeamId } from '@/core/ids';
import { CAREER_RECORD_NEWS_MIN_SEASONS, checkWeekRecords, isRecordNews } from '@/franchise/history';
import { injuryOutlook, seasonWeeksAfter } from '@/franchise/news-items';
import { scheduleWeekCount, playoffRoundCount } from '@/franchise/settings';
import type { LeagueRecord, SeasonSummary } from '@/franchise/types';
import { emptyPlayerStatLine } from '@/statistics/empty';
import { makeLeague } from './helpers';

const YEAR = 2030;
const rec = (over: Partial<LeagueRecord> = {}): LeagueRecord => ({
  key: 'passingYards.season', label: 'Passing Yards (Season)', scope: 'season', value: 5000,
  holderPlayerId: 'p_a' as PlayerId, holderTeamId: 't_a' as TeamId, holderName: 'A', year: YEAR, ...over,
});
const summary = (year: number): SeasonSummary => ({ year, champion: 't_a' as TeamId, runnerUp: 't_b' as TeamId, mvp: null, standings: {}, awards: [] });
const hist = (...years: number[]) => ({ history: years.map(summary) });
const byB = { holderPlayerId: 'p_b' as PlayerId, holderTeamId: 't_b' as TeamId, holderName: 'B' };

describe('isRecordNews', () => {
  it('stays silent in a league\'s first season: the book only holds this season\'s running bests', () => {
    const first = hist();
    expect(isRecordNews(first, { record: rec(), previous: null })).toBe(false);
    expect(isRecordNews(first, { record: rec(byB), previous: rec({ value: 4000 }) })).toBe(false);
    for (const scope of ['game', 'team', 'career'] as const) {
      expect(isRecordNews(first, { record: rec({ ...byB, scope }), previous: rec({ scope, value: 1 }) })).toBe(false);
    }
  });

  it('reports a mark from an earlier season being beaten, and a new single-game feat once the book is established', () => {
    const later = hist(YEAR - 1);
    expect(isRecordNews(later, { record: rec({ value: 5100 }), previous: rec({ year: YEAR - 1 }) })).toBe(true);
    // Two players trading the season mark back and forth: only the break of the standing mark is news.
    expect(isRecordNews(later, { record: rec({ ...byB, value: 5200 }), previous: rec({ value: 5100 }) })).toBe(false);
    const game = { key: 'rushingYards.game', label: 'Rushing Yards (Game)', scope: 'game' as const };
    expect(isRecordNews(later, { record: rec({ ...game, ...byB, value: 260 }), previous: rec({ ...game, value: 250 }) })).toBe(true);
    // The holder raising his own mark week after week is a book update, not news, even after a trade.
    expect(isRecordNews(later, { record: rec({ value: 5300, holderTeamId: 't_z' as TeamId }), previous: rec({ value: 5200 }) })).toBe(false);
    // Nothing beaten: a first holder is never news.
    expect(isRecordNews(later, { record: rec(), previous: null })).toBe(false);
  });

  it('headlines a single-play mark (longest play, longest field goal) once, at game scope, not again as season and career marks', () => {
    const later = hist(YEAR - 1, YEAR - 2, YEAR - 3);
    for (const base of ['longestPlay', 'fgLong']) {
      const at = (scope: 'game' | 'season' | 'career') => ({ key: `${base}.${scope}`, label: base, scope });
      const news = (scope: 'game' | 'season' | 'career') => isRecordNews(later, { record: rec({ ...at(scope), ...byB, value: 99 }), previous: rec({ ...at(scope), value: 98, year: YEAR - 1 }) });
      expect([news('game'), news('season'), news('career')]).toEqual([true, false, false]);
    }
    // Accumulated marks keep their season headline.
    expect(isRecordNews(later, { record: rec({ ...byB, value: 5100 }), previous: rec({ year: YEAR - 1 }) })).toBe(true);
  });

  it('reports career records only when another player passes the holder in a long enough league era', () => {
    const career = { key: 'passingYards.career', label: 'Passing Yards (Career)', scope: 'career' as const };
    const short = hist(...Array.from({ length: CAREER_RECORD_NEWS_MIN_SEASONS - 2 }, (_, i) => YEAR - 1 - i));
    const long = hist(...Array.from({ length: CAREER_RECORD_NEWS_MIN_SEASONS - 1 }, (_, i) => YEAR - 1 - i));
    const passed = { record: rec({ ...career, ...byB, value: 9000 }), previous: rec({ ...career, value: 8900, year: YEAR - 1 }) };
    expect(isRecordNews(short, passed)).toBe(false);
    expect(isRecordNews(long, passed)).toBe(true);
    // Extending his own career mark (traded or not) is not news; nor is re-passing a mark set earlier this season.
    expect(isRecordNews(long, { record: rec({ ...career, value: 9100, holderTeamId: 't_z' as TeamId }), previous: rec({ ...career, value: 8900, year: YEAR - 1 }) })).toBe(false);
    expect(isRecordNews(long, { record: rec({ ...career, value: 9200 }), previous: rec({ ...career, ...byB, value: 9000 }) })).toBe(false);
  });
});

describe('checkWeekRecords', () => {
  it('keeps the career book current mid-season: committed totals plus the season so far', () => {
    const base = makeLeague(31);
    const [id, other] = Object.keys(base.players) as [PlayerId, PlayerId];
    const year = base.season.year;
    const line = (yards: number) => ({ ...emptyPlayerStatLine(), gamesPlayed: 1, passing: { ...emptyPlayerStatLine().passing, yards } });
    const league = {
      ...base,
      careerStats: { ...base.careerStats, [id]: { playerId: id, seasons: [{ playerId: id, teamId: null, year: year - 1, line: line(4000), playoffLine: null }], totals: line(4000) } },
      season: { ...base.season, stats: { [id]: line(1500), [other]: line(4800) } },
    };
    const r = checkWeekRecords(league, []);
    expect(r.league.records.find((x) => x.key === 'passingYards.career')).toMatchObject({ holderPlayerId: id, value: 5500 });
    expect(r.league.records.find((x) => x.key === 'passingYards.season')).toMatchObject({ holderPlayerId: other, value: 4800 });
  });
});

describe('injury outlook', () => {
  const settings = makeLeague(31).settings;
  const regular = scheduleWeekCount(settings);
  const rounds = playoffRoundCount(settings);

  it('counts the weeks the season has left after a game', () => {
    expect(seasonWeeksAfter(settings, { isPreseason: false, isPlayoff: false, week: 1, playoffRound: null })).toBe(regular - 1 + rounds);
    expect(seasonWeeksAfter(settings, { isPreseason: false, isPlayoff: false, week: regular, playoffRound: null })).toBe(rounds);
    expect(seasonWeeksAfter(settings, { isPreseason: false, isPlayoff: true, week: rounds, playoffRound: rounds })).toBe(0);
    expect(seasonWeeksAfter(settings, { isPreseason: true, isPlayoff: false, week: 1, playoffRound: null })).toBe(settings.preseasonWeeks - 1 + regular + rounds);
  });

  it('words knocks, multi-week, season-long and career-threatening injuries', () => {
    expect(injuryOutlook(0, 'minor', 10)).toEqual({ kind: 'dayToDay', short: 'day-to-day' });
    expect(injuryOutlook(1, 'minor', 10).short).toBe('out 1 wk');
    expect(injuryOutlook(3, 'short', 10).short).toBe('out 3 wks');
    expect(injuryOutlook(38, 'seasonEnding', 10).short).toBe('out for the season');
    expect(injuryOutlook(8, 'moderate', 5).kind).toBe('season');
    expect(injuryOutlook(8, 'moderate', null).short).toBe('out 8 wks');
    expect(injuryOutlook(30, 'careerThreatening', 10).short).toBe('career-threatening');
  });
});
