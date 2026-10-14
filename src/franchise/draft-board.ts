/**
 * Draft boards. The consensus board is the public (noisy) projection; the user board is the user's
 * own ordering of prospects (move / insert / remove); team rankings and best-available read ONLY a
 * team's scouting reports plus public facts (position, age), never the ground truth. Pure.
 */
import type { PlayerId, TeamId } from '@/core/ids';
import type { Position } from '@/players/types';
import type { DraftState, Prospect, ScoutingReport } from '@/franchise/types';
import { DRAFT_CONFIG, ageValueBonus } from '@/franchise/prospects';
import type { DraftConfig } from '@/franchise/prospects';
import { gradeForValue, reportValue } from '@/franchise/scouting';

/** Letter grade a report implies (from its overall/potential range midpoints). */
export const gradeFor = (report: Pick<ScoutingReport, 'overallRange' | 'potentialRange'>, cfg: DraftConfig = DRAFT_CONFIG): string =>
  gradeForValue(reportValue(report, cfg), cfg);

/** 0 = best grade; unknown grades rank below F. */
export const gradeRank = (grade: string, cfg: DraftConfig = DRAFT_CONFIG): number => {
  const i = cfg.grades.findIndex((g) => g.grade === grade);
  return i < 0 ? cfg.grades.length : i;
};

/** Prospects still on the board (drafted/signed players have already left the pool). */
export const availableProspects = (draft: Pick<DraftState, 'prospects'>): readonly Prospect[] => draft.prospects;

/**
 * Public consensus order of the pool: consensusRank (noisy projection made at class generation),
 * falling back to projected round and then id for classes without ranks.
 */
export const consensusBoard = (prospects: readonly Prospect[]): PlayerId[] =>
  [...prospects]
    .sort((a, b) =>
      (a.consensusRank ?? Number.MAX_SAFE_INTEGER) - (b.consensusRank ?? Number.MAX_SAFE_INTEGER)
      || a.projectedRound - b.projectedRound
      || (a.player.id < b.player.id ? -1 : a.player.id > b.player.id ? 1 : 0))
    .map((p) => p.player.id);

/* -------------------------------------------------------------- user board */

const inPool = (draft: DraftState, id: PlayerId, fn: string): void => {
  if (!draft.prospects.some((p) => p.player.id === id)) throw new Error(`${fn}: prospect '${id}' is not in the draft pool`);
};

/** Replaces the user board (ids must be in the pool; duplicates dropped, first occurrence kept). */
export const setUserBoard = (draft: DraftState, ids: readonly PlayerId[]): DraftState => {
  for (const id of ids) inPool(draft, id, 'setUserBoard');
  return { ...draft, userBoard: [...new Set(ids)] };
};

/** Inserts a prospect at `index` (default: the end); an id already on the board is moved there instead. */
export const insertOnBoard = (draft: DraftState, id: PlayerId, index: number = draft.userBoard.length): DraftState => {
  inPool(draft, id, 'insertOnBoard');
  const board = draft.userBoard.filter((x) => x !== id);
  board.splice(Math.max(0, Math.min(Math.floor(index), board.length)), 0, id);
  return { ...draft, userBoard: board };
};

/** Moves a prospect already on the board to `toIndex` (clamped). */
export const moveOnBoard = (draft: DraftState, id: PlayerId, toIndex: number): DraftState => {
  if (!draft.userBoard.includes(id)) throw new Error(`moveOnBoard: prospect '${id}' is not on the user board`);
  return insertOnBoard(draft, id, toIndex);
};

/** Removes a prospect from the board (no-op when absent). */
export const removeFromBoard = (draft: DraftState, id: PlayerId): DraftState =>
  draft.userBoard.includes(id) ? { ...draft, userBoard: draft.userBoard.filter((x) => x !== id) } : draft;

/** The user board restricted to prospects still available, in board order. */
export const userBoardAvailable = (draft: DraftState): PlayerId[] => {
  const pool = new Set<string>(draft.prospects.map((p) => p.player.id));
  return draft.userBoard.filter((id) => pool.has(id));
};

/* -------------------------------------------------------- team rankings */

/** One row of a team's view of the pool. */
export interface BoardEntry {
  prospectId: PlayerId;
  position: Position;
  /** The team's report (null only when the team never received one). */
  report: ScoutingReport | null;
  /** Report value plus the (public) age term; the ranking key. */
  value: number;
  grade: string;
}

/** Filters for rankAvailable / bestAvailable. */
export interface BoardFilters {
  positions?: readonly Position[];
  maxAge?: number;
  /** Worst acceptable grade (e.g. 'B-'). */
  minGrade?: string;
  /** Only prospects on the user board. */
  onlyUserBoard?: boolean;
  limit?: number;
}

/** Value of an unscouted prospect from the public projection (consensus round). */
const publicValue = (p: Prospect): number => 78 - 4.5 * (p.projectedRound - 1);

/**
 * The pool ranked by one team's scouted value (best first), filtered. Reads the team's reports and
 * public facts only.
 */
export const rankAvailable = (draft: DraftState, teamId: TeamId, filters: BoardFilters = {}, cfg: DraftConfig = DRAFT_CONFIG): BoardEntry[] => {
  const reports = draft.reports[teamId] ?? {};
  const board = filters.onlyUserBoard ? new Set<string>(draft.userBoard) : null;
  const maxGradeRank = filters.minGrade !== undefined ? gradeRank(filters.minGrade, cfg) : Number.MAX_SAFE_INTEGER;
  const rows: BoardEntry[] = [];
  for (const p of draft.prospects) {
    const id = p.player.id;
    if (filters.positions && !filters.positions.includes(p.player.position)) continue;
    if (filters.maxAge !== undefined && p.player.age > filters.maxAge) continue;
    if (board && !board.has(id)) continue;
    const report = reports[id] ?? null;
    const base = report ? reportValue(report, cfg) : publicValue(p);
    const grade = report ? report.grade : gradeForValue(base, cfg);
    if (gradeRank(grade, cfg) > maxGradeRank) continue;
    rows.push({ prospectId: id, position: p.player.position, report, value: base + ageValueBonus(p.player.age, cfg), grade });
  }
  rows.sort((a, b) => b.value - a.value || (a.prospectId < b.prospectId ? -1 : 1));
  return filters.limit !== undefined ? rows.slice(0, Math.max(0, filters.limit)) : rows;
};

/** The single best available prospect in a team's eyes (null when nothing matches the filters). */
export const bestAvailable = (draft: DraftState, teamId: TeamId, filters: BoardFilters = {}, cfg: DraftConfig = DRAFT_CONFIG): BoardEntry | null =>
  rankAvailable(draft, teamId, { ...filters, limit: 1 }, cfg)[0] ?? null;
