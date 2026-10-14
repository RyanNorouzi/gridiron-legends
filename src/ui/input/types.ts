import type { Vec2 } from '@/core/vec2';

/** Raw device-level buttons (gamepad-style vocabulary shared by all devices — the "virtual gamepad"). */
export type Button =
  | 'a' | 'b' | 'x' | 'y' | 'lb' | 'rb' | 'lt' | 'rt' | 'start' | 'select'
  | 'up' | 'down' | 'left' | 'right' | 'l3' | 'r3';

/**
 * Semantic actions the game understands. Control schemes map Buttons to Actions.
 * Routing: pause, showPlayArt, the menu actions, confirm and back are consumed by the screen stack; callTimeout
 * and challenge become GameCommands issued by the Game screen; snap, the audible actions and all live
 * offense/defense/kick actions flow only through UserPlayInput (built by src/ui/game/play-input.ts); replay,
 * camera and watch actions are handled by their screens; the dev actions by tools/.
 */
export type Action =
  // universal
  | 'confirm' | 'back' | 'pause' | 'menuUp' | 'menuDown' | 'menuLeft' | 'menuRight' | 'menuTabLeft' | 'menuTabRight'
  // digital movement (remappable; merged with analog axes)
  | 'moveUp' | 'moveDown' | 'moveLeft' | 'moveRight'
  // pre-snap
  | 'snap' | 'audible' | 'audibleManBeater' | 'audibleZoneBeater' | 'audibleBlitzBeater' | 'audibleFlipRunPass'
  | 'defAudibleMan' | 'defAudibleZone' | 'defAudibleBlitz' | 'defAudibleSpy'
  | 'showPlayArt' | 'callTimeout' | 'challenge'
  // offense live
  | 'sprint' | 'juke' | 'spin' | 'stiffArm' | 'hurdle' | 'dive' | 'slide' | 'throwAway' | 'pitch'
  | 'throw1' | 'throw2' | 'throw3' | 'throw4' | 'throw5'
  /** Held modifier selecting UserPlayInput.throwType (e.g. lob vs bullet). */
  | 'throwModifier'
  // defense live
  | 'switchPlayer' | 'tackle' | 'hitStick' | 'strip'
  /** Tap = jump (intercept); with modifier/hold = swat (deflect). Feeds UserPlayInput.jumpSwat. */
  | 'jumpSwat' | 'strafe'
  /** Defense-side alias that also feeds UserPlayInput.sprint. */
  | 'defSprint'
  // kicking
  /** Edge feeding UserPlayInput.kickPress. */
  | 'kick' | 'fairCatch'
  // watch mode
  | 'jumpIn' | 'skipPlay' | 'simSpeedUp' | 'simSpeedDown'
  // camera / replay
  | 'cameraCycle' | 'replayPlayPause' | 'replaySlow' | 'replayFast' | 'replayStepBack' | 'replayStepForward'
  // dev
  | 'devToggle' | 'devOverlayCycle';

export interface PointerState {
  /** Canvas-space coordinates in logical (unscaled) pixels. */
  x: number;
  y: number;
  down: boolean;
  justDown: boolean;
  justUp: boolean;
  /** Touch drag vector when a virtual stick is active. */
  drag: Vec2 | null;
  /** Mouse-wheel steps since the last tick (+ = scroll down / toward later rows); absent or 0 when none. */
  wheel?: number;
  /**
   * A secondary input held alongside the primary pointer: the right mouse button, or another finger resting on the
   * field (not on an on-screen button or the stick). The pull-back pass uses its press to switch lob / bullet.
   * Absent = false.
   */
  secondary?: boolean;
}

/** Snapshot returned by consumeTick(); valid for one simulation tick. */
export interface InputState {
  /** SCREEN/device frame: +x = right, +y = DOWN on the canvas (matches PointerState). Not field-relative; the
   *  game screen converts it to the field frame via the camera before building UserPlayInput. Magnitude <= 1. */
  axis: Vec2;
  down: ReadonlySet<Action>;
  justPressed: ReadonlySet<Action>;
  justReleased: ReadonlySet<Action>;
  pointer: PointerState | null;
  /**
   * Second analog stick (gamepad right stick) in the SCREEN frame like `axis`, magnitude <= 1 after the deadzone.
   * Used by the pull-back pass (pull the stick away from the target, let go to throw). Absent = centred.
   */
  aim?: Vec2;
  /** Last device that produced input; drives on-screen prompts. */
  lastDevice: 'keyboard' | 'mouse' | 'gamepad' | 'touch';
  /**
   * Text typed on a physical keyboard since the last tick, for text-entry screens: printable characters as typed,
   * plus '\b' (Backspace), '\n' (Enter) and '\x1b' (Escape). Optional/additive; absent = nothing typed.
   */
  text?: readonly string[];
}

/** KeyboardEvent.code, e.g. 'KeyW', 'Space'. */
export type KeyCode = string;

/** Physical -> virtual-gamepad layer, editable by the remap UI. */
export interface DeviceMap {
  keyboard: Record<KeyCode, Button>;
  /** Mouse button index -> Button. */
  mouse: Partial<Record<0 | 1 | 2, Button>>;
  /** 0..1 */
  gamepadDeadzone: number;
}

export interface InputSource {
  readonly device: InputState['lastDevice'];
  /** Raw sampling; called once per frame. Edge accumulation is owned by the InputManager, not sources. */
  poll(): { buttons: ReadonlySet<Button>; axis: Vec2; pointer: PointerState | null; text?: readonly string[]; aim?: Vec2 };
  attach(target: EventTarget): void;
  detach(): void;
  /** Sources that own physical keys implement this. */
  setDeviceMap?(map: DeviceMap): void;
}

/** Remappable binding: an Action may be triggered by any of several Buttons. */
export type ControlScheme = Record<Action, Button[]>;

/** Serialisable unit for the Settings screen and the settings store. */
export interface ControlProfile {
  version: 1;
  scheme: ControlScheme;
  deviceMap: DeviceMap;
}

export interface InputManager {
  /** Sample all sources and merge. Call once per animation frame. Does NOT clear edges. */
  update(): void;
  /** Returns a snapshot whose justPressed/justReleased contain every edge accumulated since the previous
   *  consumeTick, then clears them. Call exactly once per simulation tick (before PlayEngine.tick). If a frame
   *  runs zero ticks the edges carry over; if a frame runs several ticks only the first sees them. */
  consumeTick(): InputState;
  /** Last consumed snapshot (convenience readers below use it). */
  state(): InputState;
  setScheme(scheme: ControlScheme): void;
  getScheme(): ControlScheme;
  setDeviceMap(map: DeviceMap): void;
  getDeviceMap(): DeviceMap;
  isDown(action: Action): boolean;
  justPressed(action: Action): boolean;
  /** clamp(sum of every source's analog axis + digital vector from move* actions), magnitude <= 1. */
  axis(): Vec2;
  /** For on-screen prompts: the glyph currently bound to an action for the last active device. */
  glyph(action: Action): string;
}
