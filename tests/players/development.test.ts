import { describe, expect, it } from 'vitest';
import { createRng } from '@/core/rng';
import {
  DEVELOPMENT, ageCurveFactor, computeAskingSalary, devTraitWeightsForQuality, growthEnvironmentFactor, progressPlayer,
  validateDevelopmentData,
} from '@/players/development';
import type { ProgressionContext } from '@/players/development';
import { emptyAttrs } from '@/players/attributes';
import type { Player, ProgressionKind } from '@/players/types';
import { makePlayer, mean } from './helpers';

const ctx = (seed: number, extra: Partial<Omit<ProgressionContext, 'rng'>> = {}): ProgressionContext => ({
  rng: createRng(seed), year: 2030, coachDevelopment: 60, facilityLevel: 3, snapsPlayed: 500, teamSuccess: 0.5, ...extra,
});

/** Runs `seasons` offseasons, ageing the player one year between each (as the franchise rollover would). */
const runSeasons = (player: Player, seasons: number, seed: number, extra: Partial<Omit<ProgressionContext, 'rng'>> = {}): Player => {
  let p = player;
  for (let i = 0; i < seasons; i++) {
    p = progressPlayer(p, ctx(seed + i, { ...extra, year: 2030 + i })).player;
    p = { ...p, age: p.age + 1, experience: p.experience + 1 };
  }
  return p;
};

describe('ageCurveFactor', () => {
  it('follows growth -> plateau -> decline for a running back', () => {
    expect(ageCurveFactor('RB', 21)).toBe(1);
    expect(ageCurveFactor('RB', 24)).toBe(1);
    expect(ageCurveFactor('RB', 25)).toBe(0);
    expect(ageCurveFactor('RB', 28)).toBe(0);
    const f30 = ageCurveFactor('RB', 30);
    expect(f30).toBeLessThan(0);
    expect(f30).toBeGreaterThan(-1);
    expect(ageCurveFactor('RB', 33)).toBe(-1);
    const f36 = ageCurveFactor('RB', 36);
    expect(f36).toBeLessThan(-1);
    expect(f36).toBeGreaterThanOrEqual(-1.6);
  });
  it('quarterbacks and kickers peak later than running backs', () => {
    expect(ageCurveFactor('QB', 30)).toBe(0);
    expect(ageCurveFactor('RB', 30)).toBeLessThan(0);
    expect(ageCurveFactor('K', 35)).toBe(0);
    expect(ageCurveFactor('QB', 27)).toBeGreaterThan(0);
    expect(ageCurveFactor('QB', 27)).toBeLessThan(1);
  });
  it('is monotonically non-increasing with age for every position', () => {
    for (const pos of ['QB', 'RB', 'WR', 'OT', 'CB', 'K'] as const) {
      let prev = ageCurveFactor(pos, 18);
      for (let age = 19; age <= 45; age++) {
        const f = ageCurveFactor(pos, age);
        expect(f).toBeLessThanOrEqual(prev + 1e-9);
        prev = f;
      }
    }
  });
});

