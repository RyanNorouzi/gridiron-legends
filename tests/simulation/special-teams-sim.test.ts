import { describe, expect, it } from 'vitest';
import { assertValidOutcome } from '@/game/outcome-factory';
import type { PlayOutcome } from '@/game/play-types';
import { MIDDLE_X } from '@/game/types';
import { simulatePlay } from '@/simulation/fast-sim';
import { makeCtx, variantOf } from './helpers';

const many = (opts: Parameters<typeof makeCtx>[0], n: number): PlayOutcome[] => {
  const base = makeCtx(opts);
  const out: PlayOutcome[] = [];
  for (let v = 0; v < n; v++) out.push(simulatePlay(variantOf(base, v)));
  return out;
};

describe('field goals and extra points', () => {
  it('make rate falls monotonically with distance and is near-automatic from close range', () => {
    const lines = [92, 85, 78, 70, 62, 55];
    const made = lines.map((ballOn) => {
      const os = many({ offensePlayId: 'fieldGoal-standard', defensePlayId: 'fgBlock-middle', ballOn, down: 4, distance: 5, special: 'fieldGoal', seed: 5 }, 300);
      for (const o of os) {
        expect(o.result).toBe('fieldGoal');
        expect(o.kickDistance).toBe(100 - ballOn + 17);
        expect(o.kickMade).not.toBeNull();
        expect(o.endBallX).toBe(MIDDLE_X);
        expect(o.events.some((e) => e.type === 'kickResult')).toBe(true);
        expect(o.stats.some((d) => d.stat === 'kicking.fgAttempts')).toBe(true);
        expect(o.stats.some((d) => d.stat === 'kicking.fgMade')).toBe(o.kickMade === true);
        expect(o.success).toBe(o.kickMade === true);
        if (o.kickMade) expect(o.epa).toBeGreaterThan(0);
      }
      return os.filter((o) => o.kickMade).length / os.length;
    });
    expect(made[0]).toBeGreaterThan(0.9);
    expect(made[made.length - 1]).toBeLessThan(0.55);
    for (let i = 1; i < made.length; i++) expect(made[i]).toBeLessThanOrEqual((made[i - 1] as number) + 0.02);
  });

  it('extra points are made most of the time and carry kicking.xp stats', () => {
    const os = many({ offensePlayId: 'extraPoint-standard', defensePlayId: 'fgBlock-middle', ballOn: 85, special: 'extraPoint', seed: 2 }, 300);
    const made = os.filter((o) => o.kickMade).length / os.length;
    expect(made).toBeGreaterThan(0.9);
    for (const o of os) {
      expect(o.result).toBe('extraPoint');
      expect(o.kickDistance).toBe(32);
      expect(o.stats.some((d) => d.stat === 'kicking.xpAttempts')).toBe(true);
      expect(o.epa).toBe(0);
    }
  });

  it('a stronger, more accurate kicker makes more long kicks', () => {
    const base = makeCtx({ offensePlayId: 'fieldGoal-standard', defensePlayId: 'fgBlock-middle', ballOn: 64, down: 4, distance: 5, special: 'fieldGoal', seed: 8 });
    const k = base.offenseLineup['K']!;
    const withKicker = (kickPower: number, kickAccuracy: number) => ({ ...base, offenseLineup: { ...base.offenseLineup, K: { ...k, attrs: { ...k.attrs, kickPower, kickAccuracy } } } });
    const rate = (ctx: ReturnType<typeof withKicker>): number => {
      let made = 0;
      for (let v = 0; v < 300; v++) if (simulatePlay(variantOf(ctx, v)).kickMade) made += 1;
      return made / 300;
    };
    expect(rate(withKicker(95, 95))).toBeGreaterThan(rate(withKicker(45, 45)) + 0.2);
  });
});

