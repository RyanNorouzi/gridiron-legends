import { describe, expect, it } from 'vitest';
import type { PlayerId, TeamId } from '@/core/ids';
import { createRng } from '@/core/rng';
import { validateLeague } from '@/save/serialize';
import type { League } from '@/franchise/types';
import { capSpace, contractApy, contractEndYear, leagueCapYear, minimumSalaryFor, termsFromApy } from '@/franchise/contracts';
import { playerAsk } from '@/franchise/negotiation';
import { cutPlayer, rosterErrors } from '@/franchise/roster';
import { runAiResigning } from '@/franchise/gm/roster-ai';
import {
  finishFreeAgency, isFreeAgencyOpen, makeFreeAgentOffer, runFreeAgency, runFreeAgencyRound, startFreeAgency,
} from '@/franchise/free-agency';
import { atPhase, bestAt, buildLeague, freeAgentsByOverall, teamByAbbr, teamsSorted, withPlayer } from './helpers';

/** Offseason: AI re-signing, then free agency opened. */
const openMarket = (seed: number): League => {
  const resigned = runAiResigning(atPhase(buildLeague({ seed }), 'resigning'), createRng(seed + 1));
  return startFreeAgency(atPhase(resigned, 'freeAgency'));
};

describe('startFreeAgency', () => {
  it('releases every expired deal into the pool and opens round 1', () => {
    const before = atPhase(buildLeague({ seed: 3 }), 'freeAgency');
    const expiredIds = Object.values(before.players).filter((p) => p.contract && contractEndYear(p.contract) < 2027).map((p) => p.id);
    const league = startFreeAgency(before, { maxRounds: 4 });
    expect(league.freeAgency).toEqual({ round: 1, maxRounds: 4, offers: [], signings: [] });
    expect(isFreeAgencyOpen(league)).toBe(true);
    expect(new Set(league.freeAgentIds)).toEqual(new Set(expiredIds));
    for (const id of league.freeAgentIds) {
      const p = league.players[id]!;
      expect(p.teamId).toBeNull();
      expect(p.contract).toBeNull();
      expect(p.askingSalary).toBe(playerAsk(p, league, null, 2027).apy);
    }
    const kept = Object.values(league.players).filter((p) => p.teamId !== null);
    expect(kept.every((p) => p.contract && contractEndYear(p.contract) >= 2027)).toBe(true);
    expect(rosterErrors(league)).toEqual([]);
    expect(() => startFreeAgency(league)).toThrow(/already running/);
    expect(() => runFreeAgencyRound(before, createRng(1))).toThrow(/not started/);
  });
});

describe('AI-only free agency', () => {
  it('signs most of the top-60 free agents, keeps every team under the cap and every roster at 53', () => {
    const open = openMarket(5);
    const top60 = freeAgentsByOverall(open).slice(0, 60);
    let league = open;
    const rng = createRng(77);
    const seen: number[] = [];
    while (isFreeAgencyOpen(league)) {
      league = runFreeAgencyRound(league, rng.fork(`r${league.freeAgency!.round}`));
      seen.push(league.freeAgency!.signings.length);
      expect(rosterErrors(league)).toEqual([]);
    }
    expect(seen).toHaveLength(5);
    expect(seen[4]!).toBeGreaterThan(seen[0]!);
    const signedTop = top60.filter((id) => league.players[id]!.teamId !== null).length;
    expect(signedTop).toBeGreaterThanOrEqual(50);
    const statuses = new Set(league.freeAgency!.offers.map((o) => o.status));
    expect(statuses.has('accepted')).toBe(true);
    expect(statuses.has('rejected')).toBe(true);
    for (const s of league.freeAgency!.signings) {
      const p = league.players[s.playerId]!;
      expect(p.teamId).toBe(s.teamId);
      expect(p.contract!.signedYear).toBe(2027);
    }

    const done = finishFreeAgency(league);
    const year = leagueCapYear(done);
    for (const team of teamsSorted(done)) {
      expect(capSpace(team, done.players, done.settings, year)).toBeGreaterThanOrEqual(0);
      expect(team.rosterIds.length).toBeLessThanOrEqual(53);
      expect(team.rosterIds.length).toBe(53);
    }
    expect(isFreeAgencyOpen(done)).toBe(false);
    expect(done.freeAgency!.offers.some((o) => o.status === 'pending')).toBe(false);
    for (const id of done.freeAgentIds) expect(done.players[id]!.askingSalary).toBe(minimumSalaryFor(done.players[id]!.experience, done.settings));
    expect(rosterErrors(done)).toEqual([]);
    expect(() => validateLeague(done)).not.toThrow();
    expect(runFreeAgencyRound(done, createRng(1))).toBe(done);
  });

  it('is deterministic for a seed', () => {
    const a = runFreeAgency(openMarket(11), createRng(4));
    const b = runFreeAgency(openMarket(11), createRng(4));
    expect(a.freeAgency!.signings).toEqual(b.freeAgency!.signings);
    const where = (l: League): (TeamId | null)[] => Object.keys(l.players).sort().map((id) => l.players[id as PlayerId]!.teamId);
    expect(where(a)).toEqual(where(b));
    const c = runFreeAgency(openMarket(11), createRng(5));
    expect(c.freeAgency!.signings).not.toEqual(a.freeAgency!.signings);
  });
});

