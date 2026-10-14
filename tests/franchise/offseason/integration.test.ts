/**
 * The orchestrator driving the real parallel modules (AI re-signing, free agency, draft, final cuts) through a
 * whole offseason through the standard wiring (offseason-deps.ts standardOffseasonDeps).
 */
import { describe, expect, it } from 'vitest';
import { createRng } from '@/core/rng';
import { advanceToPhase } from '@/franchise';
import { runOffseason } from '@/franchise/offseason';
import { standardOffseasonDeps } from '@/franchise/offseason-deps';
import { isUserTeam, rosterErrors } from '@/franchise/roster';
import type { League } from '@/franchise/types';
import { playedSeason } from './helpers';

/** The standard wiring (offseason-deps.ts); the user's roster is left to the user. */
const realDeps = standardOffseasonDeps();

describe('offseason with the real market and draft modules', () => {
  it('produces a consistent next season with rookies settled at camp and AI rosters at the limit', () => {
    const season = playedSeason(7);
    const out = runOffseason(season, createRng(12), realDeps);
    const league = out.league;
    expect(league.season.phase).toBe('preseason');
    expect(rosterErrors(league)).toEqual([]);
    expect(out.warnings.filter((w) => /phase skipped/.test(w))).toEqual([]);
    for (const t of Object.values(league.teams)) {
      if (!isUserTeam(league, t)) expect(t.rosterIds.length).toBeLessThanOrEqual(league.settings.rosterSize);
    }
    const rookies = out.camp.flatMap((r) => r.rookies);
    expect(rookies.length).toBeGreaterThan(100);
    for (const r of rookies) expect(Math.abs(r.after - r.before)).toBeLessThanOrEqual(3);
    for (const id of Object.keys(league.retiredPlayers)) expect(league.players[id as keyof League['players']]).toBeUndefined();
  }, 60_000);

  it('chains two full seasons: flags roll per offseason while All-Pro history and awards persist', () => {
    const first = runOffseason(playedSeason(7), createRng(12), realDeps).league;
    const year1 = first.year - 1;
    const second = runOffseason(advanceToPhase(first, 'awards').league, createRng(13), realDeps).league;
    expect(second.year).toBe(year1 + 2);
    expect(second.offseasonFlags?.year).toBe(year1 + 1);
    expect(second.history.map((h) => h.year)).toEqual([year1, year1 + 1]);
    for (const h of second.history) expect(h.awards.some((a) => a.award === 'MVP' && a.year === h.year)).toBe(true);
    const allProYears = new Set(Object.values(second.offseasonFlags?.allPro ?? {}).flat());
    expect([...allProYears].sort()).toEqual([year1, year1 + 1]);
    expect(rosterErrors(second)).toEqual([]);
    const coy = second.history[1]!.awards.find((a) => a.award === 'COY');
    expect(coy?.coachId).not.toBeNull();
  }, 60_000);
});
