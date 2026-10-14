import { describe, expect, it } from 'vitest';
import { FIELD_LENGTH, FIELD_WIDTH, MIDDLE_X, fieldY } from '@/game/types';
import { mirrorZone, type ZoneName } from '@/playbook/types';
import { ZONE_NAMES, ZONE_SPECS, isDeepZone, pointInZone, zoneDropPoint, zoneLandmark, zoneYRange } from '@/playbook/zones';

describe('zone landmarks', () => {
  it('lists every ZoneName and mirrors symmetrically', () => {
    expect(ZONE_NAMES).toHaveLength(17);
    for (const z of ZONE_NAMES) {
      const m = mirrorZone(z);
      expect(ZONE_SPECS[m].localX).toBeCloseTo(-ZONE_SPECS[z].localX);
      expect(ZONE_SPECS[m].depthMin).toBe(ZONE_SPECS[z].depthMin);
    }
  });

  it('keeps every landmark inside the field for both directions at midfield', () => {
    for (const dir of [1, -1] as const) {
      const losY = fieldY(50, dir);
      for (const z of ZONE_NAMES) {
        const lm = zoneLandmark(z, losY, dir);
        expect(lm.center.x - lm.halfWidth, `${z} left edge`).toBeGreaterThanOrEqual(-1e-9);
        expect(lm.center.x + lm.halfWidth, `${z} right edge`).toBeLessThanOrEqual(FIELD_WIDTH + 1e-9);
        expect(lm.center.y).toBeGreaterThan(0);
        expect(lm.center.y).toBeLessThan(FIELD_LENGTH);
        expect(lm.depthMax).toBeGreaterThan(lm.depthMin);
        const [near, far] = zoneYRange(z, losY, dir);
        expect(dir * (far - near)).toBeGreaterThan(0);
        expect(dir * (near - losY)).toBeCloseTo(lm.depthMin);
      }
    }
  });

  it('splits deep thirds, halves and quarters across FIELD_WIDTH', () => {
    const thirds: ZoneName[] = ['deepThirdLeft', 'deepThirdMiddle', 'deepThirdRight'];
    const width = (zs: ZoneName[]): number => zs.reduce((sum, z) => sum + 2 * ZONE_SPECS[z].halfWidth, 0);
    expect(width(thirds)).toBeCloseTo(FIELD_WIDTH);
    expect(width(['deepHalfLeft', 'deepHalfRight'])).toBeCloseTo(FIELD_WIDTH);
    expect(width(['deepQuarter1', 'deepQuarter2', 'deepQuarter3', 'deepQuarter4'])).toBeCloseTo(FIELD_WIDTH);
    const l = zoneLandmark('deepThirdLeft', 60, 1);
    const r = zoneLandmark('deepThirdRight', 60, 1);
    expect(l.center.x).toBeLessThan(MIDDLE_X);
    expect(r.center.x).toBeGreaterThan(MIDDLE_X);
    expect(zoneLandmark('deepThirdMiddle', 60, 1).center.x).toBeCloseTo(MIDDLE_X);
    // The offense's left is absolute +x when attacking toward y = 0.
    expect(zoneLandmark('deepThirdLeft', 60, -1).center.x).toBeGreaterThan(MIDDLE_X);
    expect(zoneLandmark('deepQuarter1', 60, 1).center.x).toBeCloseTo(FIELD_WIDTH / 8);
    expect(zoneLandmark('deepQuarter4', 60, -1).center.x).toBeCloseTo(FIELD_WIDTH / 8);
  });

  it('places underneath zones at the expected depths', () => {
    for (const z of ['hookCurlLeft', 'hookCurlRight', 'curlFlatLeft', 'curlFlatRight', 'flatLeft', 'flatRight'] as ZoneName[]) {
      const lm = zoneLandmark(z, 40, 1);
      expect(lm.depthMin).toBeGreaterThanOrEqual(1);
      expect(lm.depthMax).toBeLessThanOrEqual(12);
      expect(isDeepZone(z)).toBe(false);
    }
    const hole = zoneLandmark('middleHole', 40, 1);
    expect([hole.depthMin, hole.depthMax]).toEqual([8, 15]);
    expect(hole.center.y).toBeCloseTo(40 + 11.5);
    expect(zoneLandmark('middleHole', 40, -1).center.y).toBeCloseTo(40 - 11.5);
    expect(isDeepZone('deepHalfLeft')).toBe(true);
    expect(zoneLandmark('deepThirdMiddle', 40, 1).depthMin).toBe(12);
  });

  it('pointInZone honours lateral and depth bands; drop points stay in bounds', () => {
    const losY = 30;
    const lm = zoneLandmark('curlFlatRight', losY, 1);
    expect(pointInZone('curlFlatRight', { x: lm.center.x, y: losY + 8 }, losY, 1)).toBe(true);
    expect(pointInZone('curlFlatRight', { x: lm.center.x, y: losY + 20 }, losY, 1)).toBe(false);
    expect(pointInZone('curlFlatRight', { x: lm.center.x - 20, y: losY + 8 }, losY, 1)).toBe(false);
    expect(pointInZone('curlFlatLeft', { x: lm.center.x, y: losY + 8 }, losY, 1)).toBe(false);
    // attacking the other way, the same absolute x is now the offense's LEFT
    expect(pointInZone('curlFlatLeft', { x: lm.center.x, y: losY - 8 }, losY, -1)).toBe(true);
    for (const z of ZONE_NAMES) {
      const p = zoneDropPoint(z, losY, 1);
      expect(p.x).toBeGreaterThanOrEqual(1);
      expect(p.x).toBeLessThanOrEqual(FIELD_WIDTH - 1);
    }
  });
});
