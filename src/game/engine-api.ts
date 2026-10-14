import { vec2, type Vec2 } from '@/core/vec2';
import type { Athlete, PlayContext, PlayOutcome, PlayState, ReplayStore, UserInputs } from './play-types';
import type { AthleteId, ThrowType } from './play-events';
import type { DefensivePlay, OffensivePlay } from '@/playbook/types';
import type { PlayRegistries } from './play-context';
import type { TeamSide } from './types';

/**
 * INTENT LAYER — the seam between "deciding" and "doing".
 *
 * Every tick, each athlete gets exactly one AthleteIntent. It comes from
 *   - src/game/user-control.ts for the user-controlled athlete (from UserPlayInput), or
 *   - src/ai/index.ts (decideIntent) for everyone else.
 * The PlayEngine then executes intents: movement (physics), actions (systems).
 * AI never mutates positions/velocities/ball directly; it only returns intents.
 * A remote player's input becomes another intent source, which is what makes the
 * engine multiplayer-ready without touching the simulation.
 */
export type IntentAction =
  | 'throw' | 'throwAway' | 'handoff' | 'pitch' | 'lateral'
  | 'juke' | 'spin' | 'stiffArm' | 'hurdle' | 'dive' | 'slide' | 'truck'
  | 'tackle' | 'hitStick' | 'strip' | 'swat' | 'jump'
  | 'kick' | 'fairCatch' | 'snap' | 'audible' | 'block' | 'shed'
  /** QB kneel-down / clock-stopping spike (dead-ball actions; DeadReason 'kneel' | 'spike'). */
  | 'kneel' | 'spike';

export type Locomotion = 'run' | 'backpedal' | 'strafe';

export interface AthleteIntent {
  /** Desired movement direction in the absolute field frame. Zero = stop. Magnitude <= 1 scales effort. */
  move: Vec2;
  sprint: boolean;
  locomotion: Locomotion;
  /** Desired facing (radians) for backpedal/strafe; null = face the movement direction. */
  face: number | null;
  action: IntentAction | null;
  /** Athlete id the action targets (throw/handoff/pitch/block/tackle). */
  targetId: string | null;
  throwType: ThrowType | null;
  /** Absolute lead point for a throw. null = engine computes a lead automatically. With action 'throw' and no
   *  targetId it is a throw to that spot (the passing system picks the receiver it is for). */
  throwTarget: Vec2 | null;
  /** Kick meter results 0..1 (only with action 'kick'). */
  kickPower: number | null;
  kickAccuracy: number | null;
  /** Absolute aim point for an AI kick (action 'kick'): directional punts, corner kickoffs, the uprights.
   *  Absent/null = straight down the kicking lane. Human kickers aim with UserPlayInput.move.x instead. */
  kickTarget?: Vec2 | null;
  /** Audible key when action === 'audible'. */
  audible: string | null;
  /** Short human-readable label shown by the dev overlay, e.g. "man WR1", "fill A-gap", "read #2". */
  debug: string;
}

/**
 * Additive extension of UserPlayInput (play-types.ts) for the pull-back pass: an absolute field point to throw to.
 * Set on the tick the user releases the aim (throwType carries the trajectory); user-control turns it into a 'throw'
 * intent with that throwTarget and no targetId, which the passing system throws to the spot. Absent/null = none.
 */
export interface UserThrowSpot {
  throwSpot?: Vec2 | null;
}

export const idleIntent = (debug = 'idle'): AthleteIntent => ({
  move: vec2(0, 0),
  sprint: false,
  locomotion: 'run',
  face: null,
  action: null,
  targetId: null,
  throwType: null,
  throwTarget: null,
  kickPower: null,
  kickAccuracy: null,
  audible: null,
  debug,
});

export const moveIntent = (dir: Vec2, sprint = false, debug = 'move'): AthleteIntent => ({
  ...idleIntent(debug),
  move: dir,
  sprint,
});

/** Signature every AI decider and the user-control adapter must satisfy. */
export type IntentDecider = (athlete: Athlete, state: PlayState, dt: number) => AthleteIntent;

