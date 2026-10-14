import { describe, expect, it, vi } from 'vitest';

const drawn: { text: string; x: number; y: number }[] = [];
vi.mock('@/ui/render/text', async (orig) => {
  const m = await orig<typeof import('@/ui/render/text')>();
  return { ...m, drawText: (...a: Parameters<typeof m.drawText>) => { drawn.push({ text: String(a[1]), x: a[2], y: a[3] }); return m.drawText(...a); } };
});

import type { RenderContext, Screen } from '@/ui/screens/screen';
import { PauseScreen } from '@/ui/screens/pause';
import { makeUi } from './fixtures';

const actions = { hasReplay: () => false, onReplay: () => undefined, canTimeout: () => false, onTimeout: () => false, onSettings: () => undefined, onQuit: () => undefined, quitWarning: 'Leaving lets you sim the rest' };

describe('pause menu layout (APP2-16b, H2-16)', () => {
  it('draws the quit warning inside the panel, under its title', () => {
    const ui = makeUi();
    const pause = new PauseScreen(actions);
    ui.stack.push(pause);
    pause.activate('quit');
    drawn.length = 0;
    pause.render(ui.rc);
    const title = drawn.find((d) => d.text === 'PAUSED');
    const warn = drawn.find((d) => d.text.includes('LEAVING'));
    const firstItem = drawn.find((d) => d.text.toUpperCase().includes('RESUME') && d !== title);
    expect(title && warn).toBeTruthy();
    expect(warn?.y ?? 0).toBeGreaterThan(title?.y ?? 0);
    expect(warn?.y ?? 0).toBeLessThan(firstItem?.y ?? Infinity);
  });

  it('leaves the hint strip to a screen opened over it', () => {
    const ui = makeUi();
    const pause = new PauseScreen(actions);
    ui.stack.push(pause);
    drawn.length = 0;
    pause.render(ui.rc);
    expect(drawn.some((d) => d.text === 'SELECT')).toBe(true);
    const cover: Screen = { id: 'cover', overlay: true, enter: () => undefined, exit: () => undefined, update: () => undefined, render: (_rc: RenderContext) => undefined };
    ui.stack.push(cover);
    drawn.length = 0;
    pause.render(ui.rc);
    expect(drawn.some((d) => d.text === 'SELECT')).toBe(false);
  });
});
