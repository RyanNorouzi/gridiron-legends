import { describe, expect, it } from 'vitest';
import { createTheme } from '@/ui/theme';
import { defaultSettings } from '@/save/settings-store';
import { InfoView, MAX_STATUS_LINES, actionRow, columnsFor, errorText, info, marketLayout, sanitizeInput, sentence, statusLines, stripActions } from '@/ui/franchise/market/common';
import type { Column } from '@/ui/franchise/kit/data-table';
import { makeInput } from '../../render/fake-ctx';

const theme = (large: boolean) => createTheme({ ...defaultSettings(), textSize: large ? 'large' : 'normal' });

describe('market chrome helpers', () => {
  it('drops the Confirm edge of a mouse click but keeps touch and keyboard confirms', () => {
    const click = makeInput({ pressed: ['confirm'], device: 'mouse', pointer: { x: 1, y: 1, down: true, justDown: true, justUp: false, drag: null } });
    expect(sanitizeInput(click).justPressed.has('confirm')).toBe(false);
    const key = makeInput({ pressed: ['confirm'], device: 'keyboard' });
    expect(sanitizeInput(key)).toBe(key);
    const touch = makeInput({ pressed: ['confirm'], device: 'touch', pointer: { x: 1, y: 1, down: true, justDown: true, justUp: false, drag: null } });
    expect(sanitizeInput(touch).justPressed.has('confirm')).toBe(true);
    const hub = stripActions(makeInput({ pressed: ['menuTabLeft', 'back', 'confirm'] }), ['menuTabLeft', 'back']);
    expect([...hub.justPressed]).toEqual(['confirm']);
    expect([...hub.down]).toEqual(['confirm']);
  });

  it('formats engine errors and picks compact columns in large text', () => {
    expect(errorText(new Error('placeOffer: below his minimum'))).toBe('below his minimum');
    expect(errorText(new Error('the draft is not complete: x'))).toBe('the draft is not complete: x');
    expect(sentence('hello')).toBe('Hello');
    const cols: Column<number>[] = ['a', 'b', 'c'].map((key) => ({ key, label: key, format: String }));
    expect(columnsFor(cols, ['c', 'a'], true).map((c) => c.key)).toEqual(['c', 'a']);
    expect(columnsFor(cols, ['c'], false)).toHaveLength(3);
  });

  it('lays the frame out inside the rect, with title and hints only when pushed', () => {
    for (const large of [false, true]) {
      const t = theme(large);
      const hosted = marketLayout(t, { x: 0, y: 40, w: 480, h: 206 }, false);
      expect(hosted.title).toBeNull();
      expect(hosted.hints).toBeNull();
      expect(hosted.menu.x + hosted.menu.w).toBe(480);
      expect(hosted.body.y + hosted.body.h).toBeLessThanOrEqual(246);
      const pushed = marketLayout(t, { x: 0, y: 0, w: 480, h: 270 }, true);
      expect(pushed.title?.y).toBe(0);
      expect(pushed.body.y + pushed.body.h).toBeLessThanOrEqual(pushed.hints?.y ?? 0);
      const wide = marketLayout(t, { x: 0, y: 40, w: 480, h: 206 }, false, 1, 60);
      expect(wide.menu.w).toBe(60);
      expect(wide.bar.w + wide.menu.w).toBe(480);
    }
  });

  it('wraps a long status line in large text instead of cutting it, and gives it the room', () => {
    const text = 'Market not open · 91 free agents · 18 of your deals expire · Cap $93.7M';
    expect(statusLines(theme(false), text, 480)).toEqual([text]);
    const large = statusLines(theme(true), text, 480);
    expect(large.length).toBe(MAX_STATUS_LINES);
    expect(large.join(' ')).toBe(text);
    const t = theme(true);
    const rect = { x: 0, y: 40, w: 480, h: 206 };
    const one = marketLayout(t, rect, false, 1);
    const two = marketLayout(t, rect, false, large.length);
    expect(two.status.h).toBe(t.lineHeight * 2);
    expect(two.bar.y).toBe(one.bar.y + t.lineHeight);
    expect(two.body.y + two.body.h).toBeLessThanOrEqual(rect.y + rect.h);
    expect(marketLayout(t, rect, false, 9).status.h).toBe(t.lineHeight * MAX_STATUS_LINES);
    const huge = statusLines(t, `${text} · ${text} · ${text}`, 480);
    expect(huge).toHaveLength(MAX_STATUS_LINES);
    expect(huge[1]?.endsWith('...')).toBe(true);
  });

  it('wraps long info values onto continuation rows that keep the action', () => {
    const view = new InfoView();
    const long = 'They value your side at 1376 and theirs at 1920; they need 2035 to say yes to it';
    view.setRows([info('short', 'Verdict', 'Yes'), { ...actionRow('go', 'Submit', long) }]);
    view.fit(theme(true), { x: 0, y: 0, w: 464, h: 200 });
    const ids = view.table.rows.map((r) => r.id);
    expect(ids[0]).toBe('short');
    expect(ids.filter((id) => id.startsWith('go~')).length).toBeGreaterThan(0);
    expect(view.table.rows.filter((r) => r.id.startsWith('go')).every((r) => r.action === 'go')).toBe(true);
    expect(view.rows).toHaveLength(2);
    view.fit(theme(false), { x: 0, y: 0, w: 464, h: 200 });
    expect(view.table.rows.length).toBeLessThan(ids.length);
  });
});
