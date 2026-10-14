/**
 * The real whole-game simulator behind the season engine's GameSimulator seam: every snap of every league
 * game runs through simulation/game-sim.ts `simulateGame` (GameController + the fast play executor), and the
 * finished GameState is mapped onto the seam's GameSimResult: final score, overtime flag, the game's stat
 * lines, in-game injuries, the weather the game was played in, end-of-game fatigue and (only when the season
 * engine keeps it: user-team and playoff games) the play-by-play. Deterministic per setup.seed.
 *
 * sim-fallback.ts stays available as the fast rating-only model for tests (pass it explicitly).
 */
import type { PlayerId } from '@/core/ids';
import type { PlayRegistries } from '@/game/play-context';
import type { GameSetup } from '@/game/types';
import { playbookRegistries, simulateGame, type GameSimResult as FullGameSim, type SimulateGameOptions } from '@/simulation/game-sim';
import { createSimPlaycaller, type Playcaller } from '@/simulation/playcaller';
import { stampSetupTeams, type GameSimOptions, type GameSimResult, type GameSimulator } from './sim-seam';

let cachedRegistries: PlayRegistries | null = null;
/** Bundled formation registries, loaded once per process (the playbook data never changes at runtime). */
const registries = (): PlayRegistries => (cachedRegistries ??= playbookRegistries());

/** Fatigue entries worth carrying (drops the zeros of players who never took the field). */
const carriedFatigue = (fatigue: Readonly<Record<PlayerId, number>>): Record<PlayerId, number> => {
  const out: Record<PlayerId, number> = {};
  for (const [id, f] of Object.entries(fatigue) as [PlayerId, number][]) if (Number.isFinite(f) && f > 0) out[id] = f;
  return out;
};

/** Maps a finished whole-game simulation onto the seam's result (copies; the GameState is not shared). With the
 *  setup, every stat line is credited to the side its player dressed for (GameStats.playerTeams). */
export const toSeamResult = (sim: FullGameSim, opts: GameSimOptions = {}, setup?: Pick<GameSetup, 'home' | 'away'>): GameSimResult => {
  const { state, result } = sim;
  return {
    homeScore: result.homeScore,
    awayScore: result.awayScore,
    overtime: result.overtime,
    stats: setup ? stampSetupTeams(result.stats, setup) : result.stats,
    injuries: result.injuries.map((i) => ({ ...i })),
    weather: { ...state.weather },
    fatigue: carriedFatigue(state.fatigue),
    ...(opts.keepPlayLog ? { playLog: state.playLog } : {}),
  };
};

/** The league playcaller for a game: both clubs' staffs (head coach + coordinators from the setup). */
export const staffPlaycaller = (setup: Pick<GameSetup, 'home' | 'away'>): Playcaller => createSimPlaycaller({ home: setup.home, away: setup.away });

/**
 * A real-simulator GameSimulator with custom simulateGame options (playcaller, executor, maxPlays...). Whatever an
 * injected playcaller leaves out is called by both clubs' staffs (createSimPlaycaller with each side's head coach and
 * coordinators from the setup), so coaching tendencies show up in league results.
 */
export const createRealGameSimulator = (simOpts: SimulateGameOptions = {}): GameSimulator => (setup: GameSetup, opts: GameSimOptions = {}): GameSimResult =>
  toSeamResult(simulateGame(setup, {
    ...simOpts,
    // An injected (possibly partial) playcaller overrides only the parts it defines; the rest stays the staffs'.
    playcaller: { ...staffPlaycaller(setup), ...simOpts.playcaller },
    registries: simOpts.registries ?? registries(),
  }), opts, setup);

/** The default league simulator: every game played snap by snap by simulation/game-sim.ts (~0.5 s per game). */
export const realGameSimulator: GameSimulator = createRealGameSimulator();
