/**
 * Lazily loaded game bundle (split from the boot chunk): the game session executors (play engine, AI, fast
 * sim, rules), the Game screen with replays and highlights, and the Quick Game / Custom Game setup screens.
 * `ensureAiRegistered` runs once the bundle is loaded, before any session can create a live play.
 */
export { createDefaultSession, ensureAiRegistered } from '../game/session-defaults';
export { GameScreen } from '../screens/game';
export { QuickGameSetupScreen } from '../screens/quick-game-setup';
export { CustomGameScreen } from '../screens/custom-game';
