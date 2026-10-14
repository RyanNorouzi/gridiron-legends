/**
 * Franchise save management.
 * - FranchiseMenuScreen: the main menu's Franchise entry: Continue (the newest save), New franchise, Load
 *   franchise (N saves), Back.
 * - LoadFranchiseScreen: every save slot (name, team, season + week, last update, size) in a sortable table.
 *   Confirm / tap on a slot offers Load, Rename (letter grid), Export (a downloadable JSON file in the browser;
 *   headless the text is returned), Delete (confirmed). IMPORT (the button or Y) reads a JSON file through the
 *   browser file picker. A save whose metadata cannot be read (listed damaged by the slot store) or that fails to
 *   load is marked damaged with the error shown and can still be deleted; the others stay usable.
 * Storage calls are async; the screen redraws as they resolve and every failure becomes a toast.
 */
import type { GameState } from '@/game/types';
import type { League } from '@/franchise/types';
import type { SaveSlotMeta, SlotStore } from '@/save/slots';
import type { InputState } from '../input/types';
import { drawText } from '../render/text';
import type { RenderContext, Screen, ScreenServices } from '../screens/screen';
import { MenuList } from '../widgets/menu';
import { drawHintBar, drawPanel } from '../widgets/panel';
import { DataTable, type Column } from './kit/data-table';
import { drawDataTable, fitCell } from './kit/data-table-view';
import { NAME_ROWS } from './kit/dialog-models';
import { ChoiceDialog, ConfirmDialog, TextEntryDialog } from './kit/dialogs';
import { TERTIARY_ACTIONS, inRect, pressed, type Rect } from './kit/list';
import { SAVE_NAME_MAX, downloadText, exportFileName, fitSaveName, loadableSlots, pickTextFile, saveErrorText, slotRows, type SlotRow } from './shell/save-model';
import { drawButton, glyphOf, hintBarHeight } from './shell/widgets';

/** File bridges (the browser ones by default; tests inject fakes). */
export interface FileBridge {
  download(fileName: string, text: string): string;
  pick(): Promise<string | null>;
}

const BROWSER_FILES: FileBridge = { download: downloadText, pick: pickTextFile };

/** Options of the load screen. */
export interface LoadFranchiseOptions {
  slots: SlotStore;
  /** `game` is a game left in progress in the save (resumed, never replayed), or null. */
  onLoad(league: League, meta: SaveSlotMeta, game?: GameState | null): void;
  onBack?(): void;
  files?: FileBridge;
}

type Row = SlotRow;

/** Last word of a team name ("New Orleans Revelers" -> "Revelers"), the short form when TEAM is narrow. */
const nickname = (team: string): string => team.trim().split(/\s+/).at(-1) ?? team;

// Side columns carry a priority so narrow (large text) layouts drop them and keep the save names readable; the
// selected save's full details show on the line under the table.
const columns: Column<Row>[] = [
  { key: 'name', label: 'SAVE', flex: 6, minWidth: 20, format: (r) => (r.damaged ? { text: `! ${r.name}`, tone: 'danger' } : r.name), sortValue: (r) => r.name, defaultDir: 'asc' },
  { key: 'mode', label: 'MODE', width: 9, priority: 2, format: (r) => ({ text: r.mode, tone: r.mode === 'Franchise' ? 'dim' : 'info' }), sortValue: (r) => r.mode, defaultDir: 'asc' },
  { key: 'team', label: 'TEAM', flex: 1, minWidth: 8, priority: 4, format: (r) => ({ text: r.team, tone: 'dim' }), shorten: nickname, sortValue: (r) => r.team, defaultDir: 'asc' },
  { key: 'when', label: 'SEASON', flex: 1, minWidth: 13, format: (r) => `${r.season}${r.inGame ? ' · IN GAME' : ''}`, shorten: (t) => t.replace(' · IN GAME', ' ●'), sortValue: (r) => r.when },
  { key: 'updated', label: 'SAVED', width: 12, priority: 3, format: (r) => ({ text: r.updated, tone: 'dim' }), sortValue: (r) => r.updatedAt },
  { key: 'size', label: 'SIZE', width: 7, priority: 5, align: 'right', format: (r) => ({ text: r.size, tone: 'dim' }), sortValue: (r) => r.sizeBytes },
];

