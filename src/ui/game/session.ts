/**
 * Game session: the state machine that runs one game in the browser on top of GameController. It decides
 * whose turn it is (human play call, AI call, controller decision), executes plays through the injected
 * LivePlayFactory (tick by tick, driven by the Game screen) or FastPlayExecutor (skips, simulated defense,
 * spectator skips), holds the post-play summary with an inline challenge window, and raises SessionEvents
 * for banners, audio and commentary. Everything it needs comes through SessionDeps so tests use fakes.
 */
import type { PlayerId } from '@/core/ids';
import { createRng, type Rng } from '@/core/rng';
import type { CameraContext } from '@/core/settings';
import { GameController, type GameEvent } from '@/game/game-controller';
import type { DevHooks, LivePlay } from '@/game/engine-api';
import type { PlayOutcome, ReplayRecording, UserInputs } from '@/game/play-types';
import { otherSide, type GamePhase, type GameSetup, type GameState, type PlayLogEntry, type TeamSide } from '@/game/types';
import type { PlaybookRegistry } from '@/playbook/loader';
import { isSpecialPlay } from '@/playbook/special-teams';
import type { DefensivePlay, OffensivePlay } from '@/playbook/types';
import type { Coach } from '@/teams/types';
import { audioEventFor, bannerForGameEvent, bannerForSummary } from './banners';
import { buildPostGame } from './box-score';
import { SnapshotBuffer } from './interp';
import { coachHooksFor } from './playcaller';
import { audiblePlaysFor, buildPlaycallRequest, intermissionFor, intermissionKey, cameraContextFor, liveMetaFor, penaltyPromptFor, playFitsSituation, resolveControlRole, resumeState, summaryFor } from './session-flow';
import type { GameSession, LivePlayMeta, PlayCall, PostPlaySummary, SessionDeps, SessionEvent, SessionStage, WatchPolicy } from './session-types';
import { takeOverPlay } from './take-over';
import { createWatchPolicy } from './watch-policy';

const TIMEOUT_PHASES: readonly GamePhase[] = ['playcall', 'kickoff', 'pat', 'twoMinute', 'deadball', 'challenge', 'timeout', 'presnap'];
/** Seconds an intermission card stays up before continuing on its own. */
export const INTERMISSION_SECONDS = 2.5;
/** Seconds the card showing a challenge ruling stays up before the next play call. */
export const REVIEW_HOLD_SECONDS = 2.5;
/** Seconds the post-play card stays up while a challenge window is open. */
export const CHALLENGE_HOLD_SECONDS = 6;
export const MIN_SPEED = 1;
export const MAX_SPEED = 8;
/** Shortest hold (seconds) for a simulated play's card while a human plays (defense watch / skips). */
export const MIN_SIM_HOLD_SECONDS = 0.6;
/** Most ticks a skipped live play is run headlessly before falling back to the fast sim (40 s of play). */
const SKIP_TICK_CAP = 60 * 40;

type DefenseHandling = 'call' | 'watch' | 'auto';

class GameSessionImpl implements GameSession {
  readonly setup: GameSetup;
  readonly snapshot = new SnapshotBuffer();
  private readonly controller: GameController;
  private readonly deps: SessionDeps;
  private readonly policy: WatchPolicy;
  private readonly rng: Rng;
  private readonly listeners: ((e: SessionEvent) => void)[] = [];
  private stageValue: SessionStage = { kind: 'pregame' };
  private livePlay: LivePlay | null = null;
  private meta: LivePlayMeta | null = null;
  private shownPlay: LivePlay | null = null;
  private shownMeta: LivePlayMeta | null = null;
  private calls: Partial<Record<TeamSide, PlayCall>> = {};
  private simulateNext = false;
  private jumpedIn = false;
  private promptedAt = -1;
  private readonly announced = new Set<string>();
  private lastEntry: PlayLogEntry | null = null;
  private summaryValue: PostPlaySummary | null = null;
  private speedValue: number;
  private challengeDeclined = false;
  /** Whether the play whose outcome is being applied (possibly waiting on a penalty answer) was fast-simmed. */
  private pendingSimulated = false;
  private eventCursor = 0;
  /** Bundled plays plus both teams' playbooks, keyed by id: what pre-snap audibles may resolve to. */
  private readonly audiblePlays: ReturnType<typeof audiblePlaysFor>;
  private currentSpecial: 'none' | 'kickoff' | 'onside' | 'punt' | 'fieldGoal' | 'extraPoint' | 'twoPoint' = 'none';
  private devHooks: DevHooks | null = null;

