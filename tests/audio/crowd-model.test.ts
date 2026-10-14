import { describe, expect, it } from 'vitest';
import {
  KICK_TENSION_LEVEL, NEUTRAL_CROWD_LEVEL, bedMix, crowdIntensity, crowdMargin, freshPlayFacts, isDefensiveStand, notePlayFact,
  predictNextSituation, venueScale, type CrowdInput, type CrowdSituation,
} from '@/audio/crowd-model';

const sit = (over: Partial<CrowdSituation> = {}): CrowdSituation => ({
  offense: 'away', down: 1, distance: 10, ballOn: 40, quarter: 2, clockRemaining: 600, scoreDiff: 0, special: 'none', ...over,
});
const level = (s: CrowdSituation | null, over: Partial<CrowdInput> = {}): number =>
  crowdIntensity({ situation: s, crowdSide: 'home', phase: 'presnap', liveSeconds: 0, ...over });

describe('crowdIntensity', () => {
  it('is neutral without a situation', () => {
    expect(level(null)).toBe(NEUTRAL_CROWD_LEVEL);
  });

  it('gets loud when the home defense faces 3rd and 4th down, louder on 4th', () => {
    const first = level(sit({ down: 1 }));
    const third = level(sit({ down: 3, distance: 8 }));
    const fourth = level(sit({ down: 4, distance: 2 }));
    expect(third).toBeGreaterThan(first + 0.2);
    expect(fourth).toBeGreaterThan(third);
    expect(level(sit({ down: 3, distance: 12 }))).toBeGreaterThan(level(sit({ down: 3, distance: 2 })));
  });

  it('hushes while the home offense huddles', () => {
    expect(level(sit({ offense: 'home', down: 3 }))).toBeLessThan(level(sit({ offense: 'away', down: 1 })));
    // The crowd supporting the away side flips the picture.
    expect(level(sit({ offense: 'home', down: 3 }), { crowdSide: 'away' })).toBeGreaterThan(0.7);
  });

  it('holds a near-silent tension before a field goal', () => {
    expect(level(sit({ special: 'fieldGoal' }))).toBe(KICK_TENSION_LEVEL);
    expect(level(sit({ special: 'fieldGoal' }), { phase: 'live' })).toBeGreaterThan(KICK_TENSION_LEVEL);
  });

  it('swells with the length of a live play and is capped', () => {
    const at = (t: number): number => level(sit(), { phase: 'live', liveSeconds: t });
    expect(at(3)).toBeGreaterThan(at(0.5));
    expect(at(6)).toBeGreaterThan(at(3));
    expect(at(30)).toBeLessThanOrEqual(1);
    expect(at(30)).toBe(at(60));
  });

  it('is louder in a close game late and quieter in a lost cause', () => {
    const late = sit({ quarter: 4, clockRemaining: 120, scoreDiff: 3 });
    expect(level(late)).toBeGreaterThan(level(sit({ scoreDiff: 3 })));
    const blowout = sit({ quarter: 4, clockRemaining: 600, offense: 'away', scoreDiff: 28 });
    expect(crowdMargin(blowout, 'home')).toBe(-28);
    expect(level(blowout)).toBeLessThan(level(sit({ quarter: 4, clockRemaining: 600 })));
  });

  it('always returns 0..1', () => {
    for (const down of [1, 2, 3, 4]) for (const phase of ['presnap', 'live', 'dead'] as const) {
      const v = level(sit({ down, ballOn: 95, quarter: 5, scoreDiff: -1 }), { phase, liveSeconds: 99 });
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });
});

describe('bedMix', () => {
  it('crossfades murmur -> engaged -> loud with equal power', () => {
    expect(bedMix(0)).toEqual({ murmur: 1, engaged: 0, loud: 0 });
    expect(bedMix(0.5).engaged).toBeCloseTo(1);
    expect(bedMix(1).loud).toBeCloseTo(1);
    for (const l of [0.1, 0.3, 0.6, 0.9]) {
      const m = bedMix(l);
      expect(m.murmur ** 2 + m.engaged ** 2 + m.loud ** 2).toBeCloseTo(1);
    }
    expect(bedMix(Number.NaN)).toEqual(bedMix(0));
  });
});

describe('venueScale', () => {
  it('scales by capacity and atmosphere, domes louder and reverberant', () => {
    const big = venueScale({ capacity: 75000, roof: 'open' }, 0.8);
    const small = venueScale({ capacity: 20000, roof: 'open' }, 0.8);
    const dome = venueScale({ capacity: 75000, roof: 'dome' }, 0.8);
    expect(big.gain).toBeGreaterThan(small.gain);
    expect(dome.gain).toBeGreaterThan(big.gain);
    expect(dome.reverb).toBeGreaterThan(0);
    expect(big.reverb).toBe(0);
    expect(venueScale(null)).toEqual({ gain: 1, reverb: 0 });
    expect(venueScale({ capacity: 70000 }, 1).gain).toBeGreaterThan(venueScale({ capacity: 70000 }, 0).gain);
  });
});

describe('next-snap anticipation', () => {
  it('guesses the next down from the last play', () => {
    const facts = freshPlayFacts();
    expect(predictNextSituation(sit({ down: 2 }), facts)?.down).toBe(3);
    expect(predictNextSituation(sit({ down: 3, distance: 4 }), notePlayFact(facts, { type: 'firstDown' }))).toMatchObject({ down: 1, distance: 10 });
    // Turnover on downs, kicks, scores, flags and takeaways cannot be guessed.
    expect(predictNextSituation(sit({ down: 4 }), facts)).toBeNull();
    // After a 3rd down the next snap is usually a kick: no 4th-down guess.
    expect(predictNextSituation(sit({ down: 3 }), facts)).toBeNull();
    expect(predictNextSituation(sit({ special: 'punt' }), facts)).toBeNull();
    for (const type of ['touchdown', 'interception', 'penalty', 'kick']) expect(predictNextSituation(sit(), notePlayFact(facts, { type }))).toBeNull();
    expect(predictNextSituation(sit(), notePlayFact(facts, { type: 'recovery', side: 'defense' }))).toBeNull();
    expect(predictNextSituation(sit(), notePlayFact(facts, { type: 'recovery', side: 'offense' }))?.down).toBe(2);
    expect(predictNextSituation(null, facts)).toBeNull();
    // The applied result overrides the live guess: chains moved on the spot, or a turnover.
    const moved = notePlayFact(facts, { type: 'playResult', firstDown: true, turnover: false, yards: 3 });
    expect(predictNextSituation(sit({ down: 3, distance: 2 }), moved)?.down).toBe(1);
    const short = notePlayFact(notePlayFact(facts, { type: 'firstDown' }), { type: 'playResult', firstDown: false, turnover: false, yards: 4 });
    expect(predictNextSituation(sit({ down: 2, distance: 9 }), short)).toMatchObject({ down: 3, distance: 5 });
    expect(predictNextSituation(sit(), notePlayFact(facts, { type: 'playResult', firstDown: false, turnover: true, yards: 0 }))).toBeNull();
  });

  it('knows a defensive stand: the crowd team defending on 3rd / 4th down from scrimmage', () => {
    expect(isDefensiveStand(sit({ down: 3 }), 'home')).toBe(true);
    expect(isDefensiveStand(sit({ down: 2 }), 'home')).toBe(false);
    expect(isDefensiveStand(sit({ down: 3, offense: 'home' }), 'home')).toBe(false);
    expect(isDefensiveStand(sit({ down: 4, special: 'punt' }), 'home')).toBe(false);
  });
});