/** Full details of a save for the line under the table. */
export const slotDetail = (r: Row): string => [r.name, r.mode, r.team, r.season, ...(r.inGame ? ['IN GAME'] : []), `Saved ${r.updated}`, r.size].join(' · ');

/** The save-slot list. */
export class LoadFranchiseScreen implements Screen {
  readonly id = 'franchise-load';
  private services: ScreenServices | null = null;
  readonly table: DataTable<Row>;
  private readonly damaged = new Map<string, string>();
  private metas: SaveSlotMeta[] = [];
  private loading = true;
  private importRect: Rect | null = null;
  private readonly files: FileBridge;

  constructor(private readonly opts: LoadFranchiseOptions) {
    this.files = opts.files ?? BROWSER_FILES;
    this.table = new DataTable(columns, [], { rowId: (r) => r.id, initialSort: { key: 'updated', dir: 'desc' }, emptyText: 'No saved franchises' });
  }

  get slots(): readonly SaveSlotMeta[] { return this.metas; }
  get isLoading(): boolean { return this.loading; }

  enter(services: ScreenServices): void {
    this.services = services;
    void this.refresh();
  }

  exit(): void { this.services = null; }
  resume(): void { this.syncRows(); }

  private toast(msg: string): void { this.services?.toast(msg); }

  private syncRows(): void {
    this.table.setRows(slotRows(this.metas).map((r) => ({ ...r, damaged: this.damaged.get(r.id) ?? r.damaged })));
  }

  /** Re-reads the slot list. */
  async refresh(): Promise<void> {
    this.loading = true;
    try {
      this.metas = await this.opts.slots.list();
    } catch (err) {
      this.toast(saveErrorText(err, 'Reading saves'));
    }
    this.loading = false;
    this.syncRows();
  }

  /** Loads a slot and hands it to onLoad; false (slot marked damaged) when it cannot be read. */
  async load(id: string): Promise<boolean> {
    try {
      const loaded = await this.opts.slots.load(id);
      if (!loaded.league.userTeamId) throw new Error('the save has no user team');
      if (loaded.gameError) this.toast('The unfinished game in this save was damaged and skipped');
      this.opts.onLoad(loaded.league, loaded.meta, loaded.game);
      return true;
    } catch (err) {
      const msg = saveErrorText(err, 'Loading');
      this.damaged.set(id, msg);
      this.syncRows();
      this.toast(msg);
      return false;
    }
  }

  async rename(id: string, name: string): Promise<boolean> {
    try {
      await this.opts.slots.rename(id, name);
      await this.refresh();
      return true;
    } catch (err) {
      this.toast(saveErrorText(err, 'Rename'));
      return false;
    }
  }

  async remove(id: string): Promise<boolean> {
    try {
      await this.opts.slots.delete(id);
      this.damaged.delete(id);
      await this.refresh();
      this.toast('Save deleted');
      return true;
    } catch (err) {
      this.toast(saveErrorText(err, 'Delete'));
      return false;
    }
  }

  /** Exports a slot (download in the browser); resolves the JSON text, or null on failure. */
  async exportSlot(id: string): Promise<string | null> {
    try {
      const text = await this.opts.slots.export(id);
      const meta = this.metas.find((m) => m.id === id);
      this.files.download(exportFileName(meta?.name ?? id), text);
      this.toast('Save exported');
      return text;
    } catch (err) {
      this.toast(saveErrorText(err, 'Export'));
      return null;
    }
  }

  /** Imports an export (or bare league JSON) into a new slot. */
  async importText(text: string): Promise<SaveSlotMeta | null> {
    try {
      const meta = await this.opts.slots.import(text);
      await this.refresh();
      this.table.selectById(meta.id);
      this.toast(`Imported ${meta.name}`);
      return meta;
    } catch (err) {
      this.toast(saveErrorText(err, 'Import'));
      return null;
    }
  }

