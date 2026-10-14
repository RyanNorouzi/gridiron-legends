/**
 * New-league settings for the franchise / season / playoffs wizards: difficulty, ruleset and quarter length,
 * penalties and coach's challenges, the injury / fatigue / weather toggles, the playoff format (teams per
 * conference; byes and round names follow) and a salary-cap preset, as menu items with Left/Right cycling, plus the
 * conversion to LeagueSettingsOverrides and `buildNewLeague` (createLeague with a bundled or custom user team;
 * the custom logo seed is patched in afterwards). Pure.
 */
import { SEASON_CONFIG, conferenceRoundCount, defaultLeagueSettings, requiredByes, type LeagueSettingsOverrides } from '@/franchise/settings';
import { createLeague } from '@/franchise/league';
import type { League, LeagueSettings, PlayoffFormat } from '@/franchise/types';
import { DIFFICULTY_IDS, getDifficulty, getRuleset } from '@/game/rulesets';
import type { DifficultyId, Ruleset } from '@/game/types';
import { tunedDifficulty, withQuarterLength, type DifficultyTweak, type GameplayPrefs } from '../../gameplay-prefs';
import type { MenuItem } from '../../widgets/menu';
import { cycleOption } from '../kit/list';
import { formatMoney } from '../kit/format';
import { applyLogoSeed, draftToSpec, type CustomTeamDraft } from './custom-team';

/** Salary-cap presets relative to the default cap. */
export type CapPreset = 'tight' | 'standard' | 'loose';
/** Cap presets in menu order. */
export const CAP_PRESETS: readonly CapPreset[] = ['tight', 'standard', 'loose'];
/** Multiplier on the default cap per preset. */
export const CAP_FACTORS: Readonly<Record<CapPreset, number>> = Object.freeze({ tight: 0.9, standard: 1, loose: 1.15 });

/** Ruleset presets the wizard offers. */
export type RulesetChoice = 'arcade' | 'simulation';
/** Ruleset presets in menu order. */
export const RULESET_CHOICES: readonly RulesetChoice[] = ['arcade', 'simulation'];
/** Quarter lengths (minutes) the wizard cycles through. */
export const LEAGUE_QUARTER_MINUTES: readonly number[] = [2, 3, 4, 5, 6, 8, 10, 12, 15];

/** Playoff teams per conference the wizard offers (byes and rounds follow from the count). */
export const PLAYOFF_TEAM_CHOICES: readonly number[] = [1, 2, 4, 6, 7, 8];

/** The wizard's league settings. */
export interface NewLeagueChoice {
  difficulty: DifficultyId;
  ruleset: RulesetChoice;
  quarterMinutes: number;
  injuries: boolean;
  fatigue: boolean;
  weather: boolean;
  cap: CapPreset;
  /** Flags on / off (absent = the ruleset's default). */
  penalties?: boolean;
  /** Coach's challenges on / off (absent = the ruleset's default). */
  challenges?: boolean;
  /** Playoff teams per conference (absent = the data-file default, 7). */
  playoffTeams?: number;
  /** Difficulty tuning carried from the gameplay preferences (absent = the preset). */
  tweaks?: Partial<Record<DifficultyTweak, number>>;
}

/** Fields of the settings form. */
export type SettingsField = 'difficulty' | 'ruleset' | 'quarter' | 'penalties' | 'challenges' | 'injuries' | 'fatigue' | 'weather' | 'playoffs' | 'cap';
/** Settings fields in menu order. */
export const SETTINGS_FIELDS: readonly SettingsField[] = ['difficulty', 'ruleset', 'quarter', 'penalties', 'challenges', 'injuries', 'fatigue', 'weather', 'playoffs', 'cap'];

const ROUND_NAMES_FROM_FINAL: readonly string[] = ['Championship', 'Conference Championship', 'Divisional', 'Wild Card', 'First Round', 'Opening Round'];

/**
 * The playoff format for `teams` per conference: the byes a single-elimination bracket needs and one name per
 * round (the last round is the Championship when there are two conferences).
 */
export const playoffFormatFor = (teams: number, conferences = 2): PlayoffFormat => {
  const rounds = conferenceRoundCount(teams) + (conferences > 1 ? 1 : 0);
  const names = (conferences > 1 ? ROUND_NAMES_FROM_FINAL : ROUND_NAMES_FROM_FINAL.slice(1)).slice(0, rounds);
  while (names.length < rounds) names.push(`Round ${rounds - names.length}`);
  return { teamsPerConference: teams, byesPerConference: requiredByes(teams), roundNames: [...names].reverse() };
};

