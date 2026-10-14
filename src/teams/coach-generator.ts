/**
 * Coaching staff generation. Each role has a rating profile (a head coach lives on game management
 * and motivation, a strength coach on conditioning), an age band, a salary band and a contract band.
 * `generateStaff` builds the full 11-role staff with coordinators sharing the head coach's schemes.
 * Deterministic per Rng. Pure and headless.
 */
import type { Rng } from '@/core/rng';
import { coachId } from '@/core/ids';
import type { TeamId } from '@/core/ids';
import { clamp, lerp, mean, ratingToFactor } from '@/core/math';
import type { NameSource } from '@/players/generator';
import { avoidReservedName, createNamePool } from '@/players/names';
import type { Coach, CoachRatings, CoachTrait, DefensiveScheme, OffensiveScheme, StaffRole } from '@/teams/types';

/** Every staff role, head coach first (generateStaff order). */
export const STAFF_ROLES: readonly StaffRole[] = [
  'HC', 'OC', 'DC', 'QBCoach', 'RBCoach', 'WRCoach', 'OLCoach', 'DBCoach', 'LBCoach', 'StrengthCoach', 'Scout',
];
/** All coach traits. */
export const COACH_TRAITS: readonly CoachTrait[] = [
  'aggressive', 'conservative', 'playersCoach', 'disciplinarian', 'innovator', 'developer', 'motivator', 'clockManager',
];
/** Offensive schemes and their draw weights. */
export const OFFENSIVE_SCHEMES: readonly OffensiveScheme[] = ['balanced', 'airRaid', 'westCoast', 'groundAndPound', 'spread'];
/** Defensive schemes and their draw weights. */
export const DEFENSIVE_SCHEMES: readonly DefensiveScheme[] = ['balanced', 'blitzHeavy', 'coverageFirst', 'runStuff'];
const OFFENSIVE_SCHEME_WEIGHTS: readonly number[] = [0.3, 0.15, 0.2, 0.15, 0.2];
const DEFENSIVE_SCHEME_WEIGHTS: readonly number[] = [0.35, 0.2, 0.25, 0.2];

/** Every CoachRatings key. */
export const RATING_KEYS: readonly (keyof CoachRatings)[] = [
  'offense', 'defense', 'playerDevelopment', 'motivation', 'gameManagement', 'scouting', 'conditioning',
];

/** What a staff role is hired for and paid. */
export interface RoleProfile {
  /** Ratings the role is hired for (+10 over the coach's level). */
  primary: readonly (keyof CoachRatings)[];
  /** Ratings that matter a little (+3). Everything else sits ~12 below the level. */
  secondary: readonly (keyof CoachRatings)[];
  ageRange: readonly [number, number];
  /** Annual salary in dollars at level 0 and level 1. */
  salaryRange: readonly [number, number];
  contractRange: readonly [number, number];
}

/** Rating, age, salary and contract profile per staff role. */
export const ROLE_PROFILES: Readonly<Record<StaffRole, RoleProfile>> = {
  HC: { primary: ['gameManagement', 'motivation'], secondary: ['offense', 'defense', 'playerDevelopment'], ageRange: [38, 64], salaryRange: [3_000_000, 12_000_000], contractRange: [2, 5] },
  OC: { primary: ['offense'], secondary: ['gameManagement', 'playerDevelopment'], ageRange: [34, 60], salaryRange: [1_000_000, 4_500_000], contractRange: [1, 4] },
  DC: { primary: ['defense'], secondary: ['gameManagement', 'playerDevelopment'], ageRange: [34, 60], salaryRange: [1_000_000, 4_500_000], contractRange: [1, 4] },
  QBCoach: { primary: ['playerDevelopment'], secondary: ['offense'], ageRange: [30, 58], salaryRange: [500_000, 1_500_000], contractRange: [1, 3] },
  RBCoach: { primary: ['playerDevelopment'], secondary: ['offense'], ageRange: [28, 58], salaryRange: [400_000, 1_200_000], contractRange: [1, 3] },
  WRCoach: { primary: ['playerDevelopment'], secondary: ['offense'], ageRange: [28, 58], salaryRange: [400_000, 1_200_000], contractRange: [1, 3] },
  OLCoach: { primary: ['playerDevelopment'], secondary: ['offense'], ageRange: [30, 60], salaryRange: [450_000, 1_300_000], contractRange: [1, 3] },
  DBCoach: { primary: ['playerDevelopment'], secondary: ['defense'], ageRange: [28, 58], salaryRange: [400_000, 1_200_000], contractRange: [1, 3] },
  LBCoach: { primary: ['playerDevelopment'], secondary: ['defense'], ageRange: [28, 58], salaryRange: [400_000, 1_200_000], contractRange: [1, 3] },
  StrengthCoach: { primary: ['conditioning'], secondary: ['motivation'], ageRange: [26, 55], salaryRange: [300_000, 900_000], contractRange: [1, 3] },
  Scout: { primary: ['scouting'], secondary: ['playerDevelopment'], ageRange: [26, 62], salaryRange: [250_000, 800_000], contractRange: [1, 3] },
};

