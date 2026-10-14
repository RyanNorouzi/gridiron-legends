/**
 * Replay screen: plays a ReplayRecording frame by frame with play / pause, slow motion (x0.25, x0.5) and fast
 * forward (x2, x4), single-step (hold to scrub), a scrubber (tap or drag to seek) and camera angles (broadcast,
 * wide, close, follow the ball carrier). Every control is a tappable button too, so mouse and touch reach
 * everything keyboard and gamepad do. When the post-play challenge window is open the screen also offers the
 * challenge flag (LT / keyboard C, or the CHALLENGE button). Frames are projected into the shared FieldScene so
 * the field view draws them exactly like the live play, interpolating between frames at fractional positions.
 */
import type { CameraMode } from '@/core/settings';
import { vec2 } from '@/core/vec2';
import type { ReplayFrame, ReplayRecording } from '@/game/play-types';
import type { TeamSide, WeatherState } from '@/game/types';
import { createCameraDirector, type CameraDirector } from '../game/camera-director';
import type { StadiumView } from '../render/stadium';
import type { SceneLighting } from '../render/world-layer';
import { drawnHeading, drawScene, southTeamFor, type FieldScene, type SceneAthlete } from '../game/field-view';
import type { Action, InputState } from '../input/types';
import type { ResolvedPalettes } from '../render/palette';
import { drawText, measureText } from '../render/text';
import { fillAlpha, type ArtCtx } from '../widgets/ui-art';
import { drawHintButtons, hintRowHeight, hitHintButton, type HintButton, type HintRect } from '../widgets/hint-buttons';
import { drawBar } from '../widgets/panel';
import type { RenderContext, Screen, ScreenServices } from './screen';

/** The challenge flag offered while the post-play window is open. */
export interface ReplayChallenge {
  /** Still possible (window open, challenges left). */
  available(): boolean;
  /** Throws the flag; false when the controller refused. */
  onChallenge(): boolean;
  /** Countdown shown on the button (seconds), or null. */
  secondsLeft?(): number | null;
}

export interface ReplayViewOptions {
  palettes: ResolvedPalettes;
  fieldType: 'grass' | 'turf';
  weather: WeatherState | null;
  homeAbbr: string;
  awayAbbr: string;
  userSide: TeamSide | null;
  /** Title in the top-left corner (default "REPLAY"). */
  title?: string;
  challenge?: ReplayChallenge;
  /** Stadium drawn around the field (as in the live view). */
  stadium?: StadiumView | null;
  /** Lighting of the game (world layer), as in the live view. */
  lighting?: SceneLighting;
}

export const REPLAY_SPEEDS: readonly number[] = [0.25, 0.5, 1, 2, 4];

/** Camera angle names shown on screen. */
export const REPLAY_CAMERA_NAMES: Readonly<Partial<Record<CameraMode, string>>> = Object.freeze({
  replay: 'BROADCAST', standard: 'WIDE', zoomed: 'CLOSE', playerFollow: 'FOLLOW',
});

/** Keyboard / gamepad action that throws the challenge flag from the replay (replayFast owns the challenge button). */
export const REPLAY_FLAG_ACTION: Action = 'callTimeout';

/** Seconds a step button is held before it starts scrubbing, and frames per second while scrubbing. */
const STEP_REPEAT_DELAY = 0.35;
const SCRUB_FPS = 30;

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** Replay time readout with tenths ("6.6", "1:02.5"): one format for position and length (the game clock's
 *  format switches from tenths to m:ss at 10 s, which read "6.6 / 0:11"). */
export const replayTime = (seconds: number): string => {
  const t = Math.max(0, Math.round(seconds * 10) / 10);
  const m = Math.floor(t / 60);
  const rest = (t - m * 60).toFixed(1);
  return m > 0 ? `${m}:${rest.padStart(4, '0')}` : rest;
};

/** Frames a replay looks back to time an athlete's current state (poses that play once, e.g. a fall, start over). */
const STATE_LOOKBACK = 90;

/** Seconds athlete `id` (at index `k` in frame `i0`) has been in `state`, as the live play's state timer would say. */
const stateAge = (rec: ReplayRecording, i0: number, k: number, id: string, state: string): number => {
  let i = i0;
  while (i > 0 && i0 - i < STATE_LOOKBACK) {
    const prev = rec.frames[i - 1]?.athletes;
    const p = prev?.[k]?.id === id ? prev[k] : prev?.find((x) => x.id === id);
    if (!p || p.state !== state) break;
    i -= 1;
  }
  return i0 - i < STATE_LOOKBACK ? (i0 - i) / rec.tickRate : i0 / rec.tickRate;
};

