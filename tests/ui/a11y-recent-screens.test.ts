import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '@/core/settings';
import { vec2 } from '@/core/vec2';
import { MIDDLE_X } from '@/game/types';
import { loadPlaybookData } from '@/playbook/loader';
import { Camera } from '@/ui/camera';
import { drawScene, type FieldScene } from '@/ui/game/field-view';
import { defaultGameplay } from '@/ui/gameplay-prefs';
import { resolveTeamPalettes } from '@/ui/render/palette';
import { SpriteCache } from '@/ui/render/sprites';
import { measureText } from '@/ui/render/text';
import { AssignmentsScreen } from '@/ui/screens/assignments';
import { DifficultyTuningScreen, tweakReadout } from '@/ui/screens/difficulty-tuning';
import { createTheme } from '@/ui/theme';
import { MenuList } from '@/ui/widgets/menu';
import { makeUi } from './game/fixtures';
import { createFakeCtx, makeInput, pointerAt } from './render/fake-ctx';

const theme = createTheme(DEFAULT_SETTINGS);
const big = createTheme({ ...DEFAULT_SETTINGS, textSize: 'large' });

/** Pixel x of a value row's ◀ and ▶ as MenuList draws them (right-aligned at x + w - gap, left of a scroll gutter). */
const arrows = (th: typeof theme, x: number, w: number, value: string, scrolls = false): { dec: number; inc: number } => {
  const right = x + w - th.gap - (scrolls ? measureText('▼', th.textScale).width + th.gap : 0);
  const arrowW = measureText('◀', th.textScale).width;
  return { dec: right - measureText(`◀ ${value} ▶`, th.textScale).width + arrowW / 2, inc: right - arrowW / 2 };
};

describe('menu value rows by touch and mouse', () => {
  it('a tap on ◀ steps the value down, on ▶ up, anywhere else activates', () => {
    const menu = new MenuList([{ id: 'a', label: 'ALPHA', value: 'ONE' }, { id: 'b', label: 'BETA' }]);
    menu.draw(createFakeCtx(), theme, 10, 10, 200);
    const y = 10 + theme.lineHeight / 2;
    const { dec, inc } = arrows(theme, 10, 200, 'ONE');
    expect(menu.update(1 / 60, makeInput({ pointer: pointerAt(dec, y, true), device: 'touch' }))).toMatchObject({ type: 'change', delta: -1 });
    expect(menu.update(1 / 60, makeInput({ pointer: pointerAt(inc, y + 1, true), device: 'touch' }))).toMatchObject({ type: 'change', delta: 1 });
    expect(menu.update(1 / 60, makeInput({ pointer: pointerAt(40, y + 2, true), device: 'touch' }))).toMatchObject({ type: 'activate' });
    expect(menu.update(1 / 60, makeInput({ pointer: pointerAt(inc, y + theme.lineHeight, true), device: 'mouse' }))).toMatchObject({ type: 'activate', item: { id: 'b' } });
  });

  it('a value too wide for its row is cut so the label keeps room (large text)', () => {
    const long = 'MAN ON THE SLOT RECEIVER WITH INSIDE LEVERAGE';
    const menu = new MenuList([{ id: 'CB1', label: 'CB1', value: long }]);
    const ctx = createFakeCtx();
    menu.draw(ctx, big, 0, 0, 240);
    // Every glyph pixel stays inside the row.
    for (const f of ctx.fills) {
      expect(f.x).toBeGreaterThanOrEqual(0);
      expect(f.x + f.w).toBeLessThanOrEqual(240);
    }
    // The ▶ is still where a tap finds it, and the ◀ sits right of the label.
    expect(menu.update(1 / 60, makeInput({ pointer: pointerAt(240 - big.gap - 4, big.lineHeight / 2, true), device: 'touch' }))).toMatchObject({ type: 'change', delta: 1 });
  });
});

