/**
 * Contracts & cap view-models for the user's team: the multi-year cap table (projectedCapSpace: cap,
 * committed, dead money, space, players under contract), the contracts list (cap hit and share of the cap,
 * years left, guarantees, dead money if cut now), expiring deals (final season or already expired, with
 * whether the player wants a new deal now), the dead-money ledger (player cap charges and staff cash owed)
 * and the cap status summary.
 */
import type { PlayerId, TeamId } from '@/core/ids';
import {
  capHit, capStatus, contractEndYear, deadMoney, isActiveIn, leagueCapYear, projectedCapSpace, rebaseContract, yearsRemainingAt, type CapYearProjection,
} from '@/franchise/contracts';
import { wantsExtension } from '@/franchise/negotiation';
import { ensureClub } from '@/franchise/rivalries';
import type { League } from '@/franchise/types';
import { fullName, type Player, type Position } from '@/players/types';
import type { Column } from '../kit/data-table';
import { formatCapPct, formatMoney, formatRating, initialName, type ToneText } from '../kit/format';

/** Seasons shown in the cap table. */
export const CAP_TABLE_YEARS = 4;

/** One season of the cap table. */
export interface CapYearRow extends CapYearProjection {
  id: string;
  players: number;
}

/** Cap table rows from the league cap year on. */
export const capTableRows = (league: League, teamId: TeamId, years = CAP_TABLE_YEARS): CapYearRow[] => {
  const team = league.teams[teamId];
  if (!team) return [];
  const from = leagueCapYear(league);
  return projectedCapSpace(team, league.players, league.settings, from, years).map((p) => ({
    ...p, id: `y${p.year}`,
    players: team.rosterIds.filter((id) => { const c = league.players[id]?.contract; return !!c && isActiveIn(c, p.year); }).length,
  }));
};

/** One contract of the user's roster. */
export interface ContractRow {
  id: PlayerId;
  name: string;
  position: Position;
  age: number;
  overall: number;
  capHit: number;
  capPct: string;
  yearsLeft: number;
  endYear: number;
  guaranteed: number;
  deadIfCut: number;
  tag: string | null;
  restructured: boolean;
  wantsDeal: boolean;
}

const contractRow = (league: League, p: Player, year: number): ContractRow | null => {
  const c = p.contract;
  if (!c) return null;
  const hit = capHit(c, year);
  return {
    id: p.id, name: fullName(p), position: p.position, age: p.age, overall: p.overall, capHit: hit, capPct: formatCapPct(hit, league.settings.salaryCap),
    yearsLeft: yearsRemainingAt(c, year), endYear: contractEndYear(c), guaranteed: rebaseContract(c, year).guaranteed, deadIfCut: deadMoney(c, year),
    tag: c.tag, restructured: c.restructured, wantsDeal: wantsExtension(p, year, league.settings.salaryCap),
  };
};

/** Every contract on the roster. */
export const contractRows = (league: League, teamId: TeamId): ContractRow[] => {
  const team = league.teams[teamId];
  if (!team) return [];
  const year = leagueCapYear(league);
  return team.rosterIds.map((id) => league.players[id]).filter((p): p is Player => !!p).map((p) => contractRow(league, p, year)).filter((r): r is ContractRow => r !== null);
};

/** Contracts in their final season or already expired (need a new deal before next season). */
export const expiringRows = (league: League, teamId: TeamId): ContractRow[] => {
  const year = leagueCapYear(league);
  return contractRows(league, teamId).filter((r) => r.endYear <= year);
};

/** One season of dead money. */
export interface DeadMoneyRow {
  id: string;
  year: number;
  /** Cap charges from released/traded players. */
  player: number;
  /** Cash still owed to fired coaches (paid with the payroll, not a cap charge). */
  staff: number;
}

