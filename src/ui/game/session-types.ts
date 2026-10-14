/**
 * Contracts for the live game session: the seams the integrator wires (engine, fast sim, playcaller, coach
 * hooks, replay store, audio) and the stage model the screens render. Everything here is a type or a plain
 * data shape; `session.ts` implements it and `session-defaults.ts` supplies the real dependencies.
 */
import type { PlayerId } from '@/core/ids';
import type { Rng } from '@/core/rng';
import type { CameraContext, Settings } from '@/core/settings';
import type { AudioManager } from '@/audio/index';
import type { CoachHooks, GameEvent } from '@/game/game-controller';
import type { DevHooks, FastPlayExecutor, LivePlay, LivePlayFactory } from '@/game/engine-api';
import type { PenaltyInfo, ReviewableCall } from '@/game/play-events';
import type { PlayContext, PlayOutcome, ReplayRecording, ReplayStore, UserInputs } from '@/game/play-types';
import type { GameSetup, GameState, PlayLogEntry, TeamSide } from '@/game/types';
import type { PlaybookRegistry } from '@/playbook/loader';
import type { PlaySituation } from '@/playbook/playbooks';
import type { DefAssignment, DefensivePlay, OffensiveFormation, OffensivePlay, RouteDef } from '@/playbook/types';
import type { Coach } from '@/teams/types';
import type { PostGameData } from './box-score';
import type { SnapshotBuffer } from './interp';

/* ------------------------------------ Playcalling ------------------------------------ */

export type SpecialOptionId =
  | 'punt' | 'fieldGoal' | 'go' | 'kneel' | 'spike' | 'fakePunt' | 'fakeFieldGoal'
  | 'kickoff' | 'squib' | 'onside' | 'extraPoint' | 'twoPoint';

/** A shortcut the play-call screen offers besides the regular play list (4th down, kickoffs, PATs). */
export interface SpecialOption {
  id: SpecialOptionId;
  label: string;
  /** Play to call; null for 'go' / 'twoPoint' which open the regular list instead. */
  playId: string | null;
  detail: string;
}

/** Situation handed to the playcaller and the play-call screen. */
export interface CallSituation extends PlaySituation {
  quarter: number;
  /** 'kickoff' during a kickoff / free kick, 'pat' after a touchdown, else 'scrimmage'. */
  kind: 'scrimmage' | 'kickoff' | 'pat';
  /** Seconds remaining in the game (clock counts the current quarter). */
  gameClock: number;
}

/**
 * Chooses plays for AI sides and suggests plays for humans. Built on playbook/playbooks.ts situational
 * weights; difficulty and coach schemes shape the choice.
 */
export interface Playcaller {
  callOffense(state: GameState, plays: readonly OffensivePlay[], rng: Rng, coach: Coach | null): OffensivePlay;
  /** `offensivePlay`, when known, lets the defense answer kicks with the matching return / block unit. */
  callDefense(state: GameState, plays: readonly DefensivePlay[], rng: Rng, coach: Coach | null, offensivePlay: OffensivePlay | null): DefensivePlay;
  suggestOffense(state: GameState, plays: readonly OffensivePlay[], rng: Rng): OffensivePlay | null;
  suggestDefense(state: GameState, plays: readonly DefensivePlay[], rng: Rng): DefensivePlay | null;
  specialOptions(state: GameState, plays: readonly OffensivePlay[]): SpecialOption[];
}

/* ------------------------------------- Watch mode ------------------------------------- */

export interface WatchPrompt {
  side: TeamSide;
  /** Headline, e.g. "3RD & 7". */
  title: string;
  /** Question, e.g. "Jump in?". */
  text: string;
  /** Why the policy raised the prompt (for tests and the overlay). */
  reason: 'thirdDown' | 'fourthDown' | 'redZone' | 'twoMinute' | 'goalLine';
}

/** Decides when a spectating / defense-watching user is asked to take over. */
export interface WatchPolicy {
  shouldPrompt(state: GameState, side: TeamSide): WatchPrompt | null;
}

/* -------------------------------------- Stages --------------------------------------- */

/** What the human is being asked to call. */
export interface PlaycallRequest {
  side: TeamSide;
  unit: 'offense' | 'defense';
  offense: TeamSide;
  situation: CallSituation;
  offensePlays: OffensivePlay[];
  defensePlays: DefensivePlay[];
  special: SpecialOption[];
  /** Playcaller suggestion: a play id, a SPECIAL tab item ('special:punt' / 'special:fieldGoal' on 4th down) or null. */
  suggestion: string | null;
  /** Defensive roles the user may take control of (first = default). Empty for the offense. */
  controlRoles: string[];
  /** "2ND & 7 · OPP 34" style summary. */
  summary: string;
  /** True when the game clock is running (spike / hurry-up relevance). */
  clockRunning: boolean;
  /** Settings.playbookComplexity the lists were trimmed for (absent = 'standard'). */
  complexity?: 'simple' | 'standard' | 'advanced';
}

export interface PlayCall {
  offensivePlayId?: string;
  defensivePlayId?: string;
  /** Formation role the human controls (defense: FS / SS / MLB; offense: null = QB). */
  controlRole?: string | null;
  hurryUp?: boolean;
  /** Defense: per-role assignment overrides for the called play (advanced play calling). */
  assignmentOverrides?: Record<string, DefAssignment>;
}

/** Facts about the live play the screens need every frame. */
export interface LivePlayMeta {
  ctx: PlayContext;
  /** Receiver roles for throw1..5 (offense human only). */
  receiverSlots: string[];
  /** Role -> materialized route for the offense (play art + back-shoulder rule). */
  routes: Record<string, RouteDef>;
  formation: OffensiveFormation | null;
  /** True when no human controls an athlete (AI vs AI shown live). */
  spectating: boolean;
}

