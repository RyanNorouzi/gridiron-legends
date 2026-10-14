import { describe, expect, it } from 'vitest';
import type { PlayerId } from '@/core/ids';
import { createRng } from '@/core/rng';
import { GameController } from '@/game/game-controller';
import { createGameState } from '@/game/game-state';
import type { GameSetup, GameState, PlayLogEntry } from '@/game/types';
import { generateLeagueEntities } from '@/teams/league-generator';
import { playbookRegistries, quickSetup, simulateGame, simulateGames, simulateToEnd } from '@/simulation/game-sim';
import { defaultPlaycaller, fourthDownChoice, shouldGoForTwo, shouldOnside } from '@/simulation/playcaller';

const ENTITIES = generateLeagueEntities(7, { year: 2026, salaryCap: 250_000_000 });
const ABBRS = Object.values(ENTITIES.teams).map((t) => t.abbr);

const checkConsistency = (state: GameState): void => {
  const lines = Object.values(state.stats.players);
  const sum = (f: (l: (typeof lines)[number]) => number): number => lines.reduce((s, l) => s + f(l), 0);
  expect(state.stats.teams.home.points).toBe(state.score.home);
  expect(state.stats.teams.away.points).toBe(state.score.away);
  expect(state.stats.teams.home.pointsAgainst).toBe(state.score.away);
  expect(sum((l) => l.passing.yards) - sum((l) => l.passing.sackYards)).toBe(state.stats.teams.home.passYards + state.stats.teams.away.passYards);
  expect(sum((l) => l.rushing.yards)).toBe(state.stats.teams.home.rushYards + state.stats.teams.away.rushYards);
  expect(sum((l) => l.passing.completions)).toBe(sum((l) => l.receiving.receptions));
  expect(sum((l) => l.passing.touchdowns)).toBe(sum((l) => l.receiving.touchdowns));
  let points = { home: 0, away: 0 };
  for (const e of state.playLog) if (e.outcome.scoringSide) points = { ...points, [e.outcome.scoringSide]: points[e.outcome.scoringSide] + e.outcome.points };
  expect(points).toEqual(state.score);
  // A converted two-point try is flagged as a touchdown but is itself the try, not a score that needs one.
  const tds = state.playLog.filter((e) => e.outcome.touchdown && e.outcome.points !== 2).length;
  const pats = state.playLog.filter((e) => e.outcome.result === 'extraPoint' || (e.outcome.result !== 'penalty' && e.outcome.result !== 'kickoff' && e.ballOn >= 97 && e.down === 1 && e.distance <= 3)).length;
  expect(pats).toBeGreaterThanOrEqual(tds - 2);
};