/** Scene at a fractional frame index (interpolates between neighbouring frames). */
export const sceneFromReplay = (rec: ReplayRecording, frame: number): FieldScene => {
  const n = rec.frames.length;
  const i0 = Math.max(0, Math.min(n - 1, Math.floor(frame)));
  const i1 = Math.min(n - 1, i0 + 1);
  const t = Math.max(0, Math.min(1, frame - i0));
  const a = rec.frames[i0] as ReplayFrame | undefined;
  const b = rec.frames[i1] ?? a;
  const athletes: SceneAthlete[] = [];
  if (a && b) {
    for (const meta of rec.athletes) {
      const k = a.athletes.findIndex((x) => x.id === meta.id);
      const fa = a.athletes[k];
      const fb = b.athletes.find((x) => x.id === meta.id) ?? fa;
      if (!fa || !fb) continue;
      const colon = meta.id.indexOf(':');
      // Velocity from the neighbouring frames (the last frame looks back one), as the live view reads the engine's.
      const back = i1 === i0 ? rec.frames[i0 - 1]?.athletes.find((x) => x.id === meta.id) : undefined;
      const vx = (back ? fa.x - back.x : fb.x - fa.x) * rec.tickRate;
      const vy = (back ? fa.y - back.y : fb.y - fa.y) * rec.tickRate;
      athletes.push({
        id: meta.id, playerId: meta.playerId, teamSide: meta.teamSide, side: meta.id.startsWith('def:') ? 'defense' : 'offense',
        role: colon >= 0 ? meta.id.slice(colon + 1) : meta.id, position: meta.position, number: meta.number,
        x: lerp(fa.x, fb.x, t), y: lerp(fa.y, fb.y, t), facing: drawnHeading(fa.state, vx, vy, fa.facing), state: fa.state, stateTimer: stateAge(rec, i0, k, meta.id, fa.state), hasBall: fa.hasBall,
        controlled: false, active: fa.state !== 'down', eligible: false, bodyFacing: fa.facing, vx, vy,
      });
    }
  }
  const ball = a && b ? { x: lerp(a.ball.x, b.ball.x, t), y: lerp(a.ball.y, b.ball.y, t), z: lerp(a.ball.z, b.ball.z, t), phase: a.ball.phase, carrierId: null } : { x: 0, y: rec.losY, z: 0, phase: 'dead' as const, carrierId: null };
  const offense = rec.athletes.find((m) => m.id.startsWith('off:'))?.teamSide;
  return {
    athletes, ball, losY: rec.losY, firstDownY: rec.firstDownY, direction: rec.direction, controlledId: null, presnap: a ? a.tick < rec.snapTick : true, snapX: ball.x,
    ...(offense ? { southTeam: southTeamFor(offense, rec.direction) } : {}),
    // Animation clock, events and frames: the looks (and run-cycle phases) match the live play and survive seeks.
    tick: a ? a.tick + t : 0, events: rec.events, frames: rec.frames, playKey: `replay:${rec.id}`,
  };
};

export class ReplayScreen implements Screen {
  readonly id = 'replay';
  private frame = 0;
  private playing = true;
  private speedIndex = 2;
  private director: CameraDirector | null = null;
  private services: ScreenServices | null = null;
  private buttons: HintRect[] = [];
  private scrubbing = false;
  private held = 0;
  private scrubAcc = 0;

  constructor(readonly recording: ReplayRecording, private readonly view: ReplayViewOptions) {}

  get position(): number {
    return this.frame;
  }

  get isPlaying(): boolean {
    return this.playing;
  }

  get speed(): number {
    return REPLAY_SPEEDS[this.speedIndex] as number;
  }

  /** Current camera mode (null before enter). */
  get cameraMode(): CameraMode | null {
    return this.director?.mode ?? null;
  }

  /** Rectangles of the on-screen buttons from the last render. */
  get buttonRects(): readonly HintRect[] {
    return this.buttons;
  }

  private get lastFrame(): number {
    return Math.max(0, this.recording.frames.length - 1);
  }

  enter(services: ScreenServices): void {
    this.services = services;
    this.director = createCameraDirector(services.camera, services.settings);
    this.frame = 0;
    this.playing = true;
  }

  exit(): void {
    this.services = null;
  }

  seek(frame: number): void {
    this.frame = Math.max(0, Math.min(this.lastFrame, frame));
  }

  togglePlay(): void {
    if (!this.playing && this.frame >= this.lastFrame) this.frame = 0;
    this.playing = !this.playing;
  }

  step(delta: number): void {
    this.playing = false;
    this.seek(Math.round(this.frame) + delta);
  }

  /** Slower (-1) or faster (+1) playback. */
  changeSpeed(delta: -1 | 1): void {
    this.speedIndex = Math.max(0, Math.min(REPLAY_SPEEDS.length - 1, this.speedIndex + delta));
  }

