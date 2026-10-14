/**
 * Pure view-models of the Stats tab: league leaders per category for a scope (a regular season, a postseason,
 * or careers) and year, the advanced-metric column sets (passer rating, EPA/play, success rate, YAC, pressure
 * rate, coverage success, missed tackle rate, explosive rate...) and team stat tables (season and playoffs of
 * the current year; an all-time franchise table for the career scope).
 */
import type { PlayerId, TeamId } from '@/core/ids';
import type { League } from '@/franchise/types';
import { addLines } from '@/statistics/aggregate';
import { mergeTeamStats } from '@/statistics/apply';
import { advancedStats, safeRatio } from '@/statistics/derived';
import { emptyTeamStatLine } from '@/statistics/empty';
import type { PlayerStatLine, TeamStatLine } from '@/statistics/types';
import type { Position } from '@/players/types';
import type { Column } from '../kit/data-table';
import { formatPercent } from '../kit/format';
import type { StatGroup } from '../kit/stat-columns';
import { findPlayer, pctText, playerName, signedFixed, teamAbbr, teamName } from './common';

/** Which lines the leaders read. */
export type StatScope = 'season' | 'playoffs' | 'career';
/** Scopes in option order. */
export const STAT_SCOPES: readonly StatScope[] = ['season', 'playoffs', 'career'];
/** Option labels of the scopes. */
export const SCOPE_LABELS: Readonly<Record<StatScope, string>> = Object.freeze({ season: 'Regular season', playoffs: 'Playoffs', career: 'Career' });

/** Leader categories. */
export type LeaderGroup = Exclude<StatGroup, 'blocking'>;
/** Leader categories in view order. */
export const LEADER_GROUPS: readonly LeaderGroup[] = ['passing', 'rushing', 'receiving', 'defense', 'kicking', 'punting'];

const hasCurrentStats = (league: League): boolean =>
  Object.keys(league.season.stats).length > 0 || Object.keys(league.season.playoffStats).length > 0;

/** Years with stats, newest first (the current year while it has any, plus every finished season). */
export const statYears = (league: League): number[] => {
  const years = new Set<number>(league.history.map((h) => h.year));
  if (hasCurrentStats(league) || years.size === 0) years.add(league.season.year);
  return [...years].sort((a, b) => b - a);
};

/** Year shown first: the current year once it has stats, else the latest finished season. */
export const defaultStatYear = (league: League): number => (hasCurrentStats(league) ? league.season.year : statYears(league)[0] ?? league.season.year);

/** One player's line for a scope, with the team it was earned for. */
export interface ScopedLine {
  line: PlayerStatLine;
  teamId: TeamId | null;
}

/** Every player's line for a scope and year (year ignored for careers). */
export const scopedLines = (league: League, scope: StatScope, year: number): Map<PlayerId, ScopedLine> => {
  const out = new Map<PlayerId, ScopedLine>();
  const current = league.season.year;
  const seasonTeam = (id: PlayerId, y: number): TeamId | null =>
    league.careerStats[id]?.seasons.find((s) => s.year === y)?.teamId ?? findPlayer(league, id)?.teamId ?? null;
  if (scope === 'career') {
    for (const [id, c] of Object.entries(league.careerStats) as [PlayerId, League['careerStats'][PlayerId]][]) {
      const cur = league.season.stats[id];
      const committed = c.seasons.some((s) => s.year === current);
      out.set(id, { line: cur && !committed ? addLines(c.totals, cur) : c.totals, teamId: findPlayer(league, id)?.teamId ?? null });
    }
    for (const [id, line] of Object.entries(league.season.stats) as [PlayerId, PlayerStatLine][]) {
      if (!out.has(id)) out.set(id, { line, teamId: findPlayer(league, id)?.teamId ?? null });
    }
    return out;
  }
  if (year === current && hasCurrentStats(league)) {
    const table = scope === 'playoffs' ? league.season.playoffStats : league.season.stats;
    for (const [id, line] of Object.entries(table) as [PlayerId, PlayerStatLine][]) out.set(id, { line, teamId: seasonTeam(id, year) });
    return out;
  }
  for (const [id, c] of Object.entries(league.careerStats) as [PlayerId, League['careerStats'][PlayerId]][]) {
    const entry = c.seasons.find((s) => s.year === year);
    const line = entry ? (scope === 'playoffs' ? entry.playoffLine : entry.line) : null;
    if (line) out.set(id, { line, teamId: entry?.teamId ?? null });
  }
  return out;
};

