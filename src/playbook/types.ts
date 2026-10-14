import type { Position } from '@/players/types';

/**
 * PLAYBOOK COORDINATE CONVENTION (play-local frame, yards):
 *   +x = offense's RIGHT, +y = DOWNFIELD (toward the defense). Origin = ball at the LOS.
 * Offensive slots have y <= 0. Defensive slots have y > 0.
 * The engine converts to absolute field coords with  absX = ballX + dir * x,  absY = losY + dir * y.
 *
 * ALL left/right and numbered names in this file (Gap 'A-left', ZoneName 'deepThirdLeft',
 * 'deepQuarter1'..'deepQuarter4' numbered left-to-right) are in the play-local frame, i.e. from
 * the OFFENSE's perspective, for BOTH OffAssignment and DefAssignment. Defensive data authors and
 * defensive AI must NOT mirror them.
 *
 * `OffAssignment.mirror`, `OffensivePlay.flip` and `DefensivePlay.flip` are resolved by the playbook
 * LOADER when it materialises a play; the engine and AI never see them. flip negates every slot x and
 * waypoint dx and swaps left<->right in Gap / ZoneName / runGap (use mirrorGap/mirrorZone/mirrorRoute).
 * mirror does the same for one route only.
 */
export interface FormationSlot {
  /** Unique role within the formation, e.g. 'QB', 'RB', 'WR1', 'TE1', 'LT', 'CB2', 'FS'. */
  role: string;
  /** Preferred position pulled from the depth chart. */
  position: Position;
  x: number;
  y: number;
  /** Eligible receiver (offense) — used by rules and AI. */
  eligible?: boolean;
}

export type Personnel = '10' | '11' | '12' | '13' | '20' | '21' | '22' | '00' | '23';

export interface OffensiveFormation {
  id: string;
  name: string;
  personnel: Personnel;
  slots: FormationSlot[];
  /** Shotgun/pistol depth affects snap timing and dropback. */
  qbAlignment: 'underCenter' | 'pistol' | 'shotgun';
}

export interface DefensiveFormation {
  id: string;
  name: string;
  /** e.g. '4-3', '3-4', 'nickel', 'dime', 'goalLine', 'prevent', '4-2-5' */
  base: string;
  slots: FormationSlot[];
  boxCount: number;
}

export type RouteType =
  | 'go' | 'post' | 'corner' | 'out' | 'in' | 'dig' | 'slant' | 'curl' | 'comeback'
  | 'drag' | 'flat' | 'wheel' | 'screen' | 'hitch' | 'seam' | 'fade' | 'cross'
  | 'angle' | 'stick' | 'swing' | 'checkRelease' | 'block';

export interface RouteWaypoint {
  /** Offsets from the receiver's alignment in the play-local frame. */
  dx: number;
  dy: number;
  /** Speed multiplier 0..1 (1 = full effort). */
  speed?: number;
  /** True when this waypoint is the primary break — QB timing keys off it. */
  isBreak?: boolean;
}

export interface RouteDef {
  id: string;
  type: RouteType;
  waypoints: RouteWaypoint[];
  /** Seconds after snap when the receiver reaches the primary break. */
  breakTime: number;
  /** Depth (yards) of the primary break. */
  depth: number;
  /** After completing the route, receivers improvise: 'settle' in zone, 'continue' downfield, 'comeBack' to QB. */
  scramble: 'settle' | 'continue' | 'comeBack';
}

export type Gap = 'A-left' | 'A-right' | 'B-left' | 'B-right' | 'C-left' | 'C-right' | 'D-left' | 'D-right';

/**
 * Offensive assignment types. On kick plays the KICKING team is the offense (see game/play-types PlayContext),
 * so kicker/holder/longSnapper/gunner/kickCoverage are offensive; returner/returnBlock are defensive.
 */
export type OffAssignmentType =
  | 'qb' | 'route' | 'runBlock' | 'passBlock' | 'carry' | 'leadBlock' | 'chipRelease'
  | 'kicker' | 'holder' | 'longSnapper' | 'gunner' | 'kickCoverage';

export interface OffAssignment {
  type: OffAssignmentType;
  /** RouteDef id when type === 'route'. */
  route?: string;
  /** Mirror route horizontally (for slots on the left side). Loader-resolved. */
  mirror?: boolean;
  /** Gap responsibility for run blocking / lead blocking. */
  gap?: Gap;
  /** For 'chipRelease': route to run after chip. */
  releaseRoute?: string;
  /** For play-action fakes: which role to fake to. */
  fakeTo?: string;
}

export type PlayType = 'run' | 'pass' | 'playAction' | 'rpo' | 'qbRun' | 'screen' | 'kneel' | 'spike' | 'special';

export type PlayConcept =
  | 'insideRun' | 'outsideRun' | 'draw' | 'screen' | 'slant' | 'curl' | 'out' | 'post' | 'corner'
  | 'go' | 'cross' | 'drag' | 'mesh' | 'fourVerts' | 'playAction' | 'rpo' | 'qbRun' | 'kneel'
  | 'spike' | 'kickoff' | 'onside' | 'punt' | 'fieldGoal' | 'extraPoint' | 'fakePunt' | 'fakeFieldGoal';

export interface AudibleSet {
  manBeater?: string;
  zoneBeater?: string;
  blitzBeater?: string;
  runToPass?: string;
  passToRun?: string;
}

