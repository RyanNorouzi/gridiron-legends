/**
 * End-to-end AI game-management scenarios: a GameController positioned at the situation, the shipped AI playcaller
 * (src/ui/game/playcaller-ai.ts, the live game's) and the league sim playcaller (src/simulation/playcaller.ts) making
 * the calls, and the fast sim resolving the snaps. Kneel-outs, the two-minute drill, the fourth-down chart, onside
 * kicks, prevent, adaptation to the user's tendencies and the pre-snap disguise.
 */
import { describe, expect, it } from 'vitest';
import { disguisePlan } from '@/ai/disguise';
import { formationClass, isPrevent, isRunStop } from '@/ai/playcalling-defense';
import { isRunPlay } from '@/ai/playcalling-offense';
import { defensivePlayById, formationPersonnel, offensivePlayById } from '@/ai/scouting';
import { registerAll } from '@/ai/register';
import { createRng } from '@/core/rng';
import { GameController } from '@/game/game-controller';
import { emptyOutcome } from '@/game/outcome-factory';
import { getDifficulty } from '@/game/rulesets';
import type { DifficultyId, GameSetup, GameState, PlayLogEntry, TeamSide } from '@/game/types';
import { isSpecialPlay } from '@/playbook/special-teams';
import type { OffensivePlay } from '@/playbook/types';
import { playbookRegistries, quickSetup, simulateToEnd } from '@/simulation/game-sim';
import { defaultPlaycaller, type Playcaller } from '@/simulation/playcaller';
import { generateLeagueEntities } from '@/teams/league-generator';
import { createAiPlaycaller } from '@/ui/game/playcaller-ai';
import { build } from '../game/engine/helpers';
import { situation } from '../game/fixtures';

registerAll();

const ENTITIES = generateLeagueEntities(77, { year: 2026, salaryCap: 250_000_000 });
const ABBRS = Object.values(ENTITIES.teams).map((t) => t.abbr).sort();
const REG = playbookRegistries();

/** Real league teams and playbooks, neutral coaches, the given difficulty. */
const setupFor = (seed: number, difficulty: DifficultyId = 'pro'): GameSetup => {
  const s = quickSetup(ENTITIES, ABBRS[4] as string, ABBRS[5] as string, { seed });
  return { ...s, home: { ...s.home, headCoach: null }, away: { ...s.away, headCoach: null }, difficulty: getDifficulty(difficulty) };
};

const clock = (quarter: number, secondsRemaining: number, running = true) => ({ quarter, secondsRemaining, running, playClock: 40, playClockRunning: false });
const LATE = { twoMinuteWarningGiven: { half1: true, half2: true } };

/** The shipped live-game AI caller behind the sim's Playcaller seam. */
const shipped = createAiPlaycaller();
const liveAi: Playcaller = {
  offense: (s, plays, rng) => shipped.callOffense(s, plays, rng, null),
  defense: (s, plays, rng, off) => shipped.callDefense(s, plays, rng, null, off),
  hurryUp: defaultPlaycaller.hurryUp,
};
const CALLERS: readonly [string, Playcaller][] = [['live AI', liveAi], ['sim', defaultPlaycaller]];

/** Plays the game out from `patch` and returns the play log from that point. */
const playOut = (seed: number, patch: Partial<GameState>, caller: Playcaller, difficulty: DifficultyId = 'pro'): PlayLogEntry[] => {
  const setup = setupFor(seed, difficulty);
  const c = new GameController(setup, { state: situation(setup, { ...LATE, ...patch }), registries: REG });
  const log: PlayLogEntry[] = [];
  simulateToEnd(c, { playcaller: caller, maxPlays: 200, onPlay: (e) => log.push(e) });
  return log;
};

const offenseCall = (seed: number, patch: Partial<GameState>, caller: Playcaller, difficulty: DifficultyId = 'legend'): OffensivePlay | null => {
  const setup = setupFor(seed, difficulty);
  const s = situation(setup, { ...LATE, ...patch });
  return caller.offense(s, setup[s.possession].offensePlays, createRng(`call:${seed}`));
};

