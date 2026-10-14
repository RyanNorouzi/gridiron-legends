import type { PlayerId } from '@/core/ids';
import { restoreRng, type Rng } from '@/core/rng';
import type { DefAssignment, DefensivePlay, OffensivePlay } from '@/playbook/types';
import { createGameState, directionFor, newDrive } from './game-state';
import type { PenaltyInfo, ReviewableCall } from './play-events';
import type { PlayContext, PlayOutcome } from './play-types';
import { buildPlayContext, isReturnPlay, isSpecialConcept, specialFor, syntheticDefensePlay, syntheticReturnPlay, syntheticSpecialPlay, type PlayRegistries } from './play-context';
import { applyOutcome, betweenPlayPhase, defaultCoach, type ApplyOptions, type ApplyReport, type CoachHooks } from './rules';

export { defaultCoach, type CoachHooks } from './rules';
import { applyChallengeAccounting, boothReviews, canChallenge, challengeSideFor, CHALLENGE_WINDOW_SEC, resolveChallenge } from './rules/challenges';
import { applyTimeout } from './rules/clock';
import { winnerOf } from './rules/overtime';
import { decidePenalty, extendsPeriodFoul, type PenaltyDecisionContext } from './rules/penalties';
import { assertValidOutcome } from './outcome-factory';
import { effectiveSpecial, isKickPlay, patSpot, type PatKind, type ScoreKind, type SpecialKind } from './rules/scoring';
import { clampSpot } from './rules/downs';
import { MIDDLE_X, otherSide, type GameCommand, type GamePhase, type GameSetup, type GameState, type PendingDecision, type PlayLogEntry, type TeamSide } from './types';

/** Events emitted after commands/plays for HUD, audio and commentary. */
export type GameEvent =
  | { type: 'coinToss'; winner: TeamSide; choice: 'kick' | 'receive' | 'defer'; receiving: TeamSide }
  | { type: 'decision'; decision: PendingDecision }
  /** `replaces`: a challenge overturned the call and this entry replaces the play reported just before it. */
  | { type: 'playApplied'; entry: PlayLogEntry; replaces: boolean }
  | { type: 'score'; side: TeamSide; kind: ScoreKind; points: number; score: Record<TeamSide, number> }
  | { type: 'turnover'; from: TeamSide; to: TeamSide; kind: 'interception' | 'fumble' | 'downs' | 'onside' }
  | { type: 'firstDown'; side: TeamSide }
  | { type: 'penaltyFlag'; side: TeamSide; penalty: PenaltyInfo; accepted: boolean }
  | { type: 'twoMinute'; half: 1 | 2 }
  | { type: 'quarterEnd'; quarter: number }
  | { type: 'halftime'; score: Record<TeamSide, number> }
  | { type: 'overtime'; period: number }
  | { type: 'final'; score: Record<TeamSide, number>; winner: TeamSide | null }
  | { type: 'timeout'; side: TeamSide; remaining: number }
  | { type: 'challengeFlag'; side: TeamSide; booth: boolean; call: ReviewableCall }
  | { type: 'challengeResult'; side: TeamSide; result: 'upheld' | 'overturned'; booth: boolean }
  | { type: 'injury'; playerId: PlayerId; severity: string }
  /** playerId null: the role went back to AUTO. */
  | { type: 'substitution'; side: TeamSide; role: string; playerId: PlayerId | null };

export interface ControllerOptions {
  coach?: Partial<CoachHooks>;
  registries?: PlayRegistries;
  /** Start from an existing state (saves, scenario tests). */
  state?: GameState;
}

export interface BeginPlayOptions {
  /** True asks for the no-huddle. False / absent is no request: an AI offense then asks its coach (CoachHooks.hurryUp). */
  hurryUp?: boolean;
  controlRole?: string | null;
}

interface CurrentPlay { ctx: PlayContext; opts: ApplyOptions }
interface PendingApply { outcome: PlayOutcome; decisions: (boolean | null)[]; pendingIndex: number; opts: ApplyOptions }
interface PlayCall { offensivePlayId?: string; defensivePlayId?: string; hurryUp?: boolean; assignmentOverrides?: Record<string, DefAssignment> }

