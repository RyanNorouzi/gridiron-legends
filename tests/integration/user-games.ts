/**
 * "User game" harness for the difficulty targets: whole games played live (every snap through the tick PlayEngine,
 * both sides called by the real AI coaches) between the CPU at difficulty D and a stand-in for a solid human player.
 * The stand-in is the user's club driven by the AI at the neutral 'pro' decision profile with no edge: exactly what
 * a simulated user game does (GameSetup.humanTeam with both controllers 'ai'), so the per-side profiles and the CPU
 * performance edge come from the production path (game/difficulty-sides.ts via buildPlayContext).
 * Both directions come out of every game: CPU offense vs user defense and user offense vs CPU defense.
 * Deterministic per seed. Shared by tests/integration/difficulty-user.test.ts.
 */
import { registerAll } from '@/ai/register';
import { GameController } from '@/game/game-controller';
import type { PlayRegistries } from '@/game/play-context';
import { createPlayEngine, DEFAULT_MAX_TICKS } from '@/game/play-engine';
import type { PlayResultType } from '@/game/play-types';
import { otherSide, type DifficultyId, type GameSetup, type GameState, type PlayLogEntry, type TeamSide } from '@/game/types';
import { loadPlaybookData } from '@/playbook/loader';
import type { DefensivePlay, OffensivePlay } from '@/playbook/types';
import { quickSetup } from '@/simulation/game-sim';
import { generateLeagueEntities, type LeagueEntities } from '@/teams/league-generator';
import { aiCoachHooks } from '@/ui/game/playcaller-ai';

/** One offense's production over a set of drives. */
export interface OffenseTally {
  games: number; drives: number; scoringDrives: number; points: number;
  plays: number; yards: number; thirdAttempts: number; thirdConversions: number;
  dropbacks: number; sacks: number; interceptions: number; turnovers: number;
}

/** A zeroed tally. */
export const emptyTally = (): OffenseTally => ({
  games: 0, drives: 0, scoringDrives: 0, points: 0, plays: 0, yards: 0, thirdAttempts: 0, thirdConversions: 0, dropbacks: 0, sacks: 0, interceptions: 0, turnovers: 0,
});

/** Per-drive / per-play rates of a tally (yards per play, share of drives scored, third-down rate, sack / INT per dropback). */
export interface OffenseRates { drives: number; ypp: number; scoreRate: number; thirdDown: number; sackRate: number; intRate: number; pointsPerGame: number }

/** Rates of a tally (0 where the denominator is empty). */
export const ratesOf = (t: OffenseTally): OffenseRates => {
  const div = (a: number, b: number): number => (b > 0 ? a / b : 0);
  return {
    drives: t.drives, ypp: div(t.yards, t.plays), scoreRate: div(t.scoringDrives, t.drives), thirdDown: div(t.thirdConversions, t.thirdAttempts),
    sackRate: div(t.sacks, t.dropbacks), intRate: div(t.interceptions, t.dropbacks), pointsPerGame: div(t.points, t.games),
  };
};

/** One printable line of rates. */
export const formatRates = (label: string, r: OffenseRates): string =>
  `${label}: ${r.ypp.toFixed(2)} yd/play, scores ${(r.scoreRate * 100).toFixed(0)}% of ${r.drives} drives, 3rd down ${(r.thirdDown * 100).toFixed(0)}%, `
  + `sack ${(r.sackRate * 100).toFixed(1)}%, INT ${(r.intRate * 100).toFixed(1)}% of dropbacks, ${r.pointsPerGame.toFixed(1)} pts/game`;

const SCRIMMAGE: ReadonlySet<PlayResultType> = new Set<PlayResultType>(['run', 'pass', 'incomplete', 'sack', 'interception', 'fumble', 'touchdown', 'safety', 'scramble']);
const DROPBACK: ReadonlySet<PlayResultType> = new Set<PlayResultType>(['pass', 'incomplete', 'sack', 'interception', 'scramble']);
/** Plays that belong to a drive (scrimmage snaps and the fourth-down kicks that end one). */
const DRIVE_PLAY: ReadonlySet<PlayResultType> = new Set<PlayResultType>([...SCRIMMAGE, 'punt', 'fieldGoal', 'kneel', 'spike']);

