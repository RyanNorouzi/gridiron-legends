import type { PlayerId } from '@/core/ids';
import type { InjurySeverity } from '@/players/types';
import type { Side, TeamSide } from './types';

/** Play-local athlete id, e.g. 'off:WR1' / 'def:FS'. NOT a PlayerId. */
export type AthleteId = string;

export type ThrowType = 'bullet' | 'lob' | 'touch' | 'backShoulder' | 'highPoint' | 'throwAway';
export type TackleKind = 'arm' | 'wrap' | 'hitStick' | 'gang' | 'dive' | 'openField' | 'strip';
export type BreakMove = 'juke' | 'spin' | 'stiffArm' | 'hurdle' | 'truck' | 'burst' | 'none';
export type IncompleteReason = 'drop' | 'overthrown' | 'underthrown' | 'defended' | 'throwAway' | 'outOfBounds' | 'spike' | 'batted';
export type KickKind = 'kickoff' | 'onside' | 'punt' | 'fieldGoal' | 'extraPoint';
export type CatchKind = 'possession' | 'rac' | 'sideline' | 'highPoint' | 'diving';

export type FoulType =
  | 'falseStart' | 'offsides' | 'encroachment' | 'delayOfGame' | 'illegalFormation' | 'tooManyMen'
  | 'illegalMotion' | 'illegalShift' | 'offsideFreeKick'
  | 'holdingOffense' | 'holdingDefense' | 'passInterferenceOffense' | 'passInterferenceDefense'
  | 'facemask' | 'roughingPasser' | 'unnecessaryRoughness' | 'intentionalGrounding' | 'illegalBlockInBack'
  | 'illegalContact' | 'horseCollar' | 'illegalForwardPass' | 'roughingKicker' | 'runningIntoKicker'
  | 'kickCatchInterference' | 'illegalTouching' | 'unsportsmanlike' | 'taunting';

/**
 * Where the penalty is enforced from:
 *  previousSpot   = the line of scrimmage (most live-ball fouls)
 *  spotOfFoul     = spotBallOn (DPI, some holding calls)
 *  endOfPlay      = dead-ball foul after the play; the result stands and yards are added to endBallOn
 *  succeedingSpot = fouls on kicks / after scores; enforced on the next spot or kickoff
 */
export type PenaltyEnforcement = 'previousSpot' | 'spotOfFoul' | 'endOfPlay' | 'succeedingSpot';

export interface PenaltyInfo {
  foul: FoulType;
  side: Side;
  yards: number;
  playerId: PlayerId | null;
  automaticFirstDown: boolean;
  lossOfDown: boolean;
  enforcement: PenaltyEnforcement;
  /** Offense-perspective yard line of the foul; only meaningful for 'spotOfFoul'. */
  spotBallOn: number | null;
  /** True when the foul occurred while the ball was dead (pre-snap or after the whistle). */
  deadBall: boolean;
  /** Live-ball foul → replay the down; dead-ball → next down. */
  replayDown: boolean;
  /** Owned by rules/penalties.ts. Producers MUST set false (undecided); the controller (AI coach or user
   *  PendingDecision 'penaltyDecision') sets the final value before the outcome is written to the play log. */
  accepted: boolean;
}

/** Why the play went dead; set by live-rules/systems, consumed by outcome.ts. */
export type DeadReason =
  | 'tackle' | 'outOfBounds' | 'touchdown' | 'safety' | 'incomplete' | 'interceptionDowned'
  | 'fumbleRecovered' | 'fumbleOutOfBounds' | 'sack' | 'slide' | 'kneel' | 'spike'
  | 'touchback' | 'fairCatch' | 'kickDowned' | 'kickMade' | 'kickMissed' | 'onsideRecovered'
  | 'penaltyDeadBall' | 'forwardProgress' | 'timeExpired' | 'blockedKick';

/** Rulings the spec allows to be challenged. */
export type ReviewKind = 'catch' | 'fumble' | 'touchdown' | 'firstDown' | 'spot';

/** A close on-field ruling flagged as challengeable. Only PlayEngine/FastSim produce these. */
export interface ReviewableCall {
  kind: ReviewKind;
  tick: number;
  athleteId: AthleteId | null;
  /** 0..1 probability the on-field ruling STANDS on review. This is the ONLY field the AI coach may use
   *  when deciding to challenge; it must never read PlayOutcome.review.ifOverturned. */
  confidence: number;
}

/**
 * Live-play events. `ballOn` values are offense-perspective yard lines (ctx.offense), matching
 * PlayContext/PlayOutcome/PenaltyInfo.spotBallOn; anyone needing absolute y calls fieldY().
 */
