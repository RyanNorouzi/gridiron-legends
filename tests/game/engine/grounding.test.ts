import { describe, expect, it } from 'vitest';
import { vec2 } from '@/core/vec2';
import { groundingSafeSpot } from '@/ai/qb-reads';
import { CLOSING_RADIUS, PRESSURE_RADIUS, throwDifficulty } from '@/game/systems/passing';
import { buildPlayState } from '../../fixtures/play-state';

const setup = () => {
  const f = buildPlayState({ offensePlayId: 'shotgun-mesh', defensePlayId: '43-cover3-zone', ballOn: 30, seed: 9 });
  const qb = f.byRole('offense', 'QB');
  const rusher = f.byRole('defense', 'DE1');
  f.state.phase = 'live';
  for (const a of f.state.athletes) a.state = 'moving';
  return { f, qb, rusher };
};

describe('pressure vs threat', () => {
  it('a rusher closing fast from 3.5 yd threatens the passer without counting as pressure on him', () => {
    const { f, qb, rusher } = setup();
    rusher.pos = vec2(qb.pos.x + 3.5, qb.pos.y);
    rusher.vel = vec2(-6, 0);
    expect(3.5).toBeGreaterThan(PRESSURE_RADIUS);
    expect(3.5).toBeLessThan(CLOSING_RADIUS);
    const d = throwDifficulty(f.state, qb, null, vec2(0, qb.pos.y + 8), 'throwAway');
    expect(d.underPressure).toBe(false);
    expect(d.threatened).toBe(true);
  });
  it('a rusher drifting away at 3.5 yd neither pressures nor threatens', () => {
    const { f, qb, rusher } = setup();
    for (const a of f.state.athletes) if (a.side === 'defense' && a.id !== rusher.id) a.pos = vec2(1, qb.pos.y + 40);
    rusher.pos = vec2(qb.pos.x + 3.5, qb.pos.y);
    rusher.vel = vec2(3, 0);
    const d = throwDifficulty(f.state, qb, null, vec2(0, qb.pos.y + 8), 'throwAway');
    expect(d.underPressure).toBe(false);
    expect(d.threatened).toBe(false);
  });
});

describe('AI grounding-safe spot', () => {
  it('is always downfield of the passer, for both attack directions', () => {
    for (const direction of [1, -1] as const) {
      for (let seed = 1; seed <= 6; seed++) {
        const f = buildPlayState({ offensePlayId: 'shotgun-mesh', defensePlayId: '43-cover3-zone', ballOn: 30, seed, direction });
        const qb = f.byRole('offense', 'QB');
        // Put a back behind the passer so a naive picker would choose a spot behind him.
        const rb = f.state.athletes.find((a) => a.side === 'offense' && a.role.startsWith('RB'));
        if (rb) rb.pos = vec2(qb.pos.x + 2, qb.pos.y - direction * 3);
        const spot = groundingSafeSpot(qb, f.state);
        if (spot) expect((spot.y - qb.pos.y) * direction).toBeGreaterThanOrEqual(1);
      }
    }
  });
});
