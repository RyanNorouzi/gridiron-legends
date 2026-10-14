/**
 * Pose registry of the figure painter (art bible §6, §14): every animation clip is a function from (frame, build)
 * to a rig pose (rig.ts). Chain A registers the core clips (anims-core, anims-qb, anims-catch-kick,
 * anims-celebrate) and serviceable defaults for the line-play and tackle clips (anims-contact-defaults); chain B
 * registers its own poses for §6.2 / §6.3 with `registerPoses(clip, poses, 'B')` from anims-line / anims-tackle,
 * which replace the defaults (a later registration of a clip wins). The painter (painter.ts) paints any clip that
 * has poses, in every facing, build, body variant and tier; bump `poseRevision` users by re-registering (the
 * painter id folds in the registry revision, so cached frames of replaced poses are never reused).
 *
 * Helpers for pose authors: `P` (a pose from partial fields over the neutral stance), `L` / `A` (leg / arm
 * joint angles) and `cycle` (a looping clip from a phase formula).
 */
import type { AnimId } from '../anim-ids';
import type { FigureBuild } from '../anim';
import type { ArmPose, LegPose, Pose } from './rig';

/** Poses of a clip: a fixed list (indexed by frame, clamped) or a function of the frame and the build. */
export type PoseSource = readonly Pose[] | ((frame: number, build: FigureBuild) => Pose);

const registry = new Map<AnimId, { src: PoseSource; owner: string }>();
let revision = 0;

/** Registers (or replaces) the poses of a clip. `owner` is informational ('A', 'B', 'default'). */
export const registerPoses = (clip: AnimId, src: PoseSource, owner = 'A'): void => {
  registry.set(clip, { src, owner });
  revision++;
};

/** Registers many clips at once. */
export const registerPoseSet = (set: Partial<Record<AnimId, PoseSource>>, owner = 'A'): void => {
  for (const [clip, src] of Object.entries(set) as [AnimId, PoseSource][]) registerPoses(clip, src, owner);
};

/** Registers a clip only when nothing is registered for it yet (defaults never replace a chain's poses). */
export const registerDefaultPoses = (clip: AnimId, src: PoseSource): void => {
  if (!registry.has(clip)) registerPoses(clip, src, 'default');
};

/** True when a clip has poses. */
export const hasPoses = (clip: AnimId): boolean => registry.has(clip);
/** Who registered a clip's poses (null when none). */
export const posesOwner = (clip: AnimId): string | null => registry.get(clip)?.owner ?? null;
/** Every clip with poses. */
export const posedClips = (): AnimId[] => [...registry.keys()];
/** Changes whenever poses are (re)registered. */
export const poseRevision = (): number => revision;

/** The pose of a clip frame for a build (null when the clip has no poses). */
export const poseFor = (clip: AnimId, frame: number, build: FigureBuild): Pose | null => {
  const e = registry.get(clip);
  if (!e) return null;
  if (typeof e.src === 'function') return e.src(frame, build);
  const list = e.src;
  if (list.length === 0) return null;
  return list[Math.max(0, Math.min(list.length - 1, Math.floor(frame)))] as Pose;
};

/** Removes every registration (tests). */
export const resetPoses = (): void => {
  registry.clear();
  revision++;
};

/** Leg joint angles: thigh pitch (+ forward), knee bend, lateral spread. */
export const L = (hip: number, knee: number, out = 0.08): LegPose => ({ hip, knee, out });
/** Arm joint angles: upper-arm pitch (+ forward, PI = straight up), lateral raise (negative = across), elbow bend. */
export const A = (sh: number, out = 0.2, elbow = 0.3): ArmPose => ({ sh, out, elbow });

/** The neutral upright pose. */
export const BASE: Pose = Object.freeze<Pose>({ lean: 0.05, twist: 0, head: 0, body: 0, lift: 0, legs: [L(0.05, 0.12, 0.1), L(0.05, 0.12, 0.1)], arms: [A(0.1, 0.22, 0.35), A(0.1, 0.22, 0.35)] });

/** Partial pose fields. */
export type PoseSpec = Partial<Pose>;
/** A pose from partial fields over `from` (default the neutral pose). */
export const P = (s: PoseSpec, from: Pose = BASE): Pose => ({ ...from, ...s });

/** A looping clip of `n` frames from a formula of the frame index. */
export const cycle = (n: number, f: (i: number) => Pose): Pose[] => Array.from({ length: n }, (_, i) => f(i));

/** One full turn. */
export const TAU = Math.PI * 2;
