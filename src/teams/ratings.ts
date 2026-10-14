/**
 * Team ratings from the depth chart: starters weighted by how much each slot swings a game (QB and
 * pass rushers matter more than a second fullback). Missing or unavailable starters count as a
 * replacement-level body, so thin rosters are penalised. Pure and headless.
 */
import type { PlayerId } from '@/core/ids';
import { clamp } from '@/core/math';
import { POSITIONS } from '@/players/types';
import type { Player, Position } from '@/players/types';
import { computeOverall } from '@/players/attributes';
import { canPlayHurt } from '@/players/injuries';
import { chemistryContribution } from '@/players/personality';
import type { DepthChart, DepthSlot } from '@/teams/types';
import { returnScore } from '@/teams/depth-chart';

/** Unit ratings 1..99 plus the blended team overall. */
export interface TeamRatings {
  overall: number;
  offense: number;
  defense: number;
  specialTeams: number;
}

/** Either a roster array or an id-keyed record (League.players). */
export type PlayerSource = readonly Player[] | Readonly<Record<string, Player>>;

/** Overall credited to an empty or unusable slot. */
export const REPLACEMENT_OVERALL = 40;

/** Weight of each depth rank per slot; ranks beyond the list carry no weight. */
export const SLOT_WEIGHTS: Readonly<Record<DepthSlot, readonly number[]>> = Object.freeze({
  QB: [3.0, 0.2], RB: [1.1, 0.3], FB: [0.2], WR: [1.2, 0.9, 0.6, 0.2], TE: [0.8, 0.25],
  OT: [0.8, 0.8, 0.15], OG: [0.6, 0.6, 0.1], C: [0.6, 0.1],
  DE: [1.0, 1.0, 0.25], DT: [0.8, 0.8, 0.2], OLB: [0.8, 0.8, 0.2], MLB: [0.9, 0.2],
  CB: [1.1, 1.0, 0.5, 0.15], FS: [0.8, 0.15], SS: [0.8, 0.15],
  K: [1.0], P: [0.8], KR: [0.5], PR: [0.5],
});

/** Share of each unit in the team overall. */
export const UNIT_MIX = Object.freeze({ offense: 0.45, defense: 0.45, specialTeams: 0.1 });

/** Slots that make up the offense rating. */
export const OFFENSE_SLOTS: readonly DepthSlot[] = ['QB', 'RB', 'FB', 'WR', 'TE', 'OT', 'OG', 'C'];
/** Slots that make up the defense rating. */
export const DEFENSE_SLOTS: readonly DepthSlot[] = ['DE', 'DT', 'OLB', 'MLB', 'CB', 'FS', 'SS'];
/** Slots that make up the special-teams rating. */
export const SPECIAL_SLOTS: readonly DepthSlot[] = ['K', 'P', 'KR', 'PR'];

const isPosition = (slot: DepthSlot): slot is Position => (POSITIONS as readonly string[]).includes(slot);

/** Normalises a roster array or id-keyed record into a lookup map. */
export const toPlayerMap = (source: PlayerSource): Map<PlayerId, Player> => {
  const list = Array.isArray(source) ? (source as readonly Player[]) : Object.values(source as Readonly<Record<string, Player>>);
  return new Map(list.map((p) => [p.id, p]));
};

/**
 * What a player is worth in a given slot: his overall at his own position, his overall re-weighted
 * for the slot's position when playing out of position, and his return aptitude for KR/PR.
 * Players who cannot dress are worth replacement level.
 */
export const slotValue = (player: Player, slot: DepthSlot): number => {
  if (player.retired || !canPlayHurt(player)) return REPLACEMENT_OVERALL;
  if (slot === 'KR' || slot === 'PR') return clamp(returnScore(player, slot), 1, 99);
  return player.position === slot ? player.overall : computeOverall(player.attrs, slot);
};

/** Weighted mean of slot values over the given slots (1..99). */
export const unitRating = (slots: readonly DepthSlot[], chart: DepthChart, players: ReadonlyMap<PlayerId, Player>): number => {
  let total = 0;
  let weightSum = 0;
  for (const slot of slots) {
    if (!isPosition(slot) && slot !== 'KR' && slot !== 'PR') continue;
    const weights = SLOT_WEIGHTS[slot];
    const listed = chart[slot] ?? [];
    weights.forEach((w, rank) => {
      const id = listed[rank];
      const player = id === undefined ? undefined : players.get(id);
      total += w * (player ? slotValue(player, slot) : REPLACEMENT_OVERALL);
      weightSum += w;
    });
  }
  return weightSum > 0 ? clamp(Math.round(total / weightSum), 1, 99) : REPLACEMENT_OVERALL;
};

/** Offense, defense, special teams and the blended overall for a roster and its depth chart. */
export const teamRatings = (players: PlayerSource, depthChart: DepthChart): TeamRatings => {
  const byId = toPlayerMap(players);
  const offense = unitRating(OFFENSE_SLOTS, depthChart, byId);
  const defense = unitRating(DEFENSE_SLOTS, depthChart, byId);
  const specialTeams = unitRating(SPECIAL_SLOTS, depthChart, byId);
  const overall = clamp(Math.round(offense * UNIT_MIX.offense + defense * UNIT_MIX.defense + specialTeams * UNIT_MIX.specialTeams), 1, 99);
  return { overall, offense, defense, specialTeams };
};

/** Mean chemistryContribution of an ordinary roster (content, mid-career, neutral traits). */
export const NEUTRAL_CHEMISTRY_CONTRIBUTION = 2.4;
/** Chemistry points per unit of mean contribution above/below neutral. */
export const CHEMISTRY_SCALE = 12;

/** Locker-room chemistry 0..100 from the roster's trait/morale contributions (50 = an ordinary room). */
export const teamChemistry = (players: readonly Player[]): number => {
  if (players.length === 0) return 50;
  const total = players.reduce((s, p) => s + chemistryContribution(p), 0);
  return clamp(Math.round(50 + (total / players.length - NEUTRAL_CHEMISTRY_CONTRIBUTION) * CHEMISTRY_SCALE), 0, 100);
};

/** Per-position starter strength (mean slotValue of the weighted ranks), useful for scouting views. */
export const positionStrengths = (players: PlayerSource, depthChart: DepthChart): Record<Position, number> => {
  const byId = toPlayerMap(players);
  const out = {} as Record<Position, number>;
  for (const pos of POSITIONS) out[pos] = unitRating([pos], depthChart, byId);
  return out;
};
