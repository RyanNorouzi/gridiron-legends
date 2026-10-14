import { beforeAll, describe, expect, it } from 'vitest';
import type { TeamId } from '@/core/ids';
import {
  applyGameResult, clinchStatuses, clinchedDivision, clinchedPlayoffs, conferenceStandings, divisionRanks, divisionStandings, eliminated,
  emptyStandings, rankTeams, seeding, standingsFromSchedule, tiebreakContext, winPct, type TiebreakContext,
} from '@/franchise/standings';
import { advanceToPhase } from '@/franchise/week';
import { regularSeasonGames } from '@/franchise/schedule';
import type { League, ScheduledGame, Standing } from '@/franchise/types';
import type { Team } from '@/teams/types';
import { divisionsOf, makeLeague, playedGame, sumStandings } from './helpers';

const league = makeLeague(21);
const divisions = [...divisionsOf(league).values()];
const [divA, divB] = divisions as [Team[], Team[]];
const [a, b, c, d] = divA.map((t) => t.id) as [TeamId, TeamId, TeamId, TeamId];
const other = (divisions.find((ts) => ts[0]?.conference !== divA[0]?.conference) as Team[])[0]?.id as TeamId;
const confMate = divB[0]?.id as TeamId;

const standingsOf = (games: ScheduledGame[]): Record<TeamId, Standing> => games.reduce((s, g) => applyGameResult(s, g, league.teams), emptyStandings(league.teams));
const ctxOf = (games: ScheduledGame[], seed = 1): TiebreakContext => ({ standings: standingsOf(games), teams: league.teams, games, seed });

describe('applyGameResult', () => {
  it('records wins, losses, ties, points, division/conference splits and streaks', () => {
    const games = [playedGame(a, b, 24, 17), playedGame(a, other, 10, 20), playedGame(a, confMate, 13, 13), playedGame(c, a, 3, 30), playedGame(d, a, 0, 7)];
    const s = standingsOf(games);
    expect(s[a]).toMatchObject({ wins: 3, losses: 1, ties: 1, pointsFor: 84, pointsAgainst: 53, divisionWins: 3, divisionLosses: 0, conferenceWins: 3, conferenceLosses: 0, streak: 2 });
    expect(s[a]?.results).toEqual(['W', 'L', 'T', 'W', 'W']);
    expect(s[b]).toMatchObject({ wins: 0, losses: 1, divisionLosses: 1, conferenceLosses: 1, streak: -1 });
    expect(s[other]).toMatchObject({ wins: 1, conferenceWins: 0, divisionWins: 0 });
    expect(s[confMate]).toMatchObject({ ties: 1, streak: 0 });
    expect(winPct(s[a] as Standing)).toBeCloseTo(3.5 / 5);
  });

  it('is pure and ignores preseason, playoff and unplayed games', () => {
    const base = emptyStandings(league.teams);
    const snapshot = JSON.stringify(base);
    const next = applyGameResult(base, playedGame(a, b, 10, 3), league.teams);
    expect(JSON.stringify(base)).toBe(snapshot);
    expect(next).not.toBe(base);
    expect(applyGameResult(base, { ...playedGame(a, b, 10, 3), isPreseason: true }, league.teams)).toBe(base);
    expect(applyGameResult(base, { ...playedGame(a, b, 10, 3), isPlayoff: true }, league.teams)).toBe(base);
    expect(applyGameResult(base, { ...playedGame(a, b, 10, 3), result: null }, league.teams)).toBe(base);
  });

  it('standingsFromSchedule rebuilds the same table', () => {
    const games = [playedGame(a, b, 24, 17), playedGame(c, d, 9, 12)];
    expect(standingsFromSchedule(games, league.teams)).toEqual(standingsOf(games));
  });
});

describe('tiebreakers', () => {
  it('orders by win percentage first', () => {
    const games = [playedGame(a, other, 7, 3), playedGame(b, other, 3, 7), playedGame(c, other, 7, 7)];
    expect(rankTeams([b, c, a], ctxOf(games))).toEqual([a, c, b]);
  });

  it('breaks two-way ties head-to-head before points', () => {
    const games = [playedGame(a, b, 10, 9), playedGame(b, other, 50, 0), playedGame(other, a, 10, 7)];
    const ctx = ctxOf(games);
    expect(ctx.standings[b]?.pointsFor).toBeGreaterThan(ctx.standings[a]?.pointsFor ?? 0);
    expect(rankTeams([b, a], ctx)).toEqual([a, b]);
  });

  it('falls back to division record, then conference record', () => {
    const div = [playedGame(a, c, 10, 0), playedGame(other, a, 10, 0), playedGame(b, other, 10, 0), playedGame(c, b, 10, 0)];
    expect(rankTeams([b, a], ctxOf(div))).toEqual([a, b]);
    const conf = [playedGame(a, confMate, 10, 0), playedGame(other, a, 10, 0), playedGame(c, other, 10, 0), playedGame(confMate, c, 10, 0)];
    expect(rankTeams([c, a], ctxOf(conf))).toEqual([a, c]);
  });

  it('then point differential, then points for', () => {
    const diff = [playedGame(a, other, 30, 0), playedGame(c, other, 20, 0)];
    expect(rankTeams([c, a], ctxOf(diff))).toEqual([a, c]);
    const pf = [playedGame(a, other, 30, 20), playedGame(c, other, 10, 0)];
    expect(rankTeams([c, a], ctxOf(pf))).toEqual([a, c]);
  });

  it('settles dead heats with a deterministic seeded coin flip', () => {
    const games = [playedGame(a, other, 10, 0), playedGame(c, other, 10, 0)];
    const first = rankTeams([a, c], ctxOf(games, 5));
    expect(rankTeams([c, a], ctxOf(games, 5))).toEqual(first);
    const flips = new Set(Array.from({ length: 12 }, (_, seed) => rankTeams([a, c], ctxOf(games, seed))[0]));
    expect(flips.size).toBe(2);
  });

  it('restarts after separating a three-way tie', () => {
    // a beat b and c; b beat c; everyone 2-2 overall.
    const games = [playedGame(a, b, 10, 0), playedGame(a, c, 10, 0), playedGame(b, c, 10, 0), playedGame(other, a, 30, 0), playedGame(other, a, 30, 0),
      playedGame(b, other, 10, 0), playedGame(other, b, 10, 0), playedGame(c, other, 10, 0), playedGame(c, other, 10, 0)];
    const ctx = ctxOf(games);
    expect([a, b, c].map((t) => winPct(ctx.standings[t] as Standing))).toEqual([0.5, 0.5, 0.5]);
    expect(rankTeams([c, b, a], ctx)).toEqual([a, b, c]);
  });
});

