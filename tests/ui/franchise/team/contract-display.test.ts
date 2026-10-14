import { describe, expect, it } from 'vitest';
import { createContract, leagueCapYear, rebaseContract } from '@/franchise/contracts';
import { formatContract } from '@/ui/franchise/kit/format';
import { contractRows, dealStatus } from '@/ui/franchise/team/cap-model';
import { buildPlayerCard } from '@/ui/franchise/kit/player-view';
import { baseLeague, userId } from './helpers';

describe('contract displays use what is left (APP2-13)', () => {
  it('an expired deal is not shown as "0y $0"', () => {
    const c = { ...createContract({ salary: 4_200_000, years: 2, guaranteed: 0, signingBonus: 0, role: 'backup', year: 2025 }), yearsRemaining: 0 };
    expect(formatContract(c, { remaining: true })).toBe('Expired (was $4.2M/yr)');
  });

  it('the guarantee shown is the unpaid part in the last year of a multi-year deal', () => {
    const league = baseLeague();
    const team = userId(league);
    const year = league.year;
    const c = createContract({ salary: 13_000_000, years: 4, guaranteed: 27_900_000, signingBonus: 0, role: 'starter', year: year - 3 });
    expect(rebaseContract(c, year).guaranteed).toBe(Math.max(0, 27_900_000 - 13_000_000 * 3));
    const id = league.teams[team]?.rosterIds[0];
    if (!id) throw new Error('no player');
    const p = league.players[id];
    if (!p?.contract) throw new Error('no contract');
    const row = contractRows(league, team).find((r) => r.id === id);
    expect(row?.guaranteed).toBe(rebaseContract(p.contract, leagueCapYear(league)).guaranteed);
    const line = buildPlayerCard(league, p.id, team)?.overview.find((l) => l.id === 'guaranteed');
    expect(line?.label).toBe('Guaranteed left');
  });

  it('an ended deal reads "Re-sign now" in the Expiring view, not "No"', () => {
    expect(dealStatus({ yearsLeft: 0, wantsDeal: false }).text).toBe('Re-sign now');
    expect(dealStatus({ yearsLeft: 1, wantsDeal: true }).text).toBe('Wants deal');
    expect(dealStatus({ yearsLeft: 2, wantsDeal: false }).text).toBe('-');
  });
});