  constructor(setup: GameSetup, deps: SessionDeps) {
    this.setup = setup;
    this.deps = deps;
    this.policy = deps.watchPolicy ?? createWatchPolicy();
    this.rng = createRng(setup.seed).fork('session');
    this.speedValue = Math.max(MIN_SPEED, Math.min(MAX_SPEED, Math.round(deps.settings.simSpeed) || 1));
    const registries = { offensiveFormations: deps.registry.offensiveFormations, defensiveFormations: deps.registry.defensiveFormations };
    const state = deps.initialState ? resumeState(deps.initialState, setup) : undefined;
    this.controller = new GameController(setup, { coach: coachHooksFor(deps.playcaller, setup, deps.coachFor), registries, ...(state ? { state } : {}) });
    this.controller.onEvent((e) => this.onGameEvent(e));
    this.audiblePlays = audiblePlaysFor(setup, deps.registry);
  }

  /* ------------------------------------ getters ------------------------------------ */

  get registry(): PlaybookRegistry { return this.deps.registry; }
  get state(): Readonly<GameState> { return this.controller.state; }
  get stage(): SessionStage { return this.stageValue; }
  get userSide(): TeamSide | null { return this.controller.state.userSide; }
  get watching(): boolean { const u = this.userSide; return u !== null && this.controller.state.controllers[u] === 'watch'; }
  get speed(): number { return this.speedValue; }
  get live(): LivePlay | null { return this.livePlay; }
  get liveMeta(): LivePlayMeta | null { return this.meta; }
  get displayPlay(): LivePlay | null { return this.livePlay ?? this.shownPlay; }
  get displayMeta(): LivePlayMeta | null { return this.meta ?? this.shownMeta; }
  get lastSummary(): PostPlaySummary | null { return this.summaryValue; }

  setDevHooks(hooks: DevHooks | null): void { this.devHooks = hooks; }

  subscribe(cb: (e: SessionEvent) => void): () => void {
    this.listeners.push(cb);
    return () => { const i = this.listeners.indexOf(cb); if (i >= 0) this.listeners.splice(i, 1); };
  }

  private emit(e: SessionEvent): void { this.deps.onEvent?.(e); for (const l of [...this.listeners]) l(e); }

  private setStage(stage: SessionStage): void { this.stageValue = stage; this.emit({ type: 'stage', stage }); }

  private isHuman(side: TeamSide): boolean { return this.controller.state.controllers[side] === 'human'; }
  private coachOf(side: TeamSide): Coach | null { return this.setup[side].headCoach; }

  /* ------------------------------------- flow -------------------------------------- */

  start(): void {
    // A resumed game is already past the kickoff: carry on from where it stopped.
    if (this.controller.state.phase === 'pregame') this.controller.start();
    else this.lastEntry = this.controller.state.playLog[this.controller.state.playLog.length - 1] ?? null;
    this.resolveFlow();
  }

  private onGameEvent(e: GameEvent): void {
    this.emit({ type: 'game', event: e });
    const audio = audioEventFor(e);
    if (audio) this.deps.audio?.onGameEvent(audio);
    const banner = bannerForGameEvent(e, this.setup);
    if (banner) this.emit({ type: 'banner', ...banner });
  }

  private defenseHandling(defense: TeamSide, s: Readonly<GameState>): DefenseHandling {
    if (!this.isHuman(defense)) return 'auto';
    if (s.kickoffPending || s.patPending) return 'auto';
    const mode = this.deps.settings.defenseMode;
    if (mode === 'watch' && !this.jumpedIn) return 'watch';
    return 'call';
  }