/** Volume that qualifies a line for a category's leader board. */
export const groupVolume = (line: PlayerStatLine, group: LeaderGroup): number => {
  switch (group) {
    case 'passing': return line.passing.attempts;
    case 'rushing': return line.rushing.attempts;
    case 'receiving': return line.receiving.targets;
    case 'defense': return line.defense.tackles + line.defense.sacks + line.defense.interceptions + line.defense.passBreakups;
    case 'kicking': return line.kicking.fgAttempts + line.kicking.xpAttempts;
    case 'punting': return line.kicking.punts;
  }
};

/** Share of the category's top volume a player needs to appear on the board (keeps one-snap cameos off). */
export const QUALIFY_SHARE = 0.1;

/** One leader-board row. */
export interface LeaderRow {
  id: PlayerId;
  name: string;
  team: string;
  teamId: TeamId | null;
  position: Position | null;
  retired: boolean;
  line: PlayerStatLine;
}

/** Players with qualifying volume in a category for a scope and year. */
export const leaderRows = (league: League, group: LeaderGroup, scope: StatScope, year: number): LeaderRow[] => {
  const lines = scopedLines(league, scope, year);
  let max = 0;
  for (const s of lines.values()) max = Math.max(max, groupVolume(s.line, group));
  if (max <= 0) return [];
  const min = Math.max(1, Math.ceil(max * QUALIFY_SHARE));
  const rows: LeaderRow[] = [];
  for (const [id, s] of lines) {
    if (groupVolume(s.line, group) < min) continue;
    const p = findPlayer(league, id);
    const retired = !!league.retiredPlayers[id] || !!p?.retired;
    rows.push({
      id, name: playerName(league, id, String(id)), team: scope === 'career' && retired ? 'RET' : teamAbbr(league, s.teamId), teamId: s.teamId,
      position: p?.position ?? null, retired, line: s.line,
    });
  }
  return rows.sort((a, b) => (a.id < b.id ? -1 : 1));
};

/* ----------------------------- advanced columns ----------------------------- */

/** One advanced column. */
export interface AdvancedSpec {
  key: string;
  label: string;
  width: number;
  value(line: PlayerStatLine): number;
  text(line: PlayerStatLine): string;
  /** Sort direction when chosen (default 'desc'). */
  dir?: 'asc' | 'desc';
}

const int = (f: (l: PlayerStatLine) => number) => (l: PlayerStatLine): string => String(Math.round(f(l)));
const dec = (f: (l: PlayerStatLine) => number, d = 1) => (l: PlayerStatLine): string => f(l).toFixed(d);
const pct = (f: (l: PlayerStatLine) => number) => (l: PlayerStatLine): string => formatPercent(f(l), 1);
const adv = (l: PlayerStatLine): ReturnType<typeof advancedStats> => advancedStats(l);
const spec = (key: string, label: string, width: number, value: (l: PlayerStatLine) => number, text: (l: PlayerStatLine) => string, dir?: 'asc' | 'desc'): AdvancedSpec =>
  ({ key, label, width, value, text, ...(dir ? { dir } : {}) });

const epa = spec('epa', 'EPA/P', 6, (l) => adv(l).epaPerPlay, (l) => signedFixed(adv(l).epaPerPlay, 2));
const sr = spec('sr', 'SR%', 6, (l) => adv(l).successRate, pct((l) => adv(l).successRate));