/** Trait pairs that never coexist. */
const TRAIT_EXCLUSIONS: readonly (readonly [CoachTrait, CoachTrait])[] = [
  ['aggressive', 'conservative'], ['playersCoach', 'disciplinarian'],
];
const TRAIT_COUNT_WEIGHTS: readonly number[] = [0.2, 0.5, 0.3];
const LEVEL_RANGE: readonly [number, number] = [42, 82];
const GAMES_PER_SEASON = 17;

/** Inputs for generateCoach; everything is optional. */
export interface GenerateCoachOptions {
  /** Defaults to the shipped name pool. */
  names?: NameSource;
  teamId?: TeamId | null;
  /** 0..1 talent level; default drawn uniformly from 0.15..0.85. */
  quality?: number;
  age?: number;
  offensiveScheme?: OffensiveScheme;
  defensiveScheme?: DefensiveScheme;
}

/** Inputs for generateStaff. */
export interface GenerateStaffOptions {
  names?: NameSource;
  /** 0..1 staff quality; every coach jitters around it. Default drawn from 0.2..0.8. */
  quality?: number;
}

/** True when the two traits are mutually exclusive. */
export const coachTraitsConflict = (a: CoachTrait, b: CoachTrait): boolean =>
  TRAIT_EXCLUSIONS.some(([x, y]) => (x === a && y === b) || (x === b && y === a));

/** Draws 0..2 distinct, non-conflicting coach traits. */
export const rollCoachTraits = (rng: Rng): CoachTrait[] => {
  const count = rng.weighted([0, 1, 2], TRAIT_COUNT_WEIGHTS);
  const chosen: CoachTrait[] = [];
  let pool = [...COACH_TRAITS];
  while (chosen.length < count && pool.length > 0) {
    const trait = rng.pick(pool);
    chosen.push(trait);
    pool = pool.filter((t) => t !== trait && !coachTraitsConflict(t, trait));
  }
  return chosen;
};

/** Ratings for a role: primaries sit ~10 above the coach's level, secondaries ~3 above, the rest ~12 below. */
export const rollCoachRatings = (rng: Rng, role: StaffRole, quality: number): CoachRatings => {
  const profile = ROLE_PROFILES[role];
  const level = lerp(LEVEL_RANGE[0], LEVEL_RANGE[1], clamp(quality, 0, 1)) + rng.gaussian(0, 5);
  const ratings = {} as CoachRatings;
  for (const key of RATING_KEYS) {
    const offset = profile.primary.includes(key) ? 10 : profile.secondary.includes(key) ? 3 : -12;
    const sd = profile.primary.includes(key) ? 4 : 6;
    ratings[key] = clamp(Math.round(level + offset + rng.gaussian(0, sd)), 1, 99);
  }
  return ratings;
};

/** The ratings a role is judged on (mean of its primary ratings). */
export const roleRating = (coach: Pick<Coach, 'role' | 'ratings'>): number =>
  mean(ROLE_PROFILES[coach.role].primary.map((k) => coach.ratings[k]));

/** Annual salary (dollars, rounded to 10k) from the role's band and the primary rating level. */
export const coachSalary = (role: StaffRole, ratings: CoachRatings): number => {
  const [lo, hi] = ROLE_PROFILES[role].salaryRange;
  const t = ratingToFactor(roleRating({ role, ratings }), 1.6);
  return Math.round(lerp(lo, hi, t) / 10_000) * 10_000;
};

