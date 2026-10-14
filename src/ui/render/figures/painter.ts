/**
 * Chain A's figure painter (art bible §11): a FramePainter (anim.ts) over the two-stage figure cache.
 *  1. Geometry: pose (anims.ts registry) x build x body variant x tier x facing x ball x accessories x decal ->
 *     indexed buffer + attachments (raster-geom.ts), LRU-cached (GEOM_CACHE_MAX entries). Shared by both teams and
 *     every skin tone.
 *  2. Colour: the indexed buffer through the kit / skin / lighting LUT (materials.ts, raster-paint.ts) -> RGBA; the
 *     atlas (atlas.ts) caches the result as a surface.
 * Jersey numbers are stamped at draw time in `decorate` (numbers.ts), so they are not part of any cache key. The
 * carried ball is painted into the frame (`drawsBall`), in the arm on the camera side for side-on facings (the
 * pose is mirrored for west-facing carriers) and attached to the throwing hand for throws. `normalize` folds the
 * request fields that do not change the pixels (number, accessory bits that do not apply, day / night / indoor
 * lighting, frames past the clip's end, the ball in clips that never show it).
 */
import { clipTiming, type FigureBuild, type FigureKit, type FramePainter, type FrameRequest, type PaintedFrame } from '../anim';
import type { Facing8 } from '../sprites';
import { TIER_SCALE } from '../world-layer';
import { poseFor, poseRevision } from './anims';
import { DECALS, decalFor } from './decals';
import { lutFor, lutLighting } from './materials';
import { stampNumber } from './numbers';
import { paintGeometry, type GeomFrame, type GeomStyle } from './raster-geom';
import { colorize } from './raster-paint';
import { buildDims, mirrorPose, type Pose } from './rig';

/** Screen angle of each 8-way facing ('s' = toward the viewer). */
export const FACING_ANGLE: Readonly<Record<Facing8, number>> = Object.freeze({
  e: 0, se: Math.PI / 4, s: Math.PI / 2, sw: (3 * Math.PI) / 4, w: Math.PI, nw: (-3 * Math.PI) / 4, n: -Math.PI / 2, ne: -Math.PI / 4,
});

/**
 * Retro 3/4 view: side facings turn a little toward the camera so a figure running along the field shows its
 * chest, number side and both shoulder pads (a 16-bit sports-sprite silhouette) instead of a thin profile.
 */
export const RETRO_TURN = 0.3;
/** Extra shoulder twist toward the camera on side facings (radians at due east / west). */
export const RETRO_TWIST = 0.45;
/** View angle of a facing angle `theta` with the retro 3/4 turn (a little less on the away-from-camera facings). */
export const retroView = (theta: number): number => theta + RETRO_TURN * Math.cos(theta) * (Math.sin(theta) < -0.05 ? 0.6 : 1);

/** Clips that stay square to the opponent (no 3/4 shoulder cheat): line stances and line play. */
const SQUARE_CLIPS: ReadonlySet<string> = new Set(['stance3', 'snapStance', 'passSet', 'fireOut', 'punch', 'longSnap', 'snap']);

/** Most cached geometry frames (bible §11: 4000). */
export const GEOM_CACHE_MAX = 4000;

/** Accessory bits (bible §3.2): 1 visor, 2 towel, 4 elbow sleeves. */
export const accessoryBits = (build: FigureBuild, seed: number): number => {
  const s = seed >>> 0;
  const skill = build === 'slim' || build === 'back' || build === 'qb';
  let bits = 0;
  if (skill && s % 100 < 15) bits |= 1;
  if (skill && (s >>> 8) % 100 < 30) bits |= 2;
  if (build !== 'kick' && (s >>> 16) % 100 < 20) bits |= 4;
  return bits;
};

const isLineman = (b: FigureBuild): boolean => b === 'bigO' || b === 'bigD';

/** Geometry style for a request. */
export const styleFor = (req: FrameRequest, decal: number): GeomStyle => {
  const k = TIER_SCALE[req.tier];
  const acc = req.accessory;
  return {
    mask: k < 0.8 || req.build === 'kick' ? 0 : isLineman(req.build) ? 2 : 1,
    visor: (acc & 1) !== 0,
    towel: (acc & 2) !== 0,
    elbowSleeves: (acc & 4) !== 0,
    decal: DECALS[decal] ?? null,
    tiny: k < 0.8,
    linemanHands: isLineman(req.build),
    shortSleeves: isLineman(req.build) || req.build === 'power',
    tierScale: k,
  };
};

/**
 * Clips whose planted hand goes to the far side on east-ish facings: a three-point stance with the down hand on the
 * camera side hangs 3 px lower than the feet, into the row of the lineman in front of him.
 */
