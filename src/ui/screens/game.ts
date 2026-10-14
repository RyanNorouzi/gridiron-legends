/**
 * Game screen: integrates the session with the loop. Each fixed tick it consumes the InputState, builds the
 * UserPlayInput for the human side and advances the session; each frame it draws the field view, HUD, kick
 * meter, pull-back pass aim, banners, watch status and touch overlay. It pushes the PlayCall screen when the human must call,
 * modal prompts for decisions (coin toss, penalty, free kick, watch "jump in?"), the pause overlay, replays
 * (the post-play card's REPLAY / REVIEW, with the challenge flag available from the replay while the window is
 * open), the game's highlight reel and finally the post-game screen. The post-play buttons are tappable. After the
 * whistle the dead play keeps settling on the render clock (nobody freezes, even under prompts) and hit sticks shake
 * the camera briefly (never a hit-stop; off under reduced motion or with screen shake off).
 * In developer mode only (Settings.devMode or ?dev=1, see tools/dev-state), devToggle opens the dev console,
 * devOverlayCycle cycles the debug overlays drawn over the field, and the session's engines receive the shared
 * DevHooks.
 */
import { vec2, type Vec2 } from '@/core/vec2';
import { findAthlete } from '@/game/athlete';
import type { ReplayRecording } from '@/game/play-types';
import type { DevHooks } from '@/game/engine-api';
import { PlayEngine } from '@/game/play-engine';
import { fieldY, type GameState } from '@/game/types';
import { DevController } from '@/tools/dev-controller';
import { browserLocationSearch, isDevModeEnabled, overlayLabel, type LocationReader } from '@/tools/dev-state';
import { buildOverlayModel, drawDevBadge, drawOverlays } from '@/tools/overlays';
import { createCameraDirector, tapRadiusFor, type CameraDirector, type DirectorFrame } from '../game/camera-director';
import { BannerQueue, drawBanner, timeoutNotice } from '../game/banners';
import { attachSettleFrames, DeadBallMotion, HIT_SHAKE, ImpactFeedback } from '../game/dead-ball-motion';
import { drawScene, lightingFor, sceneFromPlay, southTeamFor, type FieldScene } from '../game/field-view';
import { GameSpeedGate } from '../game/game-speed';
import { HighlightReel } from '../game/highlights';
import { buildHudData, drawHud } from '../game/hud';
import { drawKickMeter } from '../game/kick-meter-view';
import { buildPlayInput, createThrowHold, dropThrowHold, type ThrowHoldState } from '../game/play-input';
import { renderThrowAim } from '../game/throw-aim-view';
import { aimGlyph } from '../tutorial/prompts';
import { gameHints, touchContextFor } from '../game/game-hints';
import { recordingFor, replayTitleFor } from '../game/postplay-controls';
import { playCaption } from '../game/session-flow';
import type { ChallengePrompt, GameSession, SessionStage } from '../game/session-types';
import { captionWidthClearOf, drawTouchOverlay, receiverGlyphs, shouldShowTouch, touchLabelsFor } from '../game/touch-overlay';
import { ToggleLatch } from '../input/hold-toggle';
import type { InputManager, InputState } from '../input/types';
import type { TouchLayout } from '../input/touch';
import { resolveTeamPalettes, type ResolvedPalettes } from '../render/palette';
import { stadiumViewFor } from '../render/stadium';
import { drawText } from '../render/text';
import type { Theme } from '../theme';
import { pixelLine } from '../game/pixel-draw';
import { drawHintButtons, hintRowHeight, hitHintButton, type HintRect } from '../widgets/hint-buttons';
import { DevConsoleScreen } from './dev-console';
import { HighlightsScreen } from './highlights';
import { PauseScreen } from './pause';
import { PlayCallScreen } from './playcall';
import { PostGameScreen } from './post-game';
import { ReplayScreen, type ReplayViewOptions } from './replay';
import type { RenderContext, Screen, ScreenServices } from './screen';
import { promptForStage } from './stage-prompts';
import { SubstitutionsScreen } from './substitutions';
import { drawSpeedBadge, drawWatchStatus, PromptScreen, type PromptOptions } from './watch';

