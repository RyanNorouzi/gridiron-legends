import { describe, expect, it } from 'vitest';
import { createGameState } from '@/game/game-state';
import { outcomeAt } from '@/game/outcome-factory';
import type { PlayLogEntry } from '@/game/types';
import { applyDeltas, delta } from '@/statistics/apply';
import { buildPostGame, playLogLines, scoringSummary, sideLeaders, teamStatRows } from '@/ui/game/box-score';
import { teamGameSummary } from '@/statistics/aggregate';
import { makeSetup, pid } from '../../game/fixtures';

const synthetic = () => {
  const setup = makeSetup();
  const state = createGameState(setup);
  const qb = pid('p_home_QB1');
  const rb = pid('p_home_RB1');
  const wr = pid('p_home_WR1');
  const wr2 = pid('p_home_WR2');
  const lb = pid('p_away_MLB1');
  const k = pid('p_home_K1');
  applyDeltas(state.stats, [
    delta(qb, 'passing.attempts', 27), delta(qb, 'passing.completions', 18), delta(qb, 'passing.yards', 231), delta(qb, 'passing.touchdowns', 2),
    delta(rb, 'rushing.attempts', 16), delta(rb, 'rushing.yards', 88), delta(rb, 'rushing.longest', 22), delta(rb, 'rushing.touchdowns', 1),
    delta(wr, 'receiving.targets', 9), delta(wr, 'receiving.receptions', 7), delta(wr, 'receiving.yards', 120), delta(wr, 'receiving.touchdowns', 1),
    delta(wr2, 'receiving.targets', 4), delta(wr2, 'receiving.receptions', 2), delta(wr2, 'receiving.yards', 40),
    delta(lb, 'defense.tackles', 9), delta(lb, 'defense.sacks', 1), delta(lb, 'defense.interceptions', 1),
    delta(k, 'kicking.fgAttempts', 2), delta(k, 'kicking.fgMade', 1), delta(k, 'kicking.fgLong', 44), delta(k, 'kicking.xpAttempts', 3), delta(k, 'kicking.xpMade', 3),
  ]);
  state.stats.teams.home.points = 24;
  state.stats.teams.home.totalYards = 319;
  state.stats.teams.home.passYards = 231;
  state.stats.teams.home.rushYards = 88;
  state.stats.teams.home.plays = 50;
  state.stats.teams.home.thirdDownAttempts = 10;
  state.stats.teams.home.thirdDownConversions = 5;
  state.stats.teams.home.timeOfPossessionSec = 1800;
  state.stats.teams.away.points = 17;
  state.stats.teams.away.plays = 40;
  state.stats.teams.away.totalYards = 260;
  state.stats.teams.away.pointsAgainst = 24;
  state.score = { home: 24, away: 17 };
  state.phase = 'final';
  const entry = (index: number, partial: Partial<PlayLogEntry> & { points?: number; side?: 'home' | 'away' }): PlayLogEntry => {
    const side = partial.side ?? 'home';
    const points = partial.points ?? 0;
    const outcome = { ...outcomeAt(40, { result: 'pass', yards: 12, timeElapsed: 6, touchdown: points === 6, ballCarrierId: rb, passerId: qb, receiverId: wr }, side), points, scoringSide: points > 0 ? side : null };
    return { index, quarter: partial.quarter ?? 1, clock: partial.clock ?? 500, possession: side, down: 2, distance: 7, ballOn: 40, ballX: 26, offensivePlayId: 'pass-curl', defensivePlayId: 'cover3', outcome, scoreAfter: partial.scoreAfter ?? { home: 0, away: 0 }, review: null };
  };
  state.playLog.push(entry(0, {}), entry(1, { points: 6, scoreAfter: { home: 6, away: 0 } }), entry(2, { points: 3, side: 'away', quarter: 2, clock: 61, scoreAfter: { home: 6, away: 3 } }));
  return { setup, state, qb, rb, wr, lb, k };
};

