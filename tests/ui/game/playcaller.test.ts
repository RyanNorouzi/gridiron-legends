import { describe, expect, it } from 'vitest';
import { createRng } from '@/core/rng';
import { getDifficulty } from '@/game/rulesets';
import type { GameState } from '@/game/types';
import { resolvePlaybook } from '@/playbook/loader';
import type { WeightedPlay } from '@/playbook/playbooks';
import type { Coach } from '@/teams/types';
import { coachHooksFor, createDefaultPlaycaller, fourthDownChoice, gameSecondsLeft, goForTwo, kickoffChoice, sharpen, situationFor } from '@/ui/game/playcaller';
import { makeSetup, situation } from '../../game/fixtures';

const at = (patch: Partial<GameState>, seed = 1): GameState => situation(makeSetup({ seed }), patch);
const clock = (quarter: number, secondsRemaining: number, running = false): GameState['clock'] => ({ quarter, secondsRemaining, running, playClock: 40, playClockRunning: false });
const aggressive: Coach = {
  id: 'c1' as Coach['id'], firstName: 'A', lastName: 'B', role: 'HC', age: 50, ratings: { offense: 70, defense: 70, playerDevelopment: 70, motivation: 70, gameManagement: 70, scouting: 70, conditioning: 70 },
  traits: ['aggressive'], teamId: null, salary: 0, contractYears: 1, offensiveScheme: 'airRaid', defensiveScheme: 'blitzHeavy', careerWins: 0, careerLosses: 0, championships: 0,
};

describe('situation and clock helpers', () => {
  it('computes half and game clocks and situation kinds', () => {
    const s = at({ clock: clock(1, 300) });
    expect(gameSecondsLeft(s)).toBe(300 + 3 * s.ruleset.quarterLengthSec);
    expect(situationFor(s).clock).toBe(300 + s.ruleset.quarterLengthSec);
    expect(situationFor(at({ kickoffPending: 'home' })).kind).toBe('kickoff');
    expect(situationFor(at({ patPending: 'home' })).kind).toBe('pat');
    expect(situationFor(at({ possession: 'away', score: { home: 10, away: 3 } })).scoreDiff).toBe(-7);
  });
});

describe('fourth down, kickoff and two-point decisions', () => {
  it('kicks in range, punts deep, goes on short yardage in plus territory and when desperate', () => {
    expect(fourthDownChoice(at({ down: 4, distance: 5, ballOn: 70 }), null)).toBe('fieldGoal');
    expect(fourthDownChoice(at({ down: 4, distance: 8, ballOn: 20 }), null)).toBe('punt');
    expect(fourthDownChoice(at({ down: 4, distance: 1, ballOn: 55 }), null)).toBe('go');
    const desperate = at({ down: 4, distance: 6, ballOn: 40, clock: clock(4, 90), score: { home: 10, away: 17 } });
    expect(fourthDownChoice(desperate, null)).toBe('go');
    const tieable = at({ down: 4, distance: 6, ballOn: 70, clock: clock(4, 90), score: { home: 14, away: 17 } });
    expect(fourthDownChoice(tieable, null)).toBe('fieldGoal');
    expect(fourthDownChoice(at({ down: 4, distance: 3, ballOn: 58 }), aggressive)).toBe('go');
    expect(fourthDownChoice(at({ down: 4, distance: 3, ballOn: 58 }), null)).toBe('punt');
  });

  it('onside when trailing late, squib protecting a lead at the end of a half, else deep', () => {
    expect(kickoffChoice(at({ kickoffPending: 'home', clock: clock(4, 120), score: { home: 14, away: 17 } }), null)).toBe('onside');
    expect(kickoffChoice(at({ kickoffPending: 'home', clock: clock(2, 20), score: { home: 21, away: 7 } }), null)).toBe('squib');
    expect(kickoffChoice(at({ kickoffPending: 'home', clock: clock(1, 600) }), null)).toBe('kickoff');
    expect(kickoffChoice(at({ kickoffPending: 'home', clock: clock(4, 500), score: { home: 0, away: 21 } }), aggressive)).toBe('onside');
  });

  it('follows the two-point chart late and stays conservative early', () => {
    expect(goForTwo(at({ patPending: 'home', clock: clock(4, 300), score: { home: 15, away: 17 } }), null)).toBe(true);
    expect(goForTwo(at({ patPending: 'home', clock: clock(4, 300), score: { home: 13, away: 17 } }), null)).toBe(false);
    expect(goForTwo(at({ patPending: 'home', clock: clock(1, 300), score: { home: 15, away: 17 } }), null)).toBe(false);
    expect(goForTwo(at({ patPending: 'home', clock: clock(1, 300), score: { home: 15, away: 17 } }), aggressive)).toBe(true);
  });
});

