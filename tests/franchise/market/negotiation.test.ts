import { describe, expect, it } from 'vitest';
import type { PlayerId } from '@/core/ids';
import type { Player, PlayerPreferences } from '@/players/types';
import type { Team } from '@/teams/types';
import type { League } from '@/franchise/types';
import { contractApy, createContract, minimumSalaryFor, termsFromApy } from '@/franchise/contracts';
import type { ContractTerms } from '@/franchise/contracts';
import {
  acceptThreshold, counterOffer, desiredYears, expectedRole, extensionAsk, holdoutRisk, marketSalary, playerAsk,
  playerPatience, preferenceBreakdown, preferenceScore, wantsExtension, willAccept,
} from '@/franchise/negotiation';
import { offerExtension } from '@/franchise/extension-talks';
import { makePlayer } from '../../players/helpers';
import type { PlayerOverrides } from '../../players/helpers';
import { CAP, atPhase, buildLeague, rosterOf, teamsSorted, withPlayer, withTeam } from './helpers';

const prefs = (over: Partial<PlayerPreferences>): PlayerPreferences =>
  ({ money: 0, playingTime: 0, winning: 0, location: 0, coach: 0, role: 0, chemistry: 0, ...over });

const freeAgent = (over: PlayerOverrides = {}): Player =>
  makePlayer({ id: 'p_fa01' as PlayerId, position: 'WR', attrValue: 80, age: 27, experience: 5, homeRegion: 'zz_nowhere', ...over });

const at = (ask: { apy: number; years: number; role: ContractTerms['role'] }, mult: number): ContractTerms =>
  termsFromApy(ask.apy * mult, ask.years, ask.role, 0.5, 0.2);

/** Two neutral teams (same rating/chemistry/market/coach) that differ only where a test changes them. */
const twins = (league: League): [Team, Team] => {
  const [a0, b0] = teamsSorted(league);
  const common = { overall: 70, chemistry: 50, marketSize: 'medium' as const, region: 'zz_other', history: [], headCoachId: a0!.headCoachId };
  return [{ ...a0!, ...common }, { ...b0!, ...common }];
};

describe('asks', () => {
  it('asks scale with quality, position and the cap, never below the minimum', () => {
    const league = atPhase(buildLeague(), 'freeAgency');
    const star = playerAsk(freeAgent({ attrValue: 90 }), league, null, 2027);
    const mid = playerAsk(freeAgent({ attrValue: 75 }), league, null, 2027);
    const scrub = playerAsk(freeAgent({ attrValue: 45, experience: 0 }), league, null, 2027);
    expect(star.apy).toBeGreaterThan(mid.apy * 2);
    expect(scrub.apy).toBe(minimumSalaryFor(0, league.settings));
    const qb = playerAsk(freeAgent({ attrValue: 85, position: 'QB' }), league, null, 2027);
    const k = playerAsk(freeAgent({ attrValue: 85, position: 'K' }), league, null, 2027);
    expect(qb.apy).toBeGreaterThan(k.apy * 4);
    const richer = { ...league, settings: { ...league.settings, salaryCap: CAP * 1.5 } };
    expect(playerAsk(freeAgent({ attrValue: 85 }), richer, null, 2027).apy).toBeGreaterThan(playerAsk(freeAgent({ attrValue: 85 }), league, null, 2027).apy * 1.3);
    expect(Math.abs(contractApy(star) - star.apy)).toBeLessThan(20_000);
    expect(star.role).toBe('franchise');
    expect(marketSalary(freeAgent({ attrValue: 85, age: 34 }), CAP)).toBeLessThan(marketSalary(freeAgent({ attrValue: 85, age: 27 }), CAP));
  });

  it('asks decay round by round during free agency, down to the floor', () => {
    const base = atPhase(buildLeague(), 'freeAgency');
    const p = freeAgent({ attrValue: 82, teamId: null });
    const round = (r: number): number => playerAsk(p, { ...base, freeAgency: { round: r, maxRounds: 10, offers: [], signings: [] } }, null, 2027).apy;
    expect(round(2)).toBeLessThan(round(1));
    expect(round(3)).toBeLessThan(round(2));
    expect(round(10)).toBeGreaterThanOrEqual(round(1) * 0.54);
    const closed = playerAsk(p, { ...base, freeAgency: { round: 11, maxRounds: 10, offers: [], signings: [] } }, null, 2027).apy;
    expect(closed).toBeLessThan(round(1) * 0.6);
    expect(playerAsk({ ...p, teamId: teamsSorted(base)[0]!.id }, { ...base, freeAgency: { round: 11, maxRounds: 10, offers: [], signings: [] } }, null, 2027).apy).toBe(round(1));
  });

  it('young players want long deals, veterans short ones; roles follow overall', () => {
    expect(desiredYears({ age: 24, overall: 88 })).toBe(5);
    expect(desiredYears({ age: 34, overall: 88 })).toBe(1);
    expect(expectedRole({ overall: 88, potential: 90, age: 27 })).toBe('franchise');
    expect(expectedRole({ overall: 60, potential: 80, age: 22 })).toBe('developmental');
    expect(expectedRole({ overall: 58, potential: 60, age: 29 })).toBe('backup');
  });
});

