/**
 * Remap Controls screen (opened from Settings > CONTROLS): every action, grouped (menus, movement, pre-snap,
 * ball carrier, passing, defense, kicking, between plays, watch, replay, developer), with its gamepad button and
 * the keyboard keys that press it. Confirm on an action waits for the next button press on any device
 * (keyboard, gamepad, mouse) and assigns it; Left/Right step through the buttons. An assignment that would
 * clash with another action read in the same situation swaps that action onto the freed button; remaining
 * clashes are marked "!" and named on the detail line. Esc / Back (the select button) cancels a capture, which
 * also times out. Changes apply live and persist through the Settings persist callback.
 */
import type { Settings } from '@/core/settings';
import {
  CONTROL_GROUPS, actionLabel, assignButton, captureScheme, capturedButton, conflictsFor, describeButton, findConflicts,
} from '../input/remap';
import { BUTTONS, loadDefaultProfile, schemeToSettings, settingsToScheme } from '../input/schemes';
import type { Action, Button, ControlScheme, InputState } from '../input/types';
import { drawText, fitLines } from '../render/text';
import { MenuList, type MenuItem } from '../widgets/menu';
import { drawHintBar, drawPanel } from '../widgets/panel';
import type { RenderContext, Screen, ScreenServices } from './screen';

/** Seconds a capture waits for a press. */
export const CAPTURE_SECONDS = 5;

export interface RemapOptions {
  persist?: (settings: Settings) => void | Promise<unknown>;
}

interface Capture {
  action: Action;
  remaining: number;
  saved: ControlScheme;
}

export class RemapScreen implements Screen {
  readonly id = 'remap';
  private menu: MenuList;
  private scheme: ControlScheme;
  private services: ScreenServices | null = null;
  private capture: Capture | null = null;
  private note: string | null = null;

  constructor(private readonly settings: Settings, private readonly opts: RemapOptions = {}) {
    this.scheme = settingsToScheme(settings.bindings);
    this.menu = new MenuList(this.items(), { maxVisible: 8, initialIndex: 1 });
  }

  get list(): MenuList { return this.menu; }
  get controlScheme(): ControlScheme { return this.scheme; }
  /** The action waiting for a press, or null. */
  get capturing(): Action | null { return this.capture?.action ?? null; }
  /** Last assignment message ("SWAPPED WITH JUKE"), or null. */
  get lastNote(): string | null { return this.note; }

  private items(): MenuItem[] {
    const out: MenuItem[] = [];
    for (const g of CONTROL_GROUPS) {
      out.push({ id: `group:${g.id}`, label: `- ${g.label} -`, disabled: true });
      for (const a of g.actions) {
        const clash = conflictsFor(this.scheme, a).length > 0;
        out.push({ id: `bind:${a}`, label: actionLabel(a), value: `${this.scheme[a].map((b) => b.toUpperCase()).join('/')}${clash ? ' !' : ''}` });
      }
    }
    out.push({ id: 'reset', label: 'RESET TO DEFAULTS' }, { id: 'back', label: 'BACK' });
    return out;
  }

  enter(services: ScreenServices): void {
    this.services = services;
    this.scheme = settingsToScheme(this.settings.bindings);
    this.menu.setItems(this.items());
  }

  exit(services: ScreenServices): void {
    if (this.capture) services.input.setScheme(this.capture.saved);
    this.capture = null;
    this.services = null;
  }

  private apply(next: ControlScheme): void {
    this.scheme = next;
    this.settings.bindings = schemeToSettings(next);
    this.services?.input.setScheme(next);
    void this.opts.persist?.(this.settings);
    this.menu.setItems(this.items());
  }

  /** Assigns `button` to `action` (swapping clashes); exported for tests and the capture flow. */
  assign(action: Action, button: Button): void {
    const r = assignButton(this.scheme, action, button);
    const parts = [`${actionLabel(action)} ON ${button.toUpperCase()}`];
    if (r.swapped.length > 0) parts.push(`SWAPPED WITH ${r.swapped.map(actionLabel).join(', ')}`);
    if (r.conflicts.length > 0) parts.push(`CLASHES: ${r.conflicts.map(actionLabel).join(', ')}`);
    this.note = parts.join(' · ');
    this.apply(r.scheme);
  }

  /** Steps the action's primary button through the button list. */
  cycle(action: Action, delta: -1 | 1): void {
    const current = this.scheme[action][0] ?? 'a';
    const i = BUTTONS.indexOf(current);
    const next = BUTTONS[((i + delta) % BUTTONS.length + BUTTONS.length) % BUTTONS.length] as Button;
    this.assign(action, next);
  }

