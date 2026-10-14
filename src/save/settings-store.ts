import {
  DEFAULT_SETTINGS,
  type AudioLevels, type CameraContext, type CameraMode, type CameraZoom, CrowdNoise, type ColorblindMode, type DefenseMode, type ReplayRetentionSetting,
  type Settings, type TextSize,
} from '@/core/settings';
import { serializeSettings } from './serialize';
import type { StorageAdapter } from './storage';

/**
 * Persistence for user Settings under a single slot-independent key. Loading is forgiving: the stored
 * record is merged over DEFAULT_SETTINGS field by field, and any field with the wrong type or an unknown
 * enum value falls back to its default (reported in `issues`) instead of failing the whole load.
 */
export const SETTINGS_KEY = 'gl:settings';

const TEXT_SIZES: readonly TextSize[] = ['normal', 'large'];
const COLORBLIND_MODES: readonly ColorblindMode[] = ['none', 'protanopia', 'deuteranopia', 'tritanopia'];
const TOUCH_MODES: readonly Settings['showTouchControls'][] = ['auto', 'on', 'off'];
const REPLAY_RETENTIONS: readonly ReplayRetentionSetting[] = ['off', 'lastPlay', 'drive', 'game'];
const DEFENSE_MODES: readonly DefenseMode[] = ['control', 'watch', 'playcallOnly'];
const COMPLEXITIES: readonly Settings['playbookComplexity'][] = ['simple', 'standard', 'advanced'];
const CAMERA_CONTEXTS: readonly CameraContext[] = ['offense', 'defense', 'kick', 'punt', 'watch'];
const CAMERA_MODES: readonly CameraMode[] = ['standard', 'defensive', 'playerFollow', 'zoomed', 'kick', 'replay', 'simulation'];
const CAMERA_ZOOMS: readonly CameraZoom[] = ['close', 'standard', 'wide'];
const CROWD_NOISES: readonly CrowdNoise[] = ['max', 'reactive'];
const AUDIO_KEYS: readonly (keyof AudioLevels)[] = ['master', 'sfx', 'music', 'crowd', 'commentary'];

export interface SettingsMerge {
  settings: Settings;
  /** Human-readable notes about fields that were replaced by defaults. */
  issues: string[];
}

type Raw = Record<string, unknown>;
const isRecord = (v: unknown): v is Raw => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Fresh deep copy of DEFAULT_SETTINGS (the constant is frozen). */
export const defaultSettings = (): Settings => ({
  ...DEFAULT_SETTINGS,
  audio: { ...DEFAULT_SETTINGS.audio },
  camera: { ...DEFAULT_SETTINGS.camera },
  bindings: Object.fromEntries(Object.entries(DEFAULT_SETTINGS.bindings).map(([k, v]) => [k, [...v]])),
  keyboardMap: { ...DEFAULT_SETTINGS.keyboardMap },
});

/** Settings version from which the stored gameSpeed is the user's own choice (DEFAULT_GAME_SPEED became the default). */
export const GAME_SPEED_DEFAULT_VERSION = 2;

/** Settings version from which the stored crowd level is the user's own choice (the crowd slider default became 100%). */
export const CROWD_MAX_DEFAULT_VERSION = 3;

/** The crowd slider default before CROWD_MAX_DEFAULT_VERSION; a pre-version-3 record holding it gets the new default. */
const OLD_CROWD_DEFAULT = 0.8;

/** Version of a stored record (records from before versioning count as 0). */
const storedVersion = (raw: Raw): number => (typeof raw.version === 'number' && Number.isFinite(raw.version) ? raw.version : 0);

/**
 * Merges arbitrary parsed data over the defaults, validating each field's type/enum/range. Never throws:
 * non-object input yields pure defaults with one issue. `version` is always set to the current default; a record
 * from before GAME_SPEED_DEFAULT_VERSION that still holds the old 1x gameSpeed default gets the new default instead,
 * and one from before CROWD_MAX_DEFAULT_VERSION that still holds the old 0.8 crowd level gets the 100% crowd.
 */
