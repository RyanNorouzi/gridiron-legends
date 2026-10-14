/**
 * Settings screen: gameplay preferences for new games (play style, difficulty + tuning, quarter length, penalties,
 * injuries, fatigue, weather; ScreenServices.gameplay), playbook complexity and animations, and the shared
 * Settings object edited in place (game speed, sim speed, camera per context,
 * audio levels, text size, colorblind mode, reduced motion, screen shake, touch controls, defense mode,
 * replays), the accessibility preferences kept beside it (sound captions, hold / toggle sprint; ScreenServices
 * .access, persisted through persistAccess). CONTROLS opens the Remap screen (screens/remap.ts: press-to-bind,
 * clash detection with swaps). Changes apply live where possible (audio levels, theme rebuild, input scheme) and
 * persist through the injected `persist` callback.
 */
import type { CameraContext, CameraMode, CameraZoom, CrowdNoise, ColorblindMode, DefenseMode, ReplayRetentionSetting, Settings, TextSize } from '@/core/settings';
import type { Action, ControlScheme } from '../input/types';
import { BUTTONS, actionsFor, rebind, schemeToSettings, validateScheme } from '../input/schemes';
import type { InputState } from '../input/types';
import { defaultAccess, type AccessPrefs } from '../accessibility';
import { createTheme } from '../theme';
import { MenuList, type MenuItem } from '../widgets/menu';
import { drawHintBar, drawPanel } from '../widgets/panel';
import { drawScreenBackdrop } from '../widgets/title-backdrop';
import type { ArtCtx } from '../widgets/ui-art';
import { getDifficulty } from '@/game/rulesets';
import { cycleDifficulty, defaultGameplay, difficultyBlurb, QUARTER_CHOICES, tunedDifficulty, type GameplayPrefs } from '../gameplay-prefs';
import { DifficultyTuningScreen } from './difficulty-tuning';
import { RemapScreen } from './remap';
import type { RenderContext, Screen, ScreenServices } from './screen';

export interface SettingsScreenOptions {
  /** Called with the (mutated) settings when the screen closes or a value changes. */
  persist?: (settings: Settings) => void | Promise<unknown>;
}

const CAMERA_MODES: readonly (CameraMode | 'default')[] = ['default', 'standard', 'defensive', 'playerFollow', 'zoomed', 'kick', 'simulation'];
const CAMERA_CONTEXTS: readonly CameraContext[] = ['offense', 'defense', 'kick', 'punt', 'watch'];
const CAMERA_ZOOMS: readonly CameraZoom[] = ['close', 'standard', 'wide'];
const CROWD_NOISES: readonly CrowdNoise[] = ['max', 'reactive'];
const GAME_SPEEDS: readonly number[] = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
const SIM_SPEEDS: readonly number[] = [1, 2, 4, 8];
const TEXT_SIZES: readonly TextSize[] = ['normal', 'large'];
const COLORBLIND: readonly ColorblindMode[] = ['none', 'protanopia', 'deuteranopia', 'tritanopia'];
const TOUCH: readonly Settings['showTouchControls'][] = ['auto', 'on', 'off'];
const DEFENSE: readonly DefenseMode[] = ['control', 'watch', 'playcallOnly'];
const REPLAY: readonly ReplayRetentionSetting[] = ['off', 'lastPlay', 'drive', 'game'];
const AUDIO_KEYS = ['master', 'sfx', 'music', 'crowd', 'commentary'] as const;
const COMPLEXITY: readonly Settings['playbookComplexity'][] = ['simple', 'standard', 'advanced'];

/** Display names for camera modes (never the raw enum ids). */
export const CAMERA_LABELS: Readonly<Record<CameraMode | 'default', string>> = Object.freeze({
  default: 'DEFAULT', standard: 'STANDARD', defensive: 'DEFENSIVE', playerFollow: 'FOLLOW PLAYER', zoomed: 'ZOOMED', kick: 'KICK', replay: 'REPLAY', simulation: 'FULL FIELD',
});

const cycle = <T>(list: readonly T[], current: T, delta: number): T => {
  const i = Math.max(0, list.indexOf(current));
  return list[((i + delta) % list.length + list.length) % list.length] as T;
};

