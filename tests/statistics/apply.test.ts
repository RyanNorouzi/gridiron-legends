import { describe, expect, it } from 'vitest';
import { createRng } from '@/core/rng';
import type { PlayerId } from '@/core/ids';
import {
  MAX_STAT_PATHS, STAT_PATHS, applyDelta, applyDeltas, delta, isMaxStat, isStatPath, mergeTeamStats, readStat,
} from '@/statistics/apply';
import { emptyGameStats, emptyPlayerStatLine, emptyTeamStatLine } from '@/statistics/empty';
import type { PlayStatDelta, StatPath } from '@/statistics/types';

const pid = (s: string): PlayerId => s as PlayerId;

describe('applyDelta', () => {
  it('sums ordinary counting stats', () => {
    const line = emptyPlayerStatLine();
    applyDelta(line, 'passing.attempts', 1);
    applyDelta(line, 'passing.attempts', 1);
    applyDelta(line, 'passing.yards', 12);
    applyDelta(line, 'passing.yards', -3);
    applyDelta(line, 'snaps', 5);
    applyDelta(line, 'epa', 0.75);
    applyDelta(line, 'epa', -0.25);
    expect(line.passing.attempts).toBe(2);
    expect(line.passing.yards).toBe(9);
    expect(line.snaps).toBe(5);
    expect(line.epa).toBeCloseTo(0.5, 10);
  });

  it('keeps the max for every longest-style path and never lowers it', () => {
    const maxPaths: StatPath[] = ['passing.longest', 'rushing.longest', 'receiving.longest', 'returns.longest', 'kicking.fgLong', 'kicking.puntLong'];
    expect([...MAX_STAT_PATHS].sort()).toEqual([...maxPaths].sort());
    for (const path of maxPaths) {
      const line = emptyPlayerStatLine();
      applyDelta(line, path, 15);
      applyDelta(line, path, 40);
      applyDelta(line, path, 22);
      expect(readStat(line, path)).toBe(40);
      expect(isMaxStat(path)).toBe(true);
    }
    expect(isMaxStat('passing.yards')).toBe(false);
    expect(isMaxStat('rushing.attempts')).toBe(false);
  });

  it('MAX_STAT_PATHS matches the documented suffix rule over every existing path (no drift)', () => {
    for (const path of STAT_PATHS) {
      const leaf = path.includes('.') ? path.slice(path.indexOf('.') + 1) : path;
      const byRule = leaf === 'longest' || (leaf.endsWith('Long') && leaf !== 'Long');
      expect(isMaxStat(path)).toBe(byRule);
    }
    // Summing stats that merely contain "long" elsewhere are not max stats.
    expect(isMaxStat('kicking.puntYards')).toBe(false);
  });

  it('rejects unknown paths and non-finite values with descriptive errors', () => {
    const line = emptyPlayerStatLine();
    expect(() => applyDelta(line, 'passing.bogus' as StatPath, 1)).toThrow(/unknown stat path/);
    expect(() => applyDelta(line, 'nope' as StatPath, 1)).toThrow(/unknown stat path/);
    expect(() => applyDelta(line, 'bogus.yards' as StatPath, 1)).toThrow(/unknown stat category/);
    expect(() => applyDelta(line, 'passing.yards', Number.NaN)).toThrow(/non-finite/);
    expect(() => applyDelta(line, 'passing.yards', Number.POSITIVE_INFINITY)).toThrow(/non-finite/);
    expect(() => readStat(line, 'defense.nothing' as StatPath)).toThrow(/unknown stat path/);
    expect(isStatPath('passing.yards')).toBe(true);
    expect(isStatPath('passing')).toBe(false);
    expect(isStatPath('passing.bogus')).toBe(false);
  });

  it('does not create stray properties on the line', () => {
    const line = emptyPlayerStatLine();
    expect(() => applyDelta(line, 'passing.toString' as StatPath, 1)).toThrow();
    expect(Object.keys(line.passing)).toEqual(Object.keys(emptyPlayerStatLine().passing));
  });
});