export interface GameScreenOptions {
  onQuit: () => void;
  onPlayAgain: () => void;
  onSettings?: () => void;
  /** Pause-menu warning while quit awaits its second press (default: the unsaved-game warning). */
  quitWarning?: string;
  /** Query-string reader for the ?dev=1 switch (default: the browser location). */
  locationSearch?: LocationReader;
}

/** Seconds the watch-mode "JUMP IN?" prompt waits before simulating on its own. */
export const WATCH_PROMPT_SECONDS = 6;

/** Screen y of the developer-mode status badge (top right, under the watch speed badge). */
export const devBadgeY = (theme: Theme): number => theme.pad + theme.lineHeight + theme.gap;

/** Touch layout of the manager's touch source, when the manager exposes its sources. */
export const touchLayoutOf = (input: InputManager): TouchLayout | null => {
  const sources = (input as { sources?: readonly { device: string; layout?: () => TouchLayout }[] }).sources;
  const touch = sources?.find((s) => s.device === 'touch');
  return touch?.layout ? touch.layout() : null;
};

/** Scene for the spot of the next snap when no play is being shown. */
export const emptyScene = (state: GameState): FieldScene => {
  const losY = fieldY(state.ballOn, state.direction);
  return {
    athletes: [], ball: { x: state.ballX, y: losY, z: 0, phase: 'dead', carrierId: null }, losY, firstDownY: losY + state.direction * state.distance,
    direction: state.direction, controlledId: null, presnap: false, snapX: state.ballX, southTeam: southTeamFor(state.possession, state.direction),
  };
};

export class GameScreen implements Screen {
  readonly id = 'game';
  private services: ScreenServices | null = null;
  private palettes: ResolvedPalettes | null = null;
  private director: CameraDirector | null = null;
  private readonly banners = new BannerQueue();
  private readonly throwHold: ThrowHoldState = createThrowHold();
  private unsubscribe: (() => void) | null = null;
  private lastPbp: string | null = null;
  private shownStage: SessionStage | null = null;
  /** The user's NO HUDDLE choice, kept for the rest of a drive (reset by any non-scrimmage offensive call). */
  private noHuddle: { side: string; on: boolean } = { side: '', on: false };
  private playArtHeld = false;
  private lastDevice: InputState['lastDevice'] = 'keyboard';
  private dev: DevController | null = null;
  /** Last world point under the pointer (dev teleport target / attribute pick). */
  private devCursor: Vec2 | null = null;
  private hintRects: HintRect[] = [];
  private readonly speedGate = new GameSpeedGate();
  private readonly sprintLatch = new ToggleLatch();
  private readonly deadBall = new DeadBallMotion();
  private readonly impacts = new ImpactFeedback();
  /** This game's highlights (kept as the plays end; the replay store only keeps the current drive). */
  readonly highlights = new HighlightReel();

  constructor(readonly session: GameSession, private readonly opts: GameScreenOptions) {}

  get bannerQueue(): BannerQueue {
    return this.banners;
  }

  /** True while sprint is latched on (sprint-toggle accessibility option). */
  get sprintLatched(): boolean {
    return this.sprintLatch.isOn('sprint');
  }

  /** The developer-mode controller; null whenever developer mode is off. */
  get devController(): DevController | null {
    return this.dev;
  }

  /** Creates / drops the dev controller as developer mode turns on / off and keeps the session's hooks in step. */
  private syncDev(services: ScreenServices): DevController | null {
    const on = isDevModeEnabled(services.settings, (this.opts.locationSearch ?? browserLocationSearch)());
    if (on && !this.dev) {
      this.dev = new DevController(true);
      this.session.setDevHooks?.(this.dev.hooks);
      this.attachToLivePlay(this.dev.hooks);
    } else if (!on && this.dev) {
      this.dev.disable();
      this.session.setDevHooks?.(null);
      this.attachToLivePlay(null);
      this.dev = null;
      this.devCursor = null;
    }
    this.dev?.setFavouredSide(this.session.userSide);
    return this.dev;
  }

