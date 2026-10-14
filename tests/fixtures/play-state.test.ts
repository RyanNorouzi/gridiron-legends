import { describe, expect, it } from 'vitest';
import { buildPlayState } from './play-state';
import { FIELD_WIDTH } from '@/game/types';

describe('play-state fixture', () => {
  it('builds 22 athletes at plausible spots for the default call', () => {
    const f = buildPlayState();
    expect(f.state.athletes).toHaveLength(22);
    expect(f.state.athletes.filter((a) => a.side === 'offense')).toHaveLength(11);
    for (const a of f.state.athletes) {
      expect(a.pos.x).toBeGreaterThanOrEqual(0);
      expect(a.pos.x).toBeLessThanOrEqual(FIELD_WIDTH);
      if (a.side === 'offense') expect(a.pos.y).toBeLessThanOrEqual(f.state.losY + 0.01);
      else expect(a.pos.y).toBeGreaterThanOrEqual(f.state.losY - 0.01);
    }
    expect(f.byRole('offense', 'QB').position).toBe('QB');
    expect(f.state.ball.pos).toEqual({ x: f.state.ctx.ballX, y: f.state.losY });
  });
  it('is deterministic per seed and respects direction', () => {
    const a = buildPlayState({ seed: 7, direction: -1, ballOn: 40 });
    const b = buildPlayState({ seed: 7, direction: -1, ballOn: 40 });
    expect(a.state.athletes.map((x) => [x.id, x.pos.x, x.pos.y, x.attrs.speed])).toEqual(b.state.athletes.map((x) => [x.id, x.pos.x, x.pos.y, x.attrs.speed]));
    expect(a.state.losY).toBe(110 - 40);
    for (const x of a.state.athletes) if (x.side === 'offense') expect(x.pos.y).toBeGreaterThanOrEqual(a.state.losY - 0.01);
  });
  it('marks the controlled athlete', () => {
    const f = buildPlayState({ userSide: 'away', controlRole: 'FS' });
    expect(f.state.controlledId).toBe('def:FS');
    expect(f.byRole('defense', 'FS').controlled).toBe(true);
    expect(f.state.ctx.controllers.away).toBe('human');
  });
  it('supports every bundled play pairing without throwing', () => {
    const f = buildPlayState();
    const offIds = Object.keys(f.registry.offensePlays);
    const defIds = Object.keys(f.registry.defensePlays);
    for (let i = 0; i < offIds.length; i++) {
      const s = buildPlayState({ offensePlayId: offIds[i], defensePlayId: defIds[i % defIds.length], seed: i });
      expect(s.state.athletes).toHaveLength(22);
    }
  });
});
