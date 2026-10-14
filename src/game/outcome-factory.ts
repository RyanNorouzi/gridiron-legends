import type { PlayerId } from '@/core/ids';
import type { FoulType, PenaltyEnforcement, PenaltyInfo } from './play-events';
import type { PlayOutcome } from './play-types';
import type { Side, TeamSide } from './types';

/**
 * Builders for PlayOutcome / PenaltyInfo records. Executors (PlayEngine outcome builder, FastSim) and
 * scenario tests start from `emptyOutcome` so every field is populated and the DERIVED fields carry
 * their documented defaults (clockStops=false, possessionAfter=offense, points=0, scoringSide=null).
 *
 * Kick-play convention (kickoff/onside/punt): the KICKING team is the offense. `turnover: false` is the
 * normal result (the receiving team ends with the ball); `turnover: true` means the kicking team kept or
 * regained it (onside recovery -> 'onside', muff recovered by the kicking team -> 'fumble').
 */
export const emptyOutcome = (partial: Partial<PlayOutcome> = {}, offense: TeamSide = 'home'): PlayOutcome => ({
  result: 'run',
  yards: 0,
  endBallOn: 50,
  endBallX: 160 / 6,
  turnover: false,
  turnoverType: null,
  touchdown: false,
  safety: false,
  scoringSide: null,
  points: 0,
  outOfBounds: false,
  incomplete: false,
  firstDown: false,
  clockStops: false,
  timeElapsed: 0,
  presnapElapsed: 0,
  kickMade: null,
  kickDistance: null,
  returnYards: 0,
  possessionAfter: offense,
  ballCarrierId: null,
  passerId: null,
  receiverId: null,
  tacklerIds: [],
  events: [],
  stats: [],
  playByPlay: [],
  airYards: 0,
  yac: 0,
  yardsAfterContact: 0,
  separationAtThrow: null,
  underPressure: false,
  bigPlay: false,
  replayId: null,
  injuries: [],
  fatigueAfter: {},
  review: null,
  epa: 0,
  success: false,
  ...partial,
  penalties: partial.penalties ? partial.penalties.map((p) => ({ ...p })) : [],
});

/**
 * Outcome relative to the snap spot: fills `endBallOn` from `ballOn + yards` (or `yards` from `endBallOn`)
 * when only one of them is given. Touchdowns snap endBallOn to 100, safeties to 0.
 */
export const outcomeAt = (ballOn: number, partial: Partial<PlayOutcome> = {}, offense: TeamSide = 'home'): PlayOutcome => {
  const p: Partial<PlayOutcome> = { ...partial };
  if (p.touchdown && !p.turnover) {
    p.endBallOn = 100;
    p.yards = p.yards ?? 100 - ballOn;
  } else if (p.safety && !p.turnover) {
    p.endBallOn = 0;
    p.yards = p.yards ?? -ballOn;
  } else if (p.endBallOn === undefined && p.yards !== undefined) {
    p.endBallOn = ballOn + p.yards;
  } else if (p.endBallOn !== undefined && p.yards === undefined) {
    p.yards = p.turnover ? 0 : p.endBallOn - ballOn;
  } else if (p.endBallOn === undefined) {
    p.endBallOn = ballOn;
  }
  if (p.incomplete) {
    p.endBallOn = ballOn;
    p.yards = 0;
  }
  return emptyOutcome(p, offense);
};

interface FoulDefaults {
  yards: number;
  side: Side;
  automaticFirstDown: boolean;
  lossOfDown: boolean;
  enforcement: PenaltyEnforcement;
  deadBall: boolean;
  replayDown: boolean;
}

const foul = (
  yards: number, side: Side, enforcement: PenaltyEnforcement, deadBall: boolean, replayDown: boolean,
  automaticFirstDown = false, lossOfDown = false,
): FoulDefaults => ({ yards, side, automaticFirstDown, lossOfDown, enforcement, deadBall, replayDown });

