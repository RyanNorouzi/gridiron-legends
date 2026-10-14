import { describe, expect, it } from 'vitest';
import type { PlayerId, TeamId } from '@/core/ids';
import type { LeagueRecord } from '@/franchise/types';
import { emptyPlayerStatLine } from '@/statistics/empty';
import {
  RECORD_DEFINITIONS, TEAM_RECORD_KEYS, candidatesFromStats, checkRecords, longestPlay, recordDefinition, recordValue, totalTouchdowns,
} from '@/statistics/records';
import type { RecordCandidate } from '@/statistics/records';
import type { PlayerStatLine } from '@/statistics/types';

const pid = (s: string): PlayerId => s as PlayerId;
const tid = (s: string): TeamId => s as TeamId;

const lineWith = (fill: (l: PlayerStatLine) => void): PlayerStatLine => {
  const l = emptyPlayerStatLine();
  fill(l);
  return l;
};

describe('RECORD_DEFINITIONS', () => {
  it('covers the spec list at every scope with unique keys', () => {
    const keys = RECORD_DEFINITIONS.map((d) => d.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const base of ['passingYards', 'passingTds', 'rushingYards', 'rushingTds', 'receivingYards', 'receptions', 'interceptions', 'sacks', 'tackles', 'fgLong', 'longestPlay']) {
      for (const scope of ['game', 'season', 'career']) expect(keys).toContain(`${base}.${scope}`);
    }
    expect(keys).toContain(TEAM_RECORD_KEYS.pointsGame);
    expect(keys).toContain(TEAM_RECORD_KEYS.winStreak);
    expect(keys).toContain(TEAM_RECORD_KEYS.championships);
    expect(recordDefinition('sacks.season')?.scope).toBe('season');
    expect(recordDefinition('team.winStreak')?.scope).toBe('team');
    expect(recordDefinition('nope')).toBeUndefined();
    expect(RECORD_DEFINITIONS.every((d) => d.higherIsBetter)).toBe(true);
  });

  it('tracks receiving and total touchdowns (rushing + receiving + returns + defense, never passing)', () => {
    const keys = RECORD_DEFINITIONS.map((d) => d.key);
    for (const scope of ['game', 'season', 'career']) {
      expect(keys).toContain(`receivingTds.${scope}`);
      expect(keys).toContain(`totalTds.${scope}`);
    }
    const line = lineWith((l) => { l.rushing.touchdowns = 2; l.receiving.touchdowns = 1; l.returns.returnTouchdowns = 1; l.defense.touchdowns = 1; l.passing.touchdowns = 4; });
    expect(totalTouchdowns(line)).toBe(5);
    expect(recordValue(recordDefinition('totalTds.game')!, { scope: 'game', name: 'X', year: 2026, line })).toBe(5);
    expect(recordValue(recordDefinition('receivingTds.game')!, { scope: 'game', name: 'X', year: 2026, line })).toBe(1);
  });

  it('longestPlay spans passing, rushing, receiving and returns', () => {
    expect(longestPlay(lineWith((l) => { l.rushing.longest = 30; l.returns.longest = 88; l.passing.longest = 40; }))).toBe(88);
    expect(longestPlay(emptyPlayerStatLine())).toBe(0);
  });

  it('recordValue prefers explicit values, then extractor/path, else null', () => {
    const def = recordDefinition('passingYards.game')!;
    const line = lineWith((l) => { l.passing.yards = 310; });
    expect(recordValue(def, { scope: 'game', name: 'A', year: 1, line })).toBe(310);
    expect(recordValue(def, { scope: 'game', name: 'A', year: 1, line, values: { 'passingYards.game': 400 } })).toBe(400);
    expect(recordValue(def, { scope: 'game', name: 'A', year: 1 })).toBeNull();
    expect(recordValue(def, { scope: 'game', name: 'A', year: 1, values: { 'passingYards.game': Number.NaN } })).toBeNull();
  });
});

