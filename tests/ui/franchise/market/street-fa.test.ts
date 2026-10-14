import { describe, expect, it } from 'vitest';
import type { TeamId } from '@/core/ids';
import { cutPlayer } from '@/franchise/roster';
import type { League } from '@/franchise/types';
import { ConfirmDialog } from '@/ui/franchise/kit/dialogs';
import { finishMessage } from '@/ui/franchise/market/fa-screen';
import { signStreetFreeAgent, streetFaSpec, streetMarketOpen, streetSignProblem } from '@/ui/franchise/market/street-fa';
import { rosterBlockers } from '@/ui/franchise/shell/hub-model';
import { RosterTab } from '@/ui/franchise/team/roster-tab';
import { TableScreen } from '@/ui/franchise/team/tab-screen';
import { contextFor, freeAgencyLeague, regularSeasonLeague } from './fixtures';

const user = (l: League): TeamId => l.userTeamId as TeamId;

/** The regular-season league with one user player cut (52 players: "sign 1 player to reach 53"). */
const shortLeague = (): League => {
  const l = regularSeasonLeague();
  const team = l.teams[user(l)];
  const victim = team?.rosterIds.map((id) => l.players[id]).find((p) => p && p.position === 'WR');
  if (!victim) throw new Error('no WR');
  return cutPlayer(l, user(l), victim.id);
};

describe('signing free agents outside the free-agency phase (APP2-04)', () => {
  it('is open after free agency (season) and closed while the bidding market runs', () => {
    expect(streetMarketOpen(regularSeasonLeague())).toBe(true);
    expect(streetMarketOpen(freeAgencyLeague())).toBe(false);
  });

  it('the Roster menu offers Sign free agents, and signing one clears the short-roster blocker', () => {
    const league = shortLeague();
    expect(rosterBlockers(league, user(league)).some((b) => b.kind === 'rosterTooSmall')).toBe(true);
    const fc = contextFor(league);
    const tab = new RosterTab(fc);
    expect(tab.menu().map((o) => o.id)).toContain('sign');
    tab.onMenu('sign');
    const table = fc.pushed.at(-1);
    expect(table).toBeInstanceOf(TableScreen);
    const spec = streetFaSpec(fc);
    const rows = spec.rows();
    expect(rows.length).toBeGreaterThan(0);
    const row = rows.find((r) => {
      const p = league.players[r.id];
      return p !== undefined && streetSignProblem(league, user(league), p) === null;
    });
    if (!row) throw new Error('no signable free agent');
    spec.activate?.(row);
    const dialog = fc.pushed.at(-1);
    expect(dialog).toBeInstanceOf(ConfirmDialog);
    (dialog as ConfirmDialog).choose(true);
    const after = fc.league();
    expect(after.teams[user(after)]?.rosterIds).toContain(row.id);
    expect(after.players[row.id]?.contract?.years).toBe(1);
    expect(rosterBlockers(after, user(after)).some((b) => b.kind === 'rosterTooSmall')).toBe(false);
    expect(fc.commits.at(-1)?.reason).toBe('signing');
  });

  it('refuses during the free-agency phase', () => {
    const l = freeAgencyLeague();
    const fa = l.freeAgentIds.map((id) => l.players[id]).find((p) => p !== undefined);
    if (!fa) throw new Error('no free agent');
    expect(streetSignProblem(l, user(l), fa)).toMatch(/free-agency market/);
    expect(() => signStreetFreeAgent(l, user(l), fa.id)).toThrow();
  });

  it('"Finish free agency?" warns when the roster is short', () => {
    const l = shortLeague();
    expect(finishMessage(l, user(l))).toMatch(/52\/53/);
    const full = regularSeasonLeague();
    expect(finishMessage(full, user(full))).not.toMatch(/Your roster/);
  });
});
