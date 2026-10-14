import { describe, expect, it } from 'vitest';
import { createRng } from '@/core/rng';
import type { PlayerId } from '@/core/ids';
import { emptyPlayerStatLine } from '@/statistics/empty';
import { passerRating } from '@/statistics/derived';
import { leaders, leadersBy, rankOf } from '@/statistics/leaders';
import type { PlayerStatLine } from '@/statistics/types';

const pid = (s: string): PlayerId => s as PlayerId;

const table = (entries: Record<string, (l: PlayerStatLine) => void>): Record<PlayerId, PlayerStatLine> => {
  const out: Record<PlayerId, PlayerStatLine> = {};
  for (const [id, fill] of Object.entries(entries)) {
    const l = emptyPlayerStatLine();
    fill(l);
    out[pid(id)] = l;
  }
  return out;
};

describe('leaders', () => {
  const stats = table({
    zed: (l) => { l.rushing.yards = 900; l.rushing.attempts = 200; },
    amy: (l) => { l.rushing.yards = 900; l.rushing.attempts = 150; },
    bob: (l) => { l.rushing.yards = 1200; l.rushing.attempts = 250; },
    cat: (l) => { l.rushing.yards = 300; l.rushing.attempts = 40; },
    dan: (l) => { l.rushing.yards = 0; l.rushing.attempts = 0; },
  });

  it('sorts descending with ties broken by playerId and limits to n', () => {
    expect(leaders(stats, 'rushing.yards', 3)).toEqual([
      { playerId: 'bob', value: 1200 },
      { playerId: 'amy', value: 900 },
      { playerId: 'zed', value: 900 },
    ]);
    expect(leaders(stats, 'rushing.yards', 10).map((e) => e.playerId)).toEqual(['bob', 'amy', 'zed', 'cat', 'dan']);
    expect(leaders(stats, 'rushing.yards', 0)).toEqual([]);
    expect(leaders(stats, 'rushing.yards', -2)).toEqual([]);
    expect(leaders({}, 'rushing.yards', 5)).toEqual([]);
  });

  it('applies a minimum qualifier on another path', () => {
    const board = leaders(stats, 'rushing.yards', 10, { path: 'rushing.attempts', min: 150 });
    expect(board.map((e) => e.playerId)).toEqual(['bob', 'amy', 'zed']);
  });

  it('is deterministic regardless of insertion order (seeded shuffle)', () => {
    const rng = createRng(2026);
    const ids = Object.keys(stats) as PlayerId[];
    const baseline = leaders(stats, 'rushing.yards', 5);
    for (let i = 0; i < 5; i++) {
      const shuffled: Record<PlayerId, PlayerStatLine> = {};
      for (const id of rng.shuffle(ids)) shuffled[id] = stats[id]!;
      expect(leaders(shuffled, 'rushing.yards', 5)).toEqual(baseline);
    }
  });

  it('rankOf returns the 1-based position or null', () => {
    expect(rankOf(stats, 'rushing.yards', pid('bob'))).toBe(1);
    expect(rankOf(stats, 'rushing.yards', pid('zed'))).toBe(3);
    expect(rankOf(stats, 'rushing.yards', pid('cat'), { path: 'rushing.attempts', min: 150 })).toBeNull();
    expect(rankOf(stats, 'rushing.yards', pid('ghost'))).toBeNull();
  });
});

describe('leadersBy', () => {
  it('ranks by a derived metric with a predicate qualifier', () => {
    const stats = table({
      vet: (l) => { l.passing = { ...l.passing, attempts: 400, completions: 270, yards: 3300, touchdowns: 25, interceptions: 8 }; },
      kid: (l) => { l.passing = { ...l.passing, attempts: 12, completions: 12, yards: 200, touchdowns: 3 }; },
      dud: (l) => { l.passing = { ...l.passing, attempts: 300, completions: 150, yards: 1600, touchdowns: 5, interceptions: 20 }; },
    });
    const all = leadersBy(stats, (l) => passerRating(l.passing), 5);
    expect(all[0]?.playerId).toBe('kid');
    const qualified = leadersBy(stats, (l) => passerRating(l.passing), 5, (l) => l.passing.attempts >= 100);
    expect(qualified.map((e) => e.playerId)).toEqual(['vet', 'dud']);
    const fewest = leadersBy(stats, (l) => l.passing.interceptions, 5, undefined, true);
    expect(fewest.map((e) => e.playerId)).toEqual(['kid', 'vet', 'dud']);
  });

  it('skips non-finite values', () => {
    const stats = table({ a: (l) => { l.snaps = 10; }, b: (l) => { l.snaps = 0; } });
    const board = leadersBy(stats, (l) => (l.snaps > 0 ? 1 / l.snaps : Number.NaN), 5);
    expect(board).toEqual([{ playerId: 'a', value: 0.1 }]);
  });
});
