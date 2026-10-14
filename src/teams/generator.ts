/**
 * Roster generation and default team records. `generateRoster` builds a 53-man roster whose talent
 * follows the team's strength (0..1): starters land on a strength-driven band, depth drops off by
 * rank, a few stars and busts break the pattern and every jersey number is unique. Deterministic per
 * Rng. Pure and headless.
 */
import type { Rng } from '@/core/rng';
import { clamp, lerp } from '@/core/math';
import { POSITIONS, POSITION_GROUP, isDefensive, isOffensive } from '@/players/types';
import type { Player, Position } from '@/players/types';
import { QUALITY_OVERALL_BANDS, generatePlayer, rollJerseyNumber } from '@/players/generator';
import type { NameSource, PlayerQuality } from '@/players/generator';
import type { Facilities, FanBase, TeamFinances } from '@/teams/types';
import type { MarketSize } from '@/teams/data';
import { ROSTER_COMPOSITION, STARTER_COUNTS } from '@/teams/depth-chart';

/** Inputs for generateRoster. */
export interface GenerateRosterOptions {
  /** Team strength 0..1: 0 = bottom of the league, 1 = juggernaut. */
  quality: number;
  names: NameSource;
  /** Non-empty region keys; repeat a key to bias the draw toward it. */
  regions: readonly string[];
  colleges?: readonly string[];
  year: number;
  /** Players per position; defaults to ROSTER_COMPOSITION. */
  composition?: Readonly<Record<Position, number>>;
  /** Offense-minus-defense strength tilt in strength units; default drawn from N(0, UNIT_TILT_SD). */
  unitTilt?: number;
}

/** Starter overall at team strength 0 and 1. */
export const STARTER_OVERALL_RANGE: readonly [number, number] = [61, 86];
/** Sd of the offense-vs-defense tilt so teams have an identity (great defense, shaky offense...). */
export const UNIT_TILT_SD = 0.1;
/** Overall drop-off from the starter's target by depth rank (index = rank within the position). */
export const DEPTH_DROPOFF: readonly number[] = [0, 8, 14, 18, 21, 23];
/** Extra drop for the second quarterback: backups at QB are weaker than elsewhere. */
const QB_BACKUP_EXTRA_DROP = 4;
/** Per-player jitter (sd) around the targeted overall. */
const TARGET_JITTER_SD = 3.5;
/** Generated overalls stay inside this band. */
const TARGET_BOUNDS: readonly [number, number] = [40, 97];
/** Chance that a depth player (rank >= 2) is a young developmental body instead of a journeyman. */
const YOUNG_DEPTH_CHANCE = 0.35;

/** Quality tier whose overall band contains `overall` (prospect is never returned). */
export const qualityTierFor = (overall: number): PlayerQuality => {
  if (overall >= QUALITY_OVERALL_BANDS.elite[0]) return 'elite';
  if (overall >= QUALITY_OVERALL_BANDS.starter[0]) return 'starter';
  if (overall >= QUALITY_OVERALL_BANDS.rotation[0]) return 'rotation';
  if (overall >= QUALITY_OVERALL_BANDS.backup[0]) return 'backup';
  return 'fringe';
};

/**
 * Target overall for the player at `rank` of `position` on a team of strength `quality`.
 * Stars (more likely on strong teams) and busts (more likely on weak ones) hit starters only.
 */
export const targetOverallFor = (rng: Rng, quality: number, position: Position, rank: number): number => {
  const q = clamp(quality, 0, 1);
  const starter = lerp(STARTER_OVERALL_RANGE[0], STARTER_OVERALL_RANGE[1], q);
  let drop = DEPTH_DROPOFF[Math.min(rank, DEPTH_DROPOFF.length - 1)] ?? 0;
  if (position === 'QB' && rank >= 1) drop += QB_BACKUP_EXTRA_DROP;
  let target = starter - drop + rng.gaussian(0, TARGET_JITTER_SD);
  if (rank < STARTER_COUNTS[position]) {
    if (rng.chance(0.04 + 0.22 * q)) target += rng.int(5, 10);
    else if (rng.chance(0.15 * (1 - q))) target -= rng.int(4, 8);
  }
  return Math.round(clamp(target, TARGET_BOUNDS[0], TARGET_BOUNDS[1]));
};

/** Re-rolls duplicate jersey numbers within the roster; falls back to any free 1..99 number. */
export const ensureUniqueJerseys = (rng: Rng, players: readonly Player[]): Player[] => {
  const used = new Set<number>();
  return players.map((p) => {
    let jersey = p.jerseyNumber;
    for (let attempt = 0; used.has(jersey) && attempt < 40; attempt++) jersey = rollJerseyNumber(rng, p.position);
    if (used.has(jersey)) {
      const free = Array.from({ length: 99 }, (_, i) => i + 1).filter((n) => !used.has(n));
      jersey = free.length > 0 ? rng.pick(free) : jersey;
    }
    used.add(jersey);
    return jersey === p.jerseyNumber ? p : { ...p, jerseyNumber: jersey };
  });
};

