/**
 * Practice-mode contracts: drill definitions (data), the options a player picks for a drill, the evidence a rep
 * produces and the verdict a drill's evaluator returns. Everything here is plain data so the drill model, the
 * headless rep runner and the practice / tutorial screens share one vocabulary.
 */
import type { PlayerQuality } from '@/players/generator';
import type { AthleteId, PlayEvent } from '../play-events';
import type { PlayContext, PlayOutcome } from '../play-types';
import type { DifficultyId, Direction } from '../types';

/** Picker tab a drill belongs to. */
export type DrillCategory = 'offense' | 'defense' | 'specialTeams';

/** Identifier of a drill in the catalogue (drills.ts). */
export type DrillId =
  | 'passRoutes' | 'passZone' | 'passMan' | 'running' | 'catching'
  | 'coverage' | 'zoneCoverage' | 'tackling'
  | 'fieldGoal' | 'punting';

/** Offense-perspective hash the ball is spotted on for kicks. */
export type HashChoice = 'left' | 'middle' | 'right';
/** Wind relative to the kick: calm, in the kicker's face, at his back, or across. */
export type WindChoice = 'calm' | 'headwind' | 'tailwind' | 'crossLeft' | 'crossRight';
/** Offense-perspective third of the field a directional punt should land in. */
export type PuntTarget = 'left' | 'middle' | 'right';

/** What the player chose for a drill. Kicking fields are ignored by drills that do not use them. */
export interface DrillOptions {
  difficulty: DifficultyId;
  /** Field goals: attempt distance in yards (ball spotted at 100 - (distance - 17)). */
  kickDistance: number;
  /** Punts: line of scrimmage (offense-perspective yard line). */
  puntFrom: number;
  hash: HashChoice;
  wind: WindChoice;
  /** Wind speed used when `wind` is not calm. */
  windMph: number;
  puntTarget: PuntTarget;
}

/** Which kicking options a drill exposes on its setup screen. */
export type DrillOptionKey = 'kickDistance' | 'puntFrom' | 'hash' | 'wind' | 'windMph' | 'puntTarget';

/**
 * How the user drives an athlete:
 *  - 'engine': the user's side is `human` in the PlayContext and the engine's own user control runs the athlete
 *    (control follows the ball to the carrier, switchPlayer works on defense).
 *  - 'puppet': the side stays AI and the practice decider feeds the user's input to one fixed athlete (JUGS
 *    receiver: the engine would otherwise hand control to the quarterback at the snap).
 */
export type ControlMode = 'engine' | 'puppet';

/**
 * Scripted behaviour layered over the real AI for a drill:
 *  - live: real AI everywhere except the user.
 *  - jugs: the quarterback is a JUGS machine throwing to the user's receiver; nobody else moves.
 *  - oneOnOne: blockers stand, every defender but the user is benched far downfield (open-field tackling).
 *  - coverage: the quarterback targets the receiver the user covers (man: his man; zone: the receiver nearest him
 *    at the throw); linemen and the other defenders stand.
 *  - noRush: the defense stands still (kicking drills).
 *  - freeRoam: the quarterback keeps the ball and nobody but the user moves (tutorial movement).
 */
export type DrillScript = 'live' | 'jugs' | 'oneOnOne' | 'coverage' | 'noRush' | 'freeRoam';

/** Evaluator families (see evaluators.ts). */
export type EvaluatorId = 'completion' | 'runGain' | 'jugsCatch' | 'coverage' | 'tackle' | 'fieldGoal' | 'punt';

/** Per-difficulty knobs of a drill. */
export interface DrillLevel {
  /** Quality of the practice squad across from the user. */
  opponent: PlayerQuality;
  /** Quality of the user's own squad (default 'starter'); kicking drills hand harder levels a weaker leg. */
  userQuality?: PlayerQuality;
  /** Evaluator threshold: minimum yards (completion / run), maximum yards allowed (coverage / tackle), minimum
   *  gross yards (punt). Unused by field goals and catches. */
  yards: number;
  /** Punts: minimum hang time in seconds. */
  hangTime?: number;
  /** JUGS: how far (yards) the machine's throws stray from the receiver's lead point. */
  throwSpread?: number;
}

/** Data-driven drill definition. */
export interface DrillDefinition {
  id: DrillId;
  name: string;
  category: DrillCategory;
  /** One-line description for the picker. */
  summary: string;
  /** Goal template; `{yards}` / `{hang}` / `{distance}` are filled from the level and options. */
  goal: string;
  /** Offensive play ids; reps rotate through them (scripted routes). */
  offensePlays: readonly string[];
  /** Defensive play id, or null for no defense on the field. */
  defensePlay: string | null;
  /** Which unit the user plays. */
  userUnit: 'offense' | 'defense';
  /** Formation role the user controls at the snap (null = engine default). */
  controlRole: string | null;
  control: ControlMode;
  script: DrillScript;
  evaluator: EvaluatorId;
  /** Default line of scrimmage (offense perspective). Kicking drills derive it from the options. */
  ballOn: number;
  /** Seconds the rep keeps running after the verdict so the play can be watched (ball reaching the posts...). */
  settleSeconds: number;
  /** Camera context while the rep runs. */
  camera: 'offense' | 'defense' | 'kick' | 'punt';
  options: readonly DrillOptionKey[];
  levels: Readonly<Record<DifficultyId, DrillLevel>>;
}

/** Measurements a rep collects while it runs (kick flight, landing). */
export interface RepMetrics {
  /** Seconds from the kick to the predicted landing (punts / field goals). */
  hangTime: number | null;
  /** Predicted landing spot of a kick, absolute field coordinates. */
  landingX: number | null;
  landingY: number | null;
}

/** Metrics before anything was measured. */
export const emptyMetrics = (): RepMetrics => ({ hangTime: null, landingX: null, landingY: null });

/** Everything an evaluator may look at. `outcome` is null while the play is still live. */
export interface RepEvidence {
  events: readonly PlayEvent[];
  outcome: PlayOutcome | null;
  /** Every athlete the user controlled during the rep. */
  userIds: readonly AthleteId[];
  /** Athlete id of the primary read / JUGS target / covered receiver. */
  focusId: AthleteId | null;
  startBallOn: number;
  losY: number;
  direction: Direction;
  ballX: number;
  metrics: RepMetrics;
}

/** A drill evaluator's judgement of one rep. */
export interface RepVerdict {
  success: boolean;
  /** Base points before the streak multiplier (0 on failures). */
  points: number;
  /** Short banner text, e.g. "COMPLETE +12". */
  headline: string;
  /** One-line explanation, e.g. "Primary read, 12 yards". */
  detail: string;
}

/** A drill's evaluator: returns null while the evidence is not yet decisive (never once `outcome` is set). */
export type DrillEvaluator = (evidence: RepEvidence, level: DrillLevel, def: DrillDefinition, options: DrillOptions) => RepVerdict | null;

/** Human-readable special kind of a drill's context. */
export type DrillSpecial = PlayContext['special'];
