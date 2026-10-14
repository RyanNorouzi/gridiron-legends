import type { CoachId } from '@/core/ids';
import { TICK_DT } from '@/core/time';
import type { AthleteIntent } from '@/game/engine-api';
import type { Athlete, BallKind, PlayState } from '@/game/play-types';
import { integrateMovement } from '@/physics/movement';
import type { Coach, CoachTrait, DefensiveScheme, OffensiveScheme } from '@/teams/types';
import { clearWeather } from '@/game/weather';

/** Puts a fixture play state into the live phase with the ball held by `carrierId` (default the QB). */
export const goLive = (state: PlayState, carrierId = 'off:QB', kind: BallKind = 'snap'): void => {
  state.phase = 'live';
  state.snapTick = 0;
  state.tick = 0;
  state.time = 0;
  state.ball.phase = 'held';
  state.ball.kind = kind;
  state.ball.carrierId = carrierId;
  state.ball.z = 1;
  for (const a of state.athletes) {
    a.state = 'moving';
    a.hasBall = a.id === carrierId;
    if (a.hasBall) state.ball.pos = { x: a.pos.x, y: a.pos.y };
  }
};

/** Hands the ball to another athlete (handoff by default) without moving anybody. */
export const giveBall = (state: PlayState, athleteId: string, kind: BallKind = 'handoff'): void => {
  state.ball.phase = 'held';
  state.ball.kind = kind;
  state.ball.carrierId = athleteId;
  state.ball.lastTouchedId = athleteId;
  for (const a of state.athletes) {
    a.hasBall = a.id === athleteId;
    if (a.hasBall) state.ball.pos = { x: a.pos.x, y: a.pos.y };
  }
};

/** Puts the ball loose on the turf at `pos`. */
export const looseBall = (state: PlayState, pos: { x: number; y: number }, vel = { x: 0, y: 0 }): void => {
  state.ball.phase = 'loose';
  state.ball.kind = 'fumble';
  state.ball.carrierId = null;
  state.ball.pos = { ...pos };
  state.ball.vel = { ...vel };
  state.ball.z = 0;
  state.ball.vz = 0;
  for (const a of state.athletes) a.hasBall = false;
};

/** Advances the play clock by `ticks` fixed steps (no physics). */
export const advance = (state: PlayState, ticks: number): void => {
  state.tick += ticks;
  state.time = state.tick * TICK_DT;
};

/** Integrates one athlete under an intent for one tick in clear weather. */
export const step = (athlete: Athlete, intent: AthleteIntent): void => {
  integrateMovement(athlete, intent, TICK_DT, clearWeather());
};

/** Teleports an athlete (and the ball if he holds it). */
export const place = (state: PlayState, athlete: Athlete, x: number, y: number, vel = { x: 0, y: 0 }): void => {
  athlete.pos = { x, y };
  athlete.vel = { ...vel };
  if (athlete.hasBall) state.ball.pos = { x, y };
};

export interface CoachOverrides {
  traits?: CoachTrait[];
  offensiveScheme?: OffensiveScheme;
  defensiveScheme?: DefensiveScheme;
  offense?: number;
  defense?: number;
  gameManagement?: number;
}

/** A head coach with the given traits/schemes (ratings 70 unless overridden). */
export const makeCoach = (o: CoachOverrides = {}): Coach => ({
  id: 'c_test' as CoachId,
  firstName: 'Test',
  lastName: 'Coach',
  role: 'HC',
  age: 50,
  ratings: { offense: o.offense ?? 70, defense: o.defense ?? 70, playerDevelopment: 60, motivation: 60, gameManagement: o.gameManagement ?? 70, scouting: 60, conditioning: 60 },
  traits: o.traits ?? [],
  teamId: null,
  salary: 1_000_000,
  contractYears: 3,
  offensiveScheme: o.offensiveScheme ?? 'balanced',
  defensiveScheme: o.defensiveScheme ?? 'balanced',
  careerWins: 0,
  careerLosses: 0,
  championships: 0,
});

/** Share of `n` samples for which `pick()` satisfies `pred`. */
export const share = <T>(n: number, pick: (i: number) => T, pred: (t: T) => boolean): number => {
  let hits = 0;
  for (let i = 0; i < n; i++) if (pred(pick(i))) hits++;
  return hits / n;
};
