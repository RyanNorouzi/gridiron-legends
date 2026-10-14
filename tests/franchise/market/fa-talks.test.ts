import { describe, expect, it } from 'vitest';
import type { PlayerId, TeamId } from '@/core/ids';
import { createRng } from '@/core/rng';
import { leagueCapYear, minimumSalaryFor, type ContractTerms } from '@/franchise/contracts';
import { TALKS_TUNING } from '@/franchise/extension-talks';
import {
  FA_TALKS, faInterestEstimate, faPatienceText, faTalks, freshFaTalks, marketBar, recordRefusal, talksBar, walkedAway,
} from '@/franchise/fa-talks';
import { isFreeAgencyOpen, makeFreeAgentOffer, runFreeAgencyRound, startFreeAgency } from '@/franchise/free-agency';
import { playerAsk, preferenceScore } from '@/franchise/negotiation';
import type { League } from '@/franchise/types';
import { runAiResigning } from '@/franchise/gm/roster-ai';
import type { Player } from '@/players/types';
import type { Team } from '@/teams/types';
import { atPhase, buildLeague, teamByAbbr } from './helpers';

const openMarket = (seed: number): { league: League; user: TeamId } => {
  const base = buildLeague({ seed, userTeamAbbr: 'BOS' });
  const resigned = runAiResigning(atPhase(base, 'resigning'), createRng(seed + 1));
  return { league: startFreeAgency(atPhase(resigned, 'freeAgency')), user: teamByAbbr(base, 'BOS').id };
};

/** A rock-bottom offer: league minimum, one year, developmental role, nothing guaranteed. */
const lowball = (league: League, p: Player): ContractTerms => ({ salary: minimumSalaryFor(p.experience, league.settings), years: 1, guaranteed: 0, signingBonus: 0, role: 'developmental' });

/**
 * A free agent nobody else bids on in round 1 (a dry run of the round without user offers) for whom the rock-bottom
 * offer is a true lowball (score more than lowballGap under his bar).
 */
const quietLowballTarget = (league: League, user: TeamId): Player => {
  const dry = runFreeAgencyRound(league, createRng(5));
  const bidOn = new Set((dry.freeAgency?.offers ?? []).map((o) => o.playerId));
  const team = league.teams[user] as Team;
  const ask = (p: Player) => playerAsk(p, league, team, leagueCapYear(league));
  const target = league.freeAgentIds.map((id) => league.players[id] as Player).find((p) => p && !bidOn.has(p.id) && p.overall >= 50
    && marketBar(p, league.freeAgency) - preferenceScore(p, team, lowball(league, p), league, { ask: ask(p) }) > FA_TALKS.lowballGap + 0.05);
  if (!target) throw new Error('no quiet lowball target');
  return target;
};

describe('recordRefusal', () => {
  it('wears patience down per refused round, more for lowballs, and walks away at the limit', () => {
    const t0 = { teamId: 't' as TeamId, playerId: 'p' as PlayerId, rounds: 0, lowballs: 0, patience: 1, walkedAway: false, lastRound: 0 };
    const near = recordRefusal(t0, 0.6, 0.62, 1);
    expect(near.lowball).toBe(false);
    expect(near.talks).toMatchObject({ rounds: 1, lowballs: 0, walkedAway: false, lastRound: 1 });
    expect(near.talks.patience).toBeCloseTo(1 - FA_TALKS.roundDecay, 9);
    const low = recordRefusal(near.talks, 0.4, 0.62, 2);
    expect(low.lowball).toBe(true);
    expect(low.talks.patience).toBeCloseTo(1 - 2 * FA_TALKS.roundDecay - FA_TALKS.lowballDecay, 9);
    expect(low.walkedAway).toBe(false);
    const gone = recordRefusal(low.talks, 0.4, 0.62, 3);
    expect(gone.walkedAway).toBe(true);
    expect(gone.talks.walkedAway).toBe(true);
    expect(recordRefusal({ ...t0, patience: 0.1 }, 0.6, 0.62, 1).walkedAway).toBe(true);
    expect(faPatienceText(gone.talks)).toBe('Walked away');
    expect(faPatienceText(t0)).toBe('Patient');
  });
});

