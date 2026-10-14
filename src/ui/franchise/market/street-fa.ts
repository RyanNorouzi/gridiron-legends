/**
 * Street free agents: outside the free-agency bidding window (after the draft, in camp, the preseason and the
 * season) the user can sign any unsigned player straight away on a one-year deal at the player's current ask
 * (leftovers ask little once free agency has closed). This is how a short roster ("sign 1 player to reach 53")
 * is filled by hand instead of only through Auto-fix. Opened from the Roster tab menu and the roster-issues
 * prompts of the hub.
 */
import type { PlayerId, TeamId } from '@/core/ids';
import { createContract, leagueCapYear } from '@/franchise/contracts';
import { playerAsk } from '@/franchise/negotiation';
import { canSign, signPlayer } from '@/franchise/roster';
import { rosterSizeBand } from '@/franchise/roster-rules';
import type { League, SeasonPhase } from '@/franchise/types';
import type { Contract, Player } from '@/players/types';
import type { FranchiseContext } from '../context';
import { ConfirmDialog } from '../kit/dialogs';
import { formatMoney } from '../kit/format';
import type { ViewSpec } from '../team/layout';
import { TableScreen } from '../team/tab-screen';
import { faPoolRows, type FaPoolRow } from './fa-model';

/** Phases where unsigned players are signed on the spot (before free agency opens they wait for the market). */
const STREET_PHASES: readonly SeasonPhase[] = ['postDraft', 'trainingCamp', 'preseason', 'regularSeason', 'playoffs', 'awards'];

/** True when the user may sign street free agents right now. */
export const streetMarketOpen = (league: Pick<League, 'season'>): boolean => STREET_PHASES.includes(league.season.phase);

/** The one-year deal a street free agent signs for: his current ask as salary, nothing guaranteed. */
export const streetContract = (league: League, userId: TeamId, player: Player): Contract => {
  const year = leagueCapYear(league);
  const ask = playerAsk(player, league, league.teams[userId] ?? null, year);
  return createContract({ salary: ask.apy, years: 1, guaranteed: 0, signingBonus: 0, role: ask.role, year });
};

/** Why the user cannot sign `player` now, or null. */
export const streetSignProblem = (league: League, userId: TeamId, player: Player): string | null => {
  if (!streetMarketOpen(league)) return 'free agents sign through the free-agency market now';
  const team = league.teams[userId];
  if (!team) return `unknown team ${userId}`;
  const [, max] = rosterSizeBand(league, league.season.phase);
  const check = canSign(league, userId, player.id, streetContract(league, userId, player), { year: leagueCapYear(league), rosterLimit: max });
  return check.ok ? null : check.reason;
};

/** Signs a street free agent (throws with the reason when he cannot sign). */
export const signStreetFreeAgent = (league: League, userId: TeamId, playerId: PlayerId): League => {
  const player = league.players[playerId];
  if (!player) throw new Error(`signStreetFreeAgent: unknown player ${playerId}`);
  const problem = streetSignProblem(league, userId, player);
  if (problem) throw new Error(problem);
  return signPlayer(league, userId, playerId, streetContract(league, userId, player), { year: leagueCapYear(league) });
};

/** Table spec of the street free agents (best first); Confirm asks, then signs. */
export const streetFaSpec = (fc: FranchiseContext): ViewSpec<FaPoolRow> => ({
  id: 'street-free-agents',
  label: 'Free agents',
  rows: () => faPoolRows(fc.league(), fc.userTeamId),
  rowId: (r) => r.id,
  emptyText: 'No free agents available',
  columns: (wide) => [
    { key: 'name', label: 'NAME', flex: 1, minWidth: 8, format: (r) => r.name, sortValue: (r) => r.name, defaultDir: 'asc' },
    { key: 'pos', label: 'POS', width: 3, format: (r) => r.position, sortValue: (r) => r.position, defaultDir: 'asc' },
    ...(wide ? [{ key: 'age', label: 'AGE', width: 3, format: (r: FaPoolRow) => String(r.age), sortValue: (r: FaPoolRow) => r.age, defaultDir: 'asc' as const }] : []),
    { key: 'ovr', label: 'OVR', width: 3, format: (r) => String(r.overall), sortValue: (r) => r.overall },
    { key: 'ask', label: '1-YR ASK', width: 8, format: (r) => formatMoney(r.ask.apy), sortValue: (r) => r.ask.apy },
  ],
  detail: (r) => {
    const p = fc.league().players[r.id];
    const problem = p ? streetSignProblem(fc.league(), fc.userTeamId, p) : 'gone';
    return problem ? { text: `Cannot sign: ${problem}`, tone: 'danger' } : { text: `Signs today for 1 year at ${formatMoney(r.ask.apy)}`, tone: 'info' };
  },
  activate: (r) => {
    const league = fc.league();
    const p = league.players[r.id];
    if (!p) return;
    const problem = streetSignProblem(league, fc.userTeamId, p);
    if (problem) {
      fc.toast(`Cannot sign ${r.name}: ${problem}`);
      return;
    }
    const salary = formatMoney(streetContract(league, fc.userTeamId, p).salary);
    fc.push(new ConfirmDialog('Sign free agent?', `${r.name} (${r.position}, ${r.overall} OVR) for 1 year at ${salary}.`, {
      yesLabel: 'Sign', noLabel: 'Cancel',
      onResult: (ok) => {
        if (!ok) return;
        try {
          fc.commit(signStreetFreeAgent(fc.league(), fc.userTeamId, r.id), 'signing');
          fc.toast(`${r.name.toUpperCase()} SIGNED: 1Y ${salary}`);
        } catch (err) {
          fc.toast(`Cannot sign ${r.name}: ${err instanceof Error ? err.message : String(err)}`);
        }
      },
    }));
  },
});

/** Opens the street free-agent list as a pushed table. */
export const openStreetFreeAgents = (fc: FranchiseContext): void => {
  fc.push(new TableScreen(fc, 'Sign free agents', streetFaSpec(fc), { subtitle: 'One-year deals at the player\'s ask' }));
};
