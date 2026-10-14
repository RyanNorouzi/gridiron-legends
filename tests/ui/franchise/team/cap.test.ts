import { describe, expect, it } from 'vitest';
import { contractEndYear, createContract, leagueCapYear, projectedCapSpace } from '@/franchise/contracts';
import { withClub } from '@/franchise/rivalries';
import { cutPlayer } from '@/franchise/roster';
import type { League } from '@/franchise/types';
import {
  CAP_TABLE_YEARS, capColumns, capSummary, capTableRows, contractColumns, contractDetail, contractRows, deadMoneyColumns, deadMoneyRows, expiringColumns, expiringRows,
} from '@/ui/franchise/team/cap-model';
import { CapTab } from '@/ui/franchise/team/cap-tab';
import { DEFAULT_SETTINGS } from '@/core/settings';
import { DataTable } from '@/ui/franchise/kit/data-table';
import { layoutTable } from '@/ui/franchise/kit/data-table-view';
import { createTheme } from '@/ui/theme';
import { baseLeague, mount, press, rcFor, userId, userPlayer, withPlayer } from './helpers';

describe('cap view-models', () => {
  it('projects the cap table from projectedCapSpace', () => {
    const league = baseLeague();
    const team = userId(league);
    const rows = capTableRows(league, team);
    const t = league.teams[team];
    if (!t) throw new Error('team');
    expect(rows).toHaveLength(CAP_TABLE_YEARS);
    expect(rows.map(({ year, cap, committed, deadMoney, space }) => ({ year, cap, committed, deadMoney, space })))
      .toEqual(projectedCapSpace(t, league.players, league.settings, leagueCapYear(league), CAP_TABLE_YEARS));
    expect(rows[0]?.players).toBeGreaterThan(rows[3]?.players ?? 99);
    expect(capSummary(league, team).text).toContain('space');
    expect(capTableRows(league, 't_x' as never)).toEqual([]);
  });
  it('lists contracts, expiring deals and dead money', () => {
    const base = baseLeague();
    const team = userId(base);
    const p = userPlayer(base, 'TE');
    const league = withPlayer(base, { ...p, contract: createContract({ salary: 2_000_000, years: 1, guaranteed: 0, signingBonus: 0, role: 'rotation', year: base.year }) });
    const rows = contractRows(league, team);
    expect(rows).toHaveLength(league.teams[team]?.rosterIds.length ?? 0);
    const expiring = expiringRows(league, team);
    expect(expiring.map((r) => r.id)).toContain(p.id);
    expect(expiring.every((r) => r.endYear <= leagueCapYear(league))).toBe(true);
    const cutTarget = userPlayer(league, undefined, (x) => (x.contract?.signingBonus ?? 0) > 0);
    expect(deadMoneyRows(league, team)).toEqual([]);
    const cut = cutPlayer(league, team, cutTarget.id);
    const dead = deadMoneyRows(cut, team);
    const year = leagueCapYear(league);
    expect(dead[0]?.year).toBe(year);
    expect(dead[0]?.player).toBe(cut.teams[team]?.finances.deadMoney[year]);
    const staffOwed = withClub(cut, { staffDeadMoney: { [team]: { [year + 1]: 500_000 } } });
    const withStaff = deadMoneyRows(staffOwed, team);
    expect(withStaff.find((r) => r.year === year + 1)?.staff).toBe(500_000);
    const detail = contractDetail(rows[0] as never);
    expect(detail.text).toContain('ends');
    expect(capColumns(true)).toHaveLength(6);
    expect(capColumns(false)).toHaveLength(4);
    expect(contractColumns(true)).toHaveLength(9);
    expect(contractColumns(false)).toHaveLength(4);
    expect(expiringColumns(true)).toHaveLength(7);
    expect(deadMoneyColumns()).toHaveLength(3);
    expect(contractEndYear(league.players[p.id]?.contract as never)).toBe(league.year);
  });
  it('keeps the sorted YEAR headers whole (label plus sort marker)', () => {
    const league = baseLeague();
    const theme = createTheme(DEFAULT_SETTINGS);
    const rect = { x: 0, y: 0, w: 460, h: 120 };
    const cap = new DataTable(capColumns(true), capTableRows(league, userId(league)), { rowId: (r) => r.id, initialSort: { key: 'year', dir: 'asc' } });
    expect(layoutTable(cap, theme, rect).header?.[0]?.text).toBe('YEAR▲');
    const dead = new DataTable(deadMoneyColumns(), deadMoneyRows(league, userId(league)), { rowId: (r) => r.id, initialSort: { key: 'year', dir: 'asc' } });
    expect(layoutTable(dead, theme, rect).header?.[0]?.text).toBe('YEAR▲');
  });
  it('flags a team over the cap', () => {
    const base = baseLeague();
    const team = userId(base);
    const t = base.teams[team];
    if (!t) throw new Error('team');
    const over: League = { ...base, teams: { ...base.teams, [team]: { ...t, finances: { ...t.finances, deadMoney: { [leagueCapYear(base)]: base.settings.salaryCap } } } } };
    const s = capSummary(over, team);
    expect(s.tone).toBe('danger');
    expect(s.text).toContain('OVER');
  });
});

describe('CapTab', () => {
  it('switches views, badges expiring deals and opens players from contract rows', () => {
    const base = baseLeague();
    const p = userPlayer(base, 'TE');
    const league = withPlayer(base, { ...p, contract: createContract({ salary: 2_000_000, years: 1, guaranteed: 0, signingBonus: 0, role: 'rotation', year: base.year }) });
    const { fc, screen } = mount(league, (f) => new CapTab(f));
    const rc = rcFor(fc);
    screen.render(rc);
    expect(screen.chips.current).toBe('cap');
    expect(screen.view.detail()).toMatchObject({ tone: 'info' });
    expect(screen.chips.bar.tabs.find((t) => t.id === 'expiring')?.badge).toBe(String(expiringRows(league, userId(league)).length));
    press(fc, 'confirm');
    expect(fc.openedPlayers).toEqual([]);
    press(fc, 'audible');
    expect(screen.chips.current).toBe('contracts');
    expect(screen.contracts.table.sortKey).toBe('hit');
    const top = screen.contracts.table.rows[0];
    expect(top?.capHit).toBe(Math.max(...screen.contracts.table.rows.map((r) => r.capHit)));
    press(fc, 'confirm');
    expect(fc.openedPlayers).toEqual([top?.id]);
    screen.showView('expiring');
    screen.render(rc);
    expect(screen.expiring.table.rows.map((r) => r.id)).toContain(p.id);
    screen.showView('dead');
    screen.render(rc);
    expect(screen.summary().text).toContain('cap');
    expect(screen.menu()).toEqual([]);
    expect(screen.openMenu()).toBe(false);
    press(fc, 'pause');
    expect(fc.stack.top).toBe(screen);
    expect(screen.lastLayout?.menu).toBeNull();
    const big = mount(league, (f) => new CapTab(f, { view: 'contracts' }), { settings: { textSize: 'large' } });
    big.screen.render(rcFor(big.fc));
    expect(big.screen.contracts.isWide).toBe(false);
  });
});
