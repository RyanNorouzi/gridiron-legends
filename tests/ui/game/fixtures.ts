/**
 * Fixtures for the game-screen tests: a fake LivePlay/engine that dies after N ticks with a scripted outcome,
 * a fake fast sim, a fake playcaller, a session builder over tests/game/fixtures.makeSetup, an autoplay
 * driver that answers every stage, and headless ScreenServices.
 */
import { vi } from 'vitest';
import { DEFAULT_SETTINGS, type Settings } from '@/core/settings';
import { TICK_DT } from '@/core/time';
import { vec2 } from '@/core/vec2';
import { createNullInput } from '@/ui/app';
import { createPlayState } from '@/game/athlete';
import type { LivePlay, LivePlayFactory, LivePlayOptions } from '@/game/engine-api';
import { outcomeAt } from '@/game/outcome-factory';
import type { PlayContext, PlayOutcome, PlayState, ReplayRecording, ReplayStore, UserInputs } from '@/game/play-types';
import { fieldY, type GameSetup } from '@/game/types';
import { createBall } from '@/physics/ball';
import { loadPlaybookData } from '@/playbook/loader';
import { isSpecialPlay } from '@/playbook/special-teams';
import { defaultSettings } from '@/save/settings-store';
import { Camera } from '@/ui/camera';
import { createDefaultPlaycaller } from '@/ui/game/playcaller';
import { createGameSession } from '@/ui/game/session';
import type { GameSession, PlayCall, PlaycallRequest, Playcaller, SessionDeps, SessionEvent, WatchPolicy } from '@/ui/game/session-types';
import { SpriteCache } from '@/ui/render/sprites';
import type { RenderContext, ScreenServices } from '@/ui/screens/screen';
import { ScreenStack } from '@/ui/screens/stack';
import { createTheme } from '@/ui/theme';
import { makeSetup, type SetupOverrides } from '../../game/fixtures';
import { createFakeCtx, type FakeCtx } from '../render/fake-ctx';

export type Script = (ctx: PlayContext) => PlayOutcome;

/** Deterministic outcomes keyed off the context (kickoffs touch back, punts net 42, FGs from 48 in). */
export const baseScript: Script = (ctx) => {
  const side = ctx.offense;
  const b = ctx.ballOn;
  switch (ctx.special) {
    case 'kickoff':
    case 'onside':
      return outcomeAt(b, { result: 'kickoff', kickDistance: 65, endBallOn: 100, events: [{ type: 'touchback', tick: 240 }], timeElapsed: 5 }, side);
    case 'punt':
      return outcomeAt(b, { result: 'punt', kickDistance: 42, endBallOn: Math.min(100, b + 42), timeElapsed: 6 }, side);
    case 'fieldGoal':
      return outcomeAt(b, { result: 'fieldGoal', kickMade: 100 - b + 17 <= 48, kickDistance: 100 - b + 17, timeElapsed: 5 }, side);
    case 'extraPoint':
      return outcomeAt(b, { result: 'extraPoint', kickMade: true, timeElapsed: 4 }, side);
    case 'twoPoint':
      return outcomeAt(b, { result: 'run', endBallOn: 99, timeElapsed: 4 }, side);
    default: {
      const i = ctx.playIndex % 5;
      if (i === 0) return outcomeAt(b, { result: 'incomplete', incomplete: true, timeElapsed: 5 }, side);
      const yards = i === 1 ? 4 : i === 2 ? 11 : i === 3 ? 3 : 14;
      const touchdown = b + yards >= 100;
      return outcomeAt(b, { result: i % 2 === 0 ? 'pass' : 'run', yards, touchdown, timeElapsed: 6, firstDown: yards >= ctx.distance }, side);
    }
  }
};

/** Every scrimmage play is an incompletion (three-and-outs), kicks as in baseScript. */
export const incompleteScript: Script = (ctx) => (ctx.special === 'none' ? outcomeAt(ctx.ballOn, { result: 'incomplete', incomplete: true, timeElapsed: 5 }, ctx.offense) : baseScript(ctx));

export class FakeLivePlay implements LivePlay {
  readonly state: PlayState;
  readonly inputs: UserInputs[] = [];
  private dead = false;
  private out: PlayOutcome | null = null;

  constructor(readonly ctx: PlayContext, private readonly ticksToDead: number, private readonly script: Script, readonly opts: LivePlayOptions = {}) {
    const losY = fieldY(ctx.ballOn, ctx.direction);
    this.state = createPlayState(ctx, [], createBall(vec2(ctx.ballX, losY), 'snap'), { losY, firstDownY: losY + ctx.direction * ctx.distance, recordFrames: opts.recordFrames });
  }

