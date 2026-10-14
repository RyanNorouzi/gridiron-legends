import { describe, expect, it } from 'vitest';
import {
  SOUNDS, SOUND_CATEGORIES, SOUND_IDS, isSoundId, soundCategory, transposeRecipe, validateRecipe, type SynthRecipe,
} from '@/audio/sounds';

describe('sound catalogue', () => {
  it('lists every required id exactly once and each has a recipe', () => {
    const required = [
      'crowdAmbient', 'crowdCheer', 'crowdGroan', 'crowdRoar', 'tackle', 'bigHit', 'catch', 'throw', 'kickoff', 'punt',
      'fieldGoal', 'whistle', 'touchdown', 'turnover', 'firstDown', 'menuMove', 'menuSelect', 'menuBack', 'snap',
      'incomplete', 'sack', 'fumble', 'interception', 'twoMinute', 'gameOver', 'penaltyFlag', 'hitStick',
      'boothExcited', 'boothWhoa', 'boothAww', 'paChime',
    ];
    expect([...SOUND_IDS].sort()).toEqual([...required].sort());
    expect(new Set(SOUND_IDS).size).toBe(SOUND_IDS.length);
    expect(Object.keys(SOUNDS).sort()).toEqual([...required].sort());
  });

  it('every recipe passes validation', () => {
    for (const id of SOUND_IDS) expect(() => validateRecipe(id, SOUNDS[id])).not.toThrow();
  });

  it('assigns sensible categories and only the ambient bed loops', () => {
    for (const id of SOUND_IDS) expect(SOUND_CATEGORIES).toContain(soundCategory(id));
    expect(soundCategory('crowdRoar')).toBe('crowd');
    expect(soundCategory('crowdGroan')).toBe('crowd');
    expect(soundCategory('tackle')).toBe('sfx');
    expect(soundCategory('touchdown')).toBe('music');
    expect(SOUND_IDS.filter((id) => SOUNDS[id].loop)).toEqual(['crowdAmbient']);
    expect(SOUNDS.crowdAmbient.modulation?.rateHz).toBeLessThan(1);
  });

  it('isSoundId guards untrusted strings without hitting the prototype chain', () => {
    expect(isSoundId('tackle')).toBe(true);
    expect(isSoundId('toString')).toBe(false);
    expect(isSoundId('constructor')).toBe(false);
    expect(isSoundId(42)).toBe(false);
    expect(isSoundId(null)).toBe(false);
  });

  it('transposeRecipe scales oscillator and filter frequencies and ignores bad factors', () => {
    const up = transposeRecipe(SOUNDS.bigHit, 2);
    expect(up.startHz).toBe(180);
    expect(up.endHz).toBe(60);
    expect(up.filter?.hz).toBe(2400);
    expect(up.filter?.endHz).toBe(600);
    expect(up.duration).toBe(SOUNDS.bigHit.duration);
    expect(SOUNDS.bigHit.startHz).toBe(90);
    expect(transposeRecipe(SOUNDS.tackle, 0)).toEqual(SOUNDS.tackle);
    expect(transposeRecipe(SOUNDS.tackle, Number.NaN)).toEqual(SOUNDS.tackle);
    expect(transposeRecipe(SOUNDS.menuMove, 1.5).filter).toBeUndefined();
  });

  it('validateRecipe rejects malformed recipes with descriptive errors', () => {
    const base: SynthRecipe = { ...SOUNDS.tackle };
    expect(() => validateRecipe('x', { ...base, gain: 1.5 })).toThrow(/'x'.*gain/);
    expect(() => validateRecipe('x', { ...base, noiseMix: -0.1 })).toThrow(/noiseMix/);
    expect(() => validateRecipe('x', { ...base, envelope: { ...base.envelope, sustain: 2 } })).toThrow(/sustain/);
    expect(() => validateRecipe('x', { ...base, envelope: { attack: 0.2, decay: 0.2, sustain: 0.5, release: 0.2 } })).toThrow(/exceeds duration/);
    expect(() => validateRecipe('x', { ...base, startHz: 5 })).toThrow(/startHz/);
    expect(() => validateRecipe('x', { ...base, duration: 0 })).toThrow(/duration/);
    expect(() => validateRecipe('x', { ...base, harmonics: [2] })).toThrow(/harmonics/);
    expect(() => validateRecipe('x', { ...base, modulation: { rateHz: 0, depth: 0.5 } })).toThrow(/modulation/);
    expect(() => validateRecipe('x', { ...base, filter: { kind: 'lowpass', hz: 10, q: 1 } })).toThrow(/filter/);
    expect(() => validateRecipe('x', { ...base, category: 'voice' as SynthRecipe['category'] })).toThrow(/category/);
    // noise voices may leave frequencies at anything; loops may exceed duration with their envelope.
    expect(() => validateRecipe('n', { ...SOUNDS.throw, startHz: 0, endHz: 0 })).not.toThrow();
    expect(() => validateRecipe('l', { ...SOUNDS.crowdAmbient, duration: 0.5 })).not.toThrow();
  });
});