const FAR_HAND_CLIPS: ReadonlySet<string> = new Set(['stance3']);

/** The pose a request paints (mirrored so a carried ball sits in the camera-side arm, and a down hand on the far side). */
export const requestPose = (req: FrameRequest): { pose: Pose; mirrored: boolean } | null => {
  const pose = poseFor(req.clip, req.frame, req.build);
  if (!pose) return null;
  const hold = pose.hold ?? 'tuck';
  const c = Math.cos(FACING_ANGLE[req.facing]);
  const mirrored = (req.ball && hold === 'tuck' && c < -0.1) || (!req.ball && FAR_HAND_CLIPS.has(req.clip) && c > 0.1);
  return { pose: mirrored ? mirrorPose(pose) : pose, mirrored };
};

/** A painted figure frame: the atlas frame plus where the number fits. */
export interface FigureFrame extends PaintedFrame {
  numberSpot: GeomFrame['number'];
}

const isFigureFrame = (f: PaintedFrame): f is FigureFrame => 'numberSpot' in f;

/** Creates the figure painter (its own geometry LRU). */
export const createFigurePainter = (): FramePainter & { readonly geomSize: number; geometry(req: FrameRequest): GeomFrame | null } => {
  const geom = new Map<string, GeomFrame>();
  let rev = poseRevision();
  const geometry = (req: FrameRequest): GeomFrame | null => {
    if (rev !== poseRevision()) { geom.clear(); rev = poseRevision(); }
    const decal = decalFor(req.kit);
    const key = `${req.clip}|${req.frame}|${req.facing}|${req.build}|${req.bodyVar}|${req.tier}|${req.ball ? 1 : 0}|${req.accessory}|${decal}`;
    const hit = geom.get(key);
    if (hit) {
      geom.delete(key);
      geom.set(key, hit);
      return hit;
    }
    const rp = requestPose(req);
    if (!rp) return null;
    const dims = buildDims(req.build, req.bodyVar, TIER_SCALE[req.tier]);
    const lifted = rp.pose.lift ? { ...rp.pose, lift: rp.pose.lift * TIER_SCALE[req.tier] } : rp.pose;
    const theta = FACING_ANGLE[req.facing];
    // 3/4 cheat: on side facings the shoulders open toward the camera (legs keep striding in profile)
    // (not in contact clips: a locked lineman or a tackler must square up to his man, not look at the camera)
    const upright = Math.abs(lifted.body) < 0.6 && clipTiming(req.clip).priority < 3 && !SQUARE_CLIPS.has(req.clip);
    const pose = upright ? { ...lifted, twist: lifted.twist + RETRO_TWIST * Math.cos(theta) } : lifted;
    const fr = paintGeometry(pose, dims, retroView(theta), styleFor(req, decal), req.ball, rp.mirrored ? 0 : 1);
    geom.set(key, fr);
    if (geom.size > GEOM_CACHE_MAX) geom.delete(geom.keys().next().value as string);
    return fr;
  };
  return {
    get id(): string { return `figA.${poseRevision()}`; },
    bakesNumber: false,
    drawsBall: true,
    get geomSize(): number { return geom.size; },
    geometry,
    normalize(req: FrameRequest): FrameRequest {
      const n = clipTiming(req.clip).frames;
      const frame = ((Math.floor(req.frame) % n) + n) % n;
      const pose = poseFor(req.clip, frame, req.build);
      const ball = req.ball && (pose?.hold ?? 'tuck') !== 'none';
      return { ...req, frame, number: 0, ball, accessory: accessoryBits(req.build, req.accessory), lighting: lutLighting(req.lighting) };
    },
    paint(req: FrameRequest): FigureFrame {
      const fr = geometry(req);
      if (!fr) return { width: 1, height: 1, ax: 0, ay: 0, rgba: new Uint8ClampedArray(4), numberSpot: null };
      return {
        width: fr.width, height: fr.height, ax: fr.ax, ay: fr.ay,
        rgba: colorize(fr, lutFor(req.kit, req.skin, req.lighting)),
        attach: fr.attach,
        numberSpot: fr.number,
      };
    },
    decorate(ctx: CanvasRenderingContext2D, frame: PaintedFrame, req: FrameRequest, x: number, y: number): void {
      if (req.tier > 2 || !isFigureFrame(frame) || !frame.numberSpot) return;
      stampNumber(ctx, req.kit, req.number, frame.numberSpot, x, y);
    },
  };
};

/** Kit of a request (re-exported for tools). */
export type { FigureKit };