  /** The play already running when developer mode flips picks the hooks up too (later plays get them from the session). */
  private attachToLivePlay(hooks: DevHooks | null): void {
    const stage = this.session.stage;
    if (stage.kind === 'live' && stage.play instanceof PlayEngine) stage.play.attachDevHooks(hooks);
  }

  /** Pushes the dev console (developer mode only); false when it is off. */
  openDevConsole(services: ScreenServices): boolean {
    const dev = this.dev;
    if (!dev || !dev.enabled) return false;
    const session = this.session;
    services.stack.push(new DevConsoleScreen({
      controller: dev,
      session,
      game: () => session.state,
      play: () => session.displayPlay?.state ?? null,
      live: () => session.stage.kind === 'live' && !session.stage.play.isDead,
      cursor: () => this.devCursor,
      names: { home: session.setup.home.team.abbr, away: session.setup.away.team.abbr },
    }));
    return true;
  }

  private updateDev(dev: DevController, input: InputState, services: ScreenServices): boolean {
    const p = input.pointer;
    if (p && (input.lastDevice === 'mouse' || input.lastDevice === 'touch')) this.devCursor = services.camera.screenToWorld(vec2(p.x, p.y));
    if (input.justPressed.has('devToggle')) return this.openDevConsole(services);
    if (input.justPressed.has('devOverlayCycle')) {
      dev.cycleOverlays();
      services.toast(`OVERLAYS ${overlayLabel(dev.state)}`, 1.2);
    }
    return false;
  }

  enter(services: ScreenServices): void {
    this.services = services;
    const { home, away } = this.session.setup;
    this.palettes = resolveTeamPalettes(home.team.colors, away.team.colors, services.settings.colorblind);
    this.director = createCameraDirector(services.camera, services.settings);
    this.syncDev(services);
    this.unsubscribe = this.session.subscribe((e) => {
      if (e.type === 'banner') this.banners.push({ text: e.text, sub: e.sub, tone: e.tone });
      else if (e.type === 'stage') this.onStage(e.stage);
    });
    services.audio?.setCrowdSide('home');
    services.audio?.crowd(0.5);
    if (this.session.stage.kind === 'pregame') this.session.start();
  }

  /**
   * Stage changes: a new snap drops every banner left over from earlier plays (a queued FIRST DOWN or SACK must
   * never show over the next play), and a finished play sets the caption to a description of that play.
   */
  private onStage(stage: SessionStage): void {
    if (stage.kind === 'live') this.banners.clear();
    else if (stage.kind === 'postPlay') {
      this.lastPbp = playCaption(this.session.setup, stage.summary);
      const rec = this.session.lastReplay();
      attachSettleFrames(rec, this.session.displayPlay);
      this.highlights.offer(stage.summary.entry, recordingFor(stage.summary, rec));
    }
  }

  /** The caption line under the HUD (a description of the last finished play). */
  get caption(): string | null {
    return this.lastPbp;
  }

  /** Back on top (e.g. after a replay): re-frame the view at once; drop any throw hold / aim from before (no stray throw). */
  resume(): void {
    this.director?.invalidate();
    dropThrowHold(this.throwHold);
  }

