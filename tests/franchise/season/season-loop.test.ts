import { beforeAll, describe, expect, it } from 'vitest';
import type { PlayerId } from '@/core/ids';
import { createRng } from '@/core/rng';
import { buildGameSetup } from '@/franchise/game-setup';
import { standardOffseasonDeps } from '@/franchise/offseason-deps';
import { newsKindOf } from '@/franchise/offseason-events';
import { carriedDraft } from '@/franchise/phase';
import { assignPlayer, rosterErrors } from '@/franchise/roster';
import { blockingRosterIssues } from '@/franchise/roster-rules';
import { advanceLeaguePhase, advanceLeagueWeek, simulateToPhase } from '@/franchise/season-loop';
import { fallbackSimulator } from '@/franchise/sim-fallback';
import type { DraftState, League } from '@/franchise/types';
import { validateLeague } from '@/franchise';
import { userGameThisWeek } from '@/franchise/week';
import { serializeLeague } from '@/save/serialize';
import { makeLeague } from './helpers';

const fast = { simulator: fallbackSimulator };
const toRegularSeason = (league: League): League => simulateToPhase(league, 'regularSeason', { ...fast, rng: createRng(1) }).league;

describe('advanceLeagueWeek', () => {
  const start = toRegularSeason(makeLeague(41));

  it('opens this year\'s draft class when the regular season starts', () => {
    expect(start.season.phase).toBe('regularSeason');
    expect(start.season.week).toBe(1);
    expect(start.draft?.year).toBe(start.year);
    expect(start.draft?.complete).toBe(false);
  });

  it('plays the week, then club layer, development and scouting, deterministically per rng', () => {
    const a = advanceLeagueWeek(start, { ...fast, rng: createRng(9) });
    const b = advanceLeagueWeek(start, { ...fast, rng: createRng(9) });
    expect(serializeLeague(a.league)).toBe(serializeLeague(b.league));
    expect(a.league.season.week).toBe(2);
    expect(a.games.length).toBeGreaterThan(0);
    expect(a.events.filter((e) => e.type === 'gameResult')).toHaveLength(a.games.length);
    expect(a.league.offseasonFlags?.lastWeeklyDevelopment).toEqual({ year: start.season.year, week: 1 });
    const user = start.userTeamId!;
    expect(a.league.draft!.scouting[user]!.pointsAvailable).toBeGreaterThan(start.draft!.scouting[user]!.pointsAvailable);
    expect(a.league.club).toBeDefined();
    expect(validateLeague(a.league)).toEqual([]);
    expect(rosterErrors(a.league)).toEqual([]);
    // Without an rng the League rng is used and advanced.
    const c = advanceLeagueWeek(start, fast);
    expect(c.league.rngState).not.toEqual(start.rngState);
    expect(start.season.week).toBe(1);
  });

  it('records a live user result before simulating the rest of the week', () => {
    const game = userGameThisWeek(start)!;
    const live = fallbackSimulator(buildGameSetup(start, game), { keepPlayLog: true });
    const shifted = { ...live, homeScore: live.homeScore + 1 };
    const r = advanceLeagueWeek(start, { ...fast, rng: createRng(2), userResults: { [game.id]: shifted } });
    const stored = r.league.season.schedule.find((g) => g.id === game.id)!.result!;
    expect(stored.homeScore).toBe(shifted.homeScore);
    expect(() => advanceLeagueWeek(start, { ...fast, requireUserGame: true })).toThrow(/must be played first/);
  });

  it('refuses to run outside the game phases', () => {
    expect(() => advanceLeagueWeek({ ...start, season: { ...start.season, phase: 'draft' } })).toThrow(/advanceLeaguePhase/);
  });
});

