import { describe, expect, it } from 'vitest';
import { FACILITY_DATA, FACILITY_TYPES, economyScale, facilityLevel } from '@/franchise/facilities';
import { ticketPriceRange } from '@/franchise/fans';
import { optimalTicketPrice } from '@/franchise/finances';
import type { League } from '@/franchise/types';
import { ConfirmDialog, StepperDialog } from '@/ui/franchise/kit/dialogs';
import {
  changeTicketPrice, facilityEffectText, facilityRows, facilitySummary, fanLines, fanSummary, financeLines, ticketField, ticketLines, upgrade,
} from '@/ui/franchise/team/facilities-model';
import { FacilitiesTab, facilityColumns, facilityDetail, facilityShortLabel } from '@/ui/franchise/team/facilities-tab';
import { withClub } from '@/franchise/rivalries';
import { baseLeague, inPhase, mount, press, rcFor, topAs, userId } from './helpers';

const richOffseason = (league: League): League => {
  const off = inPhase(league, 'offseason');
  const team = off.teams[userId(off)];
  if (!team) throw new Error('team');
  return { ...off, teams: { ...off.teams, [team.id]: { ...team, finances: { ...team.finances, cash: 500_000_000 } } } };
};

describe('facilities view-models', () => {
  it('describes levels, costs, effects and upgrade eligibility', () => {
    const league = baseLeague();
    const team = userId(league);
    const rows = facilityRows(league, team);
    expect(rows.map((r) => r.id)).toEqual([...FACILITY_TYPES]);
    const training = rows.find((r) => r.id === 'training');
    expect(training?.level).toBe(facilityLevel(league.teams[team]?.facilities as never, 'training'));
    expect(training?.check.ok).toBe(false);
    expect(training?.check.reason).toContain('offseason');
    expect(facilityDetail(training as never).tone).toBe('warning');
    for (const t of FACILITY_TYPES) expect(facilityEffectText(t, 1).length).toBeGreaterThan(5);
    expect(facilityEffectText('medical', 5)).toContain('-25%');
    expect(facilitySummary(league, team).text).toContain('offseason');
    const refused = upgrade(league, team, 'training');
    expect(refused.ok).toBe(false);
    const off = richOffseason(league);
    const r = upgrade(off, team, 'training');
    expect(r.ok).toBe(true);
    expect(r.league.teams[team]?.facilities.training).toBe((training?.level ?? 0) + 1);
    expect(r.league.teams[team]?.finances.cash).toBe(500_000_000 - (training?.cost ?? 0));
    const offTeam = off.teams[team];
    if (!offTeam) throw new Error('team');
    const top: League = { ...off, teams: { ...off.teams, [team]: { ...offTeam, facilities: { ...offTeam.facilities, scouting: FACILITY_DATA.maxLevel } } } };
    const max = facilityRows(top, team).find((row) => row.id === 'scouting');
    expect(max?.cost).toBeNull();
    expect(facilityDetail(max as never).text).toContain('top level');
    expect(facilityColumns(true)).toHaveLength(5);
    expect(facilityColumns(false)).toHaveLength(3);
    expect(facilityShortLabel('Player Development Center')).toBe('Player Dev Center');
    expect(facilityShortLabel('Scouting Department')).toBe('Scouting Dept');
    expect(facilityShortLabel('Stadium')).toBe('Stadium');
  });
  it('prices tickets and reports the books and the fans', () => {
    const league = baseLeague();
    const team = userId(league);
    const lines = ticketLines(league, team);
    expect(lines.slice(0, 2).map((l) => l.action)).toEqual(['price', 'optimal']);
    const field = ticketField(league, team);
    const [lo, hi] = ticketPriceRange(economyScale(league.settings));
    expect(field.min).toBe(lo);
    expect(field.max).toBe(hi);
    const set = changeTicketPrice(league, team, lo + 5);
    expect(set.ok).toBe(true);
    expect(set.league.teams[team]?.finances.ticketPrice).toBe(lo + 5);
    expect(changeTicketPrice(league, team, hi + 1000).ok).toBe(false);
    const fin = financeLines(league, team);
    expect(fin.map((l) => l.id)).toEqual(expect.arrayContaining(['rev-tickets', 'rev-total', 'exp-players', 'exp-total', 'profit', 'cash']));
    const history = withClub(league, { financeHistory: { [team]: [{ year: 2025, revenue: 9e7, expenses: 8e7, profit: 1e7, cashEnd: 7e7, ownerSubsidy: 0, ownerConfidence: 60, averageAttendancePct: 0.9 }] } });
    expect(financeLines(history, team).some((l) => l.id === 'hist-2025')).toBe(true);
    const fans = fanLines(league, team);
    expect(fans.find((l) => l.id === 'support')?.bar?.value).toBe(league.teams[team]?.fans.support);
    expect(fans.some((l) => l.id === 'owner')).toBe(true);
    expect(fanSummary(league, team).text).toContain('owner confidence');
    expect(ticketLines(league, 't_x' as never)).toEqual([]);
  });
});

describe('FacilitiesTab', () => {
  it('upgrades with confirmation in the offseason and toasts refusals', () => {
    const { fc, screen } = mount(richOffseason(baseLeague()), (f) => new FacilitiesTab(f));
    const rc = rcFor(fc);
    screen.render(rc);
    expect(screen.summary().tone).toBe('success');
    const before = fc.league().teams[fc.userTeamId]?.facilities.training ?? 0;
    press(fc, 'confirm');
    const confirm = topAs(fc, ConfirmDialog);
    expect(confirm.title).toContain('Training');
    confirm.choose(true);
    expect(fc.league().teams[fc.userTeamId]?.facilities.training).toBe(before + 1);
    expect(fc.commits.at(-1)?.reason).toBe('edit');
    const pre = mount(baseLeague(), (f) => new FacilitiesTab(f));
    press(pre.fc, 'confirm');
    expect(pre.fc.toasts.at(-1)).toContain('offseason');
    expect(pre.fc.commits).toHaveLength(0);
  });
  it('sets ticket prices with the stepper or the optimal line and shows every view in large text', () => {
    const league = baseLeague();
    const { fc, screen } = mount(league, (f) => new FacilitiesTab(f, { view: 'tickets' }), { settings: { textSize: 'large' } });
    const rc = rcFor(fc);
    screen.render(rc);
    expect(screen.summary().text).toContain('Tickets');
    press(fc, 'confirm');
    const stepper = topAs(fc, StepperDialog);
    expect(stepper.summary).toContain('Attendance');
    stepper.render(rc);
    const start = stepper.model.value('price');
    press(fc, 'menuTabRight');
    press(fc, 'confirm');
    expect(fc.league().teams[fc.userTeamId]?.finances.ticketPrice).toBe(start + 10);
    screen.tickets.table.selectById('optimal');
    press(fc, 'confirm');
    expect(fc.league().teams[fc.userTeamId]?.finances.ticketPrice).toBe(optimalTicketPrice(fc.league(), fc.userTeamId));
    for (const view of ['finances', 'fans', 'facilities']) {
      screen.showView(view);
      screen.render(rc);
      expect(screen.summary().text.length).toBeGreaterThan(5);
    }
    expect(screen.facilities.isWide).toBe(false);
    screen.tickets.table.selectById('att');
    expect(screen.ticketAction(screen.tickets.table.selected as never)).toBeNull();
  });
});
