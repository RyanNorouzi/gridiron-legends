import { describe, expect, it } from 'vitest';
import { vec2 } from '@/core/vec2';
import { idleIntent, type AthleteIntent } from '@/game/engine-api';
import { findAthlete } from '@/game/athlete';
import type { Athlete, PlayState } from '@/game/play-types';
import { JOIN_WINDOW, MAX_PILE } from '@/game/systems/tackle';
import { pileKind } from '@/game/systems/tackle-struggle';
import { buildCtx, createMeasureEnv, runLive, scrimmageCalls } from '../../integration/measure';
import { toward } from './helpers';
import { churn, eventsOf, offDir, posePile, type Body, type PosedPile } from './struggle-harness';

/**
 * Real football piles: most tackles finish one-on-one or two-on-one. Only defenders who reach the held runner within
 * JOIN_WINDOW seconds of the first hold get a hand on him, at most MAX_PILE of them, and a tackle is only 'gang' when
 * more than one man brought him down.
 */
const EXTRA = ['def:OLB1', 'def:OLB2', 'def:SS', 'def:FS'];
const toBall = (a: Athlete, s: PlayState): AthleteIntent => ({ ...toward(a, s.ball.pos), action: 'tackle' });
const chase = { 'def:OLB1': toBall, 'def:OLB2': toBall, 'def:SS': toBall, 'def:FS': toBall };
const stand = { 'off:RB': () => idleIntent('held'), 'def:MLB': () => ({ ...idleIntent('hold'), action: 'tackle' as const }) };

/** Drops the extra defenders onto the runner, spread around him, touching. */
const swarm = (s: PlayState, p: PosedPile): void => {
  const c = p.carrier;
  EXTRA.forEach((id, i) => {
    const a = findAthlete(s, id)!;
    const ang = Math.PI / 2 + (i * Math.PI) / 3;
    const r = (a.radius + c.radius) * 0.95;
    a.pos = vec2(c.pos.x + Math.cos(ang) * r, c.pos.y + offDir(s) * Math.sin(ang) * r);
    a.vel = vec2(0, 0);
    a.state = 'moving';
  });
};

