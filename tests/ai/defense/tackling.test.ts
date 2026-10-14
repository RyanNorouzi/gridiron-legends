import { describe, expect, it } from 'vitest';
import { dot, sub } from '@/core/vec2';
import { approachIntent, chooseTackle, pursuitPlan } from '@/ai/tackling';
import type { Athlete } from '@/game/play-types';
import { setAttrs, setup } from './harness';

const place = (a: Athlete, x: number, y: number, vx: number, vy: number, massLb = 200): void => {
  a.pos = { x, y };
  a.vel = { x: vx, y: vy };
  a.massLb = massLb;
  a.facing = Math.atan2(vy, vx);
  a.state = 'moving';
  a.contactTimer = 0;
};

describe('pursuit angles', () => {
  it('cuts off a faster carrier by aiming ahead of him toward the sideline', () => {
    const f = setup({ seed: 1, difficulty: 'legend' });
    const carrier = f.byRole('offense', 'RB');
    const defender = f.byRole('defense', 'FS');
    setAttrs(carrier, 80, { speed: 99, acceleration: 99 });
    setAttrs(defender, 80, { speed: 70, awareness: 70, pursuit: 80 });
    place(carrier, 30, 50, 7.5, 7.5);
    place(defender, 26, 46, 0, 0);
    const plan = pursuitPlan(defender, carrier, f.state);
    expect(plan.cutOff).toBe(true);
    const heading = { x: 1, y: 1 };
    expect(dot(sub(plan.aim, carrier.pos), heading)).toBeGreaterThan(0);
    expect(plan.aim.x).toBeGreaterThan(carrier.pos.x);
  });

  it('takes a truer angle at legend than at rookie', () => {
    const lead = (difficulty: 'rookie' | 'legend'): number => {
      const f = setup({ seed: 1, difficulty });
      const carrier = f.byRole('offense', 'RB');
      const defender = f.byRole('defense', 'FS');
      setAttrs(carrier, 80, { speed: 99 });
      setAttrs(defender, 80, { speed: 70, awareness: 70, pursuit: 70 });
      place(carrier, 30, 50, 7.5, 7.5);
      place(defender, 26, 46, 0, 0);
      const plan = pursuitPlan(defender, carrier, f.state);
      return dot(sub(plan.aim, carrier.pos), { x: Math.SQRT1_2, y: Math.SQRT1_2 });
    };
    expect(lead('legend')).toBeGreaterThan(lead('rookie') + 0.5);
  });

  it('intercepts a slower carrier at a point on his path', () => {
    const f = setup({ seed: 1, difficulty: 'legend' });
    const carrier = f.byRole('offense', 'RB');
    const defender = f.byRole('defense', 'FS');
    setAttrs(carrier, 80, { speed: 40 });
    setAttrs(defender, 80, { speed: 95, awareness: 90, pursuit: 90 });
    place(carrier, 20, 50, 0, 6);
    place(defender, 30, 60, 0, 0);
    const plan = pursuitPlan(defender, carrier, f.state);
    expect(plan.intercept).toBe(true);
    expect(plan.aim.y).toBeGreaterThan(carrier.pos.y + 1);
  });

  it('breaks down in front of a shifty carrier instead of sprinting through him', () => {
    const f = setup({ seed: 2, difficulty: 'legend' });
    const carrier = f.byRole('offense', 'RB');
    const defender = f.byRole('defense', 'MLB');
    setAttrs(carrier, 80, { agility: 95 });
    setAttrs(defender, 80, { awareness: 90 });
    place(carrier, 26, 50, 0, 6);
    place(defender, 26, 52, 0, -4);
    const i = approachIntent(defender, carrier, f.state);
    expect(i.sprint).toBe(false);
    expect(i.debug).toContain('breakdown');
    setAttrs(carrier, 80, { agility: 40 });
    place(defender, 26, 56, 0, -4);
    const j = approachIntent(defender, carrier, f.state);
    expect(j.sprint).toBe(true);
  });
});

