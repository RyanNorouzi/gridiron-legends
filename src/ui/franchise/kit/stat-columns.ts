/**
 * Stat column sets for DataTables over PlayerStatLines (player card seasons, roster stats, league leaders).
 * `statGroupsFor(position)` picks the categories that matter for a position; `statColumns(group, pick)`
 * turns a category into sortable DataTable columns reading the line returned by `pick(row)`.
 */
import { POSITION_GROUP, type Position } from '@/players/types';
import { completionPct, passerRating, safeRatio } from '@/statistics/derived';
import type { PlayerStatLine } from '@/statistics/types';
import type { Column } from './data-table';

/** Stat categories shown in tables. */
export type StatGroup = 'passing' | 'rushing' | 'receiving' | 'blocking' | 'defense' | 'kicking' | 'punting';

/** Labels for StatGroup tab/heading captions. */
export const STAT_GROUP_LABELS: Readonly<Record<StatGroup, string>> = Object.freeze({
  passing: 'Passing', rushing: 'Rushing', receiving: 'Receiving', blocking: 'Blocking', defense: 'Defense', kicking: 'Kicking', punting: 'Punting',
});

/** Relevant stat categories for a position, most important first. */
export const statGroupsFor = (position: Position): StatGroup[] => {
  if (position === 'K') return ['kicking'];
  if (position === 'P') return ['punting'];
  switch (POSITION_GROUP[position]) {
    case 'QB': return ['passing', 'rushing'];
    case 'RB': return ['rushing', 'receiving'];
    case 'WR': return ['receiving', 'rushing'];
    case 'TE': return ['receiving', 'blocking'];
    case 'OL': return ['blocking'];
    default: return ['defense'];
  }
};

/** One stat column: label, width in characters and the numeric value (also the sort key). */
export interface StatColumnSpec {
  key: string;
  label: string;
  width: number;
  value(line: PlayerStatLine): number;
  /** Display text (default: rounded integer). */
  text?(line: PlayerStatLine): string;
}

const one = (v: number): string => v.toFixed(1);

