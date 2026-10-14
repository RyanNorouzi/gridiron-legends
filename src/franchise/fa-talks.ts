/**
 * Free-agent talks: the user's side of free agency negotiates the way contract extensions do (extension-talks.ts),
 * so the market cannot be probed for a player's exact bar.
 *
 * - The UI never sees his bar. `faInterestEstimate` reads an offer through the staff's eye (negotiationSkill: head
 *   coach motivation + scouting) with deterministic noise per player, season, bidding round and refused round,
 *   and reports a band (likely / close / far apart). Re-checking the same offer in the same round reads the same.
 * - Every bidding round in which he refuses the team's offer on merit is a talks round: his patience with the team
 *   wears down (FA_TALKS.roundDecay), a lowball (score far below his bar) wears it down more, and his bar for the
 *   team creeps up a little per refused round (he is tired of haggling). Accepting his own counter is not a talks
 *   round: it faces his plain market bar and a refusal (outbid) costs no patience.
 * - When his patience runs out, or after maxLowballs lowballs, he walks away: the team's offers to him are
 *   withdrawn unseen for the rest of this free agency, and his counter to the team (if any) is dropped.
 *
 * Only user-run teams keep talks (AI teams bid as before). Records live in FreeAgencyState.talks and end with the
 * market. Pure: plain data in, plain data out.
 */
import type { PlayerId, TeamId } from '@/core/ids';
import { clamp01, lerp } from '@/core/math';
import { createRng } from '@/core/rng';
import type { Player } from '@/players/types';
import type { Team } from '@/teams/types';
import { leagueCapYear, type ContractTerms } from './contracts';
import { TALKS_TUNING, negotiationSkill, startingTalkPatience, type InterestBand } from './extension-talks';
import { acceptThreshold, playerAsk, playerPatience, preferenceScore } from './negotiation';
import type { FreeAgencyState, FreeAgentTalks, League } from './types';

/** Free-agent talks tuning. */
export const FA_TALKS = Object.freeze({
  /** Patience lost per refused bidding round. */
  roundDecay: 0.15,
  /** Extra patience lost when the refused offer was a lowball. */
  lowballDecay: 0.3,
  /** An offer scoring more than this below his bar is a lowball. */
  lowballGap: 0.08,
  /** Lowballs that make him walk away. */
  maxLowballs: 2,
  /** His bar for the team rises by this per refused round. */
  barPerRound: 0.01,
});

/** Key of a talks record. */
export const talksKey = (teamId: TeamId, playerId: PlayerId): string => `${teamId}:${playerId}`;

/** A fresh record (no refused rounds yet). */
export const freshFaTalks = (player: Player, teamId: TeamId): FreeAgentTalks => ({
  teamId, playerId: player.id, rounds: 0, lowballs: 0, patience: startingTalkPatience(player), walkedAway: false, lastRound: 0,
});

/** The team's talks with a free agent as they stand (fresh when none are recorded). Null for an unknown player. */
export const faTalks = (league: Pick<League, 'freeAgency' | 'players'>, teamId: TeamId, playerId: PlayerId): FreeAgentTalks | null => {
  const player = league.players[playerId];
  if (!player) return null;
  return league.freeAgency?.talks?.[talksKey(teamId, playerId)] ?? freshFaTalks(player, teamId);
};

/** True when he walked away from the team this free agency. */
export const walkedAway = (league: Pick<League, 'freeAgency' | 'players'>, teamId: TeamId, playerId: PlayerId): boolean =>
  league.freeAgency?.talks?.[talksKey(teamId, playerId)]?.walkedAway ?? false;

/** His market bar in bidding round `round` of `fa` (the same bar every team faces). */
export const marketBar = (player: Player, fa: Pick<FreeAgencyState, 'round' | 'maxRounds'> | null): number =>
  acceptThreshold(playerPatience(player, fa ? Math.min(fa.round, fa.maxRounds) : 1, fa?.maxRounds ?? 5));

/** His bar for a team in talks: the market bar plus barPerRound per round he already refused the team. */
export const talksBar = (player: Player, fa: Pick<FreeAgencyState, 'round' | 'maxRounds'> | null, talks: Pick<FreeAgentTalks, 'rounds'> | null): number =>
  marketBar(player, fa) + FA_TALKS.barPerRound * (talks?.rounds ?? 0);

/** Outcome of one refused offer on a talks record. */
export interface RefusalUpdate {
  talks: FreeAgentTalks;
  lowball: boolean;
  /** True when this refusal made him walk away. */
  walkedAway: boolean;
}

/** Records a refused offer (score vs his talks bar) in bidding round `round`. */
export const recordRefusal = (talks: FreeAgentTalks, score: number, bar: number, round: number): RefusalUpdate => {
  const lowball = bar - score > FA_TALKS.lowballGap;
  const patience = talks.patience - FA_TALKS.roundDecay - (lowball ? FA_TALKS.lowballDecay : 0);
  const lowballs = talks.lowballs + (lowball ? 1 : 0);
  const gone = patience <= 0 || lowballs >= FA_TALKS.maxLowballs;
  return {
    talks: { ...talks, rounds: talks.rounds + 1, lowballs, patience: Math.max(0, patience), walkedAway: talks.walkedAway || gone, lastRound: round },
    lowball,
    walkedAway: gone && !talks.walkedAway,
  };
};

/** The staff's read of an offer to a free agent. */
export interface FaInterestEstimate {
  band: InterestBand;
  /** Read margin (true margin plus the staff's error); never the exact bar. */
  estimate: number;
  /** Standard deviation of the staff's error (smaller with a better staff). */
  noise: number;
  talks: FreeAgentTalks;
}

/**
 * How the team's staff reads `offer` to free agent `playerId` (null when he is not a free agent or the team is
 * unknown). The read ignores competing offers (the staff cannot see them) and its error is drawn once per player,
 * season, bidding round and talks round, so re-checking an offer cannot average the noise out.
 */
export const faInterestEstimate = (league: League, teamId: TeamId, playerId: PlayerId, offer: ContractTerms): FaInterestEstimate | null => {
  const team: Team | undefined = league.teams[teamId];
  const player = league.players[playerId];
  if (!team || !player || player.teamId !== null) return null;
  const talks = faTalks(league, teamId, playerId) as FreeAgentTalks;
  const fa = league.freeAgency;
  const ask = playerAsk(player, league, team, leagueCapYear(league));
  const margin = preferenceScore(player, team, offer, league, { ask }) - talksBar(player, fa, talks);
  const noise = lerp(TALKS_TUNING.noiseWorst, TALKS_TUNING.noiseBest, clamp01((negotiationSkill(league, team) - 1) / 98));
  const round = fa ? Math.min(fa.round, fa.maxRounds) : 0;
  const estimate = margin + createRng(`${league.rngSeed}:fa-talks:${playerId}:${league.season.year}:${round}:${talks.rounds}`).gaussian(0, noise);
  const band: InterestBand = estimate >= TALKS_TUNING.likely ? 'likely' : estimate >= TALKS_TUNING.close ? 'close' : 'far';
  return { band, estimate, noise, talks };
};

/** Words for his patience with the team's talks. */
export const faPatienceText = (talks: Pick<FreeAgentTalks, 'patience' | 'walkedAway'>): string =>
  talks.walkedAway ? 'Walked away' : talks.patience >= 0.7 ? 'Patient' : talks.patience >= 0.35 ? 'Wearing thin' : 'At the limit';