describe('runFreeAgency for a hands-off user (includeUser)', () => {
  it('leaves the user team alone by default and bids for and settles it with includeUser', () => {
    const open = startFreeAgency(atPhase(runAiResigning(atPhase(buildLeague({ seed: 21, userTeamAbbr: 'BOS' }), 'resigning'), createRng(22)), 'freeAgency'));
    const user = teamByAbbr(open, 'BOS');
    expect(user.rosterIds.length).toBeLessThan(open.settings.rosterSize);
    const alone = runFreeAgency(open, createRng(23));
    expect(alone.freeAgency!.signings.some((s) => s.teamId === user.id)).toBe(false);
    expect(alone.teams[user.id]!.rosterIds).toEqual(user.rosterIds);
    const managed = runFreeAgency(open, createRng(23), { includeUser: true });
    expect(managed.freeAgency!.signings.some((s) => s.teamId === user.id)).toBe(true);
    expect(managed.teams[user.id]!.rosterIds).toHaveLength(managed.settings.rosterSize);
    expect(capSpace(managed.teams[user.id]!, managed.players, managed.settings, leagueCapYear(managed))).toBeGreaterThanOrEqual(0);
    expect(rosterErrors(managed)).toEqual([]);
  });
});

/** A quiet market: the user's team cut one player; every AI roster is full, so only the user can bid. */
const quietMarket = (): { league: League; userId: TeamId; playerId: PlayerId } => {
  const base = atPhase(buildLeague({ seed: 21, userTeamAbbr: 'BOS' }), 'freeAgency');
  const user = teamByAbbr(base, 'BOS');
  const star = bestAt(base, user.id, 'WR');
  const cut = cutPlayer(base, user.id, star.id);
  return { league: { ...cut, freeAgency: { round: 1, maxRounds: 3, offers: [], signings: [] } }, userId: user.id, playerId: star.id };
};

describe('user offers', () => {
  it('a generous user offer to a money-driven star wins him outright', () => {
    const open = openMarket(8);
    const user = teamsSorted(open)[9]!;
    const league0 = { ...open, userTeamId: user.id, teams: { ...open.teams, [user.id]: { ...user, isUserControlled: true } } };
    const target = league0.players[freeAgentsByOverall(league0)[0]!]!;
    const league = withPlayer(league0, { ...target, preferences: { money: 1, playingTime: 0, winning: 0, location: 0, coach: 0, role: 0, chemistry: 0 } });
    const ask = playerAsk(league.players[target.id]!, league, league.teams[user.id]!, 2027);
    const offer = makeFreeAgentOffer(league, user.id, target.id, termsFromApy(ask.apy * 1.5, ask.years, ask.role, 0.6, 0.25));
    const after = runFreeAgencyRound(league, createRng(2), [offer]);
    expect(after.players[target.id]!.teamId).toBe(user.id);
    expect(after.freeAgency!.offers.find((o) => o.id === offer.id)!.status).toBe('accepted');
    expect(after.freeAgency!.signings).toContainEqual({ playerId: target.id, teamId: user.id, round: 1 });
    expect(Math.round(contractApy(after.players[target.id]!.contract!))).toBe(Math.round(contractApy(offer)));
  });

  it('a lowball is countered; re-submitting the counter signs him, ignoring it lets it lapse', () => {
    const { league, userId, playerId } = quietMarket();
    const p = league.players[playerId]!;
    const ask = playerAsk(p, league, league.teams[userId]!, 2027);
    const low = makeFreeAgentOffer(league, userId, playerId, termsFromApy(ask.apy * 0.55, 1, 'backup', 0, 0));
    const r1 = runFreeAgencyRound(league, createRng(3), [low]);
    expect(r1.players[playerId]!.teamId).toBeNull();
    expect(r1.freeAgency!.offers.find((o) => o.id === low.id)!.status).toBe('countered');
    const counter = r1.freeAgency!.offers.find((o) => o.id === `${low.id}-c`)!;
    expect(counter.status).toBe('pending');
    expect(contractApy(counter)).toBeGreaterThan(contractApy(low));
    expect(r1.players[playerId]!.askingSalary).toBeLessThan(playerAsk(p, league, null, 2027).apy);

    const r2 = runFreeAgencyRound(r1, createRng(4), [counter]);
    expect(r2.players[playerId]!.teamId).toBe(userId);
    expect(r2.freeAgency!.signings).toContainEqual({ playerId, teamId: userId, round: 2 });
    expect(rosterErrors(r2)).toEqual([]);

    const lapsed = runFreeAgencyRound(r1, createRng(4), []);
    expect(lapsed.players[playerId]!.teamId).toBeNull();
    expect(lapsed.freeAgency!.offers.find((o) => o.id === counter.id)!.status).toBe('withdrawn');
  });

  it('validates offers at the boundary', () => {
    const { league, userId, playerId } = quietMarket();
    const terms = termsFromApy(2_000_000, 2, 'rotation', 0.3, 0.1);
    expect(() => makeFreeAgentOffer({ ...league, freeAgency: null }, userId, playerId, terms)).toThrow(/not open/);
    const rostered = league.teams[userId]!.rosterIds[0]!;
    expect(() => makeFreeAgentOffer(league, userId, rostered, terms)).toThrow(/not a free agent/);
    const bad = { ...makeFreeAgentOffer(league, userId, playerId, terms), years: 0 };
    expect(() => runFreeAgencyRound(league, createRng(1), [bad])).toThrow(/invalid terms/);
    const huge = makeFreeAgentOffer(league, userId, playerId, termsFromApy(900_000_000, 1, 'franchise', 1, 0));
    const r = runFreeAgencyRound(league, createRng(1), [huge]);
    expect(r.freeAgency!.offers.find((o) => o.id === huge.id)!.status).toBe('withdrawn');
    expect(r.players[playerId]!.teamId).toBeNull();
  });
});
