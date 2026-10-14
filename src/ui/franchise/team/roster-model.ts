/**
 * Roster view-model: one row per player on the user's roster (name, position, age, overall, potential as the
 * scouting rule allows, contract APY and years left, morale, injury, residual fatigue, flags, depth rank),
 * position-group filters, wide/narrow column sets and the summary line (roster size, cap space, rule issues).
 */
import { personalityTags } from '@/franchise/career-stage';
import type { PlayerId, TeamId } from '@/core/ids';
import { capStatus, contractApy, leagueCapYear, yearsRemainingAt } from '@/franchise/contracts';
import { userRosterIssues, rosterSizeBand } from '@/franchise/roster-rules';
import type { League, PlayerFlag } from '@/franchise/types';
import type { InjuryStatus, Player, Position, PositionGroup } from '@/players/types';
import { POSITIONS, POSITION_GROUP, fullName } from '@/players/types';
import { depthRank } from '@/teams/depth-chart';
import type { Column } from '../kit/data-table';
import { formatContract, formatMoney, formatRating, humanize, initialName, moodLabel, moodTone, type Tone, type ToneText } from '../kit/format';
import { potentialVisibility } from '../kit/player-view';
import type { TabSpec } from '../kit/tabbar';
import { plural } from './common';

/** One roster row. */
export interface RosterRow {
  id: PlayerId;
  name: string;
  jersey: number;
  position: Position;
  group: PositionGroup;
  age: number;
  overall: number;
  potential: ToneText;
  /** Sort key of the visible potential (null when hidden). */
  potentialSort: number | null;
  apy: number;
  yearsLeft: number;
  contractText: string;
  morale: number;
  injury: InjuryStatus | null;
  /** Residual fatigue 0..1 carried between games. */
  fatigue: number;
  flags: PlayerFlag[];
  /** 0-based rank in his position's depth chart slot (-1 = unlisted). */
  depthRank: number;
  traits: string[];
}

/** Filter ids: 'all' or a position group. */
export type RosterFilter = 'all' | PositionGroup;

/** Filter chips in display order. */
export const ROSTER_FILTERS: readonly TabSpec[] = [
  { id: 'all', label: 'All' }, { id: 'QB', label: 'QB' }, { id: 'RB', label: 'RB' }, { id: 'WR', label: 'WR' }, { id: 'TE', label: 'TE' },
  { id: 'OL', label: 'OL' }, { id: 'DL', label: 'DL' }, { id: 'LB', label: 'LB' }, { id: 'DB', label: 'DB' }, { id: 'ST', label: 'K/P' },
];

const potentialSortOf = (league: League, p: Player, teamId: TeamId): { text: ToneText; sort: number | null } => {
  const vis = potentialVisibility(league, p, teamId);
  if (vis.mode === 'exact') return { text: vis.text, sort: p.potential };
  if (vis.mode === 'range') {
    const [lo, hi] = vis.text.text.split('-').map((s) => Number.parseInt(s, 10));
    return { text: vis.text, sort: lo !== undefined && hi !== undefined && Number.isFinite(lo) && Number.isFinite(hi) ? (lo + hi) / 2 : lo ?? null };
  }
  return { text: vis.text, sort: null };
};

/** One row for a player as seen by `teamId`. */
export const rosterRow = (league: League, teamId: TeamId, p: Player): RosterRow => {
  const year = leagueCapYear(league);
  const team = league.teams[teamId];
  const pot = potentialSortOf(league, p, teamId);
  return {
    id: p.id, name: fullName(p), jersey: p.jerseyNumber, position: p.position, group: POSITION_GROUP[p.position], age: p.age, overall: p.overall,
    potential: pot.text, potentialSort: pot.sort,
    apy: p.contract ? Math.round(contractApy(p.contract)) : 0,
    yearsLeft: p.contract ? yearsRemainingAt(p.contract, year) : 0,
    contractText: formatContract(p.contract, { remaining: true }),
    morale: Math.round(p.morale.morale), injury: p.injury, fatigue: league.fatigue?.[p.id] ?? 0,
    flags: [...(league.club?.playerFlags[p.id] ?? [])],
    depthRank: team ? depthRank(team.depthChart, p.position, p.id) : -1,
    traits: personalityTags(p),
  };
};

/** Rows for every player on the team's roster (roster order). */
export const rosterRows = (league: League, teamId: TeamId): RosterRow[] => {
  const team = league.teams[teamId];
  if (!team) return [];
  return team.rosterIds.map((id) => league.players[id]).filter((p): p is Player => !!p).map((p) => rosterRow(league, teamId, p));
};

/** Rows matching a filter chip id ('all' or a position group). */
export const filterRoster = (rows: readonly RosterRow[], filter: string): RosterRow[] =>
  filter === 'all' || filter === '' ? [...rows] : rows.filter((r) => r.group === filter);

/** Injury cell: weeks out ("3w") toned by severity; '-' when healthy. */
export const injuryCell = (injury: InjuryStatus | null): ToneText =>
  injury ? { text: `${injury.weeksRemaining}w`, tone: injury.severity === 'minor' ? 'warning' : 'danger' } : { text: '-', tone: 'dim' };