describe('applyDeltas', () => {
  it('creates player lines on demand and mutates the passed GameStats', () => {
    const stats = emptyGameStats();
    const deltas: PlayStatDelta[] = [
      delta(pid('qb'), 'passing.attempts'),
      delta(pid('qb'), 'passing.completions'),
      delta(pid('qb'), 'passing.yards', 24),
      delta(pid('qb'), 'passing.longest', 24),
      delta(pid('wr'), 'receiving.targets'),
      delta(pid('wr'), 'receiving.receptions'),
      delta(pid('wr'), 'receiving.yards', 24),
      delta(pid('wr'), 'receiving.longest', 24),
    ];
    const returned = applyDeltas(stats, deltas);
    expect(returned).toBe(stats);
    expect(Object.keys(stats.players).sort()).toEqual(['qb', 'wr']);
    expect(stats.players[pid('qb')]?.passing).toMatchObject({ attempts: 1, completions: 1, yards: 24, longest: 24 });
    expect(stats.players[pid('wr')]?.receiving).toMatchObject({ targets: 1, receptions: 1, yards: 24, longest: 24 });
    // Second play: shorter completion must not lower the longest.
    applyDeltas(stats, [delta(pid('qb'), 'passing.yards', 5), delta(pid('qb'), 'passing.longest', 5)]);
    expect(stats.players[pid('qb')]?.passing.yards).toBe(29);
    expect(stats.players[pid('qb')]?.passing.longest).toBe(24);
    // Untouched lines stay zero.
    expect(stats.players[pid('wr')]?.rushing.attempts).toBe(0);
  });

  it('delta() defaults value to 1', () => {
    expect(delta(pid('x'), 'defense.tackles')).toEqual({ playerId: 'x', stat: 'defense.tackles', value: 1 });
    expect(delta(pid('x'), 'rushing.yards', -4)).toEqual({ playerId: 'x', stat: 'rushing.yards', value: -4 });
  });

  it('applying random deltas one by one equals the summed/maxed totals (seeded)', () => {
    const rng = createRng(1234);
    const stats = emptyGameStats();
    const expected = new Map<StatPath, number>();
    for (let i = 0; i < 400; i++) {
      const path = rng.pick(STAT_PATHS);
      const value = rng.int(0, 30);
      applyDeltas(stats, [delta(pid('p'), path, value)]);
      const prev = expected.get(path) ?? 0;
      expected.set(path, MAX_STAT_PATHS.has(path) ? Math.max(prev, value) : prev + value);
    }
    const line = stats.players[pid('p')];
    expect(line).toBeDefined();
    for (const [path, value] of expected) expect(readStat(line!, path)).toBe(value);
  });
});

describe('mergeTeamStats', () => {
  it('returns a new line with every field summed and leaves inputs untouched', () => {
    const a = emptyTeamStatLine();
    const b = emptyTeamStatLine();
    a.points = 21; a.totalYards = 310; a.thirdDownAttempts = 6; a.thirdDownConversions = 2; a.epa = 1.5;
    b.points = 7; b.totalYards = 120; b.thirdDownAttempts = 5; b.thirdDownConversions = 3; b.epa = -0.5;
    const m = mergeTeamStats(a, b);
    expect(m).not.toBe(a);
    expect(m.points).toBe(28);
    expect(m.totalYards).toBe(430);
    expect(m.thirdDownAttempts).toBe(11);
    expect(m.thirdDownConversions).toBe(5);
    expect(m.epa).toBeCloseTo(1.0, 10);
    expect(m.drives).toBe(0);
    expect(a.points).toBe(21);
    expect(b.points).toBe(7);
    expect(Object.keys(m).sort()).toEqual(Object.keys(emptyTeamStatLine()).sort());
  });
});
