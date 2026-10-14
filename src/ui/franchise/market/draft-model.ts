/**
 * Pure view-models and actions of the draft room: the clock (currentPick / onTheClock), best available by the
 * user's own reports with a team-need fit (rankAvailable + gm/needs), the full order with owners and selections,
 * the picks log graded by the user's reports, and the pick / auto-pick / sim / finish actions. Prospect numbers
 * come only from the user's scouting reports (see scouting-model.ts).
 */
import type { PlayerId, TeamId } from '@/core/ids';
import type { Rng } from '@/core/rng';
import type { Position } from '@/players/types';
import { gradeRank } from '@/franchise/draft-board';
import { autoPickFor, currentPick, finishDraft, isUserOnTheClock, makePick, onTheClock, runDraftToEnd, simToUserPick, startDraft } from '@/franchise/draft';
import { indexPicks } from '@/franchise/draft-order';
import { MAJOR_NEED, teamNeeds } from '@/franchise/gm/needs';
import type { DraftState, League } from '@/franchise/types';
import type { ToneText } from '../kit/format';
import { teamAbbr } from './common';
import { prospectRows, type ProspectRow } from './scouting-model';

/** The draft this year (null before the class exists or for another year). */
export const thisDraft = (league: League): DraftState | null => (league.draft && league.draft.year === league.year ? league.draft : null);

/** Where the draft stands for the user. */
export interface DraftRoomStatus {
  started: boolean;
  complete: boolean;
  /** Index of the pick on the clock and the number of picks. */
  pickIndex: number;
  totalPicks: number;
  round: number | null;
  pickInRound: number | null;
  overall: number | null;
  onClock: TeamId | null;
  onClockAbbr: string;
  userOnClock: boolean;
  userPicksLeft: number;
  nextUserOverall: number | null;
  /** Picks before the user's next one (0 = on the clock). */
  picksUntilUser: number | null;
  poolSize: number;
}

/** Draft room status for the user team. */
export const draftRoomStatus = (league: League, userId: TeamId): DraftRoomStatus => {
  const d = thisDraft(league);
  const started = !!d && d.order.length > 0;
  const pick = d && started ? currentPick(d) : null;
  const holders = indexPicks(league.teams);
  const ownerOf = (id: string, fallback: TeamId): TeamId => holders.get(id)?.holder ?? fallback;
  const upcoming = d && started ? d.order.slice(d.currentPickIndex) : [];
  const mineAhead = upcoming.map((p, i) => ({ p, i })).filter(({ p }) => ownerOf(p.id, p.ownerTeamId) === userId);
  const next = mineAhead[0];
  const onClock = started ? onTheClock(league) : null;
  return {
    started, complete: !!d?.complete, pickIndex: d?.currentPickIndex ?? 0, totalPicks: d?.order.length ?? 0,
    round: pick?.round ?? null, pickInRound: pick && d ? d.order.filter((p) => p.round === pick.round).findIndex((p) => p.id === pick.id) + 1 : null,
    overall: pick ? (pick.overall ?? (d?.currentPickIndex ?? 0) + 1) : null, onClock, onClockAbbr: onClock ? teamAbbr(league, onClock) : '-',
    userOnClock: started && isUserOnTheClock(league), userPicksLeft: mineAhead.length, nextUserOverall: next ? (next.p.overall ?? (d?.currentPickIndex ?? 0) + next.i + 1) : null,
    picksUntilUser: next ? next.i : null, poolSize: d?.prospects.length ?? 0,
  };
};

/** Badge for the Draft tab: "!" while the user is on the clock. */
export const draftBadge = (league: League): string | null => (thisDraft(league)?.order.length && isUserOnTheClock(league) ? '!' : null);

/* -------------------------------------------------------------- available */

/** An available prospect with the user's need at his position. */
export interface AvailableRow extends ProspectRow {
  need: number;
  needText: ToneText;
  /** Report value plus a need bonus (the "best for us" key). */
  fit: number;
}

/** Need weight in the fit key (points of report value per unit of need). */
export const NEED_FIT_WEIGHT = 20;
/** Share of the need bonus a position earns: a kicker or punter hole is real but never worth a premium pick. */
export const NEED_POSITION_SHARE: Readonly<Partial<Record<Position, number>>> = Object.freeze({ K: 0.2, P: 0.2 });

/** The pool through the user's reports, with need and fit. */
export const availableRows = (league: League, userId: TeamId): AvailableRow[] => {
  const d = thisDraft(league);
  const team = league.teams[userId];
  if (!d || !team) return [];
  const needs = teamNeeds(league, team);
  return prospectRows(d, userId).map((r) => {
    const need = needs.positions[r.position].need;
    const needText: ToneText = need >= MAJOR_NEED ? { text: 'High', tone: 'warning' } : need >= 0.2 ? { text: 'Some', tone: 'normal' } : { text: 'Low', tone: 'dim' };
    return { ...r, need, needText, fit: r.value + NEED_FIT_WEIGHT * need * (NEED_POSITION_SHARE[r.position] ?? 1) };
  });
};

