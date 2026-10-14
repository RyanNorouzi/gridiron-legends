/**
 * Roster filling for AI-managed teams (and a hands-off user team): minimum-salary signings from the free-agent
 * pool for empty required depth slots and up to the roster size, then cuts and cap compliance. Used when free
 * agency closes (free-agency.ts finishFreeAgency) and at final cuts after the draft (`aiFinalCuts`). When the pool
 * has nobody at a required position (fullbacks and specialists run out), a replacement-level street free agent is
 * generated for it, seeded from the league seed, year, team and position (the League rng stream is untouched).
 * Pure League functions plus `...InPlace` helpers on a roster.ts working copy; deterministic.
 */
import { playerId as newPlayerId, type PlayerId, type TeamId } from '@/core/ids';
import { createRng } from '@/core/rng';
import { generatePlayer } from '@/players/generator';
import { createNamePool } from '@/players/names';
import { POSITIONS } from '@/players/types';
import type { Contract, Player, Position } from '@/players/types';
import { loadColleges, loadRegions } from '@/teams/data';
import { ROSTER_COMPOSITION } from '@/teams/depth-chart';
import type { Team } from '@/teams/types';
import type { League } from '@/franchise/types';
import { leagueCapYear, minimumContract } from '@/franchise/contracts';
import { beginRosterEdit, canSign, isUserTeam, positionDepth, refreshTeamInPlace, signPlayerInPlace } from '@/franchise/roster';
import { aiCapComplianceInPlace, aiCutsToLimitInPlace, minKeep } from '@/franchise/gm/roster-ai';

const byId = (a: { id: string }, b: { id: string }): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** Minimum deal for a filler signing: two seasons for players 25 and under, otherwise one. */
const fillerContract = (p: Player, capYear: number, league: League): Contract => minimumContract(p, capYear, league.settings, p.age <= 25 ? 2 : 1);

/** Unsigned, active free agents. */
const freeAgentPool = (work: League): Player[] =>
  work.freeAgentIds.map((id) => work.players[id]).filter((p): p is Player => p !== undefined && !p.retired && p.teamId === null);

/**
 * Best minimum-salary fit the team can afford: the thinnest position (against ROSTER_COMPOSITION) first, then the
 * best overall. Null when nobody in `pool` fits under the cap.
 */
export const cheapestFit = (work: League, team: Team, pool: readonly Player[], capYear: number): { p: Player; contract: Contract } | null => {
  const depth = positionDepth(work, team);
  let best: { p: Player; contract: Contract; key: number } | null = null;
  for (const p of pool) {
    if (p.teamId !== null) continue;
    const short = ROSTER_COMPOSITION[p.position] - depth[p.position].length;
    const key = (short > 0 ? 1000 + short * 100 : short === 0 ? 0 : -1000) + p.overall;
    if (best && key <= best.key) continue;
    const contract = fillerContract(p, capYear, work);
    if (canSign(work, team.id, p.id, contract, { year: capYear }).ok) best = { p, contract, key };
  }
  return best;
};

/** Positions where the team carries fewer than minKeep players (the AI's floor; required depth slots included). */
export const rosterHoles = (work: League, teamId: TeamId): Position[] => {
  const team = work.teams[teamId];
  if (!team) return [];
  const depth = positionDepth(work, team);
  return POSITIONS.filter((pos) => depth[pos].length < minKeep(pos));
};

/**
 * Adds a generated replacement-level ('fringe') free agent at `position` to League.players and freeAgentIds.
 * Deterministic per (league seed, league year, phase, `key`).
 */
export const addStreetFreeAgentInPlace = (work: League, position: Position, key: string): Player => {
  const rng = createRng(`street:${work.rngSeed}:${work.year}:${work.season.phase}:${key}`);
  let p = generatePlayer(rng, {
    position, quality: 'fringe', names: createNamePool(), regions: loadRegions().map((r) => r.id), colleges: loadColleges().map((c) => c.name), year: work.year,
  });
  while (work.players[p.id] || work.retiredPlayers[p.id]) p = { ...p, id: newPlayerId(rng) };
  work.players[p.id] = p;
  work.freeAgentIds = [...work.freeAgentIds, p.id];
  return p;
};