describe('difficulty sharpening', () => {
  it('rookie keeps the spread, legend concentrates on the best-weighted plays', () => {
    const weighted: WeightedPlay<string>[] = [{ play: 'best', weight: 4 }, { play: 'ok', weight: 2 }, { play: 'poor', weight: 1 }];
    const flat = sharpen(weighted, 0);
    expect(flat[1]!.weight / flat[0]!.weight).toBeCloseTo(0.5);
    const sharp = sharpen(weighted, 1);
    expect(sharp[1]!.weight / sharp[0]!.weight).toBeCloseTo(0.5 ** 4);
    expect(sharpen([], 1)).toEqual([]);
  });

  it('higher difficulties concentrate the AI on the best situational plays on 3rd & long', () => {
    const pc = createDefaultPlaycaller();
    const plays = resolvePlaybook('balanced').offense;
    const topShare = (difficulty: 'rookie' | 'pro' | 'allPro' | 'legend'): number => {
      const state = at({ down: 3, distance: 12, ballOn: 40, difficulty: getDifficulty(difficulty) });
      const counts = new Map<string, number>();
      const n = 300;
      for (let i = 0; i < n; i++) {
        const p = pc.callOffense(state, plays, createRng(i), null);
        counts.set(p.id, (counts.get(p.id) ?? 0) + 1);
      }
      return [...counts.values()].sort((a, b) => b - a).slice(0, 3).reduce((s, c) => s + c, 0) / n;
    };
    const shares = (['rookie', 'pro', 'allPro', 'legend'] as const).map(topShare);
    for (let i = 1; i < shares.length; i++) expect(shares[i]).toBeGreaterThan(shares[i - 1] as number);
    expect(shares[3]).toBeGreaterThan((shares[0] as number) + 0.15);
  });
});