describe('tackle choice', () => {
  it('chooses the hit stick only with a momentum advantage on a head-on approach', () => {
    const f = setup({ seed: 3, difficulty: 'legend' });
    const carrier = f.byRole('offense', 'WR1');
    const defender = f.byRole('defense', 'SS');
    setAttrs(defender, 80, { awareness: 90, tackling: 85 });
    place(carrier, 26, 50, 0, 1, 180);
    place(defender, 26, 51.2, 0, -8, 250);
    expect(chooseTackle(defender, carrier, f.state).kind).toBe('hitStick');
    // Same geometry, light and slow defender against a big back at speed: no hit stick.
    const back = f.byRole('offense', 'RB');
    place(back, 26, 50, 0, 8, 240);
    place(defender, 26, 51.2, 0, -3, 180);
    const choice = chooseTackle(defender, back, f.state);
    expect(choice.kind).not.toBe('hitStick');
    expect(choice.kind).toBe('wrap');
  });

  it('strips from behind a carrier with poor ball security', () => {
    const f = setup({ seed: 3, difficulty: 'legend' });
    const carrier = f.byRole('offense', 'RB');
    const defender = f.byRole('defense', 'OLB1');
    setAttrs(carrier, 80, { carrying: 35 });
    setAttrs(defender, 80, { awareness: 90 });
    place(carrier, 26, 50, 0, 6, 200);
    place(defender, 26, 48.8, 0, 7, 200);
    expect(chooseTackle(defender, carrier, f.state).kind).toBe('strip');
    setAttrs(carrier, 80, { carrying: 90 });
    expect(chooseTackle(defender, carrier, f.state).kind).toBe('wrap');
  });

  it('dives when losing the angle and joins a gang tackle on a contested carrier', () => {
    const f = setup({ seed: 4, difficulty: 'legend' });
    const carrier = f.byRole('offense', 'RB');
    const defender = f.byRole('defense', 'CB1');
    setAttrs(defender, 80, { awareness: 85 });
    place(carrier, 26, 50, 0, 9, 200);
    place(defender, 26, 48, 0, 6, 190);
    expect(chooseTackle(defender, carrier, f.state).kind).toBe('dive');
    // A teammate already hanging on: gang.
    const helper = f.byRole('defense', 'MLB');
    place(helper, 26.5, 50.5, 0, 0);
    place(defender, 26, 48.2, 0, 9, 190);
    expect(chooseTackle(defender, carrier, f.state).kind).toBe('gang');
  });

  it('never hits a sliding quarterback in simulation mode', () => {
    const f = setup({ seed: 5, ruleset: 'simulation' });
    const qb = f.byRole('offense', 'QB');
    const defender = f.byRole('defense', 'MLB');
    place(qb, 26, 50, 0, 2);
    qb.state = 'sliding';
    place(defender, 26, 51, 0, -6);
    const choice = chooseTackle(defender, qb, f.state);
    expect(choice.action).toBeNull();
    expect(choice.reason).toBe('sliding qb');
    const arcade = setup({ seed: 5, ruleset: 'arcade' });
    const aqb = arcade.byRole('offense', 'QB');
    const adef = arcade.byRole('defense', 'MLB');
    place(aqb, 26, 50, 0, 2);
    aqb.state = 'sliding';
    place(adef, 26, 51, 0, -6);
    expect(chooseTackle(adef, aqb, arcade.state).action).not.toBeNull();
  });

  it('reports nothing when out of reach', () => {
    const f = setup({ seed: 6 });
    const carrier = f.byRole('offense', 'RB');
    const defender = f.byRole('defense', 'MLB');
    place(carrier, 26, 50, 0, 6);
    place(defender, 26, 56, 0, -6);
    expect(chooseTackle(defender, carrier, f.state).kind).toBeNull();
  });
});
