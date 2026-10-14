import { describe, expect, it } from 'vitest';
import type { CoachId } from '@/core/ids';
import type { Player } from '@/players/types';
import type { Team } from '@/teams/types';
import type { League } from '@/franchise/types';
import { contractApy, createContract, termsFromApy, type ContractTerms } from '@/franchise/contracts';
import { extensionAsk, loyaltyBonus, preferenceScore } from '@/franchise/negotiation';
import {
  TALKS_TUNING, currentTalks, extensionBar, interestEstimate, meetsCounter, negotiationSkill, offerExtension, startingTalkPatience, talksBrokenOff,
} from '@/franchise/extension-talks';
import { atPhase, buildLeague, rosterOf, teamsSorted, withPlayer, withTeam } from './helpers';

const contract = (years: number, signedYear: number, salary: number) =>
  createContract({ salary, years, guaranteed: 0, signingBonus: 0, role: 'starter', year: signedYear });

/** Team #3 with cap room to spare and a happy final-year starter (the player, not the cap, decides). */
const setup = (): { league: League; team: Team; player: Player } => {
  const base = buildLeague({ phase: 'regularSeason', week: 6 });
  const team0 = teamsSorted(base)[3]!;
  const team = { ...team0, finances: { ...team0.finances, capCarryover: 100_000_000 } };
  const star = rosterOf(base, team.id).find((p) => p.overall >= 70 && p.age <= 29)!;
  const player: Player = {
    ...star, traits: [], contract: contract(3, 2024, 2_000_000), morale: { morale: 75, confidence: 70, coachRelationship: 75 },
    preferences: { money: 0.9, playingTime: 0.3, winning: 0.3, location: 0.1, coach: 0.2, role: 0.3, chemistry: 0.1 },
  };
  const league = withTeam(withPlayer(base, player), team);
  return { league, team, player };
};

const lowball = (league: League, team: Team, p: Player): ContractTerms => {
  const ask = extensionAsk(p, league, team, 2026);
  return termsFromApy(ask.apy * 0.4, 1, 'backup', 0, 0);
};
const generous = (league: League, team: Team, p: Player): ContractTerms => {
  const ask = extensionAsk(p, league, team, 2026);
  return termsFromApy(ask.apy * 1.25, ask.years, ask.role, 0.7, 0.25);
};
const margin = (league: League, team: Team, p: Player, terms: ContractTerms): number =>
  preferenceScore(p, team, terms, league, { ask: extensionAsk(p, league, team, 2026), loyalty: loyaltyBonus(p) }) - extensionBar(p, currentTalks(league, p.id, team.id));

