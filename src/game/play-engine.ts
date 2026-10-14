import { TICK_DT } from '@/core/time';
import { dist, len, type Vec2 } from '@/core/vec2';
import { decideIntent } from '@/ai/index';
import { effectiveAttrs } from '@/physics/attributes';
import { deadBall, followCarrier, integrateBall } from '@/physics/ball';
import { findOverlaps, separate } from '@/physics/collision';
import { integrateMovement } from '@/physics/movement';
import { ballCarrier } from './athlete';
import { idleIntent, type AthleteIntent, type DevCommand, type DevHooks, type IntentDecider, type LivePlay, type LivePlayFactory, type LivePlayOptions } from './engine-api';
import { liveRules } from './live-rules';
import { buildOutcome } from './outcome';
import type { AthleteId } from './play-events';
import type { Athlete, PlayContext, PlayOutcome, PlayState, ReplayFrame, UserInputs } from './play-types';
import { recordFrame } from './replay';
import { markClockStart } from './systems/clock-start';
import { createPlay } from './setup';
import { devFavouredSide, kickerApproach, presnapSystem, runDevCommands, runLiveSystems, updateTimers, type EngineEnv } from './systems/index';
import { kickingSystem } from './systems/kicking';
import { beginSettle, cloneForSettle, settleFrames, settleStep, type SettleablePlay, type SettleState } from './systems/post-whistle';
import { FIELD_WIDTH, type TeamSide } from './types';
import { receiverSlotsFor, switchControlled, syncControlToCarrier, userControl } from './user-control';
import { applyCpuEdge, cpuEdgeFor } from './difficulty-sides';

/**
 * Tick-based live play engine (LivePlay). Pipeline per tick:
 *   0. effective attributes (fatigue / weather / injury) for every athlete
 *   1. pre-snap: play clock, audibles, pre-snap fouls, snap (or the kickoff kick)
 *   2. live: intents (user control / AI decider) -> movement -> ball -> systems -> live rules -> frames
 *   3. dead: the outcome is built once and exposed via `outcome`
 *   4. after the whistle (presentation only): `settle()` lets bodies decelerate and the pile go down (systems/post-whistle.ts)
 * Deterministic for a given (ctx, ctx.rng, input sequence). No rendering, no DOM.
 * Developer hooks (LivePlayOptions.dev, src/tools only): queued commands run first in a tick; infiniteStamina and
 * freezeAi are applied here, god mode inside runLiveSystems. With no hooks the pipeline is unchanged.
 */
export const DEFAULT_MAX_TICKS = 60 * 40;
/** Yards a human-controlled defender must keep off the line of scrimmage before the snap. */
export const PRESNAP_NEUTRAL_ZONE = 1;
/** The same limit for an AI defender (a press corner may crowd the line more closely than a human's shift). */
export const AI_PRESNAP_NEUTRAL_ZONE = 0.4;

export class PlayEngine implements LivePlay, SettleablePlay {
  readonly state: PlayState;
  /** Ticks processed so far. */
  stepCount = 0;
  private readonly env: EngineEnv;
  private readonly decider: IntentDecider;
  private readonly slots: string[];
  private built: PlayOutcome | null = null;
  private readonly devQueue: DevCommand[] = [];
  /** Velocities after movement, before the live systems of the latest tick (a tackle that stops a body dead). */
  private readonly preSystemsVel = new Map<AthleteId, Vec2>();
  private settleState: SettleState | null = null;
  /** Copies of the bodies at the whistle (the replay's settle frames are computed from them). */
  private whistle: Athlete[] | null = null;

  constructor(ctx: PlayContext, opts: LivePlayOptions = {}) {
    const { state, env } = createPlay(ctx, opts);
    this.state = state;
    this.env = env;
    this.decider = opts.decider ?? decideIntent;
    this.slots = receiverSlotsFor(state, opts);
  }

  get isDead(): boolean {
    return this.state.phase === 'dead';
  }

  get outcome(): PlayOutcome | null {
    return this.built;
  }

  /** Engine-private bookkeeping, exposed for the dev overlay and tests. Treat as read-only. */
  debugEnv(): EngineEnv {
    return this.env;
  }

  /** Queues a developer command (src/tools); it runs at the start of the next tick (see DevCommand). */
  queueDevCommand(cmd: DevCommand): void {
    this.devQueue.push(cmd);
  }

  /**
   * Attaches (or with null detaches) developer hooks after creation, e.g. when developer mode is switched on while
   * this play is running. Detaching also drops every queued command.
   */
  attachDevHooks(hooks: DevHooks | null): void {
    const opts: LivePlayOptions = { ...this.env.opts };
    if (hooks) opts.dev = hooks;
    else delete opts.dev;
    this.env.opts = opts;
    if (!hooks) this.devQueue.length = 0;
  }

  /** Developer commands still waiting for a live ball. */
  get pendingDevCommands(): readonly DevCommand[] {
    return this.devQueue;
  }