const BEGIN_PHASES: readonly GamePhase[] = ['playcall', 'kickoff', 'pat', 'halftime', 'twoMinute', 'deadball', 'challenge', 'timeout'];
const TIMEOUT_PHASES: readonly GamePhase[] = ['playcall', 'kickoff', 'pat', 'twoMinute', 'deadball', 'challenge', 'timeout', 'presnap'];
/** Fatigue relief for everyone during a charged timeout. */
const TIMEOUT_FATIGUE_RELIEF = 0.1;

/**
 * Owns the GameState between plays. Play executors (PlayEngine / FastSim) get a PlayContext from
 * `beginPlay` and hand back a PlayOutcome to `completePlay`; everything else goes through `dispatch`.
 * The clock only moves inside `completePlay` — there is no wall clock.
 */
export class GameController {
  readonly setup: GameSetup;
  private st: GameState;
  private rng: Rng;
  private readonly coach: CoachHooks;
  private readonly registries: PlayRegistries;
  private readonly listeners: ((e: GameEvent) => void)[] = [];
  private current: CurrentPlay | null = null;
  private pending: PendingApply | null = null;
  private snapshot: GameState | null = null;
  private lastOpts: ApplyOptions | null = null;
  private readonly subs: Record<TeamSide, Record<string, PlayerId>> = { home: {}, away: {} };
  private calls: Partial<Record<TeamSide, PlayCall>> = {};
  private freeKick = false;
  private freeKickChoice: 'kick' | 'punt' = 'kick';
  private readonly watchState = { speed: 1, skipRequested: false };

  constructor(setup: GameSetup, opts: ControllerOptions = {}) {
    this.setup = setup;
    this.st = opts.state ?? createGameState(setup);
    this.rng = restoreRng(this.st.seed, this.st.rngState);
    this.coach = { ...defaultCoach, ...opts.coach };
    this.registries = opts.registries ?? {};
  }

  get state(): Readonly<GameState> { return this.st; }
  get pendingDecision(): PendingDecision | null { return this.st.pendingDecision; }
  get isFinal(): boolean { return this.st.phase === 'final'; }
  /** Context of the play in progress (between beginPlay and completePlay). */
  get currentContext(): PlayContext | null { return this.current?.ctx ?? null; }
  /** Outcome waiting on a human penalty decision. */
  get pendingOutcome(): PlayOutcome | null { return this.pending?.outcome ?? null; }
  get substitutions(): Readonly<Record<TeamSide, Readonly<Record<string, PlayerId>>>> { return this.subs; }
  get watch(): Readonly<{ speed: number; skipRequested: boolean }> { return this.watchState; }

  onEvent(cb: (e: GameEvent) => void): () => void {
    this.listeners.push(cb);
    return () => { const i = this.listeners.indexOf(cb); if (i >= 0) this.listeners.splice(i, 1); };
  }
  private emit(e: GameEvent): void { for (const l of [...this.listeners]) l(e); }
  private isHuman(side: TeamSide): boolean { return this.st.controllers[side] === 'human'; }

  /** Replaces the state (load a save). Any play in progress is discarded. */
  loadState(state: GameState): void {
    this.st = state;
    this.rng = restoreRng(state.seed, state.rngState);
    this.current = null; this.pending = null; this.snapshot = null; this.lastOpts = null;
  }

  /** pregame -> coin toss (AI winners answer immediately). */
  start(): Readonly<GameState> {
    if (this.st.phase !== 'pregame') throw new Error(`start: game already started (phase '${this.st.phase}')`);
    this.beginCoinToss();
    return this.st;
  }

  private beginCoinToss(): void {
    const winner: TeamSide = this.rng.fork('coinToss').chance(0.5) ? 'home' : 'away';
    this.st.phase = 'coinToss';
    this.st.pendingDecision = { side: winner, kind: 'coinToss', deadlineSec: null };
    this.st.rngState = this.rng.getState();
    this.emit({ type: 'decision', decision: this.st.pendingDecision });
    if (!this.isHuman(winner)) this.dispatch({ type: 'coinToss', side: winner, choice: this.coach.coinToss(this.st, winner) });
  }

  /* ------------------------------ Commands ------------------------------ */

