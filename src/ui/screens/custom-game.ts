/**
 * Custom game: a quick game with every rule exposed. Both teams, who controls each side (HUMAN plays it, AI
 * plays it, WATCH spectates it with jump-in; only one side can be human or watched, AI vs AI is spectated),
 * difficulty, the base rules (arcade / simulation, which reset every field below), quarter length, play clock,
 * penalties and their frequency, injuries, fatigue, the overtime format, coach's challenges, two-minute warning,
 * weather type (or the stadium's climate) and the defense-control mode. Left/Right (or a tap / Confirm) change
 * the highlighted value; START GAME builds the GameSetup (`buildCustomGameSetup`, pure) and hands it to onStart.
 */
import { createRng } from '@/core/rng';
import type { DefenseMode } from '@/core/settings';
import { DIFFICULTY_IDS, getDifficulty, getRuleset } from '@/game/rulesets';
import type { DifficultyId, GameSetup, Ruleset, TeamSide, WeatherType } from '@/game/types';
import { WEATHER_TYPES, clearWeather, sampleWeather } from '@/game/weather';
import type { LeagueEntities } from '@/teams/league-generator';
import type { Team } from '@/teams/types';
import { cycleOption } from '../franchise/kit/list';
import { humanize } from '../franchise/kit/format';
import { drawTeamBadge, hintBarHeight, refitMenu, rowsThatFit } from '../franchise/shell/widgets';
import type { InputState } from '../input/types';
import { MenuList, type MenuItem } from '../widgets/menu';
import { drawHintBar, drawPanel } from '../widgets/panel';
import { drawScreenBackdrop } from '../widgets/title-backdrop';
import { drawScreenTitle, drawVersusBadge } from '../widgets/headers';
import type { ArtCtx } from '../widgets/ui-art';
import { setupHints } from '../widgets/setup-hints';
import { difficultyBlurb, withQuarterLength, type GameplayPrefs } from '../gameplay-prefs';
import { buildQuickGameSetup, quickGameLeague, sortedTeams } from './quick-game-setup';
import type { RenderContext, Screen, ScreenServices } from './screen';

/** Who runs a side. */
export type SideControl = 'human' | 'ai' | 'watch';
/** Weather choice: the stadium climate ('auto') or a fixed type. */
export type CustomWeather = 'auto' | WeatherType;

/** Every custom-game option. */
export interface CustomGameChoice {
  homeAbbr: string;
  awayAbbr: string;
  home: SideControl;
  away: SideControl;
  difficulty: DifficultyId;
  base: 'arcade' | 'simulation';
  quarterMinutes: number;
  playClockSec: number;
  penalties: boolean;
  /** 0.25..2 scalar on penalty frequency. */
  penaltyFrequency: number;
  injuries: boolean;
  fatigue: boolean;
  overtime: Ruleset['overtime'];
  /** Challenges per game; 0 = challenges off. */
  challenges: number;
  twoMinuteWarning: boolean;
  weather: CustomWeather;
  defenseMode: DefenseMode;
  seed: number;
  /** Difficulty tuning from the gameplay preferences (absent = the preset as is). */
  tweaks?: GameplayPrefs['tweaks'];
}

/** A field of the form (every option plus the START row). */
export type CustomField = Exclude<keyof CustomGameChoice, 'seed' | 'tweaks'> | 'start';

/** Quarter lengths (minutes). */
export const CUSTOM_QUARTERS: readonly number[] = [1, 2, 3, 4, 5, 6, 8, 10, 12, 15];
/** Play-clock lengths (seconds). */
export const PLAY_CLOCKS: readonly number[] = [15, 20, 25, 30, 35, 40];
/** Penalty-frequency multipliers. */
export const PENALTY_FREQUENCIES: readonly number[] = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2];
/** Overtime formats. */
export const OVERTIME_FORMATS: readonly Ruleset['overtime'][] = ['none', 'suddenDeath', 'modified'];
/** Challenges per game (0 = off). */
export const CHALLENGE_COUNTS: readonly number[] = [0, 1, 2, 3];
/** Side controller choices. */
export const SIDE_CONTROLS: readonly SideControl[] = ['human', 'ai', 'watch'];
/** Weather choices: stadium climate or a fixed type. */
export const CUSTOM_WEATHER: readonly CustomWeather[] = ['auto', ...WEATHER_TYPES];
const DEFENSE_MODES: readonly DefenseMode[] = ['control', 'watch', 'playcallOnly'];