describe('difficulty tuning', () => {
  it('scrolls its knobs in large text with a one-line readout of the highlighted knob, and touch can step both ways', () => {
    const ui = makeUi({ textSize: 'large' });
    const prefs = defaultGameplay();
    const persist = vi.fn();
    const screen = new DifficultyTuningScreen(prefs, persist);
    ui.stack.push(screen);
    screen.render(ui.rc);
    expect(screen.list.maxVisible).toBeGreaterThan(0);
    expect(screen.list.maxVisible).toBeLessThan(screen.list.items.length);
    // Keyboard reaches every row, down to BACK, and it is drawn (hit-testable) inside the canvas.
    for (let i = 0; i < screen.list.items.length - 1; i++) {
      screen.update(1 / 60, makeInput({ pressed: ['menuDown'] }), ui.services);
      screen.update(1 / 60, makeInput(), ui.services);
    }
    screen.render(ui.rc);
    expect(screen.list.selected?.id).toBe('back');
    let backY = -1;
    for (let y = 0; y < ui.rc.height && backY < 0; y++) if (screen.list.hitTest(ui.rc.width / 2, y) === screen.list.items.length - 1) backY = y;
    expect(backY).toBeGreaterThan(0);
    expect(backY + big.lineHeight).toBeLessThan(ui.rc.height - big.glyphH);
    // Back to the first knob; touch ▶ raises it, ◀ lowers it again.
    screen.list.select(0);
    screen.render(ui.rc);
    let rowY = -1;
    for (let y = 0; y < ui.rc.height && rowY < 0; y++) if (screen.list.hitTest(ui.rc.width / 2, y) === 0) rowY = y + 2;
    const w = ui.rc.width - big.pad * 2 - (big.border + big.gap) * 2;
    const x0 = big.pad + big.border + big.gap;
    const up = arrows(big, x0, w, '0', true);
    screen.update(1 / 60, makeInput({ pointer: pointerAt(up.inc, rowY, true), device: 'touch' }), ui.services);
    expect(prefs.tweaks.aiSmarts).toBe(1);
    screen.render(ui.rc);
    const down = arrows(big, x0, w, '+1', true);
    screen.update(1 / 60, makeInput({ pointer: pointerAt(down.dec, rowY, true), device: 'touch' }), ui.services);
    expect(prefs.tweaks.aiSmarts).toBeUndefined();
    expect(persist).toHaveBeenCalledTimes(2);
  });

  it('the compact readout names the knob value; normal text keeps the full readout and no scrolling', () => {
    const ui = makeUi();
    const screen = new DifficultyTuningScreen(defaultGameplay());
    ui.stack.push(screen);
    screen.render(ui.rc);
    expect(screen.list.maxVisible).toBe(0);
    const d = { qbDecisionQuality: 0.72, aiReactionDelay: 0.25, pursuitQuality: 0.6, userPassAssist: 0.5, userTackleAssist: 0.4, userBallSecurityAssist: 0.3 };
    expect(tweakReadout('aiSmarts', d as never)).toBe('AI IQ 72%');
    expect(tweakReadout('aiReaction', d as never)).toBe('REACTION 0.25S');
    expect(tweakReadout('reset', d as never)).toBeNull();
  });
});

describe('assignments editor', () => {
  it('large text: every defender row fits the list column and touch can step an assignment back', () => {
    const registry = loadPlaybookData();
    const play = Object.values(registry.defensePlays).find((p) => p.assignments.CB1?.type === 'manCover');
    if (!play) throw new Error('no defensive play');
    const ui = makeUi({ textSize: 'large' });
    const onDone = vi.fn();
    const screen = new AssignmentsScreen(play, registry, {}, { onDone });
    ui.stack.push(screen);
    const ctx = createFakeCtx();
    screen.render({ ...ui.rc, ctx });
    for (const f of ctx.fills) expect(f.x + f.w).toBeLessThanOrEqual(ui.rc.width);
    const first = screen.list.items[0];
    if (!first) throw new Error('no rows');
    screen.update(1 / 60, makeInput({ pressed: ['menuLeft'] }), ui.services);
    expect(Object.keys(screen.current)).toHaveLength(1);
    screen.update(1 / 60, makeInput({ pressed: ['menuRight'] }), ui.services);
    expect(screen.current).toEqual({});
    screen.update(1 / 60, makeInput({ pressed: ['back'] }), ui.services);
    expect(onDone).toHaveBeenCalledWith({});
  });
});

describe('stadium crowd and weather under reduced motion', () => {
  const palettes = resolveTeamPalettes({ primary: '#c02020', secondary: '#f0f0f0', accent: '#ffffff', helmet: '#c02020' }, { primary: '#2040c0', secondary: '#e0e0e0', accent: '#ffff00', helmet: '#2040c0' }, 'none');
  const draw = (th: typeof theme, time: number): string => {
    const cam = new Camera(480, 270);
    cam.setMode('simulation', { userSide: null, offense: 'home', direction: 1, ballPos: vec2(MIDDLE_X, 60), controlledPos: null });
    cam.snap();
    const ctx = createFakeCtx();
    const scene: FieldScene = {
      athletes: [], ball: { x: MIDDLE_X, y: 60, z: 0, phase: 'dead', carrierId: null }, losY: 60, firstDownY: 70, direction: 1, controlledId: null, presnap: false, snapX: MIDDLE_X,
    };
    drawScene(ctx, cam, scene, {
      theme: th, sprites: new SpriteCache(), palettes, fieldType: 'grass', homeAbbr: 'HOM', awayAbbr: 'AWY', time, userSide: 'home',
      weather: { type: 'rain', windDir: 0, windMph: 10, temperatureF: 50, precipitation: 0.6, visibility: 0.9, fieldSlick: 0.3 },
      stadium: { name: 'Harbor Point', roof: 'open', attendancePct: 0.9, homeColor: '#aa2222', awayColor: '#2222aa' }, animations: true,
    });
    return JSON.stringify(ctx.fills);
  };

  it('the crowd bobs and the rain drifts normally, and both hold still with reduced motion', () => {
    expect(draw(theme, 0.1)).not.toBe(draw(theme, 1.7));
    const still = createTheme({ ...DEFAULT_SETTINGS, reducedMotion: true });
    expect(draw(still, 0.1)).toBe(draw(still, 1.7));
  });
});
