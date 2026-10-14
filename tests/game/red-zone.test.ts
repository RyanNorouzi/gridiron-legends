import { describe, expect, it } from 'vitest';
import { newDrive } from '@/game/game-state';
import { outcomeAt } from '@/game/outcome-factory';
import { applyOutcome, type ApplyOptions } from '@/game/rules';
import type { GameState } from '@/game/types';
import { makeSetup, situation } from './fixtures';

const RUN: ApplyOptions = { special: 'none', offensivePlayId: 'run-inside', defensivePlayId: null };

/** Home ball at `ballOn`, first and ten, a fresh drive that started at `driveStart`. */
const at = (ballOn: number, driveStart = ballOn): GameState => {
  const s = situation(makeSetup(), { possession: 'home', ballOn, down: 1, distance: 10, clock: { quarter: 1, secondsRemaining: 600, running: true, playClock: 40, playClockRunning: false } });
  s.drive = newDrive('home', driveStart, 1, 600);
  return s;
};
const rz = (s: GameState): [number, number] => [s.stats.teams.home.redZoneTouchdowns, s.stats.teams.home.redZoneTrips];

describe('red-zone trips are counted once per drive', () => {
  it('a drive that STARTS inside the 20 (e.g. after a turnover) and scores is 1 trip, 1 TD', () => {
    const s = at(85);
    applyOutcome(s, outcomeAt(85, { result: 'run', yards: 3 }), RUN);
    expect(rz(s)).toEqual([0, 1]);
    applyOutcome(s, outcomeAt(88, { result: 'run', touchdown: true }), RUN);
    expect(rz(s)).toEqual([1, 1]);
  });

  it('several snaps inside the 20 on one drive are still one trip', () => {
    const s = at(70);
    applyOutcome(s, outcomeAt(70, { result: 'run', yards: 12 }), RUN);
    expect(rz(s)).toEqual([0, 0]);
    applyOutcome(s, outcomeAt(82, { result: 'run', yards: 2 }), RUN);
    applyOutcome(s, outcomeAt(84, { result: 'run', yards: 1 }), RUN);
    expect(rz(s)).toEqual([0, 1]);
  });

  it('a long touchdown from outside the 20 is not a red-zone trip or a red-zone TD', () => {
    const s = at(60);
    applyOutcome(s, outcomeAt(60, { result: 'pass', touchdown: true }), RUN);
    expect(rz(s)).toEqual([0, 0]);
  });

  it('a drive that snapped in the red zone, got pushed back and then scored counts its TD', () => {
    const s = at(82, 50);
    applyOutcome(s, outcomeAt(82, { result: 'sack', yards: -9 }), RUN);
    applyOutcome(s, outcomeAt(73, { result: 'pass', touchdown: true }), RUN);
    expect(rz(s)).toEqual([1, 1]);
  });

  it('touchdowns never exceed trips across full simulated games', async () => {
    const { quickSetup, simulateGame } = await import('@/simulation/game-sim');
    const { generateLeagueEntities } = await import('@/teams/league-generator');
    const entities = generateLeagueEntities(7, { year: 2026, salaryCap: 250_000_000 });
    const abbrs = Object.values(entities.teams).map((t) => t.abbr);
    for (const seed of [11, 12, 13, 14]) {
      const { result } = simulateGame(quickSetup(entities, abbrs[0] as string, abbrs[1] as string, { seed }));
      for (const side of ['home', 'away'] as const) {
        const t = result.stats.teams[side];
        expect(t.redZoneTouchdowns).toBeLessThanOrEqual(t.redZoneTrips);
      }
    }
  }, 30_000); // four whole games: ~3.5 s alone, well past the 5 s default on a loaded host
});
