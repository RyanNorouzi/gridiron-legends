import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '@/core/settings';
import { createNullInput } from '@/ui/app';
import { Camera } from '@/ui/camera';
import { SpriteCache } from '@/ui/render/sprites';
import { MAIN_MENU_ITEMS, MainMenuScreen, UNAVAILABLE_MESSAGE, drawTitle, titleHeight, type MainMenuActions } from '@/ui/screens/main-menu';
import type { RenderContext, ScreenServices } from '@/ui/screens/screen';
import { ScreenStack } from '@/ui/screens/stack';
import { createTheme } from '@/ui/theme';
import { createFakeCtx, makeInput } from './fake-ctx';

const setup = (actions: MainMenuActions = {}, textSize: 'normal' | 'large' = 'normal') => {
  const settings = { ...DEFAULT_SETTINGS, textSize };
  const stack = new ScreenStack({ fadeSeconds: 0 });
  const toast = vi.fn();
  const services: ScreenServices = {
    stack, settings, theme: createTheme(settings), camera: new Camera(), input: createNullInput(), sprites: new SpriteCache(),
    width: 480, height: 270, time: 0, toast,
  };
  stack.attach(services);
  const screen = new MainMenuScreen(actions, { version: '0.1.0' });
  stack.push(screen);
  const rc: RenderContext = { ctx: createFakeCtx(), width: 480, height: 270, alpha: 0, theme: services.theme, settings, camera: services.camera, sprites: services.sprites, time: 0.4 };
  return { screen, services, toast, rc, stack };
};

describe('MainMenuScreen', () => {
  it('lists every game mode in order', () => {
    expect(MAIN_MENU_ITEMS.map((i) => i.label)).toEqual([
      'QUICK GAME', 'FRANCHISE', 'SEASON', 'PLAYOFFS', 'PRACTICE', 'TUTORIAL', 'DEFENSE PRACTICE', 'OFFENSE PRACTICE', 'CUSTOM GAME', 'WATCH MODE', 'SETTINGS',
    ]);
    const { screen } = setup();
    expect(screen.list.items.map((i) => i.id)).toEqual(MAIN_MENU_ITEMS.map((i) => i.id));
    expect(screen.list.items.every((i) => !i.disabled)).toBe(true);
  });

  it('calls the injected action for a selected item', () => {
    const quickGame = vi.fn();
    const franchise = vi.fn();
    const { screen, services, toast } = setup({ quickGame, franchise });
    screen.update(1 / 60, makeInput({ pressed: ['confirm'] }), services);
    expect(quickGame).toHaveBeenCalledTimes(1);
    screen.update(1 / 60, makeInput({ pressed: ['menuDown'] }), services);
    screen.update(1 / 60, makeInput({ pressed: ['confirm'] }), services);
    expect(franchise).toHaveBeenCalledTimes(1);
    expect(toast).not.toHaveBeenCalled();
  });

  it('shows a toast for modes that have no action yet', () => {
    const { screen, services, toast } = setup({ quickGame: vi.fn() });
    screen.list.select(2);
    screen.update(1 / 60, makeInput({ pressed: ['confirm'] }), services);
    expect(toast).toHaveBeenCalledTimes(1);
    const message = String(toast.mock.calls[0]?.[0]);
    expect(message).toContain(UNAVAILABLE_MESSAGE);
    expect(message).toContain('SEASON');
    expect(screen.activate('settings', services)).toBe(false);
    expect(screen.activate('quickGame', services)).toBe(true);
  });

  it('wraps from the last item to the first', () => {
    const { screen, services } = setup();
    screen.update(1 / 60, makeInput({ pressed: ['menuUp'] }), services);
    expect(screen.list.selected?.id).toBe('settings');
    screen.update(1 / 60, makeInput({ pressed: ['menuDown'] }), services);
    expect(screen.list.selected?.id).toBe('quickGame');
  });

  it('renders the title, panel, list and hints with the pixel font', () => {
    const { screen, rc } = setup();
    screen.render(rc);
    const ctx = rc.ctx as ReturnType<typeof createFakeCtx>;
    expect(ctx.fills.length).toBeGreaterThan(300);
    expect(ctx.fillsWith(rc.theme.colors.accent).length).toBeGreaterThan(10);
    expect(ctx.fillsWith(rc.theme.colors.selection)).toHaveLength(1);
    expect(ctx.fillsWith('#fff0a8').length).toBeGreaterThan(0);
    const listTop = ctx.fillsWith(rc.theme.colors.selection)[0]!.y;
    expect(listTop).toBeGreaterThan(titleHeight(rc.theme));
    for (const f of ctx.fills) {
      expect(f.x).toBeGreaterThanOrEqual(-10);
      expect(f.y).toBeGreaterThanOrEqual(-60);
    }
  });

  it('scrolls the list in large-text mode so every item stays reachable', () => {
    const { screen, services } = setup({}, 'large');
    expect(screen.list.maxVisible).toBeGreaterThan(0);
    expect(screen.list.maxVisible).toBeLessThan(MAIN_MENU_ITEMS.length);
    for (let i = 0; i < MAIN_MENU_ITEMS.length - 1; i++) screen.update(1 / 60, makeInput({ pressed: ['menuDown'] }), services);
    expect(screen.list.selected?.id).toBe('settings');
    expect(screen.list.scroll).toBe(MAIN_MENU_ITEMS.length - screen.list.maxVisible);
    const normal = setup({}, 'normal');
    expect(normal.screen.list.maxVisible).toBe(0);
  });

  it('refits the list when large text is switched on after it was entered (back from Settings)', () => {
    const { screen, rc } = setup({}, 'normal');
    expect(screen.list.maxVisible).toBe(0);
    screen.list.select(3);
    const large = createTheme({ ...DEFAULT_SETTINGS, textSize: 'large' });
    screen.render({ ...rc, theme: large });
    expect(screen.list.maxVisible).toBeGreaterThan(0);
    expect(screen.list.maxVisible).toBeLessThan(MAIN_MENU_ITEMS.length);
    expect(screen.list.selectedIndex).toBe(3);
    screen.render(rc);
    expect(screen.list.maxVisible).toBe(0);
  });

  it('keeps the selection across re-entry', () => {
    const { screen, stack } = setup();
    screen.list.select(4);
    stack.pop();
    stack.push(screen);
    expect(screen.list.selected?.id).toBe('practice');
    screen.exit();
    expect(() => screen.render(setup().rc)).not.toThrow();
  });

  it('drawTitle returns the reserved height', () => {
    const { rc } = setup();
    expect(drawTitle(rc, 240, 0)).toBe(titleHeight(rc.theme));
    expect(titleHeight(createTheme({ ...DEFAULT_SETTINGS, textSize: 'large' }))).toBeGreaterThan(titleHeight(rc.theme));
  });
});