export const mergeSettings = (raw: unknown): SettingsMerge => {
  const out = defaultSettings();
  const issues: string[] = [];
  if (!isRecord(raw)) {
    if (raw !== undefined && raw !== null) issues.push('settings record is not an object; using defaults');
    return { settings: out, issues };
  }
  const bad = (key: string, why: string): void => { issues.push(`${key}: ${why}; using default`); };
  const pickEnum = <T extends string>(key: keyof Settings, values: readonly T[], assign: (v: T) => void): void => {
    const v = raw[key];
    if (v === undefined) return;
    if (typeof v === 'string' && (values as readonly string[]).includes(v)) assign(v as T);
    else bad(key, `expected one of ${values.join('|')}`);
  };
  const pickBool = (key: 'reducedMotion' | 'screenShake' | 'animations' | 'devMode' | 'tutorialCompleted'): void => {
    const v = raw[key];
    if (v === undefined) return;
    if (typeof v === 'boolean') out[key] = v;
    else bad(key, 'expected a boolean');
  };
  const pickSpeed = (key: 'simSpeed' | 'gameSpeed'): void => {
    const v = raw[key];
    if (v === undefined) return;
    if (typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= 64) out[key] = v;
    else bad(key, 'expected a number in (0, 64]');
  };

  pickEnum('textSize', TEXT_SIZES, (v) => { out.textSize = v; });
  pickEnum('colorblind', COLORBLIND_MODES, (v) => { out.colorblind = v; });
  pickEnum('showTouchControls', TOUCH_MODES, (v) => { out.showTouchControls = v; });
  pickEnum('replayRetention', REPLAY_RETENTIONS, (v) => { out.replayRetention = v; });
  pickEnum('defenseMode', DEFENSE_MODES, (v) => { out.defenseMode = v; });
  pickEnum('playbookComplexity', COMPLEXITIES, (v) => { out.playbookComplexity = v; });
  // Records from before the zoom presets have no cameraZoom and keep the default (the dynamic CLOSE view).
  pickEnum('cameraZoom', CAMERA_ZOOMS, (v) => { out.cameraZoom = v; });
  // Absent (older records) = the max-roar crowd.
  pickEnum('crowdNoise', CROWD_NOISES, (v) => { out.crowdNoise = v; });
  pickBool('reducedMotion');
  pickBool('screenShake');
  pickBool('animations');
  pickBool('devMode');
  pickBool('tutorialCompleted');
  pickSpeed('simSpeed');
  // Records from before settings version 2 stored the old 1x default: drop it once so the faster default applies
  // (a speed the user chose himself is kept, and so is 1x picked again after the migration).
  if (!(storedVersion(raw) < GAME_SPEED_DEFAULT_VERSION && raw.gameSpeed === 1)) pickSpeed('gameSpeed');

  if (raw.audio !== undefined) {
    if (!isRecord(raw.audio)) bad('audio', 'expected an object');
    else {
      for (const k of AUDIO_KEYS) {
        const v = raw.audio[k];
        if (v === undefined) continue;
        // Pre-version-3 records still holding the old 0.8 crowd default get the max-volume crowd once.
        if (k === 'crowd' && v === OLD_CROWD_DEFAULT && storedVersion(raw) < CROWD_MAX_DEFAULT_VERSION) continue;
        if (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1) out.audio[k] = v;
        else bad(`audio.${k}`, 'expected a number in [0, 1]');
      }
    }
  }
  if (raw.camera !== undefined) {
    if (!isRecord(raw.camera)) bad('camera', 'expected an object');
    else {
      for (const [ctx, mode] of Object.entries(raw.camera)) {
        if (!(CAMERA_CONTEXTS as readonly string[]).includes(ctx)) { bad(`camera.${ctx}`, 'unknown camera context'); continue; }
        if (typeof mode === 'string' && (CAMERA_MODES as readonly string[]).includes(mode)) out.camera[ctx as CameraContext] = mode as CameraMode;
        else bad(`camera.${ctx}`, `expected one of ${CAMERA_MODES.join('|')}`);
      }
    }
  }
  if (raw.bindings !== undefined) {
    if (!isRecord(raw.bindings)) bad('bindings', 'expected an object');
    else {
      for (const [action, buttons] of Object.entries(raw.bindings)) {
        if (Array.isArray(buttons) && buttons.every((b): b is string => typeof b === 'string')) out.bindings[action] = [...buttons];
        else bad(`bindings.${action}`, 'expected an array of strings');
      }
    }
  }
  if (raw.keyboardMap !== undefined) {
    if (!isRecord(raw.keyboardMap)) bad('keyboardMap', 'expected an object');
    else {
      for (const [code, button] of Object.entries(raw.keyboardMap)) {
        if (typeof button === 'string') out.keyboardMap[code] = button;
        else bad(`keyboardMap.${code}`, 'expected a string');
      }
    }
  }
  const known = new Set<string>(Object.keys(DEFAULT_SETTINGS));
  for (const k of Object.keys(raw)) if (!known.has(k)) issues.push(`${k}: unknown setting ignored`);
  return { settings: out, issues };
};

export interface LoadedSettings extends SettingsMerge {
  /** False when nothing was stored (defaults returned). */
  found: boolean;
}

/** Loads and merges settings, reporting what was repaired. Corrupt JSON yields defaults + an issue. */
export const loadSettingsDetailed = async (storage: StorageAdapter): Promise<LoadedSettings> => {
  const text = await storage.getItem(SETTINGS_KEY);
  if (text === null) return { settings: defaultSettings(), issues: [], found: false };
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch {
    return { settings: defaultSettings(), issues: ['stored settings are not valid JSON; using defaults'], found: true };
  }
  return { ...mergeSettings(raw), found: true };
};

/** Settings merged over DEFAULT_SETTINGS; never throws for missing or corrupt data. */
export const loadSettings = async (storage: StorageAdapter): Promise<Settings> => (await loadSettingsDetailed(storage)).settings;

/** Validates, canonicalises and stores settings; returns what was actually written. */
export const saveSettings = async (storage: StorageAdapter, settings: Settings): Promise<Settings> => {
  const { settings: canonical } = mergeSettings(settings);
  await storage.setItem(SETTINGS_KEY, serializeSettings(canonical));
  return canonical;
};
