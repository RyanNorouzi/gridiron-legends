import type { PlaybookRegistry } from './loader';
import type { AudibleSet, DefensiveAudibleSet, DefensivePlay, OffensivePlay } from './types';

/** Pre-snap audibles: resolve an audible key to the play it points at, and suggest one given the look. */
export type AudibleKey = keyof AudibleSet;
export type DefensiveAudibleKey = keyof DefensiveAudibleSet;

const OFF_KEYS: readonly AudibleKey[] = ['manBeater', 'zoneBeater', 'blitzBeater', 'runToPass', 'passToRun'];
const DEF_KEYS: readonly DefensiveAudibleKey[] = ['manShift', 'zoneShift', 'blitz', 'spy'];
const RUN_TYPES = new Set<OffensivePlay['type']>(['run', 'qbRun', 'rpo']);

/** Audible keys a play actually defines. */
export const availableAudibles = (play: OffensivePlay): AudibleKey[] => OFF_KEYS.filter((k) => play.audibles?.[k] !== undefined);

export const availableDefensiveAudibles = (play: DefensivePlay): DefensiveAudibleKey[] => DEF_KEYS.filter((k) => play.audibles?.[k] !== undefined);

/**
 * Resolve an offensive audible to its target play. Returns null when the play has no such audible, the target
 * is unknown, or the target changes formation (personnel is already on the field).
 */
export const resolveAudible = (play: OffensivePlay, key: AudibleKey, registry: Pick<PlaybookRegistry, 'offensePlays'>): OffensivePlay | null => {
  const id = play.audibles?.[key];
  if (!id) return null;
  const target = registry.offensePlays[id];
  if (!target || target.id === play.id || target.formation !== play.formation) return null;
  return target;
};

export const resolveDefensiveAudible = (play: DefensivePlay, key: DefensiveAudibleKey, registry: Pick<PlaybookRegistry, 'defensePlays'>): DefensivePlay | null => {
  const id = play.audibles?.[key];
  if (!id) return null;
  const target = registry.defensePlays[id];
  if (!target || target.id === play.id || target.formation !== play.formation) return null;
  return target;
};

const isLightBox = (d: DefensivePlay): boolean => d.formation === 'dime' || d.formation === 'prevent' || d.tags.includes('prevent');
const isRunStop = (d: DefensivePlay): boolean => d.tags.includes('runStop') || d.formation === 'goalLine';

/**
 * Suggest the audible that best answers the defensive call, restricted to audibles the play defines.
 * Priority: blitz -> blitzBeater; run-stop look vs a run -> runToPass; light box vs a pass -> passToRun;
 * man -> manBeater; zone/match -> zoneBeater. Returns null when nothing applies.
 */
export const suggestAudible = (play: OffensivePlay, defensivePlay: DefensivePlay): AudibleKey | null => {
  const has = (k: AudibleKey): boolean => play.audibles?.[k] !== undefined;
  const isRun = RUN_TYPES.has(play.type);
  if (defensivePlay.blitz !== 'none' && has('blitzBeater')) return 'blitzBeater';
  if (isRun && isRunStop(defensivePlay) && has('runToPass')) return 'runToPass';
  if (!isRun && isLightBox(defensivePlay) && has('passToRun')) return 'passToRun';
  if (!isRun && defensivePlay.coverage === 'cover0' && has('blitzBeater')) return 'blitzBeater';
  if (defensivePlay.family === 'man' && has('manBeater')) return 'manBeater';
  if ((defensivePlay.family === 'zone' || defensivePlay.family === 'match') && has('zoneBeater')) return 'zoneBeater';
  return null;
};

/**
 * Defensive counterpart: vs a run look -> blitz (run blitz), vs a mobile-QB run -> spy, vs empty/spread pass
 * -> zoneShift, vs heavy personnel -> manShift. Only keys the play defines are returned.
 */
export const suggestDefensiveAudible = (play: DefensivePlay, offensivePlay: OffensivePlay, formationPersonnel?: string): DefensiveAudibleKey | null => {
  const has = (k: DefensiveAudibleKey): boolean => play.audibles?.[k] !== undefined;
  if (offensivePlay.type === 'qbRun' && has('spy')) return 'spy';
  if (RUN_TYPES.has(offensivePlay.type) && has('blitz')) return 'blitz';
  const personnel = formationPersonnel ?? '';
  if ((offensivePlay.formation === 'empty' || personnel === '00' || personnel === '10') && has('zoneShift')) return 'zoneShift';
  if ((personnel === '22' || personnel === '23' || personnel === '13') && has('manShift')) return 'manShift';
  if (offensivePlay.dropback !== undefined && offensivePlay.dropback >= 7 && has('blitz')) return 'blitz';
  return null;
};
