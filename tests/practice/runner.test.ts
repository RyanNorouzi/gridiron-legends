/**
 * Drill reps through the real PlayEngine with the real AI (registerAll) and scripted user input.
 */
import { describe, expect, it } from 'vitest';
import { registerAll } from '@/ai/register';
import { dist, normalize, sub, vec2 } from '@/core/vec2';
import { ballCarrier, findAthlete } from '@/game/athlete';
import type { PlayState, UserPlayInput } from '@/game/play-types';
import { DrillRep, MAX_REP_SECONDS, buildDrillScenario, getDrill, idlePlayInput, receiverNearest, startDrillSession, DEFAULT_DRILL_OPTIONS } from '@/game/practice';
import { predictLanding } from '@/physics/ball';

registerAll();

/** Snap, let the routes develop ~1.2 s, then throw to the primary (slot 0). */
const quarterback = (s: PlayState): UserPlayInput => {
  const i = idlePlayInput();
  if (s.phase === 'presnap') return { ...i, snap: true };
  if (s.snapTick > 0 && s.tick - s.snapTick === 70) return { ...i, throwTo: 0, throwType: 'bullet' };
  return i;
};

/** The human free safety: sprint at the carrier and wrap up inside 1.6 yd (the engine's tackle assist does the rest). */
const safety = (s: PlayState): UserPlayInput => {
  const me = findAthlete(s, s.controlledIds.home ?? null);
  const c = ballCarrier(s);
  const i = idlePlayInput();
  if (!me || !c || c.side !== 'offense' || s.phase !== 'live') return i;
  return { ...i, move: normalize(sub(c.pos, me.pos)), sprint: true, tackle: dist(me.pos, c.pos) <= 1.6 };
};

describe('passing drill rep', () => {
  it('a scripted snap and throw to the primary completes the pass and scores it', () => {
    const session = startDrillSession('passRoutes', { difficulty: 'pro' }, 3);
    const rep = session.startRep();
    expect(rep.state.controlledIds.home).toBe('off:QB');
    expect(rep.focusId).toBe(`off:${rep.scenario.receiverSlots[0]}`);
    const verdict = rep.run((s) => quarterback(s));
    const thrown = rep.state.events.find((e) => e.type === 'throw');
    expect(thrown?.type === 'throw' && thrown.target).toBe(rep.focusId);
    expect(rep.state.events.some((e) => e.type === 'catch' && e.receiver === rep.focusId)).toBe(true);
    expect(verdict.success).toBe(true);
    expect(verdict.headline).toMatch(/^COMPLETE \+\d+/);
    // Decided at the catch; the rep ends after the settle beat rather than a long run after the catch.
    expect(rep.finished).toBe(true);
    expect(rep.elapsed).toBeLessThan(6);
    const rec = session.record(verdict, rep.scenario);
    expect(rec.points).toBe(verdict.points);
    expect(rec.points).toBeGreaterThan(100);
    expect(session.summary().successes).toBe(1);
  });

  it('completes most reps across seeds and every rep ends with a verdict', () => {
    const session = startDrillSession('passRoutes', { difficulty: 'pro' }, 11);
    for (let i = 0; i < 8; i++) {
      const rep = session.startRep();
      session.record(rep.run((s) => quarterback(s)), rep.scenario);
    }
    expect(session.reps).toBe(8);
    expect(session.successes).toBeGreaterThanOrEqual(5);
    expect(session.totalPoints).toBeGreaterThan(0);
  });
});

describe('tackling drill rep', () => {
  it('the human FS with the tackle assist wins most one-on-ones over seeds', () => {
    const session = startDrillSession('tackling', { difficulty: 'pro' }, 21);
    const results: boolean[] = [];
    for (let i = 0; i < 16; i++) {
      const rep = session.startRep();
      expect(rep.state.controlledIds.home).toBe('def:FS');
      // Everyone but the user's safety is benched far downfield.
      const benched = rep.state.athletes.filter((a) => a.side === 'defense' && a.id !== 'def:FS');
      expect(benched.every((a) => a.pos.y - rep.state.losY >= 40)).toBe(true);
      const v = rep.run((s) => safety(s));
      session.record(v, rep.scenario);
      results.push(v.success);
      if (v.success) expect(rep.state.events.some((e) => e.type === 'tackle' && e.tackler === 'def:FS')).toBe(true);
    }
    expect(results.filter(Boolean).length).toBeGreaterThanOrEqual(11);
  });
});

