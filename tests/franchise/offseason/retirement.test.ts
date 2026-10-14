import { describe, expect, it } from 'vitest';
import type { TeamId } from '@/core/ids';
import { createRng } from '@/core/rng';
import { createTradeOffer } from '@/franchise/trades';
import { rosterErrors } from '@/franchise/roster';
import {
  RETIREMENT_CONFIG, ageRetirementChance, coachRetirementChance, retirePlayer, retirePlayers, retirementChance, retirementDecisions,
  runCoachCarousel, runRetirements,
} from '@/franchise/retirement';
import { leagueCapYear } from '@/franchise/contracts';
import type { League } from '@/franchise/types';
import type { InjuryStatus } from '@/players/types';
import { DEPTH_SLOTS } from '@/teams/depth-chart';
import { atPhase, makeLeague, rostered, teamIds, withPlayer } from './helpers';

const offseasonLeague = (seed: number): League => atPhase(makeLeague(seed), 'offseason');

describe('retirement chance', () => {
  it('rises with age along the position curve: running backs early, quarterbacks and kickers late', () => {
    expect(ageRetirementChance('RB', 25)).toBe(0);
    expect(ageRetirementChance('RB', 38)).toBeGreaterThan(0.9);
    expect(ageRetirementChance('RB', 32)).toBeGreaterThan(ageRetirementChance('QB', 32) * 5);
    expect(ageRetirementChance('K', 36)).toBeLessThan(ageRetirementChance('WR', 36));
  });

  it('a 38-year-old RB retires far more often than a 25-year-old across 200 seeds', () => {
    let league = offseasonLeague(41);
    const [t1, t2] = teamIds(league) as [TeamId, TeamId];
    const old = { ...rostered(league, t1, 'RB'), age: 38, injury: null, injuryHistory: [] };
    const young = { ...rostered(league, t2, 'RB'), age: 25, injury: null, injuryHistory: [] };
    league = withPlayer(withPlayer(league, old), young);
    let oldCount = 0, youngCount = 0;
    for (let seed = 1; seed <= 200; seed++) {
      const ids = new Set(retirementDecisions(league, createRng(seed)).map((d) => d.playerId));
      if (ids.has(old.id)) oldCount++;
      if (ids.has(young.id)) youngCount++;
    }
    expect(oldCount).toBeGreaterThan(140);
    expect(youngCount).toBeLessThan(10);
    expect(oldCount).toBeGreaterThan(youngCount * 10);
  });

  it('is shaped by injuries, contract status and a championship', () => {
    const league = offseasonLeague(42);
    const [t1] = teamIds(league) as [TeamId];
    const wr = { ...rostered(league, t1, 'WR'), age: 31, overall: 75, traits: [], injury: null, injuryHistory: [], progressionLog: [] };
    const base = retirementChance(league, wr).chance;
    const ct: InjuryStatus = { bodyArea: 'lowerBody', severity: 'careerThreatening', weeksRemaining: 20, permanentPenalty: null, occurredYear: league.season.year, occurredWeek: 9 };
    expect(retirementChance(league, { ...wr, injury: ct }).chance).toBeGreaterThan(base + 0.1);
    const young = { ...wr, age: 24 };
    expect(retirementChance(league, young).chance).toBe(0);
    expect(retirementChance(league, { ...young, injury: ct }).chance).toBeGreaterThan(0.2);
    const unsigned = retirementChance(league, { ...wr, teamId: null, contract: null }).chance;
    expect(unsigned).toBeGreaterThan(base);
    const champs = { ...league, season: { ...league.season, champion: t1 } };
    expect(retirementChance(champs, wr).chance).toBeGreaterThan(base);
  });

  it('washes out unsigned free agents with no games, a low overall and little upside, at any age', () => {
    const league = offseasonLeague(43);
    const [t1] = teamIds(league) as [TeamId];
    const base = rostered(league, t1, 'OG', 2);
    const cfg = RETIREMENT_CONFIG;
    const scrub = { ...base, age: 23, overall: cfg.washoutOverall - 5, potential: cfg.washoutPotential - 5, teamId: null, contract: null, traits: [] };
    const out = retirementChance(league, scrub);
    expect(out.chance).toBeCloseTo(cfg.washoutChance, 5);
    expect(out.reasons).toContain('washout');
    // upside, a roster spot or games played this season keep him in the league
    expect(retirementChance(league, { ...scrub, potential: cfg.washoutPotential + 5 }).chance).toBe(0);
    expect(retirementChance(league, { ...scrub, teamId: t1 }).chance).toBe(0);
    const played = { ...league, season: { ...league.season, stats: { [scrub.id]: { ...(league.season.stats[scrub.id] ?? {}), gamesPlayed: 3 } } } } as League;
    expect(retirementChance(played, scrub).reasons).not.toContain('washout');
  });
});

