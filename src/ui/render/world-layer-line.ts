/**
 * Render-only spacing of the line of scrimmage (line-play readability). On the horizontal field the interior
 * linemen stand 1.15 yd apart across the field: 10-12 art px on screen at the pre-snap / CLOSE zooms, while a
 * lineman is ~20 px tall, so the rows of bodies pile into one block. Two smooth, stateless nudges of where a figure
 * is DRAWN (never where it is simulated):
 *  - the line fan: bodies near the line of scrimmage are spread across the field a little (LINE_FAN of their
 *    distance from the ball, eased to nothing by FAN_OUTER yd across and FAN_FAR yd up / down the field), so each
 *    row gets a few more pixels to itself. A continuous function of position: nothing pops as bodies move.
 *  - the neutral-zone push: before the snap the defensive front is drawn NZ_PUSH yd further off the ball so the
 *    two stances do not meet head to head; it eases out over NZ_EASE s after the snap (the get-off).
 * Only the interior bodies move (FAN_POSITIONS: the offensive and defensive lines and the linebackers; the push:
 * the down linemen), never an eligible receiver, a passer, a returner or the athlete the user controls (their
 * glyphs, prompts and routes are drawn over the simulated spot), and the fan fades out next to a ball carrier
 * (CARRIER_NEAR..CARRIER_FAR yd) so a tackler meets the runner where the runner is drawn. Figures at tiers 3 and 4
 * (whole-field views) are small enough to be left where they are. Pure math.
 */
import type { FigureTier } from './world-layer';

/** Share of the distance from the ball (across the field) added to a lineman's drawn spot. */
export const LINE_FAN = 0.25;
/** Across-field distance (yd) up to which the fan grows with the distance (past the tackles and the DE). */
export const FAN_INNER = 3.4;
/** Across-field distance (yd) where the fan has eased back to nothing (slot receivers and beyond are not moved). */
export const FAN_OUTER = 8;
/** Up / down-field distance (yd) from the line of scrimmage within which the fan is full. */
export const FAN_NEAR = 2.5;
/** Up / down-field distance (yd) where the fan has faded out. */
export const FAN_FAR = 5;
/** Extra depth (yd) the defensive front is drawn off the ball before the snap. */
export const NZ_PUSH = 0.3;
/** Up / down-field depth (yd) of the defenders the neutral-zone push applies to (the down linemen at ~1 yd); it
 *  fades out over the next NZ_FADE yd (linebackers at 4+ yd are not moved). */
export const NZ_DEPTH = 1.6;
/** Depth band (yd) over which the neutral-zone push fades out behind NZ_DEPTH. */
export const NZ_FADE = 0.8;
/** Seconds after the snap over which the neutral-zone push eases out. */
export const NZ_EASE = 0.3;
/** Highest figure tier the spacing applies to. */
export const LINE_SPACING_MAX_TIER: FigureTier = 2;
/** Distance (yd) from a ball carrier inside which the fan is off, and where it is back to full. */
export const CARRIER_NEAR = 1.0;
export const CARRIER_FAR = 2.5;
/** Positions the fan spreads (the lines and the linebackers). */
export const FAN_POSITIONS: ReadonlySet<string> = new Set(['C', 'OG', 'OT', 'DE', 'DT', 'OLB', 'MLB']);
/** Positions the neutral-zone push moves (the defensive down linemen). */
export const NZ_POSITIONS: ReadonlySet<string> = new Set(['DE', 'DT']);

const smooth = (e0: number, e1: number, x: number): number => {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/**
 * Across-field offset (yd) of the fan for a body `u` yd across the field from the ball and `v` yd up / down the
 * field from the line of scrimmage. Odd in `u` (the two halves of the line spread apart), continuous everywhere.
 */
export const lineFanYd = (u: number, v: number): number => {
  const au = Math.abs(u);
  const shape = au <= FAN_INNER ? au : FAN_INNER * (1 - smooth(FAN_INNER, FAN_OUTER, au));
  const fade = 1 - smooth(FAN_NEAR, FAN_FAR, Math.abs(v));
  return Math.sign(u) * LINE_FAN * shape * fade;
};

/**
 * Up / down-field offset (yd, away from the line of scrimmage) of a defender's drawn spot: NZ_PUSH before the snap
 * for the front within NZ_DEPTH of the line (fading out over NZ_FADE behind it), eased out over NZ_EASE s after it (`sinceSnap` < 0 or null: pre-snap).
 */
export const neutralZonePushYd = (side: 'offense' | 'defense', v: number, sinceSnap: number | null): number => {
  if (side !== 'defense') return 0;
  const k = (sinceSnap === null || sinceSnap <= 0 ? 1 : 1 - smooth(0, NZ_EASE, sinceSnap)) * (1 - smooth(NZ_DEPTH, NZ_DEPTH + NZ_FADE, Math.abs(v)));
  return k === 0 ? 0 : Math.sign(v || 1) * NZ_PUSH * k;
};

/** Facts the spacing needs about the play. */
export interface LineSpacingContext {
  tier: FigureTier;
  losY: number | null;
  snapX: number;
  /** Seconds since the snap (null before it). */
  sinceSnap: number | null;
  /** Where a ball carrier other than the passer / snapper is (null: none). */
  carrier: { x: number; y: number } | null;
  /** The athlete the user controls (never moved). */
  controlledId: string | null;
}

/** The athlete fields the spacing reads. */
export interface SpacedAthlete { id: string; side: 'offense' | 'defense'; position: string; hasBall: boolean; x: number; y: number }

const ZERO = Object.freeze({ dx: 0, dy: 0 });

/** World-yard offset of where an athlete is drawn: {dx across the field, dy up / down it}. */
export const lineSpacingYd = (ctx: LineSpacingContext, a: SpacedAthlete): { dx: number; dy: number } => {
  if (ctx.losY === null || ctx.tier > LINE_SPACING_MAX_TIER || a.hasBall || a.id === ctx.controlledId) return ZERO;
  const v = a.y - ctx.losY;
  let dx = 0;
  if (FAN_POSITIONS.has(a.position)) {
    const near = ctx.carrier ? smooth(CARRIER_NEAR, CARRIER_FAR, Math.hypot(a.x - ctx.carrier.x, a.y - ctx.carrier.y)) : 1;
    dx = lineFanYd(a.x - ctx.snapX, v) * near;
  }
  const dy = NZ_POSITIONS.has(a.position) ? neutralZonePushYd(a.side, v, ctx.sinceSnap) : 0;
  return dx === 0 && dy === 0 ? ZERO : { dx, dy };
};

/** Positions whose ball carrying does not fade the fan (the snapper and the passer in the pocket). */
const NOT_A_RUNNER: ReadonlySet<string> = new Set(['C', 'QB']);

/** The runner the fan fades around: the ball carrier unless he is the snapper or the quarterback. */
export const spacingCarrier = (athletes: readonly SpacedAthlete[]): { x: number; y: number } | null => {
  const c = athletes.find((a) => a.hasBall);
  return c && !NOT_A_RUNNER.has(c.position) ? { x: c.x, y: c.y } : null;
};