describe('simulateToPhase and advanceLeaguePhase through a whole year', () => {
  const managed = standardOffseasonDeps({ manageUserTeam: true });
  let seasonEnd: League;
  let offseasonStart: League;
  beforeAll(() => {
    seasonEnd = simulateToPhase(makeLeague(43), 'awards', { ...fast, rng: createRng(3) }).league;
    offseasonStart = advanceLeaguePhase(seasonEnd, createRng(4), managed).league;
  }, 60_000);

  it('plays to the end of the playoffs with a champion', () => {
    expect(seasonEnd.season.phase).toBe('awards');
    expect(seasonEnd.season.champion).not.toBeNull();
    // Game phases move only through nextPhase's guards: unplayed games block the playoffs.
    expect(() => advanceLeaguePhase(toRegularSeason(makeLeague(43)), createRng(1))).toThrow(/regular-season game/);
  });

  it('runs the awards phase work before moving on', () => {
    expect(offseasonStart.season.phase).toBe('offseason');
    expect(offseasonStart.season.awards.length).toBeGreaterThan(0);
  });

  it('sims through the offseason into the next preseason with news, a settled roster and no leftover draft', () => {
    const r = simulateToPhase(offseasonStart, 'preseason', { rng: createRng(5), deps: managed });
    const next = r.league;
    expect(r.blockedBy).toEqual([]);
    expect(next.year).toBe(seasonEnd.year + 1);
    expect(next.season.phase).toBe('preseason');
    expect(next.draft).toBeNull();
    expect(r.offseasonEvents.some((e) => e.type === 'retirement')).toBe(true);
    const news = next.events.filter((e) => newsKindOf(e) !== null);
    expect(news.length).toBeGreaterThan(0);
    expect(news.every((e) => e.teamId === next.userTeamId && e.resolvedChoice === 'noted')).toBe(true);
    expect(news.some((e) => newsKindOf(e) === 'draftPick')).toBe(true);
    expect(blockingRosterIssues(next, next.userTeamId!, 'trainingCamp')).toEqual([]);
    expect(validateLeague(next)).toEqual([]);
    expect(rosterErrors(next)).toEqual([]);
  }, 60_000);

  it('refuses to leave final cuts with a broken user roster unless asked to fix it', () => {
    let league = offseasonStart;
    const rng = createRng(6);
    while (league.season.phase !== 'postDraft') league = advanceLeaguePhase(league, rng.fork(league.season.phase), managed).league;
    const user = league.userTeamId!;
    const kickers = league.teams[user]!.rosterIds.filter((id) => league.players[id]?.position === 'K');
    const broken = kickers.reduce((l, id: PlayerId) => assignPlayer(l, id, null), league);
    // The user's roster is his job: the AI does not settle it at final cuts.
    const handsOn = standardOffseasonDeps({ manageUserTeam: false });
    const refused = advanceLeaguePhase(broken, createRng(7), handsOn);
    expect(refused.next).toBe('postDraft');
    expect(refused.league.season.phase).toBe('postDraft');
    expect(refused.blockedBy.map((i) => i.kind)).toContain('emptyPosition');
    const fixed = advanceLeaguePhase(broken, createRng(7), handsOn, { autoFix: true });
    expect(fixed.blockedBy).toEqual([]);
    expect(fixed.league.season.phase).toBe('trainingCamp');
    expect(blockingRosterIssues(fixed.league, user, 'trainingCamp')).toEqual([]);
    expect(rosterErrors(fixed.league)).toEqual([]);
    // simulateToPhase stops at the blocker too.
    const stopped = simulateToPhase(broken, 'preseason', { rng: createRng(8), deps: handsOn });
    expect(stopped.blockedBy.length).toBeGreaterThan(0);
    expect(stopped.league.season.phase).toBe('postDraft');
  }, 60_000);
});

describe('phase rollover keeps an open draft class', () => {
  it('drops a finished draft but carries a class already opened for the new year', () => {
    const draft = { year: 2027, complete: false } as DraftState;
    expect(carriedDraft(draft, 2027)).toBe(draft);
    expect(carriedDraft({ ...draft, year: 2026 }, 2027)).toBeNull();
    expect(carriedDraft({ ...draft, complete: true }, 2027)).toBeNull();
    expect(carriedDraft(null, 2027)).toBeNull();
  });
});
