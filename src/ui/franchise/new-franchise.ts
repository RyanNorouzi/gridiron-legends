/**
 * New franchise / season / playoffs wizard.
 * 1. League settings: difficulty, rules and quarter length, injuries / fatigue / weather, salary-cap preset
 *    (Left/Right or a tap change a value; the panel on the right explains the highlighted setting).
 * 2. Team: pick one of the 32 teams (logo, colours, ratings, market) or create a custom team (city, name,
 *    three-letter abbreviation via the letter grid, palette colours with a colorblind check, logo seed with a
 *    live preview, the team slot it takes over).
 * 3. Franchise mode only: the save name (letter grid).
 * Then createLeague({ seed, settings, userTeamAbbr | customTeam }) runs and `onCreate` receives the League (the
 * app saves it to a new slot and opens the hub). The seed is fixed when the wizard opens, so the ratings shown
 * in the picker are exactly those of the created league.
 */
import type { League } from '@/franchise/types';
import { createLeague } from '@/franchise/league';
import type { Team } from '@/teams/types';
import type { InputState } from '../input/types';
import { drawText, wrapText } from '../render/text';
import type { RenderContext, Screen, ScreenServices } from '../screens/screen';
import { MenuList, type MenuItem } from '../widgets/menu';
import { drawHintBar, drawPanel } from '../widgets/panel';
import { NAME_ROWS } from './kit/dialog-models';
import { ChoiceDialog, TextEntryDialog } from './kit/dialogs';
import type { CustomTeamDraft } from './shell/custom-team';
import { SAVE_NAME_MAX, fitSaveName } from './shell/save-model';
import { CustomTeamScreen } from './shell/custom-team-screen';
import {
  buildNewLeague, changeSetting, choiceFromGameplay, defaultNewLeagueChoice, settingsItems, settingsOverrides, type NewLeagueChoice, type SettingsField,
} from './shell/league-setup-model';
import { TeamPickScreen } from './shell/team-picker';
import { glyphOf, hintBarHeight, refitMenu, rowsThatFit } from './shell/widgets';
import { difficultyBlurb } from '../gameplay-prefs';

/** What the wizard sets up. */
export type NewLeagueMode = 'franchise' | 'season' | 'playoffs';

/** Options of the wizard. */
export interface NewFranchiseOptions {
  mode?: NewLeagueMode;
  /** Receives the created League and, in franchise mode, the save name. */
  onCreate(league: League, saveName: string | null): void;
  /** League seed (default: from the clock when the wizard opens). */
  seed?: () => number;
  /** Default: pop the wizard. */
  onBack?(): void;
}

const TITLES: Record<NewLeagueMode, string> = { franchise: 'NEW FRANCHISE', season: 'NEW SEASON', playoffs: 'PLAYOFFS' };

const HELP: Record<SettingsField | 'next' | 'back', string> = {
  difficulty: 'How good the CPU opponent is. Your own AI teammates always play at Pro.',
  ruleset: 'Arcade: fewer stoppages, no penalties. Simulation: penalties, challenges and full game flow.',
  quarter: 'Quarter length of the games you play. Simulated league games always run full length.',
  penalties: 'Flags for holding, interference, false starts and the rest.',
  challenges: "Coach's challenges to overturn close calls after a play.",
  playoffs: 'Playoff teams per conference; byes and rounds follow from the count.',
  injuries: 'Players can get hurt in games and miss weeks.',
  fatigue: 'Tired players lose speed and carry fatigue into the next week.',
  weather: 'Rain, snow, wind and cold by stadium climate and week.',
  cap: 'The league salary cap every roster is built under.',
  next: 'Choose one of the 32 teams or build your own.',
  back: 'Return to the menu.',
};

/** The wizard's settings step (it pushes the team and name steps). */
export class NewFranchiseScreen implements Screen {
  readonly id = 'franchise-new';
  readonly mode: NewLeagueMode;
  readonly seed: number;
  private services: ScreenServices | null = null;
  private menu: MenuList;
  private choiceValue: NewLeagueChoice = defaultNewLeagueChoice();
  private preview: { key: string; teams: Team[] } | null = null;
  private seededFromPrefs = false;

  constructor(private readonly opts: NewFranchiseOptions) {
    this.mode = opts.mode ?? 'franchise';
    this.seed = (opts.seed ? opts.seed() : Date.now()) >>> 0;
    this.menu = new MenuList(this.items());
  }

  get choice(): NewLeagueChoice { return this.choiceValue; }
  get list(): MenuList { return this.menu; }

  private items(): MenuItem[] {
    return [...settingsItems(this.choiceValue), { id: 'next', label: 'Choose team ▶' }, { id: 'back', label: 'Back' }];
  }

  /** Steps one setting (exported for tests). */
  change(field: SettingsField, delta: number): void {
    this.choiceValue = changeSetting(this.choiceValue, field, delta);
    this.menu.setItems(this.items());
  }

  /** Teams of the league these settings would create (cached per settings). */
  previewTeams(): Team[] {
    const settings = settingsOverrides(this.choiceValue);
    const key = JSON.stringify([this.seed, settings.salaryCap]);
    if (!this.preview || this.preview.key !== key) {
      const league = createLeague({ seed: this.seed, settings });
      this.preview = { key, teams: Object.values(league.teams) };
    }
    return this.preview.teams;
  }

  enter(services: ScreenServices): void {
    this.services = services;
    // A new league starts from the gameplay preferences (style, difficulty + tuning, quarter, switches).
    if (!this.seededFromPrefs && services.gameplay) {
      this.seededFromPrefs = true;
      this.choiceValue = choiceFromGameplay(services.gameplay);
      this.menu.setItems(this.items());
    }
  }
  exit(): void { this.services = null; }