/** Advanced columns per category (the first ones are kept in compact tables). */
export const ADVANCED_SPECS: Readonly<Record<LeaderGroup, readonly AdvancedSpec[]>> = Object.freeze({
  passing: [
    spec('rtg', 'RTG', 5, (l) => adv(l).passerRating, dec((l) => adv(l).passerRating)), epa, sr,
    spec('prs', 'PRS%', 6, (l) => safeRatio(l.passing.pressures, l.passing.attempts + l.passing.sacks), pct((l) => safeRatio(l.passing.pressures, l.passing.attempts + l.passing.sacks)), 'asc'),
    spec('ypa', 'YPA', 4, (l) => adv(l).yardsPerAttempt, dec((l) => adv(l).yardsPerAttempt)),
    spec('att', 'ATT', 4, (l) => l.passing.attempts, int((l) => l.passing.attempts)),
  ],
  rushing: [
    spec('ypc', 'YPC', 4, (l) => adv(l).yardsPerCarry, dec((l) => adv(l).yardsPerCarry)), epa, sr,
    spec('rexp', 'EXP%', 6, (l) => safeRatio(l.rushing.explosivePlays, l.rushing.attempts), pct((l) => safeRatio(l.rushing.explosivePlays, l.rushing.attempts))),
    spec('yco', 'YCO/C', 5, (l) => safeRatio(l.rushing.yardsAfterContact, l.rushing.attempts), dec((l) => safeRatio(l.rushing.yardsAfterContact, l.rushing.attempts))),
    spec('btk', 'BTK', 3, (l) => l.rushing.brokenTackles, int((l) => l.rushing.brokenTackles)),
    spec('car', 'CAR', 4, (l) => l.rushing.attempts, int((l) => l.rushing.attempts)),
  ],
  receiving: [
    spec('yac', 'YAC/R', 5, (l) => adv(l).yacPerReception, dec((l) => adv(l).yacPerReception)), epa, sr,
    spec('cexp', 'EXP%', 6, (l) => safeRatio(l.receiving.explosivePlays, l.receiving.targets), pct((l) => safeRatio(l.receiving.explosivePlays, l.receiving.targets))),
    spec('ctch', 'CTH%', 6, (l) => adv(l).catchRate, pct((l) => adv(l).catchRate)),
    spec('sep', 'SEP', 4, (l) => adv(l).avgSeparation, dec((l) => adv(l).avgSeparation)),
    spec('tgt', 'TGT', 4, (l) => l.receiving.targets, int((l) => l.receiving.targets)),
  ],
  defense: [
    spec('prate', 'PRS%', 6, (l) => adv(l).pressureRate, pct((l) => adv(l).pressureRate)),
    spec('cov', 'COV%', 6, (l) => adv(l).coverageSuccessRate, pct((l) => adv(l).coverageSuccessRate)),
    spec('mtk', 'MTK%', 6, (l) => adv(l).missedTackleRate, pct((l) => adv(l).missedTackleRate), 'asc'),
    spec('prs', 'PRS', 3, (l) => l.defense.pressures, int((l) => l.defense.pressures)),
    spec('tgta', 'TGT', 3, (l) => l.defense.targetsAllowed, int((l) => l.defense.targetsAllowed)),
    spec('ypt', 'YDS/T', 5, (l) => safeRatio(l.defense.yardsAllowed, l.defense.targetsAllowed), dec((l) => safeRatio(l.defense.yardsAllowed, l.defense.targetsAllowed)), 'asc'),
  ],
  kicking: [
    spec('fgpct', 'FG%', 6, (l) => safeRatio(l.kicking.fgMade, l.kicking.fgAttempts), pct((l) => safeRatio(l.kicking.fgMade, l.kicking.fgAttempts))),
    spec('xppct', 'XP%', 6, (l) => safeRatio(l.kicking.xpMade, l.kicking.xpAttempts), pct((l) => safeRatio(l.kicking.xpMade, l.kicking.xpAttempts))),
    spec('fglong', 'LNG', 3, (l) => l.kicking.fgLong, int((l) => l.kicking.fgLong)),
    spec('tbpct', 'TB%', 6, (l) => safeRatio(l.kicking.touchbacks, l.kicking.kickoffs), pct((l) => safeRatio(l.kicking.touchbacks, l.kicking.kickoffs))),
    spec('ko', 'KO', 3, (l) => l.kicking.kickoffs, int((l) => l.kicking.kickoffs)),
  ],
  punting: [
    spec('pavg2', 'AVG', 4, (l) => safeRatio(l.kicking.puntYards, l.kicking.punts), dec((l) => safeRatio(l.kicking.puntYards, l.kicking.punts))),
    spec('in20pct', 'IN20%', 6, (l) => safeRatio(l.kicking.puntsInside20, l.kicking.punts), pct((l) => safeRatio(l.kicking.puntsInside20, l.kicking.punts))),
    spec('ptb', 'TB', 3, (l) => l.kicking.touchbacks, int((l) => l.kicking.touchbacks), 'asc'),
    spec('plong', 'LNG', 3, (l) => l.kicking.puntLong, int((l) => l.kicking.puntLong)),
    spec('punts', 'PUNT', 4, (l) => l.kicking.punts, int((l) => l.kicking.punts)),
  ],
});