/** Short description of a playoff size ("7 per conference, 1 bye"). */
export const playoffLabel = (teams: number): string => {
  const byes = requiredByes(teams);
  return `${teams} per conf${byes > 0 ? `, ${byes} bye${byes === 1 ? '' : 's'}` : ''}`;
};

/** Defaults: the data-file settings (simulation rules, Pro, everything on, standard cap). */
export const defaultNewLeagueChoice = (): NewLeagueChoice => {
  const s = defaultLeagueSettings();
  const ruleset: RulesetChoice = s.ruleset.mode === 'arcade' ? 'arcade' : 'simulation';
  return {
    difficulty: s.difficulty.id, ruleset, quarterMinutes: Math.round(s.ruleset.quarterLengthSec / 60), injuries: s.injuriesEnabled, fatigue: s.fatigueEnabled, weather: s.weatherEnabled, cap: 'standard',
    penalties: s.ruleset.penalties, challenges: s.ruleset.challenges, playoffTeams: s.playoff.teamsPerConference,
  };
};

/** The wizard's starting values from the gameplay preferences (style, difficulty + tuning, quarter, switches). */
export const choiceFromGameplay = (g: GameplayPrefs): NewLeagueChoice => {
  const base = defaultNewLeagueChoice();
  return {
    ...base, difficulty: g.difficulty, ruleset: g.ruleset, quarterMinutes: g.quarterMinutes, injuries: g.injuries, fatigue: g.fatigue, weather: g.weather,
    penalties: g.penalties, tweaks: { ...g.tweaks },
  };
};

/** The default league cap scaled by a preset (whole $100K). */
export const capForPreset = (preset: CapPreset): number => Math.round((defaultLeagueSettings().salaryCap * CAP_FACTORS[preset]) / 1e5) * 1e5;

/** LeagueSettingsOverrides for a choice (the ruleset carries the quarter length; toggles are copied by the engine). */
export const settingsOverrides = (c: NewLeagueChoice): LeagueSettingsOverrides => ({
  ruleset: choiceRuleset(c),
  difficultyId: c.difficulty,
  ...(c.tweaks && Object.keys(c.tweaks).length > 0 ? { difficulty: tunedDifficulty(getDifficulty(c.difficulty), c.tweaks) } : {}),
  ...(c.playoffTeams !== undefined ? { playoff: playoffFormatFor(c.playoffTeams, defaultLeagueSettings().conferences.length) } : {}),
  injuriesEnabled: c.injuries,
  fatigueEnabled: c.fatigue,
  weatherEnabled: c.weather,
  salaryCap: capForPreset(c.cap),
});

/** The ruleset a choice plays under (preset + quarter length + the penalty / challenge switches). */
export const choiceRuleset = (c: NewLeagueChoice): Ruleset => {
  const r: Ruleset = withQuarterLength(getRuleset(c.ruleset), c.quarterMinutes, 60);
  if (c.penalties !== undefined) r.penalties = c.penalties;
  if (c.challenges !== undefined) {
    r.challenges = c.challenges;
    if (c.challenges && r.challengesPerGame < 1) r.challengesPerGame = 2;
  }
  return r;
};

const onOff = (v: boolean): string => (v ? 'On' : 'Off');

/** Menu items of the settings form (values shown right-aligned; Left/Right change them). */
export const settingsItems = (c: NewLeagueChoice): MenuItem[] => [
  { id: 'difficulty', label: 'Difficulty', value: getDifficulty(c.difficulty).name },
  { id: 'ruleset', label: 'Rules', value: c.ruleset === 'arcade' ? 'Arcade' : 'Simulation' },
  { id: 'quarter', label: 'Quarter length', value: `${c.quarterMinutes} min` },
  { id: 'penalties', label: 'Penalties', value: onOff(c.penalties ?? getRuleset(c.ruleset).penalties) },
  { id: 'challenges', label: 'Challenges', value: onOff(c.challenges ?? getRuleset(c.ruleset).challenges) },
  { id: 'injuries', label: 'Injuries', value: onOff(c.injuries) },
  { id: 'fatigue', label: 'Fatigue', value: onOff(c.fatigue) },
  { id: 'weather', label: 'Weather', value: onOff(c.weather) },
  { id: 'playoffs', label: 'Playoffs', value: playoffLabel(c.playoffTeams ?? defaultLeagueSettings().playoff.teamsPerConference) },
  { id: 'cap', label: 'Salary cap', value: `${c.cap === 'standard' ? 'Standard' : c.cap === 'tight' ? 'Tight' : 'Loose'} ${formatMoney(capForPreset(c.cap))}` },
];