describe('simulateGame', () => {
  it('plays a full game in well under two seconds with plausible totals and consistent stats', () => {
    const setup = quickSetup(ENTITIES, ABBRS[0] as string, ABBRS[1] as string, { seed: 11 });
    const t0 = performance.now();
    const entries: PlayLogEntry[] = [];
    const { state, result } = simulateGame(setup, { onPlay: (e) => entries.push(e) });
    expect(performance.now() - t0).toBeLessThan(2000);
    expect(state.phase).toBe('final');
    // Regulation is held to the ceiling; an overtime period (up to 10 minutes) adds its own snaps on top.
    const regulation = state.playLog.filter((e) => e.quarter <= 4).length;
    expect(regulation).toBeGreaterThanOrEqual(100);
    expect(regulation).toBeLessThanOrEqual(180);
    expect(result.plays - regulation).toBeLessThanOrEqual(result.overtime ? 60 : 0);
    expect(entries.length).toBe(result.plays);
    expect(result.homeScore + result.awayScore).toBeGreaterThanOrEqual(3);
    expect(result.homeScore).toBeLessThanOrEqual(60);
    expect(result.awayScore).toBeLessThanOrEqual(60);
    expect(result.winner === null ? result.homeScore === result.awayScore : result.winner === (result.homeScore > result.awayScore ? 'home' : 'away')).toBe(true);
    checkConsistency(state);
    const results = new Set(state.playLog.map((e) => e.outcome.result));
    for (const r of ['kickoff', 'run', 'pass', 'incomplete', 'punt']) expect(results.has(r as never)).toBe(true);
    expect(state.stats.teams.home.drives + state.stats.teams.away.drives).toBeGreaterThan(10);
    expect(state.stats.teams.home.timeOfPossessionSec + state.stats.teams.away.timeOfPossessionSec).toBeGreaterThan(0);
  });

  it('is deterministic per seed and different seeds diverge', { timeout: 30_000 }, () => {
    const a = simulateGame(quickSetup(ENTITIES, ABBRS[2] as string, ABBRS[3] as string, { seed: 21 }));
    const b = simulateGame(quickSetup(ENTITIES, ABBRS[2] as string, ABBRS[3] as string, { seed: 21 }));
    expect(a.result).toEqual(b.result);
    expect(a.state.rngState).toEqual(b.state.rngState);
    expect(a.state.playLog.map((e) => e.outcome.yards)).toEqual(b.state.playLog.map((e) => e.outcome.yards));
    const c = simulateGame(quickSetup(ENTITIES, ABBRS[2] as string, ABBRS[3] as string, { seed: 22 }));
    expect(c.state.playLog.map((e) => e.outcome.yards)).not.toEqual(a.state.playLog.map((e) => e.outcome.yards));
  });

  it('a 20-game batch runs without exceptions, every game valid and consistent', { timeout: 60_000 }, () => {
    const setups: GameSetup[] = [];
    for (let i = 0; i < 20; i++) setups.push(quickSetup(ENTITIES, ABBRS[(i * 2) % ABBRS.length] as string, ABBRS[(i * 2 + 1) % ABBRS.length] as string, { seed: 1000 + i, week: 1 + (i % 17) }));
    const results = simulateGames(setups);
    expect(results).toHaveLength(20);
    let totalPoints = 0;
    for (const r of results) {
      expect(r.state.phase).toBe('final');
      // Regulation is held to the same ceiling; an overtime period (up to 10 minutes) adds its own snaps on top.
      const regulation = r.state.playLog.filter((e) => e.quarter <= 4).length;
      expect(regulation).toBeGreaterThanOrEqual(100);
      expect(regulation).toBeLessThanOrEqual(180);
      expect(r.result.plays - regulation).toBeLessThanOrEqual(r.result.overtime ? 60 : 0);
      expect(r.result.homeScore).toBeLessThanOrEqual(60);
      expect(r.result.awayScore).toBeLessThanOrEqual(60);
      expect(Math.max(r.result.homeScore, r.result.awayScore)).toBeGreaterThanOrEqual(3);
      checkConsistency(r.state);
      totalPoints += r.result.homeScore + r.result.awayScore;
      if (r.result.overtime) expect(r.state.overtimePeriods).toBeGreaterThan(0);
    }
    expect(totalPoints / 40).toBeGreaterThan(10);
    expect(totalPoints / 40).toBeLessThan(35);
  });

  it('simulateToEnd finishes a game that has a human side, answering its decisions like an AI coach', { timeout: 30_000 }, () => {
    const setup = quickSetup(ENTITIES, ABBRS[4] as string, ABBRS[5] as string, { seed: 31, userSide: 'home' });
    expect(setup.controllers.home).toBe('human');
    const c = new GameController(setup, { registries: playbookRegistries() });
    c.start();
    const { state, result } = simulateToEnd(c);
    expect(state.phase).toBe('final');
    expect(result.plays).toBeGreaterThan(80);
    expect(state.controllers.home).toBe('human');
  });

  it('reports each play once to onPlay, the corrected entry when a challenge overturns the call', { timeout: 30_000 }, () => {
    // Seed 39 (this league) has a call overturned on review: the controller re-applies the play from its snapshot.
    const entries: PlayLogEntry[] = [];
    const { state, result } = simulateGame(quickSetup(ENTITIES, ABBRS[3] as string, ABBRS[6] as string, { seed: 39 }), { onPlay: (e) => entries.push(e) });
    const overturned = state.playLog.filter((e) => e.review?.result === 'overturned');
    expect(overturned.length).toBeGreaterThan(0);
    expect(entries.length).toBe(result.plays);
    expect(entries.map((e) => e.index)).toEqual(state.playLog.map((e) => e.index));
    for (const o of overturned) expect(entries.find((e) => e.index === o.index)?.review?.result).toBe('overturned');
  });

  it('honours an injected executor and playcaller', () => {
    const setup = quickSetup(ENTITIES, ABBRS[6] as string, ABBRS[7] as string, { seed: 41 });
    let calls = 0;
    const { result } = simulateGame(setup, {
      executor: (ctx) => { calls += 1; return simulateGameExecutorStub(ctx.ballOn, ctx.offense, ctx.special); },
      playcaller: { hurryUp: () => false },
    });
    expect(calls).toBe(result.plays);
  });
});