describe('late-game clock', () => {
  it('a leading offense kneels only when the kneels run the clock out: it never hands the ball back after a kneel', () => {
    let kneelSeries = 0;
    for (const [name, caller] of CALLERS) {
      for (const secs of [45, 70, 95]) for (const down of [1, 3]) for (const oppTimeouts of [0, 2]) for (let seed = 1; seed <= 4; seed++) {
        const log = playOut(seed, { possession: 'home', down, distance: 10, ballOn: 40, score: { home: 20, away: 17 }, timeouts: { home: 3, away: oppTimeouts }, clock: clock(4, secs) }, caller);
        const first = log.findIndex((e) => e.possession === 'home' && e.outcome.result === 'kneel');
        if (first < 0) continue;
        kneelSeries++;
        const after = log.slice(first + 1).filter((e) => e.possession === 'away');
        expect(after.length, `${name} ${secs}s down ${down} opp TO ${oppTimeouts} seed ${seed}: ${log.map((e) => `${e.possession}:${e.down}:${e.outcome.result}@${e.clock.toFixed(0)}`).join(' ')}`).toBe(0);
      }
    }
    // The scenarios really exercised the kneel-out (short clocks, no timeouts left to stop it).
    expect(kneelSeries).toBeGreaterThan(20);
  }, 60_000);

  it('runs the two-minute drill when trailing: no huddle, few runs, no kneels', () => {
    for (const [name, caller] of CALLERS) {
      let snaps = 0;
      let runs = 0;
      let runoff = 0;
      let runningSnaps = 0;
      for (let seed = 1; seed <= 6; seed++) {
        const log = playOut(seed, { possession: 'home', down: 1, distance: 10, ballOn: 25, score: { home: 13, away: 17 }, timeouts: { home: 2, away: 3 }, clock: clock(4, 105) }, caller);
        const end = log.findIndex((e) => e.possession !== 'home');
        for (const e of end < 0 ? log : log.slice(0, end)) {
          expect(e.outcome.result, `${name} seed ${seed}`).not.toBe('kneel');
          if (e.outcome.result === 'spike' || e.outcome.result === 'penalty' || e.outcome.result === 'fieldGoal') continue;
          snaps++;
          const play = offensivePlayById(e.offensivePlayId);
          if (play && isRunPlay(play)) runs++;
          if (e.outcome.presnapElapsed > 0) { runoff += e.outcome.presnapElapsed; runningSnaps++; }
        }
      }
      expect(snaps, name).toBeGreaterThan(12);
      expect(runs / snaps, `${name} run share`).toBeLessThan(0.2);
      // No-huddle tempo: a few seconds between the whistle and the snap instead of the huddle's 15-25.
      if (runningSnaps > 0) expect(runoff / runningSnaps, `${name} runoff`).toBeLessThan(10);
    }
  }, 60_000);
});

describe('fourth downs, tries and kickoffs', () => {
  const kind = (p: OffensivePlay | null): string => (p ? (isSpecialPlay(p) === 'none' ? 'go' : isSpecialPlay(p)) : 'none');
  const fourth = (ballOn: number, distance: number, extra: Partial<GameState> = {}): Partial<GameState> =>
    ({ possession: 'home', down: 4, distance, ballOn, score: { home: 10, away: 10 }, clock: clock(2, 500, false), ...extra });

  it('follows the expected-points chart: punt deep in its own end, kick in range, go on short yardage past midfield', () => {
    for (const [name, caller] of CALLERS) {
      expect(kind(offenseCall(1, fourth(25, 9), caller)), `${name} 4th & 9 own 25`).toBe('punt');
      expect(kind(offenseCall(1, fourth(78, 7), caller)), `${name} 4th & 7 opp 22`).toBe('fieldGoal');
      expect(kind(offenseCall(1, fourth(62, 1), caller)), `${name} 4th & 1 opp 38`).toBe('go');
      // Down two scores late: going for it beats punting the game away.
      expect(kind(offenseCall(1, fourth(40, 6, { score: { home: 10, away: 20 }, clock: clock(4, 150) }), caller)), `${name} desperation`).toBe('go');
    }
  });

  it('onside kicks when trailing late and kicks deep otherwise; goes for two on the chart', () => {
    for (const [name, caller] of CALLERS) {
      const kickoff = (home: number, away: number, secs: number): string =>
        kind(offenseCall(2, { possession: 'home', kickoffPending: 'home', score: { home, away }, timeouts: { home: 1, away: 3 }, clock: clock(4, secs, false) }, caller));
      expect(kickoff(20, 28, 90), `${name} down 8, 1:30, one timeout`).toBe('onside');
      expect(kickoff(20, 34, 240), `${name} down 14, 4:00`).toBe('onside');
      expect(kickoff(28, 20, 90), `${name} up 8`).toBe('kickoff');
      expect(kickoff(20, 28, 700), `${name} down 8, early`).toBe('kickoff');
      const pat = (home: number, away: number): string => kind(offenseCall(3, { possession: 'home', patPending: 'home', score: { home, away }, clock: clock(4, 200, false) }, caller));
      expect(pat(15, 17), `${name} down 2 after the six`).toBe('twoPoint');
      expect(pat(17, 14), `${name} up 3 after the six`).toBe('extraPoint');
    }
  });
});

