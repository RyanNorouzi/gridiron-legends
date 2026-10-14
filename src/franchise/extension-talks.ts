/**
 * Contract-extension talks: a team offers its own player a new deal, round by round, with a memory.
 *
 * Every offer he refuses on merit is a round (ClubState.extensionTalks, per player and season). Each round wears
 * his patience with the talks down (TALKS_TUNING.roundDecay), a lowball (score far below his bar) wears it down
 * more, and his bar creeps up a little per round (he is tired of haggling). When his patience runs out, or after
 * maxLowballs lowballs, he breaks off talks: a morale and coach-relationship hit, the 'extensionTalks' flag is
 * dropped, and he will not listen to another offer until the phase changes (then talks reopen with part of his
 * patience back; the round count keeps running for the season). His last counter stands: an offer at least as good
 * on every term is signed whatever the round.
 *
 * The UI never sees his exact bar: interestEstimate reads the offer through the staff's eye (head coach
 * motivation + scouting, negotiationSkill) with deterministic noise per player, season and round, and reports a
 * band (likely / close / far apart). A better staff reads him more tightly. Pure: League in, League out.
 */
import type { PlayerId, TeamId } from '@/core/ids';
import { createRng } from '@/core/rng';
import { clamp, clamp01, lerp } from '@/core/math';
import type { Player } from '@/players/types';
import type { Team } from '@/teams/types';
import { contractApy, extend, leagueCapYear, roundMoney, termsFromApy, type ContractTerms } from './contracts';
import {
  MARKET, ROLE_RANK, acceptThreshold, extensionAsk, extensionCapIssue, higherRole, loyaltyBonus, playerPatience, preferenceScore,
} from './negotiation';
import { ensureClub, withClub } from './rivalries';
import { teamStaff } from './staff';
import type { ExtensionTalks, League, PlayerFlag } from './types';

/** Talks tuning. */
export const TALKS_TUNING = Object.freeze({
  /** Patience lost per refused round. */
  roundDecay: 0.2,
  /** Extra patience lost when the offer was a lowball. */
  lowballDecay: 0.25,
  /** An offer scoring more than this below his bar is a lowball. */
  lowballGap: 0.08,
  /** Lowballs in one stretch of talks that end them. */
  maxLowballs: 3,
  /** His bar rises by this per round already refused this season. */
  barPerRound: 0.012,
  /** Patience when talks reopen after a break-off (next phase). */
  reopenPatience: 0.6,
  /** Morale and coach-relationship change when he breaks off. */
  breakMorale: -8,
  breakCoachRelationship: -5,
  /** Interest estimate noise (standard deviation of the read margin) with the worst and the best staff. */
  noiseWorst: 0.07,
  noiseBest: 0.015,
  /** Read margin bands: likely from `likely`, close from `close`. */
  likely: 0.03,
  close: -0.05,
});

/** Starting patience with extension talks (hot heads less, team players and happy players more). */
export const startingTalkPatience = (p: Pick<Player, 'traits' | 'morale'>): number => {
  let v = 1;
  if (p.traits.includes('hotHeaded')) v -= 0.3;
  if (p.traits.includes('competitive')) v -= 0.1;
  if (p.traits.includes('teamPlayer')) v += 0.2;
  if (p.morale.morale >= 70) v += 0.1;
  if (p.morale.morale < 40) v -= 0.15;
  return clamp(v, 0.4, 1.3);
};

/** A fresh talks record for the current season and phase. */
const freshTalks = (league: League, player: Player, teamId: TeamId): ExtensionTalks => ({
  teamId, year: league.season.year, phase: league.season.phase, rounds: 0, lowballs: 0, patience: startingTalkPatience(player), brokenOff: false, counter: null,
});

/**
 * The player's talks as they stand now (a fresh record when none exists for this team and season). A break-off from
 * an earlier phase has lapsed: talks reopen with reopenPatience and no lowballs held against the team.
 */
export const currentTalks = (league: League, playerId: PlayerId, teamId: TeamId): ExtensionTalks | null => {
  const player = league.players[playerId];
  if (!player) return null;
  const t = ensureClub(league).extensionTalks?.[playerId];
  if (!t || t.teamId !== teamId || t.year !== league.season.year) return freshTalks(league, player, teamId);
  if (t.brokenOff && t.phase !== league.season.phase) {
    return { ...t, phase: league.season.phase, brokenOff: false, lowballs: 0, patience: TALKS_TUNING.reopenPatience, counter: null };
  }
  return t;
};

/** True while he refuses to talk (broke off this phase). */
export const talksBrokenOff = (league: League, playerId: PlayerId, teamId: TeamId): boolean => currentTalks(league, playerId, teamId)?.brokenOff ?? false;