  get isDead(): boolean { return this.dead; }
  get outcome(): PlayOutcome | null { return this.out; }

  tick(inputs?: UserInputs): void {
    if (this.dead) return;
    if (inputs) this.inputs.push(inputs);
    const s = this.state;
    s.tick += 1;
    s.time += TICK_DT;
    if (s.tick === 1) {
      s.phase = 'live';
      s.snapTick = 1;
      s.events.push({ type: 'snap', tick: 1 });
    }
    if (s.tick >= this.ticksToDead) {
      this.dead = true;
      s.phase = 'dead';
      const out = this.script(this.ctx);
      if (this.opts.recordFrames && this.opts.replayStore) {
        const rec: ReplayRecording = {
          id: `rec:${this.ctx.playIndex}`, playIndex: this.ctx.playIndex, tickRate: 60, snapTick: 1, direction: this.ctx.direction, losY: s.losY, firstDownY: s.firstDownY,
          athletes: [], frames: [{ tick: 0, athletes: [], ball: { x: s.ball.pos.x, y: s.ball.pos.y, z: 0, phase: 'presnap' } }, { tick: 1, athletes: [], ball: { x: s.ball.pos.x, y: s.ball.pos.y + 3, z: 0, phase: 'held' } }], events: [],
        };
        this.opts.replayStore.push(rec);
        out.replayId = rec.id;
      }
      this.out = out;
      s.outcome = out;
    }
  }

  run(inputs?: (state: PlayState) => UserInputs, maxTicks = 1000): PlayOutcome {
    for (let i = 0; i < maxTicks && !this.dead; i++) this.tick(inputs?.(this.state));
    if (!this.out) throw new Error('FakeLivePlay: exceeded maxTicks');
    return this.out;
  }
}

/** Fixed-choice playcaller: kicks when kicking, extra point after scores, punt/FG on 4th, else pass-curl / cover3. */
export const fakePlaycaller = (): Playcaller => {
  const real = createDefaultPlaycaller();
  return {
    callOffense: (state, plays) => {
      const find = (pred: (p: (typeof plays)[number]) => boolean) => plays.find(pred) ?? null;
      if (state.kickoffPending) return find((p) => p.concept === 'kickoff') ?? plays[0]!;
      if (state.patPending) return find((p) => p.concept === 'extraPoint') ?? plays[0]!;
      if (state.down === 4) return (state.ballOn >= 65 ? find((p) => p.concept === 'fieldGoal') : find((p) => p.concept === 'punt')) ?? plays[0]!;
      return find((p) => p.id === 'pass-curl') ?? find((p) => isSpecialPlay(p) === 'none') ?? plays[0]!;
    },
    callDefense: (_state, plays, _rng, _coach, off) => {
      const special = off ? isSpecialPlay(off) : 'none';
      if (special === 'kickoff' || special === 'onside') return plays.find((p) => p.tags.includes('kickReturn')) ?? plays[0]!;
      if (special === 'punt') return plays.find((p) => p.tags.includes('puntReturn')) ?? plays[0]!;
      return plays.find((p) => p.id === 'cover3') ?? plays[0]!;
    },
    suggestOffense: (_s, plays) => plays[0] ?? null,
    suggestDefense: (_s, plays) => plays[0] ?? null,
    specialOptions: (state, plays) => real.specialOptions(state, plays),
  };
};

export const memoryReplayStore = (): ReplayStore & { recs: ReplayRecording[] } => {
  const recs: ReplayRecording[] = [];
  return { retention: 'game', recs, push: (r) => { recs.push(r); }, get: (id) => recs.find((r) => r.id === id) ?? null, last: () => recs[recs.length - 1] ?? null, clear: () => { recs.length = 0; } };
};

export interface SessionFixtureOptions {
  setup?: SetupOverrides;
  settings?: Partial<Settings>;
  ticksToDead?: number;
  script?: Script;
  playcaller?: Playcaller;
  holdSeconds?: number;
  watchPolicy?: WatchPolicy;
}

export interface SessionFixture {
  session: GameSession;
  setup: GameSetup;
  settings: Settings;
  plays: FakeLivePlay[];
  fastSim: ReturnType<typeof vi.fn<(ctx: PlayContext) => PlayOutcome>>;
  events: SessionEvent[];
  deps: SessionDeps;
}

