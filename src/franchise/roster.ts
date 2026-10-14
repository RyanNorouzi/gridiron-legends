/**
 * Roster membership: the ONLY place Team.rosterIds, Player.teamId, League.freeAgentIds and depth charts
 * change. Every exported League function is pure (returns a new League; untouched teams/players keep their
 * identity). Bulk callers (free agency, trades, AI cuts) use the `...InPlace` variants on a working copy from
 * `beginRosterEdit`, which owns fresh containers: those functions replace Team/Player objects inside the copy
 * and never mutate objects shared with the input league.
 *
 * Depth charts: AI teams are rebuilt with autoDepthChart after every change; the user's chart keeps its manual
 * order (departures removed, arrivals inserted by overall in their position slot). Cached team ratings
 * (overall/offenseRating/defenseRating) are refreshed for every team touched.
 */
import type { PlayerId, TeamId } from '@/core/ids';
import { POSITIONS } from '@/players/types';
import type { Contract, Player, Position } from '@/players/types';
import { adjustMorale } from '@/players/personality';
import { DEPTH_SLOTS, autoDepthChart, cloneDepthChart, removeFromDepthChart } from '@/teams/depth-chart';
import { teamRatings } from '@/teams/ratings';
import type { DepthChart, Team } from '@/teams/types';
import type { League } from '@/franchise/types';
import { OFFSEASON_PHASES, capHit, capSpace, isPostJuneCutoff, leagueCapYear, release, releaseDeadMoneySplit } from '@/franchise/contracts';

/* ---------------------------------------------------------------- helpers */

/** Working copy with fresh teams/players/freeAgentIds containers (objects inside are still shared until replaced). */
export const beginRosterEdit = (league: League): League => ({
  ...league,
  teams: { ...league.teams },
  players: { ...league.players },
  freeAgentIds: [...league.freeAgentIds],
});

/** True when the user manages this team's depth chart. */
export const isUserTeam = (league: Pick<League, 'userTeamId'>, team: Pick<Team, 'id' | 'isUserControlled'>): boolean =>
  team.isUserControlled || league.userTeamId === team.id;

/** Rostered players of a team (missing ids skipped). */
export const rosterPlayers = (league: Pick<League, 'teams' | 'players'>, teamId: TeamId): Player[] => {
  const team = league.teams[teamId];
  if (!team) return [];
  return team.rosterIds.map((id) => league.players[id]).filter((p): p is Player => p !== undefined);
};

/** Inserts a player into his position slot ahead of the first listed player with a lower overall. */
const insertByOverall = (chart: DepthChart, player: Player, lookup: Readonly<Record<PlayerId, Player>>): DepthChart => {
  const out = cloneDepthChart(chart);
  const list = out[player.position].filter((id) => id !== player.id);
  const at = list.findIndex((id) => (lookup[id]?.overall ?? 0) < player.overall);
  list.splice(at < 0 ? list.length : at, 0, player.id);
  out[player.position] = list;
  return out;
};

/** Recomputes the cached ratings (and, for AI teams, the depth chart) of `team` inside `work`. */
const refreshTeam = (work: League, team: Team, rebuildChart: boolean): Team => {
  const roster = team.rosterIds.map((id) => work.players[id]).filter((p): p is Player => p !== undefined);
  const depthChart = rebuildChart ? autoDepthChart(roster) : team.depthChart;
  const r = teamRatings(roster, depthChart);
  return { ...team, depthChart, overall: r.overall, offenseRating: r.offense, defenseRating: r.defense };
};

/** Rebuilds a team's depth chart (AI teams, or any team when `force`) and ratings in place. */
export const refreshTeamInPlace = (work: League, teamId: TeamId, force = false): void => {
  const team = work.teams[teamId];
  if (!team) throw new Error(`refreshTeamInPlace: unknown team ${teamId}`);
  work.teams[teamId] = refreshTeam(work, team, force || !isUserTeam(work, team));
};

/* ------------------------------------------------------------- assignment */

/**
 * Moves a player to `teamId` (null = free agency) inside a working copy. Keeps rosterIds, teamId,
 * freeAgentIds and depth charts consistent. No-op when he is already there. Throws on unknown ids.
 */
