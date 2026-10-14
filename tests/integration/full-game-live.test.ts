/**
 * Full AI-vs-AI games through the real stack: registerAll() deciders, GameController driven by the AI
 * playcaller / coach hooks, and every snap executed tick by tick by createPlayEngine().run(). A second game
 * runs under the simulation ruleset (penalties, injuries, challenges) and a third through the fast sim.
 */
import { describe, expect, it } from 'vitest';
import { registerAll } from '@/ai/register';
import { GameController } from '@/game/game-controller';
import { assertValidOutcome } from '@/game/outcome-factory';
import { createPlayEngine, DEFAULT_MAX_TICKS } from '@/game/play-engine';
import type { PlayOutcome } from '@/game/play-types';
import type { GameSetup, GameState, TeamSide } from '@/game/types';
import { loadPlaybookData } from '@/playbook/loader';
import { quickSetup, simulateGame } from '@/simulation/game-sim';
import type { GameStats, PlayerStatLine } from '@/statistics/types';
import type { PlayerId } from '@/core/ids';
import { generateLeagueEntities } from '@/teams/league-generator';
import { aiCoachHooks } from '@/ui/game/playcaller-ai';

registerAll();

const entities = generateLeagueEntities(2026, { year: 2026, salaryCap: 250_000_000 });
const registry = loadPlaybookData();

interface LiveGame {
  state: GameState;
  outcomes: PlayOutcome[];
  ticks: number[];
  ms: number;
}

const byId = <T extends { id: string }>(...lists: readonly (readonly T[])[]): Record<string, T> => {
  const out: Record<string, T> = {};
  for (const list of lists) for (const p of list) out[p.id] = p;
  return out;
};

/** Plays a whole game live (both sides AI) and collects every outcome. */
const playLiveGame = (setup: GameSetup, maxPlays = 400): LiveGame => {
  const controller = new GameController(setup, {
    coach: aiCoachHooks(setup),
    registries: { offensiveFormations: registry.offensiveFormations, defensiveFormations: registry.defensiveFormations },
  });
  const plays = { offensePlays: byId(setup.home.offensePlays, setup.away.offensePlays), defensePlays: byId(setup.home.defensePlays, setup.away.defensePlays) };
  const outcomes: PlayOutcome[] = [];
  const ticks: number[] = [];
  const started = performance.now();
  controller.start();
  while (!controller.isFinal) {
    if (outcomes.length >= maxPlays) throw new Error(`live game exceeded ${maxPlays} plays (phase ${controller.state.phase}, q${controller.state.clock.quarter} ${controller.state.clock.secondsRemaining}s)`);
    const pd = controller.pendingDecision;
    if (pd && pd.kind !== 'playCall' && pd.kind !== 'challengeWindow') throw new Error(`AI game left a ${pd.kind} decision pending for ${pd.side}`);
    const ctx = controller.beginPlay(null, null);
    const play = createPlayEngine(ctx, { registries: { offensiveFormations: registry.offensiveFormations, defensiveFormations: registry.defensiveFormations }, plays });
    const outcome = play.run(undefined, DEFAULT_MAX_TICKS);
    ticks.push(play.state.tick);
    outcomes.push(outcome);
    controller.completePlay(outcome);
  }
  return { state: controller.state as GameState, outcomes, ticks, ms: performance.now() - started };
};

const walkNumbers = (value: unknown, path: string, bad: string[]): void => {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) bad.push(path);
    return;
  }
  if (Array.isArray(value)) { value.forEach((v, i) => walkNumbers(v, `${path}[${i}]`, bad)); return; }
  if (value && typeof value === 'object') for (const [k, v] of Object.entries(value as Record<string, unknown>)) walkNumbers(v, `${path}.${k}`, bad);
};

const nonFiniteNumbers = (stats: GameStats): string[] => {
  const bad: string[] = [];
  walkNumbers(stats, 'stats', bad);
  return bad;
};

/** Team passing (net of sack yardage, the NFL convention) / rushing yards must equal the sums over that team's players. */
const expectTeamTotalsMatchPlayers = (setup: GameSetup, stats: GameStats): void => {
  for (const side of ['home', 'away'] as const) {
    const ids = Object.keys(setup[side].players) as PlayerId[];
    const line = (id: PlayerId): PlayerStatLine | undefined => stats.players[id];
    const pass = ids.reduce((sum, id) => sum + (line(id)?.passing.yards ?? 0) - (line(id)?.passing.sackYards ?? 0), 0);
    const rush = ids.reduce((sum, id) => sum + (line(id)?.rushing.yards ?? 0), 0);
    expect(stats.teams[side].passYards).toBe(pass);
    expect(stats.teams[side].rushYards).toBe(rush);
  }
};

interface Mix { pass: number; run: number; incomplete: number; punt: number; kickoff: number; fieldGoal: number; extraPoint: number; sack: number; interception: number; scramble: number; touchdown: number; penalty: number }

