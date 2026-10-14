import { describe, expect, it } from 'vitest';
import { compactLeagueStatLines, compactStatLine, expandLeagueStatLines, expandStatLine } from '@/statistics/compact';
import { emptyPlayerStatLine } from '@/statistics/empty';
import type { PlayerStatLine } from '@/statistics/types';

const qbLine = (): PlayerStatLine => {
  const l = emptyPlayerStatLine();
  l.passing.attempts = 31;
  l.passing.completions = 20;
  l.passing.yards = 245.5;
  l.rushing.yards = -3;
  l.gamesPlayed = 1;
  l.epa = 4.25;
  return l;
};

describe('compact stat lines', () => {
  it('keeps only non-zero fields and drops all-zero buckets', () => {
    expect(compactStatLine(qbLine())).toEqual({
      passing: { attempts: 31, completions: 20, yards: 245.5 }, rushing: { yards: -3 }, gamesPlayed: 1, epa: 4.25,
    });
    expect(compactStatLine(emptyPlayerStatLine())).toEqual({});
  });

  it('expands back to the exact full line', () => {
    expect(expandStatLine(compactStatLine(qbLine()))).toEqual(qbLine());
    expect(expandStatLine({})).toEqual(emptyPlayerStatLine());
    // A full line expands to itself.
    expect(expandStatLine(qbLine())).toEqual(qbLine());
  });

  it('compacts and expands every stat line of raw league JSON without touching anything else', () => {
    const line = qbLine();
    const raw = {
      version: 1,
      season: {
        stats: { p1: line }, playoffStats: {}, teamStats: { t1: { points: 0, sacks: 3 } },
        schedule: [
          { id: 'g1', result: { stats: { players: { p1: line }, teams: { home: { points: 0 }, away: { points: 7 } } } } },
          { id: 'g2', result: null },
        ],
      },
      careerStats: { p1: { playerId: 'p1', seasons: [{ year: 2026, line, playoffLine: null }], totals: line } },
      hallOfFame: [{ playerId: 'p1', careerStats: line, seasons: 0 }],
      players: { p1: { attrs: { speed: 0 } } },
    };
    const snapshot = JSON.parse(JSON.stringify(raw)) as unknown;
    const compact = compactLeagueStatLines(raw);
    expect(raw).toEqual(snapshot);
    const c = compact as unknown as typeof raw;
    expect(c.season.stats.p1).toEqual(compactStatLine(line));
    expect(c.season.schedule[0]!.result!.stats.players.p1).toEqual(compactStatLine(line));
    expect(c.season.schedule[0]!.result!.stats.teams).toEqual(raw.season.schedule[0]!.result!.stats.teams);
    expect(c.season.teamStats).toEqual(raw.season.teamStats);
    expect(c.careerStats.p1.seasons[0]!.playoffLine).toBeNull();
    expect(c.careerStats.p1.totals).toEqual(compactStatLine(line));
    expect(c.hallOfFame[0]!.careerStats).toEqual(compactStatLine(line));
    expect(c.players).toEqual(raw.players);
    expect(expandLeagueStatLines(compact)).toEqual(raw);
  });
});
