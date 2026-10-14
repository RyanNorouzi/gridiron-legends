import { describe, expect, it } from 'vitest';
import { createRng } from '@/core/rng';
import { outcomeAt } from '@/game/outcome-factory';
import { applyChallengeAccounting, boothReviews, canChallenge, challengeSideFor, resolveChallenge, shouldChallengeDefault } from '@/game/rules/challenges';
import { makeSetup, situation } from './fixtures';

const reviewed = (confidence: number) => {
  const ruled = outcomeAt(50, { result: 'pass', yards: 30, firstDown: true, receiverId: null });
  const alt = outcomeAt(50, { result: 'incomplete', incomplete: true });
  return { ...ruled, review: { call: { kind: 'catch' as const, tick: 120, athleteId: 'off:WR1', confidence }, ifOverturned: alt } };
};

describe('challenges', () => {
  it('canChallenge requires the ruleset, a challenge, a timeout, a reviewable play and time outside two minutes', () => {
    const setup = makeSetup();
    const s = situation(setup, { lastOutcome: reviewed(0.6), clock: { quarter: 2, secondsRemaining: 400, running: false, playClock: 40, playClockRunning: false } });
    expect(canChallenge(s, 'away')).toBe(true);
    expect(canChallenge({ ...s, timeouts: { home: 3, away: 0 } }, 'away')).toBe(false);
    expect(canChallenge({ ...s, challenges: { home: 2, away: 0 } }, 'away')).toBe(false);
    expect(canChallenge({ ...s, lastOutcome: outcomeAt(50, {}) }, 'away')).toBe(false);
    expect(canChallenge({ ...s, clock: { ...s.clock, secondsRemaining: 90 } }, 'away')).toBe(false);
    expect(canChallenge({ ...s, ruleset: { ...s.ruleset, challenges: false } }, 'away')).toBe(false);
  });

  it('the side hurt by the ruling is the one entitled to challenge', () => {
    const setup = makeSetup();
    const s = situation(setup, { possession: 'home', ballOn: 50, down: 2, distance: 8 });
    expect(challengeSideFor(s, reviewed(0.5))).toBe('away');
    expect(challengeSideFor(s, outcomeAt(50, {}))).toBeNull();
  });

  it('resolveChallenge is a confidence roll: low confidence tends to overturn, high confidence stands', () => {
    const outcome = reviewed(0.15);
    let overturned = 0;
    for (let seed = 0; seed < 200; seed++) {
      const r = resolveChallenge({ clock: { quarter: 1, secondsRemaining: 500, running: false, playClock: 40, playClockRunning: false } }, outcome, createRng(seed));
      if (!r.upheld) {
        overturned++;
        expect(r.outcome.incomplete).toBe(true);
        expect(r.outcome.review).toBeNull();
      } else {
        expect(r.outcome.yards).toBe(30);
      }
    }
    expect(overturned).toBeGreaterThan(140);
    const solid = reviewed(0.95);
    let stood = 0;
    for (let seed = 0; seed < 200; seed++) if (resolveChallenge({ clock: { quarter: 1, secondsRemaining: 500, running: false, playClock: 40, playClockRunning: false } }, solid, createRng(seed)).upheld) stood++;
    expect(stood).toBeGreaterThan(170);
    expect(() => resolveChallenge({ clock: { quarter: 1, secondsRemaining: 500, running: false, playClock: 40, playClockRunning: false } }, outcomeAt(50, {}), createRng(1))).toThrow();
  });

  it('accounting: upheld costs a challenge and a timeout, overturned only the challenge', () => {
    const s = { challenges: { home: 2, away: 2 }, timeouts: { home: 3, away: 3 } };
    applyChallengeAccounting(s, 'home', true);
    expect(s).toEqual({ challenges: { home: 1, away: 2 }, timeouts: { home: 2, away: 3 } });
    applyChallengeAccounting(s, 'home', false);
    expect(s).toEqual({ challenges: { home: 0, away: 2 }, timeouts: { home: 2, away: 3 } });
  });

  it('default AI challenges shaky, valuable rulings and not solid or trivial ones', () => {
    const setup = makeSetup();
    const shaky = reviewed(0.3);
    const s = situation(setup, { possession: 'home', ballOn: 50, down: 2, distance: 8, lastOutcome: shaky, clock: { quarter: 1, secondsRemaining: 500, running: false, playClock: 40, playClockRunning: false } });
    expect(shouldChallengeDefault(s, shaky, 'away')).toBe(true);
    const solid = reviewed(0.9);
    expect(shouldChallengeDefault({ ...s, lastOutcome: solid }, solid, 'away')).toBe(false);
    expect(shouldChallengeDefault(s, shaky, 'home')).toBe(false);
  });

  it('booth review kicks in inside two minutes for low-confidence calls', () => {
    const setup = makeSetup();
    const s = situation(setup, { clock: { quarter: 4, secondsRemaining: 90, running: false, playClock: 40, playClockRunning: false } });
    expect(boothReviews(s, reviewed(0.3))).toBe(true);
    expect(boothReviews(s, reviewed(0.8))).toBe(false);
    expect(boothReviews({ ...s, clock: { ...s.clock, secondsRemaining: 300 } }, reviewed(0.3))).toBe(false);
  });
});
