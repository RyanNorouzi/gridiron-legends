/**
 * Game facts the world art shows but the field scene does not carry (the down on the chain crew's down box, the
 * score and quarter on the stadium scoreboard). A screen that knows them (game.ts) may publish them each frame with
 * `setWorldGameInfo`; without them the down box and scoreboard show neutral content. Render-only state.
 */

/** Facts shown by the sideline down box and the scoreboard. */
export interface WorldGameInfo {
  down?: number | null;
  quarter?: number | null;
  homeScore?: number | null;
  awayScore?: number | null;
}

let info: WorldGameInfo | null = null;

/** Publishes the current game facts (null clears them). */
export const setWorldGameInfo = (next: WorldGameInfo | null): void => {
  info = next;
};

/** The current game facts, if a screen published them. */
export const worldGameInfo = (): WorldGameInfo | null => info;
