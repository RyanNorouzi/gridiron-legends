import { describe, expect, it } from 'vitest';
import { registerAll } from '@/ai/register';
import { vec2 } from '@/core/vec2';
import { idleIntent } from '@/game/engine-api';
import { fieldY } from '@/game/types';
import { driveBack, posePile, runPile, type PoseOptions } from './struggle-harness';

registerAll();

/**
 * Forward progress at the goal lines (systems/tackle-struggle.ts): a runner held in the field of play and driven back
 * into his own end zone is spotted where he got to (no safety), one caught in his end zone is a safety, and a runner
 * who churns the ball over the goal line while held has scored even if he is driven back out.
 */

const SMALL_BACK = { massLb: 185, attrs: { strength: 50, balance: 55 } };
const BIG_BACKER = { massLb: 255, attrs: { strength: 95, balance: 85, tackling: 90 } };
const HEAVY_BACK = { massLb: 235, attrs: { strength: 92, balance: 88, acceleration: 85, carrying: 85 } };
const SMALL_CORNER = { massLb: 180, attrs: { strength: 50, balance: 60, tackling: 60 } };

interface GoalRun { reason: string | null; dir: number; start: number; spotYd: number; lastYd: number; bestYd: number; events: string[] }

/** Runs `seeds` posed piles with the runner placed at offense yard line `ballOn` (0 = his own goal line). */
const atYardLine = (ballOn: number, n: number, o: Omit<PoseOptions, 'seed' | 'at'>): GoalRun[] => {
  const out: GoalRun[] = [];
  for (let seed = 1; seed <= n; seed++) {
    const p = posePile({ seed, ...o, at: (pos, s) => vec2(pos.x, fieldY(ballOn, s.ctx.direction)) });
    if (!p) continue;
    const tr = runPile(p);
    const s = p.built.engine.state;
    const dir = s.ctx.direction;
    // Offense yard lines (0 = own goal line, 100 = the goal line he attacks), unclamped.
    const yd = (y: number): number => dir * (y - fieldY(0, dir));
    out.push({ reason: s.deadReason, dir, start: ballOn, spotYd: yd(s.deadSpot?.y ?? 0), lastYd: yd(tr.lastY), bestYd: yd(tr.bestY), events: s.events.map((e) => e.type) });
  }
  return out;
};

const DRIVE_BACK: Omit<PoseOptions, 'seed' | 'at'> = {
  tacklerIds: ['def:MLB'], kind: 'hitStick', hold: 1.2, carrierBody: SMALL_BACK, tacklerBody: BIG_BACKER,
  carrierVel: vec2(0, 0), tacklerVel: vec2(0, 0),
  script: { 'off:RB': () => idleIntent('gave up'), 'def:MLB': (_a, s) => driveBack(s) },
};

describe('forward progress at the goal lines', () => {
  it('a runner held just outside his own goal line and driven back into the end zone is spotted where he got to, never a safety', () => {
    const runs = atYardLine(0.3, 20, DRIVE_BACK);
    expect(runs.length).toBeGreaterThan(15);
    const intoEndZone = runs.filter((r) => r.lastYd < 0);
    expect(intoEndZone.length).toBeGreaterThanOrEqual(3);
    for (const r of runs) {
      expect(r.events).not.toContain('safety');
      expect(r.reason).not.toBe('safety');
      if (r.reason === 'tackle' || r.reason === 'forwardProgress') expect(r.spotYd).toBeCloseTo(r.bestYd, 1);
      expect(r.spotYd).toBeGreaterThanOrEqual(0.3 - 1e-6);
    }
  });

  it('a runner caught in his own end zone and brought down there is a safety', () => {
    const runs = atYardLine(-1.5, 12, DRIVE_BACK);
    const tackled = runs.filter((r) => !r.events.includes('brokenTackle'));
    expect(tackled.length).toBeGreaterThan(8);
    for (const r of tackled) expect(r.reason).toBe('safety');
  });

  it('a back who churns the ball over the goal line while held has scored; one stopped short is spotted short', () => {
    const churned = atYardLine(99.4, 16, { tacklerIds: ['def:CB1'], kind: 'arm', hold: 0.6, carrierBody: HEAVY_BACK, tacklerBody: SMALL_CORNER });
    const tds = churned.filter((r) => r.reason === 'touchdown');
    expect(tds.length).toBeGreaterThan(churned.length / 2);
    // The ball (carried a little ahead of him) broke the plane: he got there by churning forward, not by the pose.
    for (const r of tds) expect(r.bestYd).toBeGreaterThan(99.4);
    const stopped = atYardLine(99.4, 16, DRIVE_BACK);
    expect(stopped.length).toBeGreaterThan(12);
    for (const r of stopped) {
      expect(r.reason).not.toBe('touchdown');
      if (r.reason === 'tackle' || r.reason === 'forwardProgress') {
        expect(r.spotYd).toBeCloseTo(r.bestYd, 1);
        expect(r.spotYd).toBeLessThan(100);
      }
    }
  });
});
