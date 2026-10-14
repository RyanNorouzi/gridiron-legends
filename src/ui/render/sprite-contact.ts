/**
 * Athlete pose data shared by the sprite painter, plus the tackle-struggle poses: a carrier who is held but still
 * fighting ('wrapped': head down, leaning into the hit, ball tucked, legs churning), a tackler hanging on
 * ('wrapping': low, both arms around the runner, legs driving) and a body going to the ground ('falling': the
 * upright pose tipped over and sinking, via `tiltBuffer`). Pure pixel data, no randomness.
 */
import type { Rgb } from './palette';
import type { PixelBuffer, SpriteAnim } from './sprites';

export type ArmPose = 'down' | 'up' | 'out' | 'swing' | 'chest' | 'reach';

export interface LegPose { dx: number; dy: number }

export interface Pose {
  bob: number;
  legL: LegPose;
  legR: LegPose;
  armL: ArmPose;
  armR: ArmPose;
  lean: number;
  kickLeg: boolean;
}

export const NEUTRAL: Pose = Object.freeze({ bob: 0, legL: { dx: 0, dy: 0 }, legR: { dx: 0, dy: 0 }, armL: 'down', armR: 'down', lean: 0, kickLeg: false });

const leg = (dx: number, dy: number): LegPose => ({ dx, dy });

/**
 * Pose for the struggle animations (null for every other animation). `side` is true for the east / west facings,
 * where lean reads as a forward tilt; seen from the front or back the struggle reads through the lowered head and
 * the legs.
 */
export const contactPose = (anim: SpriteAnim, f: number, side: boolean): Pose | null => {
  const s = side ? 2 : 1;
  switch (anim) {
    case 'wrapped': {
      // Short, quick churning steps (four frames), the free arm pumping.
      const legs: readonly [LegPose, LegPose][] = [[leg(-s, 0), leg(0, -1)], [leg(-1, 0), leg(1, 0)], [leg(0, -1), leg(s, 0)], [leg(-s, 0), leg(s, 0)]];
      const [legL, legR] = legs[f % 4] as [LegPose, LegPose];
      return { ...NEUTRAL, bob: 1, lean: side ? 2 : 0, armL: 'chest', armR: f % 2 === 0 ? 'swing' : 'down', legL, legR };
    }
    case 'wrapping':
      // Low, arms wrapped around the runner, driving the legs.
      return f % 2 === 0
        ? { ...NEUTRAL, bob: 2, lean: side ? 2 : 0, armL: 'reach', armR: 'reach', legL: leg(-s, 0), legR: leg(1, -1) }
        : { ...NEUTRAL, bob: 2, lean: side ? 2 : 0, armL: 'reach', armR: 'reach', legL: leg(-1, -1), legR: leg(s, 0) };
    case 'falling':
      return { ...NEUTRAL, bob: 1, lean: side ? 1 : 0, armL: 'out', armR: 'out', legL: leg(-1, 0), legR: leg(1, 0) };
    default:
      return null;
  }
};

/** Minimal painter surface for the arm helper. */
export interface RectPainter {
  rect(x: number, y: number, w: number, h: number, c: Rgb): void;
}

/**
 * Both arms wrapped forward around the ball carrier. Side view: two forearms reaching past the chest; front / back:
 * the forearms cross the torso.
 */
export const drawReach = (p: RectPainter, skin: Rgb, side: boolean, lean: number, bob: number): void => {
  if (side) {
    // From the front of the chest to the sprite's edge (the runner's body fills the rest).
    const x = Math.min(13, 11 + lean);
    p.rect(x, 8 + bob, 16 - x, 1, skin);
    p.rect(x, 10 + bob, 15 - x, 1, skin);
  } else {
    p.rect(3 + lean, 9 + bob, 10, 1, skin);
  }
};

/**
 * Tips an upright body over for the falling animation: rows above the hips sink by `drop` pixels and, seen from
 * the side, lean toward `dir` (+1 = the painted forward, -1 = mirrored) by `shear` pixels per row. The feet stay put.
 */
export const tiltBuffer = (buf: PixelBuffer, dir: number, shear: number, drop: number): void => {
  const { width, height } = buf;
  const src = buf.data.slice();
  buf.data.fill(0);
  const pivot = height - 3;
  // Bottom-up so the sinking torso covers the legs it lands on.
  for (let y = height - 1; y >= 0; y--) {
    const up = y < pivot;
    const ny = up ? y + drop : y;
    const nx0 = up ? Math.round((pivot - y) * shear * dir) : 0;
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (src[i + 3] !== 255) continue;
      const nx = x + nx0;
      if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
      const j = (ny * width + nx) * 4;
      buf.data[j] = src[i] as number;
      buf.data[j + 1] = src[i + 1] as number;
      buf.data[j + 2] = src[i + 2] as number;
      buf.data[j + 3] = 255;
    }
  }
};

/** Tilt of each falling frame: [shear per row, rows dropped]. */
export const FALL_TILT: readonly (readonly [number, number])[] = Object.freeze([[0.25, 1], [0.55, 3]]);
