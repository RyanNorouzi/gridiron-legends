import { describe, expect, it } from 'vitest';
import { emptyGameStats, emptyPlayerStatLine, emptyTeamStatLine } from '@/statistics/empty';
import { STAT_PATHS, readStat } from '@/statistics/apply';

const allNumbersZero = (obj: object): boolean =>
  Object.values(obj).every((v) => (typeof v === 'number' ? v === 0 : typeof v === 'object' && v !== null && allNumbersZero(v)));

describe('empty stat constructors', () => {
  it('emptyPlayerStatLine is all zeros across every category', () => {
    const line = emptyPlayerStatLine();
    expect(allNumbersZero(line)).toBe(true);
    for (const path of STAT_PATHS) expect(readStat(line, path)).toBe(0);
  });

  it('emptyTeamStatLine is all zeros', () => {
    expect(allNumbersZero(emptyTeamStatLine())).toBe(true);
  });

  it('emptyGameStats has no players and zeroed home/away lines', () => {
    const g = emptyGameStats();
    expect(Object.keys(g.players)).toHaveLength(0);
    expect(allNumbersZero(g.teams.home)).toBe(true);
    expect(allNumbersZero(g.teams.away)).toBe(true);
  });

  it('returns fresh objects every call (no shared nested references)', () => {
    const a = emptyPlayerStatLine();
    const b = emptyPlayerStatLine();
    a.passing.yards = 50;
    a.snaps = 3;
    expect(b.passing.yards).toBe(0);
    expect(b.snaps).toBe(0);
    const g1 = emptyGameStats();
    const g2 = emptyGameStats();
    g1.teams.home.points = 7;
    expect(g2.teams.home.points).toBe(0);
    expect(g1.teams.home).not.toBe(g1.teams.away);
  });

  it('STAT_PATHS enumerates every numeric leaf exactly once', () => {
    const line = emptyPlayerStatLine();
    let leaves = 0;
    for (const v of Object.values(line)) leaves += typeof v === 'number' ? 1 : Object.keys(v).length;
    expect(STAT_PATHS).toHaveLength(leaves);
    expect(new Set(STAT_PATHS).size).toBe(STAT_PATHS.length);
    expect(STAT_PATHS).toContain('passing.yards');
    expect(STAT_PATHS).toContain('kicking.puntLong');
    expect(STAT_PATHS).toContain('epa');
  });
});
