/**
 * Animation registry (art bible §6, §11): what the art chains fill in. A CLIP is an AnimId plus its timing
 * (anim-ids.ts defaults, retimable here); a PAINTER turns one frame request (clip, frame, facing, build, body
 * variant, tier, kit, skin, number, ball) into pixels. Painters are registered for a set of clips (or every clip
 * as a fallback); the most recently registered painter that covers a clip wins, so chain A registers its figure
 * painter over the placeholder (anim-legacy.ts) without editing this file. Frames are cached by atlas.ts under
 * `frameKey`, so a painter must be a pure function of the request.
 * Also here: the per-frame `Look` the selection layer (anim-select.ts, chain B's contact override) produces, the
 * figure builds per position, body variants, and frame sampling (`frameAt`, `strideFrame`).
 */
import type { Position } from '@/players/types';
import type { TeamSide } from '@/game/types';
import type { TeamColors } from '@/teams/types';
import { ANIM_IDS, DEFAULT_TIMINGS, type AnimId, type ClipTiming } from './anim-ids';
import type { Facing8 } from './sprites';
import type { FigureTier } from './world-layer';

export type { AnimId, ClipTiming } from './anim-ids';

/** Body builds (art bible §3.2). */
export type FigureBuild = 'bigO' | 'bigD' | 'power' | 'back' | 'qb' | 'slim' | 'kick';
/** Every build, in bible order. */
export const FIGURE_BUILDS: readonly FigureBuild[] = ['bigO', 'bigD', 'power', 'back', 'qb', 'slim', 'kick'];

/** Narrow / average / wide within a build (weight tercile). */
export type BodyVar = 0 | 1 | 2;

/** Build for a roster position (LS -> power; K / P -> kick). */
export const buildForPosition = (position: Position | string): FigureBuild => {
  switch (position) {
    case 'OT': case 'OG': case 'C': return 'bigO';
    case 'DE': case 'DT': return 'bigD';
    case 'TE': case 'FB': case 'OLB': case 'MLB': case 'LS': return 'power';
    case 'RB': return 'back';
    case 'QB': return 'qb';
    case 'K': case 'P': return 'kick';
    default: return 'slim';
  }
};

/** Weight (lb) boundaries of the narrow / wide terciles per build. */
const BODY_WEIGHT: Readonly<Record<FigureBuild, readonly [number, number]>> = Object.freeze({
  bigO: [305, 325], bigD: [280, 305], power: [235, 250], back: [205, 222], qb: [210, 228], slim: [185, 200], kick: [185, 205],
});

/** Body variant from weight within the build (average when unknown). */
export const bodyVarFor = (build: FigureBuild, weightLb: number | undefined): BodyVar => {
  if (weightLb === undefined || !Number.isFinite(weightLb)) return 1;
  const [lo, hi] = BODY_WEIGHT[build];
  return weightLb < lo ? 0 : weightLb > hi ? 2 : 1;
};

/**
 * A team's game-day kit as the painters see it: the side (home wears colour over light pants, away white over
 * colour; bible §5), the team's resolved palette (colour-blind modes already applied) and the legacy game-day
 * uniform (`teamUniforms`: home colours / away whites) the placeholder paints with. `id` is stable per colour set
 * and side and is part of the frame cache key; chain A derives its ramps and LUTs from these.
 */
export interface FigureKit {
  id: string;
  side: TeamSide;
  palette: TeamColors;
  uniform: TeamColors;
}

const colorsKey = (c: TeamColors): string => `${c.primary}${c.secondary}${c.accent}${c.helmet}`;

/** Builds a kit with a stable id. */
export const makeKit = (side: TeamSide, palette: TeamColors, uniform: TeamColors): FigureKit => ({
  id: `${side}:${colorsKey(palette)}:${colorsKey(uniform)}`,
  side,
  palette,
  uniform,
});

