/**
 * The franchise's real league simulator calls every game with both clubs' staffs (head coach + coordinators from the
 * GameSetup) instead of the neutral league playcaller, so coaching tendencies show up in league results.
 */
import { describe, expect, it } from 'vitest';
import { createRng } from '@/core/rng';
import { createGameState } from '@/game/game-state';
import type { GameSetup, GameState } from '@/game/types';
import { createRealGameSimulator, staffPlaycaller } from '@/franchise/sim-real';
import { defaultPlaycaller } from '@/simulation/playcaller';
import { playbookRegistries, quickSetup, simulateGame } from '@/simulation/game-sim';
import { generateLeagueEntities } from '@/teams/league-generator';
import { makeCoach } from '../../ai/shared/helpers';

const ENTITIES = generateLeagueEntities(31, { year: 2026, salaryCap: 250_000_000 });
const ABBRS = Object.values(ENTITIES.teams).map((t) => t.abbr).sort();
const base = quickSetup(ENTITIES, ABBRS[0] as string, ABBRS[1] as string, { seed: 17 });
const staffed = (scheme: 'airRaid' | 'groundAndPound'): GameSetup => ({
  ...base,
  home: { ...base.home, headCoach: makeCoach({ offensiveScheme: scheme }), offensiveCoordinator: makeCoach({ offensiveScheme: scheme }) },
});

const firstAndTen = (setup: GameSetup): GameState => {
  const s = createGameState(setup);
  Object.assign(s, { phase: 'playcall', possession: 'home', down: 1, distance: 10, ballOn: 35 });
  s.clock = { ...s.clock, quarter: 1, secondsRemaining: 700 };
  return s;
};

describe('real league simulator and the coaching staff', () => {
  it('the staff playcaller leans the calls: an air-raid staff drops back more than a ground-and-pound one', () => {
    const dropbacks = (setup: GameSetup): number => {
      const caller = staffPlaycaller(setup);
      const s = firstAndTen(setup);
      let n = 0;
      for (let i = 0; i < 400; i++) {
        const p = caller.offense(s, setup.home.offensePlays, createRng(i));
        if (p && (p.type === 'pass' || p.type === 'playAction' || p.type === 'screen')) n++;
      }
      return n / 400;
    };
    expect(dropbacks(staffed('airRaid'))).toBeGreaterThan(dropbacks(staffed('groundAndPound')) + 0.05);
  });

  it('plays every league game with that staff playcaller (not the neutral one) unless one is injected', () => {
    const registries = playbookRegistries();
    const setup = staffed('airRaid');
    const ids = (log: readonly { offensivePlayId: string | null }[] | undefined): string => (log ?? []).map((e) => e.offensivePlayId ?? '-').join(',');
    const real = createRealGameSimulator()(setup, { keepPlayLog: true });
    const withStaff = simulateGame(setup, { registries, playcaller: staffPlaycaller(setup) });
    const neutral = simulateGame(setup, { registries, playcaller: defaultPlaycaller });
    expect(ids(real.playLog)).toBe(ids(withStaff.state.playLog));
    expect(ids(real.playLog)).not.toBe(ids(neutral.state.playLog));
    const injected = createRealGameSimulator({ playcaller: defaultPlaycaller })(setup, { keepPlayLog: true });
    expect(ids(injected.playLog)).toBe(ids(neutral.state.playLog));
    // A partial playcaller replaces only what it defines: the staffs still call the plays.
    const partial = createRealGameSimulator({ playcaller: { hurryUp: defaultPlaycaller.hurryUp } })(setup, { keepPlayLog: true });
    expect(ids(partial.playLog)).toBe(ids(real.playLog));
  });
});
