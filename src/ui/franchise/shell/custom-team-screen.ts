/**
 * Custom-team editor (new-franchise wizard): a list of fields with a live preview. City and name open the
 * on-screen letter grid, the abbreviation opens it with letters only (exactly three); primary / secondary colour,
 * logo and the team slot cycle with Left/Right (a tap or Confirm steps forward). The preview shows the logo in
 * the chosen colours and the colour check for normal vision and each colorblind mode. CREATE is enabled once
 * `draftErrors` is empty; Back leaves.
 */
import type { Team } from '@/teams/types';
import type { InputState } from '../../input/types';
import { drawTeamLogo } from '../../render/logo';
import { drawText } from '../../render/text';
import type { RenderContext, Screen, ScreenServices } from '../../screens/screen';
import { MenuList, type MenuItem } from '../../widgets/menu';
import { drawHintBar, drawPanel } from '../../widgets/panel';
import { fitCell } from '../kit/data-table-view';
import { ABBR_ROWS, NAME_ROWS } from '../kit/dialog-models';
import { TextEntryDialog } from '../kit/dialogs';
import { humanize } from '../kit/format';
import { cycleOption } from '../kit/list';
import {
  colorChecks, cyclePalette, cycleLogoSeed, defaultDraft, draftColors, draftErrors, paletteName, type CustomTeamDraft,
} from './custom-team';
import { drawTeamBadge, glyphOf, hintBarHeight, refitMenu, rowsThatFit } from './widgets';

type Field = 'city' | 'name' | 'abbr' | 'primary' | 'secondary' | 'logo' | 'slot' | 'create';

/** Options of the editor. */
export interface CustomTeamOptions {
  teams: readonly Team[];
  initial?: CustomTeamDraft;
  onCreate(draft: CustomTeamDraft): void;
  onBack?(): void;
}

/** Full-screen custom-team editor. */
export class CustomTeamScreen implements Screen {
  readonly id = 'franchise-custom-team';
  readonly draft: CustomTeamDraft;
  private services: ScreenServices | null = null;
  private menu: MenuList;
  private readonly slots: string[];

  constructor(private readonly opts: CustomTeamOptions) {
    this.draft = { ...(opts.initial ?? defaultDraft(opts.teams)) };
    this.slots = [...opts.teams].sort((a, b) => a.city.localeCompare(b.city)).map((t) => t.abbr);
    this.menu = new MenuList(this.items());
  }

  get list(): MenuList { return this.menu; }
  /** Current validation errors. */
  get errors(): string[] { return draftErrors(this.draft, this.opts.teams); }

  private slotLabel(): string {
    const t = this.opts.teams.find((x) => x.abbr === this.draft.replaces);
    return t ? `${t.abbr} ${t.division}` : '-';
  }

  private items(): MenuItem[] {
    const d = this.draft;
    return [
      { id: 'city', label: 'City', value: d.city || '-' },
      { id: 'name', label: 'Name', value: d.name || '-' },
      { id: 'abbr', label: 'Abbreviation', value: d.abbr || '-' },
      { id: 'primary', label: 'Primary', value: paletteName(d.primary) },
      { id: 'secondary', label: 'Secondary', value: paletteName(d.secondary) },
      { id: 'logo', label: 'Logo', value: `#${d.logoSeed}` },
      { id: 'slot', label: 'Takes over', value: this.slotLabel() },
      { id: 'create', label: 'Create team', disabled: this.errors.length > 0 },
    ];
  }

  private refresh(): void {
    this.menu.setItems(this.items());
  }

  enter(services: ScreenServices): void { this.services = services; }
  exit(): void { this.services = null; }
  resume(): void { this.refresh(); }

  /** Steps a cycling field (exported for tests). */
  change(field: Field, delta: number): void {
    const d = this.draft;
    if (field === 'primary') d.primary = cyclePalette(d.primary, delta);
    else if (field === 'secondary') d.secondary = cyclePalette(d.secondary, delta);
    else if (field === 'logo') d.logoSeed = cycleLogoSeed(d.logoSeed, delta);
    else if (field === 'slot') d.replaces = cycleOption(this.slots, d.replaces, delta);
    this.refresh();
  }

  /** Sets a text field directly (tests; the letter grid calls it). */
  setText(field: 'city' | 'name' | 'abbr', text: string): void {
    this.draft[field] = field === 'abbr' ? text.toUpperCase() : text;
    this.refresh();
  }

  private edit(field: 'city' | 'name' | 'abbr'): void {
    const s = this.services;
    if (!s) return;
    const abbr = field === 'abbr';
    const taken = new Set(this.opts.teams.filter((t) => t.abbr !== this.draft.replaces).map((t) => t.abbr));
    s.stack.push(new TextEntryDialog(abbr ? 'Abbreviation' : field === 'city' ? 'City' : 'Team name', abbr ? 'Three letters, unique in the league' : '', {
      initial: this.draft[field], maxLength: abbr ? 3 : 16, minLength: abbr ? 3 : 1, rows: abbr ? ABBR_ROWS : NAME_ROWS,
      allowSpace: !abbr, casing: abbr ? 'upper' : 'title', ...(abbr ? { validate: (t: string) => (taken.has(t.toUpperCase()) ? `${t.toUpperCase()} is taken` : null) } : {}),
    }, (text) => { if (text !== null) this.setText(field, text); }));
  }

  /** Creates the team when the draft is valid; returns false (with a toast) otherwise. */
  create(): boolean {
    const errors = this.errors;
    if (errors.length > 0) {
      this.services?.toast(errors[0] as string);
      return false;
    }
    this.opts.onCreate({ ...this.draft });
    return true;
  }

