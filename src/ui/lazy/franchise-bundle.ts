/**
 * Lazily loaded franchise bundle: the franchise hub and its tabs, the franchise chooser / loader, the league
 * wizard, Season and Playoffs modes, and save-slot helpers.
 */
export { ensureAiRegistered } from '../game/session-defaults';
export { FranchiseHubScreen } from '../franchise/hub';
export { FranchiseMenuScreen, LoadFranchiseScreen } from '../franchise/load-franchise';
export { NewFranchiseScreen } from '../franchise/new-franchise';
export { PlayoffsModeScreen } from '../franchise/playoffs-mode';
export { createSeasonHub, startSeasonMode } from '../franchise/season-mode';
export { modeSaveName, nextSlotId, saveErrorText } from '../franchise/shell/save-model';