  dispatch(cmd: GameCommand): Readonly<GameState> {
    if (this.isFinal && cmd.type !== 'watch') throw new Error(`dispatch: game is final (${cmd.type})`);
    switch (cmd.type) {
      case 'coinToss': this.handleCoinToss(cmd.side, cmd.choice); break;
      case 'callPlay': this.handleCallPlay(cmd.side, cmd); break;
      case 'timeout': this.handleTimeout(cmd.side); break;
      case 'challenge': this.handleChallenge(cmd.side); break;
      case 'penaltyDecision': this.handlePenaltyDecision(cmd.side, cmd.accept); break;
      case 'freeKick': this.handleFreeKick(cmd.side, cmd.choice); break;
      case 'substitute': this.handleSubstitute(cmd.side, cmd.role, cmd.playerId); break;
      case 'watch': this.handleWatch(cmd.side, cmd.action); break;
    }
    return this.st;
  }

  private handleCoinToss(side: TeamSide, choice: 'kick' | 'receive' | 'defer'): void {
    const pd = this.st.pendingDecision;
    if (this.st.phase !== 'coinToss' || !pd || pd.kind !== 'coinToss') throw new Error('coinToss: no toss pending');
    if (pd.side !== side) throw new Error(`coinToss: ${side} did not win the toss`);
    const receiver = choice === 'receive' ? side : otherSide(side);
    if (!this.st.overtime) this.st.receivedOpeningKickoff = receiver;
    this.setupKickoff(otherSide(receiver));
    this.emit({ type: 'coinToss', winner: side, choice, receiving: receiver });
    this.afterPlayHousekeeping();
  }

  private setupKickoff(kicker: TeamSide): void {
    const s = this.st;
    const rs = s.ruleset;
    s.pendingDecision = null; s.ballX = MIDDLE_X; s.down = 1; s.distance = 10;
    if (rs.kickoffs) {
      s.kickoffPending = kicker; s.possession = kicker; s.ballOn = rs.kickoffYardLine; s.phase = 'kickoff';
    } else {
      const receiver = otherSide(kicker);
      s.kickoffPending = null; s.possession = receiver; s.ballOn = rs.touchbackYardLine; s.phase = 'playcall';
      s.drive = newDrive(receiver, s.ballOn, s.clock.quarter, s.clock.secondsRemaining);
      s.stats.teams[receiver].drives += 1;
    }
    s.direction = directionFor(s.possession, s.clock.quarter);
  }

  private handleCallPlay(side: TeamSide, call: PlayCall): void {
    if (!BEGIN_PHASES.includes(this.st.phase)) throw new Error(`callPlay: not allowed during phase '${this.st.phase}'`);
    const prev = this.calls[side] ?? {};
    this.calls[side] = {
      ...prev,
      ...(call.offensivePlayId !== undefined && { offensivePlayId: call.offensivePlayId }),
      ...(call.defensivePlayId !== undefined && { defensivePlayId: call.defensivePlayId }),
      ...(call.hurryUp !== undefined && { hurryUp: call.hurryUp }),
      ...(call.assignmentOverrides !== undefined && { assignmentOverrides: call.assignmentOverrides }),
    };
  }

  private handleTimeout(side: TeamSide): void {
    const s = this.st;
    if (!TIMEOUT_PHASES.includes(s.phase)) throw new Error(`timeout: not allowed during phase '${s.phase}'`);
    const pd = s.pendingDecision;
    if (pd && (pd.kind === 'coinToss' || pd.kind === 'penaltyDecision')) throw new Error(`timeout: waiting on ${pd.kind}`);
    if (s.timeouts[side] <= 0) throw new Error(`timeout: ${side} has no timeouts left`);
    s.timeouts[side] -= 1;
    applyTimeout(s);
    if (s.phase === 'presnap') this.current = null;
    if (s.phase === 'challenge') s.pendingDecision = null;
    s.phase = betweenPlayPhase(s);
    if (s.ruleset.fatigue) for (const id of Object.keys(s.fatigue)) s.fatigue[id as PlayerId] = Math.max(0, s.fatigue[id as PlayerId] - TIMEOUT_FATIGUE_RELIEF);
    this.emit({ type: 'timeout', side, remaining: s.timeouts[side] });
  }

  private handleChallenge(side: TeamSide): void {
    const s = this.st;
    const pd = s.pendingDecision;
    if (s.phase !== 'challenge' || !pd || pd.kind !== 'challengeWindow') throw new Error('challenge: no challenge window open');
    if (pd.side !== side) throw new Error(`challenge: only ${pd.side} may challenge this ruling`);
    if (!canChallenge(s, side)) throw new Error(`challenge: ${side} has no challenge or timeout left`);
    this.runChallenge(side, false);
    this.afterPlayHousekeeping();
  }