  /** Decides what happens next from the controller state; the heart of the session. */
  private resolveFlow(): void {
    const s = this.controller.state;
    if (s.phase === 'final') {
      this.setStage({ kind: 'final', result: buildPostGame(this.setup, s) });
      return;
    }
    const pd = s.pendingDecision;
    if (pd && pd.kind !== 'playCall') {
      if (!this.isHuman(pd.side)) return;
      switch (pd.kind) {
        case 'coinToss': this.setStage({ kind: 'coinToss', side: pd.side }); return;
        case 'freeKick': this.setStage({ kind: 'freeKick', side: pd.side }); return;
        case 'penaltyDecision': {
          const o = this.controller.pendingOutcome;
          if (!o) return;
          const index = o.penalties.findIndex((p) => !p.accepted);
          this.setStage({ kind: 'penalty', prompt: penaltyPromptFor(s, o, pd, Math.max(0, index)) });
          return;
        }
        case 'challengeWindow':
          if (!this.challengeDeclined) {
            if (this.stageValue.kind !== 'postPlay' && this.summaryValue) {
              this.setStage({ kind: 'postPlay', summary: this.summaryValue, remaining: CHALLENGE_HOLD_SECONDS, challenge: { side: pd.side, call: this.summaryValue.outcome.review?.call ?? { kind: 'spot', tick: 0, athleteId: null, confidence: 0.5 }, remainingSec: pd.deadlineSec ?? CHALLENGE_HOLD_SECONDS } });
            }
            return;
          }
          break;
      }
    }
    const intermission = intermissionFor(s, this.announced);
    if (intermission) {
      this.setStage({ kind: 'intermission', reason: intermission, remaining: INTERMISSION_SECONDS });
      return;
    }
    const offense = s.possession;
    const defense = otherSide(offense);
    if (this.isHuman(offense) && !this.calls[offense]?.offensivePlayId) {
      this.setStage({ kind: 'playcall', request: buildPlaycallRequest(s, this.setup, offense, this.deps.playcaller, this.deps.registry, this.rng.fork(`suggest:${s.playLog.length}`), this.deps.settings.playbookComplexity) });
      return;
    }
    const handling = this.defenseHandling(defense, s);
    if (handling === 'watch' && this.promptedAt !== s.playLog.length) {
      this.promptedAt = s.playLog.length;
      const prompt = this.policy.shouldPrompt(s, defense);
      if (prompt) { this.setStage({ kind: 'watchPrompt', prompt }); return; }
    }
    if (handling === 'call' && !this.calls[defense]?.defensivePlayId) {
      this.setStage({ kind: 'playcall', request: buildPlaycallRequest(s, this.setup, defense, this.deps.playcaller, this.deps.registry, this.rng.fork(`suggest:${s.playLog.length}`), this.deps.settings.playbookComplexity) });
      return;
    }
    const user = this.userSide;
    if (this.watching && user && this.promptedAt !== s.playLog.length && !s.kickoffPending && !s.patPending) {
      this.promptedAt = s.playLog.length;
      const prompt = this.policy.shouldPrompt(s, user);
      if (prompt) { this.setStage({ kind: 'watchPrompt', prompt }); return; }
    }
    this.beginPlay();
  }

