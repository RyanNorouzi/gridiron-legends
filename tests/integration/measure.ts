/**
 * Balance measurement harness: runs real AI-vs-AI plays through the live PlayEngine (and the fast sim) using
 * generated league lineups and bundled plays, and aggregates the league-wide rates the balance test asserts.
 * Everything here is deterministic per seed. Shared by tests/integration/balance.test.ts.
 */
import { decideIntent } from '@/ai/index';
import { registerAll } from '@/ai/register';
import { createRng } from '@/core/rng';
import type { PlayerId } from '@/core/ids';
import type { Player } from '@/players/types';
import { loadPlaybookData, type PlaybookRegistry } from '@/playbook/loader';
import { fieldGoalDistance } from '@/playbook/special-teams';
import type { DefensivePlay, OffensivePlay } from '@/playbook/types';
import type { Team } from '@/teams/types';
import { generateLeagueEntities, type LeagueEntities } from '@/teams/league-generator';
import { selectLineup } from '@/game/lineups';
import type { IntentDecider } from '@/game/engine-api';
import { createPlayEngine, DEFAULT_MAX_TICKS } from '@/game/play-engine';
import type { PlayContext, PlayOutcome } from '@/game/play-types';
import { resolveDefensiveFormation, resolveOffensiveFormation, type PlayRegistries } from '@/game/play-context';
import { getDifficulty, getRuleset } from '@/game/rulesets';
import { MIDDLE_X, type DifficultyId, type DifficultyProfile } from '@/game/types';
import { clearWeather } from '@/game/weather';
import { simulatePlay } from '@/simulation/fast-sim';

export interface MeasureEnv {
  entities: LeagueEntities;
  registry: PlaybookRegistry;
  registries: PlayRegistries;
  teams: Team[];
}

/** A call-sheet mix: quick game and intermediate concepts carry most of the volume, deep shots about a quarter. */
export const PASS_CONCEPTS: readonly string[] = [
  'shotgun-mesh', 'shotgun-slants', 'singleback-slantFlat', 'singleback-curlFlat', 'shotgun-curls', 'shotgun-quickOuts', 'trips-outs', 'shotgun-dragDig',
  'trips-smash', 'shotgun-rbScreen-right', 'shotgun-rpoSlant', 'iform-paBoot-right', 'shotgun-deepCross', 'shotgun-postWheel', 'shotgun-goRoutes', 'shotgun-fourVerts',
];
export const RUN_CONCEPTS: readonly string[] = [
  'iform-dive-right', 'iform-iso-left', 'singleback-counter-left', 'shotgun-insideZone-left', 'pistol-insideZone-right', 'iform-toss-right',
  'singleback-stretch-right', 'pistol-outsideZone-right', 'shotgun-rbDraw', 'pistol-zoneRead',
];
export const DEFENSES: readonly string[] = [
  '43-cover3-zone', '43-cover1-man', '43-cover2-zone', '43-cover4-zone', '43-cover6-zone', 'nickel-cover3-match', '34-cover1-edge',
  '43-cover0-lbBlitz', '43-cover2-zoneBlitz', '43-runStop-cover1', 'nickel-cover2-zone', '34-cover0-allOut',
];
export const SITUATIONS: readonly { down: number; distance: number; ballOn: number }[] = [
  { down: 1, distance: 10, ballOn: 25 }, { down: 2, distance: 7, ballOn: 45 }, { down: 3, distance: 5, ballOn: 62 },
  { down: 1, distance: 10, ballOn: 70 }, { down: 2, distance: 10, ballOn: 35 }, { down: 3, distance: 8, ballOn: 50 },
];

/** Builds the league + playbook environment once (registerAll included). */
export const createMeasureEnv = (seed = 2026): MeasureEnv => {
  registerAll();
  const entities = generateLeagueEntities(seed, { year: 2026, salaryCap: 250_000_000 });
  const registry = loadPlaybookData();
  const teams = Object.values(entities.teams).sort((a, b) => a.abbr.localeCompare(b.abbr));
  return { entities, registry, registries: { offensiveFormations: registry.offensiveFormations, defensiveFormations: registry.defensiveFormations }, teams };
};

