/**
 * Quick-game setup: generates a league once (cached), lets the user pick home / away teams (logo, colours,
 * overall), which side to play (or watch), difficulty, ruleset, quarter length, weather and defense mode,
 * then builds a complete GameSetup (resolved playbooks, stadium, weather, seed) and hands it to `onStart`.
 * `buildQuickGameSetup` is pure and exported for tests.
 */
import { gameId } from '@/core/ids';
import type { PlayerId, TeamId } from '@/core/ids';
import { createRng } from '@/core/rng';
import type { DefenseMode } from '@/core/settings';
import { DIFFICULTY_IDS, getDifficulty, getRuleset } from '@/game/rulesets';
import type { DifficultyId, GameSetup, GameTeamSetup, Ruleset, TeamSide, WeatherType } from '@/game/types';
import { clearWeather, generateWeather, sampleWeather } from '@/game/weather';
import { resolvePlaybook } from '@/playbook/loader';
import type { Player } from '@/players/types';
import { generateLeagueEntities, type LeagueEntities } from '@/teams/league-generator';
import type { Team } from '@/teams/types';
import type { InputState } from '../input/types';
import { drawTeamLogo } from '../render/logo';
import { drawText, measureText } from '../render/text';
import { MenuList, type MenuItem } from '../widgets/menu';
import { drawHintBar, drawPanel } from '../widgets/panel';
import { UI_SLAB } from '../render/palette';
import { drawScreenBackdrop } from '../widgets/title-backdrop';
import { drawHelmetPortrait } from '../widgets/helmet-portrait';
import { drawScreenTitle, drawVersusBadge } from '../widgets/headers';
import { drawDiagonalStripes, drawTab, fillAlpha, type ArtCtx } from '../widgets/ui-art';
import { setupHints } from '../widgets/setup-hints';
import { difficultyBlurb, tunedDifficulty, withQuarterLength, type GameplayPrefs } from '../gameplay-prefs';
import type { RenderContext, Screen, ScreenServices } from './screen';

export type QuickGameSide = 'home' | 'away' | 'watch';
export type QuickWeather = 'auto' | 'clear' | 'rain' | 'snow' | 'wind';

export interface QuickGameChoice {
  homeAbbr: string;
  awayAbbr: string;
  side: QuickGameSide;
  difficulty: DifficultyId;
  ruleset: 'arcade' | 'simulation';
  quarterMinutes: number;
  weather: QuickWeather;
  defenseMode: DefenseMode;
  seed: number;
  /** Rule switches and difficulty tuning from the gameplay preferences (absent = everything on, no tuning). */
  rules?: Pick<GameplayPrefs, 'penalties' | 'injuries' | 'fatigue' | 'weather' | 'tweaks'>;
}

export const QUARTER_MINUTES: readonly number[] = [1, 2, 3, 5, 8, 10, 15];
export const WEATHER_CHOICES: readonly QuickWeather[] = ['auto', 'clear', 'rain', 'snow', 'wind'];
export const SIDE_CHOICES: readonly QuickGameSide[] = ['home', 'away', 'watch'];
export const DEFENSE_MODES: readonly DefenseMode[] = ['control', 'watch', 'playcallOnly'];
/**
 * Facing of a team card's helmet portrait: the AWAY card is on the left, so its helmet looks right ('se', facemask
 * toward the VS badge); the HOME card's looks left ('sw'). The two helmets face each other.
 */
export const portraitFacing = (label: string): 'se' | 'sw' => (label === 'AWAY' ? 'se' : 'sw');
export const LEAGUE_YEAR = 2026;
export const LEAGUE_SALARY_CAP = 255_000_000;

let cachedLeague: { seed: number; league: LeagueEntities } | null = null;

/** The generated league for a seed, built once per seed and reused. */
export const quickGameLeague = (seed: number): LeagueEntities => {
  if (!cachedLeague || cachedLeague.seed !== seed) cachedLeague = { seed, league: generateLeagueEntities(seed, { year: LEAGUE_YEAR, salaryCap: LEAGUE_SALARY_CAP }) };
  return cachedLeague.league;
};

/** Teams sorted by city then name. */
export const sortedTeams = (league: LeagueEntities): Team[] => Object.values(league.teams).sort((a, b) => `${a.city} ${a.name}`.localeCompare(`${b.city} ${b.name}`));

