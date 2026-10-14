import { gameId, type PlayerId, type TeamId } from '@/core/ids';
import { clamp } from '@/core/math';
import { createRng, restoreRng, type Rng } from '@/core/rng';
import type { Player } from '@/players/types';
import { loadPlaybookData, resolvePlaybook } from '@/playbook/loader';
import type { GameStats } from '@/statistics/types';
import type { Coach, Stadium, Team } from '@/teams/types';
import { generateLeagueEntities, type LeagueEntities } from '@/teams/league-generator';
import type { FastPlayExecutor } from '@/game/engine-api';
import { GameController, type CoachHooks } from '@/game/game-controller';
import type { PlayRegistries } from '@/game/play-context';
import { getDifficulty, getRuleset } from '@/game/rulesets';
import { aiShouldAccept, decidingTeam, shouldChallengeDefault } from '@/game/rules';
import { generateWeather } from '@/game/weather';
import type { ControllerKind, DifficultyId, GameInjury, GameSetup, GameState, GameTeamSetup, PlayLogEntry, TeamSide, WeatherState } from '@/game/types';
import { createFastSim, type GameForm } from './fast-sim';
import { defaultPlaycaller, type Playcaller } from './playcaller';

/**
 * Whole-game simulation on top of GameController: answers every decision through the coach hooks, calls
 * plays with the injected Playcaller (default: situational weights + fourth-down chart), executes each
 * snap with the fast executor and applies it, until the game is final. Deterministic per setup seed.
 */
export interface SimulateGameOptions {
  registries?: PlayRegistries;
  playcaller?: Partial<Playcaller>;
  executor?: FastPlayExecutor;
  /**
   * Called exactly once per play with its final entry: an entry is held until the next play is applied (or the game
   * ends), so a challenge that overturns the call reports the corrected play instead of both versions.
   */
  onPlay?: (entry: PlayLogEntry) => void;
  coach?: Partial<CoachHooks>;
  /** Safety valve against a runaway loop (default 600). */
  maxPlays?: number;
  /** SD of each team's per-game form for the default executor (default GAME_FORM_SD; 0 disables). */
  formSd?: number;
}

/**
 * Standard deviation of a team's per-game form in matchup-factor units. Teams have good and bad days: without it a
 * few rating points decide nearly every game (16-1 and 0-17 seasons from a 67-77 overall spread); with it the
 * season win spread lands near the NFL's (SD ~3 wins). Calibrated with RATING_LEVERAGE at the franchise's 900 s
 * league games: 0.035 gives win SD 2.8-3.2 with mean margins of ~11.5-12 and 5-6% of games decided by 28+ (0.04 left
 * means of 12-13 once league completion reached ~63%; 0.06 with the old 0.42 leverage left means of 16 and 15-17% of
 * games decided by 28+).
 */
export const GAME_FORM_SD = 0.035;

/** Form is a normal draw truncated at this many SDs: a great day, never a different team. */
export const GAME_FORM_MAX_SDS = 2;

/** Each side's form for one game, drawn from its own stream of the game seed (the controller's rng is untouched). */
export const gameForm = (seed: number, sd: number = GAME_FORM_SD): GameForm => {
  if (sd <= 0) return { home: 0, away: 0 };
  const rng = createRng(`form:${seed}`);
  const draw = (): number => clamp(rng.gaussian(0, sd), -GAME_FORM_MAX_SDS * sd, GAME_FORM_MAX_SDS * sd);
  return { home: draw(), away: draw() };
};

export interface GameResultSummary {
  homeScore: number;
  awayScore: number;
  winner: TeamSide | null;
  overtime: boolean;
  overtimePeriods: number;
  plays: number;
  stats: GameStats;
  injuries: GameInjury[];
}

export interface GameSimResult {
  state: GameState;
  result: GameResultSummary;
}

/** Formation registries from the bundled playbook data (so return units and kick formations resolve their roles). */
export const playbookRegistries = (): PlayRegistries => {
  try {
    const reg = loadPlaybookData();
    return { offensiveFormations: reg.offensiveFormations, defensiveFormations: reg.defensiveFormations };
  } catch {
    return {};
  }
};