export interface CallSpec {
  off: string;
  def: string;
  down?: number;
  distance?: number;
  ballOn?: number;
  special?: PlayContext['special'];
  difficulty?: DifficultyId;
  /** Hold the OFFENSE's AI decisions at this level while `difficulty` drives the defense (the same offense vs a
   *  rookie or a legend defense). Omitted: both sides play at `difficulty`. */
  offenseDifficulty?: DifficultyId;
  ruleset?: 'arcade' | 'simulation';
  /** Index into the team list; the defense is the next team. */
  teamIndex?: number;
  seed: string;
}

const rosterOf = (env: MeasureEnv, team: Team): Record<PlayerId, Player> => {
  const out: Record<PlayerId, Player> = {};
  for (const id of team.rosterIds) { const p = env.entities.players[id]; if (p) out[id] = p; }
  return out;
};

const playOrThrow = <T>(table: Record<string, T>, id: string, label: string): T => {
  const p = table[id];
  if (!p) throw new Error(`measure: unknown ${label} play '${id}'`);
  return p;
};

/** A PlayContext for one AI-vs-AI snap between two league teams. */
export const buildCtx = (env: MeasureEnv, c: CallSpec): PlayContext => {
  const ti = (c.teamIndex ?? 0) % env.teams.length;
  const home = env.teams[ti] as Team;
  const away = env.teams[(ti + 1) % env.teams.length] as Team;
  const offensivePlay: OffensivePlay = playOrThrow(env.registry.offensePlays, c.off, 'offensive');
  const defensivePlay: DefensivePlay = playOrThrow(env.registry.defensePlays, c.def, 'defensive');
  const offForm = resolveOffensiveFormation(offensivePlay, env.registries);
  const defForm = resolveDefensiveFormation(defensivePlay, env.registries);
  const offenseLineup = selectLineup(home, rosterOf(env, home), offForm, {}, [], { rotate: false });
  const defenseLineup = selectLineup(away, rosterOf(env, away), defForm, {}, [], { rotate: false });
  const fatigue: Record<PlayerId, number> = {};
  for (const p of [...Object.values(offenseLineup), ...Object.values(defenseLineup)]) fatigue[p.id] = 0;
  const ballOn = c.ballOn ?? 25;
  return {
    playIndex: 0, down: c.down ?? 1, distance: c.distance ?? 10, ballOn, ballX: MIDDLE_X, direction: 1, offense: 'home',
    offensivePlay, defensivePlay, offenseLineup, defenseLineup, coaches: {}, weather: clearWeather(),
    difficulty: getDifficulty(c.difficulty ?? 'pro'), ruleset: getRuleset(c.ruleset ?? 'simulation'),
    controllers: { home: 'ai', away: 'ai' }, userSide: null, userControl: 'none', controlRole: null,
    quarter: 2, clockRemaining: 600, scoreDiff: 0, special: c.special ?? 'none', crowdFactor: 0.5,
    rng: createRng(`balance:${c.seed}:${c.off}:${c.def}:${ballOn}`), fatigue, clockRunning: true,
  };
};

export interface LiveResult { outcome: PlayOutcome | null; ticks: number; maxTicks: boolean; error: string | null }

/**
 * The real AI with each side deciding at its own level: offense athletes decide under `offense`, everyone else (and
 * every engine system after the intents, which only reads defensive knobs) under `defense`.
 */
export const splitDifficultyDecider = (offense: DifficultyProfile, defense: DifficultyProfile): IntentDecider => (a, s, dt) => {
  s.ctx.difficulty = a.side === 'offense' ? offense : defense;
  try {
    return decideIntent(a, s, dt);
  } finally {
    s.ctx.difficulty = defense;
  }
};

/** Runs one play to the whistle on the live engine; a maxTicks overrun is recorded instead of thrown. */
export const runLive = (env: MeasureEnv, ctx: PlayContext, decider?: IntentDecider): LiveResult => {
  const play = createPlayEngine(ctx, decider ? { registries: env.registries, decider } : { registries: env.registries });
  try {
    const outcome = play.run(undefined, DEFAULT_MAX_TICKS);
    return { outcome, ticks: play.state.tick, maxTicks: false, error: null };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { outcome: null, ticks: play.state.tick, maxTicks: /exceeded/.test(msg), error: msg };
  }
};