/** Column specs per category (games played is prepended by statColumns). */
export const STAT_COLUMN_SPECS: Readonly<Record<StatGroup, readonly StatColumnSpec[]>> = Object.freeze({
  passing: [
    { key: 'cmp', label: 'CMP', width: 4, value: (l) => l.passing.completions },
    { key: 'att', label: 'ATT', width: 4, value: (l) => l.passing.attempts },
    { key: 'pct', label: 'PCT', width: 5, value: (l) => completionPct(l.passing), text: (l) => one(completionPct(l.passing)) },
    { key: 'pyds', label: 'YDS', width: 5, value: (l) => l.passing.yards },
    { key: 'ptd', label: 'TD', width: 3, value: (l) => l.passing.touchdowns },
    { key: 'int', label: 'INT', width: 3, value: (l) => l.passing.interceptions },
    { key: 'rtg', label: 'RTG', width: 5, value: (l) => passerRating(l.passing), text: (l) => one(passerRating(l.passing)) },
  ],
  rushing: [
    { key: 'car', label: 'CAR', width: 4, value: (l) => l.rushing.attempts },
    { key: 'ryds', label: 'YDS', width: 5, value: (l) => l.rushing.yards },
    { key: 'ypc', label: 'AVG', width: 4, value: (l) => safeRatio(l.rushing.yards, l.rushing.attempts), text: (l) => one(safeRatio(l.rushing.yards, l.rushing.attempts)) },
    { key: 'rtd', label: 'TD', width: 3, value: (l) => l.rushing.touchdowns },
    { key: 'rlng', label: 'LNG', width: 3, value: (l) => l.rushing.longest },
  ],
  receiving: [
    { key: 'rec', label: 'REC', width: 4, value: (l) => l.receiving.receptions },
    { key: 'tgt', label: 'TGT', width: 4, value: (l) => l.receiving.targets },
    { key: 'cyds', label: 'YDS', width: 5, value: (l) => l.receiving.yards },
    { key: 'ypr', label: 'AVG', width: 4, value: (l) => safeRatio(l.receiving.yards, l.receiving.receptions), text: (l) => one(safeRatio(l.receiving.yards, l.receiving.receptions)) },
    { key: 'ctd', label: 'TD', width: 3, value: (l) => l.receiving.touchdowns },
  ],
  blocking: [
    { key: 'bsnp', label: 'SNP', width: 4, value: (l) => l.blocking.snaps },
    { key: 'pnk', label: 'PNK', width: 3, value: (l) => l.blocking.pancakes },
    { key: 'ska', label: 'SKA', width: 3, value: (l) => l.blocking.sacksAllowed },
    { key: 'pra', label: 'PRA', width: 3, value: (l) => l.blocking.pressuresAllowed },
  ],
  defense: [
    { key: 'tkl', label: 'TKL', width: 4, value: (l) => l.defense.tackles },
    { key: 'tfl', label: 'TFL', width: 3, value: (l) => l.defense.tfl },
    { key: 'sck', label: 'SCK', width: 4, value: (l) => l.defense.sacks, text: (l) => (Number.isInteger(l.defense.sacks) ? String(l.defense.sacks) : one(l.defense.sacks)) },
    { key: 'dint', label: 'INT', width: 3, value: (l) => l.defense.interceptions },
    { key: 'pd', label: 'PD', width: 3, value: (l) => l.defense.passBreakups },
    { key: 'ff', label: 'FF', width: 3, value: (l) => l.defense.forcedFumbles },
  ],
  kicking: [
    { key: 'fgm', label: 'FGM', width: 3, value: (l) => l.kicking.fgMade },
    { key: 'fga', label: 'FGA', width: 3, value: (l) => l.kicking.fgAttempts },
    { key: 'fgp', label: 'PCT', width: 5, value: (l) => safeRatio(l.kicking.fgMade, l.kicking.fgAttempts) * 100, text: (l) => one(safeRatio(l.kicking.fgMade, l.kicking.fgAttempts) * 100) },
    { key: 'fgl', label: 'LNG', width: 3, value: (l) => l.kicking.fgLong },
    { key: 'xpm', label: 'XPM', width: 3, value: (l) => l.kicking.xpMade },
    { key: 'xpa', label: 'XPA', width: 3, value: (l) => l.kicking.xpAttempts },
  ],
  punting: [
    { key: 'pnt', label: 'PUNT', width: 4, value: (l) => l.kicking.punts },
    { key: 'pyd', label: 'YDS', width: 5, value: (l) => l.kicking.puntYards },
    { key: 'pavg', label: 'AVG', width: 4, value: (l) => safeRatio(l.kicking.puntYards, l.kicking.punts), text: (l) => one(safeRatio(l.kicking.puntYards, l.kicking.punts)) },
    { key: 'in20', label: 'IN20', width: 4, value: (l) => l.kicking.puntsInside20 },
    { key: 'plng', label: 'LNG', width: 3, value: (l) => l.kicking.puntLong },
  ],
});

/** Sortable, right-aligned DataTable columns for a category, led by games played (GP). */
export const statColumns = <R>(group: StatGroup, pick: (row: R) => PlayerStatLine): Column<R>[] => {
  const specs: readonly StatColumnSpec[] = [{ key: 'gp', label: 'GP', width: 3, value: (l) => l.gamesPlayed }, ...STAT_COLUMN_SPECS[group]];
  return specs.map((s) => ({
    key: s.key,
    label: s.label,
    width: s.width,
    align: 'right' as const,
    format: (row: R) => (s.text ? s.text(pick(row)) : String(Math.round(s.value(pick(row))))),
    sortValue: (row: R) => s.value(pick(row)),
  }));
};