/** Score his bar sits at this round: first-round patience bar plus barPerRound per refused round this season. */
export const extensionBar = (player: Player, talks: Pick<ExtensionTalks, 'rounds'> | null): number =>
  acceptThreshold(playerPatience(player, 1, 3)) + TALKS_TUNING.barPerRound * (talks?.rounds ?? 0);

/** True when `offer` is at least as good as `counter` on every term (same length). */
export const meetsCounter = (offer: ContractTerms, counter: ContractTerms): boolean =>
  offer.years === counter.years && contractApy(offer) >= contractApy(counter) - 1 && ROLE_RANK[offer.role] >= ROLE_RANK[counter.role]
  && offer.guaranteed + offer.signingBonus >= counter.guaranteed + counter.signingBonus - 1;

/** Talks records with this season's entries only (older seasons pruned) and `playerId` set to `talks` (null deletes). */
const writeTalks = (league: League, playerId: PlayerId, talks: ExtensionTalks | null): League => {
  const all = ensureClub(league).extensionTalks ?? {};
  const next: Record<string, ExtensionTalks> = {};
  for (const [id, t] of Object.entries(all)) if (t.year >= league.season.year && id !== playerId) next[id] = t;
  if (talks) next[playerId] = talks;
  return withClub(league, { extensionTalks: next });
};

const dropFlag = (league: League, playerId: PlayerId, flag: PlayerFlag): League => {
  const flags = ensureClub(league).playerFlags;
  const own = flags[playerId];
  if (!own?.includes(flag)) return league;
  return withClub(league, { playerFlags: { ...flags, [playerId]: own.filter((f) => f !== flag) } });
};

/** Result of an extension offer. */
export interface ExtensionResult {
  accepted: boolean;
  /** His appeal score of the offer (0 when it never reached him). */
  score: number;
  /** League after the offer: the new deal when accepted, the recorded round (or break-off) when refused on merit, unchanged otherwise. */
  league: League;
  /** Terms he would sign for when he says no (null when accepted, refused over the cap, or talks ended). */
  counter: ContractTerms | null;
  /** Why the offer could not be made or why talks ended ('cap: ...', 'talks: ...'); null when he decided on merit. */
  reason?: string | null;
  /** The talks after this offer (null when accepted). */
  talks?: ExtensionTalks | null;
  /** True when this refusal made him break off talks. */
  brokeOff?: boolean;
}

/**
 * A team offers its own player a new deal starting in the league cap year. Refused before he sees it when it would
 * put the team over the cap this cap year or next (extensionCapIssue) or while he has broken off talks. Otherwise
 * he scores it (preference score with loyalty) against his bar for this round (extensionBar); an offer meeting his
 * standing counter is always signed. Yes replaces his contract (contracts.ts `extend`) and closes the talks; no
 * records the round (patience, lowballs, his counter) and may end the talks (see the module header).
 * Throws when he is not under contract with the team or the terms are malformed.
 */