describe('other drills through the engine', () => {
  it('JUGS: the machine throws to the user-driven receiver, who catches it by running under the ball', () => {
    const session = startDrillSession('catching', { difficulty: 'rookie' }, 5);
    let caught = 0;
    for (let i = 0; i < 5; i++) {
      const rep = session.startRep();
      expect(rep.puppetId).toBe('off:WR2');
      expect(rep.state.controlledId).toBe('off:WR2');
      const v = rep.run((s) => {
        const me = findAthlete(s, 'off:WR2');
        const input = idlePlayInput();
        if (!me || s.ball.phase !== 'inAir') return input;
        const d = sub(predictLanding(s.ball, s.ctx.weather, 1.2).pos, me.pos);
        return Math.hypot(d.x, d.y) < 0.3 ? input : { ...input, move: normalize(d), sprint: true };
      });
      const t = rep.state.events.find((e) => e.type === 'throw');
      expect(t?.type === 'throw' && t.target).toBe('off:WR2');
      if (v.success) caught += 1;
    }
    expect(caught).toBeGreaterThanOrEqual(3);
  });

  it('field goals are kicked through the human kick meter and judged; punts are measured', () => {
    const meter = (s: PlayState, t: number): UserPlayInput => {
      const m = s.kickMeter;
      const press = !!m && ((m.phase === 'idle' && t > 5) || (m.phase === 'power' && m.cursor >= 0.9) || (m.phase === 'accuracy' && m.cursor > 0.95));
      return { ...idlePlayInput(), kickPress: press };
    };
    const fg = new DrillRep(buildDrillScenario(getDrill('fieldGoal'), { ...DEFAULT_DRILL_OPTIONS, kickDistance: 30 }, 4));
    let t = 0;
    const fgVerdict = fg.run((s) => meter(s, t++));
    expect(fg.state.events.some((e) => e.type === 'kickResult')).toBe(true);
    expect(fgVerdict.success).toBe(true);
    const punt = new DrillRep(buildDrillScenario(getDrill('punting'), { ...DEFAULT_DRILL_OPTIONS, difficulty: 'rookie' }, 4));
    t = 0;
    const pv = punt.run((s) => meter(s, t++));
    expect(punt.metrics.hangTime).toBeGreaterThan(2.5);
    expect(punt.metrics.landingY! - punt.state.losY).toBeGreaterThan(25);
    expect(pv.detail).toMatch(/yds, \d\.\ds hang/);
  });

  it('coverage focuses on the receiver the user covers and the quarterback throws at him', () => {
    const rep = startDrillSession('coverage', {}, 8).startRep();
    const me = findAthlete(rep.state, rep.state.controlledIds.home ?? null)!;
    expect(me.role).toBe('CB2');
    expect(me.assignment.type).toBe('manCover');
    expect(rep.focusId).toBe(`off:${'manTarget' in me.assignment ? me.assignment.manTarget : ''}`);
    rep.run(() => null);
    const t = rep.state.events.find((e) => e.type === 'throw');
    expect(t?.type === 'throw' && t.target).toBe(rep.focusId);
    expect(rep.verdict).not.toBeNull();
  });

  it('zone coverage: the free safety plays the deep middle and the quarterback attacks the receiver nearest him', () => {
    const rep = startDrillSession('zoneCoverage', {}, 6).startRep();
    const me = findAthlete(rep.state, rep.state.controlledIds.home ?? null)!;
    expect(me.role).toBe('FS');
    expect(me.assignment.type).toBe('zone');
    expect(rep.focusId).toBeNull();
    // The decider sees the positions handed to the input callback just before its tick.
    let nearestBefore: string | null = null;
    let decision: { target: string | null; nearest: string | null } | null = null;
    rep.run((s) => {
      const qb = s.intents['off:QB'];
      if (!decision && qb?.action === 'throw') decision = { target: qb.targetId, nearest: nearestBefore };
      nearestBefore = receiverNearest(s, 'def:FS')?.id ?? null;
      return null;
    });
    expect(decision).not.toBeNull();
    expect(decision!.target).toBe(decision!.nearest);
    const t = rep.state.events.find((e) => e.type === 'throw');
    expect(t?.type === 'throw' && t.target).toBe(decision!.target);
    expect(rep.verdict).not.toBeNull();
  });

  it('a rep nobody finishes is called at the time cap; the free-roam quarterback never stalls the play dead', () => {
    const def = { ...getDrill('catching'), script: 'freeRoam' as const };
    const rep = new DrillRep(buildDrillScenario(def, DEFAULT_DRILL_OPTIONS, 2));
    for (let i = 0; i < 60 * 8; i++) rep.tick({ ...idlePlayInput(), move: vec2(0, i % 120 < 60 ? 1 : -1) });
    expect(rep.state.phase).toBe('live');
    expect(rep.finished).toBe(false);
    const v = rep.run(() => null);
    expect(v.success).toBe(false);
    expect(rep.elapsed).toBeLessThanOrEqual(MAX_REP_SECONDS + 1);
  });
});
