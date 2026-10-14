import { describe, expect, it } from 'vitest';
import { createRng } from '@/core/rng';
import {
  MORALE_PERFORMANCE_RANGE, adjustMorale, assignTraits, chemistryContribution, moraleEffectOnPerformance, traitsConflict,
} from '@/players/personality';
import type { MoraleEvent } from '@/players/personality';
import { PERSONALITY_TRAITS } from '@/players/types';
import type { Morale, PersonalityTrait } from '@/players/types';
import { makePlayer } from './helpers';

describe('assignTraits', () => {
  it('draws 0..3 distinct, non-conflicting traits and covers every count', () => {
    const counts = new Set<number>();
    const rng = createRng(11);
    for (let i = 0; i < 500; i++) {
      const traits = assignTraits(rng);
      counts.add(traits.length);
      expect(traits.length).toBeLessThanOrEqual(3);
      expect(new Set(traits).size).toBe(traits.length);
      for (const t of traits) expect(PERSONALITY_TRAITS).toContain(t);
      for (const a of traits) for (const b of traits) if (a !== b) expect(traitsConflict(a, b)).toBe(false);
    }
    expect([...counts].sort()).toEqual([0, 1, 2, 3]);
  });
  it('is deterministic per seed and rarely hands mentor to rookies', () => {
    expect(assignTraits(createRng(5))).toEqual(assignTraits(createRng(5)));
    const share = (experience: number): number => {
      const rng = createRng(99);
      let mentors = 0;
      for (let i = 0; i < 2000; i++) if (assignTraits(rng, { experience }).includes('mentor')) mentors++;
      return mentors / 2000;
    };
    expect(share(0)).toBeLessThan(share(10) * 0.7);
  });
  it('traitsConflict is symmetric', () => {
    expect(traitsConflict('lazy', 'workhorse')).toBe(true);
    expect(traitsConflict('workhorse', 'lazy')).toBe(true);
    expect(traitsConflict('hotHeaded', 'quiet')).toBe(true);
    expect(traitsConflict('leader', 'teamPlayer')).toBe(false);
  });
});

describe('adjustMorale', () => {
  const at = (morale: number, traits: PersonalityTrait[] = [], rest: Partial<Morale> = {}) =>
    makePlayer({ traits, morale: { morale, confidence: 60, coachRelationship: 60, ...rest } });
  const drop = (traits: PersonalityTrait[], event: MoraleEvent, start = 60): number => start - adjustMorale(at(start, traits), event).morale;

  it('stays within 0..100 and returns a new object without mutating the player', () => {
    const p = at(100);
    const before = { ...p.morale };
    const up = adjustMorale(p, { type: 'win' });
    expect(up.morale).toBe(100);
    expect(p.morale).toEqual(before);
    expect(up).not.toBe(p.morale);
    expect(adjustMorale(at(0), { type: 'loss' }).morale).toBe(0);
    expect(adjustMorale(at(2), { type: 'benched', magnitude: 3 }).morale).toBe(0);
    const big = adjustMorale(at(50), { type: 'contract', magnitude: 50 });
    expect(big.morale).toBe(68);
    expect(big.confidence).toBeLessThanOrEqual(100);
  });
  it('base directions are sensible', () => {
    expect(adjustMorale(at(60), { type: 'win' }).morale).toBeGreaterThan(60);
    expect(adjustMorale(at(60), { type: 'loss' }).morale).toBeLessThan(60);
    expect(adjustMorale(at(60), { type: 'benched' }).morale).toBeLessThan(adjustMorale(at(60), { type: 'loss' }).morale);
    expect(adjustMorale(at(60), { type: 'fine' }).coachRelationship).toBeLessThan(60);
    expect(adjustMorale(at(60), { type: 'praise' }).confidence).toBeGreaterThan(60);
    expect(adjustMorale(at(60), { type: 'injury' }).confidence).toBeLessThan(60);
    expect(adjustMorale(at(60), { type: 'win', magnitude: 0 }).morale).toBe(60);
  });
  it('hotHeaded amplifies negatives but not positives', () => {
    expect(drop(['hotHeaded'], { type: 'benched' })).toBeGreaterThan(drop([], { type: 'benched' }));
    expect(adjustMorale(at(60, ['hotHeaded']), { type: 'win' }).morale).toBe(adjustMorale(at(60), { type: 'win' }).morale);
  });
  it('teamPlayer dampens negatives', () => {
    expect(drop(['teamPlayer'], { type: 'benched' })).toBeLessThan(drop([], { type: 'benched' }));
    expect(drop(['teamPlayer'], { type: 'fine' })).toBeLessThan(drop([], { type: 'fine' }));
  });
  it('competitive players care more about winning', () => {
    expect(adjustMorale(at(60, ['competitive']), { type: 'teamSuccess' }).morale).toBeGreaterThan(adjustMorale(at(60), { type: 'teamSuccess' }).morale);
    expect(drop(['competitive'], { type: 'loss', magnitude: 2 })).toBeGreaterThan(drop([], { type: 'loss', magnitude: 2 }));
    expect(drop(['competitive'], { type: 'fine' })).toBe(drop([], { type: 'fine' }));
  });
  it('coach change and trades pull the coach relationship toward neutral', () => {
    expect(adjustMorale(at(60, [], { coachRelationship: 90 }), { type: 'coachChange' }).coachRelationship).toBe(60);
    expect(adjustMorale(at(60, [], { coachRelationship: 10 }), { type: 'coachChange' }).coachRelationship).toBe(40);
    expect(adjustMorale(at(60, [], { coachRelationship: 90 }), { type: 'traded' }).coachRelationship).toBe(60);
  });
});

describe('moraleEffectOnPerformance', () => {
  const m = (morale: number, confidence = morale): Morale => ({ morale, confidence, coachRelationship: 50 });
  it('is a small multiplier within the published bounds and monotonic in morale', () => {
    expect(moraleEffectOnPerformance(m(0))).toBe(MORALE_PERFORMANCE_RANGE[0]);
    expect(moraleEffectOnPerformance(m(100))).toBe(MORALE_PERFORMANCE_RANGE[1]);
    expect(moraleEffectOnPerformance(m(60))).toBeCloseTo(1, 6);
    let prev = 0;
    for (let v = 0; v <= 100; v += 5) {
      const f = moraleEffectOnPerformance(m(v, 60));
      expect(f).toBeGreaterThanOrEqual(prev);
      prev = f;
    }
    expect(moraleEffectOnPerformance(m(60, 100))).toBeGreaterThan(moraleEffectOnPerformance(m(60, 20)));
  });
});

describe('chemistryContribution', () => {
  it('leaders and team players add, hot heads and lazy players drain', () => {
    const glue = chemistryContribution(makePlayer({ traits: ['leader', 'teamPlayer'] }));
    const plain = chemistryContribution(makePlayer({ traits: [] }));
    const toxic = chemistryContribution(makePlayer({ traits: ['hotHeaded', 'lazy'] }));
    expect(glue).toBeGreaterThan(plain);
    expect(plain).toBeGreaterThan(toxic);
    expect(toxic).toBeLessThan(0);
  });
  it('morale, experience and coach relationship shade the result', () => {
    const happy = chemistryContribution(makePlayer({ morale: { morale: 95, confidence: 70, coachRelationship: 90 } }));
    const glum = chemistryContribution(makePlayer({ morale: { morale: 10, confidence: 70, coachRelationship: 10 } }));
    expect(happy).toBeGreaterThan(glum + 3);
    expect(chemistryContribution(makePlayer({ experience: 12 }))).toBeGreaterThan(chemistryContribution(makePlayer({ experience: 0 })));
  });
});