  private beginPlay(): void {
    const s = this.controller.state;
    const offense = s.possession;
    const defense = otherSide(offense);
    const offPlays = this.setup[offense].offensePlays;
    const defPlays = this.setup[defense].defensePlays;
    const index = s.playLog.length;
    const offId = this.calls[offense]?.offensivePlayId;
    // A called play that does not fit the down (a scrimmage play on a kickoff) falls back to the coach's call.
    const offPlay: OffensivePlay = (offId ? offPlays.find((p) => p.id === offId && playFitsSituation(s, p)) : undefined)
      ?? this.deps.playcaller.callOffense(s, offPlays, this.rng.fork(`off:${index}`), this.coachOf(offense));
    const special = isSpecialPlay(offPlay);
    const defId = this.calls[defense]?.defensivePlayId;
    const kick = special !== 'none' && special !== 'twoPoint';
    const called = !kick && defId ? defPlays.find((p) => p.id === defId) : undefined;
    const defPlay: DefensivePlay = called ?? this.deps.playcaller.callDefense(s, defPlays, this.rng.fork(`def:${index}`), this.coachOf(defense), offPlay);
    const humanOff = this.isHuman(offense);
    const humanDef = this.isHuman(defense);
    const defLive = humanDef && (this.deps.settings.defenseMode === 'control' || this.jumpedIn);
    const liveControl = humanOff || defLive;
    const mode: 'live' | 'fast' = this.simulateNext ? 'fast' : liveControl || this.watching ? 'live' : 'fast';
    const controlRole = humanOff ? resolveControlRole('offense', this.calls[offense]?.controlRole, offPlay, this.deps.registry)
      : defLive ? resolveControlRole('defense', this.calls[defense]?.controlRole, defPlay, this.deps.registry) : null;
    const hurryUp = this.calls[offense]?.hurryUp ?? false;
    const overrides = called ? this.calls[defense]?.assignmentOverrides : undefined;
    if (overrides && Object.keys(overrides).length > 0) this.controller.dispatch({ type: 'callPlay', side: defense, defensivePlayId: defPlay.id, assignmentOverrides: overrides });
    const ctx = this.controller.beginPlay(offPlay.id, defPlay.id, { controlRole, hurryUp });
    this.currentSpecial = ctx.special;
    this.calls = {};
    this.simulateNext = false;
    this.deps.audio?.onGameEvent({ type: 'possession', offense: ctx.offense, play: ctx, stadium: this.setup.stadium });
    if (mode === 'fast') {
      // Nothing is left on the field: the scene redraws at the new spot (emptyScene) instead of the previous live play.
      this.clearShown();
      this.finishPlay(this.deps.fastSim(ctx), true);
      return;
    }
    const play = this.deps.engine(ctx, {
      recordFrames: this.deps.settings.replayRetention !== 'off',
      replayStore: this.deps.replayStore,
      registries: { offensiveFormations: this.deps.registry.offensiveFormations, defensiveFormations: this.deps.registry.defensiveFormations },
      // Without the play registries every pre-snap audible fails silently.
      plays: this.audiblePlays,
      ...(this.devHooks ? { dev: this.devHooks } : {}),
    });
    this.livePlay = play; this.meta = liveMetaFor(ctx, this.deps.registry, !liveControl);
    this.shownPlay = play; this.shownMeta = this.meta;
    this.eventCursor = 0; this.snapshot.reset(); this.snapshot.capture(play.state);
    this.setStage({ kind: 'live', play, meta: this.meta });
  }

  private clearShown(): void { this.shownPlay = null; this.shownMeta = null; this.snapshot.reset(); }

  /**
   * SKIP during a live play: finishes the play being watched headlessly (no audio for the skipped ticks), so the result
   * card, spot and clock match what was on the field and the last frame stays on screen. It was really played, so its
   * card is not marked simulated: the replay and highlight stay available. A play the user controls (dev
   * fast-sim cheat) would stall without input, so it is fast-simmed from the snap, as is one that never ends.
   */
  private finishSkipped(play: LivePlay, headless: boolean): void {
    for (let i = 0; headless && i < SKIP_TICK_CAP && !play.isDead; i++) play.tick();
    this.eventCursor = play.state.events.length;
    if (play.isDead && play.outcome) { this.snapshot.reset(); this.snapshot.capture(play.state); this.finishPlay(play.outcome, false); return; }
    this.clearShown();
    this.finishPlay(this.deps.fastSim(play.state.ctx), true);
  }

  private finishPlay(outcome: PlayOutcome, simulated: boolean): void {
    this.livePlay = null; this.meta = null;
    this.jumpedIn = false; this.challengeDeclined = false;
    this.pendingSimulated = simulated;
    this.controller.completePlay(outcome);
    this.afterApply(simulated);
  }

  /** After completePlay / a penalty answer / a challenge: show the summary or the next prompt. */
  private afterApply(simulated: boolean): void {
    const s = this.controller.state;
    const pd = s.pendingDecision;
    if (pd?.kind === 'penaltyDecision' && this.isHuman(pd.side)) { this.resolveFlow(); return; }
    const entry = s.playLog[s.playLog.length - 1] ?? null;
    if (entry && entry !== this.lastEntry) {
      this.lastEntry = entry;
      const summary = summaryFor(this.setup, entry, this.currentSpecial, simulated);
      this.summaryValue = summary;
      for (const line of summary.pbp) this.emit({ type: 'pbp', line });
      const banner = bannerForSummary(summary);
      if (banner) this.emit({ type: 'banner', ...banner });
      const window = pd?.kind === 'challengeWindow' && this.isHuman(pd.side) && !this.challengeDeclined && entry.outcome.review
        ? { side: pd.side, call: entry.outcome.review.call, remainingSec: pd.deadlineSec ?? CHALLENGE_HOLD_SECONDS }
        : null;
      // Keep the card up for the whole challenge window the controller granted.
      const base = this.deps.holdSeconds ?? 2;
      // Simulated cards flash by at sim speed, but never too fast to read while a human is playing.
      const quick = simulated && (this.watching || !this.isHuman(entry.possession) || this.deps.settings.defenseMode !== 'control');
      const hold = window ? Math.max(CHALLENGE_HOLD_SECONDS, window.remainingSec) : quick ? Math.max(this.watching ? 0 : Math.min(base, MIN_SIM_HOLD_SECONDS), base * 0.4 / this.speedValue) : base;
      this.setStage({ kind: 'postPlay', summary, remaining: hold, challenge: window });
      return;
    }
    this.resolveFlow();
  }