/** The rule fields a base ruleset resets. */
export const applyBase = (c: CustomGameChoice, base: 'arcade' | 'simulation'): CustomGameChoice => {
  const r = getRuleset(base);
  return {
    ...c, base, quarterMinutes: Math.round(r.quarterLengthSec / 60), playClockSec: r.playClockSec, penalties: r.penalties,
    penaltyFrequency: r.penalties ? Math.max(0.25, r.penaltyFrequency) : 1, injuries: r.injuries, fatigue: r.fatigue, overtime: r.overtime,
    challenges: r.challenges ? r.challengesPerGame : 0, twoMinuteWarning: r.twoMinuteWarning,
  };
};

/** Defaults: first two teams, human home vs AI, Pro, simulation rules, stadium weather. */
export const defaultCustomChoice = (teams: readonly Team[]): CustomGameChoice => applyBase({
  homeAbbr: teams[0]?.abbr ?? '', awayAbbr: teams[1]?.abbr ?? teams[0]?.abbr ?? '', home: 'human', away: 'ai', difficulty: 'pro', base: 'simulation',
  quarterMinutes: 8, playClockSec: 40, penalties: true, penaltyFrequency: 1, injuries: true, fatigue: true, overtime: 'modified', challenges: 2,
  twoMinuteWarning: true, weather: 'auto', defenseMode: 'control', seed: 1,
}, 'simulation');

const viewer = (s: SideControl): boolean => s !== 'ai';

/** A copy of the choice with one field stepped (at most one side is human or watched). */
export const changeCustom = (c: CustomGameChoice, field: CustomField, delta: number, abbrs: readonly string[]): CustomGameChoice => {
  const flip = (v: boolean): boolean => !v;
  switch (field) {
    case 'homeAbbr': {
      let homeAbbr = cycleOption(abbrs, c.homeAbbr, delta);
      if (homeAbbr === c.awayAbbr) homeAbbr = cycleOption(abbrs, homeAbbr, delta);
      return { ...c, homeAbbr };
    }
    case 'awayAbbr': {
      let awayAbbr = cycleOption(abbrs, c.awayAbbr, delta);
      if (awayAbbr === c.homeAbbr) awayAbbr = cycleOption(abbrs, awayAbbr, delta);
      return { ...c, awayAbbr };
    }
    case 'home': case 'away': {
      const other: 'home' | 'away' = field === 'home' ? 'away' : 'home';
      const value = cycleOption(SIDE_CONTROLS, c[field], delta);
      return { ...c, [field]: value, [other]: viewer(value) && viewer(c[other]) ? 'ai' : c[other] };
    }
    case 'difficulty': return { ...c, difficulty: cycleOption(DIFFICULTY_IDS, c.difficulty, delta) };
    case 'base': return applyBase(c, c.base === 'arcade' ? 'simulation' : 'arcade');
    case 'quarterMinutes': return { ...c, quarterMinutes: cycleOption(CUSTOM_QUARTERS, c.quarterMinutes, delta) };
    case 'playClockSec': return { ...c, playClockSec: cycleOption(PLAY_CLOCKS, c.playClockSec, delta) };
    case 'penalties': return { ...c, penalties: flip(c.penalties) };
    case 'penaltyFrequency': return { ...c, penaltyFrequency: cycleOption(PENALTY_FREQUENCIES, c.penaltyFrequency, delta) };
    case 'injuries': return { ...c, injuries: flip(c.injuries) };
    case 'fatigue': return { ...c, fatigue: flip(c.fatigue) };
    case 'overtime': return { ...c, overtime: cycleOption(OVERTIME_FORMATS, c.overtime, delta) };
    case 'challenges': return { ...c, challenges: cycleOption(CHALLENGE_COUNTS, c.challenges, delta) };
    case 'twoMinuteWarning': return { ...c, twoMinuteWarning: flip(c.twoMinuteWarning) };
    case 'weather': return { ...c, weather: cycleOption(CUSTOM_WEATHER, c.weather, delta) };
    case 'defenseMode': return { ...c, defenseMode: cycleOption(DEFENSE_MODES, c.defenseMode, delta) };
    case 'start': return c;
  }
};

const onOff = (v: boolean): string => (v ? 'On' : 'Off');
const CONTROL_LABEL: Record<SideControl, string> = { human: 'Human', ai: 'AI', watch: 'Watch' };
const OT_LABEL: Record<Ruleset['overtime'], string> = { none: 'None (ties)', suddenDeath: 'Sudden death', modified: 'Both possess' };