/** Seasons in charge scaled by age; only head coaches accumulate a record. */
const rollCareer = (rng: Rng, role: StaffRole, age: number, quality: number): Pick<Coach, 'careerWins' | 'careerLosses' | 'championships'> => {
  if (role !== 'HC') return { careerWins: 0, careerLosses: 0, championships: 0 };
  const maxSeasons = clamp(age - ROLE_PROFILES.HC.ageRange[0], 0, 22);
  const seasons = rng.int(0, maxSeasons);
  let wins = 0;
  let championships = 0;
  for (let i = 0; i < seasons; i++) {
    const w = clamp(Math.round(rng.gaussian(6.5 + 4 * quality, 3)), 0, GAMES_PER_SEASON);
    wins += w;
    if (w >= 12 && rng.chance(0.12)) championships += 1;
  }
  return { careerWins: wins, careerLosses: seasons * GAMES_PER_SEASON - wins, championships };
};

/** Generates one coach for a role. Unattached unless `teamId` is given. */
export const generateCoach = (rng: Rng, role: StaffRole, opts: GenerateCoachOptions = {}): Coach => {
  if (!STAFF_ROLES.includes(role)) throw new Error(`generateCoach: unknown role '${String(role)}'`);
  if (opts.quality !== undefined && (opts.quality < 0 || opts.quality > 1)) throw new Error(`generateCoach: quality must be in 0..1, got ${opts.quality}`);
  const profile = ROLE_PROFILES[role];
  if (opts.age !== undefined && (!Number.isInteger(opts.age) || opts.age < 22 || opts.age > 80)) {
    throw new Error(`generateCoach: age must be an integer in 22..80, got ${opts.age}`);
  }
  const names = opts.names ?? createNamePool();
  const id = coachId(rng);
  const quality = opts.quality ?? rng.range(0.15, 0.85);
  const age = opts.age ?? rng.int(profile.ageRange[0], profile.ageRange[1]);
  const ratings = rollCoachRatings(rng, role, quality);
  const traits = rollCoachTraits(rng);
  const offensiveScheme = opts.offensiveScheme ?? rng.weighted(OFFENSIVE_SCHEMES, OFFENSIVE_SCHEME_WEIGHTS);
  const defensiveScheme = opts.defensiveScheme ?? rng.weighted(DEFENSIVE_SCHEMES, DEFENSIVE_SCHEME_WEIGHTS);
  const firstName = names.pickFirst(rng);
  const lastName = avoidReservedName(firstName, names.pickLast(rng), () => names.pickLast(rng));
  const contractYears = rng.int(profile.contractRange[0], profile.contractRange[1]);
  const career = rollCareer(rng, role, age, quality);
  return {
    id, firstName, lastName, role, age, ratings, traits,
    teamId: opts.teamId ?? null,
    salary: coachSalary(role, ratings),
    contractYears, offensiveScheme, defensiveScheme,
    ...career,
  };
};

/**
 * Full 11-role staff for a team: the head coach sets the schemes and the coordinators inherit them;
 * position coaches, the strength coach and the scout draw their own quality around the staff level.
 */
export const generateStaff = (rng: Rng, teamId: TeamId, opts: GenerateStaffOptions = {}): Coach[] => {
  const names = opts.names ?? createNamePool();
  const staffQuality = clamp(opts.quality ?? rng.range(0.2, 0.8), 0, 1);
  const jitter = (): number => clamp(staffQuality + rng.gaussian(0, 0.1), 0, 1);
  const head = generateCoach(rng, 'HC', { names, teamId, quality: jitter() });
  const staff: Coach[] = [head];
  for (const role of STAFF_ROLES) {
    if (role === 'HC') continue;
    staff.push(generateCoach(rng, role, {
      names, teamId, quality: jitter(),
      offensiveScheme: head.offensiveScheme,
      defensiveScheme: head.defensiveScheme,
    }));
  }
  return staff;
};

/** The head coach in a staff list, if any. */
export const headCoachOf = (staff: readonly Coach[]): Coach | undefined => staff.find((c) => c.role === 'HC');
