/**
 * Incremental league simulation for the franchise UI. `advanceLeagueWeek` plays a whole week in one call (the
 * real simulator needs ~0.5 s per game), which would freeze the screen, so a SimJob splits the work: each
 * `step()` pre-simulates ONE of the week's games into a cache (the same setups the week engine will build, so
 * results are identical), and the step after the last game runs `advanceLeagueWeek` with a simulator that answers
 * from the cache. Offseason phases advance one `advanceLeaguePhase` per step. The job stops at its target, on a
 * user-roster block, on an error (the League is left at the last completed step, never half-applied) or when
 * cancelled (between weeks). `onStep` hears about every completed week / phase (the hub commits and autosaves
 * there, so closing the browser mid-sim keeps the finished weeks). Headless and deterministic.
 *
 * Off the main thread: with a `remote` simulator (the shared Web Worker pool of ./sim-workers.ts by default in a
 * browser when no `simulator` is injected) the first step of a week hands every game's setup to the workers and the
 * following steps return at once until all results are back (`waiting`), so the page keeps drawing and a cancel is
 * honoured on the next frame. The results feed the same cache, so the League is identical to the in-thread path.
 * If a worker fails the week is redone on this thread and the job carries on synchronously. When a week completes
 * and another follows, the next week's games go to the workers BEFORE `onStep` runs, so the workers simulate while
 * this thread does the week's bookkeeping and the checkpoint save. `settled()` resolves on the next remote answer
 * (the progress overlay's hidden-tab pump waits on it instead of on animation frames).
 */
import type { GameId } from '@/core/ids';
import { buildGameSetup } from '@/franchise/game-setup';
import { nextPhaseOf } from '@/franchise/phase';
import type { RosterRuleIssue } from '@/franchise/roster-rules';
import { advanceLeaguePhase, advanceLeagueWeek, type LeaguePhaseResult, type LeagueWeekResult, type UserGameResult } from '@/franchise/season-loop';
import { playoffRoundCount, scheduleWeekCount } from '@/franchise/settings';
import type { GameSimResult, GameSimulator } from '@/franchise/sim-seam';
import { realGameSimulator } from '@/franchise/sim-real';
import type { League, ScheduledGame, SeasonPhase } from '@/franchise/types';
import { gamesThisWeek, isGamePhase, keepsPlayLog, recordUserGameResult } from '@/franchise/week';
import { advanceInjury } from '@/players/injuries';
import { SimWorkerError, sharedSimWorkers, type AsyncGameSimulator } from './sim-workers';

/** What a job runs to: one game week, until the League reaches a phase, or one offseason phase step. */
export type SimTarget = { kind: 'week' } | { kind: 'phase'; phase: SeasonPhase } | { kind: 'nextPhase' };

/** Options of a SimJob. */
export interface SimJobOptions {
  /** Game simulator (default: the real whole-game simulator). */
  simulator?: GameSimulator;
  /**
   * Off-thread simulator for the weeks' games. Default: the shared worker pool (sharedSimWorkers) when no
   * `simulator` is injected and the environment has Workers, else none. Null forces the synchronous path.
   */
  remote?: AsyncGameSimulator | null;
  /** Live results of the user's game, applied to the FIRST week only. */
  userResults?: Readonly<Record<GameId, UserGameResult>>;
  /** Settle the user's roster automatically when a gated phase move is blocked. */
  autoFix?: boolean;
  /** Safety valve on weeks + phases (default 160). */
  maxSteps?: number;
  /**
   * Called after every completed week ('week') or offseason phase step ('phase') with the consistent League at
   * that point. A throwing listener does not stop the job.
   */
  onStep?(league: League, kind: 'week' | 'phase'): void;
}

/** What a job produced. `league` is always a consistent League (the input when nothing completed). */
export interface SimJobResult {
  league: League;
  weeks: LeagueWeekResult[];
  phases: LeaguePhaseResult[];
  blockedBy: RosterRuleIssue[];
  error: string | null;
  cancelled: boolean;
}

interface WeekPlan {
  pending: ScheduledGame[];
  total: number;
  /** Games with a cached result. */
  done: number;
  prepared: League;
  cache: Map<string, GameSimResult>;
  /** True once the games went to the remote simulator. */
  dispatched: boolean;
  /** First remote failure of the week. */
  failed: Error | null;
}

/** Heals injuries that have run out, exactly as the week engine does before kickoff (so cached setups match). */
const healExpired = (league: League): League => {
  let players: League['players'] | null = null;
  for (const p of Object.values(league.players)) {
    if (!p.injury || p.injury.weeksRemaining > 0) continue;
    players ??= { ...league.players };
    players[p.id] = advanceInjury(p);
  }
  return players ? { ...league, players } : league;
};

