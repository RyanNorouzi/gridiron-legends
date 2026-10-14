import { describe, expect, it } from 'vitest';
import { TICK_DT } from '@/core/time';
import { dist } from '@/core/vec2';
import { integrateMovement } from '@/physics/movement';
import { maxSpeed } from '@/physics/speed';
import { pursuitAim, pursueCarrier, tackleChoice } from '@/ai/pursuit';
import { buildPlayState } from '../../fixtures/play-state';
import { goLive, giveBall, place } from './helpers';

const carrierRunning = (seed = 1, difficulty: 'rookie' | 'pro' | 'legend' = 'pro') => {
  const f = buildPlayState({ seed, difficulty, offensePlayId: 'shotgun-insideZone-left', defensePlayId: '43-cover3-zone' });
  goLive(f.state);
  const rb = f.byRole('offense', 'RB');
  giveBall(f.state, rb.id);
  rb.attrs.speed = 85;
  place(f.state, rb, 26, 60, { x: 0, y: maxSpeed(85) });
  return { f, rb };
};

describe('pursuit angles', () => {
  it('a trailing defender aims ahead of the carrier (cut-off), deeper when slower', () => {
    const { f, rb } = carrierRunning();
    const slow = f.byRole('defense', 'MLB');
    const fast = f.byRole('defense', 'CB1');
    slow.attrs.speed = 70;
    fast.attrs.speed = 97;
    place(f.state, slow, 20, 52);
    place(f.state, fast, 20, 52);
    const slowAim = pursuitAim(slow, rb, f.state);
    const fastAim = pursuitAim(fast, rb, f.state);
    expect(slowAim.trailing).toBe(true);
    expect(slowAim.aim.y).toBeGreaterThan(rb.pos.y + 1);
    expect(fastAim.aim.y).toBeGreaterThan(rb.pos.y);
    expect(slowAim.lead).toBeGreaterThan(fastAim.lead);
    expect(slowAim.speedRatio).toBeLessThan(1);
  });

  it('never aims beyond the goal line the carrier is attacking', () => {
    const { f, rb } = carrierRunning();
    place(f.state, rb, 26, 106, { x: 0, y: 9 });
    const d = f.byRole('defense', 'FS');
    d.attrs.speed = 60;
    place(f.state, d, 26, 96);
    expect(pursuitAim(d, rb, f.state).aim.y).toBeLessThanOrEqual(110);
  });

  it('difficulty pursuit quality pulls rookie AI toward the carrier\'s current spot', () => {
    const rookie = carrierRunning(2, 'rookie');
    const legend = carrierRunning(2, 'legend');
    const dr = rookie.f.byRole('defense', 'SS');
    const dl = legend.f.byRole('defense', 'SS');
    for (const d of [dr, dl]) { d.attrs.speed = 75; d.attrs.awareness = 60; }
    place(rookie.f.state, dr, 16, 55);
    place(legend.f.state, dl, 16, 55);
    expect(pursuitAim(dl, legend.rb, legend.f.state).lead).toBeGreaterThan(pursuitAim(dr, rookie.rb, rookie.f.state).lead);
  });

  it('emergent: a faster defender chasing from behind closes to tackling range', () => {
    const { f, rb } = carrierRunning();
    rb.attrs.speed = 60;
    rb.vel = { x: 0, y: maxSpeed(60) };
    const d = f.byRole('defense', 'CB2');
    d.attrs.speed = 95;
    d.attrs.acceleration = 90;
    place(f.state, d, 30, 56);
    let tackled = false;
    for (let t = 0; t < 480 && !tackled; t++) {
      const intent = pursueCarrier(d, f.state);
      integrateMovement(d, intent, TICK_DT, f.state.ctx.weather);
      rb.pos = { x: rb.pos.x, y: Math.min(108, rb.pos.y + rb.vel.y * TICK_DT) };
      f.state.ball.pos = { ...rb.pos };
      if (intent.action === 'tackle' || intent.action === 'hitStick' || intent.action === 'strip') tackled = true;
      f.state.tick++;
    }
    expect(tackled).toBe(true);
    expect(dist(d.pos, rb.pos)).toBeLessThan(2.5);
    expect(rb.pos.y).toBeLessThan(108);
  });
});