/* ------------------------------ Executor seams ------------------------------ */

export interface LivePlayOptions {
  recordFrames?: boolean;
  replayStore?: ReplayStore | null;
  /** Formation lookups (from the playbook loader). Missing entries fall back to role inference. */
  registries?: PlayRegistries;
  /** Override the AI decider (tests inject scripted intents). Defaults to ai/index decideIntent. */
  decider?: IntentDecider;
  /** Play registries used to resolve pre-snap audibles (resolveAudible needs the target plays). When absent
   *  every audible fails and the called play stands. Additive. */
  plays?: { offensePlays?: Record<string, OffensivePlay>; defensePlays?: Record<string, DefensivePlay> };
  /** Developer-mode cheats and commands (src/tools, dev mode only). Absent = the engine behaves exactly as without
   *  it. The object is read live every tick, so toggling a flag affects the play in progress. Additive. */
  dev?: DevHooks;
}

/* ------------------------------ Developer hooks ------------------------------ */

/**
 * Imperative developer commands, applied at the START of the next engine tick (before intents). Ball commands
 * (spawnBall / forceTouchdown / forceTurnover) wait in the queue until the ball is live; a teleport applies at once.
 */
export type DevCommand =
  /** Moves an athlete (and the ball when he holds it) to an absolute field point, clamped inside the field. */
  | { type: 'teleport'; athleteId: AthleteId; pos: Vec2 }
  /** Drops the ball loose (a fumble charged to whoever last had it) at `pos`. */
  | { type: 'spawnBall'; mode: 'loose'; pos: Vec2 }
  /** Puts the ball in `athleteId`'s hands through the matching live path (handoff, catch, interception, recovery). */
  | { type: 'spawnBall'; mode: 'toAthlete'; athleteId: AthleteId; pos?: Vec2 }
  /** The side's carrier (or its athlete nearest the ball, handed the ball) is placed in the end zone it attacks. */
  | { type: 'forceTouchdown'; side: TeamSide }
  /** The carrier fumbles and the nearest opponent recovers (a ball in the air is intercepted instead). */
  | { type: 'forceTurnover' };

/** Cheats the engine applies for one team (see src/tools/dev-state.ts). All flags default to off. */
export interface DevHooks {
  /** The favoured team cannot be tackled, fumble (incl. muffed pitches / kick catches) or be intercepted; its tackles
   *  and catch contests always win. */
  godMode?: boolean;
  /** The favoured team's fatigue stays 0 (in play and in PlayOutcome.fatigueAfter) and its burst never drains. */
  infiniteStamina?: boolean;
  /** Every athlete not under human control gets an idle intent once the ball is live. */
  freezeAi?: boolean;
  /** Team the cheats favour; absent/null = ctx.userSide, else the only human-controlled side. */
  side?: TeamSide | null;
  /** Command inbox shared with the UI: drained into the engine's queue at the start of every tick. */
  commands?: DevCommand[];
  /** PlayContext.playIndex the inbox commands were issued for; an engine running another play discards them, so a
   *  command issued as a play ends never leaks into the next one. Absent/null = accept. */
  commandPlayIndex?: number | null;
}

/** A play in progress, driven tick by tick. Implemented by src/game/play-engine.ts. */
export interface LivePlay {
  readonly state: PlayState;
  /** Advance one fixed tick. `inputs` carries human input per side (absent = none). */
  tick(inputs?: UserInputs): void;
  readonly isDead: boolean;
  /** Non-null once the play is dead and the outcome has been built. */
  readonly outcome: PlayOutcome | null;
  /** Run until dead (AI vs AI, tests, sim-to-end). Throws if maxTicks is exceeded. */
  run(inputs?: (state: PlayState) => UserInputs, maxTicks?: number): PlayOutcome;
}

export type LivePlayFactory = (ctx: PlayContext, opts?: LivePlayOptions) => LivePlay;

/** Statistical executor: one call, one outcome. Implemented by src/simulation/fast-sim.ts. */
export type FastPlayExecutor = (ctx: PlayContext) => PlayOutcome;
