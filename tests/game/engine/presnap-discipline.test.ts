/** H2-01: a held stick before the snap must not walk the human's athlete off his alignment (or through the line). */
import { describe, expect, it } from 'vitest';
import { vec2 } from '@/core/vec2';
import { registerAll } from '@/ai/register';
import { findAthlete } from '@/game/athlete';
import { PRESNAP_NEUTRAL_ZONE } from '@/game/play-engine';
import { build, emptyInput } from './helpers';

registerAll();

describe('pre-snap discipline for human-controlled athletes', () => {
  it('a human quarterback holding the stick stays set; the snap still goes to his alignment', () => {
    const { engine } = build({ offensePlayId: 'shotgun-slants', defensePlayId: '43-cover3-zone', seed: 2, ballOn: 5, userSide: 'home', controlRole: 'QB', ruleset: 'arcade' });
    const s = engine.state;
    const qb = findAthlete(s, 'off:QB')!;
    const start = { ...qb.pos };
    // About three seconds of ArrowUp (downfield) and then ArrowRight.
    for (let t = 0; t < 180; t++) engine.tick({ home: { ...emptyInput(), move: t < 120 ? vec2(0, s.ctx.direction) : vec2(1, 0), sprint: true } });
    expect(s.phase).toBe('presnap');
    expect(Math.hypot(qb.pos.x - start.x, qb.pos.y - start.y)).toBeLessThan(0.05);
    expect(s.ctx.direction * (qb.pos.y - s.losY)).toBeLessThan(0);
    engine.tick({ home: { ...emptyInput(), snap: true, move: vec2(0, s.ctx.direction) } });
    expect(s.phase).toBe('live');
    expect(Math.hypot(qb.pos.x - start.x, qb.pos.y - start.y)).toBeLessThan(0.3);
  });

  it('a human defender may shift before the snap but never into the neutral zone', () => {
    const { engine } = build({ offensePlayId: 'shotgun-slants', defensePlayId: '43-cover3-zone', seed: 2, ballOn: 40, userSide: 'away', controlRole: 'MLB', ruleset: 'arcade' });
    const s = engine.state;
    const mlb = findAthlete(s, 'def:MLB')!;
    const x0 = mlb.pos.x;
    // Toward the offense's backfield (across the line) for three seconds, then sideways.
    for (let t = 0; t < 180 && s.phase === 'presnap'; t++) engine.tick({ away: { ...emptyInput(), move: t < 150 ? vec2(0, -s.ctx.direction) : vec2(1, 0) } });
    const depth = s.ctx.direction * (mlb.pos.y - s.losY);
    expect(depth).toBeGreaterThanOrEqual(PRESNAP_NEUTRAL_ZONE - 1e-9);
    if (s.phase === 'presnap') expect(mlb.pos.x).not.toBeCloseTo(x0, 1);
  });
});