/** Everything a painter needs for one frame. Pure data; the frame cache key is derived from it. */
export interface FrameRequest {
  clip: AnimId;
  /** Frame index within the clip (0 .. frames-1). */
  frame: number;
  facing: Facing8;
  build: FigureBuild;
  bodyVar: BodyVar;
  tier: FigureTier;
  kit: FigureKit;
  /** Index into SKIN_TONES. */
  skin: number;
  /** Jersey number (only part of the key for painters that bake it). */
  number: number;
  /** Carrying the ball (in the arm). */
  ball: boolean;
  /** Render-only accessory seed (hash of the player id): visor, towel, sleeves (bible §3.2). */
  accessory: number;
  lighting: string;
}

/** Attachment points of a painted frame, in art px relative to the frame's anchor (the feet). */
export interface FrameAttachments {
  helmetTop?: { x: number; y: number };
  torsoCentre?: { x: number; y: number };
  ball?: { x: number; y: number };
  hands?: readonly { x: number; y: number }[];
  feet?: readonly { x: number; y: number }[];
  /** Chest number quad (left, top, width, height) when visible from this facing. */
  chestNumber?: { x: number; y: number; w: number; h: number; back: boolean } | null;
}

/**
 * One painted frame: art-pixel size and anchor (the midpoint between the feet on the ground), and either RGBA
 * pixels or a draw callback into a `width` x `height` context. `image` is filled in by the atlas.
 */
export interface PaintedFrame {
  width: number;
  height: number;
  ax: number;
  ay: number;
  rgba?: Uint8ClampedArray;
  draw?: (ctx: CanvasRenderingContext2D) => void;
  attach?: FrameAttachments;
}

/** A frame painter (chain A's rig, chain B's contact poses, or the placeholder). */
export interface FramePainter {
  /** Unique id; part of the cache key, so bump it when the art changes within a session (dev reloads). */
  readonly id: string;
  /** True when the number is painted into the frame (then it is part of the cache key). */
  readonly bakesNumber?: boolean;
  /** True when the carried ball is painted into the frame (req.ball); else the compositor draws it at attach.ball. */
  readonly drawsBall?: boolean;
  paint(req: FrameRequest): PaintedFrame;
  /**
   * Optional: the canonical request for `req` (fields the painter ignores set to fixed values, frames that look
   * the same folded together). Cache keys and painting use it, so equivalent frames are painted once.
   */
  normalize?(req: FrameRequest): FrameRequest;
  /**
   * Optional draw-time decoration on the world layer after the cached frame is blitted (e.g. jersey numbers
   * stamped from digit tiles). (x, y) is the frame anchor in art px.
   */
  decorate?(ctx: CanvasRenderingContext2D, frame: PaintedFrame, req: FrameRequest, x: number, y: number): void;
}

interface PainterEntry { painter: FramePainter; clips: ReadonlySet<AnimId> | null; order: number }

const timings = new Map<AnimId, ClipTiming>();
const painters: PainterEntry[] = [];
let painterOrder = 0;

/** Timing of a clip (registered override, else the bible default). */
export const clipTiming = (clip: AnimId): ClipTiming => timings.get(clip) ?? DEFAULT_TIMINGS[clip];

/** Overrides a clip's timing (partial: unspecified fields keep the default). */
export const registerClip = (clip: AnimId, timing: Partial<ClipTiming>): void => {
  timings.set(clip, { ...DEFAULT_TIMINGS[clip], ...timing });
};

/**
 * Registers a painter for `clips` (omitted = every clip, a fallback). Later registrations win over earlier ones
 * for the clips they cover. Returns an unregister function (tests).
 */
export const registerPainter = (painter: FramePainter, clips?: readonly AnimId[]): (() => void) => {
  const entry: PainterEntry = { painter, clips: clips ? new Set(clips) : null, order: painterOrder++ };
  painters.push(entry);
  return () => {
    const i = painters.indexOf(entry);
    if (i >= 0) painters.splice(i, 1);
  };
};