describe('box score', () => {
  it('builds team rows from the summaries', () => {
    const { state } = synthetic();
    const s = teamGameSummary(state.stats);
    const rows = teamStatRows(s.home, s.away);
    const row = (label: string) => rows.find((r) => r.label === label)!;
    expect(row('TOTAL YARDS')).toEqual({ label: 'TOTAL YARDS', home: '319', away: '260' });
    expect(row('3RD DOWN').home).toBe('50%');
    expect(row('POSSESSION').home).toBe('30:00');
    expect(row('YDS / PLAY').home).toBe('6.4');
  });

  it('shows whole penalty yards (half-the-distance enforcement leaves fractions)', () => {
    const { state } = synthetic();
    const s = teamGameSummary(state.stats);
    const rows = teamStatRows({ ...s.home, penalties: 6, penaltyYards: 59.5 }, { ...s.away, penalties: 1, penaltyYards: 4.5 });
    expect(rows.find((r) => r.label === 'PENALTIES')).toMatchObject({ home: '6-60', away: '1-5' });
  });

  it('shows a rate over zero attempts as "-" rather than 0%', () => {
    const { state } = synthetic();
    const s = teamGameSummary(state.stats);
    const none = { ...s.home, thirdDownAttempts: 0, thirdDownPct: 0, fourthDownAttempts: 0, fourthDownPct: 0, redZoneTrips: 0, redZonePct: 0 };
    const rows = teamStatRows(none, s.away);
    for (const label of ['3RD DOWN', '4TH DOWN', 'RED ZONE']) expect(rows.find((r) => r.label === label)?.home).toBe('-');
    expect(teamStatRows(s.home, none).find((r) => r.label === '3RD DOWN')?.home).toBe('50%');
  });

  it('ranks leaders per side with names and compact lines', () => {
    const { setup, state, qb, rb, wr, lb, k } = synthetic();
    const home = sideLeaders(state.stats.players, setup.home.players, 3);
    expect(home.passing[0]?.playerId).toBe(qb);
    expect(home.passing[0]?.line).toContain('18/27');
    expect(home.passing[0]?.line).toContain('2 TD');
    expect(home.passing).toHaveLength(1);
    expect(home.rushing[0]?.playerId).toBe(rb);
    expect(home.rushing[0]?.line).toContain('LG 22');
    expect(home.receiving.map((r) => r.playerId)).toEqual([wr, pid('p_home_WR2')]);
    expect(home.receiving[0]?.name).toBe('W. HOME');
    expect(home.kicking[0]?.playerId).toBe(k);
    expect(home.kicking[0]?.line).toContain('FG 1/2');
    expect(home.defense).toHaveLength(0);
    const away = sideLeaders(state.stats.players, setup.away.players, 3);
    expect(away.defense[0]?.playerId).toBe(lb);
    expect(away.defense[0]?.line).toContain('1 INT');
    expect(away.passing).toHaveLength(0);
  });

  it('lists scoring plays with the running score and play-log lines', () => {
    const { setup, state } = synthetic();
    const scoring = scoringSummary(state.playLog);
    expect(scoring).toHaveLength(2);
    expect(scoring[0]).toMatchObject({ quarter: 1, side: 'home', score: { home: 6, away: 0 } });
    expect(scoring[0]?.text).toContain('PASSING TD');
    expect(scoring[1]?.clock).toBe('1:01');
    const lines = playLogLines(setup, state.playLog);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/^Q1 8:20 /);
    expect(lines[0]).toContain('complete to');
  });

  it('assembles the post-game data with the winner', () => {
    const { setup, state } = synthetic();
    const data = buildPostGame(setup, state);
    expect(data.winner).toBe('home');
    expect(data.abbr).toEqual({ home: 'HAR', away: 'RDG' });
    expect(data.names.home).toBe('Harbor City Anchors');
    expect(data.teamRows.length).toBeGreaterThan(10);
    expect(data.leaders.home.passing[0]?.value).toBe(231);
    expect(data.scoring).toHaveLength(2);
    expect(data.playLog).toHaveLength(3);
    expect(data.overtime).toBe(false);
    state.score = { home: 17, away: 17 };
    expect(buildPostGame(setup, state).winner).toBeNull();
  });
});
