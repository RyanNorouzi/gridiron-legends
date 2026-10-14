/**
 * AI cap usage after a full offseason (re-signing, free agency, draft, final cuts, camp) with the negotiation.ts
 * price level. Measured on seed 9 (AI teams, cap year after the rollover; the rollover itself adds ~$12M of cap
 * growth to everyone's space):
 *   price level 1.0 (bundled bands only): median $53M unused, mean $60M, max $133M; year two median $89M, mean $79M
 *   MARKET_PRICE_LEVEL (1.0 at 60 -> 1.5 at 72-80 -> 1.15 at 95), with gm/roster-ai re-signing also reserving
 *   minimum fills for already-open roster slots: median $18M, mean $42M, max $121M; year two median $17M, mean
 *   $42M, max $124M (5-7 teams still above $80M)
 * The remaining outliers are weak rosters (overall 64-68, nobody above ~$12M) that lose the bidding for the top free
 * agents; every 70+ free agent signs somewhere.
 */
import { describe, expect, it } from 'vitest';
import { createRng } from '@/core/rng';
import { createLeague } from '@/franchise';
import { capSpace, leagueCapYear } from '@/franchise/contracts';
import { marketPriceLevel, marketSalary } from '@/franchise/negotiation';
import { runOffseason } from '@/franchise/offseason';
import { standardOffseasonDeps } from '@/franchise/offseason-deps';
import { advanceToPhase } from '@/franchise/week';

describe('AI cap usage', () => {
  it('prices the middle of the market up and the stars least', () => {
    expect(marketPriceLevel(55)).toBe(1);
    expect(marketPriceLevel(75)).toBeCloseTo(1.5);
    expect(marketPriceLevel(99)).toBeCloseTo(1.15);
    expect(marketPriceLevel(88)).toBeLessThan(marketPriceLevel(82));
    const qb = { position: 'QB' as const, overall: 99, potential: 99, age: 28 };
    const share = marketSalary(qb, 250_000_000) / 250_000_000;
    expect(share).toBeGreaterThan(0.22);
    expect(share).toBeLessThan(0.27);
  });

  it('leaves AI teams close to the cap after an offseason', () => {
    let league = advanceToPhase(createLeague({ seed: 9, userTeamAbbr: 'BOS' }), 'awards').league;
    league = runOffseason(league, createRng(1), standardOffseasonDeps({ manageUserTeam: true })).league;
    expect(league.season.phase).toBe('preseason');
    const year = leagueCapYear(league);
    const spaces = Object.values(league.teams).filter((t) => t.id !== league.userTeamId)
      .map((t) => capSpace(t, league.players, league.settings, year)).sort((a, b) => a - b);
    const median = spaces[Math.floor(spaces.length / 2)]!;
    const mean = spaces.reduce((a, b) => a + b, 0) / spaces.length;
    expect(spaces[0]).toBeGreaterThanOrEqual(0);
    expect(median).toBeLessThan(30_000_000);
    expect(mean).toBeLessThan(50_000_000);
  }, 60_000);
});