/** Adds one finished game to the offense tallies of `side` (keyed by the offense). */
export const tallyOffense = (t: OffenseTally, state: Readonly<GameState>, side: TeamSide): void => {
  t.games += 1;
  t.points += state.score[side];
  let drive: PlayLogEntry[] = [];
  let before = 0;
  const closeDrive = (): void => {
    if (drive.length === 0) return;
    const last = drive[drive.length - 1] as PlayLogEntry;
    // A half ended by kneel-downs is not a possession anyone tried to score on.
    if (!drive.every((e) => e.outcome.result === 'kneel')) {
      t.drives += 1;
      if (last.scoreAfter[side] > before) t.scoringDrives += 1;
    }
    drive = [];
  };
  let prevScore = 0;
  let prevQuarter = 1;
  for (const e of state.playLog) {
    const o = e.outcome;
    const half = (q: number): number => (q <= 2 ? 1 : q <= 4 ? 2 : q);
    if (half(e.quarter) !== half(prevQuarter)) closeDrive();
    prevQuarter = e.quarter;
    const mine = e.possession === side && DRIVE_PLAY.has(o.result);
    if (!mine && DRIVE_PLAY.has(o.result)) closeDrive();
    if (mine) {
      if (drive.length === 0) before = prevScore;
      drive.push(e);
      if (SCRIMMAGE.has(o.result)) {
        t.plays += 1;
        t.yards += o.result === 'interception' ? 0 : o.yards;
        if (DROPBACK.has(o.result)) t.dropbacks += 1;
        if (o.result === 'sack') t.sacks += 1;
        if (o.result === 'interception') t.interceptions += 1;
        if (o.turnover && o.turnoverType !== 'downs') t.turnovers += 1;
        if (e.down === 3) {
          t.thirdAttempts += 1;
          if (o.firstDown || o.touchdown) t.thirdConversions += 1;
        }
      }
      if (o.turnover || o.touchdown || o.result === 'punt' || o.result === 'fieldGoal') closeDrive();
    }
    prevScore = e.scoreAfter[side];
  }
  closeDrive();
};

/** League entities, sorted team abbreviations and formation registries shared by every game. */
export interface UserGameEnv { entities: LeagueEntities; abbrs: string[]; registries: PlayRegistries }

/** League entities + playbook registries, built once (registerAll included). */
export const createUserGameEnv = (seed = 2026): UserGameEnv => {
  registerAll();
  const entities = generateLeagueEntities(seed, { year: 2026, salaryCap: 250_000_000 });
  const reg = loadPlaybookData();
  const abbrs = Object.values(entities.teams).map((t) => t.abbr).sort();
  return { entities, abbrs, registries: { offensiveFormations: reg.offensiveFormations, defensiveFormations: reg.defensiveFormations } };
};

const byId = <T extends { id: string }>(...lists: readonly (readonly T[])[]): Record<string, T> => {
  const out: Record<string, T> = {};
  for (const list of lists) for (const p of list) out[p.id] = p;
  return out;
};

/**
 * The setup of user game `index`. Games come in mirrored pairs: the same two clubs and the same seed, the user's club
 * home in the even game and away in the odd one, so neither side of the comparison gets the stronger roster.
 */
export const userGameSetup = (env: UserGameEnv, difficulty: DifficultyId, index: number, humanTeam: TeamSide | null): GameSetup => {
  const n = env.abbrs.length;
  const pair = Math.floor(index / 2);
  const home = env.abbrs[(pair * 5) % n] as string;
  const away = env.abbrs[(pair * 5 + 3) % n] as string;
  const base = quickSetup(env.entities, home, away, { rulesetId: 'arcade', seed: 7001 + pair * 97, difficultyId: difficulty, controllers: { home: 'ai', away: 'ai' } });
  return humanTeam ? { ...base, humanTeam } : base;
};

/** Plays one whole game live; throws if it does not finish. */
export const playLive = (env: UserGameEnv, setup: GameSetup, maxPlays = 500): GameState => {
  const controller = new GameController(setup, { coach: aiCoachHooks(setup), registries: env.registries });
  const plays: { offensePlays: Record<string, OffensivePlay>; defensePlays: Record<string, DefensivePlay> } = {
    offensePlays: byId(setup.home.offensePlays, setup.away.offensePlays), defensePlays: byId(setup.home.defensePlays, setup.away.defensePlays),
  };
  controller.start();
  let n = 0;
  while (!controller.isFinal) {
    if (n++ >= maxPlays) throw new Error(`user game exceeded ${maxPlays} plays`);
    const ctx = controller.beginPlay(null, null);
    const play = createPlayEngine(ctx, { registries: env.registries, plays });
    controller.completePlay(play.run(undefined, DEFAULT_MAX_TICKS));
  }
  return controller.state as GameState;
};

/** Both directions of `games` user games at one level, and how long they took. */
export interface DifficultyMeasure { cpuOffense: OffenseTally; userOffense: OffenseTally; ms: number }

/** Lets the worker answer the test runner between games (a minutes-long synchronous block trips its RPC timeout). */
const breathe = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** `games` user games at `difficulty` in mirrored pairs (the user's club home, then away). */
export const measureUserGames = async (env: UserGameEnv, difficulty: DifficultyId, games: number): Promise<DifficultyMeasure> => {
  const cpuOffense = emptyTally();
  const userOffense = emptyTally();
  const started = performance.now();
  for (let i = 0; i < games; i++) {
    const user: TeamSide = i % 2 === 0 ? 'home' : 'away';
    const state = playLive(env, userGameSetup(env, difficulty, i, user));
    tallyOffense(cpuOffense, state, otherSide(user));
    tallyOffense(userOffense, state, user);
    await breathe();
  }
  return { cpuOffense, userOffense, ms: performance.now() - started };
};
