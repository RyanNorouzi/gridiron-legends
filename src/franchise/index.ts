/**
 * Franchise season engine: settings, league creation, schedule, standings, playoffs, game setup, the
 * simulation seam (real whole-game simulator + rating-based fallback), week advance, phase machine, history, the
 * game loop (season-loop.ts), roster rules for phase moves and the offseason news adapter. Other franchise
 * modules (contracts, market, draft, club layer) export from their own files.
 */
export type * from './types';
export { SEASON_PHASE_ORDER } from './types';
export * from './settings';
export * from './league';
export * from './schedule';
export * from './standings';
export * from './playoffs';
export * from './game-setup';
export * from './sim-seam';
export * from './sim-fallback';
export * from './sim-real';
export * from './week';
export * from './phase';
export * from './history';
export * from './season-loop';
export * from './roster-rules';
export * from './offseason-events';