describe('preferences', () => {
  it('a money-driven player takes the richer offer', () => {
    const league = atPhase(buildLeague(), 'freeAgency');
    const [a, b] = twins(league);
    const p = freeAgent({ preferences: prefs({ money: 1 }) });
    const ask = playerAsk(p, league, a, 2027);
    const rich = at(ask, 1.25);
    const fair = at(ask, 1.0);
    const best = contractApy(rich);
    const sRich = preferenceScore(p, a, rich, league, { ask, bestCompetingApy: best });
    const sFair = preferenceScore(p, b, fair, league, { ask, bestCompetingApy: best });
    expect(sRich).toBeGreaterThan(sFair + 0.15);
    expect(preferenceBreakdown(p, a, at(ask, 0.7), league, { ask }).money).toBeLessThan(0.3);
  });

  it('a location-driven player prefers his home region on equal money', () => {
    const league = atPhase(buildLeague(), 'freeAgency');
    const [a, b] = twins(league);
    const home = { ...a, region: 'south' };
    const p = freeAgent({ homeRegion: 'south', preferences: prefs({ location: 1 }) });
    const ask = playerAsk(p, league, home, 2027);
    const offer = at(ask, 1.0);
    expect(preferenceScore(p, home, offer, league, { ask })).toBeGreaterThan(preferenceScore(p, b, offer, league, { ask }) + 0.3);
    expect(preferenceBreakdown(p, { ...b, marketSize: 'large' }, offer, league, { ask }).location)
      .toBeGreaterThan(preferenceBreakdown(p, { ...b, marketSize: 'small' }, offer, league, { ask }).location);
  });

  it('a winning-driven player prefers the contender', () => {
    const base = atPhase(buildLeague(), 'freeAgency');
    const [a, b] = twins(base);
    const contender: Team = { ...a, overall: 84, history: [{ year: 2026, wins: 13, losses: 4, ties: 0, madePlayoffs: true, playoffResult: null, champion: false }] };
    const cellar: Team = { ...b, overall: 62, history: [{ year: 2026, wins: 3, losses: 14, ties: 0, madePlayoffs: false, playoffResult: null, champion: false }] };
    const league = withTeam(withTeam(base, contender), cellar);
    const p = freeAgent({ preferences: prefs({ winning: 1 }) });
    const ask = playerAsk(p, league, contender, 2027);
    const offer = at(ask, 1.0);
    expect(preferenceScore(p, contender, offer, league, { ask })).toBeGreaterThan(preferenceScore(p, cellar, offer, league, { ask }) + 0.3);
  });

  it('playing time, role and coach preferences respond to the team', () => {
    const league = atPhase(buildLeague(), 'freeAgency');
    const [a] = twins(league);
    const scrub = freeAgent({ attrValue: 30, preferences: prefs({ playingTime: 1 }) });
    const star = freeAgent({ attrValue: 95, preferences: prefs({ playingTime: 1 }) });
    const ask = playerAsk(star, league, a, 2027);
    expect(preferenceBreakdown(star, a, at(ask, 1), league, { ask }).playingTime).toBe(1);
    expect(preferenceBreakdown(scrub, a, at(ask, 1), league, { ask }).playingTime).toBeLessThan(0.5);
    const backupRole = { ...at(ask, 1), role: 'backup' as const };
    expect(preferenceBreakdown(star, a, backupRole, league, { ask }).role).toBeLessThan(0.2);
    const hc = league.coaches[a.headCoachId!]!;
    const ratings = (v: number) => ({ offense: v, defense: v, playerDevelopment: v, motivation: v, gameManagement: v, scouting: v, conditioning: v });
    const great = { ...league, coaches: { ...league.coaches, [hc.id]: { ...hc, ratings: ratings(95), traits: ['playersCoach' as const] } } };
    const poor = { ...league, coaches: { ...league.coaches, [hc.id]: { ...hc, ratings: ratings(35), traits: ['disciplinarian' as const] } } };
    const hothead = { ...star, traits: ['hotHeaded' as const] };
    expect(preferenceBreakdown(hothead, a, at(ask, 1), great, { ask }).coach).toBeGreaterThan(preferenceBreakdown(hothead, a, at(ask, 1), poor, { ask }).coach + 0.4);
  });

  it('acceptance bar falls with patience, which fades round by round', () => {
    expect(acceptThreshold(0)).toBeCloseTo(0.42, 5);
    expect(acceptThreshold(1)).toBeCloseTo(0.7, 5);
    expect(willAccept(0.6, 0)).toBe(true);
    expect(willAccept(0.6, 1)).toBe(false);
    const star = freeAgent({ attrValue: 90 });
    expect(playerPatience(star, 1, 5)).toBeGreaterThan(playerPatience(star, 3, 5));
    expect(playerPatience(star, 5, 5)).toBe(0);
    expect(playerPatience(star, 1, 5)).toBeGreaterThan(playerPatience(freeAgent({ attrValue: 70, age: 32 }), 1, 5));
  });

  it('counterOffer asks at least his number with his preferred length', () => {
    const league = atPhase(buildLeague(), 'freeAgency');
    const [a] = twins(league);
    const p = freeAgent({ attrValue: 84, teamId: null });
    const ask = playerAsk(p, league, a, 2027);
    const low = { id: 'fa-x', teamId: a.id, playerId: p.id, ...at(ask, 0.7), years: 1, round: 1, status: 'pending' as const };
    const c = counterOffer(p, a, low, league, 2027);
    expect(c.id).toBe('fa-x-c');
    expect(c.status).toBe('pending');
    expect(contractApy(c)).toBeGreaterThanOrEqual(ask.apy - 20_000);
    expect(c.years).toBe(ask.years);
    expect(preferenceScore(p, a, c, league, { ask })).toBeGreaterThan(preferenceScore(p, a, low, league, { ask }));
  });
});