export const makeSession = (o: SessionFixtureOptions = {}): SessionFixture => {
  const settings: Settings = { ...defaultSettings(), ...o.settings };
  const script = o.script ?? baseScript;
  const plays: FakeLivePlay[] = [];
  const engine: LivePlayFactory = (ctx, opts) => {
    const p = new FakeLivePlay(ctx, o.ticksToDead ?? 4, script, opts);
    plays.push(p);
    return p;
  };
  const fastSim = vi.fn((ctx: PlayContext) => script(ctx));
  const events: SessionEvent[] = [];
  const deps: SessionDeps = {
    engine, fastSim, playcaller: o.playcaller ?? fakePlaycaller(), registry: loadPlaybookData(), replayStore: memoryReplayStore(), settings,
    holdSeconds: o.holdSeconds ?? 2, onEvent: (e) => events.push(e), watchPolicy: o.watchPolicy,
  };
  const setup = makeSetup(o.setup);
  return { session: createGameSession(setup, deps), setup, settings, plays, fastSim, events, deps };
};

/** Sensible human offense call: punt / XP / kickoff when offered, else the first regular play. */
export const defaultOffenseCall = (req: PlaycallRequest): PlayCall => {
  const opt = (id: string) => req.special.find((o) => o.id === id)?.playId ?? null;
  if (req.situation.down === 4 && req.situation.kind === 'scrimmage') {
    const kick = opt('fieldGoal') && req.situation.ballOn >= 65 ? opt('fieldGoal') : opt('punt');
    if (kick) return { offensivePlayId: kick };
  }
  const xp = opt('extraPoint');
  if (xp) return { offensivePlayId: xp };
  const ko = opt('kickoff');
  if (ko) return { offensivePlayId: ko };
  return { offensivePlayId: req.offensePlays[0]!.id };
};

export interface AutoplayOptions {
  until: (s: GameSession) => boolean;
  maxSteps?: number;
  inputs?: UserInputs;
  offense?: (req: PlaycallRequest) => PlayCall;
  defense?: (req: PlaycallRequest) => PlayCall;
  coinToss?: 'kick' | 'receive' | 'defer';
  watch?: boolean;
}

/** Drives the session, answering every stage, until `until` holds (or the game ends). Returns steps taken. */
export const autoplay = (session: GameSession, opts: AutoplayOptions): number => {
  const max = opts.maxSteps ?? 20000;
  for (let i = 0; i < max; i++) {
    if (opts.until(session)) return i;
    const stage = session.stage;
    switch (stage.kind) {
      case 'pregame': session.start(); break;
      case 'coinToss': session.answerCoinToss(opts.coinToss ?? 'receive'); break;
      case 'playcall':
        session.callPlay(stage.request.unit === 'offense'
          ? (opts.offense?.(stage.request) ?? defaultOffenseCall(stage.request))
          : (opts.defense?.(stage.request) ?? { defensivePlayId: stage.request.defensePlays[0]!.id }));
        break;
      case 'live': session.tick(opts.inputs); break;
      case 'penalty': session.answerPenalty(true); break;
      case 'freeKick': session.answerFreeKick('kick'); break;
      case 'watchPrompt': session.answerWatchPrompt(opts.watch ?? false); break;
      case 'postPlay':
      case 'intermission': session.update(10); break;
      case 'final': return i;
    }
  }
  throw new Error(`autoplay: condition not reached after ${max} steps (stage ${session.stage.kind})`);
};

export interface HeadlessUi {
  services: ScreenServices;
  stack: ScreenStack;
  rc: RenderContext;
  ctx: FakeCtx;
  toast: ReturnType<typeof vi.fn>;
  settings: Settings;
}

/** Screen services with a null input manager, a fake context and no audio. */
export const makeUi = (settingsOverride: Partial<Settings> = {}): HeadlessUi => {
  const settings: Settings = { ...defaultSettings(), ...settingsOverride };
  const stack = new ScreenStack({ fadeSeconds: 0 });
  const toast = vi.fn();
  const theme = createTheme(settings);
  const camera = new Camera(480, 270);
  const sprites = new SpriteCache();
  const services: ScreenServices = { stack, settings, theme, camera, input: createNullInput(), sprites, width: 480, height: 270, time: 0, toast };
  stack.attach(services);
  const ctx = createFakeCtx();
  const rc: RenderContext = { ctx, width: 480, height: 270, alpha: 0.5, theme, settings, camera, sprites, time: 1.2 };
  return { services, stack, rc, ctx, toast, settings };
};

export { DEFAULT_SETTINGS };