const pct = (v: number): string => `${Math.round(v * 100)}%`;

/** Rebinds `action`'s primary button to the next/previous Button; returns the validated new scheme. */
export const cycleBinding = (scheme: ControlScheme, action: Action, delta: number): ControlScheme => {
  const current = scheme[action][0] ?? 'a';
  const next = cycle(BUTTONS, current, delta);
  const rest = scheme[action].slice(1).filter((b) => b !== next);
  const proposed = rebind(scheme, action, [next, ...rest]);
  const check = validateScheme(schemeToSettings(proposed), scheme);
  return check.scheme ?? scheme;
};

/** Other actions sharing the action's primary button (informational; sharing is allowed across contexts). */
export const bindingConflicts = (scheme: ControlScheme, action: Action): Action[] => {
  const b = scheme[action][0];
  return b ? actionsFor(scheme, b).filter((a) => a !== action) : [];
};

export class SettingsScreen implements Screen {
  readonly id = 'settings';
  private menu: MenuList;
  private services: ScreenServices | null = null;
  private settings: Settings;
  private detachedAccess: AccessPrefs | null = null;
  private detachedGameplay: GameplayPrefs | null = null;

  constructor(settings: Settings, private readonly opts: SettingsScreenOptions = {}) {
    this.settings = settings;
    this.menu = new MenuList(this.mainItems(), { maxVisible: 9 });
  }

  get list(): MenuList {
    return this.menu;
  }

  private mainItems(): MenuItem[] {
    const s = this.settings;
    const cam = (ctx: CameraContext): MenuItem => ({ id: `camera:${ctx}`, label: `CAMERA · ${ctx.toUpperCase()}`, value: CAMERA_LABELS[s.camera[ctx] ?? 'default'] });
    const g = this.gameplay();
    const onOff = (v: boolean): string => (v ? 'ON' : 'OFF');
    return [
      { id: 'gameSpeed', label: 'GAME SPEED', value: `${s.gameSpeed}x` },
      { id: 'simSpeed', label: 'SIM SPEED', value: `${s.simSpeed}x` },
      { id: 'defenseMode', label: 'DEFENSE MODE', value: s.defenseMode === 'playcallOnly' ? 'CALL ONLY' : s.defenseMode.toUpperCase() },
      { id: 'replayRetention', label: 'REPLAYS', value: s.replayRetention.toUpperCase() },
      { id: 'gp:ruleset', label: 'PLAY STYLE', value: g.ruleset === 'arcade' ? 'ARCADE' : 'SIMULATION' },
      { id: 'gp:difficulty', label: 'DIFFICULTY', value: tunedDifficulty(getDifficulty(g.difficulty), g.tweaks).name.toUpperCase(), subLabel: difficultyBlurb(g.difficulty, 'short').toUpperCase() },
      { id: 'tuning', label: 'DIFFICULTY TUNING…' },
      { id: 'gp:quarter', label: 'QUARTER LENGTH', value: `${g.quarterMinutes} MIN` },
      { id: 'gp:penalties', label: 'PENALTIES', value: onOff(g.penalties) },
      { id: 'gp:injuries', label: 'INJURIES', value: onOff(g.injuries) },
      { id: 'gp:fatigue', label: 'FATIGUE', value: onOff(g.fatigue) },
      { id: 'gp:weather', label: 'WEATHER', value: onOff(g.weather) },
      { id: 'playbookComplexity', label: 'PLAYBOOK', value: s.playbookComplexity.toUpperCase() },
      { id: 'cameraZoom', label: 'CAMERA ZOOM', value: (s.cameraZoom ?? 'close').toUpperCase() },
      ...CAMERA_CONTEXTS.map(cam),
      ...AUDIO_KEYS.map((k) => ({ id: `audio:${k}`, label: `AUDIO · ${k.toUpperCase()}`, value: pct(s.audio[k]) })),
      { id: 'crowdNoise', label: 'CROWD NOISE', value: (s.crowdNoise ?? 'max') === 'max' ? 'MAX ROAR' : 'REACTIVE' },
      { id: 'textSize', label: 'TEXT SIZE', value: s.textSize.toUpperCase() },
      { id: 'colorblind', label: 'COLORBLIND', value: s.colorblind.toUpperCase() },
      { id: 'reducedMotion', label: 'REDUCED MOTION', value: s.reducedMotion ? 'ON' : 'OFF' },
      { id: 'screenShake', label: 'SCREEN SHAKE', value: s.screenShake ? 'ON' : 'OFF' },
      { id: 'animations', label: 'ANIMATIONS', value: s.animations ? 'ON' : 'OFF' },
      { id: 'showTouchControls', label: 'TOUCH CONTROLS', value: s.showTouchControls.toUpperCase() },
      { id: 'captions', label: 'SOUND CAPTIONS', value: this.access().captions ? 'ON' : 'OFF' },
      { id: 'sprintToggle', label: 'SPRINT BUTTON', value: this.access().sprintToggle ? 'TOGGLE' : 'HOLD' },
      { id: 'controls', label: 'CONTROLS…' },
      { id: 'back', label: 'BACK' },
    ];
  }

