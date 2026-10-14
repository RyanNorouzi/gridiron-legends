import type { Rng } from './rng';

/** Branded string ids keep entity ids from being mixed up at compile time. */
export type Brand<T, B extends string> = T & { readonly __brand: B };
export type PlayerId = Brand<string, 'PlayerId'>;
export type TeamId = Brand<string, 'TeamId'>;
export type CoachId = Brand<string, 'CoachId'>;
export type StadiumId = Brand<string, 'StadiumId'>;
export type GameId = Brand<string, 'GameId'>;
export type PlayId = Brand<string, 'PlayId'>;
export type LeagueId = Brand<string, 'LeagueId'>;

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/** Deterministic id built from an rng so saves/replays are reproducible. */
export const makeId = <B extends string>(rng: Rng, prefix: string, length = 8): Brand<string, B> => {
  let s = prefix + '_';
  for (let i = 0; i < length; i++) s += ALPHABET[rng.int(0, ALPHABET.length - 1)];
  return s as Brand<string, B>;
};

export const playerId = (rng: Rng): PlayerId => makeId<'PlayerId'>(rng, 'p');
export const teamId = (rng: Rng): TeamId => makeId<'TeamId'>(rng, 't');
export const coachId = (rng: Rng): CoachId => makeId<'CoachId'>(rng, 'c');
export const stadiumId = (rng: Rng): StadiumId => makeId<'StadiumId'>(rng, 's');
export const gameId = (rng: Rng): GameId => makeId<'GameId'>(rng, 'g');
export const playId = (rng: Rng): PlayId => makeId<'PlayId'>(rng, 'pl');
export const leagueId = (rng: Rng): LeagueId => makeId<'LeagueId'>(rng, 'lg');
