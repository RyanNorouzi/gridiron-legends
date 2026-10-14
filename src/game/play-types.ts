import type { PlayerId } from '@/core/ids';
import type { Vec2 } from '@/core/vec2';
import type { Rng } from '@/core/rng';
import type { AttributeSet, Player, Position, InjurySeverity } from '@/players/types';
import type { AudibleSet, DefAssignment, DefensiveAudibleSet, DefensivePlay, OffAssignment, OffensivePlay } from '@/playbook/types';
import type { PlayStatDelta } from '@/statistics/types';
import type { Coach } from '@/teams/types';
import type { ControllerKind, DifficultyProfile, Direction, Ruleset, Side, TeamSide, WeatherState } from './types';
import type { AthleteId, DeadReason, PenaltyInfo, PlayEvent, ReviewableCall, ThrowType } from './play-events';
import type { AthleteIntent } from './engine-api';

/**
 * Live-play types: everything the PlayEngine manipulates tick by tick. See ./types.ts for field
 * conventions and ./play-events.ts for events, penalties and reviews.
 */
export type UserControlMode = 'offense' | 'defense' | 'watch' | 'none';

export type AthleteState =
  | 'idle' | 'presnap' | 'moving' | 'blocking' | 'engaged' | 'shedding' | 'tackling' | 'tackled'
  | 'down' | 'diving' | 'juking' | 'spinning' | 'hurdling' | 'stiffArming' | 'catching' | 'jumping'
  | 'throwing' | 'kicking' | 'dropback' | 'scrambling' | 'sliding' | 'stumbling' | 'celebrating' | 'trucking'
  // Tackle struggle: a carrier who is held but still fighting for yards, a tackler hanging on to him, and anyone
  // going to the ground (the tackle finishing, or bodies settling after the whistle).
  | 'wrapped' | 'wrapping' | 'falling';

/** Per-athlete AI scratch memory. Reset every play. */
export interface AthleteAiMemory {
  targetPos: Vec2 | null;
  targetAthleteId: AthleteId | null;
  reactionTimer: number;
  routeIndex: number;
  routeTimer: number;
  readIndex: number;
  lastDecisionTick: number;
  /** Human-readable label for the debug overlay (e.g. "man: WR1", "fill B-gap"). */
  decision: string;
  zoneCenter: Vec2 | null;
  blockTargetId: AthleteId | null;
  recognizedRun: boolean;
  recognizedPass: boolean;
  scratch: Record<string, number>;
}

export interface Athlete {
  id: AthleteId;
  playerId: PlayerId;
  teamSide: TeamSide;
  side: Side;
  position: Position;
  role: string;
  number: number;
  name: string;
  pos: Vec2;
  vel: Vec2;
  /** Radians, absolute field frame. */
  facing: number;
  /** Collision radius in yards. */
  radius: number;
  massLb: number;
  heightIn: number;
  /** EFFECTIVE attributes: recomputed every live tick by physics/attributes.ts from baseAttrs + fatigue +
   *  weather + injury. movement, systems/* and ai/* read `attrs` only and never re-apply fatigue/weather. */
  attrs: AttributeSet;
  /** Never changes during a play. */
  baseAttrs: AttributeSet;
  fatigue: number;
  state: AthleteState;
  stateTimer: number;
  hasBall: boolean;
  controlled: boolean;
  assignment: OffAssignment | DefAssignment;
  ai: AthleteAiMemory;
  engagedWith: AthleteId | null;
  /** 0..1 burst meter (sprint). */
  burst: number;
  specialMoveCooldown: number;
  brokenTacklesThisPlay: number;
  eligible: boolean;
  /** False once tackled/down — no longer participates. */
  active: boolean;
  /** Seconds since this athlete was last hit (for gang tackles). */
  contactTimer: number;
}

export type BallPhase = 'presnap' | 'snap' | 'held' | 'inAir' | 'loose' | 'dead';
export type BallKind = 'none' | 'snap' | 'handoff' | 'pitch' | 'pass' | 'lateral' | 'kickoff' | 'punt' | 'fieldGoal' | 'fumble' | 'tip';

export interface BallState {
  pos: Vec2;
  /** Height in yards above the ground. */
  z: number;
  vel: Vec2;
  vz: number;
  phase: BallPhase;
  kind: BallKind;
  carrierId: AthleteId | null;
  throwerId: AthleteId | null;
  targetId: AthleteId | null;
  targetPos: Vec2 | null;
  throwType: ThrowType | null;
  launchTick: number;
  /** Predicted landing tick, for receivers/defenders to time their break on the ball. */
  landingTick: number;
  lastTouchedId: AthleteId | null;
  isTipped: boolean;
  /** True once a ball in flight (pass/kick) has crossed losY. Used for intentional grounding and illegal
   *  touching. NOT the illegal-forward-pass test (that is PassState.releasePos vs losY). */
  crossedLos: boolean;
}