describe('progressPlayer growth', () => {
  it('a 22-year-old star grows substantially over 5 seasons and never exceeds potential', () => {
    const young = makePlayer({ position: 'WR', age: 22, attrValue: 68, potential: 92, devTrait: 'star', experience: 0 });
    let p = young;
    for (let i = 0; i < 5; i++) {
      p = progressPlayer(p, ctx(100 + i, { year: 2030 + i })).player;
      expect(p.overall).toBeLessThanOrEqual(p.potential);
      expect(p.progressionLog).toHaveLength(i + 1);
      expect(p.progressionLog[i]?.year).toBe(2030 + i);
      p = { ...p, age: p.age + 1 };
    }
    expect(p.overall).toBeGreaterThanOrEqual(young.overall + 12);
    expect(p.attrs.catching).toBeGreaterThan(young.attrs.catching);
    expect(p.attrs.speed).toBeGreaterThan(young.attrs.speed);
  });
  it('a 34-year-old declines, losing speed before awareness', () => {
    const vet = makePlayer({ position: 'RB', age: 34, attrValue: 82, potential: 82 });
    const after = runSeasons(vet, 1, 200);
    expect(after.overall).toBeLessThan(vet.overall);
    const speedDrop = vet.attrs.speed - after.attrs.speed;
    const awarenessDrop = vet.attrs.awareness - after.attrs.awareness;
    expect(speedDrop).toBeGreaterThan(0);
    expect(speedDrop).toBeGreaterThan(awarenessDrop);
    expect(awarenessDrop).toBeLessThanOrEqual(0);
    expect(after.potential).toBeLessThanOrEqual(vet.overall);
    expect(after.potential).toBeGreaterThanOrEqual(after.overall);
  });
  it('respects the potential ceiling for capped players across many seeds', () => {
    const capped = makePlayer({ position: 'QB', age: 22, attrValue: 74, potential: 74, devTrait: 'superstar' });
    for (let seed = 0; seed < 60; seed++) {
      const { player } = progressPlayer(capped, ctx(seed));
      expect(player.overall).toBeLessThanOrEqual(player.potential);
      expect(player.overall).toBeLessThanOrEqual(capped.potential + DEVELOPMENT.potentialDrift.max + DEVELOPMENT.events.breakout.potentialBonus[1]!);
    }
  });
  it('does not mutate the input player and is deterministic', () => {
    const p = makePlayer({ position: 'CB', age: 23, attrValue: 65, potential: 85 });
    const snapshot = JSON.parse(JSON.stringify(p)) as Player;
    const a = progressPlayer(p, ctx(9));
    const b = progressPlayer(p, ctx(9));
    expect(p).toEqual(snapshot);
    expect(a.player).not.toBe(p);
    expect(a.player.attrs).not.toBe(p.attrs);
    expect(a).toEqual(b);
    expect(a.entry.overallBefore).toBe(p.overall);
    expect(a.entry.overallAfter).toBe(a.player.overall);
    expect(a.player.progressionLog.at(-1)).toEqual(a.entry);
  });
  it('better coaching, facilities and snaps produce more growth on average', () => {
    const p = makePlayer({ position: 'OLB', age: 23, attrValue: 62, potential: 90, devTrait: 'normal' });
    const grow = (extra: Partial<Omit<ProgressionContext, 'rng'>>): number =>
      mean(Array.from({ length: 120 }, (_, i) => progressPlayer(p, ctx(300 + i, extra)).player.overall - p.overall));
    const rich = grow({ coachDevelopment: 99, facilityLevel: 5, snapsPlayed: 900 });
    const poor = grow({ coachDevelopment: 5, facilityLevel: 1, snapsPlayed: 0 });
    expect(rich).toBeGreaterThan(poor + 1.5);
    expect(growthEnvironmentFactor(p, { coachDevelopment: 99, facilityLevel: 5, snapsPlayed: 900, teamSuccess: 1 }))
      .toBeGreaterThan(growthEnvironmentFactor(p, { coachDevelopment: 5, facilityLevel: 1, snapsPlayed: 0, teamSuccess: 0 }));
  });
  it('training focus accelerates the focused attribute', () => {
    const p = makePlayer({ position: 'WR', age: 23, attrValue: 60, potential: 88 });
    const focused = mean(Array.from({ length: 80 }, (_, i) => progressPlayer(p, ctx(400 + i, { trainingFocus: 'routeRunning' })).player.attrs.routeRunning));
    const balanced = mean(Array.from({ length: 80 }, (_, i) => progressPlayer(p, ctx(400 + i, { trainingFocus: null })).player.attrs.routeRunning));
    expect(focused).toBeGreaterThan(balanced + 1);
    const viaPlayer = progressPlayer({ ...p, trainingFocus: 'routeRunning' }, ctx(1)).player;
    const viaCtx = progressPlayer(p, ctx(1, { trainingFocus: 'routeRunning' })).player;
    expect(viaPlayer.attrs).toEqual(viaCtx.attrs);
  });
  it('dev trait speeds growth: superstar outgrows bust', () => {
    const base = makePlayer({ position: 'DT', age: 22, attrValue: 60, potential: 90 });
    const growFor = (devTrait: Player['devTrait']): number =>
      mean(Array.from({ length: 100 }, (_, i) => progressPlayer({ ...base, devTrait }, ctx(500 + i)).player.overall - base.overall));
    expect(growFor('superstar')).toBeGreaterThan(growFor('bust') + 3);
  });
});

