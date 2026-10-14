/**
 * Save format v2 (compact stat lines) on a real three-season league: exact round trip, canonical text, loading a v1
 * (full stat line) file through the migration, and the size win over the v1 format.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { createRng } from '@/core/rng';
import { createLeague } from '@/franchise';
import { runOffseason } from '@/franchise/offseason';
import { standardOffseasonDeps } from '@/franchise/offseason-deps';
import type { League } from '@/franchise/types';
import { advanceToPhase } from '@/franchise/week';
import { CURRENT_SAVE_VERSION } from '@/save/migrations';
import { deserializeLeague, parseSaveText, serializeLeague, stableStringify } from '@/save/serialize';

let league: League;

describe('compact league saves', () => {
  beforeAll(() => {
    let l = createLeague({ seed: 3, userTeamAbbr: 'BOS' });
    const deps = standardOffseasonDeps({ manageUserTeam: true });
    for (let year = 0; year < 3; year++) {
      l = advanceToPhase(l, 'awards').league;
      if (year < 2) l = runOffseason(l, createRng(year), deps).league;
    }
    league = l;
  }, 60_000);

  it('holds three seasons of stats', () => {
    expect(league.history.length).toBe(2);
    expect(league.season.phase).toBe('awards');
    // Two closed seasons in the career books, the third still in the season tables.
    expect(Object.values(league.careerStats).some((c) => c.seasons.length === 2)).toBe(true);
    expect(Object.keys(league.season.stats).length).toBeGreaterThan(1000);
  });

  it('round-trips a three-season league exactly and canonically', () => {
    const text = serializeLeague(league);
    const back = deserializeLeague(text);
    expect(back).toEqual(league);
    expect(serializeLeague(back)).toBe(text);
    expect(deserializeLeague(serializeLeague(league, { compress: true }))).toEqual(league);
    const onDisk = parseSaveText(text) as { version: number; season: { stats: Record<string, Record<string, unknown>> } };
    expect(onDisk.version).toBe(CURRENT_SAVE_VERSION);
    expect(league.version).toBe(1);
  }, 60_000);

  it('loads a v1 save (full, zero-filled stat lines) through the migration', () => {
    const v1 = stableStringify(league);
    expect(v1).toContain('"version":1');
    expect(v1).toContain('"sackYards":0');
    expect(deserializeLeague(v1)).toEqual(league);
  }, 60_000);

  it('shrinks the raw JSON by at least 60% against the v1 format', () => {
    const v1 = stableStringify(league).length;
    const v2 = serializeLeague(league).length;
    expect(1 - v2 / v1).toBeGreaterThanOrEqual(0.6);
  }, 60_000);
});