/* ------------------------------ Aggregation ------------------------------ */

export interface ScrimmageTally {
  plays: number; maxTicks: number; errors: string[]; timeSum: number;
  dropbacks: number; attempts: number; completions: number; passYards: number; sacks: number; interceptions: number; drops: number;
  pressures: number; throwAways: number; scrambles: number; throwTimeSum: number; throws: number; airSum: number;
  carries: number; rushYards: number; stuffs: number; explosiveRuns: number; runFumbles: number;
  brokenTackles: number; tackleAttempts: number; fumbles: number; touches: number;
  /** yards per play keyed by `${offense play}|${defense play}`. */
  matrix: Record<string, { yards: number; plays: number }>;
}

export const emptyScrimmage = (): ScrimmageTally => ({
  plays: 0, maxTicks: 0, errors: [], timeSum: 0, dropbacks: 0, attempts: 0, completions: 0, passYards: 0, sacks: 0, interceptions: 0, drops: 0,
  pressures: 0, throwAways: 0, scrambles: 0, throwTimeSum: 0, throws: 0, airSum: 0, carries: 0, rushYards: 0, stuffs: 0, explosiveRuns: 0, runFumbles: 0,
  brokenTackles: 0, tackleAttempts: 0, fumbles: 0, touches: 0, matrix: {},
});

const PASS_TYPES = new Set(['pass', 'playAction', 'screen', 'rpo']);

export const tallyScrimmage = (t: ScrimmageTally, ctx: PlayContext, r: LiveResult): void => {
  t.plays += 1;
  if (r.maxTicks) t.maxTicks += 1;
  if (r.error) t.errors.push(`${ctx.offensivePlay.id} vs ${ctx.defensivePlay.id}: ${r.error}`);
  const o = r.outcome;
  if (!o) return;
  t.timeSum += o.timeElapsed;
  if (o.result === 'penalty') return;
  const key = `${ctx.offensivePlay.id}|${ctx.defensivePlay.id}`;
  const cell = (t.matrix[key] ??= { yards: 0, plays: 0 });
  cell.plays += 1;
  cell.yards += o.result === 'interception' ? -45 : o.yards;
  const events = o.events;
  const snap = events.find((e) => e.type === 'snap');
  const thrown = events.find((e) => e.type === 'throw');
  const passPlay = PASS_TYPES.has(ctx.offensivePlay.type);
  const fumbled = events.some((e) => e.type === 'fumble');
  if (fumbled) t.fumbles += 1;
  for (const e of events) {
    if (e.type === 'brokenTackle') { t.brokenTackles += 1; t.tackleAttempts += 1; }
    else if (e.type === 'missedTackle' || e.type === 'tackle') t.tackleAttempts += 1;
  }
  const dropback = passPlay && o.result !== 'run';
  if (dropback) {
    t.dropbacks += 1;
    // Pressure as the league counts it: a rusher on the passer at the throw (hurry), a hit on him before it, or a sack.
    const qbHit = !!snap && events.some((e) => e.type === 'wrapUp' && ctx.offenseLineup[e.carrier.replace(/^off:/, '')]?.position === 'QB' && (!thrown || e.tick <= thrown.tick));
    if (o.underPressure || o.result === 'sack' || qbHit || events.some((e) => e.type === 'pressure')) t.pressures += 1;
    if (thrown && snap && thrown.type === 'throw') { t.throws += 1; t.throwTimeSum += (thrown.tick - snap.tick) / 60; }
  }
  switch (o.result) {
    case 'pass': t.attempts += 1; t.completions += 1; t.passYards += o.yards; t.touches += 1; t.airSum += o.airYards; break;
    case 'incomplete': {
      t.attempts += 1;
      const inc = events.find((e) => e.type === 'incomplete');
      if (inc && inc.type === 'incomplete') { if (inc.reason === 'drop') t.drops += 1; if (inc.reason === 'throwAway') t.throwAways += 1; }
      break;
    }
    case 'interception': t.attempts += 1; t.interceptions += 1; break;
    case 'sack': t.sacks += 1; break;
    case 'scramble': t.scrambles += 1; break;
    case 'run':
      t.carries += 1; t.rushYards += o.yards; t.touches += 1;
      if (o.yards <= 0) t.stuffs += 1;
      if (o.yards >= 12) t.explosiveRuns += 1;
      if (fumbled) t.runFumbles += 1;
      break;
    default: break;
  }
};