describe('punts', () => {
  it('average 38-48 gross yards, pin inside the 20 sometimes, and every outcome is valid', () => {
    const os = many({ offensePlayId: 'punt-standard', defensePlayId: 'puntReturn-middle', ballOn: 30, down: 4, distance: 8, special: 'punt', seed: 3 }, 500);
    const gross = os.filter((o) => o.kickDistance !== null && o.kickDistance > 0).map((o) => o.kickDistance as number);
    const avg = gross.reduce((a, b) => a + b, 0) / gross.length;
    expect(avg).toBeGreaterThan(38);
    expect(avg).toBeLessThan(48);
    let fairCatches = 0;
    let returns = 0;
    let touchbacks = 0;
    for (const o of os) {
      expect(() => assertValidOutcome(o)).not.toThrow();
      expect(o.result).toBe('punt');
      expect(o.yards).toBe(0);
      expect(o.stats.some((d) => d.stat === 'kicking.punts')).toBe(true);
      expect(o.events[0]?.type).toBe('snap');
      if (o.events.some((e) => e.type === 'fairCatch')) fairCatches += 1;
      if (o.returnYards > 0) returns += 1;
      if (o.events.some((e) => e.type === 'touchback')) { touchbacks += 1; expect(o.endBallOn).toBe(100); }
      if (!o.turnover && !o.touchdown && o.endBallOn < 100) expect(o.endBallOn).toBeGreaterThan(0);
    }
    expect(fairCatches).toBeGreaterThan(20);
    expect(returns).toBeGreaterThan(50);
    expect(touchbacks).toBeLessThan(60);
  });

  it('pooch punts from midfield land inside the 20 far more often than not', () => {
    const os = many({ offensePlayId: 'punt-pooch', defensePlayId: 'puntReturn-middle', ballOn: 60, down: 4, distance: 8, special: 'punt', seed: 4 }, 300);
    const inside = os.filter((o) => o.stats.some((d) => d.stat === 'kicking.puntsInside20')).length;
    expect(inside / os.length).toBeGreaterThan(0.5);
  });

  it('punt returns can go the distance and a muff can hand the ball back to the kicking team', () => {
    const os = many({ offensePlayId: 'punt-standard', defensePlayId: 'puntReturn-middle', ballOn: 10, down: 4, distance: 8, special: 'punt', seed: 11 }, 3000);
    const tds = os.filter((o) => o.touchdown);
    expect(tds.length).toBeGreaterThan(0);
    for (const o of tds) { expect(o.turnover).toBe(false); expect(o.endBallOn).toBe(0); expect(o.stats.some((d) => d.stat === 'returns.returnTouchdowns')).toBe(true); }
    const muffs = os.filter((o) => o.turnover);
    expect(muffs.length).toBeGreaterThan(0);
    for (const o of muffs) expect(o.turnoverType).toBe('fumble');
  });
});

