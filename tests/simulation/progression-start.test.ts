/**
 * The sim QB's progression does not always start at the play's designed primary: the pre-snap read moves the first
 * look to the second or third man on a share of snaps, from the same single die (the look roll is split, so the dice
 * count never changes). This is what keeps the X receiver from drawing a third or more of his team's targets.
 */
import { describe, expect, it } from 'vitest';
import { PRIMARY_READ_SHARE, progressionStart, SECOND_READ_SHARE } from '@/simulation/pass-model';

describe('progression start', () => {
  it('starts at the primary on PRIMARY_READ_SHARE of snaps, the 2nd / 3rd read on the rest, and re-spreads the roll over 0..1', () => {
    const counts = [0, 0, 0];
    const N = 10_000;
    for (let i = 0; i < N; i++) {
      const u = (i + 0.5) / N;
      const { start, roll } = progressionStart(u, 5);
      counts[start] = (counts[start] ?? 0) + 1;
      expect(roll).toBeGreaterThanOrEqual(0);
      expect(roll).toBeLessThan(1);
    }
    expect(counts[0]! / N).toBeCloseTo(PRIMARY_READ_SHARE, 2);
    expect(counts[1]! / N).toBeCloseTo(SECOND_READ_SHARE, 2);
    expect(counts[2]! / N).toBeCloseTo(1 - PRIMARY_READ_SHARE - SECOND_READ_SHARE, 2);
  });

  it('never starts past the receivers there are, and is a pure function of the roll', () => {
    for (const u of [0, 0.3, 0.6, 0.9, 0.999999]) {
      expect(progressionStart(u, 1).start).toBe(0);
      expect(progressionStart(u, 2).start).toBeLessThanOrEqual(1);
      expect(progressionStart(u, 3)).toEqual(progressionStart(u, 3));
    }
    expect(progressionStart(0.99, 2)).toEqual({ start: 1, roll: expect.closeTo((0.99 - PRIMARY_READ_SHARE) / (1 - PRIMARY_READ_SHARE), 6) });
  });
});