export interface ScrimmageRates {
  plays: number; maxTicksPct: number; meanPlaySec: number; yardsPerPlay: number;
  completionPct: number; ypa: number; sackPct: number; intPct: number; dropPct: number; pressurePct: number; timeToThrow: number; throwAwayPct: number; scramblePct: number; airYards: number;
  ypc: number; stuffPct: number; explosiveRunPct: number; fumblePct: number; brokenTacklePct: number;
}

export const scrimmageRates = (t: ScrimmageTally): ScrimmageRates => {
  const div = (a: number, b: number): number => (b > 0 ? a / b : 0);
  return {
    plays: t.plays, maxTicksPct: div(t.maxTicks, t.plays), meanPlaySec: div(t.timeSum, t.plays - t.maxTicks),
    yardsPerPlay: div(t.passYards + t.rushYards, t.plays),
    completionPct: div(t.completions, t.attempts), ypa: div(t.passYards, t.attempts), sackPct: div(t.sacks, t.dropbacks), intPct: div(t.interceptions, t.attempts),
    dropPct: div(t.drops, t.attempts), pressurePct: div(t.pressures, t.dropbacks), timeToThrow: div(t.throwTimeSum, t.throws), throwAwayPct: div(t.throwAways, t.attempts),
    scramblePct: div(t.scrambles, t.dropbacks), airYards: div(t.airSum, t.completions),
    ypc: div(t.rushYards, t.carries), stuffPct: div(t.stuffs, t.carries), explosiveRunPct: div(t.explosiveRuns, t.carries), fumblePct: div(t.runFumbles, t.carries),
    brokenTacklePct: div(t.brokenTackles, t.tackleAttempts),
  };
};

/** The scrimmage call matrix: every offensive concept vs every defense, situations rotating, `variants` seeds each. */
export const scrimmageCalls = (
  variants: number,
  opts: { difficulty?: DifficultyId; offenseDifficulty?: DifficultyId; seedTag?: string; offense?: readonly string[]; defenses?: readonly string[] } = {},
): CallSpec[] => {
  const calls: CallSpec[] = [];
  const offense = opts.offense ?? [...PASS_CONCEPTS, ...RUN_CONCEPTS];
  const defenses = opts.defenses ?? DEFENSES;
  offense.forEach((off, oi) => {
    defenses.forEach((def, di) => {
      for (let v = 0; v < variants; v++) {
        const sit = SITUATIONS[(oi + di + v) % SITUATIONS.length] as (typeof SITUATIONS)[number];
        calls.push({
          off, def, ...sit, difficulty: opts.difficulty, offenseDifficulty: opts.offenseDifficulty, teamIndex: (oi * 3 + di + v) % 8, seed: `${opts.seedTag ?? 'base'}:${v}`,
        });
      }
    });
  });
  return calls;
};

export const measureScrimmage = (env: MeasureEnv, calls: readonly CallSpec[]): ScrimmageTally => {
  const t = emptyScrimmage();
  for (const c of calls) {
    const ctx = buildCtx(env, c);
    const decider = c.offenseDifficulty ? splitDifficultyDecider(getDifficulty(c.offenseDifficulty), ctx.difficulty) : undefined;
    tallyScrimmage(t, ctx, runLive(env, ctx, decider));
  }
  return t;
};

/** The same calls through the fast sim (statistical executor). */
export const measureFastSim = (env: MeasureEnv, calls: readonly CallSpec[]): ScrimmageTally => {
  const t = emptyScrimmage();
  for (const c of calls) {
    const ctx = buildCtx(env, c);
    tallyScrimmage(t, ctx, { outcome: simulatePlay(ctx), ticks: 0, maxTicks: false, error: null });
  }
  return t;
};

