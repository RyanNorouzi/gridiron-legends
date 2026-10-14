import { describe, expect, it } from 'vitest';
import { loadPlaybookData } from '@/playbook/loader';
import { isSpecialPlay } from '@/playbook/special-teams';
import { chasePolicy, fixture, runSim } from './sim';

/** Every bundled non-special play against a few looks: the deciders must never throw or produce NaN positions. */
describe('offense smoke', () => {
  const reg = loadPlaybookData();
  const plays = Object.values(reg.offensePlays).filter((p) => isSpecialPlay(p) === 'none' && !p.tags.includes('twoPoint'));
  const looks = ['43-cover3-zone', 'nickel-cover0-cbBlitz'];

  it('runs every play to completion with valid numbers', { timeout: 60_000 }, () => {
    expect(plays.length).toBeGreaterThan(40);
    for (const play of plays) {
      for (const [i, look] of looks.entries()) {
        const fx = fixture({ offensePlayId: play.id, defensePlayId: look, seed: 10 + i, direction: i % 2 === 0 ? 1 : -1 });
        const res = runSim(fx, { seconds: 3, defense: chasePolicy(0.8) });
        expect(res.ticks, `${play.id} vs ${look}`).toBeGreaterThan(0);
        for (const a of fx.state.athletes) {
          expect(Number.isFinite(a.pos.x) && Number.isFinite(a.pos.y), `${play.id} ${a.id} pos`).toBe(true);
          expect(Number.isFinite(a.vel.x) && Number.isFinite(a.vel.y), `${play.id} ${a.id} vel`).toBe(true);
          if (a.side === 'offense') expect(a.ai.decision, `${play.id} ${a.id} decision`).not.toBe('');
        }
        const b = fx.state.ball.pos;
        expect(Number.isFinite(b.x) && Number.isFinite(b.y), `${play.id} ball`).toBe(true);
        for (const e of res.events) if (e.id.startsWith('off:')) expect(e.action, `${play.id} action`).toBeTruthy();
      }
    }
  });

  it('attacks in both directions: routes and drops mirror with ctx.direction', () => {
    for (const direction of [1, -1] as const) {
      const fx = fixture({ offensePlayId: 'shotgun-mesh', defensePlayId: '43-cover3-zone', seed: 4, direction });
      const qb = fx.byRole('offense', 'QB');
      const wr2 = fx.byRole('offense', 'WR2');
      const startQb = qb.pos.y;
      const startWr = wr2.pos.y;
      runSim(fx, { seconds: 1.5, idleRoles: [] });
      expect(Math.sign(wr2.pos.y - startWr)).toBe(direction);
      expect(Math.sign(qb.pos.y - startQb)).toBe(-direction);
    }
  });
});
