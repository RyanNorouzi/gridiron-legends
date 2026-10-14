import { describe, expect, it } from 'vitest';
import { createRng } from '@/core/rng';
import { generatePlayer } from '@/players/generator';
import { avoidReservedName, createNamePool, isReservedFullName } from '@/players/names';

describe('reserved real-person names', () => {
  it('recognises reserved pairs case-insensitively', () => {
    expect(isReservedFullName('Jerry', 'Rice')).toBe(true);
    expect(isReservedFullName('JOHN', 'madden')).toBe(true);
    expect(isReservedFullName('Jerry', 'Stone')).toBe(false);
  });

  it('redraws the last name only when the pair is reserved', () => {
    let calls = 0;
    const redraw = (): string => { calls++; return 'Stone'; };
    expect(avoidReservedName('Jerry', 'Hollis', redraw)).toBe('Hollis');
    expect(calls).toBe(0);
    expect(avoidReservedName('Jerry', 'Rice', redraw)).toBe('Stone');
    expect(calls).toBe(1);
  });

  it('pools and the player generator never produce a reserved name', () => {
    const pool = createNamePool(createRng(1), { first: ['Jerry'], last: ['Rice', 'Hollis'], colleges: null });
    for (let i = 0; i < 40; i++) expect(pool.pickFullName().lastName).toBe('Hollis');
    const rng = createRng(2);
    for (let i = 0; i < 40; i++) {
      const p = generatePlayer(rng, { position: 'WR', names: pool, regions: ['west'], year: 2026 });
      expect(`${p.firstName} ${p.lastName}`).toBe('Jerry Hollis');
    }
  });
});
