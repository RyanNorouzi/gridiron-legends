import { describe, expect, it } from 'vitest';
import type { Team } from '@/teams/types';
import type { League } from '@/franchise/types';
import { capSpace, createContract, projectedCapSpace, termsFromApy } from '@/franchise/contracts';
import { extensionAsk, extensionCapIssue } from '@/franchise/negotiation';
import { offerExtension } from '@/franchise/extension-talks';
import { buildLeague, rosterOf, teamsSorted, withPlayer, withTeam } from './helpers';

const contract = (years: number, signedYear: number, salary: number) =>
  createContract({ salary, years, guaranteed: 0, signingBonus: 0, role: 'starter', year: signedYear });

/** A league whose team #3 has a happy final-year starter, and the dead money needed to leave `room` dollars of cap
 *  space in 2026 (and `roomNext` in 2027, default the same). */
const setup = (room: number, roomNext = room): { league: League; team: Team; playerId: string } => {
  const base = buildLeague({ phase: 'regularSeason', week: 6 });
  const team0 = teamsSorted(base)[3]!;
  const star = rosterOf(base, team0.id).find((p) => p.overall >= 70 && p.age <= 29)!;
  let league = withPlayer(base, { ...star, contract: contract(3, 2024, 2_000_000), morale: { morale: 75, confidence: 70, coachRelationship: 75 } });
  const [now, next] = projectedCapSpace(team0, league.players, league.settings, 2026, 2);
  const dead = { ...team0.finances.deadMoney, 2026: (team0.finances.deadMoney[2026] ?? 0) + now!.space - room, 2027: (team0.finances.deadMoney[2027] ?? 0) + next!.space - roomNext };
  league = withTeam(league, { ...team0, finances: { ...team0.finances, deadMoney: dead } });
  return { league, team: league.teams[team0.id]!, playerId: star.id };
};

describe('offerExtension cap check', () => {
  it('refuses a deal that would put the team over the cap this year, with a reason and no counter', () => {
    const { league, team, playerId } = setup(1_000_000);
    const player = league.players[playerId as never]!;
    const ask = extensionAsk(player, league, team, 2026);
    const terms = termsFromApy(Math.max(ask.apy * 1.2, 20_000_000), ask.years, ask.role, 0.6, 0.25);
    const r = offerExtension(league, team.id, player.id, terms);
    expect(r.accepted).toBe(false);
    expect(r.counter).toBeNull();
    expect(r.league).toBe(league);
    expect(r.reason).toMatch(/^cap: .* over the 2026 cap/);
    expect(extensionCapIssue(league, team.id, player, terms)).not.toBeNull();
  });

  it('refuses a deal that only breaks next year\'s cap (back-loaded)', () => {
    const { league: tight, team: t, playerId } = setup(60_000_000, 1_000_000);
    const player = tight.players[playerId as never]!;
    expect(capSpace(t, tight.players, tight.settings, 2026)).toBe(60_000_000);
    // $10M a year for three years: fits the $60M of 2026 room, not the $1M of 2027.
    const terms = termsFromApy(10_000_000, 3, 'starter', 0.5, 0.2);
    expect(extensionCapIssue(tight, t.id, player, terms)).toMatch(/over the 2027 cap/);
    const r = offerExtension(tight, t.id, player.id, terms);
    expect(r.accepted).toBe(false);
    expect(r.reason).toMatch(/over the 2027 cap/);
  });

  it('lets a deal that fits both cap years through to the player (who signs a fair one)', () => {
    const { league, team, playerId } = setup(150_000_000);
    const player = league.players[playerId as never]!;
    const ask = extensionAsk(player, league, team, 2026);
    const terms = termsFromApy(ask.apy * 1.2, ask.years, ask.role, 0.6, 0.25);
    expect(extensionCapIssue(league, team.id, player, terms)).toBeNull();
    const r = offerExtension(league, team.id, player.id, terms);
    expect(r.accepted).toBe(true);
    expect(r.reason).toBeNull();
    const after = r.league.teams[team.id]!;
    expect(capSpace(after, r.league.players, r.league.settings, 2026)).toBeGreaterThanOrEqual(0);
  });

  it('does not block a team already over the cap from a deal that does not make it worse', () => {
    const { league, team, playerId } = setup(-5_000_000);
    const player = league.players[playerId as never]!;
    // Same salary as today for one year: the cap hit is unchanged.
    const r = offerExtension(league, team.id, player.id, { salary: 2_000_000, years: 1, guaranteed: 0, signingBonus: 0, role: 'starter' });
    expect(r.reason ?? null).toBeNull();
    expect(extensionCapIssue(league, team.id, player, { salary: 2_000_000, years: 1, guaranteed: 0, signingBonus: 0, role: 'starter' })).toBeNull();
    expect(extensionCapIssue(league, team.id, player, { salary: 9_000_000, years: 1, guaranteed: 0, signingBonus: 0, role: 'starter' })).toMatch(/over the 2026 cap/);
  });
});