  exit(services: ScreenServices): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    services.audio?.stop();
    this.services = null;
  }

  /* -------------------------------------- update -------------------------------------- */

  private canTimeout(): boolean {
    const side = this.session.userSide;
    const s = this.session.state;
    const k = this.session.stage.kind;
    return side !== null && s.controllers[side] === 'human' && s.timeouts[side] > 0 && k !== 'final' && k !== 'pregame' && k !== 'coinToss' && k !== 'penalty';
  }

  openPause(services: ScreenServices): void {
    const session = this.session;
    const watchToggle = session.userSide && session.setup.controllers[session.userSide] === 'watch'
      ? () => (session.watching ? session.jumpIn() : session.resumeWatching())
      : undefined;
    services.stack.push(new PauseScreen({
      hasReplay: () => session.lastReplay() !== null,
      onReplay: () => this.openReplay(services),
      hasHighlights: () => this.highlights.size > 0,
      onHighlights: () => this.openHighlights(services),
      canTimeout: () => this.canTimeout(),
      onTimeout: () => session.callTimeout(),
      onSettings: () => this.opts.onSettings?.(),
      ...(session.userSide && session.state.controllers[session.userSide] === 'human' && session.substitute ? { onSubstitutions: () => services.stack.push(new SubstitutionsScreen(session)) } : {}),
      onQuit: () => this.opts.onQuit(),
      ...(this.opts.quitWarning ? { quitWarning: this.opts.quitWarning } : {}),
      ...(watchToggle ? { onToggleWatch: watchToggle, watchLabel: () => (session.watching ? 'JUMP IN' : 'BACK TO WATCHING') } : {}),
    }));
  }

  /**
   * Replays `recording` (default: the last play). While the post-play challenge window is open the replay also
   * offers the flag, so the coach can review the play before deciding.
   */
  openReplay(services: ScreenServices, recording?: ReplayRecording, title?: string): boolean {
    const session = this.session;
    const rec = recording ?? session.lastReplay();
    if (!rec || !this.palettes) return false;
    const { setup, state } = session;
    const stage = session.stage;
    const opts: ReplayViewOptions = {
      palettes: this.palettes, fieldType: setup.stadium.fieldType, weather: state.weather, homeAbbr: setup.home.team.abbr, awayAbbr: setup.away.team.abbr, userSide: session.userSide,
      stadium: stadiumViewFor(setup, this.palettes), lighting: lightingFor(setup.stadium.roof, state.weather?.type ?? null, String(setup.id)),
    };
    if (title) opts.title = title;
    else if (stage.kind === 'postPlay' && recordingFor(stage.summary, rec)) opts.title = replayTitleFor(stage.summary);
    if (!recording && stage.kind === 'postPlay' && stage.challenge) {
      const current = (): ChallengePrompt | null => (session.stage === stage ? stage.challenge : null);
      opts.challenge = { available: () => current() !== null, onChallenge: () => session.challenge(), secondsLeft: () => current()?.remainingSec ?? null };
    }
    services.stack.push(new ReplayScreen(rec, opts));
    return true;
  }

  /** The highlight reel (pause menu); each entry plays in the replay screen. */
  openHighlights(services: ScreenServices): void {
    services.stack.push(new HighlightsScreen({
      highlights: () => this.highlights.list,
      onPlay: (h) => { this.openReplay(services, h.recording, `${h.title} · ${h.detail}`); },
    }));
  }

  /** Runs a post-play button (keyboard, gamepad, mouse and touch all land here). */
  private postPlayControl(id: string, stage: Extract<SessionStage, { kind: 'postPlay' }>, services: ScreenServices): void {
    if (id === 'continue') this.session.continue();
    else if (id === 'challenge' && stage.challenge) {
      if (!this.session.challenge()) services.toast('No challenge available');
    } else if (id === 'replay') this.openReplay(services);
  }

  private showPrompt(stage: SessionStage, services: ScreenServices, prompt: PromptOptions): void {
    if (this.shownStage === stage) return;
    this.shownStage = stage;
    services.stack.push(new PromptScreen(prompt));
  }

  private handleStage(stage: SessionStage, input: InputState, services: ScreenServices): void {
    const session = this.session;
    switch (stage.kind) {
      case 'coinToss':
      case 'penalty':
      case 'freeKick':
      case 'watchPrompt': {
        const prompt = promptForStage(stage, session, WATCH_PROMPT_SECONDS);
        if (prompt) this.showPrompt(stage, services, prompt);
        break;
      }
      case 'playcall':
        if (this.shownStage !== stage) {
          this.shownStage = stage;
          if (stage.request.unit !== 'offense' || stage.request.situation.kind !== 'scrimmage') this.noHuddle = { side: '', on: false };
          services.stack.push(new PlayCallScreen(stage.request, session.registry, {
            onCall: (call) => {
              // NO HUDDLE stays on for the rest of the drive until the user turns it off.
              if (stage.request.unit === 'offense' && stage.request.situation.kind === 'scrimmage') this.noHuddle = { side: stage.request.side, on: call.hurryUp === true };
              session.callPlay(call);
            },
            onPause: () => { if (this.services) this.openPause(this.services); },
            onTimeout: () => session.callTimeout() && timeoutNotice(session.setup, stage.request.side, session.state.timeouts[stage.request.side]),
            defaultRole: stage.request.controlRoles[0] ?? null,
            defaultHurryUp: this.noHuddle.on && this.noHuddle.side === stage.request.side && stage.request.offense === stage.request.side,
          }));
        }
        break;
      case 'live':
        this.tickLive(stage, input, services);
        break;
      case 'postPlay': {
        const hit = hitHintButton(this.hintRects, input.pointer);
        if (hit) this.postPlayControl(hit, stage, services);
        else if (input.justPressed.has('confirm') || input.justPressed.has('snap')) session.continue();
        else if (input.justPressed.has('challenge') && stage.challenge) this.postPlayControl('challenge', stage, services);
        else if (input.justPressed.has('showPlayArt')) this.postPlayControl('replay', stage, services);
        else if (input.justPressed.has('skipPlay')) session.skipPlay();
        break;
      }
      case 'intermission':
        if (input.justPressed.has('confirm')) session.continue();
        break;
      case 'final':
        if (this.shownStage !== stage) {
          this.shownStage = stage;
          services.stack.replace(new PostGameScreen(stage.result, { onPlayAgain: this.opts.onPlayAgain, onMenu: this.opts.onQuit }));
        }
        break;
      default:
        break;
    }
  }

  /**
   * Runs the live play's ticks for this loop tick: as many as the game speed asks (0 at 0.5x every other tick),
   * with sprint latched when the sprint-toggle accessibility option is on.
   */
  private tickLive(stage: Extract<SessionStage, { kind: 'live' }>, input: InputState, services: ScreenServices): void {
    const session = this.session;
    const side = session.userSide;
    const controls = side !== null && !stage.meta.spectating && session.state.controllers[side] === 'human';
    if (input.justPressed.has('callTimeout') && session.callTimeout()) return;
    if (!controls && input.justPressed.has('skipPlay')) {
      session.skipPlay();
      return;
    }
    const toggle = services.access?.sprintToggle === true;
    for (const raw of this.speedGate.step(services.settings.gameSpeed, input)) {
      if (session.stage !== stage) return;
      if (controls && side) {
        const inp = toggle ? this.sprintLatch.apply(raw) : raw;
        const play = stage.play.state;
        const playInput = buildPlayInput(inp, play, services.camera, { side, formationSlots: stage.meta.receiverSlots, routes: stage.meta.routes, throwHold: this.throwHold, tapRadiusPx: tapRadiusFor(services.camera.zoom) });
        this.playArtHeld = inp.down.has('showPlayArt') && play.phase === 'presnap';
        session.tick({ [side]: playInput });
      } else {
        this.playArtHeld = false;
        session.tick();
      }
    }
  }

  private updateCamera(dt: number, services: ScreenServices): void {
    if (!this.director) return;
    const session = this.session;
    const play = session.displayPlay;
    const s = session.state;
    const context = session.cameraContext();
    let frame: DirectorFrame;
    if (play) {
      const ps = play.state;
      const controlled = findAthlete(ps, ps.controlledId);
      frame = { context, userSide: session.userSide, offense: ps.ctx.offense, direction: ps.ctx.direction, ballPos: ps.ball.pos, controlledPos: controlled?.pos ?? null, losY: ps.losY, kickLandingPos: ps.ball.targetPos, kickReturn: ['kickoff', 'onside', 'punt'].includes(ps.ctx.special) };
    } else {
      const losY = fieldY(s.ballOn, s.direction);
      frame = { context, userSide: session.userSide, offense: s.kickoffPending ?? s.possession, direction: s.direction, ballPos: vec2(s.ballX, losY), controlledPos: null, losY, kickReturn: s.kickoffPending !== null };
    }
    this.director.update(dt, frame);
    const shake = services.settings.screenShake && !services.theme.reducedMotion;
    if (shake && play && play.state.tick === play.state.snapTick + 1 && play.state.snapTick > 0) services.camera.addShake(1, 0.1);
    if (this.impacts.scan(session.live) && shake) services.camera.addShake(HIT_SHAKE.amplitude, HIT_SHAKE.seconds);
  }

  update(dt: number, input: InputState, services: ScreenServices): void {
    this.services = services;
    this.lastDevice = input.lastDevice;
    if (this.session.stage.kind !== 'live') {
      // Between plays: sprint unlatches and the speed gate starts afresh.
      this.sprintLatch.reset();
      this.speedGate.reset();
    }
    if (input.justPressed.has('pause')) {
      this.openPause(services);
      return;
    }
    const dev = this.syncDev(services);
    if (dev && this.updateDev(dev, input, services)) return;
    this.banners.update(dt);
    this.session.update(dt);
    dev?.runFastSim(this.session);
    if (input.justPressed.has('cameraCycle')) this.director?.cycle();
    if (this.session.watching && input.justPressed.has('jumpIn')) this.session.jumpIn();
    if (this.session.watching || this.session.liveMeta?.spectating) {
      if (input.justPressed.has('simSpeedUp')) this.session.setSpeed(this.session.speed * 2);
      if (input.justPressed.has('simSpeedDown')) this.session.setSpeed(this.session.speed / 2);
    }
    this.handleStage(this.session.stage, input, services);
    this.updateCamera(dt, services);
  }

  /* -------------------------------------- render -------------------------------------- */

  render(rc: RenderContext): void {
    const { ctx, theme, width, height } = rc;
    const session = this.session;
    const { setup, state } = session;
    const palettes = this.palettes ?? resolveTeamPalettes(setup.home.team.colors, setup.away.team.colors, rc.settings.colorblind);
    const play = session.displayPlay;
    const meta = session.displayMeta;
    const stage = session.stage;
    const input = this.services?.input;
    const context = session.cameraContext();
    // A dead play keeps settling (and animating) while it is shown, held still under the pause menu and the dev console.
    const paused = ['pause', 'devConsole'].includes(this.services?.stack.top?.id ?? '');
    const settleAlpha = this.deadBall.advance(play, rc.time, session.snapshot, paused);
    const scene = { ...(play ? sceneFromPlay(play.state, session.snapshot, settleAlpha ?? rc.alpha, { time: rc.time, paused }) : emptyScene(state)), lighting: lightingFor(setup.stadium.roof, state.weather?.type ?? null, String(setup.id)) };
    const slots = meta?.receiverSlots ?? [];
    drawScene(ctx, rc.camera, scene, {
      theme, sprites: rc.sprites, palettes, fieldType: setup.stadium.fieldType, weather: state.weather, homeAbbr: setup.home.team.abbr, awayAbbr: setup.away.team.abbr,
      time: rc.time, userSide: session.userSide, routes: meta?.routes, showPlayArt: this.playArtHeld, receiverSlots: slots,
      receiverGlyphs: input ? receiverGlyphs(this.lastDevice, (a) => input.glyph(a), slots.length) : undefined, switchHints: context === 'defense' && stage.kind === 'live',
      stadium: stadiumViewFor(setup, palettes), animations: rc.settings.animations, world: rc.world ?? null,
      gameInfo: { down: state.down, quarter: state.clock.quarter, homeScore: state.score.home, awayScore: state.score.away } });
    const dev = this.dev;
    if (dev && play && dev.state.overlays.size > 0) {
      const model = buildOverlayModel(play.state, dev.state.overlays, { routes: meta?.routes, routeById: (id) => session.registry.routes[id], pointer: this.devCursor });
      drawOverlays(ctx, rc.camera, theme, model, theme.pad, theme.pad * 2 + (theme.glyphH + theme.gap) * 4);
    }
    const aimHint = input ? aimGlyph(this.lastDevice, (a) => input.glyph(a)) : null;
    renderThrowAim(ctx, rc.camera, theme, stage.kind === 'live' && !stage.meta.spectating ? stage.play.state : null, session.userSide, aimHint);
    if (dev && this.devCursor) {
      const c = rc.camera.worldToScreen(this.devCursor);
      pixelLine(ctx, c.x - 3, c.y, c.x + 3, c.y, theme.colors.warning);
      pixelLine(ctx, c.x, c.y - 3, c.x, c.y + 3, theme.colors.warning);
    }
    // The play-call overlay owns the bottom of the screen (its control hints), so the last play-by-play line hides there.
    const pbpLine = stage.kind === 'playcall' ? null : this.lastPbp;
    const hud = buildHudData(state, setup, { play: play?.state ?? null, resultText: stage.kind === 'postPlay' ? stage.summary.resultText : null, pbpLine, palettes });
    const touchLayout = input && shouldShowTouch(rc.settings.showTouchControls, this.lastDevice) ? touchLayoutOf(input) : null;
    const captionW = touchLayout ? captionWidthClearOf(touchLayout, width, height, theme.gap) : undefined;
    const hudBottomTop = drawHud(ctx, theme, hud, width, height, state.ruleset.timeoutsPerHalf, captionW);
    if (stage.kind === 'live') drawKickMeter(ctx, theme, hud.kickMeter, width, height);
    if (stage.kind === 'intermission') {
      const label = stage.reason === 'halftime' ? 'HALFTIME' : stage.reason === 'twoMinute' ? 'TWO-MINUTE WARNING' : stage.reason === 'overtime' ? 'OVERTIME' : `END OF QUARTER ${state.clock.quarter - 1}`;
      drawText(ctx, label, width / 2, height * 0.5 - theme.glyphH, { size: theme.textScale, align: 'center', color: theme.colors.accent, shadow: theme.colors.shadow });
      drawText(ctx, `${setup.away.team.abbr} ${state.score.away}  ·  ${setup.home.team.abbr} ${state.score.home}`, width / 2, height * 0.5 + theme.gap, { size: theme.textScale, align: 'center', color: theme.colors.text, shadow: theme.colors.shadow });
    }
    if (stage.kind === 'live' && stage.meta.spectating && !session.watching) drawWatchStatus(ctx, theme, 'DEFENSE SIMULATING', width, height * 0.5, rc.time);
    if (session.watching || (stage.kind === 'live' && stage.meta.spectating)) drawSpeedBadge(ctx, theme, session.speed, width);
    drawBanner(ctx, theme, this.banners.current, width, height);
    // Under the watch-mode speed badge (top right).
    if (this.dev) drawDevBadge(ctx, theme, this.dev.state, width - theme.pad, devBadgeY(theme));
    if (input) {
      const hints = gameHints(this.session, (a) => input.glyph(a));
      // Stack above whatever the HUD drew along the bottom (result strip + wrapped caption), at any text size.
      const hintY = hudBottomTop - theme.gap - hintRowHeight(theme);
      this.hintRects = hints.length > 0 ? drawHintButtons(ctx, theme, hints, width, hintY) : [];
      // Only the post-play card's buttons are tappable (live-play taps belong to the field).
      if (stage.kind !== 'postPlay') this.hintRects = [];
      if (touchLayout) drawTouchOverlay(ctx, theme, touchLayout, touchLabelsFor(touchContextFor(this.session), input.getScheme(), touchLayout.buttons.map((b) => b.button)));
    }
  }
}