  /** Starts waiting for a press for `action`. */
  startCapture(action: Action): void {
    const services = this.services;
    if (!services) return;
    this.capture = { action, remaining: CAPTURE_SECONDS, saved: this.scheme };
    services.input.setScheme(captureScheme());
  }

  private endCapture(button: Button | null): void {
    const c = this.capture;
    if (!c) return;
    this.capture = null;
    this.services?.input.setScheme(c.saved);
    if (button) this.assign(c.action, button);
    else this.note = 'NO CHANGE';
  }

  reset(): void {
    this.note = 'DEFAULT CONTROLS RESTORED';
    this.apply(loadDefaultProfile().scheme);
  }

  update(dt: number, input: InputState, services: ScreenServices): void {
    if (this.capture) {
      const b = capturedButton(input);
      this.capture.remaining -= dt;
      // The select button (Esc / Backspace / pad Back) cancels; it can still be chosen with Left / Right.
      if (b === 'select' || this.capture.remaining <= 0) this.endCapture(null);
      else if (b) this.endCapture(b);
      return;
    }
    const ev = this.menu.update(dt, input);
    if (!ev) return;
    if (ev.type === 'back') {
      services.stack.pop();
      return;
    }
    const id = 'item' in ev ? ev.item.id : '';
    const action = id.startsWith('bind:') ? (id.slice(5) as Action) : null;
    if (ev.type === 'change' && action) this.cycle(action, ev.delta);
    else if (ev.type === 'activate') {
      if (action) this.startCapture(action);
      else if (id === 'reset') this.reset();
      else if (id === 'back') services.stack.pop();
    } else if (ev.type === 'select') this.note = null;
  }

  /** Detail line for the selected row: buttons with keys, and clashes. */
  detail(): { text: string; danger: boolean } {
    const c = this.capture;
    if (c) return { text: `PRESS A BUTTON OR KEY FOR ${actionLabel(c.action)} · ESC CANCELS · ${Math.max(0, Math.ceil(c.remaining))}s`, danger: false };
    if (this.note) return { text: this.note, danger: this.note.includes('CLASHES') };
    const id = this.menu.selected?.id ?? '';
    if (!id.startsWith('bind:')) {
      const n = findConflicts(this.scheme).length;
      return { text: n > 0 ? `${n} CLASH${n === 1 ? '' : 'ES'} IN THIS LAYOUT` : 'NO CLASHES', danger: n > 0 };
    }
    const action = id.slice(5) as Action;
    const keyboard = this.services?.input.getDeviceMap().keyboard ?? loadDefaultProfile().deviceMap.keyboard;
    const clashes = conflictsFor(this.scheme, action);
    const pad = this.scheme[action].map((b) => describeButton(b, keyboard)).join(' / ');
    return clashes.length > 0 ? { text: `${pad} · CLASHES: ${clashes.map(actionLabel).join(', ')}`, danger: true } : { text: pad, danger: false };
  }

  render(rc: RenderContext): void {
    const { ctx, width, height } = rc;
    const theme = this.services?.theme ?? rc.theme;
    const c = theme.colors;
    const size = theme.textScale;
    ctx.fillStyle = c.bg;
    ctx.fillRect(0, 0, width, height);
    const hintH = theme.glyphH + 4 * size;
    const content = drawPanel(ctx, theme, theme.pad, theme.pad, width - theme.pad * 2, height - hintH - theme.pad * 3, { style: 'raised', title: 'CONTROLS' });
    const detailLines = size > 1 ? 2 : 1;
    const rows = Math.max(1, Math.floor((content.h - (theme.glyphH + theme.gap) * detailLines - theme.gap) / theme.lineHeight));
    if (this.menu.maxVisible !== rows) this.menu = new MenuList(this.menu.items, { maxVisible: rows, initialIndex: Math.max(0, this.menu.selectedIndex) });
    this.menu.draw(ctx, theme, content.x, content.y, content.w, { time: rc.time });
    const d = this.detail();
    const lines = fitLines(d.text, content.w, detailLines, size);
    lines.forEach((line, i) => {
      drawText(ctx, line, content.x, content.y + content.h - (theme.glyphH + theme.gap) * (lines.length - i), { color: d.danger ? c.danger : this.capture ? c.accent : c.textDim, size });
    });
    const input = this.services?.input;
    drawHintBar(ctx, theme, this.capture ? [{ glyph: 'ESC', label: 'CANCEL' }] : [
      { glyph: input?.glyph('confirm') ?? 'A', label: 'PRESS NEW' },
      { glyph: `${input?.glyph('menuLeft') ?? '←'} ${input?.glyph('menuRight') ?? '→'}`, label: 'CHANGE' },
      { glyph: input?.glyph('back') ?? 'B', label: 'BACK' },
    ], width, height - hintH - theme.pad);
  }
}