export const assignPlayerInPlace = (work: League, playerId: PlayerId, teamId: TeamId | null): void => {
  const player = work.players[playerId];
  if (!player) throw new Error(`assignPlayer: unknown player ${playerId}`);
  if (teamId !== null && !work.teams[teamId]) throw new Error(`assignPlayer: unknown team ${teamId}`);
  const from = player.teamId;
  if (from === teamId) {
    const settled = teamId === null ? player.retired || work.freeAgentIds.includes(playerId) : (work.teams[teamId] as Team).rosterIds.includes(playerId);
    if (settled) return;
  }
  const moved: Player = { ...player, teamId };
  work.players[playerId] = moved;
  if (from !== null && from !== teamId) {
    const old = work.teams[from];
    if (old) {
      const user = isUserTeam(work, old);
      const next: Team = { ...old, rosterIds: old.rosterIds.filter((id) => id !== playerId) };
      if (user) next.depthChart = removeFromDepthChart(old.depthChart, playerId);
      work.teams[from] = refreshTeam(work, next, !user);
    }
  }
  if (teamId !== null) {
    const dest = work.teams[teamId] as Team;
    const user = isUserTeam(work, dest);
    const rosterIds = dest.rosterIds.includes(playerId) ? dest.rosterIds : [...dest.rosterIds, playerId];
    const next: Team = { ...dest, rosterIds };
    if (user) next.depthChart = insertByOverall(dest.depthChart, moved, work.players);
    work.teams[teamId] = refreshTeam(work, next, !user);
    if (work.freeAgentIds.includes(playerId)) work.freeAgentIds = work.freeAgentIds.filter((id) => id !== playerId);
  } else if (!player.retired && !work.freeAgentIds.includes(playerId)) {
    work.freeAgentIds = [...work.freeAgentIds, playerId];
  }
};

/** Pure: returns a League with the player moved to `teamId` (null = free agency). */
export const assignPlayer = (league: League, playerId: PlayerId, teamId: TeamId | null): League => {
  const work = beginRosterEdit(league);
  assignPlayerInPlace(work, playerId, teamId);
  return work;
};

/* ------------------------------------------------------------ sign and cut */

export interface SignOptions {
  /** Cap year the deal is charged against (default leagueCapYear). */
  year?: number;
  /** Skip the cap check (commissioner moves, forced minimum fills). */
  allowOverCap?: boolean;
  /** Reject when the roster already holds this many players. */
  rosterLimit?: number;
}

/** Whether `teamId` may sign free agent `playerId` to `contract`; reason explains a refusal. */
export const canSign = (league: League, teamId: TeamId, playerId: PlayerId, contract: Contract, opts: SignOptions = {}): { ok: boolean; reason: string | null } => {
  const team = league.teams[teamId];
  const player = league.players[playerId];
  if (!team) return { ok: false, reason: `unknown team ${teamId}` };
  if (!player) return { ok: false, reason: `unknown player ${playerId}` };
  if (player.retired) return { ok: false, reason: `${player.firstName} ${player.lastName} is retired` };
  if (player.teamId !== null) return { ok: false, reason: `${player.firstName} ${player.lastName} is not a free agent` };
  if (opts.rosterLimit !== undefined && team.rosterIds.length >= opts.rosterLimit) return { ok: false, reason: `${team.abbr} roster is full (${opts.rosterLimit})` };
  if (!opts.allowOverCap) {
    const year = opts.year ?? leagueCapYear(league);
    const space = capSpace(team, league.players, league.settings, year);
    const hit = capHit(contract, year);
    if (hit > space) return { ok: false, reason: `${team.abbr} is $${Math.round(hit - space).toLocaleString('en-US')} short of cap space` };
  }
  return { ok: true, reason: null };
};

/** In-place signing on a working copy (see canSign for the checks; throws with the reason). */
export const signPlayerInPlace = (work: League, teamId: TeamId, playerId: PlayerId, contract: Contract, opts: SignOptions = {}): void => {
  const check = canSign(work, teamId, playerId, contract, opts);
  if (!check.ok) throw new Error(`signPlayer: ${check.reason ?? 'refused'}`);
  const player = work.players[playerId] as Player;
  work.players[playerId] = { ...player, contract, morale: adjustMorale(player, { type: 'contract' }) };
  assignPlayerInPlace(work, playerId, teamId);
};