/** Fatigue cell: percent, toned when high. */
export const fatigueCell = (f: number): ToneText => {
  const pct = Math.round(f * 100);
  const tone: Tone = f >= 0.5 ? 'danger' : f >= 0.25 ? 'warning' : 'dim';
  return { text: `${pct}%`, tone };
};

const nameCell = (r: RosterRow): ToneText => (r.flags.includes('tradeBlock') ? { text: `${r.name} (TB)`, tone: 'info' } : { text: r.name });

/** Roster columns: the full set when wide, a compact one for narrow (large-text) tables. */
export const rosterColumns = (wide: boolean): Column<RosterRow>[] => {
  const name: Column<RosterRow> = { key: 'name', label: 'NAME', shorten: initialName, flex: 1, minWidth: 8, format: nameCell, sortValue: (r) => r.name, defaultDir: 'asc' };
  const pos: Column<RosterRow> = { key: 'pos', label: 'POS', width: 3, format: (r) => r.position, sortValue: (r) => POSITIONS.indexOf(r.position) * 100 + (r.depthRank < 0 ? 99 : r.depthRank), defaultDir: 'asc' };
  const ovr: Column<RosterRow> = { key: 'ovr', label: 'OVR', width: 3, align: 'right', format: (r) => formatRating(r.overall), sortValue: (r) => r.overall };
  const pot: Column<RosterRow> = { key: 'pot', label: 'POT', width: wide ? 5 : 3, align: 'right', format: (r) => r.potential, sortValue: (r) => r.potentialSort };
  const apy: Column<RosterRow> = { key: 'apy', label: 'APY', width: 6, align: 'right', format: (r) => (r.apy > 0 ? formatMoney(r.apy) : { text: '-', tone: 'dim' }), sortValue: (r) => r.apy };
  const inj: Column<RosterRow> = { key: 'inj', label: 'INJ', width: 3, align: 'right', format: (r) => injuryCell(r.injury), sortValue: (r) => r.injury?.weeksRemaining ?? 0 };
  // Narrow (large text): the name keeps 14 characters (any generated name in its "C. Blankenship" form); the
  // injury column gives way first (injured rows are dimmed and the detail line names the injury), then APY.
  if (!wide) return [{ ...name, minWidth: 14 }, pos, ovr, pot, { ...apy, priority: 1 }, { ...inj, priority: 2 }];
  return [
    name, pos,
    { key: 'age', label: 'AGE', width: 3, align: 'right', format: (r) => String(r.age), sortValue: (r) => r.age, defaultDir: 'asc' },
    ovr, pot, apy,
    { key: 'yrs', label: 'YRS', width: 3, align: 'right', format: (r) => (r.yearsLeft > 0 ? String(r.yearsLeft) : { text: '-', tone: 'dim' }), sortValue: (r) => r.yearsLeft, defaultDir: 'asc' },
    { key: 'mor', label: 'MOR', width: 3, align: 'right', format: (r) => ({ text: String(r.morale), tone: moodTone(r.morale) }), sortValue: (r) => r.morale, defaultDir: 'asc' },
    inj,
    { key: 'fat', label: 'FAT', width: 4, align: 'right', format: (r) => fatigueCell(r.fatigue), sortValue: (r) => r.fatigue },
  ];
};

/** Detail line for the selected row. */
export const rosterDetail = (r: RosterRow): ToneText => {
  const parts = [`#${r.jersey} ${r.name}`, r.contractText, `${moodLabel(r.morale)} (${r.morale})`];
  if (r.injury) parts.push(`${humanize(r.injury.bodyArea)} ${humanize(r.injury.severity)}`);
  if (r.flags.length > 0) parts.push(r.flags.map(humanize).join(', '));
  else if (r.traits.length > 0) parts.push(r.traits.map(humanize).join(', '));
  return { text: parts.join(' · '), tone: r.injury ? 'warning' : 'info' };
};

/** Summary line: roster size against the phase band, cap space and roster-rule issues. */
export const rosterSummary = (league: League, teamId: TeamId): ToneText => {
  const team = league.teams[teamId];
  if (!team) return { text: 'No team', tone: 'danger' };
  const [min, max] = rosterSizeBand(league, league.season.phase);
  const cap = capStatus(team, league.players, league.settings, leagueCapYear(league));
  const issues = userRosterIssues(league, teamId);
  const blocking = issues.filter((i) => i.severity === 'blocking').length;
  const size = `${team.rosterIds.length} players (${min > 0 ? `${min}-` : 'max '}${max})`;
  const capText = cap.compliant ? `Cap space ${formatMoney(cap.space)}` : `Over the cap by ${formatMoney(cap.overBy)}`;
  const issueText = issues.length === 0 ? 'No roster issues' : `${plural(issues.length, 'roster issue')}${blocking > 0 ? ` (${blocking} blocking)` : ''}`;
  const tone: Tone = blocking > 0 || !cap.compliant ? 'danger' : issues.length > 0 ? 'warning' : 'dim';
  return { text: `${size} · ${capText} · ${issueText}`, tone };
};