/** Minimal scripted executor for the injection test. */
const simulateGameExecutorStub = (ballOn: number, offense: 'home' | 'away', special: string) => {
  const base = { result: 'run' as const, yards: 4, endBallOn: Math.min(99, ballOn + 4), timeElapsed: 5, firstDown: false };
  if (special === 'kickoff' || special === 'onside') return outcome({ result: 'kickoff', endBallOn: 100, events: [{ type: 'touchback', tick: 1 }], timeElapsed: 0, kickDistance: 65 }, ballOn, offense);
  if (special === 'punt') return outcome({ result: 'punt', endBallOn: Math.min(100, ballOn + 40), timeElapsed: 6, kickDistance: 40 }, ballOn, offense);
  if (special === 'fieldGoal') return outcome({ result: 'fieldGoal', kickMade: true, kickDistance: 100 - ballOn + 17, timeElapsed: 5 }, ballOn, offense);
  if (special === 'extraPoint') return outcome({ result: 'extraPoint', kickMade: true, timeElapsed: 4 }, ballOn, offense);
  return outcome(base, ballOn, offense);
};
import { outcomeAt } from '@/game/outcome-factory';
const outcome = (partial: Parameters<typeof outcomeAt>[1], ballOn: number, offense: 'home' | 'away') => outcomeAt(ballOn, partial, offense);

describe('quickSetup', () => {
  it('builds a setup from league entities with playbooks, coaches, stadium and weather', () => {
    const setup = quickSetup(ENTITIES, ABBRS[8] as string, ABBRS[9] as string, { week: 12 });
    expect(setup.home.team.abbr).toBe(ABBRS[8]);
    expect(Object.keys(setup.home.players).length).toBe(setup.home.team.rosterIds.length);
    expect(setup.home.offensePlays.length).toBeGreaterThan(20);
    expect(setup.home.defensePlays.some((d) => d.tags.includes('kickReturn'))).toBe(true);
    expect(setup.home.headCoach?.id).toBe(setup.home.team.headCoachId);
    expect(setup.stadium.id).toBe(setup.home.team.stadiumId);
    expect(setup.controllers).toEqual({ home: 'ai', away: 'ai' });
    expect(setup.weather.type).toBeDefined();
    expect(() => createGameState(setup)).not.toThrow();
    expect(quickSetup(ENTITIES, ABBRS[8] as string, ABBRS[9] as string).seed).toBe(quickSetup(ENTITIES, ABBRS[8] as string, ABBRS[9] as string).seed);
  });

  it('builds from a numeric seed and rejects bad matchups', () => {
    const setup = quickSetup(3, ABBRS[0] as string, ABBRS[1] as string);
    expect(setup.home.team.abbr).toBe(ABBRS[0]);
    expect(() => quickSetup(ENTITIES, 'ZZZ', ABBRS[1] as string)).toThrow(/unknown team/);
    expect(() => quickSetup(ENTITIES, ABBRS[0] as string, ABBRS[0] as string)).toThrow(/itself/);
  });
});