/** Everyone simulated: both sides AI, no local viewer. */
const aiOnly = (setup: GameSetup): GameSetup => ({ ...setup, userSide: null, controllers: { home: 'ai', away: 'ai' } });

const summarize = (state: GameState): GameResultSummary => ({
  homeScore: state.score.home,
  awayScore: state.score.away,
  winner: state.score.home === state.score.away ? null : state.score.home > state.score.away ? 'home' : 'away',
  overtime: state.overtimePeriods > 0,
  overtimePeriods: state.overtimePeriods,
  plays: state.playLog.length,
  stats: state.stats,
  injuries: state.injuries,
});

/**
 * Drives an existing controller to the final whistle. Human pending decisions are answered as an AI coach
 * would (sim-to-end from a user game), plays are called by the playcaller and executed by the executor.
 */
export const simulateToEnd = (controller: GameController, opts: SimulateGameOptions = {}): GameSimResult => {
  const executor = opts.executor ?? createFastSim(gameForm(controller.state.seed, opts.formSd));
  const caller: Playcaller = { ...defaultPlaycaller, ...opts.playcaller };
  const maxPlays = opts.maxPlays ?? 600;
  let held: PlayLogEntry | null = null;
  const flush = (): void => {
    if (held) opts.onPlay?.(held);
    held = null;
  };
  const unsubscribe = opts.onPlay ? controller.onEvent((e) => {
    if (e.type !== 'playApplied') return;
    if (!e.replaces) flush();
    held = e.entry;
  }) : null;
  try {
    if (controller.state.phase === 'pregame') controller.start();
    let guard = 0;
    while (!controller.isFinal) {
      if (controller.state.playLog.length > maxPlays || guard++ > maxPlays * 4) throw new Error(`simulateToEnd: exceeded ${maxPlays} plays without reaching the final whistle`);
      const s = controller.state;
      const pd = controller.pendingDecision;
      if (pd && pd.kind !== 'playCall' && answerDecision(controller, pd.side, pd.kind)) continue;
      const rng: Rng = restoreRng(s.seed, s.rngState).fork(`call:${s.playLog.length}`);
      const offense = s.possession;
      const defense = offense === 'home' ? 'away' : 'home';
      const offPlay = caller.offense(s, controller.setup[offense].offensePlays, rng.fork('off'));
      const defPlay = caller.defense(s, controller.setup[defense].defensePlays, rng.fork('def'), offPlay);
      const hurryUp = !s.kickoffPending && !s.patPending && caller.hurryUp(s);
      const ctx = controller.beginPlay(offPlay?.id ?? null, defPlay?.id ?? null, { hurryUp });
      controller.completePlay(executor(ctx));
    }
  } finally {
    unsubscribe?.();
    flush();
  }
  const state = controller.state as GameState;
  return { state, result: summarize(state) };
};

/**
 * Answers a decision the controller left to a human side with the default AI logic. Returns true when a
 * command was dispatched (the loop re-reads the state); false means the decision needs no command (a declined
 * challenge window is cleared by the next beginPlay).
 */
const answerDecision = (c: GameController, side: TeamSide, kind: Exclude<GameState['pendingDecision'], null>['kind']): boolean => {
  const s = c.state;
  switch (kind) {
    case 'coinToss': c.dispatch({ type: 'coinToss', side, choice: 'defer' }); return true;
    case 'freeKick': c.dispatch({ type: 'freeKick', side, choice: 'kick' }); return true;
    case 'penaltyDecision': {
      const o = c.pendingOutcome;
      const pen = o?.penalties.find((p) => decidingTeam(s, p) === side) ?? o?.penalties[0];
      const accept = o && pen ? aiShouldAccept(s, o, pen) : false;
      c.dispatch({ type: 'penaltyDecision', side, accept });
      return true;
    }
    case 'challengeWindow': {
      const last = s.lastOutcome;
      if (last && shouldChallengeDefault(s as GameState, last, side)) { c.dispatch({ type: 'challenge', side }); return true; }
      return false;
    }
    case 'playCall': return false;
  }
};

