/**
 * Depth-chart view-model and edits for the user's team. One list per DepthSlot (QB..P, KR, PR) in playing
 * order; starters are the first STARTER_COUNTS[slot]. Edits (move up/down, move to a rank, swap, add a
 * returner or a cross-position backup, remove an extra listing, auto rebuild) return ActionResults whose
 * League carries the new chart with the team's cached ratings refreshed (roster.ts refreshTeamInPlace keeps a
 * user chart's manual order). Validation comes from teams/depth-chart.ts validateDepthChart; edits never
 * shrink a slot below its starter count, so they cannot introduce 'understaffed' errors.
 */
import type { PlayerId, TeamId } from '@/core/ids';
import { beginRosterEdit, refreshTeamInPlace, rosterPlayers } from '@/franchise/roster';
import type { League } from '@/franchise/types';
import { canPlayHurt } from '@/players/injuries';
import { fullName, type InjuryStatus, type Player, type Position } from '@/players/types';
import {
  DEPTH_SLOTS, RETURNER_POSITIONS, STARTER_COUNTS, applySubstitution, autoDepthChart, cloneDepthChart, returnScore, validateDepthChart,
  type DepthChartIssue,
} from '@/teams/depth-chart';
import type { DepthChart, DepthSlot } from '@/teams/types';
import { POSITION_NAMES } from '../kit/format';
import type { TabSpec } from '../kit/tabbar';
import { done, refused, type ActionResult } from './common';

/** One player listed in a slot. */
export interface DepthRow {
  id: PlayerId;
  /** 0-based depth rank. */
  rank: number;
  name: string;
  position: Position;
  overall: number;
  /** Slot rating: return score for KR/PR, overall elsewhere. */
  rating: number;
  injury: InjuryStatus | null;
  /** False when his injury keeps him out of the lineup. */
  available: boolean;
  fatigue: number;
  starter: boolean;
  /** Listed outside his own position (KR/PR excluded). */
  outOfPosition: boolean;
  /** Worst validation issue naming him in this slot. */
  issue: DepthChartIssue | null;
}

/** True for the return roles. */
export const isReturnSlot = (slot: DepthSlot): slot is 'KR' | 'PR' => slot === 'KR' || slot === 'PR';

/** Human name of a slot. */
export const slotName = (slot: DepthSlot): string => (slot === 'KR' ? 'Kick Returner' : slot === 'PR' ? 'Punt Returner' : POSITION_NAMES[slot]);

/** Validation issues of the team's chart. */
export const depthIssues = (league: League, teamId: TeamId): DepthChartIssue[] => {
  const team = league.teams[teamId];
  return team ? validateDepthChart(team.depthChart, rosterPlayers(league, teamId)) : [];
};

/** Rows of one slot in depth order. */
export const slotRows = (league: League, teamId: TeamId, slot: DepthSlot): DepthRow[] => {
  const team = league.teams[teamId];
  if (!team) return [];
  const issues = depthIssues(league, teamId).filter((i) => i.slot === slot);
  return (team.depthChart[slot] ?? []).map((id, rank): DepthRow | null => {
    const p = league.players[id];
    if (!p) return null;
    const mine = issues.filter((i) => i.playerId === id);
    return {
      id, rank, name: fullName(p), position: p.position, overall: p.overall,
      rating: isReturnSlot(slot) ? Math.round(returnScore(p, slot)) : p.overall,
      injury: p.injury, available: canPlayHurt(p), fatigue: league.fatigue?.[id] ?? 0, starter: rank < STARTER_COUNTS[slot],
      outOfPosition: !isReturnSlot(slot) && p.position !== slot,
      issue: mine.find((i) => i.severity === 'error') ?? mine[0] ?? null,
    };
  }).filter((r): r is DepthRow => r !== null);
};

/** Error/warning counts per slot. */
export const slotIssueCounts = (issues: readonly DepthChartIssue[]): Record<DepthSlot, { errors: number; warnings: number }> => {
  const out = {} as Record<DepthSlot, { errors: number; warnings: number }>;
  for (const s of DEPTH_SLOTS) out[s] = { errors: 0, warnings: 0 };
  for (const i of issues) {
    const c = out[i.slot];
    if (!c) continue;
    if (i.severity === 'error') c.errors++;
    else c.warnings++;
  }
  return out;
};

/** Slot chips with a "!" badge on slots holding errors and the warning count otherwise. */
export const depthChips = (league: League, teamId: TeamId): TabSpec[] => {
  const counts = slotIssueCounts(depthIssues(league, teamId));
  return DEPTH_SLOTS.map((s) => ({ id: s, label: s, badge: counts[s].errors > 0 ? '!' : counts[s].warnings > 0 ? String(counts[s].warnings) : null }));
};

/** The League with `chart` installed on the team and its cached ratings refreshed. */
export const withDepthChart = (league: League, teamId: TeamId, chart: DepthChart): League => {
  const team = league.teams[teamId];
  if (!team) throw new Error(`withDepthChart: unknown team ${teamId}`);
  const work = beginRosterEdit(league);
  work.teams[teamId] = { ...team, depthChart: chart };
  refreshTeamInPlace(work, teamId, false);
  return work;
};

const slotList = (league: League, teamId: TeamId, slot: DepthSlot): PlayerId[] | null => league.teams[teamId]?.depthChart[slot] ?? null;