describe('default playcaller', () => {
  const setup = quickSetup(ENTITIES, ABBRS[10] as string, ABBRS[11] as string, { seed: 5 });
  const at = (patch: Partial<GameState>): GameState => {
    const s = createGameState(setup);
    Object.assign(s, { phase: 'playcall', ...patch });
    if (patch.clock) s.clock = { ...createGameState(setup).clock, ...patch.clock };
    return s;
  };
  const rng = createRng(3);

  it('fourth-down chart: field goal in range, punt from deep, go when short or desperate', () => {
    expect(fourthDownChoice(at({ down: 4, distance: 8, ballOn: 75 }))).toBe('fieldGoal');
    expect(fourthDownChoice(at({ down: 4, distance: 8, ballOn: 30 }))).toBe('punt');
    expect(fourthDownChoice(at({ down: 4, distance: 1, ballOn: 50 }))).toBe('go');
    expect(fourthDownChoice(at({ down: 4, distance: 6, ballOn: 40, score: { home: 10, away: 24 }, clock: { quarter: 4, secondsRemaining: 150, running: false, playClock: 40, playClockRunning: false } }))).toBe('go');
  });

  it('two-point and onside decisions follow the score and clock', () => {
    expect(shouldGoForTwo(at({ score: { home: 20, away: 22 }, clock: { quarter: 4, secondsRemaining: 200, running: false, playClock: 40, playClockRunning: false } }))).toBe(true);
    expect(shouldGoForTwo(at({ score: { home: 20, away: 22 }, clock: { quarter: 2, secondsRemaining: 200, running: false, playClock: 40, playClockRunning: false } }))).toBe(false);
    expect(shouldOnside(at({ score: { home: 14, away: 24 }, clock: { quarter: 4, secondsRemaining: 90, running: false, playClock: 40, playClockRunning: false } }))).toBe(true);
    expect(shouldOnside(at({ score: { home: 24, away: 14 }, clock: { quarter: 4, secondsRemaining: 90, running: false, playClock: 40, playClockRunning: false } }))).toBe(false);
  });

  it('calls kickoffs, PATs, punts and field goals, and a return unit against kicks', () => {
    const plays = setup.home.offensePlays;
    const defs = setup.away.defensePlays;
    expect(defaultPlaycaller.offense(at({ kickoffPending: 'home', phase: 'kickoff' }), plays, rng)?.concept).toBe('kickoff');
    expect(defaultPlaycaller.offense(at({ patPending: 'home', phase: 'pat', ballOn: 85 }), plays, rng)?.concept).toBe('extraPoint');
    expect(defaultPlaycaller.offense(at({ down: 4, distance: 9, ballOn: 25 }), plays, rng)?.concept).toBe('punt');
    expect(defaultPlaycaller.offense(at({ down: 4, distance: 9, ballOn: 80 }), plays, rng)?.concept).toBe('fieldGoal');
    const regular = defaultPlaycaller.offense(at({ down: 1, distance: 10, ballOn: 50 }), plays, rng);
    expect(regular?.type).not.toBe('special');
    const kick = plays.find((p) => p.concept === 'kickoff')!;
    expect(defaultPlaycaller.defense(at({ kickoffPending: 'home' }), defs, rng, kick)?.tags).toContain('kickReturn');
    const punt = plays.find((p) => p.concept === 'punt')!;
    expect(defaultPlaycaller.defense(at({ down: 4 }), defs, rng, punt)?.tags).toContain('puntReturn');
    const d = defaultPlaycaller.defense(at({ down: 1, distance: 10, ballOn: 50 }), defs, rng, regular);
    expect(d?.tags.some((t) => t === 'kickReturn' || t === 'puntReturn' || t === 'fgBlock')).toBe(false);
    const hurry = at({ score: { home: 14, away: 17 }, clock: { quarter: 4, secondsRemaining: 100, running: true, playClock: 40, playClockRunning: false } });
    expect(defaultPlaycaller.hurryUp(hurry)).toBe(true);
    expect(defaultPlaycaller.hurryUp(at({}))).toBe(false);
  });

  it('players in the box score are all on the rosters', () => {
    const { state } = simulateGame(setup);
    const rosters = new Set<PlayerId>([...setup.home.team.rosterIds, ...setup.away.team.rosterIds]);
    for (const id of Object.keys(state.stats.players)) expect(rosters.has(id as PlayerId)).toBe(true);
  });
});