/** Menu items of the form. */
export const customGameItems = (c: CustomGameChoice, teamName: (abbr: string) => string): MenuItem[] => [
  { id: 'awayAbbr', label: 'Away team', value: teamName(c.awayAbbr) },
  { id: 'homeAbbr', label: 'Home team', value: teamName(c.homeAbbr) },
  { id: 'away', label: 'Away side', value: CONTROL_LABEL[c.away] },
  { id: 'home', label: 'Home side', value: CONTROL_LABEL[c.home] },
  { id: 'difficulty', label: 'Difficulty', value: getDifficulty(c.difficulty).name, subLabel: difficultyBlurb(c.difficulty, 'short') },
  { id: 'base', label: 'Base rules', value: c.base === 'arcade' ? 'Arcade' : 'Simulation' },
  { id: 'quarterMinutes', label: 'Quarter length', value: `${c.quarterMinutes} min` },
  { id: 'playClockSec', label: 'Play clock', value: `${c.playClockSec} s` },
  { id: 'penalties', label: 'Penalties', value: onOff(c.penalties) },
  { id: 'penaltyFrequency', label: 'Flag frequency', value: `${Math.round(c.penaltyFrequency * 100)}%`, disabled: !c.penalties },
  { id: 'injuries', label: 'Injuries', value: onOff(c.injuries) },
  { id: 'fatigue', label: 'Fatigue', value: onOff(c.fatigue) },
  { id: 'overtime', label: 'Overtime', value: OT_LABEL[c.overtime] },
  { id: 'challenges', label: 'Challenges', value: c.challenges === 0 ? 'Off' : `${c.challenges} per game` },
  { id: 'twoMinuteWarning', label: 'Two-minute warning', value: onOff(c.twoMinuteWarning) },
  { id: 'weather', label: 'Weather', value: c.weather === 'auto' ? 'Stadium climate' : humanize(c.weather) },
  { id: 'defenseMode', label: 'Your defense', value: c.defenseMode === 'playcallOnly' ? 'Call only' : humanize(c.defenseMode), disabled: c.home !== 'human' && c.away !== 'human' },
  { id: 'start', label: 'START GAME' },
];

/** Builds the GameSetup for a custom choice. Throws for unknown or identical teams. */
export const buildCustomGameSetup = (league: LeagueEntities, c: CustomGameChoice): GameSetup => {
  const base = buildQuickGameSetup(league, {
    homeAbbr: c.homeAbbr, awayAbbr: c.awayAbbr, side: 'home', difficulty: c.difficulty, ruleset: c.base, quarterMinutes: c.quarterMinutes,
    weather: 'auto', defenseMode: c.defenseMode, seed: c.seed, ...(c.tweaks ? { rules: { penalties: true, injuries: c.injuries, fatigue: c.fatigue, weather: true, tweaks: c.tweaks } } : {}),
  });
  const ruleset: Ruleset = {
    ...withQuarterLength(base.ruleset, c.quarterMinutes), playClockSec: c.playClockSec, penalties: c.penalties,
    penaltyFrequency: c.penalties ? c.penaltyFrequency : 0, injuries: c.injuries, fatigue: c.fatigue, overtime: c.overtime,
    challenges: c.challenges > 0, challengesPerGame: c.challenges, twoMinuteWarning: c.twoMinuteWarning,
  };
  const weather = c.weather === 'auto' ? base.weather
    : base.stadium.roof === 'dome' ? clearWeather(70) : sampleWeather(createRng(c.seed).fork('custom-weather'), c.weather);
  const controllers = { home: c.home, away: c.away };
  const userSide: TeamSide | null = c.home === 'human' ? 'home' : c.away === 'human' ? 'away' : c.home === 'watch' ? 'home' : c.away === 'watch' ? 'away' : null;
  return { ...base, ruleset, weather, controllers, userSide };
};

/** The form's starting values from the gameplay preferences (style, difficulty + tuning, quarter, switches). */
export const withGameplayPrefs = (c: CustomGameChoice, g: GameplayPrefs | undefined): CustomGameChoice => {
  if (!g) return c;
  const based = applyBase({ ...c, difficulty: g.difficulty }, g.ruleset);
  return {
    ...based,
    quarterMinutes: CUSTOM_QUARTERS.includes(g.quarterMinutes) ? g.quarterMinutes : based.quarterMinutes,
    penalties: based.penalties && g.penalties, injuries: g.injuries, fatigue: g.fatigue,
    weather: g.weather ? based.weather : 'clear',
    tweaks: { ...g.tweaks },
  };
};

/** Options of the screen. */
export interface CustomGameOptions {
  onStart(setup: GameSetup, choice: CustomGameChoice): void;
  leagueSeed?: number;
  league?: LeagueEntities;
  seed?: () => number;
}

/** The custom-game form. */
export class CustomGameScreen implements Screen {
  readonly id = 'customGame';
  private services: ScreenServices | null = null;
  private league: LeagueEntities | null = null;
  private teams: Team[] = [];
  private menu = new MenuList([]);
  choice: CustomGameChoice = defaultCustomChoice([]);

