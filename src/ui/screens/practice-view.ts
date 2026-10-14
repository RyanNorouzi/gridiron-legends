/**
 * Practice play view: the live-play plumbing shared by the practice game screen and the interactive tutorial.
 * It owns the camera director, the interpolation buffer, the throw-hold tracker and the resolved squad palettes;
 * each tick it turns the InputState into the user's UserPlayInput (ui/game/play-input.ts, the only producer) and
 * advances the headless DrillRep; each frame it draws the field view, receiver glyphs, the kick meter and the
 * touch overlay exactly like the game screen does.
 */
import { TICK_DT } from '@/core/time';
import { vec2 } from '@/core/vec2';
import { findAthlete } from '@/game/athlete';
import type { PlayState, UserPlayInput } from '@/game/play-types';
import type { TeamSide } from '@/game/types';
import type { DrillRep } from '@/game/practice/runner';
import { canSettle } from '@/game/systems/post-whistle';
import { createCameraDirector, tapRadiusFor, type CameraDirector, type DirectorContext } from '../game/camera-director';
import { drawScene, sceneFromPlay } from '../game/field-view';
import { SnapshotBuffer } from '../game/interp';
import { drawKickMeter } from '../game/kick-meter-view';
import { buildPlayInput, createThrowHold, playInputContext, type PlayInputContext, type ThrowHoldState } from '../game/play-input';
import { drawTouchOverlay, receiverGlyphs, shouldShowTouch, touchLabelsFor } from '../game/touch-overlay';
import type { InputManager, InputState } from '../input/types';
import { resolveTeamPalettes, type ResolvedPalettes } from '../render/palette';
import type { RenderContext, ScreenServices } from './screen';
import { touchLayoutOf } from './game';

/**
 * The engine walks a human kicker with the aim stick, and a punter who drifts while the long snap is in the air
 * muffs it. Until the punter has the ball the aim is held back; once he holds it, the stick aims the punt.
 */
export const steadyKicker = (input: UserPlayInput, play: PlayState, side: TeamSide): UserPlayInput => {
  if (!play.kickMeter || play.ctx.offense !== side || play.ctx.special !== 'punt') return input;
  const secured = play.ball.phase === 'held' && play.ball.carrierId === (play.controlledIds[side] ?? null);
  return secured ? input : { ...input, move: vec2(0, 0) };
};

/** Seconds after the snap the running drill keeps a human quarterback still while the designed handoff happens. */
export const HANDOFF_HOLD_SECONDS = 1.5;

/**
 * Running drills are about the ball carrier: a human quarterback who drifts with the stick at the snap runs away
 * from the mesh point and keeps the ball. Until the designed handoff / toss (or HANDOFF_HOLD_SECONDS after the snap)
 * the quarterback's movement is held back, so control always passes to the runner. Everything else passes through.
 */
export const steadyHandoff = (input: UserPlayInput, play: PlayState, side: TeamSide): UserPlayInput => {
  if (play.ctx.offense !== side || play.ctx.offensivePlay.type !== 'run' || play.phase !== 'live' || play.snapTick < 0) return input;
  if ((play.tick - play.snapTick) * TICK_DT > HANDOFF_HOLD_SECONDS) return input;
  const me = findAthlete(play, play.controlledIds[side] ?? null);
  if (!me || me.assignment.type !== 'qb') return input;
  if (play.events.some((e) => e.type === 'handoff' || e.type === 'pitch')) return input;
  return { ...input, move: vec2(0, 0), sprint: false };
};

/** Live-play input + rendering for one DrillRep at a time (see the file header). */
export class PracticePlayView {
  private director: CameraDirector | null = null;
  private palettes: ResolvedPalettes | null = null;
  private readonly buffer = new SnapshotBuffer();
  private readonly throwHold: ThrowHoldState = createThrowHold();
  private repValue: DrillRep | null = null;
  /** The rep whose settle has come to rest (its final resting frame is already in the buffer). */
  private restedRep: DrillRep | null = null;
  private artHeld = false;
  private device: InputState['lastDevice'] = 'keyboard';
  private eventCursor = 0;
  private announced = false;
  /** The last input handed to the rep (tests and the tutorial read it). */
  lastInput: UserPlayInput | null = null;

  get rep(): DrillRep | null {
    return this.repValue;
  }

  get lastDevice(): InputState['lastDevice'] {
    return this.device;
  }

  /** Binds the camera and palettes to the screen services (call from Screen.enter). */
  attach(services: ScreenServices): void {
    this.director = createCameraDirector(services.camera, services.settings);
    this.palettes = null;
  }

  /** Shows a new rep (the interpolation history restarts). */
  setRep(rep: DrillRep | null): void {
    this.repValue = rep;
    this.buffer.reset();
    this.throwHold.action = null;
    this.lastInput = null;
    this.eventCursor = 0;
    this.announced = false;
    if (rep) {
      this.buffer.capture(rep.state);
      this.palettes = null;
    }
  }

  /** Input context of the user's athlete right now ('dead' without a rep). */
  context(): PlayInputContext {
    const rep = this.repValue;
    return rep ? playInputContext(rep.state, rep.scenario.userSide) : 'dead';
  }

