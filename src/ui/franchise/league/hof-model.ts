/**
 * Pure view-models of the Hall of Fame tab and the career page: inductee rows (League.hallOfFame), the watch
 * list (hofCandidates) with each score's breakdown (hofBreakdown parts vs the position threshold), and the
 * career page lines built from careerSummary (overview, career and playoff totals, records, score breakdown).
 */
import type { PlayerId, TeamId } from '@/core/ids';
import { AWARD_LABELS } from '@/franchise/awards';
import { careerSummary, hofCandidates, type HofBreakdown } from '@/franchise/hall-of-fame';
import type { League } from '@/franchise/types';
import type { Position } from '@/players/types';
import { completionPct, passerRating, safeRatio } from '@/statistics/derived';
import type { PlayerStatLine } from '@/statistics/types';
import type { CellBar, CellValue } from '../kit/data-table';
import type { Tone, ToneText } from '../kit/format';
import { STAT_GROUP_LABELS, statGroupsFor, type StatGroup } from '../kit/stat-columns';
import { teamAbbr, teamName } from './common';

/** One Hall of Famer. */
export interface InducteeRow {
  id: PlayerId;
  year: number;
  name: string;
  position: string;
  seasons: number;
  peak: number;
  titles: number;
  awards: number;
  teams: string;
}

/** Every inductee, newest class first. */
export const inducteeRows = (league: League): InducteeRow[] =>
  [...league.hallOfFame].sort((a, b) => b.inductedYear - a.inductedYear || (a.name < b.name ? -1 : 1)).map((h) => ({
    id: h.playerId, year: h.inductedYear, name: h.name, position: h.position, seasons: h.seasons, peak: h.peakOverall, titles: h.championships,
    awards: h.awards.filter((a) => a.playerId !== null).length, teams: h.teams.map((t) => teamAbbr(league, t)).join('/'),
  }));

/** The newest class: its year and size (null when the Hall is empty). */
export const latestClass = (league: League): { year: number; count: number } | null => {
  if (league.hallOfFame.length === 0) return null;
  const year = Math.max(...league.hallOfFame.map((h) => h.inductedYear));
  return { year, count: league.hallOfFame.filter((h) => h.inductedYear === year).length };
};

/** One watch-list candidate. */
export interface CandidateRow {
  id: PlayerId;
  name: string;
  position: Position;
  status: ToneText;
  score: number;
  threshold: number;
  /** score / threshold (1 = on the line). */
  progress: number;
  retired: boolean;
  breakdown: HofBreakdown;
}

/** Watch list rows (best score first). */
export const candidateRows = (league: League, limit = 25): CandidateRow[] =>
  hofCandidates(league, limit).map((c) => ({
    id: c.playerId, name: c.name, position: c.position,
    status: c.eligible ? { text: 'Eligible', tone: 'success' } : c.retired ? { text: 'Retired', tone: 'dim' } : { text: 'Active', tone: 'info' },
    score: c.score, threshold: c.threshold, progress: c.threshold > 0 ? c.score / c.threshold : 0, retired: c.retired, breakdown: c.breakdown,
  }));

const one = (v: number): string => (Math.round(v * 10) / 10).toFixed(1);

/** "Prod 42.1 + Awards 10.0 + ... = 82.1 of 90.0". */
export const breakdownText = (b: HofBreakdown): string =>
  `Prod ${one(b.production)} + Awards ${one(b.awards)} + All-Pro ${one(b.allPro)} + Titles ${one(b.championships)} + Peak ${one(b.peak)} + Years ${one(b.longevity)}${b.preLeague > 0 ? ` + Pre-league ${one(b.preLeague)}` : ''} = ${one(b.total)} of ${one(b.threshold)}`;

/** The parts of a breakdown as label/points pairs (total last). */
export const breakdownParts = (b: HofBreakdown): { id: string; label: string; points: number }[] => [
  { id: 'production', label: 'Production', points: b.production },
  { id: 'awards', label: 'Awards', points: b.awards },
  { id: 'allPro', label: 'All-Pro selections', points: b.allPro },
  { id: 'championships', label: 'Championships', points: b.championships },
  { id: 'peak', label: 'Peak overall', points: b.peak },
  { id: 'longevity', label: 'Longevity', points: b.longevity },
  { id: 'preLeague', label: 'Pre-league honours', points: b.preLeague },
  { id: 'total', label: 'Total', points: b.total },
];

/* --------------------------------- career --------------------------------- */

/** One line of the career page. */
export interface CareerLine {
  id: string;
  label: string;
  value: CellValue;
  heading?: boolean;
  playerId?: PlayerId;
  teamId?: TeamId;
  bar?: CellBar | null;
}