  /** Opens the file picker and imports the chosen file. */
  async importFile(): Promise<SaveSlotMeta | null> {
    const text = await this.files.pick();
    if (text === null) {
      this.toast('No file chosen');
      return null;
    }
    return this.importText(text);
  }

  /** The per-slot action menu. */
  openActions(row: Row): void {
    const s = this.services;
    if (!s) return;
    const unreadable = this.metas.find((m) => m.id === row.id)?.damaged !== undefined;
    const options = unreadable
      ? [{ id: 'delete', label: 'Delete' }, { id: 'cancel', label: 'Cancel' }]
      : [{ id: 'load', label: 'Load' }, { id: 'rename', label: 'Rename' }, { id: 'export', label: 'Export' }, { id: 'delete', label: 'Delete' }, { id: 'cancel', label: 'Cancel' }];
    s.stack.push(new ChoiceDialog(row.name, row.damaged ?? `${row.team} - ${row.when}`, options, (id) => {
      if (id === 'load') void this.load(row.id);
      else if (id === 'export') void this.exportSlot(row.id);
      else if (id === 'rename') {
        s.stack.push(new TextEntryDialog('Rename save', '', { initial: fitSaveName(row.name), maxLength: SAVE_NAME_MAX, rows: NAME_ROWS, casing: 'title' }, (name) => {
          if (name !== null) void this.rename(row.id, name);
        }));
      } else if (id === 'delete') {
        s.stack.push(new ConfirmDialog('Delete save?', `${row.name} will be gone for good.`, { defaultNo: true, yesLabel: 'Delete', noLabel: 'Keep', onResult: (yes) => { if (yes) void this.remove(row.id); } }));
      }
    }));
  }

  private back(): void {
    if (this.opts.onBack) this.opts.onBack();
    else if (this.services?.stack.top === this) this.services.stack.pop();
  }

  update(dt: number, input: InputState): void {
    const p = input.pointer;
    if ((p?.justDown && this.importRect && inRect(this.importRect, p.x, p.y)) || pressed(input, TERTIARY_ACTIONS)) {
      void this.importFile();
      return;
    }
    const ev = this.table.update(dt, input);
    if (ev?.type === 'activate') this.openActions(ev.row);
    else if (ev?.type === 'back') this.back();
  }

  render(rc: RenderContext): void {
    const theme = this.services?.theme ?? rc.theme;
    const { ctx, width, height } = rc;
    const c = theme.colors;
    const size = theme.textScale;
    ctx.fillStyle = c.bg;
    ctx.fillRect(0, 0, width, height);
    drawText(ctx, 'LOAD FRANCHISE', width / 2, theme.pad, { size, align: 'center', color: c.accent, shadow: c.shadow });
    const top = theme.pad + theme.lineHeight;
    const hintH = hintBarHeight(theme);
    const bottom = height - hintH - theme.pad;
    const tableRect = { x: theme.pad, y: top, w: width - theme.pad * 2, h: bottom - top - theme.lineHeight - theme.gap * 2 };
    if (this.loading && this.metas.length === 0) drawText(ctx, 'Reading saves...', width / 2, top + theme.lineHeight, { size, align: 'center', color: c.textDim });
    else drawDataTable(ctx, theme, this.table, tableRect);
    const sel = this.table.selected;
    this.importRect = drawButton(ctx, theme, 'IMPORT', width - theme.pad, bottom - theme.lineHeight - theme.gap, true, 'right');
    const detailW = Math.max(0, this.importRect.x - theme.gap - theme.pad);
    if (sel) drawText(ctx, fitCell(sel.damaged ?? slotDetail(sel), detailW, size), theme.pad, tableRect.y + tableRect.h + theme.gap, { color: sel.damaged ? c.danger : c.textDim, size });
    const input = this.services?.input;
    drawHintBar(ctx, theme, [
      { glyph: glyphOf(input, 'confirm'), label: 'Options' },
      { glyph: glyphOf(input, 'audible'), label: 'Import' },
      { glyph: glyphOf(input, 'back'), label: 'Back' },
    ], width, height - hintH - theme.pad);
  }
}

