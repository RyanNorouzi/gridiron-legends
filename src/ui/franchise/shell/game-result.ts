/**
 * Game-day bridges between a live game and the season engine:
 * - `userResultFromState` converts a FINAL GameState into the UserGameResult advanceLeagueWeek records (score,
 *   overtime, the game's stat lines, in-game injuries, weather, play-by-play and carried fatigue). With the game's
 *   setup every stat line is credited to the side its player dressed for (GameStats.playerTeams); without it the
 *   season engine stamps them when the result is recorded (week.ts recordUserGameResult builds the same setup);
 * - `simulateRestOfGame` finishes an abandoned game from its current state with the whole-game simulator (the
 *   play in progress, if any, is discarded; pending human decisions are answered like an AI coach would). Plays are
 *   called by both clubs' staffs, exactly like the league's simulated games (sim-real.ts staffPlaycaller).
 * Both work on copies: the session's state is never mutated. Headless.
 */
import type { PlayerId } from '@/core/ids';
import type { UserGameResult } from '@/franchise/season-loop';
import { staffPlaycaller } from '@/franchise/sim-real';
import { stampSetupTeams } from '@/franchise/sim-seam';
import { GameController } from '@/game/game-controller';
import { betweenPlayPhase } from '@/game/rules';
import type { GameSetup, GameState } from '@/game/types';
import { playbookRegistries, simulateToEnd, type SimulateGameOptions } from '@/simulation/game-sim';

/** Converts a finished game into the season engine's user result. Throws when the game is not final. */
export const userResultFromState = (state: Readonly<GameState>, setup?: Pick<GameSetup, 'home' | 'away'>): UserGameResult => {
  if (state.phase !== 'final') throw new Error(`userResultFromState: the game is not final (phase '${state.phase}')`);
  const fatigue: Record<PlayerId, number> = {};
  for (const [id, f] of Object.entries(state.fatigue) as [PlayerId, number][]) if (Number.isFinite(f) && f > 0) fatigue[id] = f;
  return {
    homeScore: state.score.home,
    awayScore: state.score.away,
    overtime: state.overtimePeriods > 0,
    stats: setup ? stampSetupTeams(structuredClone(state.stats), setup) : structuredClone(state.stats),
    injuries: state.injuries.map((i) => ({ ...i })),
    playLog: structuredClone(state.playLog),
    fatigue,
    weather: { ...state.weather },
    quarterLengthSec: state.ruleset.quarterLengthSec,
  };
};

/** Phases in which a play is in progress (between beginPlay and completePlay). */
const IN_PLAY: readonly GameState['phase'][] = ['presnap', 'live'];

/** A copy of `state` a fresh controller can resume: both sides AI, any play in progress rolled back. */
export const resumableState = (state: Readonly<GameState>): GameState => {
  const st = structuredClone(state) as GameState;
  st.controllers = { home: 'ai', away: 'ai' };
  if (IN_PLAY.includes(st.phase) || st.pendingDecision?.kind === 'penaltyDecision') {
    st.pendingDecision = null;
    st.phase = betweenPlayPhase(st);
    st.clock.playClockRunning = false;
  }
  return st;
};

/**
 * Plays the rest of a game with the whole-game simulator and returns the final state: the fast executor, and both
 * clubs' staffs (head coach + coordinators from the setup) calling the plays, as in every simulated league game.
 * `simOpts.playcaller` overrides only the parts it defines. A game that has not kicked off yet is simulated from the
 * start. Throws when the state cannot be resumed (callers fall back to simulating the whole game).
 */
export const simulateRestOfGame = (setup: GameSetup, state: Readonly<GameState>, simOpts: SimulateGameOptions = {}): GameState => {
  if (state.phase === 'final') return structuredClone(state) as GameState;
  const st = resumableState(state);
  const registries = simOpts.registries ?? playbookRegistries();
  const controller = new GameController({ ...setup, userSide: null, controllers: { home: 'ai', away: 'ai' } }, { state: st, registries, ...(simOpts.coach ? { coach: simOpts.coach } : {}) });
  return simulateToEnd(controller, { ...simOpts, registries, playcaller: { ...staffPlaycaller(setup), ...simOpts.playcaller } }).state;
};