const teamSetup = (league: LeagueEntities, team: Team): GameTeamSetup => {
  const players: Record<PlayerId, Player> = {};
  for (const id of team.rosterIds) {
    const p = league.players[id];
    if (p) players[id] = p;
  }
  const playbook = resolvePlaybook(team.playbookId);
  return { team, players, headCoach: team.headCoachId ? league.coaches[team.headCoachId] ?? null : null, offensePlays: playbook.offense, defensePlays: playbook.defense };
};

const WEATHER_TYPE: Readonly<Record<Exclude<QuickWeather, 'auto'>, WeatherType>> = { clear: 'clear', rain: 'rain', snow: 'snow', wind: 'wind' };

/** Builds the GameSetup for a choice. Throws when a team abbreviation is unknown or both teams match. */
export const buildQuickGameSetup = (league: LeagueEntities, choice: QuickGameChoice): GameSetup => {
  const find = (abbr: string): Team => {
    const t = Object.values(league.teams).find((x) => x.abbr === abbr);
    if (!t) throw new Error(`quick game: unknown team ${abbr}`);
    return t;
  };
  const home = find(choice.homeAbbr);
  const away = find(choice.awayAbbr);
  if (home.id === away.id) throw new Error('quick game: home and away must differ');
  const stadium = league.stadiums[home.stadiumId];
  if (!stadium) throw new Error(`quick game: ${home.abbr} has no stadium`);
  const rng = createRng(choice.seed);
  const weatherRng = rng.fork('weather');
  const rules = choice.rules;
  const weather = rules && !rules.weather ? clearWeather(70) : choice.weather === 'auto'
    ? generateWeather(weatherRng, stadium.climate, 8, stadium.roof)
    : stadium.roof === 'dome' ? clearWeather(70) : sampleWeather(weatherRng, WEATHER_TYPE[choice.weather]);
  const userSide: TeamSide | null = choice.side === 'watch' ? 'home' : choice.side;
  const controllers: GameSetup['controllers'] = { home: 'ai', away: 'ai' };
  if (choice.side === 'watch') controllers.home = 'watch';
  else controllers[choice.side] = 'human';
  return {
    id: gameId(rng.fork('id')),
    home: teamSetup(league, home),
    away: teamSetup(league, away),
    stadium,
    ruleset: withRuleSwitches(withQuarterLength(getRuleset(choice.ruleset), choice.quarterMinutes), rules),
    difficulty: tunedDifficulty(getDifficulty(choice.difficulty), rules?.tweaks ?? {}),
    weather,
    seed: choice.seed,
    userSide,
    controllers,
    isPlayoff: false,
  };
};

/** A ruleset with the preference switches applied (penalties can only be turned off, never forced on). */
export const withRuleSwitches = (ruleset: Ruleset, rules: Pick<GameplayPrefs, 'penalties' | 'injuries' | 'fatigue'> | undefined): Ruleset =>
  rules ? { ...ruleset, penalties: ruleset.penalties && rules.penalties, injuries: rules.injuries, fatigue: rules.fatigue } : ruleset;

export interface QuickGameSetupOptions {
  onStart: (setup: GameSetup, choice: QuickGameChoice) => void;
  /** 'watch' preselects Watch Mode. */
  mode?: 'play' | 'watch';
  /** League seed (default 7); tests may inject a league instead. */
  leagueSeed?: number;
  league?: LeagueEntities;
  /** Game seed; default derived from the clock at start. */
  seed?: () => number;
}

type Field = 'home' | 'away' | 'side' | 'difficulty' | 'ruleset' | 'quarter' | 'weather' | 'defense' | 'start';

export class QuickGameSetupScreen implements Screen {
  readonly id = 'quickGameSetup';
  private league: LeagueEntities | null = null;
  private teams: Team[] = [];
  private menu: MenuList;
  private services: ScreenServices | null = null;
  readonly choice: QuickGameChoice;

  constructor(private readonly opts: QuickGameSetupOptions) {
    this.choice = { homeAbbr: '', awayAbbr: '', side: opts.mode === 'watch' ? 'watch' : 'home', difficulty: 'pro', ruleset: 'simulation', quarterMinutes: 5, weather: 'auto', defenseMode: 'control', seed: 1 };
    this.menu = new MenuList([]);
  }