/** Callbacks of the Franchise menu. */
export interface FranchiseMenuOptions {
  slots: SlotStore;
  onNew(): void;
  onLoadList(): void;
  /** Continue the newest save. */
  onContinue(meta: SaveSlotMeta): void;
  onBack?(): void;
}

/** New / continue / load chooser behind the main menu's Franchise entry. */
export class FranchiseMenuScreen implements Screen {
  readonly id = 'franchise-menu';
  private services: ScreenServices | null = null;
  private metas: SaveSlotMeta[] = [];
  readonly menu = new MenuList([]);

  constructor(private readonly opts: FranchiseMenuOptions) {
    this.syncItems();
  }

  /** The newest save that can be loaded (damaged listings are skipped). */
  get newest(): SaveSlotMeta | null { return loadableSlots(this.metas)[0] ?? null; }

  private syncItems(): void {
    const newest = this.newest;
    const hadContinue = this.menu.items.some((i) => i.id === 'continue');
    this.menu.setItems([
      ...(newest ? [{ id: 'continue', label: 'Continue', subLabel: newest.name === newest.teamName ? newest.name : `${newest.name} - ${newest.teamName}` }] : []),
      { id: 'new', label: 'New franchise' },
      { id: 'load', label: `Load franchise (${this.metas.length})`, disabled: this.metas.length === 0 },
      { id: 'back', label: 'Back' },
    ]);
    // Continuing is the likely choice once a save shows up.
    if (newest && !hadContinue) this.menu.select(0);
  }

  /** Re-reads the slots (continue / load entries). */
  async refresh(): Promise<void> {
    try {
      this.metas = await this.opts.slots.list();
    } catch {
      this.metas = [];
    }
    this.syncItems();
  }

  enter(services: ScreenServices): void {
    this.services = services;
    void this.refresh();
  }

  exit(): void { this.services = null; }
  resume(): void { void this.refresh(); }

  private back(): void {
    if (this.opts.onBack) this.opts.onBack();
    else if (this.services?.stack.top === this) this.services.stack.pop();
  }

  update(dt: number, input: InputState): void {
    const ev = this.menu.update(dt, input);
    if (ev?.type === 'back') return this.back();
    if (ev?.type !== 'activate') return;
    const newest = this.newest;
    if (ev.item.id === 'continue' && newest) this.opts.onContinue(newest);
    else if (ev.item.id === 'new') this.opts.onNew();
    else if (ev.item.id === 'load') this.opts.onLoadList();
    else if (ev.item.id === 'back') this.back();
  }

  render(rc: RenderContext): void {
    const theme = this.services?.theme ?? rc.theme;
    const { ctx, width, height } = rc;
    ctx.fillStyle = theme.colors.bg;
    ctx.fillRect(0, 0, width, height);
    drawText(ctx, 'FRANCHISE', width / 2, theme.pad, { size: theme.textScale, align: 'center', color: theme.colors.accent, shadow: theme.colors.shadow });
    const w = Math.min(width - theme.pad * 2, 260 * theme.textScale);
    const hintH = hintBarHeight(theme);
    const top = theme.pad + theme.lineHeight * 2;
    const panel = drawPanel(ctx, theme, Math.round((width - w) / 2), top, w, Math.min(height - top - hintH - theme.pad * 2, this.menu.measure(theme) + theme.pad * 2), { style: 'raised' });
    this.menu.draw(ctx, theme, panel.x, panel.y, panel.w, { time: rc.time });
    const input = this.services?.input;
    drawHintBar(ctx, theme, [
      { glyph: glyphOf(input, 'confirm'), label: 'Select' },
      { glyph: glyphOf(input, 'back'), label: 'Back' },
    ], width, height - hintH - theme.pad);
  }
}