/** Moves a listed player to `rank` (clamped) within the slot. */
export const setRankInSlot = (league: League, teamId: TeamId, slot: DepthSlot, playerId: PlayerId, rank: number): ActionResult => {
  const list = slotList(league, teamId, slot);
  const team = league.teams[teamId];
  if (!list || !team) return refused(league, 'Unknown team');
  const from = list.indexOf(playerId);
  if (from < 0) return refused(league, `Not listed at ${slot}`);
  const to = Math.max(0, Math.min(list.length - 1, Math.floor(rank)));
  if (to === from) return refused(league, from === 0 ? 'Already first' : 'Already last');
  const p = league.players[playerId];
  const chart = applySubstitution(team.depthChart, slot, playerId, to);
  return done(withDepthChart(league, teamId, chart), `${p ? fullName(p) : playerId} is now ${slot}${to + 1}`);
};

/** Moves a player one place up (-1) or down (+1). */
export const moveInSlot = (league: League, teamId: TeamId, slot: DepthSlot, playerId: PlayerId, delta: -1 | 1): ActionResult => {
  const list = slotList(league, teamId, slot);
  const from = list ? list.indexOf(playerId) : -1;
  if (from < 0) return refused(league, `Not listed at ${slot}`);
  return setRankInSlot(league, teamId, slot, playerId, from + delta);
};

/** Swaps two players listed in the same slot. */
export const swapInSlot = (league: League, teamId: TeamId, slot: DepthSlot, a: PlayerId, b: PlayerId): ActionResult => {
  const team = league.teams[teamId];
  const list = team?.depthChart[slot];
  if (!team || !list) return refused(league, 'Unknown team');
  const ia = list.indexOf(a);
  const ib = list.indexOf(b);
  if (ia < 0 || ib < 0) return refused(league, `Both players must be listed at ${slot}`);
  if (ia === ib) return refused(league, 'Pick a different player');
  const chart = cloneDepthChart(team.depthChart);
  const next = [...list];
  next[ia] = b;
  next[ib] = a;
  chart[slot] = next;
  const pa = league.players[a];
  const pb = league.players[b];
  return done(withDepthChart(league, teamId, chart), `Swapped ${pa ? pa.lastName : a} and ${pb ? pb.lastName : b} at ${slot}`);
};

/** Rebuilds the whole chart automatically (best available players first). */
export const autoDepth = (league: League, teamId: TeamId): ActionResult => {
  if (!league.teams[teamId]) return refused(league, 'Unknown team');
  return done(withDepthChart(league, teamId, autoDepthChart(rosterPlayers(league, teamId))), 'Depth chart rebuilt automatically');
};

/** Roster players who could be added to a slot (returners for KR/PR, anyone not yet listed elsewhere). */
export const addCandidates = (league: League, teamId: TeamId, slot: DepthSlot): Player[] => {
  const team = league.teams[teamId];
  if (!team) return [];
  const listed = new Set(team.depthChart[slot] ?? []);
  return rosterPlayers(league, teamId)
    .filter((p) => !listed.has(p.id) && (!isReturnSlot(slot) || RETURNER_POSITIONS.includes(p.position)))
    .sort((x, y) => (isReturnSlot(slot) ? returnScore(y, slot) - returnScore(x, slot) : y.overall - x.overall) || (x.id < y.id ? -1 : 1));
};

/** Lists a roster player at the end of a slot. */
export const addToSlot = (league: League, teamId: TeamId, slot: DepthSlot, playerId: PlayerId): ActionResult => {
  const team = league.teams[teamId];
  if (!team) return refused(league, 'Unknown team');
  const p = league.players[playerId];
  if (!p || !team.rosterIds.includes(playerId)) return refused(league, 'Not on your roster');
  if (isReturnSlot(slot) && !RETURNER_POSITIONS.includes(p.position)) return refused(league, `A ${p.position} cannot return kicks`);
  if ((team.depthChart[slot] ?? []).includes(playerId)) return refused(league, `Already listed at ${slot}`);
  const chart = applySubstitution(team.depthChart, slot, playerId, (team.depthChart[slot] ?? []).length);
  return done(withDepthChart(league, teamId, chart), `${fullName(p)} added at ${slot}`);
};

/** Why a player cannot be removed from a slot (null = allowed): only extra listings, never below the starters. */
export const removeBlocker = (league: League, teamId: TeamId, slot: DepthSlot, playerId: PlayerId): string | null => {
  const list = slotList(league, teamId, slot);
  const p = league.players[playerId];
  if (!list || !p || !list.includes(playerId)) return `Not listed at ${slot}`;
  if (!isReturnSlot(slot) && p.position === slot) return 'Players stay listed at their own position';
  if (list.length <= STARTER_COUNTS[slot]) return `${slot} needs ${STARTER_COUNTS[slot]} listed`;
  return null;
};

/** Removes an extra listing (returner or cross-position backup). */
export const removeFromSlot = (league: League, teamId: TeamId, slot: DepthSlot, playerId: PlayerId): ActionResult => {
  const why = removeBlocker(league, teamId, slot, playerId);
  const team = league.teams[teamId];
  if (why || !team) return refused(league, why ?? 'Unknown team');
  const chart = cloneDepthChart(team.depthChart);
  chart[slot] = chart[slot].filter((id) => id !== playerId);
  const p = league.players[playerId];
  return done(withDepthChart(league, teamId, chart), `${p ? fullName(p) : playerId} removed from ${slot}`);
};