  get list(): MenuList {
    return this.menu;
  }

  private items(): MenuItem[] {
    const c = this.choice;
    const team = (abbr: string): string => {
      const t = this.teams.find((x) => x.abbr === abbr);
      // Large text: the nickname only, so the row keeps its HOME / AWAY label on screen.
      const large = (this.services?.theme.textScale ?? 1) > 1;
      return t ? `${large ? '' : `${t.city.toUpperCase()} `}${t.name.toUpperCase()} (${t.overall})` : abbr;
    };
    return [
      { id: 'home', label: 'HOME', value: team(c.homeAbbr) },
      { id: 'away', label: 'AWAY', value: team(c.awayAbbr) },
      { id: 'side', label: 'PLAY AS', value: c.side === 'watch' ? 'WATCH' : c.side.toUpperCase() },
      { id: 'difficulty', label: 'DIFFICULTY', value: getDifficulty(c.difficulty).name.toUpperCase(), subLabel: difficultyBlurb(c.difficulty, 'short').toUpperCase() },
      { id: 'ruleset', label: 'RULES', value: c.ruleset.toUpperCase() },
      { id: 'quarter', label: 'QUARTERS', value: `${c.quarterMinutes} MIN` },
      { id: 'weather', label: 'WEATHER', value: c.weather.toUpperCase() },
      { id: 'defense', label: 'DEFENSE', value: c.defenseMode === 'playcallOnly' ? 'CALL ONLY' : c.defenseMode.toUpperCase(), disabled: c.side === 'watch' },
      { id: 'start', label: c.side === 'watch' ? 'START WATCHING' : 'START GAME' },
    ];
  }

  enter(services: ScreenServices): void {
    this.services = services;
    if (!this.league) {
      this.league = this.opts.league ?? quickGameLeague(this.opts.leagueSeed ?? 7);
      this.teams = sortedTeams(this.league);
      this.choice.homeAbbr = this.teams[0]?.abbr ?? '';
      this.choice.awayAbbr = this.teams[1]?.abbr ?? this.choice.homeAbbr;
      this.choice.defenseMode = services.settings.defenseMode;
      const g = services.gameplay;
      if (g) {
        this.choice.difficulty = g.difficulty;
        this.choice.ruleset = g.ruleset;
        if (QUARTER_MINUTES.includes(g.quarterMinutes)) this.choice.quarterMinutes = g.quarterMinutes;
        this.choice.rules = { penalties: g.penalties, injuries: g.injuries, fatigue: g.fatigue, weather: g.weather, tweaks: { ...g.tweaks } };
      }
    }
    const selected = Math.max(0, this.menu.selectedIndex);
    this.menu = new MenuList(this.items(), { initialIndex: selected });
  }

  exit(): void {
    this.services = null;
  }

  private cycle<T>(list: readonly T[], current: T, delta: number): T {
    const i = Math.max(0, list.indexOf(current));
    return list[((i + delta) % list.length + list.length) % list.length] as T;
  }

  /** Changes a field by one step (exported for tests). */
  change(field: Field, delta: number): void {
    const c = this.choice;
    const abbrs = this.teams.map((t) => t.abbr);
    switch (field) {
      case 'home': c.homeAbbr = this.cycle(abbrs, c.homeAbbr, delta); if (c.homeAbbr === c.awayAbbr) c.awayAbbr = this.cycle(abbrs, c.awayAbbr, delta); break;
      case 'away': c.awayAbbr = this.cycle(abbrs, c.awayAbbr, delta); if (c.awayAbbr === c.homeAbbr) c.awayAbbr = this.cycle(abbrs, c.awayAbbr, delta); break;
      case 'side': c.side = this.cycle(SIDE_CHOICES, c.side, delta); break;
      case 'difficulty': c.difficulty = this.cycle(DIFFICULTY_IDS, c.difficulty, delta); break;
      case 'ruleset': c.ruleset = c.ruleset === 'arcade' ? 'simulation' : 'arcade'; break;
      case 'quarter': c.quarterMinutes = this.cycle(QUARTER_MINUTES, c.quarterMinutes, delta); break;
      case 'weather': c.weather = this.cycle(WEATHER_CHOICES, c.weather, delta); break;
      case 'defense': c.defenseMode = this.cycle(DEFENSE_MODES, c.defenseMode, delta); break;
      case 'start': break;
    }
    this.menu.setItems(this.items());
  }