/** Simulates one full game from a setup (both sides AI regardless of the setup's controllers). */
export const simulateGame = (setup: GameSetup, opts: SimulateGameOptions = {}): GameSimResult => {
  const controller = new GameController(aiOnly(setup), { coach: opts.coach, registries: opts.registries ?? playbookRegistries() });
  return simulateToEnd(controller, opts);
};

/** Simulates several games (a league week) in order. */
export const simulateGames = (setups: readonly GameSetup[], opts: SimulateGameOptions = {}): GameSimResult[] => setups.map((s) => simulateGame(s, opts));

export interface QuickSetupOptions {
  /** Game seed (default: derived from the league seed and the matchup). */
  seed?: number;
  rulesetId?: string;
  difficultyId?: DifficultyId;
  weather?: WeatherState;
  /** Season week for weather generation (default 1). */
  week?: number;
  isPlayoff?: boolean;
  userSide?: TeamSide | null;
  controllers?: Record<TeamSide, ControllerKind>;
  /** League year used when generating entities from a numeric seed (default 2026). */
  year?: number;
  salaryCap?: number;
}

const teamByAbbr = (entities: LeagueEntities, abbr: string): Team => {
  const key = abbr.toUpperCase();
  const team = Object.values(entities.teams).find((t) => t.abbr === key);
  if (!team) throw new Error(`quickSetup: unknown team '${abbr}'`);
  return team;
};

const teamSetup = (entities: LeagueEntities, team: Team): GameTeamSetup => {
  const players: Record<PlayerId, Player> = {};
  for (const id of team.rosterIds) {
    const p = entities.players[id];
    if (!p) throw new Error(`quickSetup: ${team.abbr} roster references unknown player ${id}`);
    players[id] = p;
  }
  const headCoach: Coach | null = team.headCoachId ? entities.coaches[team.headCoachId] ?? null : null;
  const book = resolvePlaybook(team.playbookId);
  return { team, players, headCoach, offensePlays: book.offense, defensePlays: book.defense };
};

/**
 * Builds a GameSetup for two league teams (by abbreviation) from generated league entities, or from a
 * numeric seed (a fresh league is generated). Playbooks resolve via each team's playbookId.
 */
export const quickSetup = (seedOrEntities: number | LeagueEntities, homeAbbr: string, awayAbbr: string, opts: QuickSetupOptions = {}): GameSetup => {
  const entities = typeof seedOrEntities === 'number'
    ? generateLeagueEntities(seedOrEntities, { year: opts.year ?? 2026, salaryCap: opts.salaryCap ?? 250_000_000 })
    : seedOrEntities;
  const home = teamByAbbr(entities, homeAbbr);
  const away = teamByAbbr(entities, awayAbbr);
  if (home.id === away.id) throw new Error('quickSetup: a team cannot play itself');
  const stadium: Stadium | undefined = entities.stadiums[home.stadiumId];
  if (!stadium) throw new Error(`quickSetup: stadium ${home.stadiumId} missing for ${home.abbr}`);
  const baseSeed = typeof seedOrEntities === 'number' ? seedOrEntities : 1;
  const seed = opts.seed ?? (createRng(`${baseSeed}:${home.abbr}:${away.abbr}`).int(1, 2 ** 31 - 1));
  const rng = createRng(seed);
  const weather = opts.weather ?? generateWeather(rng.fork('weather'), stadium.climate, opts.week ?? 1, stadium.roof);
  const userSide = opts.userSide ?? null;
  const controllers = opts.controllers ?? { home: userSide === 'home' ? 'human' : 'ai', away: userSide === 'away' ? 'human' : 'ai' };
  return {
    id: gameId(rng.fork('id')),
    home: teamSetup(entities, home),
    away: teamSetup(entities, away),
    stadium,
    ruleset: getRuleset(opts.rulesetId ?? 'simulation'),
    difficulty: getDifficulty(opts.difficultyId ?? 'pro'),
    weather,
    seed,
    userSide,
    controllers,
    isPlayoff: opts.isPlayoff ?? false,
  };
};

/** Team ids of a setup, for callers that key results by TeamId. */
export const setupTeamIds = (setup: GameSetup): Record<TeamSide, TeamId> => ({ home: setup.home.team.id, away: setup.away.team.id });