describe('tables and seeding over a played season', () => {
  let played: League;
  let events: ReturnType<typeof advanceToPhase>['events'];
  beforeAll(() => {
    const run = advanceToPhase(makeLeague(21), 'playoffs');
    played = run.league;
    events = run.events;
  });

  it('division and conference tables cover every team in order', () => {
    const ctx = tiebreakContext(played);
    const divs = divisionStandings(ctx);
    expect(Object.keys(divs)).toHaveLength(8);
    for (const order of Object.values(divs)) {
      expect(order).toHaveLength(4);
      for (let i = 1; i < order.length; i++) expect(winPct(ctx.standings[order[i - 1] as TeamId] as Standing)).toBeGreaterThanOrEqual(winPct(ctx.standings[order[i] as TeamId] as Standing));
    }
    const confs = conferenceStandings(ctx);
    expect(Object.values(confs).flat()).toHaveLength(32);
    const ranks = divisionRanks(ctx);
    expect(Object.values(ranks).filter((r) => r === 0)).toHaveLength(8);
    expect(sumStandings(played.season.standings, 'wins')).toBe(sumStandings(played.season.standings, 'losses'));
  });

  it('seeds division winners first, then the best wild cards', () => {
    const ctx = tiebreakContext(played);
    const seeds = seeding(played.season.standings, played.teams, played.settings, ctx);
    const divs = divisionStandings(ctx);
    for (const conf of played.settings.conferences) {
      const list = seeds[conf] as TeamId[];
      expect(list).toHaveLength(7);
      const winners = Object.values(divs).map((o) => o[0] as TeamId).filter((id) => played.teams[id]?.conference === conf);
      expect(new Set(list.slice(0, 4))).toEqual(new Set(winners));
      const pct = (id: TeamId): number => winPct(ctx.standings[id] as Standing);
      for (let i = 1; i < 4; i++) expect(pct(list[i - 1] as TeamId)).toBeGreaterThanOrEqual(pct(list[i] as TeamId));
      const rest = Object.values(played.teams).filter((t) => t.conference === conf && !list.includes(t.id));
      for (const t of rest) expect(pct(t.id)).toBeLessThanOrEqual(pct(list[6] as TeamId));
      expect(list.every((id) => played.teams[id]?.conference === conf)).toBe(true);
    }
    expect(played.season.bracket?.seeds).toEqual(seeds);
  });

  it('clinch and elimination announcements were never wrong', () => {
    const seeded = new Set(Object.values(played.season.bracket?.seeds ?? {}).flat());
    const clinched = events.filter((e) => e.type === 'clinch').map((e) => (e as { teamId: TeamId }).teamId);
    const out = events.filter((e) => e.type === 'eliminated').map((e) => (e as { teamId: TeamId }).teamId);
    expect(clinched.length).toBeGreaterThan(0);
    expect(out.length).toBeGreaterThan(0);
    for (const t of clinched) expect(seeded.has(t)).toBe(true);
    for (const t of out) expect(seeded.has(t)).toBe(false);
    const ctx = tiebreakContext(played);
    const status = clinchStatuses(ctx, played.settings);
    expect(Object.values(status).filter((s) => s === 'eliminated')).toHaveLength(18);
    for (const t of seeded) expect(clinchedPlayoffs(ctx, played.settings, t)).toBe(true);
  });

  it('nothing is decided before the season starts, and a dominant team clinches early', () => {
    const fresh = makeLeague(21);
    const ctx = tiebreakContext(fresh);
    expect(Object.values(clinchStatuses(ctx, fresh.settings)).every((s) => s === null)).toBe(true);
    const games = regularSeasonGames(fresh.season.schedule);
    const sweep = games.map((g) => (g.home === a || g.away === a ? { ...playedGame(g.home, g.away, g.home === a ? 30 : 0, g.home === a ? 0 : 30, g.week), id: g.id } : g));
    const partial = sweep.map((g) => (g.week > 12 && g.home !== a && g.away !== a ? { ...g, result: null } : g));
    const standings = partial.reduce((s, g) => applyGameResult(s, g, fresh.teams), emptyStandings(fresh.teams));
    const pctx: TiebreakContext = { standings, teams: fresh.teams, games: partial, seed: 0 };
    expect(clinchedDivision(pctx, a)).toBe(true);
    expect(clinchedPlayoffs(pctx, fresh.settings, a)).toBe(true);
    expect(eliminated(pctx, fresh.settings, a)).toBe(false);
  });
});