/** Default yardage/enforcement per foul; producers override any field via `makePenalty`. */
export const FOUL_DEFAULTS: Readonly<Record<FoulType, FoulDefaults>> = {
  falseStart: foul(5, 'offense', 'previousSpot', true, true),
  offsides: foul(5, 'defense', 'previousSpot', false, true),
  encroachment: foul(5, 'defense', 'previousSpot', true, true),
  delayOfGame: foul(5, 'offense', 'previousSpot', true, true),
  illegalFormation: foul(5, 'offense', 'previousSpot', false, true),
  tooManyMen: foul(5, 'defense', 'previousSpot', false, true),
  illegalMotion: foul(5, 'offense', 'previousSpot', false, true),
  illegalShift: foul(5, 'offense', 'previousSpot', false, true),
  offsideFreeKick: foul(5, 'offense', 'previousSpot', false, true),
  holdingOffense: foul(10, 'offense', 'previousSpot', false, true),
  holdingDefense: foul(5, 'defense', 'previousSpot', false, true, true),
  passInterferenceOffense: foul(10, 'offense', 'previousSpot', false, true),
  passInterferenceDefense: foul(0, 'defense', 'spotOfFoul', false, true, true),
  facemask: foul(15, 'defense', 'endOfPlay', false, false, true),
  roughingPasser: foul(15, 'defense', 'previousSpot', false, true, true),
  unnecessaryRoughness: foul(15, 'defense', 'endOfPlay', false, false, true),
  intentionalGrounding: foul(10, 'offense', 'spotOfFoul', false, false, false, true),
  illegalBlockInBack: foul(10, 'offense', 'spotOfFoul', false, true),
  illegalContact: foul(5, 'defense', 'previousSpot', false, true, true),
  horseCollar: foul(15, 'defense', 'endOfPlay', false, false, true),
  illegalForwardPass: foul(5, 'offense', 'spotOfFoul', false, false, false, true),
  roughingKicker: foul(15, 'defense', 'previousSpot', false, true, true),
  runningIntoKicker: foul(5, 'defense', 'previousSpot', false, true),
  kickCatchInterference: foul(15, 'offense', 'spotOfFoul', false, true),
  illegalTouching: foul(0, 'offense', 'spotOfFoul', false, true),
  unsportsmanlike: foul(15, 'offense', 'endOfPlay', true, false),
  taunting: foul(15, 'offense', 'endOfPlay', true, false),
};

/** Builds a PenaltyInfo from foul defaults; `accepted` is always false (owned by rules/penalties.ts). */
export const makePenalty = (
  fType: FoulType,
  overrides: Partial<Omit<PenaltyInfo, 'foul' | 'accepted'>> = {},
): PenaltyInfo => {
  const d = FOUL_DEFAULTS[fType];
  return {
    foul: fType,
    side: overrides.side ?? d.side,
    yards: overrides.yards ?? d.yards,
    playerId: overrides.playerId ?? null,
    automaticFirstDown: overrides.automaticFirstDown ?? (d.automaticFirstDown && (overrides.side ?? d.side) === 'defense'),
    lossOfDown: overrides.lossOfDown ?? d.lossOfDown,
    enforcement: overrides.enforcement ?? d.enforcement,
    spotBallOn: overrides.spotBallOn ?? null,
    deadBall: overrides.deadBall ?? d.deadBall,
    replayDown: overrides.replayDown ?? d.replayDown,
    accepted: false,
  };
};

/** A pre-snap dead-ball foul: the play never happened (result 'penalty', 0 yards, no time elapsed). */
export const deadBallOutcome = (ballOn: number, penalty: PenaltyInfo, offense: TeamSide = 'home'): PlayOutcome =>
  outcomeAt(ballOn, { result: 'penalty', yards: 0, timeElapsed: 0, penalties: [penalty] }, offense);

/** Convenience for tests: a runner id list. */
export const asPlayerId = (s: string): PlayerId => s as PlayerId;

/** Classifications producers must never emit (read the booleans instead). */
const RESERVED_RESULTS: readonly PlayOutcome['result'][] = ['touchdown', 'safety', 'fumble'];
const NUMERIC_FIELDS: readonly (keyof PlayOutcome)[] = ['yards', 'endBallOn', 'endBallX', 'timeElapsed', 'presnapElapsed', 'returnYards', 'airYards', 'yac', 'yardsAfterContact', 'epa'];

/**
 * Boundary check for an outcome handed to the controller by an executor: every numeric FACT is finite,
 * elapsed times are non-negative, the result is not a reserved classification and penalties are undecided.
 * Throws a descriptive error; returns the outcome unchanged otherwise.
 */
export const assertValidOutcome = (o: PlayOutcome): PlayOutcome => {
  for (const k of NUMERIC_FIELDS) {
    const v = o[k];
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`PlayOutcome.${k} must be a finite number, got ${String(v)}`);
  }
  if (o.timeElapsed < 0 || o.presnapElapsed < 0) throw new Error('PlayOutcome: timeElapsed/presnapElapsed must be >= 0');
  if (RESERVED_RESULTS.includes(o.result)) throw new Error(`PlayOutcome.result '${o.result}' is reserved; set the touchdown/safety/turnover flags instead`);
  if (!Array.isArray(o.penalties)) throw new Error('PlayOutcome.penalties must be an array');
  if (o.turnover && o.turnoverType === null) throw new Error('PlayOutcome: a turnover needs a turnoverType');
  if (o.review && o.review.ifOverturned.review !== null) throw new Error('PlayOutcome.review.ifOverturned must not carry its own review');
  return o;
};