describe('free-agent talks', () => {
  it('reads offers as noisy bands, stable within a round, never the exact margin', () => {
    const { league, user } = openMarket(21);
    const team = league.teams[user] as Team;
    const p = league.freeAgentIds.map((id) => league.players[id] as Player).find((x) => x.overall >= 65) as Player;
    const ask = playerAsk(p, league, team, leagueCapYear(league));
    const read = faInterestEstimate(league, user, p.id, ask);
    expect(read).not.toBeNull();
    expect(read!.noise).toBeGreaterThanOrEqual(TALKS_TUNING.noiseBest);
    expect(read!.noise).toBeLessThanOrEqual(TALKS_TUNING.noiseWorst);
    const margin = preferenceScore(p, team, ask, league, { ask }) - talksBar(p, league.freeAgency, null);
    expect(read!.estimate).not.toBe(margin);
    expect(faInterestEstimate(league, user, p.id, ask)).toEqual(read);
    const rich = faInterestEstimate(league, user, p.id, { ...ask, salary: ask.salary * 3, signingBonus: ask.signingBonus * 3, role: 'franchise' });
    expect(rich!.estimate).toBeGreaterThan(read!.estimate);
    expect(['likely', 'close', 'far']).toContain(read!.band);
    const rostered = (league.teams[user] as Team).rosterIds[0] as PlayerId;
    expect(faInterestEstimate(league, user, rostered, ask)).toBeNull();
    // A new bidding round draws a new error.
    const r2 = { ...league, freeAgency: { ...league.freeAgency!, round: 2 } };
    expect(faInterestEstimate(r2, user, p.id, ask)!.estimate).not.toBe(read!.estimate);
  });

  it('refused lowballs raise his bar, wear his patience down and make him walk away; later offers are withdrawn', () => {
    const { league, user } = openMarket(21);
    const p = quietLowballTarget(league, user);
    expect(faTalks(league, user, p.id)).toEqual(freshFaTalks(p, user));
    let l = league;
    let rounds = 0;
    while (!walkedAway(l, user, p.id) && isFreeAgencyOpen(l) && rounds < 4) {
      l = runFreeAgencyRound(l, createRng(5 + rounds), [makeFreeAgentOffer(l, user, p.id, lowball(l, l.players[p.id] as Player))]);
      rounds++;
      if (l.players[p.id]?.teamId !== null) throw new Error('target signed somewhere');
    }
    const t = faTalks(l, user, p.id)!;
    expect(t.walkedAway).toBe(true);
    expect(t.lowballs).toBe(FA_TALKS.maxLowballs);
    expect(t.rounds).toBe(rounds);
    expect(rounds).toBeLessThanOrEqual(FA_TALKS.maxLowballs);
    expect(talksBar(p, l.freeAgency, t)).toBeCloseTo(marketBar(p, l.freeAgency) + FA_TALKS.barPerRound * t.rounds, 9);
    // No standing counter to the team he walked away from.
    expect((l.freeAgency?.offers ?? []).some((o) => o.teamId === user && o.playerId === p.id && o.status === 'pending')).toBe(false);
    // A generous offer now never reaches him.
    const rich = { ...lowball(l, p), salary: 20_000_000, years: 3, role: 'starter' as const };
    const offer = makeFreeAgentOffer(l, user, p.id, rich);
    const after = runFreeAgencyRound(l, createRng(99), [offer]);
    expect(after.freeAgency?.offers.find((o) => o.id === offer.id)?.status).toBe('withdrawn');
    expect(after.players[p.id]?.teamId).not.toBe(user);
  });

  it('a fair first offer that clears his bar signs exactly as before (no talks recorded)', () => {
    const { league, user } = openMarket(22);
    const p = quietLowballTarget(league, user);
    const team = league.teams[user] as Team;
    const ask = playerAsk(p, league, team, leagueCapYear(league));
    const generous: ContractTerms = { salary: Math.round(ask.salary * 1.5), years: ask.years, guaranteed: ask.guaranteed, signingBonus: ask.signingBonus, role: 'starter' };
    const l = runFreeAgencyRound(league, createRng(5), [makeFreeAgentOffer(league, user, p.id, generous)]);
    expect(l.players[p.id]?.teamId).toBe(user);
    expect(l.freeAgency?.talks).toBeUndefined();
  });

  it('accepting his own counter is never a refused talks round (no patience lost, no walk-away)', () => {
    const { league, user } = openMarket(21);
    const team = league.teams[user] as Team;
    const targets = league.freeAgentIds.map((id) => league.players[id] as Player).filter((p) => p.overall >= 55).slice(0, 25);
    const offers = targets.map((p) => {
      const ask = playerAsk(p, league, team, leagueCapYear(league));
      return makeFreeAgentOffer(league, user, p.id, { ...ask, salary: Math.round(ask.salary * 0.85) });
    });
    const r1 = runFreeAgencyRound(league, createRng(21 * 7), offers);
    const counters = (r1.freeAgency?.offers ?? []).filter((o) => o.teamId === user && o.status === 'pending' && o.id.endsWith('-c'));
    expect(counters.length).toBeGreaterThan(0);
    // The user takes every counter (what fa-model.acceptCounter submits: the counter moved to this round).
    const round = r1.freeAgency!.round;
    const taken = counters.map((c) => ({ ...c, round }));
    const r1Taken = { ...r1, freeAgency: { ...r1.freeAgency!, offers: r1.freeAgency!.offers.map((o) => taken.find((t) => t.id === o.id) ?? o) } };
    const r2 = runFreeAgencyRound(r1Taken, createRng(21 * 11), taken);
    const unsigned = counters.filter((c) => r2.players[c.playerId]?.teamId !== user);
    for (const c of counters) {
      expect(faTalks(r2, user, c.playerId)).toEqual(faTalks(r1, user, c.playerId));
      expect(walkedAway(r2, user, c.playerId)).toBe(false);
    }
    // Some counters still fail (outbid, or short of his market bar), so the no-penalty rule was exercised.
    expect(unsigned.length).toBeGreaterThan(0);
  });

  it('AI-only rounds keep no talks', () => {
    const { league } = openMarket(23);
    const l = runFreeAgencyRound(league, createRng(1));
    expect(l.freeAgency?.talks).toBeUndefined();
  });
});