/** Dead money by season (player cap charges and staff cash), oldest first. */
export const deadMoneyRows = (league: League, teamId: TeamId): DeadMoneyRow[] => {
  const team = league.teams[teamId];
  if (!team) return [];
  const staff = ensureClub(league).staffDeadMoney[teamId] ?? {};
  const years = new Set<number>([...Object.keys(team.finances.deadMoney), ...Object.keys(staff)].map((y) => Number(y)).filter((y) => Number.isFinite(y)));
  return [...years].sort((a, b) => a - b).map((year) => ({ id: `d${year}`, year, player: team.finances.deadMoney[year] ?? 0, staff: staff[year] ?? 0 }))
    .filter((r) => r.player > 0 || r.staff > 0);
};

/** Cap status line for the league cap year. */
export const capSummary = (league: League, teamId: TeamId): ToneText => {
  const team = league.teams[teamId];
  if (!team) return { text: 'No team', tone: 'danger' };
  const year = leagueCapYear(league);
  const s = capStatus(team, league.players, league.settings, year);
  const base = `${year} cap ${formatMoney(s.cap)} · committed ${formatMoney(s.committed)} · dead ${formatMoney(s.deadMoney)}`;
  return s.compliant ? { text: `${base} · space ${formatMoney(s.space)}`, tone: s.space < league.settings.salaryCap * 0.02 ? 'warning' : 'success' }
    : { text: `${base} · OVER by ${formatMoney(s.overBy)}`, tone: 'danger' };
};

/* --------------------------------- columns -------------------------------- */

const money = (v: number): ToneText => (v > 0 ? { text: formatMoney(v) } : { text: '-', tone: 'dim' });

/** Cap table columns. */
export const capColumns = (wide: boolean): Column<CapYearRow>[] => [
  { key: 'year', label: 'YEAR', width: 6, format: (r) => String(r.year), sortValue: (r) => r.year, defaultDir: 'asc' },
  { key: 'cap', label: 'CAP', width: 7, align: 'right', format: (r) => formatMoney(r.cap), sortValue: (r) => r.cap },
  { key: 'committed', label: 'COMMIT', width: 7, align: 'right', format: (r) => formatMoney(r.committed), sortValue: (r) => r.committed },
  ...(wide ? [{ key: 'dead', label: 'DEAD', width: 7, align: 'right', format: (r: CapYearRow) => money(r.deadMoney), sortValue: (r: CapYearRow) => r.deadMoney } as Column<CapYearRow>] : []),
  { key: 'space', label: 'SPACE', width: 7, align: 'right', format: (r) => ({ text: formatMoney(r.space), tone: r.space < 0 ? 'danger' : 'success' }), sortValue: (r) => r.space },
  ...(wide ? [{ key: 'players', label: 'SIGNED', width: 6, align: 'right', format: (r: CapYearRow) => String(r.players), sortValue: (r: CapYearRow) => r.players } as Column<CapYearRow>] : []),
];

const tagText = (r: ContractRow): ToneText | null => (r.tag ? { text: r.tag === 'franchise' ? 'FT' : 'TT', tone: 'info' } : r.restructured ? { text: 'R', tone: 'dim' } : null);

/** Contract list columns. */
export const contractColumns = (wide: boolean): Column<ContractRow>[] => [
  { key: 'name', label: 'NAME', shorten: initialName, flex: 1, minWidth: 8, format: (r) => r.name, sortValue: (r) => r.name, defaultDir: 'asc' },
  { key: 'pos', label: 'POS', width: 3, format: (r) => r.position, sortValue: (r) => r.position, defaultDir: 'asc' },
  ...(wide ? [{ key: 'ovr', label: 'OVR', width: 3, align: 'right', format: (r: ContractRow) => formatRating(r.overall), sortValue: (r: ContractRow) => r.overall } as Column<ContractRow>] : []),
  { key: 'hit', label: 'HIT', width: 6, align: 'right', format: (r) => money(r.capHit), sortValue: (r) => r.capHit },
  ...(wide ? [{ key: 'pct', label: 'CAP%', width: 5, align: 'right', format: (r: ContractRow) => r.capPct, sortValue: (r: ContractRow) => r.capHit } as Column<ContractRow>] : []),
  { key: 'yrs', label: 'YRS', width: 3, align: 'right', format: (r) => (r.yearsLeft > 0 ? String(r.yearsLeft) : { text: '0', tone: 'warning' }), sortValue: (r) => r.yearsLeft, defaultDir: 'asc' },
  ...(wide ? [
    { key: 'gtd', label: 'GTD', width: 6, align: 'right', format: (r: ContractRow) => money(r.guaranteed), sortValue: (r: ContractRow) => r.guaranteed } as Column<ContractRow>,
    { key: 'dead', label: 'CUT$', width: 6, align: 'right', format: (r: ContractRow) => (r.deadIfCut > 0 ? { text: formatMoney(r.deadIfCut), tone: 'warning' } : { text: '-', tone: 'dim' }), sortValue: (r: ContractRow) => r.deadIfCut } as Column<ContractRow>,
    { key: 'tag', label: 'TAG', width: 3, format: (r: ContractRow) => tagText(r) ?? '' } as Column<ContractRow>,
  ] : []),
];

