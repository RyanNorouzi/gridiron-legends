import { describe, expect, it } from 'vitest';
import { len, vec2 } from '@/core/vec2';
import { TICK_DT } from '@/core/time';
import type { Athlete } from '@/game/play-types';
import { beginSettle, settleStep, SETTLE_SLIDE_MAX } from '@/game/systems/post-whistle';
import { buildPlayState } from '../../fixtures/play-state';

/** Real athletes from a fixture, posed by hand into a struggle at the whistle. */
const scene = (): { athletes: Athlete[]; rb: Athlete; lb: Athlete; ss: Athlete; wr: Athlete } => {
  const { state } = buildPlayState({ offensePlayId: 'iform-dive-right', defensePlayId: '43-cover3-zone', seed: 5 });
  const athletes = state.athletes;
  const get = (id: string): Athlete => athletes.find((a) => a.id === id)!;
  for (const a of athletes) { a.state = 'idle'; a.vel = vec2(0, 0); }
  const rb = get('off:RB');
  const lb = get('def:MLB');
  const ss = get('def:SS');
  const wr = get('off:WR1');
  rb.pos = vec2(26, 50); rb.hasBall = true; rb.state = 'wrapped'; rb.facing = Math.PI / 2;
  lb.pos = vec2(26, 51); lb.state = 'wrapping'; lb.facing = -Math.PI / 2;
  ss.pos = vec2(40, 70);
  wr.pos = vec2(10, 60);
  return { athletes, rb, lb, ss, wr };
};

const run = (athletes: Athlete[], st: ReturnType<typeof beginSettle>): number => {
  let n = 0;
  while (settleStep(athletes, st, TICK_DT)) n += 1;
  return n;
};

describe('post-whistle pile', () => {
  it('a churning carrier drags the pile forward as it goes down', () => {
    const { athletes, rb, lb } = scene();
    rb.vel = vec2(0, 4);
    lb.vel = vec2(0, 2.5);
    const st = beginSettle(athletes, rb.id, rb.pos);
    expect(st.pile).toEqual([rb.id, lb.id]);
    expect(rb.state).toBe('falling');
    expect(lb.state).toBe('falling');
    expect(rb.vel.y).toBeGreaterThan(0);
    const y0 = rb.pos.y;
    run(athletes, st);
    expect(rb.state).toBe('down');
    expect(lb.state).toBe('down');
    // A short skid, never a glide.
    expect(rb.pos.y - y0).toBeGreaterThan(0.1);
    expect(rb.pos.y - y0).toBeLessThan(1.2);
  });

  it('a big square hit drives the pile backward', () => {
    const { athletes, rb, lb } = scene();
    rb.vel = vec2(0, 1);
    lb.vel = vec2(0, -7);
    lb.massLb = 260;
    rb.massLb = 190;
    const y0 = rb.pos.y;
    const st = beginSettle(athletes, rb.id, rb.pos);
    expect(len(rb.vel)).toBeLessThanOrEqual(SETTLE_SLIDE_MAX + 1e-9);
    run(athletes, st);
    expect(rb.pos.y).toBeLessThan(y0);
  });

  it('a tackle that stopped the carrier dead still skids with the momentum from before the hit', () => {
    const { athletes, rb, lb } = scene();
    const st = beginSettle(athletes, rb.id, rb.pos, new Map([[rb.id, vec2(0, 8)], [lb.id, vec2(0, -1)]]));
    expect(rb.vel.y).toBeGreaterThan(1);
    run(athletes, st);
    expect(rb.state).toBe('down');
  });

  it('with no momentum at all the pile still sags to the ground (tackler onto the carrier)', () => {
    const { athletes, rb, lb } = scene();
    const st = beginSettle(athletes, rb.id, rb.pos);
    expect(len(rb.vel)).toBeGreaterThan(0);
    expect(lb.vel.y).toBeLessThan(0);
    run(athletes, st);
    expect([rb.state, lb.state]).toEqual(['down', 'down']);
  });

  it('far-away players are not in the pile: they pull up on their feet and turn to the ball', () => {
    const { athletes, rb, ss, wr } = scene();
    ss.vel = vec2(-9, 0);
    ss.state = 'moving';
    wr.state = 'blocking';
    const st = beginSettle(athletes, rb.id, rb.pos);
    expect(st.pile).not.toContain(ss.id);
    const n = run(athletes, st);
    expect(n * TICK_DT).toBeLessThan(1.5);
    expect(ss.state).toBe('idle');
    expect(wr.state).toBe('idle');
    expect(len(ss.vel)).toBe(0);
  });

  it('an incomplete pass has no pile: nobody goes down', () => {
    const { athletes, rb, lb } = scene();
    rb.state = 'moving';
    rb.hasBall = false;
    lb.state = 'moving';
    const st = beginSettle(athletes, null, vec2(26, 50));
    expect(st.pile).toEqual([]);
    run(athletes, st);
    expect(athletes.every((a) => a.state === 'idle')).toBe(true);
  });

  it('an injured player (inactive) goes to the ground where he is', () => {
    const { athletes, wr } = scene();
    wr.active = false;
    wr.vel = vec2(3, 0);
    const st = beginSettle(athletes, null, vec2(26, 50));
    run(athletes, st);
    expect(wr.state).toBe('down');
  });
});