/** A copy of the choice with one field stepped. Changing the rules resets the quarter length, penalties and challenges to their defaults. */
export const changeSetting = (c: NewLeagueChoice, field: SettingsField, delta: number): NewLeagueChoice => {
  switch (field) {
    case 'difficulty': return { ...c, difficulty: cycleOption(DIFFICULTY_IDS, c.difficulty, delta) };
    case 'ruleset': {
      const ruleset = cycleOption(RULESET_CHOICES, c.ruleset, delta);
      const preset = getRuleset(ruleset);
      return { ...c, ruleset, quarterMinutes: Math.round(preset.quarterLengthSec / 60), penalties: preset.penalties, challenges: preset.challenges };
    }
    case 'quarter': {
      const list = LEAGUE_QUARTER_MINUTES.includes(c.quarterMinutes) ? LEAGUE_QUARTER_MINUTES : [...LEAGUE_QUARTER_MINUTES, c.quarterMinutes].sort((a, b) => a - b);
      return { ...c, quarterMinutes: cycleOption(list, c.quarterMinutes, delta) };
    }
    case 'penalties': return { ...c, penalties: !(c.penalties ?? getRuleset(c.ruleset).penalties) };
    case 'challenges': return { ...c, challenges: !(c.challenges ?? getRuleset(c.ruleset).challenges) };
    case 'playoffs': return { ...c, playoffTeams: cycleOption(PLAYOFF_TEAM_CHOICES, c.playoffTeams ?? defaultLeagueSettings().playoff.teamsPerConference, delta) };
    case 'injuries': return { ...c, injuries: !c.injuries };
    case 'fatigue': return { ...c, fatigue: !c.fatigue };
    case 'weather': return { ...c, weather: !c.weather };
    case 'cap': return { ...c, cap: cycleOption(CAP_PRESETS, c.cap, delta) };
  }
};

/** What the wizard hands to buildNewLeague. */
export interface NewLeagueRequest {
  seed: number;
  choice: NewLeagueChoice;
  /** A bundled team (by abbreviation) ... */
  teamAbbr?: string;
  /** ... or a custom team. */
  custom?: CustomTeamDraft;
  name?: string;
}

/** Creates the League for a wizard request. Throws when neither a team nor a custom team is given. */
export const buildNewLeague = (req: NewLeagueRequest): League => {
  if (!req.teamAbbr && !req.custom) throw new Error('buildNewLeague: choose a team or create one');
  const settings = settingsOverrides(req.choice);
  const league = createLeague({
    seed: req.seed, settings, name: req.name ?? SEASON_CONFIG.defaultLeagueName,
    ...(req.custom ? { customTeam: draftToSpec(req.custom) } : { userTeamAbbr: req.teamAbbr as string }),
  });
  return req.custom && league.userTeamId ? applyLogoSeed(league, league.userTeamId, req.custom.logoSeed) : league;
};

/** Fields the hub's LEAGUE RULES form edits on an existing league (structure, cap and playoffs stay fixed). */
export const RULE_FIELDS: readonly SettingsField[] = ['difficulty', 'ruleset', 'quarter', 'penalties', 'challenges', 'injuries', 'fatigue', 'weather'];

/** The form values of an existing league's game rules. */
export const choiceFromLeague = (s: LeagueSettings): NewLeagueChoice => ({
  ...defaultNewLeagueChoice(),
  difficulty: s.difficulty.id,
  ruleset: s.ruleset.mode === 'arcade' ? 'arcade' : 'simulation',
  quarterMinutes: Math.round(s.ruleset.quarterLengthSec / 60),
  penalties: s.ruleset.penalties,
  challenges: s.ruleset.challenges,
  injuries: s.injuriesEnabled,
  fatigue: s.fatigueEnabled,
  weather: s.weatherEnabled,
});

/**
 * A copy of the League with new game rules for every game from now on: play style (ruleset preset), quarter length,
 * penalties, challenges, the injury / fatigue / weather switches (mirrored into the ruleset as the engine reads
 * only the Ruleset) and the difficulty. A custom-tuned difficulty is kept while its preset is unchanged.
 */
export const withGameRules = (league: League, c: NewLeagueChoice): League => {
  const prev = league.settings;
  const ruleset = { ...choiceRuleset(c), injuries: c.injuries, fatigue: c.fatigue };
  const difficulty = prev.difficulty.id === c.difficulty ? { ...prev.difficulty } : c.tweaks ? tunedDifficulty(getDifficulty(c.difficulty), c.tweaks) : getDifficulty(c.difficulty);
  return { ...league, settings: { ...prev, ruleset, difficulty, injuriesEnabled: c.injuries, fatigueEnabled: c.fatigue, weatherEnabled: c.weather } };
};