  tick(inputs: UserInputs = {}): void {
    const s = this.state;
    const env = this.env;
    if (s.phase === 'dead') {
      if (!this.built) this.finish();
      return;
    }
    const dt = TICK_DT;
    this.stepCount += 1;
    s.tick += 1;
    s.time += dt;
    env.inputs = inputs;
    if (env.opts.dev || this.devQueue.length > 0) {
      runDevCommands(s, env, this.devQueue);
      // A command may end the play (a recovery that cannot be advanced): finish the tick without moving anyone.
      if (this.isDead) {
        this.finishTick();
        return;
      }
    }
    this.refreshAttrs();
    for (const side of ['home', 'away'] as const) {
      const input = inputs[side];
      if (input && s.ctx.controllers[side] === 'human') switchControlled(s, side, input);
    }
    this.computeIntents(inputs, dt);
    if (s.phase === 'presnap') {
      const depths = this.defenderDepths();
      kickerApproach(s, env);
      this.integrate(dt);
      this.keepOutOfNeutralZone(depths);
      kickingSystem(s, env, dt);
      if (s.phase === 'presnap') presnapSystem(s, env, dt);
      this.finishTick();
      return;
    }
    s.playClock += dt;
    updateTimers(s, env, dt);
    if (s.phase === 'live') {
      kickerApproach(s, env);
      this.integrate(dt);
      this.stepBall(dt);
      this.notePreSystemsVel();
      runLiveSystems(s, env, dt);
      liveRules(s, env, dt);
      markClockStart(s, env);
    }
    this.finishTick();
  }

  run(inputs?: (state: PlayState) => UserInputs, maxTicks = DEFAULT_MAX_TICKS): PlayOutcome {
    let steps = 0;
    while (!this.isDead) {
      if (steps >= maxTicks) throw new Error(`PlayEngine.run: play exceeded ${maxTicks} ticks (phase ${this.state.phase}, ball ${this.state.ball.phase})`);
      this.tick(inputs ? inputs(this.state) : {});
      steps += 1;
    }
    const o = this.built;
    if (!o) throw new Error('PlayEngine.run: dead play without an outcome');
    return o;
  }

  private notePreSystemsVel(): void {
    for (const a of this.state.athletes) {
      const v = this.preSystemsVel.get(a.id);
      if (v) { v.x = a.vel.x; v.y = a.vel.y; } else this.preSystemsVel.set(a.id, { x: a.vel.x, y: a.vel.y });
    }
  }

  /** Team whose stamina the dev hooks keep full (null without the infiniteStamina cheat). */
  private freshSide(): TeamSide | null {
    const dev = this.env.opts.dev;
    return dev?.infiniteStamina ? devFavouredSide(this.state, dev) : null;
  }

  private refreshAttrs(): void {
    const s = this.state;
    const fresh = this.freshSide();
    for (const a of s.athletes) {
      if (fresh !== null && a.teamSide === fresh) a.fatigue = 0;
      // The CPU team's performance edge (All-Pro / Legend vs a human; NO_EDGE otherwise) rides on top of the ratings.
      a.attrs = applyCpuEdge(effectiveAttrs(a.baseAttrs, a.fatigue, s.ctx.weather, this.env.players[a.id]?.injury ?? null), cpuEdgeFor(s.ctx, a.teamSide));
    }
  }

  private computeIntents(inputs: UserInputs, dt: number): void {
    const s = this.state;
    const intents: Record<AthleteId, AthleteIntent> = {};
    const frozen = s.phase === 'live' && this.env.opts.dev?.freezeAi === true;
    for (const a of s.athletes) {
      if (!a.active) {
        intents[a.id] = idleIntent('inactive');
        continue;
      }
      if (a.controlled && s.ctx.controllers[a.teamSide] === 'human') {
        const input = inputs[a.teamSide];
        intents[a.id] = input ? userControl(a, input, s, { receiverSlots: this.slots }) : idleIntent('user');
        continue;
      }
      intents[a.id] = frozen ? idleIntent('dev: frozen') : this.decider(a, s, dt);
    }
    s.intents = intents;
  }

  /** Pre-snap depth (yards on the defense's side of the line) of every active defender, human-controlled or AI. */
  private defenderDepths(): Map<Athlete, number> {
    const s = this.state;
    const out = new Map<Athlete, number>();
    for (const a of s.athletes) if (a.active && a.side === 'defense') out.set(a, s.ctx.direction * (a.pos.y - s.losY));
    return out;
  }

  /**
   * A defender (human or AI) may shift before the snap, but never into the neutral zone or the offense's backfield: he
   * stays PRESNAP_NEUTRAL_ZONE off the ball (or where he lined up, if that was closer), and on the field.
   */
  private keepOutOfNeutralZone(depths: Map<Athlete, number>): void {
    const s = this.state;
    for (const [a, before] of depths) {
      const human = a.controlled && s.ctx.controllers[a.teamSide] === 'human';
      const floor = Math.min(before, human ? PRESNAP_NEUTRAL_ZONE : AI_PRESNAP_NEUTRAL_ZONE);
      if (s.ctx.direction * (a.pos.y - s.losY) < floor) {
        a.pos.y = s.losY + s.ctx.direction * floor;
        a.vel.y = 0;
      }
      a.pos.x = Math.min(FIELD_WIDTH - a.radius, Math.max(a.radius, a.pos.x));
    }
  }

