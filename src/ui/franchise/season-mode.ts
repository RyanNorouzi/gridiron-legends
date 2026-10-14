/**
 * Season mode: one season with your team and no offseason. The wizard (NewFranchiseScreen in 'season' mode)
 * creates the league; the hub runs in 'season' mode: the same tabs and game days, Advance offers only this
 * season's weeks and "sim to" points, and once the champion is crowned the season summary (champion, your record
 * and playoff finish, the awards) closes the mode. With a save system the season gets its own save slot (mode
 * 'season'), autosaved like a franchise, so it can be continued from the Franchise menu after a reload.
 */
import type { League } from '@/franchise/types';
import type { GameState } from '@/game/types';
import type { SaveSystem } from '@/save/index';
import type { ScreenServices } from '../screens/screen';
import { FranchiseHubScreen, type FranchiseHubOptions } from './hub';
import { NewFranchiseScreen } from './new-franchise';
import { modeSaveName, nextSlotId, saveErrorText } from './shell/save-model';

/** Options of Season mode. */
export type SeasonModeOptions = Omit<FranchiseHubOptions, 'mode' | 'slot' | 'saveSystem' | 'league' | 'resumeGame'> & {
  /** Save system for the season's slot (absent = the season is not saved). */
  saves?: SaveSystem | null;
};

/** The hub of a Season-mode league (saved to `slot` when given, resuming `resumeGame` when one was left in progress). */
export const createSeasonHub = (league: League, opts: SeasonModeOptions, slot: string | null = null, resumeGame: GameState | null = null): FranchiseHubScreen => {
  const { saves, ...hubOpts } = opts;
  return new FranchiseHubScreen({ ...hubOpts, league, mode: 'season', slot: saves && slot ? slot : null, saveSystem: saves && slot ? saves : null, resumeGame });
};

/** Options of startSeasonMode. */
export interface StartSeasonOptions extends SeasonModeOptions {
  /** League seed for the wizard (default: the clock). */
  seed?: () => number;
  /** Called with the hub right before it is pushed (the app keeps a handle for popTo). */
  onHub?(hub: FranchiseHubScreen): void;
}

/** Writes a new season to a fresh slot (mode 'season'); resolves the slot id, or null when saving failed. */
export const saveNewSeason = async (saves: SaveSystem, league: League): Promise<string | null> => {
  const metas = await saves.slots.list();
  const team = league.userTeamId ? league.teams[league.userTeamId] : undefined;
  const meta = await saves.slots.save(nextSlotId(metas, 'season'), league, null, { mode: 'season', name: modeSaveName(team, league.year, 'season') });
  return meta.id;
};

/**
 * Pushes the Season-mode wizard; when the league is created the wizard is replaced by the season hub (saved to its
 * own slot when a save system is given). Leaving the hub runs `opts.onExit`.
 */
export const startSeasonMode = (services: ScreenServices, opts: StartSeasonOptions): NewFranchiseScreen => {
  const wizard = new NewFranchiseScreen({
    mode: 'season',
    ...(opts.seed ? { seed: opts.seed } : {}),
    onCreate: (league) => {
      const stack = services.stack;
      const open = (slot: string | null): void => {
        if (stack.all.includes(wizard)) {
          stack.popTo(wizard);
          stack.pop();
        }
        const hub = createSeasonHub(league, opts, slot);
        opts.onHub?.(hub);
        stack.push(hub);
      };
      const saves = opts.saves;
      if (!saves) return open(null);
      saveNewSeason(saves, league).then(open).catch((err: unknown) => {
        services.toast(saveErrorText(err, 'Saving the new season'));
        open(null);
      });
    },
  });
  services.stack.push(wizard);
  return wizard;
};
