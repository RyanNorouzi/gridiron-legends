/**
 * Every animation clip id of the art bible (§6.1 core, §6.2 line play, §6.3 tackles) with its default timing:
 * frame count, frames per second, how it plays and its priority. The art chains may retime a clip through the
 * registry (anim.ts `registerClip`) within the bible's ±15% tuning rule; the ids themselves are the contract.
 *  - `loop`: repeats (locomotion clips advance by distance travelled, others by the play clock);
 *  - `once`: a one-shot that plays to its last frame and then yields (it keeps playing even if the state that
 *    started it has already ended, unless something of higher priority takes over);
 *  - `hold`: a one-shot that holds its last frame for as long as its driver lasts.
 * Priority (higher interrupts lower): 0 stance / idle, 1 locomotion, 2 moves and actions (throws, catches,
 * kicks, jukes), 3 contact (blocks, tackles), 4 on the ground.
 */

/** Clip ids of chain A (core figures). */
export const CORE_ANIM_IDS = [
  'idle', 'stance2', 'stance3', 'snapStance', 'qbUnderCenter', 'qbShotgun', 'dbReady', 'returnerReady',
  'jog', 'run', 'sprint', 'carry', 'carrySprint', 'carryHigh', 'switchHands', 'backpedal', 'shuffle', 'cut', 'juke', 'spin',
  'stiffArm', 'hurdle', 'truck', 'stumble', 'dropback', 'setFeet', 'throw', 'throwLob', 'throwRun', 'handoff',
  'takeHandoff', 'pitch', 'slide', 'kneel', 'spike', 'reachOut', 'catchChest', 'catchHigh', 'catchDive',
  'catchSideline', 'catchTurn', 'drop', 'swat', 'jumpContest', 'kickoff', 'punt', 'fieldGoal', 'holdPlace',
  'longSnap', 'snap', 'fairCatch', 'getUp', 'injuredDown', 'celebrateSpike', 'celebrateLeap', 'celebratePoint',
  'celebrateFlex', 'highFive', 'sackDance', 'fistPump', 'dejected', 'down', 'downBack',
] as const;

/** Clip ids of chain B (line play). */
export const LINE_ANIM_IDS = [
  'passSet', 'fireOut', 'punch', 'handFight', 'driveBlock', 'driven', 'anchor', 'bullRush', 'doubleTeam', 'splitDouble',
  'swim', 'rip', 'spinMove', 'longArmShed', 'beaten', 'pancake', 'knockdown', 'knockback',
] as const;

/** Clip ids of chain B (tackles and contact). */
export const TACKLE_ANIM_IDS = [
  'tackleLunge', 'wrap', 'tackledBack', 'tackledFwd', 'hangOn', 'struggle', 'armGrab', 'spunDown', 'diveTackle', 'tripped',
  'bigHit', 'blownUp', 'pileOn', 'buried', 'openFieldWrap', 'rolledDown', 'stripChop', 'fumbleReach', 'scoopUp',
  'fallOnBall', 'whiff', 'shrugged', 'fallFwd', 'fallBack',
] as const;

/** Chain A clip ids. */
export type CoreAnimId = (typeof CORE_ANIM_IDS)[number];
/** Chain B line-play clip ids. */
export type LineAnimId = (typeof LINE_ANIM_IDS)[number];
/** Chain B tackle clip ids. */
export type TackleAnimId = (typeof TACKLE_ANIM_IDS)[number];
/** Any animation clip id. */
export type AnimId = CoreAnimId | LineAnimId | TackleAnimId;

/** Every clip id. */
export const ANIM_IDS: readonly AnimId[] = [...CORE_ANIM_IDS, ...LINE_ANIM_IDS, ...TACKLE_ANIM_IDS];

/** How a clip plays (see the module doc). */
export type ClipKind = 'loop' | 'once' | 'hold';
/** 0 stance / idle, 1 locomotion, 2 action, 3 contact, 4 ground. */
export type ClipPriority = 0 | 1 | 2 | 3 | 4;

/** Timing of a clip. */
export interface ClipTiming {
  frames: number;
  fps: number;
  kind: ClipKind;
  priority: ClipPriority;
  /** Locomotion loops: yards travelled per full cycle (the phase follows the odometer, so feet never slide). */
  strideYd?: number;
  /** A `once` clip that hands over to this clip when it finishes (e.g. catchTurn -> carry). */
  next?: AnimId;
  /** Lying on the ground on the last frame (drives getUp, shadows and pile order). */
  lying?: boolean;
}

const t = (frames: number, fps: number, kind: ClipKind, priority: ClipPriority, extra: Partial<ClipTiming> = {}): ClipTiming => ({ frames, fps, kind, priority, ...extra });
/** A locomotion loop whose cycle is `frames / fps * 6.5` yards (the bible's rate = speed / 6.5). */
const loco = (frames: number, fps: number): ClipTiming => t(frames, fps, 'loop', 1, { strideYd: (frames / fps) * 6.5 });