  constructor(private readonly opts: CustomGameOptions) {}

  get list(): MenuList { return this.menu; }

  private teamName = (abbr: string): string => {
    const t = this.teams.find((x) => x.abbr === abbr);
    return t ? `${t.abbr} ${t.name} (${t.overall})` : abbr;
  };

  enter(services: ScreenServices): void {
    this.services = services;
    if (!this.league) {
      this.league = this.opts.league ?? quickGameLeague(this.opts.leagueSeed ?? 7);
      this.teams = sortedTeams(this.league);
      this.choice = withGameplayPrefs({ ...defaultCustomChoice(this.teams), defenseMode: services.settings.defenseMode }, services.gameplay);
    }
    this.menu.setItems(customGameItems(this.choice, this.teamName));
  }

  exit(): void { this.services = null; }

  /** Steps one field (exported for tests). */
  change(field: CustomField, delta: number): void {
    this.choice = changeCustom(this.choice, field, delta, this.teams.map((t) => t.abbr));
    this.menu.setItems(customGameItems(this.choice, this.teamName));
  }

  /** Builds the setup and starts (null when the league is not loaded). */
  start(): GameSetup | null {
    if (!this.league) return null;
    this.choice = { ...this.choice, seed: (this.opts.seed ? this.opts.seed() : Date.now()) >>> 0 };
    const s = this.services;
    if (s && (this.choice.home === 'human' || this.choice.away === 'human') && s.settings.defenseMode !== this.choice.defenseMode) {
      s.settings.defenseMode = this.choice.defenseMode;
      s.persistSettings?.();
    }
    const setup = buildCustomGameSetup(this.league, this.choice);
    this.opts.onStart(setup, { ...this.choice });
    return setup;
  }

  update(dt: number, input: InputState, services: ScreenServices): void {
    // The start button (Enter) starts from any row; confirm on a value row steps that value.
    if (input.justPressed.has('pause')) {
      services.audio?.onGameEvent({ type: 'menuSelect' });
      this.start();
      return;
    }
    const ev = this.menu.update(dt, input);
    if (!ev) return;
    if (ev.type === 'back') {
      services.audio?.onGameEvent({ type: 'menuBack' });
      services.stack.pop();
      return;
    }
    if (ev.type === 'select') {
      services.audio?.onGameEvent({ type: 'menuMove' });
      return;
    }
    const field = ev.item.id as CustomField;
    if (ev.type === 'activate' && field === 'start') {
      services.audio?.onGameEvent({ type: 'menuSelect' });
      this.start();
    } else this.change(field, ev.type === 'change' ? ev.delta : 1);
  }

  render(rc: RenderContext): void {
    const theme = this.services?.theme ?? rc.theme;
    const { ctx, width, height } = rc;
    const size = theme.textScale;
    drawScreenBackdrop(ctx as ArtCtx, theme, width, height, rc.time);
    drawScreenTitle(ctx as ArtCtx, theme, 'CUSTOM GAME', width / 2, theme.pad);
    const top = theme.pad + theme.lineHeight;
    const hintH = hintBarHeight(theme);
    const bottom = height - hintH - theme.pad * 2;
    const sideW = size > 1 ? 0 : Math.round(width * 0.32);
    const listW = width - theme.pad * 2 - (sideW > 0 ? sideW + theme.pad : 0);
    const panel = drawPanel(ctx, theme, theme.pad, top, listW, bottom - top, { style: 'raised' });
    this.menu = refitMenu(this.menu, rowsThatFit(theme, panel.h));
    this.menu.draw(ctx, theme, panel.x, panel.y, panel.w, { time: rc.time });
    if (sideW > 0) {
      const box = drawPanel(ctx, theme, theme.pad * 2 + listW, top, sideW, bottom - top, { style: 'raised', title: 'Matchup' });
      let y = box.y;
      [this.choice.awayAbbr, this.choice.homeAbbr].forEach((abbr, i) => {
        const t = this.teams.find((x) => x.abbr === abbr);
        if (!t) return;
        if (i === 1) {
          // The VS badge between the two teams.
          drawVersusBadge(ctx as ArtCtx, theme, box.x + box.w - 16, y + 2);
          y += theme.gap;
        }
        y += drawTeamBadge(ctx, theme, t, box.x, y, box.w, 24, [`OVR ${t.overall}`]) + theme.gap;
      });
    }
    const input = this.services?.input;
    drawHintBar(ctx, theme, setupHints(input ?? null, this.menu.selected?.id === 'start'), width, height - hintH - theme.pad);
  }
}