  /** Builds the setup and starts; returns it (null when the league is missing). */
  start(): GameSetup | null {
    if (!this.league) return null;
    const services = this.services;
    if (services && this.choice.side !== 'watch' && services.settings.defenseMode !== this.choice.defenseMode) {
      services.settings.defenseMode = this.choice.defenseMode;
      services.persistSettings?.();
    }
    this.choice.seed = this.opts.seed ? this.opts.seed() : (Date.now() >>> 0);
    const setup = buildQuickGameSetup(this.league, this.choice);
    this.opts.onStart(setup, { ...this.choice });
    return setup;
  }

  update(dt: number, input: InputState, services: ScreenServices): void {
    // The start button (Enter) starts from any row; confirm on a value row changes that value.
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
    } else if (ev.type === 'change') this.change(ev.item.id as Field, ev.delta);
    else if (ev.type === 'activate') {
      services.audio?.onGameEvent({ type: 'menuSelect' });
      if (ev.item.id === 'start') this.start();
      else this.change(ev.item.id as Field, 1);
    } else if (ev.type === 'select') services.audio?.onGameEvent({ type: 'menuMove' });
  }

  /** Shows as many rows as the list panel holds (all when they fit), keeping the selection. */
  private refit(rows: number): void {
    const want = rows >= this.menu.items.length ? 0 : Math.max(1, rows);
    if (this.menu.maxVisible === want) return;
    this.menu = new MenuList(this.menu.items, { maxVisible: want, initialIndex: Math.max(0, this.menu.selectedIndex) });
  }

  /** Draws a team card and returns its height. */
  private drawTeamCard(rc: RenderContext, abbr: string, x: number, y: number, w: number, label: string): number {
    const { ctx, theme } = rc;
    const t = this.teams.find((tt) => tt.abbr === abbr);
    if (!t) return QuickGameSetupScreen.cardHeight(theme);
    const size = 24;
    // The ratings line sits below the logo and its colour bar (and below the two name lines in large text).
    const ratingsY = Math.max(size + 6, theme.lineHeight * 2);
    const cardH = QuickGameSetupScreen.cardHeight(theme);
    const content = drawPanel(ctx, theme, x, y, w, cardH, { style: 'raised', title: label });
    // Team identity: a colour band with diagonal stripes behind the right side of the card, and a lit plate
    // (dark rim + drop shadow) under the emblem.
    const art = ctx as ArtCtx;
    const bandX = x + Math.round(w * 0.72);
    drawDiagonalStripes(art, bandX, y + theme.border, x + w - theme.border - bandX, cardH - theme.border * 2, t.colors.primary, 0.3, 10, 4);
    drawTab(art, bandX - 4, y + theme.border, 6, cardH - theme.border * 2, t.colors.primary, { cutLeft: 4 });
    fillAlpha(art, UI_SLAB.edge, 0.6, content.x + 1, content.y + 1, size, size);
    drawTeamLogo(ctx, t.logoSeed, t.colors, size, content.x, content.y);
    // The team's helmet on the stripe band, turned toward the other card.
    drawHelmetPortrait(art, t.colors, 34, x + w - theme.border - 24, y + Math.round(cardH / 2) + 2, portraitFacing(label));
    drawText(ctx, t.city.toUpperCase(), content.x + size + theme.gap, content.y, { color: theme.colors.text, size: theme.textScale });
    // Theme accent, not the team colour: dark primaries (navy, maroon) were unreadable on the dark panel.
    drawText(ctx, t.name.toUpperCase(), content.x + size + theme.gap, content.y + theme.lineHeight, { color: theme.colors.accent, size: theme.textScale, shadow: theme.colors.shadow });
    ctx.fillStyle = t.colors.secondary;
    ctx.fillRect(content.x, content.y + size + 2, size, 2);
    const ratings = [`OVR ${t.overall} · OFF ${t.offenseRating} · DEF ${t.defenseRating}`, `OVR ${t.overall} O${t.offenseRating} D${t.defenseRating}`, `OVR ${t.overall}`]
      .find((line) => measureText(line, theme.textScale).width <= content.w) ?? `${t.overall}`;
    drawText(ctx, ratings, content.x, content.y + ratingsY, { color: theme.colors.textDim, size: theme.textScale });
    return cardH;
  }

  /** Team card height: logo + colour bar, then the ratings line (two name lines in large text). */
  static cardHeight(theme: { lineHeight: number; pad: number }): number {
    return Math.max(24 + 6, theme.lineHeight * 2) + theme.lineHeight + theme.pad * 2;
  }

  /**
   * Large text: the team cards would leave room for two option rows, so the matchup shrinks to a logo + abbreviation
   * on each side of the title (the HOME / AWAY rows already name both teams) and the option list gets the rest of the
   * screen, with tighter outer margins so all nine rows fit at once.
   */
  private renderLarge(rc: RenderContext): void {
    const { ctx, theme, width, height } = rc;
    const s = theme.textScale;
    const hintH = theme.glyphH + 4 * s;
    const titleY = 2 * s;
    // A calm ink strip behind the title row so the backdrop's light towers never sit under the abbreviations.
    const listY = titleY + theme.glyphH + 2 * s;
    fillAlpha(ctx as ArtCtx, UI_SLAB.ink, 0.85, 0, 0, width, listY - s);
    drawText(ctx, this.choice.side === 'watch' ? 'WATCH MODE' : 'QUICK GAME', width / 2, titleY, { size: s, align: 'center', color: theme.colors.accent, shadow: theme.colors.shadow });
    const logo = theme.glyphH;
    const side = (abbr: string, right: boolean): void => {
      const t = this.teams.find((tt) => tt.abbr === abbr);
      if (!t) return;
      const x = right ? width - theme.pad - logo : theme.pad;
      drawTeamLogo(ctx, t.logoSeed, t.colors, logo, x, titleY);
      drawText(ctx, t.abbr, right ? x - theme.gap : x + logo + theme.gap, titleY, { size: s, align: right ? 'right' : 'left', color: theme.colors.text });
    };
    side(this.choice.awayAbbr, false);
    side(this.choice.homeAbbr, true);
    const hintY = height - hintH - 2 * s;
    const panelH = hintY - s - listY;
    const content = drawPanel(ctx, theme, theme.pad, listY, width - theme.pad * 2, panelH, { style: 'raised' });
    const inset = theme.border + 2 * s;
    this.refit(Math.floor((panelH - inset * 2) / theme.lineHeight));
    this.menu.draw(ctx, theme, content.x, listY + inset, content.w, { time: rc.time });
    drawHintBar(ctx, theme, setupHints(this.services?.input ?? null, this.menu.selected?.id === 'start'), width, hintY);
  }

  render(rc: RenderContext): void {
    const { ctx, theme, width, height } = rc;
    drawScreenBackdrop(ctx as ArtCtx, theme, width, height, rc.time);
    if (theme.textScale > 1) return this.renderLarge(rc);
    const hintH = theme.glyphH + 4 * theme.textScale;
    drawScreenTitle(ctx as ArtCtx, theme, this.choice.side === 'watch' ? 'WATCH MODE' : 'QUICK GAME', width / 2, theme.pad);
    const cardW = Math.round((width - theme.pad * 3) / 2);
    const cardY = theme.pad + theme.glyphH + theme.gap;
    this.drawTeamCard(rc, this.choice.awayAbbr, theme.pad, cardY, cardW, 'AWAY');
    this.drawTeamCard(rc, this.choice.homeAbbr, theme.pad * 2 + cardW, cardY, cardW, 'HOME');
    drawVersusBadge(ctx as ArtCtx, theme, width / 2, cardY + Math.round(QuickGameSetupScreen.cardHeight(theme) / 2));
    const listY = cardY + QuickGameSetupScreen.cardHeight(theme) + theme.gap;
    const content = drawPanel(ctx, theme, theme.pad, listY, width - theme.pad * 2, height - listY - hintH - theme.pad * 2, { style: 'raised' });
    this.refit(Math.floor(content.h / theme.lineHeight));
    this.menu.draw(ctx, theme, content.x, content.y, content.w, { time: rc.time });
    const input = this.services?.input;
    drawHintBar(ctx, theme, setupHints(input ?? null, this.menu.selected?.id === 'start'), width, height - hintH - theme.pad);
  }
}

export type { TeamId };
