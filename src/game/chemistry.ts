import { clamp01 } from '@/core/math';
import type { PlayerId } from '@/core/ids';
import type { Player } from '@/players/types';

/**
 * Quarterback-receiver chemistry: how well a passer and a target know each other, from the seasons they have shared
 * on this roster (a rookie or a new signing starts cold, a long-tenured pair is in sync) nudged by the team's overall
 * chemistry. 0..1 with 0.5 neutral. The live passing model (game/systems/passing.ts) and the statistical pass model
 * (simulation/pass-model.ts) read it through PlayContext.passChemistry.
 */

/** Chemistry of a pair with no shared history on a neutral locker room. */
export const COLD_CHEMISTRY = 0.4;
/** Added per shared season, saturating at MAX_SHARED_SEASONS. */
export const CHEMISTRY_PER_SEASON = 0.12;
export const MAX_SHARED_SEASONS = 5;
/** Team chemistry (0..100) swings every pair by up to this much either way. */
export const TEAM_CHEMISTRY_SWING = 0.1;

/** The current league year from a player's own record (the season he entered plus his seasons of experience). */
export const currentYearOf = (p: Pick<Player, 'rookieYear' | 'experience'>): number => p.rookieYear + p.experience;

/**
 * Seasons a player has been on `teamId`: since the draft when this team drafted him, else since the contract he
 * signed (a re-signed veteran counts from his latest deal: a conservative estimate).
 */
export const seasonsWithTeam = (p: Pick<Player, 'rookieYear' | 'experience' | 'draft' | 'contract' | 'teamId'>, teamId: string): number => {
  if (p.teamId !== teamId) return 0;
  const year = currentYearOf(p);
  const joined = p.draft && p.draft.teamId === teamId ? p.draft.year : p.contract ? p.contract.signedYear : year;
  return Math.max(0, year - joined);
};

/** Chemistry 0..1 between a passer and a receiver on `teamId` with the team's chemistry 0..100. */
export const pairChemistry = (
  qb: Pick<Player, 'id' | 'rookieYear' | 'experience' | 'draft' | 'contract' | 'teamId'>,
  receiver: Pick<Player, 'id' | 'rookieYear' | 'experience' | 'draft' | 'contract' | 'teamId'>,
  teamId: string, teamChemistry = 50,
): number => {
  if (qb.id === receiver.id) return 1;
  const shared = Math.min(MAX_SHARED_SEASONS, seasonsWithTeam(qb, teamId), seasonsWithTeam(receiver, teamId));
  const team = TEAM_CHEMISTRY_SWING * ((Math.max(0, Math.min(100, teamChemistry)) - 50) / 50);
  return clamp01(COLD_CHEMISTRY + CHEMISTRY_PER_SEASON * shared + team);
};

/** Chemistry of the lineup's QB with every other offensive player on the field, keyed by the receiver's player id. */
export const lineupChemistry = (lineup: Record<string, Player>, teamId: string, teamChemistry = 50): Record<PlayerId, number> => {
  const qb = lineup['QB'];
  const out: Record<PlayerId, number> = {};
  if (!qb) return out;
  for (const p of Object.values(lineup)) if (p.id !== qb.id) out[p.id] = Math.round(pairChemistry(qb, p, teamId, teamChemistry) * 1000) / 1000;
  return out;
};

/** A pair's chemistry from the context map (0.5 when unknown: quick tests, synthetic contexts). */
export const chemistryFor = (map: Readonly<Record<PlayerId, number>> | undefined, receiverId: PlayerId | null | undefined): number =>
  receiverId && map && map[receiverId] !== undefined ? map[receiverId] : 0.5;
