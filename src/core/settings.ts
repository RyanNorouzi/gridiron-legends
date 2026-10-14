/**
 * User settings shared by save/, audio/, ui/ and tools/. Lives in core/ because save and audio sit
 * below ui in the import order. Persisted by save/ as its own slot-independent record.
 */
export type TextSize = 'normal' | 'large';
export type ColorblindMode = 'none' | 'protanopia' | 'deuteranopia' | 'tritanopia';
export type CameraMode = 'standard' | 'defensive' | 'playerFollow' | 'zoomed' | 'kick' | 'replay' | 'simulation';
export type CameraContext = 'offense' | 'defense' | 'kick' | 'punt' | 'watch';
/** Field camera zoom preset: CLOSE (dynamic: close on the play, easing out to aim / follow a deep ball), STANDARD, WIDE. */
export type CameraZoom = 'close' | 'standard' | 'wide';
/** Crowd noise: 'max' = the stadium roars at full volume the whole game (default); 'reactive' = it rises and falls with the game. */
export type CrowdNoise = 'max' | 'reactive';
export type DefenseMode = 'control' | 'watch' | 'playcallOnly';
export type ReplayRetentionSetting = 'off' | 'lastPlay' | 'drive' | 'game';

/** 0..1 each. */
export interface AudioLevels {
  master: number;
  sfx: number;
  music: number;
  crowd: number;
  commentary: number;
}

export interface Settings {
  version: number;
  textSize: TextSize;
  colorblind: ColorblindMode;
  reducedMotion: boolean;
  screenShake: boolean;
  showTouchControls: 'auto' | 'on' | 'off';
  audio: AudioLevels;
  camera: Partial<Record<CameraContext, CameraMode>>;
  /** Camera zoom preset. Optional so older settings records stay valid; absent = 'close'. */
  cameraZoom?: CameraZoom;
  /** Crowd noise mode. Optional so older settings records stay valid; absent = 'max'. */
  crowdNoise?: CrowdNoise;
  replayRetention: ReplayRetentionSetting;
  /** Simulation speed multiplier for watch mode / auto-sim (1, 2, 4, 8). */
  simSpeed: number;
  /** Live-play pacing multiplier (0.5x .. 2x): play ticks run per 60 Hz frame; game time per tick is unchanged. */
  gameSpeed: number;
  defenseMode: DefenseMode;
  animations: boolean;
  devMode: boolean;
  /** Action -> Button[] as plain strings; ui/input validates into a ControlScheme (core cannot import ui). */
  bindings: Record<string, string[]>;
  /** KeyboardEvent.code -> Button as plain strings; validated by ui/input. */
  keyboardMap: Record<string, string>;
  playbookComplexity: 'simple' | 'standard' | 'advanced';
  /** True once the first-launch tutorial was played through or skipped (the main menu stops offering it).
   *  Optional so older settings records stay valid; absent = false. */
  tutorialCompleted?: boolean;
}

/** Default live-play pacing: a quarter faster than real time so the action on screen feels quick. */
export const DEFAULT_GAME_SPEED = 1.25;

export const DEFAULT_SETTINGS: Readonly<Settings> = Object.freeze({
  /** 2: the default gameSpeed became DEFAULT_GAME_SPEED; 3: the crowd slider defaults to 100% (owner: the crowd roars at
   *  maximum). save/settings-store.ts migrates older records once. */
  version: 3,
  textSize: 'normal',
  colorblind: 'none',
  reducedMotion: false,
  screenShake: true,
  showTouchControls: 'auto',
  audio: { master: 0.8, sfx: 1, music: 0.6, crowd: 1, commentary: 0.8 },
  camera: {},
  cameraZoom: 'close',
  replayRetention: 'drive',
  simSpeed: 4,
  /** Snappier default pacing (owner request: faster players); 1x stays available in Settings. */
  gameSpeed: DEFAULT_GAME_SPEED,
  defenseMode: 'control',
  animations: true,
  devMode: false,
  bindings: {},
  keyboardMap: {},
  playbookComplexity: 'standard',
  tutorialCompleted: false,
});