describe('progression events', () => {
  const kindsOver = (player: Player, n: number, seedBase: number): Set<ProgressionKind> => {
    const kinds = new Set<ProgressionKind>();
    for (let i = 0; i < n; i++) kinds.add(progressPlayer(player, ctx(seedBase + i)).entry.kind);
    return kinds;
  };
  it('young superstars can break out and veterans can fall off a cliff', () => {
    const young = makePlayer({ position: 'RB', age: 22, attrValue: 65, potential: 85, devTrait: 'superstar' });
    expect(kindsOver(young, 300, 1000).has('breakout')).toBe(true);
    const old = makePlayer({ position: 'RB', age: 33, attrValue: 80, potential: 80 });
    expect(kindsOver(old, 300, 2000).has('decline')).toBe(true);
    expect(kindsOver(old, 300, 2000).has('breakout')).toBe(false);
  });
  it('slumps and jumps both occur, moving the overall in opposite directions', () => {
    const p = makePlayer({ position: 'WR', age: 27, attrValue: 76, potential: 80 });
    const byKind: Partial<Record<ProgressionKind, number[]>> = {};
    for (let i = 0; i < 500; i++) {
      const r = progressPlayer(p, ctx(7000 + i));
      (byKind[r.entry.kind] ??= []).push(r.player.overall - p.overall);
    }
    expect(byKind.slump?.length ?? 0).toBeGreaterThan(0);
    expect(byKind.jump?.length ?? 0).toBeGreaterThan(0);
    expect(mean(byKind.slump ?? [])).toBeLessThan(mean(byKind.normal ?? []) - 1);
    expect(mean(byKind.jump ?? [])).toBeGreaterThan(mean(byKind.normal ?? []) + 1);
    // Low morale and the bust trait make slumps more likely.
    const glum = { ...p, morale: { ...p.morale, morale: 20 }, devTrait: 'bust' as const };
    let slumps = 0;
    for (let i = 0; i < 500; i++) if (progressPlayer(glum, ctx(7000 + i)).entry.kind === 'slump') slumps++;
    expect(slumps).toBeGreaterThan(byKind.slump?.length ?? 0);
  });
  it('rejects a non-finite context at the boundary instead of leaking NaN into attrs', () => {
    const p = makePlayer({ position: 'CB', age: 23, attrValue: 65, potential: 85 });
    expect(() => progressPlayer(p, ctx(1, { coachDevelopment: Number.NaN }))).toThrow(/coachDevelopment/);
    expect(() => progressPlayer(p, ctx(1, { snapsPlayed: Number.POSITIVE_INFINITY }))).toThrow(/snapsPlayed/);
    expect(() => progressPlayer(p, ctx(1, { trainingFocus: 'dancing' as unknown as 'speed' }))).toThrow(/trainingFocus/);
  });
  it('a breakout raises overall by more than a normal year and can lift potential', () => {
    const young = makePlayer({ position: 'RB', age: 22, attrValue: 65, potential: 70, devTrait: 'superstar' });
    const normal: number[] = [];
    const breakout: number[] = [];
    for (let i = 0; i < 400; i++) {
      const r = progressPlayer(young, ctx(3000 + i));
      (r.entry.kind === 'breakout' ? breakout : normal).push(r.player.overall - young.overall);
      if (r.entry.kind === 'breakout') expect(r.player.potential).toBeGreaterThanOrEqual(young.potential);
    }
    expect(breakout.length).toBeGreaterThan(0);
    expect(mean(breakout)).toBeGreaterThan(mean(normal));
  });
  it('a severe injury this year marks the season as an injury year with athletic losses', () => {
    const healthy = makePlayer({ position: 'WR', age: 25, attrValue: 75, potential: 82 });
    const hurt: Player = {
      ...healthy,
      injuryHistory: [{ bodyArea: 'lowerBody', severity: 'seasonEnding', weeksRemaining: 0, permanentPenalty: null, occurredYear: 2030, occurredWeek: 6 }],
    };
    const hurtSpeed: number[] = [];
    const healthySpeed: number[] = [];
    for (let i = 0; i < 100; i++) {
      const r = progressPlayer(hurt, ctx(600 + i, { year: 2030 }));
      expect(r.entry.kind).toBe('injury');
      hurtSpeed.push(r.player.attrs.speed - hurt.attrs.speed);
      healthySpeed.push(progressPlayer(healthy, ctx(600 + i, { year: 2030 })).player.attrs.speed - healthy.attrs.speed);
    }
    expect(mean(hurtSpeed)).toBeLessThan(mean(healthySpeed) - 1.5);
    // The same history no longer counts once the year has moved on.
    const later = progressPlayer(hurt, ctx(5, { year: 2031 }));
    expect(later.entry.kind).not.toBe('injury');
  });
});