describe('extension talks', () => {
  it('counts rounds, wears patience down and raises his bar per round', () => {
    const { league, team, player } = setup();
    const start = currentTalks(league, player.id, team.id)!;
    expect(start).toMatchObject({ rounds: 0, lowballs: 0, brokenOff: false, counter: null });
    expect(start.patience).toBeCloseTo(startingTalkPatience(player), 9);
    const r1 = offerExtension(league, team.id, player.id, lowball(league, team, player));
    expect(r1.accepted).toBe(false);
    const t1 = currentTalks(r1.league, player.id, team.id)!;
    expect(t1.rounds).toBe(1);
    expect(t1.lowballs).toBe(1);
    expect(t1.patience).toBeCloseTo(start.patience - TALKS_TUNING.roundDecay - TALKS_TUNING.lowballDecay, 9);
    expect(t1.counter).toEqual(r1.counter);
    expect(extensionBar(player, t1)).toBeGreaterThan(extensionBar(player, start));
    // Rounds are per season: next year's talks start over.
    const nextYear = { ...r1.league, season: { ...r1.league.season, year: 2027 } };
    expect(currentTalks(nextYear, player.id, team.id)?.rounds).toBe(0);
  });

  it('breaks off after repeated lowballs: morale hit, no talks until the next phase', () => {
    const { league, team, player } = setup();
    let l = league;
    let last = offerExtension(l, team.id, player.id, lowball(l, team, player));
    for (let i = 0; i < 5 && !last.brokeOff; i++) {
      l = last.league;
      last = offerExtension(l, team.id, player.id, lowball(l, team, player));
    }
    expect(last.brokeOff).toBe(true);
    expect(last.reason).toMatch(/^talks: .*broke off/);
    expect(last.counter).toBeNull();
    const after = last.league;
    expect(currentTalks(after, player.id, team.id)?.rounds).toBeLessThanOrEqual(TALKS_TUNING.maxLowballs);
    expect(after.players[player.id]!.morale.morale).toBe(player.morale.morale + TALKS_TUNING.breakMorale);
    expect(after.players[player.id]!.morale.coachRelationship).toBe(player.morale.coachRelationship + TALKS_TUNING.breakCoachRelationship);
    expect(talksBrokenOff(after, player.id, team.id)).toBe(true);
    // Even a generous offer is not heard this phase, and nothing changes.
    const shut = offerExtension(after, team.id, player.id, generous(after, team, player));
    expect(shut.accepted).toBe(false);
    expect(shut.reason).toMatch(/^talks: .*until the next phase/);
    expect(shut.league).toBe(after);
    // Next phase: talks reopen with part of his patience back and the season's rounds still counted.
    const later = atPhase(after, 'playoffs', 1);
    const reopened = currentTalks(later, player.id, team.id)!;
    expect(reopened).toMatchObject({ brokenOff: false, lowballs: 0, patience: TALKS_TUNING.reopenPatience });
    expect(reopened.rounds).toBe(currentTalks(after, player.id, team.id)!.rounds);
    const yes = offerExtension(later, team.id, player.id, generous(later, team, player));
    expect(yes.accepted).toBe(true);
    expect(yes.league.club?.extensionTalks?.[player.id]).toBeUndefined();
  });

  it('close offers wear patience slower than lowballs, and his standing counter is always signed', () => {
    const { league, team, player } = setup();
    const ask = extensionAsk(player, league, team, 2026);
    // An offer a little short of his bar (not a lowball).
    let near: ContractTerms | null = null;
    for (let m = 1.0; m >= 0.5; m -= 0.02) {
      const t = termsFromApy(ask.apy * m, ask.years, ask.role, 0.4, 0.15);
      const g = -margin(league, team, player, t);
      if (g > 0.005 && g < TALKS_TUNING.lowballGap) { near = t; break; }
    }
    expect(near).not.toBeNull();
    const r = offerExtension(league, team.id, player.id, near!);
    expect(r.accepted).toBe(false);
    const t = currentTalks(r.league, player.id, team.id)!;
    expect(t.lowballs).toBe(0);
    expect(t.patience).toBeCloseTo(startingTalkPatience(player) - TALKS_TUNING.roundDecay, 9);
    expect(meetsCounter(r.counter!, r.counter!)).toBe(true);
    expect(contractApy(r.counter!)).toBeGreaterThanOrEqual(ask.apy);
    const signed = offerExtension(r.league, team.id, player.id, r.counter!);
    expect(signed.accepted).toBe(true);
    expect(signed.league.players[player.id]!.contract!.years).toBe(r.counter!.years);
  });

  it('the staff read is banded, noisy and tighter with a better staff; it never reveals the exact bar', () => {
    const { league, team, player } = setup();
    const withStaff = (rating: number): League => {
      const hcId = team.headCoachId as CoachId;
      const hc = league.coaches[hcId]!;
      const coaches: League['coaches'] = { ...league.coaches };
      coaches[hcId] = { ...hc, ratings: { ...hc.ratings, motivation: rating, scouting: rating } };
      for (const id of team.staffIds) {
        const c = coaches[id];
        if (c && id !== hcId) coaches[id] = { ...c, ratings: { ...c.ratings, scouting: Math.min(c.ratings.scouting, rating) } };
      }
      return { ...league, coaches };
    };
    const good = withStaff(99);
    const bad = withStaff(1);
    expect(negotiationSkill(good, team)).toBeGreaterThan(negotiationSkill(bad, team));
    const offer = extensionAsk(player, league, team, 2026);
    const terms = termsFromApy(offer.apy, offer.years, offer.role, 0.4, 0.15);
    const g = interestEstimate(good, team.id, player.id, terms)!;
    const b = interestEstimate(bad, team.id, player.id, terms)!;
    expect(g.noise).toBeLessThan(b.noise);
    // Deterministic within a round (re-checking cannot average the error out).
    expect(interestEstimate(good, team.id, player.id, terms)!.estimate).toBe(g.estimate);
    const truth = margin(league, team, player, terms);
    expect(g.estimate).not.toBe(truth);
    // Across many leagues the good staff's reads sit much closer to the truth.
    let errGood = 0;
    let errBad = 0;
    for (let seed = 1; seed <= 60; seed++) {
      errGood += (interestEstimate({ ...good, rngSeed: seed }, team.id, player.id, terms)!.estimate - truth) ** 2;
      errBad += (interestEstimate({ ...bad, rngSeed: seed }, team.id, player.id, terms)!.estimate - truth) ** 2;
    }
    expect(Math.sqrt(errGood / 60)).toBeLessThan(0.03);
    expect(Math.sqrt(errBad / 60)).toBeGreaterThan(0.04);
    expect(interestEstimate(good, team.id, player.id, generous(good, team, player))!.band).toBe('likely');
    expect(interestEstimate(good, team.id, player.id, lowball(good, team, player))!.band).toBe('far');
    expect(interestEstimate(good, teamsSorted(league)[0]!.id, player.id, terms)).toBeNull();
  });
});