export type PlayEvent =
  | { type: 'snap'; tick: number }
  | { type: 'handoff'; tick: number; from: AthleteId; to: AthleteId }
  | { type: 'pitch'; tick: number; from: AthleteId; to: AthleteId }
  | { type: 'lateral'; tick: number; from: AthleteId; to: AthleteId }
  | { type: 'playActionFake'; tick: number; qb: AthleteId; to: AthleteId }
  | { type: 'throw'; tick: number; thrower: AthleteId; target: AthleteId | null; throwType: ThrowType; airYards: number; difficulty: number }
  | { type: 'catch'; tick: number; receiver: AthleteId; contested: boolean; catchKind: CatchKind; ballOn: number }
  | { type: 'incomplete'; tick: number; reason: IncompleteReason; target: AthleteId | null; defender: AthleteId | null }
  | { type: 'interception'; tick: number; defender: AthleteId; ballOn: number }
  | { type: 'tipped'; tick: number; by: AthleteId }
  /** The play-ending tackle. `dragYards`: yards the runner churned forward while held (the struggle), when there was one. */
  | { type: 'tackle'; tick: number; tackler: AthleteId; carrier: AthleteId; kind: TackleKind; assists: AthleteId[]; dragYards?: number }
  /** A tackler got hold of the runner: the struggle starts (it ends in a tackle, a broken tackle, a fumble or a whistle). */
  | { type: 'wrapUp'; tick: number; tackler: AthleteId; carrier: AthleteId; kind: TackleKind }
  /** Another defender joins a struggle already under way (a gang tackle in the making). */
  | { type: 'pileJoin'; tick: number; defender: AthleteId; carrier: AthleteId }
  /** The held runner was stood up (no forward progress): the whistle follows, the ball spotted at his furthest point. */
  | { type: 'forwardProgressStopped'; tick: number; carrier: AthleteId; ballOn: number }
  | { type: 'brokenTackle'; tick: number; carrier: AthleteId; defender: AthleteId; move: BreakMove }
  | { type: 'missedTackle'; tick: number; defender: AthleteId; carrier: AthleteId }
  | { type: 'fumble'; tick: number; carrier: AthleteId; forcedBy: AthleteId | null; ballOn: number; forward: boolean }
  | { type: 'recovery'; tick: number; by: AthleteId; side: Side; ballOn: number; advanced: boolean }
  | { type: 'muff'; tick: number; by: AthleteId }
  | { type: 'downed'; tick: number; by: AthleteId; ballOn: number }
  | { type: 'sack'; tick: number; by: AthleteId; assists: AthleteId[]; yardsLost: number }
  | { type: 'pressure'; tick: number; by: AthleteId }
  | { type: 'pancake'; tick: number; blocker: AthleteId; defender: AthleteId }
  /** A blocker and a defender lock up (presentation only: sound and feedback; no rule or stat reads it). */
  | { type: 'blockEngage'; tick: number; blocker: AthleteId; defender: AthleteId; kind: 'run' | 'pass' }
  | { type: 'blockShed'; tick: number; defender: AthleteId; blocker: AthleteId }
  | { type: 'outOfBounds'; tick: number; athlete: AthleteId | null; ballOn: number }
  | { type: 'touchdown'; tick: number; scorer: AthleteId; side: Side }
  | { type: 'safety'; tick: number }
  | { type: 'firstDown'; tick: number }
  | { type: 'slide'; tick: number; athlete: AthleteId }
  | { type: 'kneel'; tick: number; athlete: AthleteId }
  | { type: 'spike'; tick: number; athlete: AthleteId }
  | { type: 'scramble'; tick: number; qb: AthleteId }
  | { type: 'kick'; tick: number; kicker: AthleteId; kind: KickKind; power: number; accuracy: number }
  | { type: 'kickResult'; tick: number; kind: KickKind; made: boolean; distance: number }
  | { type: 'kickBlocked'; tick: number; by: AthleteId }
  | { type: 'touchback'; tick: number }
  | { type: 'fairCatch'; tick: number; by: AthleteId }
  | { type: 'onsideRecovery'; tick: number; by: AthleteId; side: Side }
  | { type: 'penalty'; tick: number; penalty: PenaltyInfo }
  | { type: 'whistle'; tick: number; reason: DeadReason }
  | { type: 'audible'; tick: number; success: boolean; newPlayId: string; side: Side }
  | { type: 'injury'; tick: number; athlete: AthleteId; severity: InjurySeverity }
  | { type: 'specialMove'; tick: number; athlete: AthleteId; move: BreakMove }
  | { type: 'hitStick'; tick: number; by: AthleteId; on: AthleteId }
  | { type: 'switchPlayer'; tick: number; to: AthleteId; side: TeamSide }
  | { type: 'challenge'; tick: number; side: TeamSide; call: ReviewKind; overturned: boolean };
