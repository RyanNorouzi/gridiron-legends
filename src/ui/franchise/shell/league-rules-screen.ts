/**
 * LEAGUE RULES (hub menu): changes a running league's game rules for every game from now on: difficulty, play
 * style (arcade / simulation), quarter length, penalties, coach's challenges, injuries, fatigue and weather.
 * SAVE commits the League ('settings' autosave); BACK leaves it unchanged. Structure, cap and playoff format stay
 * as the league was created.
 */
import type { InputState } from '../../input/types';
import { drawText, wrapText } from '../../render/text';
import type { RenderContext, Screen, ScreenServices } from '../../screens/screen';
import { MenuList, type MenuItem } from '../../widgets/menu';
import { drawHintBar, drawPanel } from '../../widgets/panel';
import type { FranchiseContext } from '../context';
import { changeSetting, choiceFromLeague, RULE_FIELDS, settingsItems, withGameRules, type NewLeagueChoice, type SettingsField } from './league-setup-model';
import { glyphOf, hintBarHeight, refitMenu, rowsThatFit } from './widgets';

export class LeagueRulesScreen implements Screen {
  readonly id = 'franchise-league-rules';
  private services: ScreenServices | null = null;
  private menu: MenuList;
  private choiceValue: NewLeagueChoice;

  constructor(private readonly fc: FranchiseContext) {
    this.choiceValue = choiceFromLeague(fc.league().settings);
    this.menu = new MenuList(this.items());
  }

  get choice(): NewLeagueChoice { return this.choiceValue; }
  get list(): MenuList { return this.menu; }

  private items(): MenuItem[] {
    const rows = settingsItems(this.choiceValue).filter((i) => RULE_FIELDS.includes(i.id as SettingsField));
    return [...rows, { id: 'save', label: 'Save rules' }, { id: 'back', label: 'Back' }];
  }

  /** Steps one rule (exported for tests). */
  change(field: SettingsField, delta: number): void {
    if (!RULE_FIELDS.includes(field)) return;
    this.choiceValue = changeSetting(this.choiceValue, field, delta);
    this.menu.setItems(this.items());
  }

  /** Commits the rules and closes. */
  save(): void {
    this.fc.commit(withGameRules(this.fc.league(), this.choiceValue), 'settings');
    this.fc.toast('League rules saved: they apply from the next game');
    this.close();
  }

  private close(): void {
    const s = this.services;
    if (s && s.stack.top === this) this.fc.pop();
  }

  enter(services: ScreenServices): void { this.services = services; }
  exit(): void { this.services = null; }

  update(dt: number, input: InputState): void {
    const ev = this.menu.update(dt, input);
    if (!ev) return;
    if (ev.type === 'back') return this.close();
    if (ev.type === 'select') return;
    const id = ev.item.id;
    if (id === 'save' && ev.type === 'activate') this.save();
    else if (id === 'back' && ev.type === 'activate') this.close();
    else if (id !== 'save' && id !== 'back') this.change(id as SettingsField, ev.type === 'change' ? ev.delta : 1);
  }

  render(rc: RenderContext): void {
    const theme = this.services?.theme ?? rc.theme;
    const { ctx, width, height } = rc;
    const c = theme.colors;
    const size = theme.textScale;
    ctx.fillStyle = c.bg;
    ctx.fillRect(0, 0, width, height);
    drawText(ctx, 'LEAGUE RULES', width / 2, theme.pad, { size, align: 'center', color: c.accent, shadow: c.shadow });
    const top = theme.pad + theme.lineHeight;
    const hintH = hintBarHeight(theme);
    const bottom = height - hintH - theme.pad * 2;
    const note = wrapText('Applies to every game from the next one on, played or simulated.', width - theme.pad * 4, size);
    const panel = drawPanel(ctx, theme, theme.pad, top, width - theme.pad * 2, bottom - top, { style: 'raised' });
    const listH = panel.h - note.length * theme.lineHeight;
    this.menu = refitMenu(this.menu, rowsThatFit(theme, listH, 2));
    this.menu.draw(ctx, theme, panel.x, panel.y, panel.w, { time: rc.time });
    note.forEach((line, i) => drawText(ctx, line, panel.x, panel.y + listH + i * theme.lineHeight, { color: c.textDim, size }));
    const input = this.services?.input;
    drawHintBar(ctx, theme, [
      { glyph: `${glyphOf(input, 'menuLeft')} ${glyphOf(input, 'menuRight')}`, label: 'Change' },
      { glyph: glyphOf(input, 'back'), label: 'Back' },
    ], width, height - hintH - theme.pad);
  }
}
