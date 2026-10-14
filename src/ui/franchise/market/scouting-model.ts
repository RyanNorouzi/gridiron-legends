/**
 * Pure view-models and actions of the scouting tab and the draft room's prospect lists.
 *
 * IMPERFECT INFORMATION: every rating-like number comes from the USER TEAM's ScoutingReport
 * (DraftState.reports[userTeamId]); from Prospect.player only the public facts in PUBLIC_PLAYER_FIELDS (name,
 * position, age, height, weight) are read, plus the public Prospect fields (college, consensus, combine, pro day).
 * Ground truth (overall, potential, attributes, dev trait, personality) is never touched here.
 *
 * Scouting points: the week's points bank in DraftState.scouting[user]; the user builds a plan (points per
 * prospect and interviews) and applies it atomically (applyScoutingPlan), or invests / interviews one prospect at
 * once from the report (allocateScouting / interview). The draft board is edited with the draft-board functions.
 */
import type { PlayerId, TeamId } from '@/core/ids';
import { insertOnBoard, moveOnBoard, rankAvailable, removeFromBoard, setUserBoard, gradeRank } from '@/franchise/draft-board';
import { DRAFT_CONFIG } from '@/franchise/prospects';
import { allocateScouting, applyScoutingPlan, interview, reportValue, scoutingEntry, scoutingPointsPerWeek } from '@/franchise/scouting';
import type { CombineResults, DraftState, League, Prospect, ScoutingReport } from '@/franchise/types';
import type { DevTrait, PersonalityTrait, Position } from '@/players/types';
import { formatRatingRange, type ToneText } from '../kit/format';

/** The only Prospect.player fields the market UI reads (public facts). */
export const PUBLIC_PLAYER_FIELDS = ['id', 'firstName', 'lastName', 'position', 'age', 'heightIn', 'weightLb'] as const;

/** Public facts about a prospect. */
export interface ProspectPublic {
  id: PlayerId;
  name: string;
  position: Position;
  age: number;
  heightIn: number;
  weightLb: number;
  college: string;
  projectedRound: number;
  consensusRank: number | null;
  combine: CombineResults;
  proDay: Partial<CombineResults> | null;
}

/** Reads a prospect's public facts (and nothing else from Prospect.player). */
export const publicProspect = (p: Prospect): ProspectPublic => {
  const pl = p.player;
  return {
    id: pl.id, name: `${pl.firstName} ${pl.lastName}`, position: pl.position, age: pl.age, heightIn: pl.heightIn, weightLb: pl.weightLb,
    college: p.college, projectedRound: p.projectedRound, consensusRank: p.consensusRank ?? null, combine: p.combine, proDay: p.proDay,
  };
};

/** A points-and-interviews plan for this week's scouting. */
export interface ScoutPlan {
  invest: ReadonlyMap<PlayerId, number>;
  interviews: ReadonlySet<PlayerId>;
}

/** A plan with nothing in it. */
export const EMPTY_PLAN: ScoutPlan = Object.freeze({ invest: new Map<PlayerId, number>(), interviews: new Set<PlayerId>() });

/** One prospect as the user's scouts see him. */
export interface ProspectRow extends ProspectPublic {
  report: ScoutingReport | null;
  overall: ToneText;
  potential: ToneText;
  grade: string;
  /** 0 = best grade. */
  gradeRank: number;
  /** 0..1. */
  confidence: number;
  invested: number;
  interviewed: boolean;
  redFlags: string[];
  traits: PersonalityTrait[];
  devEstimate: DevTrait | null;
  /** 1-based spot on the user's board, or null. */
  boardRank: number | null;
  /** Report value (range midpoints blended), the ranking key. */
  value: number;
  plannedPoints: number;
  plannedInterview: boolean;
}

const UNKNOWN: ToneText = { text: '?', tone: 'dim' };

/** A row from public facts plus the user's report (never the ground truth). */
export const prospectRow = (prospect: Prospect, report: ScoutingReport | null, invested: number, boardRank: number | null, plan: ScoutPlan = EMPTY_PLAN): ProspectRow => {
  const pub = publicProspect(prospect);
  return {
    ...pub, report,
    overall: report ? formatRatingRange(report.overallRange[0], report.overallRange[1]) : UNKNOWN,
    potential: report ? formatRatingRange(report.potentialRange[0], report.potentialRange[1]) : UNKNOWN,
    grade: report?.grade ?? '?', gradeRank: report ? gradeRank(report.grade) : DRAFT_CONFIG.grades.length,
    confidence: report?.confidence ?? 0, invested, interviewed: report?.interviewed ?? false, redFlags: report?.redFlags ?? [],
    traits: report?.traitsRevealed ?? [], devEstimate: report?.devTraitEstimate ?? null, boardRank,
    value: report ? reportValue(report) : 0, plannedPoints: plan.invest.get(pub.id) ?? 0, plannedInterview: plan.interviews.has(pub.id),
  };
};