  /** Movement for every active athlete plus a light positional separation of overlapping bodies. */
  private integrate(dt: number): void {
    const s = this.state;
    const carrier = ballCarrier(s);
    for (const a of s.athletes) {
      if (!a.active) continue;
      integrateMovement(a, s.intents[a.id] ?? idleIntent(), dt, s.ctx.weather);
    }
    for (const o of findOverlaps(s.athletes)) {
      if (o.a.state === 'engaged' || o.b.state === 'engaged') continue;
      if (o.a.state === 'presnap' && o.b.state === 'presnap') continue;
      if (carrier && (o.a.id === carrier.id || o.b.id === carrier.id) && o.a.side === o.b.side) continue;
      separate(o.a, o.b, o.penetration * 0.5, o.normal);
    }
  }

  private stepBall(dt: number): void {
    const s = this.state;
    const env = this.env;
    const ball = s.ball;
    if (ball.phase === 'held') {
      const carrier = ballCarrier(s);
      if (carrier) followCarrier(ball, carrier);
      env.ballStep = { hitGround: false, bounced: false, settled: false };
      return;
    }
    if (ball.phase === 'inAir' || ball.phase === 'loose') env.ballStep = integrateBall(ball, dt, s.ctx.weather, env.rng);
    else env.ballStep = { hitGround: false, bounced: false, settled: false };
  }

  private updateTracks(dt: number): void {
    const s = this.state;
    for (const a of s.athletes) {
      const t = this.env.tracks[a.id];
      if (!t) continue;
      t.distance += dist(t.prev, a.pos);
      const it = s.intents[a.id];
      if (it && it.sprint && it.locomotion === 'run' && len(it.move) > 0.05 && a.burst > 0 && a.active) t.sprintSeconds += dt;
      t.prev.x = a.pos.x;
      t.prev.y = a.pos.y;
    }
  }

  private finishTick(): void {
    const s = this.state;
    this.updateTracks(TICK_DT);
    const fresh = this.freshSide();
    if (fresh !== null) for (const a of s.athletes) if (a.teamSide === fresh) a.burst = 1;
    const kickPending = s.kickMeter !== null && this.env.kick === null;
    for (const side of ['home', 'away'] as const) syncControlToCarrier(s, side as TeamSide, kickPending);
    recordFrame(s);
    if (s.phase === 'dead' && !this.built) this.finish();
  }

  /**
   * One post-whistle tick (presentation only, see systems/post-whistle.ts): bodies keep their momentum, decelerate
   * and the pile goes to the ground. Never touches the outcome, the ball, the clock, state.tick or env.rng. Returns
   * true while anything is still moving; false before the whistle and once everyone is at rest.
   */
  settle(): boolean {
    if (!this.built) return false;
    if (!this.settleState) this.settleState = this.startSettle(this.state.athletes);
    return settleStep(this.state.athletes, this.settleState, TICK_DT);
  }

  /** True once the play is dead and its bodies have come to rest. */
  get settled(): boolean {
    return this.settleState?.done ?? false;
  }

  /**
   * The whole post-whistle settle as replay frames (ticks after the dead tick), run on copies of the bodies as they
   * were at the whistle: frame for frame what `settle()` shows. Empty before the whistle.
   */
  settleFrames(): ReplayFrame[] {
    const s = this.state;
    if (!this.whistle || !this.built) return [];
    const copy = cloneForSettle(this.whistle);
    return settleFrames(copy, this.startSettle(copy), TICK_DT, s.tick + 1, { x: s.ball.pos.x, y: s.ball.pos.y, z: s.ball.z, phase: s.ball.phase });
  }

  private startSettle(athletes: Athlete[]): SettleState {
    return beginSettle(athletes, this.state.ball.carrierId, this.state.ball.pos, this.preSystemsVel);
  }

  private finish(): void {
    const s = this.state;
    s.ball = deadBall(s.ball);
    // The outcome is built from motionless bodies exactly as before; the velocities come back afterwards so nobody
    // freezes on the whistle (settle() then brings them to rest, presentation only).
    const moving = s.athletes.map((a) => a.vel);
    for (const a of s.athletes) {
      a.vel = { x: 0, y: 0 };
      if (this.env.injuredIds.has(a.id)) a.active = false;
    }
    this.built = buildOutcome(s, this.env);
    const fresh = this.freshSide();
    if (fresh !== null) {
      const rested = s.athletes.filter((a) => a.teamSide === fresh).map((a) => a.playerId);
      for (const o of [this.built, this.built.review?.ifOverturned]) if (o) for (const id of rested) o.fatigueAfter[id] = 0;
    }
    s.outcome = this.built;
    s.athletes.forEach((a, i) => { a.vel = { ...(moving[i] ?? a.vel) }; });
    this.whistle = cloneForSettle(s.athletes);
  }
}

/** LivePlayFactory implementation: `createPlayEngine(ctx, opts)`. */
export const createPlayEngine: LivePlayFactory = (ctx, opts) => new PlayEngine(ctx, opts);