describe('tackle choice', () => {
  it('wraps up when in reach, nothing when far', () => {
    const { f, rb } = carrierRunning();
    const d = f.byRole('defense', 'MLB');
    place(f.state, d, 26, 61.2, { x: 0, y: -3 });
    d.attrs.awareness = 80;
    rb.attrs.carrying = 90;
    const choice = tackleChoice(d, rb, f.state);
    expect(choice === 'tackle' || choice === 'hitStick').toBe(true);
    place(f.state, d, 26, 70);
    expect(tackleChoice(d, rb, f.state)).toBeNull();
  });

  it('strips a loose-handed carrier from behind and dives when about to be outrun', () => {
    const { f, rb } = carrierRunning();
    const d = f.byRole('defense', 'MLB');
    d.attrs.awareness = 90;
    rb.attrs.carrying = 30;
    // Directly behind the carrier, within reach.
    place(f.state, d, 26, 59.0, { x: 0, y: 8 });
    expect(tackleChoice(d, rb, f.state)).toBe('strip');
    // Just out of reach, slower and losing ground: lay out.
    d.attrs.speed = 60;
    place(f.state, d, 26, 57.6, { x: 0, y: 6 });
    expect(tackleChoice(d, rb, f.state)).toBe('dive');
    // Not trailing (head-on) or well out of range: no dive.
    place(f.state, d, 26, 62.4, { x: 0, y: -6 });
    expect(tackleChoice(d, rb, f.state)).toBeNull();
  });

  it('hit sticks need a momentum edge; eager low-quality defenders load up on thinner edges', () => {
    const attempts = (difficulty: 'rookie' | 'legend', awareness: number, defenderSpeed: number, seed: number): number => {
      const { f, rb } = carrierRunning(seed, difficulty);
      const d = f.byRole('defense', 'SS');
      d.attrs.awareness = awareness;
      d.massLb = 215;
      rb.massLb = 205;
      rb.attrs.carrying = 90;
      rb.vel = { x: 0, y: 6 };
      place(f.state, d, 26, 61.3, { x: 0, y: -defenderSpeed });
      let sticks = 0;
      for (let i = 0; i < 40; i++) {
        f.state.tick = i * 31;
        if (tackleChoice(d, rb, f.state) === 'hitStick') sticks++;
      }
      return sticks;
    };
    // Clear momentum edge: both kinds of defender load up at least sometimes.
    expect(attempts('legend', 95, 12, 5)).toBeGreaterThan(0);
    expect(attempts('rookie', 15, 12, 5)).toBeGreaterThan(0);
    // Thin edge (~0.17): the sharp defender never gambles; some eager ones do.
    let sharp = 0;
    let eager = 0;
    for (let seed = 1; seed <= 8; seed++) {
      sharp += attempts('legend', 95, 8, seed);
      eager += attempts('rookie', 15, 8, seed);
    }
    expect(sharp).toBe(0);
    expect(eager).toBeGreaterThan(0);
  });
});

describe('kick coverage under control', () => {
  it('a coverage man never lays out from dive range: he keeps his feet (a scrimmage chaser still dives)', () => {
    const { f, rb } = carrierRunning();
    const d = f.byRole('defense', 'MLB');
    d.attrs.speed = 60;
    // Two yards off his back, slower and losing ground: the scrimmage read is a dive.
    place(f.state, d, 26, 57.0, { x: 0, y: 6 });
    expect(dist(d.pos, rb.pos) - d.radius - rb.radius).toBeGreaterThan(1.6);
    expect(pursueCarrier(d, f.state).action).toBe('dive');
    expect(pursueCarrier(d, f.state, { underControl: true }).action).toBeNull();
  });

  it('a coverage man wraps up instead of loading up a hit stick in space', () => {
    let scrimmageSticks = 0;
    for (let seed = 1; seed <= 6; seed++) {
      const { f, rb } = carrierRunning(seed, 'rookie');
      const d = f.byRole('defense', 'SS');
      d.attrs.awareness = 15;
      d.massLb = 230;
      rb.massLb = 190;
      rb.attrs.carrying = 90;
      rb.vel = { x: 0, y: 6 };
      for (const y of [61.3, 61.1, 60.95]) {
        place(f.state, d, 26, y, { x: 0, y: -12 });
        for (let i = 0; i < 20; i++) {
          f.state.tick = i * 31;
          if (pursueCarrier(d, f.state).action === 'hitStick') scrimmageSticks++;
          const controlled = pursueCarrier(d, f.state, { underControl: true }).action;
          expect(controlled === null || controlled === 'tackle', `${controlled}`).toBe(true);
        }
      }
    }
    expect(scrimmageSticks).toBeGreaterThan(0);
  });
});
