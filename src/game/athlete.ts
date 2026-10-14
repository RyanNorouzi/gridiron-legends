import type { PlayerId } from '@/core/ids';
import { clone, vec2, type Vec2 } from '@/core/vec2';
import type { Player } from '@/players/types';
import type { DefAssignment, OffAssignment } from '@/playbook/types';
import type { Athlete, AthleteAiMemory, PlayContext, PlayState } from './play-types';
import type { AthleteId } from './play-events';
import type { BallState } from './play-types';
import type { Side, TeamSide } from './types';

/** Collision radius for every athlete, in yards. */
export const ATHLETE_RADIUS = 0.5;

export const emptyAiMemory = (): AthleteAiMemory => ({
  targetPos: null,
  targetAthleteId: null,
  reactionTimer: 0,
  routeIndex: 0,
  routeTimer: 0,
  readIndex: 0,
  lastDecisionTick: -1,
  decision: '',
  zoneCenter: null,
  blockTargetId: null,
  recognizedRun: false,
  recognizedPass: false,
  scratch: {},
});

export const athleteId = (side: Side, role: string): AthleteId => `${side === 'offense' ? 'off' : 'def'}:${role}`;

export interface CreateAthleteOptions {
  player: Player;
  side: Side;
  teamSide: TeamSide;
  role: string;
  pos: Vec2;
  facing: number;
  assignment: OffAssignment | DefAssignment;
  eligible?: boolean;
  fatigue?: number;
  controlled?: boolean;
}

/** Builds a fresh Athlete for one play from a roster Player. `attrs` starts equal to `baseAttrs`. */
export const createAthlete = (o: CreateAthleteOptions): Athlete => ({
  id: athleteId(o.side, o.role),
  playerId: o.player.id,
  teamSide: o.teamSide,
  side: o.side,
  position: o.player.position,
  role: o.role,
  number: o.player.jerseyNumber,
  name: `${o.player.firstName[0]}. ${o.player.lastName}`,
  pos: clone(o.pos),
  vel: vec2(0, 0),
  facing: o.facing,
  radius: ATHLETE_RADIUS,
  massLb: o.player.weightLb,
  heightIn: o.player.heightIn,
  attrs: { ...o.player.attrs },
  baseAttrs: { ...o.player.attrs },
  fatigue: o.fatigue ?? 0,
  state: 'presnap',
  stateTimer: 0,
  hasBall: false,
  controlled: o.controlled ?? false,
  assignment: o.assignment,
  ai: emptyAiMemory(),
  engagedWith: null,
  burst: 1,
  specialMoveCooldown: 0,
  brokenTacklesThisPlay: 0,
  eligible: o.eligible ?? false,
  active: true,
  contactTimer: 0,
});

export interface CreatePlayStateOptions {
  losY: number;
  firstDownY: number;
  recordFrames?: boolean;
}

/** Assembles a PlayState in the 'presnap' phase. */
export const createPlayState = (ctx: PlayContext, athletes: Athlete[], ball: BallState, o: CreatePlayStateOptions): PlayState => ({
  tick: 0,
  time: 0,
  phase: 'presnap',
  ctx,
  athletes,
  ball,
  events: [],
  outcome: null,
  losY: o.losY,
  firstDownY: o.firstDownY,
  snapX: ball.pos.x,
  snapTick: -1,
  pass: null,
  controlledId: null,
  controlledIds: {},
  intents: {},
  frames: [],
  recordFrames: o.recordFrames ?? false,
  playClock: ctx.ruleset.playClockSec,
  deadReason: null,
  deadSpot: null,
  forwardProgressY: null,
  firstContactY: null,
  kickMeter: null,
  debug: {},
});

export const findAthlete = (state: Pick<PlayState, 'athletes'>, id: AthleteId | null): Athlete | null =>
  id === null ? null : (state.athletes.find((a) => a.id === id) ?? null);

export const athletesOn = (state: Pick<PlayState, 'athletes'>, side: Side): Athlete[] => state.athletes.filter((a) => a.side === side);

export const ballCarrier = (state: Pick<PlayState, 'athletes' | 'ball'>): Athlete | null => findAthlete(state, state.ball.carrierId);

export const playerIdsOnField = (state: Pick<PlayState, 'athletes'>): PlayerId[] => state.athletes.map((a) => a.playerId);