  /* ------------------------------------ driving ------------------------------------ */

  update(dt: number): void {
    const stage = this.stageValue;
    if (stage.kind === 'postPlay') {
      stage.remaining -= dt;
      if (stage.challenge) {
        stage.challenge.remainingSec -= dt;
        if (stage.challenge.remainingSec <= 0) { stage.challenge = null; this.challengeDeclined = true; }
      }
      if (stage.remaining <= 0) this.continue();
    } else if (stage.kind === 'intermission') {
      stage.remaining -= dt;
      if (stage.remaining <= 0) this.continue();
    }
  }

  tick(inputs?: UserInputs): void {
    const stage = this.stageValue;
    if (stage.kind !== 'live') return;
    const play = stage.play;
    const n = stage.meta.spectating ? this.speedValue : 1;
    for (let i = 0; i < n && !play.isDead; i++) {
      play.tick(i === 0 ? inputs : undefined);
      this.forwardPlayEvents(play);
    }
    this.snapshot.capture(play.state);
    if (play.isDead && play.outcome) this.finishPlay(play.outcome, false);
  }

  private forwardPlayEvents(play: LivePlay): void {
    const events = play.state.events;
    for (; this.eventCursor < events.length; this.eventCursor++) {
      const e = events[this.eventCursor];
      if (e) this.deps.audio?.onGameEvent(e, play.state);
    }
  }

  continue(): void {
    const stage = this.stageValue;
    if (stage.kind === 'postPlay') {
      if (stage.challenge) this.challengeDeclined = true;
      this.resolveFlow();
    } else if (stage.kind === 'intermission') {
      this.announced.add(intermissionKey(this.controller.state, stage.reason));
      this.resolveFlow();
    }
  }

  /* ------------------------------------ commands ----------------------------------- */

  callPlay(call: PlayCall): void {
    const stage = this.stageValue;
    if (stage.kind !== 'playcall') return;
    const req = stage.request;
    if (req.unit === 'offense' && !call.offensivePlayId) return;
    if (req.unit === 'defense' && !call.defensivePlayId) return;
    this.calls[req.side] = { ...this.calls[req.side], ...call };
    this.resolveFlow();
  }

  answerCoinToss(choice: 'kick' | 'receive' | 'defer'): void {
    const stage = this.stageValue;
    if (stage.kind !== 'coinToss') return;
    this.controller.dispatch({ type: 'coinToss', side: stage.side, choice });
    this.resolveFlow();
  }

  answerPenalty(accept: boolean): void {
    const stage = this.stageValue;
    if (stage.kind !== 'penalty') return;
    this.controller.dispatch({ type: 'penaltyDecision', side: stage.prompt.side, accept });
    this.afterApply(this.pendingSimulated);
  }

  answerFreeKick(choice: 'kick' | 'punt'): void {
    const stage = this.stageValue;
    if (stage.kind !== 'freeKick') return;
    this.controller.dispatch({ type: 'freeKick', side: stage.side, choice });
    this.resolveFlow();
  }

  answerWatchPrompt(jumpIn: boolean): void {
    const stage = this.stageValue;
    if (stage.kind !== 'watchPrompt') return;
    if (jumpIn) {
      if (this.watching) this.jumpIn();
      // Also marks the next play as taken over so a 'watch' defense mode does not fast-sim it.
      this.jumpedIn = true;
    }
    this.resolveFlow();
  }

