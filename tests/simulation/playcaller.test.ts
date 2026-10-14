import { describe, expect, it } from 'vitest';
import { createRng } from '@/core/rng';
import type { GameState } from '@/game/types';
import { createGameState } from '@/game/game-state';
import { createSimPlaycaller, defaultPlaycaller, fourthDownChoice, GAME_SCRIPT_ROUT, GAME_SCRIPT_SOFT, LEAGUE_PLAYCALLING_IQ } from '@/simulation/playcaller';
import { quickSetup } from '@/simulation/game-sim';
import { generateLeagueEntities } from '@/teams/league-generator';
import { makeCoach } from '../ai/shared/helpers';

const ENTITIES = generateLeagueEntities(77, { year: 2026, salaryCap: 250_000_000 });
const ABBRS = Object.values(ENTITIES.teams).map((t) => t.abbr).sort();
const setup = quickSetup(ENTITIES, ABBRS[2] as string, ABBRS[3] as string, { seed: 9 });
const at = (patch: Partial<GameState>): GameState => {
  const s = createGameState(setup);
  Object.assign(s, { phase: 'playcall', ...patch });
  if (patch.clock) s.clock = { ...createGameState(setup).clock, ...patch.clock };
  return s;
};
const defPlays = setup.away.defensePlays;
const clock = (quarter: number, secondsRemaining: number, running = true) => ({ quarter, secondsRemaining, running, playClock: 40, playClockRunning: false });

describe('sim playcaller game management', () => {
  const plays = setup.home.offensePlays;

  it('kneels out a win and spikes to stop a running clock when trailing', () => {
    const kneel = defaultPlaycaller.offense(at({ possession: 'home', down: 1, distance: 10, ballOn: 40, score: { home: 20, away: 14 }, timeouts: { home: 1, away: 0 }, clock: clock(4, 70) }), plays, createRng(1));
    expect(kneel?.type).toBe('kneel');
    const spike = defaultPlaycaller.offense(at({ possession: 'home', down: 2, distance: 6, ballOn: 60, score: { home: 14, away: 17 }, timeouts: { home: 0, away: 2 }, clock: clock(4, 30) }), plays, createRng(1));
    expect(spike?.type).toBe('spike');
  });

  it('hurries only when the clock matters', () => {
    expect(defaultPlaycaller.hurryUp(at({ possession: 'home', score: { home: 10, away: 13 }, clock: clock(4, 110) }))).toBe(true);
    expect(defaultPlaycaller.hurryUp(at({ possession: 'home', score: { home: 17, away: 13 }, clock: clock(4, 110) }))).toBe(false);
    expect(defaultPlaycaller.hurryUp(at({ possession: 'home', score: { home: 17, away: 13 }, clock: clock(2, 90) }))).toBe(true);
  });

  it('fourth downs follow the coach: the aggressive one goes where the conservative one punts', () => {
    const s = at({ possession: 'home', down: 4, distance: 2, ballOn: 48, clock: clock(2, 500, false) });
    expect(fourthDownChoice(s, makeCoach({ traits: ['aggressive'] }))).toBe('go');
    expect(fourthDownChoice(s, makeCoach({ traits: ['conservative'] }))).toBe('punt');
    // League games are called at a fixed judgement, whatever the user's difficulty.
    const rookieGame = { ...s, difficulty: { ...s.difficulty, playcallingIq: 0.2 } };
    expect(fourthDownChoice(rookieGame)).toBe(fourthDownChoice(s));
    expect(LEAGUE_PLAYCALLING_IQ).toBeGreaterThan(0.5);
  });

  it('the staff leans the run/pass mix', () => {
    const air = createSimPlaycaller({ home: makeCoach({ offensiveScheme: 'airRaid' }) });
    const ground = createSimPlaycaller({ home: makeCoach({ offensiveScheme: 'groundAndPound' }) });
    const s = at({ possession: 'home', down: 1, distance: 10, ballOn: 35, clock: clock(1, 700) });
    const dropback = (c: typeof air): number => {
      let n = 0;
      for (let i = 0; i < 300; i++) { const p = c.offense(s, plays, createRng(i)); if (p && (p.type === 'pass' || p.type === 'playAction' || p.type === 'screen')) n++; }
      return n / 300;
    };
    expect(dropback(air)).toBeGreaterThan(dropback(ground) + 0.05);
    // A full staff: the offensive coordinator pulls a ground-and-pound head coach's mix toward his air raid.
    const head = makeCoach({ offensiveScheme: 'groundAndPound' });
    const withOc = createSimPlaycaller({ home: { headCoach: head, offensiveCoordinator: makeCoach({ offensiveScheme: 'airRaid' }) } });
    expect(dropback(withOc)).toBeGreaterThan(dropback(createSimPlaycaller({ home: head })) + 0.03);
  });

  it('the defensive staff leans the pressure: a blitz-minded coordinator brings more', () => {
    const s = at({ possession: 'home', down: 2, distance: 6, ballOn: 45, clock: clock(1, 700) });
    const blitzes = (c: ReturnType<typeof createSimPlaycaller>): number => {
      let n = 0;
      for (let i = 0; i < 400; i++) { const p = c.defense(s, defPlays, createRng(i), null); if (p && p.blitz !== 'none') n++; }
      return n / 400;
    };
    const head = makeCoach({ defensiveScheme: 'coverageFirst' });
    const neutral = blitzes(createSimPlaycaller());
    const cautious = blitzes(createSimPlaycaller({ away: head }));
    const pushed = blitzes(createSimPlaycaller({ away: { headCoach: head, defensiveCoordinator: makeCoach({ defensiveScheme: 'blitzHeavy', traits: ['aggressive'] }) } }));
    expect(cautious).toBeLessThan(neutral);
    expect(pushed).toBeGreaterThan(cautious + 0.02);
  });

  // Game script: a defense two scores up in the fourth quarter, or routing in the third, sits back (fewer blitzes);
  // nothing changes in a close game, before halftime or for the trailing side.
  it('a defense protecting a big second-half lead blitzes less; a close game or the first half is untouched', () => {
    const blitzShare = (quarter: number, awayLead: number): number => {
      const s = at({ possession: 'home', down: 2, distance: 6, ballOn: 45, score: { home: 10, away: 10 + awayLead }, clock: clock(quarter, 600) });
      let n = 0;
      for (let i = 0; i < 400; i++) { const p = defaultPlaycaller.defense(s, defPlays, createRng(i), null); if (p && p.blitz !== 'none') n++; }
      return n / 400;
    };
    const close = blitzShare(4, 3);
    expect(blitzShare(4, GAME_SCRIPT_SOFT)).toBeLessThan(close - 0.03);
    expect(blitzShare(3, GAME_SCRIPT_ROUT)).toBeLessThan(blitzShare(3, 3) - 0.03);
    expect(blitzShare(2, GAME_SCRIPT_ROUT)).toBe(blitzShare(2, 3));
    expect(blitzShare(3, GAME_SCRIPT_SOFT)).toBe(blitzShare(3, 3));
  });
});