/** Week + phase steps from the League's current point until `target` (at least 1). */
export const estimateSteps = (league: League, target: SimTarget): number => {
  if (target.kind !== 'phase') return 1;
  const s = league.settings;
  let phase = league.season.phase;
  let week = league.season.week;
  let steps = 0;
  for (let guard = 0; guard < 24 && phase !== target.phase; guard++) {
    if (phase === 'preseason') {
      steps += Math.max(1, s.preseasonWeeks - week + 1);
      phase = 'regularSeason';
    } else if (phase === 'regularSeason') {
      steps += Math.max(1, scheduleWeekCount(s) - week + 1);
      phase = 'playoffs';
    } else if (phase === 'playoffs') {
      steps += Math.max(1, playoffRoundCount(s) - week + 1);
      phase = 'awards';
    } else {
      steps += 1;
      phase = nextPhaseOf(phase);
    }
    week = 1;
  }
  return Math.max(1, steps);
};

/** A resumable league simulation (see the module header). */
export class SimJob {
  private current: League;
  private readonly simulator: GameSimulator;
  private remote: AsyncGameSimulator | null;
  private readonly total: number;
  private plan: WeekPlan | null = null;
  private stepsDone = 0;
  private finished = false;
  private cancelRequested = false;
  private userResults: Readonly<Record<GameId, UserGameResult>> | undefined;
  private readonly out: SimJobResult;
  private settleWaiters: (() => void)[] = [];

  constructor(readonly start: League, readonly target: SimTarget, private readonly opts: SimJobOptions = {}) {
    this.current = start;
    this.simulator = opts.simulator ?? realGameSimulator;
    this.remote = opts.remote !== undefined ? opts.remote : opts.simulator ? null : sharedSimWorkers();
    this.userResults = opts.userResults;
    this.total = estimateSteps(start, target);
    this.out = { league: start, weeks: [], phases: [], blockedBy: [], error: null, cancelled: false };
    if (target.kind === 'phase' && start.season.phase === target.phase) this.finished = true;
    if (target.kind === 'week' && !isGamePhase(start.season.phase)) this.fail(`No games are played in the ${start.season.phase} phase`);
  }

  get done(): boolean { return this.finished; }
  get result(): SimJobResult { return { ...this.out, league: this.current }; }
  /** League after the last completed step. */
  get league(): League { return this.current; }

  /** 0..1 progress estimate. */
  get progress(): number {
    if (this.finished) return 1;
    const partial = this.plan && this.plan.total > 0 ? this.plan.done / (this.plan.total + 1) : 0;
    return Math.max(0, Math.min(0.99, (this.stepsDone + partial) / this.total));
  }

  /** Games simulated / to simulate in the week being prepared (null outside a week). */
  get weekProgress(): { done: number; total: number } | null {
    return this.plan ? { done: this.plan.done, total: this.plan.total } : null;
  }

  /** True while the week's games are out at the remote simulator (a step now does nothing but check). */
  get waiting(): boolean {
    const p = this.plan;
    return !this.finished && !this.cancelRequested && p !== null && p.dispatched && p.failed === null && p.done < p.total;
  }

  /** True when the job simulates games off this thread. */
  get offThread(): boolean { return this.remote !== null && !this.remote.broken; }

  /** Resolves when a remote game of the current week answers (at once when the job is not waiting on one). */
  settled(): Promise<void> {
    if (!this.waiting) return Promise.resolve();
    return new Promise<void>((resolve) => this.settleWaiters.push(resolve));
  }

  private wakeWaiters(): void {
    for (const w of this.settleWaiters.splice(0)) w();
  }

  /** Stops before the next week / phase (a week being prepared is discarded; nothing half-applied). */
  cancel(): void {
    this.cancelRequested = true;
    // Games still queued for the workers are dropped at once; a game already running finishes and is ignored.
    if (this.plan?.dispatched) this.remote?.cancelQueued();
    this.wakeWaiters();
  }

  /** Does one unit of work; returns true once the job is finished. */
  step(): boolean {
    if (this.finished) return true;
    if (this.cancelRequested) {
      this.plan = null;
      this.out.cancelled = true;
      this.finished = true;
      return true;
    }
    if (this.stepsDone >= (this.opts.maxSteps ?? 160)) return this.fail('Simulation stopped: too many steps');
    try {
      if (isGamePhase(this.current.season.phase)) this.weekStep();
      else this.phaseStep();
    } catch (err) {
      return this.fail(err instanceof Error ? err.message : String(err));
    }
    return this.finished;
  }

