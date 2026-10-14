import { describe, expect, it } from 'vitest';
import { createRng } from '@/core/rng';
import { getDifficulty } from '@/game/rulesets';
import { loadPlaybookData } from '@/playbook/loader';
import { pickWeighted, type PlaySituation } from '@/playbook/playbooks';
import type { DefensivePlay } from '@/playbook/types';
import { callDefense, callDefensivePlay, formationClass, isBlitz, isPrevent, weighDefensivePlays, type DefensiveCallArgs } from '@/ai/playcalling-defense';
import { makeCoach, share } from './helpers';

const plays: DefensivePlay[] = Object.values(loadPlaybookData().defensePlays);
const allPro = getDifficulty('allPro');

const sit = (o: Partial<PlaySituation> = {}): PlaySituation => ({ down: 1, distance: 10, ballOn: 30, clock: 600, scoreDiff: 0, ...o });
const call = (args: Partial<DefensiveCallArgs>, seed: number): DefensivePlay =>
  callDefensivePlay({ plays, situation: sit(), coach: null, difficulty: allPro, rng: createRng(seed), ...args });

const N = 250;

describe('callDefensivePlay', () => {
  it('picks prevent late when ahead, never when behind', () => {
    const ahead = share(N, (i) => call({ situation: sit({ clock: 90, scoreDiff: -6 }), quarter: 4 }, i), isPrevent);
    expect(ahead).toBeGreaterThan(0.35);
    const behind = share(N, (i) => call({ situation: sit({ clock: 90, scoreDiff: 6 }), quarter: 4 }, i), isPrevent);
    expect(behind).toBeLessThan(0.02);
    const early = share(N, (i) => call({ situation: sit({ clock: 900, scoreDiff: -6 }), quarter: 1 }, i), isPrevent);
    expect(early).toBeLessThan(0.02);
  });

  it('blitzes on 3rd & short far more than on 1st & 10, and more still when chasing late', () => {
    const shortBlitz = share(N, (i) => call({ situation: sit({ down: 3, distance: 1 }) }, i), isBlitz);
    const baseBlitz = share(N, (i) => call({ situation: sit({ down: 1, distance: 10 }) }, i), isBlitz);
    expect(shortBlitz).toBeGreaterThan(0.5);
    expect(shortBlitz).toBeGreaterThan(baseBlitz + 0.2);
    const chasing = share(N, (i) => call({ situation: sit({ down: 2, distance: 6, clock: 200, scoreDiff: 7 }), quarter: 4 }, i), isBlitz);
    expect(chasing).toBeGreaterThan(baseBlitz);
  });

  it('long yardage brings two-high shells and goal line brings the goal-line package', () => {
    const twoHigh = (p: DefensivePlay): boolean => p.coverage === 'cover2' || p.coverage === 'cover4' || p.coverage === 'cover6';
    expect(share(N, (i) => call({ situation: sit({ down: 2, distance: 12 }) }, i), twoHigh)).toBeGreaterThan(share(N, (i) => call({ situation: sit({ down: 2, distance: 2 }) }, i), twoHigh) + 0.2);
    const goal = share(N, (i) => call({ situation: sit({ down: 1, distance: 3, ballOn: 97 }) }, i), (p) => formationClass(p.formation) === 'goalLine');
    expect(goal).toBeGreaterThan(0.5);
    expect(share(N, (i) => call({ situation: sit({ ballOn: 30 }) }, i), (p) => formationClass(p.formation) === 'goalLine')).toBeLessThan(0.02);
  });

  it('scheme, personnel and tendencies shift the call', () => {
    const heavy = makeCoach({ defensiveScheme: 'blitzHeavy' });
    const cover = makeCoach({ defensiveScheme: 'coverageFirst' });
    const neutral = sit({ down: 2, distance: 6 });
    const heavyBlitz = share(N, (i) => call({ coach: heavy, situation: neutral }, i), isBlitz);
    const coverBlitz = share(N, (i) => call({ coach: cover, situation: neutral }, i), isBlitz);
    expect(heavyBlitz).toBeGreaterThan(coverBlitz + 0.15);
    expect(heavyBlitz).toBeGreaterThan(0.3);
    const dimeVsSpread = share(N, (i) => call({ offenseFormationPersonnel: '10', offenseTendencies: { passRate: 0.8 } }, i), (p) => formationClass(p.formation) === 'dime' || formationClass(p.formation) === 'nickel');
    const dimeVsHeavy = share(N, (i) => call({ offenseFormationPersonnel: '22', offenseTendencies: { passRate: 0.3 } }, i), (p) => formationClass(p.formation) === 'dime' || formationClass(p.formation) === 'nickel');
    expect(dimeVsSpread).toBeGreaterThan(dimeVsHeavy + 0.2);
  });

  it('never calls a return unit and draws exactly one die (the disguise is the live defense\'s hash, not a roll)', () => {
    for (let i = 0; i < 60; i++) {
      const args: DefensiveCallArgs = { plays, situation: sit(), coach: makeCoach({ defense: 90 }), difficulty: getDifficulty('legend'), rng: createRng(i) };
      const c = callDefense(args);
      expect(c.play.tags.some((t) => t === 'kickReturn' || t === 'puntReturn' || t === 'fgBlock')).toBe(false);
      expect(Object.keys(c)).toEqual(['play']);
      // Same stream as one weighted pick: nothing else was drawn, so the next number matches.
      const ref = createRng(i);
      expect(pickWeighted(weighDefensivePlays({ ...args, rng: ref }), ref)).toBe(c.play);
      expect(args.rng.next()).toBe(ref.next());
    }
    expect(() => callDefense({ plays: [], situation: sit(), coach: null, difficulty: allPro, rng: createRng(1) })).toThrow(/empty/);
  });
});
