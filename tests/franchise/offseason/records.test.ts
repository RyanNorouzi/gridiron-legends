import { describe, expect, it } from 'vitest';
import type { GameId, PlayerId, TeamId } from '@/core/ids';
import {
  FRANCHISE_TEAM_RECORD_KEYS, applyRecords, careerRecordCandidates, gameRecordCandidates, longestWinStreak, recordBook, recordsHeldBy,
  seasonEndRecords, seasonRecordCandidates, teamRecordCandidates,
} from '@/franchise/records';
import type { League, ScheduledGame } from '@/franchise/types';
import { emptyTeamStatLine } from '@/statistics/empty';
import { TEAM_RECORD_KEYS } from '@/statistics/records';
import type { PlayerStatLine } from '@/statistics/types';
import { atPhase, flatStandings, makeLeague, playedSeason, rostered, standing, statLine, teamIds } from './helpers';

const recordOf = (league: League, key: string) => league.records.find((r) => r.key === key);

const finishedGame = (id: string, home: TeamId, away: TeamId, homePts: number, awayPts: number, players: Record<PlayerId, PlayerStatLine>): ScheduledGame => ({
  id: id as GameId, week: 1, home, away, isPlayoff: false, playoffRound: null, isPreseason: false,
  result: {
    homeScore: homePts, awayScore: awayPts, overtime: false, playLogId: null, injuries: [],
    stats: { players, teams: { home: { ...emptyTeamStatLine(), points: homePts }, away: { ...emptyTeamStatLine(), points: awayPts } } },
    weather: { type: 'clear', windDir: 0, windMph: 0, temperatureF: 68, precipitation: 0, visibility: 1, fieldSlick: 0 },
  },
});

