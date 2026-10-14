/**
 * The trading block: players a team openly shops (ClubState.playerFlags 'tradeBlock', visible on every roster).
 *
 * The user puts players on his block from the player card; AI teams list their own surplus (refreshAiTradeBlocks):
 * up to BLOCK_TUNING.maxPerAiTeam players worth at least minValue trade points that the team can spare (backups
 * behind healthy starters, starters at a surplus position, veterans 29+ on a rebuilding team; never an untouchable
 * or a starter at a need), plus any player an event already put there who is disgruntled. The block matters to
 * the trade AI:
 *   - proposals (roster-ai.ts aiTradeProposals) prefer targets on a partner's block (score x targetScoreBoost, bar
 *     lowered by barRelief), so AI teams come after the user's listed players first;
 *   - an AI team asks less for its own listed players (trades.ts valueTo: outgoing value x sellDiscount);
 *   - trades.ts runAiTradeActivity refreshes the AI blocks, lets teams with a need a listed player fills shop more
 *     often (activity x shopBoost), and sends its offers to the user from the teams most interested in his block.
 * Pure.
 */
import type { PlayerId, TeamId } from '@/core/ids';
import { POSITIONS, type Player } from '@/players/types';
import { STARTER_COUNTS } from '@/teams/depth-chart';
import type { Team } from '@/teams/types';
import { leagueCapYear } from '@/franchise/contracts';
import { isUserTeam, positionDepth } from '@/franchise/roster';
import { MAJOR_NEED, teamNeeds, type TeamNeeds } from '@/franchise/gm/needs';
import { isUntouchable, playerTradeValue } from '@/franchise/gm/valuation';
import { ensureClub, withClub } from '@/franchise/rivalries';
import type { League, PlayerFlag } from '@/franchise/types';

/** Trading-block tuning. */
export const BLOCK_TUNING = Object.freeze({
  /** Players an AI team lists at most. */
  maxPerAiTeam: 2,
  /** Trade points a player needs to be worth listing. */
  minValue: 12,
  /** Proposal target score multiplier for listed players. */
  targetScoreBoost: 1.6,
  /** Overall points the "clear upgrade" bar is lowered by for listed players. */
  barRelief: 2,
  /** Value an AI team puts on its own listed player when he goes out. */
  sellDiscount: 0.9,
  /** Shopping chance multiplier for a team with a need a listed player fills. */
  shopBoost: 1.6,
});

const BLOCK: PlayerFlag = 'tradeBlock';

/** True when the player is on his team's trading block. */
export const isOnTradeBlock = (league: Pick<League, 'club'>, playerId: PlayerId): boolean => (league.club?.playerFlags[playerId] ?? []).includes(BLOCK);

/** A team's listed players (roster order). */
export const tradeBlockOf = (league: League, teamId: TeamId): PlayerId[] =>
  (league.teams[teamId]?.rosterIds ?? []).filter((id) => isOnTradeBlock(league, id));

/** Players an AI team would list: its most valuable spare players (see the module header), best first. */
export const aiBlockCandidates = (league: League, team: Team, needs: TeamNeeds = teamNeeds(league, team)): PlayerId[] => {
  const year = leagueCapYear(league);
  const out: { p: Player; v: number }[] = [];
  const depth = positionDepth(league, team);
  for (const pos of POSITIONS) {
    const players = depth[pos];
    players.forEach((p, rank) => {
      const starter = rank < STARTER_COUNTS[pos];
      if (isUntouchable(p, year, league.settings) || p.injury) return;
      if (starter && needs.positions[pos].need >= MAJOR_NEED * 0.6) return;
      // A backup is spare only when the position is deeper than its starters plus one.
      const spare = starter ? needs.surplus.includes(pos) || (needs.direction === 'rebuild' && p.age >= 29) : players.length > STARTER_COUNTS[pos] + 1;
      const v = playerTradeValue(p, year, league.settings);
      if (spare && v >= BLOCK_TUNING.minValue) out.push({ p, v });
    });
  }
  return out.sort((a, b) => b.v - a.v || (a.p.id < b.p.id ? -1 : 1)).slice(0, BLOCK_TUNING.maxPerAiTeam).map((x) => x.p.id);
};

/**
 * Re-lists every AI team's block: its current candidates, plus listed players who are disgruntled (an event put
 * them there); stale listings (and listings of players no longer on a team) are dropped. The user's block is left
 * to the user.
 */
export const refreshAiTradeBlocks = (league: League): League => {
  const flags = { ...ensureClub(league).playerFlags };
  let changed = false;
  // A listing lapses when the player leaves his team (released, retired): free agents are nobody's block.
  for (const [id, own] of Object.entries(flags)) {
    const p = league.players[id as PlayerId];
    if (!own.includes(BLOCK) || (p && p.teamId !== null)) continue;
    flags[id] = own.filter((f) => f !== BLOCK);
    changed = true;
  }
  for (const team of Object.values(league.teams)) {
    if (isUserTeam(league, team)) continue;
    const keep = new Set(aiBlockCandidates(league, team));
    for (const id of team.rosterIds) {
      const own = flags[id] ?? [];
      const listed = own.includes(BLOCK);
      const want = keep.has(id) || (listed && own.includes('disgruntled'));
      if (listed === want) continue;
      flags[id] = want ? [...own, BLOCK] : own.filter((f) => f !== BLOCK);
      changed = true;
    }
  }
  return changed ? withClub(league, { playerFlags: flags }) : league;
};

/**
 * `league` without the trading-block listing of `playerIds` (the same object when none was listed). A traded player
 * is no longer shopped: his new team did not put him on its block (trades.ts executeTrade clears it).
 */
export const withoutTradeBlock = (league: League, playerIds: Iterable<PlayerId>): League => {
  const flags = league.club?.playerFlags;
  if (!flags) return league;
  let next: Record<string, PlayerFlag[]> | null = null;
  for (const id of playerIds) {
    const own = flags[id];
    if (!own?.includes(BLOCK)) continue;
    next ??= { ...flags };
    next[id] = own.filter((f) => f !== BLOCK);
  }
  return next ? withClub(league, { playerFlags: next }) : league;
};

/** How many listed players on other teams (the user's included) fill one of `team`'s real needs. */
export const blockDemand = (league: League, team: Team, needs: TeamNeeds = teamNeeds(league, team)): number => {
  let n = 0;
  for (const other of Object.values(league.teams)) {
    if (other.id === team.id) continue;
    for (const id of tradeBlockOf(league, other.id)) {
      const p = league.players[id];
      if (p && needs.positions[p.position].need >= 0.3 && p.overall >= needs.positions[p.position].weakestStarter + BLOCK_TUNING.barRelief) n++;
    }
  }
  return n;
};
