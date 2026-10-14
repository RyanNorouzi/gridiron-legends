/**
 * Saving a franchise game in progress (so a reload or a closed tab cannot throw the game away and let the user
 * replay a loss from 0-0): the scheduled game a saved mid-game state belongs to, and a page-hide hook that
 * flushes the autosaver when the browser tab is hidden or closed. The live state itself travels through
 * FranchiseContext.saveLiveGame into the autosaver's `game()` source.
 */
import type { TeamId } from '@/core/ids';
import type { League, ScheduledGame } from '@/franchise/types';
import type { GameState } from '@/game/types';

/**
 * The unplayed scheduled game of the user's team a saved mid-game state belongs to; null when the state is final,
 * the game was already recorded, or it is not the user's game (a stale state is then simply dropped).
 */
export const resumableGameFor = (league: League, state: Readonly<GameState> | null | undefined, userTeamId: TeamId): ScheduledGame | null => {
  if (!state || state.phase === 'final') return null;
  const game = league.season.schedule.find((g) => g.id === state.id) ?? null;
  if (!game || game.result !== null) return null;
  if (game.home !== userTeamId && game.away !== userTeamId) return null;
  if (game.home !== state.home || game.away !== state.away) return null;
  return game;
};

/** "ATL 14 - BUF 10, Q3 8:12" for the resume prompt. */
export const liveGameSummary = (league: League, state: Readonly<GameState>): string => {
  const abbr = (id: TeamId): string => league.teams[id]?.abbr ?? '???';
  const secs = Math.max(0, Math.round(state.clock.secondsRemaining));
  const clock = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
  const period = state.overtime ? 'OT' : `Q${state.clock.quarter}`;
  return `${abbr(state.away)} ${state.score.away} - ${abbr(state.home)} ${state.score.home}, ${period} ${clock}`;
};

/**
 * Calls `flush` when the page is hidden or unloaded (tab switch, close, reload), so the last marks reach storage.
 * Returns the detach function; a no-op outside a browser.
 */
export const flushOnPageHide = (flush: () => void): (() => void) => {
  if (typeof document === 'undefined' || typeof window === 'undefined') return () => undefined;
  const onVisibility = (): void => { if (document.visibilityState === 'hidden') flush(); };
  window.addEventListener('pagehide', flush);
  document.addEventListener('visibilitychange', onVisibility);
  return () => {
    window.removeEventListener('pagehide', flush);
    document.removeEventListener('visibilitychange', onVisibility);
  };
};