/** Every available prospect through the team's reports (optionally one position). */
export const prospectRows = (draft: DraftState, teamId: TeamId, plan: ScoutPlan = EMPTY_PLAN, position: Position | null = null): ProspectRow[] => {
  const reports = draft.reports[teamId] ?? {};
  const entry = scoutingEntry(draft, teamId);
  const board = new Map(draft.userBoard.map((id, i) => [id, i + 1]));
  return draft.prospects
    .filter((p) => position === null || p.player.position === position)
    .map((p) => prospectRow(p, reports[p.player.id] ?? null, entry.invested[p.player.id] ?? 0, board.get(p.player.id) ?? null, plan));
};

/** The user's board (available prospects only), in board order. */
export const boardRows = (draft: DraftState, teamId: TeamId, plan: ScoutPlan = EMPTY_PLAN): ProspectRow[] => {
  const byId = new Map(prospectRows(draft, teamId, plan).map((r) => [r.id, r]));
  return draft.userBoard.map((id) => byId.get(id)).filter((r): r is ProspectRow => !!r);
};

/* ------------------------------------------------------------------ status */

/** Scouting budget and plan for the status line. */
export interface ScoutingStatus {
  open: boolean;
  points: number;
  perWeek: number;
  planCost: number;
  remaining: number;
  quality: number;
  interviewCost: number;
  maxPerProspect: number;
  prospects: number;
  board: number;
}

/** Points spent by a plan. */
export const planCost = (plan: ScoutPlan): number =>
  [...plan.invest.values()].reduce((s, v) => s + v, 0) + plan.interviews.size * DRAFT_CONFIG.scouting.interviewCost;

/** True while this year's class can be scouted (open, draft not started). */
export const scoutingOpen = (league: League): boolean => {
  const d = league.draft;
  return !!d && d.year === league.year && !d.complete && d.order.length === 0 && league.season.phase !== 'draft';
};

/** Budget, plan cost and pool size for the user team. */
export const scoutingStatus = (league: League, teamId: TeamId, plan: ScoutPlan = EMPTY_PLAN): ScoutingStatus => {
  const draft = league.draft;
  const team = league.teams[teamId];
  const entry = draft ? scoutingEntry(draft, teamId) : { pointsAvailable: 0, invested: {} };
  const cost = planCost(plan);
  return {
    open: scoutingOpen(league), points: entry.pointsAvailable, perWeek: team ? scoutingPointsPerWeek(team, league.coaches) : 0, planCost: cost,
    remaining: entry.pointsAvailable - cost, quality: draft?.scouting[teamId]?.scoutQuality ?? 50, interviewCost: DRAFT_CONFIG.scouting.interviewCost,
    maxPerProspect: DRAFT_CONFIG.scouting.maxInvestedPerProspect, prospects: draft?.prospects.length ?? 0, board: draft?.userBoard.length ?? 0,
  };
};

/* -------------------------------------------------------------------- plan */

/** Most points the plan may put on one prospect (his cap and the budget left after the rest of the plan). */
export const maxPlanPoints = (draft: DraftState, teamId: TeamId, plan: ScoutPlan, id: PlayerId): number => {
  const entry = scoutingEntry(draft, teamId);
  const others = planCost(plan) - (plan.invest.get(id) ?? 0);
  return Math.max(0, Math.min(DRAFT_CONFIG.scouting.maxInvestedPerProspect - (entry.invested[id] ?? 0), Math.floor(entry.pointsAvailable - others)));
};

/** The plan with `points` on one prospect (0 removes him). */
export const withPlanPoints = (plan: ScoutPlan, id: PlayerId, points: number): ScoutPlan => {
  const invest = new Map(plan.invest);
  if (points > 0) invest.set(id, Math.round(points));
  else invest.delete(id);
  return { invest, interviews: plan.interviews };
};