export interface PassState {
  throwerId: AthleteId;
  /** null for throw-aways. */
  targetId: AthleteId | null;
  throwType: ThrowType;
  /** 0..1 overall difficulty at release. */
  difficulty: number;
  airYards: number;
  releaseTick: number;
  /** Passer position at release (illegal forward pass / grounding rules). */
  releasePos: Vec2;
  passerOutsideTackleBox: boolean;
  underPressure: boolean;
  separationAtThrow: number;
}

export interface PlayContext {
  playIndex: number;
  down: number;
  distance: number;
  ballOn: number;
  /** Absolute x of the snap spot; createPlay places the ball at (ballX, fieldY(ballOn, direction)). */
  ballX: number;
  direction: Direction;
  /** The side that snaps the ball. On kick plays (special !== 'none') this is the KICKING team; the receiving
   *  team's athletes have side 'defense'. ballOn/endBallOn/yards stay in this side's perspective. */
  offense: TeamSide;
  offensivePlay: OffensivePlay;
  defensivePlay: DefensivePlay;
  /** Players on the field for each side, keyed by formation role. */
  offenseLineup: Record<string, Player>;
  defenseLineup: Record<string, Player>;
  coaches: Partial<Record<TeamSide, Coach>>;
  weather: WeatherState;
  /** The game's selected difficulty. AI and systems read it through difficultyFor (game/difficulty-sides.ts). */
  difficulty: DifficultyProfile;
  /** Additive: per-team decision profiles in a human-vs-CPU game (the CPU team: the selected profile with its
   *  performance edge; the human's team: neutral 'pro' decisions + the selected user assists). Absent = AI vs AI:
   *  both sides use `difficulty` and nobody gets an edge. */
  sideDifficulty?: Partial<Record<TeamSide, DifficultyProfile>>;
  ruleset: Ruleset;
  /** Authoritative: who decides for each side. */
  controllers: Record<TeamSide, ControllerKind>;
  /** LOCAL viewer's side/mode (camera, HUD); must agree with `controllers`. */
  userSide: TeamSide | null;
  userControl: UserControlMode;
  /** Formation role the user controls at createPlay; null = engine default (offense: QB then carrier; defense: FS/SS). */
  controlRole: string | null;
  quarter: number;
  clockRemaining: number;
  /** Offense score minus defense score. */
  scoreDiff: number;
  special: 'none' | 'kickoff' | 'onside' | 'punt' | 'fieldGoal' | 'extraPoint' | 'twoPoint';
  /** Home-field/crowd factor 0..1 affecting away false starts etc. */
  crowdFactor: number;
  /** Team abbreviations for broadcast-style yard lines ("at the ATL 32"); OWN/OPP wording when absent. */
  teamAbbrs?: Record<TeamSide, string>;
  /** Forked per play by the controller: rng.fork(`play:${playIndex}`). Consumed directly by systems/AI. */
  rng: Rng;
  /** Read-only fatigue per player entering the play. Results flow back via PlayOutcome.fatigueAfter. */
  fatigue: Record<PlayerId, number>;
  /** True (the default when absent) when the game clock was running before this snap, so the executor charges
   *  the pre-snap seconds to PlayOutcome.presnapElapsed; false after a stoppage (0 is reported). Additive. */
  clockRunning?: boolean;
  /** True when the offense called a no-huddle / hurry-up (the pre-snap charge shrinks to the hurry-up runoff
   *  and the AI offense may use a quick cadence). Additive; absent = normal huddle. */
  hurryUp?: boolean;
  /** QB-receiver chemistry 0..1 (0.5 neutral) of the offense's passer with each offensive player on the field, keyed
   *  by the receiver's player id (game/chemistry.ts). Absent = neutral for everyone. Additive. */
  passChemistry?: Record<PlayerId, number>;
}

export type PlayResultType =
  | 'run' | 'pass' | 'incomplete' | 'sack' | 'interception' | 'fumble' | 'touchdown' | 'safety'
  | 'kickoff' | 'onside' | 'punt' | 'fieldGoal' | 'extraPoint' | 'twoPoint' | 'kneel' | 'spike' | 'penalty' | 'scramble';

