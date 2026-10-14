/**
 * DrillRep: one headless rep of a drill. Creates the live play for a scenario through the LivePlayFactory
 * (createPlayEngine by default) with the practice decider, feeds the user's per-tick input (engine control or
 * puppet), measures kick flights, and asks the drill's evaluator for a verdict every tick. A rep finishes when the
 * play is dead, or `settleSeconds` after an early verdict (the catch, the kick), or at the safety time cap.
 * Deterministic for a given scenario and input sequence; no rendering.
 */
import { createRng } from '@/core/rng';
import { TICK_DT } from '@/core/time';
import { decideIntent } from '@/ai/index';
import { predictLanding } from '@/physics/ball';
import type { IntentDecider, LivePlay, LivePlayFactory } from '../engine-api';
import type { AthleteId } from '../play-events';
import { createPlayEngine } from '../play-engine';
import type { PlayState, UserPlayInput } from '../play-types';
import { EVALUATORS, fail } from './evaluators';
import type { DrillScenario } from './scenarios';
import { createPracticeDecider, focusFor, stageRep } from './scripts';
import { emptyMetrics, type RepEvidence, type RepMetrics, type RepVerdict } from './types';

/** Safety cap: a rep nobody finishes (a quarterback who never throws) is called after this many seconds. */
export const MAX_REP_SECONDS = 40;

/** Injectable executors for a rep (tests swap the engine or the AI). */
export interface DrillRepDeps {
  /** Live play factory (default: the real PlayEngine). */
  engine?: LivePlayFactory;
  /** Base AI decider under the drill scripts (default: ai/index decideIntent; registerAll() must have run). */
  ai?: IntentDecider;
  recordFrames?: boolean;
}

/** One headless rep of a drill (see the file header). */
export class DrillRep {
  readonly play: LivePlay;
  readonly puppetId: AthleteId | null;
  readonly metrics: RepMetrics = emptyMetrics();
  private readonly focus: AthleteId | null;
  private readonly users: AthleteId[] = [];
  private input: UserPlayInput | null = null;
  private verdictValue: RepVerdict | null = null;
  private decidedTick: number | null = null;
  private done = false;
  private ticks = 0;

  constructor(readonly scenario: DrillScenario, deps: DrillRepDeps = {}) {
    let focusRef: AthleteId | null = null;
    let puppetRef: AthleteId | null = null;
    const decider = createPracticeDecider({
      scenario,
      rng: createRng(scenario.seed).fork('script'),
      base: deps.ai ?? decideIntent,
      userInput: () => this.input,
      get puppetId() { return puppetRef; },
      focusId: () => focusRef,
    });
    const factory = deps.engine ?? createPlayEngine;
    this.play = factory(scenario.ctx, { registries: scenario.registries, decider, recordFrames: deps.recordFrames ?? false });
    puppetRef = stageRep(this.play.state, scenario);
    this.puppetId = puppetRef;
    focusRef = focusFor(this.play.state, scenario, puppetRef);
    this.focus = focusRef;
    this.trackUser();
  }

  get state(): PlayState {
    return this.play.state;
  }

  /** The athlete the drill is about: primary read, JUGS receiver or the covered receiver. */
  get focusId(): AthleteId | null {
    return this.focus;
  }

  /** Every athlete the user has controlled so far. */
  get userIds(): readonly AthleteId[] {
    return this.users;
  }

  get verdict(): RepVerdict | null {
    return this.verdictValue;
  }

  get finished(): boolean {
    return this.done;
  }

  /** Seconds since the rep started. */
  get elapsed(): number {
    return this.ticks * TICK_DT;
  }

  /** The evidence the evaluator sees right now. */
  evidence(): RepEvidence {
    const s = this.play.state;
    return {
      events: s.events, outcome: this.play.outcome, userIds: this.users, focusId: this.focus, startBallOn: s.ctx.ballOn,
      losY: s.losY, direction: s.ctx.direction, ballX: s.ctx.ballX, metrics: this.metrics,
    };
  }

  /** Advances one fixed tick with the user's input (null = nothing pressed). */
  tick(input: UserPlayInput | null = null): void {
    if (this.done) return;
    const sc = this.scenario;
    this.ticks += 1;
    if (sc.def.control === 'engine') this.play.tick(input ? { [sc.userSide]: input } : {});
    else {
      this.input = input;
      this.play.tick({});
    }
    this.trackUser();
    this.measure();
    this.judge();
  }

  /** Runs to the end with an input provider (tests, auto-play). */
  run(inputs: (state: PlayState, rep: DrillRep) => UserPlayInput | null = () => null, maxTicks = Math.ceil(MAX_REP_SECONDS / TICK_DT) + 10): RepVerdict {
    for (let i = 0; i < maxTicks && !this.done; i++) this.tick(inputs(this.play.state, this));
    if (!this.verdictValue) throw new Error('DrillRep.run: rep did not finish');
    return this.verdictValue;
  }

  private trackUser(): void {
    const id = this.play.state.controlledIds[this.scenario.userSide] ?? this.play.state.controlledId;
    if (id && !this.users.includes(id)) this.users.push(id);
  }

  /** Kick flights: hang time and landing spot, predicted once at the kick. */
  private measure(): void {
    const s = this.play.state;
    const ball = s.ball;
    if (this.metrics.hangTime !== null || ball.phase !== 'inAir' || (ball.kind !== 'punt' && ball.kind !== 'fieldGoal' && ball.kind !== 'kickoff')) return;
    const landing = predictLanding(ball, s.ctx.weather, 0);
    this.metrics.hangTime = (s.tick - ball.launchTick + landing.ticks) * TICK_DT;
    this.metrics.landingX = landing.pos.x;
    this.metrics.landingY = landing.pos.y;
  }

  private judge(): void {
    const sc = this.scenario;
    const s = this.play.state;
    if (!this.verdictValue) {
      const v = EVALUATORS[sc.def.evaluator](this.evidence(), sc.level, sc.def, sc.options);
      if (v) {
        this.verdictValue = v;
        this.decidedTick = s.tick;
      }
    }
    if (this.play.isDead) {
      this.verdictValue ??= fail('NO RESULT', 'The rep ended without a result');
      this.done = true;
      return;
    }
    if (this.verdictValue && this.decidedTick !== null && (s.tick - this.decidedTick) * TICK_DT >= sc.def.settleSeconds) {
      this.done = true;
      return;
    }
    if (this.elapsed >= MAX_REP_SECONDS) {
      this.verdictValue ??= fail('TIME', 'Too slow - make a play');
      this.done = true;
    }
  }
}