  /** Gameplay preferences (a detached default copy before enter / in headless use). */
  gameplay(): GameplayPrefs {
    return (this.services?.gameplay ?? (this.detachedGameplay ??= defaultGameplay()));
  }

  private changeGameplay(key: string, delta: number): void {
    const g = this.gameplay();
    switch (key) {
      case 'ruleset': g.ruleset = g.ruleset === 'arcade' ? 'simulation' : 'arcade'; break;
      case 'difficulty': g.difficulty = cycleDifficulty(g.difficulty, delta); break;
      case 'quarter': g.quarterMinutes = cycle(QUARTER_CHOICES, g.quarterMinutes, delta); break;
      case 'penalties': g.penalties = !g.penalties; break;
      case 'injuries': g.injuries = !g.injuries; break;
      case 'fatigue': g.fatigue = !g.fatigue; break;
      case 'weather': g.weather = !g.weather; break;
      default: return;
    }
    this.services?.persistGameplay?.();
    this.menu.setItems(this.mainItems());
  }

  /** Accessibility preferences (a detached default copy before enter / in headless use). */
  private access(): AccessPrefs {
    return (this.services?.access ?? (this.detachedAccess ??= defaultAccess()));
  }

  enter(services: ScreenServices): void {
    this.services = services;
    this.settings = services.settings;
    this.menu.setItems(this.mainItems());
  }

  exit(): void {
    this.services = null;
  }

  /** Back from a sub-screen (tuning, controls): refresh the values it may have changed. */
  resume(): void {
    this.menu.setItems(this.mainItems());
  }

  private applyLive(): void {
    const services = this.services;
    if (!services) return;
    services.audio?.setLevels(this.settings.audio);
    services.audio?.setCrowdNoise(this.settings.crowdNoise ?? 'max');
    services.theme = createTheme(this.settings);
    void this.opts.persist?.(this.settings);
  }