export const offerExtension = (league: League, teamId: Team['id'], playerId: Player['id'], terms: ContractTerms): ExtensionResult => {
  const team = league.teams[teamId];
  const player = league.players[playerId];
  if (!team || !player || player.teamId !== teamId || !player.contract) throw new Error(`offerExtension: ${playerId} is not under contract with ${teamId}`);
  if (!Number.isInteger(terms.years) || terms.years < 1 || [terms.salary, terms.guaranteed, terms.signingBonus].some((v) => !Number.isFinite(v) || v < 0)) {
    throw new Error('offerExtension: invalid terms');
  }
  const year = leagueCapYear(league);
  const capIssue = extensionCapIssue(league, teamId, player, terms, year);
  if (capIssue) return { accepted: false, score: 0, league, counter: null, reason: `cap: ${capIssue}` };
  const talks = currentTalks(league, playerId, teamId) as ExtensionTalks;
  if (talks.brokenOff) return { accepted: false, score: 0, league, counter: null, reason: `talks: ${player.firstName} ${player.lastName} has broken off talks until the next phase`, talks };
  const ask = extensionAsk(player, league, team, year);
  const score = preferenceScore(player, team, terms, league, { ask, loyalty: loyaltyBonus(player) });
  const bar = extensionBar(player, talks);
  if (score >= bar || (talks.counter !== null && meetsCounter(terms, talks.counter))) {
    const signed = writeTalks({ ...league, players: { ...league.players, [playerId]: extend(player, terms, year) } }, playerId, null);
    return { accepted: true, score, league: dropFlag(signed, playerId, 'extensionTalks'), counter: null, reason: null, talks: null };
  }
  const lowball = bar - score > TALKS_TUNING.lowballGap;
  const patience = talks.patience - TALKS_TUNING.roundDecay - (lowball ? TALKS_TUNING.lowballDecay : 0);
  const lowballs = talks.lowballs + (lowball ? 1 : 0);
  const next: ExtensionTalks = { ...talks, phase: league.season.phase, rounds: talks.rounds + 1, lowballs, patience: Math.max(0, patience), counter: null };
  if (patience <= 0 || lowballs >= TALKS_TUNING.maxLowballs) {
    const m = player.morale;
    const upset: Player = { ...player, morale: { ...m, morale: clamp(m.morale + TALKS_TUNING.breakMorale, 0, 100), coachRelationship: clamp(m.coachRelationship + TALKS_TUNING.breakCoachRelationship, 0, 100) } };
    const ended = writeTalks({ ...league, players: { ...league.players, [playerId]: upset } }, playerId, { ...next, brokenOff: true });
    return { accepted: false, score, league: dropFlag(ended, playerId, 'extensionTalks'), counter: null, reason: `talks: ${player.firstName} ${player.lastName} broke off talks`, talks: { ...next, brokenOff: true }, brokeOff: true };
  }
  const role = higherRole(terms.role, ask.role);
  const apy = roundMoney(Math.max(contractApy(terms), ask.apy * (1 + TALKS_TUNING.barPerRound * next.rounds)));
  const counter = termsFromApy(apy, ask.years, role, MARKET.guaranteeByRole[role], MARKET.bonusByRole[role]);
  const kept: ExtensionTalks = { ...next, counter };
  return { accepted: false, score, league: writeTalks(league, playerId, kept), counter, reason: null, talks: kept };
};

/* ---------------------------------------------------------------- the read */

/** 1..99: how well the staff reads a player at the table (head coach motivation 60%, best scouting eye 40%). */
export const negotiationSkill = (league: Pick<League, 'coaches'>, team: Pick<Team, 'id' | 'staffIds' | 'headCoachId'>): number => {
  const staff = Object.values(teamStaff(league, team));
  const hc = team.headCoachId ? league.coaches[team.headCoachId] : undefined;
  const motivation = hc && hc.teamId === team.id ? hc.ratings.motivation : 35;
  const eye = staff.reduce((m, c) => Math.max(m, c.ratings.scouting), 35);
  return clamp(Math.round(0.6 * motivation + 0.4 * eye), 1, 99);
};

/** Interest band of a read. */
export type InterestBand = 'likely' | 'close' | 'far';

/** The staff's read of an offer: a noisy margin (score minus bar) and its band. */
export interface InterestEstimate {
  band: InterestBand;
  /** Read margin (true margin plus the staff's error); never the exact bar. */
  estimate: number;
  /** Standard deviation of the staff's error (smaller with a better staff). */
  noise: number;
  talks: ExtensionTalks;
}

/**
 * How the staff reads `offer` (null when he is not under contract with the team). The error is drawn once per
 * player, season and round (the same offer reads the same until a round is played), so re-checking an offer
 * cannot average it out.
 */
export const interestEstimate = (league: League, teamId: TeamId, playerId: PlayerId, offer: ContractTerms): InterestEstimate | null => {
  const team = league.teams[teamId];
  const player = league.players[playerId];
  if (!team || !player || player.teamId !== teamId || !player.contract) return null;
  const talks = currentTalks(league, playerId, teamId) as ExtensionTalks;
  const ask = extensionAsk(player, league, team, leagueCapYear(league));
  const score = preferenceScore(player, team, offer, league, { ask, loyalty: loyaltyBonus(player) });
  const margin = talks.counter && meetsCounter(offer, talks.counter) ? Math.max(0.1, score - extensionBar(player, talks)) : score - extensionBar(player, talks);
  const noise = lerp(TALKS_TUNING.noiseWorst, TALKS_TUNING.noiseBest, clamp01((negotiationSkill(league, team) - 1) / 98));
  const estimate = margin + createRng(`${league.rngSeed}:talks:${playerId}:${league.season.year}:${talks.rounds}`).gaussian(0, noise);
  const band: InterestBand = estimate >= TALKS_TUNING.likely ? 'likely' : estimate >= TALKS_TUNING.close ? 'close' : 'far';
  return { band, estimate, noise, talks };
};

/** Words for his patience with the talks. */
export const patienceText = (talks: Pick<ExtensionTalks, 'patience' | 'brokenOff'>): string =>
  talks.brokenOff ? 'Broke off talks' : talks.patience >= 0.7 ? 'Patient' : talks.patience >= 0.35 ? 'Wearing thin' : 'At the limit';