  /** One fixed tick: builds the user's input from `input` and advances the rep (no-op once it finished). */
  step(input: InputState, services: ScreenServices): void {
    this.device = input.lastDevice;
    const rep = this.repValue;
    if (!rep || rep.finished) {
      this.artHeld = false;
      // After the whistle the bodies keep settling (presentation only) instead of freezing.
      if (rep && rep.play.isDead && canSettle(rep.play) && this.restedRep !== rep) {
        // The step that brings everyone to rest still changes the scene (fallers land): capture it twice so the
        // interpolation ends on the resting frame instead of the one before it.
        if (!rep.play.settle()) {
          this.restedRep = rep;
          this.buffer.capture(rep.state);
        }
        this.buffer.capture(rep.state);
      }
      return;
    }
    const sc = rep.scenario;
    const play = rep.state;
    const raw = buildPlayInput(input, play, services.camera, { side: sc.userSide, formationSlots: sc.receiverSlots, routes: sc.routes, throwHold: this.throwHold, tapRadiusPx: tapRadiusFor(services.camera.zoom) });
    const kicked = steadyKicker(raw, play, sc.userSide);
    const userInput = sc.def.evaluator === 'runGain' ? steadyHandoff(kicked, play, sc.userSide) : kicked;
    this.artHeld = input.down.has('showPlayArt') && play.phase === 'presnap';
    this.lastInput = userInput;
    rep.tick(userInput);
    if (rep.play.isDead && canSettle(rep.play)) rep.play.settle();
    this.buffer.capture(rep.state);
    // Play sounds: every new play event goes to the audio mapper, as in a real game.
    const events = rep.state.events;
    const audio = services.audio;
    if (!this.announced) {
      audio?.onGameEvent({ type: 'possession', offense: rep.state.ctx.offense });
      this.announced = true;
    }
    for (; this.eventCursor < events.length; this.eventCursor++) {
      const e = events[this.eventCursor];
      if (e && audio) audio.onGameEvent(e);
    }
  }

  /** Frames the camera on the rep (call once per update). */
  updateCamera(dt: number): void {
    const rep = this.repValue;
    if (!rep || !this.director) return;
    const ps = rep.state;
    const controlled = findAthlete(ps, ps.controlledIds[rep.scenario.userSide] ?? ps.controlledId);
    const context: DirectorContext = rep.scenario.def.camera;
    this.director.update(dt, {
      context, userSide: rep.scenario.userSide, offense: ps.ctx.offense, direction: ps.ctx.direction, ballPos: ps.ball.pos,
      controlledPos: controlled?.pos ?? null, losY: ps.losY, kickLandingPos: ps.ball.targetPos,
    });
  }

  cycleCamera(): void {
    this.director?.cycle();
  }

  private palettesFor(rc: RenderContext): ResolvedPalettes | null {
    const rep = this.repValue;
    if (!rep) return null;
    if (!this.palettes) this.palettes = resolveTeamPalettes(rep.scenario.squads.home.colors, rep.scenario.squads.away.colors, rc.settings.colorblind);
    return this.palettes;
  }

  /** Draws the field, athletes, prompts, kick meter and (when enabled) the touch overlay. */
  render(rc: RenderContext, input: InputManager | null): void {
    const rep = this.repValue;
    const palettes = this.palettesFor(rc);
    if (!rep || !palettes) return;
    const { ctx, theme, width, height } = rc;
    const sc = rep.scenario;
    const play = rep.state;
    const slots = sc.def.userUnit === 'offense' ? sc.receiverSlots : [];
    drawScene(ctx, rc.camera, sceneFromPlay(play, this.buffer, rc.alpha, { time: rc.time }), {
      theme, sprites: rc.sprites, palettes, fieldType: 'turf', weather: play.ctx.weather, homeAbbr: sc.squads.home.abbr, awayAbbr: sc.squads.away.abbr,
      time: rc.time, userSide: sc.userSide, routes: sc.def.userUnit === 'offense' ? sc.routes : undefined, showPlayArt: this.artHeld, receiverSlots: slots,
      receiverGlyphs: input ? receiverGlyphs(this.device, (a) => input.glyph(a), slots.length) : undefined,
      switchHints: sc.def.userUnit === 'defense' && play.phase === 'live', world: rc.world ?? null, animations: rc.settings.animations,
    });
    drawKickMeter(ctx, theme, play.kickMeter, width, height);
    if (input && shouldShowTouch(rc.settings.showTouchControls, this.device)) {
      const layout = touchLayoutOf(input);
      if (layout) drawTouchOverlay(ctx, theme, layout, touchLabelsFor(this.context(), input.getScheme(), layout.buttons.map((b) => b.button)));
    }
  }

  /** Screen position of the user's athlete (tutorial callouts), or null. */
  userScreenPos(rc: RenderContext): { x: number; y: number } | null {
    const rep = this.repValue;
    if (!rep) return null;
    const a = findAthlete(rep.state, rep.state.controlledIds[rep.scenario.userSide] ?? rep.state.controlledId);
    return a ? rc.camera.worldToScreen(vec2(a.pos.x, a.pos.y)) : null;
  }
}
