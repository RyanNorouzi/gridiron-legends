import { describe, expect, it } from 'vitest';
import { createRng } from '@/core/rng';
import { getDifficulty } from '@/game/rulesets';
import { athleteNoise, cachedRoll, decisionQuality, jitter, noiseIndex, noiseScale, reactionDelay } from '@/ai/variance';
import { makeAthlete } from '../../physics/helpers';

describe('variance', () => {
  it('athleteNoise is deterministic per (player, salt), spread over 0..1 and differs between salts', () => {
    const a = makeAthlete();
    expect(athleteNoise(a, 'eager')).toBe(athleteNoise(a, 'eager'));
    expect(athleteNoise(a, 'eager')).not.toBe(athleteNoise(a, 'lane'));
    const values: number[] = [];
    for (let i = 0; i < 200; i++) values.push(athleteNoise(makeAthlete(), 'x'));
    for (const v of values) { expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThan(1); }
    const mean = values.reduce((s, v) => s + v, 0) / values.length;
    expect(mean).toBeGreaterThan(0.4);
    expect(mean).toBeLessThan(0.6);
    expect(Math.abs(jitter(a, 'j', 2))).toBeLessThanOrEqual(2);
    expect(noiseScale(a, 's')).toBeGreaterThanOrEqual(0.85);
    expect(noiseScale(a, 's')).toBeLessThanOrEqual(1.15);
    expect(noiseIndex(a, 'i', 3)).toBeGreaterThanOrEqual(0);
    expect(noiseIndex(a, 'i', 3)).toBeLessThan(3);
  });

  it('reaction delay is longer on rookie than legend and for low-reaction athletes', () => {
    const rookie = getDifficulty('rookie');
    const legend = getDifficulty('legend');
    const slow = makeAthlete({ attrs: { reaction: 30 } });
    const quick = makeAthlete({ attrs: { reaction: 95 } });
    expect(reactionDelay(slow, rookie)).toBeGreaterThan(reactionDelay(slow, legend));
    expect(reactionDelay(quick, rookie)).toBeGreaterThan(reactionDelay(quick, legend));
    expect(reactionDelay(slow, rookie)).toBeGreaterThan(reactionDelay(quick, rookie));
    expect(reactionDelay(slow, legend)).toBeGreaterThan(reactionDelay(quick, legend));
    // A 95-reaction rookie-AI defender is still slower than a 30-reaction legend-AI one.
    expect(reactionDelay(quick, rookie)).toBeGreaterThan(reactionDelay(slow, legend));
    expect(reactionDelay(quick, legend)).toBeGreaterThanOrEqual(0);
  });

  it('decisionQuality rises with awareness and with the difficulty knob', () => {
    const dumb = makeAthlete({ attrs: { awareness: 20 } });
    const smart = makeAthlete({ attrs: { awareness: 95 } });
    expect(decisionQuality(smart, 0.5)).toBeGreaterThan(decisionQuality(dumb, 0.5));
    expect(decisionQuality(dumb, 0.95)).toBeGreaterThan(decisionQuality(dumb, 0.3));
    expect(decisionQuality(smart, 1)).toBeLessThanOrEqual(1);
    expect(decisionQuality(dumb, 0)).toBeGreaterThanOrEqual(0);
  });

  it('cachedRoll holds a roll for its ttl and then re-rolls', () => {
    const a = makeAthlete();
    const rng = createRng(3);
    const first = cachedRoll(a, rng, 10, 'hit', 30);
    expect(cachedRoll(a, rng, 25, 'hit', 30)).toBe(first);
    expect(cachedRoll(a, rng, 39, 'hit', 30)).toBe(first);
    const later = cachedRoll(a, rng, 40, 'hit', 30);
    expect(later).not.toBe(first);
    expect(a.ai.scratch['hit@']).toBe(40);
  });
});