describe('retirePlayer', () => {
  it('moves the player out of players, rosters, depth charts and free agency; voids the contract; books bonus dead money', () => {
    let league = offseasonLeague(43);
    const [t1, t2] = teamIds(league) as [TeamId, TeamId];
    const capYear = leagueCapYear(league);
    const star = rostered(league, t1, 'QB');
    const contract = { salary: 20_000_000, years: 4, yearsRemaining: 3, guaranteed: 30_000_000, signingBonus: 20_000_000, role: 'franchise' as const, signedYear: capYear - 1, restructured: false, tag: null };
    league = withPlayer(league, { ...star, contract });
    const offer = { ...createTradeOffer(league, t1, t2, [{ kind: 'player', playerId: star.id }], []), status: 'pending' as const };
    league = { ...league, pendingTrades: [offer] };
    const deadBefore = league.teams[t1]!.finances.deadMoney[capYear] ?? 0;
    const out = retirePlayer(league, star.id);
    expect(out.players[star.id]).toBeUndefined();
    expect(out.retiredPlayers[star.id]).toMatchObject({ retired: true, teamId: null, contract: null });
    expect(out.teams[t1]!.rosterIds).not.toContain(star.id);
    for (const slot of DEPTH_SLOTS) expect(out.teams[t1]!.depthChart[slot]).not.toContain(star.id);
    expect(out.freeAgentIds).not.toContain(star.id);
    expect(out.teams[t1]!.finances.deadMoney[capYear]).toBe(deadBefore + 15_000_000);
    expect(out.pendingTrades[0]?.status).toBe('withdrawn');
    expect(rosterErrors(out)).toEqual([]);
    expect(retirePlayer(out, star.id)).toBe(out);
    expect(() => retirePlayer(out, 'p_nobody' as typeof star.id)).toThrow(/unknown player/);
  });

  it('retires free agents out of the free-agent list', () => {
    const league = offseasonLeague(44);
    const fa = league.freeAgentIds[0]!;
    const { league: out, retired } = retirePlayers(league, [fa]);
    expect(out.freeAgentIds).not.toContain(fa);
    expect(out.retiredPlayers[fa]).toBeDefined();
    expect(retired[0]?.teamId).toBeNull();
    expect(rosterErrors(out)).toEqual([]);
  });

  it('counts pre-league years in the seasons a retiree played', () => {
    const base = offseasonLeague(45);
    const vet = { ...rostered(base, teamIds(base)[0] as TeamId, 'QB'), experience: 11 };
    const league = withPlayer(base, vet);
    expect(league.careerStats[vet.id]?.seasons.length ?? 0).toBeLessThan(11);
    expect(retirePlayers(league, [vet.id]).retired[0]?.seasons).toBe(11);
  });

  it('runRetirements retires a plausible share of the league and keeps it consistent', () => {
    const league = offseasonLeague(45);
    const { league: out, retired } = runRetirements(league, createRng(9));
    const active = Object.keys(league.players).length;
    expect(retired.length).toBeGreaterThan(active * 0.02);
    expect(retired.length).toBeLessThan(active * 0.15);
    expect(Object.keys(out.players).length + retired.length).toBe(active);
    for (const r of retired) expect(out.retiredPlayers[r.playerId]).toBeDefined();
    expect(rosterErrors(out)).toEqual([]);
    expect(runRetirements(league, createRng(9)).retired).toEqual(retired);
  });
});

describe('coach carousel', () => {
  it('ages staff, retires old coaches and hires a replacement for the same role', () => {
    let league = offseasonLeague(46);
    const [t1] = teamIds(league) as [TeamId];
    const hcId = league.teams[t1]!.headCoachId!;
    league = { ...league, coaches: { ...league.coaches, [hcId]: { ...league.coaches[hcId]!, age: 72 } } };
    const cfg = { ...RETIREMENT_CONFIG, coach: { ...RETIREMENT_CONFIG.coach, minAge: 70, perYearOver: 1, maxChance: 1, baseChance: 0 } };
    expect(coachRetirementChance({ age: 73 }, cfg)).toBe(1);
    const { league: out, moves } = runCoachCarousel(league, createRng(3), cfg);
    expect(moves).toHaveLength(1);
    expect(moves[0]).toMatchObject({ retiredId: hcId, teamId: t1, role: 'HC' });
    const hire = out.coaches[moves[0]!.replacementId!]!;
    expect(out.teams[t1]!.headCoachId).toBe(hire.id);
    expect(hire).toMatchObject({ role: 'HC', teamId: t1 });
    expect(out.teams[t1]!.staffIds).not.toContain(hcId);
    expect(out.coaches[hcId]).toMatchObject({ teamId: null, age: 73 });
    expect(out.offseasonFlags?.retiredCoaches).toContain(hcId);
    const someone = Object.values(league.coaches).find((c) => c.id !== hcId)!;
    expect(out.coaches[someone.id]!.age).toBe(someone.age + 1);
  });
});