export interface ChallengePrompt {
  side: TeamSide;
  call: ReviewableCall;
  remainingSec: number;
}

export interface PostPlaySummary {
  entry: PlayLogEntry;
  outcome: PlayOutcome;
  /** "RUN +5", "INCOMPLETE", "TOUCHDOWN" ... */
  resultText: string;
  /** Play-by-play lines (executor lines, or a generated one). */
  pbp: string[];
  replayId: string | null;
  bigPlay: boolean;
  /** True when this play was fast-simulated (defense watch / skip). */
  simulated: boolean;
}

export interface PenaltyPrompt {
  side: TeamSide;
  penalty: PenaltyInfo;
  foulingSide: TeamSide;
  title: string;
  acceptText: string;
  declineText: string;
}

export type IntermissionReason = 'halftime' | 'twoMinute' | 'quarterEnd' | 'overtime';

export type SessionStage =
  | { kind: 'pregame' }
  | { kind: 'coinToss'; side: TeamSide }
  | { kind: 'playcall'; request: PlaycallRequest }
  | { kind: 'live'; play: LivePlay; meta: LivePlayMeta }
  | { kind: 'postPlay'; summary: PostPlaySummary; remaining: number; challenge: ChallengePrompt | null }
  | { kind: 'penalty'; prompt: PenaltyPrompt }
  | { kind: 'freeKick'; side: TeamSide }
  | { kind: 'watchPrompt'; prompt: WatchPrompt }
  | { kind: 'intermission'; reason: IntermissionReason; remaining: number }
  | { kind: 'final'; result: PostGameData };

/** Notices the session raises for the HUD / audio / commentary. */
export type SessionEvent =
  | { type: 'stage'; stage: SessionStage }
  | { type: 'game'; event: GameEvent }
  | { type: 'banner'; text: string; sub: string | null; tone: 'good' | 'bad' | 'neutral' | 'flag' }
  | { type: 'pbp'; line: string };

/* -------------------------------------- Session -------------------------------------- */

export interface SessionDeps {
  engine: LivePlayFactory;
  fastSim: FastPlayExecutor;
  playcaller: Playcaller;
  /** Coach hooks per side (penalties, challenges, timeouts, coin toss); defaults derive from the playcaller. */
  coachFor?: (side: TeamSide) => Partial<CoachHooks>;
  registry: PlaybookRegistry;
  replayStore: ReplayStore;
  audio?: AudioManager;
  settings: Settings;
  watchPolicy?: WatchPolicy;
  /** Seconds the post-play summary is held before the next call (default 2). */
  holdSeconds?: number;
  /** A saved mid-game state to resume from (franchise game interrupted by a reload) instead of a fresh kickoff.
   *  Any play that was in progress is rolled back; the setup's controllers apply. */
  initialState?: GameState;
  onEvent?: (e: SessionEvent) => void;
}

export interface GameSession {
  readonly setup: GameSetup;
  /** Playbook registry (formations / routes) for play art and receiver slots. */
  readonly registry: PlaybookRegistry;
  readonly state: Readonly<GameState>;
  readonly stage: SessionStage;
  readonly userSide: TeamSide | null;
  /** True while the user is a spectator (controller kind 'watch'). */
  readonly watching: boolean;
  /** Engine ticks per session tick while no human controls the play (watch / simulated defense). */
  readonly speed: number;
  readonly live: LivePlay | null;
  readonly liveMeta: LivePlayMeta | null;
  /** The play to draw: the live one, or the last finished one until the next snap. */
  readonly displayPlay: LivePlay | null;
  readonly displayMeta: LivePlayMeta | null;
  readonly lastSummary: PostPlaySummary | null;
  start(): void;
  /** Advances timers (post-play hold, challenge countdown, intermissions). */
  update(dt: number): void;
  /** Advances the live play by one session tick (several engine ticks when nobody is controlled). */
  tick(inputs?: UserInputs): void;
  /** Ends a hold / intermission early. */
  continue(): void;
  callPlay(call: PlayCall): void;
  answerCoinToss(choice: 'kick' | 'receive' | 'defer'): void;
  answerPenalty(accept: boolean): void;
  answerFreeKick(choice: 'kick' | 'punt'): void;
  answerWatchPrompt(jumpIn: boolean): void;
  /** Throws the challenge flag while a window is open; returns false when no window / no challenges left. */
  challenge(): boolean;
  callTimeout(): boolean;
  /** Fast-sims the current live play (or flags the next play to be simulated). */
  skipPlay(): void;
  setSpeed(speed: number): void;
  /** Spectator -> player (dispatches the controller 'jumpIn' watch command). */
  jumpIn(): void;
  resumeWatching(): void;
  cameraContext(): CameraContext;
  lastReplay(): ReplayRecording | null;
  /** Interpolated scene positions from the previous tick, for rendering. */
  readonly snapshot: SnapshotBuffer;
  subscribe(cb: (e: SessionEvent) => void): () => void;
  /** Developer hooks (src/tools dev mode) handed to every live engine created from now on; null removes them.
   *  Optional so fake sessions keep compiling. Additive. */
  setDevHooks?(hooks: DevHooks | null): void;
  /** Sends `playerId` in at formation `role` for the human user side from the next snap (GameCommand
   *  'substitute'), or with null hands the role back to AUTO; false when refused (not the user's roster,
   *  injured, no human side). Optional; additive. */
  substitute?(role: string, playerId: PlayerId | null): boolean;
  /** The user side's manual substitutions so far (role -> player). Optional; additive. */
  userSubstitutions?(): Readonly<Record<string, PlayerId>>;
}