  /** Next camera angle; returns it. */
  cycleCamera(): CameraMode | null {
    return this.director?.cycle() ?? null;
  }

  /** Throws the challenge flag (when offered) and closes the replay; false when not possible. */
  challenge(services: ScreenServices): boolean {
    const c = this.view.challenge;
    if (!c?.available()) return false;
    if (!c.onChallenge()) {
      services.toast('No challenge available');
      return false;
    }
    if (services.stack.top === this) services.stack.pop();
    return true;
  }

  private scrubberRect(services: ScreenServices): { x: number; y: number; w: number; h: number } {
    const t = services.theme;
    const rowsTop = this.buttons.length > 0 ? Math.min(...this.buttons.map((b) => b.y)) : services.height - t.pad - hintRowHeight(t);
    return { x: t.pad * 2, y: rowsTop - t.gap - 6 * t.textScale, w: services.width - t.pad * 4, h: 6 * t.textScale };
  }

  /** Runs one control by id (keyboard, gamepad, mouse and touch all end here). */
  run(id: string, services: ScreenServices): void {
    switch (id) {
      case 'play': this.togglePlay(); break;
      case 'slow': this.changeSpeed(-1); break;
      case 'fast': this.changeSpeed(1); break;
      case 'back1': this.step(-1); break;
      case 'fwd1': this.step(1); break;
      case 'camera': this.cycleCamera(); break;
      case 'flag': this.challenge(services); break;
      case 'close': if (services.stack.top === this) services.stack.pop(); break;
      default: break;
    }
  }

  private stepHeld(dt: number, input: InputState): void {
    const back = input.down.has('replayStepBack') || input.down.has('menuLeft');
    const fwd = input.down.has('replayStepForward') || input.down.has('menuRight');
    if (back === fwd) {
      this.held = 0;
      this.scrubAcc = 0;
      return;
    }
    this.held += dt;
    if (this.held < STEP_REPEAT_DELAY) return;
    this.scrubAcc += dt * SCRUB_FPS;
    const n = Math.floor(this.scrubAcc);
    if (n > 0) {
      this.scrubAcc -= n;
      this.step(back ? -n : n);
    }
  }

  update(dt: number, input: InputState, services: ScreenServices): void {
    const pressed = (a: Action): boolean => input.justPressed.has(a);
    const p = input.pointer;
    const hit = hitHintButton(this.buttons, p);
    // A mouse click also raises the A-button actions (confirm / play-pause): the click itself decides instead.
    const click = input.lastDevice === 'mouse' && !!p?.justDown;
    if (pressed('back') || pressed('pause')) return this.run('close', services);
    if (pressed(REPLAY_FLAG_ACTION) && this.view.challenge?.available()) {
      this.challenge(services);
      return;
    }
    if (!click && (pressed('replayPlayPause') || pressed('confirm'))) this.togglePlay();
    if (pressed('replaySlow')) this.changeSpeed(-1);
    if (pressed('replayFast')) this.changeSpeed(1);
    if (pressed('replayStepBack') || pressed('menuLeft')) this.step(-1);
    if (pressed('replayStepForward') || pressed('menuRight')) this.step(1);
    if (pressed('cameraCycle') || pressed('menuUp')) this.cycleCamera();
    this.stepHeld(dt, input);
    if (hit) {
      this.run(hit, services);
      if (services.stack.top !== this) return;
    } else if (p) {
      const r = this.scrubberRect(services);
      const onBar = p.y >= r.y - 6 && p.y <= r.y + r.h + 6 && r.w > 0;
      if (p.justDown) this.scrubbing = onBar;
      if (this.scrubbing) {
        this.playing = false;
        this.seek(((p.x - r.x) / r.w) * this.lastFrame);
      } else if (click) this.togglePlay();
      // Released after the seek: a click / tap shorter than a frame arrives as justDown with down already false.
      if (!p.down) this.scrubbing = false;
    }
    if (this.playing) {
      this.frame += dt * this.recording.tickRate * this.speed;
      if (this.frame >= this.lastFrame) {
        this.frame = this.lastFrame;
        this.playing = false;
      }
    }
    const scene = sceneFromReplay(this.recording, this.frame);
    const carrier = scene.athletes.find((a) => a.hasBall);
    this.director?.update(dt, {
      context: 'replay', userSide: this.view.userSide, offense: this.recording.athletes.find((a) => a.id.startsWith('off:'))?.teamSide ?? 'home',
      direction: this.recording.direction, ballPos: vec2(scene.ball.x, scene.ball.y), controlledPos: carrier ? vec2(carrier.x, carrier.y) : null,
      // The broadcast angle follows the ball but, like the live views, never pans off the field and its stands.
      losY: scene.losY, replayTarget: this.services ? this.services.camera.clampTarget(vec2(scene.ball.x, scene.ball.y), this.services.camera.replayZoom()) : vec2(scene.ball.x, scene.ball.y),
    });
  }