/** Pure: signs free agent `playerId` to `teamId` with `contract` (cap-checked unless allowOverCap). */
export const signPlayer = (league: League, teamId: TeamId, playerId: PlayerId, contract: Contract, opts: SignOptions = {}): League => {
  const work = beginRosterEdit(league);
  signPlayerInPlace(work, teamId, playerId, contract, opts);
  return work;
};

/** Dead money / savings preview of cutting a player now. */
export const cutPreview = (league: League, teamId: TeamId, playerId: PlayerId, year = leagueCapYear(league)): { deadThisYear: number; deadNextYear: number; capSavings: number } => {
  const c = league.players[playerId]?.contract;
  if (!c || league.players[playerId]?.teamId !== teamId) return { deadThisYear: 0, deadNextYear: 0, capSavings: 0 };
  const split = releaseDeadMoneySplit(c, year, isPostJuneCutoff(league.season.phase));
  return { deadThisYear: split.thisYear, deadNextYear: split.nextYear, capSavings: capHit(c, year) - split.thisYear };
};

/** In-place release: books dead money (June-1 split after the cutoff), clears the contract, moves him to free agency. */
export const cutPlayerInPlace = (work: League, teamId: TeamId, playerId: PlayerId, year = leagueCapYear(work), postDeadline = isPostJuneCutoff(work.season.phase)): void => {
  const team = work.teams[teamId];
  const player = work.players[playerId];
  if (!team) throw new Error(`cutPlayer: unknown team ${teamId}`);
  if (!player || player.teamId !== teamId || !team.rosterIds.includes(playerId)) throw new Error(`cutPlayer: player ${playerId} is not on ${team.abbr}`);
  const r = release(team, player, year, { postDeadline });
  work.teams[teamId] = r.team;
  work.players[playerId] = r.player;
  assignPlayerInPlace(work, playerId, null);
};

/** Pure: releases a player (dead money booked to `year`, June-1 split after the cutoff) into free agency. */
export const cutPlayer = (league: League, teamId: TeamId, playerId: PlayerId, year = leagueCapYear(league), opts: { postDeadline?: boolean } = {}): League => {
  const work = beginRosterEdit(league);
  cutPlayerInPlace(work, teamId, playerId, year, opts.postDeadline ?? isPostJuneCutoff(league.season.phase));
  return work;
};

/* ---------------------------------------------------------------- queries */

/** Players on a team's roster. */
export const rosterCount = (league: Pick<League, 'teams'>, teamId: TeamId): number => league.teams[teamId]?.rosterIds.length ?? 0;

/** Extra bodies a team may carry between the season's end and final cuts (draft class, camp competition). */
export const OFFSEASON_ROSTER_EXTRA = 22;

/** Roster ceiling right now: settings.rosterSize in season, plus OFFSEASON_ROSTER_EXTRA in the offseason phases. */
export const rosterLimitFor = (league: Pick<League, 'settings' | 'season'>): number =>
  league.settings.rosterSize + (OFFSEASON_PHASES.includes(league.season.phase) ? OFFSEASON_ROSTER_EXTRA : 0);

/** Cuts needed to get down to `limit` (default settings.rosterSize). */
export const needsCutsTo = (league: Pick<League, 'teams' | 'settings'>, teamId: TeamId, limit = league.settings.rosterSize): number =>
  Math.max(0, rosterCount(league, teamId) - limit);