  private handlePenaltyDecision(side: TeamSide, accept: boolean): void {
    const pd = this.st.pendingDecision;
    if (!this.pending || !pd || pd.kind !== 'penaltyDecision') throw new Error('penaltyDecision: no penalty decision pending');
    if (pd.side !== side) throw new Error(`penaltyDecision: ${pd.side} decides this penalty`);
    this.pending.decisions[this.pending.pendingIndex] = accept;
    this.st.pendingDecision = null;
    this.continueApply();
  }

  private handleFreeKick(side: TeamSide, choice: 'kick' | 'punt'): void {
    const pd = this.st.pendingDecision;
    if (!pd || pd.kind !== 'freeKick') throw new Error('freeKick: no free kick pending');
    if (pd.side !== side) throw new Error(`freeKick: ${pd.side} kicks after the safety`);
    this.freeKick = true;
    this.freeKickChoice = choice;
    this.st.pendingDecision = null;
    this.st.phase = betweenPlayPhase(this.st);
  }

  private handleSubstitute(side: TeamSide, role: string, playerId: PlayerId | null): void {
    if (playerId === null) {
      // Back to AUTO: drop the override so the depth chart and the fatigue rotation choose again.
      if (role in this.subs[side]) {
        delete this.subs[side][role];
        this.emit({ type: 'substitution', side, role, playerId: null });
      }
      return;
    }
    const team = this.setup[side];
    const p = team.players[playerId];
    if (!p || !team.team.rosterIds.includes(playerId)) throw new Error(`substitute: ${playerId} is not on the ${side} roster`);
    if (p.injury !== null || this.st.injuries.some((i) => i.playerId === playerId)) throw new Error(`substitute: ${playerId} is injured`);
    this.subs[side][role] = playerId;
    this.emit({ type: 'substitution', side, role, playerId });
  }

  private handleWatch(side: TeamSide, action: 'skip' | 'speedUp' | 'speedDown' | 'jumpIn' | 'resume'): void {
    if (this.st.userSide !== side) throw new Error('watch: only the local user side may issue watch commands');
    const w = this.watchState;
    if (action === 'speedUp') w.speed = Math.min(8, w.speed * 2);
    else if (action === 'speedDown') w.speed = Math.max(1, w.speed / 2);
    else if (action === 'skip') w.skipRequested = true;
    else if (action === 'jumpIn') this.st.controllers[side] = 'human';
    else this.st.controllers[side] = 'watch';
  }

  /** Clears a pending watch-skip request (the sim calls this once it has skipped). */
  acknowledgeSkip(): void { this.watchState.skipRequested = false; }

  /* ------------------------------ Plays ------------------------------ */

  /** Validates the phase, resolves both plays (auto-selecting kickoff / PAT plays) and returns the PlayContext. */
  beginPlay(offensivePlayId?: string | null, defensivePlayId?: string | null, opts: BeginPlayOptions = {}): PlayContext {
    const s = this.st;
    if (this.isFinal) throw new Error('beginPlay: the game is final');
    if (this.pending) throw new Error('beginPlay: a penalty decision is pending');
    const pd = s.pendingDecision;
    if (pd && pd.kind !== 'playCall' && pd.kind !== 'challengeWindow') throw new Error(`beginPlay: waiting on ${pd.kind} by ${pd.side}`);
    if (!BEGIN_PHASES.includes(s.phase)) throw new Error(`beginPlay: cannot start a play during phase '${s.phase}'`);
    if (s.phase === 'challenge') { s.pendingDecision = null; s.phase = betweenPlayPhase(s); this.afterPlayHousekeeping(); }
    if (s.clock.secondsRemaining <= 0 && !s.patPending && s.playLog.length > 0 && !(s.lastOutcome?.penalties.some(extendsPeriodFoul) ?? false)) {
      throw new Error('beginPlay: no time remains in the period');
    }
    const offense = s.possession;
    const defense = otherSide(offense);
    const offId = offensivePlayId ?? this.calls[offense]?.offensivePlayId ?? null;
    const defId = defensivePlayId ?? this.calls[defense]?.defensivePlayId ?? null;
    const { play: offensivePlay, special } = this.resolveOffense(offId);
    const hurryUp = this.hurriesUp(offense, offensivePlay, special, opts.hurryUp === true || this.calls[offense]?.hurryUp === true);
    const overrides = this.calls[defense]?.assignmentOverrides;
    const resolvedDef = this.resolveDefense(defId, special);
    const defensivePlay = overrides ? { ...resolvedDef, assignments: { ...resolvedDef.assignments, ...overrides } } : resolvedDef;
    if (s.patPending) {
      // Between tries the spot is kept relative to the extra-point spot (see continueApply): a fouled try is re-snapped
      // from the walked-off spot, whichever kind of try comes next.
      const kind: PatKind = special === 'extraPoint' ? 'extraPoint' : 'twoPoint';
      s.ballOn = clampSpot(patSpot(s.ruleset, kind) + s.ballOn - patSpot(s.ruleset, 'extraPoint'));
    }
    const ctx = buildPlayContext(s, this.setup, offensivePlay, defensivePlay, this.rng, this.registries, { special, controlRole: opts.controlRole ?? null, substitutions: this.subs, hurryUp });
    this.current = { ctx, opts: { special, offensivePlayId: offensivePlay.id, defensivePlayId: defensivePlay.id, hurryUp } };
    this.calls = {};
    if (s.kickoffPending) this.freeKick = false;
    s.phase = 'presnap';
    s.pendingDecision = null;
    s.clock.playClockRunning = true;
    s.rngState = this.rng.getState();
    return ctx;
  }