  /** Changes one setting by a step (exported for tests). */
  change(id: string, delta: number): void {
    const s = this.settings;
    if (id.startsWith('camera:')) {
      const ctx = id.slice(7) as CameraContext;
      const next = cycle(CAMERA_MODES, s.camera[ctx] ?? 'default', delta);
      if (next === 'default') delete s.camera[ctx];
      else s.camera[ctx] = next;
    } else if (id.startsWith('gp:')) {
      this.changeGameplay(id.slice(3), delta);
      return;
    } else if (id.startsWith('audio:')) {
      const k = id.slice(6) as (typeof AUDIO_KEYS)[number];
      s.audio[k] = Math.max(0, Math.min(1, Math.round((s.audio[k] + delta * 0.1) * 10) / 10));
    } else {
      switch (id) {
        case 'gameSpeed': s.gameSpeed = cycle(GAME_SPEEDS, s.gameSpeed, delta); break;
        case 'simSpeed': s.simSpeed = cycle(SIM_SPEEDS, s.simSpeed, delta); break;
        case 'defenseMode': s.defenseMode = cycle(DEFENSE, s.defenseMode, delta); break;
        case 'replayRetention': s.replayRetention = cycle(REPLAY, s.replayRetention, delta); break;
        case 'textSize': s.textSize = cycle(TEXT_SIZES, s.textSize, delta); break;
        case 'colorblind': s.colorblind = cycle(COLORBLIND, s.colorblind, delta); break;
        case 'reducedMotion': s.reducedMotion = !s.reducedMotion; break;
        case 'screenShake': s.screenShake = !s.screenShake; break;
        case 'animations': s.animations = !s.animations; break;
        case 'cameraZoom': s.cameraZoom = cycle(CAMERA_ZOOMS, s.cameraZoom ?? 'close', delta); break;
        case 'crowdNoise': s.crowdNoise = cycle(CROWD_NOISES, s.crowdNoise ?? 'max', delta); break;
        case 'playbookComplexity': s.playbookComplexity = cycle(COMPLEXITY, s.playbookComplexity, delta); break;
        case 'showTouchControls': s.showTouchControls = cycle(TOUCH, s.showTouchControls, delta); break;
        case 'captions':
        case 'sprintToggle': {
          const a = this.access();
          if (id === 'captions') a.captions = !a.captions;
          else a.sprintToggle = !a.sprintToggle;
          this.services?.persistAccess?.();
          this.menu.setItems(this.mainItems());
          return;
        }
        default: return;
      }
    }
    this.applyLive();
    this.menu.setItems(this.mainItems());
  }

  /** Activates a row (exported for tests). */
  activate(id: string): void {
    const services = this.services;
    if (id === 'controls') services?.stack.push(new RemapScreen(this.settings, this.opts.persist ? { persist: this.opts.persist } : {}));
    else if (id === 'tuning') services?.stack.push(new DifficultyTuningScreen(this.gameplay(), () => this.services?.persistGameplay?.()));
    else if (id === 'back') {
      void this.opts.persist?.(this.settings);
      services?.stack.pop();
    } else this.change(id, 1);
  }

  update(dt: number, input: InputState, services: ScreenServices): void {
    const ev = this.menu.update(dt, input);
    if (!ev) return;
    if (ev.type === 'back') {
      services.audio?.onGameEvent({ type: 'menuBack' });
      this.activate('back');
    } else if (ev.type === 'change') this.change(ev.item.id, ev.delta);
    else if (ev.type === 'activate') {
      services.audio?.onGameEvent({ type: 'menuSelect' });
      this.activate(ev.item.id);
    } else if (ev.type === 'select') services.audio?.onGameEvent({ type: 'menuMove' });
  }

  /**
   * Shows as many rows as the panel holds (all of them when they fit) instead of a fixed count, keeping the
   * selection; the list fills the panel down to its bottom frame.
   */
  private fitRows(rows: number): void {
    const want = rows >= this.menu.items.length ? 0 : Math.max(1, rows);
    if (this.menu.maxVisible === want) return;
    this.menu = new MenuList(this.menu.items, { maxVisible: want, initialIndex: Math.max(0, this.menu.selectedIndex) });
  }

  render(rc: RenderContext): void {
    const { ctx, width, height } = rc;
    const theme = this.services?.theme ?? rc.theme;
    drawScreenBackdrop(ctx as ArtCtx, theme, width, height, rc.time);
    const hintH = theme.glyphH + 4 * theme.textScale;
    const content = drawPanel(ctx, theme, theme.pad, theme.pad, width - theme.pad * 2, height - hintH - theme.pad * 3, { style: 'raised', title: 'SETTINGS' });
    this.fitRows(Math.floor(content.h / theme.lineHeight));
    this.menu.draw(ctx, theme, content.x, content.y, content.w, { time: rc.time });
    const input = this.services?.input;
    drawHintBar(ctx, theme, [
      { glyph: `${input?.glyph('menuLeft') ?? '←'} ${input?.glyph('menuRight') ?? '→'}`, label: 'CHANGE' },
      { glyph: input?.glyph('back') ?? 'B', label: 'BACK' },
    ], width, height - hintH - theme.pad);
  }
}