describe('defensive situations', () => {
  const defenseShare = (patch: Partial<GameState>, pred: (id: string) => boolean, difficulty: DifficultyId = 'pro', n = 120, formationOf?: OffensivePlay): number => {
    let hits = 0;
    for (let i = 0; i < n; i++) {
      const setup = setupFor(1, difficulty);
      const s = situation(setup, { ...LATE, ...patch });
      const def: TeamSide = s.possession === 'home' ? 'away' : 'home';
      const off = formationOf ?? (setup[s.possession].offensePlays.find((p) => p.type === 'pass') as OffensivePlay);
      if (pred(shipped.callDefense(s, setup[def].defensePlays, createRng(`d${i}`), null, off).id)) hits++;
    }
    return hits / n;
  };
  const isPreventId = (id: string): boolean => {
    const p = defensivePlayById(id);
    return p !== undefined && isPrevent(p);
  };

  it('plays prevent protecting a late lead, never early or when trailing', () => {
    const late = defenseShare({ possession: 'home', down: 1, distance: 10, ballOn: 30, score: { home: 14, away: 20 }, clock: clock(4, 50) }, isPreventId);
    const early = defenseShare({ possession: 'home', down: 1, distance: 10, ballOn: 30, score: { home: 14, away: 20 }, clock: clock(2, 400) }, isPreventId);
    const trailing = defenseShare({ possession: 'home', down: 1, distance: 10, ballOn: 30, score: { home: 20, away: 14 }, clock: clock(4, 50) }, isPreventId);
    expect(late).toBeGreaterThan(0.35);
    expect(early).toBeLessThan(0.05);
    expect(trailing).toBeLessThan(0.05);
  });

  it('adapts to what the user has been running, legend far more than rookie', () => {
    const setup = setupFor(1);
    const plays = setup.home.offensePlays;
    const spread = plays.find((p) => p.type === 'pass' && ['10', '11'].includes(formationPersonnel(p.formation) ?? '') && plays.filter((q) => q.formation === p.formation && q.type === 'pass').length >= 2) as OffensivePlay;
    expect(spread).toBeDefined();
    const log: PlayLogEntry[] = [];
    for (let i = 0; i < 12; i++) {
      log.push({ index: i, quarter: 1, clock: 800 - 30 * i, possession: 'home', down: 1, distance: 10, ballOn: 35, ballX: 26.67, offensivePlayId: spread.id, defensivePlayId: null,
        outcome: emptyOutcome({ result: 'pass', yards: 12 }, 'home'), scoreAfter: { home: 0, away: 0 }, review: null });
    }
    const sub = (id: string): boolean => {
      const p = defensivePlayById(id);
      return p !== undefined && !isRunStop(p) && (formationClass(p.formation) === 'nickel' || formationClass(p.formation) === 'dime');
    };
    const at = { possession: 'home' as const, down: 1, distance: 10, ballOn: 35, playLog: log, clock: clock(2, 600) };
    const legend = defenseShare(at, sub, 'legend', 200, spread);
    const rookie = defenseShare(at, sub, 'rookie', 200, spread);
    expect(legend).toBeGreaterThan(rookie + 0.1);
    // With no report (first snap) the legend has nothing to adapt to.
    const blind = defenseShare({ ...at, playLog: [] }, sub, 'legend', 200, spread);
    expect(legend).toBeGreaterThan(blind + 0.05);
  });

  it('an AI defense disguises its shell against a human quarterback too, more at legend', () => {
    const share = (difficulty: DifficultyId): number => {
      let n = 0;
      for (let seed = 1; seed <= 40; seed++) {
        const { engine } = build({ offensePlayId: 'shotgun-mesh', defensePlayId: '43-cover2-zone', seed, ballOn: 35, difficulty, offense: 'home', userSide: 'home', controlRole: 'QB' });
        if (disguisePlan(engine.state).disguised) n++;
      }
      return n / 40;
    };
    const legend = share('legend');
    expect(legend).toBeGreaterThan(0.35);
    expect(legend).toBeGreaterThan(share('rookie') + 0.2);
  });
});