  private push(screen: Screen): void {
    this.services?.stack.push(screen);
  }

  private popTo(): void {
    const s = this.services;
    if (s && s.stack.all.includes(this)) s.stack.popTo(this);
  }

  /** Opens the team step: pick a team or create one. */
  chooseTeam(): void {
    this.push(new ChoiceDialog('Your team', 'Take over one of the 32 teams or create your own.', [
      { id: 'pick', label: 'Pick a team' },
      { id: 'custom', label: 'Create a custom team' },
    ], (id) => {
      if (id === 'pick') this.openPicker();
      else if (id === 'custom') this.openCustom();
    }));
  }

  /** Pushes the team picker. */
  openPicker(): TeamPickScreen {
    const teams = this.previewTeams();
    const byId = new Map(teams.map((t) => [t.id, t]));
    const picker = new TeamPickScreen({
      title: 'CHOOSE YOUR TEAM', subtitle: TITLES[this.mode], teams,
      rivalNames: (t) => t.rivalIds.map((id) => byId.get(id)?.abbr ?? '').filter((a) => a.length > 0),
      onPick: (team) => this.afterTeam({ teamAbbr: team.abbr }, `${team.city} ${team.name}`),
    });
    this.push(picker);
    return picker;
  }

  /** Pushes the custom-team editor. */
  openCustom(): CustomTeamScreen {
    const editor = new CustomTeamScreen({ teams: this.previewTeams(), onCreate: (draft) => this.afterTeam({ custom: draft }, `${draft.city} ${draft.name}`) });
    this.push(editor);
    return editor;
  }

  private afterTeam(team: { teamAbbr?: string; custom?: CustomTeamDraft }, teamName: string): void {
    this.popTo();
    if (this.mode !== 'franchise') {
      this.finish(team, null);
      return;
    }
    const initial = fitSaveName(teamName);
    this.push(new TextEntryDialog('Save name', 'Name this franchise save', { initial, maxLength: SAVE_NAME_MAX, rows: NAME_ROWS, casing: 'title' }, (name) => {
      if (name !== null) this.finish(team, name);
    }));
  }

  /** Creates the League and hands it over; returns it (null with a toast when creation failed). */
  finish(team: { teamAbbr?: string; custom?: CustomTeamDraft }, saveName: string | null): League | null {
    let league: League;
    try {
      league = buildNewLeague({ seed: this.seed, choice: this.choiceValue, ...team });
    } catch (err) {
      this.services?.toast(err instanceof Error ? err.message : 'The league could not be created');
      return null;
    }
    this.opts.onCreate(league, saveName);
    return league;
  }

  private back(): void {
    if (this.opts.onBack) this.opts.onBack();
    else if (this.services?.stack.top === this) this.services.stack.pop();
  }

  update(dt: number, input: InputState): void {
    const ev = this.menu.update(dt, input);
    if (!ev) return;
    if (ev.type === 'back') return this.back();
    if (ev.type === 'select') return;
    const id = ev.item.id;
    if (id === 'next' && ev.type === 'activate') this.chooseTeam();
    else if (id === 'back' && ev.type === 'activate') this.back();
    else if (id !== 'next' && id !== 'back') this.change(id as SettingsField, ev.type === 'change' ? ev.delta : 1);
  }

  render(rc: RenderContext): void {
    const theme = this.services?.theme ?? rc.theme;
    const { ctx, width, height } = rc;
    const c = theme.colors;
    const size = theme.textScale;
    ctx.fillStyle = c.bg;
    ctx.fillRect(0, 0, width, height);
    drawText(ctx, TITLES[this.mode], width / 2, theme.pad, { size, align: 'center', color: c.accent, shadow: c.shadow });
    const top = theme.pad + theme.lineHeight;
    const hintH = hintBarHeight(theme);
    const bottom = height - hintH - theme.pad * 2;
    const helpW = size > 1 ? 0 : Math.round(width * 0.34);
    const listW = width - theme.pad * 2 - (helpW > 0 ? helpW + theme.pad : 0);
    const panel = drawPanel(ctx, theme, theme.pad, top, listW, bottom - top, { style: 'raised', title: 'League settings' });
    this.menu = refitMenu(this.menu, rowsThatFit(theme, panel.h));
    this.menu.draw(ctx, theme, panel.x, panel.y, panel.w, { time: rc.time });
    if (helpW > 0) {
      const help = drawPanel(ctx, theme, theme.pad * 2 + listW, top, helpW, bottom - top, { style: 'raised' });
      const key = (this.menu.selected?.id ?? 'next') as keyof typeof HELP;
      const text = key === 'difficulty' ? `${difficultyBlurb(this.choiceValue.difficulty)} ${HELP.difficulty}` : HELP[key] ?? '';
      wrapText(text, help.w, size).forEach((line, i) => {
        if (help.y + i * theme.lineHeight + theme.glyphH <= help.y + help.h) drawText(ctx, line, help.x, help.y + i * theme.lineHeight, { color: c.textDim, size });
      });
    }
    const input = this.services?.input;
    drawHintBar(ctx, theme, [
      { glyph: `${glyphOf(input, 'menuLeft')} ${glyphOf(input, 'menuRight')}`, label: 'Change' },
      { glyph: glyphOf(input, 'confirm'), label: 'Select' },
      { glyph: glyphOf(input, 'back'), label: 'Back' },
    ], width, height - hintH - theme.pad);
  }
}