const validateRosterOptions = (opts: GenerateRosterOptions): void => {
  if (!Number.isFinite(opts.quality) || opts.quality < 0 || opts.quality > 1) {
    throw new Error(`generateRoster: quality must be in 0..1, got ${opts.quality}`);
  }
  if (opts.regions.length === 0) throw new Error('generateRoster: regions must be non-empty');
  if (!Number.isInteger(opts.year)) throw new Error('generateRoster: year must be an integer');
  const composition = opts.composition ?? ROSTER_COMPOSITION;
  for (const pos of POSITIONS) {
    const n = composition[pos];
    if (!Number.isInteger(n) || n < 0) throw new Error(`generateRoster: composition.${pos} must be a non-negative integer`);
  }
};

/**
 * Generates a complete roster (ROSTER_COMPOSITION by default) in position order, best player first
 * within each position. Players are unattached (teamId/contract null); the league generator signs them.
 */
export const generateRoster = (rng: Rng, opts: GenerateRosterOptions): Player[] => {
  validateRosterOptions(opts);
  const composition = opts.composition ?? ROSTER_COMPOSITION;
  const tilt = opts.unitTilt ?? rng.gaussian(0, UNIT_TILT_SD);
  const players: Player[] = [];
  for (const position of POSITIONS) {
    const count = composition[position];
    const group: Player[] = [];
    const unitQuality = clamp(opts.quality + (isOffensive(position) ? tilt : isDefensive(position) ? -tilt : 0), 0, 1);
    for (let rank = 0; rank < count; rank++) {
      const target = targetOverallFor(rng, unitQuality, position, rank);
      const young = rank >= 2 && rng.chance(YOUNG_DEPTH_CHANCE);
      const player = generatePlayer(rng, {
        position,
        names: opts.names,
        regions: opts.regions,
        colleges: opts.colleges,
        year: opts.year,
        quality: qualityTierFor(target),
        targetOverall: target,
        ...(young ? { age: rng.int(22, 24) } : {}),
      });
      group.push(player);
    }
    group.sort((a, b) => b.overall - a.overall || (a.id < b.id ? -1 : 1));
    players.push(...group);
  }
  return ensureUniqueJerseys(rng, players);
};

/** Mean overall of the top `n` players at a position (0 when none). */
export const topOverallMean = (players: readonly Player[], position: Position, n: number): number => {
  const group = players.filter((p) => p.position === position).sort((a, b) => b.overall - a.overall).slice(0, n);
  return group.length === 0 ? 0 : group.reduce((s, p) => s + p.overall, 0) / group.length;
};

/** Players grouped by position group (offense/defense unit views). */
export const playersByGroup = (players: readonly Player[]): Record<string, Player[]> => {
  const out: Record<string, Player[]> = {};
  for (const p of players) (out[POSITION_GROUP[p.position]] ??= []).push(p);
  return out;
};

/* ------------------------------ Default team records ------------------------------ */

/** Starting cash and ticket price by market size. */
export const MARKET_DEFAULTS: Readonly<Record<MarketSize, { cash: number; ticketPrice: number; support: number; facilityLevel: number }>> = {
  small: { cash: 20_000_000, ticketPrice: 65, support: 52, facilityLevel: 2 },
  medium: { cash: 35_000_000, ticketPrice: 85, support: 58, facilityLevel: 2 },
  large: { cash: 60_000_000, ticketPrice: 110, support: 64, facilityLevel: 3 },
};

/** Fresh finances: no revenue/expenses booked, no dead money, cash defaulting to 20% of the cap. */
export const emptyTeamFinances = (cap: number, overrides: Partial<Pick<TeamFinances, 'cash' | 'ticketPrice'>> = {}): TeamFinances => {
  if (!Number.isFinite(cap) || cap <= 0) throw new Error(`emptyTeamFinances: cap must be positive, got ${cap}`);
  return {
    cash: overrides.cash ?? Math.round(cap * 0.2),
    ticketPrice: overrides.ticketPrice ?? MARKET_DEFAULTS.medium.ticketPrice,
    seasonRevenue: { tickets: 0, merchandise: 0, sponsors: 0, concessions: 0 },
    seasonExpenses: { playerSalaries: 0, staffSalaries: 0, stadium: 0, facilities: 0 },
    deadMoney: {},
    capCarryover: 0,
  };
};

/** Every facility at `level` (clamped 1..5). */
export const defaultFacilities = (level = 2): Facilities => {
  const l = clamp(Math.round(level), 1, 5);
  return { training: l, medical: l, scouting: l, stadium: l, development: l, analytics: l };
};

/** Neutral fan base scaled by market size: modest support, average excitement, healthy attendance. */
export const defaultFans = (marketSize: MarketSize = 'medium'): FanBase => ({
  support: MARKET_DEFAULTS[marketSize].support,
  excitement: 50,
  attendancePct: 0.85,
});
