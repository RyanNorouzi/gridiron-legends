import { describe, expect, it } from 'vitest';
import { backfieldRotationEvery, POSITION_ROTATION } from '@/game/lineups';

describe('backfield rotation', () => {
  it('rotates the backup in more often the closer he is to the starter', () => {
    expect(backfieldRotationEvery(80, 78)).toBe(2);
    expect(backfieldRotationEvery(84, 76)).toBe(3);
    expect(backfieldRotationEvery(86, 72)).toBe(5);
    expect(backfieldRotationEvery(90, 60)).toBe(7);
  });
  it('backs and linemen rotate on fatigue sooner than the default', () => {
    expect(POSITION_ROTATION.RB?.threshold).toBeLessThan(0.65);
    expect(POSITION_ROTATION.DT?.threshold).toBeLessThan(0.65);
  });
});
