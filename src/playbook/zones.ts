import type { Vec2 } from '@/core/vec2';
import type { Direction } from '@/game/types';
import type { ZoneName } from './types';

/**
 * Zone landmarks for zone coverage. Zone names are offense-perspective (play-local left/right,
 * quarters numbered left-to-right); this module converts them to absolute field coordinates.
 * FIELD_WIDTH mirrors game/types.ts (playbook sits below game in the import order, so it is restated here;
 * tests assert the two agree).
 */
const FIELD_WIDTH = 160 / 3;
const MIDDLE_X = FIELD_WIDTH / 2;

export interface ZoneLandmark {
  /** Absolute centre of the zone (x across the field, y at the middle of its depth band). */
  center: Vec2;
  /** Half the zone's lateral extent in yards. */
  halfWidth: number;
  /** Depth band in yards beyond the LOS (play-local, positive downfield). */
  depthMin: number;
  depthMax: number;
}

/** Play-local description: lateral centre offset from the ball's hash-independent middle and depth band. */
interface ZoneSpec {
  localX: number;
  halfWidth: number;
  depthMin: number;
  depthMax: number;
}

const THIRD = FIELD_WIDTH / 3;
const HALF = FIELD_WIDTH / 2;
const QUARTER = FIELD_WIDTH / 4;
const DEEP_MIN = 12;
const DEEP_MAX = 35;

export const ZONE_SPECS: Record<ZoneName, ZoneSpec> = {
  deepThirdLeft: { localX: -THIRD, halfWidth: THIRD / 2, depthMin: DEEP_MIN, depthMax: DEEP_MAX },
  deepThirdMiddle: { localX: 0, halfWidth: THIRD / 2, depthMin: DEEP_MIN, depthMax: DEEP_MAX },
  deepThirdRight: { localX: THIRD, halfWidth: THIRD / 2, depthMin: DEEP_MIN, depthMax: DEEP_MAX },
  deepHalfLeft: { localX: -HALF / 2, halfWidth: HALF / 2, depthMin: DEEP_MIN, depthMax: DEEP_MAX },
  deepHalfRight: { localX: HALF / 2, halfWidth: HALF / 2, depthMin: DEEP_MIN, depthMax: DEEP_MAX },
  deepQuarter1: { localX: -1.5 * QUARTER, halfWidth: QUARTER / 2, depthMin: 10, depthMax: DEEP_MAX },
  deepQuarter2: { localX: -0.5 * QUARTER, halfWidth: QUARTER / 2, depthMin: 10, depthMax: DEEP_MAX },
  deepQuarter3: { localX: 0.5 * QUARTER, halfWidth: QUARTER / 2, depthMin: 10, depthMax: DEEP_MAX },
  deepQuarter4: { localX: 1.5 * QUARTER, halfWidth: QUARTER / 2, depthMin: 10, depthMax: DEEP_MAX },
  curlFlatLeft: { localX: -18, halfWidth: 8, depthMin: 5, depthMax: 12 },
  curlFlatRight: { localX: 18, halfWidth: 8, depthMin: 5, depthMax: 12 },
  hookCurlLeft: { localX: -9, halfWidth: 6, depthMin: 8, depthMax: 12 },
  hookCurlRight: { localX: 9, halfWidth: 6, depthMin: 8, depthMax: 12 },
  flatLeft: { localX: -20, halfWidth: 6.5, depthMin: 1, depthMax: 7 },
  flatRight: { localX: 20, halfWidth: 6.5, depthMin: 1, depthMax: 7 },
  middleHole: { localX: 0, halfWidth: 5, depthMin: 8, depthMax: 15 },
  middleHook: { localX: 0, halfWidth: 6, depthMin: 6, depthMax: 12 },
};

export const ZONE_NAMES = Object.keys(ZONE_SPECS) as ZoneName[];

export const isDeepZone = (zone: ZoneName): boolean => zone.startsWith('deep');

/**
 * Absolute landmark for a zone. Zones are anchored to the field's middle (not the ball's hash) because
 * coverage divides the whole field; the offense's left is absolute -x when dir === 1 and +x when dir === -1.
 */
export const zoneLandmark = (zone: ZoneName, losY: number, dir: Direction): ZoneLandmark => {
  const spec = ZONE_SPECS[zone];
  const depthMid = (spec.depthMin + spec.depthMax) / 2;
  return {
    center: { x: MIDDLE_X + dir * spec.localX, y: losY + dir * depthMid },
    halfWidth: spec.halfWidth,
    depthMin: spec.depthMin,
    depthMax: spec.depthMax,
  };
};

/** Absolute y range [near, far] along the offense's direction for a landmark. */
export const zoneYRange = (zone: ZoneName, losY: number, dir: Direction): [number, number] => {
  const spec = ZONE_SPECS[zone];
  return [losY + dir * spec.depthMin, losY + dir * spec.depthMax];
};

/** True when an absolute point lies inside the zone's lateral band and depth band. */
export const pointInZone = (zone: ZoneName, point: Vec2, losY: number, dir: Direction): boolean => {
  const lm = zoneLandmark(zone, losY, dir);
  const depth = dir * (point.y - losY);
  return Math.abs(point.x - lm.center.x) <= lm.halfWidth && depth >= lm.depthMin && depth <= lm.depthMax;
};

/** Where a defender should drop to when first taking the zone: the landmark clamped inside the field. */
export const zoneDropPoint = (zone: ZoneName, losY: number, dir: Direction): Vec2 => {
  const lm = zoneLandmark(zone, losY, dir);
  const margin = 1;
  return { x: Math.min(FIELD_WIDTH - margin, Math.max(margin, lm.center.x)), y: lm.center.y };
};
