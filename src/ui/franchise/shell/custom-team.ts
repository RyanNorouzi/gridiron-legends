/**
 * Custom-team model for the new-franchise wizard: a draft (city, name, three-letter abbreviation, primary and
 * secondary colour from a fixed palette, logo seed and the bundled team whose slot it takes over), validation
 * (names present, abbreviation free, colours distinguishable for normal vision AND every colorblind mode), the
 * conversion to the engine's CustomTeamSpec and the post-creation logo-seed patch (CustomTeamSpec has no logo
 * field, so the chosen seed is applied to the created League). Pure.
 */
import type { TeamId } from '@/core/ids';
import type { ColorblindMode } from '@/core/settings';
import type { CustomTeamSpec } from '@/franchise/league';
import type { League } from '@/franchise/types';
import type { Team, TeamColors } from '@/teams/types';
import { contrastRatio, isConfusable, textColorOn } from '../../render/palette';
import { cycleIndex } from '../kit/list';

/** One palette colour. */
export interface PaletteColor {
  id: string;
  name: string;
  hex: string;
}

/** Colours offered for custom teams (dark to light, varied hues). */
export const TEAM_PALETTE: readonly PaletteColor[] = Object.freeze([
  { id: 'navy', name: 'Navy', hex: '#1b2a5c' }, { id: 'royal', name: 'Royal', hex: '#2456c8' }, { id: 'sky', name: 'Sky', hex: '#5fa8e8' },
  { id: 'teal', name: 'Teal', hex: '#11807a' }, { id: 'forest', name: 'Forest', hex: '#1f5a2e' }, { id: 'kelly', name: 'Kelly', hex: '#2e9e44' },
  { id: 'lime', name: 'Lime', hex: '#a6d13a' }, { id: 'gold', name: 'Gold', hex: '#f0b429' }, { id: 'orange', name: 'Orange', hex: '#e8702a' },
  { id: 'red', name: 'Red', hex: '#c8242c' }, { id: 'maroon', name: 'Maroon', hex: '#6e1a2a' }, { id: 'purple', name: 'Purple', hex: '#5a2a8c' },
  { id: 'pink', name: 'Pink', hex: '#e86aa8' }, { id: 'brown', name: 'Brown', hex: '#6b4423' }, { id: 'silver', name: 'Silver', hex: '#a8adb4' },
  { id: 'black', name: 'Black', hex: '#15161c' }, { id: 'white', name: 'White', hex: '#f1f1ea' }, { id: 'cream', name: 'Cream', hex: '#efe3c2' },
]);

/** Modes the colour check covers. */
export const CHECK_MODES: readonly ColorblindMode[] = ['none', 'protanopia', 'deuteranopia', 'tritanopia'];

/** An in-progress custom team. */
export interface CustomTeamDraft {
  city: string;
  name: string;
  abbr: string;
  /** TEAM_PALETTE ids. */
  primary: string;
  secondary: string;
  logoSeed: number;
  /** Abbreviation of the bundled team whose slot (division, stadium, market, roster) the team takes. */
  replaces: string;
}

/** Hex of a palette id (the first colour for unknown ids). */
export const paletteHex = (id: string): string => (TEAM_PALETTE.find((p) => p.id === id) ?? TEAM_PALETTE[0] as PaletteColor).hex;
/** Name of a palette id. */
export const paletteName = (id: string): string => (TEAM_PALETTE.find((p) => p.id === id) ?? TEAM_PALETTE[0] as PaletteColor).name;

/** Next / previous palette id. */
export const cyclePalette = (id: string, delta: number): string => {
  const i = Math.max(0, TEAM_PALETTE.findIndex((p) => p.id === id));
  return (TEAM_PALETTE[cycleIndex(i, delta, TEAM_PALETTE.length)] as PaletteColor).id;
};

/** Logo seeds wrap in 1..9999. */
export const cycleLogoSeed = (seed: number, delta: number): number => (((Math.round(seed) - 1 + delta) % 9999) + 9999) % 9999 + 1;

/** A starting draft that takes over the first team (sorted by city). */
export const defaultDraft = (teams: readonly Team[]): CustomTeamDraft => {
  const first = [...teams].sort((a, b) => a.city.localeCompare(b.city))[0];
  return { city: 'Riverport', name: 'Comets', abbr: 'RVC', primary: 'teal', secondary: 'gold', logoSeed: 4242, replaces: first?.abbr ?? '' };
};

/** Full TeamColors for a draft (helmet = primary, accent = readable text colour on the primary). */
export const draftColors = (d: Pick<CustomTeamDraft, 'primary' | 'secondary'>): TeamColors => {
  const primary = paletteHex(d.primary);
  return { primary, secondary: paletteHex(d.secondary), accent: textColorOn(primary), helmet: primary };
};

/** Colour-check result per vision mode. */
export interface ColorCheck {
  mode: ColorblindMode;
  ok: boolean;
}

/** Whether primary and secondary stay distinguishable under every vision mode (and have some contrast). */
export const colorChecks = (d: Pick<CustomTeamDraft, 'primary' | 'secondary'>): ColorCheck[] => {
  const a = paletteHex(d.primary);
  const b = paletteHex(d.secondary);
  const lowContrast = contrastRatio(a, b) < 1.3;
  return CHECK_MODES.map((mode) => ({ mode, ok: !lowContrast && !isConfusable(a, b, mode) }));
};

/** Every problem with a draft (empty = the team can be created). */
export const draftErrors = (d: CustomTeamDraft, teams: readonly Team[]): string[] => {
  const errors: string[] = [];
  if (!d.city.trim()) errors.push('Enter a city');
  if (!d.name.trim()) errors.push('Enter a team name');
  const abbr = d.abbr.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(abbr)) errors.push('The abbreviation needs 3 letters');
  const target = teams.find((t) => t.abbr === d.replaces);
  if (!target) errors.push('Choose the team slot to take over');
  if (teams.some((t) => t.abbr === abbr && t.abbr !== d.replaces)) errors.push(`${abbr} is already used`);
  if (d.primary === d.secondary) errors.push('Pick two different colours');
  else if (colorChecks(d).some((c) => !c.ok)) errors.push('Colours are hard to tell apart');
  return errors;
};

/** The engine spec for a draft. */
export const draftToSpec = (d: CustomTeamDraft): CustomTeamSpec => ({
  replaces: d.replaces, city: d.city.trim(), name: d.name.trim(), abbr: d.abbr.trim().toUpperCase(), colors: draftColors(d),
});

/** The League with a team's logo seed replaced (new objects; the input is untouched). */
export const applyLogoSeed = (league: League, teamId: TeamId, logoSeed: number): League => {
  const team = league.teams[teamId];
  if (!team || team.logoSeed === logoSeed) return league;
  return { ...league, teams: { ...league.teams, [teamId]: { ...team, logoSeed } } };
};