/** Sortable DataTable columns for advanced specs (right-aligned). */
export const advancedColumns = <R>(specs: readonly AdvancedSpec[], pick: (row: R) => PlayerStatLine): Column<R>[] =>
  specs.map((s) => ({
    key: s.key, label: s.label, width: s.width, align: 'right' as const, format: (r: R) => s.text(pick(r)), sortValue: (r: R) => s.value(pick(r)),
    ...(s.dir ? { defaultDir: s.dir } : {}),
  }));

/** Basic stat keys kept in compact (large text) leader tables. */
export const COMPACT_KEYS: Readonly<Record<LeaderGroup, readonly string[]>> = Object.freeze({
  passing: ['pyds', 'ptd', 'int', 'rtg'], rushing: ['ryds', 'ypc', 'rtd'], receiving: ['rec', 'cyds', 'ctd'],
  defense: ['tkl', 'sck', 'dint'], kicking: ['fgm', 'fga', 'fgl'], punting: ['pnt', 'pavg', 'in20'],
});

/** Default sort column per category (basic / advanced). */
export const LEADER_SORT: Readonly<Record<LeaderGroup, { basic: string; advanced: string }>> = Object.freeze({
  passing: { basic: 'pyds', advanced: 'rtg' }, rushing: { basic: 'ryds', advanced: 'ypc' }, receiving: { basic: 'cyds', advanced: 'yac' },
  defense: { basic: 'tkl', advanced: 'prate' }, kicking: { basic: 'fgm', advanced: 'fgpct' }, punting: { basic: 'pyd', advanced: 'pavg2' },
});

/* -------------------------------- team stats -------------------------------- */

/** One team's line for a scope. */
export interface TeamStatsRow {
  id: TeamId;
  abbr: string;
  name: string;
  games: number;
  line: TeamStatLine;
}

/**
 * Team lines for the current year: the regular season (Season.teamStats) or the postseason (summed from the
 * played playoff games). Null when the scope/year has no team stats (earlier years are not kept).
 */
export const teamStatsRows = (league: League, scope: Exclude<StatScope, 'career'>, year: number): TeamStatsRow[] | null => {
  if (year !== league.season.year) return null;
  const row = (id: TeamId, games: number, line: TeamStatLine): TeamStatsRow => ({ id, abbr: teamAbbr(league, id), name: teamName(league, id), games, line });
  if (scope === 'season') {
    return (Object.keys(league.teams) as TeamId[]).map((id) => {
      const s = league.season.standings[id];
      return row(id, s ? s.wins + s.losses + s.ties : 0, league.season.teamStats[id] ?? emptyTeamStatLine());
    });
  }
  const acc = new Map<TeamId, { games: number; line: TeamStatLine }>();
  for (const g of league.season.schedule) {
    if (!g.isPlayoff || !g.result) continue;
    for (const [side, id] of [['home', g.home], ['away', g.away]] as const) {
      const cur = acc.get(id) ?? { games: 0, line: emptyTeamStatLine() };
      acc.set(id, { games: cur.games + 1, line: mergeTeamStats(cur.line, g.result.stats.teams[side]) });
    }
  }
  return [...acc.entries()].map(([id, v]) => row(id, v.games, v.line));
};

/** One team's all-time record (finished seasons in Team.history). */
export interface AllTimeRow {
  id: TeamId;
  abbr: string;
  name: string;
  seasons: number;
  wins: number;
  losses: number;
  ties: number;
  pct: string;
  pctValue: number;
  playoffs: number;
  titles: number;
  bestWins: number;
}

/** All-time franchise records for every team. */
export const allTimeRows = (league: League): AllTimeRow[] =>
  Object.values(league.teams).map((t) => {
    const w = t.history.reduce((s, h) => s + h.wins, 0);
    const l = t.history.reduce((s, h) => s + h.losses, 0);
    const ti = t.history.reduce((s, h) => s + h.ties, 0);
    const g = w + l + ti;
    return {
      id: t.id, abbr: t.abbr, name: `${t.city} ${t.name}`, seasons: t.history.length, wins: w, losses: l, ties: ti, pct: pctText(w, l, ti),
      pctValue: g > 0 ? (w + ti / 2) / g : 0, playoffs: t.history.filter((h) => h.madePlayoffs).length, titles: t.championships,
      bestWins: t.history.reduce((m, h) => Math.max(m, h.wins), 0),
    };
  });
