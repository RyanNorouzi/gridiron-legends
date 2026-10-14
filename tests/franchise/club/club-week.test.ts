import { describe, expect, it } from 'vitest';
import { createRng } from '@/core/rng';
import { advanceClubPhase, advanceClubWeek, closeClubSeason, type RecordBreak } from '@/franchise/events';
import { seasonFinanceReport } from '@/franchise/finances';
import { advanceWeekDetailed } from '@/franchise/week';
import type { League } from '@/franchise/types';
import { deserializeLeague, serializeLeague } from '@/save/serialize';
import { clubLeague, patchPlayer, userTeamOf, withPhase } from './helpers';

/** Plays `weeks` weeks with the season engine and runs the club layer after each. */
const play = (start: League, weeks: number): { league: League; perWeek: number[] } => {
  let l = start;
  const perWeek: number[] = [];
  for (let i = 0; i < weeks; i++) {
    const phase = l.season.phase;
    const week = l.season.week;
    const r = advanceWeekDetailed(l);
    const records: RecordBreak[] = r.events.flatMap((e) => (e.type === 'record' ? [{ record: e.record, previous: e.previous }] : []));
    const club = advanceClubWeek(r.league, { games: r.games, phase, week, brokenRecords: records });
    perWeek.push(club.events.length);
    l = club.league;
  }
  return { league: l, perWeek };
};

const start = clubLeague(33);
const played = play(start, 7);
const team = userTeamOf(played.league);

describe('advanceClubWeek', () => {
  it('books money, moves fans and morale, and keeps the rivalry ledger', () => {
    const l = played.league;
    expect(l.season.phase).toBe('regularSeason');
    const report = seasonFinanceReport(l, team.id);
    expect(report.revenue.media).toBeGreaterThan(0);
    expect(report.revenue.tickets).toBeGreaterThan(0);
    expect(report.expenses.playerSalaries).toBeGreaterThan(0);
    expect(report.homeGames).toBeGreaterThan(0);
    expect(Object.keys(l.club?.rivalries ?? {}).length).toBeGreaterThan(0);
    expect(Object.keys(l.club?.tenure ?? {}).length).toBeGreaterThan(1000);
    const moodChanged = team.rosterIds.some((id) => l.players[id]?.morale.morale !== start.players[id]?.morale.morale);
    expect(moodChanged).toBe(true);
    for (const t of Object.values(l.teams)) {
      expect(t.finances.cash).toBeGreaterThanOrEqual(0);
      expect(t.fans.support).toBeGreaterThanOrEqual(0);
      expect(t.fans.support).toBeLessThanOrEqual(100);
      expect(t.chemistry).toBeGreaterThanOrEqual(0);
      expect(t.chemistry).toBeLessThanOrEqual(100);
    }
  });

  it('raises at most maxPerWeek events a week, only for the user team', () => {
    for (const n of played.perWeek) expect(n).toBeLessThanOrEqual(3);
    for (const e of played.league.events) expect(e.teamId).toBe(team.id);
  });

  it('is deterministic and pure', () => {
    const snapshot = JSON.stringify(start);
    const again = play(start, 7);
    expect(JSON.stringify(again.league)).toBe(JSON.stringify(played.league));
    expect(JSON.stringify(start)).toBe(snapshot);
  });

  it('survives a save round trip', () => {
    const restored = deserializeLeague(serializeLeague(played.league));
    expect(restored.club).toEqual(played.league.club);
    expect(restored.events).toEqual(played.league.events);
  });

  it('AI events are resolved on the spot when requested', () => {
    const l = played.league;
    const r = advanceWeekDetailed(l);
    const club = advanceClubWeek(r.league, { games: r.games, phase: l.season.phase, week: l.season.week, aiEvents: true, rng: createRng(4) });
    const ai = club.league.events.filter((e) => e.teamId !== team.id);
    for (const e of ai) expect(e.resolvedChoice).not.toBeNull();
  });
});

describe('season close and phase changes', () => {
  const offseason = withPhase(played.league, 'offseason', 0);

  it('closeClubSeason closes the books, resets excitement, turns the staff over, once', () => {
    const closed = closeClubSeason(offseason, createRng(8));
    expect(closed.staff).not.toBeNull();
    const l = closed.league;
    for (const t of Object.values(l.teams)) {
      expect(l.club?.financeHistory?.[t.id]?.[0]?.year).toBe(offseason.season.year);
      expect(t.finances.seasonRevenue.tickets).toBe(0);
    }
    const anyCoach = Object.values(offseason.coaches).find((c) => c.teamId === team.id && c.age < 60);
    if (anyCoach) expect(l.coaches[anyCoach.id]?.age).toBe(anyCoach.age + 1);
    const again = closeClubSeason(l, createRng(8));
    expect(again.league).toBe(l);
    expect(again.staff).toBeNull();
  });

  it('advanceClubPhase announces offseason news for the user team', () => {
    const old = team.rosterIds.map((id) => played.league.players[id]).find((p) => p && p.position === 'P');
    if (!old) throw new Error('no punter');
    // One announcement per week: the most notable veteran (highest overall) goes first.
    const l = patchPlayer(offseason, old.id, { age: 38, overall: 88 });
    const r = advanceClubPhase(l, createRng(2));
    expect(r.events.some((e) => e.type === 'retirementAnnounced' && e.playerId === old.id)).toBe(true);
    expect(r.events.length).toBeLessThanOrEqual(3);
    expect(r.league.events.length).toBe(l.events.length + r.events.length);
  });
});