/** The painter that draws `clip`: the latest specific registration, else the latest fallback; null when none. */
export const painterFor = (clip: AnimId): FramePainter | null => {
  let best: PainterEntry | null = null;
  for (const e of painters) {
    const covers = e.clips === null || e.clips.has(clip);
    if (!covers) continue;
    const specific = e.clips !== null;
    const bestSpecific = best ? best.clips !== null : false;
    if (!best || (specific && !bestSpecific) || (specific === bestSpecific && e.order > best.order)) best = e;
  }
  return best?.painter ?? null;
};

/** True when a fallback painter (one registered for every clip) is registered. */
export const hasFallbackPainter = (): boolean => painters.some((e) => e.clips === null);

/** Clips with no specific (non-fallback) painter yet: the art chains' to-do list. */
export const unpaintedClips = (): AnimId[] => ANIM_IDS.filter((c) => !painters.some((e) => e.clips?.has(c)));

/** Clears every override and painter (tests). */
export const resetAnimRegistry = (): void => {
  timings.clear();
  painters.length = 0;
};

/** The request a painter actually paints for `req` (its `normalize`, else `req` itself). */
export const canonicalRequest = (painter: FramePainter, req: FrameRequest): FrameRequest => painter.normalize?.(req) ?? req;

/** Cache key of a frame for a painter (of the canonical request). */
export const frameKey = (painter: FramePainter, req: FrameRequest): string => rawFrameKey(painter, canonicalRequest(painter, req));

const rawFrameKey = (painter: FramePainter, r: FrameRequest): string =>
  `${painter.id}|${r.clip}|${r.frame}|${r.facing}|${r.build}|${r.bodyVar}|${r.tier}|${r.kit.id}|${r.skin}|${painter.bakesNumber ? r.number : ''}|${r.ball ? 1 : 0}|${r.accessory & 0xff}|${r.lighting}`;

/**
 * Frame of a clip `seconds` after it started: loops wrap (offset by `phase` frames), one-shots clamp to the last
 * frame. Negative time is frame 0.
 */
export const frameAt = (clip: AnimId, seconds: number, phase = 0): number => {
  const c = clipTiming(clip);
  const raw = Math.floor(Math.max(0, seconds) * c.fps + 1e-6);
  if (c.kind === 'loop') return (((raw + Math.floor(phase)) % c.frames) + c.frames) % c.frames;
  return Math.min(c.frames - 1, raw);
};

/** Seconds a one-shot clip takes to reach its last frame. */
export const clipSeconds = (clip: AnimId): number => {
  const c = clipTiming(clip);
  return c.frames / c.fps;
};

/** Locomotion frame from the odometer: `distanceYd` travelled, offset by `phase` frames. */
export const strideFrame = (clip: AnimId, distanceYd: number, phase = 0): number => {
  const c = clipTiming(clip);
  const stride = c.strideYd ?? (c.frames / c.fps) * 6.5;
  const raw = Math.floor((Math.max(0, distanceYd) / stride) * c.frames + 1e-6) + Math.floor(phase);
  return ((raw % c.frames) + c.frames) % c.frames;
};

/**
 * What one athlete looks like this frame: the clip and frame, the screen facing, a render offset from the
 * simulated position (art px, already scaled by tier; bible §6.2 caps it at MAX_RENDER_OFFSET), an extra lift
 * (art px up the screen: hurdles, piles, blown-up carriers) and whether the body lies on the ground.
 */
export interface Look {
  clip: AnimId;
  frame: number;
  facing: Facing8;
  dx: number;
  dy: number;
  lift?: number;
  lying?: boolean;
  /** Draw order nudge within the same feet y (pile layers: later arrivals on top). */
  layer?: number;
}

/** Longest render offset from the simulated position, art px at tier 1 (scaled by tier). */
export const MAX_RENDER_OFFSET = 8;