/* ------------------------------ Special teams ------------------------------ */

export interface SpecialTally {
  plays: number; maxTicks: number; errors: string[]; timeSum: number;
  fg: Record<number, { made: number; attempts: number }>;
  punts: number; puntYards: number; puntTouchbacks: number;
  kickoffs: number; kickoffTouchbacks: number; kickoffReturns: number; kickoffReturnYards: number; kickoffReturnTds: number;
}

export const emptySpecial = (): SpecialTally => ({ plays: 0, maxTicks: 0, errors: [], timeSum: 0, fg: {}, punts: 0, puntYards: 0, puntTouchbacks: 0, kickoffs: 0, kickoffTouchbacks: 0, kickoffReturns: 0, kickoffReturnYards: 0, kickoffReturnTds: 0 });

export const FG_DISTANCES: readonly number[] = [30, 45, 55];

export const measureSpecial = (env: MeasureEnv, perKind: number): SpecialTally => {
  const t = emptySpecial();
  const record = (ctx: PlayContext, r: LiveResult, use: (o: PlayOutcome) => void): void => {
    t.plays += 1;
    if (r.maxTicks) t.maxTicks += 1;
    if (r.error) t.errors.push(`${ctx.offensivePlay.id}: ${r.error}`);
    if (r.outcome) { t.timeSum += r.outcome.timeElapsed; use(r.outcome); }
  };
  for (let i = 0; i < perKind; i++) {
    const ko = buildCtx(env, { off: 'kickoff-deep', def: 'kickReturn-middle', special: 'kickoff', ballOn: 35, teamIndex: i % 8, seed: `ko:${i}` });
    record(ko, runLive(env, ko), (o) => {
      t.kickoffs += 1;
      if (o.events.some((e) => e.type === 'touchback')) t.kickoffTouchbacks += 1;
      else if (o.events.some((e) => e.type === 'kick') && !o.events.some((e) => e.type === 'fairCatch')) {
        t.kickoffReturns += 1;
        t.kickoffReturnYards += o.returnYards;
        if (o.touchdown) t.kickoffReturnTds += 1;
      }
    });
    const punt = buildCtx(env, { off: 'punt-standard', def: 'puntReturn-middle', special: 'punt', ballOn: 25 + (i % 4) * 5, down: 4, teamIndex: i % 8, seed: `punt:${i}` });
    record(punt, runLive(env, punt), (o) => {
      if (o.kickDistance === null) return;
      t.punts += 1;
      t.puntYards += o.kickDistance;
      if (o.events.some((e) => e.type === 'touchback')) t.puntTouchbacks += 1;
    });
  }
  const perDistance = Math.max(10, Math.ceil(perKind / FG_DISTANCES.length));
  for (const d of FG_DISTANCES) {
    const ballOn = 117 - d;
    if (fieldGoalDistance(ballOn) !== d) throw new Error(`measure: FG distance mismatch for ${d}`);
    for (let i = 0; i < perDistance; i++) {
      const fg = buildCtx(env, { off: 'fieldGoal-standard', def: 'fgBlock-middle', special: 'fieldGoal', ballOn, down: 4, distance: 5, teamIndex: i % 8, seed: `fg:${d}:${i}` });
      record(fg, runLive(env, fg), (o) => {
        const cell = (t.fg[d] ??= { made: 0, attempts: 0 });
        cell.attempts += 1;
        if (o.kickMade) cell.made += 1;
      });
    }
  }
  return t;
};

export interface SpecialRates { plays: number; maxTicksPct: number; meanPlaySec: number; fgPct: Record<number, number>; puntAvg: number; puntTouchbackPct: number; kickoffReturnAvg: number; kickoffTouchbackPct: number; kickoffReturnTdPct: number }