/**
 * Result of one play. Produced by BOTH executors (game/outcome.ts for the PlayEngine, simulation/fast-sim.ts).
 *
 * FACTS (set by the executor): result, yards, endBallOn, endBallX, turnover, turnoverType, touchdown, safety,
 * outOfBounds, incomplete, firstDown, timeElapsed, presnapElapsed, penalties, kickMade, kickDistance,
 * returnYards, ids, events, stats, playByPlay, airYards, yac, yardsAfterContact, separationAtThrow,
 * underPressure, bigPlay, replayId, injuries, fatigueAfter, review, epa, success.
 * DERIVED (executors leave at the default; GameController.applyOutcome overwrites via game/rules/*):
 * clockStops (rules/clock.ts), possessionAfter (rules/possession.ts), points + scoringSide (rules/scoring.ts).
 *
 * PENALTIES: all FACT fields describe the UN-PENALIZED live result; producers never bake penalty yardage in.
 * `penalties` carry accepted=false; enforcement (accept/decline, half-distance, replay down, nullified stats)
 * is done exclusively by game/rules/penalties.ts. Pre-snap dead-ball fouls: result='penalty', yards=0.
 *
 * `result` is a classification for stat bucketing/PBP, NOT the terminal result. Precedence: 'penalty' (no-play)
 * > 'kneel'|'spike' > 'sack' > 'interception' > 'incomplete' > 'pass' (any completed forward pass, even if it
 * ends in a fumble/TD) > 'scramble' (QB run on a called pass) > 'run' > special kinds from ctx.special.
 * 'touchdown' | 'safety' | 'fumble' are RESERVED — producers must not emit them; read the booleans instead.
 * `yards` = offensive yards from the LOS for the ORIGINAL offense (negative for losses; 0 on turnovers before
 * the return; return yardage lives in returnYards). `endBallOn` is ALWAYS in ctx.offense's perspective even
 * when possession changes (controller converts with 100 - endBallOn). Never infer scoring from its sign.
 */
export interface PlayOutcome {
  result: PlayResultType;
  yards: number;
  endBallOn: number;
  /** Raw absolute x where the ball became dead (before hash spotting). */
  endBallX: number;
  turnover: boolean;
  turnoverType: 'interception' | 'fumble' | 'downs' | 'onside' | null;
  touchdown: boolean;
  safety: boolean;
  scoringSide: TeamSide | null;
  points: number;
  outOfBounds: boolean;
  incomplete: boolean;
  /** True iff the offense reached the line to gain this play (penalty automatic first downs are applied by rules). */
  firstDown: boolean;
  clockStops: boolean;
  /** Seconds elapsed during the live portion of the play. */
  timeElapsed: number;
  /** Seconds the GAME clock ran between the previous whistle and this snap (0 when stopped). */
  presnapElapsed: number;
  penalties: PenaltyInfo[];
  kickMade: boolean | null;
  kickDistance: number | null;
  returnYards: number;
  possessionAfter: TeamSide;
  ballCarrierId: PlayerId | null;
  passerId: PlayerId | null;
  receiverId: PlayerId | null;
  tacklerIds: PlayerId[];
  events: PlayEvent[];
  stats: PlayStatDelta[];
  playByPlay: string[];
  airYards: number;
  yac: number;
  yardsAfterContact: number;
  separationAtThrow: number | null;
  underPressure: boolean;
  bigPlay: boolean;
  replayId: string | null;
  injuries: { playerId: PlayerId; severity: InjurySeverity }[];
  /** Fatigue (0..1) after the play for every player who was on the field. Absent = not on the field. */
  fatigueAfter: Record<PlayerId, number>;
  /** Non-null when the play contained a close ruling. `ifOverturned` is the complete alternate outcome
   *  (its own `review` is null). The AI coach may only read `call.confidence`. */
  review: { call: ReviewableCall; ifOverturned: PlayOutcome } | null;
  /** Computed via statistics/epa.ts from ctx.down/distance/ballOn vs endBallOn/turnover/points. */
  epa: number;
  success: boolean;
}

export interface KickMeterState {
  phase: 'idle' | 'power' | 'accuracy' | 'done';
  cursor: number;
  power: number | null;
  accuracy: number | null;
}