  /**
   * No-huddle for this snap: a spike always is one, a kneel never; kicks and tries huddle. Otherwise the explicit call
   * (the human's NO HUDDLE, a sim playcaller) or, for an AI offense, its coach's clock management.
   */
  private hurriesUp(offense: TeamSide, play: OffensivePlay, special: SpecialKind, requested: boolean): boolean {
    if (play.type === 'spike') return true;
    if (play.type === 'kneel' || (special !== 'none' && special !== 'twoPoint') || this.st.patPending || this.st.kickoffPending) return false;
    if (requested) return true;
    return !this.isHuman(offense) && (this.coach.hurryUp?.(this.st, offense) ?? false);
  }

  private resolveOffense(id: string | null): { play: OffensivePlay; special: SpecialKind } {
    const s = this.st;
    const plays = this.setup[s.possession].offensePlays;
    const found = id ? plays.find((p) => p.id === id) ?? null : null;
    if (id && !found) throw new Error(`beginPlay: unknown offensive play "${id}" for ${s.possession}`);
    if (s.kickoffPending) {
      const punting = this.freeKick && (found ? found.concept === 'punt' : this.freeKickChoice === 'punt');
      if (found && (found.concept === 'kickoff' || found.concept === 'onside' || (punting && found.concept === 'punt'))) return { play: found, special: specialFor(found.concept) };
      const concept = punting ? 'punt' : found?.concept === 'onside' ? 'onside' : 'kickoff';
      return { play: plays.find((p) => p.concept === concept) ?? syntheticSpecialPlay(concept), special: concept };
    }
    if (s.patPending) {
      if (!found) return { play: plays.find((p) => p.concept === 'extraPoint') ?? syntheticSpecialPlay('extraPoint'), special: 'extraPoint' };
      if (found.concept === 'extraPoint') return { play: found, special: 'extraPoint' };
      if (isSpecialConcept(found.concept)) throw new Error(`beginPlay: "${id}" cannot be run as a two-point try`);
      return { play: found, special: 'twoPoint' };
    }
    if (found) {
      if (found.concept === 'kickoff' || found.concept === 'onside' || found.concept === 'extraPoint') throw new Error(`beginPlay: "${id}" is not a scrimmage play`);
      return { play: found, special: specialFor(found.concept) };
    }
    const play = this.coach.pickOffensivePlay(s, plays, this.rng.fork('autoplay'));
    return { play, special: specialFor(play.concept) };
  }