/** Roster grouped by position, best overall first (id breaks ties). */
export const positionDepth = (league: Pick<League, 'players'>, team: Pick<Team, 'rosterIds'>): Record<Position, Player[]> => {
  const out = {} as Record<Position, Player[]>;
  for (const pos of POSITIONS) out[pos] = [];
  for (const id of team.rosterIds) {
    const p = league.players[id];
    if (p) out[p.position].push(p);
  }
  for (const pos of POSITIONS) out[pos].sort((a, b) => b.overall - a.overall || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return out;
};

/* ------------------------------------------------------------- validation */

export type RosterIssueKind =
  | 'missingPlayer' | 'teamMismatch' | 'duplicateRoster' | 'notOnRoster' | 'freeAgentAttached' | 'freeAgentMissing'
  | 'freeAgentDuplicate' | 'freeAgentUnknown' | 'retiredActive' | 'depthStranger' | 'unlisted' | 'noContract' | 'freeAgentContract';

export interface RosterIssue {
  kind: RosterIssueKind;
  /** Errors break the roster invariants; warnings are advisory. */
  severity: 'error' | 'warning';
  teamId: TeamId | null;
  playerId: PlayerId | null;
  message: string;
}

/**
 * Checks every roster invariant: rosterIds <-> Player.teamId both ways, no player on two rosters, free agents
 * unattached/unique/known/active, every unattached active player listed as a free agent, depth charts only list
 * roster players. Warnings: roster players missing from their position slot, rostered players without a
 * contract, free agents still holding one.
 */
export const validateRosterConsistency = (league: League): RosterIssue[] => {
  const issues: RosterIssue[] = [];
  const add = (kind: RosterIssueKind, severity: 'error' | 'warning', teamId: TeamId | null, playerId: PlayerId | null, message: string): void => {
    issues.push({ kind, severity, teamId, playerId, message });
  };
  const owner = new Map<PlayerId, TeamId>();
  for (const team of Object.values(league.teams)) {
    const seen = new Set<PlayerId>();
    for (const id of team.rosterIds) {
      const p = league.players[id];
      if (!p) { add('missingPlayer', 'error', team.id, id, `${team.abbr} lists unknown player ${id}`); continue; }
      if (seen.has(id) || (owner.has(id) && owner.get(id) !== team.id)) add('duplicateRoster', 'error', team.id, id, `${id} is listed twice (${team.abbr})`);
      seen.add(id);
      owner.set(id, team.id);
      if (p.teamId !== team.id) add('teamMismatch', 'error', team.id, id, `${id} is on ${team.abbr} but has teamId ${String(p.teamId)}`);
      if (p.retired) add('retiredActive', 'error', team.id, id, `${id} is retired but rostered by ${team.abbr}`);
      if (!p.contract) add('noContract', 'warning', team.id, id, `${id} is rostered by ${team.abbr} without a contract`);
      const slot = team.depthChart[p.position];
      if (!p.retired && Array.isArray(slot) && !slot.includes(id)) add('unlisted', 'warning', team.id, id, `${id} (${p.position}) is not on the ${team.abbr} depth chart`);
    }
    for (const slot of DEPTH_SLOTS) {
      for (const id of team.depthChart[slot] ?? []) {
        if (!seen.has(id)) add('depthStranger', 'error', team.id, id, `${team.abbr} ${slot} lists ${id}, who is not on the roster`);
      }
    }
  }
  const faSeen = new Set<PlayerId>();
  for (const id of league.freeAgentIds) {
    const p = league.players[id];
    if (!p) { add('freeAgentUnknown', 'error', null, id, `free agent ${id} is not in league.players`); continue; }
    if (faSeen.has(id)) add('freeAgentDuplicate', 'error', null, id, `free agent ${id} is listed twice`);
    faSeen.add(id);
    if (p.teamId !== null) add('freeAgentAttached', 'error', p.teamId, id, `free agent ${id} has teamId ${p.teamId}`);
    if (p.retired) add('retiredActive', 'error', null, id, `free agent ${id} is retired`);
    if (p.contract) add('freeAgentContract', 'warning', null, id, `free agent ${id} still holds a contract`);
  }
  for (const p of Object.values(league.players)) {
    if (p.teamId !== null && !owner.has(p.id)) add('notOnRoster', 'error', p.teamId, p.id, `${p.id} has teamId ${p.teamId} but is on no roster`);
    else if (p.teamId !== null && owner.get(p.id) !== p.teamId) add('teamMismatch', 'error', p.teamId, p.id, `${p.id} has teamId ${p.teamId} but is rostered by ${String(owner.get(p.id))}`);
    if (p.teamId === null && !p.retired && !faSeen.has(p.id)) add('freeAgentMissing', 'error', null, p.id, `unattached player ${p.id} is not in freeAgentIds`);
  }
  return issues;
};

/** Errors only (the invariants every roster function preserves). */
export const rosterErrors = (league: League): RosterIssue[] => validateRosterConsistency(league).filter((i) => i.severity === 'error');