/**
 * Contract status of an expiring deal: one that has run out is up for re-signing now (wantsExtension only speaks
 * about extending a deal that still has seasons left, so it said "No" for all of them).
 */
export const dealStatus = (r: Pick<ContractRow, 'yearsLeft' | 'wantsDeal'>): ToneText =>
  r.yearsLeft === 0 ? { text: 'Re-sign now', tone: 'info' } : r.wantsDeal ? { text: 'Wants deal', tone: 'warning' } : { text: '-', tone: 'dim' };

/** Expiring-deal columns. */
export const expiringColumns = (wide: boolean): Column<ContractRow>[] => [
  { key: 'name', label: 'NAME', shorten: initialName, flex: 1, minWidth: 8, format: (r) => r.name, sortValue: (r) => r.name, defaultDir: 'asc' },
  { key: 'pos', label: 'POS', width: 3, format: (r) => r.position, sortValue: (r) => r.position, defaultDir: 'asc' },
  ...(wide ? [{ key: 'age', label: 'AGE', width: 3, align: 'right', format: (r: ContractRow) => String(r.age), sortValue: (r: ContractRow) => r.age, defaultDir: 'asc' } as Column<ContractRow>] : []),
  { key: 'ovr', label: 'OVR', width: 3, align: 'right', format: (r) => formatRating(r.overall), sortValue: (r) => r.overall },
  { key: 'hit', label: 'APY', width: 6, align: 'right', format: (r) => money(r.capHit), sortValue: (r) => r.capHit },
  { key: 'ends', label: 'ENDS', width: 4, align: 'right', format: (r) => String(r.endYear), sortValue: (r) => r.endYear, defaultDir: 'asc' },
  ...(wide ? [{ key: 'wants', label: 'STATUS', width: 10, format: dealStatus, sortValue: (r: ContractRow) => (r.yearsLeft === 0 ? 2 : r.wantsDeal ? 1 : 0) } as Column<ContractRow>] : []),
];

/** Dead-money columns. */
export const deadMoneyColumns = (): Column<DeadMoneyRow>[] => [
  { key: 'year', label: 'YEAR', width: 6, format: (r) => String(r.year), sortValue: (r) => r.year, defaultDir: 'asc' },
  { key: 'player', label: 'PLAYER CAP', width: 10, align: 'right', format: (r) => money(r.player), sortValue: (r) => r.player },
  { key: 'staff', label: 'STAFF CASH', width: 10, align: 'right', format: (r) => money(r.staff), sortValue: (r) => r.staff },
];

/** Detail for a contract row. */
export const contractDetail = (r: ContractRow): ToneText => ({
  text: `${r.name} · ends ${r.endYear} · guaranteed ${formatMoney(r.guaranteed)} · dead if cut ${formatMoney(r.deadIfCut)}${r.tag ? ` · ${r.tag} tag` : ''}${r.wantsDeal ? ' · wants a new deal' : ''}`,
  tone: r.wantsDeal ? 'warning' : 'info',
});