  challenge(): boolean {
    const stage = this.stageValue;
    if (stage.kind !== 'postPlay' || !stage.challenge) return false;
    try {
      this.controller.dispatch({ type: 'challenge', side: stage.challenge.side });
    } catch {
      return false;
    }
    this.challengeDeclined = true;
    // A call that stands keeps the same log entry: hold the card so the ruling (and the lost timeout) is seen.
    const summary = this.summaryValue;
    if (summary && this.controller.state.playLog.at(-1)?.review?.result === 'upheld') this.setStage({ kind: 'postPlay', summary: { ...summary, resultText: `CALL STANDS · ${summary.resultText}` }, remaining: REVIEW_HOLD_SECONDS, challenge: null });
    else this.afterApply(stage.summary.simulated);
    return true;
  }

  callTimeout(): boolean {
    const side = this.userSide;
    const s = this.controller.state;
    if (!side || !this.isHuman(side) || s.timeouts[side] <= 0 || !TIMEOUT_PHASES.includes(s.phase)) return false;
    const pd = s.pendingDecision;
    if (pd && (pd.kind === 'coinToss' || pd.kind === 'penaltyDecision' || pd.kind === 'freeKick')) return false;
    const stage = this.stageValue;
    if (stage.kind === 'live' && stage.play.state.phase !== 'presnap') return false;
    if (stage.kind === 'final' || stage.kind === 'pregame') return false;
    try {
      this.controller.dispatch({ type: 'timeout', side });
    } catch {
      return false;
    }
    if (stage.kind === 'live') {
      this.livePlay = null;
      this.meta = null;
      this.calls = {};
      this.resolveFlow();
    } else if (stage.kind === 'postPlay' && stage.challenge) {
      stage.challenge = null;
      this.challengeDeclined = true;
    }
    return true;
  }

  skipPlay(): void {
    const stage = this.stageValue;
    if (stage.kind === 'live') {
      this.finishSkipped(stage.play, stage.meta.spectating);
      return;
    }
    if (stage.kind === 'playcall' || stage.kind === 'watchPrompt' || stage.kind === 'postPlay' || stage.kind === 'intermission') {
      this.simulateNext = true;
      if (stage.kind === 'watchPrompt') this.answerWatchPrompt(false);
      else if (stage.kind !== 'playcall') this.continue();
    }
  }

  substitute(role: string, playerId: PlayerId | null): boolean {
    const side = this.userSide;
    if (!side || !this.isHuman(side) || this.controller.isFinal) return false;
    try {
      this.controller.dispatch({ type: 'substitute', side, role, playerId });
    } catch {
      return false;
    }
    return true;
  }

  userSubstitutions(): Readonly<Record<string, PlayerId>> {
    const side = this.userSide;
    return side ? { ...this.controller.substitutions[side] } : {};
  }

  setSpeed(speed: number): void {
    this.speedValue = Math.max(MIN_SPEED, Math.min(MAX_SPEED, Math.round(speed) || MIN_SPEED));
  }

  jumpIn(): void {
    const side = this.userSide;
    if (!side || this.controller.state.controllers[side] !== 'watch' || this.controller.isFinal) return;
    this.controller.dispatch({ type: 'watch', side, action: 'jumpIn' });
    // Take the play that is running right now too, not only the next snap.
    const stage = this.stageValue;
    if (stage.kind === 'live' && !stage.play.isDead && takeOverPlay(stage.play.state, side) !== null) stage.meta.spectating = false;
  }

  resumeWatching(): void {
    const side = this.userSide;
    if (!side || this.controller.state.controllers[side] !== 'human' || this.controller.isFinal) return;
    this.controller.dispatch({ type: 'watch', side, action: 'resume' });
  }

  cameraContext(): CameraContext {
    return cameraContextFor(this.controller.state, this.userSide, this.meta?.ctx ?? null);
  }

  lastReplay(): ReplayRecording | null {
    const id = this.summaryValue?.replayId ?? null;
    return (id ? this.deps.replayStore.get(id) : null) ?? this.deps.replayStore.last();
  }
}

/** Builds a session for a setup; `deps` decides real vs fake executors (see session-defaults.ts). */
export const createGameSession = (setup: GameSetup, deps: SessionDeps): GameSession => new GameSessionImpl(setup, deps);