  private resolveDefense(id: string | null, special: SpecialKind): DefensivePlay {
    const s = this.st;
    const plays = this.setup[otherSide(s.possession)].defensePlays;
    if (id) {
      const found = plays.find((p) => p.id === id);
      if (!found) throw new Error(`beginPlay: unknown defensive play "${id}" for ${otherSide(s.possession)}`);
      return found;
    }
    if (special === 'kickoff' || special === 'onside' || special === 'punt') {
      const tag = special === 'punt' ? 'puntReturn' : 'kickReturn';
      return plays.find((p) => isReturnPlay(p) && p.tags.includes(tag)) ?? plays.find(isReturnPlay) ?? syntheticReturnPlay(special === 'punt' ? 'punt' : 'kickoff');
    }
    const regular = plays.filter((p) => !isReturnPlay(p));
    return regular.length > 0 ? this.coach.pickDefensivePlay(s, regular, this.rng.fork('autodef')) : syntheticDefensePlay();
  }

  /** Applies the play in the documented order; may suspend on a human penalty decision (see pendingDecision). */
  completePlay(outcome: PlayOutcome): Readonly<GameState> {
    const s = this.st;
    if (!this.current || (s.phase !== 'presnap' && s.phase !== 'live')) throw new Error(`completePlay: no play in progress (phase '${s.phase}')`);
    const cur = this.current;
    assertValidOutcome(outcome);
    const cleaned: PlayOutcome = {
      ...outcome,
      penalties: s.ruleset.penalties ? outcome.penalties.map((p) => ({ ...p })) : [],
      review: s.ruleset.challenges ? outcome.review : null,
    };
    this.snapshot = structuredClone(s);
    this.pending = { outcome: cleaned, decisions: [], pendingIndex: -1, opts: cur.opts };
    this.current = null;
    s.phase = 'deadball';
    return this.continueApply();
  }

  private continueApply(): Readonly<GameState> {
    const s = this.st;
    const p = this.pending;
    if (!p) throw new Error('continueApply: nothing pending');
    const decider = (pen: PenaltyInfo, ctx: PenaltyDecisionContext): boolean | null =>
      this.isHuman(ctx.decidingSide) ? null : this.coach.shouldAccept(s, p.outcome, pen, ctx);
    const r = decidePenalty(s, p.outcome, decider, p.opts.special, p.decisions);
    p.decisions = r.decisions;
    p.outcome = r.outcome;
    if (r.pending) {
      p.pendingIndex = r.pending.index;
      s.pendingDecision = { side: r.pending.side, kind: 'penaltyDecision', deadlineSec: null };
      s.phase = 'deadball';
      this.emit({ type: 'decision', decision: s.pendingDecision });
      return s;
    }
    this.pending = null;
    this.lastOpts = { ...p.opts, special: effectiveSpecial(p.opts.special, r.outcome) };
    const report = applyOutcome(s, r.outcome, this.lastOpts);
    // A try replayed after a walk-off keeps its offset in the extra-point frame the touchdown spot uses: no hidden
    // controller state, so it survives a save and resume between tries.
    if (s.patPending && p.opts.special === 'twoPoint') s.ballOn += patSpot(s.ruleset, 'extraPoint') - patSpot(s.ruleset, 'twoPoint');
    s.rngState = this.rng.getState();
    this.emitReport(report);
    if (report.overtimeStarts) { this.beginCoinToss(); return this.st; }
    this.openChallengeWindow(report);
    this.afterPlayHousekeeping();
    return this.st;
  }

  private emitReport(report: ApplyReport, replaces = false): void {
    const o = report.outcome;
    const entry = report.entry;
    this.emit({ type: 'playApplied', entry, replaces });
    for (const pen of o.penalties) {
      const side = pen.side === 'offense' ? entry.possession : otherSide(entry.possession);
      this.emit({ type: 'penaltyFlag', side, penalty: pen, accepted: pen.accepted });
    }
    if (report.scoring.kind && report.scoring.scoringSide) this.emit({ type: 'score', side: report.scoring.scoringSide, kind: report.scoring.kind, points: report.scoring.points, score: { ...this.st.score } });
    const poss = report.possession;
    if (poss && (o.turnover || poss.turnoverOnDowns) && (o.turnoverType !== null || poss.turnoverOnDowns)) {
      // On kick plays the RECEIVING team (ctx defense) is the one that loses the ball.
      const loser = o.turnover && isKickPlay(report.special) ? otherSide(entry.possession) : entry.possession;
      this.emit({ type: 'turnover', from: loser, to: otherSide(loser), kind: o.turnoverType ?? 'downs' });
    }
    if (report.firstDown && !report.scoring.kind) this.emit({ type: 'firstDown', side: entry.possession });
    for (const inj of o.injuries) this.emit({ type: 'injury', playerId: inj.playerId, severity: inj.severity });
    if (report.twoMinuteWarning) this.emit({ type: 'twoMinute', half: report.twoMinuteWarning });
    if (report.quarterEnded !== null && !report.halftime && !report.final && !report.overtimeStarts) this.emit({ type: 'quarterEnd', quarter: report.quarterEnded });
    if (report.halftime) this.emit({ type: 'halftime', score: { ...this.st.score } });
    if (report.overtimeStarts || report.nextOvertimePeriod) this.emit({ type: 'overtime', period: this.st.overtimePeriods });
    if (report.final) this.emit({ type: 'final', score: { ...this.st.score }, winner: winnerOf(this.st) });
  }

