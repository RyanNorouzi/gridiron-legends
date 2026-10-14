/**
 * Season wear: the fatigue a player carries from one game week into the next (League.fatigue).
 *
 * A game's own fatigue is shed over a normal week of rest (players/fatigue.ts weeklyRecovery clears it), so what
 * carries over is wear from the WORKLOAD: every snap adds WEAR_TUNING.perSnap (scaled by his stamina, fatigue.ts
 * fatigueCostFactor: 0.7x at stamina 99 up to 1.5x at stamina 1), and each week he keeps only part of what he
 * carried in: `playedRetain` after a full workload, `lightRetain` after a light week (lightSnaps or fewer) and
 * `restRetain` when he did not play (bye, inactive, injured). A good conditioning staff (staff.ts
 * StaffEffects.conditioning) sheds up to 10% more of it, a poor one up to 10% less. The team's weekly practice plan
 * (practice-plan.ts) scales what is kept (rest sheds more, full pads less) and full pads add wear of its own. Wear is
 * capped at `max`.
 *
 * Where it bites (mildly): League.fatigue becomes GameSetup.fatigue, the player's fatigue at kickoff, so a worn
 * starter begins the game slightly slower (fatigueAttrMultiplier) and with a slightly higher injury chance per play
 * (players/injuries.ts injuryProbability grows with fatigue squared); the lineup rotation and the depth chart
 * already read that fatigue. A 65-snap starter settles around 0.18-0.2 wear: about 2% off his athletic attributes at
 * kickoff and about 5% more injury risk. Measured in tests/franchise/season/wear.test.ts. Pure.
 */
import type { PlayerId, TeamId } from '@/core/ids';
import { clamp, ratingToFactor } from '@/core/math';
import { fatigueCostFactor } from '@/players/fatigue';
import type { Player } from '@/players/types';
import type { GameStats } from '@/statistics/types';
import { PRACTICE_TUNING } from './practice-plan';
import { staffEffects } from './staff';
import type { League, PracticePlan } from './types';

/** Wear tuning. */
export const WEAR_TUNING = Object.freeze({
  /** Carried wear per snap at average stamina cost (x fatigueCostFactor). */
  perSnap: 0.0012,
  /** Share of carried wear kept after a week with a full workload. */
  playedRetain: 0.55,
  /** A week with this many snaps or fewer is a light week. */
  lightSnaps: 20,
  /** Share kept after a light week. */
  lightRetain: 0.4,
  /** Share kept after a week without playing (bye, inactive, injured). */
  restRetain: 0.25,
  /** Retain multiplier range from the worst (x1.1) to the best (x0.9) conditioning staff. */
  conditioningSpread: 0.1,
  /** Most wear a player can carry. */
  max: 0.3,
  /** Smaller values are dropped (fully rested). */
  floor: 0.005,
});

/** Share of carried wear kept through a week with `snaps` snaps (conditioning 1..99, default average). */
export const wearRetain = (snaps: number, conditioning = 50): number => {
  const T = WEAR_TUNING;
  const base = snaps <= 0 ? T.restRetain : snaps <= T.lightSnaps ? T.lightRetain : T.playedRetain;
  return base * (1 + T.conditioningSpread * (1 - 2 * ratingToFactor(conditioning)));
};

/** Wear after one week: what he kept of `prev` plus what this week's snaps (and an intense practice) added (0..max).
 *  `plan` is his team's weekly practice plan (practice-plan.ts; default normal). */
export const nextWear = (prev: number, snaps: number, stamina: number, conditioning = 50, plan: PracticePlan = 'normal'): number => {
  const gained = (Math.max(0, snaps) * WEAR_TUNING.perSnap + PRACTICE_TUNING.practiceWear[plan]) * fatigueCostFactor(stamina);
  return clamp(clamp(prev, 0, 1) * wearRetain(snaps, conditioning) * PRACTICE_TUNING.retain[plan] + gained, 0, WEAR_TUNING.max);
};

/** Snaps per player over a week's games (box-score lines). */
export const weekSnaps = (stats: readonly Pick<GameStats, 'players'>[]): Map<PlayerId, number> => {
  const out = new Map<PlayerId, number>();
  for (const s of stats) for (const [id, line] of Object.entries(s.players) as [PlayerId, GameStats['players'][PlayerId]][]) out.set(id, (out.get(id) ?? 0) + line.snaps);
  return out;
};

/**
 * League.fatigue after a week: every player who carried wear or took a snap gets nextWear (his club's
 * conditioning staff applied; free agents average). Entries below `floor` are dropped. `players` is the week's
 * player table (stamina is read from it); `league` supplies teams and coaches.
 */
export const applyWeekWear = (
  league: Pick<League, 'teams' | 'coaches'>, players: Readonly<Record<PlayerId, Player>>, prev: Readonly<Record<PlayerId, number>>, snaps: ReadonlyMap<PlayerId, number>,
  plans: Readonly<Record<TeamId, PracticePlan>> = {},
): Record<PlayerId, number> => {
  const conditioning = new Map<TeamId, number>();
  const conditioningOf = (teamId: TeamId | null): number => {
    const team = teamId ? league.teams[teamId] : undefined;
    if (!team) return 50;
    let c = conditioning.get(team.id);
    if (c === undefined) {
      c = staffEffects(league, team).conditioning;
      conditioning.set(team.id, c);
    }
    return c;
  };
  const out: Record<PlayerId, number> = {};
  const ids = new Set<PlayerId>([...(Object.keys(prev) as PlayerId[]), ...snaps.keys()]);
  // An intense practice wears every rostered player, even one who did not play.
  for (const [teamId, plan] of Object.entries(plans) as [TeamId, PracticePlan][]) {
    if (PRACTICE_TUNING.practiceWear[plan] > 0) for (const id of league.teams[teamId]?.rosterIds ?? []) ids.add(id);
  }
  for (const id of ids) {
    const p = players[id];
    if (!p) continue;
    const plan = p.teamId ? plans[p.teamId] ?? 'normal' : 'normal';
    const w = nextWear(prev[id] ?? 0, snaps.get(id) ?? 0, p.attrs.stamina, conditioningOf(p.teamId), plan);
    if (w >= WEAR_TUNING.floor) out[id] = w;
  }
  return out;
};