describe('default playcaller calls', () => {
  const pc = createDefaultPlaycaller();
  const setup = makeSetup();
  const offense = setup.home.offensePlays;
  const defense = setup.home.defensePlays;

  it('kicks off, tries the extra point, punts or kicks on fourth down and otherwise picks a scrimmage play', () => {
    const rng = createRng(3);
    expect(pc.callOffense(at({ kickoffPending: 'home' }), offense, rng, null).concept).toBe('kickoff');
    expect(pc.callOffense(at({ kickoffPending: 'home', clock: clock(4, 60), score: { home: 0, away: 7 } }), offense, rng, null).concept).toBe('onside');
    expect(pc.callOffense(at({ patPending: 'home' }), offense, rng, null).concept).toBe('extraPoint');
    expect(pc.callOffense(at({ down: 4, distance: 9, ballOn: 30 }), offense, rng, null).concept).toBe('punt');
    expect(pc.callOffense(at({ down: 4, distance: 9, ballOn: 75 }), offense, rng, null).concept).toBe('fieldGoal');
    const regular = pc.callOffense(at({ down: 1, distance: 10, ballOn: 30 }), offense, rng, null);
    expect(['insideRun', 'curl', 'go']).toContain(regular.concept);
    // 30 s, clock stopped: the kneels (1 s each) and three victory-formation runoffs run it out once the defense is out of timeouts.
    const kneel = pc.callOffense(at({ down: 1, distance: 10, ballOn: 30, clock: clock(4, 30), score: { home: 21, away: 17 }, timeouts: { home: 3, away: 0 } }), offense, rng, null);
    expect(kneel.concept).toBe('kneel');
    // With three timeouts left the defense stops the clock after each kneel: kneeling out would hand the ball back.
    const handBack = at({ down: 1, distance: 10, ballOn: 30, clock: clock(4, 30), score: { home: 21, away: 17 }, timeouts: { home: 3, away: 3 } });
    expect(pc.callOffense(handBack, offense, rng, null).concept).not.toBe('kneel');
    expect(pc.suggestOffense(handBack, offense, rng)?.concept).not.toBe('kneel');
  });

  it('stars the kneel when kneeling runs it out, and never a third-down spike with timeouts in hand (H2-17)', () => {
    const rng = createRng(3);
    // Q4 1:25 running, up 3, opponent out of timeouts, 1st & 10 at the own 40 (the arcade play clock burns 24 s a kneel).
    const arcade = { ...at({}).ruleset, playClockSec: 25, huddleRunoffSec: 15 };
    const kneelOut = { ...at({ down: 1, distance: 10, ballOn: 40, clock: clock(4, 85, true), score: { home: 20, away: 17 }, timeouts: { home: 3, away: 0 } }), ruleset: arcade };
    expect(pc.suggestOffense(kneelOut, offense, rng)?.concept).toBe('kneel');
    const thirdAndLong = at({ down: 3, distance: 14, ballOn: 50, clock: clock(4, 59, true), score: { home: 13, away: 20 }, timeouts: { home: 3, away: 3 } });
    expect(pc.suggestOffense(thirdAndLong, offense, rng)?.type).not.toBe('spike');
    expect(pc.callOffense(thirdAndLong, offense, rng, null).type).not.toBe('spike');
  });

  it('answers kicks with the return unit and scrimmage plays with a coverage', () => {
    const rng = createRng(4);
    const punt = offense.find((p) => p.concept === 'punt')!;
    const kick = offense.find((p) => p.concept === 'kickoff')!;
    expect(pc.callDefense(at({}), defense, rng, null, punt).tags).toContain('puntReturn');
    expect(pc.callDefense(at({}), defense, rng, null, kick).tags).toContain('kickReturn');
    const regular = pc.callDefense(at({}), defense, rng, null, offense[1]!);
    expect(['cover3', 'man-blitz']).toContain(regular.id);
    const blitzy = new Set<string>();
    for (let i = 0; i < 40; i++) blitzy.add(pc.callDefense(at({ down: 3, distance: 3 }), defense, createRng(i), aggressive, offense[1]!).id);
    expect(blitzy.has('man-blitz')).toBe(true);
  });

  it('offers the right special options and suggestions', () => {
    const fourth = pc.specialOptions(at({ down: 4, distance: 2, ballOn: 70 }), offense).map((o) => o.id);
    expect(fourth).toEqual(expect.arrayContaining(['punt', 'fieldGoal', 'go']));
    expect(pc.specialOptions(at({ kickoffPending: 'home' }), offense).map((o) => o.id)).toEqual(expect.arrayContaining(['kickoff', 'onside']));
    expect(pc.specialOptions(at({ patPending: 'home' }), offense).map((o) => o.id)).toContain('extraPoint');
    const late = pc.specialOptions(at({ down: 1, distance: 10, ballOn: 40, clock: clock(4, 50), score: { home: 20, away: 17 } }), offense).map((o) => o.id);
    expect(late).toContain('kneel');
    const kneelDetail = (away: number) => pc.specialOptions(at({ down: 1, distance: 10, ballOn: 40, clock: clock(4, 40), score: { home: 20, away: 17 }, timeouts: { home: 3, away } }), offense).find((o) => o.id === 'kneel')?.detail;
    expect(kneelDetail(0)).toBe('Run out the clock');
    expect(kneelDetail(3)).toMatch(/get it back/);
    const spike = pc.specialOptions(at({ down: 1, distance: 10, ballOn: 40, clock: clock(4, 50, true), score: { home: 17, away: 20 } }), offense).map((o) => o.id);
    expect(spike).toContain('spike');
    expect(pc.specialOptions(at({ down: 1 }), offense)).toEqual([]);
    const fgAt = (ballOn: number) => pc.specialOptions(at({ down: 4, distance: 6, ballOn }), offense).find((o) => o.id === 'fieldGoal');
    expect(fgAt(66.6343868645202)?.detail).toBe('50 yards');
    expect(fgAt(7.6343868645202)).toBeUndefined();
    expect(pc.suggestOffense(at({ down: 2, distance: 5 }), offense, createRng(1))).not.toBeNull();
    expect(pc.suggestOffense(at({ kickoffPending: 'home' }), offense, createRng(1))).toBeNull();
    expect(pc.suggestDefense(at({}), defense, createRng(1))).not.toBeNull();
  });

  it('coach hooks route the controller fallbacks through the playcaller', () => {
    const hooks = coachHooksFor(pc, setup);
    expect(hooks.pickOffensivePlay(at({ down: 4, distance: 9, ballOn: 30 }), [...offense], createRng(1)).concept).toBe('punt');
    expect(['cover3', 'man-blitz']).toContain(hooks.pickDefensivePlay(at({}), defense.filter((p) => !p.tags.includes('kickReturn') && !p.tags.includes('puntReturn')), createRng(1)).id);
    expect(hooks.coinToss(at({}), 'home')).toBe('defer');
    const custom = coachHooksFor(pc, setup, () => ({ coinToss: () => 'receive' }));
    expect(custom.coinToss(at({}), 'away')).toBe('receive');
  });
});