describe('extensions and holdouts', () => {
  const contract = (years: number, signedYear: number, salary: number) =>
    createContract({ salary, years, guaranteed: 0, signingBonus: 0, role: 'starter', year: signedYear });

  it('wantsExtension: final-year regulars and badly underpaid stars', () => {
    expect(wantsExtension(freeAgent({ attrValue: 72, contract: contract(3, 2024, 2_000_000) }), 2026)).toBe(true);
    expect(wantsExtension(freeAgent({ attrValue: 72, contract: contract(4, 2026, 2_000_000) }), 2026)).toBe(false);
    expect(wantsExtension(freeAgent({ attrValue: 60, contract: contract(3, 2024, 2_000_000) }), 2026)).toBe(false);
    const underpaid = freeAgent({ attrValue: 88, contract: contract(4, 2024, 1_000_000) });
    expect(wantsExtension(underpaid, 2026)).toBe(false);
    expect(wantsExtension(underpaid, 2026, CAP)).toBe(true);
    expect(wantsExtension(freeAgent({ attrValue: 80, age: 35, contract: contract(3, 2024, 2_000_000) }), 2026)).toBe(false);
  });

  it('holdout pressure grows with underpayment and temperament', () => {
    const league = buildLeague();
    const hot = freeAgent({ attrValue: 90, age: 26, experience: 5, traits: ['hotHeaded'], contract: contract(4, 2025, 1_000_000) });
    const calm = { ...hot, traits: ['teamPlayer' as const] };
    const paid = { ...hot, contract: contract(4, 2025, 60_000_000) };
    expect(holdoutRisk(hot, league, 2026)).toBeGreaterThan(holdoutRisk(calm, league, 2026));
    expect(holdoutRisk(paid, league, 2026)).toBe(0);
    const team = teamsSorted(league)[0]!;
    const finalYear = freeAgent({ attrValue: 80, contract: contract(3, 2024, 3_000_000), teamId: team.id });
    expect(extensionAsk(finalYear, league, team, 2026).apy).toBeGreaterThan(playerAsk(finalYear, league, team, 2026).apy);
  });

  it('offerExtension: a fair offer is signed, a lowball gets his counter terms', () => {
    const base = buildLeague({ phase: 'regularSeason', week: 6 });
    const team0 = teamsSorted(base)[3]!;
    // Plenty of cap room, so the player (not the cap check) decides.
    const team = { ...team0, finances: { ...team0.finances, capCarryover: 100_000_000 } };
    const star = rosterOf(base, team.id).find((p) => p.overall >= 70 && p.age <= 29)!;
    const player = { ...star, contract: contract(3, 2024, 2_000_000), morale: { morale: 75, confidence: 70, coachRelationship: 75 } };
    const league = withTeam(withPlayer(base, player), team);
    const ask = extensionAsk(player, league, team, 2026);
    const yes = offerExtension(league, team.id, player.id, termsFromApy(ask.apy * 1.2, ask.years, ask.role, 0.6, 0.25));
    expect(yes.accepted).toBe(true);
    expect(yes.league.players[player.id]!.contract!.signedYear).toBe(2026);
    expect(yes.league.players[player.id]!.contract!.years).toBe(ask.years);
    expect(league.players[player.id]!.contract).toEqual(player.contract);
    const no = offerExtension(league, team.id, player.id, termsFromApy(ask.apy * 0.4, 1, 'backup', 0, 0));
    expect(no.accepted).toBe(false);
    // The refusal is a recorded round of talks (extension-talks.ts); nothing else about the League changes.
    expect(no.league.players).toBe(league.players);
    expect(no.league.club?.extensionTalks?.[player.id]?.rounds).toBe(1);
    expect(contractApy(no.counter!)).toBeGreaterThanOrEqual(ask.apy - 20_000);
    expect(() => offerExtension(league, teamsSorted(base)[0]!.id, player.id, no.counter!)).toThrow(/not under contract/);
  });
});