  private openChallengeWindow(report: ApplyReport): void {
    const s = this.st;
    const o = report.outcome;
    if (this.isFinal || !o.review || !s.ruleset.challenges || !this.snapshot || !this.lastOpts) return;
    const special = this.lastOpts.special;
    const side = challengeSideFor(this.snapshot, o, special);
    if (boothReviews(s, o)) { this.runChallenge(side ?? otherSide(report.entry.possession), true); return; }
    if (!side || !canChallenge(s, side)) return;
    if (this.isHuman(side)) {
      s.phase = 'challenge';
      s.pendingDecision = { side, kind: 'challengeWindow', deadlineSec: CHALLENGE_WINDOW_SEC };
      this.emit({ type: 'decision', decision: s.pendingDecision });
    } else if (this.coach.shouldChallenge(s, o, side, special)) {
      this.runChallenge(side, false);
    }
  }

  private runChallenge(side: TeamSide, booth: boolean): void {
    const s = this.st;
    const last = s.lastOutcome;
    const entry = s.playLog[s.playLog.length - 1];
    if (!last?.review || !entry || !this.snapshot || !this.lastOpts) throw new Error('challenge: nothing to review');
    const res = resolveChallenge(s, last, this.rng);
    if (!booth) applyChallengeAccounting(s, side, res.upheld);
    this.emit({ type: 'challengeFlag', side, booth, call: res.call });
    if (res.upheld) {
      entry.review = { call: res.call, challengedBy: side, result: 'upheld' };
      // A lost challenge is a charged timeout: like any timeout it stops the clock.
      if (!booth) applyTimeout(s);
      s.pendingDecision = null;
      s.phase = betweenPlayPhase(s);
    } else {
      const acct = { challenges: { ...s.challenges }, timeouts: { ...s.timeouts } };
      const restored = structuredClone(this.snapshot);
      restored.challenges = acct.challenges;
      restored.timeouts = acct.timeouts;
      this.st = restored;
      const alt: PlayOutcome = { ...res.outcome, penalties: res.outcome.penalties.map((p, i) => ({ ...p, accepted: last.penalties[i]?.accepted ?? p.accepted })) };
      const report = applyOutcome(this.st, alt, this.lastOpts);
      report.entry.review = { call: res.call, challengedBy: side, result: 'overturned' };
      this.emitReport(report, true);
    }
    this.st.rngState = this.rng.getState();
    this.emit({ type: 'challengeResult', side, result: res.upheld ? 'upheld' : 'overturned', booth });
  }

  /** AI free-kick / timeout decisions and the informational play-call decision, once nothing blocks. */
  private afterPlayHousekeeping(): void {
    const s = this.st;
    if (this.isFinal) return;
    const pd = s.pendingDecision;
    if (pd?.kind === 'freeKick') {
      this.freeKick = true;
      if (this.isHuman(pd.side)) return;
      this.dispatch({ type: 'freeKick', side: pd.side, choice: this.coach.freeKick(s, pd.side) });
    }
    if (s.phase === 'challenge' || s.phase === 'coinToss' || (s.pendingDecision && s.pendingDecision.kind !== 'playCall')) return;
    for (const side of ['home', 'away'] as const) {
      if (!this.isHuman(side) && s.timeouts[side] > 0 && s.clock.running && this.coach.callTimeout(s, side)) this.handleTimeout(side);
    }
    const needs = ([s.possession, otherSide(s.possession)] as const).find((side) => this.isHuman(side));
    s.pendingDecision = needs ? { side: needs, kind: 'playCall', deadlineSec: null } : null;
  }
}