const n = (v: number): string => String(Math.round(v)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/** Key totals of a stat category as one phrase ("4,512 yds, 38 TD, 9 INT, 95.3 rating"). */
export const groupSummary = (line: PlayerStatLine, group: StatGroup): string => {
  const p = line.passing, r = line.rushing, c = line.receiving, d = line.defense, k = line.kicking, b = line.blocking;
  switch (group) {
    case 'passing': return `${n(p.completions)}/${n(p.attempts)} (${completionPct(p).toFixed(1)}%), ${n(p.yards)} yds, ${n(p.touchdowns)} TD, ${n(p.interceptions)} INT, ${passerRating(p).toFixed(1)} rating`;
    case 'rushing': return `${n(r.attempts)} car, ${n(r.yards)} yds (${safeRatio(r.yards, r.attempts).toFixed(1)}), ${n(r.touchdowns)} TD`;
    case 'receiving': return `${n(c.receptions)} rec, ${n(c.yards)} yds, ${n(c.touchdowns)} TD`;
    case 'defense': return `${n(d.tackles)} tkl, ${Number.isInteger(d.sacks) ? n(d.sacks) : d.sacks.toFixed(1)} sacks, ${n(d.interceptions)} INT, ${n(d.forcedFumbles)} FF`;
    case 'kicking': return `${n(k.fgMade)}/${n(k.fgAttempts)} FG, long ${n(k.fgLong)}, ${n(k.xpMade)}/${n(k.xpAttempts)} XP`;
    case 'punting': return `${n(k.punts)} punts, ${safeRatio(k.puntYards, k.punts).toFixed(1)} avg, ${n(k.puntsInside20)} inside 20`;
    case 'blocking': return `${n(line.gamesStarted)} starts, ${n(b.pancakes)} pancakes, ${n(b.sacksAllowed)} sacks allowed`;
  }
};

/** The career page of a player, by section (null for an unknown player). */
export const careerLines = (league: League, playerId: PlayerId): { title: string; subtitle: string; overview: CareerLine[]; stats: CareerLine[]; hof: CareerLine[] } | null => {
  const s = careerSummary(league, playerId);
  if (!s) return null;
  const hof = league.hallOfFame.find((h) => h.playerId === playerId);
  const status: ToneText = hof ? { text: `Hall of Fame, class of ${hof.inductedYear}`, tone: 'accent' } : s.retired ? { text: 'Retired', tone: 'dim' } : { text: 'Active', tone: 'info' };
  const overview: CareerLine[] = [
    { id: 'card', label: 'Player card', value: { text: 'Open', tone: 'info' }, playerId },
    { id: 'status', label: 'Status', value: status },
    { id: 'seasons', label: 'Seasons', value: s.tenure > s.seasons ? `${s.seasons} in league (${s.tenure} pro)` : String(s.seasons) },
    { id: 'peak', label: 'Peak overall', value: `${s.peakOverall} (now ${s.overall})` },
    { id: 'titles', label: 'Championships', value: String(s.championships) },
    { id: 'allpro', label: 'All-Pro selections', value: String(s.allPros) },
    ...s.teams.map((t, i): CareerLine => ({ id: `team:${t}`, label: i === 0 ? 'Teams' : '', value: teamName(league, t), teamId: t })),
    { id: 'h:awards', label: `Awards (${s.awards.filter((a) => a.playerId).length})`, value: '', heading: true },
    ...s.awards.filter((a) => a.playerId).map((a, i): CareerLine => ({ id: `award:${i}`, label: String(a.year), value: `${AWARD_LABELS[a.award]} (${teamAbbr(league, a.teamId)})` })),
    { id: 'h:records', label: `Records held (${s.records.length})`, value: '', heading: true },
    ...s.records.map((r): CareerLine => ({ id: `rec:${r.key}`, label: r.label, value: `${Number.isInteger(r.value) ? r.value : r.value.toFixed(1)} (${r.year})` })),
  ];
  const groups: StatGroup[] = [...statGroupsFor(s.position)];
  const stats: CareerLine[] = [
    { id: 'h:reg', label: 'Regular season', value: `${s.totals.gamesPlayed} games`, heading: true },
    ...groups.map((g): CareerLine => ({ id: `reg:${g}`, label: STAT_GROUP_LABELS[g], value: groupSummary(s.totals, g) })),
    { id: 'h:po', label: 'Playoffs', value: `${s.playoffTotals.gamesPlayed} games`, heading: true },
    ...groups.map((g): CareerLine => ({ id: `po:${g}`, label: STAT_GROUP_LABELS[g], value: groupSummary(s.playoffTotals, g) })),
    { id: 'h:years', label: 'By season', value: '', heading: true },
    ...s.bySeason.map((e): CareerLine => ({ id: `yr:${e.year}`, label: `${e.year} ${teamAbbr(league, e.teamId)}`, value: groupSummary(e.line, groups[0] ?? 'defense'), ...(e.teamId ? { teamId: e.teamId } : {}) })),
  ];
  const b = s.hof;
  const tone = (pts: number): Tone => (b.threshold > 0 && pts >= b.threshold ? 'success' : 'info');
  const hofLines: CareerLine[] = breakdownParts(b).map((p) => ({
    id: `hof:${p.id}`, label: p.label, value: { text: one(p.points), tone: p.id === 'total' ? tone(p.points) : 'normal' },
    bar: { value: b.threshold > 0 ? Math.min(99, (p.points / b.threshold) * 99) : 0, tone: p.id === 'total' ? tone(p.points) : 'info' },
  }));
  hofLines.push({ id: 'hof:threshold', label: `${s.position} threshold`, value: { text: one(b.threshold), tone: 'dim' }, bar: { value: 99, tone: 'dim' } });
  return {
    title: `${s.name} · ${s.position}`, subtitle: `${status.text} · ${s.teams.map((t) => teamAbbr(league, t)).join('/') || 'no team'}`,
    overview, stats, hof: hofLines,
  };
};