describe('kickoffs', () => {
  it('touchback rate is plausible, returns average about 20-27 yards and the receiving team starts deep', () => {
    const os = many({ offensePlayId: 'kickoff-deep', defensePlayId: 'kickReturn-middle', ballOn: 35, special: 'kickoff', seed: 6 }, 500);
    const tb = os.filter((o) => o.events.some((e) => e.type === 'touchback'));
    expect(tb.length / os.length).toBeGreaterThan(0.3);
    expect(tb.length / os.length).toBeLessThan(0.85);
    const returned = os.filter((o) => o.returnYards > 0 && !o.turnover);
    const avgRet = returned.reduce((s, o) => s + o.returnYards, 0) / returned.length;
    expect(avgRet).toBeGreaterThan(18);
    expect(avgRet).toBeLessThan(30);
    for (const o of os) {
      expect(o.result).toBe('kickoff');
      expect(o.kickDistance).toBeGreaterThan(40);
      expect(o.stats.some((d) => d.stat === 'kicking.kickoffs')).toBe(true);
      if (o.events.some((e) => e.type === 'touchback')) { expect(o.endBallOn).toBe(100); expect(o.timeElapsed).toBe(0); }
      else if (!o.touchdown && !o.turnover) { expect(o.endBallOn).toBeGreaterThan(0); expect(o.endBallOn).toBeLessThan(100); }
    }
  });

  it('squib kicks are short and never touchbacks; onside kicks are recovered by the kicking team roughly 10-25% of the time', () => {
    const squibs = many({ offensePlayId: 'kickoff-squib', defensePlayId: 'kickReturn-middle', ballOn: 35, special: 'kickoff', seed: 7 }, 200);
    for (const o of squibs) { expect(o.kickDistance).toBeLessThan(60); expect(o.events.some((e) => e.type === 'touchback')).toBe(false); }
    const onsides = many({ offensePlayId: 'kickoff-onside', defensePlayId: 'kickReturn-hands', ballOn: 35, special: 'onside', seed: 8 }, 1000);
    const recovered = onsides.filter((o) => o.turnover);
    expect(recovered.length / onsides.length).toBeGreaterThan(0.06);
    expect(recovered.length / onsides.length).toBeLessThan(0.3);
    for (const o of onsides) {
      expect(o.result).toBe('onside');
      expect(o.kickDistance).toBeLessThan(25);
      expect(o.endBallOn).toBeGreaterThan(40);
      expect(o.endBallOn).toBeLessThan(60);
      if (o.turnover) expect(o.turnoverType).toBe('onside');
      expect(o.events.some((e) => e.type === 'onsideRecovery')).toBe(true);
    }
  });

  it('kick returns are deterministic per seed and a better returner gains more', () => {
    const a = simulatePlay(makeCtx({ offensePlayId: 'kickoff-deep', defensePlayId: 'kickReturn-middle', ballOn: 35, special: 'kickoff', seed: 9 }, 3));
    const b = simulatePlay(makeCtx({ offensePlayId: 'kickoff-deep', defensePlayId: 'kickReturn-middle', ballOn: 35, special: 'kickoff', seed: 9 }, 3));
    expect(a).toEqual(b);
    const base = makeCtx({ offensePlayId: 'kickoff-deep', defensePlayId: 'kickReturn-middle', ballOn: 35, special: 'kickoff', seed: 10 });
    const shift = (p: (typeof base.defenseLineup)[string], delta: number) => ({ ...p, attrs: { ...p.attrs, speed: Math.min(99, Math.max(1, p.attrs.speed + delta)), agility: Math.min(99, Math.max(1, p.attrs.agility + delta)), vision: Math.min(99, Math.max(1, p.attrs.vision + delta)) } });
    const boost = (delta: number) => ({ ...base, defenseLineup: { ...base.defenseLineup, KR: shift(base.defenseLineup['KR']!, delta), KR2: shift(base.defenseLineup['KR2']!, delta) } });
    const avg = (ctx: ReturnType<typeof boost>): number => {
      let total = 0; let n = 0;
      for (let v = 0; v < 400; v++) { const o = simulatePlay(variantOf(ctx, v)); if (o.returnYards > 0) { total += o.returnYards; n += 1; } }
      return total / n;
    };
    expect(avg(boost(30))).toBeGreaterThan(avg(boost(-30)) + 2);
  });
});

describe('kick-play clock facts', () => {
  it('kickoffs and onside kicks never report pre-snap seconds (the clock is stopped), punts and field goals do', () => {
    for (let v = 0; v < 30; v++) {
      expect(simulatePlay(makeCtx({ offensePlayId: 'kickoff-deep', defensePlayId: 'kickReturn-middle', ballOn: 35, special: 'kickoff', seed: 1 }, v)).presnapElapsed).toBe(0);
      expect(simulatePlay(makeCtx({ offensePlayId: 'kickoff-onside', defensePlayId: 'kickReturn-hands', ballOn: 35, special: 'onside', seed: 1 }, v)).presnapElapsed).toBe(0);
    }
    expect(simulatePlay(makeCtx({ offensePlayId: 'punt-standard', defensePlayId: 'puntReturn-middle', ballOn: 30, down: 4, distance: 8, special: 'punt', seed: 3 }, 1)).presnapElapsed).toBeGreaterThan(0);
    expect(simulatePlay(makeCtx({ offensePlayId: 'fieldGoal-standard', defensePlayId: 'fgBlock-middle', ballOn: 80, down: 4, distance: 5, special: 'fieldGoal', seed: 3 }, 1)).presnapElapsed).toBeGreaterThan(0);
  });

  it('a punt touchback is valued from the 20, not the goal line', () => {
    const os = many({ offensePlayId: 'punt-standard', defensePlayId: 'puntReturn-middle', ballOn: 60, down: 4, distance: 8, special: 'punt', seed: 12 }, 400);
    const tb = os.filter((o) => o.events.some((e) => e.type === 'touchback'));
    const downed = os.filter((o) => o.events.some((e) => e.type === 'downed') && o.endBallOn >= 96);
    expect(tb.length).toBeGreaterThan(0);
    expect(downed.length).toBeGreaterThan(0);
    for (const o of tb) for (const d of downed) expect(o.epa).toBeLessThan(d.epa);
  });
});