export interface OffensivePlay {
  id: string;
  name: string;
  formation: string;
  type: PlayType;
  concept: PlayConcept;
  /** role -> assignment. Every slot in the formation must have an assignment. */
  assignments: Record<string, OffAssignment>;
  /** Primary read (role). */
  primary: string;
  /** Reads after the primary; use readOrder() / receiverSlots() for the full lists. */
  progression: string[];
  /** Runs only. */
  ballCarrier?: string;
  runGap?: Gap;
  /** Passing plays: dropback depth in yards (3, 5, 7). */
  dropback?: number;
  /** Play-action / RPO: role of the fake handoff target. */
  fakeTo?: string;
  audibles?: AudibleSet;
  /** Situational tags for AI playcalling: 'shortYardage', 'redZone', 'twoMinute', 'longYardage', 'goalLine', 'clockKill' */
  tags: string[];
  /** Mirror the whole play horizontally. Loader-resolved. */
  flip?: boolean;
}

export type CoverageShell = 'cover0' | 'cover1' | 'cover2' | 'cover3' | 'cover4' | 'cover6' | 'cover9';
export type CoverageFamily = 'man' | 'zone' | 'match';
export type BlitzType = 'none' | 'lb' | 'cb' | 'safety' | 'nickel' | 'doubleAGap' | 'edge' | 'zone' | 'allOut';

export type ZoneName =
  | 'deepThirdLeft' | 'deepThirdMiddle' | 'deepThirdRight'
  | 'deepHalfLeft' | 'deepHalfRight'
  | 'deepQuarter1' | 'deepQuarter2' | 'deepQuarter3' | 'deepQuarter4'
  | 'curlFlatLeft' | 'curlFlatRight' | 'hookCurlLeft' | 'hookCurlRight'
  | 'flatLeft' | 'flatRight' | 'middleHole' | 'middleHook';

export type DefAssignmentType =
  | 'manCover' | 'zone' | 'blitz' | 'rushGap' | 'contain' | 'spy' | 'runFill' | 'returner' | 'returnBlock';

export interface DefAssignment {
  type: DefAssignmentType;
  /** Offensive role to follow when type === 'manCover' (e.g. 'WR1', 'TE1', 'RB'). If the role is absent from the
   *  offensive formation the engine reassigns to the nearest uncovered eligible receiver at createPlay. */
  manTarget?: string;
  zone?: ZoneName;
  gap?: Gap;
  technique?: 'press' | 'off';
  /** Man coverage with deep help available (affects aggressiveness). */
  hasHelp?: boolean;
}

export interface DefensiveAudibleSet {
  manShift?: string;
  zoneShift?: string;
  blitz?: string;
  spy?: string;
}

export interface DefensivePlay {
  id: string;
  name: string;
  formation: string;
  coverage: CoverageShell;
  family: CoverageFamily;
  blitz: BlitzType;
  assignments: Record<string, DefAssignment>;
  tags: string[];
  audibles?: DefensiveAudibleSet;
  /** Mirror the whole play horizontally. Loader-resolved. */
  flip?: boolean;
  /** 'strength' flips the play so its strong side matches the offense's strength (TE/trips side). */
  alignTo?: 'none' | 'strength' | 'passStrength';
}

export interface Playbook {
  id: string;
  name: string;
  offensePlayIds: string[];
  defensePlayIds: string[];
}

/** Validation issues surfaced by the playbook loader. */
export interface PlaybookIssue {
  playId: string;
  message: string;
}

/* ------------------------------ Shared helpers ------------------------------ */

const swapLR = (s: string): string => (s.includes('left') ? s.replace('left', 'right') : s.includes('right') ? s.replace('right', 'left') : s);

export const mirrorGap = (g: Gap): Gap => swapLR(g) as Gap;

const ZONE_MIRROR: Partial<Record<ZoneName, ZoneName>> = {
  deepThirdLeft: 'deepThirdRight', deepThirdRight: 'deepThirdLeft',
  deepHalfLeft: 'deepHalfRight', deepHalfRight: 'deepHalfLeft',
  deepQuarter1: 'deepQuarter4', deepQuarter4: 'deepQuarter1', deepQuarter2: 'deepQuarter3', deepQuarter3: 'deepQuarter2',
  curlFlatLeft: 'curlFlatRight', curlFlatRight: 'curlFlatLeft', hookCurlLeft: 'hookCurlRight', hookCurlRight: 'hookCurlLeft',
  flatLeft: 'flatRight', flatRight: 'flatLeft',
};
export const mirrorZone = (z: ZoneName): ZoneName => ZONE_MIRROR[z] ?? z;

export const mirrorRoute = (r: RouteDef): RouteDef => ({ ...r, waypoints: r.waypoints.map((w) => ({ ...w, dx: -w.dx })) });

/** Full read list, primary first. */
export const readOrder = (play: OffensivePlay): string[] => [play.primary, ...play.progression.filter((r) => r !== play.primary)];

/**
 * Receiver slots for throw1..throw5 and the HUD icons: [primary, ...progression, ...remaining eligible slots
 * in formation order], deduplicated, capped at 5. Any eligible athlete (RB checkdown, TE) is targetable.
 */
export const receiverSlots = (play: OffensivePlay, formation: OffensiveFormation): string[] => {
  const out: string[] = [];
  const push = (r: string): void => {
    if (!out.includes(r) && out.length < 5) out.push(r);
  };
  for (const r of readOrder(play)) push(r);
  for (const s of formation.slots) if (s.eligible && play.assignments[s.role]?.type === 'route') push(s.role);
  return out;
};