export const specialRates = (t: SpecialTally): SpecialRates => {
  const div = (a: number, b: number): number => (b > 0 ? a / b : 0);
  const fgPct: Record<number, number> = {};
  for (const [d, c] of Object.entries(t.fg)) fgPct[Number(d)] = div(c.made, c.attempts);
  return {
    plays: t.plays, maxTicksPct: div(t.maxTicks, t.plays), meanPlaySec: div(t.timeSum, t.plays - t.maxTicks), fgPct,
    puntAvg: div(t.puntYards, t.punts), puntTouchbackPct: div(t.puntTouchbacks, t.punts),
    kickoffReturnAvg: div(t.kickoffReturnYards, t.kickoffReturns), kickoffTouchbackPct: div(t.kickoffTouchbacks, t.kickoffs), kickoffReturnTdPct: div(t.kickoffReturnTds, t.kickoffReturns),
  };
};

/* ------------------------------ Reporting ------------------------------ */

const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;
const num = (x: number, d = 2): string => x.toFixed(d);

export const formatTable = (title: string, rows: readonly [string, string, string][]): string => {
  const w0 = Math.max(...rows.map((r) => r[0].length), 6);
  const w1 = Math.max(...rows.map((r) => r[1].length), 6);
  const line = rows.map((r) => `  ${r[0].padEnd(w0)}  ${r[1].padStart(w1)}  ${r[2]}`).join('\n');
  return `${title}\n${line}`;
};

export const scrimmageRows = (r: ScrimmageRates): [string, string, string][] => [
  ['plays', String(r.plays), ''], ['maxTicks', pct(r.maxTicksPct), 'must be 0'], ['mean play', `${num(r.meanPlaySec)} s`, '< 9 s'], ['yards/play', num(r.yardsPerPlay), ''],
  ['completion', pct(r.completionPct), '52-70%'], ['yards/att', num(r.ypa), '5.5-8.5'], ['sack', pct(r.sackPct), '4-10%'], ['INT', pct(r.intPct), '1.5-4.5%'],
  ['drop', pct(r.dropPct), ''], ['pressure', pct(r.pressurePct), ''], ['time to throw', `${num(r.timeToThrow)} s`, ''], ['throwaway', pct(r.throwAwayPct), ''],
  ['scramble', pct(r.scramblePct), ''], ['air yds/comp', num(r.airYards, 1), ''],
  ['yards/carry', num(r.ypc), '3.3-5.2'], ['stuff', pct(r.stuffPct), '12-25%'], ['explosive run', pct(r.explosiveRunPct), ''], ['fumble/carry', pct(r.fumblePct), '0.5-3%'],
  ['broken tackle', pct(r.brokenTacklePct), 'per attempt'],
];

export const specialRows = (r: SpecialRates): [string, string, string][] => [
  ['plays', String(r.plays), ''], ['maxTicks', pct(r.maxTicksPct), 'must be 0'], ['mean play', `${num(r.meanPlaySec)} s`, ''],
  ...FG_DISTANCES.map((d): [string, string, string] => [`FG ${d}`, pct(r.fgPct[d] ?? 0), d === 30 ? '> 85%' : d === 55 ? '< 55%' : '']),
  ['punt avg', num(r.puntAvg, 1), '36-50'], ['punt touchback', pct(r.puntTouchbackPct), ''],
  ['KO return avg', num(r.kickoffReturnAvg, 1), ''], ['KO touchback', pct(r.kickoffTouchbackPct), ''], ['KO return TD', pct(r.kickoffReturnTdPct), ''],
];

/** For each defense, the offensive concept with the best yards/play; returns the set of winning concepts. */
export const bestConceptPerDefense = (t: ScrimmageTally, concepts: readonly string[]): Record<string, string> => {
  const best: Record<string, { off: string; ypp: number }> = {};
  for (const [key, cell] of Object.entries(t.matrix)) {
    const [off, def] = key.split('|') as [string, string];
    if (!concepts.includes(off) || cell.plays === 0) continue;
    const ypp = cell.yards / cell.plays;
    const cur = best[def];
    if (!cur || ypp > cur.ypp) best[def] = { off, ypp };
  }
  const out: Record<string, string> = {};
  for (const [def, b] of Object.entries(best)) out[def] = b.off;
  return out;
};