  /** Runs to completion on this thread (tests, headless tools); a remote simulator is not used. */
  runToEnd(maxUnits = 5000): SimJobResult {
    this.remote = null;
    for (let i = 0; i < maxUnits && !this.step(); i++);
    if (!this.finished) this.fail('Simulation did not finish');
    return this.result;
  }

  private fail(message: string): true {
    this.out.error = message;
    this.plan = null;
    this.finished = true;
    return true;
  }

  private preparePlan(): WeekPlan {
    let prepared = this.current;
    for (const [id, r] of Object.entries(this.userResults ?? {}) as [GameId, UserGameResult][]) prepared = recordUserGameResult(prepared, id, r);
    prepared = healExpired(prepared);
    const pending = gamesThisWeek(prepared).filter((g) => g.result === null);
    return { pending, total: pending.length, done: 0, prepared, cache: new Map(), dispatched: false, failed: null };
  }

  private weekStep(): void {
    this.plan ??= this.preparePlan();
    const plan = this.plan;
    if (this.offThread || plan.dispatched) {
      if (!this.remoteWeekReady(plan)) return;
    } else {
      const game = plan.pending.shift();
      if (game) {
        const setup = buildGameSetup(plan.prepared, game);
        plan.cache.set(game.id, this.simulator(setup, { keepPlayLog: keepsPlayLog(plan.prepared, game) }));
        plan.done++;
        return;
      }
    }
    const cached: GameSimulator = (setup, o) => plan.cache.get(setup.id) ?? this.simulator(setup, o);
    const week = advanceLeagueWeek(this.current, { simulator: cached, ...(this.userResults ? { userResults: this.userResults } : {}) });
    this.userResults = undefined;
    this.plan = null;
    this.current = week.league;
    this.out.weeks.push(week);
    this.stepsDone++;
    this.checkTarget();
    // Keep the workers busy through this week's checkpoint: the next week's games go out first.
    if (!this.finished && !this.cancelRequested && this.offThread && isGamePhase(this.current.season.phase)) {
      this.plan = this.preparePlan();
      this.remoteWeekReady(this.plan);
    }
    this.notify('week');
  }

  /**
   * Remote week: the first call sends every game to the remote simulator; later calls report whether all results
   * are in. A worker failure drops the remote and restarts the week on this thread; a simulation error throws.
   */
  private remoteWeekReady(plan: WeekPlan): boolean {
    const remote = this.remote;
    if (!remote) {
      // The remote was dropped mid-week (runToEnd): simulate this week again on this thread.
      if (plan.done >= plan.total) return true;
      this.plan = null;
      return false;
    }
    if (!plan.dispatched) {
      plan.dispatched = true;
      for (const game of plan.pending.splice(0)) {
        const setup = buildGameSetup(plan.prepared, game);
        remote.simulate(setup, { keepPlayLog: keepsPlayLog(plan.prepared, game) }).then((r) => {
          if (this.plan !== plan) return;
          plan.cache.set(game.id, r);
          plan.done++;
          this.wakeWaiters();
        }, (err: unknown) => {
          if (this.plan === plan) plan.failed ??= err instanceof Error ? err : new Error(String(err));
          this.wakeWaiters();
        });
      }
    }
    const failed = plan.failed;
    if (failed) {
      if (failed instanceof SimWorkerError && failed.kind !== 'simulation') {
        this.remote = null;
        this.plan = null;
        return false;
      }
      throw failed;
    }
    return plan.done >= plan.total;
  }

  private phaseStep(): void {
    if (this.target.kind === 'week') {
      this.fail(`No games are played in the ${this.current.season.phase} phase`);
      return;
    }
    const prev = this.current;
    const r = advanceLeaguePhase(prev, undefined, undefined, { autoFix: this.opts.autoFix ?? false });
    this.current = r.league;
    this.out.phases.push(r);
    this.stepsDone++;
    if (r.league !== prev) this.notify('phase');
    if (r.blockedBy.length > 0) {
      this.out.blockedBy = r.blockedBy;
      this.finished = true;
      return;
    }
    if (this.target.kind === 'nextPhase') this.finished = true;
    else this.checkTarget();
  }

  private notify(kind: 'week' | 'phase'): void {
    try {
      this.opts.onStep?.(this.current, kind);
    } catch {
      // A listener (autosave) must never break the simulation; the result still carries the League.
    }
  }

  private checkTarget(): void {
    const t = this.target;
    if (t.kind === 'week' || t.kind === 'nextPhase') this.finished = true;
    else if (this.current.season.phase === t.phase) this.finished = true;
  }
}

/** True when a job result moved the calendar to another phase. */
export const changedPhase = (before: League, r: SimJobResult): boolean =>
  before.season.phase !== r.league.season.phase || before.season.year !== r.league.season.year;