describe('salary scale and data', () => {
  it('computeAskingSalary is monotonic in overall, scarce positions pay more, never below minimum', () => {
    let prev = 0;
    for (let ovr = 40; ovr <= 99; ovr++) {
      const s = computeAskingSalary('QB', ovr, ovr, 27);
      expect(s).toBeGreaterThanOrEqual(prev);
      expect(s).toBeGreaterThanOrEqual(DEVELOPMENT.salary.minimum);
      prev = s;
    }
    expect(computeAskingSalary('QB', 92, 92, 27)).toBeGreaterThan(30_000_000);
    expect(computeAskingSalary('QB', 92, 92, 27)).toBeGreaterThan(computeAskingSalary('WR', 92, 92, 27));
    expect(computeAskingSalary('WR', 92, 92, 27)).toBeGreaterThan(computeAskingSalary('K', 92, 92, 27) * 3);
    expect(computeAskingSalary('QB', 45, 45, 27)).toBe(DEVELOPMENT.salary.minimum);
    expect(computeAskingSalary('RB', 80, 80, 27)).toBeGreaterThan(computeAskingSalary('RB', 80, 80, 34));
    expect(computeAskingSalary('RB', 70, 90, 22)).toBeGreaterThan(computeAskingSalary('RB', 70, 70, 22));
  });
  it('progression refreshes askingSalary', () => {
    const p = makePlayer({ position: 'QB', age: 23, attrValue: 70, potential: 95, devTrait: 'star', askingSalary: 1 });
    const r = progressPlayer(p, ctx(8));
    expect(r.player.askingSalary).toBe(computeAskingSalary('QB', r.player.overall, r.player.potential, 23));
  });
  it('devTraitWeightsForQuality and validation guard the data boundary', () => {
    expect(devTraitWeightsForQuality('elite').superstar).toBeGreaterThan(devTraitWeightsForQuality('fringe').superstar);
    expect(() => devTraitWeightsForQuality('legend')).toThrow(/legend/);
    const broken = JSON.parse(JSON.stringify(DEVELOPMENT)) as { positions: Record<string, unknown> };
    delete broken.positions.QB;
    expect(() => validateDevelopmentData(broken)).toThrow(/QB/);
    expect(() => validateDevelopmentData(null)).toThrow(/object/);
    expect(validateDevelopmentData(DEVELOPMENT)).toBe(DEVELOPMENT);
  });
  it('a plateau player barely moves and keeps flat attrs coherent', () => {
    const peak = makePlayer({ position: 'QB', age: 30, attrs: emptyAttrs(80), potential: 80 });
    const r = progressPlayer(peak, ctx(12));
    expect(Math.abs(r.player.overall - peak.overall)).toBeLessThanOrEqual(3);
    expect(r.player.overall).toBeLessThanOrEqual(r.player.potential);
  });
});