describe('pile limits', () => {
  it('no more than MAX_PILE defenders ever hold the runner, however many get to him', () => {
    // A real pile is the tackler and one or two more, never a five-man scrum.
    expect(MAX_PILE).toBeLessThanOrEqual(3);
    let swarmed = 0;
    for (let seed = 1; seed <= 12; seed++) {
      const p = posePile({ seed, tacklerIds: ['def:MLB'], hold: 0.6, carrierVel: vec2(0, 0), tacklerVel: vec2(0, 0), script: { ...stand, ...chase }, onPose: swarm });
      if (!p) continue;
      const { engine } = p.built;
      const env = engine.debugEnv();
      let most = 1;
      while (!engine.isDead && engine.stepCount < 4000) {
        engine.tick({});
        most = Math.max(most, env.struggle?.tacklers.length ?? 0);
      }
      const joins = eventsOf(p, 'pileJoin').length;
      if (joins > 0) swarmed += 1;
      expect(most).toBeLessThanOrEqual(MAX_PILE);
      expect(joins).toBeLessThanOrEqual(MAX_PILE - 1);
      for (const e of eventsOf(p, 'tackle')) if (e.type === 'tackle') expect(1 + e.assists.length).toBeLessThanOrEqual(MAX_PILE);
    }
    expect(swarmed).toBeGreaterThanOrEqual(6);
  });

  it('a defender who gets to the runner after the join window is not in on the tackle', () => {
    let late = 0;
    for (let seed = 1; seed <= 16; seed++) {
      const p = posePile({ seed, tacklerIds: ['def:MLB'], hold: 0.35, carrierVel: vec2(0, 0), tacklerVel: vec2(0, 0), script: { ...stand, ...chase } });
      if (!p) continue;
      const { engine } = p.built;
      const s = engine.state;
      const t0 = s.time;
      let dropped = false;
      // Only the first struggle: once it is over, a new contact starts a new pile (with its own window).
      while (!engine.isDead && engine.stepCount < 4000 && (p.carrier.state === 'wrapped' || !dropped)) {
        if (!dropped && s.time - t0 > JOIN_WINDOW + 0.05) {
          if (p.carrier.state !== 'wrapped') break;
          swarm(s, p);
          dropped = true;
        }
        engine.tick({});
      }
      if (!dropped) continue;
      late += 1;
      expect(eventsOf(p, 'pileJoin')).toHaveLength(0);
      const first = eventsOf(p, 'tackle')[0];
      if (first && first.type === 'tackle') expect(first.assists.filter((id) => EXTRA.includes(id))).toHaveLength(0);
    }
    expect(late).toBeGreaterThanOrEqual(3);
  });

  it('a late arrival kept out of the pile is not locked out: when the runner breaks free he takes him on at once', () => {
    // Being too late to get a hand on the pile must not freeze him: a runner who sheds his tackler right beside him
    // meets him on the next tick, not a few tenths of a second later ("touch" football).
    const star: Body = { massLb: 215, attrs: { agility: 95, balance: 95, strength: 88, carrying: 90, acceleration: 92 } };
    const scrub: Body = { massLb: 180, attrs: { tackling: 35, strength: 40, balance: 45 } };
    const involves = (e: PlayState['events'][number]): boolean => JSON.stringify(e).includes('"def:SS"');
    const delays: number[] = [];
    for (let seed = 1; seed <= 80; seed++) {
      const p = posePile({
        seed, tacklerIds: ['def:CB1'], kind: 'arm', hold: 0.5, carrierBody: star, tacklerBody: scrub,
        script: { 'off:RB': (_a, s) => ({ ...churn(s), action: 'truck' }), 'def:SS': toBall },
      });
      if (!p) continue;
      const { engine } = p.built;
      const s = engine.state;
      const ss = findAthlete(s, 'def:SS')!;
      const t0 = s.time;
      let dropped = false;
      let brokeAt = -1;
      let met = false;
      while (!engine.isDead && engine.stepCount < 4000 && !met) {
        if (!dropped && s.time - t0 > JOIN_WINDOW + 0.05) {
          if (p.carrier.state !== 'wrapped') break;
          ss.pos = vec2(p.carrier.pos.x + (p.carrier.radius + ss.radius) * 0.95, p.carrier.pos.y + offDir(s) * 0.1);
          ss.vel = vec2(0, 0);
          ss.state = 'moving';
          dropped = true;
        }
        const n = s.events.length;
        engine.tick({});
        for (const e of s.events.slice(n)) {
          if (brokeAt < 0 && dropped && e.type === 'brokenTackle' && e.defender === 'def:CB1') brokeAt = s.tick;
          else if (brokeAt >= 0 && involves(e)) {
            delays.push(s.tick - brokeAt);
            met = true;
            break;
          }
        }
      }
    }
    expect(delays.length).toBeGreaterThanOrEqual(8);
    expect(delays.filter((d) => d <= 2).length).toBeGreaterThanOrEqual(Math.ceil(delays.length * 0.75));
  }, 60_000);

  it('in real AI-vs-AI snaps roughly a third of tackles are assisted and most end one-on-one', () => {
    const env = createMeasureEnv(2026);
    let tackles = 0;
    let assisted = 0;
    let solo = 0;
    for (const c of scrimmageCalls(1, { seedTag: 'pile-share' })) {
      const o = runLive(env, buildCtx(env, c)).outcome;
      for (const e of o?.events ?? []) {
        if (e.type !== 'tackle') continue;
        tackles += 1;
        if (e.assists.length > 0) assisted += 1;
        else solo += 1;
        expect(1 + e.assists.length).toBeLessThanOrEqual(MAX_PILE);
      }
    }
    expect(tackles).toBeGreaterThan(150);
    expect(assisted / tackles).toBeGreaterThanOrEqual(0.28);
    expect(assisted / tackles).toBeLessThanOrEqual(0.47);
    expect(solo).toBeGreaterThan(assisted);
  }, 120_000);

  it("a lone tackler's grab is never recorded as a gang tackle", () => {
    expect(pileKind(1, 'gang')).toBe('wrap');
    expect(pileKind(1, 'arm')).toBe('arm');
    expect(pileKind(2, 'wrap')).toBe('gang');
    expect(pileKind(3, 'hitStick')).toBe('hitStick');
  });
});