describe('checkRecords', () => {
  const qbGame = (yards: number, name: string, year: number): RecordCandidate => ({
    scope: 'game', playerId: pid(name), teamId: tid('T1'), name, year, line: lineWith((l) => { l.passing.yards = yards; }),
  });

  it('establishes first-time records for non-zero values only', () => {
    const { updated, broken } = checkRecords([], [qbGame(320, 'Ada', 2026)]);
    expect(broken).toHaveLength(1);
    expect(broken[0]?.previous).toBeNull();
    expect(broken[0]?.record).toMatchObject({ key: 'passingYards.game', value: 320, holderPlayerId: 'Ada', holderTeamId: 'T1', holderName: 'Ada', year: 2026, scope: 'game' });
    expect(updated).toHaveLength(1);
    // A zero stat line (e.g. an OL with 0 passing yards) never becomes a record.
    const zero = checkRecords([], [{ scope: 'game', name: 'Nobody', year: 2026, line: emptyPlayerStatLine() }]);
    expect(zero.updated).toHaveLength(0);
    expect(zero.broken).toHaveLength(0);
  });

  it('updates only when strictly beaten and keeps the holder on ties', () => {
    const existing: LeagueRecord = {
      key: 'passingYards.game', label: 'Passing Yards (Game)', scope: 'game', value: 400,
      holderPlayerId: pid('Old'), holderTeamId: null, holderName: 'Old', year: 2020,
    };
    const worse = checkRecords([existing], [qbGame(399, 'New', 2026)]);
    expect(worse.broken).toHaveLength(0);
    expect(worse.updated).toEqual([existing]);
    const tie = checkRecords([existing], [qbGame(400, 'New', 2026)]);
    expect(tie.broken).toHaveLength(0);
    expect(tie.updated[0]?.holderName).toBe('Old');
    const better = checkRecords([existing], [qbGame(401, 'New', 2026)]);
    expect(better.broken).toHaveLength(1);
    expect(better.broken[0]?.previous).toBe(existing);
    expect(better.broken[0]?.record.holderName).toBe('New');
    expect(better.updated[0]?.value).toBe(401);
    expect(better.updated).toHaveLength(1);
  });

  it('is pure and preserves the order of existing records', () => {
    const r1: LeagueRecord = { key: 'sacks.season', label: 'Sacks (Season)', scope: 'season', value: 10, holderPlayerId: pid('a'), holderTeamId: null, holderName: 'a', year: 2020 };
    const r2: LeagueRecord = { key: 'tackles.season', label: 'Tackles (Season)', scope: 'season', value: 100, holderPlayerId: pid('b'), holderTeamId: null, holderName: 'b', year: 2020 };
    const records = [r1, r2];
    const snapshot = JSON.stringify(records);
    const cand: RecordCandidate = { scope: 'season', playerId: pid('c'), name: 'c', year: 2026, line: lineWith((l) => { l.defense.tackles = 150; l.defense.interceptions = 5; }) };
    const res = checkRecords(records, [cand]);
    expect(JSON.stringify(records)).toBe(snapshot);
    expect(res.updated.map((r) => r.key)).toEqual(['sacks.season', 'tackles.season', 'interceptions.season']);
    expect(res.updated[1]?.value).toBe(150);
    expect(res.broken.map((b) => b.record.key).sort()).toEqual(['interceptions.season', 'tackles.season']);
  });

  it('picks the best of several candidates in one call (earlier wins on equal values)', () => {
    const res = checkRecords([], [qbGame(300, 'B', 2026), qbGame(350, 'C', 2026), qbGame(350, 'D', 2026), qbGame(200, 'E', 2026)]);
    expect(res.broken).toHaveLength(1);
    expect(res.broken[0]?.record.holderName).toBe('C');
    expect(res.broken[0]?.record.value).toBe(350);
  });

  it('only matches candidates of the definition scope', () => {
    const seasonCand: RecordCandidate = { scope: 'season', playerId: pid('s'), name: 's', year: 2026, line: lineWith((l) => { l.passing.yards = 5000; }) };
    const res = checkRecords([], [seasonCand]);
    expect(res.updated.map((r) => r.key)).toContain('passingYards.season');
    expect(res.updated.map((r) => r.key)).not.toContain('passingYards.game');
    expect(res.updated.map((r) => r.key)).not.toContain('passingYards.career');
  });

  it('handles team records through explicit values', () => {
    const team: RecordCandidate = { scope: 'team', teamId: tid('HOU'), name: 'Houston Comets', year: 2026, values: { [TEAM_RECORD_KEYS.pointsGame]: 52, [TEAM_RECORD_KEYS.winStreak]: 9, [TEAM_RECORD_KEYS.championships]: 0 } };
    const res = checkRecords([], [team]);
    expect(res.updated.map((r) => r.key).sort()).toEqual([TEAM_RECORD_KEYS.pointsGame, TEAM_RECORD_KEYS.winStreak].sort());
    expect(res.updated.find((r) => r.key === TEAM_RECORD_KEYS.pointsGame)).toMatchObject({ value: 52, holderTeamId: 'HOU', holderPlayerId: null, holderName: 'Houston Comets' });
    const later = checkRecords(res.updated, [{ ...team, year: 2027, values: { [TEAM_RECORD_KEYS.championships]: 1, [TEAM_RECORD_KEYS.winStreak]: 9 } }]);
    expect(later.broken.map((b) => b.record.key)).toEqual([TEAM_RECORD_KEYS.championships]);
    expect(later.updated).toHaveLength(3);
  });

  it('candidatesFromStats builds one candidate per player with names and teams', () => {
    const stats: Record<PlayerId, PlayerStatLine> = {
      [pid('p1')]: lineWith((l) => { l.rushing.yards = 1500; }),
      [pid('p2')]: lineWith((l) => { l.rushing.yards = 900; }),
    };
    const cands = candidatesFromStats('season', stats, 2026, (id) => `Name ${id}`, (id) => (id === 'p1' ? tid('A') : null));
    expect(cands).toHaveLength(2);
    expect(cands[0]).toMatchObject({ scope: 'season', playerId: 'p1', teamId: 'A', name: 'Name p1', year: 2026 });
    expect(cands[1]?.teamId).toBeUndefined();
    const res = checkRecords([], cands);
    expect(res.updated.find((r) => r.key === 'rushingYards.season')?.holderPlayerId).toBe('p1');
  });
});