  /** The on-screen controls for the current state. */
  controls(services: ScreenServices): HintButton[] {
    const g = (a: Action): string => services.input.glyph(a);
    const out: HintButton[] = [
      { id: 'play', glyph: g('replayPlayPause'), label: this.playing ? 'PAUSE' : 'PLAY' },
      { id: 'slow', glyph: g('replaySlow'), label: 'SLOWER' },
      { id: 'fast', glyph: g('replayFast'), label: 'FASTER' },
      { id: 'back1', glyph: g('replayStepBack'), label: '◀' },
      { id: 'fwd1', glyph: g('replayStepForward'), label: '▶' },
      { id: 'camera', glyph: g('cameraCycle'), label: 'CAMERA' },
    ];
    const c = this.view.challenge;
    if (c?.available()) {
      const secs = c.secondsLeft?.() ?? null;
      out.push({ id: 'flag', glyph: g(REPLAY_FLAG_ACTION), label: secs === null ? 'CHALLENGE' : `CHALLENGE ${Math.max(0, Math.ceil(secs))}s` });
    }
    out.push({ id: 'close', glyph: g('back'), label: 'CLOSE' });
    return out;
  }

  render(rc: RenderContext): void {
    const { ctx, theme, width, height } = rc;
    const scene = { ...sceneFromReplay(this.recording, this.frame), ...(this.view.lighting ? { lighting: this.view.lighting } : {}) };
    drawScene(ctx, rc.camera, scene, {
      theme, sprites: rc.sprites, palettes: this.view.palettes, fieldType: this.view.fieldType, weather: this.view.weather, homeAbbr: this.view.homeAbbr,
      awayAbbr: this.view.awayAbbr, time: rc.time, userSide: this.view.userSide, stadium: this.view.stadium ?? null, animations: rc.settings.animations,
      world: rc.world ?? null,
    });
    const s = theme.textScale;
    const shadow = theme.colors.shadow;
    // Each readout sits on a small ink chip so it stays legible over yard lines and crowds.
    const label = (text: string, x: number, y: number, color: string, align: 'left' | 'right'): void => {
      const w = measureText(text, s).width;
      const left = align === 'right' ? x - w : x;
      fillAlpha(ctx as ArtCtx, theme.colors.shadow, 0.75, left - 3, y - 2, w + 6, theme.glyphH + 4);
      drawText(ctx, text, left, y, { color, size: s, shadow });
    };
    const slow = this.speed < 1 ? ' SLOW-MO' : '';
    label(`${this.view.title ?? 'REPLAY'}  x${this.speed}${slow}${this.playing ? '' : '  ▮▮'}`, theme.pad, theme.pad, theme.colors.accent, 'left');
    const seconds = this.frame / this.recording.tickRate;
    const total = this.lastFrame / this.recording.tickRate;
    label(`${replayTime(seconds)} / ${replayTime(total)}`, width - theme.pad, theme.pad, theme.colors.text, 'right');
    const mode = this.director?.mode;
    if (mode) label(`CAM ${REPLAY_CAMERA_NAMES[mode] ?? mode.toUpperCase()}`, width - theme.pad, theme.pad + theme.lineHeight, theme.colors.textDim, 'right');
    const services = this.services;
    if (!services) return;
    const bottom = height - theme.pad - hintRowHeight(theme);
    const controls = this.controls(services);
    // Backing strip so the buttons stay readable over the field.
    const rows = this.buttons.length > 0 ? this.buttons : [];
    const top = rows.length > 0 ? Math.min(...rows.map((b) => b.y)) : bottom;
    ctx.fillStyle = theme.colors.bg;
    const prev = ctx.globalAlpha;
    ctx.globalAlpha = prev * 0.7;
    ctx.fillRect(0, top - theme.gap, width, height - top + theme.gap);
    ctx.globalAlpha = prev;
    this.buttons = drawHintButtons(ctx, theme, controls, width, bottom);
    const r = this.scrubberRect(services);
    drawBar(ctx, theme, r.x, r.y, r.w, r.h, this.lastFrame > 0 ? this.frame / this.lastFrame : 0);
    const snapX = r.x + 1 + Math.round((r.w - 2) * (this.lastFrame > 0 ? Math.min(1, Math.max(0, this.recording.snapTick / this.lastFrame)) : 0));
    ctx.fillStyle = theme.colors.los;
    ctx.fillRect(snapX, r.y - 2, 1, r.h + 4);
  }
}