/* ------------------------------------------------------------------ order */

/** One pick of the order. */
export interface OrderRow {
  id: string;
  index: number;
  overall: number;
  label: string;
  round: number;
  owner: TeamId;
  ownerAbbr: string;
  via: string | null;
  isUser: boolean;
  isCurrent: boolean;
  made: boolean;
  selection: string | null;
}

/** "1-12" for round 1, 12th pick of the round. */
const roundPick = (round: number, inRound: number): string => `${round}-${inRound}`;

/** The whole order: owners (after trades), the pick on the clock and the selections made. */
export const orderRows = (league: League, userId: TeamId): OrderRow[] => {
  const d = thisDraft(league);
  if (!d) return [];
  const holders = indexPicks(league.teams);
  const made = new Map(d.selections.map((s) => [s.pick.id, s]));
  const perRound = new Map<number, number>();
  return d.order.map((p, index) => {
    const inRound = (perRound.get(p.round) ?? 0) + 1;
    perRound.set(p.round, inRound);
    const sel = made.get(p.id);
    const owner = sel ? sel.pick.ownerTeamId : (holders.get(p.id)?.holder ?? p.ownerTeamId);
    const player = sel ? league.players[sel.playerId] : undefined;
    return {
      id: p.id, index, overall: p.overall ?? index + 1, label: roundPick(p.round, inRound), round: p.round, owner, ownerAbbr: teamAbbr(league, owner),
      via: p.originalTeamId !== owner ? teamAbbr(league, p.originalTeamId) : null, isUser: owner === userId, isCurrent: !d.complete && index === d.currentPickIndex,
      made: !!sel, selection: sel ? (player ? `${player.firstName} ${player.lastName} (${player.position})` : sel.playerId) : null,
    };
  });
};

/** One selection, graded by the user's report on the player. */
export interface LogRow {
  id: string;
  overall: number;
  label: string;
  teamId: TeamId;
  team: string;
  playerId: PlayerId;
  name: string;
  position: string;
  grade: string;
  gradeRank: number;
  isUser: boolean;
}

/** Selections so far, newest first. */
export const logRows = (league: League, userId: TeamId): LogRow[] => {
  const d = thisDraft(league);
  if (!d) return [];
  const labels = new Map(orderRows(league, userId).map((r) => [r.id, r.label]));
  const reports = d.reports[userId] ?? {};
  return d.selections.map((s, i) => {
    const p = league.players[s.playerId];
    const grade = reports[s.playerId]?.grade ?? '?';
    return {
      id: s.pick.id, overall: s.pick.overall ?? i + 1, label: labels.get(s.pick.id) ?? `${s.pick.round}-?`, teamId: s.pick.ownerTeamId, team: teamAbbr(league, s.pick.ownerTeamId),
      playerId: s.playerId, name: p ? `${p.firstName} ${p.lastName}` : s.playerId, position: p?.position ?? '?', grade, gradeRank: gradeRank(grade), isUser: s.pick.ownerTeamId === userId,
    };
  }).reverse();
};

/* ---------------------------------------------------------------- actions */

/** Starts this year's draft (class, pro days, order) unless it is already running or done. */
export const ensureDraftStarted = (league: League, rng: Rng): League => {
  const d = thisDraft(league);
  return d && (d.complete || d.order.length > 0) ? league : startDraft(league, rng);
};

const finishIfDone = (league: League, rng: Rng): League => (league.draft && !league.draft.complete && currentPick(league.draft) === null ? finishDraft(league, rng) : league);

/** The user drafts `prospectId` with the pick on the clock (the last pick also finishes the draft). */
export const draftProspect = (league: League, userId: TeamId, prospectId: PlayerId, rng: Rng): League => {
  if (!isUserOnTheClock(league) || league.userTeamId !== userId) throw new Error('draft: you are not on the clock');
  return finishIfDone(makePick(league, prospectId), rng.fork('finish'));
};

/** Auto-pick for the user (his board first, else the best on his reports). */
export const autoPickUser = (league: League, userId: TeamId, rng: Rng): { league: League; playerId: PlayerId } => {
  if (!isUserOnTheClock(league)) throw new Error('autoPick: you are not on the clock');
  const playerId = autoPickFor(league, userId, rng.fork('auto'));
  return { league: draftProspect(league, userId, playerId, rng), playerId };
};

/** Sims AI picks until the user is on the clock (or the draft ends). */
export const simToMine = (league: League, rng: Rng): League => simToUserPick(ensureDraftStarted(league, rng.fork('start')), rng.fork('sim'));

/** Sims the rest of the draft, auto-picking for the user. */
export const simToEnd = (league: League, rng: Rng): League => finishIfDone(runDraftToEnd(ensureDraftStarted(league, rng.fork('start')), rng.fork('sim')), rng.fork('finish'));

/** Closes a draft whose picks are all made. */
export const closeDraft = (league: League, rng: Rng): League => finishIfDone(league, rng);
