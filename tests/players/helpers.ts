import type { PlayerId } from '@/core/ids';
import { computeOverall, emptyAttrs } from '@/players/attributes';
import type { NameSource } from '@/players/generator';
import type { Player, Position } from '@/players/types';

const FIRST = ['Avery', 'Blake', 'Casey', 'Dakota', 'Emerson', 'Finley', 'Harper', 'Jordan'];
const LAST = ['Archer', 'Brooks', 'Carver', 'Dalton', 'Ellison', 'Fletcher', 'Granger', 'Holloway'];

/** Minimal NameSource for tests (draws from the rng so results stay deterministic). */
export const testNames: NameSource = {
  pickFirst: (rng) => FIRST[rng.int(0, FIRST.length - 1)] ?? 'Avery',
  pickLast: (rng) => LAST[rng.int(0, LAST.length - 1)] ?? 'Archer',
};

export const REGIONS = ['north', 'south', 'east', 'west'] as const;
export const COLLEGES = ['Ridgeview State', 'Harbor Tech', 'Pine Valley'] as const;

export type PlayerOverrides = Partial<Player> & { attrValue?: number };

/** Builds a complete Player with flat attributes (default 70) and sensible defaults. */
export const makePlayer = (overrides: PlayerOverrides = {}): Player => {
  const { attrValue, ...rest } = overrides;
  const position: Position = rest.position ?? 'WR';
  const attrs = rest.attrs ?? emptyAttrs(attrValue ?? 70);
  const overall = computeOverall(attrs, position);
  const base: Player = {
    id: 'p_test0001' as PlayerId,
    firstName: 'Test',
    lastName: 'Player',
    position,
    age: 26,
    jerseyNumber: 11,
    heightIn: 72,
    weightLb: 200,
    attrs,
    overall,
    potential: overall,
    devTrait: 'normal',
    experience: 4,
    traits: [],
    morale: { morale: 70, confidence: 70, coachRelationship: 60 },
    contract: null,
    teamId: null,
    injury: null,
    injuryHistory: [],
    draft: null,
    retired: false,
    rookieYear: 2020,
    askingSalary: 1_000_000,
    preferences: { money: 0.5, playingTime: 0.5, winning: 0.5, location: 0.5, coach: 0.5, role: 0.5, chemistry: 0.5 },
    homeRegion: 'north',
    college: null,
    trainingFocus: null,
    progressionLog: [],
  };
  return { ...base, ...rest, potential: rest.potential ?? Math.max(overall, base.potential) };
};

export const mean = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
