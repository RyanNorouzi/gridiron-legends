import { describe, expect, it } from 'vitest';
import { hiringFee, STAFF_TUNING } from '@/franchise/staff';
import { roundMoney } from '@/franchise/contracts';
import { StaffTab } from '@/ui/franchise/team/staff-tab';
import { fireStaff, marketRows, staffRows } from '@/ui/franchise/team/staff-model';
import { baseLeague, mount, userId } from './helpers';

describe('coach market after a firing (APP2-09) and the hire fee (APP2-16a)', () => {
  it('opening the market after firing a coach shows a full market, not just him', () => {
    const league = baseLeague();
    const team = userId(league);
    const row = staffRows(league, team).find((r) => r.coach && r.role !== 'HC');
    if (!row?.coach) throw new Error('no coach to fire');
    const fired = fireStaff(league, team, row.coach.id);
    expect(fired.ok).toBe(true);
    // Precondition of the bug: the fired coach alone makes the market non-empty.
    expect(marketRows(fired.league, row.role).length).toBeLessThanOrEqual(1);
    const { fc, screen } = mount(fired.league, (f) => new StaffTab(f));
    screen.openMarket(row.role);
    const rows = marketRows(fc.league(), row.role);
    expect(rows.length).toBeGreaterThan(1);
    expect(rows.some((r) => r.coach?.id !== row.coach?.id)).toBe(true);
  });

  it('the fee preview uses the same rounding as the charge', () => {
    expect(hiringFee(1_030_000)).toBe(roundMoney(1_030_000 * STAFF_TUNING.hiringFeeShare));
  });
});