/** Default timings (art bible §6 tables). */
export const DEFAULT_TIMINGS: Readonly<Record<AnimId, ClipTiming>> = Object.freeze({
  idle: t(2, 2, 'loop', 0), stance2: t(2, 2, 'loop', 0), stance3: t(2, 2, 'loop', 0), snapStance: t(2, 2, 'loop', 0),
  qbUnderCenter: t(2, 2, 'loop', 0), qbShotgun: t(2, 2, 'loop', 0), dbReady: t(2, 2, 'loop', 0), returnerReady: t(2, 2, 'loop', 0),
  jog: loco(8, 10), run: loco(8, 12), sprint: loco(8, 14), carry: loco(8, 12), carrySprint: loco(8, 14), carryHigh: loco(8, 12),
  switchHands: t(2, 12, 'once', 2), backpedal: loco(6, 12), shuffle: loco(4, 10), cut: t(3, 15, 'once', 2), juke: t(4, 14, 'once', 2),
  spin: t(8, 16, 'once', 2), stiffArm: t(3, 12, 'hold', 2), hurdle: t(5, 12, 'once', 2), truck: t(4, 14, 'once', 2),
  stumble: t(5, 12, 'once', 2), dropback: loco(6, 12), setFeet: t(4, 10, 'loop', 1), throw: t(5, 16, 'once', 2),
  throwLob: t(5, 14, 'once', 2), throwRun: t(4, 16, 'once', 2), handoff: t(3, 12, 'once', 2), takeHandoff: t(3, 12, 'once', 2),
  pitch: t(3, 14, 'once', 2), slide: t(4, 12, 'hold', 3, { lying: true }), kneel: t(2, 6, 'hold', 2), spike: t(3, 14, 'once', 2),
  reachOut: t(2, 8, 'hold', 2), catchChest: t(3, 14, 'once', 2), catchHigh: t(4, 14, 'once', 2),
  catchDive: t(5, 14, 'hold', 3, { lying: true }), catchSideline: t(4, 12, 'once', 2), catchTurn: t(3, 14, 'once', 2, { next: 'carry' }),
  drop: t(3, 12, 'once', 2), swat: t(3, 16, 'once', 2), jumpContest: t(4, 14, 'once', 2), kickoff: t(5, 14, 'once', 2),
  punt: t(5, 14, 'once', 2), fieldGoal: t(5, 14, 'once', 2), holdPlace: t(3, 10, 'hold', 2), longSnap: t(3, 16, 'once', 2),
  snap: t(2, 12, 'once', 2), fairCatch: t(2, 6, 'loop', 2), getUp: t(4, 8, 'once', 2), injuredDown: t(2, 2, 'loop', 4, { lying: true }),
  celebrateSpike: t(4, 10, 'once', 2), celebrateLeap: t(4, 10, 'once', 2), celebratePoint: t(3, 8, 'once', 2),
  celebrateFlex: t(3, 8, 'loop', 2), highFive: t(3, 10, 'once', 2), sackDance: t(4, 10, 'loop', 2), fistPump: t(2, 8, 'once', 2),
  dejected: t(2, 2, 'loop', 0), down: t(1, 1, 'hold', 4, { lying: true }), downBack: t(1, 1, 'hold', 4, { lying: true }),
  // chain B: line play
  passSet: t(4, 10, 'loop', 1), fireOut: t(3, 16, 'once', 2), punch: t(3, 16, 'once', 3), handFight: t(4, 10, 'loop', 3),
  driveBlock: t(4, 10, 'loop', 3), driven: t(4, 10, 'loop', 3), anchor: t(4, 10, 'loop', 3), bullRush: t(4, 10, 'loop', 3),
  doubleTeam: t(4, 10, 'loop', 3), splitDouble: t(4, 10, 'loop', 3), swim: t(6, 14, 'once', 3), rip: t(5, 14, 'once', 3),
  spinMove: t(6, 16, 'once', 3), longArmShed: t(4, 12, 'once', 3), beaten: t(3, 12, 'once', 3),
  pancake: t(4, 12, 'hold', 3), knockdown: t(5, 12, 'once', 4, { next: 'downBack', lying: true }), knockback: t(5, 12, 'once', 3),
  // chain B: tackles
  tackleLunge: t(3, 14, 'hold', 3), wrap: t(6, 12, 'hold', 3, { lying: true }), tackledBack: t(6, 12, 'hold', 4, { lying: true }),
  tackledFwd: t(5, 12, 'hold', 4, { lying: true }), hangOn: t(4, 10, 'loop', 3), struggle: t(4, 10, 'loop', 3),
  armGrab: t(4, 12, 'hold', 3), spunDown: t(5, 12, 'hold', 4, { lying: true }), diveTackle: t(4, 14, 'hold', 3, { lying: true }),
  tripped: t(5, 14, 'hold', 4, { lying: true }), bigHit: t(5, 16, 'hold', 3), blownUp: t(6, 16, 'hold', 4, { lying: true }),
  pileOn: t(4, 12, 'hold', 4, { lying: true }), buried: t(1, 1, 'hold', 4, { lying: true }), openFieldWrap: t(5, 12, 'hold', 3, { lying: true }),
  rolledDown: t(5, 12, 'hold', 4, { lying: true }), stripChop: t(4, 16, 'once', 3), fumbleReach: t(3, 16, 'once', 3),
  scoopUp: t(3, 12, 'once', 2), fallOnBall: t(4, 12, 'hold', 4, { lying: true }), whiff: t(4, 12, 'once', 3),
  shrugged: t(3, 12, 'once', 3), fallFwd: t(5, 12, 'hold', 4, { lying: true }), fallBack: t(5, 12, 'hold', 4, { lying: true }),
});

/** True for a known clip id. */
export const isAnimId = (s: string): s is AnimId => Object.prototype.hasOwnProperty.call(DEFAULT_TIMINGS, s);
