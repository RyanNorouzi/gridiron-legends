import { describe, expect, it } from 'vitest';
import { decideIntent } from '@/ai/index';
import { registerAll } from '@/ai/register';
import { dist, vec2 } from '@/core/vec2';
import { findAthlete } from '@/game/athlete';
import { idleIntent } from '@/game/engine-api';
import type { Athlete } from '@/game/play-types';
import { joinPile } from '@/game/systems/tackle-struggle';
import { build } from './helpers';
import { driveBack, posePile, runPile } from './struggle-harness';

registerAll();

/**
 * Bodies in a tackle struggle (systems/tackle-struggle.ts) move like bodies: a defender who grabs the runner from
 * arm's length (or from a dive) slides onto him instead of teleporting, men hanging on do not stack on one spot,
 * teammates leaning in to push the pile do not walk through the runner, and a runner driven backwards out of bounds
 * keeps his forward progress.
 */

const PLAYS: readonly [string, string][] = [
  ['iform-dive-right', '43-runStop-cover1'], ['pistol-outsideZone-right', '43-cover2-zoneBlitz'], ['singleback-counter-left', '34-cover1-edge'],
  ['shotgun-mesh', '43-cover1-man'], ['iform-toss-right', '43-cover3-zone'], ['shotgun-slants', '34-cover0-allOut'],
];

interface PileWatch { struggles: number; maxStep: number; minMate: number; minPileGap: number }

/** Real AI plays, watched tick by tick while a struggle is on. */
const watchPiles = (): PileWatch => {
  const out: PileWatch = { struggles: 0, maxStep: 0, minMate: Infinity, minPileGap: Infinity };
  for (const [off, def] of PLAYS) {
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const { engine } = build({ offensePlayId: off, defensePlayId: def, seed, ballOn: 35 }, {}, { decider: decideIntent });
      const env = engine.debugEnv();
      const s = engine.state;
      const prev = new Map<string, { x: number; y: number }>();
      let was = false;
      let inPile = new Set<string>();
      while (!engine.isDead && engine.stepCount < 3000) {
        engine.tick({});
        const st = env.struggle;
        if (s.phase === 'live' && st) {
          if (!was) out.struggles += 1;
          const pile = new Set([st.carrierId, ...st.tacklers.map((m) => m.id)]);
          for (const a of s.athletes) {
            const p = prev.get(a.id);
            if (p && pile.has(a.id)) out.maxStep = Math.max(out.maxStep, dist(p, a.pos));
          }
          const c = findAthlete(s, st.carrierId) as Athlete;
          for (const m of s.athletes) {
            if (inPile.has(c.id) && m.active && m.side === c.side && m.id !== c.id) out.minMate = Math.min(out.minMate, dist(m.pos, c.pos) / (m.radius + c.radius));
          }
          // Settled pile men (joined a few ticks ago) hang on side by side around him, not on top of each other.
          const settled = st.tacklers.filter((m) => s.time - m.joinedAt > 0.25).map((m) => findAthlete(s, m.id) as Athlete);
          for (let i = 0; i < settled.length; i++) for (let j = i + 1; j < settled.length; j++) {
            const a = settled[i] as Athlete;
            const b = settled[j] as Athlete;
            out.minPileGap = Math.min(out.minPileGap, dist(a.pos, b.pos) / (a.radius + b.radius));
          }
        }
        was = s.phase === 'live' && !!st;
        inPile = new Set(st && s.phase === 'live' ? [st.carrierId, ...st.tacklers.map((m) => m.id)] : []);
        for (const a of s.athletes) prev.set(a.id, { x: a.pos.x, y: a.pos.y });
      }
    }
  }
  return out;
};

describe('bodies in the pile', () => {
  it('nobody teleports onto the runner, pile men do not stack, and teammates do not walk through him', () => {
    const w = watchPiles();
    expect(w.struggles).toBeGreaterThan(10);
    // Top speed is ~11 yd/s (0.18 yd a tick, a little more on the grab tick with the collision push); grabbing on
    // from arm's length or a dive is a slide, not a jump (it used to snap up to 1.1 yd in one tick).
    expect(w.maxStep).toBeLessThan(0.35);
    expect(w.minMate).toBeGreaterThan(0.75);
    expect(w.minPileGap).toBeGreaterThan(0.8);
  }, 120_000);

  it('a defender grabbing on from a dive slides onto the runner over a few ticks', () => {
    const p = posePile({ seed: 3, tacklerIds: ['def:MLB'] });
    expect(p).not.toBeNull();
    if (!p) return;
    const s = p.built.engine.state;
    const ss = findAthlete(s, 'def:SS') as Athlete;
    ss.pos = vec2(p.carrier.pos.x + 1.9, p.carrier.pos.y);
    ss.vel = vec2(-3, 0);
    ss.state = 'moving';
    joinPile(s, p.built.engine.debugEnv(), p.carrier, ss, 'dive', 0.8);
    const before = { ...ss.pos };
    p.built.engine.tick({});
    expect(dist(before, ss.pos)).toBeLessThan(0.25);
  });
});

describe('sideline', () => {
  it('a runner driven backwards out of bounds keeps his forward progress and is down in bounds', () => {
    let out = 0;
    for (let seed = 1; seed <= 40; seed++) {
      // A big linebacker catches a runner standing near the sideline and drives him back and out (the sideline drive
      // the pile AI uses, ai/pile.ts: mostly out, partly back).
      const p = posePile({
        seed, tacklerIds: ['def:MLB'], hold: 1.2, at: (pos) => vec2(0.75, pos.y), carrierVel: vec2(0, 0), tacklerVel: vec2(-4, 0),
        carrierBody: { massLb: 185, attrs: { strength: 50, balance: 55 } }, tacklerBody: { massLb: 255, attrs: { strength: 95, tackling: 90 } },
        script: { 'off:RB': () => idleIntent('gave up'), 'def:MLB': (_a, st) => driveBack(st, vec2(-0.8, -0.6 * st.ctx.direction)) },
      });
      if (!p) continue;
      const tr = runPile(p);
      const s = p.built.engine.state;
      const dir = s.ctx.direction;
      if (dir * (tr.bestY - tr.lastY) <= 0.1 || !s.events.some((e) => e.type === 'forwardProgressStopped')) continue;
      out += 1;
      // Driven back and out after his progress was stopped, he is down in the field of play (the real rule: no out of
      // bounds, the clock does not stop), spotted at the sideline at the furthest point he reached while held.
      expect(s.deadReason).toBe('forwardProgress');
      expect(tr.outcome.outOfBounds).toBe(false);
      expect(tr.outcome.endBallX).toBeCloseTo(0, 5);
      expect(dir * ((s.deadSpot?.y ?? 0) - tr.bestY)).toBeGreaterThanOrEqual(-0.01);
    }
    expect(out).toBeGreaterThanOrEqual(3);
  });
});