export interface PlayState {
  tick: number;
  time: number;
  phase: 'presnap' | 'live' | 'dead';
  ctx: PlayContext;
  athletes: Athlete[];
  ball: BallState;
  events: PlayEvent[];
  outcome: PlayOutcome | null;
  /** Absolute y of the line of scrimmage and first-down marker. */
  losY: number;
  firstDownY: number;
  /** Absolute x of the ball at the snap; tackle box is snapX +/- 4 yd (grounding). */
  snapX: number;
  snapTick: number;
  pass: PassState | null;
  /** Athlete under user control for the local viewer (mirrors controlledIds[ctx.userSide]). */
  controlledId: AthleteId | null;
  controlledIds: Partial<Record<TeamSide, AthleteId>>;
  /** Intent chosen for each athlete this tick (debug overlay, replay, multiplayer sync). */
  intents: Record<AthleteId, AthleteIntent>;
  frames: ReplayFrame[];
  recordFrames: boolean;
  /** Pre-snap: seconds left on the play clock; live: seconds since snap. */
  playClock: number;
  deadReason: DeadReason | null;
  /** Absolute field pos where the ball is spotted; set by whoever sets deadReason. */
  deadSpot: Vec2 | null;
  /** Furthest ball y (along ctx.direction) reached by the current carrier while in bounds; null on change of possession/loose ball. */
  forwardProgressY: number | null;
  /** Position of first contact with the eventual ball carrier (yards-after-contact). */
  firstContactY: number | null;
  /** Tick the game clock started running during this play (snap on scrimmage plays, first touch on kickoffs);
   *  null/undefined while it has not (and always on PAT / two-point tries). The HUD shows the clock ticking from it. */
  clockStartTick?: number | null;
  /** Engine-owned kick meter; non-null only on kick plays with a human kicker. Drawn by the HUD. */
  kickMeter: KickMeterState | null;
  debug: Record<string, string | number>;
}

export interface ReplayFrame {
  tick: number;
  athletes: { id: AthleteId; x: number; y: number; facing: number; state: AthleteState; hasBall: boolean }[];
  ball: { x: number; y: number; z: number; phase: BallPhase };
}

/** Finished-play recording keyed by PlayOutcome.replayId. Owned by the controller's ReplayStore, never saved. FastSim never produces one. */
export interface ReplayRecording {
  id: string;
  playIndex: number;
  tickRate: number;
  snapTick: number;
  direction: Direction;
  losY: number;
  firstDownY: number;
  athletes: { id: AthleteId; playerId: PlayerId; teamSide: TeamSide; position: Position; number: number; name: string }[];
  frames: ReplayFrame[];
  events: PlayEvent[];
}

export type ReplayRetention = 'off' | 'lastPlay' | 'drive' | 'game';

export interface ReplayStore {
  readonly retention: ReplayRetention;
  push(rec: ReplayRecording): void;
  get(id: string): ReplayRecording | null;
  last(): ReplayRecording | null;
  clear(): void;
}

/**
 * User intent for the current tick for ONE side; produced only by src/ui/game/play-input.ts in the browser
 * (or scripted in tests), consumed by game/user-control.ts. Booleans are edges (true for one tick) unless noted.
 */
export interface UserPlayInput {
  /** ABSOLUTE field-frame direction, same frame as AthleteIntent.move; the UI has already applied camera
   *  orientation and ctx.direction. user-control.ts passes it through unchanged. During a kick meter,
   *  move.x is the aim offset (-1..1). */
  move: Vec2;
  /** Held. */
  sprint: boolean;
  /** Held: keep facing while moving (user-control picks 'backpedal' vs 'strafe' from move vs facing). */
  strafe: boolean;
  /** 0-based index into receiverSlots(play, formation) (throw1 -> 0 = primary). Set on the tick the throw
   *  button is RELEASED; the input layer derives throwType from hold length + modifier (null = engine default). */
  throwTo: number | null;
  throwType: ThrowType | null;
  juke: boolean;
  spin: boolean;
  stiffArm: boolean;
  hurdle: boolean;
  dive: boolean;
  slide: boolean;
  /** Equivalent to throwType 'throwAway' with throwTo null. */
  throwAway: boolean;
  snap: boolean;
  audible: keyof AudibleSet | null;
  defAudible: keyof DefensiveAudibleSet | null;
  /** Defense: switch to the nearest active defender to the ball / projected landing point, or to switchToId. */
  switchPlayer: boolean;
  switchToId: AthleteId | null;
  hitStick: boolean;
  strip: boolean;
  tackle: boolean;
  /** Defense/receiver: play the ball — mapped to IntentAction 'swat' or 'jump' by ball height/arrival. */
  jumpSwat: boolean;
  /** Kick meter press (edge). The engine advances PlayState.kickMeter. */
  kickPress: boolean;
  fairCatch: boolean;
  pitch: boolean;
}

/** Per-tick human input keyed by the side that produced it. Absent side = no human input that tick. */
export type UserInputs = Partial<Record<TeamSide, UserPlayInput>>;