describe('record candidates', () => {
  it('breaks and persists a season record, keeps it on re-application, replaces it when beaten', () => {
    const base = makeLeague(31);
    const [t1, t2] = teamIds(base) as [TeamId, TeamId];
    const qb = rostered(base, t1, 'QB');
    const other = rostered(base, t2, 'QB');
    const league = atPhase(base, 'awards', { stats: { [qb.id]: statLine({ passing: { yards: 5000, touchdowns: 40 } }) } });
    const first = applyRecords(league, seasonRecordCandidates(league));
    const rec = recordOf(first.league, 'passingYards.season');
    expect(rec?.value).toBe(5000);
    expect(rec?.holderPlayerId).toBe(qb.id);
    expect(rec?.holderName).toBe(`${qb.firstName} ${qb.lastName}`);
    expect(first.broken.some((b) => b.record.key === 'passingYards.season' && b.previous === null)).toBe(true);
    const again = applyRecords(first.league, seasonRecordCandidates(first.league));
    expect(again.broken).toEqual([]);
    expect(again.league).toBe(first.league);
    const better = { ...first.league, season: { ...first.league.season, stats: { [other.id]: statLine({ passing: { yards: 5100 } }) } } };
    const beaten = applyRecords(better, seasonRecordCandidates(better));
    const b = beaten.broken.find((x) => x.record.key === 'passingYards.season');
    expect(b?.previous?.holderPlayerId).toBe(qb.id);
    expect(recordOf(beaten.league, 'passingYards.season')?.holderPlayerId).toBe(other.id);
    expect(recordsHeldBy(beaten.league, other.id).map((r) => r.key)).toContain('passingYards.season');
  });

  it('builds single-game candidates from game results (player lines and team points)', () => {
    const base = makeLeague(32);
    const [t1, t2] = teamIds(base) as [TeamId, TeamId];
    const rb = rostered(base, t1, 'RB');
    const game = finishedGame('g_rec_1', t1, t2, 63, 10, { [rb.id]: statLine({ gamesPlayed: 1, rushing: { attempts: 30, yards: 290, touchdowns: 5, longest: 88 } }) });
    const preseason = { ...finishedGame('g_rec_2', t2, t1, 90, 0, {}), isPreseason: true };
    const league = atPhase(base, 'regularSeason', { schedule: [game, preseason] });
    const { league: out } = applyRecords(league, gameRecordCandidates(league));
    expect(recordOf(out, 'rushingYards.game')?.value).toBe(290);
    expect(recordOf(out, 'longestPlay.game')?.value).toBe(88);
    expect(recordOf(out, TEAM_RECORD_KEYS.pointsGame)).toMatchObject({ value: 63, holderTeamId: t1 });
  });

  it('adds the current, uncommitted season to career totals', () => {
    const base = makeLeague(33);
    const wr = rostered(base, teamIds(base)[0]!, 'WR');
    const year = base.season.year;
    const careerStats = { ...base.careerStats, [wr.id]: { playerId: wr.id, seasons: [{ playerId: wr.id, teamId: wr.teamId, year: year - 1, line: statLine({ receiving: { yards: 1000 } }), playoffLine: null }], totals: statLine({ receiving: { yards: 1000 } }) } };
    const league = atPhase({ ...base, careerStats }, 'awards', { stats: { [wr.id]: statLine({ receiving: { yards: 900 } }) } });
    const cand = careerRecordCandidates(league).find((c) => c.playerId === wr.id);
    expect(cand?.line?.receiving.yards).toBe(1900);
  });

  it('builds team records: season points and wins, longest streak, championships, fewest points once complete', () => {
    const base = makeLeague(34);
    const [t1] = teamIds(base) as [TeamId];
    const results: ('W' | 'L')[] = ['W', 'W', 'L', 'W', 'W', 'W', 'W', 'W', 'L', 'W', 'W', 'W', 'L', 'W', 'W', 'L', 'W'];
    const standings = { ...flatStandings(base), [t1]: standing(t1, 13, 4, results) };
    const teams = { ...base.teams, [t1]: { ...base.teams[t1]!, championships: 4 } };
    const league = atPhase({ ...base, teams }, 'awards', { standings });
    expect(longestWinStreak(results)).toBe(5);
    const cands = teamRecordCandidates(league);
    const mine = cands.find((c) => c.teamId === t1);
    expect(mine?.values?.[FRANCHISE_TEAM_RECORD_KEYS.winsSeason]).toBe(13);
    expect(mine?.values?.[TEAM_RECORD_KEYS.winStreak]).toBe(5);
    expect(mine?.values?.[TEAM_RECORD_KEYS.championships]).toBe(4);
    // The schedule is unplayed, so the fewest-points mark is not offered yet.
    expect(mine?.values?.[FRANCHISE_TEAM_RECORD_KEYS.fewestPointsAllowed]).toBeUndefined();
    const { league: out } = applyRecords(league, cands);
    expect(recordOf(out, FRANCHISE_TEAM_RECORD_KEYS.winsSeason)?.holderTeamId).toBe(t1);
    expect(recordBook(out, 'team').map((r) => r.key)).toEqual([
      TEAM_RECORD_KEYS.pointsGame, TEAM_RECORD_KEYS.winStreak, TEAM_RECORD_KEYS.championships, FRANCHISE_TEAM_RECORD_KEYS.pointsSeason,
      FRANCHISE_TEAM_RECORD_KEYS.winsSeason,
    ].filter((k) => out.records.some((r) => r.key === k)));
  });
});

describe('seasonEndRecords', () => {
  it('sets every scope after a simulated season and is a no-op the second time', () => {
    const league = playedSeason(7);
    const first = seasonEndRecords(league);
    const scopes = new Set(first.league.records.map((r) => r.scope));
    expect([...scopes].sort()).toEqual(['career', 'game', 'season', 'team']);
    expect(recordOf(first.league, FRANCHISE_TEAM_RECORD_KEYS.fewestPointsAllowed)).toBeDefined();
    const second = seasonEndRecords(first.league);
    expect(second.broken).toEqual([]);
    expect(second.league.records).toEqual(first.league.records);
  });
});