const mixOf = (outcomes: readonly PlayOutcome[]): Mix => {
  const m: Mix = { pass: 0, run: 0, incomplete: 0, punt: 0, kickoff: 0, fieldGoal: 0, extraPoint: 0, sack: 0, interception: 0, scramble: 0, touchdown: 0, penalty: 0 };
  for (const o of outcomes) {
    if (o.touchdown) m.touchdown += 1;
    if (o.result in m) m[o.result as keyof Mix] += 1;
  }
  return m;
};

const describeGame = (label: string, g: LiveGame): string => {
  const m = mixOf(g.outcomes);
  const s = g.state;
  const maxTicks = Math.max(...g.ticks);
  return `${label}: ${s.score.home}-${s.score.away} in ${g.outcomes.length} plays, ${(g.ms / 1000).toFixed(1)}s, max ${maxTicks} ticks/play, mix ${JSON.stringify(m)}`;
};

const expectSaneGame = (setup: GameSetup, g: LiveGame): void => {
  const s = g.state;
  expect(s.phase).toBe('final');
  expect(g.ms).toBeLessThan(60_000);
  for (const side of ['home', 'away'] as const) {
    expect(s.score[side]).toBeGreaterThanOrEqual(0);
    expect(s.score[side]).toBeLessThanOrEqual(70);
  }
  expect(g.outcomes.length).toBeGreaterThanOrEqual(60);
  expect(g.outcomes.length).toBeLessThanOrEqual(200);
  expect(s.playLog.length).toBe(g.outcomes.length);
  expect(nonFiniteNumbers(s.stats)).toEqual([]);
  for (const o of g.outcomes) assertValidOutcome(o);
  expectTeamTotalsMatchPlayers(setup, s.stats);
  for (const t of g.ticks) expect(t).toBeLessThanOrEqual(DEFAULT_MAX_TICKS);
  const m = mixOf(g.outcomes);
  expect(m.pass).toBeGreaterThan(0);
  expect(m.run).toBeGreaterThan(0);
  expect(m.incomplete).toBeGreaterThan(0);
  expect(m.punt).toBeGreaterThan(0);
  expect(m.kickoff).toBeGreaterThan(0);
  expect(m.fieldGoal + m.extraPoint).toBeGreaterThan(0);
  const totalPoints = s.score.home + s.score.away;
  const sides: TeamSide[] = ['home', 'away'];
  expect(sides.reduce((sum, side) => sum + s.stats.teams[side].points, 0)).toBe(totalPoints);
};

describe('full live game (AI vs AI, tick engine)', () => {
  it('arcade rules: reaches the final whistle with a plausible box score', () => {
    const base = quickSetup(entities, 'BOS', 'NYC', { rulesetId: 'arcade', seed: 101, controllers: { home: 'ai', away: 'ai' } });
    // Three-minute periods: a full arcade game in well under a minute of wall clock.
    const setup: GameSetup = { ...base, ruleset: { ...base.ruleset, quarterLengthSec: 180 } };
    const game = playLiveGame(setup);
    console.log(describeGame('arcade', game));
    expectSaneGame(setup, game);
  }, 120_000);

  it('simulation rules: penalties, injuries and challenges do not break the flow', () => {
    const base = quickSetup(entities, 'PHI', 'BUF', { rulesetId: 'simulation', seed: 202, controllers: { home: 'ai', away: 'ai' } });
    // Full simulation rules (penalties, injuries, challenges, modified overtime) over the same short periods as
    // the arcade game, so the run stays inside the play-count and clock bounds.
    const setup: GameSetup = { ...base, ruleset: { ...base.ruleset, quarterLengthSec: 300 } };
    const game = playLiveGame(setup, 500);
    console.log(describeGame('simulation', game));
    expectSaneGame(setup, game);
  }, 180_000);

  it('fast sim: the same setup through simulateGame is consistent too', () => {
    const setup = quickSetup(entities, 'BAL', 'WAS', { rulesetId: 'arcade', seed: 303 });
    const started = performance.now();
    const { state, result } = simulateGame(setup);
    expect(performance.now() - started).toBeLessThan(10_000);
    expect(state.phase).toBe('final');
    expect(result.plays).toBeGreaterThanOrEqual(60);
    expect(result.plays).toBeLessThanOrEqual(200);
    expect(result.homeScore).toBeLessThanOrEqual(70);
    expect(result.awayScore).toBeLessThanOrEqual(70);
    expect(nonFiniteNumbers(state.stats)).toEqual([]);
    for (const entry of state.playLog) assertValidOutcome(entry.outcome);
    expectTeamTotalsMatchPlayers(setup, state.stats);
    const m = mixOf(state.playLog.map((e) => e.outcome));
    expect(m.pass).toBeGreaterThan(0);
    expect(m.run).toBeGreaterThan(0);
    expect(m.kickoff).toBeGreaterThan(0);
  }, 60_000);
});