  update(dt: number, input: InputState): void {
    const ev = this.menu.update(dt, input);
    if (!ev) return;
    if (ev.type === 'back') {
      if (this.opts.onBack) this.opts.onBack();
      else if (this.services?.stack.top === this) this.services.stack.pop();
      return;
    }
    const field = 'item' in ev ? (ev.item.id as Field) : null;
    if (!field) return;
    if (ev.type === 'change') this.change(field, ev.delta);
    else if (ev.type === 'activate') {
      if (field === 'city' || field === 'name' || field === 'abbr') this.edit(field);
      else if (field === 'create') this.create();
      else this.change(field, 1);
    }
  }

  render(rc: RenderContext): void {
    const theme = this.services?.theme ?? rc.theme;
    const { ctx, width, height } = rc;
    const c = theme.colors;
    const size = theme.textScale;
    ctx.fillStyle = c.bg;
    ctx.fillRect(0, 0, width, height);
    drawText(ctx, 'CUSTOM TEAM', width / 2, theme.pad, { size, align: 'center', color: c.accent, shadow: c.shadow });
    let top = theme.pad + theme.lineHeight;
    const hintH = hintBarHeight(theme);
    const bottom = height - hintH - theme.pad * 2;
    // Large text: a compact preview strip above a full-width list; otherwise the preview sits beside the list.
    const compact = size > 1;
    if (compact) top += this.drawStrip(rc, theme.pad, top, width - theme.pad * 2) + theme.gap;
    const previewW = compact ? 0 : Math.round(Math.min(170, width * 0.36));
    const listW = width - theme.pad * 2 - (compact ? 0 : previewW + theme.pad);
    const panel = drawPanel(ctx, theme, theme.pad, top, listW, bottom - top, { style: 'raised' });
    this.menu = refitMenu(this.menu, rowsThatFit(theme, panel.h, 2));
    this.menu.draw(ctx, theme, panel.x, panel.y, panel.w, { time: rc.time });
    if (!compact) this.drawPreview(rc, theme.pad * 2 + listW, top, previewW, bottom - top);
    const input = this.services?.input;
    drawHintBar(ctx, theme, [
      { glyph: `${glyphOf(input, 'menuLeft')} ${glyphOf(input, 'menuRight')}`, label: 'Change' },
      { glyph: glyphOf(input, 'confirm'), label: 'Edit' },
      { glyph: glyphOf(input, 'back'), label: 'Back' },
    ], width, height - hintH - theme.pad);
  }

  /** Large-text preview: logo, colour swatches and a one-line colour check. Returns its height. */
  private drawStrip(rc: RenderContext, x: number, y: number, w: number): number {
    const theme = this.services?.theme ?? rc.theme;
    const { ctx } = rc;
    const d = this.draft;
    const colors = draftColors(d);
    const h = theme.lineHeight * 2;
    drawTeamLogo(ctx, d.logoSeed, colors, h - 2, x, y);
    const tx = x + h + theme.gap;
    const sw = theme.lineHeight - 4;
    ctx.fillStyle = colors.primary;
    ctx.fillRect(tx, y + 2, sw * 2, sw);
    ctx.fillStyle = colors.secondary;
    ctx.fillRect(tx + sw * 2, y + 2, sw * 2, sw);
    drawText(ctx, fitCell(d.abbr || '---', Math.max(0, x + w - tx - sw * 4 - theme.gap), theme.textScale), tx + sw * 4 + theme.gap, y + 2, { color: theme.colors.text, size: theme.textScale });
    const bad = colorChecks(d).filter((ch) => !ch.ok);
    const text = bad.length === 0 ? 'Colours OK for all vision' : `Clash: ${bad.map((b) => (b.mode === 'none' ? 'normal' : humanize(b.mode))).join(', ')}`;
    drawText(ctx, fitCell(text, Math.max(0, x + w - tx), theme.textScale), tx, y + theme.lineHeight, { color: bad.length === 0 ? theme.colors.success : theme.colors.warning, size: theme.textScale });
    return h;
  }

  private drawPreview(rc: RenderContext, x: number, y: number, w: number, h: number): void {
    const theme = this.services?.theme ?? rc.theme;
    const { ctx } = rc;
    const content = drawPanel(ctx, theme, x, y, w, h, { style: 'raised', title: 'Preview' });
    const d = this.draft;
    const colors = draftColors(d);
    const logo = Math.min(48, theme.lineHeight * 4);
    const used = drawTeamBadge(ctx, theme, { city: d.city || '-', name: d.name || '-', abbr: d.abbr, logoSeed: d.logoSeed, colors }, content.x, content.y, content.w, logo, [d.abbr || '---']);
    let ly = content.y + used + theme.gap;
    const sw = Math.max(8, theme.lineHeight);
    ctx.fillStyle = colors.primary;
    ctx.fillRect(content.x, ly, sw * 2, sw);
    ctx.fillStyle = colors.secondary;
    ctx.fillRect(content.x + sw * 2, ly, sw * 2, sw);
    ly += sw + theme.gap;
    const size = theme.textScale;
    for (const check of colorChecks(d)) {
      if (ly + theme.glyphH > content.y + content.h) break;
      const label = check.mode === 'none' ? 'Normal' : humanize(check.mode);
      drawText(ctx, fitCell(`${check.ok ? 'OK' : '!!'} ${label}`, content.w, size), content.x, ly, { color: check.ok ? theme.colors.success : theme.colors.warning, size });
      ly += theme.lineHeight;
    }
  }
}
