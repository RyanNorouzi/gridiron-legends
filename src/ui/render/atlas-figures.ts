/**
 * Figure frames through the atlas: resolves a FrameRequest to its painter (anim.ts registry) and cached frame,
 * within the per-frame paint budget (past it, the caller's previous frame for that athlete is drawn instead, or the
 * frame is painted anyway when there is nothing to fall back to), and builds the prerender plan: for every figure
 * on the field, the pre-snap stance (in the facing it is shown in, or all 8 when none is given) first, then the
 * run / carry cycles in the six side and diagonal facings, then the block loop facing across the line. Plans are
 * queued once per play (pre-snap) for the athletes actually on the field, at the live tier; the scene compositor
 * pumps the queue in time slices. (Cache keys include the jersey number only for painters that bake it.)
 */
import { FACINGS, type Facing8 } from './sprites';
import { canonicalRequest, clipTiming, frameKey, painterFor, type AnimId, type BodyVar, type FigureBuild, type FigureKit, type FramePainter, type FrameRequest } from './anim';
import { SpriteAtlas, type AtlasFrame, type AtlasJob } from './atlas';
import type { FigureTier } from './world-layer';

/** The atlas every world-layer view shares (LRU 2500 frames, 1.5 ms of cache-miss painting per frame). */
export const FIGURE_ATLAS = new SpriteAtlas();

/** A resolved figure frame. */
export interface ResolvedFigure {
  frame: AtlasFrame;
  painter: FramePainter;
  key: string;
}

/**
 * The frame for `req`: cached, else painted within the budget; past the budget the `fallbackKey` frame (the
 * athlete's previous one) when still cached, else painted anyway. Null only when no painter is registered.
 */
export const resolveFigure = (atlas: SpriteAtlas, req: FrameRequest, fallbackKey: string | null): ResolvedFigure | null => {
  const painter = painterFor(req.clip);
  if (!painter) return null;
  const canon = canonicalRequest(painter, req);
  const key = frameKey(painter, canon);
  const paint = (): ReturnType<FramePainter['paint']> => painter.paint(canon);
  const got = atlas.get(key, paint, fallbackKey === null);
  if (got) return { frame: got, painter, key };
  const prev = fallbackKey ? atlas.peek(fallbackKey) : null;
  if (prev) return { frame: prev, painter, key: fallbackKey as string };
  return { frame: atlas.paintNow(key, paint), painter, key };
};

/** One figure to prerender (a player on the field, in his kit). */
export interface CastMember {
  kit: FigureKit;
  build: FigureBuild;
  bodyVar: BodyVar;
  skin: number;
  number: number;
  accessory: number;
  /** Pre-snap stance clip. */
  stance: AnimId;
  /** Facing the stance is shown in (all 8 when omitted). */
  facing?: Facing8;
}

const SIDE_FACINGS: readonly Facing8[] = ['e', 'w', 'ne', 'se', 'nw', 'sw'];

/** Jobs for a cast at a tier, in the bible's priority order (stances, then run / carry cycles, then blocks). */
export const prerenderJobs = (cast: readonly CastMember[], tier: FigureTier, lighting: string, stanceTier: FigureTier = tier): AtlasJob[] => {
  const jobs: AtlasJob[] = [];
  const add = (m: CastMember, clip: AnimId, frame: number, facing: Facing8, ball: boolean, at: FigureTier = tier): void => {
    const req: FrameRequest = { clip, frame, facing, build: m.build, bodyVar: m.bodyVar, tier: at, kit: m.kit, skin: m.skin, number: m.number, ball, accessory: m.accessory, lighting };
    const painter = painterFor(clip);
    if (!painter) return;
    const canon = canonicalRequest(painter, req);
    jobs.push({ key: frameKey(painter, canon), paint: () => painter.paint(canon) });
  };
  for (const m of cast) for (const f of m.facing ? [m.facing] : FACINGS) for (let i = 0; i < clipTiming(m.stance).frames; i++) add(m, m.stance, i, f, false, stanceTier);
  for (const m of cast) {
    const clips: AnimId[] = m.build === 'bigO' || m.build === 'bigD' ? ['run'] : m.build === 'back' || m.build === 'slim' ? ['run', 'carry'] : ['run'];
    for (const clip of clips) for (const f of SIDE_FACINGS) for (let i = 0; i < clipTiming(clip).frames; i++) add(m, clip, i, f, clip === 'carry');
  }
  for (const m of cast) {
    if (m.build !== 'bigO' && m.build !== 'bigD') continue;
    for (const f of ['e', 'w'] as const) for (let i = 0; i < clipTiming('handFight').frames; i++) add(m, 'handFight', i, f, false);
  }
  return jobs;
};

/** Queues a cast's prerender jobs on the atlas (cached frames are skipped). */
export const prerenderCast = (atlas: SpriteAtlas, cast: readonly CastMember[], tier: FigureTier, lighting: string, stanceTier: FigureTier = tier): void => {
  atlas.prerender(prerenderJobs(cast, tier, lighting, stanceTier));
};