/**
 * Signs the best available free agent on a minimum deal at every position below its minKeep floor (a generated
 * street free agent when the pool has nobody there). The deal is cap-checked when possible; a required body is
 * signed over the cap otherwise (cap compliance follows). Returns the signed ids.
 */
export const fillRosterHolesInPlace = (work: League, teamId: TeamId, capYear = leagueCapYear(work)): PlayerId[] => {
  const signed: PlayerId[] = [];
  for (const pos of rosterHoles(work, teamId)) {
    const team = work.teams[teamId] as Team;
    let have = positionDepth(work, team)[pos].length;
    const candidates = freeAgentPool(work).filter((p) => p.position === pos).sort((a, b) => b.overall - a.overall || byId(a, b));
    for (let n = candidates.length; have + candidates.length < minKeep(pos); n++) candidates.push(addStreetFreeAgentInPlace(work, pos, `${teamId}:${pos}:${n}`));
    for (const p of candidates) {
      if (have >= minKeep(pos)) break;
      const contract = fillerContract(p, capYear, work);
      const allowOverCap = !canSign(work, teamId, p.id, contract, { year: capYear }).ok;
      signPlayerInPlace(work, teamId, p.id, contract, { year: capYear, allowOverCap });
      signed.push(p.id);
      have++;
    }
  }
  return signed;
};

/** Signs cap-checked minimum deals (thinnest positions first) until the roster reaches `size`. Returns the signed ids. */
export const fillRosterToSizeInPlace = (work: League, teamId: TeamId, size = work.settings.rosterSize, capYear = leagueCapYear(work)): PlayerId[] => {
  const signed: PlayerId[] = [];
  let pool = freeAgentPool(work);
  while ((work.teams[teamId] as Team).rosterIds.length < size) {
    const fit = cheapestFit(work, work.teams[teamId] as Team, pool, capYear);
    if (!fit) break;
    signPlayerInPlace(work, teamId, fit.p.id, fit.contract, { year: capYear });
    signed.push(fit.p.id);
    pool = pool.filter((q) => q.id !== fit.p.id);
  }
  return signed;
};

/** What settling one roster did. */
export interface RosterSettleReport {
  signed: PlayerId[];
  cut: PlayerId[];
  restructured: PlayerId[];
}

/**
 * Brings a roster to exactly `size` where the pool and the cap allow: fills empty required positions, fills to
 * `size` with minimum deals, cuts the least valuable players down to `size`, restores cap compliance (restructures
 * then cuts) and refills with whatever still fits under the cap. The depth chart is rebuilt for AI teams.
 */
export const settleRosterInPlace = (work: League, teamId: TeamId, size = work.settings.rosterSize, capYear = leagueCapYear(work)): RosterSettleReport => {
  const signed = [...fillRosterHolesInPlace(work, teamId, capYear), ...fillRosterToSizeInPlace(work, teamId, size, capYear)];
  const cut = aiCutsToLimitInPlace(work, teamId, size);
  const compliance = aiCapComplianceInPlace(work, teamId);
  signed.push(...fillRosterToSizeInPlace(work, teamId, size, capYear));
  refreshTeamInPlace(work, teamId);
  return { signed, cut: [...cut, ...compliance.cut], restructured: compliance.restructured };
};

/**
 * Final cuts after the draft: every AI team (and the user's with `includeUser`, for a hands-off user) is settled
 * at settings.rosterSize (settleRosterInPlace). Teams are processed in id order.
 */
export const aiFinalCuts = (league: League, opts: { includeUser?: boolean } = {}): League => {
  const work = beginRosterEdit(league);
  for (const team of Object.values(league.teams).sort(byId)) {
    if (!opts.includeUser && isUserTeam(league, team)) continue;
    settleRosterInPlace(work, team.id);
  }
  return work;
};