/** Adds or removes an interview; prospects already interviewed are refused (throws). */
export const togglePlanInterview = (draft: DraftState, teamId: TeamId, plan: ScoutPlan, id: PlayerId): ScoutPlan => {
  const interviews = new Set(plan.interviews);
  if (interviews.has(id)) interviews.delete(id);
  else {
    if (draft.reports[teamId]?.[id]?.interviewed) throw new Error('interview: he has already been interviewed');
    interviews.add(id);
  }
  return { invest: plan.invest, interviews };
};

/** Spreads the available points over the top `count` prospects (board first, then by report value). */
export const quickPlan = (draft: DraftState, teamId: TeamId, count = 8): ScoutPlan => {
  const entry = scoutingEntry(draft, teamId);
  const cap = DRAFT_CONFIG.scouting.maxInvestedPerProspect;
  const ranked = rankAvailable(draft, teamId).map((e) => e.prospectId);
  const board = draft.userBoard.filter((id) => ranked.includes(id));
  const order = [...board, ...ranked.filter((id) => !board.includes(id))].filter((id) => (entry.invested[id] ?? 0) < cap).slice(0, count);
  let left = Math.floor(entry.pointsAvailable);
  const invest = new Map<PlayerId, number>();
  for (let i = 0; i < order.length && left > 0; i++) {
    const id = order[i] as PlayerId;
    const share = Math.ceil(left / (order.length - i));
    const pts = Math.min(share, cap - (entry.invested[id] ?? 0), left);
    if (pts > 0) invest.set(id, pts);
    left -= pts;
  }
  return { invest, interviews: new Set() };
};

const withDraft = (league: League, fn: (d: DraftState) => DraftState): League => {
  if (!league.draft) throw new Error('no draft class is open');
  return { ...league, draft: fn(league.draft) };
};

/** Like withDraft, but only while the class may be scouted (scoutingOpen): the engine does not check the phase itself. */
const whileScouting = (league: League, fn: (d: DraftState) => DraftState): League => {
  if (!scoutingOpen(league)) throw new Error('scouting is closed until the next class opens');
  return withDraft(league, fn);
};

/** Applies the whole plan (throws when it costs more than the bank, or once scouting has closed). */
export const applyPlan = (league: League, teamId: TeamId, plan: ScoutPlan): League =>
  whileScouting(league, (d) => applyScoutingPlan(d, teamId, { invest: plan.invest, interviews: [...plan.interviews] }));

/** Invests points in one prospect now (throws once scouting has closed). */
export const investNow = (league: League, teamId: TeamId, id: PlayerId, points: number): League => whileScouting(league, (d) => allocateScouting(d, teamId, id, points));

/** Interviews one prospect now (throws once scouting has closed). */
export const interviewNow = (league: League, teamId: TeamId, id: PlayerId): League => whileScouting(league, (d) => interview(d, teamId, id));

/* ------------------------------------------------------------------- board */

/** Adds a prospect to the end of the board (or moves him to `index`). */
export const boardAdd = (league: League, id: PlayerId, index?: number): League => withDraft(league, (d) => insertOnBoard(d, id, index));
/** Removes a prospect from the board. */
export const boardRemove = (league: League, id: PlayerId): League => withDraft(league, (d) => removeFromBoard(d, id));
/** Moves a board prospect by `delta` spots (or to the top / bottom). */
export const boardShift = (league: League, id: PlayerId, delta: number | 'top' | 'bottom'): League => withDraft(league, (d) => {
  const i = d.userBoard.indexOf(id);
  if (i < 0) throw new Error('moveOnBoard: he is not on your board');
  const to = delta === 'top' ? 0 : delta === 'bottom' ? d.userBoard.length - 1 : Math.max(0, Math.min(d.userBoard.length - 1, i + delta));
  return moveOnBoard(d, id, to);
});
/** Replaces the board with the best `limit` prospects by the team's own grades. */
export const boardFromGrades = (league: League, teamId: TeamId, limit = 64): League =>
  withDraft(league, (d) => setUserBoard(d, rankAvailable(d, teamId, { limit }).map((e) => e.prospectId)));

/** Badge for the Scouting tab: whole points waiting to be spent, or null. */
export const scoutingBadge = (league: League): string | null => {
  const user = league.userTeamId;
  const points = user && league.draft ? Math.floor(scoutingEntry(league.draft, user).pointsAvailable) : 0;
  return scoutingOpen(league) && points > 0 ? String(points) : null;
};
