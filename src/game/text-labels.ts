import type { CatchKind, DeadReason, FoulType, IncompleteReason, KickKind, ThrowType } from './play-events';
import type { SpecialKind } from './rules/scoring';

/**
 * Reader-facing wording for the engine's identifiers: fouls, catch kinds, incompletions, dead-ball reasons, kick kinds
 * and down-and-distance. Play-by-play, recaps and the post-game log share these so no raw id (roughingPasser,
 * highPoint, kickMade) or unrounded yardage (2nd & 12.5) ever reaches the screen.
 */

/** 'shotgunTrips' / 'shotgun-curls' / 'iForm' -> 'Shotgun Trips' / 'Shotgun Curls' / 'I Form'. */
export const humanizeId = (id: string): string =>
  id
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[-_]+/g, ' ')
    .trim()
    .split(/\s+/)
    .map((w) => (w.length > 0 ? w[0]!.toUpperCase() + w.slice(1) : w))
    .join(' ');

const FOUL_LABELS: Record<FoulType, string> = {
  falseStart: 'False start', offsides: 'Offside', encroachment: 'Encroachment', delayOfGame: 'Delay of game',
  illegalFormation: 'Illegal formation', tooManyMen: 'Too many men on the field', illegalMotion: 'Illegal motion',
  illegalShift: 'Illegal shift', offsideFreeKick: 'Offside on the kick', holdingOffense: 'Offensive holding',
  holdingDefense: 'Defensive holding', passInterferenceOffense: 'Offensive pass interference',
  passInterferenceDefense: 'Defensive pass interference', facemask: 'Face mask', roughingPasser: 'Roughing the passer',
  unnecessaryRoughness: 'Unnecessary roughness', intentionalGrounding: 'Intentional grounding',
  illegalBlockInBack: 'Illegal block in the back', illegalContact: 'Illegal contact', horseCollar: 'Horse-collar tackle',
  illegalForwardPass: 'Illegal forward pass', roughingKicker: 'Roughing the kicker', runningIntoKicker: 'Running into the kicker',
  kickCatchInterference: 'Kick-catch interference', illegalTouching: 'Illegal touching', unsportsmanlike: 'Unsportsmanlike conduct',
  taunting: 'Taunting',
};

/** 'roughingPasser' -> 'Roughing the passer'. */
export const foulLabel = (foul: FoulType): string => FOUL_LABELS[foul] ?? humanizeId(foul);

const CATCH_LABELS: Record<CatchKind, string> = {
  possession: 'catch', rac: 'catch in stride', sideline: 'toe-tap catch on the sideline', highPoint: 'leaping catch', diving: 'diving catch',
};

/** Noun phrase for a catch: 'leaping catch', 'contested diving catch'. */
export const catchLabel = (kind: CatchKind, contested: boolean): string => `${contested ? 'contested ' : ''}${CATCH_LABELS[kind] ?? 'catch'}`;

const THROW_LABELS: Record<ThrowType, string> = {
  bullet: 'a bullet', lob: 'a lob', touch: 'a touch pass', backShoulder: 'a back-shoulder throw', highPoint: 'a jump ball', throwAway: 'it away',
};

/** 'backShoulder' -> 'a back-shoulder throw'. */
export const throwLabel = (t: ThrowType): string => THROW_LABELS[t] ?? `a ${humanizeId(t).toLowerCase()}`;

const INCOMPLETE_LABELS: Record<IncompleteReason, string> = {
  drop: 'dropped', overthrown: 'overthrown', underthrown: 'underthrown', defended: 'broken up', throwAway: 'thrown away',
  outOfBounds: 'out of bounds', spike: 'spiked', batted: 'batted down',
};

/** 'Incomplete, overthrown' style clause for an incompletion reason. */
export const incompleteLabel = (reason: IncompleteReason): string => INCOMPLETE_LABELS[reason] ?? humanizeId(reason).toLowerCase();

const KICK_LABELS: Record<KickKind, string> = { kickoff: 'kickoff', onside: 'onside kick', punt: 'punt', fieldGoal: 'field goal', extraPoint: 'extra point' };

/** 'fieldGoal' -> 'field goal'. */
export const kickLabel = (kind: KickKind): string => KICK_LABELS[kind] ?? humanizeId(kind).toLowerCase();

/** Situation heading of a special-teams snap: 'Field goal', 'Onside kick', 'Two-point try'. */
export const specialLabel = (special: SpecialKind): string => {
  if (special === 'twoPoint') return 'Two-point try';
  if (special === 'none') return 'Scrimmage';
  const k = kickLabel(special);
  return k[0]!.toUpperCase() + k.slice(1);
};

const DEAD_LABELS: Partial<Record<DeadReason, string>> = {
  tackle: 'tackled', outOfBounds: 'out of bounds', forwardProgress: 'forward progress stopped', slide: 'the runner slides',
  kneel: 'kneel-down', spike: 'spike', fumbleRecovered: 'fumble recovered', fumbleOutOfBounds: 'fumble out of bounds',
  interceptionDowned: 'interception downed', kickDowned: 'kick downed', fairCatch: 'fair catch', timeExpired: 'whistle',
  blockedKick: 'blocked kick', onsideRecovered: 'onside kick recovered', sack: 'sack', penaltyDeadBall: 'flag',
};

/** Why the whistle blew, in words ('forward progress stopped'). */
export const deadReasonLabel = (reason: DeadReason | null): string => (reason ? DEAD_LABELS[reason] ?? humanizeId(reason).toLowerCase() : 'whistle');

/** Yards to go as a broadcast would say it: whole yards (a fraction rounds up, like the HUD), 'Goal' when the line to gain is the goal line. */
export const distanceLabel = (distance: number, ballOn?: number): string => {
  if (ballOn !== undefined && ballOn + distance >= 100 - 1e-6) return 'Goal';
  return String(Math.max(1, Math.ceil(distance - 1e-6)));
};

const ordinal = (n: number): string => (n === 1 ? '1st' : n === 2 ? '2nd' : n === 3 ? '3rd' : `${n}th`);

/** '3rd & 4', '1st & Goal' (the HUD's chains: 2.5 to go reads '3'). */
export const downDistanceLabel = (down: number, distance: number, ballOn?: number): string => `${ordinal(down)} & ${distanceLabel(distance, ballOn)}`;

/** '1 yard' / '12 yards'. */
export const yardsLabel = (n: number): string => `${n} yard${Math.abs(n) === 1 ? '' : 's'}`;
